from datetime import date
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import AuthContext, ensure_scope_access, has_permission, require_permission
from app.database import get_db
from app.models import SocialContribution

router = APIRouter(prefix="/social-impact", tags=["social impact"])


class ContributionInput(BaseModel):
    organization_id: str
    branch_id: str | None = None
    factory_id: str | None = None
    title: str = Field(min_length=1, max_length=200)
    contribution_type: str = Field(
        pattern=r"^(community|education|health|environment|employee_volunteering|local_supplier_development)$"
    )
    occurred_on: date
    beneficiary_count: int = Field(default=0, ge=0)
    volunteer_hours: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=2)
    amount: Decimal | None = Field(default=None, ge=0, max_digits=18, decimal_places=2)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    partner: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=1000)

    @field_validator("title", "partner", "note", mode="before")
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

    @model_validator(mode="after")
    def amount_requires_currency(self) -> "ContributionInput":
        if (self.amount is None) != (self.currency is None):
            raise ValueError("Amount and currency must be provided together.")
        return self


def _authorize(auth: AuthContext, organization_id: str, permission: str) -> None:
    if not has_permission(auth, organization_id, permission):
        raise HTTPException(
            status_code=403,
            detail={"code": "permission_denied", "message": "You do not have permission to use social impact in this organization."},
        )


def _apply_scope(query, *, branch_id: str | None, factory_id: str | None):
    if branch_id:
        query = query.where(SocialContribution.branch_id == branch_id)
    if factory_id:
        query = query.where(SocialContribution.factory_id == factory_id)
    return query


def build_social_impact_summary(
    db: Session,
    organization_id: str,
    *,
    branch_id: str | None = None,
    factory_id: str | None = None,
) -> dict:
    scoped = _apply_scope(
        select(SocialContribution).where(SocialContribution.organization_id == organization_id),
        branch_id=branch_id,
        factory_id=factory_id,
    ).subquery()
    totals = db.execute(
        select(
            func.count().label("record_count"),
            func.coalesce(func.sum(scoped.c.beneficiary_count), 0).label("beneficiaries"),
            func.coalesce(func.sum(scoped.c.volunteer_hours), 0).label("volunteer_hours"),
        ).select_from(scoped)
    ).one()
    by_currency = db.execute(
        select(scoped.c.currency, func.sum(scoped.c.amount))
        .where(scoped.c.amount.is_not(None))
        .group_by(scoped.c.currency)
        .order_by(scoped.c.currency)
    ).all()
    return {
        "record_count": totals.record_count,
        "beneficiary_count": totals.beneficiaries,
        "volunteer_hours": str(totals.volunteer_hours),
        "contribution_by_currency": [
            {"currency": currency, "amount": f"{amount:.2f}"}
            for currency, amount in by_currency
        ],
    }


def _contribution_payload(contribution: SocialContribution) -> dict:
    return {
        "id": contribution.id,
        "organization_id": contribution.organization_id,
        "branch_id": contribution.branch_id,
        "factory_id": contribution.factory_id,
        "title": contribution.title,
        "contribution_type": contribution.contribution_type,
        "occurred_on": contribution.occurred_on.isoformat(),
        "beneficiary_count": contribution.beneficiary_count,
        "volunteer_hours": str(contribution.volunteer_hours),
        "amount": str(contribution.amount) if contribution.amount is not None else None,
        "currency": contribution.currency,
        "partner": contribution.partner,
        "note": contribution.note,
        "created_at": contribution.created_at.isoformat() if contribution.created_at else None,
    }


@router.get("/records")
def list_contributions(
    organization_id: str,
    branch_id: str | None = None,
    factory_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0, le=100000)] = 0,
    auth: AuthContext = Depends(require_permission("social:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize(auth, organization_id, "social:read")
    ensure_scope_access(
        db, auth, organization_id=organization_id, branch_id=branch_id, factory_id=factory_id
    )
    query = _apply_scope(
        select(SocialContribution).where(SocialContribution.organization_id == organization_id),
        branch_id=branch_id,
        factory_id=factory_id,
    )
    rows = db.scalars(
        query.order_by(SocialContribution.occurred_on.desc(), SocialContribution.created_at.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return [_contribution_payload(row) for row in rows]


@router.post("/records", status_code=201)
def create_contribution(
    body: ContributionInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("social:manage")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize(auth, body.organization_id, "social:manage")
    ensure_scope_access(
        db,
        auth,
        organization_id=body.organization_id,
        branch_id=body.branch_id,
        factory_id=body.factory_id,
    )
    contribution = SocialContribution(
        **body.model_dump(),
        created_by=auth.user.id,
    )
    db.add(contribution)
    db.flush()
    record_audit(
        db,
        event_type="social_impact.contribution_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="social_contribution",
        resource_id=contribution.id,
        message="Social contribution recorded.",
        metadata={"contribution_type": body.contribution_type, "beneficiary_count": body.beneficiary_count},
    )
    db.commit()
    db.refresh(contribution)
    return _contribution_payload(contribution)


@router.get("/summary")
def social_impact_summary(
    organization_id: str,
    branch_id: str | None = None,
    factory_id: str | None = None,
    auth: AuthContext = Depends(require_permission("social:read")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize(auth, organization_id, "social:read")
    ensure_scope_access(
        db, auth, organization_id=organization_id, branch_id=branch_id, factory_id=factory_id
    )
    return build_social_impact_summary(
        db, organization_id, branch_id=branch_id, factory_id=factory_id
    )