# PLCE ERP Project Audit

## Audit date

2026-10-07

## Executive summary

The existing project is a functional prototype, not a production-grade ERP. It uses a Vite/React frontend and an Express backend. It persists application data in a local JSON file, uses plaintext seed credentials, exposes session identity through an unsigned cookie, and has no relational database, migrations, object-level authorization, business-rule layer, audit trail, or accounting engine.

The current frontend has meaningful interaction for dashboard navigation, sales, inventory, procurement, HR, finance, banking, manufacturing, reports, and settings. However, several actions are only partially functional: the frontend does not load the complete dashboard data, the inventory and finance actions are not consistently validated or audited, the settings UI mutates browser state rather than server state, and the reports and export buttons are placeholders.

## Current architecture

- Frontend: React 18 with Vite and JavaScript/TypeScript-compatible source.
- Backend: Node.js Express 4.
- Persistence: JSON file at `erp-data.json`.
- Authentication: cookie-based identity with username/role encoded in the cookie.
- Session handling: no server-side session record, expiry, revocation, or token integrity.
- Authorization: role checks exist for a few endpoints, but most routes are only authenticated.
- Data access: direct mutation of in-memory JSON data through route handlers.
- Documentation: only a short README exists.
- Tests: no automated test suite.

## Existing modules

### Functional or partially functional

- Dashboard and executive summary
- Sales order creation
- Inventory stock restock, issue, and dispatch
- Procurement order creation
- Employee creation
- Finance transaction creation
- Banking transaction creation, transfer, approval, and rejection
- Manufacturing order creation
- Reports metrics page
- Settings toggles
- Login and logout
- Responsive navigation

### Present but not production-ready

- Customer, supplier, product, user, asset, payroll, HR, quality, maintenance, fleet, import/export, document, and reporting modules are only represented by seed data or simple list pages.
- The dashboard is populated from static seed values and does not consistently call the backend dashboard endpoint.
- The selected date range is not applied to data.
- The reports page is a static KPI card render.
- The settings page changes local state and calls a backend toggle only for the settings endpoint, but the current frontend does not refresh the backend data.

## Database status

No relational database is configured. The application uses `erp-data.json` and therefore has no:

- Foreign key enforcement
- Transactions
- Constraints
- Indexes
- Migrations
- Rollback support
- Concurrent-write protection
- Production backup strategy

## Authentication and authorization findings

### Critical

1. Plaintext passwords are stored in `erp-data.json`.
2. The legacy session cookie contains only username and role, with no integrity protection.
3. A user can alter the cookie to claim another role if the matching username is known.
4. The session has no server-side revocation or timeout enforcement.
5. The frontend exposes demo credentials in the page and the server uses plaintext credentials in the seed data.
6. Role checks are not uniform; many important routes only require authentication.
7. The cookie is not marked Secure in production.
8. The cookie has no explicit `SameSite=Strict` or `Path` boundary issue beyond the configured path.

### Medium

1. Login has no rate limiting.
2. Login has no lockout or failed-attempt tracking.
3. There is no password change or reset flow.
4. There is no session audit record.
5. Authentication is not tied to branch, warehouse, department, or permission scopes.

## Frontend-backend findings

- The frontend and backend are served by the same Express process in development.
- Vite is configured for a separate development server on port 8080, while Express also uses port 8080. This can cause port conflicts when both are started independently.
- The frontend calls relative API paths and therefore relies on the same origin.
- The frontend uses raw HTML interpolation for user-controlled values, creating an XSS risk in forms and tables.
- The frontend uses browser `alert()` for some errors.
- Forms do not preserve user input after a failed backend request.
- The frontend stores mutable data in module-level arrays and does not synchronize all modules from the backend.
- The backend returns only selected seed data; it does not expose a complete operational model.

## Security findings

- Plaintext passwords and operational records are stored in a local JSON file.
- No authorization is enforced for general module reads beyond authentication.
- Keystroke or request rate limiting is absent.
- No CSRF protection is present.
- No request size or payload limits are configured.
- No structured audit logging exists.
- No secure file upload validation exists.
- User-controlled values are inserted into HTML without escaping.
- The source contains development credentials that should never be used in production.
- The data file is directly writable and may contain sensitive business data.

## Critical operational findings

1. Inventory receives and issues only update a quantity; no immutable inventory transaction is created.
2. Stock issue does not create a ledger or audit record.
3. Sales creation does not create an invoice, customer balance, revenue, tax, inventory movement, or accounting entry.
4. Purchase creation does not create a approval workflow, RFQ, supplier comparison, or accounting entry.
5. Finance transactions are not posted through a double-entry engine.
6. Banking transactions are not reconciled against accounting records.
7. Manufacturing orders do not consume material, create production accounting, or produce finished goods.
8. Payroll and HR are not connected to accounting or attendance.
9. No closed-period protection exists.
10. No duplicate transaction prevention exists.
11. No branch, company, or cost-center isolation exists.
12. No supplier/customer credit limits or aging exists.
13. No tax rules or exchange-rate engine exists.
14. No approval history is retained.
15. No document numbering sequence exists.
16. No exported report implementation exists.

## Recommended architecture

The existing frontend should be preserved as the UI layer, but the backend should be changed from a file-backed JSON API to a layered application with a relational PostgreSQL database.

Recommended boundary:

- Express or FastAPI API layer
- Pydantic schemas
- Dependency-injected services
- Repository layer
- SQLAlchemy or Prisma ORM
- PostgreSQL migrations through Alembic
- Role and permission policy layer
- Accounting posting service
- Inventory transaction service
- Approval workflow service
- Audit service
- Background job layer
- React frontend with typed API client and component-level error handling

The current project should not be replaced wholesale. The existing React UI and simple route structure can be retained while the backend is progressively modernized.

## Implementation order

1. Add a real relational database and migration system.
2. Add secure password hashing and server-side session management.
3. Add environment configuration and production-safe startup.
4. Add structured logging, centralized errors, and request validation.
5. Add RBAC and object-level authorization.
6. Add audit logging and immutable financial/inventory transactions.
7. Implement master data and company/branch hierarchy.
8. Implement procurement and inventory workflows.
9. Implement sales, customer, and accounting integration.
10. Implement manufacturing, MRP, QA, maintenance, HR, and payroll.
11. Implement reports, exports, notifications, and production deployment.

## Foundation changes completed during this audit

- Project inventory and runtime inspection completed.
- Existing React/Express architecture identified.
- Static diagnostics found no syntax errors.
- Live root page returned HTTP 200.
- Protected dashboard returned HTTP 401.
- Login flow was verified as accepting the seeded administrator credentials.
- Password hashing and signed session authentication implemented.
- Legacy plaintext credentials are migrated after a successful login.
- Session cookies are HttpOnly, SameSite=Lax, and Secure in production.
- Valid sessions expire after eight hours and forged or expired sessions are rejected.
- Invalid login returns HTTP 401.
- Authentication unit tests pass: 3/3.
- No source files were removed or rewritten during the audit.

## Required next step

Implement the secure foundation phase before adding additional ERP modules. This includes database-backed persistence, server-side session storage or a production database, environment configuration, transactional repositories, centralized validation, and implementation of the first database migration and tests.
