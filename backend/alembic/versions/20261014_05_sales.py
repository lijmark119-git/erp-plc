"""Add customers, sales orders, and FIFO shipment fulfillment.

Revision ID: 20261014_05_sales
Revises: 20261014_04_procurement
Create Date: 2026-10-14 04:45:00.000000
"""

import uuid

from alembic import op
import sqlalchemy as sa


revision = "20261014_05_sales"
down_revision = "20261014_04_procurement"
branch_labels = None
depends_on = None

SALES_PERMISSIONS = (
    ("sales:customer_manage", "Create customer records."),
    ("sales:fulfill", "Fulfill sales orders and issue inventory."),
    ("sales:order", "Create customer sales orders."),
    ("sales:read", "View customers and sales orders."),
)


def upgrade() -> None:
    op.create_table(
        "customers",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("code", sa.String(length=50), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("phone", sa.String(length=50), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_customers_id_org"),
        sa.UniqueConstraint("organization_id", "code", name="uq_customers_org_code"),
    )
    op.create_table(
        "sales_orders",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("customer_id", sa.String(length=36), nullable=False),
        sa.Column("order_number", sa.String(length=40), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "status IN ('open', 'partially_shipped', 'shipped')",
            name="ck_sales_orders_status",
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["customer_id", "organization_id"],
            ["customers.id", "customers.organization_id"],
            name="fk_sales_orders_customer_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_sales_orders_id_org"),
        sa.UniqueConstraint("organization_id", "order_number", name="uq_sales_orders_org_number"),
    )
    op.create_index("ix_sales_orders_org_created", "sales_orders", ["organization_id", "created_at"])
    op.create_table(
        "sales_order_lines",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("sales_order_id", sa.String(length=36), nullable=False),
        sa.Column("item_id", sa.String(length=36), nullable=False),
        sa.Column("ordered_quantity", sa.Numeric(18, 3), nullable=False),
        sa.Column("shipped_quantity", sa.Numeric(18, 3), nullable=False),
        sa.Column("unit_price", sa.Numeric(18, 4), nullable=False),
        sa.CheckConstraint("ordered_quantity > 0", name="ck_sales_order_lines_positive_quantity"),
        sa.CheckConstraint(
            "shipped_quantity >= 0 AND shipped_quantity <= ordered_quantity",
            name="ck_sales_order_lines_shipped_quantity",
        ),
        sa.CheckConstraint("unit_price >= 0", name="ck_sales_order_lines_nonnegative_price"),
        sa.ForeignKeyConstraint(
            ["item_id", "organization_id"],
            ["inventory_items.id", "inventory_items.organization_id"],
            name="fk_sales_order_lines_item_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["sales_order_id", "organization_id"],
            ["sales_orders.id", "sales_orders.organization_id"],
            name="fk_sales_order_lines_order_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_sales_order_lines_id_org"),
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
    for code, description in SALES_PERMISSIONS:
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
            exists = op.get_bind().execute(
                sa.select(role_permission_table.c.role_id).where(
                    role_permission_table.c.role_id == role_id,
                    role_permission_table.c.permission_id == permission_id,
                )
            ).first()
            if exists is None:
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
        permission_table.c.code.in_([code for code, _ in SALES_PERMISSIONS])
    )
    op.get_bind().execute(
        role_permission_table.delete().where(role_permission_table.c.permission_id.in_(permission_ids))
    )
    op.get_bind().execute(
        permission_table.delete().where(
            permission_table.c.code.in_([code for code, _ in SALES_PERMISSIONS])
        )
    )
    op.drop_table("sales_order_lines")
    op.drop_index("ix_sales_orders_org_created", table_name="sales_orders")
    op.drop_table("sales_orders")
    op.drop_table("customers")
