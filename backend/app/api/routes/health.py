from fastapi import APIRouter

from app.config import settings
from app.database import test_database_connection

router = APIRouter(tags=["health"])


@router.get("/health")
def health_check() -> dict[str, str]:
    return {
        "status": "ok",
        "service": settings.APP_NAME,
        "environment": settings.APP_ENV,
    }


@router.get("/health/ready")
def readiness_check() -> dict[str, object]:
    database_status = test_database_connection()
    return {
        "status": "ready" if database_status["status"] == "connected" else "degraded",
        "database": database_status,
    }
