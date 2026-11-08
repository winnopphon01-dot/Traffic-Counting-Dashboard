"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.database import check_database, init_db
from app.routers import traffic
from app.schemas import HealthResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("traffic-api")

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create traffic_events if missing; never drops existing tables.
    # Fail startup if database schema initialization fails.
    init_db()
    logger.info("Database schema initialized (checkfirst=True)")

    if not settings.api_key:
        logger.warning(
            "API_KEY is not set - write endpoints are unprotected. "
            "Only acceptable for local development."
        )
    logger.info("APP_ENV=%s", settings.app_env)
    if not settings.is_production and not settings.uses_postgres:
        logger.warning(
            "DATABASE_URL is not PostgreSQL - running in development mode (SQLite)."
        )
    yield


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
)

app.include_router(traffic.router)


@app.get("/", tags=["service"])
def read_root() -> dict:
    """Basic service information."""
    return {
        "service": settings.app_name,
        "version": settings.app_version,
        "docs": "/docs",
        "health": "/health",
    }


@app.get(
    "/health",
    response_model=HealthResponse,
    tags=["service"],
    responses={503: {"model": HealthResponse}},
)
def health() -> JSONResponse:
    """Liveness/readiness probe: checks that the database answers."""
    db_ok = check_database()
    body = HealthResponse(
        status="ok" if db_ok else "degraded",
        database="connected" if db_ok else "unavailable",
        service=settings.app_name,
        version=settings.app_version,
    )
    code = (
        status.HTTP_200_OK
        if db_ok
        else status.HTTP_503_SERVICE_UNAVAILABLE
    )
    return JSONResponse(content=body.model_dump(), status_code=code)


@app.exception_handler(Exception)
async def unhandled_exception_handler(
    request: Request, exc: Exception
) -> JSONResponse:
    """Never leak internals (stack traces, connection strings) to clients."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )
