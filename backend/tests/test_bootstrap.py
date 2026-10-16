import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import bootstrap
from app.database import Base
from app.models import (
    Permission,
    Role,
    RolePermission,
    SetupState,
    User,
    UserRoleAssignment,
    UserScopeGrant,
)


def test_explicit_bootstrap_creates_hashed_admin_once(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    test_session_maker = sessionmaker(bind=engine, expire_on_commit=False)
    with test_session_maker.begin() as db:
        db.add(SetupState(id=1, bootstrap_complete=False))
    monkeypatch.setattr(bootstrap, "SessionLocal", test_session_maker)

    user_id = bootstrap.bootstrap_admin(
        organization_code="CONFIRMED-CODE",
        organization_name="Confirmed Organization",
        username="Initial.Admin",
        full_name="Initial Administrator",
        password="Interactive-Password-123",
    )
    with test_session_maker() as db:
        user = db.get(User, user_id)
        assert user is not None
        assert user.username == "initial.admin"
        assert user.password_hash != "Interactive-Password-123"
        assert user.password_hash.startswith("$argon2")
        assert db.scalar(select(Role.id).where(Role.organization_id == user.organization_id))
        assert db.scalar(select(UserRoleAssignment.user_id).where(UserRoleAssignment.user_id == user_id))
        assert db.scalar(select(UserScopeGrant.user_id).where(UserScopeGrant.user_id == user_id))
        assert db.scalar(select(Permission.id))
        assert db.scalar(select(RolePermission.role_id))
        assert db.get(SetupState, 1).bootstrap_complete is True

    with pytest.raises(RuntimeError, match="only allowed once"):
        bootstrap.bootstrap_admin(
            organization_code="OTHER-CODE",
            organization_name="Another Organization",
            username="second.admin",
            full_name="Second Administrator",
            password="Interactive-Password-123",
        )
    engine.dispose()


def test_bootstrap_rejects_short_password() -> None:
    with pytest.raises(ValueError, match="at least 12"):
        bootstrap.bootstrap_admin(
            organization_code="CODE",
            organization_name="Organization",
            username="admin",
            full_name="Administrator",
            password="short",
        )


def test_bootstrap_rejects_invalid_username() -> None:
    with pytest.raises(ValueError, match="Bootstrap username"):
        bootstrap.bootstrap_admin(
            organization_code="CODE",
            organization_name="Organization",
            username="invalid username",
            full_name="Administrator",
            password="Long-Enough-Password-123",
        )
