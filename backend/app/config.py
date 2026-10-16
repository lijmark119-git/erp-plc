from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    APP_NAME: str = "ERP Foundation API"
    APP_ENV: str = "development"
    DEBUG: bool = False
    DATABASE_URL: str = "postgresql+psycopg2://erp_user:replace-with-a-secure-password@localhost:5432/erp_plc"
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"
    API_V1_PREFIX: str = "/api"
    SESSION_COOKIE_NAME: str = "erp_session"
    CSRF_COOKIE_NAME: str = "erp_csrf"
    SESSION_COOKIE_SECURE: bool = False
    SESSION_TTL_HOURS: int = Field(default=8, ge=1, le=168)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @field_validator("CORS_ORIGINS")
    @classmethod
    def require_explicit_cors_origins(cls, value: str) -> str:
        origins = [origin.strip() for origin in value.split(",") if origin.strip()]
        if not origins or "*" in origins:
            raise ValueError("CORS_ORIGINS must contain explicit origins and cannot include '*'.")
        return value

    @model_validator(mode="after")
    def require_secure_production_cookie(self) -> "Settings":
        if self.APP_ENV.lower() == "production" and not self.SESSION_COOKIE_SECURE:
            raise ValueError("SESSION_COOKIE_SECURE must be true in production.")
        return self


settings = Settings()
