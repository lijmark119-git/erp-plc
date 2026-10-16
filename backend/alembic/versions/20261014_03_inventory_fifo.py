"""Add FIFO inventory items, warehouses, movements, and layers.

Revision ID: 20261014_03_inventory_fifo
Revises: 20261014_02_usernames
Create Date: 2026-10-14 03:30:00.000000
"""

import uuid

from alembic import op
import sqlalchemy as sa


revision = "20261014_03_inventory_fifo"
down_revision = "20261014_02_usernames"
branch_labels = None
depends_on = None

INVENTORY_PERMISSIONS = (
    ("inventory:read", "View inventory items, stock balances, and movements."),
    ("inventory:manage", "Create inventory items and warehouses."),
    ("inventory:transact", "Receive, issue, and transfer inventory stock."),
)


def upgrade() -> None:
    op.create_table(
        "inventory_items",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("sku", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("unit", sa.String(length=24), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["organization_id"], ["organizations.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "organization_id", name="uq_inventory_items_id_org"),
        sa.UniqueConstraint("organization_id", "sku", name="uq_inventory_items_org_sku"),
    )
    op.create_table(
        "inventory_movements",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("item_id", sa.String(length=36), nullable=False),
        sa.Column("movement_type", sa.String(length=20), nullable=False),
        sa.Column("quantity", sa.Numeric(18, 3), nullable=False),
        sa.Column("source_warehouse_id", sa.String(length=36), nullable=True),
        sa.Column("destination_warehouse_id", sa.String(length=36), nullable=True),
        sa.Column("currency", sa.String(length=3), nullable=True),
        sa.Column("unit_cost", sa.Numeric(18, 4), nullable=True),
        sa.Column("reference", sa.String(length=100), nullable=True),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("actor_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "movement_type IN ('receipt', 'issue', 'transfer')",
            name="ck_inventory_movement_type",
        ),
        sa.CheckConstraint("quantity > 0", name="ck_inventory_movement_positive_quantity"),
        sa.CheckConstraint(
            "(movement_type = 'receipt' AND source_warehouse_id IS NULL "
            "AND destination_warehouse_id IS NOT NULL AND currency IS NOT NULL "
            "AND unit_cost IS NOT NULL) OR "
            "(movement_type = 'issue' AND source_warehouse_id IS NOT NULL "
            "AND destination_warehouse_id IS NULL AND currency IS NULL "
            "AND unit_cost IS NULL) OR "
            "(movement_type = 'transfer' AND source_warehouse_id IS NOT NULL "
            "AND destination_warehouse_id IS NOT NULL AND source_warehouse_id <> destination_warehouse_id "
            "AND currency IS NULL AND unit_cost IS NULL)",
            name="ck_inventory_movement_fields_match_type",
        ),
        sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["item_id", "organization_id"],
            ["inventory_items.id", "inventory_items.organization_id"],
            name="fk_inventory_movements_item_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["source_warehouse_id", "organization_id"],
            ["warehouses.id", "warehouses.organization_id"],
            name="fk_inventory_movements_source_warehouse_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["destination_warehouse_id", "organization_id"],
            ["warehouses.id", "warehouses.organization_id"],
            name="fk_inventory_movements_destination_warehouse_org",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "id", "organization_id", "item_id",
            name="uq_inventory_movements_id_org_item",
        ),
    )
    op.create_index(
        "ix_inventory_movements_org_created",
        "inventory_movements",
        ["organization_id", "created_at"],
    )
    op.create_table(
        "inventory_layers",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("item_id", sa.String(length=36), nullable=False),
        sa.Column("warehouse_id", sa.String(length=36), nullable=False),
        sa.Column("movement_id", sa.String(length=36), nullable=False),
        sa.Column("original_quantity", sa.Numeric(18, 3), nullable=False),
        sa.Column("remaining_quantity", sa.Numeric(18, 3), nullable=False),
        sa.Column("unit_cost", sa.Numeric(18, 4), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "remaining_quantity >= 0 AND remaining_quantity <= original_quantity",
            name="ck_inventory_layers_valid_remaining",
        ),
        sa.CheckConstraint(
            "original_quantity > 0",
            name="ck_inventory_layers_positive_original",
        ),
        sa.CheckConstraint("unit_cost >= 0", name="ck_inventory_layers_nonnegative_cost"),
        sa.ForeignKeyConstraint(
            ["item_id", "organization_id"],
            ["inventory_items.id", "inventory_items.organization_id"],
            name="fk_inventory_layers_item_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["warehouse_id", "organization_id"],
            ["warehouses.id", "warehouses.organization_id"],
            name="fk_inventory_layers_warehouse_org",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["movement_id", "organization_id", "item_id"],
            [
                "inventory_movements.id",
                "inventory_movements.organization_id",
                "inventory_movements.item_id",
            ],
            name="fk_inventory_layers_movement_org_item",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "id", "organization_id", "item_id",
            name="uq_inventory_layers_id_org_item",
        ),
    )
    op.create_index(
        "ix_inventory_layers_fifo",
        "inventory_layers",
        ["organization_id", "warehouse_id", "item_id", "created_at", "id"],
    )
    op.create_table(
        "inventory_allocations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("movement_id", sa.String(length=36), nullable=False),
        sa.Column("organization_id", sa.String(length=36), nullable=False),
        sa.Column("item_id", sa.String(length=36), nullable=False),
        sa.Column("layer_id", sa.String(length=36), nullable=False),
        sa.Column("quantity", sa.Numeric(18, 3), nullable=False),
        sa.Column("unit_cost", sa.Numeric(18, 4), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.CheckConstraint(
            "quantity > 0",
            name="ck_inventory_allocations_positive_quantity",
        ),
        sa.CheckConstraint("unit_cost >= 0", name="ck_inventory_allocations_nonnegative_cost"),
        sa.ForeignKeyConstraint(
            ["movement_id", "organization_id", "item_id"],
            [
                "inventory_movements.id",
                "inventory_movements.organization_id",
                "inventory_movements.item_id",
            ],
            name="fk_inventory_allocations_movement_org_item",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["layer_id", "organization_id", "item_id"],
            ["inventory_layers.id", "inventory_layers.organization_id", "inventory_layers.item_id"],
            name="fk_inventory_allocations_layer_org_item",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id"),
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
    permission_ids = {}
    for code, description in INVENTORY_PERMISSIONS:
        permission_id = str(uuid.uuid4())
        op.get_bind().execute(
            permission_table.insert().values(
                id=permission_id,
                code=code,
                description=description,
            )
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
        permission_table.c.code.in_([code for code, _ in INVENTORY_PERMISSIONS])
    )
    op.get_bind().execute(role_permission_table.delete().where(role_permission_table.c.permission_id.in_(permission_ids)))
    op.get_bind().execute(permission_table.delete().where(permission_table.c.code.in_([code for code, _ in INVENTORY_PERMISSIONS])))
    op.drop_table("inventory_allocations")
    op.drop_index("ix_inventory_layers_fifo", table_name="inventory_layers")
    op.drop_table("inventory_layers")
    op.drop_index("ix_inventory_movements_org_created", table_name="inventory_movements")
    op.drop_table("inventory_movements")
    op.drop_table("inventory_items")
