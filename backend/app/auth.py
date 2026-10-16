import hmac
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import settings
from app.models import (
    Branch,
    Factory,
    Permission,
    RolePermission,
    User,
    UserRoleAssignment,
    UserScopeGrant,
    UserSession,
    Warehouse,
)
from app.security import hash_token


def normalize_username(value: str) -> str:
    normalized = value.strip().lower()
    if "@" in normalized:
        normalized = normalized.split("@", 1)[0]
    normalized = re.sub(r"[^a-z0-9._-]", "", normalized)
    normalized = normalized.strip("._-")
    return normalized or "user"


@dataclass(frozen=True)
class AuthContext:
    user: User
    session: UserSession
    permissions_by_organization: dict[str, set[str]]
    grants: list[UserScopeGrant]


def unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": "authentication_required", "message": "Authentication is required."},
        headers={"WWW-Authenticate": "Session"},
    )


def get_current_auth(request: Request, db: Session = Depends(get_db)) -> AuthContext:
    raw_token = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if not raw_token:
        raise unauthorized()

    token_hash = hash_token(raw_token)
    session = db.scalar(
        select(UserSession).where(
            UserSession.token_hash == token_hash,
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > datetime.now(timezone.utc),
        )
    )
    if session is None:
        raise unauthorized()

    safe_methods = {"GET", "HEAD", "OPTIONS"}
    if request.method.upper() not in safe_methods:
        csrf_token = request.headers.get("X-CSRF-Token", "")
        csrf_cookie = request.cookies.get(settings.CSRF_COOKIE_NAME, "")
        if (
            not csrf_token
            or not csrf_cookie
            or not hmac.compare_digest(csrf_token, csrf_cookie)
            or not hmac.compare_digest(hash_token(csrf_token), session.csrf_token_hash)
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "csrf_invalid", "message": "A valid CSRF token is required."},
            )

    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise unauthorized()

    grants = list(
        db.scalars(
            select(UserScopeGrant).where(UserScopeGrant.user_id == user.id)
        ).all()
    )
    organization_ids = {grant.organization_id for grant in grants}
    permissions_by_organization: dict[str, set[str]] = {org_id: set() for org_id in organization_ids}
    if organization_ids:
        rows = db.execute(
            select(UserRoleAssignment.organization_id, Permission.code)
            .join(RolePermission, RolePermission.role_id == UserRoleAssignment.role_id)
            .join(Permission, Permission.id == RolePermission.permission_id)
            .where(
                UserRoleAssignment.user_id == user.id,
                UserRoleAssignment.organization_id.in_(organization_ids),
            )
        )
        for org_id, permission_code in rows:
            permissions_by_organization.setdefault(org_id, set()).add(permission_code)

    return AuthContext(
        user=user,
        session=session,
        permissions_by_organization=permissions_by_organization,
        grants=grants,
    )


def require_permission(permission_code: str) -> Callable:
    def dependency(auth: AuthContext = Depends(get_current_auth)) -> AuthContext:
        if not any(permission_code in permissions for permissions in auth.permissions_by_organization.values()):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "permission_denied", "message": "You do not have permission to perform this action."},
            )
        return auth

    return dependency


def has_permission(auth: AuthContext, organization_id: str, permission_code: str) -> bool:
    return permission_code in auth.permissions_by_organization.get(organization_id, set())


def ensure_scope_access(
    db: Session,
    auth: AuthContext,
    *,
    organization_id: str,
    branch_id: str | None = None,
    warehouse_id: str | None = None,
    factory_id: str | None = None,
    require_organization_scope: bool = False,
) -> None:
    if len([value for value in (branch_id, warehouse_id, factory_id) if value is not None]) > 1:
        raise HTTPException(status_code=422, detail={"code": "invalid_scope", "message": "Only one location scope may be selected."})

    if require_organization_scope:
        allowed = any(
            grant.organization_id == organization_id
            and grant.branch_id is None
            and grant.warehouse_id is None
            and grant.factory_id is None
            for grant in auth.grants
        )
    elif not any((branch_id, warehouse_id, factory_id)):
        allowed = any(
            grant.organization_id == organization_id
            and grant.branch_id is None
            and grant.warehouse_id is None
            and grant.factory_id is None
            for grant in auth.grants
        )
    else:
        requested_scope = branch_id or warehouse_id or factory_id
        allowed = any(
            grant.organization_id == organization_id
            and (
                (branch_id is not None and grant.branch_id == branch_id)
                or (warehouse_id is not None and grant.warehouse_id == warehouse_id)
                or (factory_id is not None and grant.factory_id == factory_id)
                or (
                    grant.branch_id is None
                    and grant.warehouse_id is None
                    and grant.factory_id is None
                )
            )
            for grant in auth.grants
        )
        if requested_scope is None:
            allowed = False

    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "scope_denied", "message": "You do not have access to the requested organizational scope."},
        )

    if branch_id:
        valid = db.scalar(
            select(Branch.id).where(
                Branch.id == branch_id,
                Branch.organization_id == organization_id,
                Branch.is_active.is_(True),
            )
        )
        if valid is None:
            raise HTTPException(status_code=404, detail={"code": "scope_not_found", "message": "The requested scope was not found."})
    if warehouse_id:
        valid = db.scalar(
            select(Warehouse.id).where(
                Warehouse.id == warehouse_id,
                Warehouse.organization_id == organization_id,
                Warehouse.is_active.is_(True),
            )
        )
        if valid is None:
            raise HTTPException(status_code=404, detail={"code": "scope_not_found", "message": "The requested scope was not found."})
    if factory_id:
        valid = db.scalar(
            select(Factory.id).where(
                Factory.id == factory_id,
                Factory.organization_id == organization_id,
                Factory.is_active.is_(True),
            )
        )
        if valid is None:
            raise HTTPException(status_code=404, detail={"code": "scope_not_found", "message": "The requested scope was not found."})


def permission_codes_for_role(db: Session, role_id: str) -> set[str]:
    return set(
        db.scalars(
            select(Permission.code)
            .join(RolePermission, RolePermission.permission_id == Permission.id)
            .where(RolePermission.role_id == role_id)
        ).all()
    )
