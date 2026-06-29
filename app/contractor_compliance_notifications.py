"""Email reminders for contractor company compliance document expiry (PI/PL, Workcover)."""

from __future__ import annotations

import json
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from app.email_service import send_email
from app.models import ContractorCompany, User

REMINDER_DAYS_BEFORE = (30, 7, 1)

_DOC_LABELS = {
    "pi_pl_insurance": "PI/PL Insurance",
    "workcover": "Workcover",
}

_DEFAULT_SUBJECT = "{portal_name}: {doc_label} for {company_name} expires in {due_in_label}"
_DEFAULT_BODY = """Hi {first_name},

This is a reminder that {doc_label} for contractor company "{company_name}" expires on {expires_on_label} ({due_in_label} from today).

Open Workforce: {workforce_url}

Regards,
{portal_name}
"""


def _coerce_bool(raw: Any, *, default: bool = True) -> bool:
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


def _portal_name() -> str:
    from app.branding import portal_display_name_from_settings

    return portal_display_name_from_settings()


def _workforce_url() -> str:
    from flask import url_for

    try:
        return url_for("intranet.directory_page", _external=True)
    except Exception:
        return "/intranet/directory"


def _render_template(template: str, ctx: dict[str, str]) -> str:
    out = template or ""
    for key, val in ctx.items():
        out = out.replace("{" + key + "}", val or "")
    return out


def _due_in_label(days_before: int) -> str:
    if days_before == 30:
        return "1 month"
    if days_before == 7:
        return "1 week"
    if days_before == 1:
        return "1 day"
    return f"{days_before} days"


def _expires_on_label(iso: str) -> str:
    try:
        return datetime.strptime(iso[:10], "%Y-%m-%d").date().strftime("%d %b %Y")
    except ValueError:
        return iso


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


def _sent_log_path() -> Path:
    from flask import current_app

    path = Path(current_app.instance_path) / "contractor_compliance_reminder_sent.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _load_sent_log() -> dict[str, str]:
    path = _sent_log_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
    except Exception:
        pass
    return {}


def _save_sent_log(data: dict[str, str]) -> None:
    _sent_log_path().write_text(json.dumps(data, indent=2), encoding="utf-8")


def _log_key(*, company_id: int, kind: str, expires_on: date, days_before: int, user_id: int) -> str:
    return f"{int(company_id)}:{kind}:{expires_on.isoformat()}:{int(days_before)}:{int(user_id)}"


def _was_sent(**kwargs: Any) -> bool:
    return _log_key(**kwargs) in _load_sent_log()


def _record_sent(**kwargs: Any) -> None:
    key = _log_key(**kwargs)
    log = _load_sent_log()
    log[key] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    _save_sent_log(log)


def _lock_path() -> Path:
    from flask import current_app

    path = Path(current_app.instance_path) / "contractor_compliance_reminder.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def _reminder_lock() -> Iterator[bool]:
    try:
        import fcntl
    except ImportError:
        yield True
        return

    handle = open(_lock_path(), "w")
    acquired = False
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError:
            acquired = False
        yield acquired
    finally:
        if acquired:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
        try:
            handle.close()
        except Exception:
            pass


def _user_email(user: User) -> str | None:
    addr = (user.email or "").strip()
    if addr and "@" in addr:
        return addr
    return None


def _user_first_name(user: User) -> str:
    name = (getattr(user, "full_name", None) or user.username or "there").strip()
    return name.split()[0] if name else "there"


def _notify_users() -> list[User]:
    from app import rbac
    from app.extensions import db

    rows = db.session.query(User).filter(User.is_active.is_(True)).all()
    out: list[User] = []
    seen: set[int] = set()
    for u in rows:
        if u.id in seen:
            continue
        if not rbac.user_can_workforce_create(u):
            continue
        if not _user_email(u):
            continue
        seen.add(int(u.id))
        out.append(u)
    return out


def _parse_expires_on(raw: object) -> date | None:
    if not raw:
        return None
    try:
        return datetime.strptime(str(raw).strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _contractors_for_company(company_id: int) -> list[User]:
    from app.extensions import db

    rows = db.session.query(User).filter(User.is_active.is_(True)).all()
    out: list[User] = []
    seen: set[int] = set()
    for u in rows:
        if u.id in seen:
            continue
        attrs = u.attributes if isinstance(u.attributes, dict) else {}
        if not attrs.get("is_contractor"):
            continue
        try:
            cid = int(attrs.get("contractor_company_id"))
        except (TypeError, ValueError):
            continue
        if cid != int(company_id):
            continue
        if not _user_email(u):
            continue
        seen.add(int(u.id))
        out.append(u)
    return out


def _resource_first_name(user: User) -> str:
    attrs = user.attributes if isinstance(user.attributes, dict) else {}
    fn = str(attrs.get("first_name") or "").strip()
    if fn:
        return fn
    name = (getattr(user, "full_name", None) or user.username or "there").strip()
    return name.split()[0] if name else "there"


def _send_resource_reminder(
    *,
    user: User,
    company: ContractorCompany,
    kind: str,
    expires_on: date,
    days_before: int,
) -> tuple[bool, str]:
    from app.module_email_notifications import get_module_settings

    settings = get_module_settings("workforce")
    doc_label = _DOC_LABELS.get(kind, kind.replace("_", " ").title())
    ctx = {
        "first_name": _resource_first_name(user),
        "display_name": (getattr(user, "full_name", None) or user.username or "").strip(),
        "company_name": company.name or "your company",
        "doc_label": doc_label,
        "expires_on": expires_on.isoformat(),
        "expires_on_label": _expires_on_label(expires_on.isoformat()),
        "days_before": str(days_before),
        "due_in_label": _due_in_label(days_before),
        "portal_name": _portal_name(),
        "workforce_url": _workforce_url(),
    }
    subject = _render_template(settings.get("resource_subject") or _DEFAULT_SUBJECT, ctx)
    body = _render_template(settings.get("resource_body") or _DEFAULT_BODY, ctx)
    addr = _user_email(user)
    if not addr:
        return False, "no email"
    return send_email(to_addrs=[addr], subject=subject, body=body)


def _send_reminder(
    *,
    user: User,
    company: ContractorCompany,
    kind: str,
    expires_on: date,
    days_before: int,
) -> tuple[bool, str]:
    from app.module_email_notifications import get_module_settings

    settings = get_module_settings("workforce")
    doc_label = _DOC_LABELS.get(kind, kind.replace("_", " ").title())
    ctx = {
        "first_name": _user_first_name(user),
        "company_name": company.name or "Contractor company",
        "doc_label": doc_label,
        "expires_on": expires_on.isoformat(),
        "expires_on_label": _expires_on_label(expires_on.isoformat()),
        "days_before": str(days_before),
        "due_in_label": _due_in_label(days_before),
        "portal_name": _portal_name(),
        "workforce_url": _workforce_url(),
    }
    subject = _render_template(settings.get("subject") or _DEFAULT_SUBJECT, ctx)
    body = _render_template(settings.get("body") or _DEFAULT_BODY, ctx)
    addr = _user_email(user)
    if not addr:
        return False, "no email"
    return send_email(to_addrs=[addr], subject=subject, body=body)


def run_contractor_compliance_reminders(*, force: bool = False) -> dict[str, Any]:
    if force:
        return _run_contractor_compliance_reminders(force=True)
    with _reminder_lock() as acquired:
        if not acquired:
            return {
                "ok": True,
                "skipped": "locked",
                "sent": 0,
                "failed": 0,
                "checked": 0,
                "messages": [],
            }
        return _run_contractor_compliance_reminders(force=False)


def _run_contractor_compliance_reminders(*, force: bool = False) -> dict[str, Any]:
    from app.extensions import db

    result: dict[str, Any] = {
        "ok": True,
        "skipped": None,
        "sent": 0,
        "failed": 0,
        "checked": 0,
        "messages": [],
    }
    email_ok, email_msg = _outbound_email_ready()
    if not email_ok:
        result["skipped"] = email_msg
        return result

    local_now = _local_now()
    today_local = local_now.date()
    from app.module_email_notifications import get_module_settings

    wf_settings = get_module_settings("workforce")
    managers_enabled = bool(wf_settings.get("enabled"))
    resources_enabled = bool(wf_settings.get("resource_enabled"))
    recipients = _notify_users() if managers_enabled else []
    if managers_enabled and not recipients:
        if not resources_enabled:
            result["skipped"] = "no_recipients"
            return result

    manager_days = wf_settings.get("reminder_days") or REMINDER_DAYS_BEFORE
    resource_days = wf_settings.get("resource_reminder_days") or REMINDER_DAYS_BEFORE

    companies = db.session.query(ContractorCompany).all()
    for company in companies:
        docs = company.documents if isinstance(company.documents, dict) else {}
        contractors = _contractors_for_company(int(company.id)) if resources_enabled else []
        for kind in _DOC_LABELS:
            entry = docs.get(kind)
            if not isinstance(entry, dict):
                continue
            expires_on = _parse_expires_on(entry.get("expires_on"))
            if not expires_on:
                continue
            if managers_enabled:
                for days_before in manager_days:
                    if expires_on != today_local + timedelta(days=days_before):
                        continue
                    result["checked"] += 1
                    for user in recipients:
                        if not force and _was_sent(
                            company_id=int(company.id),
                            kind=kind,
                            expires_on=expires_on,
                            days_before=days_before,
                            user_id=int(user.id),
                        ):
                            continue
                        ok, msg = _send_reminder(
                            user=user,
                            company=company,
                            kind=kind,
                            expires_on=expires_on,
                            days_before=days_before,
                        )
                        if ok:
                            result["sent"] += 1
                            if not force:
                                _record_sent(
                                    company_id=int(company.id),
                                    kind=kind,
                                    expires_on=expires_on,
                                    days_before=days_before,
                                    user_id=int(user.id),
                                )
                        else:
                            result["failed"] += 1
                            result["messages"].append(msg)
            if resources_enabled:
                for days_before in resource_days:
                    if expires_on != today_local + timedelta(days=days_before):
                        continue
                    result["checked"] += 1
                    for user in contractors:
                        if not force and _was_sent(
                            company_id=int(company.id),
                            kind=kind,
                            expires_on=expires_on,
                            days_before=days_before,
                            user_id=int(user.id),
                        ):
                            continue
                        ok, msg = _send_resource_reminder(
                            user=user,
                            company=company,
                            kind=kind,
                            expires_on=expires_on,
                            days_before=days_before,
                        )
                        if ok:
                            result["sent"] += 1
                            if not force:
                                _record_sent(
                                    company_id=int(company.id),
                                    kind=kind,
                                    expires_on=expires_on,
                                    days_before=days_before,
                                    user_id=int(user.id),
                                )
                        else:
                            result["failed"] += 1
                            result["messages"].append(msg)
    return result


def run_scheduled_contractor_compliance_reminders() -> dict[str, Any]:
    return run_contractor_compliance_reminders(force=False)
