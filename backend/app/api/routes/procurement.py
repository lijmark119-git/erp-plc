from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import AuthContext, has_permission, require_permission
from app.database import get_db
from app.models import (
    InventoryItem,
    InventoryLayer,
    InventoryMovement,
    PurchaseOrder,
    PurchaseOrderLine,
    Supplier,
    Warehouse,
)
from app.api.routes.inventory import _authorize_inventory, _get_item, _get_warehouse

router = APIRouter(prefix="/procurement", tags=["procurement"])

Quantity = Annotated[Decimal, Field(gt=0, max_digits=18, decimal_places=3)]
UnitCost = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]


class SupplierInput(BaseModel):
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


class PurchaseOrderLineInput(BaseModel):
    item_id: str
    quantity: Quantity
    unit_cost: UnitCost


class PurchaseOrderInput(BaseModel):
    organization_id: str
    supplier_id: str
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    lines: list[PurchaseOrderLineInput] = Field(min_length=1, max_length=100)


class ReceiveLineInput(BaseModel):
    line_id: str
    warehouse_id: str
    quantity: Quantity


def _authorize(
    auth: AuthContext,
    organization_id: str,
    permission: str,
) -> None:
    if not has_permission(auth, organization_id, permission):
        raise HTTPException(
            status_code=403,
            detail={"code": "permission_denied", "message": "You do not have permission to use procurement in this organization."},
        )
    if not any(grant.organization_id == organization_id for grant in auth.grants):
        raise HTTPException(
            status_code=403,
            detail={"code": "scope_denied", "message": "You do not have access to this organization."},
        )


def _supplier_payload(supplier: Supplier) -> dict:
    return {
        "id": supplier.id,
        "organization_id": supplier.organization_id,
        "code": supplier.code,
        "name": supplier.name,
        "email": supplier.email,
        "phone": supplier.phone,
        "is_active": supplier.is_active,
    }


def _order_payload(db: Session, order: PurchaseOrder) -> dict:
    supplier = db.scalar(
        select(Supplier).where(
            Supplier.id == order.supplier_id,
            Supplier.organization_id == order.organization_id,
        )
    )
    rows = db.execute(
        select(PurchaseOrderLine, InventoryItem)
        .join(InventoryItem, InventoryItem.id == PurchaseOrderLine.item_id)
        .where(
            PurchaseOrderLine.purchase_order_id == order.id,
            PurchaseOrderLine.organization_id == order.organization_id,
        )
        .order_by(PurchaseOrderLine.id)
    ).all()
    return {
        "id": order.id,
        "organization_id": order.organization_id,
        "order_number": order.order_number,
        "supplier_id": order.supplier_id,
        "supplier_code": supplier.code if supplier else "",
        "supplier_name": supplier.name if supplier else "",
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
                "received_quantity": f"{line.received_quantity:.3f}",
                "unit_cost": f"{line.unit_cost:.4f}",
            }
            for line, item in rows
        ],
    }


@router.get("/suppliers")
def list_suppliers(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("procurement:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize(auth, organization_id, "procurement:read")
    return [
        _supplier_payload(supplier)
        for supplier in db.scalars(
            select(Supplier)
            .where(Supplier.organization_id == organization_id, Supplier.is_active.is_(True))
            .order_by(Supplier.code)
        ).all()
    ]


@router.post("/suppliers", status_code=201)
def create_supplier(
    body: SupplierInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("procurement:manage")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize(auth, body.organization_id, "procurement:manage")
    code = body.code.upper()
    if db.scalar(
        select(Supplier.id).where(
            Supplier.organization_id == body.organization_id,
            Supplier.code == code,
        )
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "supplier_code_conflict", "message": "A supplier with this code already exists in this organization."},
        )
    supplier = Supplier(
        organization_id=body.organization_id,
        code=code,
        name=body.name,
        email=body.email,
        phone=body.phone,
    )
    db.add(supplier)
    db.flush()
    record_audit(
        db,
        event_type="procurement.supplier_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="supplier",
        resource_id=supplier.id,
        metadata={"code": supplier.code},
    )
    db.commit()
    return _supplier_payload(supplier)


@router.get("/purchase-orders")
def list_purchase_orders(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("procurement:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize(auth, organization_id, "procurement:read")
    orders = db.scalars(
        select(PurchaseOrder)
        .where(PurchaseOrder.organization_id == organization_id)
        .order_by(PurchaseOrder.created_at.desc(), PurchaseOrder.id.desc())
    ).all()
    return [_order_payload(db, order) for order in orders]


@router.post("/purchase-orders", status_code=201)
def create_purchase_order(
    body: PurchaseOrderInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("procurement:order")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize(auth, body.organization_id, "procurement:order")
    supplier = db.scalar(
        select(Supplier).where(
            Supplier.id == body.supplier_id,
            Supplier.organization_id == body.organization_id,
            Supplier.is_active.is_(True),
        )
    )
    if supplier is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "supplier_not_found", "message": "The active supplier was not found in this organization."},
        )
    item_ids = [line.item_id for line in body.lines]
    if len(set(item_ids)) != len(item_ids):
        raise HTTPException(
            status_code=422,
            detail={"code": "duplicate_order_item", "message": "Each item may appear only once on a purchase order."},
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
    order = PurchaseOrder(
        organization_id=body.organization_id,
        supplier_id=supplier.id,
        order_number=f"PO-{now:%Y%m%d}-{uuid4().hex[:8].upper()}",
        status="ordered",
        currency=body.currency,
        created_by=auth.user.id,
    )
    db.add(order)
    db.flush()
    db.add_all(
        PurchaseOrderLine(
            organization_id=body.organization_id,
            purchase_order_id=order.id,
            item_id=line.item_id,
            ordered_quantity=line.quantity,
            unit_cost=line.unit_cost,
        )
        for line in body.lines
    )
    record_audit(
        db,
        event_type="procurement.purchase_order_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="purchase_order",
        resource_id=order.id,
        metadata={"order_number": order.order_number, "supplier_id": supplier.id, "line_count": len(body.lines)},
    )
    db.commit()
    return _order_payload(db, order)


@router.post("/purchase-orders/{order_id}/receive")
def receive_purchase_order_line(
    order_id: str,
    body: ReceiveLineInput,
    request: Request,
    organization_id: str,
    auth: AuthContext = Depends(require_permission("procurement:receive")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize(auth, organization_id, "procurement:receive")
    _authorize_inventory(auth, organization_id, "inventory:transact")
    order = db.scalar(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == order_id, PurchaseOrder.organization_id == organization_id)
        .with_for_update()
    )
    if order is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "purchase_order_not_found", "message": "The purchase order was not found in this organization."},
        )
    line = db.scalar(
        select(PurchaseOrderLine)
        .where(
            PurchaseOrderLine.id == body.line_id,
            PurchaseOrderLine.purchase_order_id == order.id,
            PurchaseOrderLine.organization_id == organization_id,
        )
        .with_for_update()
    )
    if line is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "purchase_order_line_not_found", "message": "The purchase order line was not found."},
        )
    outstanding = line.ordered_quantity - line.received_quantity
    if body.quantity > outstanding:
        raise HTTPException(
            status_code=409,
            detail={"code": "quantity_exceeds_outstanding", "message": f"Cannot receive more than the outstanding quantity ({outstanding})."},
        )
    item = _get_item(db, organization_id, line.item_id)
    warehouse = _get_warehouse(db, auth, organization_id, body.warehouse_id)
    movement = InventoryMovement(
        organization_id=organization_id,
        item_id=item.id,
        movement_type="receipt",
        quantity=body.quantity,
        destination_warehouse_id=warehouse.id,
        currency=order.currency,
        unit_cost=line.unit_cost,
        reference=order.order_number,
        note=f"Supplier: {order.supplier_id}",
        actor_id=auth.user.id,
    )
    db.add(movement)
    db.flush()
    db.add(
        InventoryLayer(
            organization_id=organization_id,
            item_id=item.id,
            warehouse_id=warehouse.id,
            movement_id=movement.id,
            original_quantity=body.quantity,
            remaining_quantity=body.quantity,
            unit_cost=line.unit_cost,
            currency=order.currency,
        )
    )
    line.received_quantity += body.quantity
    lines = db.scalars(
        select(PurchaseOrderLine).where(
            PurchaseOrderLine.purchase_order_id == order.id,
            PurchaseOrderLine.organization_id == organization_id,
        )
    ).all()
    order.status = (
        "received"
        if all(row.received_quantity == row.ordered_quantity for row in lines)
        else "partially_received"
    )
    record_audit(
        db,
        event_type="procurement.purchase_order_received",
        request=request,
        actor_id=auth.user.id,
        organization_id=organization_id,
        resource_type="purchase_order",
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
    return _order_payload(db, order)
