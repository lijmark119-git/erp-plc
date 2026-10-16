"""Add organization-scoped social contribution records.

Revision ID: 20261014_08_social_impact
Revises: 20261014_07_hr
Create Date: 2026-10-14 08:00:00.000000
"""

import uuid

from alembic import op
import sqlalchemy as sa


revision = "20261014_08_social_impact"
down_revision = "20261014_07_hr"
branch_labels = None
depends_on = None

FEATURE_PERMISSIONS = (
    ("manufacturing:read", "View manufacturing sites and operational dashboard metrics."),
    ("social:manage", "Record organization social-contribution activities."),
    ("social:read", "View organization social-contribution records and results."),
)


def upgrade() -> None:
    op.create_table(
        "social_contributions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("branch_id", sa.String(length=36), nullable=True),
        sa.Column("factory_id", sa.String(length=36), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("contribution_type", sa.String(length=40), nullable=False),
        sa.Column("occurred_on", sa.Date(), nullable=False),
        sa.Column("beneficiary_count", sa.Integer(), nullable=False),
        sa.Column("volunteer_hours", sa.Numeric(12, 2), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=True),
        sa.Column("currency", sa.String(length=3), nullable=True),
        sa.Column("partner", sa.String(length=200), nullable=True),
        sa.Column("note", sa.String(length=1000), nullable=True),
        sa.Column("created_by", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.CheckConstraint(
            "contribution_type IN ('community', 'education', 'health', 'environment', "
            "'employee_volunteering', 'local_supplier_development')",
            name="ck_social_contributions_type",
        ),
        sa.CheckConstraint("beneficiary_count >= 0", name="ck_social_contributions_beneficiaries"),
        sa.CheckConstraint("volunteer_hours >= 0", name="ck_social_contributions_hours"),
        sa.CheckConstraint("amount IS NULL OR amount >= 0", name="ck_social_contributions_amount"),
        sa.CheckConstraint("branch_id IS NULL OR factory_id IS NULL", name="ck_social_contributions_single_location"),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["branch_id", "organization_id"],
            ["branches.id", "branches.organization_id"],
            name="fk_social_contributions_branch_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["factory_id", "organization_id"],
            ["factories.id", "factories.organization_id"],
            name="fk_social_contributions_factory_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_social_contributions_org_date",
        "social_contributions",
        ["organization_id", "occurred_on"],
    )

    bind = op.get_bind()
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
    permission_ids = []
    for code, description in FEATURE_PERMISSIONS:
        permission_id = bind.execute(
            sa.select(permission_table.c.id).where(permission_table.c.code == code)
        ).scalar_one_or_none()
        if permission_id is None:
            permission_id = str(uuid.uuid4())
            bind.execute(permission_table.insert().values(
                id=permission_id, code=code, description=description
            ))
        permission_ids.append(permission_id)

    for role_id in bind.execute(
        sa.select(role_table.c.id).where(role_table.c.is_system.is_(True))
    ).scalars():
        for permission_id in permission_ids:
            exists = bind.execute(
                sa.select(role_permission_table.c.role_id).where(
                    role_permission_table.c.role_id == role_id,
                    role_permission_table.c.permission_id == permission_id,
                )
            ).first()
            if exists is None:
                bind.execute(role_permission_table.insert().values(
                    role_id=role_id, permission_id=permission_id
                ))


def downgrade() -> None:
    bind = op.get_bind()
    permission_table = sa.table(
        "permissions",
        sa.column("id", sa.String(length=36)),
        sa.column("code", sa.String(length=120)),
    )
    role_permission_table = sa.table(
        "role_permissions",
        sa.column("permission_id", sa.String(length=36)),
    )
    permission_ids = sa.select(permission_table.c.id).where(
        permission_table.c.code.in_([code for code, _ in FEATURE_PERMISSIONS])
    )
    bind.execute(role_permission_table.delete().where(
        role_permission_table.c.permission_id.in_(permission_ids)
    ))
    bind.execute(permission_table.delete().where(
        permission_table.c.code.in_([code for code, _ in FEATURE_PERMISSIONS])
    ))
    op.drop_index("ix_social_contributions_org_date", table_name="social_contributions")
    op.drop_table("social_contributions")