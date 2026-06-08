"""Email reminders for unsigned monthly timesheets (Administration → Timesheets → Notifications)."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.branding import portal_shell_name
from app.email_service import send_email
from app.models import User
from app.timesheet_signed import get_signed_timesheet, normalize_month

SETTING_KEY = "timesheet_notifications"

_DEFAULT_SUBJECT = "Reminder: signed timesheet for {month_label}"
_DEFAULT_BODY = """Hi {first_name},

This is a reminder to complete and upload your signed timesheet for {month_label}.

Open Timesheets: {timesheets_url}

Regards,
{portal_name}
"""

_SCHEDULE_ONCE = "once"
_SCHEDULE_INTERVAL = "interval"


def _coerce(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def _sent_log_path() -> Path:
    from flask import current_app

    p = Path(current_app.instance_path) / "timesheet_reminder_sent.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _load_sent_log() -> dict[str, dict[str, str]]:
    path = _sent_log_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
        out: dict[str, dict[str, str]] = {}
        for month, rows in data.items():
            if isinstance(rows, dict):
                out[str(month)] = {str(k): str(v) for k, v in rows.items()}
        return out
    except Exception:
        return {}


def _save_sent_log(data: dict[str, dict[str, str]]) -> None:
    _sent_log_path().write_text(json.dumps(data, indent=2), encoding="utf-8")


def _record_sent(user_id: int, month: str, *, when: datetime | None = None) -> None:
    month = normalize_month(month)
    ts = (when or datetime.now(timezone.utc)).replace(microsecond=0).isoformat()
    log = _load_sent_log()
    bucket = log.setdefault(month, {})
    bucket[str(user_id)] = ts
    _save_sent_log(log)


def _last_sent_at(user_id: int, month: str) -> datetime | None:
    month = normalize_month(month)
    raw = (_load_sent_log().get(month) or {}).get(str(user_id))
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _render_template(template: str, ctx: dict[str, str]) -> str:
    out = template or ""
    for key, val in ctx.items():
        out = out.replace("{" + key + "}", val or "")
    return out


def _timesheets_url() -> str:
    from flask import url_for

    try:
        return url_for("intranet.timesheets_page", _external=True)
    except Exception:
        return "/intranet/timesheets"


def _month_label(month: str) -> str:
    try:
        y, m = normalize_month(month).split("-", 1)
        return date(int(y), int(m), 1).strftime("%B %Y")
    except Exception:
        return month


def _user_display_name(user: User) -> str:
    name = (getattr(user, "full_name", None) or "").strip()
    if name:
        return name
    return (user.username or user.email or f"User {user.id}").strip()


def _user_first_name(user: User) -> str:
    attrs = user.attributes if isinstance(getattr(user, "attributes", None), dict) else {}
    fn = str(attrs.get("first_name") or "").strip()
    if fn:
        return fn
    display = _user_display_name(user)
    return display.split()[0] if display else ""


def _user_email(user: User) -> str:
    for candidate in (user.email, user.username):
        addr = str(candidate or "").strip()
        if addr and "@" in addr:
            return addr
    return ""


def _active_users_with_email() -> list[User]:
    from app.extensions import db

    rows = (
        db.session.query(User)
        .filter(User.is_active.is_(True))
        .order_by(User.full_name.asc(), User.username.asc())
        .all()
    )
    seen: set[str] = set()
    out: list[User] = []
    for user in rows:
        email = _user_email(user).lower()
        if not email or email in seen:
            continue
        seen.add(email)
        out.append(user)
    return out


def users_missing_signed_timesheet(month: str) -> list[User]:
    month = normalize_month(month)
    missing: list[User] = []
    for user in _active_users_with_email():
        if not get_signed_timesheet(user.id, month):
            missing.append(user)
    return missing


def get_notification_settings() -> dict[str, Any]:
    from app.settings import get_setting

    v = _coerce(get_setting(SETTING_KEY, default={}))
    mode = str(v.get("schedule_mode") or _SCHEDULE_ONCE).strip().lower()
    if mode not in (_SCHEDULE_ONCE, _SCHEDULE_INTERVAL):
        mode = _SCHEDULE_ONCE
    try:
        once_day = int(v.get("once_day_of_month") or 25)
    except (TypeError, ValueError):
        once_day = 25
    once_day = max(1, min(28, once_day))
    try:
        interval_days = int(v.get("interval_days") or 7)
    except (TypeError, ValueError):
        interval_days = 7
    interval_days = max(1, min(90, interval_days))
    try:
        send_hour = int(v.get("send_hour_local") if v.get("send_hour_local") is not None else 9)
    except (TypeError, ValueError):
        send_hour = 9
    send_hour = max(0, min(23, send_hour))
    return {
        "enabled": bool(v.get("enabled")),
        "schedule_mode": mode,
        "once_day_of_month": once_day,
        "interval_days": interval_days,
        "send_hour_local": send_hour,
        "subject": (v.get("subject") or _DEFAULT_SUBJECT).strip(),
        "body": (v.get("body") or _DEFAULT_BODY).strip(),
        "last_run_at": str(v.get("last_run_at") or "").strip(),
        "last_run_summary": v.get("last_run_summary") if isinstance(v.get("last_run_summary"), dict) else {},
    }


def notification_settings_for_api() -> dict[str, Any]:
    s = get_notification_settings()
    return {
        **s,
        "placeholders": [
            "{first_name}",
            "{display_name}",
            "{email}",
            "{month}",
            "{month_label}",
            "{timesheets_url}",
            "{portal_name}",
        ],
        "defaults": {
            "subject": _DEFAULT_SUBJECT,
            "body": _DEFAULT_BODY,
        },
    }


def save_notification_settings(payload: dict[str, Any]) -> dict[str, Any] | tuple[dict[str, str], int]:
    from app.settings import get_setting, set_setting

    cur = _coerce(get_setting(SETTING_KEY, default={}))
    enabled = bool(payload.get("enabled"))
    mode = str(payload.get("schedule_mode") or _SCHEDULE_ONCE).strip().lower()
    if mode not in (_SCHEDULE_ONCE, _SCHEDULE_INTERVAL):
        mode = _SCHEDULE_ONCE
    try:
        once_day = int(payload.get("once_day_of_month") or 25)
    except (TypeError, ValueError):
        once_day = 25
    once_day = max(1, min(28, once_day))
    try:
        interval_days = int(payload.get("interval_days") or 7)
    except (TypeError, ValueError):
        interval_days = 7
    interval_days = max(1, min(90, interval_days))
    try:
        send_hour = int(payload.get("send_hour_local") if payload.get("send_hour_local") is not None else 9)
    except (TypeError, ValueError):
        send_hour = 9
    send_hour = max(0, min(23, send_hour))
    subject = (payload.get("subject") or _DEFAULT_SUBJECT).strip()[:500]
    body = (payload.get("body") or _DEFAULT_BODY).strip()[:20000]

    nxt = dict(cur)
    nxt.update(
        {
            "enabled": enabled,
            "schedule_mode": mode,
            "once_day_of_month": once_day,
            "interval_days": interval_days,
            "send_hour_local": send_hour,
            "subject": subject,
            "body": body,
        }
    )
    set_setting(SETTING_KEY, nxt)
    return notification_settings_for_api()


def build_template_context(user: User, month: str) -> dict[str, str]:
    month = normalize_month(month)
    return {
        "first_name": _user_first_name(user),
        "display_name": _user_display_name(user),
        "email": _user_email(user),
        "month": month,
        "month_label": _month_label(month),
        "timesheets_url": _timesheets_url(),
        "portal_name": portal_shell_name(),
    }


def sample_template_context() -> dict[str, str]:
    return {
        "first_name": "Alex",
        "display_name": "Alex Example",
        "email": "alex@example.com",
        "month": "2026-06",
        "month_label": "June 2026",
        "timesheets_url": _timesheets_url(),
        "portal_name": portal_shell_name(),
    }


def _local_now() -> datetime:
    import zoneinfo

    from app.settings import get_setting

    cfg = get_setting("time", default={}) or {}
    tz_name = str(cfg.get("timezone") or "Australia/Melbourne").strip() or "Australia/Melbourne"
    try:
        tz = zoneinfo.ZoneInfo(tz_name)
    except Exception:
        tz = zoneinfo.ZoneInfo("Australia/Melbourne")
    return datetime.now(tz)


def _should_send_for_schedule(settings: dict[str, Any], *, now: datetime | None = None) -> bool:
    now = now or _local_now()
    if now.hour < int(settings.get("send_hour_local") or 9):
        return False
    mode = settings.get("schedule_mode") or _SCHEDULE_ONCE
    if mode == _SCHEDULE_ONCE:
        target_day = int(settings.get("once_day_of_month") or 25)
        return now.day == target_day
    return True


def _eligible_for_reminder(user: User, month: str, settings: dict[str, Any], *, force: bool = False) -> bool:
    if force:
        return True
    last = _last_sent_at(user.id, month)
    if not last:
        return True
    mode = settings.get("schedule_mode") or _SCHEDULE_ONCE
    if mode == _SCHEDULE_ONCE:
        return False
    interval = int(settings.get("interval_days") or 7)
    return datetime.now(timezone.utc) - last.astimezone(timezone.utc) >= timedelta(days=interval)


def send_reminder_to_user(user: User, month: str, settings: dict[str, Any] | None = None) -> tuple[bool, str]:
    settings = settings or get_notification_settings()
    email = _user_email(user)
    if not email:
        return False, "No email address."
    ctx = build_template_context(user, month)
    subject = _render_template(settings["subject"], ctx)[:500]
    body = _render_template(settings["body"], ctx)
    ok, msg = send_email(to_addrs=[email], subject=subject, body=body)
    if ok:
        _record_sent(user.id, month)
    return ok, msg


def send_test_reminder(*, to_addr: str) -> tuple[bool, str]:
    addr = str(to_addr or "").strip()
    if not addr or "@" not in addr:
        return False, "Enter a valid email address."
    settings = get_notification_settings()
    ctx = sample_template_context()
    ctx["email"] = addr
    subject = _render_template(settings["subject"], ctx)[:500]
    body = _render_template(settings["body"], ctx)
    return send_email(to_addrs=[addr], subject=subject, body=body)


def _current_month() -> str:
    now = _local_now()
    return f"{now.year:04d}-{now.month:02d}"


def _timesheets_available() -> bool:
    try:
        from app.community_edition import community_module_available

        return bool(community_module_available("timesheets"))
    except Exception:
        return True


def run_timesheet_reminders(*, force: bool = False) -> dict[str, Any]:
    """Send reminder emails to users missing a signed timesheet for the current month."""
    from app.settings import get_setting, set_setting

    settings = get_notification_settings()
    result: dict[str, Any] = {
        "ok": True,
        "skipped": None,
        "month": _current_month(),
        "sent": 0,
        "failed": 0,
        "messages": [],
    }

    if not _timesheets_available():
        result["skipped"] = "timesheets_not_licensed"
        return result
    if not settings.get("enabled") and not force:
        result["skipped"] = "disabled"
        return result
    if not force and not _should_send_for_schedule(settings):
        result["skipped"] = "not_scheduled"
        return result

    month = _current_month()
    pending = users_missing_signed_timesheet(month)
    for user in pending:
        if not _eligible_for_reminder(user, month, settings, force=force):
            continue
        ok, msg = send_reminder_to_user(user, month, settings)
        if ok:
            result["sent"] += 1
        else:
            result["failed"] += 1
            result["messages"].append(f"{_user_email(user) or user.id}: {msg}")

    summary = {
        "month": month,
        "sent": result["sent"],
        "failed": result["failed"],
        "pending": len(pending),
        "forced": bool(force),
        "at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }
    cur = _coerce(get_setting(SETTING_KEY, default={}))
    cur["last_run_at"] = summary["at"]
    cur["last_run_summary"] = summary
    set_setting(SETTING_KEY, cur)
    result["summary"] = summary
    if result["failed"]:
        result["ok"] = False
    return result


def run_scheduled_timesheet_reminders() -> dict[str, Any]:
    return run_timesheet_reminders(force=False)
