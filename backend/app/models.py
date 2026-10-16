from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def new_id() -> str:
    return str(uuid4())


class Organization(Base):
    __tablename__ = "organizations"
    __table_args__ = (UniqueConstraint("code", name="uq_organizations_code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Branch(Base):
    __tablename__ = "branches"
    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_branches_org_code"),
        UniqueConstraint("id", "organization_id", name="uq_branches_id_org"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Warehouse(Base):
    __tablename__ = "warehouses"
    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_warehouses_org_code"),
        UniqueConstraint("id", "organization_id", name="uq_warehouses_id_org"),
        ForeignKeyConstraint(
            ["branch_id", "organization_id"],
            ["branches.id", "branches.organization_id"],
            name="fk_warehouses_branch_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    branch_id: Mapped[str | None] = mapped_column(String(36))
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Factory(Base):
    __tablename__ = "factories"
    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_factories_org_code"),
        UniqueConstraint("id", "organization_id", name="uq_factories_id_org"),
        ForeignKeyConstraint(
            ["branch_id", "organization_id"],
            ["branches.id", "branches.organization_id"],
            name="fk_factories_branch_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    branch_id: Mapped[str | None] = mapped_column(String(36))
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name="fk_users_organization_id",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(512))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    failed_login_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now())


class Role(Base):
    __tablename__ = "roles"
    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_roles_org_code"),
        UniqueConstraint("id", "organization_id", name="uq_roles_id_org"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    code: Mapped[str] = mapped_column(String(80), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Permission(Base):
    __tablename__ = "permissions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    description: Mapped[str] = mapped_column(String(255), nullable=False)


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role_id: Mapped[str] = mapped_column(ForeignKey("roles.id", ondelete="RESTRICT"), primary_key=True)
    permission_id: Mapped[str] = mapped_column(ForeignKey("permissions.id", ondelete="RESTRICT"), primary_key=True)


class UserRoleAssignment(Base):
    __tablename__ = "user_role_assignments"
    __table_args__ = (
        UniqueConstraint("user_id", "role_id", "organization_id", name="uq_user_role_assignment"),
        ForeignKeyConstraint(
            ["role_id", "organization_id"],
            ["roles.id", "roles.organization_id"],
            name="fk_user_role_role_org",
            ondelete="RESTRICT",
        ),
        Index("ix_user_role_assignments_org_user", "organization_id", "user_id"),
    )

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), primary_key=True)
    role_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)


class UserScopeGrant(Base):
    __tablename__ = "user_scope_grants"
    __table_args__ = (
        CheckConstraint(
            "(CASE WHEN branch_id IS NOT NULL THEN 1 ELSE 0 END + "
            "CASE WHEN warehouse_id IS NOT NULL THEN 1 ELSE 0 END + "
            "CASE WHEN factory_id IS NOT NULL THEN 1 ELSE 0 END) <= 1",
            name="ck_user_scope_one_location",
        ),
        ForeignKeyConstraint(
            ["branch_id", "organization_id"],
            ["branches.id", "branches.organization_id"],
            name="fk_user_scope_branch_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["warehouse_id", "organization_id"],
            ["warehouses.id", "warehouses.organization_id"],
            name="fk_user_scope_warehouse_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["factory_id", "organization_id"],
            ["factories.id", "factories.organization_id"],
            name="fk_user_scope_factory_org",
            ondelete="RESTRICT",
        ),
        Index("ix_user_scope_grants_user_org", "user_id", "organization_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    branch_id: Mapped[str | None] = mapped_column(String(36))
    warehouse_id: Mapped[str | None] = mapped_column(String(36))
    factory_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UserSession(Base):
    __tablename__ = "user_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    csrf_token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(512))


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_org_created", "organization_id", "created_at"),
        ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name="fk_audit_events_organization_id",
        ),
        ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name="fk_audit_events_actor_id",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str | None] = mapped_column(String)
    actor_id: Mapped[str | None] = mapped_column(String)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    resource_type: Mapped[str | None] = mapped_column(String(100))
    resource_id: Mapped[str | None] = mapped_column(String(255))
    message: Mapped[str | None] = mapped_column(Text)
    event_metadata: Mapped[dict | None] = mapped_column("metadata", JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SocialContribution(Base):
    __tablename__ = "social_contributions"
    __table_args__ = (
        CheckConstraint(
            "contribution_type IN ('community', 'education', 'health', 'environment', "
            "'employee_volunteering', 'local_supplier_development')",
            name="ck_social_contributions_type",
        ),
        CheckConstraint("beneficiary_count >= 0", name="ck_social_contributions_beneficiaries"),
        CheckConstraint("volunteer_hours >= 0", name="ck_social_contributions_hours"),
        CheckConstraint("amount IS NULL OR amount >= 0", name="ck_social_contributions_amount"),
        CheckConstraint(
            "branch_id IS NULL OR factory_id IS NULL",
            name="ck_social_contributions_single_location",
        ),
        ForeignKeyConstraint(
            ["branch_id", "organization_id"],
            ["branches.id", "branches.organization_id"],
            name="fk_social_contributions_branch_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["factory_id", "organization_id"],
            ["factories.id", "factories.organization_id"],
            name="fk_social_contributions_factory_org",
            ondelete="RESTRICT",
        ),
        Index("ix_social_contributions_org_date", "organization_id", "occurred_on"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    branch_id: Mapped[str | None] = mapped_column(String(36))
    factory_id: Mapped[str | None] = mapped_column(String(36))
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    contribution_type: Mapped[str] = mapped_column(String(40), nullable=False)
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    beneficiary_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    volunteer_hours: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, default=Decimal("0"))
    amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    currency: Mapped[str | None] = mapped_column(String(3))
    partner: Mapped[str | None] = mapped_column(String(200))
    note: Mapped[str | None] = mapped_column(String(1000))
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SetupState(Base):
    __tablename__ = "system_setup_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bootstrap_complete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Supplier(Base):
    __tablename__ = "suppliers"
    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_suppliers_org_code"),
        UniqueConstraint("id", "organization_id", name="uq_suppliers_id_org"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(50))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"
    __table_args__ = (
        UniqueConstraint("organization_id", "order_number", name="uq_purchase_orders_org_number"),
        UniqueConstraint("id", "organization_id", name="uq_purchase_orders_id_org"),
        CheckConstraint(
            "status IN ('ordered', 'partially_received', 'received')",
            name="ck_purchase_orders_status",
        ),
        ForeignKeyConstraint(
            ["supplier_id", "organization_id"],
            ["suppliers.id", "suppliers.organization_id"],
            name="fk_purchase_orders_supplier_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    supplier_id: Mapped[str] = mapped_column(String(36), nullable=False)
    order_number: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="ordered")
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"
    __table_args__ = (
        UniqueConstraint("id", "organization_id", name="uq_purchase_order_lines_id_org"),
        CheckConstraint("ordered_quantity > 0", name="ck_purchase_order_lines_positive_quantity"),
        CheckConstraint(
            "received_quantity >= 0 AND received_quantity <= ordered_quantity",
            name="ck_purchase_order_lines_received_quantity",
        ),
        CheckConstraint("unit_cost >= 0", name="ck_purchase_order_lines_nonnegative_cost"),
        ForeignKeyConstraint(
            ["purchase_order_id", "organization_id"],
            ["purchase_orders.id", "purchase_orders.organization_id"],
            name="fk_purchase_order_lines_order_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["item_id", "organization_id"],
            ["inventory_items.id", "inventory_items.organization_id"],
            name="fk_purchase_order_lines_item_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    purchase_order_id: Mapped[str] = mapped_column(String(36), nullable=False)
    item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    ordered_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    received_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False, default=Decimal("0"))
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)


class Customer(Base):
    __tablename__ = "customers"
    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_customers_org_code"),
        UniqueConstraint("id", "organization_id", name="uq_customers_id_org"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(50))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SalesOrder(Base):
    __tablename__ = "sales_orders"
    __table_args__ = (
        UniqueConstraint("organization_id", "order_number", name="uq_sales_orders_org_number"),
        UniqueConstraint("id", "organization_id", name="uq_sales_orders_id_org"),
        CheckConstraint(
            "status IN ('open', 'partially_shipped', 'shipped')",
            name="ck_sales_orders_status",
        ),
        ForeignKeyConstraint(
            ["customer_id", "organization_id"],
            ["customers.id", "customers.organization_id"],
            name="fk_sales_orders_customer_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    customer_id: Mapped[str] = mapped_column(String(36), nullable=False)
    order_number: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="open")
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )


class SalesOrderLine(Base):
    __tablename__ = "sales_order_lines"
    __table_args__ = (
        UniqueConstraint("id", "organization_id", name="uq_sales_order_lines_id_org"),
        CheckConstraint("ordered_quantity > 0", name="ck_sales_order_lines_positive_quantity"),
        CheckConstraint(
            "shipped_quantity >= 0 AND shipped_quantity <= ordered_quantity",
            name="ck_sales_order_lines_shipped_quantity",
        ),
        CheckConstraint("unit_price >= 0", name="ck_sales_order_lines_nonnegative_price"),
        ForeignKeyConstraint(
            ["sales_order_id", "organization_id"],
            ["sales_orders.id", "sales_orders.organization_id"],
            name="fk_sales_order_lines_order_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["item_id", "organization_id"],
            ["inventory_items.id", "inventory_items.organization_id"],
            name="fk_sales_order_lines_item_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    sales_order_id: Mapped[str] = mapped_column(String(36), nullable=False)
    item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    ordered_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    shipped_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False, default=Decimal("0"))
    unit_price: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)


class FinancialAccount(Base):
    __tablename__ = "financial_accounts"
    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_financial_accounts_org_code"),
        UniqueConstraint("id", "organization_id", name="uq_financial_accounts_id_org"),
        CheckConstraint(
            "account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')",
            name="ck_financial_accounts_type",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    code: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    account_type: Mapped[str] = mapped_column(String(20), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JournalEntry(Base):
    __tablename__ = "journal_entries"
    __table_args__ = (
        UniqueConstraint("organization_id", "entry_number", name="uq_journal_entries_org_number"),
        UniqueConstraint("id", "organization_id", name="uq_journal_entries_id_org"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    entry_number: Mapped[str] = mapped_column(String(48), nullable=False)
    posting_date: Mapped[date] = mapped_column(Date, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    reference: Mapped[str | None] = mapped_column(String(100))
    posted_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )


class JournalLine(Base):
    __tablename__ = "journal_lines"
    __table_args__ = (
        CheckConstraint(
            "(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)",
            name="ck_journal_lines_one_positive_side",
        ),
        ForeignKeyConstraint(
            ["account_id", "organization_id"],
            ["financial_accounts.id", "financial_accounts.organization_id"],
            name="fk_journal_lines_account_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["entry_id", "organization_id"],
            ["journal_entries.id", "journal_entries.organization_id"],
            name="fk_journal_lines_entry_org",
            ondelete="RESTRICT",
        ),
        UniqueConstraint("entry_id", "account_id", name="uq_journal_lines_entry_account"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    entry_id: Mapped[str] = mapped_column(String(36), nullable=False)
    account_id: Mapped[str] = mapped_column(String(36), nullable=False)
    debit: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=Decimal("0"))
    credit: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=Decimal("0"))
    memo: Mapped[str | None] = mapped_column(String(255))


class Department(Base):
    __tablename__ = "hr_departments"
    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_hr_departments_org_code"),
        UniqueConstraint("id", "organization_id", name="uq_hr_departments_id_org"),
        ForeignKeyConstraint(
            ["parent_id", "organization_id"],
            ["hr_departments.id", "hr_departments.organization_id"],
            name="fk_hr_departments_parent_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    code: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(String(36))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Employee(Base):
    __tablename__ = "hr_employees"
    __table_args__ = (
        UniqueConstraint("organization_id", "employee_number", name="uq_hr_employees_org_number"),
        UniqueConstraint("id", "organization_id", name="uq_hr_employees_id_org"),
        UniqueConstraint("organization_id", "user_id", name="uq_hr_employees_org_user"),
        CheckConstraint(
            "status IN ('active', 'on_leave', 'terminated')",
            name="ck_hr_employees_status",
        ),
        CheckConstraint(
            "employment_type IN ('permanent', 'contract', 'temporary')",
            name="ck_hr_employees_employment_type",
        ),
        CheckConstraint("monthly_salary >= 0 AND pensionable_salary >= 0", name="ck_hr_employees_salary"),
        ForeignKeyConstraint(
            ["department_id", "organization_id"],
            ["hr_departments.id", "hr_departments.organization_id"],
            name="fk_hr_employees_department_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["manager_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_employees_manager_org",
            ondelete="RESTRICT",
        ),
        Index("ix_hr_employees_org_status", "organization_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    employee_number: Mapped[str] = mapped_column(String(32), nullable=False)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    department_id: Mapped[str | None] = mapped_column(String(36))
    manager_id: Mapped[str | None] = mapped_column(String(36))
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    job_title: Mapped[str] = mapped_column(String(120), nullable=False)
    employment_type: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    hire_date: Mapped[date] = mapped_column(Date, nullable=False)
    termination_date: Mapped[date | None] = mapped_column(Date)
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(50))
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    monthly_salary: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    pensionable_salary: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), onupdate=func.now())


class EmployeePayComponent(Base):
    __tablename__ = "hr_employee_pay_components"
    __table_args__ = (
        UniqueConstraint("employee_id", "code", name="uq_hr_pay_components_employee_code"),
        CheckConstraint("component_type IN ('earning', 'deduction')", name="ck_hr_pay_components_type"),
        CheckConstraint("amount > 0", name="ck_hr_pay_components_amount"),
        ForeignKeyConstraint(
            ["employee_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_pay_components_employee_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    employee_id: Mapped[str] = mapped_column(String(36), nullable=False)
    code: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    component_type: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    is_taxable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_pensionable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class LeaveType(Base):
    __tablename__ = "hr_leave_types"
    __table_args__ = (
        UniqueConstraint("organization_id", "code", name="uq_hr_leave_types_org_code"),
        UniqueConstraint("id", "organization_id", name="uq_hr_leave_types_id_org"),
        CheckConstraint("annual_entitlement_days >= 0", name="ck_hr_leave_types_entitlement"),
        CheckConstraint("paid_percentage >= 0 AND paid_percentage <= 100", name="ck_hr_leave_types_paid_percentage"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    code: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    annual_entitlement_days: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    paid_percentage: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class LeaveRequest(Base):
    __tablename__ = "hr_leave_requests"
    __table_args__ = (
        CheckConstraint("requested_days > 0", name="ck_hr_leave_requests_days"),
        CheckConstraint("status IN ('pending', 'approved', 'rejected')", name="ck_hr_leave_requests_status"),
        ForeignKeyConstraint(
            ["employee_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_leave_requests_employee_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["leave_type_id", "organization_id"],
            ["hr_leave_types.id", "hr_leave_types.organization_id"],
            name="fk_hr_leave_requests_type_org",
            ondelete="RESTRICT",
        ),
        Index("ix_hr_leave_requests_org_dates", "organization_id", "start_date", "end_date"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    employee_id: Mapped[str] = mapped_column(String(36), nullable=False)
    leave_type_id: Mapped[str] = mapped_column(String(36), nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    requested_days: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    reason: Mapped[str | None] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    requested_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    decided_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    decision_note: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AttendanceRecord(Base):
    __tablename__ = "hr_attendance_records"
    __table_args__ = (
        UniqueConstraint("organization_id", "employee_id", "work_date", name="uq_hr_attendance_org_employee_date"),
        CheckConstraint(
            "status IN ('present', 'remote', 'absent', 'on_leave')",
            name="ck_hr_attendance_status",
        ),
        ForeignKeyConstraint(
            ["employee_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_attendance_employee_org",
            ondelete="RESTRICT",
        ),
        Index("ix_hr_attendance_org_date", "organization_id", "work_date"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    employee_id: Mapped[str] = mapped_column(String(36), nullable=False)
    work_date: Mapped[date] = mapped_column(Date, nullable=False)
    check_in: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    check_out: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    break_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="present")
    note: Mapped[str | None] = mapped_column(String(255))
    recorded_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PayrollTaxSchedule(Base):
    __tablename__ = "hr_payroll_tax_schedules"
    __table_args__ = (
        UniqueConstraint("organization_id", "effective_from", name="uq_hr_tax_schedules_org_effective"),
        UniqueConstraint("id", "organization_id", name="uq_hr_tax_schedules_id_org"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    source_reference: Mapped[str] = mapped_column(String(500), nullable=False)
    brackets: Mapped[list[dict]] = mapped_column(JSON, nullable=False)
    configured_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PayrollRun(Base):
    __tablename__ = "hr_payroll_runs"
    __table_args__ = (
        UniqueConstraint("organization_id", "period", name="uq_hr_payroll_runs_org_period"),
        UniqueConstraint("id", "organization_id", name="uq_hr_payroll_runs_id_org"),
        CheckConstraint("status IN ('draft', 'finalized')", name="ck_hr_payroll_runs_status"),
        ForeignKeyConstraint(
            ["tax_schedule_id", "organization_id"],
            ["hr_payroll_tax_schedules.id", "hr_payroll_tax_schedules.organization_id"],
            name="fk_hr_payroll_runs_tax_schedule_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    period: Mapped[str] = mapped_column(String(7), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    tax_schedule_id: Mapped[str] = mapped_column(String(36), nullable=False)
    employee_pension_rate: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False)
    employer_pension_rate: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    finalized_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PayrollLine(Base):
    __tablename__ = "hr_payroll_lines"
    __table_args__ = (
        UniqueConstraint("run_id", "employee_id", name="uq_hr_payroll_lines_run_employee"),
        CheckConstraint(
            "gross_pay >= 0 AND taxable_pay >= 0 AND pensionable_pay >= 0 "
            "AND employee_pension >= 0 AND employer_pension >= 0 AND income_tax >= 0 "
            "AND other_deductions >= 0 AND net_pay >= 0",
            name="ck_hr_payroll_lines_nonnegative",
        ),
        ForeignKeyConstraint(
            ["run_id", "organization_id"],
            ["hr_payroll_runs.id", "hr_payroll_runs.organization_id"],
            name="fk_hr_payroll_lines_run_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["employee_id", "organization_id"],
            ["hr_employees.id", "hr_employees.organization_id"],
            name="fk_hr_payroll_lines_employee_org",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    run_id: Mapped[str] = mapped_column(String(36), nullable=False)
    employee_id: Mapped[str] = mapped_column(String(36), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    gross_pay: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    taxable_pay: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    pensionable_pay: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    employee_pension: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    employer_pension: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    income_tax: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    other_deductions: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    net_pay: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    calculation_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)


class InventoryItem(Base):
    __tablename__ = "inventory_items"
    __table_args__ = (
        UniqueConstraint("organization_id", "sku", name="uq_inventory_items_org_sku"),
        UniqueConstraint("id", "organization_id", name="uq_inventory_items_id_org"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    sku: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    unit: Mapped[str] = mapped_column(String(24), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class InventoryMovement(Base):
    __tablename__ = "inventory_movements"
    __table_args__ = (
        CheckConstraint(
            "movement_type IN ('receipt', 'issue', 'transfer')",
            name="ck_inventory_movement_type",
        ),
        CheckConstraint("quantity > 0", name="ck_inventory_movement_positive_quantity"),
        CheckConstraint(
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
        UniqueConstraint("id", "organization_id", "item_id", name="uq_inventory_movements_id_org_item"),
        ForeignKeyConstraint(
            ["item_id", "organization_id"],
            ["inventory_items.id", "inventory_items.organization_id"],
            name="fk_inventory_movements_item_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["source_warehouse_id", "organization_id"],
            ["warehouses.id", "warehouses.organization_id"],
            name="fk_inventory_movements_source_warehouse_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["destination_warehouse_id", "organization_id"],
            ["warehouses.id", "warehouses.organization_id"],
            name="fk_inventory_movements_destination_warehouse_org",
            ondelete="RESTRICT",
        ),
        Index("ix_inventory_movements_org_created", "organization_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    movement_type: Mapped[str] = mapped_column(String(20), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    source_warehouse_id: Mapped[str | None] = mapped_column(String(36))
    destination_warehouse_id: Mapped[str | None] = mapped_column(String(36))
    currency: Mapped[str | None] = mapped_column(String(3))
    unit_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    reference: Mapped[str | None] = mapped_column(String(100))
    note: Mapped[str | None] = mapped_column(String(500))
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )


class InventoryLayer(Base):
    __tablename__ = "inventory_layers"
    __table_args__ = (
        UniqueConstraint("id", "organization_id", "item_id", name="uq_inventory_layers_id_org_item"),
        CheckConstraint("original_quantity > 0", name="ck_inventory_layers_positive_original"),
        CheckConstraint(
            "remaining_quantity >= 0 AND remaining_quantity <= original_quantity",
            name="ck_inventory_layers_valid_remaining",
        ),
        CheckConstraint("unit_cost >= 0", name="ck_inventory_layers_nonnegative_cost"),
        ForeignKeyConstraint(
            ["item_id", "organization_id"],
            ["inventory_items.id", "inventory_items.organization_id"],
            name="fk_inventory_layers_item_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["warehouse_id", "organization_id"],
            ["warehouses.id", "warehouses.organization_id"],
            name="fk_inventory_layers_warehouse_org",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["movement_id", "organization_id", "item_id"],
            ["inventory_movements.id", "inventory_movements.organization_id", "inventory_movements.item_id"],
            name="fk_inventory_layers_movement_org_item",
            ondelete="RESTRICT",
        ),
        Index(
            "ix_inventory_layers_fifo",
            "organization_id",
            "warehouse_id",
            "item_id",
            "created_at",
            "id",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    warehouse_id: Mapped[str] = mapped_column(String(36), nullable=False)
    movement_id: Mapped[str] = mapped_column(String(36), nullable=False)
    original_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    remaining_quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        server_default=func.now(),
    )


class InventoryAllocation(Base):
    __tablename__ = "inventory_allocations"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_inventory_allocations_positive_quantity"),
        CheckConstraint("unit_cost >= 0", name="ck_inventory_allocations_nonnegative_cost"),
        ForeignKeyConstraint(
            ["movement_id", "organization_id", "item_id"],
            ["inventory_movements.id", "inventory_movements.organization_id", "inventory_movements.item_id"],
            name="fk_inventory_allocations_movement_org_item",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["layer_id", "organization_id", "item_id"],
            ["inventory_layers.id", "inventory_layers.organization_id", "inventory_layers.item_id"],
            name="fk_inventory_allocations_layer_org_item",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    movement_id: Mapped[str] = mapped_column(String(36), nullable=False)
    organization_id: Mapped[str] = mapped_column(String(36), nullable=False)
    item_id: Mapped[str] = mapped_column(String(36), nullable=False)
    layer_id: Mapped[str] = mapped_column(String(36), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), nullable=False)
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
