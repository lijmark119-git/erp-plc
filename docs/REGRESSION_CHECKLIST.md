# ERP regression checklist

This checklist compares the original application inventory in `PROJECT_AUDIT.md` (2026-10-07) with the current PostgreSQL-backed application. The original audit described multiple actions as seed-data or partial workflows; the comparison below checks that those original destinations and actions remain available while identifying the current implementation and remaining test work.

## Module and original-feature comparison

| Original inventory | Current equivalent retained or extended | Automated coverage | Regression status |
|---|---|---|---|
| Dashboard and executive summary; original KPI cards and date range | Dashboard navigation and KPI views remain; PostgreSQL-backed dashboard metrics and the reporting catalog are additive. | `dashboardRepository.test.js`, `navigation.test.js`, `apiAuthorization.test.js` | [x] Full suite passed |
| Sales order creation | Customer, quote, approval, order, delivery, return inspection, invoice, receipt/payment, receivables, and reports workflows. Existing `/api/sales` compatibility route remains. | `salesWorkflow.test.js`, `crudApi.test.js`, `apiAuthorization.test.js`, `navigation.test.js` | [x] Full suite passed |
| Inventory restock, issue, and dispatch | Existing inventory movement UI and APIs remain; transactional stock ledger, warehouse balances, transfers, counts, traceability, reservations, and manufacturing/procurement movements extend them. | `inventoryRepository.test.js`, `inventoryManagement.test.js`, `inventoryTraceabilityApi.test.js`, `salesWorkflow.test.js`, `procurementApi.test.js`, `manufacturing.test.js` | [x] Full suite passed |
| Procurement order creation | Supplier register, requisitions, quote comparison, approval, partial receipts, optional inventory/accounting receipt posting, invoice match, supplier documents, and scorecards. Legacy quick-create PO remains available. | `procurementService.test.js`, `procurementApi.test.js`, `manufacturing.test.js` | [x] Full suite passed |
| Project register | Organization-scoped projects and tasks with validated dates/statuses, permission-gated navigation and APIs, and audited lifecycle updates. | `projects.test.js`, `navigation.test.js` | [x] Full suite passed |
| Employee creation and HR/payroll pages | Employee and organization records, attendance, leave, payroll lifecycle, documents, reports, and audit are retained/extended. Sensitive HR document/payroll permissions remain gated. | `hrPayroll.test.js`, `apiAuthorization.test.js`, `navigation.test.js` | [x] Full suite passed |
| Finance transaction creation | Finance routes remain; accounting adds chart of accounts, journals, periods, general ledger, statements, budgets, and audit. | `financeRepository.test.js`, `accountingEngine.test.js`, `crudApi.test.js`, `apiAuthorization.test.js` | [x] Full suite passed |
| Banking transactions, transfers, approvals, and rejections | Banking UI and workflows remain; statement import, matching, reconciliation, and history extend them. | `bankReconciliation.test.js`, `bankReconciliationApi.test.js`, `financeRepository.test.js`, `apiAuthorization.test.js` | [x] Full suite passed |
| Manufacturing order creation | Legacy summary/routes remain; the production workspace adds BOM/routing, MRP, reservations, consumption/output, quality, downtime, costing, and traceability. | `manufacturing.test.js`, `inventoryManagement.test.js`, `navigation.test.js` | [x] Full suite passed |
| Reports metrics page and settings toggles | Reports and settings destinations remain. The report catalog, saved views, permission checks, and audited CSV export are additive. | `dashboardRepository.test.js`, `apiAuthorization.test.js`, `navigation.test.js`, `governanceUi.test.js` | [x] Full suite passed |
| Login, logout, responsive navigation | Signed sessions, login/logout APIs, server-side authorization, route guards, and responsive navigation remain. | `auth.test.js`, `authorization.test.js`, `apiAuthorization.test.js`, `navigation.test.js` | [x] Full suite passed |
| Customer, supplier, product, user, asset, payroll, HR, quality, maintenance, fleet, import/export and documents represented by seed data or simple list pages | Current modules retain their implemented records and workflows; not every original seed-data area has a complete operational workflow. Consult module status documents for explicit boundaries. | `crudApi.test.js`, module-specific tests, `governanceApi.test.js`, `governanceService.test.js` | [x] Full suite passed; documented boundaries remain |

## Automated regression run

Run from the repository root:

```powershell
npm.cmd test
npm.cmd run db:migrate
npm.cmd run build
```

- [x] Full configured Node test suite passes after the latest Projects changes (`npm.cmd test`; serial execution as configured in `package.json`).
- [x] Migration runner succeeds and reports no checksum drift; existing migration files are not edited after application.
- [x] Build/startup command completes using the documented package scripts. The build script is a placeholder, not a production bundle build.
- [x] `git diff --check` reports no whitespace errors.
- [x] Record command, date, pass/fail count, and any blocked checks below; do not infer a pass from selected tests.

### Latest recorded run

| Check | Result | Notes |
|---|---|---|
| Run date | Recorded | 2026-10-20 (local environment date). |
| `npm.cmd test` | Passed | 89 tests passed, 0 failed, 0 skipped after Projects changes; serial full suite completed. |
| Focused tests | Passed | 8 tests passed, 0 failed (`projects.test.js` and `navigation.test.js`). |
| `npm.cmd run db:migrate` | Passed | Migration runner applied all 47 migrations, including additive migration 046. |
| `npm.cmd run build` | Completed (limited) | Script only prints “No build required for this ERP prototype”; no production bundle is generated. |
| Startup / HTTP health | Passed | Started with the documented `npm.cmd start` command on temporary port 8082; `/api/health` returned `ok` and database `connected`. Port 8080's pre-existing process was left untouched. |
| Browser module/navigation smoke check | Partial | On the fresh 8082 app, the signed-in ADMIN saw Projects in navigation, opened the Projects workspace, and received the expected empty state from `GET /api/projects`. Login/logout interactions, console/network-wide checks, and all other module screens were not rechecked. |

## Security, workflow, and data checks

For each relevant release or implementation stage:

- [x] Login accepts valid credentials and rejects invalid credentials (automated auth tests).
- [x] Logout invalidates the browser session; unauthenticated requests cannot access protected APIs (automated auth tests; browser interaction not performed).
- [ ] Session expiry/invalid signatures are rejected.
- [x] Admin, Manager, Seller, and any affected specialized roles see only authorized navigation and API actions (automated authorization coverage).
- [ ] Existing CRUD paths continue to read, create, update, and delete only where the role has permission.
- [ ] Input validation failures return explicit client errors without partial writes.
- [ ] Duplicate/idempotent requests do not create duplicate orders, receipts, inventory movements, journals, or payments.
- [ ] Concurrent updates preserve stock/accounting invariants and reject stale or conflicting transitions.
- [ ] A failure during a multi-record workflow rolls back all associated business, inventory, and accounting writes.
- [ ] Migration application preserves representative pre-existing rows, relationships, and balances; rollback steps are documented for schema additions.
- [ ] Cross-module chain tests cover sales-to-cash, purchasing receipt-to-stock/ledger, production-to-inventory, payroll-to-accounting, and bank reconciliation.
- [ ] Browser smoke test checks loading, empty, success, and validation/error states, plus frontend console and backend HTTP errors.
- [ ] Dashboard and every original navigation destination remain accessible for the roles that had access in the original inventory (navigation permission tests pass; no complete visual walk-through performed).

## Known boundaries to track

These are not regression failures if unchanged, but must not be described as completed workflows:

- Supplier invoice matching does not yet post an AP liability or initiate supplier payment.
- Purchase requisition approval is not automatically linked to a sourcing comparison.
- Customer return inspection does not automatically create a credit note or refund.
- Report export currently supports audited CSV; Excel/PDF and scheduled delivery are not implemented.
- The `build` package script is a placeholder and does not produce a production frontend bundle.
- Browser-only validation is separate from Node API tests; record it explicitly rather than treating API coverage as visual verification.
