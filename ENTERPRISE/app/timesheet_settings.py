"""Timesheet PDF branding: company details and logo (Administration settings)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flask import current_app

from app.settings import get_setting, set_setting

SETTING_KEY = "timesheets"
TIMESHEET_LOGO_URL = "/admin/timesheets/logo"


def _cfg(raw: Any | None = None) -> dict[str, Any]:
    if raw is None:
        raw = get_setting(SETTING_KEY, default={}) or {}
    return dict(raw) if isinstance(raw, dict) else {}


def timesheet_branding_dir() -> Path:
    p = Path(current_app.instance_path) / "timesheet_branding"
    p.mkdir(parents=True, exist_ok=True)
    return p


def get_timesheet_settings() -> dict[str, Any]:
    cfg = _cfg()
    logo_name = str(cfg.get("logo_name") or "").strip()
    logo_url = TIMESHEET_LOGO_URL if logo_name else ""
    return {
        "company_line_1": str(cfg.get("company_line_1") or "").strip(),
        "company_line_2": str(cfg.get("company_line_2") or "").strip(),
        "company_line_3": str(cfg.get("company_line_3") or "").strip(),
        "logo_name": logo_name,
        "logo_url": logo_url,
    }


def company_lines_from_settings(cfg: dict[str, Any] | None = None) -> list[str]:
    v = _cfg(cfg)
    lines = [
        str(v.get("company_line_1") or "").strip(),
        str(v.get("company_line_2") or "").strip(),
        str(v.get("company_line_3") or "").strip(),
    ]
    return [x for x in lines if x]


def timesheet_logo_path(cfg: dict[str, Any] | None = None) -> Path | None:
    v = _cfg(cfg)
    name = str(v.get("logo_name") or "").strip()
    if not name:
        return None
    path = timesheet_branding_dir() / name
    return path if path.exists() else None


def timesheet_settings_for_pdf() -> dict[str, Any]:
    cfg = get_timesheet_settings()
    return {
        "company_lines": company_lines_from_settings(cfg),
        "logo_path": timesheet_logo_path(cfg),
    }


def persist_timesheet_settings(payload: dict[str, Any]) -> dict[str, Any]:
    cur = _cfg()
    nxt = dict(cur)
    nxt["company_line_1"] = str(payload.get("company_line_1") or "").strip()[:240]
    nxt["company_line_2"] = str(payload.get("company_line_2") or "").strip()[:240]
    nxt["company_line_3"] = str(payload.get("company_line_3") or "").strip()[:240]
    if "logo_name" in cur:
        nxt["logo_name"] = cur.get("logo_name")
    set_setting(SETTING_KEY, nxt)
    return get_timesheet_settings()


def set_timesheet_logo_name(filename: str) -> dict[str, Any]:
    cur = _cfg()
    nxt = dict(cur)
    nxt["logo_name"] = filename
    set_setting(SETTING_KEY, nxt)
    return get_timesheet_settings()
