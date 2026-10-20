import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';

import { createDatabasePool } from '../database.js';
import { accountingService } from '../services/accountingService.js';

const pool = createDatabasePool();
const organizationId = (await pool.query('SELECT id FROM organizations WHERE code = $1', ['DEFAULT'])).rows[0].id;
const client = await pool.connect();
const actorId = (await client.query('SELECT id FROM users WHERE organization_id = $1 AND active = TRUE ORDER BY created_at LIMIT 1', [organizationId])).rows[0].id;

after(async () => {
  await client.release();
  await pool.end();
});

async function createTestAccounts() {
  const codes = [`ACC-${randomUUID().replaceAll('-', '').slice(0, 12)}`, `ACC-${randomUUID().replaceAll('-', '').slice(0, 12)}`];
  const result = await client.query(
    `INSERT INTO accounting_accounts (organization_id, account_code, account_name, account_type, normal_balance, opening_balance)
     VALUES ($1, $2, $3, 'ASSET', 'DEBIT', 0), ($1, $4, $5, 'REVENUE', 'CREDIT', 0)
     RETURNING id, account_code`,
    [organizationId, codes[0], 'Test Asset', codes[1], 'Test Revenue'],
  );
  return result.rows;
}

test('balanced journal is accepted and posted', async () => {
  const [asset, revenue] = await createTestAccounts();
  const journal = await accountingService.createJournal(client, organizationId, actorId, {
    transactionDate: new Date().toISOString().slice(0, 10),
    reference: `TEST-${randomUUID()}`,
    description: 'Balanced journal test',
    sourceModule: 'test',
    sourceTransactionId: randomUUID(),
    status: 'APPROVED',
    currency: 'ETB',
    lines: [
      { accountId: asset.id, debit: 100, credit: 0, description: 'Test asset debit' },
      { accountId: revenue.id, debit: 0, credit: 100, description: 'Test revenue credit' },
    ],
  });
  assert.equal(journal.status, 'APPROVED');
  const posted = await accountingService.postJournal(client, organizationId, actorId, journal.id);
  assert.equal(posted.status, 'POSTED');
  const balance = await accountingService.getBalance(client, organizationId, asset.id);
  assert.equal(Number(balance.closingBalance), 100);
  await client.query('DELETE FROM accounting_journal_lines WHERE journal_id = $1', [journal.id]);
  await client.query('DELETE FROM accounting_journals WHERE id = $1', [journal.id]);
  await client.query('DELETE FROM accounting_accounts WHERE id IN ($1, $2)', [asset.id, revenue.id]);
});

test('unbalanced journal is rejected', async () => {
  const [asset, revenue] = await createTestAccounts();
  await assert.rejects(() => accountingService.createJournal(client, organizationId, actorId, {
    transactionDate: new Date().toISOString().slice(0, 10),
    reference: `TEST-${randomUUID()}`,
    description: 'Unbalanced journal test',
    sourceModule: 'test',
    sourceTransactionId: randomUUID(),
    lines: [
      { accountId: asset.id, debit: 100, credit: 0, description: 'Test asset debit' },
      { accountId: revenue.id, debit: 0, credit: 99, description: 'Test revenue credit' },
    ],
  }), /must match/);
  await client.query('DELETE FROM accounting_accounts WHERE id IN ($1, $2)', [asset.id, revenue.id]);
});

test('journal sequence recovers when its counter is behind existing journal numbers', async () => {
  const [asset, revenue] = await createTestAccounts();
  const fiscalYear = new Date().getFullYear();
  const sourceTransactionId = randomUUID();
  const priorSequence = (await client.query(
    'SELECT next_number FROM accounting_journal_sequences WHERE organization_id = $1 AND fiscal_year = $2',
    [organizationId, fiscalYear],
  )).rows[0] || null;
  let journal;
  try {
    await client.query(
      `INSERT INTO accounting_journal_sequences (organization_id, fiscal_year, next_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (organization_id, fiscal_year) DO UPDATE SET next_number = 1`,
      [organizationId, fiscalYear],
    );
    const latestNumber = Number((await client.query(
      `SELECT COALESCE(MAX(substring(journal_number FROM '^JE-[0-9]{4}-([0-9]+)$')::BIGINT), 0) AS value
       FROM accounting_journals WHERE organization_id = $1 AND journal_number LIKE $2`,
      [organizationId, `JE-${fiscalYear}-%`],
    )).rows[0].value);
    journal = await accountingService.createJournal(client, organizationId, actorId, {
      transactionDate: new Date().toISOString().slice(0, 10),
      description: 'Stale sequence recovery test',
      sourceModule: 'test',
      sourceTransactionId,
      lines: [
        { accountId: asset.id, debit: 10, credit: 0, description: 'Test debit' },
        { accountId: revenue.id, debit: 0, credit: 10, description: 'Test credit' },
      ],
    });
    assert.equal(Number(journal.journal_number.split('-').at(-1)), latestNumber + 1);
  } finally {
    if (journal) {
      await client.query('DELETE FROM accounting_journal_lines WHERE journal_id = $1', [journal.id]);
      await client.query('DELETE FROM accounting_journals WHERE id = $1', [journal.id]);
    }
    if (priorSequence) {
      await client.query(
        'UPDATE accounting_journal_sequences SET next_number = $3 WHERE organization_id = $1 AND fiscal_year = $2',
        [organizationId, fiscalYear, priorSequence.next_number],
      );
    } else {
      await client.query(
        'DELETE FROM accounting_journal_sequences WHERE organization_id = $1 AND fiscal_year = $2',
        [organizationId, fiscalYear],
      );
    }
    await client.query('DELETE FROM accounting_accounts WHERE id IN ($1, $2)', [asset.id, revenue.id]);
  }
});

test('reversal creates a balanced opposite journal and marks source reversed', async () => {
  const [asset, revenue] = await createTestAccounts();
  const journal = await accountingService.createJournal(client, organizationId, actorId, {
    transactionDate: new Date().toISOString().slice(0, 10),
    reference: `TEST-${randomUUID()}`,
    description: 'Reversal test',
    sourceModule: 'test',
    sourceTransactionId: randomUUID(),
    status: 'APPROVED',
    lines: [
      { accountId: asset.id, debit: 100, credit: 0, description: 'Test asset debit' },
      { accountId: revenue.id, debit: 0, credit: 100, description: 'Test revenue credit' },
    ],
  });
  await accountingService.postJournal(client, organizationId, actorId, journal.id);
  const reversal = await accountingService.reverseJournal(client, organizationId, actorId, journal.id, 'Test reversal');
  assert.equal(reversal.status, 'POSTED');
  const source = await accountingService.getJournal(client, organizationId, journal.id);
  assert.equal(source.status, 'REVERSED');
  assert.equal(source.reversal_journal_id, reversal.id);
  await client.query('DELETE FROM accounting_journal_lines WHERE journal_id IN ($1, $2)', [journal.id, reversal.id]);
  await client.query('DELETE FROM accounting_journals WHERE id IN ($1, $2)', [journal.id, reversal.id]);
  await client.query('DELETE FROM accounting_accounts WHERE id IN ($1, $2)', [asset.id, revenue.id]);
});

test('closed period rejects posting', async () => {
  const [asset, revenue] = await createTestAccounts();
  let period;
  let journal;
  try {
    journal = await accountingService.createJournal(client, organizationId, actorId, {
      transactionDate: new Date().toISOString().slice(0, 10),
      reference: `TEST-${randomUUID()}`,
      description: 'Closed period test',
      sourceModule: 'test',
      sourceTransactionId: randomUUID(),
      status: 'APPROVED',
      lines: [
        { accountId: asset.id, debit: 25, credit: 0, description: 'Test asset debit' },
        { accountId: revenue.id, debit: 0, credit: 25, description: 'Test revenue credit' },
      ],
    });
    period = (await client.query(
      'SELECT id, status, closed_at, updated_at FROM accounting_periods WHERE id = $1',
      [journal.accounting_period_id],
    )).rows[0];
    await client.query(
      'UPDATE accounting_periods SET status = \'CLOSED\', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [period.id],
    );
    await assert.rejects(() => accountingService.postJournal(client, organizationId, actorId, journal.id), /accounting period is closed/i);
  } finally {
    if (journal) {
      await client.query('DELETE FROM accounting_journal_lines WHERE journal_id = $1', [journal.id]);
      await client.query('DELETE FROM accounting_journals WHERE id = $1', [journal.id]);
    }
    await client.query('DELETE FROM accounting_accounts WHERE id IN ($1, $2)', [asset.id, revenue.id]);
    if (period) {
      await client.query(
        'UPDATE accounting_periods SET status = $2, closed_at = $3, updated_at = $4 WHERE id = $1',
        [period.id, period.status, period.closed_at, period.updated_at],
      );
    }
  }
});

test('closed periods can be reopened only with a reason and retain closure history', async () => {
  const originalClosure = new Date('9998-12-31T23:59:59.000Z');
  await client.query('BEGIN');
  try {
    const period = (await client.query(
      `INSERT INTO accounting_periods (
         organization_id, fiscal_year, period_number, period_start, period_end,
         status, closed_at, closed_by
       ) VALUES ($1, 9998, 12, '9998-12-01', '9999-01-01', 'CLOSED', $2, $3)
       RETURNING id`,
      [organizationId, originalClosure, actorId],
    )).rows[0];

    await assert.rejects(
      () => accountingService.reopenPeriod(client, organizationId, actorId, period.id, { reason: '  ' }),
      /reopening reason/i,
    );
    const reopened = await accountingService.reopenPeriod(
      client, organizationId, actorId, period.id, { reason: 'Correct a reviewed posting date' },
    );
    assert.equal(reopened.status, 'OPEN');
    assert.equal(await accountingService.reopenPeriod(
      client, organizationId, actorId, period.id, { reason: 'Duplicate request' },
    ), null);

    const history = (await client.query(
      `SELECT reason, previous_closed_at, previous_closed_by
       FROM accounting_period_reopen_history WHERE period_id = $1`,
      [period.id],
    )).rows[0];
    assert.equal(history.reason, 'Correct a reviewed posting date');
    assert.equal(new Date(history.previous_closed_at).toISOString(), originalClosure.toISOString());
    assert.equal(history.previous_closed_by, actorId);
  } finally {
    await client.query('ROLLBACK');
  }
});

test('trial balance is calculated from posted entries', async () => {
  const [asset, revenue] = await createTestAccounts();
  const journal = await accountingService.createJournal(client, organizationId, actorId, {
    transactionDate: new Date().toISOString().slice(0, 10),
    reference: `TEST-${randomUUID()}`,
    description: 'Trial balance test',
    sourceModule: 'test',
    sourceTransactionId: randomUUID(),
    status: 'APPROVED',
    lines: [
      { accountId: asset.id, debit: 50, credit: 0, description: 'Test asset debit' },
      { accountId: revenue.id, debit: 0, credit: 50, description: 'Test revenue credit' },
    ],
  });
  await accountingService.postJournal(client, organizationId, actorId, journal.id);
  const trialBalance = await accountingService.getTrialBalance(client, organizationId);
  const assetRow = trialBalance.find((row) => row.account_code === asset.account_code);
  assert.equal(Number(assetRow.debit), 50);
  assert.equal(Number(assetRow.credit), 0);
  await client.query('DELETE FROM accounting_journal_lines WHERE journal_id = $1', [journal.id]);
  await client.query('DELETE FROM accounting_journals WHERE id = $1', [journal.id]);
  await client.query('DELETE FROM accounting_accounts WHERE id IN ($1, $2)', [asset.id, revenue.id]);
});

test('journal submit, approval, and posting follow the required lifecycle', async () => {
  const [asset, revenue] = await createTestAccounts();
  let journal;
  try {
    journal = await accountingService.createJournal(client, organizationId, actorId, {
      transactionDate: new Date().toISOString().slice(0, 10),
      description: 'Journal lifecycle test',
      sourceModule: 'test',
      sourceTransactionId: randomUUID(),
      lines: [
        { accountId: asset.id, debit: 40, credit: 0, description: 'Lifecycle debit' },
        { accountId: revenue.id, debit: 0, credit: 40, description: 'Lifecycle credit' },
      ],
    });
    assert.equal(journal.status, 'DRAFT');
    assert.equal(await accountingService.approveJournal(client, organizationId, actorId, journal.id), null);
    const submitted = await accountingService.submitJournal(client, organizationId, actorId, journal.id);
    assert.equal(submitted.status, 'SUBMITTED');
    const approved = await accountingService.approveJournal(client, organizationId, actorId, journal.id);
    assert.equal(approved.status, 'APPROVED');
    const posted = await accountingService.postJournal(client, organizationId, actorId, journal.id);
    assert.equal(posted.status, 'POSTED');
    const history = await client.query('SELECT to_status FROM accounting_journal_status_history WHERE journal_id = $1 ORDER BY changed_at', [journal.id]);
    assert.deepEqual(history.rows.map((row) => row.to_status), ['SUBMITTED', 'APPROVED', 'POSTED']);
  } finally {
    if (journal) {
      await client.query('DELETE FROM accounting_journal_lines WHERE journal_id = $1', [journal.id]);
      await client.query('DELETE FROM accounting_journals WHERE id = $1', [journal.id]);
    }
    await client.query('DELETE FROM accounting_accounts WHERE id IN ($1, $2)', [asset.id, revenue.id]);
  }
});

test('account balance and trial balance retain posted movements in closed periods', async () => {
  const [asset, revenue] = await createTestAccounts();
  let journal;
  let originalPeriodStatus;
  try {
    journal = await accountingService.createJournal(client, organizationId, actorId, {
      transactionDate: new Date().toISOString().slice(0, 10),
      description: 'Closed history test',
      sourceModule: 'test',
      sourceTransactionId: randomUUID(),
      status: 'APPROVED',
      lines: [
        { accountId: asset.id, debit: 75, credit: 0, description: 'Historical debit' },
        { accountId: revenue.id, debit: 0, credit: 75, description: 'Historical credit' },
      ],
    });
    await accountingService.postJournal(client, organizationId, actorId, journal.id);
    const period = journal.accounting_period_id;
    originalPeriodStatus = (await client.query('SELECT status FROM accounting_periods WHERE id = $1', [period])).rows[0].status;
    await client.query("UPDATE accounting_periods SET status = 'CLOSED' WHERE id = $1", [period]);
    const balance = await accountingService.getBalance(client, organizationId, asset.id);
    const trialBalance = await accountingService.getTrialBalance(client, organizationId);
    const row = trialBalance.find((item) => item.account_code === asset.account_code);
    assert.equal(Number(balance.debit), 75);
    assert.equal(Number(balance.closingBalance), 75);
    assert.equal(Number(row.debit), 75);
  } finally {
    if (journal) {
      await client.query('UPDATE accounting_periods SET status = $2 WHERE id = $1', [journal.accounting_period_id, originalPeriodStatus || 'OPEN']);
      await client.query('DELETE FROM accounting_journal_lines WHERE journal_id = $1', [journal.id]);
      await client.query('DELETE FROM accounting_journals WHERE id = $1', [journal.id]);
    }
    await client.query('DELETE FROM accounting_accounts WHERE id IN ($1, $2)', [asset.id, revenue.id]);
  }
});

test('automatic accounting templates post sales, purchasing, expense, inventory, and manufacturing journals', async () => {
  const vatAccountCode = `VAT-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const vatAccount = await accountingService.createAccount(client, organizationId, actorId, {
    accountCode: vatAccountCode,
    accountName: 'Recoverable VAT test account',
    accountType: 'ASSET',
    normalBalance: 'DEBIT',
  });
  const common = { transactionDate: new Date().toISOString().slice(0, 10), currency: 'ETB' };
  const cases = [
    ['sales-invoice', { amount: 115, vatAmount: 15 }],
    ['customer-payment', { amount: 50 }],
    ['purchase-invoice', { inventoryAmount: 100, expenseAmount: 20, recoverableVat: 15, recoverableVatAccountCode: vatAccountCode }],
    ['supplier-payment', { amount: 135 }],
    ['expense', { amount: 25, description: 'Test expense posting' }],
    ['inventory-receipt', { amount: 30 }],
    ['inventory-issue', { amount: 18 }],
    ['manufacturing-consumption', { amount: 14 }],
    ['manufacturing-completion', { amount: 14 }],
  ];
  const journals = [];
  try {
    for (const [transactionType, amounts] of cases) {
      const journal = await accountingService.createBusinessJournal(client, organizationId, actorId, {
        ...common,
        ...amounts,
        transactionType,
        sourceTransactionId: `${transactionType}:${randomUUID()}`,
        description: `Automatic ${transactionType} test`,
      });
      journals.push(journal);
      assert.equal(journal.status, 'POSTED', `${transactionType} should be posted`);
      const totals = journal.lines.reduce((sum, line) => ({ debit: sum.debit + Number(line.debit), credit: sum.credit + Number(line.credit) }), { debit: 0, credit: 0 });
      assert.ok(Math.abs(totals.debit - totals.credit) < 0.000001, `${transactionType} must balance`);
    }
  } finally {
    const ids = journals.map((journal) => journal.id);
    if (ids.length) {
      await client.query('DELETE FROM accounting_journal_lines WHERE journal_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM accounting_journals WHERE id = ANY($1::uuid[])', [ids]);
    }
    await client.query('DELETE FROM accounting_accounts WHERE id = $1', [vatAccount.id]);
  }
});

test('monthly budget variance uses posted journal actuals and governance dimensions', async () => {
  const [asset, revenue] = await createTestAccounts();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const costCenterCode = `C${suffix}`;
  const profitCenterCode = `P${suffix}`;
  const fiscalYear = 2098;
  const budgetCode = `B${suffix}`;
  const journalDate = `${fiscalYear}-02-01`;
  let journal;
  let costCenter;
  let profitCenter;
  try {
    costCenter = (await client.query(
      `INSERT INTO enterprise_cost_centers (organization_id, code, name)
       VALUES ($1, $2, $3) RETURNING id`,
      [organizationId, costCenterCode, 'Budget variance test'],
    )).rows[0];
    profitCenter = (await client.query(
      `INSERT INTO enterprise_profit_centers (organization_id, code, name)
       VALUES ($1, $2, $3) RETURNING id`,
      [organizationId, profitCenterCode, 'Budget variance test'],
    )).rows[0];
    await accountingService.saveBudgetLine(client, organizationId, actorId, {
      budgetCode,
      budgetName: 'Budget variance integration test',
      fiscalYear,
      periodStart: `${fiscalYear}-02-01`,
      accountId: asset.id,
      amount: 100,
      costCenterCode,
      profitCenterCode,
    });
    journal = await accountingService.createJournal(client, organizationId, actorId, {
      transactionDate: journalDate,
      description: 'Budget actual integration test',
      sourceModule: 'test',
      sourceTransactionId: randomUUID(),
      status: 'APPROVED',
      lines: [
        { accountId: asset.id, debit: 125, credit: 0, description: 'Budgeted actual', costCenter: costCenterCode, profitCenter: profitCenterCode },
        { accountId: revenue.id, debit: 0, credit: 125, description: 'Offsetting credit' },
      ],
    });
    await accountingService.postJournal(client, organizationId, actorId, journal.id);
    const report = await accountingService.getBudgetWorkspace(client, organizationId);
    const line = report.find((item) => item.budget_code === budgetCode && new Date(item.period_start).toISOString().slice(0, 10) === journalDate);
    assert.ok(line);
    assert.equal(Number(line.budget_amount), 100);
    assert.equal(Number(line.actual_amount), 125);
    assert.equal(Number(line.variance), -25);
  } finally {
    if (journal) {
      await client.query('DELETE FROM accounting_journal_lines WHERE journal_id = $1', [journal.id]);
      await client.query('DELETE FROM accounting_journals WHERE id = $1', [journal.id]);
    }
    await client.query('DELETE FROM accounting_budgets WHERE organization_id = $1 AND budget_code = $2', [organizationId, budgetCode]);
    if (costCenter) await client.query('DELETE FROM enterprise_cost_centers WHERE id = $1', [costCenter.id]);
    if (profitCenter) await client.query('DELETE FROM enterprise_profit_centers WHERE id = $1', [profitCenter.id]);
    await client.query('DELETE FROM accounting_accounts WHERE id IN ($1, $2)', [asset.id, revenue.id]);
  }
});
