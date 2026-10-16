"""Add HR, leave, attendance, and payroll foundations.

Revision ID: 20261014_07_hr
Revises: 20261014_06_finance
Create Date: 2026-10-14 05:40:00.000000
"""

import uuid

from alembic import op
import sqlalchemy as sa


revision = "20261014_07_hr"
down_revision = "20261014_06_finance"
branch_labels = None
depends_on = None

HR_PERMISSIONS = (
    ("hr:attendance_manage", "Record and manage employee attendance."),
    ("hr:leave_approve", "Approve or reject employee leave requests."),
    ("hr:leave_request", "Submit employee leave requests."),
    ("hr:manage", "Manage HR departments and employee records."),
    ("hr:payroll_manage", "Configure and process payroll."),
    ("hr:payroll_read", "View payroll records and calculations."),
    ("hr:read", "View HR, employee, leave, and attendance records."),
    ("hr:reports", "View HR operational and payroll reports."),
)


def upgrade() -> None:
    op.create_table(
        "hr_departments",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("parent_id", sa.String(length=36), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["parent_id", "organization_id"],
            ["hr_departments.id", "hr_departments.organization_id"],
            name="fk_hr_departments_parent_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_hr_departments_id_org"),
        sa.UniqueConstraint("organization_id", "code", name="uq_hr_departments_org_code"),
    )
    op.create_table(
        "hr_employees",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("employee_number", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=True),
        sa.Column("department_id", sa.String(length=36), nullable=True),
        sa.Column("manager_id", sa.String(length=36), nullable=True),
        sa.Column("full_name", sa.String(length=255), nullable=False),
        sa.Column("job_title", sa.String(length=120), nullable=False),
        sa.Column("employment_type", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("hire_date", sa.Date(), nullable=False),
        sa.Column("termination_date", sa.Date(), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("phone", sa.String(length=50), nullable=True),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("monthly_salary", sa.Numeric(18, 2), nullable=False),
        sa.Column("pensionable_salary", sa.Numeric(18, 2), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('active', 'on_leave', 'terminated')",
            name="ck_hr_employees_status",
        ),
        sa.CheckConstraint(
            "employment_type IN ('permanent', 'contract', 'temporary')",
            name="ck_hr_employees_employment_type",
        ),
        sa.CheckConstraint("monthly_salary >= 0 AND pensionable_salary >= 0", name="ck_hr_employees_salary"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["department_id", "organization_id"],
            ["hr_departments.id", "hr_departments.organization_id"],
            name="fk_hr_employees_department_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["manager_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_employees_manager_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_hr_employees_id_org"),
        sa.UniqueConstraint("organization_id", "employee_number", name="uq_hr_employees_org_number"),
        sa.UniqueConstraint("organization_id", "user_id", name="uq_hr_employees_org_user"),
    )
    op.create_index("ix_hr_employees_org_status", "hr_employees", ["organization_id", "status"])
    op.create_table(
        "hr_employee_pay_components",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("employee_id", sa.String(length=36), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("component_type", sa.String(length=20), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("is_taxable", sa.Boolean(), nullable=False),
        sa.Column("is_pensionable", sa.Boolean(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.CheckConstraint("component_type IN ('earning', 'deduction')", name="ck_hr_pay_components_type"),
        sa.CheckConstraint("amount > 0", name="ck_hr_pay_components_amount"),
        sa.ForeignKeyConstraint(
            ["employee_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_pay_components_employee_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("employee_id", "code", name="uq_hr_pay_components_employee_code"),
    )
    op.create_table(
        "hr_leave_types",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("annual_entitlement_days", sa.Numeric(8, 2), nullable=False),
        sa.Column("paid_percentage", sa.Numeric(5, 2), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.CheckConstraint("annual_entitlement_days >= 0", name="ck_hr_leave_types_entitlement"),
        sa.CheckConstraint("paid_percentage >= 0 AND paid_percentage <= 100", name="ck_hr_leave_types_paid_percentage"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_hr_leave_types_id_org"),
        sa.UniqueConstraint("organization_id", "code", name="uq_hr_leave_types_org_code"),
    )
    op.create_table(
        "hr_leave_requests",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("employee_id", sa.String(length=36), nullable=False),
        sa.Column("leave_type_id", sa.String(length=36), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("requested_days", sa.Numeric(8, 2), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("requested_by", sa.String(length=36), nullable=False),
        sa.Column("decided_by", sa.String(length=36), nullable=True),
        sa.Column("decision_note", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("requested_days > 0", name="ck_hr_leave_requests_days"),
        sa.CheckConstraint("status IN ('pending', 'approved', 'rejected')", name="ck_hr_leave_requests_status"),
        sa.ForeignKeyConstraint(
            ["employee_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_leave_requests_employee_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["leave_type_id", "organization_id"],
            ["hr_leave_types.id", "hr_leave_types.organization_id"],
            name="fk_hr_leave_requests_type_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["requested_by"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["decided_by"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_hr_leave_requests_org_dates", "hr_leave_requests", ["organization_id", "start_date", "end_date"])
    op.create_table(
        "hr_attendance_records",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("employee_id", sa.String(length=36), nullable=False),
        sa.Column("work_date", sa.Date(), nullable=False),
        sa.Column("check_in", sa.DateTime(timezone=True), nullable=True),
        sa.Column("check_out", sa.DateTime(timezone=True), nullable=True),
        sa.Column("break_minutes", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.Column("recorded_by", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.CheckConstraint(
            "status IN ('present', 'remote', 'absent', 'on_leave')",
            name="ck_hr_attendance_status",
        ),
        sa.ForeignKeyConstraint(
            ["employee_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_attendance_employee_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["recorded_by"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("organization_id", "employee_id", "work_date", name="uq_hr_attendance_org_employee_date"),
    )
    op.create_index("ix_hr_attendance_org_date", "hr_attendance_records", ["organization_id", "work_date"])
    op.create_table(
        "hr_payroll_tax_schedules",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("source_reference", sa.String(length=500), nullable=False),
        sa.Column("brackets", sa.JSON(), nullable=False),
        sa.Column("configured_by", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["configured_by"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_hr_tax_schedules_id_org"),
        sa.UniqueConstraint("organization_id", "effective_from", name="uq_hr_tax_schedules_org_effective"),
    )
    op.create_table(
        "hr_payroll_runs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("period", sa.String(length=7), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("tax_schedule_id", sa.String(length=36), nullable=False),
        sa.Column("employee_pension_rate", sa.Numeric(5, 4), nullable=False),
        sa.Column("employer_pension_rate", sa.Numeric(5, 4), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=False),
        sa.Column("finalized_by", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column("finalized_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('draft', 'finalized')", name="ck_hr_payroll_runs_status"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["tax_schedule_id", "organization_id"],
            ["hr_payroll_tax_schedules.id", "hr_payroll_tax_schedules.organization_id"],
            name="fk_hr_payroll_runs_tax_schedule_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["finalized_by"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_hr_payroll_runs_id_org"),
        sa.UniqueConstraint("organization_id", "period", name="uq_hr_payroll_runs_org_period"),
    )
    op.create_table(
        "hr_payroll_lines",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("employee_id", sa.String(length=36), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("gross_pay", sa.Numeric(18, 2), nullable=False),
        sa.Column("taxable_pay", sa.Numeric(18, 2), nullable=False),
        sa.Column("pensionable_pay", sa.Numeric(18, 2), nullable=False),
        sa.Column("employee_pension", sa.Numeric(18, 2), nullable=False),
        sa.Column("employer_pension", sa.Numeric(18, 2), nullable=False),
        sa.Column("income_tax", sa.Numeric(18, 2), nullable=False),
        sa.Column("other_deductions", sa.Numeric(18, 2), nullable=False),
        sa.Column("net_pay", sa.Numeric(18, 2), nullable=False),
        sa.Column("calculation_snapshot", sa.JSON(), nullable=False),
        sa.CheckConstraint(
            "gross_pay >= 0 AND taxable_pay >= 0 AND pensionable_pay >= 0 "
            "AND employee_pension >= 0 AND employer_pension >= 0 AND income_tax >= 0 "
            "AND other_deductions >= 0 AND net_pay >= 0",
            name="ck_hr_payroll_lines_nonnegative",
        ),
        sa.ForeignKeyConstraint(
            ["run_id", "organization_id"],
            ["hr_payroll_runs.id", "hr_payroll_runs.organization_id"],
            name="fk_hr_payroll_lines_run_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["employee_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_payroll_lines_employee_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "employee_id", name="uq_hr_payroll_lines_run_employee"),
    )

    permission_table = sa.table(
        "permissions",
        sa.column("id", sa.String(length=36)),
        sa.column("code", sa.String(length=120)),
        sa.column("description", sa.String(length=255)),
    )
    role_table = sa.table(
        "roles",
        sa.column("id", sa.String(length=36)),
        sa.column("is_system", sa.Boolean()),
    )
    role_permission_table = sa.table(
        "role_permissions",
        sa.column("role_id", sa.String(length=36)),
        sa.column("permission_id", sa.String(length=36)),
    )
    permission_ids: dict[str, str] = {}
    for code, description in HR_PERMISSIONS:
        existing = op.get_bind().execute(
            sa.select(permission_table.c.id).where(permission_table.c.code == code)
        ).scalar_one_or_none()
        permission_id = existing or str(uuid.uuid4())
        if existing is None:
            op.get_bind().execute(
                permission_table.insert().values(id=permission_id, code=code, description=description)
            )
        permission_ids[code] = permission_id

    system_role_ids = op.get_bind().execute(
        sa.select(role_table.c.id).where(role_table.c.is_system.is_(True))
    ).scalars()
    for role_id in system_role_ids:
        for permission_id in permission_ids.values():
            if op.get_bind().execute(
                sa.select(role_permission_table.c.role_id).where(
                    role_permission_table.c.role_id == role_id,
                    role_permission_table.c.permission_id == permission_id,
                )
            ).first() is None:
                op.get_bind().execute(
                    role_permission_table.insert().values(
                        role_id=role_id,
                        permission_id=permission_id,
                    )
                )


def downgrade() -> None:
    role_permission_table = sa.table(
        "role_permissions",
        sa.column("permission_id", sa.String(length=36)),
    )
    permission_table = sa.table(
        "permissions",
        sa.column("id", sa.String(length=36)),
        sa.column("code", sa.String(length=120)),
    )
    permission_ids = sa.select(permission_table.c.id).where(
        permission_table.c.code.in_([code for code, _ in HR_PERMISSIONS])
    )
    op.get_bind().execute(
        role_permission_table.delete().where(role_permission_table.c.permission_id.in_(permission_ids))
    )
    op.get_bind().execute(
        permission_table.delete().where(
            permission_table.c.code.in_([code for code, _ in HR_PERMISSIONS])
        )
    )
    op.drop_table("hr_payroll_lines")
    op.drop_table("hr_payroll_runs")
    op.drop_table("hr_payroll_tax_schedules")
    op.drop_index("ix_hr_attendance_org_date", table_name="hr_attendance_records")
    op.drop_table("hr_attendance_records")
    op.drop_index("ix_hr_leave_requests_org_dates", table_name="hr_leave_requests")
    op.drop_table("hr_leave_requests")
    op.drop_table("hr_leave_types")
    op.drop_table("hr_employee_pay_components")
    op.drop_index("ix_hr_employees_org_status", table_name="hr_employees")
    op.drop_table("hr_employees")
    op.drop_table("hr_departments")
