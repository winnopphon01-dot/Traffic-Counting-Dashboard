"""Application settings loaded from environment variables.

- APP_ENV      : "development" (default) or "production".
    In production the app FAILS FAST at startup when:
      * DATABASE_URL is not PostgreSQL (prevents accidentally running on
        the fallback SQLite file), or
      * API_KEY is empty (write endpoints must never be unprotected).
- DATABASE_URL : SQLAlchemy connection string.
    * Production (on Docker network `traffic_net`):
        postgresql+psycopg://trafficapp:<DB_PASSWORD>@traffic-postgres:5432/trafficdb
    * Local development fallback:
        sqlite:///./dev.db
- API_KEY      : Shared secret required in the `X-API-Key` header for write
                 endpoints. When empty (development only), authentication is
                 disabled and a warning is logged at startup.

Validation is intentionally done with a plain RuntimeError (not a Pydantic
validator) so that failure messages never echo the DATABASE_URL value, which
contains the database password.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Traffic Counting API"
    app_version: str = "0.1.0"

    app_env: str = "development"

    # Never commit a real password here. See .env.example.
    database_url: str = "sqlite:///./dev.db"
    api_key: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    @property
    def is_production(self) -> bool:
        return self.app_env.strip().lower() == "production"

    @property
    def uses_postgres(self) -> bool:
        # Matches postgres://, postgresql:// and postgresql+psycopg://
        return self.database_url.startswith("postgres")


def _validate_production_settings(settings: Settings) -> None:
    """Fail fast on misconfiguration instead of silently running on SQLite."""
    if not settings.is_production:
        return
    problems: list[str] = []
    if not settings.uses_postgres:
        problems.append(
            "DATABASE_URL must be a PostgreSQL connection string "
            "(postgresql+psycopg://trafficapp:<password>@traffic-postgres:5432/trafficdb)"
        )
    if not settings.api_key:
        problems.append("API_KEY must be set when APP_ENV=production")
    if problems:
        # Do not include settings.database_url/api_key values in the message.
        raise RuntimeError(
            "Invalid production configuration: " + "; ".join(problems)
        )


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    _validate_production_settings(settings)
    return settings
