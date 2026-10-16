from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import AuthContext, ensure_scope_access, get_current_auth, has_permission
from app.database import get_db
from app.models import (
    Employee,
    Factory,
    FinancialAccount,
    InventoryItem,
    InventoryLayer,
    JournalEntry,
    PurchaseOrder,
    SalesOrder,
    SocialContribution,
    Warehouse,
)
from app.api.routes.social_impact import build_social_impact_summary

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/enterprise")
def enterprise_dashboard(
    organization_id: str,
    branch_id: str | None = None,
    factory_id: str | None = None,
    warehouse_id: str | None = None,
    auth: AuthContext = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    if sum(value is not None for value in (branch_id, factory_id, warehouse_id)) > 1:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_scope", "message": "Select only one branch, factory, or warehouse."},
        )
    ensure_scope_access(
        db,
        auth,
        organization_id=organization_id,
        branch_id=branch_id,
        factory_id=factory_id,
        warehouse_id=warehouse_id,
    )
    module_permissions = {
        "workforce": "hr:read",
        "inventory": "inventory:read",
        "manufacturing": "manufacturing:read",
        "procurement": "procurement:read",
        "sales": "sales:read",
        "finance": "finance:read",
        "social_impact": "social:read",
    }
    visible = {
        module: has_permission(auth, organization_id, permission)
        for module, permission in module_permissions.items()
    }
    if not any(visible.values()):
        raise HTTPException(
            status_code=403,
            detail={"code": "permission_denied", "message": "You do not have access to enterprise dashboard metrics."},
        )

    organization_wide = branch_id is None and factory_id is None and warehouse_id is None
    modules: dict[str, dict] = {}
    if visible["workforce"] and organization_wide:
        counts = db.execute(
            select(Employee.status, func.count(Employee.id))
            .where(Employee.organization_id == organization_id)
            .group_by(Employee.status)
        ).all()
        workforce = {status: count for status, count in counts}
        modules["workforce"] = {
            "total": sum(workforce.values()),
            "active": workforce.get("active", 0),
            "on_leave": workforce.get("on_leave", 0),
            "terminated": workforce.get("terminated", 0),
            "large_workforce": sum(workforce.values()) >= 5000,
        }

    if visible["inventory"]:
        grants = [grant for grant in auth.grants if grant.organization_id == organization_id]
        organization_grant = any(
            grant.branch_id is None and grant.warehouse_id is None and grant.factory_id is None
            for grant in grants
        )
        if warehouse_id:
            warehouse_ids = [warehouse_id]
        elif branch_id:
            warehouse_ids = list(db.scalars(select(Warehouse.id).where(
                Warehouse.organization_id == organization_id,
                Warehouse.branch_id == branch_id,
                Warehouse.is_active.is_(True),
            )).all())
        elif factory_id:
            factory_branch = db.scalar(select(Factory.branch_id).where(
                Factory.id == factory_id, Factory.organization_id == organization_id
            ))
            warehouse_ids = list(db.scalars(select(Warehouse.id).where(
                Warehouse.organization_id == organization_id,
                Warehouse.branch_id == factory_branch,
                Warehouse.is_active.is_(True),
            )).all()) if factory_branch else []
        elif organization_grant:
            warehouse_ids = list(db.scalars(select(Warehouse.id).where(
                Warehouse.organization_id == organization_id,
                Warehouse.is_active.is_(True),
            )).all())
        else:
            warehouse_ids = [grant.warehouse_id for grant in grants if grant.warehouse_id]
            branch_ids = [grant.branch_id for grant in grants if grant.branch_id]
            if branch_ids:
                warehouse_ids.extend(db.scalars(select(Warehouse.id).where(
                    Warehouse.organization_id == organization_id,
                    Warehouse.branch_id.in_(branch_ids),
                    Warehouse.is_active.is_(True),
                )).all())
        balance_query = select(func.coalesce(func.sum(InventoryLayer.remaining_quantity), 0)).where(
            InventoryLayer.organization_id == organization_id
        )
        if warehouse_ids:
            balance_query = balance_query.where(InventoryLayer.warehouse_id.in_(set(warehouse_ids)))
        else:
            balance_query = balance_query.where(InventoryLayer.warehouse_id.is_(None))
        modules["inventory"] = {
            "active_skus": db.scalar(select(func.count(InventoryItem.id)).where(
                InventoryItem.organization_id == organization_id,
                InventoryItem.is_active.is_(True),
            )) or 0,
            "on_hand_quantity": str(db.scalar(balance_query) or 0),
            "accessible_warehouse_count": len(set(warehouse_ids)),
        }

    if visible["procurement"] and organization_wide:
        rows = db.execute(
            select(PurchaseOrder.status, func.count(PurchaseOrder.id))
            .where(PurchaseOrder.organization_id == organization_id)
            .group_by(PurchaseOrder.status)
        ).all()
        modules["procurement"] = {
            "orders_by_status": {status: count for status, count in rows},
            "open_orders": sum(count for status, count in rows if status != "received"),
        }

    if visible["sales"] and organization_wide:
        rows = db.execute(
            select(SalesOrder.status, func.count(SalesOrder.id))
            .where(SalesOrder.organization_id == organization_id)
            .group_by(SalesOrder.status)
        ).all()
        modules["sales"] = {
            "orders_by_status": {status: count for status, count in rows},
            "open_orders": sum(count for status, count in rows if status != "shipped"),
        }

    if visible["finance"] and organization_wide:
        modules["finance"] = {
            "active_accounts": db.scalar(select(func.count(FinancialAccount.id)).where(
                FinancialAccount.organization_id == organization_id,
                FinancialAccount.is_active.is_(True),
            )) or 0,
            "journal_entries": db.scalar(select(func.count(JournalEntry.id)).where(
                JournalEntry.organization_id == organization_id,
            )) or 0,
        }

    if visible["social_impact"]:
        modules["social_impact"] = build_social_impact_summary(
            db, organization_id, branch_id=branch_id, factory_id=factory_id
        )

    if visible["manufacturing"]:
        factory_count_query = select(func.count(Factory.id)).where(
                Factory.organization_id == organization_id,
                Factory.is_active.is_(True),
            )
        if branch_id:
            factory_count_query = factory_count_query.where(Factory.branch_id == branch_id)
        if factory_id:
            factory_count_query = factory_count_query.where(Factory.id == factory_id)
        if warehouse_id:
            factory_count_query = None
        if factory_count_query is not None:
            modules["manufacturing"] = {
                "active_factories": db.scalar(factory_count_query) or 0,
            }

    if visible["inventory"] and organization_wide:
        modules.setdefault("inventory", {}).update({
            "active_warehouses": db.scalar(select(func.count(Warehouse.id)).where(
                Warehouse.organization_id == organization_id,
                Warehouse.is_active.is_(True),
            )) or 0,
        })

    return {
        "organization_id": organization_id,
        "scope": {
            "branch_id": branch_id,
            "factory_id": factory_id,
            "warehouse_id": warehouse_id,
            "organization_wide": organization_wide,
        },
        "as_of": datetime.now(timezone.utc).isoformat(),
        "modules": modules,
    }