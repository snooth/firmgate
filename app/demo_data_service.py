"""Incremental demo data seeding for development and demos (20% of each section per click)."""

from __future__ import annotations

import math
import re
import time
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func

from app import rbac
from app.extensions import db
from app.files_workspace import ensure_user_workspace_folder
from app.models import (
    AppSetting,
    BlogPost,
    CalendarEvent,
    ChatMessage,
    ChatRoom,
    ChatRoomMember,
    ContractorCompany,
    FileNode,
    Role,
    SkyControlScore,
    User,
    WikiPage,
    utcnow,
)
from app.settings import get_setting

DEMO_PROGRESS_KEY = "demo_data_progress"
DEMO_USER_PASSWORD = "demo123"

_POOL_EMPLOYEES: list[dict[str, Any]] = [
    {"full_name": "Sarah Johnson", "email": "demo.sarah.johnson@example.com", "department": "Sales", "job_title": "Account Executive", "location": "Sydney", "workforce_project": "Horizon"},
    {"full_name": "Mike Thompson", "email": "demo.mike.thompson@example.com", "department": "Delivery", "job_title": "Project Manager", "location": "Canberra", "workforce_project": "Atlas"},
    {"full_name": "Emily Davis", "email": "demo.emily.davis@example.com", "department": "Engineering", "job_title": "Solutions Architect", "location": "Melbourne", "workforce_project": "Horizon"},
    {"full_name": "David Lee", "email": "demo.david.lee@example.com", "department": "Sales", "job_title": "Business Development", "location": "Brisbane", "workforce_project": "Summit"},
    {"full_name": "Rachel Green", "email": "demo.rachel.green@example.com", "department": "Support", "job_title": "Service Lead", "location": "Perth", "workforce_project": "Atlas"},
    {"full_name": "James Wilson", "email": "demo.james.wilson@example.com", "department": "Security", "job_title": "Security Analyst", "location": "Sydney", "workforce_project": "Guardian"},
    {"full_name": "Olivia Martin", "email": "demo.olivia.martin@example.com", "department": "HR", "job_title": "People Partner", "location": "Adelaide", "workforce_project": "Unassigned"},
    {"full_name": "Noah Taylor", "email": "demo.noah.taylor@example.com", "department": "Finance", "job_title": "Finance Manager", "location": "Sydney", "workforce_project": "Summit"},
    {"full_name": "Ava Brown", "email": "demo.ava.brown@example.com", "department": "Marketing", "job_title": "Communications Lead", "location": "Melbourne", "workforce_project": "Horizon"},
    {"full_name": "Liam Cooper", "email": "demo.liam.cooper@example.com", "department": "Engineering", "job_title": "DevOps Engineer", "location": "Canberra", "workforce_project": "Atlas"},
]

_POOL_CONTRACTOR_COMPANIES: list[dict[str, str]] = [
    {"name": "Northwind Consulting Pty Ltd", "abn": "12 345 678 901", "company_rep": "Alex North"},
    {"name": "Summit ICT Services", "abn": "98 765 432 109", "company_rep": "Priya Summit"},
]

_POOL_CONTRACTORS: list[dict[str, Any]] = [
    {"full_name": "Charlie Moore", "email": "demo.charlie.moore@contractor.example.com", "company_idx": 0, "job_title": "Senior Developer"},
    {"full_name": "Jessica Thompson", "email": "demo.jessica.thompson@contractor.example.com", "company_idx": 0, "job_title": "Business Analyst"},
    {"full_name": "Ravi Kumar", "email": "demo.ravi.kumar@contractor.example.com", "company_idx": 1, "job_title": "Cloud Engineer"},
    {"full_name": "Liam Wong", "email": "demo.liam.wong@contractor.example.com", "company_idx": 1, "job_title": "UX Designer"},
    {"full_name": "Maya Singh", "email": "demo.maya.singh@contractor.example.com", "company_idx": 0, "job_title": "Test Lead"},
]

_POOL_WORKFORCE_PROJECTS: list[dict[str, str]] = [
    {"name": "Horizon", "director": "Sarah Johnson", "contract_end": "2026-12-31"},
    {"name": "Atlas", "director": "Mike Thompson", "contract_end": "2027-06-30"},
    {"name": "Summit", "director": "David Lee", "contract_end": "2026-09-30"},
    {"name": "Guardian", "director": "James Wilson", "contract_end": "2027-03-31"},
    {"name": "Pulse", "director": "Emily Davis", "contract_end": "2026-11-15"},
]

_POOL_BLOGS: list[dict[str, str]] = [
    {"title": "Welcome to Firmgate", "category": "Company", "excerpt": "A quick tour of what's new.", "body": "<p>We have refreshed the portal with blogs, wiki, and team chat.</p>"},
    {"title": "Security awareness month", "category": "Security", "excerpt": "Tips for staying safe online.", "body": "<p>Complete your security training and report suspicious email.</p>"},
    {"title": "Quarterly town hall recap", "category": "Events", "excerpt": "Highlights from this week's session.", "body": "<p>Thank you to everyone who joined the town hall.</p>"},
    {"title": "New CRM pipeline launched", "category": "Sales", "excerpt": "Track leads from first contact to close.", "body": "<p>Sales teams can now manage leads in the CRM module.</p>"},
    {"title": "Office reopening guidelines", "category": "HR", "excerpt": "Hybrid work expectations.", "body": "<p>Review the updated workplace policy on the wiki.</p>"},
]

_POOL_EVENTS: list[dict[str, str]] = [
    {"title": "All-hands meeting", "location": "Main conference room", "notes": "Monthly company update"},
    {"title": "Project Horizon checkpoint", "location": "Teams", "notes": "Delivery review"},
    {"title": "Security training workshop", "location": "Training room B", "notes": "Mandatory for new starters"},
    {"title": "CRM pipeline review", "location": "Sales floor", "notes": "Q2 forecast"},
    {"title": "Social club lunch", "location": "Cafe downstairs", "notes": "Optional"},
]

_POOL_WIKI: list[dict[str, str]] = [
    {"title": "Getting started", "slug": "getting-started", "body_md": "# Getting started\n\nUse the sidebar to browse modules."},
    {"title": "IT support", "slug": "it-support", "body_md": "# IT support\n\nLog requests via the service desk."},
    {"title": "Leave policy", "slug": "leave-policy", "body_md": "# Leave\n\nApply through your manager."},
    {"title": "Document standards", "slug": "document-standards", "body_md": "# Documents\n\nStore files under your user folder."},
    {"title": "Security classification guide", "slug": "security-classification", "body_md": "# Classification\n\nFollow the handling rules for each level."},
]

_POOL_CHAT_MESSAGES: list[str] = [
    "Welcome to the demo team chat channel.",
    "Reminder: town hall is tomorrow at 10:00.",
    "Has anyone tested the new CRM leads view?",
    "Security training due by end of month.",
    "Great work on the Horizon milestone this week.",
]

_POOL_DOC_FOLDERS: list[str] = [
    "Demo proposals",
    "Demo policies",
    "Demo project files",
]

_POOL_SKY_SCORES: list[dict[str, int]] = [
    {"score": 12400, "landed": 18, "wave": 3},
    {"score": 9800, "landed": 14, "wave": 2},
    {"score": 15200, "landed": 22, "wave": 4},
]

_POOL_HOME_ANNOUNCEMENTS: list[dict[str, str]] = [
    {"category": "Company", "title": "Welcome", "body_html": "<p>Demo announcement: explore the refreshed home page.</p>"},
    {"category": "Security", "title": "Training reminder", "body_html": "<p>Complete security training when you have a moment.</p>"},
    {"category": "Events", "title": "Town hall", "body_html": "<p>Join us for the monthly all-hands.</p>"},
    {"category": "IT", "title": "Maintenance window", "body_html": "<p>Scheduled maintenance this weekend.</p>"},
    {"category": "HR", "title": "Benefits update", "body_html": "<p>Review the updated benefits guide on the wiki.</p>"},
]

_POOL_ABOUT_GLANCE: list[dict[str, str]] = [
    {"value": "2019", "label": "Founded", "subtitle": "Established in Australia"},
    {"value": "150+", "label": "Employees", "subtitle": "Across Australia"},
    {"value": "3", "label": "Offices", "subtitle": "Australia-wide"},
    {"value": "24/7", "label": "Support", "subtitle": "Always here to help"},
]

_POOL_ABOUT_BODY: list[dict[str, Any]] = [
    {
        "who_title": "Who we are",
        "who_body": "<p>We are a demo organisation showcasing Firmgate modules: workforce, CRM, documents, security clearance, and more.</p>",
        "links": [
            {"label": "Policies & documents", "url": "/intranet/documents"},
            {"label": "Employee directory", "url": "/intranet/directory"},
            {"label": "Files", "url": "/intranet/documents"},
        ],
    }
]

_SECTION_POOLS: dict[str, list[Any]] = {
    "employees": _POOL_EMPLOYEES,
    "contractor_companies": _POOL_CONTRACTOR_COMPANIES,
    "contractors": _POOL_CONTRACTORS,
    "workforce_projects": _POOL_WORKFORCE_PROJECTS,
    "blogs": _POOL_BLOGS,
    "events": _POOL_EVENTS,
    "wiki_pages": _POOL_WIKI,
    "chat_messages": _POOL_CHAT_MESSAGES,
    "document_folders": _POOL_DOC_FOLDERS,
    "sky_scores": _POOL_SKY_SCORES,
    "home_announcements": _POOL_HOME_ANNOUNCEMENTS,
    "about_glance": _POOL_ABOUT_GLANCE,
    "about_page": _POOL_ABOUT_BODY,
}


def _slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s[:140] or "item"


def _batch_size(pool_len: int, current: int) -> int:
    if current >= pool_len:
        return 0
    chunk = max(1, math.ceil(pool_len * 0.2))
    return min(chunk, pool_len - current)


def _load_progress() -> dict[str, int]:
    raw = get_setting(DEMO_PROGRESS_KEY, default={}) or {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, int] = {}
    for k, v in raw.items():
        try:
            out[str(k)] = max(0, int(v))
        except (TypeError, ValueError):
            continue
    return out


def _save_progress(progress: dict[str, int]) -> None:
    row = db.session.get(AppSetting, DEMO_PROGRESS_KEY)
    if not row:
        row = AppSetting(key=DEMO_PROGRESS_KEY, value=progress)
        db.session.add(row)
    else:
        row.value = progress


def _put_setting(key: str, value: Any) -> None:
    row = db.session.get(AppSetting, key)
    if not row:
        db.session.add(AppSetting(key=key, value=value))
    else:
        row.value = value


def _assign_standard_role(user: User) -> None:
    std = db.session.query(Role).filter(Role.name == "standard").first()
    if std:
        user.roles = [std]


def _ensure_demo_user(spec: dict[str, Any], *, contractor: bool = False, company_id: int | None = None) -> tuple[User | None, bool]:
    email = str(spec.get("email") or "").strip().lower()
    if not email:
        return None, False
    existing = db.session.query(User).filter(func.lower(User.email) == email).first()
    if existing:
        return existing, False

    attrs: dict[str, Any] = {
        "department": spec.get("department") or ("Contractors" if contractor else "Demo"),
        "job_title": spec.get("job_title") or "",
        "location": spec.get("location") or "",
        "workforce_project": spec.get("workforce_project") or "Unassigned",
        "mfa_required": False,
        "intranet_login_enabled": True,
    }
    if contractor:
        attrs["is_contractor"] = True
        if company_id:
            attrs["contractor_company_id"] = company_id

    user = User(
        username=email,
        email=email,
        full_name=str(spec.get("full_name") or "").strip() or email,
        is_active=True,
        attributes=attrs,
    )
    user.set_password(DEMO_USER_PASSWORD)
    db.session.add(user)
    db.session.flush()
    _assign_standard_role(user)
    rbac.ensure_user_in_general_group(user, db.session)
    ensure_user_workspace_folder(user)
    return user, True


def _event_date(offset_days: int) -> str:
    return (date.today() + timedelta(days=offset_days)).strftime("%Y-%m-%d")


def _seed_employees(items: list[dict], actor_id: int) -> int:
    added = 0
    for spec in items:
        _, created = _ensure_demo_user(spec, contractor=False)
        if created:
            added += 1
    return added


def _seed_contractor_companies(start: int, count: int) -> tuple[int, dict[int, ContractorCompany]]:
    mapping: dict[int, ContractorCompany] = {}
    added = 0
    for idx in range(start, min(start + count, len(_POOL_CONTRACTOR_COMPANIES))):
        spec = _POOL_CONTRACTOR_COMPANIES[idx]
        name = spec["name"]
        row = db.session.query(ContractorCompany).filter(ContractorCompany.name == name).first()
        if not row:
            row = ContractorCompany(
                name=name,
                abn=spec.get("abn"),
                company_rep=spec.get("company_rep"),
            )
            db.session.add(row)
            db.session.flush()
            added += 1
        mapping[idx] = row
    return added, mapping


def _seed_contractors(items: list[dict], companies: dict[int, ContractorCompany]) -> int:
    added = 0
    for spec in items:
        idx = int(spec.get("company_idx") or 0)
        company = companies.get(idx)
        _, created = _ensure_demo_user(
            spec,
            contractor=True,
            company_id=(company.id if company else None),
        )
        if created:
            added += 1
    return added


def _seed_workforce_projects(items: list[dict]) -> int:
    cur = get_setting("workforce_directory_projects", default=[]) or []
    cur_list = list(cur) if isinstance(cur, list) else []
    names = {str(x.get("name") or "").strip() for x in cur_list if isinstance(x, dict)}
    added = 0
    for spec in items:
        if spec["name"] in names:
            continue
        cur_list.append(dict(spec))
        names.add(spec["name"])
        added += 1
    if added:
        _put_setting("workforce_directory_projects", cur_list)
    return added


def _seed_blogs(items: list[dict], actor_id: int) -> int:
    added = 0
    for spec in items:
        title = spec["title"]
        if db.session.query(BlogPost).filter(BlogPost.title == title).first():
            continue
        slug = _slugify(title)
        i = 1
        while db.session.query(BlogPost).filter(BlogPost.slug == slug).first():
            i += 1
            slug = f"{_slugify(title)}-{i}"
        post = BlogPost(
            slug=slug,
            title=title[:255],
            excerpt=spec.get("excerpt", "")[:1000],
            body=spec.get("body"),
            category=spec.get("category"),
            status="published",
            published_at=utcnow(),
            created_by_id=actor_id,
        )
        db.session.add(post)
        added += 1
    return added


def _seed_events(items: list[dict], actor_id: int, start_offset: int) -> int:
    added = 0
    for i, spec in enumerate(items):
        title = spec["title"]
        if db.session.query(CalendarEvent).filter(CalendarEvent.title == title).first():
            continue
        ev = CalendarEvent(
            title=title[:255],
            date=_event_date(start_offset + i * 3),
            all_day=False,
            start="10:00",
            end="11:00",
            location=spec.get("location"),
            notes=spec.get("notes"),
            created_by_id=actor_id,
        )
        db.session.add(ev)
        added += 1
    return added


def _seed_wiki(items: list[dict], actor_id: int) -> int:
    added = 0
    for spec in items:
        slug = spec["slug"]
        if db.session.query(WikiPage).filter(WikiPage.slug == slug).first():
            continue
        page = WikiPage(
            slug=slug,
            title=spec["title"][:255],
            body_md=spec.get("body_md") or "",
            created_by_id=actor_id,
            updated_by_id=actor_id,
        )
        db.session.add(page)
        added += 1
    return added


def _ensure_general_chat_room(actor_id: int) -> ChatRoom:
    room = db.session.query(ChatRoom).filter(ChatRoom.title == "General").first()
    if room:
        return room
    room = ChatRoom(title="General", created_by_id=actor_id)
    db.session.add(room)
    db.session.flush()
    db.session.add(ChatRoomMember(room_id=room.id, user_id=actor_id, role="admin"))
    return room


def _seed_chat_messages(items: list[str], actor_id: int, progress_idx: int) -> int:
    room = _ensure_general_chat_room(actor_id)
    added = 0
    for i, text in enumerate(items):
        exists = (
            db.session.query(ChatMessage)
            .filter(ChatMessage.room_id == room.id, ChatMessage.text == text)
            .first()
        )
        if exists:
            continue
        db.session.add(ChatMessage(room_id=room.id, sender_id=actor_id, text=text[:4000]))
        added += 1
    return added


def _seed_document_folders(items: list[str], actor_id: int) -> int:
    user = db.session.get(User, actor_id)
    if not user:
        return 0
    root = ensure_user_workspace_folder(user)
    added = 0
    for name in items:
        exists = (
            db.session.query(FileNode)
            .filter(
                FileNode.parent_id == root.id,
                FileNode.is_folder.is_(True),
                FileNode.name == name,
                FileNode.owner_id == actor_id,
            )
            .first()
        )
        if exists:
            continue
        folder = FileNode(
            name=name[:512],
            is_folder=True,
            parent_id=root.id,
            owner_id=actor_id,
            attributes={"demo_data": True},
        )
        db.session.add(folder)
        added += 1
    return added


def _seed_sky_scores(items: list[dict], actor_id: int) -> int:
    added = 0
    for spec in items:
        score = int(spec.get("score") or 0)
        exists = (
            db.session.query(SkyControlScore)
            .filter(SkyControlScore.user_id == actor_id, SkyControlScore.score == score)
            .first()
        )
        if exists:
            continue
        db.session.add(
            SkyControlScore(
                user_id=actor_id,
                score=score,
                landed=int(spec.get("landed") or 0),
                wave=int(spec.get("wave") or 1),
            )
        )
        added += 1
    return added


def _seed_home_announcements(items: list[dict]) -> int:
    cur = get_setting("home", default={}) or {}
    if not isinstance(cur, dict):
        cur = {}
    anns = list(cur.get("announcements") or []) if isinstance(cur.get("announcements"), list) else []
    titles = {str(a.get("title") or "") for a in anns if isinstance(a, dict)}
    added = 0
    for spec in items:
        if spec["title"] in titles:
            continue
        anns.append(
            {
                "category": spec.get("category") or "General",
                "title": spec["title"],
                "body_html": spec.get("body_html") or "",
                "show_full_on_home": False,
            }
        )
        titles.add(spec["title"])
        added += 1
    if added:
        cur["announcements"] = anns
        _put_setting("home", cur)
    return added


def _seed_about_glance(items: list[dict], start_idx: int) -> int:
    cur = get_setting("about", default={}) or {}
    if not isinstance(cur, dict):
        cur = {}
    from app.intranet_bp import _normalize_about_glance

    glance = _normalize_about_glance(cur.get("glance"))
    added = 0
    for j, spec in enumerate(items):
        slot = start_idx + j
        if slot >= len(glance):
            break
        glance[slot] = dict(spec)
        added += 1
    if added:
        cur["glance"] = glance
        _put_setting("about", cur)
    return added


def _seed_about_page(items: list[dict]) -> int:
    if not items:
        return 0
    cur = get_setting("about", default={}) or {}
    if not isinstance(cur, dict):
        cur = {}
    if cur.get("who_body"):
        return 0
    spec = items[0]
    cur["who_title"] = spec.get("who_title") or "Who we are"
    cur["who_body"] = spec.get("who_body") or ""
    links = spec.get("links")
    if isinstance(links, list):
        cur["links"] = links
    _put_setting("about", cur)
    return 1


def demo_data_status() -> dict[str, Any]:
    progress = _load_progress()
    sections: dict[str, Any] = {}
    total_pct = 0.0
    count = 0
    for key, pool in _SECTION_POOLS.items():
        cur = progress.get(key, 0)
        size = len(pool)
        pct = min(100, int(round((cur / size) * 100))) if size else 100
        sections[key] = {"current": cur, "total": size, "percent": pct}
        total_pct += pct
        count += 1
    overall = int(round(total_pct / count)) if count else 0
    complete = all(sections[k]["percent"] >= 100 for k in sections)
    return {"sections": sections, "overall_percent": overall, "complete": complete}


def add_demo_data_batch(*, actor_id: int) -> tuple[dict[str, int], str]:
    """Add ~20% of each section's demo pool. Returns ({section: added_count}, summary)."""
    progress = _load_progress()
    added: dict[str, int] = {}
    companies_cache: dict[int, ContractorCompany] | None = None

    def slice_pool(key: str) -> tuple[list[Any], int, int]:
        pool = _SECTION_POOLS[key]
        cur = progress.get(key, 0)
        n = _batch_size(len(pool), cur)
        return pool[cur : cur + n], cur, n

    items, cur, n = slice_pool("employees")
    if n:
        c = _seed_employees(items, actor_id)
        added["employees"] = c
        progress["employees"] = cur + n

    items, cur, n = slice_pool("contractor_companies")
    if n:
        cc_added, companies_cache = _seed_contractor_companies(cur, n)
        added["contractor_companies"] = cc_added
        progress["contractor_companies"] = cur + n

    items, cur, n = slice_pool("contractors")
    if n:
        if companies_cache is None:
            _, companies_cache = _seed_contractor_companies(0, len(_POOL_CONTRACTOR_COMPANIES))
        c = _seed_contractors(items, companies_cache)
        added["contractors"] = c
        progress["contractors"] = cur + n

    items, cur, n = slice_pool("workforce_projects")
    if n:
        c = _seed_workforce_projects(items)
        added["workforce_projects"] = c
        progress["workforce_projects"] = cur + n

    items, cur, n = slice_pool("blogs")
    if n:
        c = _seed_blogs(items, actor_id)
        added["blogs"] = c
        progress["blogs"] = cur + n

    items, cur, n = slice_pool("events")
    if n:
        c = _seed_events(items, actor_id, start_offset=7 + cur)
        added["events"] = c
        progress["events"] = cur + n

    items, cur, n = slice_pool("wiki_pages")
    if n:
        c = _seed_wiki(items, actor_id)
        added["wiki_pages"] = c
        progress["wiki_pages"] = cur + n

    items, cur, n = slice_pool("chat_messages")
    if n:
        c = _seed_chat_messages(items, actor_id, cur)
        added["chat_messages"] = c
        progress["chat_messages"] = cur + n

    items, cur, n = slice_pool("document_folders")
    if n:
        c = _seed_document_folders(items, actor_id)
        added["document_folders"] = c
        progress["document_folders"] = cur + n

    items, cur, n = slice_pool("sky_scores")
    if n:
        c = _seed_sky_scores(items, actor_id)
        added["sky_scores"] = c
        progress["sky_scores"] = cur + n

    items, cur, n = slice_pool("home_announcements")
    if n:
        c = _seed_home_announcements(items)
        added["home_announcements"] = c
        progress["home_announcements"] = cur + n

    items, cur, n = slice_pool("about_glance")
    if n:
        c = _seed_about_glance(items, cur)
        added["about_glance"] = c
        progress["about_glance"] = cur + n

    items, cur, n = slice_pool("about_page")
    if n:
        c = _seed_about_page(items)
        added["about_page"] = c
        progress["about_page"] = cur + n

    _save_progress(progress)
    db.session.commit()

    total_added = sum(added.values())
    status = demo_data_status()
    if status["complete"]:
        summary = f"Demo data complete ({status['overall_percent']}% of all sections). Added {total_added} item(s) this click."
    elif total_added == 0:
        summary = "All demo sections are already at or above their target fill level."
    else:
        summary = (
            f"Added demo data across {len(added)} section(s) ({total_added} item(s) this click). "
            f"Overall fill: {status['overall_percent']}%."
        )
    return added, summary
