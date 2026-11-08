"""Pydantic schemas for request validation and response serialization."""

from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator


def _ensure_utc(value: datetime) -> datetime:
    """Treat naive datetimes as UTC; keep aware datetimes as given."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


class TrafficCreate(BaseModel):
    """Payload accepted by POST /api/traffic."""

    camera_id: str = Field(..., min_length=1, max_length=64)
    vehicle_count: int = Field(..., ge=0)
    non_vehicle_count: int = Field(..., ge=0)
    person_count: int = Field(..., ge=0)
    # Optional: when omitted the database uses the current time.
    event_time: Optional[datetime] = None
    source: str = Field(default="api", min_length=1, max_length=32)

    @field_validator("camera_id")
    @classmethod
    def camera_id_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("camera_id must not be blank")
        return v

    @field_validator("event_time")
    @classmethod
    def normalize_event_time(cls, v: Optional[datetime]) -> Optional[datetime]:
        return _ensure_utc(v) if v is not None else None


class TrafficResponse(BaseModel):
    """Traffic event returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    camera_id: str
    vehicle_count: int
    non_vehicle_count: int
    person_count: int
    event_time: datetime
    source: str
    created_at: datetime

    @field_serializer("event_time", "created_at")
    def _serialize_utc(self, value: datetime) -> datetime:
        """Always emit timezone-aware UTC timestamps.

        SQLite returns naive datetimes (stored values are UTC); PostgreSQL
        TIMESTAMPTZ returns aware values. Normalizing keeps the API contract
        identical on both backends.
        """
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


class CameraInfo(BaseModel):
    camera_id: str
    event_count: int
    last_event_time: Optional[datetime] = None


class HealthResponse(BaseModel):
    status: str
    database: str
    service: str
    version: str


class MessageResponse(BaseModel):
    detail: str
