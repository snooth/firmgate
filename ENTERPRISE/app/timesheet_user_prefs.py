"""Per-user timesheet preferences (e.g. home state for public holidays)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from flask import current_app

from app.timesheet_holidays import DEFAULT_TIMESHEET_STATE, normalize_state


def prefs_dir() -> Path:
    p = Path(current_app.instance_path) / "timesheet_user_prefs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _path(user_id: int) -> Path:
    return prefs_dir() / f"{user_id}.json"


def get_user_prefs(user_id: int) -> dict[str, str]:
    path = _path(user_id)
    if not path.exists():
        return {"state": DEFAULT_TIMESHEET_STATE}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"state": DEFAULT_TIMESHEET_STATE}
        state = normalize_state(str(data.get("state") or "")) or DEFAULT_TIMESHEET_STATE
        return {"state": state}
    except Exception:
        return {"state": DEFAULT_TIMESHEET_STATE}


def save_user_prefs(user_id: int, state: str) -> dict[str, str]:
    normalized = normalize_state(state)
    if not normalized:
        raise ValueError("invalid state")
    body = {
        "state": normalized,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _path(user_id).write_text(json.dumps(body, indent=2), encoding="utf-8")
    return {"state": normalized}
