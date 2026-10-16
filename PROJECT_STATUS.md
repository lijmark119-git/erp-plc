# Project Status

## Overview
The repository contains a legacy Node.js/Express prototype and a newer React + TypeScript / FastAPI foundation. The newer stack is the project of record; the legacy application is reference material and is not the target for new implementation.

## Current phase
PHASE 4 — authenticated ERP application shell (implemented; business workflows intentionally excluded).

The Phase 4 shell includes the protected dashboard, permission-filtered module cards and navigation, module Overview routes, breadcrumbs, organization and branch scope context, responsive navigation, and explicit setup-pending states for unfinished business modules.

The Phase 3 PostgreSQL migration/bootstrap verification gate remains open. Business workflows, including Inventory, must not be implemented until the foundation and organization/master-data prerequisites are validated.

## Actual work completed
- Created `frontend/` with a working Vite + React + TypeScript app
- Added a FastAPI backend under `backend/`
- Added base SQLAlchemy configuration and connection checks
- Added Alembic migration skeleton with a foundation baseline for organizations, users, and audit events
- Added Docker Compose entries for Postgres, backend, and frontend
- Added `.env.example` placeholders only
- Added health endpoint tests and verified startup behavior
- Added Argon2id password storage, revocable cookie sessions, session-bound CSRF checks, RBAC, scope grants, audit events, and administrator bootstrap CLI
- Added the Phase 4 React application shell with permission-dependent module routes and honest not-implemented states
- Added accessible mobile drawer focus handling, keyboard dismissal, module Overview navigation, and route breadcrumbs

## Checks performed
- Frontend `npm run typecheck` passed
- Frontend `npm run build` passed
- Frontend `npm run lint` passed
- Backend health endpoint returned status successfully at `http://localhost:8000/api/health`
- Frontend dev server served successfully at `http://localhost:5173/`
- Backend authentication/access-control/bootstrap test suite: 21 tests passed
- Phase 3 Alembic migrations upgraded and downgraded successfully against temporary SQLite
- Alembic metadata check reports no schema drift against the migrated SQLite schema
- Live FastAPI startup on port 8001 succeeded; health returned `200` and unauthenticated admin access returned `401`
- Frontend tests: 13 passed across 2 files
- Frontend ESLint, TypeScript typecheck, and production build passed
- Backend regression tests: 21 passed; pytest reported an asyncio fixture-loop-scope deprecation warning

## Risks and known limits
- The business model is not yet fully confirmed: legal entities, branches, warehouses, factories, and costing policies remain open decisions.
- No financial ledger, stock valuation, or sales/purchasing workflow was implemented in this phase.
- The app remains intentionally a foundation layer rather than an operational ERP module rollout.
- Operational modules remain explicit placeholders; no business metrics or workflows are presented as implemented.
- Inventory costing policy and organization/location relationships remain unapproved.

## Current verification snapshot
- Git status cannot be obtained: neither the project directory nor its Desktop parent contains `.git` metadata, and `git.exe` is unavailable in this environment.
- `alembic heads` reports `20261013_01_auth_access` as the single head. `alembic current` cannot connect to PostgreSQL at `localhost:5432`, so the applied database revision is unknown; Docker is unavailable.
- The new FastAPI backend has no Inventory models, routes, service, repository, or migration. No Inventory database change has been made.

## Next milestone
Verify the migration and bootstrap procedure against PostgreSQL, then implement the remaining organization/master-data workflows and confirm the company/location authorization policy. PostgreSQL-backed verification is pending because Docker/PostgreSQL is unavailable in this environment. Do not begin transaction-heavy modules until then.
Before Inventory, also obtain approval for the costing method and warehouse/branch ownership policy; do not treat either as finalized by the UI shell.

The first incomplete task is PostgreSQL-backed migration/bootstrap verification: make PostgreSQL available, apply the Alembic head, verify the applied revision, and validate the explicit administrator bootstrap. Then confirm organization/location master-data policy before authorizing any Inventory schema or workflow work.
