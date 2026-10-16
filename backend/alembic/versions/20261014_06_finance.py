"""Add chart of accounts and balanced manual journal entries.

Revision ID: 20261014_06_finance
Revises: 20261014_05_sales
Create Date: 2026-10-14 05:15:00.000000
"""

import uuid

from alembic import op
import sqlalchemy as sa


revision = "20261014_06_finance"
down_revision = "20261014_05_sales"
branch_labels = None
depends_on = None

FINANCE_PERMISSIONS = (
    ("finance:accounts_manage", "Create financial chart-of-account records."),
    ("finance:post", "Post balanced manual journal entries."),
    ("finance:read", "View financial accounts and posted journal entries."),
)


def upgrade() -> None:
    op.create_table(
        "financial_accounts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("account_type", sa.String(length=20), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')",
            name="ck_financial_accounts_type",
        ),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_financial_accounts_id_org"),
        sa.UniqueConstraint("organization_id", "code", name="uq_financial_accounts_org_code"),
    )
    op.create_table(
        "journal_entries",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("entry_number", sa.String(length=48), nullable=False),
        sa.Column("posting_date", sa.Date(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("reference", sa.String(length=100), nullable=True),
        sa.Column("posted_by", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["posted_by"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_journal_entries_id_org"),
        sa.UniqueConstraint("organization_id", "entry_number", name="uq_journal_entries_org_number"),
    )
    op.create_index(
        "ix_journal_entries_org_posting_date",
        "journal_entries",
        ["organization_id", "posting_date"],
    )
    op.create_table(
        "journal_lines",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("entry_id", sa.String(length=36), nullable=False),
        sa.Column("account_id", sa.String(length=36), nullable=False),
        sa.Column("debit", sa.Numeric(18, 4), nullable=False),
        sa.Column("credit", sa.Numeric(18, 4), nullable=False),
        sa.Column("memo", sa.String(length=255), nullable=True),
        sa.CheckConstraint(
            "(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)",
            name="ck_journal_lines_one_positive_side",
        ),
        sa.ForeignKeyConstraint(
            ["account_id", "organization_id"],
            ["financial_accounts.id", "financial_accounts.organization_id"],
            name="fk_journal_lines_account_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["entry_id", "organization_id"],
            ["journal_entries.id", "journal_entries.organization_id"],
            name="fk_journal_lines_entry_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("entry_id", "account_id", name="uq_journal_lines_entry_account"),
    )
    op.create_index("ix_journal_lines_account", "journal_lines", ["organization_id", "account_id"])

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
    for code, description in FINANCE_PERMISSIONS:
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
        permission_table.c.code.in_([code for code, _ in FINANCE_PERMISSIONS])
    )
    op.get_bind().execute(
        role_permission_table.delete().where(role_permission_table.c.permission_id.in_(permission_ids))
    )
    op.get_bind().execute(
        permission_table.delete().where(
            permission_table.c.code.in_([code for code, _ in FINANCE_PERMISSIONS])
        )
    )
    op.drop_index("ix_journal_lines_account", table_name="journal_lines")
    op.drop_table("journal_lines")
    op.drop_index("ix_journal_entries_org_posting_date", table_name="journal_entries")
    op.drop_table("journal_entries")
    op.drop_table("financial_accounts")
