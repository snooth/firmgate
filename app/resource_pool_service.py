"""Resource Pool — standalone DB records (separate from workforce User roster)."""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any
from uuid import uuid4

from app.extensions import db
from app.models import ResourcePoolResource, utcnow


def _s(v: Any) -> str:
    return ("" if v is None else str(v)).strip()


def _parse_ymd(raw: str) -> date | None:
    vv = _s(raw)
    if not vv:
        return None
    if len(vv) >= 10 and vv[4] in "-/" and vv[:4].isdigit():
        try:
            return datetime.strptime(vv[:10].replace("/", "-"), "%Y-%m-%d").date()
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(vv, fmt).date()
        except ValueError:
            pass
    return None


def _filled(val) -> bool:
    if val is None:
        return False
    if isinstance(val, bool):
        return True
    if isinstance(val, list):
        return len(val) > 0
    s = _s(val)
    return bool(s) and s not in ("—", "-", "None")


def _display_name(row: ResourcePoolResource) -> str:
    full = _s(row.full_name)
    if full:
        return full
    g, f = _s(row.given_name), _s(row.family_name)
    return f"{g} {f}".strip() or "Unnamed resource"


def _initials(name: str) -> str:
    parts = [p for p in name.split() if p]
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    if parts:
        return parts[0][:2].upper()
    return "?"


def _normalize_skills(raw) -> list[str]:
    out: list[str] = []
    if isinstance(raw, list):
        for it in raw:
            t = _s(it)
            if t:
                out.append(t[:80])
    elif isinstance(raw, str) and raw.strip():
        for part in raw.replace(";", ",").split(","):
            t = part.strip()
            if t:
                out.append(t[:80])
    return out[:24]


def _availability(
    *,
    today: date,
    start: date | None,
    end: date | None,
) -> tuple[str, int | None, str]:
    if end and end < today:
        return "unavailable", None, "Unavailable"
    if start and start > today:
        days = (start - today).days
        if days <= 30:
            return "available_soon", days, f"Available in {days} day{'s' if days != 1 else ''}"
        return "unavailable", days, f"Starts in {days} days"
    if end:
        days_left = (end - today).days
        if days_left <= 30:
            return "available_now", days_left, "Available now"
        return "available_now", None, "Available now"
    if start and start <= today:
        return "available_now", None, "Available now"
    return "available_now", None, "Available now"


def _resolve_availability(row: ResourcePoolResource, today: date) -> tuple[str, int | None, str]:
    override = _s(getattr(row, "availability_override", "") or "")
    if override == "available_now":
        return "available_now", None, "Available now"
    if override == "unavailable":
        return "unavailable", None, "Not available"
    start = _parse_ymd(row.contract_start_date)
    end = _parse_ymd(row.contract_end_date)
    return _availability(today=today, start=start, end=end)


def compliance_gaps(row: ResourcePoolResource) -> list[str]:
    gaps: list[str] = []

    def need(label: str, val) -> None:
        if not _filled(val):
            gaps.append(label)

    need("Name", _display_name(row))
    need("Email", row.email)
    need("Phone", row.phone)
    need("Job title", row.job_title)
    need("Location", row.location)
    if not _normalize_skills(row.skills):
        gaps.append("Skills")
    return gaps


def _cleared_from_row(row: ResourcePoolResource) -> bool:
    level = _s(row.clearance_level)
    status = _s(row.clearance_status).lower()
    return bool(level) and status not in ("expired", "deactivated", "archived", "")


def resource_to_api_dict(row: ResourcePoolResource) -> dict[str, Any]:
    today = date.today()
    name = _display_name(row)
    start = _parse_ymd(row.contract_start_date)
    end = _parse_ymd(row.contract_end_date)
    status_key, days_until, status_label = _resolve_availability(row, today)
    avail_override = _s(getattr(row, "availability_override", "") or "")
    skills = _normalize_skills(row.skills)
    gaps = compliance_gaps(row)
    notes = _notes_for_api(row)
    level = _s(row.clearance_level) or "—"
    loc = _s(row.location)
    if loc == "Other" and _s(row.location_detail):
        loc = f"{loc} — {_s(row.location_detail)}"

    updated = row.updated_at or row.created_at or utcnow()
    updated_iso = updated.isoformat() if hasattr(updated, "isoformat") else ""

    cv = row.cv_document if isinstance(row.cv_document, dict) else {}
    cv_stored = _s(cv.get("stored"))

    return {
        "id": int(row.id),
        "name": name,
        "given_name": _s(row.given_name),
        "family_name": _s(row.family_name),
        "full_name": _s(row.full_name) or name,
        "initials": _initials(name),
        "tone": int(row.id) % 6,
        "subtitle": _s(row.job_title) or _s(row.department) or _s(row.employment_type),
        "department": _s(row.department),
        "job_title": _s(row.job_title),
        "employment_type": _s(row.employment_type) or "Employee",
        "location": loc or "—",
        "location_detail": _s(row.location_detail),
        "remote_friendly": bool(row.remote_friendly),
        "skills": skills,
        "clearance_level": level,
        "cleared": _cleared_from_row(row),
        "clearance_status": _s(row.clearance_status),
        "clearance_expiry": _s(row.clearance_expiry),
        "availability_status": status_key,
        "availability_label": status_label,
        "availability_days": days_until,
        "availability_override": avail_override or "auto",
        "email": _s(row.email),
        "phone": _s(row.phone),
        "reports_to": _s(row.reports_to) or "—",
        "about": _s(row.about),
        "hourly_rate": _s(row.hourly_rate),
        "daily_rate": _s(row.daily_rate),
        "contract_start": _s(row.contract_start_date),
        "resource_added": (row.created_at.isoformat() if getattr(row, "created_at", None) else ""),
        "contract_end": end.isoformat() if end else _s(row.contract_end_date),
        "compliance_gaps": gaps,
        "notes": notes,
        "notes_count": len(notes),
        "updated_at": updated_iso,
        "has_cv": bool(cv_stored),
        "cv_original_name": _s(cv.get("original_name")),
        "cv_mime": _s(cv.get("mime")) or "application/pdf",
        "cv_stored": cv_stored,
        "cv_uploaded_at": _s(cv.get("uploaded_at")),
    }


def list_active_resources() -> list[ResourcePoolResource]:
    return (
        ResourcePoolResource.query.filter(ResourcePoolResource.is_active.is_(True))
        .order_by(ResourcePoolResource.full_name.asc(), ResourcePoolResource.id.asc())
        .all()
    )


def build_resource_pool_payload(*, clearance_records: list[dict] | None = None) -> dict[str, Any]:
    """Build API payload for Resource Pool UI from resource_pool_resources table."""
    rows = list_active_resources()
    resources = [resource_to_api_dict(r) for r in rows]
    skill_gap_labels: set[str] = set()
    for r in resources:
        for g in r.get("compliance_gaps") or []:
            skill_gap_labels.add(g)

    total = len(resources)
    available_now = sum(1 for r in resources if r["availability_status"] == "available_now")
    available_30 = sum(
        1
        for r in resources
        if r["availability_status"] == "available_soon"
        or (
            r["availability_status"] == "available_now"
            and r.get("availability_days") is not None
            and int(r["availability_days"]) <= 30
        )
    )
    cleared_count = sum(1 for r in resources if r["cleared"])

    skill_options = sorted({sk for r in resources for sk in r.get("skills") or [] if sk})[:80]
    clearance_options = sorted(
        {r["clearance_level"] for r in resources if r["clearance_level"] and r["clearance_level"] != "—"}
    )
    location_options = sorted({r["location"] for r in resources if r["location"] and r["location"] != "—"})[:40]
    employment_options = sorted({r["employment_type"] for r in resources if r["employment_type"]})

    return {
        "resources": resources,
        "kpis": {
            "total": total,
            "available_now": available_now,
            "available_now_pct": round((available_now / total) * 100, 1) if total else 0,
            "available_30": available_30,
            "available_30_pct": round((available_30 / total) * 100, 1) if total else 0,
            "cleared": cleared_count,
            "cleared_pct": round((cleared_count / total) * 100, 1) if total else 0,
            "skill_gaps": len(skill_gap_labels),
        },
        "filters": {
            "skills": skill_options,
            "clearance_levels": clearance_options,
            "locations": location_options,
            "employment_types": employment_options,
            "skill_gap_labels": sorted(skill_gap_labels)[:40],
        },
    }


def _apply_payload(row: ResourcePoolResource, data: dict) -> None:
    full = _s(data.get("full_name"))
    given = _s(data.get("given_name"))
    family = _s(data.get("family_name"))
    if full:
        row.full_name = full[:255]
    elif given or family:
        row.given_name = given[:120]
        row.family_name = family[:120]
        row.full_name = f"{given} {family}".strip()[:255]
    elif "full_name" in data or "given_name" in data or "family_name" in data:
        row.full_name = full[:255]
        row.given_name = given[:120]
        row.family_name = family[:120]

    scalar_fields = (
        ("email", 255),
        ("phone", 80),
        ("job_title", 255),
        ("department", 255),
        ("employment_type", 64),
        ("location", 255),
        ("location_detail", 255),
        ("clearance_level", 40),
        ("clearance_status", 40),
        ("clearance_expiry", 32),
        ("contract_start_date", 32),
        ("contract_end_date", 32),
        ("reports_to", 255),
        ("hourly_rate", 32),
        ("daily_rate", 32),
    )
    for key, maxlen in scalar_fields:
        if key in data:
            setattr(row, key, _s(data.get(key))[:maxlen])

    if "remote_friendly" in data:
        row.remote_friendly = bool(data.get("remote_friendly"))
    if "about" in data:
        row.about = _s(data.get("about"))[:8000]
    if "skills" in data:
        row.skills = _normalize_skills(data.get("skills"))
    if "notes" in data and isinstance(data.get("notes"), list):
        row.notes = data["notes"]


def create_resource(data: dict, *, actor_id: int | None) -> ResourcePoolResource:
    name = _s(data.get("full_name")) or f"{_s(data.get('given_name'))} {_s(data.get('family_name'))}".strip()
    if not name:
        raise ValueError("name required")
    row = ResourcePoolResource(
        full_name=name[:255],
        given_name=_s(data.get("given_name"))[:120],
        family_name=_s(data.get("family_name"))[:120],
        created_by_id=actor_id,
        updated_by_id=actor_id,
    )
    _apply_payload(row, data)
    if not _s(row.employment_type):
        row.employment_type = "Employee"
    db.session.add(row)
    db.session.commit()
    return row


def update_resource(row: ResourcePoolResource, data: dict, *, actor_id: int | None) -> ResourcePoolResource:
    _apply_payload(row, data)
    row.updated_by_id = actor_id
    row.updated_at = utcnow()
    db.session.commit()
    return row


def delete_resource(row: ResourcePoolResource) -> None:
    row.is_active = False
    row.updated_at = utcnow()
    db.session.commit()


def get_resource(resource_id: int) -> ResourcePoolResource | None:
    row = db.session.get(ResourcePoolResource, resource_id)
    if not row or not row.is_active:
        return None
    return row


def _touch(row: ResourcePoolResource, *, actor_id: int | None) -> None:
    row.updated_by_id = actor_id
    row.updated_at = utcnow()


def update_resource_skills(
    row: ResourcePoolResource, raw: str | list, *, actor_id: int | None
) -> ResourcePoolResource:
    row.skills = _normalize_skills(raw)
    _touch(row, actor_id=actor_id)
    db.session.commit()
    return row


def update_resource_overview(
    row: ResourcePoolResource, data: dict, *, actor_id: int | None
) -> ResourcePoolResource:
    allowed = {
        "email",
        "phone",
        "location",
        "location_detail",
        "remote_friendly",
        "clearance_level",
        "clearance_status",
        "clearance_expiry",
        "employment_type",
        "about",
        "availability_override",
    }
    patch = {k: data[k] for k in allowed if k in data}
    if "availability_override" in patch:
        ov = _s(patch.get("availability_override")).lower()
        if ov in ("auto", "automatic", ""):
            row.availability_override = ""
        elif ov in ("available_now", "available"):
            row.availability_override = "available_now"
        elif ov in ("unavailable", "not_available", "not available"):
            row.availability_override = "unavailable"
        else:
            row.availability_override = ov[:32]
        patch = {k: v for k, v in patch.items() if k != "availability_override"}
    _apply_payload(row, patch)
    _touch(row, actor_id=actor_id)
    db.session.commit()
    return row


def update_resource_experience(
    row: ResourcePoolResource, data: dict, *, actor_id: int | None
) -> ResourcePoolResource:
    allowed = {
        "job_title",
        "department",
        "reports_to",
        "contract_start_date",
        "contract_end_date",
        "hourly_rate",
        "daily_rate",
    }
    patch = {k: data[k] for k in allowed if k in data}
    _apply_payload(row, patch)
    _touch(row, actor_id=actor_id)
    db.session.commit()
    return row


def _plain_from_html(html: str) -> str:
    t = re.sub(r"<[^>]+>", " ", html or "")
    return re.sub(r"\s+", " ", t).strip()[:4000]


def _notes_for_api(row: ResourcePoolResource) -> list[dict[str, Any]]:
    from markupsafe import escape

    raw = row.notes if isinstance(row.notes, list) else []
    out: list[dict[str, Any]] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        text = _s(item.get("text") or item.get("body") or "")
        body_html = _s(item.get("body_html") or "")
        if not body_html and text:
            body_html = f"<p>{escape(text)}</p>"
        out.append(
            {
                "id": _s(item.get("id")) or str(i),
                "text": text or _plain_from_html(body_html),
                "body_html": body_html,
                "author_id": item.get("author_id"),
                "author_name": _s(item.get("author_name") or "Unknown") or "Unknown",
                "created_at": _s(item.get("created_at") or ""),
            }
        )
    return out


def append_resource_note(
    row: ResourcePoolResource,
    *,
    body_html: str,
    actor_id: int | None,
    author_name: str,
) -> ResourcePoolResource:
    from app.wiki_sanitize import sanitize_wiki_html

    cleaned = sanitize_wiki_html((body_html or "").strip())
    if not cleaned or cleaned in ("<br>", "<p><br></p>", "<div><br></div>"):
        raise ValueError("note is empty")
    notes = list(row.notes) if isinstance(row.notes, list) else []
    notes.append(
        {
            "id": uuid4().hex[:12],
            "body_html": cleaned[:280000],
            "text": _plain_from_html(cleaned),
            "author_id": actor_id,
            "author_name": (author_name or "Unknown").strip()[:120],
            "created_at": utcnow().isoformat(),
        }
    )
    row.notes = notes[-500:]
    _touch(row, actor_id=actor_id)
    db.session.commit()
    return row


def update_resource_notes_from_text(
    row: ResourcePoolResource, text: str, *, actor_id: int | None
) -> ResourcePoolResource:
    lines = [ln.strip() for ln in (text or "").replace("\r", "").split("\n") if ln.strip()]
    now = utcnow().isoformat()
    row.notes = [{"text": ln[:4000], "created_at": now} for ln in lines[:200]]
    _touch(row, actor_id=actor_id)
    db.session.commit()
    return row


def set_resource_cv(
    row: ResourcePoolResource,
    *,
    original_name: str,
    stored: str,
    mime: str,
    actor_id: int | None,
) -> ResourcePoolResource:
    row.cv_document = {
        "original_name": original_name[:240],
        "stored": stored[:120],
        "mime": mime[:120] or "application/pdf",
        "uploaded_at": utcnow().isoformat(),
    }
    _touch(row, actor_id=actor_id)
    db.session.commit()
    return row


def clear_resource_cv(row: ResourcePoolResource, *, actor_id: int | None) -> ResourcePoolResource:
    row.cv_document = {}
    _touch(row, actor_id=actor_id)
    db.session.commit()
    return row


def cv_upload_dir(resource_id: int):
    from pathlib import Path
    from flask import current_app

    out = Path(str(current_app.config.get("UPLOAD_ROOT"))) / "resource_pool" / str(resource_id)
    out.mkdir(parents=True, exist_ok=True)
    return out


def create_resource_with_cv(
    data: dict,
    *,
    file_bytes: bytes,
    original_name: str,
    mime: str,
    actor_id: int | None,
) -> ResourcePoolResource:
    """Create a resource and attach an uploaded CV in one transaction."""
    from uuid import uuid4

    row = create_resource(data, actor_id=actor_id)
    suf = ""
    if "." in original_name:
        suf = "." + original_name.rsplit(".", 1)[-1].lower()
    if suf not in (".pdf", ".docx"):
        suf = ".pdf"
    stored = f"{uuid4().hex}{suf}"
    out_dir = cv_upload_dir(row.id)
    (out_dir / stored).write_bytes(file_bytes)
    set_resource_cv(
        row,
        original_name=original_name,
        stored=stored,
        mime=mime,
        actor_id=actor_id,
    )
    return row


def resolve_cv_path(resource_id: int, stored: str):
    from pathlib import Path

    root = cv_upload_dir(resource_id)
    try:
        base = root.resolve()
        path = (base / stored).resolve()
        if base not in path.parents and path != base:
            return None
    except Exception:
        return None
    if path.is_file():
        return path
    return None
