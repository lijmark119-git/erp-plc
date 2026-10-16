from fastapi import Request
from sqlalchemy.orm import Session

from app.models import AuditEvent


def record_audit(
    db: Session,
    *,
    event_type: str,
    request: Request,
    actor_id: str | None = None,
    organization_id: str | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    message: str | None = None,
    metadata: dict | None = None,
) -> AuditEvent:
    safe_metadata = dict(metadata or {})
    safe_metadata["ip_address"] = request.client.host if request.client else None
    safe_metadata["user_agent"] = request.headers.get("user-agent", "")[:512]
    event = AuditEvent(
        actor_id=actor_id,
        organization_id=organization_id,
        event_type=event_type,
        resource_type=resource_type,
        resource_id=resource_id,
        message=message,
        event_metadata=safe_metadata,
    )
    db.add(event)
    return event
