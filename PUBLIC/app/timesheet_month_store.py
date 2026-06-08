"""Per-user timesheet drafts and exported PDFs keyed by month."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import current_app

from app.timesheet_signed import get_signed_timesheet, normalize_month


def _store_dir(name: str) -> Path:
    p = Path(current_app.instance_path) / name
    p.mkdir(parents=True, exist_ok=True)
    return p


def drafts_dir() -> Path:
    return _store_dir("timesheet_drafts")


def exports_dir() -> Path:
    return _store_dir("timesheet_exports")


def _meta_path(kind: str) -> Path:
    folder = drafts_dir() if kind == "draft" else exports_dir()
    return folder / "index.json"


def _load_meta(kind: str) -> dict:
    path = _meta_path(kind)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_meta(kind: str, data: dict) -> None:
    _meta_path(kind).write_text(json.dumps(data, indent=2), encoding="utf-8")


def _entry_key(user_id: int, month: str) -> str:
    return f"{user_id}:{normalize_month(month)}"


def _storage_name(user_id: int, month: str, ext: str) -> str:
    return f"{user_id}_{normalize_month(month).replace('-', '')}.{ext}"


def _month_from_payload(payload: dict[str, Any]) -> str:
    month = str(payload.get("month") or "").strip()[:7]
    if month:
        return normalize_month(month)
    period_start = str(payload.get("period_start") or "").strip()[:7]
    if period_start:
        return normalize_month(period_start)
    raise ValueError("month is required")


def _normalize_draft_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Align row holiday flags and project labels with the selected state."""
    from app.timesheet_holidays import holiday_name, is_weekend, normalize_state, parse_iso_date

    out = dict(payload)
    state = normalize_state(str(out.get("state") or ""))
    rows_in = out.get("rows")
    if not isinstance(rows_in, list):
        return out

    default_project = str(out.get("default_project") or "").strip()
    rows_out: list[dict[str, Any]] = []
    for raw in rows_in:
        if not isinstance(raw, dict):
            continue
        row = dict(raw)
        d = parse_iso_date(str(row.get("date") or ""))
        hol_label = holiday_name(d, state=state) if d else ""
        if d:
            row["is_weekend"] = is_weekend(d)

        if hol_label:
            override = bool(row.get("holiday_override"))
            consultant = str(row.get("consultant") or "").strip()
            role = str(row.get("role") or "").strip()
            hours = str(row.get("hours") or "").strip()
            has_work = bool(consultant or role or hours)
            if override or has_work:
                row["is_holiday"] = False
                row["holiday_override"] = True
                if not consultant and not role and not hours:
                    row["project"] = str(row.get("project") or default_project).strip()
            else:
                row["is_holiday"] = True
                row["holiday_override"] = False
                row["project"] = hol_label
                row["consultant"] = ""
                row["role"] = ""
                row["hours"] = ""
        else:
            row["is_holiday"] = False
            row.pop("holiday_override", None)
            consultant = str(row.get("consultant") or "").strip()
            role = str(row.get("role") or "").strip()
            hours = str(row.get("hours") or "").strip()
            project = str(row.get("project") or "").strip()
            if not consultant and not role and not hours and project:
                row["project"] = default_project
        rows_out.append(row)

    out["rows"] = rows_out
    return out


def save_month_draft(user_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    month = _month_from_payload(payload)
    key = _entry_key(user_id, month)
    stored = _storage_name(user_id, month, "json")
    payload = _normalize_draft_payload(payload)
    body = {
        "month": month,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
    (drafts_dir() / stored).write_text(json.dumps(body, indent=2), encoding="utf-8")
    meta = _load_meta("draft")
    meta[key] = {"stored_name": stored, "month": month, "saved_at": body["saved_at"]}
    _save_meta("draft", meta)
    return body


def get_month_draft(user_id: int, month: str) -> dict[str, Any] | None:
    key = _entry_key(user_id, month)
    meta = _load_meta("draft").get(key)
    if not isinstance(meta, dict):
        return None
    fname = str(meta.get("stored_name") or "").strip()
    if not fname:
        return None
    path = drafts_dir() / fname
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        payload = data.get("payload")
        if isinstance(payload, dict):
            data["payload"] = _normalize_draft_payload(payload)
        return data
    except Exception:
        return None


def save_month_export(user_id: int, month: str, pdf_bytes: bytes, filename: str) -> dict[str, Any]:
    month = normalize_month(month)
    key = _entry_key(user_id, month)
    stored = _storage_name(user_id, month, "pdf")
    (exports_dir() / stored).write_bytes(pdf_bytes)
    saved_at = datetime.now(timezone.utc).isoformat()
    meta = _load_meta("export")
    meta[key] = {
        "stored_name": stored,
        "month": month,
        "filename": filename,
        "saved_at": saved_at,
    }
    _save_meta("export", meta)
    return {"month": month, "filename": filename, "saved_at": saved_at, "stored_name": stored}


def get_month_export(user_id: int, month: str) -> dict[str, Any] | None:
    key = _entry_key(user_id, month)
    meta = _load_meta("export").get(key)
    if not isinstance(meta, dict):
        return None
    fname = str(meta.get("stored_name") or "").strip()
    if not fname:
        return None
    path = exports_dir() / fname
    if not path.exists():
        return None
    return {
        "month": normalize_month(month),
        "filename": str(meta.get("filename") or fname),
        "saved_at": str(meta.get("saved_at") or ""),
        "stored_name": fname,
    }


def export_file_path(user_id: int, month: str) -> Path | None:
    info = get_month_export(user_id, month)
    if not info:
        return None
    path = exports_dir() / info["stored_name"]
    return path if path.exists() else None


def month_state(user_id: int, month: str) -> dict[str, Any]:
    month = normalize_month(month)
    draft = get_month_draft(user_id, month)
    export = get_month_export(user_id, month)
    signed = get_signed_timesheet(user_id, month)
    return {
        "month": month,
        "draft": draft.get("payload") if isinstance(draft, dict) else None,
        "draft_saved_at": draft.get("saved_at") if isinstance(draft, dict) else "",
        "export": export,
        "signed": signed,
    }
