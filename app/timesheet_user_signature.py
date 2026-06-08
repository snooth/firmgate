"""Per-user default employee signature for timesheets (until cleared)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from flask import current_app


def signatures_dir() -> Path:
    p = Path(current_app.instance_path) / "timesheet_user_signatures"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _path(user_id: int) -> Path:
    return signatures_dir() / f"{user_id}.json"


def get_user_signature(user_id: int) -> dict[str, str]:
    path = _path(user_id)
    if not path.exists():
        return {"image": ""}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"image": ""}
        return {"image": str(data.get("image") or "")}
    except Exception:
        return {"image": ""}


def save_user_signature(user_id: int, image: str) -> dict[str, str]:
    image = str(image or "").strip()
    if image and not image.startswith("data:image/"):
        raise ValueError("invalid signature image")
    if image and len(image) > 700_000:
        raise ValueError("signature image too large")
    body = {
        "image": image,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    _path(user_id).write_text(json.dumps(body, indent=2), encoding="utf-8")
    return {"image": image}
