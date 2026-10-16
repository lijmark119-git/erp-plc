from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import record_audit
from app.auth import AuthContext, get_current_auth, normalize_username
from app.config import settings
from app.database import get_db
from app.models import User, UserSession
from app.security import create_secret_token, hash_password, hash_token, verify_password

router = APIRouter(tags=["authentication"])

MAX_LOGIN_ATTEMPTS = 10
LOCKOUT_MINUTES = 15


class LoginRequest(BaseModel):
    username: str = Field(
        min_length=1,
        max_length=254,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._%+@\-]*$",
    )
    password: str = Field(min_length=1, max_length=256)


class LoginResponse(BaseModel):
    csrf_token: str
    user_id: str
    full_name: str


@router.post("/login", response_model=LoginResponse)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> LoginResponse:
    username = normalize_username(body.username)
    user = db.scalar(select(User).where(User.username == username).with_for_update())
    now = datetime.now(timezone.utc)
    lock_until = user.locked_until if user else None
    if lock_until is not None and lock_until.tzinfo is None:
        lock_until = lock_until.replace(tzinfo=timezone.utc)
    locked = lock_until is not None and lock_until > now
    password_valid = verify_password(body.password, user.password_hash if user else None)

    if user is None or not user.is_active or locked or not password_valid:
        if user is not None:
            user.failed_login_attempts += 1
            if user.failed_login_attempts >= MAX_LOGIN_ATTEMPTS and not locked:
                user.locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
        record_audit(
            db,
            event_type="authentication.login_failed",
            request=request,
            actor_id=None,
            organization_id=user.organization_id if user else None,
            resource_type="user" if user else None,
            resource_id=user.id if user else None,
            message="Login attempt rejected.",
            metadata={"outcome": "rejected"},
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials", "message": "Username or password is incorrect."},
            headers={"WWW-Authenticate": "Session"},
        )

    user.failed_login_attempts = 0
    user.locked_until = None
    session_token = create_secret_token()
    csrf_token = create_secret_token()
    session = UserSession(
        user_id=user.id,
        token_hash=hash_token(session_token),
        csrf_token_hash=hash_token(csrf_token),
        expires_at=now + timedelta(hours=settings.SESSION_TTL_HOURS),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:512],
    )
    db.add(session)
    db.flush()
    record_audit(
        db,
        event_type="authentication.login_succeeded",
        request=request,
        actor_id=user.id,
        organization_id=user.organization_id,
        resource_type="user_session",
        resource_id=session.id,
        metadata={"outcome": "accepted"},
    )
    db.commit()
    response.set_cookie(
        key=settings.SESSION_COOKIE_NAME,
        value=session_token,
        max_age=settings.SESSION_TTL_HOURS * 60 * 60,
        httponly=True,
        secure=settings.SESSION_COOKIE_SECURE or settings.APP_ENV.lower() == "production",
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        key=settings.CSRF_COOKIE_NAME,
        value=csrf_token,
        max_age=settings.SESSION_TTL_HOURS * 60 * 60,
        httponly=False,
        secure=settings.SESSION_COOKIE_SECURE or settings.APP_ENV.lower() == "production",
        samesite="lax",
        path="/",
    )
    return LoginResponse(csrf_token=csrf_token, user_id=user.id, full_name=user.full_name)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    response: Response,
    auth: AuthContext = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> Response:
    now = datetime.now(timezone.utc)
    auth.session.revoked_at = now
    record_audit(
        db,
        event_type="authentication.logout",
        request=request,
        actor_id=auth.user.id,
        resource_type="user_session",
        resource_id=auth.session.id,
    )
    db.commit()
    response.delete_cookie(
        key=settings.SESSION_COOKIE_NAME,
        httponly=True,
        secure=settings.SESSION_COOKIE_SECURE or settings.APP_ENV.lower() == "production",
        samesite="lax",
        path="/",
    )
    response.delete_cookie(
        key=settings.CSRF_COOKIE_NAME,
        httponly=False,
        secure=settings.SESSION_COOKIE_SECURE or settings.APP_ENV.lower() == "production",
        samesite="lax",
        path="/",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me")
def current_user(auth: AuthContext = Depends(get_current_auth)) -> dict:
    return {
        "id": auth.user.id,
        "username": auth.user.username,
        "full_name": auth.user.full_name,
        "permissions": {
            organization_id: sorted(permission_codes)
            for organization_id, permission_codes in auth.permissions_by_organization.items()
        },
        "scopes": [
            {
                "organization_id": grant.organization_id,
                "branch_id": grant.branch_id,
                "warehouse_id": grant.warehouse_id,
                "factory_id": grant.factory_id,
            }
            for grant in auth.grants
        ],
    }
