# Enterprise finance and controlling

This is an additive extension to the accounting workspace. Existing transaction, general-ledger, accounts-payable/accounts-receivable journal, period, cash-flow, and financial-statement workflows remain available.

## Monthly budget versus actual

- Create a fiscal-year budget and enter monthly amounts by ledger account.
- Optionally assign a line to an active enterprise cost center and profit center.
- Budget actuals are calculated from posted journal lines for the same account, month, and dimensions. Draft, submitted, and approved journals do not affect actuals.
- Variance is budget less actual; a positive value means the budget is greater than posted actuals.
- Budget changes and line updates are recorded in the accounting audit trail. A closed accounting budget cannot be changed.
- Journal lines can carry optional cost-center and profit-center codes to support dimension-level reporting.

Migration `034_finance_budget_control.sql` creates the additive tables and permission. Budget management is restricted to the finance and administrator roles; accounting report readers can view the variance workspace.

Fixed-asset accounting, depreciation posting, foreign-exchange revaluation, intercompany eliminations, accrual schedules, and consolidated management reporting are not added by this migration.
