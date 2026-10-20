import { randomUUID } from 'node:crypto';

const ACCOUNT_COLUMNS = `
  id, organization_id, account_code, account_name, account_type,
  parent_account_id, active, description, normal_balance, opening_balance,
  created_at, updated_at
`;

function toNumber(value) {
  return Number(value);
}

export async function getAccountingAccounts(client, organizationId) {
  const result = await client.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounting_accounts
     WHERE organization_id = $1
     ORDER BY account_code`,
    [organizationId],
  );
  return result.rows;
}

export async function getAccountingBudgetWorkspace(client, organizationId) {
  const result = await client.query(
    `SELECT budget.id AS budget_id, budget.budget_code, budget.budget_name,
            budget.fiscal_year, budget.status AS budget_status,
            line.id AS line_id, line.period_start, line.account_id,
            account.account_code, account.account_name, account.account_type,
            line.cost_center_code, line.profit_center_code, line.budget_amount,
            COALESCE(actual.actual_amount, 0) AS actual_amount,
            line.budget_amount - COALESCE(actual.actual_amount, 0) AS variance
     FROM accounting_budgets budget
     LEFT JOIN accounting_budget_lines line
       ON line.budget_id = budget.id AND line.organization_id = budget.organization_id
     LEFT JOIN accounting_accounts account
       ON account.id = line.account_id AND account.organization_id = budget.organization_id
     LEFT JOIN LATERAL (
       SELECT SUM(CASE WHEN account.normal_balance = 'DEBIT'
                       THEN journal_line.debit - journal_line.credit
                       ELSE journal_line.credit - journal_line.debit END) AS actual_amount
       FROM accounting_journals journal
       JOIN accounting_journal_lines journal_line ON journal_line.journal_id = journal.id
       WHERE journal.organization_id = budget.organization_id
         AND journal.status = 'POSTED'
         AND journal.transaction_date >= line.period_start
         AND journal.transaction_date < (line.period_start + INTERVAL '1 month')
         AND journal_line.account_id = line.account_id
         AND COALESCE(journal_line.cost_center, '') = line.cost_center_code
         AND COALESCE(journal_line.profit_center, '') = line.profit_center_code
     ) actual ON line.id IS NOT NULL
     WHERE budget.organization_id = $1
     ORDER BY budget.fiscal_year DESC, line.period_start, account.account_code,
              line.cost_center_code, line.profit_center_code`,
    [organizationId],
  );
  return result.rows;
}

export async function saveAccountingBudgetLine(client, organizationId, actorId, input) {
  const budgetResult = await client.query(
    `INSERT INTO accounting_budgets (organization_id, budget_code, budget_name, fiscal_year, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, fiscal_year) DO UPDATE
       SET budget_code = EXCLUDED.budget_code, budget_name = EXCLUDED.budget_name,
           updated_at = CURRENT_TIMESTAMP
       WHERE accounting_budgets.status = 'ACTIVE'
     RETURNING id, budget_code, budget_name, fiscal_year, status`,
    [organizationId, input.budgetCode, input.budgetName, input.fiscalYear, actorId],
  );
  if (!budgetResult.rows[0]) throw new Error('A closed budget cannot be changed.');

  const result = await client.query(
    `INSERT INTO accounting_budget_lines (
       organization_id, budget_id, account_id, period_start,
       cost_center_code, profit_center_code, budget_amount
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (budget_id, account_id, period_start, cost_center_code, profit_center_code)
     DO UPDATE SET budget_amount = EXCLUDED.budget_amount, updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [
      organizationId, budgetResult.rows[0].id, input.accountId, input.periodStart,
      input.costCenterCode, input.profitCenterCode, input.amount,
    ],
  );
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_budget_line_saved', result.rows[0].id, {
    budgetCode: budgetResult.rows[0].budget_code,
    fiscalYear: budgetResult.rows[0].fiscal_year,
    accountId: input.accountId,
    periodStart: input.periodStart,
    costCenterCode: input.costCenterCode || null,
    profitCenterCode: input.profitCenterCode || null,
    budgetAmount: input.amount,
  }, 'accounting_budget_line');
  return result.rows[0];
}

export async function getAccountingAccount(client, organizationId, accountId) {
  const result = await client.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounting_accounts
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, accountId],
  );
  return result.rows[0] ?? null;
}

export async function getAccountingAccountByCode(client, organizationId, accountCode) {
  const normalizedCode = String(accountCode ?? '').trim().toUpperCase();
  const result = await client.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounting_accounts
     WHERE organization_id = $1 AND UPPER(account_code) = $2 AND active = TRUE`,
    [organizationId, normalizedCode],
  );
  return result.rows[0] ?? null;
}

export async function createAccountingAccount(client, organizationId, actorId, input) {
  const result = await client.query(
    `INSERT INTO accounting_accounts (
      organization_id, account_code, account_name, account_type,
      parent_account_id, active, description, normal_balance, opening_balance,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING ${ACCOUNT_COLUMNS}`,
    [
      organizationId,
      String(input.accountCode).trim().toUpperCase(),
      String(input.accountName).trim(),
      input.accountType,
      input.parentAccountId || null,
      input.active !== false,
      input.description || null,
      input.normalBalance,
      normalizeAmount(input.openingBalance),
    ],
  );
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_account_created', result.rows[0].id, {
    accountCode: result.rows[0].account_code,
    accountName: result.rows[0].account_name,
  }, 'accounting_account');
  return result.rows[0];
}

export async function updateAccountingAccount(client, organizationId, accountId, actorId, input) {
  const result = await client.query(
    `UPDATE accounting_accounts
     SET account_name = $1, account_type = $2, parent_account_id = $3,
         active = $4, description = $5, normal_balance = $6,
         opening_balance = $7, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = $8 AND id = $9
     RETURNING ${ACCOUNT_COLUMNS}`,
    [
      input.accountName,
      input.accountType,
      input.parentAccountId || null,
      input.active !== false,
      input.description || null,
      input.normalBalance,
      normalizeAmount(input.openingBalance),
      organizationId,
      accountId,
    ],
  );
  if (!result.rows[0]) return null;
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_account_updated', accountId, {
    accountName: input.accountName,
    accountType: input.accountType,
  }, 'accounting_account');
  return result.rows[0];
}

export async function getAccountingPeriods(client, organizationId) {
  const result = await client.query(
    `SELECT id, organization_id, fiscal_year, period_number, period_start, period_end,
            status, closed_at, closed_by, created_at, updated_at
     FROM accounting_periods
     WHERE organization_id = $1
     ORDER BY fiscal_year DESC, period_number DESC`,
    [organizationId],
  );
  return result.rows;
}

export async function createAccountingPeriod(client, organizationId, actorId, input) {
  const year = Number(input.fiscalYear);
  const month = Number(input.periodNumber);
  const periodStart = String(input.periodStart || '');
  const periodEnd = String(input.periodEnd || '');
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  if (!Number.isInteger(year) || year < 2000 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) ||
    Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start >= end ||
    start.getUTCFullYear() !== year || start.getUTCMonth() + 1 !== month ||
    end.getUTCFullYear() !== year || end.getUTCMonth() + 1 !== month) {
    throw new Error('A period requires a valid fiscal year, month, and date range within that month.');
  }
  const overlap = await client.query(
    `SELECT id FROM accounting_periods
     WHERE organization_id = $1 AND period_start <= $3 AND period_end >= $2`,
    [organizationId, periodStart, periodEnd],
  );
  if (overlap.rows.length) throw new Error('Accounting periods cannot overlap.');
  const result = await client.query(
    `INSERT INTO accounting_periods (organization_id, fiscal_year, period_number, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [organizationId, year, month, periodStart, periodEnd],
  );
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_period_created', result.rows[0].id, {
    fiscalYear: year,
    periodNumber: month,
  }, 'accounting_period');
  return result.rows[0];
}

export async function getOrCreateAccountingPeriod(client, organizationId, actorId, date = new Date()) {
  const transactionDate = new Date(date);
  const dateOnly = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const fiscalYear = dateOnly ? Number(date.slice(0, 4)) : transactionDate.getUTCFullYear();
  const periodNumber = dateOnly ? Number(date.slice(5, 7)) : transactionDate.getUTCMonth() + 1;
  const periodStart = `${fiscalYear}-${String(periodNumber).padStart(2, '0')}-01`;
  const periodEnd = new Date(Date.UTC(fiscalYear, periodNumber, 0)).toISOString().slice(0, 10);
  const periodResult = await client.query(
    `SELECT id, fiscal_year, period_number, status FROM accounting_periods
     WHERE organization_id = $1 AND fiscal_year = $2 AND period_number = $3
     FOR UPDATE`,
    [organizationId, fiscalYear, periodNumber],
  );
  if (periodResult.rows[0]) return periodResult.rows[0];

  const inserted = await client.query(
    `INSERT INTO accounting_periods (
      organization_id, fiscal_year, period_number, period_start, period_end, status,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, 'OPEN', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING id, fiscal_year, period_number, status`,
    [organizationId, fiscalYear, periodNumber, periodStart, periodEnd],
  );
  const period = inserted.rows[0];
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_period_created', period.id, {
    fiscalYear,
    periodNumber,
  });
  return period;
}

export async function closeAccountingPeriod(client, organizationId, actorId, periodId) {
  const pending = await client.query(
    `SELECT 1 FROM accounting_journals
     WHERE organization_id = $1 AND accounting_period_id = $2
       AND status IN ('DRAFT', 'SUBMITTED', 'APPROVED') LIMIT 1`,
    [organizationId, periodId],
  );
  if (pending.rows.length) throw new Error('Submit, approve, or cancel all journals before closing the period.');
  const result = await client.query(
    `UPDATE accounting_periods
     SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, closed_by = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND organization_id = $3 AND status = 'OPEN'
     RETURNING id, fiscal_year, period_number, period_start, period_end, status, closed_at`,
    [actorId, periodId, organizationId],
  );
  if (!result.rows[0]) return null;
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_period_closed', periodId, {
    fiscalYear: result.rows[0].fiscal_year,
    periodNumber: result.rows[0].period_number,
  }, 'accounting_period');
  return result.rows[0];
}

export async function reopenAccountingPeriod(client, organizationId, actorId, periodId, reason) {
  const periodResult = await client.query(
    `SELECT id, fiscal_year, period_number, closed_at, closed_by
     FROM accounting_periods
     WHERE organization_id = $1 AND id = $2 AND status = 'CLOSED'
     FOR UPDATE`,
    [organizationId, periodId],
  );
  const period = periodResult.rows[0];
  if (!period) return null;

  await client.query(
    `INSERT INTO accounting_period_reopen_history (
       organization_id, period_id, reopened_by, reason, previous_closed_at, previous_closed_by
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [organizationId, periodId, actorId, reason, period.closed_at, period.closed_by],
  );
  const result = await client.query(
    `UPDATE accounting_periods
     SET status = 'OPEN', closed_at = NULL, closed_by = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = $1 AND id = $2 AND status = 'CLOSED'
     RETURNING id, fiscal_year, period_number, period_start, period_end, status`,
    [organizationId, periodId],
  );
  if (!result.rows[0]) return null;

  await recordAccountingAudit(client, organizationId, actorId, 'accounting_period_reopened', periodId, {
    fiscalYear: period.fiscal_year,
    periodNumber: period.period_number,
    reason,
    previousClosedAt: period.closed_at,
    previousClosedBy: period.closed_by,
  }, 'accounting_period');
  return result.rows[0];
}

export async function createAccountingJournal(client, organizationId, actorId, input) {
  const transactionDate = input.transactionDate instanceof Date
    ? input.transactionDate.toISOString().slice(0, 10)
    : String(input.transactionDate).slice(0, 10);
  const period = await getOrCreateAccountingPeriod(client, organizationId, actorId, transactionDate);
  const fiscalYear = Number(period.fiscal_year ?? period.fiscalYear ?? transactionDate.slice(0, 4));
  await client.query(
    `INSERT INTO accounting_journal_sequences (organization_id, fiscal_year, next_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (organization_id, fiscal_year) DO NOTHING`,
    [organizationId, fiscalYear],
  );
  const sequenceResult = await client.query(
    `SELECT next_number FROM accounting_journal_sequences
     WHERE organization_id = $1 AND fiscal_year = $2
     FOR UPDATE`,
    [organizationId, fiscalYear],
  );
  if (!sequenceResult.rows[0]) throw new Error('Accounting journal sequence not found.');
  const existingJournalResult = await client.query(
    `SELECT COALESCE(MAX(substring(journal_number FROM '^JE-[0-9]{4}-([0-9]+)$')::BIGINT), 0) AS last_number
     FROM accounting_journals
     WHERE organization_id = $1
       AND journal_number LIKE $2`,
    [organizationId, `JE-${fiscalYear}-%`],
  );
  const nextNumber = Math.max(
    Number(sequenceResult.rows[0].next_number),
    Number(existingJournalResult.rows[0].last_number) + 1,
  );
  const journalNumber = `JE-${fiscalYear}-${String(nextNumber).padStart(6, '0')}`;
  const status = input.status || 'DRAFT';
  const result = await client.query(
    `INSERT INTO accounting_journals (
      organization_id, journal_number, accounting_period_id, transaction_date,
      reference, description, source_module, source_transaction_id, currency,
      status, created_by, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING id, organization_id, journal_number, accounting_period_id,
              transaction_date, reference, description, source_module,
              source_transaction_id, currency, status, created_by, created_at, updated_at`,
    [
      organizationId,
      journalNumber,
      period.id,
      transactionDate,
      input.reference || null,
      input.description,
      input.sourceModule,
      input.sourceTransactionId || null,
      input.currency || 'ETB',
      status,
      actorId,
    ],
  );
  await client.query(
    `UPDATE accounting_journal_sequences
     SET next_number = $3, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = $1 AND fiscal_year = $2`,
    [organizationId, fiscalYear, nextNumber + 1],
  );
  const journal = result.rows[0];
  await insertJournalLines(client, journal.id, input.lines, organizationId);
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_journal_created', journal.id, {
    journalNumber,
    status,
    sourceModule: input.sourceModule,
    sourceTransactionId: input.sourceTransactionId || null,
  });
  return { ...journal, period, lines: await getJournalLines(client, journal.id) };
}

export async function getJournalLines(client, journalId) {
  const result = await client.query(
    `SELECT line.id, line.journal_id, line.account_id, account.account_code,
            account.account_name, line.line_number, line.debit, line.credit,
           line.description, line.cost_center, line.profit_center, line.created_at
     FROM accounting_journal_lines line
     JOIN accounting_accounts account ON account.id = line.account_id
     WHERE line.journal_id = $1
     ORDER BY line.line_number`,
    [journalId],
  );
  return result.rows;
}

export async function getAccountingJournal(client, organizationId, journalId) {
  const result = await client.query(
    `SELECT j.id, j.organization_id, j.journal_number, j.accounting_period_id,
            p.fiscal_year, p.period_number, p.status AS period_status,
            j.transaction_date, j.reference, j.description, j.source_module,
            j.source_transaction_id, j.currency, j.status, j.created_by,
            j.approved_by, j.posted_by, j.reversed_by, j.approved_at,
            j.posted_at, j.reversed_at, j.reversal_journal_id, j.created_at,
            j.updated_at
     FROM accounting_journals j
     JOIN accounting_periods p ON p.id = j.accounting_period_id
     WHERE j.organization_id = $1 AND j.id = $2`,
    [organizationId, journalId],
  );
  if (!result.rows[0]) return null;
  return { ...result.rows[0], lines: await getJournalLines(client, journalId) };
}

export async function getAccountingJournals(client, organizationId, status) {
  const query = status
    ? `SELECT j.id, j.journal_number, j.transaction_date, j.reference,
               j.description, j.source_module, j.source_transaction_id,
               j.currency, j.status, j.created_at, j.updated_at,
               p.fiscal_year, p.period_number
        FROM accounting_journals j
        JOIN accounting_periods p ON p.id = j.accounting_period_id
        WHERE j.organization_id = $1 AND j.status = $2
        ORDER BY j.transaction_date DESC, j.created_at DESC`
    : `SELECT j.id, j.journal_number, j.transaction_date, j.reference,
               j.description, j.source_module, j.source_transaction_id,
               j.currency, j.status, j.created_at, j.updated_at,
               p.fiscal_year, p.period_number
        FROM accounting_journals j
        JOIN accounting_periods p ON p.id = j.accounting_period_id
        WHERE j.organization_id = $1
        ORDER BY j.transaction_date DESC, j.created_at DESC`;
  const result = await client.query(query, status ? [organizationId, status] : [organizationId]);
  return result.rows;
}

export async function submitAccountingJournal(client, organizationId, actorId, journalId) {
  const journal = await getAccountingJournal(client, organizationId, journalId);
  if (!journal || journal.status !== 'DRAFT') return null;
  const result = await client.query(
    `UPDATE accounting_journals
     SET status = 'SUBMITTED', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND organization_id = $2 AND status = 'DRAFT'
     RETURNING *`,
    [journalId, organizationId],
  );
  if (!result.rows[0]) return null;
  await recordStatusHistory(client, journalId, 'DRAFT', 'SUBMITTED', actorId, 'Journal submitted');
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_journal_submitted', journalId, {
    journalNumber: journal.journal_number,
  });
  return result.rows[0];
}

export async function approveAccountingJournal(client, organizationId, actorId, journalId) {
  const journal = await getAccountingJournal(client, organizationId, journalId);
  if (!journal || journal.status !== 'SUBMITTED') return null;
  const result = await client.query(
    `UPDATE accounting_journals
     SET status = 'APPROVED', approved_by = $1, approved_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND organization_id = $3 AND status = 'SUBMITTED'
     RETURNING *`,
    [actorId, journalId, organizationId],
  );
  if (!result.rows[0]) return null;
  await recordStatusHistory(client, journalId, journal.status, 'APPROVED', actorId, 'Journal approved');
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_journal_approved', journalId, {
    journalNumber: journal.journal_number,
  });
  return result.rows[0];
}

export async function postAccountingJournal(client, organizationId, actorId, journalId) {
  const journal = await getAccountingJournal(client, organizationId, journalId);
  if (!journal || journal.status !== 'APPROVED') return null;
  if (journal.period_status === 'CLOSED') throw new Error('The accounting period is closed.');
  const balanced = await isBalanced(client, journalId);
  if (!balanced) throw new Error('Journal is unbalanced.');
  const result = await client.query(
    `UPDATE accounting_journals
     SET status = 'POSTED', posted_by = $1, posted_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND organization_id = $3 AND status = 'APPROVED'
     RETURNING *`,
    [actorId, journalId, organizationId],
  );
  if (!result.rows[0]) return null;
  await recordStatusHistory(client, journalId, journal.status, 'POSTED', actorId, 'Journal posted');
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_journal_posted', journalId, {
    journalNumber: journal.journal_number,
  });
  return result.rows[0];
}

export async function cancelAccountingJournal(client, organizationId, actorId, journalId, reason) {
  const journal = await getAccountingJournal(client, organizationId, journalId);
  if (!journal || !['DRAFT', 'SUBMITTED'].includes(journal.status)) return null;
  const result = await client.query(
    `UPDATE accounting_journals
     SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND organization_id = $2 AND status IN ('DRAFT', 'SUBMITTED')
     RETURNING *`,
    [journalId, organizationId],
  );
  if (!result.rows[0]) return null;
  await recordStatusHistory(client, journalId, journal.status, 'CANCELLED', actorId, reason || 'Journal cancelled');
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_journal_cancelled', journalId, { reason });
  return result.rows[0];
}

export async function reverseAccountingJournal(client, organizationId, actorId, journalId, reason) {
  const journal = await getAccountingJournal(client, organizationId, journalId);
  if (!journal || journal.status !== 'POSTED') return null;
  if (journal.period_status === 'CLOSED') throw new Error('The accounting period is closed.');
  const reversalLines = await client.query(
    `SELECT account_id, credit AS debit, debit AS credit, description, cost_center, profit_center
     FROM accounting_journal_lines
     WHERE journal_id = $1`,
    [journalId],
  );
  const reversalResult = await client.query(
    `SELECT id FROM accounting_journals
     WHERE organization_id = $1 AND reversal_journal_id = $2`,
    [organizationId, journalId],
  );
  if (reversalResult.rows.length > 0) return null;
  const period = await getOrCreateAccountingPeriod(client, organizationId, actorId, journal.transaction_date);
  const sequenceResult = await client.query(
    `SELECT next_number FROM accounting_journal_sequences
     WHERE organization_id = $1 AND fiscal_year = $2
     FOR UPDATE`,
    [organizationId, period.fiscal_year],
  );
  const journalNumber = `JE-${period.fiscal_year}-${String(sequenceResult.rows[0].next_number).padStart(6, '0')}`;
  const reversal = await client.query(
    `INSERT INTO accounting_journals (
      organization_id, journal_number, accounting_period_id, transaction_date,
      reference, description, source_module, source_transaction_id, currency,
      status, created_by, posted_by, posted_at, reversal_journal_id,
      created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'POSTED', $10, $10,
              CURRENT_TIMESTAMP, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING *`,
    [
      organizationId,
      journalNumber,
      period.id,
      journal.transaction_date,
      `REV-${journal.journal_number}`,
      `Reversal of ${journal.journal_number}: ${journal.description}`,
      'accounting reversal',
      `${journal.source_transaction_id || journal.id}:REVERSAL`,
      journal.currency,
      actorId,
      journal.id,
    ],
  );
  for (const [index, line] of reversalLines.rows.entries()) {
    await client.query(
      `INSERT INTO accounting_journal_lines (
        journal_id, account_id, line_number, debit, credit, description, cost_center, profit_center,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
      [reversal.rows[0].id, line.account_id, index + 1, toNumber(line.debit), toNumber(line.credit), line.description, line.cost_center, line.profit_center],
    );
  }
  await client.query(
    `UPDATE accounting_journals
     SET status = 'REVERSED', reversed_by = $1, reversed_at = CURRENT_TIMESTAMP,
         reversal_journal_id = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND organization_id = $4`,
    [actorId, reversal.rows[0].id, journalId, organizationId],
  );
  await client.query(
    `UPDATE accounting_journal_sequences
     SET next_number = next_number + 1, updated_at = CURRENT_TIMESTAMP
     WHERE organization_id = $1 AND fiscal_year = $2`,
    [organizationId, period.fiscal_year],
  );
  await recordStatusHistory(client, journalId, journal.status, 'REVERSED', actorId, reason || 'Journal reversed');
  await recordAccountingAudit(client, organizationId, actorId, 'accounting_journal_reversed', journalId, {
    reversalJournalNumber: journalNumber,
    reason,
  });
  return reversal.rows[0];
}

export async function getAccountingLedger(client, organizationId, accountId) {
  const account = accountId ? await getAccountingAccount(client, organizationId, accountId) : null;
  if (accountId && !account) return null;
  const query = accountId
    ? `SELECT j.journal_number, j.transaction_date, j.reference, j.description,
              jl.line_number, jl.debit, jl.credit, jl.description AS line_description,
              jl.cost_center, jl.profit_center, j.status, j.source_module, j.source_transaction_id,
              j.created_at, j.posted_at
        FROM accounting_journal_lines jl
        JOIN accounting_journals j ON j.id = jl.journal_id
        WHERE j.organization_id = $1 AND jl.account_id = $2
          AND j.status = 'POSTED'
        ORDER BY j.transaction_date, j.journal_number, jl.line_number`
    : `SELECT j.journal_number, j.transaction_date, j.reference, j.description,
              jl.line_number, jl.debit, jl.credit, jl.description AS line_description,
              jl.cost_center, jl.profit_center, j.status, j.source_module, j.source_transaction_id,
              j.created_at, j.posted_at
        FROM accounting_journal_lines jl
        JOIN accounting_journals j ON j.id = jl.journal_id
        WHERE j.organization_id = $1 AND j.status = 'POSTED'
        ORDER BY j.transaction_date, j.journal_number, jl.line_number`;
  const result = await client.query(query, accountId ? [organizationId, accountId] : [organizationId]);
  let runningBalance = account ? toNumber(account.opening_balance) : null;
  const movements = result.rows.map((movement) => {
    if (account) {
      runningBalance += account.normal_balance === 'DEBIT'
        ? toNumber(movement.debit) - toNumber(movement.credit)
        : toNumber(movement.credit) - toNumber(movement.debit);
    }
    return { ...movement, running_balance: runningBalance };
  });
  return {
    account,
    openingBalance: account ? toNumber(account.opening_balance) : null,
    closingBalance: account ? runningBalance : null,
    movements,
  };
}

export async function getAccountingBalance(client, organizationId, accountId) {
  const account = await getAccountingAccount(client, organizationId, accountId);
  if (!account) return null;
  const result = await client.query(
    `SELECT
       COALESCE(SUM(debit), 0) AS debit,
       COALESCE(SUM(credit), 0) AS credit
     FROM accounting_journal_lines jl
     JOIN accounting_journals j ON j.id = jl.journal_id
    WHERE jl.account_id = $1 AND j.status = 'POSTED'`,
    [accountId],
  );
  const debit = toNumber(result.rows[0].debit);
  const credit = toNumber(result.rows[0].credit);
  const movement = account.normal_balance === 'DEBIT' ? debit - credit : credit - debit;
  return {
    account,
    debit,
    credit,
    movement,
    openingBalance: toNumber(account.opening_balance),
    closingBalance: toNumber(account.opening_balance) + movement,
  };
}

export async function getTrialBalance(client, organizationId) {
  const rows = await client.query(
    `SELECT a.account_code, a.account_name, a.account_type, a.normal_balance,
            COALESCE(SUM(jl.debit) FILTER (WHERE j.status = 'POSTED'), 0) AS debit,
            COALESCE(SUM(jl.credit) FILTER (WHERE j.status = 'POSTED'), 0) AS credit,
            COALESCE(SUM(jl.debit) FILTER (WHERE j.status = 'POSTED'), 0)
              - COALESCE(SUM(jl.credit) FILTER (WHERE j.status = 'POSTED'), 0) AS net
     FROM accounting_accounts a
     LEFT JOIN accounting_journal_lines jl ON jl.account_id = a.id
     LEFT JOIN accounting_journals j ON j.id = jl.journal_id
     WHERE a.organization_id = $1 AND a.active = TRUE
     GROUP BY a.id
     ORDER BY a.account_code`,
    [organizationId],
  );
  return rows.rows;
}

export async function getFinancialStatement(client, organizationId, reportType) {
  const accounts = await getAccountingAccounts(client, organizationId);
  const balances = await Promise.all(accounts.map((account) => getAccountingBalance(client, organizationId, account.id)));
  const byAccount = new Map(balances.map((balance) => [balance.account.account_code, balance]));
  const totals = { debit: 0, credit: 0 };
  for (const balance of balances) {
    totals.debit += balance.debit;
    totals.credit += balance.credit;
  }
  const result = {
    reportType,
    generatedAt: new Date().toISOString(),
    accounts: balances.map((balance) => ({
      accountCode: balance.account.account_code,
      accountName: balance.account.account_name,
      accountType: balance.account.account_type,
      debit: balance.debit,
      credit: balance.credit,
      openingBalance: balance.openingBalance,
      closingBalance: balance.closingBalance,
    })),
    totals,
  };
  if (reportType === 'trial-balance') return result;
  if (reportType === 'general-ledger') return result;
  if (reportType === 'profit-and-loss') {
    const revenue = accounts.filter((account) => ['REVENUE', 'OTHER_INCOME'].includes(account.account_type)).reduce((sum, account) => sum + byAccount.get(account.account_code).closingBalance, 0);
    const expenses = accounts.filter((account) => ['COGS', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'].includes(account.account_type)).reduce((sum, account) => sum + byAccount.get(account.account_code).closingBalance, 0);
    return { ...result, revenue, expenses, netIncome: revenue - expenses };
  }
  if (reportType === 'balance-sheet') {
    const assets = accounts.filter((account) => account.account_type === 'ASSET').reduce((sum, account) => sum + byAccount.get(account.account_code).closingBalance, 0);
    const liabilities = accounts.filter((account) => account.account_type === 'LIABILITY').reduce((sum, account) => sum + byAccount.get(account.account_code).closingBalance, 0);
    const equity = accounts.filter((account) => ['EQUITY'].includes(account.account_type)).reduce((sum, account) => sum + byAccount.get(account.account_code).closingBalance, 0);
    return { ...result, assets, liabilities, equity, totalLiabilitiesAndEquity: liabilities + equity };
  }
  if (reportType === 'cash-flow') {
    const cashAccounts = accounts.filter((account) => account.account_type === 'ASSET' && (
      account.account_code === '1000' || /cash|bank/i.test(account.account_name)
    ));
    const cashInflows = cashAccounts.reduce((sum, account) => sum + byAccount.get(account.account_code).debit, 0);
    const cashOutflows = cashAccounts.reduce((sum, account) => sum + byAccount.get(account.account_code).credit, 0);
    return {
      ...result,
      cashAccounts: cashAccounts.map((account) => ({ accountCode: account.account_code, accountName: account.account_name })),
      cashInflows,
      cashOutflows,
      netCashFlow: cashInflows - cashOutflows,
    };
  }
  if (reportType === 'account-statement') return result;
  throw new Error('Unsupported financial report.');
}

export async function createAutomaticJournal(client, organizationId, actorId, input) {
  const lines = await Promise.all(input.lines.map(async (line) => {
    const account = await getAccountingAccountByCode(client, organizationId, line.accountCode);
    if (!account) throw new Error(`Accounting account not found: ${line.accountCode}`);
    return { ...line, accountId: account.id };
  }));
  return createAccountingJournal(client, organizationId, actorId, {
    ...input,
    lines,
    status: input.status || 'DRAFT',
  });
}

async function insertJournalLines(client, journalId, lines, organizationId) {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('A journal must contain at least two lines.');
  const debitTotal = lines.reduce((sum, line) => sum + normalizeAmount(line.debit), 0);
  const creditTotal = lines.reduce((sum, line) => sum + normalizeAmount(line.credit), 0);
  if (Math.abs(debitTotal - creditTotal) > 0.000001) throw new Error('Journal debit and credit totals must match.');
  for (const [index, line] of lines.entries()) {
    const debit = normalizeAmount(line.debit);
    const credit = normalizeAmount(line.credit);
    if ((debit > 0) === (credit > 0)) throw new Error('Each journal line must contain exactly one positive debit or credit.');
    if (!line.description?.trim()) throw new Error('Every journal line requires a description.');
    const account = await client.query(
      'SELECT 1 FROM accounting_accounts WHERE id = $1 AND organization_id = $2 AND active = TRUE',
      [line.accountId, organizationId],
    );
    if (!account.rows[0]) throw new Error('Journal account must be active and belong to the current organization.');
    await client.query(
      `INSERT INTO accounting_journal_lines (
        journal_id, account_id, line_number, debit, credit, description, cost_center, profit_center, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
      [journalId, line.accountId, index + 1, debit, credit, line.description.trim(), line.costCenter || null, line.profitCenter || null],
    );
  }
}

async function isBalanced(client, journalId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
     FROM accounting_journal_lines WHERE journal_id = $1`,
    [journalId],
  );
  return Math.abs(toNumber(result.rows[0].debit) - toNumber(result.rows[0].credit)) <= 0.000001;
}

async function recordStatusHistory(client, journalId, fromStatus, toStatus, actorId, reason) {
  await client.query(
    `INSERT INTO accounting_journal_status_history (
      journal_id, from_status, to_status, changed_by, changed_at, reason, details
    ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, '{}'::jsonb)`,
    [journalId, fromStatus, toStatus, actorId, reason],
  );
}

async function recordAccountingAudit(client, organizationId, actorId, action, entityId, details, entityType = 'accounting_journal') {
  await client.query(
    `INSERT INTO audit_events (
      organization_id, actor_user_id, action, entity_type, entity_id, details
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [organizationId, actorId, action, entityType, entityId, JSON.stringify(details)],
  );
}

function normalizeAmount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) throw new Error('Amount must be a finite number.');
  return Math.round(number * 1_000_000) / 1_000_000;
}
