from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal, localcontext
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import AuthContext, has_permission, require_permission
from app.database import get_db
from app.models import FinancialAccount, JournalEntry, JournalLine

router = APIRouter(prefix="/finance", tags=["finance"])

Money = Annotated[Decimal, Field(ge=0, max_digits=18, decimal_places=4)]


class AccountInput(BaseModel):
    organization_id: str
    code: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    name: str = Field(min_length=1, max_length=255)
    account_type: str = Field(pattern=r"^(asset|liability|equity|revenue|expense)$")

    @field_validator("code", "name", mode="before")
    @classmethod
    def trim_text(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("This field must be text.")
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank.")
        return value


class JournalLineInput(BaseModel):
    account_id: str
    debit: Money = Decimal("0")
    credit: Money = Decimal("0")
    memo: str | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def exactly_one_side(self) -> "JournalLineInput":
        if (self.debit > 0) == (self.credit > 0):
            raise ValueError("Each journal line must have either a debit or a credit, but not both.")
        return self


class JournalEntryInput(BaseModel):
    organization_id: str
    posting_date: date
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    description: str = Field(min_length=1, max_length=500)
    reference: str | None = Field(default=None, max_length=100)
    lines: list[JournalLineInput] = Field(min_length=2, max_length=100)

    @field_validator("description", "reference", mode="before")
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
    def balanced_and_unique_accounts(self) -> "JournalEntryInput":
        account_ids = [line.account_id for line in self.lines]
        if len(account_ids) != len(set(account_ids)):
            raise ValueError("Each account may appear only once in a journal entry.")
        with localcontext() as context:
            context.prec = 50
            debits = sum((line.debit for line in self.lines), Decimal("0"))
            credits = sum((line.credit for line in self.lines), Decimal("0"))
        if debits != credits:
            raise ValueError("Journal entry debits and credits must balance exactly.")
        return self


def _authorize(auth: AuthContext, organization_id: str, permission: str) -> None:
    if not has_permission(auth, organization_id, permission):
        raise HTTPException(
            status_code=403,
            detail={"code": "permission_denied", "message": "You do not have permission to use Finance in this organization."},
        )
    if not any(grant.organization_id == organization_id for grant in auth.grants):
        raise HTTPException(
            status_code=403,
            detail={"code": "scope_denied", "message": "You do not have access to this organization."},
        )


def _account_payload(account: FinancialAccount) -> dict:
    return {
        "id": account.id,
        "organization_id": account.organization_id,
        "code": account.code,
        "name": account.name,
        "account_type": account.account_type,
        "is_active": account.is_active,
    }


def _entry_payload(db: Session, entry: JournalEntry) -> dict:
    rows = db.execute(
        select(JournalLine, FinancialAccount)
        .join(FinancialAccount, FinancialAccount.id == JournalLine.account_id)
        .where(
            JournalLine.entry_id == entry.id,
            JournalLine.organization_id == entry.organization_id,
        )
        .order_by(FinancialAccount.code)
    ).all()
    return {
        "id": entry.id,
        "organization_id": entry.organization_id,
        "entry_number": entry.entry_number,
        "posting_date": entry.posting_date.isoformat(),
        "currency": entry.currency,
        "description": entry.description,
        "reference": entry.reference,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
        "lines": [
            {
                "id": line.id,
                "account_id": line.account_id,
                "account_code": account.code,
                "account_name": account.name,
                "account_type": account.account_type,
                "debit": f"{line.debit:.4f}",
                "credit": f"{line.credit:.4f}",
                "memo": line.memo,
            }
            for line, account in rows
        ],
    }


@router.get("/accounts")
def list_accounts(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("finance:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize(auth, organization_id, "finance:read")
    return [
        _account_payload(account)
        for account in db.scalars(
            select(FinancialAccount)
            .where(FinancialAccount.organization_id == organization_id)
            .order_by(FinancialAccount.code)
        ).all()
    ]


@router.post("/accounts", status_code=201)
def create_account(
    body: AccountInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("finance:accounts_manage")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize(auth, body.organization_id, "finance:accounts_manage")
    code = body.code.upper()
    if db.scalar(
        select(FinancialAccount.id).where(
            FinancialAccount.organization_id == body.organization_id,
            FinancialAccount.code == code,
        )
    ):
        raise HTTPException(
            status_code=409,
            detail={"code": "account_code_conflict", "message": "A financial account with this code already exists in this organization."},
        )
    account = FinancialAccount(
        organization_id=body.organization_id,
        code=code,
        name=body.name,
        account_type=body.account_type,
    )
    db.add(account)
    db.flush()
    record_audit(
        db,
        event_type="finance.account_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="financial_account",
        resource_id=account.id,
        metadata={"code": account.code, "account_type": account.account_type},
    )
    db.commit()
    return _account_payload(account)


@router.get("/journal-entries")
def list_journal_entries(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("finance:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    _authorize(auth, organization_id, "finance:read")
    entries = db.scalars(
        select(JournalEntry)
        .where(JournalEntry.organization_id == organization_id)
        .order_by(JournalEntry.posting_date.desc(), JournalEntry.created_at.desc(), JournalEntry.id.desc())
    ).all()
    return [_entry_payload(db, entry) for entry in entries]


@router.post("/journal-entries", status_code=201)
def post_journal_entry(
    body: JournalEntryInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("finance:post")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize(auth, body.organization_id, "finance:post")
    account_ids = [line.account_id for line in body.lines]
    accounts = db.scalars(
        select(FinancialAccount).where(
            FinancialAccount.organization_id == body.organization_id,
            FinancialAccount.id.in_(account_ids),
            FinancialAccount.is_active.is_(True),
        )
    ).all()
    if len(accounts) != len(account_ids):
        raise HTTPException(
            status_code=404,
            detail={"code": "financial_account_not_found", "message": "One or more active financial accounts were not found in this organization."},
        )

    now = datetime.now(timezone.utc)
    entry = JournalEntry(
        organization_id=body.organization_id,
        entry_number=f"JE-{now:%Y%m%d}-{uuid4().hex[:8].upper()}",
        posting_date=body.posting_date,
        currency=body.currency,
        description=body.description,
        reference=body.reference,
        posted_by=auth.user.id,
    )
    db.add(entry)
    db.flush()
    db.add_all(
        JournalLine(
            organization_id=body.organization_id,
            entry_id=entry.id,
            account_id=line.account_id,
            debit=line.debit,
            credit=line.credit,
            memo=line.memo,
        )
        for line in body.lines
    )
    record_audit(
        db,
        event_type="finance.journal_entry_posted",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="journal_entry",
        resource_id=entry.id,
        metadata={
            "entry_number": entry.entry_number,
            "posting_date": entry.posting_date.isoformat(),
            "currency": entry.currency,
            "line_count": len(body.lines),
        },
    )
    db.commit()
    return _entry_payload(db, entry)


@router.get("/ledger")
def account_ledger(
    organization_id: str,
    account_id: str,
    auth: AuthContext = Depends(require_permission("finance:read")),
    db: Session = Depends(get_db),
) -> dict:
    _authorize(auth, organization_id, "finance:read")
    account = db.scalar(
        select(FinancialAccount).where(
            FinancialAccount.id == account_id,
            FinancialAccount.organization_id == organization_id,
        )
    )
    if account is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "financial_account_not_found", "message": "The financial account was not found in this organization."},
        )
    rows = db.execute(
        select(JournalEntry, JournalLine)
        .join(
            JournalLine,
            (JournalLine.entry_id == JournalEntry.id)
            & (JournalLine.organization_id == JournalEntry.organization_id),
        )
        .where(
            JournalEntry.organization_id == organization_id,
            JournalLine.account_id == account.id,
        )
        .order_by(JournalEntry.posting_date, JournalEntry.created_at, JournalEntry.id)
    ).all()
    currencies: defaultdict[str, Decimal] = defaultdict(Decimal)
    output = []
    for entry, line in rows:
        currencies[entry.currency] += line.debit - line.credit
        output.append(
            {
                "entry_id": entry.id,
                "entry_number": entry.entry_number,
                "posting_date": entry.posting_date.isoformat(),
                "description": entry.description,
                "reference": entry.reference,
                "currency": entry.currency,
                "debit": f"{line.debit:.4f}",
                "credit": f"{line.credit:.4f}",
                "running_balance": f"{currencies[entry.currency]:.4f}",
            }
        )
    return {"account": _account_payload(account), "entries": output}
