# Reporting and Analytics Status

## Available

- The existing management KPI cards remain visible.
- The report catalog presents live dashboard metrics from the existing ledgers and invoices, grouped by module and restricted to the user's existing module permissions.
- Each catalog result identifies its period, comparison range, source, and currency.
- Current-period values are compared with the preceding equal-length period when the underlying metric supports comparison.
- Users can filter, sort, paginate, and select displayed columns.
- Saved report views are scoped to the signed-in user and organization. Their filters, date range, sort, page size, and selected columns are validated against a fixed schema; arbitrary query text is not accepted.
- CSV export records an audit event before download, and CSV cells are escaped against spreadsheet formula injection.
- Drill-down actions open the associated authorized module.

## Not enabled

- Excel and PDF generation are not included because the application has no configured export libraries or renderer.
- Scheduled report delivery is not available because no report scheduler or delivery integration is configured.
- AI-generated or natural-language reports are not available; no query generator or AI service is configured.
- Custom report definitions, branch/department/warehouse comparisons, and operational exception catalogs require additional approved data sources and safe, permission-scoped definitions.

No generated SQL is accepted or executed by the reporting API.
