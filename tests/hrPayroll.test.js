import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { app } from '../server.js';
import { createDatabasePool } from '../database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dirname, '..', 'erp-data.json');
const databasePool = createDatabasePool();

after(async () => databasePool.end());

async function preserveHrWorkspace(t) {
  const organization = (await databasePool.query(
    'SELECT id FROM organizations WHERE code = $1',
    ['DEFAULT'],
  )).rows[0];
  const organizationId = organization.id;
  const workspaceResult = await databasePool.query(
    'SELECT data, updated_by, updated_at FROM hr_workspaces WHERE organization_id = $1',
    [organizationId],
  );
  const originalWorkspace = workspaceResult.rows[0] || null;
  const originalPeriods = (await databasePool.query(
    'SELECT id FROM accounting_periods WHERE organization_id = $1',
    [organizationId],
  )).rows.map((row) => row.id);
  const originalSequences = (await databasePool.query(
    'SELECT fiscal_year, next_number FROM accounting_journal_sequences WHERE organization_id = $1',
    [organizationId],
  )).rows;
  const state = { payrollPeriodId: null };

  t.after(async () => {
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      if (state.payrollPeriodId) {
        const sourceIds = [`payroll:${state.payrollPeriodId}`, `payroll-payment:${state.payrollPeriodId}`];
        const journals = await client.query(
          `SELECT id FROM accounting_journals
           WHERE organization_id = $1 AND source_module = 'hr_payroll'
             AND source_transaction_id = ANY($2::text[])`,
          [organizationId, sourceIds],
        );
        const journalIds = journals.rows.map((row) => row.id);
        if (journalIds.length) {
          await client.query(
            `DELETE FROM audit_events
             WHERE entity_type = 'accounting_journal' AND entity_id = ANY($1::text[])`,
            [journalIds],
          );
          await client.query('DELETE FROM accounting_journals WHERE id = ANY($1::uuid[])', [journalIds]);
        }
      }
      if (originalWorkspace) {
        await client.query(
          `UPDATE hr_workspaces
           SET data = $2::jsonb, updated_by = $3, updated_at = $4
           WHERE organization_id = $1`,
          [organizationId, JSON.stringify(originalWorkspace.data), originalWorkspace.updated_by, originalWorkspace.updated_at],
        );
      } else {
        await client.query('DELETE FROM hr_workspaces WHERE organization_id = $1', [organizationId]);
      }

      await client.query(
        `DELETE FROM accounting_periods period
         WHERE period.organization_id = $1
           AND NOT (period.id = ANY($2::uuid[]))
           AND NOT EXISTS (
             SELECT 1 FROM accounting_journals journal
             WHERE journal.accounting_period_id = period.id
           )`,
        [organizationId, originalPeriods],
      );
      const originalYears = originalSequences.map((row) => row.fiscal_year);
      await client.query(
        `DELETE FROM accounting_journal_sequences
         WHERE organization_id = $1 AND NOT (fiscal_year = ANY($2::integer[]))`,
        [organizationId, originalYears],
      );
      for (const sequence of originalSequences) {
        await client.query(
          `UPDATE accounting_journal_sequences SET next_number = $3
           WHERE organization_id = $1 AND fiscal_year = $2`,
          [organizationId, sequence.fiscal_year, sequence.next_number],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  return state;
}

function request(server, method, url, options = {}, cookie = '') {
  return fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(options.headers || {}),
    },
    body: options.body,
    credentials: 'include',
  }).then(async (response) => {
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
    };
  });
}

function getCookieFromLogin(response) {
  return (response.headers.get('set-cookie') || '').split(';')[0];
}

test('HR employee and attendance flows work end-to-end', async (t) => {
  await preserveHrWorkspace(t);
  const originalData = fs.readFileSync(dataPath, 'utf8');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    fs.writeFileSync(dataPath, originalData);
    await new Promise((resolve) => server.close(resolve));
  });

  const adminLogin = await request(server, 'POST', '/api/login', {
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const cookie = getCookieFromLogin(adminLogin);
  assert.equal(adminLogin.status, 200);

  const employeeInput = {
    employeeNumber: '20260001',
    firstName: 'Selam',
    lastName: 'Tesfaye',
    gender: 'Female',
    nationalId: '123456789012',
    departmentId: 'dept-hr',
    positionId: 'pos-hr',
    employmentType: 'Full-time',
    hireDate: '2026-09-01',
    contract: 'Permanent',
    salary: 26000,
    status: 'Active',
  };
  const invalidPhone = await request(server, 'POST', '/api/employees', {
    body: JSON.stringify({ ...employeeInput, employeeNumber: '20260002', phone: '091ABC5678' }),
  }, cookie);
  assert.equal(invalidPhone.status, 400);
  const invalidEmployeeNumber = await request(server, 'POST', '/api/employees', {
    body: JSON.stringify({ ...employeeInput, employeeNumber: 'EMP-2026-CA-002' }),
  }, cookie);
  assert.equal(invalidEmployeeNumber.status, 400);
  const invalidEmployeeName = await request(server, 'POST', '/api/employees', {
    body: JSON.stringify({ ...employeeInput, employeeNumber: '20260003', firstName: 'Selam2' }),
  }, cookie);
  assert.equal(invalidEmployeeName.status, 400);
  const invalidGender = await request(server, 'POST', '/api/employees', {
    body: JSON.stringify({ ...employeeInput, employeeNumber: '20260005', gender: '7' }),
  }, cookie);
  assert.equal(invalidGender.status, 400);
  const invalidNationalId = await request(server, 'POST', '/api/employees', {
    body: JSON.stringify({ ...employeeInput, employeeNumber: '20260006', nationalId: 'NID-123456' }),
  }, cookie);
  assert.equal(invalidNationalId.status, 400);
  const invalidDate = await request(server, 'POST', '/api/employees', {
    body: JSON.stringify({ ...employeeInput, employeeNumber: '20260004', hireDate: '2026-02-30' }),
  }, cookie);
  assert.equal(invalidDate.status, 400);
  const employee = await request(server, 'POST', '/api/employees', {
    body: JSON.stringify(employeeInput),
  }, cookie);
  assert.equal(employee.status, 201, JSON.stringify(employee.body));
  assert.equal(employee.body.employeeNumber, '20260001');

  const checkIn = await request(server, 'POST', `/api/hr/attendance/check-in/${employee.body.id}`, {}, cookie);
  assert.equal(checkIn.status, 201);
  assert.equal(checkIn.body.status, 'Present');
  assert.match(checkIn.body.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(checkIn.body.checkIn, /^([01]\d|2[0-3]):[0-5]\d$/);

  const checkOut = await request(server, 'POST', `/api/hr/attendance/check-out/${employee.body.id}`, {}, cookie);
  assert.equal(checkOut.status, 200);
  assert.ok(Number(checkOut.body.workingHours) >= 0);
  assert.match(checkOut.body.checkOut, /^([01]\d|2[0-3]):[0-5]\d$/);
  assert.ok(Number(checkOut.body.overtime) >= 0);

  const attendance = await request(server, 'GET', '/api/hr/attendance', {}, cookie);
  assert.equal(attendance.status, 200);
  assert.ok(Array.isArray(attendance.body));
});

test('leave requests can be created and approved', async (t) => {
  await preserveHrWorkspace(t);
  const originalData = fs.readFileSync(dataPath, 'utf8');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    fs.writeFileSync(dataPath, originalData);
    await new Promise((resolve) => server.close(resolve));
  });

  const adminLogin = await request(server, 'POST', '/api/login', {
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const cookie = getCookieFromLogin(adminLogin);

  const leaveType = await request(server, 'POST', '/api/hr/leave/types', {
    body: JSON.stringify({ name: 'Study Leave', code: 'STUDY', daysPerYear: 10, accrualRate: 0.83 }),
  }, cookie);
  assert.equal(leaveType.status, 201);

  const leaveRequest = await request(server, 'POST', '/api/hr/leave/requests', {
    body: JSON.stringify({ employeeId: 'emp-001', leaveTypeId: leaveType.body.id, startDate: '2026-10-01', endDate: '2026-10-03', reason: 'Professional certificate' }),
  }, cookie);
  assert.equal(leaveRequest.status, 201);
  assert.equal(leaveRequest.body.status, 'Pending');

  const approval = await request(server, 'POST', `/api/hr/leave/requests/${leaveRequest.body.id}/approve`, {
    body: JSON.stringify({ status: 'Approved' }),
  }, cookie);
  assert.equal(approval.status, 200);
  assert.equal(approval.body.status, 'Approved');
});

test('salary payroll workflow calculates, approves, posts and pays', async (t) => {
  const hrTestState = await preserveHrWorkspace(t);
  const openAccountingPeriod = (await databasePool.query(
    `SELECT TO_CHAR(period_start, 'YYYY-MM-DD') AS start_date,
            TO_CHAR(period_end, 'YYYY-MM-DD') AS end_date
     FROM accounting_periods
     WHERE organization_id = (SELECT id FROM organizations WHERE code = $1)
       AND status = 'OPEN'
     ORDER BY period_end DESC
     LIMIT 1`,
    ['DEFAULT'],
  )).rows[0];
  assert.ok(openAccountingPeriod, 'Payroll posting requires an open accounting period');
  const originalData = fs.readFileSync(dataPath, 'utf8');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    fs.writeFileSync(dataPath, originalData);
    await new Promise((resolve) => server.close(resolve));
  });

  const adminLogin = await request(server, 'POST', '/api/login', {
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const cookie = getCookieFromLogin(adminLogin);

  await request(server, 'PUT', '/api/hr/employees/emp-001', {
    body: JSON.stringify({ status: 'On leave' }),
  }, cookie);
  await request(server, 'PUT', '/api/hr/employees/emp-002', {
    body: JSON.stringify({ status: 'Terminated' }),
  }, cookie);

  const created = await request(server, 'POST', '/api/hr/payroll/periods', {
    body: JSON.stringify({
      label: `Payroll ${openAccountingPeriod.start_date.slice(0, 7)}`,
      startDate: openAccountingPeriod.start_date,
      endDate: openAccountingPeriod.end_date,
    }),
  }, cookie);
  assert.equal(created.status, 201);
  hrTestState.payrollPeriodId = created.body.id;

  const calculate = await request(server, 'POST', `/api/hr/payroll/periods/${created.body.id}/calculate`, {}, cookie);
  assert.equal(calculate.status, 200);
  assert.equal(calculate.body.period.status, 'Calculated');
  assert.ok(calculate.body.entries.length > 0);
  assert.ok(calculate.body.entries.some((entry) => entry.employeeId === 'emp-001'));
  assert.ok(!calculate.body.entries.some((entry) => entry.employeeId === 'emp-002'));

  const approveBeforeReview = await request(server, 'POST', `/api/hr/payroll/periods/${created.body.id}/approve`, {}, cookie);
  assert.equal(approveBeforeReview.status, 409);

  const review = await request(server, 'POST', `/api/hr/payroll/periods/${created.body.id}/review`, {}, cookie);
  assert.equal(review.status, 200);
  assert.equal(review.body.status, 'Review');

  const approve = await request(server, 'POST', `/api/hr/payroll/periods/${created.body.id}/approve`, {}, cookie);
  assert.equal(approve.status, 200);
  assert.equal(approve.body.status, 'Approved');

  const post = await request(server, 'POST', `/api/hr/payroll/periods/${created.body.id}/post`, {}, cookie);
  assert.equal(post.status, 200);
  assert.equal(post.body.period.status, 'Posted');
  assert.ok(post.body.accountingEntries.length >= 5);

  const pay = await request(server, 'POST', `/api/hr/payroll/periods/${created.body.id}/pay`, {}, cookie);
  assert.equal(pay.status, 200);
  assert.equal(pay.body.status, 'Paid');

  const payslip = await request(server, 'GET', `/api/hr/payroll/payslip/emp-001?periodId=${created.body.id}`, {}, cookie);
  assert.equal(payslip.status, 200);
  assert.ok(Number(payslip.body.payslip.netSalary) >= 0);
});

test('RBAC blocks unauthorized HR and payroll access', async (t) => {
  const originalData = fs.readFileSync(dataPath, 'utf8');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    fs.writeFileSync(dataPath, originalData);
    await new Promise((resolve) => server.close(resolve));
  });

  const sellerLogin = await request(server, 'POST', '/api/login', {
    body: JSON.stringify({ username: 'seller', password: 'seller123' }),
  });
  const cookie = getCookieFromLogin(sellerLogin);

  const forbidden = await request(server, 'GET', '/api/hr/attendance', {}, cookie);
  assert.equal(forbidden.status, 403);

  const managerLogin = await request(server, 'POST', '/api/login', {
    body: JSON.stringify({ username: 'manager', password: 'manager123' }),
  });
  const managerCookie = getCookieFromLogin(managerLogin);
  const allowed = await request(server, 'GET', '/api/hr/attendance', {}, managerCookie);
  assert.equal(allowed.status, 200);
});
