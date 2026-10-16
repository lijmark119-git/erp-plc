# Architecture Baseline

## Status
Architecture baseline for the current PHASE 3 authentication and access-control foundation. Read with the modular monolith design, ER diagram, and database dictionary.

## Architectural direction
The ERP remains a modular monolith. The current backend is FastAPI with a React + TypeScript SPA and PostgreSQL persistence through SQLAlchemy/Alembic. The legacy Node prototype remains a reference only; the new API is the authorization boundary.

## Core principles
1. secure defaults for all operational writes
2. single source of truth for inventory and accounting data
3. role-based authorization tied to organization context
4. immutable ledger and stock history wherever possible
5. explicit module dependency direction to avoid circular logic
6. centralized audit and validation across the platform

## Layered model

### Presentation layer
- React web client for ERP operations and dashboards
- UI state, client-side validation, and navigation
- backend-driven authorization data; no trust in client-side permissions

### API and transport layer
- FastAPI API boundary with REST conventions
- request validation and standard error responses
- parameterized access to repositories and services
- service-level checks before database writes

### Application service layer
- identity and access management
- organization and tenant management
- inventory movement and valuation
- purchasing, sales, and invoicing orchestration
- finance posting and bank reconciliation
- manufacturing planning and production control
- reporting and analytics aggregation

### Data access and persistence layer
- PostgreSQL as the canonical transactional database
- migration-based schema evolution
- UUID primary keys and organization-scoped data access
- indexed foreign keys and enforced business constraints

## Shared platform services
These are intentionally centralized to avoid duplication across modules:
- configuration management
- validation and serialization
- password hashing and session handling
- permission and RBAC checks
- audit event emission
- request logging and correlation IDs
- database transaction wrappers

## Authentication and authorization baseline
- Password hashes use Argon2id; plaintext passwords are never stored.
- The browser receives an opaque random session token in an HttpOnly, SameSite cookie; only its hash is persisted.
- Authenticated state-changing requests require a session-bound CSRF token in both the CSRF cookie and `X-CSRF-Token` header.
- Sessions expire and can be revoked. Inactive users cannot use existing sessions.
- Roles grant named permissions within an organization. User scope grants independently restrict company and optional branch, warehouse, or factory access.
- Admin routes enforce authorization on the backend and audit sensitive actions. Audit rows have no update/delete API.
- No administrator is seeded. The first administrator is created by a one-time local CLI after migrations, with an interactively entered password.

## Module dependency direction

The dependency order is intentionally directional:
- foundation -> organizations -> identity -> inventory -> purchasing/sales/finance/manufacturing -> reporting

This means plugins or features may not bypass the shared foundation and authoritative modules. In particular:
- accounting must not be bypassed for financial events
- inventory must not be bypassed for stock movements
- manufacturing must use the same BOM, routing, and stock validation flow

## Business rule handling
Business rules remain configurable and must be treated as policy decisions until confirmed by the company. The design supports but does not force multi-company, multi-branch, multi-warehouse, multi-factory, and multi-currency scenarios via `organization_id` and location-scoped references.

## Review status
The architecture has been reviewed for:
- circular dependency risk
- duplicate concepts across domain tables
- missing transaction links
- unsafe deletion patterns
- auditability gaps
- concurrency and consistency risk

The baseline remains intentionally conservative and should be verified before further module expansion.
