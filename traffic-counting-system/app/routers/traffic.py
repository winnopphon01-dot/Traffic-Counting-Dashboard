"""Traffic endpoints."""

from datetime import date, datetime, time, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import TrafficEvent
from app.schemas import CameraInfo, TrafficCreate, TrafficResponse

router = APIRouter(prefix="/api", tags=["traffic"])

MAX_HISTORY_LIMIT = 1000
DEFAULT_HISTORY_LIMIT = 100


def require_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    """Guard write endpoints with the X-API-Key header.

    When API_KEY is not configured the check is skipped (development only)
    so the app can be tested without secrets.
    """
    expected = get_settings().api_key
    if expected and x_api_key != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
        )


@router.get("/cameras", response_model=list[CameraInfo])
def list_cameras(db: Session = Depends(get_db)) -> list[CameraInfo]:
    """Cameras that have at least one recorded event."""
    rows = db.execute(
        select(
            TrafficEvent.camera_id,
            func.count(TrafficEvent.id),
            func.max(TrafficEvent.event_time),
        ).group_by(TrafficEvent.camera_id)
    ).all()
    return [
        CameraInfo(
            camera_id=row[0],
            event_count=row[1],
            last_event_time=row[2],
        )
        for row in rows
    ]


@router.post(
    "/traffic",
    response_model=TrafficResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_api_key)],
)
def create_traffic_event(
    payload: TrafficCreate,
    db: Session = Depends(get_db),
) -> TrafficEvent:
    """Record a counting event from the AI engine / Node-RED."""
    event = TrafficEvent(
        camera_id=payload.camera_id,
        vehicle_count=payload.vehicle_count,
        non_vehicle_count=payload.non_vehicle_count,
        person_count=payload.person_count,
        # None -> database default (current time)
        event_time=payload.event_time or None,
        source=payload.source,
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@router.get(
    "/traffic/latest",
    response_model=TrafficResponse,
    dependencies=[Depends(require_api_key)],
)
def get_latest_traffic(
    camera_id: Optional[str] = Query(default=None, min_length=1, max_length=64),
    db: Session = Depends(get_db),
) -> TrafficEvent:
    """Most recent event, optionally filtered by camera."""
    stmt = select(TrafficEvent).order_by(
        TrafficEvent.event_time.desc(), TrafficEvent.id.desc()
    ).limit(1)
    if camera_id:
        stmt = stmt.where(TrafficEvent.camera_id == camera_id)
    event = db.execute(stmt).scalars().first()
    if event is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No traffic data available",
        )
    return event


@router.get(
    "/traffic/history",
    response_model=list[TrafficResponse],
    dependencies=[Depends(require_api_key)],
)
def get_traffic_history(
    camera_id: Optional[str] = Query(default=None, min_length=1, max_length=64),
    start: Optional[datetime] = Query(default=None),
    end: Optional[datetime] = Query(default=None),
    start_date: Optional[date] = Query(default=None),
    end_date: Optional[date] = Query(default=None),
    limit: int = Query(default=DEFAULT_HISTORY_LIMIT, ge=1, le=MAX_HISTORY_LIMIT),
    db: Session = Depends(get_db),
) -> list[TrafficEvent]:
    """Historical events, newest first, with time/camera filters.

    Date-only bounds cover complete UTC calendar days, including end_date.
    """
    stmt = select(TrafficEvent)
    if camera_id:
        stmt = stmt.where(TrafficEvent.camera_id == camera_id)
    if start is not None:
        stmt = stmt.where(TrafficEvent.event_time >= start)
    if start_date is not None:
        start_of_day = datetime.combine(start_date, time.min, tzinfo=timezone.utc)
        stmt = stmt.where(TrafficEvent.event_time >= start_of_day)
    if end is not None:
        stmt = stmt.where(TrafficEvent.event_time <= end)
    if end_date is not None:
        end_of_day = datetime.combine(end_date, time.max, tzinfo=timezone.utc)
        stmt = stmt.where(TrafficEvent.event_time <= end_of_day)
    stmt = (
        stmt.order_by(TrafficEvent.event_time.desc(), TrafficEvent.id.desc()).limit(limit)
    )
    return list(db.execute(stmt).scalars().all())
