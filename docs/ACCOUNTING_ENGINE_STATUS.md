# Accounting Engine Status

## Summary

The accounting engine is implemented as a PostgreSQL-backed extension of the existing ERP architecture. It preserves the existing React/Express application, existing finance and inventory repositories, and all current migrations.

## Implemented

- Hierarchical chart of accounts with all required account types.
- Accounting periods with open/closed controls.
- Journal entries, journal lines, lifecycle status, approval, posting, cancellation, and reversal.
- Balanced journal validation and atomic posting.
- Per-account opening balance, debit, credit, and closing balance calculations.
- Trial balance, general ledger, profit and loss, balance sheet, cash flow, and account statement views.
- Structured audit records for journal and period lifecycle operations.
- RBAC for accounting administration, journal operations, and reporting.
- REST APIs for accounts, periods, journals, ledger, balances, and reports.
- Frontend accounting navigation, journal management, account hierarchy, reports, and actions.
- Real database tests for balanced entries, unbalanced rejection, posting, reversal, period locks, balances, and trial balance.

## Database Tables

- accounting_accounts
- accounting_periods
- accounting_journal_sequences
- accounting_journals
- accounting_journal_lines
- accounting_journal_status_history

The existing finance_transactions, bank_accounts, inventory_items, inventory_movements, and audit_events tables remain in use.

## API Surface

- GET /api/accounting/accounts
- POST /api/accounting/accounts
- PUT /api/accounting/accounts/:id
- GET /api/accounting/periods
- POST /api/accounting/periods
- POST /api/accounting/periods/:id/close
- GET /api/accounting/journals
- POST /api/accounting/journals
- GET /api/accounting/journals/:id
- POST /api/accounting/journals/:id/approve
- POST /api/accounting/journals/:id/post
- POST /api/accounting/journals/:id/cancel
- POST /api/accounting/journals/:id/reverse
- GET /api/accounting/ledger?accountId=
- GET /api/accounting/balances/:accountId
- GET /api/accounting/reports/:reportType

## Accounting Rules

- Every journal must contain at least two lines.
- Every line has exactly one side: debit or credit.
- Total debit must equal total credit at six-decimal precision.
- Posted journals must be approved and their accounting period must be open.
- Posted journals are never deleted.
- Reversal creates a new posted journal with opposite lines and marks the original journal as reversed.
- Account balances are calculated from posted journal lines and opening balances.
- Financial reports are calculated from PostgreSQL posted transactions, never browser state.
- Journal and period lifecycle changes are audited.

## Validation

Run the accounting tests and complete suite with:

node --test tests/*.test.js

node scripts/migrate.js

## Remaining Limitations

- Automatic integration for every existing business module is not complete; this status documents the accounting service and APIs available for integration.
- Tax rates, currencies, cost centers, foreign exchange, fixed assets, depreciation, and recurring entries are not yet implemented.
- The existing business data routes remain JSON-backed when PostgreSQL is unavailable.
- Accounting balances are based on the current open accounting periods; closed periods are excluded from normal ledger/report calculations.
