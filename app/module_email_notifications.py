"""Configurable email reminders for portal modules (Administration → Email Notification)."""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.email_service import send_email
from app.models import User

SETTING_KEY = "module_email_notifications"

MODULE_ORDER = (
    "events",
    "wiki",
    "team_chat",
    "workforce",
    "security_training",
)

_MODULE_DEFAULTS: dict[str, dict[str, Any]] = {
    "events": {
        "enabled": False,
        "reminder_days": [1, 7],
        "send_hour_local": 9,
        "subject": "{portal_name}: Event reminder — {event_title} on {event_date_label}",
        "body": """Hi {first_name},

Reminder: "{event_title}" is on {event_date_label}{event_time_label}.
{event_location_line}

Open Events: {events_url}

Regards,
{portal_name}
""",
    },
    "wiki": {
        "enabled": False,
        "subject": '{portal_name}: Wiki updated — "{page_title}"',
        "body": """Hi {first_name},

The wiki page "{page_title}" was updated by {editor_name}.

View page: {page_url}

Regards,
{portal_name}
""",
    },
    "team_chat": {
        "enabled": False,
        "send_hour_local": 9,
        "subject": "{portal_name}: You have unread Team Chat messages",
        "body": """Hi {first_name},

You have {unread_count} unread Team Chat message(s).

Open Team Chat: {team_chat_url}

Regards,
{portal_name}
""",
    },
    "workforce": {
        "enabled": True,
        "reminder_days": [30, 7, 1],
        "send_hour_local": 9,
        "subject": "{portal_name}: {doc_label} for {company_name} expires in {due_in_label}",
        "body": """Hi {first_name},

This is a reminder that {doc_label} for contractor company "{company_name}" expires on {expires_on_label} ({due_in_label} from today).

Open Workforce: {workforce_url}

Regards,
{portal_name}
""",
        "resource_enabled": False,
        "resource_reminder_days": [30, 7, 1],
        "resource_subject": "{portal_name}: Your {doc_label} expires in {due_in_label}",
        "resource_body": """Hi {first_name},

Your {doc_label} for "{company_name}" expires on {expires_on_label} ({due_in_label} from today). Please upload updated PI/PL Insurance or Workcover documents in Workforce.

Open Workforce: {workforce_url}

Regards,
{portal_name}
""",
    },
    "security_training": {
        "enabled": False,
        "interval_days": 7,
        "send_hour_local": 9,
        "subject": "{portal_name}: Complete your security training",
        "body": """Hi {first_name},

You have not completed all required security training modules ({completed_count} of {total_count} done).

Open Security Training: {security_training_url}

Regards,
{portal_name}
""",
    },
}

_MODULE_META: dict[str, dict[str, Any]] = {
    "events": {
        "label": "Events",
        "description": "Email attendees before calendar events (creator and shared users).",
        "instant_only": False,
        "has_reminder_days": True,
        "has_send_hour": True,
        "placeholders": [
            "{first_name}",
            "{event_title}",
            "{event_date_label}",
            "{event_time_label}",
            "{event_location_line}",
            "{events_url}",
            "{portal_name}",
        ],
    },
    "wiki": {
        "label": "Wiki",
        "description": "Email users who watch a wiki page when it is updated.",
        "instant_only": True,
        "has_send_hour": False,
        "placeholders": [
            "{first_name}",
            "{page_title}",
            "{editor_name}",
            "{page_url}",
            "{portal_name}",
        ],
    },
    "team_chat": {
        "label": "Team Chat",
        "description": "Daily digest email when a user has unread Team Chat messages.",
        "instant_only": False,
        "has_send_hour": True,
        "placeholders": [
            "{first_name}",
            "{unread_count}",
            "{team_chat_url}",
            "{portal_name}",
        ],
    },
    "workforce": {
        "label": "Workforce",
        "description": "Email Workforce managers before contractor compliance documents (PI/PL Insurance, Workcover) expire.",
        "instant_only": False,
        "has_reminder_days": True,
        "has_send_hour": True,
        "has_resource_section": True,
        "placeholders": [
            "{first_name}",
            "{doc_label}",
            "{company_name}",
            "{expires_on_label}",
            "{due_in_label}",
            "{workforce_url}",
            "{portal_name}",
        ],
        "resource_placeholders": [
            "{first_name}",
            "{display_name}",
            "{doc_label}",
            "{company_name}",
            "{expires_on_label}",
            "{due_in_label}",
            "{workforce_url}",
            "{portal_name}",
        ],
    },
    "security_training": {
        "label": "Security Training",
        "description": "Periodic reminders for users who have not completed required training.",
        "instant_only": False,
        "has_interval_days": True,
        "has_send_hour": True,
        "placeholders": [
            "{first_name}",
            "{completed_count}",
            "{total_count}",
            "{security_training_url}",
            "{portal_name}",
        ],
    },
}


def _coerce(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def _coerce_bool(raw: Any, *, default: bool = False) -> bool:
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    s = str(raw).strip().lower()
    if s in {"1", "true", "yes", "on"}:
        return True
    if s in {"0", "false", "no", "off"}:
        return False
    return default


def _parse_reminder_days(raw: Any, *, default: list[int]) -> list[int]:
    if isinstance(raw, list):
        out: list[int] = []
        for item in raw:
            try:
                n = int(item)
            except (TypeError, ValueError):
                continue
            if 1 <= n <= 365 and n not in out:
                out.append(n)
        return sorted(out, reverse=True) if out else list(default)
    if isinstance(raw, str):
        parts = re.split(r"[,;\s]+", raw.strip())
        return _parse_reminder_days([p for p in parts if p], default=default)
    return list(default)


def _portal_name() -> str:
    from app.branding import portal_display_name_from_settings

    return portal_display_name_from_settings()


def _render_template(template: str, ctx: dict[str, str]) -> str:
    out = template or ""
    for key, val in ctx.items():
        out = out.replace("{" + key + "}", val or "")
    return out


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


def _outbound_email_ready() -> tuple[bool, str]:
    from app.email_service import get_email_settings

    cfg = get_email_settings()
    if not _coerce_bool(cfg.get("enabled"), default=False):
        return False, "Outbound email is not enabled"
    if not (cfg.get("smtp_host") or "").strip():
        return False, "SMTP host is not configured"
    if not (cfg.get("from_email") or "").strip():
        return False, "From email is not configured"
    return True, ""


def _user_display_name(user: User | None) -> str:
    if not user:
        return ""
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
    return display.split()[0] if display else "there"


def _user_email(user: User) -> str:
    attrs = user.attributes if isinstance(getattr(user, "attributes", None), dict) else {}
    for candidate in (user.email, user.username, attrs.get("email"), attrs.get("work_email")):
        addr = str(candidate or "").strip()
        if addr and "@" in addr:
            return addr
    return ""


def _due_in_label(days_before: int) -> str:
    if days_before == 30:
        return "1 month"
    if days_before == 7:
        return "1 week"
    if days_before == 1:
        return "1 day"
    return f"{days_before} days"


def _url_for_route(endpoint: str, **kwargs: Any) -> str:
    from flask import url_for

    try:
        return url_for(endpoint, _external=True, **kwargs)
    except Exception:
        fallbacks = {
            "intranet.events_page": "/intranet/events",
            "intranet.wiki_page": "/intranet/wiki",
            "intranet.team_chat_page": "/intranet/team-chat",
            "intranet.directory_page": "/intranet/directory",
            "intranet.security_training_page": "/intranet/security-training",
        }
        return fallbacks.get(endpoint, "/")


def get_all_module_settings() -> dict[str, dict[str, Any]]:
    from app.settings import get_setting

    stored = _coerce(get_setting(SETTING_KEY, default={}))
    out: dict[str, dict[str, Any]] = {}
    for key in MODULE_ORDER:
        defaults = dict(_MODULE_DEFAULTS[key])
        cur = _coerce(stored.get(key))
        merged = {**defaults, **cur}
        merged["enabled"] = _coerce_bool(merged.get("enabled"), default=bool(defaults.get("enabled")))
        if "reminder_days" in defaults:
            merged["reminder_days"] = _parse_reminder_days(
                merged.get("reminder_days"), default=list(defaults["reminder_days"])
            )
        if "resource_reminder_days" in defaults:
            merged["resource_reminder_days"] = _parse_reminder_days(
                merged.get("resource_reminder_days"), default=list(defaults["resource_reminder_days"])
            )
        if "resource_enabled" in defaults:
            merged["resource_enabled"] = _coerce_bool(
                merged.get("resource_enabled"), default=bool(defaults.get("resource_enabled"))
            )
        if "resource_subject" in defaults:
            merged["resource_subject"] = str(merged.get("resource_subject") or defaults["resource_subject"]).strip()
        if "resource_body" in defaults:
            merged["resource_body"] = str(merged.get("resource_body") or defaults["resource_body"]).strip()
        if "interval_days" in defaults:
            try:
                merged["interval_days"] = max(1, min(90, int(merged.get("interval_days") or defaults["interval_days"])))
            except (TypeError, ValueError):
                merged["interval_days"] = int(defaults["interval_days"])
        if "stale_days" in defaults:
            try:
                merged["stale_days"] = max(1, min(365, int(merged.get("stale_days") or defaults["stale_days"])))
            except (TypeError, ValueError):
                merged["stale_days"] = int(defaults["stale_days"])
        if "send_hour_local" in defaults:
            try:
                merged["send_hour_local"] = max(0, min(23, int(merged.get("send_hour_local") if merged.get("send_hour_local") is not None else defaults["send_hour_local"])))
            except (TypeError, ValueError):
                merged["send_hour_local"] = int(defaults["send_hour_local"])
        merged["subject"] = str(merged.get("subject") or defaults["subject"]).strip()
        merged["body"] = str(merged.get("body") or defaults["body"]).strip()
        out[key] = merged
    return out


def get_module_settings(module: str) -> dict[str, Any]:
    return get_all_module_settings().get(module, dict(_MODULE_DEFAULTS.get(module, {})))


def notification_settings_for_api() -> dict[str, Any]:
    all_settings = get_all_module_settings()
    modules: dict[str, Any] = {}
    for key in MODULE_ORDER:
        meta = _MODULE_META[key]
        defaults = _MODULE_DEFAULTS[key]
        s = all_settings[key]
        modules[key] = {
            **s,
            "label": meta["label"],
            "description": meta["description"],
            "instant_only": bool(meta.get("instant_only")),
            "has_reminder_days": bool(meta.get("has_reminder_days")),
            "has_interval_days": bool(meta.get("has_interval_days")),
            "has_stale_days": bool(meta.get("has_stale_days")),
            "has_send_hour": bool(meta.get("has_send_hour", True)),
            "has_resource_section": bool(meta.get("has_resource_section")),
            "placeholders": list(meta.get("placeholders") or []),
            "resource_placeholders": list(meta.get("resource_placeholders") or []),
            "defaults": {
                "subject": defaults["subject"],
                "body": defaults["body"],
                **(
                    {
                        "resource_subject": defaults["resource_subject"],
                        "resource_body": defaults["resource_body"],
                    }
                    if "resource_subject" in defaults
                    else {}
                ),
            },
        }
    return {"modules": modules, "module_order": list(MODULE_ORDER)}


def save_notification_settings(payload: dict[str, Any]) -> dict[str, Any]:
    from app.settings import get_setting, set_setting

    incoming = _coerce(payload.get("modules"))
    if not incoming and isinstance(payload.get("module"), str):
        incoming = {str(payload["module"]): _coerce(payload.get("settings"))}
    if not incoming:
        incoming = _coerce(payload)

    stored = _coerce(get_setting(SETTING_KEY, default={}))
    for key in MODULE_ORDER:
        if key not in incoming:
            continue
        patch = _coerce(incoming[key])
        if not patch:
            continue
        cur = _coerce(stored.get(key))
        cur = {**dict(_MODULE_DEFAULTS[key]), **cur, **patch}
        if "enabled" in patch:
            cur["enabled"] = _coerce_bool(patch.get("enabled"))
        if "reminder_days" in patch:
            cur["reminder_days"] = _parse_reminder_days(
                patch.get("reminder_days"), default=list(_MODULE_DEFAULTS[key].get("reminder_days") or [1])
            )
        if "resource_reminder_days" in patch:
            cur["resource_reminder_days"] = _parse_reminder_days(
                patch.get("resource_reminder_days"),
                default=list(_MODULE_DEFAULTS[key].get("resource_reminder_days") or [30, 7, 1]),
            )
        if "resource_enabled" in patch:
            cur["resource_enabled"] = _coerce_bool(patch.get("resource_enabled"))
        if "resource_subject" in patch:
            cur["resource_subject"] = str(patch.get("resource_subject") or "").strip() or _MODULE_DEFAULTS[key].get(
                "resource_subject", ""
            )
        if "resource_body" in patch:
            cur["resource_body"] = str(patch.get("resource_body") or "").strip() or _MODULE_DEFAULTS[key].get(
                "resource_body", ""
            )
        for field in ("interval_days", "stale_days", "send_hour_local"):
            if field in patch and field in _MODULE_DEFAULTS[key]:
                try:
                    cur[field] = int(patch.get(field))
                except (TypeError, ValueError):
                    pass
        if "subject" in patch:
            cur["subject"] = str(patch.get("subject") or "").strip() or _MODULE_DEFAULTS[key]["subject"]
        if "body" in patch:
            cur["body"] = str(patch.get("body") or "").strip() or _MODULE_DEFAULTS[key]["body"]
        stored[key] = cur
    set_setting(SETTING_KEY, stored)
    return notification_settings_for_api()


def _sample_context(module: str) -> dict[str, str]:
    base = {
        "first_name": "Alex",
        "display_name": "Alex Example",
        "email": "alex@example.com",
        "portal_name": _portal_name(),
    }
    samples = {
        "events": {
            "event_title": "Quarterly planning",
            "event_date_label": "15 Jul 2026",
            "event_time_label": " at 10:00",
            "event_location_line": "Location: Boardroom",
            "events_url": _url_for_route("intranet.events_page"),
        },
        "wiki": {
            "page_title": "Onboarding guide",
            "editor_name": "Sam Nuth",
            "page_url": _url_for_route("intranet.wiki_page") + "/onboarding",
        },
        "team_chat": {
            "unread_count": "3",
            "team_chat_url": _url_for_route("intranet.team_chat_page"),
        },
        "workforce": {
            "doc_label": "PI/PL Insurance",
            "company_name": "Example Contractors Pty Ltd",
            "expires_on_label": "30 Jul 2026",
            "due_in_label": "1 month",
            "workforce_url": _url_for_route("intranet.directory_page"),
        },
        "security_training": {
            "completed_count": "2",
            "total_count": "5",
            "security_training_url": _url_for_route("intranet.security_training_page"),
        },
    }
    return {**base, **samples.get(module, {})}


def send_test_notification(*, module: str, to_addr: str, variant: str = "") -> tuple[bool, str]:
    key = str(module or "").strip()
    if key not in MODULE_ORDER:
        return False, "Unknown module"
    addr = str(to_addr or "").strip()
    if not addr or "@" not in addr:
        return False, "Enter a valid email address"
    settings = get_module_settings(key)
    ctx = _sample_context(key)
    ctx["email"] = addr
    ctx["display_name"] = "Alex Example"
    use_resource = str(variant or "").strip().lower() == "resource"
    if use_resource and key == "workforce":
        subject = _render_template(settings.get("resource_subject") or settings["subject"], ctx)[:500]
        body = _render_template(settings.get("resource_body") or settings["body"], ctx)
    else:
        subject = _render_template(settings["subject"], ctx)[:500]
        body = _render_template(settings["body"], ctx)
    return send_email(to_addrs=[addr], subject=subject, body=body)


def _sent_log_path() -> Path:
    from flask import current_app

    path = Path(current_app.instance_path) / "module_email_reminder_sent.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _load_sent_log() -> dict[str, dict[str, str]]:
    path = _sent_log_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {}
        out: dict[str, dict[str, str]] = {}
        for mod, rows in data.items():
            if isinstance(rows, dict):
                out[str(mod)] = {str(k): str(v) for k, v in rows.items()}
        return out
    except Exception:
        return {}


def _save_sent_log(data: dict[str, dict[str, str]]) -> None:
    _sent_log_path().write_text(json.dumps(data, indent=2), encoding="utf-8")


def _was_sent(module: str, key: str) -> bool:
    return bool((_load_sent_log().get(module) or {}).get(key))


def _record_sent(module: str, key: str) -> None:
    log = _load_sent_log()
    bucket = log.setdefault(module, {})
    bucket[key] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    _save_sent_log(log)


def _should_run_scheduled(settings: dict[str, Any], *, module: str, force: bool) -> bool:
    if force:
        return True
    now = _local_now()
    if now.hour < int(settings.get("send_hour_local") or 9):
        return False
    day_key = f"__daily__:{now.date().isoformat()}"
    return not _was_sent(module, day_key)


def _mark_scheduled_run(module: str) -> None:
    day_key = f"__daily__:{_local_now().date().isoformat()}"
    _record_sent(module, day_key)


def _send_to_user(user: User, settings: dict[str, Any], ctx: dict[str, str]) -> tuple[bool, str]:
    addr = _user_email(user)
    if not addr:
        return False, "no email"
    ctx = {**ctx, "first_name": _user_first_name(user), "display_name": _user_display_name(user), "email": addr}
    subject = _render_template(settings["subject"], ctx)[:500]
    body = _render_template(settings["body"], ctx)
    return send_email(to_addrs=[addr], subject=subject, body=body)


def _event_recipients(ev) -> list[User]:
    from app.extensions import db
    from app.models import Group

    ids: set[int] = set()
    if ev.created_by_id:
        ids.add(int(ev.created_by_id))
    for raw in ev.shared_user_ids or []:
        try:
            ids.add(int(raw))
        except (TypeError, ValueError):
            continue
    for gid in ev.shared_group_ids or []:
        try:
            group = db.session.get(Group, int(gid))
        except (TypeError, ValueError):
            group = None
        if group:
            for u in group.users or []:
                if u.is_active:
                    ids.add(int(u.id))
    out: list[User] = []
    for uid in ids:
        u = db.session.get(User, uid)
        if u and u.is_active and _user_email(u):
            out.append(u)
    return out


def run_events_reminders(*, force: bool = False) -> dict[str, Any]:
    from app.extensions import db
    from app.models import CalendarEvent

    settings = get_module_settings("events")
    result: dict[str, Any] = {"ok": True, "module": "events", "sent": 0, "failed": 0, "skipped": None}
    if not settings.get("enabled"):
        result["skipped"] = "disabled"
        return result
    email_ok, email_msg = _outbound_email_ready()
    if not email_ok:
        result["skipped"] = email_msg
        return result
    if not _should_run_scheduled(settings, module="events", force=force):
        result["skipped"] = "not_due"
        return result

    today = _local_now().date()
    for days_before in settings.get("reminder_days") or [1]:
        target = (today + timedelta(days=int(days_before))).isoformat()
        rows = db.session.query(CalendarEvent).filter(CalendarEvent.date == target).all()
        for ev in rows:
            time_label = ""
            if ev.start:
                time_label = f" at {ev.start}"
            loc_line = f"Location: {ev.location}" if (ev.location or "").strip() else ""
            ctx = {
                "event_title": ev.title or "Event",
                "event_date_label": datetime.strptime(ev.date, "%Y-%m-%d").strftime("%d %b %Y") if ev.date else ev.date,
                "event_time_label": time_label,
                "event_location_line": loc_line,
                "events_url": _url_for_route("intranet.events_page"),
                "portal_name": _portal_name(),
            }
            for user in _event_recipients(ev):
                log_key = f"ev:{ev.id}:{days_before}:{user.id}"
                if not force and _was_sent("events", log_key):
                    continue
                ok, _ = _send_to_user(user, settings, ctx)
                if ok:
                    result["sent"] += 1
                    if not force:
                        _record_sent("events", log_key)
                else:
                    result["failed"] += 1
    if not force:
        _mark_scheduled_run("events")
    return result


def notify_wiki_page_updated(page, *, editor: User | None = None) -> dict[str, Any]:
    from app.extensions import db
    from app.models import WikiPageWatch

    settings = get_module_settings("wiki")
    result: dict[str, Any] = {"ok": True, "module": "wiki", "sent": 0, "failed": 0, "skipped": None}
    if not settings.get("enabled"):
        result["skipped"] = "disabled"
        return result
    email_ok, email_msg = _outbound_email_ready()
    if not email_ok:
        result["skipped"] = email_msg
        return result

    editor_id = int(editor.id) if editor else 0
    watches = db.session.query(WikiPageWatch).filter(WikiPageWatch.wiki_page_id == page.id).all()
    ctx = {
        "page_title": page.title or page.slug,
        "editor_name": _user_display_name(editor) or "Someone",
        "page_url": _url_for_route("intranet.wiki_page") + f"/{page.slug}",
        "portal_name": _portal_name(),
    }
    for watch in watches:
        if int(watch.user_id) == editor_id:
            continue
        user = db.session.get(User, int(watch.user_id))
        if not user or not user.is_active:
            continue
        ok, _ = _send_to_user(user, settings, ctx)
        if ok:
            result["sent"] += 1
        else:
            result["failed"] += 1
    return result


def run_team_chat_reminders(*, force: bool = False) -> dict[str, Any]:
    from app.intranet_bp import _chat_unread_summary

    settings = get_module_settings("team_chat")
    result: dict[str, Any] = {"ok": True, "module": "team_chat", "sent": 0, "failed": 0, "skipped": None}
    if not settings.get("enabled"):
        result["skipped"] = "disabled"
        return result
    email_ok, email_msg = _outbound_email_ready()
    if not email_ok:
        result["skipped"] = email_msg
        return result
    if not _should_run_scheduled(settings, module="team_chat", force=force):
        result["skipped"] = "not_due"
        return result

    from app.extensions import db

    users = db.session.query(User).filter(User.is_active.is_(True)).all()
    today = _local_now().date().isoformat()
    for user in users:
        summary = _chat_unread_summary(int(user.id))
        total = int(summary.get("total") or 0)
        if total <= 0:
            continue
        log_key = f"user:{user.id}:{today}"
        if not force and _was_sent("team_chat", log_key):
            continue
        ctx = {
            "unread_count": str(total),
            "team_chat_url": _url_for_route("intranet.team_chat_page"),
            "portal_name": _portal_name(),
        }
        ok, _ = _send_to_user(user, settings, ctx)
        if ok:
            result["sent"] += 1
            if not force:
                _record_sent("team_chat", log_key)
        else:
            result["failed"] += 1
    if not force:
        _mark_scheduled_run("team_chat")
    return result


def run_workforce_reminders(*, force: bool = False) -> dict[str, Any]:
    from app.contractor_compliance_notifications import run_contractor_compliance_reminders

    settings = get_module_settings("workforce")
    if not settings.get("enabled") and not settings.get("resource_enabled"):
        return {"ok": True, "module": "workforce", "skipped": "disabled", "sent": 0, "failed": 0}
    if not force and not _should_run_scheduled(settings, module="workforce", force=False):
        return {"ok": True, "module": "workforce", "skipped": "not_due", "sent": 0, "failed": 0}
    out = run_contractor_compliance_reminders(force=force)
    out["module"] = "workforce"
    if not force:
        _mark_scheduled_run("workforce")
    return out


def run_security_training_reminders(*, force: bool = False) -> dict[str, Any]:
    from app import security_training_service as stsvc
    from app.extensions import db
    from app.intranet_bp import _security_training_folder

    settings = get_module_settings("security_training")
    result: dict[str, Any] = {"ok": True, "module": "security_training", "sent": 0, "failed": 0, "skipped": None}
    if not settings.get("enabled"):
        result["skipped"] = "disabled"
        return result
    email_ok, email_msg = _outbound_email_ready()
    if not email_ok:
        result["skipped"] = email_msg
        return result
    if not _should_run_scheduled(settings, module="security_training", force=force):
        result["skipped"] = "not_due"
        return result

    folder = _security_training_folder()
    file_ids: list[int] = []
    if folder:
        from app.intranet_bp import _security_training_catalog

        for row in _security_training_catalog(folder, limit=500):
            try:
                file_ids.append(int(row.get("id")))
            except (TypeError, ValueError):
                continue
    interval = int(settings.get("interval_days") or 7)
    users = db.session.query(User).filter(User.is_active.is_(True)).all()
    for user in users:
        if not _user_email(user):
            continue
        summary = stsvc.progress_summary(user, file_ids)
        if not file_ids or summary.get("all_complete"):
            continue
        log_key = f"user:{user.id}"
        if not force:
            last = (_load_sent_log().get("security_training") or {}).get(log_key)
            if last:
                try:
                    dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    if datetime.now(timezone.utc) - dt < timedelta(days=interval):
                        continue
                except Exception:
                    pass
        ctx = {
            "completed_count": str(summary.get("completed") or 0),
            "total_count": str(summary.get("total") or 0),
            "security_training_url": _url_for_route("intranet.security_training_page"),
            "portal_name": _portal_name(),
        }
        ok, _ = _send_to_user(user, settings, ctx)
        if ok:
            result["sent"] += 1
            if not force:
                _record_sent("security_training", log_key)
        else:
            result["failed"] += 1
    if not force:
        _mark_scheduled_run("security_training")
    return result


def _parse_iso_date(raw: str) -> date | None:
    if not raw:
        return None
    try:
        return datetime.strptime(str(raw).strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


_MODULE_RUNNERS = {
    "events": run_events_reminders,
    "team_chat": run_team_chat_reminders,
    "workforce": run_workforce_reminders,
    "security_training": run_security_training_reminders,
}


def run_module_reminders(module: str, *, force: bool = False) -> dict[str, Any]:
    fn = _MODULE_RUNNERS.get(str(module or "").strip())
    if not fn:
        return {"ok": False, "error": "Unknown or instant-only module"}
    return fn(force=force)


def run_scheduled_module_reminders() -> dict[str, Any]:
    results: dict[str, Any] = {}
    for key in MODULE_ORDER:
        if key == "wiki":
            continue
        try:
            results[key] = run_module_reminders(key, force=False)
        except Exception as exc:
            results[key] = {"ok": False, "error": str(exc)}
    return results
