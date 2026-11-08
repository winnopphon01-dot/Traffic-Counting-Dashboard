"""Database engine, session factory and FastAPI dependency.

The engine is built from the DATABASE_URL environment variable so the same
code works with PostgreSQL in production (psycopg driver) and with SQLite for
local development/tests. No SQL is ever composed from user input; all queries
go through the SQLAlchemy ORM with bound parameters.
"""

from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings

settings = get_settings()

_is_sqlite = settings.database_url.startswith("sqlite")

# SQLite needs check_same_thread=False when FastAPI runs with multiple
# worker threads; PostgreSQL (psycopg) does not accept this argument.
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine: Engine = create_engine(
    settings.database_url,
    connect_args=_connect_args,
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that provides a scoped session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_database() -> bool:
    """Return True when the database answers `SELECT 1`."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


def init_db() -> None:
    """Create tables that do not exist yet.

    checkfirst=True makes this idempotent and it never drops or alters
    existing tables (e.g. the temporary `setup_test` table on the VPS).
    """
    # Import models so they are registered on Base.metadata before create_all.
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine, checkfirst=True)
