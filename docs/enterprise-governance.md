# Enterprise management and governance

The Enterprise Governance workspace is an additive, company-scoped extension. Existing HR branch, department, hierarchy, accounting, and transaction workflows remain in place.

## Capabilities

- Register subsidiary and plant records beneath the authenticated company.
- Define business units, cost centers, and profit centers.
- Create non-overlapping fiscal years for the company or a subsidiary/plant.
- Configure amount, currency, transaction type, department, requester-role, approver-role, priority, and delegated-from-role approval rules.
- Register policy metadata, classifications, review dates, retention periods, and document references.
- Review company governance metrics and a recent audit trail.

All records are scoped to the authenticated company. IDs selected from another company are rejected by both application checks and composite database foreign keys. New records are audited using the existing `audit_events` table. Records are lifecycle-managed rather than deleted.

## Permissions and API

- `governance:read`: read the governance workspace.
- `governance:manage`: add records and transition supported lifecycle statuses.
- `GET /api/governance`: company structure, centers, fiscal years, approval rules, policies, audit events, and governance metrics.
- `POST /api/governance/:collection`: add a record. Collections are `entities`, `business-units`, `cost-centers`, `profit-centers`, `fiscal-years`, `approval-rules`, and `policies`.
- `PATCH /api/governance/:collection/:id/status`: transition a record's status without deleting its audit history.

Migration `027_enterprise_governance.sql` adds new tables and permissions; it does not modify existing business tables. Database-backed authentication is required for this workspace.

## Integration boundaries

Approval rules are stored and displayed as governance configuration, but existing transaction approval flows are not silently changed to consume them. That integration requires a separately verified change to each applicable workflow.

Existing accounting reports do not carry subsidiary/plant dimensions. The executive overview therefore reports governance metrics only and explicitly marks financial consolidation unavailable. Financial consolidation, currency translation, and intercompany eliminations must wait until transaction tagging and accounting rules are designed and approved.

Retention periods and document references are metadata only. This feature does not upload, store, or automatically delete documents.
