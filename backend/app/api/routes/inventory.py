from collections import defaultdict
from decimal import Decimal, localcontext
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import AuthContext, has_permission, require_permission
from app.database import get_db
from app.models import (
    Branch,
    InventoryAllocation,
    InventoryItem,
    InventoryLayer,
    InventoryMovement,
    Warehouse,
)

router = APIRouter(prefix="/inventory", tags=["inventory"])

Quantity = Annotated[Decimal, Field(gt=0, max_digits=18, decimal_places=3)]
UnitCost = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]


class ItemInput(BaseModel):
    organization_id: str
    sku: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
    name: str = Field(min_length=1, max_length=255)
    unit: str = Field(min_length=1, max_length=24)

    @field_validator("sku", "name", "unit", mode="before")
    @classmethod
    def trim_required_text(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("This field must be text.")
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank.")
        return value


class WarehouseInput(BaseModel):
    organization_id: str
    branch_id: str | None = None
    code: str = Field(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    name: str = Field(min_length=1, max_length=255)

    @field_validator("code", "name", mode="before")
    @classmethod
    def trim_required_text(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("This field must be text.")
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank.")
        return value


class ReceiptInput(BaseModel):
    organization_id: str
    item_id: str
    warehouse_id: str
    quantity: Quantity
    unit_cost: UnitCost
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    reference: str | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=500)


class IssueInput(BaseModel):
    organization_id: str
    item_id: str
    warehouse_id: str
    quantity: Quantity
    reference: str | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=500)


class TransferInput(BaseModel):
    organization_id: str
    item_id: str
    source_warehouse_id: str
    destination_warehouse_id: str
    quantity: Quantity
    reference: str | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=500)


def _authorize_inventory(
    auth: AuthContext,
    organization_id: str,
    permission: str,
    *,
    organization_wide: bool = False,
) -> None:
    if not has_permission(auth, organization_id, permission):
        raise HTTPException(
            status_code=403,
            detail={"code": "permission_denied", "message": "You do not have permission to use inventory in this organization."},
        )
    grants = [grant for grant in auth.grants if grant.organization_id == organization_id]
    if organization_wide:
        if not any(
            grant.branch_id is None and grant.warehouse_id is None and grant.factory_id is None
            for grant in grants
        ):
            raise HTTPException(
                status_code=403,
                detail={"code": "scope_denied", "message": "Organization-wide inventory setup requires organization access."},
            )
    elif not grants:
        raise HTTPException(
            status_code=403,
            detail={"code": "scope_denied", "message": "You do not have access to this organization."},
        )


def _get_item(db: Session, organization_id: str, item_id: str) -> InventoryItem:
    item = db.scalar(
        select(InventoryItem).where(
            InventoryItem.id == item_id,
            InventoryItem.organization_id == organization_id,
            InventoryItem.is_active.is_(True),
        )
    )
    if item is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "inventory_item_not_found", "message": "The active inventory item was not found in this organization."},
        )
    return item


def _get_warehouse(
    db: Session,
    auth: AuthContext,
    organization_id: str,
    warehouse_id: str,
) -> Warehouse:
    warehouse = db.scalar(
        select(Warehouse).where(
            Warehouse.id == warehouse_id,
            Warehouse.organization_id == organization_id,
            Warehouse.is_active.is_(True),
        )
    )
    if warehouse is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "warehouse_not_found", "message": "The active warehouse was not found in this organization."},
        )

    grants = [grant for grant in auth.grants if grant.organization_id == organization_id]
    if any(
        grant.branch_id is None and grant.warehouse_id is None and grant.factory_id is None
        for grant in grants
    ):
        return warehouse
    if any(
        grant.warehouse_id == warehouse.id
        or (warehouse.branch_id is not None and grant.branch_id == warehouse.branch_id)
        for grant in grants
    ):
        return warehouse
    raise HTTPException(
        status_code=403,
        detail={"code": "scope_denied", "message": "You do not have access to this warehouse."},
    )


def _accessible_warehouse_ids(
    db: Session,
    auth: AuthContext,
    organization_id: str,
) -> list[str]:
    grants = [grant for grant in auth.grants if grant.organization_id == organization_id]
    if any(
        grant.branch_id is None and grant.warehouse_id is None and grant.factory_id is None
        for grant in grants
    ):
        return list(
            db.scalars(
                select(Warehouse.id).where(
                    Warehouse.organization_id == organization_id,
                    Warehouse.is_active.is_(True),
                )
            ).all()
        )

    warehouse_ids = {grant.warehouse_id for grant in grants if grant.warehouse_id is not None}
    branch_ids = {grant.branch_id for grant in grants if grant.branch_id is not None}
    conditions = []
    if warehouse_ids:
        conditions.append(Warehouse.id.in_(warehouse_ids))
    if branch_ids:
        conditions.append(Warehouse.branch_id.in_(branch_ids))
    if not conditions:
        return []
    return list(
        db.scalars(
            select(Warehouse.id).where(
                Warehouse.organization_id == organization_id,
                Warehouse.is_active.is_(True),
                or_(*conditions),
            )
        ).all()
    )


def _movement_payload(
    movement: InventoryMovement,
    item: InventoryItem,
    allocations: list[InventoryAllocation],
) -> dict:
    costs: defaultdict[str, Decimal] = defaultdict(Decimal)
    serialized_allocations = []
    with localcontext() as context:
        context.prec = 50
        for allocation in allocations:
            costs[allocation.currency] += allocation.quantity * allocation.unit_cost
            serialized_allocations.append(
                {
                    "quantity": _decimal_text(allocation.quantity, 3),
                    "unit_cost": _decimal_text(allocation.unit_cost, 4),
                    "currency": allocation.currency,
                }
            )
    return {
        "id": movement.id,
        "organization_id": movement.organization_id,
        "item_id": movement.item_id,
        "sku": item.sku,
        "item_name": item.name,
        "movement_type": movement.movement_type,
        "quantity": _decimal_text(movement.quantity, 3),
        "source_warehouse_id": movement.source_warehouse_id,
        "destination_warehouse_id": movement.destination_warehouse_id,
        "currency": movement.currency,
        "unit_cost": _decimal_text(movement.unit_cost, 4) if movement.unit_cost is not None else None,
        "reference": movement.reference,
        "note": movement.note,
        "created_at": movement.created_at.isoformat() if movement.created_at else None,
        "cost_allocations": serialized_allocations,
        "cost_totals": {currency: _decimal_text(amount, 7) for currency, amount in costs.items()},
    }


def _decimal_text(value: Decimal, places: int) -> str:
    with localcontext() as context:
        context.prec = 50
        return format(value.quantize(Decimal(1).scaleb(-places)), "f")


def _consume_fifo(
    db: Session,
    *,
    organization_id: str,
    item_id: str,
    warehouse_id: str,
    quantity: Decimal,
) -> list[tuple[InventoryLayer, Decimal]]:
    layers = list(
        db.scalars(
            select(InventoryLayer)
            .where(
                InventoryLayer.organization_id == organization_id,
                InventoryLayer.item_id == item_id,
                InventoryLayer.warehouse_id == warehouse_id,
                InventoryLayer.remaining_quantity > 0,
            )
            .order_by(InventoryLayer.created_at, InventoryLayer.id)
            .with_for_update()
        ).all()
    )
    with localcontext() as context:
        context.prec = 50
        available = sum((layer.remaining_quantity for layer in layers), Decimal("0"))
    if available < quantity:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "insufficient_stock",
                "message": f"Insufficient stock. Available quantity is {available}.",
            },
        )

    outstanding = quantity
    consumed: list[tuple[InventoryLayer, Decimal]] = []
    for layer in layers:
        taken = min(layer.remaining_quantity, outstanding)
        if taken:
            layer.remaining_quantity -= taken
            consumed.append((layer, taken))
            outstanding -= taken
        if outstanding == 0:
            break
    return consumed


@router.get("/items")
def list_items(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("inventory:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize_inventory(auth, organization_id, "inventory:read")
    return [
        {
            "id": item.id,
            "organization_id": item.organization_id,
            "sku": item.sku,
            "name": item.name,
            "unit": item.unit,
            "is_active": item.is_active,
        }
        for item in db.scalars(
            select(InventoryItem)
            .where(InventoryItem.organization_id == organization_id)
            .order_by(InventoryItem.sku)
        ).all()
    ]


@router.post("/items", status_code=201)
def create_item(
    body: ItemInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("inventory:manage")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize_inventory(auth, body.organization_id, "inventory:manage", organization_wide=True)
    sku = body.sku.strip().upper()
    if db.scalar(
        select(InventoryItem.id).where(
            InventoryItem.organization_id == body.organization_id,
            InventoryItem.sku == sku,
        )
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "sku_conflict", "message": "An item with this SKU already exists in this organization."},
        )
    item = InventoryItem(
        organization_id=body.organization_id,
        sku=sku,
        name=body.name.strip(),
        unit=body.unit.strip(),
    )
    db.add(item)
    db.flush()
    record_audit(
        db,
        event_type="inventory.item_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="inventory_item",
        resource_id=item.id,
        metadata={"sku": item.sku},
    )
    db.commit()
    return {
        "id": item.id,
        "organization_id": item.organization_id,
        "sku": item.sku,
        "name": item.name,
        "unit": item.unit,
        "is_active": item.is_active,
    }


@router.get("/warehouses")
def list_warehouses(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("inventory:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize_inventory(auth, organization_id, "inventory:read")
    warehouse_ids = _accessible_warehouse_ids(db, auth, organization_id)
    if not warehouse_ids:
        return []
    warehouses = db.scalars(
        select(Warehouse)
        .where(Warehouse.id.in_(warehouse_ids))
        .order_by(Warehouse.code)
    ).all()
    return [
        {
            "id": warehouse.id,
            "organization_id": warehouse.organization_id,
            "branch_id": warehouse.branch_id,
            "code": warehouse.code,
            "name": warehouse.name,
            "is_active": warehouse.is_active,
        }
        for warehouse in warehouses
    ]


@router.post("/warehouses", status_code=201)
def create_warehouse(
    body: WarehouseInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("inventory:manage")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize_inventory(auth, body.organization_id, "inventory:manage", organization_wide=True)
    code = body.code.strip().upper()
    if db.scalar(
        select(Warehouse.id).where(
            Warehouse.organization_id == body.organization_id,
            Warehouse.code == code,
        )
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "warehouse_code_conflict", "message": "A warehouse with this code already exists in this organization."},
        )
    if body.branch_id is not None and db.scalar(
        select(Branch.id).where(
            Branch.id == body.branch_id,
            Branch.organization_id == body.organization_id,
            Branch.is_active.is_(True),
        )
    ) is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "branch_not_found", "message": "The active branch was not found in this organization."},
        )
    warehouse = Warehouse(
        organization_id=body.organization_id,
        branch_id=body.branch_id,
        code=code,
        name=body.name.strip(),
    )
    db.add(warehouse)
    db.flush()
    record_audit(
        db,
        event_type="inventory.warehouse_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="warehouse",
        resource_id=warehouse.id,
        metadata={"code": warehouse.code, "branch_id": warehouse.branch_id},
    )
    db.commit()
    return {
        "id": warehouse.id,
        "organization_id": warehouse.organization_id,
        "branch_id": warehouse.branch_id,
        "code": warehouse.code,
        "name": warehouse.name,
        "is_active": warehouse.is_active,
    }


@router.get("/balances")
def list_balances(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("inventory:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize_inventory(auth, organization_id, "inventory:read")
    warehouse_ids = _accessible_warehouse_ids(db, auth, organization_id)
    if not warehouse_ids:
        return []
    rows = db.execute(
        select(
            InventoryLayer.item_id,
            InventoryLayer.warehouse_id,
            func.sum(InventoryLayer.remaining_quantity),
        )
        .where(
            InventoryLayer.organization_id == organization_id,
            InventoryLayer.warehouse_id.in_(warehouse_ids),
            InventoryLayer.remaining_quantity > 0,
        )
        .group_by(InventoryLayer.item_id, InventoryLayer.warehouse_id)
        .order_by(InventoryLayer.warehouse_id, InventoryLayer.item_id)
    ).all()
    output = []
    for item_id, warehouse_id, quantity in rows:
        item = db.get(InventoryItem, item_id)
        warehouse = db.get(Warehouse, warehouse_id)
        if item is not None and warehouse is not None:
            output.append(
                {
                    "item_id": item.id,
                    "sku": item.sku,
                    "item_name": item.name,
                    "unit": item.unit,
                    "warehouse_id": warehouse.id,
                    "warehouse_code": warehouse.code,
                    "warehouse_name": warehouse.name,
                    "quantity": str(quantity),
                }
            )
    return output


@router.post("/receipts", status_code=201)
def receive_stock(
    body: ReceiptInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("inventory:transact")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize_inventory(auth, body.organization_id, "inventory:transact")
    item = _get_item(db, body.organization_id, body.item_id)
    _get_warehouse(db, auth, body.organization_id, body.warehouse_id)
    movement = InventoryMovement(
        organization_id=body.organization_id,
        item_id=body.item_id,
        movement_type="receipt",
        quantity=body.quantity,
        destination_warehouse_id=body.warehouse_id,
        currency=body.currency,
        unit_cost=body.unit_cost,
        reference=body.reference.strip() if body.reference else None,
        note=body.note.strip() if body.note else None,
        actor_id=auth.user.id,
    )
    db.add(movement)
    db.flush()
    db.add(
        InventoryLayer(
            organization_id=body.organization_id,
            item_id=body.item_id,
            warehouse_id=body.warehouse_id,
            movement_id=movement.id,
            original_quantity=body.quantity,
            remaining_quantity=body.quantity,
            unit_cost=body.unit_cost,
            currency=body.currency,
        )
    )
    record_audit(
        db,
        event_type="inventory.stock_received",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="inventory_movement",
        resource_id=movement.id,
        metadata={"item_id": body.item_id, "quantity": str(body.quantity), "warehouse_id": body.warehouse_id},
    )
    db.commit()
    return _movement_payload(movement, item, [])


@router.post("/issues", status_code=201)
def issue_stock(
    body: IssueInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("inventory:transact")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize_inventory(auth, body.organization_id, "inventory:transact")
    item = _get_item(db, body.organization_id, body.item_id)
    _get_warehouse(db, auth, body.organization_id, body.warehouse_id)
    consumed = _consume_fifo(
        db,
        organization_id=body.organization_id,
        item_id=body.item_id,
        warehouse_id=body.warehouse_id,
        quantity=body.quantity,
    )
    movement = InventoryMovement(
        organization_id=body.organization_id,
        item_id=body.item_id,
        movement_type="issue",
        quantity=body.quantity,
        source_warehouse_id=body.warehouse_id,
        reference=body.reference.strip() if body.reference else None,
        note=body.note.strip() if body.note else None,
        actor_id=auth.user.id,
    )
    db.add(movement)
    db.flush()
    allocations = []
    for layer, quantity in consumed:
        allocation = InventoryAllocation(
            movement_id=movement.id,
            organization_id=body.organization_id,
            item_id=body.item_id,
            layer_id=layer.id,
            quantity=quantity,
            unit_cost=layer.unit_cost,
            currency=layer.currency,
        )
        db.add(allocation)
        allocations.append(allocation)
    record_audit(
        db,
        event_type="inventory.stock_issued",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="inventory_movement",
        resource_id=movement.id,
        metadata={"item_id": body.item_id, "quantity": str(body.quantity), "warehouse_id": body.warehouse_id},
    )
    db.commit()
    return _movement_payload(movement, item, allocations)


@router.post("/transfers", status_code=201)
def transfer_stock(
    body: TransferInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("inventory:transact")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize_inventory(auth, body.organization_id, "inventory:transact")
    item = _get_item(db, body.organization_id, body.item_id)
    if body.source_warehouse_id == body.destination_warehouse_id:
        raise HTTPException(
            status_code=422,
            detail={"code": "same_warehouse_transfer", "message": "Source and destination warehouses must be different."},
        )
    _get_warehouse(db, auth, body.organization_id, body.source_warehouse_id)
    _get_warehouse(db, auth, body.organization_id, body.destination_warehouse_id)
    consumed = _consume_fifo(
        db,
        organization_id=body.organization_id,
        item_id=body.item_id,
        warehouse_id=body.source_warehouse_id,
        quantity=body.quantity,
    )
    movement = InventoryMovement(
        organization_id=body.organization_id,
        item_id=body.item_id,
        movement_type="transfer",
        quantity=body.quantity,
        source_warehouse_id=body.source_warehouse_id,
        destination_warehouse_id=body.destination_warehouse_id,
        reference=body.reference.strip() if body.reference else None,
        note=body.note.strip() if body.note else None,
        actor_id=auth.user.id,
    )
    db.add(movement)
    db.flush()
    allocations = []
    for layer, quantity in consumed:
        db.add(
            InventoryLayer(
                organization_id=body.organization_id,
                item_id=body.item_id,
                warehouse_id=body.destination_warehouse_id,
                movement_id=movement.id,
                original_quantity=quantity,
                remaining_quantity=quantity,
                unit_cost=layer.unit_cost,
                currency=layer.currency,
            )
        )
        allocation = InventoryAllocation(
            movement_id=movement.id,
            organization_id=body.organization_id,
            item_id=body.item_id,
            layer_id=layer.id,
            quantity=quantity,
            unit_cost=layer.unit_cost,
            currency=layer.currency,
        )
        db.add(allocation)
        allocations.append(allocation)
    record_audit(
        db,
        event_type="inventory.stock_transferred",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="inventory_movement",
        resource_id=movement.id,
        metadata={
            "item_id": body.item_id,
            "quantity": str(body.quantity),
            "source_warehouse_id": body.source_warehouse_id,
            "destination_warehouse_id": body.destination_warehouse_id,
        },
    )
    db.commit()
    return _movement_payload(movement, item, allocations)


@router.get("/movements")
def list_movements(
    organization_id: str,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    auth: AuthContext = Depends(require_permission("inventory:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize_inventory(auth, organization_id, "inventory:read")
    warehouse_ids = _accessible_warehouse_ids(db, auth, organization_id)
    if not warehouse_ids:
        return []
    movements = db.scalars(
        select(InventoryMovement)
        .where(
            InventoryMovement.organization_id == organization_id,
            or_(
                InventoryMovement.source_warehouse_id.in_(warehouse_ids),
                InventoryMovement.destination_warehouse_id.in_(warehouse_ids),
            ),
        )
        .order_by(InventoryMovement.created_at.desc(), InventoryMovement.id.desc())
        .limit(limit)
    ).all()
    if not movements:
        return []
    item_ids = {movement.item_id for movement in movements}
    items = {
        item.id: item
        for item in db.scalars(select(InventoryItem).where(InventoryItem.id.in_(item_ids))).all()
    }
    movement_ids = [movement.id for movement in movements]
    allocations_by_movement: defaultdict[str, list[InventoryAllocation]] = defaultdict(list)
    for allocation in db.scalars(
        select(InventoryAllocation).where(InventoryAllocation.movement_id.in_(movement_ids))
    ).all():
        allocations_by_movement[allocation.movement_id].append(allocation)
    return [
        _movement_payload(movement, items[movement.item_id], allocations_by_movement[movement.id])
        for movement in movements
        if movement.item_id in items
    ]
