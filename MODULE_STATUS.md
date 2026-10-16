# Module Status

## Purpose
This document records the current ERP platform after the Phase 4 application-shell implementation. Phase 3 PostgreSQL verification remains a prerequisite for business workflows.

## Current module status

### Foundation and platform
- Status: Implemented baseline
- Notes: Vite frontend, FastAPI backend, PostgreSQL-ready SQLAlchemy, Alembic, health checks, Docker Compose, environment config, and tests are in place.

### Identity and authorization
- Status: Implemented foundation baseline
- Notes: Cookie-based sessions, Argon2id password hashing, user administration, role/permission enforcement, explicit organizational scope grants, CSRF checks, and audit events are implemented. Final business authorization matrix remains pending.

### ERP application shell
- Status: Phase 4 implemented and verified
- Notes: Protected dashboard, authorized module cards, module Overview navigation, Administration subpages, breadcrumbs, organization and branch-scope context, responsive desktop/tablet/mobile navigation, and loading/error/empty/forbidden/not-found states are implemented. Unfinished business modules show explicit setup-pending content and no fabricated business data.

### Organization and hierarchy
- Status: Foundation scope entities implemented; workflows pending
- Notes: Organizations, branches, warehouses, and factories can be represented as authorization scopes. Their final business hierarchy remains unconfirmed.

### Inventory
- Status: Initial functional module implemented
- Notes: Organization-scoped item and warehouse setup, live on-hand quantities, immutable receipt/issue/transfer movements, FIFO layer consumption, transfer cost carry-forward, audit events, and inventory permissions are implemented in the React + FastAPI stack. Receipt layers preserve their entered currency; FIFO allocation costs are reported by currency without conversion or finance posting.
- Remaining gates: Apply the Alembic migration and verify it against PostgreSQL before production use. Confirm the company's branch/warehouse hierarchy, base-currency policy, valuation accounting integration, and approval controls before treating inventory as production-ready.

### Procurement
- Status: Initial operational workflow implemented
- Notes: Organization-scoped suppliers, multi-line purchase orders, partial receiving, over-receipt prevention, audit events, dedicated permissions, and direct receipt into an authorized Inventory warehouse as FIFO cost layers are implemented. Receiving requires both procurement receive and inventory transact permissions.
- Remaining gates: Apply the Alembic migration and verify it against PostgreSQL. Supplier terms, approval and cancellation workflows, invoice matching, tax, and Finance/GL integration remain unimplemented.

### Sales
- Status: Initial order and shipment workflow implemented
- Notes: Organization-scoped customers and multi-line sales orders support partial shipments from authorized warehouses. Shipment fulfillment requires both Sales fulfillment and Inventory transaction permissions, issues stock through the shared FIFO layer allocator, and writes inventory allocation, movement, and audit records.
- Remaining gates: Apply the Alembic migration and verify it against PostgreSQL. Invoicing, returns, taxes, approvals, and Finance/GL integration remain unimplemented.

### Finance
- Status: Initial general-ledger workflow implemented
- Notes: Organization-scoped chart-of-account records, single-currency balanced manual journal entries, immutable posting records, audit events, and per-account/per-currency running net-debit ledgers are implemented with dedicated permissions.
- Remaining gates: Apply the Alembic migration and verify it against PostgreSQL. Base currency, fiscal-period close, automated source-document postings, tax, invoicing, bank accounts, reconciliation, and approval controls remain unimplemented.

### Human Resources and payroll
- Status: Initial operational foundation implemented; statutory and integration gates remain
- Notes: Organization-scoped departments and reporting hierarchy; employee hire/status records and manager links; ETB salary plus explicitly configured pensionable salary; recurring earnings/deductions; policy-configurable leave types, requests, approvals, and balances; daily attendance with check-in/out; configurable effective-dated Ethiopian income-tax schedules with source references; monthly payroll calculation/review/finalization snapshots; monthly reports; and dedicated backend permissions/audit events.
- Payroll currently calculates 7% employee and 11% employer pension on the employee-entered pensionable salary and progressive tax from the configured schedule. It does not preload potentially outdated tax bands.
- Remaining gates: Apply and verify the Alembic migration against PostgreSQL; have authorized payroll staff verify and configure the current official tax schedule and effective date; validate leave policies against current law; model tenure-based accrual and sick-leave tiers; integrate leave/overtime with pay, bank disbursement, and Finance journals; perform production payroll parallel-run validation. This is not yet a complete legally compliant payroll system.

### Manufacturing
- Status: Not implemented on the new FastAPI foundation
- Notes: Existing legacy prototype code is reference material only; it is not being used as a replacement for the custom ERP implementation.

## Phase gate
The Phase 4 shell is complete; Inventory, Procurement, Sales order fulfillment, an initial manual-journal Finance workflow, and an initial HR/payroll foundation are implemented on top of it. They pass SQLite-backed API tests but are not production-ready until PostgreSQL migration/runtime verification and the remaining business, statutory, and integration decisions are complete.

## Dependency order
1. Foundation platform and runtime configuration
2. Organization and identity baseline
3. Master data and reference data management
4. Inventory and procurement (initial purchasing and stock-receiving integration implemented)
5. Sales and order fulfillment (initial customer ordering and inventory shipment implemented)
6. Finance and accounting (initial journal workflow implemented)
7. Human Resources and payroll (initial workflow implemented; statutory/integration gates remain)
8. Manufacturing and production control
9. Reporting and governance

FIFO is the approved initial inventory costing method. Inventory, initial Procurement, Sales shipment, manual Finance journal transactions, and initial HR/payroll workflows are implemented, but are not production-ready until their Alembic migrations are applied and verified against PostgreSQL and the remaining hierarchy, currency, accounting, payroll-law, and approval decisions are confirmed.
