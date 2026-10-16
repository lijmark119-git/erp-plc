import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.routes.administration import router as administration_router
from app.api.routes.authentication import router as authentication_router
from app.api.routes.dashboard import router as dashboard_router
from app.api.routes.health import router as health_router
from app.api.routes.finance import router as finance_router
from app.api.routes.hr import router as hr_router
from app.api.routes.inventory import router as inventory_router
from app.api.routes.procurement import router as procurement_router
from app.api.routes.sales import router as sales_router
from app.api.routes.social_impact import router as social_impact_router
from app.config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

app = FastAPI(
    title=settings.APP_NAME,
    version="0.1.0",
    description="Security-first ERP foundation API for the Manufacturing and General Trading PLC project.",
    debug=settings.DEBUG,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.CORS_ORIGINS.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix=settings.API_V1_PREFIX)
app.include_router(authentication_router, prefix=f"{settings.API_V1_PREFIX}/auth")
app.include_router(dashboard_router, prefix=settings.API_V1_PREFIX)
app.include_router(administration_router, prefix=settings.API_V1_PREFIX)
app.include_router(inventory_router, prefix=settings.API_V1_PREFIX)
app.include_router(procurement_router, prefix=settings.API_V1_PREFIX)
app.include_router(sales_router, prefix=settings.API_V1_PREFIX)
app.include_router(finance_router, prefix=settings.API_V1_PREFIX)
app.include_router(hr_router, prefix=settings.API_V1_PREFIX)
app.include_router(social_impact_router, prefix=settings.API_V1_PREFIX)


@app.get("/")
def root() -> dict[str, str]:
    return {"message": "ERP foundation API is running"}


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict):
        error = detail
    else:
        error = {"code": "request_failed", "message": str(detail)}
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": error},
        headers=exc.headers,
    )


@app.middleware("http")
async def security_response_headers(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.url.path.startswith(f"{settings.API_V1_PREFIX}/auth"):
        response.headers["Cache-Control"] = "no-store"
    return response
