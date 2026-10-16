from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes.inventory import (
    _authorize_inventory,
    _consume_fifo,
    _get_item,
    _get_warehouse,
    _movement_payload,
)
from app.audit import record_audit
from app.auth import AuthContext, has_permission, require_permission
from app.database import get_db
from app.models import (
    Customer,
    InventoryAllocation,
    InventoryItem,
    InventoryMovement,
    SalesOrder,
    SalesOrderLine,
)

router = APIRouter(prefix="/sales", tags=["sales"])

Quantity = Annotated[Decimal, Field(gt=0, max_digits=18, decimal_places=3)]
UnitPrice = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]


class CustomerInput(BaseModel):
    organization_id: str
    code: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    name: str = Field(min_length=1, max_length=255)
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=50)

    @field_validator("code", "name", "email", "phone", mode="before")
    @classmethod
    def trim_text(cls, value: object) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("This field must be text.")
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank.")
        return value


class SalesOrderLineInput(BaseModel):
    item_id: str
    quantity: Quantity
    unit_price: UnitPrice


class SalesOrderInput(BaseModel):
    organization_id: str
    customer_id: str
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    lines: list[SalesOrderLineInput] = Field(min_length=1, max_length=100)


class FulfillLineInput(BaseModel):
    line_id: str
    warehouse_id: str
    quantity: Quantity


def _authorize_sales(auth: AuthContext, organization_id: str, permission: str) -> None:
    if not has_permission(auth, organization_id, permission):
        raise HTTPException(
            status_code=403,
            detail={"code": "permission_denied", "message": "You do not have permission to use Sales in this organization."},
        )
    if not any(grant.organization_id == organization_id for grant in auth.grants):
        raise HTTPException(
            status_code=403,
            detail={"code": "scope_denied", "message": "You do not have access to this organization."},
        )


def _customer_payload(customer: Customer) -> dict:
    return {
        "id": customer.id,
        "organization_id": customer.organization_id,
        "code": customer.code,
        "name": customer.name,
        "email": customer.email,
        "phone": customer.phone,
        "is_active": customer.is_active,
    }


def _order_payload(db: Session, order: SalesOrder) -> dict:
    customer = db.scalar(
        select(Customer).where(
            Customer.id == order.customer_id,
            Customer.organization_id == order.organization_id,
        )
    )
    rows = db.execute(
        select(SalesOrderLine, InventoryItem)
        .join(InventoryItem, InventoryItem.id == SalesOrderLine.item_id)
        .where(
            SalesOrderLine.sales_order_id == order.id,
            SalesOrderLine.organization_id == order.organization_id,
        )
        .order_by(SalesOrderLine.id)
    ).all()
    return {
        "id": order.id,
        "organization_id": order.organization_id,
        "order_number": order.order_number,
        "customer_id": order.customer_id,
        "customer_code": customer.code if customer else "",
        "customer_name": customer.name if customer else "",
        "status": order.status,
        "currency": order.currency,
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "lines": [
            {
                "id": line.id,
                "item_id": line.item_id,
                "sku": item.sku,
                "item_name": item.name,
                "unit": item.unit,
                "ordered_quantity": f"{line.ordered_quantity:.3f}",
                "shipped_quantity": f"{line.shipped_quantity:.3f}",
                "unit_price": f"{line.unit_price:.4f}",
            }
            for line, item in rows
        ],
    }


@router.get("/customers")
def list_customers(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("sales:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize_sales(auth, organization_id, "sales:read")
    return [
        _customer_payload(customer)
        for customer in db.scalars(
            select(Customer)
            .where(Customer.organization_id == organization_id, Customer.is_active.is_(True))
            .order_by(Customer.code)
        ).all()
    ]


@router.post("/customers", status_code=201)
def create_customer(
    body: CustomerInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("sales:customer_manage")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize_sales(auth, body.organization_id, "sales:customer_manage")
    code = body.code.upper()
    if db.scalar(
        select(Customer.id).where(
            Customer.organization_id == body.organization_id,
            Customer.code == code,
        )
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "customer_code_conflict", "message": "A customer with this code already exists in this organization."},
        )
    customer = Customer(
        organization_id=body.organization_id,
        code=code,
        name=body.name,
        email=body.email,
        phone=body.phone,
    )
    db.add(customer)
    db.flush()
    record_audit(
        db,
        event_type="sales.customer_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="customer",
        resource_id=customer.id,
        metadata={"code": customer.code},
    )
    db.commit()
    return _customer_payload(customer)


@router.get("/orders")
def list_sales_orders(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("sales:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize_sales(auth, organization_id, "sales:read")
    orders = db.scalars(
        select(SalesOrder)
        .where(SalesOrder.organization_id == organization_id)
        .order_by(SalesOrder.created_at.desc(), SalesOrder.id.desc())
    ).all()
    return [_order_payload(db, order) for order in orders]


@router.post("/orders", status_code=201)
def create_sales_order(
    body: SalesOrderInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("sales:order")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize_sales(auth, body.organization_id, "sales:order")
    _authorize_inventory(auth, body.organization_id, "inventory:read")
    customer = db.scalar(
        select(Customer).where(
            Customer.id == body.customer_id,
            Customer.organization_id == body.organization_id,
            Customer.is_active.is_(True),
        )
    )
    if customer is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "customer_not_found", "message": "The active customer was not found in this organization."},
        )
    item_ids = [line.item_id for line in body.lines]
    if len(set(item_ids)) != len(item_ids):
        raise HTTPException(
            status_code=422,
            detail={"code": "duplicate_order_item", "message": "Each item may appear only once on a sales order."},
        )
    items = db.scalars(
        select(InventoryItem).where(
            InventoryItem.organization_id == body.organization_id,
            InventoryItem.id.in_(item_ids),
            InventoryItem.is_active.is_(True),
        )
    ).all()
    if len(items) != len(item_ids):
        raise HTTPException(
            status_code=404,
            detail={"code": "inventory_item_not_found", "message": "One or more active inventory items were not found in this organization."},
        )
    now = datetime.now(timezone.utc)
    order = SalesOrder(
        organization_id=body.organization_id,
        customer_id=customer.id,
        order_number=f"SO-{now:%Y%m%d}-{uuid4().hex[:8].upper()}",
        status="open",
        currency=body.currency,
        created_by=auth.user.id,
    )
    db.add(order)
    db.flush()
    db.add_all(
        SalesOrderLine(
            organization_id=body.organization_id,
            sales_order_id=order.id,
            item_id=line.item_id,
            ordered_quantity=line.quantity,
            unit_price=line.unit_price,
        )
        for line in body.lines
    )
    record_audit(
        db,
        event_type="sales.order_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="sales_order",
        resource_id=order.id,
        metadata={"order_number": order.order_number, "customer_id": customer.id, "line_count": len(body.lines)},
    )
    db.commit()
    return _order_payload(db, order)


@router.post("/orders/{order_id}/fulfill")
def fulfill_sales_order_line(
    order_id: str,
    body: FulfillLineInput,
    request: Request,
    organization_id: str,
    auth: AuthContext = Depends(require_permission("sales:fulfill")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize_sales(auth, organization_id, "sales:fulfill")
    _authorize_inventory(auth, organization_id, "inventory:transact")
    order = db.scalar(
        select(SalesOrder)
        .where(SalesOrder.id == order_id, SalesOrder.organization_id == organization_id)
        .with_for_update()
    )
    if order is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "sales_order_not_found", "message": "The sales order was not found in this organization."},
        )
    line = db.scalar(
        select(SalesOrderLine)
        .where(
            SalesOrderLine.id == body.line_id,
            SalesOrderLine.sales_order_id == order.id,
            SalesOrderLine.organization_id == organization_id,
        )
        .with_for_update()
    )
    if line is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "sales_order_line_not_found", "message": "The sales order line was not found."},
        )
    outstanding = line.ordered_quantity - line.shipped_quantity
    if body.quantity > outstanding:
        raise HTTPException(
            status_code=409,
            detail={"code": "quantity_exceeds_outstanding", "message": f"Cannot ship more than the outstanding quantity ({outstanding})."},
        )
    item = _get_item(db, organization_id, line.item_id)
    warehouse = _get_warehouse(db, auth, organization_id, body.warehouse_id)
    consumed = _consume_fifo(
        db,
        organization_id=organization_id,
        item_id=item.id,
        warehouse_id=warehouse.id,
        quantity=body.quantity,
    )
    movement = InventoryMovement(
        organization_id=organization_id,
        item_id=item.id,
        movement_type="issue",
        quantity=body.quantity,
        source_warehouse_id=warehouse.id,
        reference=order.order_number,
        note=f"Sales shipment to {order.customer_id}",
        actor_id=auth.user.id,
    )
    db.add(movement)
    db.flush()
    allocations = []
    for layer, quantity in consumed:
        allocation = InventoryAllocation(
            movement_id=movement.id,
            organization_id=organization_id,
            item_id=item.id,
            layer_id=layer.id,
            quantity=quantity,
            unit_cost=layer.unit_cost,
            currency=layer.currency,
        )
        db.add(allocation)
        allocations.append(allocation)
    line.shipped_quantity += body.quantity
    lines = db.scalars(
        select(SalesOrderLine).where(
            SalesOrderLine.sales_order_id == order.id,
            SalesOrderLine.organization_id == organization_id,
        )
    ).all()
    order.status = (
        "shipped"
        if all(row.shipped_quantity == row.ordered_quantity for row in lines)
        else "partially_shipped"
    )
    record_audit(
        db,
        event_type="sales.order_fulfilled",
        request=request,
        actor_id=auth.user.id,
        organization_id=organization_id,
        resource_type="sales_order",
        resource_id=order.id,
        metadata={
            "order_number": order.order_number,
            "line_id": line.id,
            "quantity": str(body.quantity),
            "warehouse_id": warehouse.id,
            "inventory_movement_id": movement.id,
        },
    )
    db.commit()
    return {
        "order": _order_payload(db, order),
        "inventory_movement": _movement_payload(movement, item, allocations),
    }
