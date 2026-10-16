# PostgreSQL Setup for the FastAPI Foundation

## Configuration

From `backend/`, copy `.env.example` to `.env` and configure the PostgreSQL connection URL for the target environment. The FastAPI foundation does not use a `SESSION_SECRET`; opaque session and CSRF token digests are stored in PostgreSQL.

The application expects:

- `DATABASE_URL` — PostgreSQL connection URL
- `APP_ENV` — `development` or `production`
- `SESSION_COOKIE_NAME` and `CSRF_COOKIE_NAME` — cookie names
- `SESSION_COOKIE_SECURE` — must be `true` in production
- `SESSION_TTL_HOURS` — session lifetime from 1 to 168 hours

## Local development

Use Docker Compose for a local PostgreSQL service or connect to an explicitly configured PostgreSQL server. Never commit `.env` or expose its contents in logs or source-control diffs.

## Migration commands

```powershell
cd backend
.\.venv\Scripts\python.exe -m alembic upgrade head
```

Alembic migrations create the organization, user, audit, role/permission, session, branch, warehouse, factory, and scope-grant foundation. Schema changes must be introduced as new forward migrations after review.

The root-level Node/Express migration and seed commands belong to the legacy prototype and do not provision this FastAPI authentication schema.

## First administrator

```powershell
.\.venv\Scripts\python.exe -m app.bootstrap --organization-code "<confirmed-code>" --organization-name "<confirmed-name>" --username "<administrator-username>" --full-name "<administrator-name>"
```

The command prompts for a password and confirmation. It only runs once, before any user exists, and there is no default administrator account or password.

## Production

Set `APP_ENV=production`, `SESSION_COOKIE_SECURE=true`, configure exact trusted CORS origins, use HTTPS, and give the application database account only the required database privileges.
