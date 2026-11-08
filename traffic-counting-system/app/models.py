"""ORM models."""

from datetime import datetime, timezone

from sqlalchemy import DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utcnow() -> datetime:
    """Timezone-aware UTC timestamp (PostgreSQL stores it as TIMESTAMPTZ)."""
    return datetime.now(timezone.utc)


class TrafficEvent(Base):
    """A single counting event reported by the AI engine via Node-RED/API."""

    __tablename__ = "traffic_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    camera_id: Mapped[str] = mapped_column(String(64), nullable=False)
    vehicle_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    non_vehicle_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    person_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    event_time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="api")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    __table_args__ = (
        # Supports filtering by camera and time range efficiently.
        Index("ix_traffic_events_camera_event_time", "camera_id", "event_time"),
    )

    def __repr__(self) -> str:
        return (
            f"<TrafficEvent id={self.id} camera_id={self.camera_id!r} "
            f"event_time={self.event_time}>"
        )
