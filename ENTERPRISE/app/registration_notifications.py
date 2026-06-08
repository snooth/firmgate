"""Email notifications for self-service registrations (admin + optional registrant)."""

from __future__ import annotations

import re
from typing import Any

from app.email_service import send_email
from app.branding import portal_shell_name
from app.mfa_service import mfa_enrolled
from app.registration_service import (
    ATTR_REGISTRATION_PENDING,
    ATTR_REGISTRATION_SUBMITTED_AT,
    registration_display_name,
    registration_pending,
    registration_submitted_at,
)

if True:  # TYPE_CHECKING
    from app.models import User

SETTING_KEY = "registration_notifications"
ATTR_REGISTRATION_NOTIFY_SENT = "registration_notify_sent"

_DEFAULT_ADMIN_SUBJECT = "New registration pending approval: {display_name}"
_DEFAULT_ADMIN_BODY = """A new self-service registration is ready for review.

Name: {display_name}
Email: {email}
Submitted: {submitted_at}

Review pending registrations:
{admin_url}
"""

_DEFAULT_REGISTRANT_SUBJECT = "Registration received — {portal_name}"
_DEFAULT_REGISTRANT_BODY = """Hi {first_name},

Thank you for registering with {portal_name}. Your registration has been received and is pending administrator approval.

You will be able to sign in once an administrator approves your account.

Regards,
{portal_name}
"""

_DEFAULT_APPROVAL_SUBJECT = "Your {portal_name} registration has been approved"
_DEFAULT_APPROVAL_BODY = """Hi {first_name},

Good news — your {portal_name} registration has been approved. You can now sign in with your account.

Email: {email}
Sign in: {login_url}

Regards,
{portal_name}
"""


def _coerce(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def _user_attrs(user: User) -> dict:
    a = user.attributes
    return dict(a) if isinstance(a, dict) else {}


def _parse_recipients(raw: Any) -> list[str]:
    if isinstance(raw, list):
        parts = [str(x).strip() for x in raw]
    else:
        parts = re.split(r"[,;\n]+", str(raw or ""))
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        e = p.strip().lower()
        if not e or "@" not in e or e in seen:
            continue
        seen.add(e)
        out.append(p.strip()[:255])
    return out[:40]


def _render_template(template: str, context: dict[str, str]) -> str:
    out = template or ""
    for key, val in context.items():
        out = out.replace("{" + key + "}", val)
    return out


def _portal_name() -> str:
    from app.registration_service import portal_is_extranet

    return portal_shell_name("non_core_team" if portal_is_extranet() else "core_team")


def _admin_registrations_url() -> str:
    from flask import url_for

    try:
        base = url_for("intranet.admin_page", _external=True)
    except Exception:
        base = "/intranet/admin"
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}tab=registrations"


def _login_url() -> str:
    from flask import url_for

    try:
        return url_for("auth.login", _external=True)
    except Exception:
        return "/login"


def get_notification_settings() -> dict[str, Any]:
    from app.settings import get_setting

    v = _coerce(get_setting(SETTING_KEY, default={}))
    return {
        "admin_notify_enabled": bool(v.get("admin_notify_enabled")),
        "admin_notify_emails": _parse_recipients(v.get("admin_notify_emails")),
        "admin_subject": (v.get("admin_subject") or _DEFAULT_ADMIN_SUBJECT).strip(),
        "admin_body": (v.get("admin_body") or _DEFAULT_ADMIN_BODY).strip(),
        "registrant_notify_enabled": bool(v.get("registrant_notify_enabled")),
        "registrant_subject": (v.get("registrant_subject") or _DEFAULT_REGISTRANT_SUBJECT).strip(),
        "registrant_body": (v.get("registrant_body") or _DEFAULT_REGISTRANT_BODY).strip(),
        "approval_notify_enabled": v.get("approval_notify_enabled", True) is not False,
        "approval_subject": (v.get("approval_subject") or _DEFAULT_APPROVAL_SUBJECT).strip(),
        "approval_body": (v.get("approval_body") or _DEFAULT_APPROVAL_BODY).strip(),
    }


def notification_settings_for_api() -> dict[str, Any]:
    s = get_notification_settings()
    return {
        **s,
        "admin_notify_emails_text": "\n".join(s["admin_notify_emails"]),
        "placeholders": [
            "{display_name}",
            "{first_name}",
            "{last_name}",
            "{surname}",
            "{email}",
            "{submitted_at}",
            "{admin_url}",
            "{login_url}",
            "{approved_at}",
            "{portal_name}",
        ],
        "defaults": {
            "admin_subject": _DEFAULT_ADMIN_SUBJECT,
            "admin_body": _DEFAULT_ADMIN_BODY,
            "registrant_subject": _DEFAULT_REGISTRANT_SUBJECT,
            "registrant_body": _DEFAULT_REGISTRANT_BODY,
            "approval_subject": _DEFAULT_APPROVAL_SUBJECT,
            "approval_body": _DEFAULT_APPROVAL_BODY,
        },
    }


def save_notification_settings(payload: dict[str, Any]) -> dict[str, Any] | tuple[dict[str, str], int]:
    from app.settings import set_setting

    admin_enabled = bool(payload.get("admin_notify_enabled"))
    emails = _parse_recipients(payload.get("admin_notify_emails") or payload.get("admin_notify_emails_text"))
    admin_subject = (payload.get("admin_subject") or _DEFAULT_ADMIN_SUBJECT).strip()[:500]
    admin_body = (payload.get("admin_body") or _DEFAULT_ADMIN_BODY).strip()[:20000]
    registrant_enabled = bool(payload.get("registrant_notify_enabled"))
    registrant_subject = (payload.get("registrant_subject") or _DEFAULT_REGISTRANT_SUBJECT).strip()[:500]
    registrant_body = (payload.get("registrant_body") or _DEFAULT_REGISTRANT_BODY).strip()[:20000]
    approval_enabled = payload.get("approval_notify_enabled", True) is not False
    approval_subject = (payload.get("approval_subject") or _DEFAULT_APPROVAL_SUBJECT).strip()[:500]
    approval_body = (payload.get("approval_body") or _DEFAULT_APPROVAL_BODY).strip()[:20000]

    if admin_enabled and not emails:
        return {"error": "Add at least one notification recipient email when admin notifications are enabled."}, 400

    set_setting(
        SETTING_KEY,
        {
            "admin_notify_enabled": admin_enabled,
            "admin_notify_emails": emails,
            "admin_subject": admin_subject,
            "admin_body": admin_body,
            "registrant_notify_enabled": registrant_enabled,
            "registrant_subject": registrant_subject,
            "registrant_body": registrant_body,
            "approval_notify_enabled": approval_enabled,
            "approval_subject": approval_subject,
            "approval_body": approval_body,
        },
    )
    return notification_settings_for_api()


def build_template_context(user: User, *, approved_at: str | None = None) -> dict[str, str]:
    attrs = _user_attrs(user)
    fn = str(attrs.get("first_name") or "").strip()
    sn = str(attrs.get("surname") or "").strip()
    display = registration_display_name(user) or (user.email or user.username or "")
    submitted = registration_submitted_at(user) or ""
    return {
        "display_name": display,
        "first_name": fn or display.split()[0] if display else "",
        "last_name": sn,
        "surname": sn,
        "email": (user.email or user.username or "").strip(),
        "submitted_at": submitted,
        "admin_url": _admin_registrations_url(),
        "login_url": _login_url(),
        "approved_at": (approved_at or "").strip(),
        "portal_name": _portal_name(),
    }


def sample_template_context() -> dict[str, str]:
    return {
        "display_name": "Alex Taylor",
        "first_name": "Alex",
        "last_name": "Taylor",
        "surname": "Taylor",
        "email": "alex.taylor@example.com",
        "submitted_at": "2026-05-19T10:30:00+00:00",
        "admin_url": _admin_registrations_url(),
        "login_url": _login_url(),
        "approved_at": "2026-05-19T14:00:00+00:00",
        "portal_name": _portal_name(),
    }


def clear_registration_notify_sent(user: User) -> None:
    attrs = _user_attrs(user)
    attrs.pop(ATTR_REGISTRATION_NOTIFY_SENT, None)
    user.attributes = attrs


def _mark_notify_sent(user: User) -> None:
    from datetime import datetime, timezone

    attrs = _user_attrs(user)
    attrs[ATTR_REGISTRATION_NOTIFY_SENT] = (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    )
    user.attributes = attrs


def send_test_notification(*, to_addr: str, which: str = "admin") -> tuple[bool, str]:
    settings = get_notification_settings()
    ctx = sample_template_context()
    if which == "registrant":
        subject = _render_template(settings["registrant_subject"], ctx)
        body = _render_template(settings["registrant_body"], ctx)
    elif which == "approval":
        subject = _render_template(settings["approval_subject"], ctx)
        body = _render_template(settings["approval_body"], ctx)
    else:
        subject = _render_template(settings["admin_subject"], ctx)
        body = _render_template(settings["admin_body"], ctx)
    subject = f"[Test] {subject}"[:500]
    return send_email(to_addrs=[to_addr], subject=subject, body=body)


def send_registration_notifications(user: User) -> dict[str, Any]:
    """Notify admins (and optionally the registrant) once MFA is complete and registration is ready."""
    from app.extensions import db

    result: dict[str, Any] = {"admin": None, "registrant": None, "skipped": None}

    if not registration_pending(user):
        result["skipped"] = "not_pending"
        return result
    if not mfa_enrolled(user):
        result["skipped"] = "mfa_incomplete"
        return result
    if _user_attrs(user).get(ATTR_REGISTRATION_NOTIFY_SENT):
        result["skipped"] = "already_sent"
        return result

    settings = get_notification_settings()
    ctx = build_template_context(user)

    mark_sent = not settings["admin_notify_enabled"]
    if settings["admin_notify_enabled"]:
        recipients = settings["admin_notify_emails"]
        if recipients:
            subject = _render_template(settings["admin_subject"], ctx)[:500]
            body = _render_template(settings["admin_body"], ctx)
            ok, msg = send_email(to_addrs=recipients, subject=subject, body=body)
            result["admin"] = {"ok": ok, "message": msg, "to": recipients}
            if ok:
                mark_sent = True
        else:
            result["admin"] = {"ok": False, "message": "No notification recipients configured."}

    if settings["registrant_notify_enabled"]:
        reg_email = (user.email or user.username or "").strip()
        if reg_email and "@" in reg_email:
            subject = _render_template(settings["registrant_subject"], ctx)[:500]
            body = _render_template(settings["registrant_body"], ctx)
            ok, msg = send_email(to_addrs=[reg_email], subject=subject, body=body)
            result["registrant"] = {"ok": ok, "message": msg, "to": reg_email}
        else:
            result["registrant"] = {"ok": False, "message": "Registrant email missing."}

    if result["admin"] is None and result["registrant"] is None and not settings["admin_notify_enabled"]:
        result["skipped"] = "notifications_disabled"

    if mark_sent:
        _mark_notify_sent(user)
        db.session.add(user)
        db.session.commit()

    return result


def send_registration_approval_notification(user: User) -> dict[str, Any]:
    """Email the registrant after an administrator approves their account."""
    from datetime import datetime, timezone

    result: dict[str, Any] = {"ok": None, "message": None, "skipped": None, "to": None}
    settings = get_notification_settings()
    if not settings["approval_notify_enabled"]:
        result["skipped"] = "disabled"
        return result

    reg_email = (user.email or user.username or "").strip()
    if not reg_email or "@" not in reg_email:
        result["ok"] = False
        result["message"] = "Registrant email missing."
        return result

    approved_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    ctx = build_template_context(user, approved_at=approved_at)
    subject = _render_template(settings["approval_subject"], ctx)[:500]
    body = _render_template(settings["approval_body"], ctx)
    ok, msg = send_email(to_addrs=[reg_email], subject=subject, body=body)
    result["ok"] = ok
    result["message"] = msg
    result["to"] = reg_email
    return result
