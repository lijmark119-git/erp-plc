import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { app, databasePool } from '../server.js';

async function startTestServer() {
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
  return response.headers.get('set-cookie')?.split(';')[0];
}

test('governance routes enforce permissions and persist company-scoped records', async () => {
  const { server, baseUrl } = await startTestServer();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const created = {
    entities: [],
    'business-units': [],
    'cost-centers': [],
    'profit-centers': [],
    'fiscal-years': [],
    'approval-rules': [],
    policies: [],
  };
  let organizationId;

  try {
    const adminCookie = await login(baseUrl, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
    const managerCookie = await login(baseUrl, process.env.MANAGER_USERNAME, process.env.MANAGER_PASSWORD);
    const sellerCookie = await login(baseUrl, process.env.SELLER_USERNAME, process.env.SELLER_PASSWORD);
    const headers = (cookie) => ({ cookie, 'content-type': 'application/json' });
    const adminUser = await databasePool.query(
      'SELECT organization_id FROM users WHERE username = $1',
      [String(process.env.ADMIN_USERNAME).toLowerCase()],
    );
    organizationId = adminUser.rows[0]?.organization_id;

    const adminWorkspaceResponse = await fetch(`${baseUrl}/api/governance`, { headers: headers(adminCookie) });
    assert.equal(adminWorkspaceResponse.status, 200);
    const initialWorkspace = await adminWorkspaceResponse.json();
    assert.ok(Array.isArray(initialWorkspace.entities));
    assert.ok(Array.isArray(initialWorkspace.costCenters));
    assert.equal(initialWorkspace.dashboard.financialConsolidationAvailable, false);

    const managerWorkspace = await fetch(`${baseUrl}/api/governance`, { headers: headers(managerCookie) });
    assert.equal(managerWorkspace.status, 200);
    const sellerWorkspace = await fetch(`${baseUrl}/api/governance`, { headers: headers(sellerCookie) });
    assert.equal(sellerWorkspace.status, 403);
    const managerWrite = await fetch(`${baseUrl}/api/governance/entities`, {
      method: 'POST',
      headers: headers(managerCookie),
      body: JSON.stringify({ code: `DENY-${suffix}`, name: 'Denied entity', entityType: 'SUBSIDIARY' }),
    });
    assert.equal(managerWrite.status, 403);

    const create = async (collection, body) => {
      const response = await fetch(`${baseUrl}/api/governance/${collection}`, {
        method: 'POST',
        headers: headers(adminCookie),
        body: JSON.stringify(body),
      });
      const responseBody = await response.text();
      assert.equal(response.status, 201, responseBody);
      const record = JSON.parse(responseBody);
      created[collection].push(record.id);
      return record;
    };

    const entity = await create('entities', {
      code: `SUB-${suffix}`, name: 'Governance Test Subsidiary', entityType: 'SUBSIDIARY', currency: 'ETB',
    });
    const unit = await create('business-units', {
      code: `BU-${suffix}`, name: 'Test Operations', entityId: entity.id, departmentCode: 'OPS',
    });
    await create('cost-centers', {
      code: `CC-${suffix}`, name: 'Test Cost Center', entityId: entity.id, businessUnitId: unit.id, departmentCode: 'OPS',
    });
    await create('profit-centers', {
      code: `PC-${suffix}`, name: 'Test Profit Center', entityId: entity.id, businessUnitId: unit.id, departmentCode: 'OPS',
    });
    const fiscalYear = await create('fiscal-years', {
      code: `FY-${suffix}`, name: 'Test Fiscal Year', entityId: entity.id, startDate: '2099-01-01', endDate: '2099-12-31',
    });
    const approvalRule = await create('approval-rules', {
      code: `AR-${suffix}`, transactionType: 'Purchase order', entityId: entity.id, minAmount: 100,
      maxAmount: 1000, currency: 'ETB', approverRole: 'MANAGER', delegatedFromRole: 'ADMIN',
    });
    const policy = await create('policies', {
      code: `PL-${suffix}`, title: 'Governance Test Policy', entityId: entity.id,
      ownerDepartment: 'Finance', effectiveDate: '2099-01-01', reviewDate: '2099-12-31', retentionDays: 365,
    });

    const openFiscalYear = await fetch(`${baseUrl}/api/governance/fiscal-years/${fiscalYear.id}/status`, {
      method: 'PATCH', headers: headers(adminCookie), body: JSON.stringify({ status: 'OPEN' }),
    });
    assert.equal(openFiscalYear.status, 200);
    const activatePolicy = await fetch(`${baseUrl}/api/governance/policies/${policy.id}/status`, {
      method: 'PATCH', headers: headers(adminCookie), body: JSON.stringify({ status: 'ACTIVE' }),
    });
    assert.equal(activatePolicy.status, 200);
    const deactivateRule = await fetch(`${baseUrl}/api/governance/approval-rules/${approvalRule.id}/status`, {
      method: 'PATCH', headers: headers(adminCookie), body: JSON.stringify({ active: false }),
    });
    assert.equal(deactivateRule.status, 200);

    const invalidFiscalYear = await fetch(`${baseUrl}/api/governance/fiscal-years`, {
      method: 'POST',
      headers: headers(adminCookie),
      body: JSON.stringify({ code: `BAD-${suffix}`, name: 'Invalid dates', startDate: '2099-02-30', endDate: '2099-12-31' }),
    });
    assert.equal(invalidFiscalYear.status, 400);

    const updatedWorkspace = await (await fetch(`${baseUrl}/api/governance`, { headers: headers(adminCookie) })).json();
    assert.ok(updatedWorkspace.auditTrail.some((entry) => entry.entityId === entity.id));
    assert.equal(updatedWorkspace.entities.find((item) => item.id === entity.id).name, entity.name);
    assert.equal(updatedWorkspace.fiscalYears.find((item) => item.id === fiscalYear.id).status, 'OPEN');

  } finally {
    if (organizationId) {
      const client = await databasePool.connect();
      try {
        await client.query('BEGIN');
        const tables = [
          ['policies', 'enterprise_policies'],
          ['approval-rules', 'enterprise_approval_rules'],
          ['fiscal-years', 'enterprise_fiscal_years'],
          ['profit-centers', 'enterprise_profit_centers'],
          ['cost-centers', 'enterprise_cost_centers'],
          ['business-units', 'enterprise_business_units'],
          ['entities', 'enterprise_entities'],
        ];
        const cleanupIds = new Set(Object.values(created).flat());
        for (const [, table] of tables) {
          const matching = await client.query(
            `SELECT id::text FROM ${table} WHERE organization_id = $1 AND code LIKE $2`,
            [organizationId, `%${suffix}`],
          );
          matching.rows.forEach((row) => cleanupIds.add(row.id));
        }
        const ids = [...cleanupIds];
        await client.query(
          `DELETE FROM audit_events
           WHERE organization_id = $1 AND entity_type LIKE 'governance.%'
             AND entity_id = ANY($2::text[])`,
          [organizationId, ids],
        );
        for (const [, table] of tables) {
          if (ids.length) {
            await client.query(
              `DELETE FROM ${table} WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
              [organizationId, ids],
            );
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

after(async () => {
  if (databasePool) await databasePool.end();
});
