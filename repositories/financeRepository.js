import crypto from 'node:crypto';

export async function getBankingSnapshot(client, organizationId) {
  const accountsResult = await client.query(`
      SELECT id, code, name, bank_name, account_number, currency, current_balance, account_type, status
      FROM bank_accounts
      WHERE organization_id = $1
      ORDER BY created_at
    `, [organizationId]);
  const transactionsResult = await client.query(`
      SELECT
        id, bank_account_id, type, amount, description, category, reference, status,
        occurred_at, created_by, approved_at, approved_by
      FROM finance_transactions
      WHERE organization_id = $1
      ORDER BY occurred_at DESC
    `, [organizationId]);
  const statementsResult = await client.query(`
      SELECT statement.id, statement.bank_account_id, statement.legacy_id,
        statement.transaction_date, statement.description, statement.category,
        statement.type, statement.amount, statement.status, statement.reference,
        EXISTS (
          SELECT 1 FROM bank_reconciliation_matches match
          WHERE match.organization_id = statement.organization_id
            AND match.statement_transaction_id = statement.id
        ) AS is_matched
      FROM bank_statement_transactions statement
      WHERE statement.organization_id = $1
      ORDER BY statement.transaction_date DESC, statement.created_at DESC
    `, [organizationId]);
  const matchesResult = await client.query(`
      SELECT match.id, match.legacy_id, match.statement_transaction_id,
        match.finance_transaction_id, match.legacy_cashbook_transaction_id,
        match.amount, match.method, match.status, match.matched_at,
        statement.legacy_id AS legacy_statement_id,
        transaction.legacy_id AS legacy_transaction_id
      FROM bank_reconciliation_matches match
      JOIN bank_statement_transactions statement
        ON statement.id = match.statement_transaction_id
      LEFT JOIN finance_transactions transaction
        ON transaction.id = match.finance_transaction_id
      WHERE match.organization_id = $1
      ORDER BY match.matched_at DESC, match.id
    `, [organizationId]);

  const titleCase = (value) => String(value || '').toLowerCase().replace(/(^|_)([a-z])/g, (_match, prefix, letter) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`);
  const accounts = accountsResult.rows.map((account) => ({
    id: account.id,
    code: account.code,
    name: account.name,
    bank: account.bank_name,
    accountNumber: account.account_number,
    currency: account.currency,
    balance: Number(account.current_balance),
    type: account.account_type,
    status: titleCase(account.status),
  }));
  const transactions = transactionsResult.rows.map((transaction) => ({
    id: transaction.id,
    accountId: transaction.bank_account_id,
    date: new Date(transaction.occurred_at).toISOString().slice(0, 10),
    description: transaction.description,
    category: transaction.category,
    type: titleCase(transaction.type),
    amount: Number(transaction.amount),
    status: transaction.status === 'APPROVED' || transaction.status === 'CLEARED'
      ? 'Cleared'
      : titleCase(transaction.status),
    reference: transaction.reference || '',
  }));
  const statementTransactions = statementsResult.rows.map((statement) => ({
    id: statement.id,
    legacyId: statement.legacy_id,
    accountId: statement.bank_account_id,
    date: String(statement.transaction_date).slice(0, 10),
    description: statement.description,
    category: statement.category,
    type: titleCase(statement.type),
    amount: Number(statement.amount),
    status: statement.is_matched ? 'Matched' : titleCase(statement.status),
    reference: statement.reference || '',
  }));
  const reconciliationHistory = matchesResult.rows.map((match) => ({
    id: match.legacy_id || match.id,
    statementTransactionId: match.statement_transaction_id,
    cashbookTransactionId: match.finance_transaction_id,
    legacyCashbookTransactionId: match.legacy_cashbook_transaction_id,
    amount: Number(match.amount),
    method: match.method,
    status: titleCase(match.status),
    matchedOn: match.matched_at.toISOString(),
  }));
  const totalBalance = accounts.reduce((sum, account) => sum + account.balance, 0);
  const credits = transactions
    .filter((transaction) => transaction.type === 'Credit')
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const debits = transactions
    .filter((transaction) => transaction.type === 'Debit')
    .reduce((sum, transaction) => sum + transaction.amount, 0);

  return {
    accounts,
    transactions,
    statementTransactions,
    reconciliationHistory,
    summary: {
      totalBalance,
      credits,
      debits,
      pending: transactions.filter((transaction) => transaction.status === 'Pending').length,
    },
  };
}

export async function createBankAccount(client, organizationId, input) {
  const result = await client.query(`
    INSERT INTO bank_accounts (
      organization_id, code, name, bank_name, account_number, currency,
      opening_balance, current_balance, account_type, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 'ACTIVE')
    RETURNING id, code, name, bank_name, account_number, currency,
      current_balance, account_type, status
  `, [
    organizationId,
    input.code,
    input.name,
    input.bank || null,
    input.accountNumber,
    input.currency.toUpperCase(),
    Number(input.openingBalance),
    input.type,
  ]);
  const account = result.rows[0];
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    bank: account.bank_name,
    accountNumber: account.account_number,
    currency: account.currency,
    balance: Number(account.current_balance),
    type: account.account_type,
    status: 'Active',
  };
}

export async function createFinanceTransaction(client, organizationId, actorId, input) {
  return client.query(`
    INSERT INTO finance_transactions (
      organization_id, bank_account_id, type, amount, description, category,
      reference, status, created_by, occurred_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `, [
    organizationId,
    input.accountId,
    input.type.toUpperCase(),
    input.amount,
    input.description,
    input.category,
    input.reference || null,
    'PENDING',
    actorId,
    input.date,
  ]);
}

export async function approveFinanceTransaction(client, organizationId, transactionId, actorId) {
  await client.query('BEGIN');
  try {
    const transactionResult = await client.query(`
      SELECT id, bank_account_id, type, amount
      FROM finance_transactions
      WHERE id = $1 AND organization_id = $2 AND status = 'PENDING'
      FOR UPDATE
    `, [transactionId, organizationId]);
    const transaction = transactionResult.rows[0];
    if (!transaction) {
      await client.query('ROLLBACK');
      return { transaction: null };
    }

    const accountResult = await client.query(`
      SELECT id, current_balance
      FROM bank_accounts
      WHERE id = $1 AND organization_id = $2
      FOR UPDATE
    `, [transaction.bank_account_id, organizationId]);
    const account = accountResult.rows[0];
    if (!account) throw new Error('Bank transaction account was not found in its organization.');
    if (transaction.type === 'DEBIT' && Number(account.current_balance) < Number(transaction.amount)) {
      await client.query('ROLLBACK');
      return { transaction: null, insufficientFunds: true };
    }

    await client.query(`
      UPDATE bank_accounts
      SET current_balance = current_balance + CASE
        WHEN $1::text = 'CREDIT' THEN $2::numeric
        ELSE -$2::numeric
      END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND organization_id = $4
    `, [transaction.type, transaction.amount, account.id, organizationId]);
    const result = await client.query(`
      UPDATE finance_transactions
      SET status = 'APPROVED', approved_at = CURRENT_TIMESTAMP, approved_by = $3
      WHERE id = $1 AND organization_id = $2 AND status = 'PENDING'
      RETURNING *
    `, [transactionId, organizationId, actorId]);
    if (!result.rowCount) throw new Error('Pending bank transaction changed during approval.');
    await client.query('COMMIT');
    return { transaction: result.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function rejectFinanceTransaction(client, organizationId, transactionId, actorId) {
  const result = await client.query(`
    UPDATE finance_transactions
    SET status = 'REJECTED', approved_at = CURRENT_TIMESTAMP, approved_by = $3
    WHERE id = $1 AND organization_id = $2 AND status = 'PENDING'
    RETURNING *
  `, [transactionId, organizationId, actorId]);
  return result.rows[0] ?? null;
}

export async function createReconciliationMatch(client, organizationId, actorId, input) {
  await client.query('BEGIN');
  try {
    const statementResult = await client.query(`
      SELECT id, bank_account_id, amount
      FROM bank_statement_transactions
      WHERE id = $1 AND organization_id = $2
      FOR UPDATE
    `, [input.statementTransactionId, organizationId]);
    const transactionResult = await client.query(`
      SELECT id, bank_account_id, amount, type
      FROM finance_transactions
      WHERE id = $1 AND organization_id = $2
      FOR UPDATE
    `, [input.cashbookTransactionId, organizationId]);
    const statement = statementResult.rows[0];
    const transaction = transactionResult.rows[0];
    if (!statement || !transaction) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }
    if (statement.bank_account_id !== transaction.bank_account_id) {
      await client.query('ROLLBACK');
      return { accountMismatch: true };
    }

    const result = await client.query(`
      INSERT INTO bank_reconciliation_matches (
        organization_id, statement_transaction_id, finance_transaction_id,
        amount, method, status, matched_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, 'MATCHED', CURRENT_TIMESTAMP, $6)
      RETURNING id, statement_transaction_id, finance_transaction_id, amount,
        method, status, matched_at
    `, [organizationId, statement.id, transaction.id, statement.amount, input.method, actorId]);
    await client.query(`
      UPDATE bank_statement_transactions SET status = 'MATCHED'
      WHERE id = $1 AND organization_id = $2
    `, [statement.id, organizationId]);
    await client.query('COMMIT');
    const match = result.rows[0];
    return {
      match: {
        id: match.id,
        statementTransactionId: match.statement_transaction_id,
        cashbookTransactionId: match.finance_transaction_id,
        amount: Number(match.amount),
        method: match.method,
        status: 'Matched',
        matchedOn: match.matched_at.toISOString(),
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function createTransfer(client, organizationId, actorId, input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !input.fromAccountId || !input.toAccountId) {
    return { rowCount: 0, invalidInput: true };
  }

  await client.query('BEGIN');
  try {
    const result = await client.query(`
      SELECT id, currency, current_balance
      FROM bank_accounts
      WHERE organization_id = $1 AND id IN ($2, $3)
      ORDER BY id
      FOR UPDATE
    `, [organizationId, input.fromAccountId, input.toAccountId]);
    const accounts = new Map(result.rows.map((account) => [account.id, account]));
    const fromAccount = accounts.get(input.fromAccountId);
    const toAccount = accounts.get(input.toAccountId);

    if (!fromAccount || !toAccount || input.fromAccountId === input.toAccountId) {
      await client.query('ROLLBACK');
      return { rowCount: 0 };
    }
    if (fromAccount.currency !== toAccount.currency) {
      await client.query('ROLLBACK');
      return { rowCount: 0, currencyMismatch: true };
    }
    if (Number(fromAccount.current_balance) < amount) {
      await client.query('ROLLBACK');
      return { rowCount: 0, insufficientFunds: true };
    }

    const transferId = crypto.randomUUID();
    const occurredAt = input.date || new Date().toISOString();
    await client.query(`
      UPDATE bank_accounts
      SET current_balance = current_balance - $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [amount, input.fromAccountId]);
    await client.query(`
      UPDATE bank_accounts
      SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [amount, input.toAccountId]);
    await client.query(`
      INSERT INTO finance_transactions (
        id, organization_id, bank_account_id, type, amount, description, category,
        reference, status, created_by, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [crypto.randomUUID(), organizationId, input.fromAccountId, 'DEBIT', amount, input.description, 'Internal transfer', transferId, 'APPROVED', actorId, occurredAt]);
    await client.query(`
      INSERT INTO finance_transactions (
        id, organization_id, bank_account_id, type, amount, description, category,
        reference, status, created_by, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [crypto.randomUUID(), organizationId, input.toAccountId, 'CREDIT', amount, input.description, 'Internal transfer', transferId, 'APPROVED', actorId, occurredAt]);
    await client.query('COMMIT');
    return { rowCount: 2, transferId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
