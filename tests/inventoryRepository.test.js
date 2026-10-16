import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createDatabasePool } from '../database.js';
import { getInventorySnapshot, issueInventory, receiveInventory } from '../repositories/inventoryRepository.js';

async function getActorId(client, organizationId) {
  const result = await client.query(
    'SELECT id FROM users WHERE organization_id = $1 AND active = TRUE ORDER BY created_at LIMIT 1',
    [organizationId],
  );
  return result.rows[0].id;
}

async function createInventoryItem(client, organizationId) {
  const result = await client.query(`
    INSERT INTO inventory_items
      (organization_id, sku, name, quantity, reorder_level, unit_cost, currency, location)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, sku, quantity
  `, [
    organizationId,
    `TEST-${randomUUID()}`,
    'Repository Test Item',
    10,
    5,
    4,
    'ETB',
    'TEST-WAREHOUSE',
  ]);
  return result.rows[0];
}

test('receiving inventory updates quantity and creates a movement atomically', async () => {
  const pool = createDatabasePool();
  const client = await pool.connect();
  const organizationId = (await client.query(
    'SELECT id FROM organizations WHERE code = $1',
    ['DEFAULT'],
  )).rows[0].id;
  const item = await createInventoryItem(client, organizationId);
  const actorId = await getActorId(client, organizationId);
  const reference = `RECEIVE-${randomUUID()}`;

  try {
    const received = await receiveInventory(client, organizationId, actorId, {
      sku: item.sku,
      quantity: 12.25,
      unitCost: 40,
      reference,
      reason: 'Repository integration test',
      date: new Date().toISOString(),
    });

    assert.ok(received);
    assert.equal(Number(received.quantity), Number(item.quantity) + 12.25);
    const snapshot = await getInventorySnapshot(client, organizationId);
    const movement = await client.query(
      `SELECT direction, quantity, unit_cost, reference, performed_by
       FROM inventory_movements
       WHERE organization_id = $1 AND inventory_item_id = $2 AND reference = $3`,
      [organizationId, item.id, reference],
    );
    assert.equal(movement.rows[0].direction, 'IN');
    assert.equal(Number(movement.rows[0].quantity), 12.25);
    assert.equal(movement.rows[0].reference, reference);
    assert.equal(movement.rows[0].performed_by, actorId);
    assert.equal(Number(snapshot.items.find((entry) => entry.id === item.id).quantity), Number(item.quantity) + 12.25);
  } finally {
    await client.query('DELETE FROM inventory_movements WHERE inventory_item_id = $1', [item.id]);
    await client.query('DELETE FROM inventory_items WHERE id = $1', [item.id]);
    client.release();
    await pool.end();
  }
});

test('issuing inventory rejects insufficient stock without changing quantity or movement history', async () => {
  const pool = createDatabasePool();
  const client = await pool.connect();
  const organizationId = (await client.query(
    'SELECT id FROM organizations WHERE code = $1',
    ['DEFAULT'],
  )).rows[0].id;
  const item = await createInventoryItem(client, organizationId);
  const actorId = await getActorId(client, organizationId);
  const reference = `ISSUE-${randomUUID()}`;
  const quantity = Number(item.quantity) + 1;

  try {
    const result = await issueInventory(client, organizationId, actorId, {
      sku: item.sku,
      quantity,
      unitCost: 1,
      reference,
      reason: 'Rejected repository integration test',
      date: new Date().toISOString(),
    });

    assert.equal(result.insufficientStock, true);
    const current = await client.query(
      'SELECT quantity FROM inventory_items WHERE id = $1',
      [item.id],
    );
    assert.equal(Number(current.rows[0].quantity), Number(item.quantity));
    assert.equal(
      (await client.query('SELECT COUNT(*) AS count FROM inventory_movements WHERE reference = $1', [reference])).rows[0].count,
      '0',
    );
  } finally {
    await client.query('DELETE FROM inventory_movements WHERE inventory_item_id = $1', [item.id]);
    await client.query('DELETE FROM inventory_items WHERE id = $1', [item.id]);
    client.release();
    await pool.end();
  }
});
