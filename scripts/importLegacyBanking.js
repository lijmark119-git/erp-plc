import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from '../database.js';
import { migrateDatabase } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(__dirname, '..');
const sourcePath = path.join(projectDirectory, 'erp-data.json');
const importKey = 'erp-data-banking-v1';

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid legacy ${label} record.`);
  }
  return value;
}

function requireText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`Legacy ${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function requireAmount(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Legacy ${label} must be a positive finite number.`);
  }
  return amount;
}

function dateValue(value, label) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Legacy ${label} is not a valid date.`);
  return parsed;
}

function transactionStatus(value) {
  const normalized = String(value || 'Pending').toUpperCase();
  const status = normalized === 'CLEARED' ? 'CLEARED' : normalized;
  if (!['PENDING', 'APPROVED', 'REJECTED', 'CLEARED'].includes(status)) {
    throw new Error(`Unsupported legacy bank transaction status: ${value}`);
  }
  return status;
}

async function importLegacyBanking(pool) {
  const source = fs.readFileSync(sourcePath);
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
  const data = JSON.parse(source.toString('utf8'));
  const accounts = (data.bankAccounts || []).map((record) => requireRecord(record, 'account'));
  const transactions = (data.bankTransactions || []).map((record) => requireRecord(record, 'transaction'));
  const statements = (data.bankStatementTransactions || []).map((record) => requireRecord(record, 'statement'));
  const history = (data.bankReconciliationHistory || []).map((record) => requireRecord(record, 'reconciliation'));
  if (!accounts.length) throw new Error('The legacy banking source contains no bank accounts; import cancelled.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const organizationResult = await client.query(
      'SELECT id FROM organizations WHERE code = $1 AND is_active = TRUE',
      ['DEFAULT'],
    );
    if (organizationResult.rowCount !== 1) {
      throw new Error('The active DEFAULT organization was not found uniquely; import cancelled.');
    }
    const organizationId = organizationResult.rows[0].id;
    const priorImport = await client.query(
      'SELECT source_sha256, record_counts FROM legacy_data_imports WHERE import_key = $1 FOR UPDATE',
      [importKey],
    );
    if (priorImport.rowCount) {
      if (priorImport.rows[0].source_sha256 !== sourceHash) {
        throw new Error('The banking source changed after its prior import; refusing to overwrite imported data.');
      }
      await client.query('COMMIT');
      console.log(`Banking data was already imported; no changes made. Counts: ${JSON.stringify(priorImport.rows[0].record_counts)}`);
      return;
    }

    const counts = await client.query(`
      SELECT
        (SELECT count(*) FROM bank_accounts WHERE organization_id = $1) AS accounts,
        (SELECT count(*) FROM finance_transactions WHERE organization_id = $1) AS transactions,
        (SELECT count(*) FROM bank_statement_transactions WHERE organization_id = $1) AS statements,
        (SELECT count(*) FROM bank_reconciliation_matches WHERE organization_id = $1) AS reconciliations
    `, [organizationId]);
    if (Object.values(counts.rows[0]).some((count) => Number(count) !== 0)) {
      throw new Error(`Target organization already contains banking data (${JSON.stringify(counts.rows[0])}); import cancelled without changes.`);
    }

    const accountIds = new Map();
    for (const account of accounts) {
      const legacyId = requireText(account.id, 'account id', 120);
      const balance = Number(account.balance);
      if (!Number.isFinite(balance) || balance < 0) throw new Error(`Legacy account ${legacyId} has an invalid balance.`);
      const result = await client.query(`
        INSERT INTO bank_accounts (
          organization_id, code, legacy_id, name, bank_name, account_number,
          currency, opening_balance, current_balance, account_type, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10)
        RETURNING id
      `, [
        organizationId,
        `LEGACY-${legacyId}`,
        legacyId,
        requireText(account.name, 'account name', 160),
        account.bank ? requireText(account.bank, 'bank name', 160) : null,
        requireText(account.accountNumber, 'account number', 80),
        requireText(account.currency, 'account currency', 3).toUpperCase(),
        balance,
        requireText(account.type, 'account type', 40),
        String(account.status || 'Active').toUpperCase(),
      ]);
      accountIds.set(legacyId, result.rows[0].id);
    }

    const transactionIds = new Map();
    for (const transaction of transactions) {
      const legacyId = requireText(transaction.id, 'transaction id', 120);
      const accountId = accountIds.get(transaction.accountId);
      if (!accountId) throw new Error(`Legacy transaction ${legacyId} references an unknown bank account.`);
      const type = String(transaction.type || '').toUpperCase();
      if (!['CREDIT', 'DEBIT'].includes(type)) throw new Error(`Legacy transaction ${legacyId} has an unsupported type.`);
      const result = await client.query(`
        INSERT INTO finance_transactions (
          organization_id, bank_account_id, legacy_id, type, amount, description,
          category, reference, status, occurred_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
      `, [
        organizationId,
        accountId,
        legacyId,
        type,
        requireAmount(transaction.amount, `transaction ${legacyId} amount`),
        requireText(transaction.description, `transaction ${legacyId} description`, 240),
        requireText(transaction.category, `transaction ${legacyId} category`, 100),
        transaction.reference ? requireText(transaction.reference, `transaction ${legacyId} reference`, 120) : null,
        transactionStatus(transaction.status),
        dateValue(transaction.date, `transaction ${legacyId} date`),
      ]);
      transactionIds.set(legacyId, result.rows[0].id);
    }

    const statementIds = new Map();
    for (const statement of statements) {
      const legacyId = requireText(statement.id, 'statement id', 120);
      const accountId = accountIds.get(statement.accountId);
      if (!accountId) throw new Error(`Legacy statement ${legacyId} references an unknown bank account.`);
      const type = String(statement.type || '').toUpperCase();
      if (!['CREDIT', 'DEBIT'].includes(type)) throw new Error(`Legacy statement ${legacyId} has an unsupported type.`);
      const result = await client.query(`
        INSERT INTO bank_statement_transactions (
          organization_id, bank_account_id, legacy_id, transaction_date,
          description, category, type, amount, status, reference
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
      `, [
        organizationId,
        accountId,
        legacyId,
        dateValue(statement.date, `statement ${legacyId} date`),
        requireText(statement.description, `statement ${legacyId} description`, 240),
        requireText(statement.category, `statement ${legacyId} category`, 100),
        type,
        requireAmount(statement.amount, `statement ${legacyId} amount`),
        String(statement.status || 'Pending').toUpperCase(),
        statement.reference ? requireText(statement.reference, `statement ${legacyId} reference`, 120) : null,
      ]);
      statementIds.set(legacyId, result.rows[0].id);
    }

    for (const match of history) {
      const legacyId = match.id ? requireText(match.id, 'reconciliation id', 120) : null;
      const statementId = statementIds.get(match.statementTransactionId);
      if (!statementId) throw new Error(`Legacy reconciliation ${legacyId || '(without id)'} references an unknown statement.`);
      const transactionId = transactionIds.get(match.cashbookTransactionId) || null;
      const statement = statements.find((item) => item.id === match.statementTransactionId);
      const legacyAccountId = match.accountId || statement?.accountId;
      if (!accountIds.has(legacyAccountId)) throw new Error(`Legacy reconciliation ${legacyId || '(without id)'} references an unknown account.`);
      const method = String(match.method || 'manual').toLowerCase();
      if (!['reference', 'manual', 'amount'].includes(method)) {
        throw new Error(`Legacy reconciliation ${legacyId || '(without id)'} has an unsupported match method.`);
      }
      await client.query(`
        INSERT INTO bank_reconciliation_matches (
          organization_id, legacy_id, statement_transaction_id,
          finance_transaction_id, legacy_cashbook_transaction_id, amount,
          method, status, matched_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        organizationId,
        legacyId,
        statementId,
        transactionId,
        transactionId ? null : requireText(match.cashbookTransactionId, `reconciliation ${legacyId} legacy cashbook id`, 120),
        requireAmount(match.amount, `reconciliation ${legacyId} amount`),
        method,
        String(match.status || 'Matched').toUpperCase(),
        dateValue(match.matchedOn, `reconciliation ${legacyId} date`),
      ]);
      await client.query(
        "UPDATE bank_statement_transactions SET status = 'MATCHED' WHERE id = $1",
        [statementId],
      );
    }

    const recordCounts = {
      accounts: accounts.length,
      transactions: transactions.length,
      statements: statements.length,
      reconciliations: history.length,
      unresolvedLegacyCashbookReferences: history.filter((entry) => !transactionIds.has(entry.cashbookTransactionId)).length,
    };
    await client.query(`
      INSERT INTO legacy_data_imports (import_key, source_sha256, record_counts)
      VALUES ($1, $2, $3::jsonb)
    `, [importKey, sourceHash, JSON.stringify(recordCounts)]);
    await client.query('COMMIT');
    console.log(`Imported legacy banking records into the DEFAULT organization: ${JSON.stringify(recordCounts)}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const pool = createDatabasePool();
try {
  await migrateDatabase(pool);
  await importLegacyBanking(pool);
} finally {
  await pool.end();
}
