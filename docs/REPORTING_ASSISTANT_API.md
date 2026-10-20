# Reporting and Assistant API

These endpoints use the existing authenticated session cookie. Organization identity and report permissions are taken from the server session; clients cannot choose an organization or send query text to execute.

## Reporting

### `GET /api/reports/catalog?range=30d`

Requires at least one permission for a catalog report. Supported ranges are `7d`, `30d`, `90d`, and `1y`.

Returns `{ reports, range, period, generatedAt }`. Each report row contains its module, label, source, date period, currency, current/previous values, change, and optional transaction count. Only rows whose report permission the current user holds are returned. Existing metric calculation and organization scope are reused from `repositories/dashboardRepository.js`.

The catalog currently contains a bounded set of six aggregate views; it does not accept arbitrary SQL, joins, field names, or record identifiers.

### `GET /api/reports/saved`

Requires access to at least one report. Returns saved views scoped to the current organization and user.

### `POST /api/reports/saved`

Requires access to at least one report. Example:

```json
{
  "name": "Monthly summary",
  "reportKey": "dashboard-summary",
  "config": {
    "columns": ["module", "report", "current"],
    "pageSize": 10,
    "sortBy": "module",
    "sortDirection": "asc",
    "range": "30d",
    "filter": ""
  }
}
```

Only the fixed report key, enumerated columns/sort fields/ranges, page sizes 5–100, and bounded filters are accepted. Saving replaces the same user's configuration with the same name. The configuration and its audit event commit in one database transaction.

### `DELETE /api/reports/saved/:reportId`

Deletes only a configuration owned by the current user and organization. Deletion and its audit event are transactional.

### `POST /api/reports/exports`

Records an export audit event before the client generates a CSV. Currently accepts only `{ "reportKey": "dashboard-summary", "format": "csv", "range": "30d", "filter": "" }`. Unsupported formats or ranges return HTTP 400. The client downloads only the rows already returned by the permission-filtered catalog.

## ERP assistant

### `POST /api/assistant/chat`

Requires at least one of the user's existing sales, inventory, procurement, manufacturing, HR, accounting-report, or finance transaction permissions.

Request:

```json
{ "question": "Summarize my sales performance", "range": "30d" }
```

`question` is required and limited to 1,500 characters. `range` must be `7d`, `30d`, `90d`, or `1y`. Responses are labeled `aiAssisted: true`, include `authorizedModules`, `sourceMetrics`, `reportingRange`, `period`, and `completedAction: false`. HTTP 429 indicates the per-user process-local rate limit; HTTP 502/504 indicate provider/configuration failure or timeout. The assistant event records metadata only, not prompt or response text.

External inference requires all of `ERP_AI_ENABLED=true`, `ERP_AI_ENDPOINT`, `ERP_AI_API_KEY`, and `ERP_AI_MODEL`. The API key is read server-side only. The endpoint must use HTTPS except localhost development, and redirects are rejected. The provider receives only the user's question and permission-filtered aggregate metrics, not detailed records or database access. With the provider disabled, workflow help and aggregate summaries are handled locally.

For a question about a specific module, only the relevant authorized aggregate metrics are included (for example, inventory questions do not include finance metrics). Broad summary questions may include all aggregate metrics the user is authorized to see.

## Authorization and scope note

These endpoints enforce the existing organization identity and named role permissions. The current application does not attach branch, department, warehouse, or factory scope grants to authenticated users or its dashboard queries. Such row-level scope filtering is therefore not available to these new endpoints; do not grant a user cross-branch access based on a UI-only filter. Add a shared server-side scope service and apply it to source repositories before enabling scoped enterprise reporting.

## Migration and rollback

Apply migrations with `npm.cmd run db:migrate` (PowerShell) or `npm run db:migrate` in a shell with npm scripts enabled. `migrations/042_reporting_workspace.sql` adds user-owned saved configurations and audit lookup indexing. `migrations/043_ai_assistant_events.sql` adds metadata-only assistant event tracking.

The migration runner is forward-only and verifies checksums. Never edit or delete applied migration files or manually delete their `schema_migrations` rows. To roll back the application, first deploy code that no longer references these tables, then back up data and apply this reviewed reverse DDL in a controlled maintenance window:

```sql
BEGIN;
DROP INDEX IF EXISTS idx_ai_assistant_events_user_created;
DROP TABLE IF EXISTS ai_assistant_events;
DROP INDEX IF EXISTS idx_saved_report_configurations_user;
DROP TABLE IF EXISTS saved_report_configurations;
DROP INDEX IF EXISTS idx_report_export_audit;
COMMIT;
```

The reverse DDL permanently removes saved views and assistant event metadata; export or retain them first if required by policy. Keep the applied migration records so the migration runner does not silently recreate removed objects. If the newer code is redeployed after this rollback, restore the database backup or add a reviewed forward migration before startup.

## Validation

Focused integration coverage is in `tests/apiAuthorization.test.js`; navigation coverage is in `tests/navigation.test.js`. Run:

```powershell
node --test tests\apiAuthorization.test.js tests\navigation.test.js
```
