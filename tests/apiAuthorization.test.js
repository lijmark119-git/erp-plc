import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { app, databasePool } from '../server.js';

const dataPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'erp-data.json');
const adminUsername = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;
const managerUsername = process.env.MANAGER_USERNAME;
const managerPassword = process.env.MANAGER_PASSWORD;
const sellerUsername = process.env.SELLER_USERNAME;
const sellerPassword = process.env.SELLER_PASSWORD;

async function startTestServer() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie');
}

test('health endpoint reports application and database status', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.application, 'PLC ERP System');
    assert.equal(body.database, 'connected');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('database-backed sessions enforce permission checks through the API', async () => {
  const originalData = fs.readFileSync(dataPath, 'utf8');
  const { server, baseUrl } = await startTestServer();
  const cookieHeader = 'cookie';

  try {
    const adminCookie = await login(baseUrl, adminUsername, adminPassword);
    const managerCookie = await login(baseUrl, managerUsername, managerPassword);
    assert.ok(adminCookie);
    assert.ok(managerCookie);

    const sessionResponse = await fetch(`${baseUrl}/api/session`, {
      headers: { [cookieHeader]: adminCookie.split(';')[0] },
    });
    const session = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200);
    assert.equal(session.user.role, 'ADMIN');
    assert.equal(session.user.username, adminUsername.toLowerCase());
    assert.ok(Array.isArray(session.user.permissions));
    assert.ok(session.user.permissions.includes('accounting:reports:view'));
    assert.ok(session.user.permissions.includes('settings:toggle'));

    const sellerCookie = await login(baseUrl, sellerUsername, sellerPassword);
    assert.ok(sellerCookie);

    const adminDashboardResponse = await fetch(`${baseUrl}/api/dashboard?range=30d`, {
      headers: { [cookieHeader]: adminCookie.split(';')[0] },
    });
    const adminDashboard = await adminDashboardResponse.json();
    assert.equal(adminDashboardResponse.status, 200);
    assert.deepEqual(
      Object.keys(adminDashboard.metrics).sort(),
      ['cash', 'inventory', 'payables', 'purchases', 'receivables', 'sales'],
    );

    const sellerDashboardResponse = await fetch(`${baseUrl}/api/dashboard?range=30d`, {
      headers: { [cookieHeader]: sellerCookie.split(';')[0] },
    });
    const sellerDashboard = await sellerDashboardResponse.json();
    assert.equal(sellerDashboardResponse.status, 200);
    assert.deepEqual(Object.keys(sellerDashboard.metrics).sort(), ['receivables', 'sales']);

    const invalidRangeResponse = await fetch(`${baseUrl}/api/dashboard?range=all`, {
      headers: { [cookieHeader]: adminCookie.split(';')[0] },
    });
    assert.equal(invalidRangeResponse.status, 400);

    const accountingResponse = await fetch(`${baseUrl}/api/accounting/reports/trial-balance`, {
      headers: { [cookieHeader]: adminCookie.split(';')[0] },
    });
    assert.equal(accountingResponse.status, 200);

    const managerAccountingResponse = await fetch(`${baseUrl}/api/accounting/reports/trial-balance`, {
      headers: { [cookieHeader]: managerCookie.split(';')[0] },
    });
    assert.equal(managerAccountingResponse.status, 200);

    const sellerAccountingResponse = await fetch(`${baseUrl}/api/accounting/reports/trial-balance`, {
      headers: { [cookieHeader]: sellerCookie.split(';')[0] },
    });
    assert.equal(sellerAccountingResponse.status, 403);

    const sellerJournalResponse = await fetch(`${baseUrl}/api/accounting/journals`, {
      method: 'POST',
      headers: { [cookieHeader]: sellerCookie.split(';')[0], 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(sellerJournalResponse.status, 403);

    const adminManufacturingResponse = await fetch(`${baseUrl}/api/manufacturing/workspace`, {
      headers: { [cookieHeader]: adminCookie.split(';')[0] },
    });
    assert.equal(adminManufacturingResponse.status, 200);

    const managerManufacturingResponse = await fetch(`${baseUrl}/api/manufacturing/workspace`, {
      headers: { [cookieHeader]: managerCookie.split(';')[0] },
    });
    assert.equal(managerManufacturingResponse.status, 200);

    const managerQualityResponse = await fetch(`${baseUrl}/api/manufacturing/quality-inspections`, {
      headers: { [cookieHeader]: managerCookie.split(';')[0] },
    });
    assert.equal(managerQualityResponse.status, 200);

    const sellerQualityResponse = await fetch(`${baseUrl}/api/manufacturing/quality-inspections`, {
      method: 'POST',
      headers: { [cookieHeader]: sellerCookie.split(';')[0], 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(sellerQualityResponse.status, 403);

    const sellerManufacturingResponse = await fetch(`${baseUrl}/api/manufacturing/workspace`, {
      headers: { [cookieHeader]: sellerCookie.split(';')[0] },
    });
    assert.equal(sellerManufacturingResponse.status, 403);

    const sellerLegacySalesResponse = await fetch(`${baseUrl}/api/sales`, {
      headers: { [cookieHeader]: sellerCookie.split(';')[0] },
    });
    assert.equal(sellerLegacySalesResponse.status, 200);

    for (const modulePath of [
      '/api/inventory',
      '/api/procurement',
      '/api/hr',
      '/api/finance',
      '/api/reports',
      '/api/settings',
      '/api/manufacturing',
      '/api/banking',
    ]) {
      const response = await fetch(`${baseUrl}${modulePath}`, {
        headers: { [cookieHeader]: sellerCookie.split(';')[0] },
      });
      assert.equal(response.status, 403, `Seller must not read ${modulePath}`);
    }

    const forbiddenResponse = await fetch(`${baseUrl}/api/settings/Audit%20logging/toggle`, {
      method: 'POST',
      headers: { [cookieHeader]: sellerCookie.split(';')[0] },
    });
    assert.equal(forbiddenResponse.status, 403);

    const allowedResponse = await fetch(`${baseUrl}/api/settings/Audit%20logging/toggle`, {
      method: 'POST',
      headers: { [cookieHeader]: adminCookie.split(';')[0] },
    });
    assert.equal(allowedResponse.status, 200);
  } finally {
    fs.writeFileSync(dataPath, originalData);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

after(async () => {
  if (databasePool) await databasePool.end();
});
