"""Per-user signed timesheet PDF uploads (instance storage)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from flask import current_app
from werkzeug.utils import secure_filename


def signed_timesheets_dir() -> Path:
    p = Path(current_app.instance_path) / "timesheet_signed"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _meta_path() -> Path:
    return signed_timesheets_dir() / "index.json"


def _load_meta() -> dict:
    path = _meta_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_meta(data: dict) -> None:
    _meta_path().write_text(json.dumps(data, indent=2), encoding="utf-8")


def normalize_month(month: str) -> str:
    m = str(month or "").strip()[:7]
    if len(m) != 7 or m[4] != "-":
        raise ValueError("month must be YYYY-MM")
    y, mo = m.split("-")
    if not (y.isdigit() and mo.isdigit()):
        raise ValueError("month must be YYYY-MM")
    yi, mi = int(y), int(mo)
    if yi < 2000 or yi > 2100 or mi < 1 or mi > 12:
        raise ValueError("month out of range")
    return m


def _entry_key(user_id: int, month: str) -> str:
    return f"{user_id}:{normalize_month(month)}"


def signed_storage_name(user_id: int, month: str) -> str:
    return f"{user_id}_{normalize_month(month).replace('-', '')}.pdf"


def get_signed_timesheet(user_id: int, month: str) -> dict | None:
    key = _entry_key(user_id, month)
    meta = _load_meta().get(key)
    if not isinstance(meta, dict):
        return None
    fname = str(meta.get("stored_name") or "").strip()
    if not fname:
        return None
    path = signed_timesheets_dir() / fname
    if not path.exists():
        return None
    return {
        "month": normalize_month(month),
        "original_name": str(meta.get("original_name") or fname),
        "uploaded_at": str(meta.get("uploaded_at") or ""),
        "stored_name": fname,
    }


def save_signed_timesheet(user_id: int, month: str, file_storage, original_name: str) -> dict:
    stored = signed_storage_name(user_id, month)
    dest = signed_timesheets_dir() / stored
    file_storage.save(str(dest))
    key = _entry_key(user_id, month)
    meta = _load_meta()
    safe_original = secure_filename(original_name) or stored
    meta[key] = {
        "stored_name": stored,
        "original_name": safe_original,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    _save_meta(meta)
    out = get_signed_timesheet(user_id, month)
    if not out:
        raise RuntimeError("Could not save signed timesheet.")
    return out


def delete_signed_timesheet(user_id: int, month: str) -> bool:
    """Delete signed PDF and index entry for user/month. Returns True if removed."""
    month = normalize_month(month)
    key = _entry_key(user_id, month)
    meta = _load_meta()
    entry = meta.get(key)
    if not isinstance(entry, dict):
        return False
    fname = str(entry.get("stored_name") or "").strip()
    meta.pop(key, None)
    _save_meta(meta)
    if fname:
        path = signed_timesheets_dir() / fname
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass
    return True


def signed_file_path(user_id: int, month: str) -> Path | None:
    info = get_signed_timesheet(user_id, month)
    if not info:
        return None
    path = signed_timesheets_dir() / info["stored_name"]
    return path if path.exists() else None


def list_all_signed_timesheets() -> list[dict]:
    """All signed PDF uploads indexed by user and month."""
    meta = _load_meta()
    out: list[dict] = []
    for key, entry in meta.items():
        if not isinstance(entry, dict):
            continue
        try:
            user_id_s, month = str(key).split(":", 1)
            user_id = int(user_id_s)
            month = normalize_month(month)
        except (ValueError, AttributeError):
            continue
        fname = str(entry.get("stored_name") or "").strip()
        if not fname:
            continue
        path = signed_timesheets_dir() / fname
        if not path.exists():
            continue
        out.append(
            {
                "user_id": user_id,
                "month": month,
                "original_name": str(entry.get("original_name") or fname),
                "uploaded_at": str(entry.get("uploaded_at") or ""),
            }
        )
    out.sort(key=lambda r: (r["month"], r["user_id"]), reverse=True)
    return out
