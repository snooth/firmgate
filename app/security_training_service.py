"""Per-user Security Training completion (stored on User.attributes).

Completion for each module is stored as an ISO UTC timestamp. We derive an overall
"fully completed at" timestamp as the latest completion time across required modules.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models import FileNode, User

ATTR_COMPLETED = "security_training_completed"

_ST_VIDEO_EXT = frozenset({"mp4", "webm", "mov"})
_ST_SLIDE_EXT = frozenset({"ppt", "pptx", "pps", "ppsx", "ppsm", "pptm", "odp", "pot", "potx", "potm"})
_ST_PDF_EXT = frozenset({"pdf"})
_ST_DOC_EXT = frozenset({"doc", "docx", "odt", "rtf", "txt"})
_ST_SHEET_EXT = frozenset({"xls", "xlsx", "ods", "csv"})


def training_kind_from_ext(ext: str) -> str | None:
    e = (ext or "").lower().strip()
    if e in _ST_VIDEO_EXT:
        return "video"
    if e in _ST_SLIDE_EXT:
        return "slides"
    if e in _ST_PDF_EXT:
        return "pdf"
    if e in _ST_DOC_EXT:
        return "document"
    if e in _ST_SHEET_EXT:
        return "spreadsheet"
    return None


def training_kind_from_filename(name: str) -> str | None:
    n = name or ""
    if "." not in n:
        return None
    return training_kind_from_ext(n.rsplit(".", 1)[-1])


def _attrs(user: User) -> dict:
    a = user.attributes
    return dict(a) if isinstance(a, dict) else {}


def completed_map(user: User) -> dict[str, str]:
    raw = _attrs(user).get(ATTR_COMPLETED)
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in raw.items():
        if v:
            out[str(k)] = str(v)
    return out


def is_completed(user: User, file_node_id: int) -> bool:
    return str(int(file_node_id)) in completed_map(user)


def mark_completed(user: User, file_node_id: int) -> str:
    """Record completion; returns ISO timestamp."""
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    attrs = _attrs(user)
    cur = completed_map(user)
    cur[str(int(file_node_id))] = now
    attrs[ATTR_COMPLETED] = cur
    user.attributes = attrs
    return now


def progress_summary(user: User, file_ids: list[int]) -> dict:
    done = completed_map(user)
    total = len(file_ids)
    completed = sum(1 for fid in file_ids if str(int(fid)) in done)
    all_complete = total > 0 and completed >= total
    fc = fully_completed_at(user, file_ids) if all_complete else None
    nr = next_refresh_at(user, file_ids) if all_complete else None
    return {
        "total": total,
        "completed": completed,
        "all_complete": all_complete,
        "fully_completed_at": fc,
        "next_refresh_at": nr,
    }


def fully_completed_at(user: User, file_ids: list[int]) -> str | None:
    """
    ISO timestamp for when the user finished all required training modules.

    Defined as the latest completion timestamp among the required `file_ids`,
    but only returned when every module is complete.
    """
    done = completed_map(user)
    if not file_ids:
        return None
    stamps: list[str] = []
    for fid in file_ids:
        v = done.get(str(int(fid)))
        if not v:
            return None
        stamps.append(str(v))
    if not stamps:
        return None
    # Lexicographic max works for ISO 8601 UTC strings without microseconds.
    return max(stamps)


def _add_12_months(iso_utc: str) -> str | None:
    """Add 12 months to an ISO datetime string (UTC), keeping day when possible."""
    try:
        dt = datetime.fromisoformat(str(iso_utc))
    except Exception:
        return None
    # Normalise naive datetimes to UTC (stored values are UTC).
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    y = dt.year + 1
    try:
        out = dt.replace(year=y)
    except ValueError:
        # Feb 29 → Feb 28 on non-leap years.
        out = dt.replace(year=y, day=28)
    return out.replace(microsecond=0).isoformat()


def next_refresh_at(user: User, file_ids: list[int]) -> str | None:
    """ISO timestamp 12 months after `fully_completed_at`."""
    fc = fully_completed_at(user, file_ids)
    if not fc:
        return None
    return _add_12_months(fc)


def user_progress_row(user: User, file_ids: list[int]) -> dict:
    """Per-user training status for officer dashboards."""
    summary = progress_summary(user, file_ids)
    total = int(summary["total"])
    completed = int(summary["completed"])
    if total <= 0:
        status = "no_training"
    elif summary["all_complete"]:
        status = "complete"
    elif completed > 0:
        status = "in_progress"
    else:
        status = "not_started"
    return {
        "user_id": user.id,
        "username": user.username or "",
        "email": user.email or "",
        "full_name": (user.full_name or "").strip(),
        "status": status,
        **summary,
    }


DEFAULT_PAGE_INTRO_PLAIN = (
    "Training packs, PDFs, Office documents, presentations, and videos from the Security Training folder."
)


def _coerce_settings(raw) -> dict:
    return dict(raw) if isinstance(raw, dict) else {}


def get_security_training_settings() -> dict:
    from app.settings import get_setting

    return _coerce_settings(get_setting("security_training", default={}))


def page_intro_html_raw() -> str:
    v = get_security_training_settings()
    raw = str(v.get("page_intro_html") or "").strip()
    return raw


def page_intro_markup():
    """Safe HTML for the Security Training page hero subtitle."""
    from markupsafe import Markup

    from app.html_clean import plain_about_body_to_html, render_about_body_markup

    raw = page_intro_html_raw()
    if not raw:
        return Markup(plain_about_body_to_html(DEFAULT_PAGE_INTRO_PLAIN))
    return Markup(render_about_body_markup(raw))


def security_training_settings_for_api() -> dict:
    ids = get_security_training_settings().get("allowed_user_ids")
    if not isinstance(ids, list):
        ids = []
    clean: list[int] = []
    seen: set[int] = set()
    for x in ids[:800]:
        try:
            i = int(x)
        except (TypeError, ValueError):
            continue
        if i in seen:
            continue
        seen.add(i)
        clean.append(i)
    return {
        "allowed_user_ids": clean,
        "page_intro_html": page_intro_html_raw(),
        "default_page_intro_plain": DEFAULT_PAGE_INTRO_PLAIN,
    }


def merge_security_training_settings(payload: dict) -> dict:
    """Merge admin payload into security_training setting; returns API dict."""
    from app.html_clean import sanitize_about_html
    from app.settings import set_setting

    cfg = dict(get_security_training_settings())
    if "allowed_user_ids" in payload:
        ids = payload.get("allowed_user_ids")
        if not isinstance(ids, list):
            ids = []
        clean: list[int] = []
        seen: set[int] = set()
        for x in ids[:800]:
            try:
                i = int(x)
            except (TypeError, ValueError):
                continue
            if i in seen:
                continue
            seen.add(i)
            clean.append(i)
        cfg["allowed_user_ids"] = clean
    if "page_intro_html" in payload:
        cfg["page_intro_html"] = sanitize_about_html(str(payload.get("page_intro_html") or ""))[:50000]
    set_setting("security_training", cfg)
    return security_training_settings_for_api()
