# Project management

The Projects workspace is an additive, organization-scoped project register with task tracking. Projects and tasks are persisted in PostgreSQL, and creation/status changes are written to the existing audit trail in the same transaction.

## Capabilities

- Create projects with a unique organization-level code, name, description, start date, due date, and lifecycle status.
- Create tasks under a project and record task due dates and status.
- Update project and task status with server-side enum and date validation.
- Enforce organization scoping through API queries and composite foreign keys.

## Permissions and API

- `projects:read`: view projects and their tasks.
- `projects:manage`: create projects/tasks and update their statuses.
- `GET /api/projects`
- `POST /api/projects`
- `POST /api/projects/:projectId/tasks`
- `PATCH /api/projects/:projectId/status`
- `PATCH /api/projects/:projectId/tasks/:taskId/status`

The navigation entry is available only when the authenticated session grants `projects:read`. ADMIN and MANAGER roles are granted the project read/manage permissions by migration 046; other roles must be explicitly granted access through the existing permission administration process.

## Validation

The focused project API and navigation checks passed (8 tests total); the full configured test suite passed after this addition (89 passed, 0 failed, 0 skipped). Migration 046 applied successfully as part of the 47-migration set. The app started through `npm.cmd start`, the health endpoint reported a connected database, and a signed-in browser smoke check verified Projects navigation, workspace rendering, and the empty response from `GET /api/projects`.

## Scope boundaries and rollback

This initial slice does not yet include budgets, resource assignments, dependencies/Gantt scheduling, timesheets, project billing, portfolio management, or integration with finance. It adds no changes to existing finance, HR, sales, or inventory records.

To roll back before dependent application code is removed, first remove project permission mappings and catalog rows, then drop `project_tasks` and `projects`:

```sql
DELETE FROM role_permissions WHERE permission_id IN
  (SELECT id FROM permissions WHERE code IN ('projects:read', 'projects:manage'));
DELETE FROM permissions WHERE code IN ('projects:read', 'projects:manage');
DROP TABLE IF EXISTS project_tasks;
DROP TABLE IF EXISTS projects;
```

This rollback deletes project/task records, so export or retain them before executing it. The migration is additive and does not alter existing business tables or data.
