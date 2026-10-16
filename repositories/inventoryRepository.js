export async function getInventorySnapshot(client, organizationId) {
  const result = await client.query(`
    SELECT id, sku, name, description, quantity, reorder_level, unit_cost,
           currency, location, status, updated_at
    FROM inventory_items
    WHERE organization_id = $1
    ORDER BY sku
  `, [organizationId]);

  return {
    items: result.rows,
    alerts: result.rows.filter((item) => Number(item.quantity) <= Number(item.reorder_level)),
  };
}

export async function receiveInventory(client, organizationId, actorId, input) {
  const quantity = Number(input.quantity);
  const unitCost = Number(input.unitCost);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
    return { rowCount: 0, invalidInput: true };
  }

  await client.query('BEGIN');
  try {
    const itemResult = await client.query(`
      SELECT id, quantity
      FROM inventory_items
      WHERE organization_id = $1 AND sku = $2
      FOR UPDATE
    `, [organizationId, input.sku]);
    const item = itemResult.rows[0];
    if (!item) {
      await client.query('ROLLBACK');
      return null;
    }

    const updated = await client.query(`
      UPDATE inventory_items
      SET quantity = quantity + $1,
          unit_cost = CASE WHEN quantity = 0 THEN $2 ELSE unit_cost END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [quantity, unitCost, item.id]);
    await client.query(`
      INSERT INTO inventory_movements (
        organization_id, inventory_item_id, direction, quantity, unit_cost,
        reference, reason, performed_by, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [organizationId, item.id, 'IN', quantity, unitCost, input.reference || null, input.reason || null, actorId, input.date || new Date().toISOString()]);
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function issueInventory(client, organizationId, actorId, input) {
  const quantity = Number(input.quantity);
  const unitCost = Number(input.unitCost);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
    return { rowCount: 0, invalidInput: true };
  }

  await client.query('BEGIN');
  try {
    const itemResult = await client.query(`
      SELECT id, quantity
      FROM inventory_items
      WHERE organization_id = $1 AND sku = $2
      FOR UPDATE
    `, [organizationId, input.sku]);
    const item = itemResult.rows[0];

    if (!item || Number(item.quantity) < quantity) {
      await client.query('ROLLBACK');
      return { rowCount: 0, insufficientStock: true };
    }

    await client.query(`
      UPDATE inventory_items
      SET quantity = quantity - $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [quantity, item.id]);
    await client.query(`
      INSERT INTO inventory_movements (
        organization_id, inventory_item_id, direction, quantity, unit_cost,
        reference, reason, performed_by, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [organizationId, item.id, 'OUT', quantity, unitCost, input.reference || null, input.reason || null, actorId, input.date || new Date().toISOString()]);
    await client.query('COMMIT');
    return { rowCount: 1 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
