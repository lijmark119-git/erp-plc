export function normalizeMatchToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createReconciliationMatch(history = [], statementTransactionId, cashbookTransactionId) {
  if (!statementTransactionId || !cashbookTransactionId) {
    return { duplicate: true, reason: 'Both statement and cashbook transaction identifiers are required.' };
  }

  const duplicate = history.some((entry) => (
    entry.statementTransactionId === statementTransactionId
    || entry.cashbookTransactionId === cashbookTransactionId
    || (entry.statementTransactionId === statementTransactionId && entry.cashbookTransactionId === cashbookTransactionId)
  ));

  if (duplicate) {
    return { duplicate: true, reason: 'This item is already matched or already linked to another reconciliation record.' };
  }

  return {
    duplicate: false,
    entry: {
      statementTransactionId,
      cashbookTransactionId,
      matchedOn: new Date().toISOString(),
      status: 'Matched',
      method: 'manual',
    },
  };
}

export function getReconciliationSummary({ statementTransactions = [], cashbookTransactions = [], history = [] }) {
  const matchedStatementIds = new Set();
  const matchedCashbookIds = new Set();
  const matches = [];

  for (const item of history) {
    const statement = statementTransactions.find((entry) => entry.id === item.statementTransactionId);
    const cashbook = cashbookTransactions.find((entry) => entry.id === item.cashbookTransactionId);
    if (!statement) continue;
    matchedStatementIds.add(statement.id);
    if (!cashbook) {
      matches.push({
        ...item,
        statement,
        cashbook: null,
        amount: Number(item.amount ?? statement.amount ?? 0),
        method: item.method || 'manual',
        status: item.status || 'Matched',
        unresolvedCashbookTransactionId: item.legacyCashbookTransactionId || item.cashbookTransactionId || null,
      });
      continue;
    }
    matchedCashbookIds.add(cashbook.id);
    matches.push({
      ...item,
      statement,
      cashbook,
      amount: Number(item.amount ?? cashbook.amount ?? statement.amount ?? 0),
      method: item.method || 'manual',
      status: item.status || 'Matched',
    });
  }

  const unmatchedStatements = statementTransactions.filter((entry) => !matchedStatementIds.has(entry.id));
  const unmatchedCashbook = cashbookTransactions.filter((entry) => !matchedCashbookIds.has(entry.id));
  const matchedCount = matches.length;
  const difference = unmatchedStatements.reduce((total, statement) => total + Number(statement.amount || 0), 0)
    - unmatchedCashbook.reduce((total, entry) => total + Number(entry.amount || 0), 0);

  return {
    matches,
    unmatchedStatements,
    unmatchedCashbook,
    history,
    statementTransactions,
    cashbookTransactions,
    summary: {
      matchedCount,
      unmatchedStatementCount: unmatchedStatements.length,
      unmatchedCashbookCount: unmatchedCashbook.length,
      difference,
      isBalanced: difference === 0,
    },
  };
}

export function autoMatchTransactions({ statementTransactions = [], cashbookTransactions = [], history = [] }) {
  const existing = getReconciliationSummary({ statementTransactions, cashbookTransactions, history });
  const matchedCashbookIds = new Set(existing.matches.map((match) => match.cashbook?.id).filter(Boolean));
  const matchedStatementIds = new Set(existing.matches.map((match) => match.statement.id));
  const created = [];

  for (const statement of existing.unmatchedStatements) {
    const candidate = existing.unmatchedCashbook.find((cashbook) => {
      if (matchedCashbookIds.has(cashbook.id) || matchedStatementIds.has(statement.id)) return false;
      if (statement.accountId && cashbook.accountId && statement.accountId !== cashbook.accountId) return false;
      const sameType = String(cashbook.type || '').toUpperCase() === String(statement.type || '').toUpperCase();
      const sameAmount = Number(cashbook.amount || 0) === Number(statement.amount || 0);
      const statementReference = normalizeMatchToken(statement.reference || '');
      const cashbookReference = normalizeMatchToken(cashbook.reference || '');
      const sameReference = Boolean(statementReference) && statementReference === cashbookReference;
      const sameDescription = normalizeMatchToken(cashbook.description || '') === normalizeMatchToken(statement.description || '');
      return sameType && sameAmount && (sameReference || (sameDescription && Boolean(statement.description || cashbook.description)));
    });

    if (!candidate) continue;

    const match = createReconciliationMatch(history, statement.id, candidate.id);
    if (match.duplicate) continue;
    const statementReference = normalizeMatchToken(statement.reference || '');
    const cashbookReference = normalizeMatchToken(candidate.reference || '');
    const sameReference = Boolean(statementReference) && statementReference === cashbookReference;
    const id = `REC-${Date.now()}-${created.length + 1}`;
    created.push({
      ...match.entry,
      id,
      amount: Number(statement.amount || candidate.amount || 0),
      accountId: statement.accountId || candidate.accountId || null,
      method: sameReference ? 'reference' : 'amount',
    });
    matchedCashbookIds.add(candidate.id);
    matchedStatementIds.add(statement.id);
    history = [...history, { ...match.entry, id }];
  }

  return {
    created,
    summary: getReconciliationSummary({ statementTransactions, cashbookTransactions, history }),
  };
}
