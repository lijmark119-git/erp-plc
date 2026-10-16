# Requirements Traceability

## Confirmed requirements
- Build a custom ERP for a Manufacturing and General Trading PLC.
- Keep the implementation secure, maintainable, and testable.
- Use a modular monolith architecture and treat foundation work as a precursor to business modules.
- Keep assumptions and business-rule gaps explicitly identified.
- Prepare infrastructure and platform baseline before implementing module logic.

## Phase 2 coverage
- R-003: Secure, maintainable, testable software — covered by backend health checks, configuration, Docker Compose, linting, type checks, and tests.
- R-011: Modular monolith design — preserved as the project architecture model.
- R-012: Secure foundation for PostgreSQL, RBAC, auditability, API conventions — started with PostgreSQL-ready configuration, SQLAlchemy, Alembic, and API health baseline.

## Phase 3 coverage — authentication and access control
- Secure login/logout and revocable browser sessions — implemented with hashed opaque session tokens, HttpOnly cookies, expiry, and session-bound CSRF validation.
- Password storage — Argon2id; no plaintext password persistence.
- User administration and role/permission checks — API-protected and tested.
- Organization and optional branch/warehouse/factory restrictions — explicit scope grants checked by the backend, independent of frontend visibility.
- Security-sensitive audit events — authentication and administrative actions are persisted server-side and have no update/delete API.
- Initial administrator setup — explicit interactive CLI bootstrap; no default administrator/password is seeded.

## Pending business decisions
- Legal entity and company structure
- Branch, warehouse, and factory hierarchy
- Base currency, currency conversion, and financial policy
- Approval matrix and authority limits
- Tax and multi-currency rules
- Manufacturing policy and process maturity

## Phase 5 coverage — initial inventory module
- FIFO is the approved initial stock-costing method.
- Organization-scoped items and warehouses, receipt/issue/transfer transactions, FIFO stock layers and allocations, on-hand balances, movement history, and audit events are implemented.
- Inventory API authorization uses inventory read/manage/transact permissions and the existing organization/branch/warehouse scope grants.
- Outstanding production gates: PostgreSQL migration/runtime verification; confirmation of the branch/warehouse hierarchy; base currency and currency conversion rules; finance integration and approval controls.

## Phase 6 coverage — initial procurement module
- Organization-scoped supplier records and multi-line purchase orders are implemented with `procurement:read`, `procurement:manage`, and `procurement:order` permission checks.
- Partial purchase-order deliveries update received quantities and status; over-receipts are rejected.
- Receiving requires both procurement receive and inventory transaction permissions and creates audited, immutable FIFO Inventory receipt layers in an authorized warehouse.
- PostgreSQL migration/runtime verification remains outstanding; purchase approvals, supplier invoices, tax, cancellation, and Finance/GL posting remain unimplemented.

## Phase 7 coverage — initial Sales module
- Organization-scoped customer records and multi-line sales orders are implemented with `sales:read`, `sales:customer_manage`, and `sales:order` permission checks.
- Partial order fulfillment requires both `sales:fulfill` and `inventory:transact`; it uses the shared FIFO allocator, reduces authorized warehouse stock, and records immutable inventory movement/allocation and audit records.
- Over-shipment and insufficient stock are rejected atomically; PostgreSQL migration/runtime verification remains outstanding.
- Invoicing, returns, taxes, approvals, and Finance/GL posting remain unimplemented. Banking and manufacturing workflows remain future modules; an initial HR/payroll foundation is covered in Phase 9.

## Phase 8 coverage — initial Finance ledger
- Organization-scoped chart-of-account setup and immutable manual journal entries are implemented with `finance:read`, `finance:accounts_manage`, and `finance:post` permissions.
- Journal validation requires at least two unique accounts, exactly one positive debit/credit per line, exact debit-credit equality, and one ISO currency per entry; persisted lines enforce their positive-side and organization-consistent foreign-key constraints.
- Account ledgers report running net debits separately by currency; posted entries have no edit/delete API and all posting/setup actions are audited.
- PostgreSQL migration/runtime verification remains outstanding. Base currency, fiscal close, automated Sales/Procurement postings, tax, invoicing, banking/reconciliation, and approvals remain unimplemented.

## Phase 9 coverage — initial Ethiopia HR and payroll
- Organization-scoped departments, employee lifecycle records, manager links, recurring earnings/deductions, leave types/requests/approval/balances, attendance/check-in/out, monthly payroll draft/finalization snapshots, and operational reports are implemented with dedicated HR permissions and audit events.
- Payroll uses an explicitly configured pensionable salary and the researched 7% employee / 11% employer pension rates. Progressive income tax requires an authorized user to enter an effective-dated schedule with an official source reference; unverified tax bands are not preloaded.
- SQLite-backed API coverage exercises employee and pay-component setup, leave approval and balances, attendance checkout, tax configuration, payroll calculation/finalization, duplicate-run prevention, and reports.
- PostgreSQL migration/runtime verification and official tax-schedule verification remain outstanding. Tenure-based leave progression, statutory sick-leave tiers, attendance/overtime and approved-leave payroll integration, bank disbursement, Finance/GL journals, and production parallel runs remain unimplemented.

## Current status
PHASE 3 authentication/access-control foundation, the PHASE 4 application shell, Inventory, initial Procurement, initial Sales shipment, initial Finance journal workflows, and initial HR/payroll workflows are implemented and covered by automated tests. PostgreSQL verification, broader organization/master-data workflows, statutory payroll confirmation, and remaining business modules are still incomplete.

## Phase 4 coverage — protected application shell
- Authorized dashboard module cards and sidebar visibility — implemented from backend-provided organization permissions.
- Protected routes, direct-route permission denial, not-found handling, and breadcrumbs — implemented and tested.
- Module-specific Overview navigation — implemented for permission-visible modules; unfinished modules display explicit setup-pending states without fabricated business data.
- Responsive desktop, tablet, and mobile navigation — implemented; the mobile drawer supports focus entry, Tab wrapping, Escape dismissal, and focus return.
- Top navigation, user menu, organization context, and available branch-scope context — implemented using authenticated session and scope data.
- Loading, error, empty, forbidden, and not-found states — implemented.
- Validation: 13 frontend tests, ESLint, TypeScript typecheck, production build, and 21 backend tests passed.

## Phase 4 exclusions and next gates
- Inventory, initial procurement, Sales shipment, and manual Finance journal transactions are implemented on the new foundation; PostgreSQL verification and confirmed organization/master-data relationships remain prerequisites for production use.
- FIFO is selected for initial inventory valuation; base-currency conversion and finance posting remain unfinalized.
- Before this module, the migration head was `20261014_02_usernames`; the database's applied revision could not be confirmed because `localhost:5432` refused the Alembic connection and Docker is unavailable.
- Git status could not be inspected because the workspace has no `.git` metadata and no Git executable was found.
