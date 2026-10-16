# Decisions and Business Confirmation Requirements

## Confirmed decisions
1. The project remains a custom ERP for a Manufacturing and General Trading PLC.
2. The runtime model remains a modular monolith.
3. PostgreSQL is the target relational database.
4. Foundation work must precede operational module implementation.
5. Financial and inventory records must remain governed by authoritative services.
6. The current stack baseline will use React + TypeScript + Vite on the frontend and FastAPI + SQLAlchemy + Alembic on the backend.
7. Browser authentication uses opaque server-side sessions stored by token hash; session cookies are HttpOnly, SameSite, and Secure in production. Mutating authenticated requests require a session-bound CSRF token.
8. Passwords are stored only as Argon2id hashes. Sessions are revocable and expire after a configurable duration.
9. Authorization combines least-privilege roles/permissions with explicit organization and optional branch, warehouse, or factory grants. Organization-wide access is represented by a deliberate organization-level grant rather than inferred from a user record.

## Open decisions requiring confirmation
- exact legal entity and organization structure
- branch, warehouse, and factory hierarchy
- costing and valuation policies
- approval authority model
- tax and multi-currency requirements
- hosting, backup, and retention policy

## Temporary assumptions
- default environment is development unless production settings are supplied
- organization_id remains the tenant boundary for initial design
- multiple organizations and locations remain configurable rather than hard-coded
- identity and access control are required before module features begin
- branch, warehouse, and factory scopes are independent dimensions pending business confirmation; explicit grants are used without assuming a universal location hierarchy

## Authentication architecture decision

No authentication mechanism had previously been selected, so the following options were compared before implementation:

| Option | Benefits | Risks / costs | Fit |
| --- | --- | --- | --- |
| Opaque server-side session in an HttpOnly cookie | Immediate revocation, small browser credential exposure, central session controls, simple first-party SPA integration | Requires database lookup and CSRF protection for state-changing requests | Selected |
| Short-lived JWT access tokens plus refresh tokens | Stateless access-token validation and common for distributed APIs | Revocation/refresh rotation complexity; token storage in browser increases exposure; unnecessary for the current single API deployment | Not selected |
| OAuth/OIDC delegated identity | Appropriate for enterprise SSO and external identity providers | Requires an identity provider and company policy decision not yet supplied | Deferred |

The implementation stores only a SHA-256 digest of a cryptographically random session token and CSRF token. Password hashes use Argon2id. Login errors do not distinguish unknown users from bad passwords. A local-only bootstrap CLI requires explicit organization/user details and an interactively entered password; there is no seeded or known administrator credential. Production must set `SESSION_COOKIE_SECURE=true` and serve over HTTPS.

## Recommendation
Proceed with the organization and identity foundation next, then validate the master-data model before implementing transaction-heavy modules.
