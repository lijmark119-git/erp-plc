# HR and Payroll

HR and payroll are implemented as additions to the existing ERP. Existing authentication, role permissions, PostgreSQL, and non-HR modules remain in place.

## Employee and organization management

- Create and edit employees with a unique employee number, personal and contact details, emergency contact, department, position, branch, employment type, hire date, contract, salary, allowances, deductions, and status.
- Terminate employees without deleting their attendance or payroll history.
- Maintain departments, positions, branches, and employee-linked hierarchy nodes.

## Attendance and leave

- Record Ethiopia-local check-in and check-out, working hours, overtime, and late arrivals.
- Record absences and review attendance history and aggregate reports.
- Configure paid or unpaid leave types and annual allowances; submit leave requests and approve or reject pending requests.
- Pending leave requests reserve balance, approved requests update used and available balances, and the HR screen shows approved leave on a selectable month calendar.

## Payroll

Payroll periods follow the enforced workflow:

`Draft -> Calculate -> Review -> Approve -> Post -> Paid`

Payroll calculation includes employees with `Active` or `On leave` status and excludes terminated employees. It uses employee salary, allowances, attendance overtime, deductions, advances, configured income-tax bands, and employee/employer pension rates. Payroll rules can be updated by an ADMIN from the payroll settings screen; rates and thresholds are configuration defaults, not a substitute for current Ethiopian tax or labor-law advice.

Each posted payroll and payment creates a balanced, posted journal in the existing PostgreSQL general ledger. Payroll uses these seeded account codes:

| Account | Code |
| --- | --- |
| Employee advances receivable | 1210 |
| Salary payable | 2010 |
| Other deductions payable | 2110 |
| Income tax payable | 2210 |
| Pension payable | 2220 |
| Salary expense | 6010 |
| Employer-related expense | 6020 |
| Bank/Cash (cash and cash equivalents) | 1000 |

The payment step records the accounting journal and marks the payroll period paid; it does not initiate an external bank transfer.

## Persistence, permissions, and audit

- With `DATABASE_URL` configured, HR records are persisted by organization in PostgreSQL `hr_workspaces` JSONB, and workspace updates and associated payroll ledger posting share a database transaction.
- Without PostgreSQL configured, the existing JSON-file development fallback is retained.
- Payroll journals use the existing accounting journal service, including accounting-period checks, journal numbering, audit events, and the posted general ledger.
- HR actions are protected by the existing HR/RBAC permission checks and recorded in the HR audit trail. Payroll rule configuration is ADMIN-only.

## Reports and payslips

- Employee register and CSV export.
- Attendance, leave, and payroll summary reports.
- Payroll period detail, posted journal listing, and printable employee payslips.

## API surface

- Employees: `GET /api/hr/employees`, `POST /api/employees`, `PUT /api/hr/employees/:id`
- Organization: `GET /api/hr/organization`, `POST /api/hr/departments`, `POST /api/hr/positions`, `POST /api/hr/branches`, `POST /api/hr/hierarchy`
- Attendance: `GET /api/hr/attendance`, `POST /api/hr/attendance/check-in/:employeeId`, `POST /api/hr/attendance/check-out/:employeeId`, `POST /api/hr/attendance/absence`
- Leave: `GET /api/hr/leave`, `GET /api/hr/leave/calendar`, `POST /api/hr/leave/types`, `POST /api/hr/leave/requests`, `POST /api/hr/leave/requests/:id/approve`
- Payroll: `GET /api/hr/payroll`, `POST /api/hr/payroll/settings`, `POST /api/hr/payroll/periods`, and `POST /api/hr/payroll/periods/:id/{calculate,review,approve,post,pay}`
- Payslips and reports: `GET /api/hr/payroll/payslip/:employeeId`, `GET /api/hr/payroll/reports`, `GET /api/hr/reports`, `GET /api/hr/audit`

## Database setup and verification

Apply pending schema updates with:

```sh
npm run db:migrate
```

The HR workspace and payroll-account migrations are additive. Payroll posting requires the seeded account codes listed above. The journal sequence is keyed by organization and fiscal year.

Verification performed: all 28 existing Node tests passed, including HR API, payroll workflow, RBAC, and accounting journal tests.
