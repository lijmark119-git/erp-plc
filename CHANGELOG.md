# Changelog

All notable changes for the ERP project are recorded here.

## [Unreleased] Phase 4 application shell
### Added
- Permission-aware dashboard module cards and module Overview routes
- Breadcrumbs, authenticated user menu, organization and branch-scope context display
- Responsive sidebar with keyboard-accessible mobile drawer behavior
- Explicit setup-pending states for modules without business APIs; no fabricated metrics or transactions
- Frontend tests for protected routing, module visibility, not-found routes, and mobile keyboard navigation

### Changed
- Project and module status distinguish the completed application shell from unfinished business modules

### Verification
- Frontend: 13 tests passed; lint, typecheck, and production build passed
- Backend regression suite: 21 tests passed
- Inventory remains gated by PostgreSQL and organization/master-data verification and approved costing policy

## [2026-10-14] Phase 2 foundation implementation
### Added
- React + TypeScript + Vite frontend in `frontend/`
- FastAPI backend in `backend/`
- PostgreSQL-ready SQLAlchemy configuration and health checks
- Alembic migration baseline for foundation tables
- Docker Compose configuration for Postgres, backend, and frontend
- root and backend `.env.example` placeholders
- health check tests for the FastAPI foundation

### Changed
- README updated to describe the actual PHASE 2 foundation status and run commands
- project status and module status files updated to reflect the verified platform baseline
- traceability and decisions documents updated to reflect the current phase and remaining business confirmations

### Notes
- No business modules were implemented in this phase.
- Financial, sales, purchasing, inventory, and manufacturing logic remain intentionally outside scope until the identity and master-data foundation is validated.

## [2026-10-13] Phase 3 authentication and access-control foundation
### Added
- documented comparison and selection of revocable server-side cookie sessions
- Argon2id password hashing, login/logout, CSRF protection, and session expiry
- user, role, permission, organization/location scope, and audit persistence models
- protected user/role administration routes and a first-admin bootstrap CLI
- focused authentication, permission, scope, and audit tests

### Security notes
- no production administrator is seeded; bootstrap requires an explicit one-time local CLI operation and an interactively entered password
- business-module endpoints remain out of scope
