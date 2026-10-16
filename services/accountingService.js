import {
  approveAccountingJournal,
  cancelAccountingJournal,
  closeAccountingPeriod,
  createAccountingAccount,
  createAccountingJournal,
  createAccountingPeriod,
  createAutomaticJournal,
  getAccountingAccount,
  getAccountingAccountByCode,
  getAccountingAccounts,
  getAccountingBalance,
  getAccountingJournal,
  getAccountingJournals,
  getAccountingLedger,
  getAccountingPeriods,
  getFinancialStatement,
  getTrialBalance,
  postAccountingJournal,
  reverseAccountingJournal,
  submitAccountingJournal,
  updateAccountingAccount,
} from '../repositories/accountingRepository.js';

const JOURNAL_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REVERSED', 'CANCELLED']);
const ACCOUNT_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'OPERATING_EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE']);
const NORMAL_BALANCES = new Set(['DEBIT', 'CREDIT']);

export const accountingService = {
  async getAccounts(client, organizationId) {
    return getAccountingAccounts(client, organizationId);
  },

  async createAccount(client, organizationId, actorId, input) {
    const account = normalizeAccountInput(input);
    if (account.parentAccountId) await validateAccountParent(client, organizationId, account.parentAccountId);
    return createAccountingAccount(client, organizationId, actorId, account);
  },

  async updateAccount(client, organizationId, actorId, accountId, input) {
    const current = await getAccountingAccount(client, organizationId, accountId);
    if (!current) return null;
    const account = normalizeAccountInput({ ...current, ...input });
    if (account.parentAccountId) {
      if (account.parentAccountId === accountId) throw new Error('An account cannot be its own parent.');
      await validateAccountParent(client, organizationId, account.parentAccountId, accountId);
    }
    return updateAccountingAccount(client, organizationId, accountId, actorId, account);
  },

  async getPeriods(client, organizationId) {
    return getAccountingPeriods(client, organizationId);
  },

  async createPeriod(client, organizationId, actorId, input) {
    return createAccountingPeriod(client, organizationId, actorId, input);
  },

  async closePeriod(client, organizationId, actorId, periodId) {
    return closeAccountingPeriod(client, organizationId, actorId, periodId);
  },

  async createJournal(client, organizationId, actorId, input) {
    validateJournalInput(input);
    return createAccountingJournal(client, organizationId, actorId, input);
  },

  async approveJournal(client, organizationId, actorId, journalId) {
    return approveAccountingJournal(client, organizationId, actorId, journalId);
  },

  async postJournal(client, organizationId, actorId, journalId) {
    return postAccountingJournal(client, organizationId, actorId, journalId);
  },

  async cancelJournal(client, organizationId, actorId, journalId, reason) {
    return cancelAccountingJournal(client, organizationId, actorId, journalId, reason);
  },

  async reverseJournal(client, organizationId, actorId, journalId, reason) {
    return reverseAccountingJournal(client, organizationId, actorId, journalId, reason);
  },

  async createAutomaticJournal(client, organizationId, actorId, input) {
    return createAutomaticJournal(client, organizationId, actorId, input);
  },

  async createBusinessJournal(client, organizationId, actorId, input) {
    const templates = {
      'sales-invoice': [
        { code: input.receivableAccountCode || '1100', side: 'debit', amount: Number(input.amount), description: 'Accounts receivable' },
        { code: input.revenueAccountCode || '4000', side: 'credit', amount: Number(input.amount) - Number(input.vatAmount || 0), description: 'Sales revenue' },
        { code: input.vatAccountCode || '2200', side: 'credit', amount: Number(input.vatAmount || 0), description: 'VAT payable' },
      ],
      'customer-payment': [
        { code: input.cashAccountCode || '1000', side: 'debit', amount: Number(input.amount), description: 'Cash or bank received' },
        { code: input.receivableAccountCode || '1100', side: 'credit', amount: Number(input.amount), description: 'Accounts receivable collected' },
      ],
      'purchase-invoice': [
        { code: input.inventoryAccountCode || '1200', side: 'debit', amount: Number(input.inventoryAmount || 0), description: 'Inventory acquired' },
        { code: input.expenseAccountCode || '6000', side: 'debit', amount: Number(input.expenseAmount || 0), description: 'Purchase expense' },
        { code: input.recoverableVatAccountCode || '1100', side: 'debit', amount: Number(input.recoverableVat || 0), description: 'Recoverable VAT' },
        { code: input.payableAccountCode || '2000', side: 'credit', amount: Number(input.inventoryAmount || 0) + Number(input.expenseAmount || 0) + Number(input.recoverableVat || 0), description: 'Accounts payable' },
      ],
      'supplier-payment': [
        { code: input.payableAccountCode || '2000', side: 'debit', amount: Number(input.amount), description: 'Accounts payable settled' },
        { code: input.cashAccountCode || '1000', side: 'credit', amount: Number(input.amount), description: 'Cash or bank paid' },
      ],
      expense: [
        { code: input.expenseAccountCode || '6000', side: 'debit', amount: Number(input.amount), description: input.description || 'Operating expense' },
        { code: input.paymentAccountCode || '1000', side: 'credit', amount: Number(input.amount), description: 'Expense payment' },
      ],
      'inventory-receipt': [
        { code: input.inventoryAccountCode || '1200', side: 'debit', amount: Number(input.amount), description: 'Inventory received' },
        { code: input.grniAccountCode || '2000', side: 'credit', amount: Number(input.amount), description: 'Goods received not invoiced' },
      ],
      'inventory-issue': [
        { code: input.cogsAccountCode || '5000', side: 'debit', amount: Number(input.amount), description: 'Cost of goods issued' },
        { code: input.inventoryAccountCode || '1200', side: 'credit', amount: Number(input.amount), description: 'Inventory relieved' },
      ],
      'manufacturing-consumption': [
        { code: input.wipAccountCode || '1300', side: 'debit', amount: Number(input.amount), description: 'Manufacturing work in progress' },
        { code: input.inventoryAccountCode || '1200', side: 'credit', amount: Number(input.amount), description: 'Raw materials consumed' },
      ],
      'manufacturing-completion': [
        { code: input.finishedGoodsAccountCode || '1400', side: 'debit', amount: Number(input.amount), description: 'Finished goods completed' },
        { code: input.wipAccountCode || '1300', side: 'credit', amount: Number(input.amount), description: 'Work in progress relieved' },
      ],
      'manufacturing-labor': [
        { code: input.wipAccountCode || '1300', side: 'debit', amount: Number(input.amount), description: 'Direct labor capitalized to work in progress' },
        { code: input.expenseAccountCode || '6010', side: 'credit', amount: Number(input.amount), description: 'Direct labor expense reclassified' },
      ],
      'manufacturing-overhead': [
        { code: input.wipAccountCode || '1300', side: 'debit', amount: Number(input.amount), description: 'Production overhead capitalized to work in progress' },
        { code: input.expenseAccountCode || '6000', side: 'credit', amount: Number(input.amount), description: 'Production overhead expense reclassified' },
      ],
      'manufacturing-scrap': [
        { code: input.scrapAccountCode || '7100', side: 'debit', amount: Number(input.amount), description: 'Rejected production scrap expense' },
        { code: input.wipAccountCode || '1300', side: 'credit', amount: Number(input.amount), description: 'Rejected work in progress relieved' },
      ],
    };
    const sourceType = String(input.transactionType || '');
    const template = templates[sourceType];
    if (!template) throw new Error('Unsupported automatic accounting transaction type.');
    if (sourceType === 'purchase-invoice' && Number(input.recoverableVat || 0) > 0 && !input.recoverableVatAccountCode) {
      throw new Error('recoverableVatAccountCode is required when recoverable VAT is recorded.');
    }
    const transactionDate = input.transactionDate || input.transaction_date;
    const sourceTransactionId = input.sourceTransactionId || input.source_transaction_id;
    if (!transactionDate || !sourceTransactionId || !input.description) {
      throw new Error('transactionDate, sourceTransactionId, and description are required.');
    }
    if (template.some((line) => !Number.isFinite(line.amount) || line.amount < 0)) {
      throw new Error('Automatic accounting amounts must be non-negative finite numbers.');
    }
    const lines = template.filter((line) => line.amount > 0).map((line) => ({
      accountCode: line.code,
      debit: line.side === 'debit' ? line.amount : 0,
      credit: line.side === 'credit' ? line.amount : 0,
      description: line.description,
    }));
    const journal = await this.createAutomaticJournal(client, organizationId, actorId, {
      transactionDate,
      reference: input.reference || null,
      description: input.description,
      sourceModule: sourceType.startsWith('manufacturing-') ? 'manufacturing' : sourceType.startsWith('inventory-') ? 'inventory' : sourceType.startsWith('sales-') ? 'sales' : sourceType.startsWith('purchase') || sourceType.startsWith('supplier-') ? 'procurement' : 'finance',
      sourceTransactionId,
      currency: input.currency || 'ETB',
      status: 'SUBMITTED',
      lines,
    });
    const approved = await this.approveJournal(client, organizationId, actorId, journal.id);
    if (!approved) throw new Error('Automatic journal could not be approved.');
    const posted = await this.postJournal(client, organizationId, actorId, journal.id);
    if (!posted) throw new Error('Automatic journal could not be posted.');
    return { ...posted, journalNumber: journal.journal_number, lines: journal.lines };
  },

  async getJournals(client, organizationId, status) {
    return getAccountingJournals(client, organizationId, status);
  },

  async submitJournal(client, organizationId, actorId, journalId) {
    return submitAccountingJournal(client, organizationId, actorId, journalId);
  },

  async getJournal(client, organizationId, journalId) {
    return getAccountingJournal(client, organizationId, journalId);
  },

  async getBalance(client, organizationId, accountId) {
    return getAccountingBalance(client, organizationId, accountId);
  },

  async getLedger(client, organizationId, accountId) {
    return getAccountingLedger(client, organizationId, accountId);
  },

  async getTrialBalance(client, organizationId) {
    return getTrialBalance(client, organizationId);
  },

  async getFinancialStatement(client, organizationId, reportType) {
    return getFinancialStatement(client, organizationId, reportType);
  },

  async getAccountByCode(client, organizationId, accountCode) {
    return getAccountingAccountByCode(client, organizationId, accountCode);
  },

  async closeFiscalYear(client, organizationId, actorId, fiscalYear, retainedEarningsCode = '3100') {
    const year = Number(fiscalYear);
    if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error('fiscalYear must be a valid four-digit year.');
    const periods = await getAccountingPeriods(client, organizationId);
    const yearPeriods = periods.filter((period) => Number(period.fiscal_year) === year);
    const openPeriods = yearPeriods.filter((period) => period.status === 'OPEN');
    if (!openPeriods.length) throw new Error(`Fiscal year ${year} has no open accounting periods.`);
    const unposted = await client.query(
      `SELECT 1 FROM accounting_journals j
       JOIN accounting_periods p ON p.id = j.accounting_period_id
       WHERE j.organization_id = $1 AND p.fiscal_year = $2
         AND j.status IN ('DRAFT', 'SUBMITTED', 'APPROVED') LIMIT 1`,
      [organizationId, year],
    );
    if (unposted.rows.length) throw new Error('Submit, approve, or cancel all journals before closing the fiscal year.');

    const balances = await client.query(
      `SELECT a.id, a.account_code, a.account_name, a.account_type, a.normal_balance,
              COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
       FROM accounting_accounts a
       LEFT JOIN accounting_journals j ON j.organization_id = $1 AND j.status = 'POSTED'
         AND j.transaction_date >= make_date($2, 1, 1)
         AND j.transaction_date < make_date($2 + 1, 1, 1)
       LEFT JOIN accounting_journal_lines jl ON jl.account_id = a.id AND jl.journal_id = j.id
       WHERE a.organization_id = $1
         AND a.account_type IN ('REVENUE', 'OTHER_INCOME', 'COGS', 'OPERATING_EXPENSE', 'OTHER_EXPENSE')
       GROUP BY a.id ORDER BY a.account_code`,
      [organizationId, year],
    );
    const lines = [];
    let revenue = 0;
    let expenses = 0;
    for (const account of balances.rows) {
      const debit = Number(account.debit);
      const credit = Number(account.credit);
      const amount = account.normal_balance === 'CREDIT' ? credit - debit : debit - credit;
      if (['REVENUE', 'OTHER_INCOME'].includes(account.account_type)) revenue += amount;
      else expenses += amount;
      if (Math.abs(amount) <= 0.000001) continue;
      const closesByDebit = account.normal_balance === 'CREDIT' ? amount > 0 : amount < 0;
      lines.push({
        accountId: account.id,
        debit: closesByDebit ? Math.abs(amount) : 0,
        credit: closesByDebit ? 0 : Math.abs(amount),
        description: `Close ${year} ${account.account_name}`,
      });
    }
    const netIncome = revenue - expenses;
    let closingJournal = null;
    if (lines.length) {
      const retainedEarnings = await getAccountingAccountByCode(client, organizationId, retainedEarningsCode);
      if (!retainedEarnings || retainedEarnings.account_type !== 'EQUITY') {
        throw new Error(`Retained earnings account ${retainedEarningsCode} is missing or is not an equity account.`);
      }
      const closeAmount = Math.round(Math.abs(netIncome) * 1_000_000) / 1_000_000;
      if (closeAmount > 0.000001) lines.push({
        accountId: retainedEarnings.id,
        debit: netIncome < 0 ? closeAmount : 0,
        credit: netIncome > 0 ? closeAmount : 0,
        description: `Close ${year} net ${netIncome < 0 ? 'loss' : 'income'}`,
      });
      const period = openPeriods.reduce((latest, current) => current.period_end > latest.period_end ? current : latest);
      closingJournal = await this.createJournal(client, organizationId, actorId, {
        transactionDate: String(period.period_end).slice(0, 10),
        reference: `FY-${year}-CLOSE`,
        description: `Fiscal year ${year} closing entries`,
        sourceModule: 'accounting',
        sourceTransactionId: `year-close:${year}`,
        status: 'SUBMITTED',
        lines,
      });
      const approved = await this.approveJournal(client, organizationId, actorId, closingJournal.id);
      if (!approved) throw new Error('Fiscal year closing journal could not be approved.');
      closingJournal = await this.postJournal(client, organizationId, actorId, closingJournal.id);
      if (!closingJournal) throw new Error('Fiscal year closing journal could not be posted.');
    }
    const closed = [];
    for (const period of openPeriods) {
      const result = await closeAccountingPeriod(client, organizationId, actorId, period.id);
      if (result) closed.push(result);
    }
    return { fiscalYear: year, netIncome, closingJournal, closedPeriods: closed };
  },
};

function normalizeAccountInput(input) {
  const accountCode = String(input.accountCode ?? input.account_code ?? '').trim().toUpperCase();
  const accountName = String(input.accountName ?? input.account_name ?? '').trim();
  const accountType = String(input.accountType ?? input.account_type ?? '').toUpperCase();
  const normalBalance = String(input.normalBalance ?? input.normal_balance ?? '').toUpperCase();
  const openingBalance = Number(input.openingBalance ?? input.opening_balance ?? 0);
  if (!accountCode || !accountName) throw new Error('accountCode and accountName are required.');
  if (!ACCOUNT_TYPES.has(accountType)) throw new Error('Invalid account type.');
  if (!NORMAL_BALANCES.has(normalBalance)) throw new Error('normalBalance must be DEBIT or CREDIT.');
  if (!Number.isFinite(openingBalance) || openingBalance < 0) throw new Error('openingBalance must be a non-negative number.');
  return {
    accountCode,
    accountName,
    accountType,
    parentAccountId: input.parentAccountId ?? input.parent_account_id ?? null,
    active: input.active !== false,
    description: input.description || null,
    normalBalance,
    openingBalance,
  };
}

async function validateAccountParent(client, organizationId, parentId, childId = null) {
  const parent = await getAccountingAccount(client, organizationId, parentId);
  if (!parent) throw new Error('Parent account must belong to the current organization.');
  if (childId) {
    const ancestors = await client.query(
      `WITH RECURSIVE account_tree AS (
         SELECT id, parent_account_id FROM accounting_accounts WHERE id = $1 AND organization_id = $2
        UNION
         SELECT account.id, account.parent_account_id
         FROM accounting_accounts account JOIN account_tree tree ON account.id = tree.parent_account_id
         WHERE account.organization_id = $2
       ) SELECT 1 FROM account_tree WHERE id = $3 LIMIT 1`,
      [parentId, organizationId, childId],
    );
    if (ancestors.rows.length) throw new Error('Account hierarchy cannot contain a cycle.');
  }
}

function validateJournalInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Journal data is required.');
  if (!input.description || !input.sourceModule || !input.transactionDate) {
    throw new Error('description, sourceModule, and transactionDate are required.');
  }
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new Error('A journal must contain at least two lines.');
  }
  if (input.status && !JOURNAL_STATUSES.has(String(input.status).toUpperCase())) {
    throw new Error('Invalid journal status.');
  }
  if (Number.isNaN(new Date(input.transactionDate).valueOf())) throw new Error('transactionDate must be a valid date.');
  if (input.currency && !/^[A-Z]{3}$/.test(String(input.currency).toUpperCase())) throw new Error('currency must be a three-letter ISO code.');
  const lineAccountIds = new Set();
  for (const line of input.lines) {
    if (!line.accountId || !line.description) throw new Error('Every journal line requires an account and description.');
    if (lineAccountIds.has(line.accountId)) throw new Error('A journal cannot contain duplicate accounts.');
    lineAccountIds.add(line.accountId);
    if (!Number.isFinite(Number(line.debit)) || !Number.isFinite(Number(line.credit))) {
      throw new Error('Journal line amounts must be numeric.');
    }
    if (Number(line.debit) < 0 || Number(line.credit) < 0) throw new Error('Journal line amounts cannot be negative.');
    if (Number(line.debit) > 0 && Number(line.credit) > 0) throw new Error('A journal line cannot be both debit and credit.');
  }
  const totalDebit = input.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const totalCredit = input.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.000001) throw new Error('Journal debit and credit totals must match.');
  if (input.accountType && !ACCOUNT_TYPES.has(input.accountType)) throw new Error('Invalid account type.');
  if (input.normalBalance && !NORMAL_BALANCES.has(input.normalBalance)) throw new Error('Invalid normal balance.');
}
