from collections.abc import Generator
from datetime import date, datetime, time, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.models import (
    Branch,
    AttendanceRecord,
    Employee,
    InventoryAllocation,
    InventoryItem,
    InventoryLayer,
    InventoryMovement,
    JournalEntry,
    JournalLine,
    Organization,
    Permission,
    Role,
    RolePermission,
    User,
    UserRoleAssignment,
    UserScopeGrant,
    Warehouse,
)
from app.security import hash_password


@pytest.fixture
def inventory_client() -> Generator[TestClient, None, None]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def enable_sqlite_foreign_keys(connection, _record) -> None:
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)
    test_session_maker = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_get_db() -> Generator[Session, None, None]:
        yield from _db_session(test_session_maker)

    app.dependency_overrides[get_db] = override_get_db
    with test_session_maker() as db:
        organization = Organization(code="INV", name="Inventory Test")
        db.add(organization)
        db.flush()
        branch = Branch(organization_id=organization.id, code="B1", name="Branch One")
        warehouse_a = Warehouse(
            organization_id=organization.id,
            code="A",
            name="Warehouse A",
        )
        warehouse_b = Warehouse(
            organization_id=organization.id,
            code="B",
            name="Warehouse B",
        )
        role = Role(
            organization_id=organization.id,
            code="inventory_admin",
            name="Inventory Administrator",
            is_system=True,
        )
        user = User(
            organization_id=organization.id,
            username="inventory.admin",
            full_name="Inventory Admin",
            password_hash=hash_password("Inventory-Test-Password-123"),
            is_active=True,
        )
        db.add_all([branch, warehouse_a, warehouse_b, role, user])
        permissions = [
            Permission(code=code, description=code)
            for code in (
                "inventory:read",
                "inventory:manage",
                "inventory:transact",
                "manufacturing:read",
                "procurement:read",
                "procurement:manage",
                "procurement:order",
                "procurement:receive",
                "sales:read",
                "sales:customer_manage",
                "sales:order",
                "sales:fulfill",
                "finance:read",
                "finance:accounts_manage",
                "finance:post",
                "hr:attendance_manage",
                "hr:leave_approve",
                "hr:leave_request",
                "hr:manage",
                "hr:payroll_manage",
                "hr:payroll_read",
                "hr:read",
                "hr:reports",
                "social:manage",
                "social:read",
            )
        ]
        db.add_all(permissions)
        db.flush()
        db.add_all(
            RolePermission(role_id=role.id, permission_id=permission.id)
            for permission in permissions
        )
        db.flush()
        db.add_all(
            [
                UserRoleAssignment(
                    user_id=user.id,
                    role_id=role.id,
                    organization_id=organization.id,
                ),
                UserScopeGrant(user_id=user.id, organization_id=organization.id),
            ]
        )
        db.commit()
        seeded = {
            "organization_id": organization.id,
            "branch_id": branch.id,
            "warehouse_a_id": warehouse_a.id,
            "warehouse_b_id": warehouse_b.id,
            "session_maker": test_session_maker,
        }

    client = TestClient(app)
    response = client.post(
        "/api/auth/login",
        json={"username": "inventory.admin", "password": "Inventory-Test-Password-123"},
    )
    assert response.status_code == 200
    client.headers.update({"X-CSRF-Token": response.json()["csrf_token"]})
    client.test_data = seeded
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(engine)
        engine.dispose()


def _db_session(session_maker: sessionmaker) -> Generator[Session, None, None]:
    with session_maker() as session:
        yield session


def test_fifo_receipts_issue_and_transfer_preserve_cost_layers(
    inventory_client: TestClient,
) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    item_response = inventory_client.post(
        "/api/inventory/items",
        json={
            "organization_id": organization_id,
            "sku": "raw-001",
            "name": "Raw Material",
            "unit": "kg",
        },
    )
    assert item_response.status_code == 201
    item_id = item_response.json()["id"]

    for quantity, unit_cost in (("10", "2.0000"), ("8", "5.0000")):
        response = inventory_client.post(
            "/api/inventory/receipts",
            json={
                "organization_id": organization_id,
                "item_id": item_id,
                "warehouse_id": inventory_client.test_data["warehouse_a_id"],
                "quantity": quantity,
                "unit_cost": unit_cost,
                "currency": "USD",
            },
        )
        assert response.status_code == 201

    issue = inventory_client.post(
        "/api/inventory/issues",
        json={
            "organization_id": organization_id,
            "item_id": item_id,
            "warehouse_id": inventory_client.test_data["warehouse_a_id"],
            "quantity": "12",
        },
    )
    assert issue.status_code == 201
    assert issue.json()["cost_allocations"] == [
        {"quantity": "10.000", "unit_cost": "2.0000", "currency": "USD"},
        {"quantity": "2.000", "unit_cost": "5.0000", "currency": "USD"},
    ]
    assert issue.json()["cost_totals"] == {"USD": "30.0000000"}

    transfer = inventory_client.post(
        "/api/inventory/transfers",
        json={
            "organization_id": organization_id,
            "item_id": item_id,
            "source_warehouse_id": inventory_client.test_data["warehouse_a_id"],
            "destination_warehouse_id": inventory_client.test_data["warehouse_b_id"],
            "quantity": "3",
        },
    )
    assert transfer.status_code == 201
    assert transfer.json()["cost_allocations"] == [
        {"quantity": "3.000", "unit_cost": "5.0000", "currency": "USD"},
    ]

    balances = inventory_client.get(
        "/api/inventory/balances",
        params={"organization_id": organization_id},
    )
    assert balances.status_code == 200
    assert {
        (row["warehouse_id"], row["quantity"])
        for row in balances.json()
    } == {
        (inventory_client.test_data["warehouse_a_id"], "3.000"),
        (inventory_client.test_data["warehouse_b_id"], "3.000"),
    }
    movements = inventory_client.get(
        "/api/inventory/movements",
        params={"organization_id": organization_id},
    )
    assert movements.status_code == 200
    assert sorted(row["movement_type"] for row in movements.json()) == sorted([
        "transfer",
        "issue",
        "receipt",
        "receipt",
    ])


def test_insufficient_stock_does_not_create_partial_issue(inventory_client: TestClient) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    item = InventoryItem(
        organization_id=organization_id,
        sku="PART-1",
        name="Part",
        unit="ea",
    )
    with inventory_client.test_data["session_maker"]() as db:
        db.add(item)
        db.commit()
        item_id = item.id

    receipt = inventory_client.post(
        "/api/inventory/receipts",
        json={
            "organization_id": organization_id,
            "item_id": item_id,
            "warehouse_id": inventory_client.test_data["warehouse_a_id"],
            "quantity": "2",
            "unit_cost": "1",
            "currency": "USD",
        },
    )
    assert receipt.status_code == 201
    issue = inventory_client.post(
        "/api/inventory/issues",
        json={
            "organization_id": organization_id,
            "item_id": item_id,
            "warehouse_id": inventory_client.test_data["warehouse_a_id"],
            "quantity": "3",
        },
    )
    assert issue.status_code == 409
    assert issue.json()["error"]["code"] == "insufficient_stock"
    with inventory_client.test_data["session_maker"]() as db:
        layer = db.scalar(select(InventoryLayer).where(InventoryLayer.item_id == item_id))
        assert layer is not None
        assert layer.remaining_quantity == Decimal("2.000")
        assert db.scalar(
            select(InventoryMovement.id).where(
                InventoryMovement.item_id == item_id,
                InventoryMovement.movement_type == "issue",
            )
        ) is None
        assert db.scalar(select(InventoryAllocation.id)) is None


def test_warehouse_setup_is_organization_scoped_and_unique(inventory_client: TestClient) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    created = inventory_client.post(
        "/api/inventory/warehouses",
        json={
            "organization_id": organization_id,
            "branch_id": inventory_client.test_data["branch_id"],
            "code": "new-warehouse",
            "name": "New Warehouse",
        },
    )
    assert created.status_code == 201
    assert created.json()["code"] == "NEW-WAREHOUSE"
    assert created.json()["branch_id"] == inventory_client.test_data["branch_id"]

    duplicate = inventory_client.post(
        "/api/inventory/warehouses",
        json={
            "organization_id": organization_id,
            "code": "NEW-WAREHOUSE",
            "name": "Duplicate",
        },
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "warehouse_code_conflict"


def test_purchase_order_partial_receipts_update_fifo_inventory(inventory_client: TestClient) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    item_response = inventory_client.post(
        "/api/inventory/items",
        json={"organization_id": organization_id, "sku": "PROC-1", "name": "Purchased Part", "unit": "ea"},
    )
    assert item_response.status_code == 201
    item_id = item_response.json()["id"]

    supplier_response = inventory_client.post(
        "/api/procurement/suppliers",
        json={"organization_id": organization_id, "code": "sup-1", "name": "Supplier One"},
    )
    assert supplier_response.status_code == 201

    order_response = inventory_client.post(
        "/api/procurement/purchase-orders",
        json={
            "organization_id": organization_id,
            "supplier_id": supplier_response.json()["id"],
            "currency": "USD",
            "lines": [{"item_id": item_id, "quantity": "10", "unit_cost": "2.5000"}],
        },
    )
    assert order_response.status_code == 201
    order = order_response.json()
    assert order["status"] == "ordered"
    assert order["lines"][0]["ordered_quantity"] == "10.000"
    warehouse_id = inventory_client.test_data["warehouse_a_id"]

    partial = inventory_client.post(
        f"/api/procurement/purchase-orders/{order['id']}/receive",
        params={"organization_id": organization_id},
        json={"line_id": order["lines"][0]["id"], "warehouse_id": warehouse_id, "quantity": "4"},
    )
    assert partial.status_code == 200
    assert partial.json()["status"] == "partially_received"
    assert partial.json()["lines"][0]["received_quantity"] == "4.000"

    over_receive = inventory_client.post(
        f"/api/procurement/purchase-orders/{order['id']}/receive",
        params={"organization_id": organization_id},
        json={"line_id": order["lines"][0]["id"], "warehouse_id": warehouse_id, "quantity": "7"},
    )
    assert over_receive.status_code == 409
    assert over_receive.json()["error"]["code"] == "quantity_exceeds_outstanding"

    final_delivery = inventory_client.post(
        f"/api/procurement/purchase-orders/{order['id']}/receive",
        params={"organization_id": organization_id},
        json={"line_id": order["lines"][0]["id"], "warehouse_id": warehouse_id, "quantity": "6"},
    )
    assert final_delivery.status_code == 200
    assert final_delivery.json()["status"] == "received"
    assert final_delivery.json()["lines"][0]["received_quantity"] == "10.000"

    balances = inventory_client.get(
        "/api/inventory/balances",
        params={"organization_id": organization_id},
    )
    assert balances.status_code == 200
    assert sum(Decimal(row["quantity"]) for row in balances.json() if row["item_id"] == item_id) == Decimal("10")
    movements = inventory_client.get(
        "/api/inventory/movements",
        params={"organization_id": organization_id},
    )
    assert movements.status_code == 200
    purchase_receipts = [row for row in movements.json() if row["reference"] == order["order_number"]]
    assert len(purchase_receipts) == 2
    assert all(row["currency"] == "USD" and row["unit_cost"] == "2.5000" for row in purchase_receipts)


def test_inventory_endpoints_enforce_permissions_and_tenant_scope(inventory_client: TestClient) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    forbidden = inventory_client.get(
        "/api/inventory/items",
        params={"organization_id": "not-this-organization"},
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "permission_denied"

    other_scope = inventory_client.post(
        "/api/inventory/items",
        json={
            "organization_id": "not-this-organization",
            "sku": "ITEM-1",
            "name": "Item",
            "unit": "ea",
        },
    )
    assert other_scope.status_code == 403

    duplicate = inventory_client.post(
        "/api/inventory/items",
        json={
            "organization_id": organization_id,
            "sku": "duplicate",
            "name": "One",
            "unit": "ea",
        },
    )
    assert duplicate.status_code == 201
    duplicate_again = inventory_client.post(
        "/api/inventory/items",
        json={
            "organization_id": organization_id,
            "sku": "DUPLICATE",
            "name": "Two",
            "unit": "ea",
        },
    )
    assert duplicate_again.status_code == 409
    assert duplicate_again.json()["error"]["code"] == "sku_conflict"


def test_purchase_order_creation_requires_order_permission(inventory_client: TestClient) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    with inventory_client.test_data["session_maker"]() as db:
        permission_id = db.scalar(select(Permission.id).where(Permission.code == "procurement:order"))
        assignment = db.scalar(select(UserRoleAssignment).where(UserRoleAssignment.organization_id == organization_id))
        assert permission_id is not None
        assert assignment is not None
        role_permission = db.get(RolePermission, (assignment.role_id, permission_id))
        assert role_permission is not None
        db.delete(role_permission)
        db.commit()

    response = inventory_client.post(
        "/api/procurement/purchase-orders",
        json={
            "organization_id": organization_id,
            "supplier_id": "not-a-supplier",
            "currency": "USD",
            "lines": [{"item_id": "not-an-item", "quantity": "1", "unit_cost": "1"}],
        },
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "permission_denied"


def test_sales_fulfillment_issues_fifo_stock_and_tracks_partial_shipments(
    inventory_client: TestClient,
) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    item = inventory_client.post(
        "/api/inventory/items",
        json={"organization_id": organization_id, "sku": "SALE-1", "name": "Sale Item", "unit": "ea"},
    )
    assert item.status_code == 201
    item_id = item.json()["id"]
    warehouse_id = inventory_client.test_data["warehouse_a_id"]

    for quantity, unit_cost in (("3", "2.0000"), ("4", "3.0000")):
        receipt = inventory_client.post(
            "/api/inventory/receipts",
            json={
                "organization_id": organization_id,
                "item_id": item_id,
                "warehouse_id": warehouse_id,
                "quantity": quantity,
                "unit_cost": unit_cost,
                "currency": "USD",
            },
        )
        assert receipt.status_code == 201

    customer = inventory_client.post(
        "/api/sales/customers",
        json={"organization_id": organization_id, "code": "CUST-1", "name": "Customer One"},
    )
    assert customer.status_code == 201
    order = inventory_client.post(
        "/api/sales/orders",
        json={
            "organization_id": organization_id,
            "customer_id": customer.json()["id"],
            "currency": "USD",
            "lines": [{"item_id": item_id, "quantity": "5", "unit_price": "9.0000"}],
        },
    )
    assert order.status_code == 201
    order_data = order.json()
    assert order_data["status"] == "open"

    partial = inventory_client.post(
        f"/api/sales/orders/{order_data['id']}/fulfill",
        params={"organization_id": organization_id},
        json={"line_id": order_data["lines"][0]["id"], "warehouse_id": warehouse_id, "quantity": "4"},
    )
    assert partial.status_code == 200
    assert partial.json()["order"]["status"] == "partially_shipped"
    assert partial.json()["order"]["lines"][0]["shipped_quantity"] == "4.000"
    assert partial.json()["inventory_movement"]["cost_totals"] == {"USD": "9.0000000"}

    over_ship = inventory_client.post(
        f"/api/sales/orders/{order_data['id']}/fulfill",
        params={"organization_id": organization_id},
        json={"line_id": order_data["lines"][0]["id"], "warehouse_id": warehouse_id, "quantity": "2"},
    )
    assert over_ship.status_code == 409
    assert over_ship.json()["error"]["code"] == "quantity_exceeds_outstanding"

    final_ship = inventory_client.post(
        f"/api/sales/orders/{order_data['id']}/fulfill",
        params={"organization_id": organization_id},
        json={"line_id": order_data["lines"][0]["id"], "warehouse_id": warehouse_id, "quantity": "1"},
    )
    assert final_ship.status_code == 200
    assert final_ship.json()["order"]["status"] == "shipped"
    assert final_ship.json()["order"]["lines"][0]["shipped_quantity"] == "5.000"

    balances = inventory_client.get("/api/inventory/balances", params={"organization_id": organization_id})
    assert balances.status_code == 200
    remaining = next(row["quantity"] for row in balances.json() if row["item_id"] == item_id)
    assert remaining == "2.000"


def test_finance_posts_only_balanced_single_currency_journals_and_lists_ledger(
    inventory_client: TestClient,
) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    cash = inventory_client.post(
        "/api/finance/accounts",
        json={"organization_id": organization_id, "code": "1000", "name": "Cash", "account_type": "asset"},
    )
    revenue = inventory_client.post(
        "/api/finance/accounts",
        json={"organization_id": organization_id, "code": "4000", "name": "Sales Revenue", "account_type": "revenue"},
    )
    assert cash.status_code == revenue.status_code == 201

    entry_input = {
        "organization_id": organization_id,
        "posting_date": "2026-10-14",
        "currency": "USD",
        "description": "Opening sale",
        "reference": "INV-001",
        "lines": [
            {"account_id": cash.json()["id"], "debit": "125.5000", "credit": "0"},
            {"account_id": revenue.json()["id"], "debit": "0", "credit": "125.5000"},
        ],
    }
    unbalanced = {**entry_input, "lines": [
        {"account_id": cash.json()["id"], "debit": "125.5000", "credit": "0"},
        {"account_id": revenue.json()["id"], "debit": "0", "credit": "125.4900"},
    ]}
    rejected = inventory_client.post("/api/finance/journal-entries", json=unbalanced)
    assert rejected.status_code == 422

    posted = inventory_client.post("/api/finance/journal-entries", json=entry_input)
    assert posted.status_code == 201
    entry = posted.json()
    assert entry["currency"] == "USD"
    assert entry["entry_number"].startswith("JE-")
    assert sum(Decimal(line["debit"]) for line in entry["lines"]) == Decimal("125.5")
    assert sum(Decimal(line["credit"]) for line in entry["lines"]) == Decimal("125.5")

    listing = inventory_client.get(
        "/api/finance/journal-entries",
        params={"organization_id": organization_id},
    )
    assert listing.status_code == 200
    assert [row["id"] for row in listing.json()] == [entry["id"]]

    ledger = inventory_client.get(
        "/api/finance/ledger",
        params={"organization_id": organization_id, "account_id": cash.json()["id"]},
    )
    assert ledger.status_code == 200
    assert ledger.json()["entries"][0]["running_balance"] == "125.5000"

    with inventory_client.test_data["session_maker"]() as db:
        assert db.scalar(select(JournalEntry.id)) == entry["id"]
        assert len(db.scalars(select(JournalLine)).all()) == 2


def test_hr_employee_leave_attendance_payroll_and_reports_are_audited_and_scoped(
    inventory_client: TestClient,
) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    department_response = inventory_client.post(
        "/api/hr/departments",
        json={"organization_id": organization_id, "code": "OPS", "name": "Operations"},
    )
    assert department_response.status_code == 201
    department_id = department_response.json()["id"]

    today = date.today()
    employee_response = inventory_client.post(
        "/api/hr/employees",
        json={
            "organization_id": organization_id,
            "employee_number": "EMP-001",
            "full_name": "Aster Example",
            "job_title": "Operator",
            "employment_type": "permanent",
            "hire_date": (today - timedelta(days=120)).isoformat(),
            "department_id": department_id,
            "currency": "ETB",
            "monthly_salary": "10000.00",
            "pensionable_salary": "8000.00",
        },
    )
    assert employee_response.status_code == 201
    employee_id = employee_response.json()["id"]

    component = inventory_client.post(
        f"/api/hr/employees/{employee_id}/pay-components",
        json={
            "organization_id": organization_id,
            "employee_id": employee_id,
            "code": "ALLOWANCE",
            "name": "Transport allowance",
            "component_type": "earning",
            "amount": "1000.00",
            "is_taxable": True,
            "is_pensionable": False,
        },
    )
    assert component.status_code == 201
    deduction = inventory_client.post(
        f"/api/hr/employees/{employee_id}/pay-components",
        json={
            "organization_id": organization_id,
            "employee_id": employee_id,
            "code": "MEAL",
            "name": "Meal deduction",
            "component_type": "deduction",
            "amount": "100.00",
            "is_taxable": False,
            "is_pensionable": False,
        },
    )
    assert deduction.status_code == 201

    leave_type = inventory_client.post(
        "/api/hr/leave/types",
        json={
            "organization_id": organization_id,
            "code": "ANNUAL",
            "name": "Annual leave",
            "annual_entitlement_days": "16",
            "paid_percentage": "100",
        },
    )
    assert leave_type.status_code == 201
    leave_start = date(today.year, 6, 1)
    leave_payload = {
        "organization_id": organization_id,
        "employee_id": employee_id,
        "leave_type_id": leave_type.json()["id"],
        "start_date": leave_start.isoformat(),
        "end_date": (leave_start + timedelta(days=1)).isoformat(),
        "requested_days": "2",
        "reason": "Family leave",
    }
    leave = inventory_client.post("/api/hr/leave/requests", json=leave_payload)
    assert leave.status_code == 201
    overlap = inventory_client.post("/api/hr/leave/requests", json=leave_payload)
    assert overlap.status_code == 409
    decision = inventory_client.post(
        f"/api/hr/leave/requests/{leave.json()['id']}/decision",
        params={"organization_id": organization_id},
        json={"decision": "approved", "note": "Approved"},
    )
    assert decision.status_code == 200
    balances = inventory_client.get(
        "/api/hr/leave/balances",
        params={"organization_id": organization_id, "year": today.year},
    )
    assert balances.status_code == 200
    assert balances.json()[0]["available_days"] == "14.00"

    check_in = datetime.combine(today, time(9, 0))
    attendance = inventory_client.post(
        "/api/hr/attendance",
        json={
            "organization_id": organization_id,
            "employee_id": employee_id,
            "work_date": today.isoformat(),
            "check_in": check_in.isoformat(),
            "status": "present",
        },
    )
    assert attendance.status_code == 201
    check_out = inventory_client.patch(
        f"/api/hr/attendance/{attendance.json()['id']}/checkout",
        params={"organization_id": organization_id},
        json={"check_out": datetime.combine(today, time(17, 30)).isoformat(), "break_minutes": 30},
    )
    assert check_out.status_code == 200
    assert check_out.json()["worked_minutes"] == 480

    period = today.strftime("%Y-%m")
    blocked_run = inventory_client.post(
        "/api/hr/payroll/runs",
        json={"organization_id": organization_id, "period": period},
    )
    assert blocked_run.status_code == 409
    tax_schedule = inventory_client.post(
        "/api/hr/payroll/tax-schedules",
        json={
            "organization_id": organization_id,
            "effective_from": "2026-01-01",
            "source_reference": "Test statutory schedule, effective 2026-01-01",
            "brackets": [
                {"lower": "0", "upper": "1000", "rate": "0"},
                {"lower": "1000", "upper": None, "rate": "0.10"},
            ],
        },
    )
    assert tax_schedule.status_code == 201
    run = inventory_client.post(
        "/api/hr/payroll/runs",
        json={"organization_id": organization_id, "period": period},
    )
    assert run.status_code == 201
    payroll_line = run.json()["lines"][0]
    assert payroll_line["gross_pay"] == "11000.00"
    assert payroll_line["employee_pension"] == "560.00"
    assert payroll_line["employer_pension"] == "880.00"
    assert payroll_line["income_tax"] == "1000.00"
    assert payroll_line["other_deductions"] == "100.00"
    assert payroll_line["net_pay"] == "9340.00"

    finalized = inventory_client.post(
        f"/api/hr/payroll/runs/{run.json()['id']}/finalize",
        params={"organization_id": organization_id},
    )
    assert finalized.status_code == 200
    assert finalized.json()["status"] == "finalized"
    duplicate = inventory_client.post(
        "/api/hr/payroll/runs",
        json={"organization_id": organization_id, "period": period},
    )
    assert duplicate.status_code == 409

    reports = inventory_client.get(
        "/api/hr/reports",
        params={"organization_id": organization_id, "year": today.year, "month": today.month},
    )
    assert reports.status_code == 200
    assert reports.json()["employee_summary"]["active"] == 1
    assert reports.json()["attendance"][0]["worked_minutes"] == 480
    assert reports.json()["payroll"]["status"] == "finalized"
    with inventory_client.test_data["session_maker"]() as db:
        assert db.scalar(select(Employee.id).where(Employee.id == employee_id)) == employee_id
        assert db.scalar(select(AttendanceRecord.id).where(AttendanceRecord.id == attendance.json()["id"]))


def test_enterprise_dashboard_scales_and_social_impact_is_location_scoped(
    inventory_client: TestClient,
) -> None:
    organization_id = inventory_client.test_data["organization_id"]
    with inventory_client.test_data["session_maker"]() as db:
        db.add_all(
            Employee(
                organization_id=organization_id,
                employee_number=f"LARGE-{employee_number:05d}",
                full_name=f"Employee {employee_number}",
                job_title="Operator",
                employment_type="permanent",
                status="active",
                hire_date=date(2020, 1, 1),
                currency="ETB",
                monthly_salary=Decimal("1000.00"),
                pensionable_salary=Decimal("800.00"),
            )
            for employee_number in range(1, 5002)
        )
        db.commit()

    dashboard = inventory_client.get(
        "/api/dashboard/enterprise",
        params={"organization_id": organization_id},
    )
    assert dashboard.status_code == 200
    workforce = dashboard.json()["modules"]["workforce"]
    assert workforce["total"] == 5001
    assert workforce["active"] == 5001
    assert workforce["large_workforce"] is True

    contribution = inventory_client.post(
        "/api/social-impact/records",
        json={
            "organization_id": organization_id,
            "branch_id": inventory_client.test_data["branch_id"],
            "title": "Local technical training",
            "contribution_type": "education",
            "occurred_on": date.today().isoformat(),
            "beneficiary_count": 45,
            "volunteer_hours": "12.50",
            "amount": "25000.00",
            "currency": "ETB",
            "partner": "Community Technical College",
        },
    )
    assert contribution.status_code == 201
    assert contribution.json()["beneficiary_count"] == 45

    summary = inventory_client.get(
        "/api/social-impact/summary",
        params={
            "organization_id": organization_id,
            "branch_id": inventory_client.test_data["branch_id"],
        },
    )
    assert summary.status_code == 200
    assert summary.json()["record_count"] == 1
    assert summary.json()["beneficiary_count"] == 45
    assert summary.json()["volunteer_hours"] == "12.50"
    assert summary.json()["contribution_by_currency"] == [{"currency": "ETB", "amount": "25000.00"}]

    branch_dashboard = inventory_client.get(
        "/api/dashboard/enterprise",
        params={
            "organization_id": organization_id,
            "branch_id": inventory_client.test_data["branch_id"],
        },
    )
    assert branch_dashboard.status_code == 200
    assert "workforce" not in branch_dashboard.json()["modules"]
    assert branch_dashboard.json()["modules"]["social_impact"]["beneficiary_count"] == 45
