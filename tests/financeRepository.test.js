import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createDatabasePool } from '../database.js';
import {
  approveFinanceTransaction,
  createFinanceTransaction,
  createTransfer,
  getBankingSnapshot,
} from '../repositories/financeRepository.js';

async function getActorId(client, organizationId) {
  const result = await client.query(
    'SELECT id FROM users WHERE organization_id = $1 AND active = TRUE ORDER BY created_at LIMIT 1',
    [organizationId],
  );
  return result.rows[0].id;
}

async function createAccounts(client, organizationId) {
  const codes = [randomUUID(), randomUUID()];
  const result = await client.query(`
    INSERT INTO bank_accounts
      (organization_id, code, name, account_number, currency, current_balance, account_type)
    VALUES ($1, $2, $3, $4, $5, $6, $7), ($1, $8, $9, $10, $11, $12, $13)
    RETURNING id, current_balance
  `, [
    organizationId, codes[0], 'Transfer Source', 'SOURCE-TEST', 'ETB', 1000, 'TEST',
    codes[1], 'Transfer Destination', 'DESTINATION-TEST', 'ETB', 500, 'TEST',
  ]);
  return result.rows;
}

test('transfer updates two accounts and records both ledger entries atomically', async () => {
  const pool = createDatabasePool();
  const client = await pool.connect();
  const organizationId = (await client.query(
    'SELECT id FROM organizations WHERE code = $1',
    ['DEFAULT'],
  )).rows[0].id;
  const actorId = await getActorId(client, organizationId);
  const [fromAccount, toAccount] = await createAccounts(client, organizationId);
  let transferId = null;

  try {
    const result = await createTransfer(client, organizationId, actorId, {
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
      amount: 25.5,
      description: 'Repository transfer test',
      date: new Date().toISOString(),
    });

    assert.equal(result.rowCount, 2);
    assert.ok(result.transferId);
    transferId = result.transferId;

    const snapshot = await getBankingSnapshot(client, organizationId);
    const updatedFrom = snapshot.accounts.find((account) => account.id === fromAccount.id);
    const updatedTo = snapshot.accounts.find((account) => account.id === toAccount.id);
    assert.equal(updatedFrom.balance, Number(fromAccount.current_balance) - 25.5);
    assert.equal(updatedTo.balance, Number(toAccount.current_balance) + 25.5);
    assert.equal(snapshot.transactions.filter((transaction) => transaction.reference === transferId).length, 2);
  } finally {
    if (transferId) {
      await client.query('DELETE FROM finance_transactions WHERE reference = $1', [transferId]);
    }
    await client.query('DELETE FROM bank_accounts WHERE id IN ($1, $2)', [fromAccount.id, toAccount.id]);
    client.release();
    await pool.end();
  }
});

test('transfer rejects insufficient funds without changing balances', async () => {
  const pool = createDatabasePool();
  const client = await pool.connect();
  const organizationId = (await client.query(
    'SELECT id FROM organizations WHERE code = $1',
    ['DEFAULT'],
  )).rows[0].id;
  const actorId = await getActorId(client, organizationId);
  const [fromAccount, toAccount] = await createAccounts(client, organizationId);
  const amount = Number(fromAccount.current_balance) + 1;

  try {
    const result = await createTransfer(client, organizationId, actorId, {
      fromAccountId: fromAccount.id,
      toAccountId: toAccount.id,
      amount,
      description: 'Rejected transfer test',
      date: new Date().toISOString(),
    });

    assert.equal(result.insufficientFunds, true);
    const snapshot = await getBankingSnapshot(client, organizationId);
    assert.equal(snapshot.accounts.find((account) => account.id === fromAccount.id).balance, Number(fromAccount.current_balance));
    assert.equal(snapshot.accounts.find((account) => account.id === toAccount.id).balance, Number(toAccount.current_balance));
  } finally {
    await client.query('DELETE FROM bank_accounts WHERE id IN ($1, $2)', [fromAccount.id, toAccount.id]);
    client.release();
    await pool.end();
  }
});

test('pending bank transactions change balances only once when approved', async () => {
  const pool = createDatabasePool();
  const client = await pool.connect();
  const organizationId = (await client.query(
    'SELECT id FROM organizations WHERE code = $1',
    ['DEFAULT'],
  )).rows[0].id;
  const actorId = await getActorId(client, organizationId);
  const accountCode = randomUUID();
  const account = (await client.query(`
    INSERT INTO bank_accounts
      (organization_id, code, name, account_number, currency, current_balance, account_type)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, current_balance
  `, [organizationId, accountCode, 'Approval Test Account', 'APPROVAL-TEST', 'ETB', 100, 'TEST'])).rows[0];
  const transactionIds = [];

  try {
    const insufficient = await createFinanceTransaction(client, organizationId, actorId, {
      accountId: account.id,
      type: 'Debit',
      amount: 101,
      description: 'Insufficient funds test',
      category: 'TEST',
      date: new Date().toISOString(),
    });
    transactionIds.push(insufficient.rows[0].id);
    const rejected = await approveFinanceTransaction(client, organizationId, insufficient.rows[0].id, actorId);
    assert.equal(rejected.insufficientFunds, true);
    assert.equal(Number((await client.query('SELECT current_balance FROM bank_accounts WHERE id = $1', [account.id])).rows[0].current_balance), 100);

    const pending = await createFinanceTransaction(client, organizationId, actorId, {
      accountId: account.id,
      type: 'Debit',
      amount: 30,
      description: 'Approval balance test',
      category: 'TEST',
      date: new Date().toISOString(),
    });
    transactionIds.push(pending.rows[0].id);
    assert.equal(Number((await client.query('SELECT current_balance FROM bank_accounts WHERE id = $1', [account.id])).rows[0].current_balance), 100);

    const approved = await approveFinanceTransaction(client, organizationId, pending.rows[0].id, actorId);
    assert.equal(approved.transaction.status, 'APPROVED');
    assert.equal(Number((await client.query('SELECT current_balance FROM bank_accounts WHERE id = $1', [account.id])).rows[0].current_balance), 70);
    const secondApproval = await approveFinanceTransaction(client, organizationId, pending.rows[0].id, actorId);
    assert.equal(secondApproval.transaction, null);
    assert.equal(Number((await client.query('SELECT current_balance FROM bank_accounts WHERE id = $1', [account.id])).rows[0].current_balance), 70);
  } finally {
    if (transactionIds.length) {
      await client.query('DELETE FROM finance_transactions WHERE id = ANY($1::uuid[])', [transactionIds]);
    }
    await client.query('DELETE FROM bank_accounts WHERE id = $1', [account.id]);
    client.release();
    await pool.end();
  }
});
