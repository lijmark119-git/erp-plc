# PHASE 1 Architecture: Modular Monolith and Secure Foundation Design

## Scope of PHASE 1

This document records the architecture baseline agreed before foundation implementation. It does not define the final production schema or business rules. The current PHASE 3 implementation realizes the auth/access-control portion of this design in the FastAPI backend.

In scope for PHASE 1:
- modular monolith runtime boundaries
- frontend/backend separation and API contract rules
- module dependency map and shared service responsibilities
- organization and operational hierarchy model
- database baseline and core entities
- PK/FK and constraint pattern
- authorization and audit boundaries
- business workflow and data-flow boundaries
- unresolved policy decisions that still require confirmation

Out of scope for PHASE 1:
- final manufacturing feature rollout
- final accounting policy implementation
- full branch/factory design finalization
- full procurement and sales operational logic
- final reporting and analytics implementation

## Architecture decision: modular monolith

The project is designed as a modular monolith, not a distributed microservice platform.

Why this is the correct baseline:
- one deployable application boundary reduces operational complexity
- one PostgreSQL database keeps cross-module transactional integrity easier to enforce
- domain modules can still remain independent in code and permission boundaries
- the architecture supports future decomposition only when business and operational requirements justify it

### Recommended runtime structure

```text
repo/
  apps/
    web/                    # React frontend
  frontend/                 # React + TypeScript + Vite SPA
  backend/
    app/
      api/                  # FastAPI routes
      auth.py               # session, role, and scope dependencies
      models.py             # SQLAlchemy persistence models
      security.py           # password and opaque token hashing
    alembic/                # PostgreSQL schema migrations
    tests/
```

### Design intent
- One application process owns the business domain orchestration.
- Each module owns its own domain model and repository layer.
- Shared services own cross-cutting concerns: auth, audit, validation, config, business events, and security headers.
- Modules may call other modules only through approved service interfaces, never by direct table mutation from route handlers.

## Frontend and backend boundaries

### Frontend responsibilities
- React-based user experience
- client-side state handling and form validation
- display of authorized data only
- trigger workflows through a typed REST API contract
- never be the system of record for financial or inventory truth

### Backend responsibilities
- authentication and session validation
- authorization policy evaluation
- validation, sanitation, and business-rule enforcement
- database access through repositories and transaction boundaries
- audit event emission for sensitive operations
- domain orchestration across modules, especially for inventory, accounting, and manufacturing

### Boundary rules
- All writes must pass through backend services.
- User-controlled values must be escaped or encoded before rendering in HTML.
- No frontend module may bypass security checks or mutate data directly in the database.
- The backend must keep the source of truth for quantity, balances, approvals, and ledger records.

## Module dependency map

### Shared foundation layer
These services are the platform backbone and are available to all other modules.
- configuration management
- structured logging
- request tracing and correlation IDs
- validation and sanitization
- password hashing and token/session security
- audit event emission
- RBAC permission registry
- health and readiness checks

### Core business modules and dependency direction

| Module | Depends on | Notes |
| --- | --- | --- |
| foundation | none | bootstrapping, config, logging, validation |
| organizations | foundation | tenant, company, branch, warehouse, cost center concepts |
| identity | foundation, organizations | users, roles, permissions, sessions |
| inventory | foundation, organizations, identity | stock, uom, warehouses, movements, valuation |
| purchasing | foundation, organizations, inventory, identity | supplier orders and receipts |
| sales | foundation, organizations, inventory, identity | customers, orders, invoices, collections |
| finance | foundation, organizations, identity | accounts, journals, payment posting, bank reconciliation |
| manufacturing | foundation, organizations, inventory, finance | BOM, routing, work centers, production orders |
| hr | foundation, organizations, identity | employees, attendance, payroll hooks |
| reporting | all | read-only aggregation and reporting services |

### Dependency rules
- No module should import or mutate another module's storage directly.
- The accounting module is the authoritative posting layer for financial transactions.
- The inventory module is the authoritative source for stock balances and movement history.
- Manufacturing may depend on inventory and finance, but inventory and finance must not depend back on manufacturing in a way that bypasses the approval model.

## Organizational hierarchy and operational context

This is the most important area that still requires business confirmation.

### Required design concept
All transactional data must be tied to an `organization_id`. This makes a tenant boundary explicit and supports future multi-company or multi-entity expansion without forcing a default business model.

### Allowed shape for Phase 1
- `organizations` = top-level company or legal entity root
- `branches` = operational units under an organization (if confirmed required)
- `warehouses` = storage and stock-holding locations relevant to inventory
- `factories` = production locations or manufacturing units (if confirmed required)
- `departments` / `cost_centers` = operational classification not necessarily final schema yet

### Important caution
The project must not invent requirements such as a final corporate tree model, legal-entity rules, or warehouse/factory assignments unless the business confirms them. The safe baseline is:
- one organization root is valid by default
- multiple organizations are supported by data design but not forced by workflow logic
- branch/warehouse/factory relationships are modeled as configurable, not hard-coded

## Core database baseline

The current migration set already shows a strong baseline pattern for the secure data foundation. The architecture design for PHASE 1 retains those entities and emphasizes the following principles:
- every key transactional table carries `organization_id`
- all tables use UUID primary keys
- referential integrity is enforced via foreign keys
- a row is never deleted if it supports audit or accounting history; soft-delete or status-delimiters are preferred for master data
- immutable records are preferred for ledger and inventory movement history

### Core entity families

1. Identity and authorization
- organizations
- roles
- permissions
- role_permissions
- users
- audit_events

2. Finance and banking
- bank_accounts
- finance_transactions

3. Inventory and warehouse
- inventory_uoms
- inventory_products
- inventory_uom_conversions
- inventory_warehouses
- inventory_locations
- inventory_transfer_requests
- inventory_stock_transactions
- inventory_adjustments

4. Sales and customer workflow
- customers
- customer_addresses
- quotations
- quotation_lines
- sales_orders
- sales_order_lines
- delivery_notes
- delivery_line_items
- customer_invoices
- invoice_lines
- customer_payments
- accounts_receivable

5. Manufacturing and planning
- manufacturing_work_centers
- manufacturing_boms
- manufacturing_bom_lines
- manufacturing_routings
- manufacturing_routing_operations
- manufacturing_orders
- manufacturing_order_materials
- manufacturing_material_reservations
- manufacturing_order_operations

### Primary key and foreign key patterns

- all IDs use `UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- all cross-entity references use `UUID` foreign keys
- parent-child tables are scoped by organization and often have composite uniqueness constraints
- all lookup tables have a stable `code` or unique business key
- transactional tables track `created_at`, `updated_at`, and often `occurred_at` or `transaction_date`

### Important constraints to preserve
- `UNIQUE (organization_id, code)` for organization-scoped master data
- `UNIQUE (organization_id, username)` and `UNIQUE (organization_id, employee_number)` for user identity records
- `CHECK` constraints for status enums and positive quantity rules
- `ON DELETE CASCADE` for organization-owned child data
- `ON DELETE RESTRICT` for tables whose history must not be silently erased
- `ON DELETE SET NULL` for audit ownership and non-critical references

## API conventions

### Transport conventions
- All APIs should follow REST-style resource nouns and pluralized collections.
- Authenticated requests must include validated session or token context.
- Errors should be returned in a consistent format: `code`, `message`, and optional `details`.

### Request conventions
- path parameters use stable IDs
- filters are query-based and scoped to the current organization context
- all writes require a validated body and permission check
- all mutation endpoints produce an audit event

### Response conventions
- use explicit status codes: `200`, `201`, `204`, `400`, `401`, `403`, `404`, `409`, `422`, `500`
- return minimal resource payloads with canonical IDs
- do not expose raw internal database exceptions to clients

## Authorization boundaries

### Policy model
- user roles are scoped to an organization
- permissions are coarse-grained business capabilities, not only route names
- actions must be checked at the API boundary and again in service logic for defense in depth
- approval and exception workflows are subject to explicit permission checks

### Critical boundary rules
- Finance and accounting must not be writable by a general operations user without a finance or approval permission.
- Inventory movement must be created by service code, not by unaudited route-level quantity updates.
- Manufacturing orders must be validated against BOM/routing rules and stock reservation rules.
- Audit events must not be mutable by normal users.

## Integrated business workflow model

### 1. Purchase and inventory flow
- supplier master data is stored in organization-scoped tables
- purchase approval and receiving flow create inventory stock transactions and accounting postings through a controlled service layer
- quantity movement is always tracked with a valid reference to the source transaction

### 2. Sales and financial flow
- customer and sales order data are scoped to an organization
- sales order creation must validate customer credit and product availability
- delivery and invoice generation must be linked to the same transactional path and financial postings
- payment records reconcile against customer invoice balances and bank activity

### 3. Manufacturing flow
- BOM and routing define the production structure
- manufacturing orders reserve material and schedule work centers
- production completion creates stock movement and cost posting through the same validation boundaries
- material consumption and final output are auditable and never inferred only from UI state

### 4. Access and governance flow
- user identity, role assignment, and permission evaluation happen in the identity layer
- security events and operational actions are written to `audit_events`
- any override or exception flow must be logged and reviewed

## Review of circular dependencies and risk areas

### Circular dependency review
The design avoids circular dependency risk by enforcing these rules:
- shared foundation and identity are foundational services
- inventory and accounting are domain authorities, not consumers of ad hoc UI state
- manufacturing depends on inventory and finance, but not vice versa
- reporting remains read-only and aggregates from authoritative modules

### Unsafe deletion and history review
- organization deletion should be restricted or require cascade design approval
- master data deletion should be soft-delete or status-driven for data retention
- ledger and inventory history rows should never be removed casually
- references to deleted users or approvers should be preserved via `SET NULL` or archival references

### Auditability review
- every sensitive business action should emit an audit_event with actor, entity type, request ID, and details
- transactions that change balances or approval state must include a business reference ID
- audit records must never be built only from UI logs

### Concurrency and integrity review
- inventory and accounting operations must run in transactions
- balances must be recalculated or validated before commit
- unique constraints and status checks should block duplicate posting
- no process should trust client-side quantities as final truth

## Business rules requiring confirmation

The following rules are not safe to invent without business confirmation:
- whether the company operates as one legal entity or multiple legal entities
- whether branches are distinct from warehouses and factories in the final data model
- whether every warehouse belongs to exactly one branch or can be shared across branches
- whether each factory can produce across multiple organizations or only within one
- whether the organization uses a single chart of accounts or a company-specific chart
- whether products are global across all organizations or restricted by organization scope
- whether inventory costing is FIFO, weighted average, standard cost, or another approach
- whether approvals happen by role, manager, finance, or structured workflow policy
- whether the project is single-currency or multi-currency
- whether audit retention and legal compliance require a longer history than the default design

## Consistency checks completed

The design has been checked for the following issues:
- duplicate concepts minimized: tenant, user, product, stock, and financial posting roles are separated and explicitly directional
- missing relationships addressed: all major operational flows have a source transaction reference and a user or approver reference
- unsafe deletion mitigated: status-based controls and cascade rules are used only where data provenance is not endangered
- auditability strengthened: every critical action is linked to evidence in the audit layer
- concurrency risk reduced: transactional boundaries and unique constraints are defined around the critical update points

## Status of PHASE 1 design

Status: architecture baseline defined and foundational authentication/access-control elements are implemented in PHASE 3.

The design remains intentionally conservative: a single deployable service, strict module boundaries, PostgreSQL-backed integrity, and explicit rules for authorization and business workflow consistency.

## Implemented authentication choices

- Browser sessions use random opaque tokens, with only SHA-256 token digests persisted server-side.
- Session cookies are HttpOnly and SameSite=Lax; production requires Secure cookies over HTTPS.
- State-changing authenticated requests must match a session-bound CSRF token in the readable CSRF cookie and request header.
- Password hashes use Argon2id.
- Roles are organization-scoped; explicit user grants constrain organization and optional branch, warehouse, or factory access.
- The first administrator is provisioned by an explicit interactive CLI after migrations; no known password is seeded.
- These are platform policies, not final business authority rules; the role matrix and organizational hierarchy still require business confirmation.
