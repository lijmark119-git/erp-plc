from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.models import (
    AuditEvent,
    Branch,
    Factory,
    Organization,
    Permission,
    Role,
    RolePermission,
    User,
    UserRoleAssignment,
    UserScopeGrant,
    UserSession,
    Warehouse,
)
from app.security import hash_password, hash_token


@pytest.fixture
def test_client() -> Generator[TestClient, None, None]:
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
    seeded = {}

    def override_get_db() -> Generator[Session, None, None]:
        with test_session_maker() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    with test_session_maker() as db:
        organization = Organization(code="TEST", name="Test Organization")
        db.add(organization)
        db.flush()
        branch = Branch(organization_id=organization.id, code="B1", name="Branch One")
        db.add(branch)
        db.flush()
        warehouse = Warehouse(
            organization_id=organization.id,
            branch_id=branch.id,
            code="W1",
            name="Warehouse One",
        )
        factory = Factory(
            organization_id=organization.id,
            branch_id=branch.id,
            code="F1",
            name="Factory One",
        )
        db.add_all([warehouse, factory])
        permission_codes = [
            "audit:read",
            "roles:assign",
            "roles:manage",
            "users:create",
            "users:read",
            "users:update",
        ]
        permissions = {
            code: Permission(code=code, description=f"Test {code} permission")
            for code in permission_codes
        }
        db.add_all(permissions.values())
        admin_role = Role(
            organization_id=organization.id,
            code="admin",
            name="Test Administrator",
            is_system=True,
        )
        reader_role = Role(
            organization_id=organization.id,
            code="reader",
            name="Branch Reader",
        )
        manager_role = Role(
            organization_id=organization.id,
            code="manager",
            name="Limited User Manager",
        )
        location_manager_role = Role(
            organization_id=organization.id,
            code="location_manager",
            name="Branch User Manager",
        )
        location_operator_role = Role(
            organization_id=organization.id,
            code="location_operator",
            name="Location Operator",
        )
        admin = User(
            organization_id=organization.id,
            username="admin",
            full_name="Test Admin",
            password_hash=hash_password("Test-Admin-Password-123"),
            is_active=True,
        )
        reader = User(
            organization_id=organization.id,
            username="reader",
            full_name="Branch Reader",
            password_hash=hash_password("Test-Reader-Password-123"),
            is_active=True,
        )
        manager = User(
            organization_id=organization.id,
            username="manager",
            full_name="Limited Manager",
            password_hash=hash_password("Test-Manager-Password-123"),
            is_active=True,
        )
        location_manager = User(
            organization_id=organization.id,
            username="location.manager",
            full_name="Branch Manager",
            password_hash=hash_password("Test-Location-Manager-123"),
            is_active=True,
        )
        other_organization = Organization(code="OTHER", name="Other Organization")
        db.add_all(
            [
                admin_role,
                reader_role,
                manager_role,
                location_manager_role,
                location_operator_role,
                admin,
                reader,
                manager,
                location_manager,
                other_organization,
            ]
        )
        db.flush()
        db.add_all(
            [
                RolePermission(role_id=admin_role.id, permission_id=permission.id)
                for permission in permissions.values()
            ]
        )
        db.add(
            RolePermission(
                role_id=location_manager_role.id,
                permission_id=permissions["users:create"].id,
            )
        )
        db.add(
            RolePermission(
                role_id=location_manager_role.id,
                permission_id=permissions["roles:assign"].id,
            )
        )
        db.add(
            RolePermission(
                role_id=location_operator_role.id,
                permission_id=permissions["users:create"].id,
            )
        )
        db.add(
            RolePermission(
                role_id=reader_role.id,
                permission_id=permissions["users:read"].id,
            )
        )
        db.add_all(
            [
                RolePermission(
                    role_id=manager_role.id,
                    permission_id=permissions["users:create"].id,
                ),
                RolePermission(
                    role_id=manager_role.id,
                    permission_id=permissions["roles:assign"].id,
                ),
            ]
        )
        db.add_all(
            [
                UserRoleAssignment(
                    user_id=admin.id,
                    role_id=admin_role.id,
                    organization_id=organization.id,
                ),
                UserRoleAssignment(
                    user_id=reader.id,
                    role_id=reader_role.id,
                    organization_id=organization.id,
                ),
                UserRoleAssignment(
                    user_id=manager.id,
                    role_id=manager_role.id,
                    organization_id=organization.id,
                ),
                UserRoleAssignment(
                    user_id=location_manager.id,
                    role_id=location_manager_role.id,
                    organization_id=organization.id,
                ),
                UserScopeGrant(user_id=admin.id, organization_id=organization.id),
                UserScopeGrant(
                    user_id=reader.id,
                    organization_id=organization.id,
                    branch_id=branch.id,
                ),
                UserScopeGrant(user_id=manager.id, organization_id=organization.id),
                UserScopeGrant(
                    user_id=location_manager.id,
                    organization_id=organization.id,
                    branch_id=branch.id,
                ),
            ]
        )
        db.commit()
        seeded.update(
            {
                "organization_id": organization.id,
                "branch_id": branch.id,
                "warehouse_id": warehouse.id,
                "factory_id": factory.id,
                "admin_id": admin.id,
                "reader_id": reader.id,
                "manager_id": manager.id,
                "location_manager_id": location_manager.id,
                "admin_role_id": admin_role.id,
                "location_operator_role_id": location_operator_role.id,
                "other_organization_id": other_organization.id,
                "session_maker": test_session_maker,
            }
        )

    client = TestClient(app)
    client.test_data = seeded
    try:
        yield client
    finally:
        app.dependency_overrides.pop(get_db, None)
        Base.metadata.drop_all(engine)
        engine.dispose()


def login(client: TestClient, username: str, password: str) -> str:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200
    return response.json()["csrf_token"]


def test_successful_login_uses_http_only_session_and_scoped_identity(test_client: TestClient) -> None:
    response = test_client.post(
        "/api/auth/login",
        json={"username": "ADMIN", "password": "Test-Admin-Password-123"},
    )
    assert response.status_code == 200
    assert response.json()["user_id"] == test_client.test_data["admin_id"]
    assert response.cookies.get("erp_session")
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert "erp_csrf=" in cookie

    me = test_client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["username"] == "admin"
    assert "users:create" in me.json()["permissions"][test_client.test_data["organization_id"]]
    session_token = test_client.cookies.get("erp_session")
    with test_client.test_data["session_maker"]() as db:
        session = db.scalar(select(UserSession).where(UserSession.user_id == test_client.test_data["admin_id"]))
        assert session is not None
        assert session.token_hash == hash_token(session_token)
        assert session.token_hash != session_token
        assert db.scalar(
            select(AuditEvent.id).where(
                AuditEvent.event_type == "authentication.login_succeeded",
                AuditEvent.actor_id == test_client.test_data["admin_id"],
            )
        )


def test_invalid_credentials_are_generic_and_audited(test_client: TestClient) -> None:
    response = test_client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "wrong-password"},
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_credentials"
    assert response.json()["error"]["message"] == "Username or password is incorrect."
    unknown_user_response = test_client.post(
        "/api/auth/login",
        json={"username": "unknown", "password": "wrong-password"},
    )
    assert unknown_user_response.status_code == response.status_code
    assert unknown_user_response.json() == response.json()
    with test_client.test_data["session_maker"]() as db:
        assert db.scalar(
            select(AuditEvent.id).where(AuditEvent.event_type == "authentication.login_failed")
        )


def test_unauthenticated_admin_access_is_rejected(test_client: TestClient) -> None:
    response = test_client.get(
        "/api/admin/users",
        params={"organization_id": test_client.test_data["organization_id"]},
    )
    assert response.status_code == 401


def test_role_restriction_blocks_user_creation(test_client: TestClient) -> None:
    csrf_token = login(
        test_client,
        "reader",
        "Test-Reader-Password-123",
    )
    response = test_client.post(
        "/api/admin/users",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "primary_organization_id": test_client.test_data["organization_id"],
            "username": "new-user",
            "full_name": "New User",
            "password": "New-User-Password-123",
            "scopes": [{"organization_id": test_client.test_data["organization_id"]}],
        },
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "permission_denied"


def test_branch_scope_cannot_enumerate_entire_organization(test_client: TestClient) -> None:
    login(test_client, "reader", "Test-Reader-Password-123")
    response = test_client.get(
        "/api/admin/users",
        params={"organization_id": test_client.test_data["organization_id"]},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "scope_denied"


def test_authenticated_mutation_requires_csrf_token(test_client: TestClient) -> None:
    login(test_client, "admin", "Test-Admin-Password-123")
    response = test_client.post(
        "/api/admin/users",
        json={
            "primary_organization_id": test_client.test_data["organization_id"],
            "username": "new-user",
            "full_name": "New User",
            "password": "New-User-Password-123",
            "scopes": [{"organization_id": test_client.test_data["organization_id"]}],
        },
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_invalid"


def test_csrf_token_must_match_session_cookie(test_client: TestClient) -> None:
    csrf_token = login(test_client, "admin", "Test-Admin-Password-123")
    test_client.cookies.set("erp_csrf", "attacker-supplied-token")
    response = test_client.post(
        "/api/auth/logout",
        headers={"X-CSRF-Token": csrf_token},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "csrf_invalid"


def test_user_administration_hashes_password_and_writes_audit(test_client: TestClient) -> None:
    csrf_token = login(test_client, "admin@example.com", "Test-Admin-Password-123")
    password = "Created-User-Password-123"
    response = test_client.post(
        "/api/admin/users",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "primary_organization_id": test_client.test_data["organization_id"],
            "username": "created-user",
            "full_name": "Created User",
            "password": password,
            "scopes": [
                {
                    "organization_id": test_client.test_data["organization_id"],
                    "branch_id": test_client.test_data["branch_id"],
                }
            ],
        },
    )
    assert response.status_code == 201
    assert response.json()["username"] == "created-user"
    user_id = response.json()["id"]
    with test_client.test_data["session_maker"]() as db:
        user = db.get(User, user_id)
        assert user is not None
        assert user.password_hash != password
        assert user.password_hash.startswith("$argon2")
        assert db.scalar(
            select(AuditEvent.id).where(
                AuditEvent.event_type == "administration.user_created",
                AuditEvent.resource_id == user_id,
            )
        )


def test_nonexistent_location_scopes_are_rejected(test_client: TestClient) -> None:
    admin_csrf = login(test_client, "admin", "Test-Admin-Password-123")
    response = test_client.post(
        "/api/admin/users",
        headers={"X-CSRF-Token": admin_csrf},
        json={
            "primary_organization_id": test_client.test_data["organization_id"],
            "username": "out-of-scope",
            "full_name": "Out of Scope",
            "password": "Out-Of-Scope-Password-123",
            "scopes": [
                {
                    "organization_id": test_client.test_data["organization_id"],
                    "factory_id": "not-an-authorized-factory",
                }
            ],
        },
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "scope_not_found"


@pytest.mark.parametrize("scope_column", ["warehouse_id", "factory_id"])
def test_location_scope_grants_do_not_cross_scope_dimensions(
    test_client: TestClient,
    scope_column: str,
) -> None:
    csrf_token = login(
        test_client,
        "location.manager",
        "Test-Location-Manager-123",
    )
    payload = {
        "primary_organization_id": test_client.test_data["organization_id"],
        "username": f"scope-{scope_column}",
        "full_name": "Location Scoped User",
        "password": "Location-Scoped-Password-123",
        "scopes": [
            {
                "organization_id": test_client.test_data["organization_id"],
                scope_column: test_client.test_data[scope_column],
            }
        ],
    }
    response = test_client.post(
        "/api/admin/users",
        headers={"X-CSRF-Token": csrf_token},
        json=payload,
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "scope_denied"


def test_branch_admin_can_only_create_users_within_its_scope(test_client: TestClient) -> None:
    csrf_token = login(
        test_client,
        "location.manager@example.com",
        "Test-Location-Manager-123",
    )
    response = test_client.post(
        "/api/admin/users",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "primary_organization_id": test_client.test_data["organization_id"],
            "username": "branch.user",
            "full_name": "Branch User",
            "password": "Branch-User-Password-123",
            "scopes": [
                {
                    "organization_id": test_client.test_data["organization_id"],
                    "branch_id": test_client.test_data["branch_id"],
                }
            ],
            "roles": [
                {
                    "organization_id": test_client.test_data["organization_id"],
                    "role_id": test_client.test_data["location_operator_role_id"],
                }
            ],
        },
    )
    assert response.status_code == 201


def test_cross_organization_access_is_denied(test_client: TestClient) -> None:
    csrf_token = login(test_client, "admin@example.com", "Test-Admin-Password-123")
    other_organization_id = test_client.test_data["other_organization_id"]
    response = test_client.post(
        "/api/admin/users",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "primary_organization_id": other_organization_id,
            "username": "other-org-user",
            "full_name": "Other Organization User",
            "password": "Other-Organization-Password-123",
            "scopes": [{"organization_id": other_organization_id}],
        },
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "permission_denied"


def test_role_assignment_cannot_escalate_permissions(test_client: TestClient) -> None:
    csrf_token = login(
        test_client,
        "manager@example.com",
        "Test-Manager-Password-123",
    )
    response = test_client.post(
        "/api/admin/users",
        headers={"X-CSRF-Token": csrf_token},
        json={
            "primary_organization_id": test_client.test_data["organization_id"],
            "username": "escalated-user",
            "full_name": "Escalated User",
            "password": "Escalated-User-Password-123",
            "scopes": [{"organization_id": test_client.test_data["organization_id"]}],
            "roles": [
                {
                    "organization_id": test_client.test_data["organization_id"],
                    "role_id": test_client.test_data["admin_role_id"],
                }
            ],
        },
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "role_escalation_denied"


def test_logout_revokes_session_and_audits_sensitive_operation(test_client: TestClient) -> None:
    csrf_token = login(test_client, "admin@example.com", "Test-Admin-Password-123")
    response = test_client.post(
        "/api/auth/logout",
        headers={"X-CSRF-Token": csrf_token},
    )
    assert response.status_code == 204
    assert test_client.get("/api/auth/me").status_code == 401
    with test_client.test_data["session_maker"]() as db:
        assert db.scalar(
            select(AuditEvent.id).where(
                AuditEvent.event_type == "authentication.logout",
                AuditEvent.actor_id == test_client.test_data["admin_id"],
            )
        )


def test_deactivating_user_revokes_existing_sessions(test_client: TestClient) -> None:
    admin_csrf = login(test_client, "admin@example.com", "Test-Admin-Password-123")
    created = test_client.post(
        "/api/admin/users",
        headers={"X-CSRF-Token": admin_csrf},
        json={
            "primary_organization_id": test_client.test_data["organization_id"],
            "username": "deactivated-user",
            "full_name": "Deactivated User",
            "password": "Deactivated-User-Password-123",
            "scopes": [{"organization_id": test_client.test_data["organization_id"]}],
        },
    )
    assert created.status_code == 201
    user_id = created.json()["id"]

    with TestClient(app) as second_client:
        login(second_client, "deactivated-user@example.com", "Deactivated-User-Password-123")
        assert second_client.get("/api/auth/me").status_code == 200
        response = test_client.patch(
            f"/api/admin/users/{user_id}/active",
            params={"organization_id": test_client.test_data["organization_id"]},
            headers={"X-CSRF-Token": admin_csrf},
            json={"is_active": False},
        )
        assert response.status_code == 200
        assert response.json()["is_active"] is False
        assert second_client.get("/api/auth/me").status_code == 401
