import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoMatchTransactions,
  createReconciliationMatch,
  getReconciliationSummary,
} from '../services/bankReconciliation.js';

test('manual reconciliation rejects missing and already matched items', () => {
  const history = [{ statementTransactionId: 'statement-1', cashbookTransactionId: 'cashbook-1' }];

  assert.equal(createReconciliationMatch(history, '', 'cashbook-2').duplicate, true);
  assert.equal(createReconciliationMatch(history, 'statement-1', 'cashbook-2').duplicate, true);
  assert.equal(createReconciliationMatch(history, 'statement-2', 'cashbook-1').duplicate, true);
  assert.equal(createReconciliationMatch(history, 'statement-2', 'cashbook-2').duplicate, false);
});

test('automatic reconciliation matches only exact, same-account, one-to-one transactions', () => {
  const statementTransactions = [
    { id: 'statement-ref', accountId: 'account-1', type: 'Credit', amount: 100, reference: 'INV-100', description: 'Customer payment' },
    { id: 'statement-desc', accountId: 'account-1', type: 'Debit', amount: 75, reference: '', description: 'Bank fee' },
    { id: 'statement-empty', accountId: 'account-1', type: 'Debit', amount: 900, reference: '', description: '' },
    { id: 'statement-amount', accountId: 'account-1', type: 'Credit', amount: 500, reference: 'INV-500', description: 'Customer receipt' },
    { id: 'statement-account', accountId: 'account-2', type: 'Credit', amount: 300, reference: 'INV-300', description: 'Receipt' },
  ];
  const cashbookTransactions = [
    { id: 'cashbook-ref', accountId: 'account-1', type: 'Credit', amount: 100, reference: 'inv 100', description: 'Payment' },
    { id: 'cashbook-desc', accountId: 'account-1', type: 'Debit', amount: 75, reference: '', description: 'Bank fee' },
    { id: 'cashbook-empty', accountId: 'account-1', type: 'Debit', amount: 900, reference: '', description: '' },
    { id: 'cashbook-wrong-amount', accountId: 'account-1', type: 'Credit', amount: 50, reference: 'INV-500', description: 'Customer receipt' },
    { id: 'cashbook-wrong-account', accountId: 'account-3', type: 'Credit', amount: 300, reference: 'INV-300', description: 'Receipt' },
  ];

  const result = autoMatchTransactions({ statementTransactions, cashbookTransactions });

  assert.deepEqual(
    result.created.map((entry) => [entry.statementTransactionId, entry.cashbookTransactionId, entry.method]),
    [
      ['statement-ref', 'cashbook-ref', 'reference'],
      ['statement-desc', 'cashbook-desc', 'amount'],
    ],
  );
  assert.equal(result.summary.summary.matchedCount, 2);
  assert.deepEqual(
    result.summary.unmatchedStatements.map((item) => item.id),
    ['statement-empty', 'statement-amount', 'statement-account'],
  );
});

test('reconciliation summary excludes matched records from both unmatched lists', () => {
  const statementTransactions = [{ id: 'statement-1', amount: 25 }];
  const cashbookTransactions = [{ id: 'cashbook-1', amount: 25 }];
  const history = [{ statementTransactionId: 'statement-1', cashbookTransactionId: 'cashbook-1' }];

  const summary = getReconciliationSummary({ statementTransactions, cashbookTransactions, history });

  assert.equal(summary.summary.matchedCount, 1);
  assert.deepEqual(summary.unmatchedStatements, []);
  assert.deepEqual(summary.unmatchedCashbook, []);
});

test('an imported orphaned cashbook reference stays in history and cannot be auto-matched again', () => {
  const statementTransactions = [{ id: 'statement-1', amount: 25, accountId: 'account-1', type: 'Credit', reference: 'INV-25', description: 'Customer receipt' }];
  const cashbookTransactions = [{ id: 'cashbook-new', amount: 25, accountId: 'account-1', type: 'Credit', reference: 'INV-25', description: 'Customer receipt' }];
  const history = [{
    statementTransactionId: 'statement-1',
    cashbookTransactionId: null,
    legacyCashbookTransactionId: 'BT-1001',
    amount: 25,
  }];

  const result = autoMatchTransactions({ statementTransactions, cashbookTransactions, history });

  assert.equal(result.created.length, 0);
  assert.equal(result.summary.matches[0].unresolvedCashbookTransactionId, 'BT-1001');
  assert.deepEqual(result.summary.unmatchedStatements, []);
  assert.deepEqual(result.summary.unmatchedCashbook.map((entry) => entry.id), ['cashbook-new']);
});
