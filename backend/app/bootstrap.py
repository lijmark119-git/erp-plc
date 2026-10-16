import argparse
from getpass import getpass
import re

from sqlalchemy import func, select

from app.database import SessionLocal
from app.models import (
    AuditEvent,
    Organization,
    Permission,
    Role,
    RolePermission,
    SetupState,
    User,
    UserRoleAssignment,
    UserScopeGrant,
)
from app.security import hash_password

BOOTSTRAP_PERMISSIONS = {
    "audit:read": "View immutable audit events.",
    "finance:accounts_manage": "Create financial chart-of-account records.",
    "finance:post": "Post balanced manual journal entries.",
    "finance:read": "View financial accounts and posted journal entries.",
    "hr:attendance_manage": "Record and manage employee attendance.",
    "hr:leave_approve": "Approve or reject employee leave requests.",
    "hr:leave_request": "Submit employee leave requests.",
    "hr:manage": "Manage HR departments and employee records.",
    "hr:payroll_manage": "Configure and process payroll.",
    "hr:payroll_read": "View payroll records and calculations.",
    "hr:read": "View HR, employee, leave, and attendance records.",
    "hr:reports": "View HR operational and payroll reports.",
    "inventory:manage": "Create inventory items and warehouses.",
    "inventory:read": "View inventory items, stock balances, and movements.",
    "inventory:transact": "Receive, issue, and transfer inventory stock.",
    "manufacturing:read": "View manufacturing sites and operational dashboard metrics.",
    "procurement:manage": "Create and manage supplier records.",
    "procurement:read": "View suppliers and purchase orders.",
    "procurement:order": "Create and issue purchase orders.",
    "procurement:receive": "Receive purchase order deliveries into inventory.",
    "sales:customer_manage": "Create customer records.",
    "sales:fulfill": "Fulfill sales orders and issue inventory.",
    "sales:order": "Create customer sales orders.",
    "sales:read": "View customers and sales orders.",
    "social:manage": "Record organization social-contribution activities.",
    "social:read": "View organization social-contribution records and results.",
    "roles:assign": "Assign roles within authorized organizations.",
    "roles:manage": "Create roles using permissions already held.",
    "users:create": "Create users within authorized organizational scopes.",
    "users:read": "View users within authorized organizational scopes.",
    "users:update": "Change user activation state.",
}


def bootstrap_admin(
    *,
    organization_code: str,
    organization_name: str,
    username: str,
    full_name: str,
    password: str,
) -> str:
    if len(password) < 12:
        raise ValueError("Bootstrap password must be at least 12 characters.")
    normalized_username = username.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", normalized_username):
        raise ValueError("Bootstrap username must start with a letter or number and contain only letters, numbers, periods, underscores, or hyphens.")

    with SessionLocal.begin() as db:
        setup = db.scalar(select(SetupState).where(SetupState.id == 1).with_for_update())
        if setup is None:
            raise RuntimeError("Setup state is missing. Apply Alembic migrations before bootstrapping.")
        if setup.bootstrap_complete or db.scalar(select(func.count()).select_from(User)):
            raise RuntimeError("Bootstrap is only allowed once, before any user exists.")

        organization = Organization(
            code=organization_code.strip(),
            name=organization_name.strip(),
            status="active",
        )
        admin = User(
            organization_id="",
            username=normalized_username,
            full_name=full_name.strip(),
            password_hash=hash_password(password),
            is_active=True,
        )
        db.add(organization)
        db.flush()
        admin.organization_id = organization.id
        db.add(admin)
        db.flush()

        permissions: list[Permission] = []
        for code, description in BOOTSTRAP_PERMISSIONS.items():
            permission = Permission(code=code, description=description)
            db.add(permission)
            permissions.append(permission)
        db.flush()

        role = Role(
            organization_id=organization.id,
            code="system_administrator",
            name="System Administrator",
            is_system=True,
        )
        db.add(role)
        db.flush()
        for permission in permissions:
            db.add(RolePermission(role_id=role.id, permission_id=permission.id))
        db.add(
            UserScopeGrant(
                user_id=admin.id,
                organization_id=organization.id,
            )
        )
        db.add(
            UserRoleAssignment(
                user_id=admin.id,
                role_id=role.id,
                organization_id=organization.id,
            )
        )
        db.add(
            AuditEvent(
                actor_id=admin.id,
                organization_id=organization.id,
                event_type="administration.initial_bootstrap",
                resource_type="user",
                resource_id=admin.id,
                message="Initial administrator created through explicit CLI bootstrap.",
                event_metadata={"method": "interactive_cli"},
            )
        )
        setup.bootstrap_complete = True
        return admin.id


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create the first organization administrator. Run once after applying database migrations."
    )
    parser.add_argument("--organization-code", required=True)
    parser.add_argument("--organization-name", required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--full-name", required=True)
    args = parser.parse_args()

    password = getpass("New administrator password (minimum 12 characters): ")
    confirmation = getpass("Confirm administrator password: ")
    if password != confirmation:
        parser.error("Passwords do not match.")
    try:
        user_id = bootstrap_admin(
            organization_code=args.organization_code,
            organization_name=args.organization_name,
            username=args.username,
            full_name=args.full_name,
            password=password,
        )
    except (RuntimeError, ValueError) as exc:
        parser.error(str(exc))
    print(f"Initial administrator created. User ID: {user_id}")


if __name__ == "__main__":
    main()
