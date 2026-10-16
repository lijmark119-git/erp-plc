import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { app, databasePool } from '../server.js';

async function startServer() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function request(baseUrl, cookie, endpoint, method = 'GET', payload) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { response, body: await response.json() };
}

test('banking API exposes reconciliation state and rejects invalid matches without changing it', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const cookie = await login(baseUrl, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
    const initial = await request(baseUrl, cookie, '/api/banking');
    assert.equal(initial.response.status, 200);
    assert.ok(Array.isArray(initial.body.statementTransactions));
    assert.ok(Array.isArray(initial.body.reconciliationHistory));

    const invalidMatch = await request(baseUrl, cookie, '/api/banking/reconciliation/matches', 'POST', {
      statementTransactionId: 'missing-statement',
      cashbookTransactionId: 'missing-cashbook',
    });
    assert.equal(invalidMatch.response.status, 404);

    const final = await request(baseUrl, cookie, '/api/banking');
    assert.equal(final.body.reconciliationHistory.length, initial.body.reconciliationHistory.length);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('banking API serves the imported PostgreSQL accounts, statements, and reconciliation history', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const cookie = await login(baseUrl, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
    const { response, body } = await request(baseUrl, cookie, '/api/banking');
    assert.equal(response.status, 200);
    assert.equal(body.accounts.length, 3);
    assert.equal(body.transactions.length, 2);
    assert.equal(body.statementTransactions.length, 5);
    assert.equal(body.reconciliationHistory.length, 4);
    assert.deepEqual(
      body.reconciliationHistory
        .filter((entry) => entry.legacyCashbookTransactionId)
        .map((entry) => entry.legacyCashbookTransactionId)
        .sort(),
      ['BT-1001', 'BT-1004'],
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

after(async () => {
  if (databasePool) await databasePool.end();
});
