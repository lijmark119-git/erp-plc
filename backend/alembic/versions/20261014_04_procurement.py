"""Add supplier and purchase-order workflows.

Revision ID: 20261014_04_procurement
Revises: 20261014_03_inventory_fifo
Create Date: 2026-10-14 04:00:00.000000
"""

import uuid

from alembic import op
import sqlalchemy as sa


revision = "20261014_04_procurement"
down_revision = "20261014_03_inventory_fifo"
branch_labels = None
depends_on = None

PROCUREMENT_PERMISSIONS = (
    ("procurement:manage", "Create and manage supplier records."),
    ("procurement:read", "View suppliers and purchase orders."),
    ("procurement:order", "Create and issue purchase orders."),
    ("procurement:receive", "Receive purchase order deliveries into inventory."),
)


def upgrade() -> None:
    op.create_table(
        "suppliers",
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
        sa.UniqueConstraint("id", "organization_id", name="uq_suppliers_id_org"),
        sa.UniqueConstraint("organization_id", "code", name="uq_suppliers_org_code"),
    )
    op.create_table(
        "purchase_orders",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("supplier_id", sa.String(length=36), nullable=False),
        sa.Column("order_number", sa.String(length=40), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "status IN ('ordered', 'partially_received', 'received')",
            name="ck_purchase_orders_status",
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["supplier_id", "organization_id"],
            ["suppliers.id", "suppliers.organization_id"],
            name="fk_purchase_orders_supplier_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_purchase_orders_id_org"),
        sa.UniqueConstraint("organization_id", "order_number", name="uq_purchase_orders_org_number"),
    )
    op.create_index(
        "ix_purchase_orders_org_created",
        "purchase_orders",
        ["organization_id", "created_at"],
    )
    op.create_table(
        "purchase_order_lines",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("purchase_order_id", sa.String(length=36), nullable=False),
        sa.Column("item_id", sa.String(length=36), nullable=False),
        sa.Column("ordered_quantity", sa.Numeric(18, 3), nullable=False),
        sa.Column("received_quantity", sa.Numeric(18, 3), nullable=False),
        sa.Column("unit_cost", sa.Numeric(18, 4), nullable=False),
        sa.CheckConstraint("ordered_quantity > 0", name="ck_purchase_order_lines_positive_quantity"),
        sa.CheckConstraint(
            "received_quantity >= 0 AND received_quantity <= ordered_quantity",
            name="ck_purchase_order_lines_received_quantity",
        ),
        sa.CheckConstraint("unit_cost >= 0", name="ck_purchase_order_lines_nonnegative_cost"),
        sa.ForeignKeyConstraint(
            ["item_id", "organization_id"],
            ["inventory_items.id", "inventory_items.organization_id"],
            name="fk_purchase_order_lines_item_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["purchase_order_id", "organization_id"],
            ["purchase_orders.id", "purchase_orders.organization_id"],
            name="fk_purchase_order_lines_order_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_purchase_order_lines_id_org"),
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
    for code, description in PROCUREMENT_PERMISSIONS:
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
    op.get_bind().execute(
        role_permission_table.insert(),
        [
            {"role_id": role_id, "permission_id": permission_id}
            for role_id in system_role_ids
            for permission_id in permission_ids.values()
        ],
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
        permission_table.c.code.in_([code for code, _ in PROCUREMENT_PERMISSIONS])
    )
    op.get_bind().execute(
        role_permission_table.delete().where(role_permission_table.c.permission_id.in_(permission_ids))
    )
    op.get_bind().execute(
        permission_table.delete().where(
            permission_table.c.code.in_([code for code, _ in PROCUREMENT_PERMISSIONS])
        )
    )
    op.drop_table("purchase_order_lines")
    op.drop_index("ix_purchase_orders_org_created", table_name="purchase_orders")
    op.drop_table("purchase_orders")
    op.drop_table("suppliers")
