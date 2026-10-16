from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import (
    AuthContext,
    ensure_scope_access,
    get_current_auth,
    has_permission,
    normalize_username,
    permission_codes_for_role,
    require_permission,
)
from app.database import get_db
from app.models import (
    AuditEvent,
    Permission,
    Role,
    RolePermission,
    User,
    UserRoleAssignment,
    UserScopeGrant,
    UserSession,
)
from app.security import hash_password

router = APIRouter(prefix="/admin", tags=["administration"])


class ScopeInput(BaseModel):
    organization_id: str
    branch_id: str | None = None
    warehouse_id: str | None = None
    factory_id: str | None = None

    @model_validator(mode="after")
    def only_one_location(self) -> "ScopeInput":
        selected = [self.branch_id, self.warehouse_id, self.factory_id]
        if sum(value is not None for value in selected) > 1:
            raise ValueError("Only one location scope may be specified.")
        return self


class RoleInput(BaseModel):
    organization_id: str
    code: str = Field(min_length=2, max_length=80, pattern=r"^[a-z][a-z0-9_-]*$")
    name: str = Field(min_length=1, max_length=255)
    permission_codes: list[str] = Field(default_factory=list, max_length=100)


class RoleAssignmentInput(BaseModel):
    organization_id: str
    role_id: str


class UserCreateInput(BaseModel):
    primary_organization_id: str
    username: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._@+-]*$")
    full_name: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=12, max_length=256)
    scopes: list[ScopeInput] = Field(min_length=1, max_length=100)
    roles: list[RoleAssignmentInput] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique_scopes_and_roles(self) -> "UserCreateInput":
        scope_keys = {
            (
                scope.organization_id,
                scope.branch_id,
                scope.warehouse_id,
                scope.factory_id,
            )
            for scope in self.scopes
        }
        role_keys = {(assignment.organization_id, assignment.role_id) for assignment in self.roles}
        if len(scope_keys) != len(self.scopes):
            raise ValueError("Duplicate user scopes are not allowed.")
        if len(role_keys) != len(self.roles):
            raise ValueError("Duplicate role assignments are not allowed.")
        return self


class UserActiveInput(BaseModel):
    is_active: bool


class UserRolesInput(BaseModel):
    role_ids: list[str] = Field(max_length=100)


class UserOutput(BaseModel):
    id: str
    username: str
    full_name: str
    is_active: bool
    scopes: list[dict[str, str | None]]


def _assert_actor_can_assign_role(
    db: Session,
    auth: AuthContext,
    role: Role,
    organization_id: str,
) -> None:
    if not has_permission(auth, organization_id, "roles:assign"):
        raise HTTPException(
            status_code=403,
            detail={"code": "permission_denied", "message": "You cannot assign roles in this organization."},
        )
    role_permissions = permission_codes_for_role(db, role.id)
    actor_permissions = auth.permissions_by_organization.get(organization_id, set())
    if not role_permissions.issubset(actor_permissions):
        raise HTTPException(
            status_code=403,
            detail={"code": "role_escalation_denied", "message": "You cannot assign permissions you do not hold."},
        )


@router.post("/roles", status_code=status.HTTP_201_CREATED)
def create_role(
    body: RoleInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("roles:manage")),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    ensure_scope_access(
        db,
        auth,
        organization_id=body.organization_id,
        require_organization_scope=True,
    )
    if not has_permission(auth, body.organization_id, "roles:manage"):
        raise HTTPException(status_code=403, detail={"code": "permission_denied", "message": "Role management is not allowed in this organization."})

    requested_codes = set(body.permission_codes)
    actor_permissions = auth.permissions_by_organization.get(body.organization_id, set())
    if not requested_codes.issubset(actor_permissions):
        raise HTTPException(
            status_code=403,
            detail={"code": "role_escalation_denied", "message": "You cannot grant permissions you do not hold."},
        )
    permissions = list(db.scalars(select(Permission).where(Permission.code.in_(requested_codes))).all()) if requested_codes else []
    if len(permissions) != len(requested_codes):
        raise HTTPException(status_code=422, detail={"code": "unknown_permission", "message": "One or more permission codes are not registered."})

    role = Role(organization_id=body.organization_id, code=body.code, name=body.name)
    db.add(role)
    db.flush()
    for permission in permissions:
        db.add(RolePermission(role_id=role.id, permission_id=permission.id))
    record_audit(
        db,
        event_type="administration.role_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=body.organization_id,
        resource_type="role",
        resource_id=role.id,
        metadata={"code": role.code, "permission_codes": sorted(requested_codes)},
    )
    db.commit()
    return {"id": role.id, "organization_id": role.organization_id, "code": role.code}


@router.post("/users", status_code=status.HTTP_201_CREATED, response_model=UserOutput)
def create_user(
    body: UserCreateInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("users:create")),
    db: Session = Depends(get_db),
) -> UserOutput:
    primary_org = body.primary_organization_id
    if not any(scope.organization_id == primary_org for scope in body.scopes):
        raise HTTPException(status_code=422, detail={"code": "primary_scope_required", "message": "A scope for the primary organization is required."})
    if not has_permission(auth, primary_org, "users:create"):
        raise HTTPException(status_code=403, detail={"code": "permission_denied", "message": "User creation is not allowed in this organization."})
    for scope in body.scopes:
        if not has_permission(auth, scope.organization_id, "users:create"):
            raise HTTPException(status_code=403, detail={"code": "permission_denied", "message": "User creation is not allowed in one of the requested organizations."})
        ensure_scope_access(
            db,
            auth,
            organization_id=scope.organization_id,
            branch_id=scope.branch_id,
            warehouse_id=scope.warehouse_id,
            factory_id=scope.factory_id,
        )
    normalized_username = normalize_username(body.username)
    if db.scalar(select(User.id).where(User.username == normalized_username)) is not None:
        raise HTTPException(status_code=409, detail={"code": "username_conflict", "message": "A user with this username already exists."})

    roles_by_id: dict[str, Role] = {}
    scope_organizations = {scope.organization_id for scope in body.scopes}
    for assignment in body.roles:
        if assignment.organization_id not in scope_organizations:
            raise HTTPException(status_code=422, detail={"code": "role_scope_mismatch", "message": "Role assignments must match one of the user's granted organizations."})
        if not has_permission(auth, assignment.organization_id, "roles:assign"):
            raise HTTPException(status_code=403, detail={"code": "permission_denied", "message": "Role assignment is not allowed in one of the requested organizations."})
        role = db.scalar(
            select(Role).where(
                Role.id == assignment.role_id,
                Role.organization_id == assignment.organization_id,
            )
        )
        if role is None:
            raise HTTPException(status_code=404, detail={"code": "role_not_found", "message": "A requested role was not found."})
        _assert_actor_can_assign_role(db, auth, role, assignment.organization_id)
        roles_by_id[role.id] = role

    user = User(
        organization_id=primary_org,
        username=normalized_username,
        full_name=body.full_name.strip(),
        password_hash=hash_password(body.password),
        is_active=True,
    )
    db.add(user)
    db.flush()
    grants: list[UserScopeGrant] = []
    for scope in body.scopes:
        grant = UserScopeGrant(
            user_id=user.id,
            organization_id=scope.organization_id,
            branch_id=scope.branch_id,
            warehouse_id=scope.warehouse_id,
            factory_id=scope.factory_id,
        )
        db.add(grant)
        grants.append(grant)
    for role in roles_by_id.values():
        db.add(
            UserRoleAssignment(
                user_id=user.id,
                role_id=role.id,
                organization_id=role.organization_id,
            )
        )
    record_audit(
        db,
        event_type="administration.user_created",
        request=request,
        actor_id=auth.user.id,
        organization_id=primary_org,
        resource_type="user",
        resource_id=user.id,
        metadata={
            "scope_count": len(grants),
            "role_ids": sorted(roles_by_id),
        },
    )
    db.commit()
    return UserOutput(
        id=user.id,
        username=user.username,
        full_name=user.full_name,
        is_active=user.is_active,
        scopes=[
            {
                "organization_id": grant.organization_id,
                "branch_id": grant.branch_id,
                "warehouse_id": grant.warehouse_id,
                "factory_id": grant.factory_id,
            }
            for grant in grants
        ],
    )


@router.get("/users", response_model=list[UserOutput])
def list_users(
    organization_id: str,
    auth: AuthContext = Depends(require_permission("users:read")),
    db: Session = Depends(get_db),
) -> list[UserOutput]:
    if not has_permission(auth, organization_id, "users:read"):
        raise HTTPException(status_code=403, detail={"code": "permission_denied", "message": "User access is not allowed in this organization."})
    ensure_scope_access(db, auth, organization_id=organization_id, require_organization_scope=True)
    users = list(
        db.scalars(
            select(User)
            .join(UserScopeGrant, UserScopeGrant.user_id == User.id)
            .where(UserScopeGrant.organization_id == organization_id)
            .distinct()
            .order_by(User.username)
        ).all()
    )
    output: list[UserOutput] = []
    for user in users:
        grants = list(
            db.scalars(
                select(UserScopeGrant).where(
                    UserScopeGrant.user_id == user.id,
                    UserScopeGrant.organization_id == organization_id,
                )
            ).all()
        )
        output.append(
            UserOutput(
                id=user.id,
                username=user.username,
                full_name=user.full_name,
                is_active=user.is_active,
                scopes=[
                    {
                        "organization_id": grant.organization_id,
                        "branch_id": grant.branch_id,
                        "warehouse_id": grant.warehouse_id,
                        "factory_id": grant.factory_id,
                    }
                    for grant in grants
                ],
            )
        )
    return output


@router.patch("/users/{user_id}/active", response_model=UserOutput)
def set_user_active(
    user_id: str,
    organization_id: str,
    body: UserActiveInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("users:update")),
    db: Session = Depends(get_db),
) -> UserOutput:
    if not has_permission(auth, organization_id, "users:update"):
        raise HTTPException(status_code=403, detail={"code": "permission_denied", "message": "User administration is not allowed in this organization."})
    ensure_scope_access(db, auth, organization_id=organization_id, require_organization_scope=True)
    user = db.scalar(
        select(User)
        .join(UserScopeGrant, UserScopeGrant.user_id == User.id)
        .where(User.id == user_id, UserScopeGrant.organization_id == organization_id)
    )
    if user is None:
        raise HTTPException(status_code=404, detail={"code": "user_not_found", "message": "The user was not found in this organization."})
    if user.id == auth.user.id and not body.is_active:
        raise HTTPException(status_code=409, detail={"code": "self_deactivation_denied", "message": "You cannot deactivate your own account."})
    user.is_active = body.is_active
    if not body.is_active:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        sessions = db.scalars(
            select(UserSession).where(
                UserSession.user_id == user.id,
                UserSession.revoked_at.is_(None),
            )
        ).all()
        for session in sessions:
            session.revoked_at = now
    record_audit(
        db,
        event_type="administration.user_active_changed",
        request=request,
        actor_id=auth.user.id,
        organization_id=organization_id,
        resource_type="user",
        resource_id=user.id,
        metadata={"is_active": body.is_active},
    )
    db.commit()
    grants = list(
        db.scalars(
            select(UserScopeGrant).where(
                UserScopeGrant.user_id == user.id,
                UserScopeGrant.organization_id == organization_id,
            )
        ).all()
    )
    return UserOutput(
        id=user.id,
        username=user.username,
        full_name=user.full_name,
        is_active=user.is_active,
        scopes=[
            {
                "organization_id": grant.organization_id,
                "branch_id": grant.branch_id,
                "warehouse_id": grant.warehouse_id,
                "factory_id": grant.factory_id,
            }
            for grant in grants
        ],
    )


@router.put("/users/{user_id}/roles", response_model=list[str])
def replace_user_roles(
    user_id: str,
    organization_id: str,
    body: UserRolesInput,
    request: Request,
    auth: AuthContext = Depends(require_permission("roles:assign")),
    db: Session = Depends(get_db),
) -> list[str]:
    if not has_permission(auth, organization_id, "roles:assign"):
        raise HTTPException(status_code=403, detail={"code": "permission_denied", "message": "Role assignment is not allowed in this organization."})
    ensure_scope_access(db, auth, organization_id=organization_id, require_organization_scope=True)
    target = db.scalar(
        select(User)
        .join(UserScopeGrant, UserScopeGrant.user_id == User.id)
        .where(User.id == user_id, UserScopeGrant.organization_id == organization_id)
    )
    if target is None:
        raise HTTPException(status_code=404, detail={"code": "user_not_found", "message": "The user was not found in this organization."})
    if len(set(body.role_ids)) != len(body.role_ids):
        raise HTTPException(status_code=422, detail={"code": "duplicate_role", "message": "Duplicate role assignments are not allowed."})

    roles = list(
        db.scalars(
            select(Role).where(
                Role.id.in_(body.role_ids),
                Role.organization_id == organization_id,
            )
        ).all()
    ) if body.role_ids else []
    if len(roles) != len(body.role_ids):
        raise HTTPException(status_code=404, detail={"code": "role_not_found", "message": "One or more roles were not found in this organization."})
    for role in roles:
        if not permission_codes_for_role(db, role.id).issubset(
            auth.permissions_by_organization.get(organization_id, set())
        ):
            raise HTTPException(status_code=403, detail={"code": "role_escalation_denied", "message": "You cannot assign permissions you do not hold."})

    assignments = list(
        db.scalars(
            select(UserRoleAssignment).where(
                UserRoleAssignment.user_id == target.id,
                UserRoleAssignment.organization_id == organization_id,
            )
        ).all()
    )
    old_role_ids = {assignment.role_id for assignment in assignments}
    new_role_ids = {role.id for role in roles}
    for assignment in assignments:
        if assignment.role_id not in new_role_ids:
            db.delete(assignment)
    for role in roles:
        if role.id not in old_role_ids:
            db.add(
                UserRoleAssignment(
                    user_id=target.id,
                    role_id=role.id,
                    organization_id=organization_id,
                )
            )
    record_audit(
        db,
        event_type="administration.user_roles_replaced",
        request=request,
        actor_id=auth.user.id,
        organization_id=organization_id,
        resource_type="user",
        resource_id=target.id,
        metadata={
            "previous_role_ids": sorted(old_role_ids),
            "new_role_ids": sorted(new_role_ids),
        },
    )
    db.commit()
    return sorted(new_role_ids)


@router.get("/audit")
def list_security_audit(
    organization_id: str,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    auth: AuthContext = Depends(require_permission("audit:read")),
    db: Session = Depends(get_db),
) -> list[dict]:
    if not has_permission(auth, organization_id, "audit:read"):
        raise HTTPException(status_code=403, detail={"code": "permission_denied", "message": "Audit access is not allowed in this organization."})
    ensure_scope_access(db, auth, organization_id=organization_id, require_organization_scope=True)
    events = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.organization_id == organization_id)
        .order_by(AuditEvent.created_at.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": event.id,
            "event_type": event.event_type,
            "actor_id": event.actor_id,
            "resource_type": event.resource_type,
            "resource_id": event.resource_id,
            "message": event.message,
            "metadata": event.event_metadata,
            "created_at": event.created_at,
        }
        for event in events
    ]
