import calendar as calendar_mod
from datetime import date, datetime, timedelta, timezone
from typing import Any
import html
import re
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4
import json

from flask import Blueprint, abort, jsonify, render_template, request, current_app, url_for, send_file
from flask_login import current_user, login_required
from markupsafe import Markup
from werkzeug.utils import secure_filename
from sqlalchemy import func, inspect, or_, update
from sqlalchemy.exc import IntegrityError, OperationalError

from app.branding import portal_core_name, portal_shell_name
from app.extensions import db
from app.html_clean import (
    announcement_snippet_html,
    render_about_body_markup,
    sanitize_about_html,
    strip_data_uri_images,
)

from app.models import (
    BlogPost,
    CalendarEvent,
    ChatCallSignal,
    ChatMessage,
    ChatRoom,
    ChatRoomMember,
    ContractorCompany,
    FileNode,
    Role,
    User,
    WikiPage,
    WikiPageNote,
    WikiPageVote,
    WikiPageWatch,
)
from app.models import utcnow
from app.settings import get_setting, set_setting
from app import access
from app import calendar_au_holidays
from app import rbac
from app.files_workspace import ensure_user_workspace_folder
from app.audit_service import validate_deletion_justification, write_audit as audit_write


bp = Blueprint("intranet", __name__, url_prefix="/intranet")


def _norm_email_for_dedupe(u: User) -> str | None:
    e = (getattr(u, "email", None) or "").strip().lower()
    return e if e else None


def _dedupe_users_by_email(users: list[User]) -> tuple[list[User], dict[int, int]]:
    """Collapse duplicate accounts that share the same email.

    One person must appear once in Workforce / dashboard lists: ``User`` rows that
    share an email (e.g. seeded contractor username vs admin user with email-as-username)
    are merged for display. The canonical row prefers ``is_contractor`` when exactly one
    contractor exists in the group; otherwise the lowest ``id`` wins.

    Returns:
        deduped_users — original order, first occurrence of each canonical user only
        id_alias — discarded user id → canonical user id (for client-side id references)
    """
    from collections import defaultdict

    buckets: dict[str, list[User]] = defaultdict(list)
    for u in users:
        ne = _norm_email_for_dedupe(u)
        key = ne if ne else f"__noid:{getattr(u, 'id', 0)}"
        buckets[key].append(u)

    id_alias: dict[int, int] = {}
    winner_by_key: dict[str, User] = {}

    def _is_contractor(u: User) -> bool:
        try:
            return bool(_user_attr_dict(u).get("is_contractor"))
        except Exception:
            return False

    for key, bucket in buckets.items():
        if len(bucket) == 1:
            winner_by_key[key] = bucket[0]
            continue
        contractors = [x for x in bucket if _is_contractor(x)]
        if len(contractors) == 1:
            w = contractors[0]
        elif len(contractors) > 1:
            w = min(contractors, key=lambda x: x.id)
        else:
            w = min(bucket, key=lambda x: x.id)
        winner_by_key[key] = w
        for x in bucket:
            if x.id != w.id:
                id_alias[int(x.id)] = int(w.id)

    seen: set[int] = set()
    out: list[User] = []
    for u in users:
        ne = _norm_email_for_dedupe(u)
        key = ne if ne else f"__noid:{getattr(u, 'id', 0)}"
        w = winner_by_key[key]
        if w.id in seen:
            continue
        seen.add(w.id)
        out.append(w)
    return out, id_alias


def _is_intranet_portal_admin(u: User) -> bool:
    """True when `u` has full portal administration — not part of workforce headcount."""
    try:
        return rbac.user_has_permission(u, rbac.PERMISSION_ADMIN)
    except Exception:
        return False


def _workforce_roster_users(users: list[User]) -> list[User]:
    """Directory / Workforce KPI lists: exclude portal admins."""
    return [u for u in users if not _is_intranet_portal_admin(u)]





def _workforce_can_read() -> bool:
    """Workforce directory and dashboard (`workforce.read`)."""
    return rbac.user_can_workforce_read(current_user)


def _workforce_can_create() -> bool:
    """Edit roster, contractor companies, project catalog (non-destructive catalog edits)."""
    return rbac.user_can_workforce_create(current_user)


def _workforce_can_delete() -> bool:
    """Destructive workforce actions (remove shared project, delete contractor company)."""
    return rbac.user_can_workforce_delete(current_user)



def _seed_contractors_if_empty() -> None:
    """No built-in sample contractors; add real users via Administration or Workforce."""
    return

def _nav(active: str) -> dict:
    items = [
        ("home", "Home", "intranet.intranet_page"),
        ("news", "Blogs", "intranet.news_page"),
        ("events", "Events", "intranet.events_page"),
        ("wiki", "Wiki", "intranet.wiki_page"),
        ("team_chat", "Team Chat", "intranet.team_chat_page"),
        ("directory", "Workforce", "intranet.directory_page"),
        ("workforce_dashboard", "Workforce Dashboard", "intranet.workforce_dashboard_page"),
        ("security_training", "Security Training", "intranet.security_training_page"),
        ("documents", "Documents", "intranet.documents_page"),
        ("about", "About Company", "intranet.about_page"),
        ("game", "Games", "chess.game_lobby_page"),
        ("admin", "Administration", "intranet.admin_page"),
    ]
    try:
        from app.community_edition import community_module_available

        cfg = get_setting("modules", default={}) or {}
        mods = cfg.get("modules") if isinstance(cfg, dict) else None
        mods = mods if isinstance(mods, dict) else {}
        is_admin = bool(
            current_user.is_authenticated and rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN)
        )
        can_access_users_admin = bool(
            current_user.is_authenticated and rbac.user_can_access_users_admin(current_user)
        )
        uid = getattr(current_user, "id", None)
        allowed: set[str] = set()
        for key, _label, _endpoint in items:
            if not community_module_available(key):
                continue
            rule = mods.get(key) if isinstance(mods, dict) else None
            rule = rule if isinstance(rule, dict) else {}
            if rule.get("enabled") is False:
                if key == "admin" and (is_admin or can_access_users_admin):
                    pass
                elif not (is_admin and key == "admin"):
                    continue
            if is_admin or (key == "admin" and can_access_users_admin):
                allowed.add(key)
                continue
            if not bool(rule.get("restricted")):
                allowed.add(key)
                continue
            ids = rule.get("allowed_user_ids")
            ids = ids if isinstance(ids, list) else []
            ok_user = False
            if uid is not None:
                try:
                    ok_user = int(uid) in {int(x) for x in ids}
                except Exception:
                    ok_user = False
            if ok_user:
                allowed.add(key)
    except Exception:
        from app.community_edition import COMMUNITY_EDITION_MODULES

        allowed = {k for k, _l, _e in items if k in COMMUNITY_EDITION_MODULES or k == "admin"}

    filtered = [it for it in items if it[0] in allowed]
    return {"active": active, "items": filtered}



def _news_posts() -> list[dict]:
    # Backed by DB; falls back to sample rows if no posts exist yet.
    rows = (
        BlogPost.query.order_by(
            (BlogPost.status == "published").desc(),
            (BlogPost.published_at.isnot(None)).desc(),
            BlogPost.published_at.desc(),
            BlogPost.updated_at.desc(),
        )
        .limit(200)
        .all()
    )
    if rows:
        out: list[dict] = []
        for p in rows:
            author = ""
            try:
                author = (
                    (p.created_by.full_name or p.created_by.username)
                    if getattr(p, "created_by", None) is not None
                    else ""
                )
            except Exception:
                author = ""
            try:
                d = p.published_at.astimezone().strftime("%d %b %Y") if p.published_at else ""
            except Exception:
                d = ""
            iso = ""
            try:
                iso = p.published_at.date().isoformat() if p.published_at else ""
            except Exception:
                iso = ""
            out.append(
                {
                    "id": p.slug,
                    "post_id": p.id,
                    "date": d,
                    "date_iso": iso,
                    "author": author,
                    "category": (p.category or "").strip(),
                    "visibility": (p.visibility or "all"),
                    "status": (p.status or "draft"),
                    "allow_comments": bool(getattr(p, "allow_comments", False)),
                    "notify_on_publish": bool(getattr(p, "notify_on_publish", False)),
                    "title": p.title,
                    "excerpt": p.excerpt or "",
                    "body": p.body or "",
                    "image": p.cover_image_url or getattr(p, "image_url", None),
                }
            )
        return out

    return [
        {
            "id": "welcome",
            "post_id": None,
            "date": "07 Feb 2026",
            "date_iso": "",
            "author": portal_core_name(),
            "title": f"Welcome to {portal_core_name()}",
            "excerpt": "We’ve launched a unified portal for files, announcements, and company resources.",
            "body": f"Welcome! This is {portal_core_name()} — your internal portal for files, blogs, and employee resources.",
            "image": None,
        },
        {
            "id": "it-policy",
            "post_id": None,
            "date": "19 Feb 2026",
            "date_iso": "",
            "author": "IT",
            "title": "Updated IT policy: MFA and device compliance",
            "excerpt": "Please review the updated policy and ensure your devices meet compliance requirements.",
            "body": "We’ve updated the policy to require MFA and device compliance checks for all staff.",
            "image": None,
        },
        {
            "id": "wellbeing",
            "post_id": None,
            "date": "01 Mar 2026",
            "date_iso": "",
            "author": "People & Culture",
            "title": "Employee wellbeing program",
            "excerpt": "New wellbeing initiatives are available to all staff. Learn what’s included and how to join.",
            "body": "We’re launching a wellbeing program. Details and resources will be posted here.",
            "image": None,
        },
    ]


def _slugify(raw: str) -> str:
    import re

    s = (raw or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    s = re.sub(r"-{2,}", "-", s)
    return s or "post"


def _blog_published_at_on_publish(explicit: str | None = None):
    """Resolve published_at when a post is (or becomes) published."""
    from app.models import utcnow

    published_at = utcnow()
    pub = (explicit or "").strip()
    if pub:
        try:
            d = datetime.strptime(pub[:10], "%Y-%m-%d").date()
            published_at = datetime(d.year, d.month, d.day, tzinfo=utcnow().tzinfo)
        except Exception:
            pass
    return published_at


def _commit_blog_post():
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({"error": "could not save blog post"}), 500
    return None


@bp.route("/api/blogs", methods=["GET"])
@login_required
def api_blogs_list():
    posts = _news_posts()
    return jsonify({"posts": posts})


@bp.route("/api/blogs", methods=["POST"])
@login_required
def api_blogs_create():
    if not rbac.user_can_blogs_write(current_user):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    title = (payload.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title required"}), 400
    excerpt = (payload.get("excerpt") or "").strip()
    body = (payload.get("body") or "").strip()
    cover_image_url = (payload.get("cover_image_url") or payload.get("image_url") or "").strip() or None
    category = (payload.get("category") or "").strip()[:64] or None
    visibility = (payload.get("visibility") or "all").strip().lower() or "all"
    status = (payload.get("status") or "draft").strip().lower() or "draft"
    notify_on_publish = bool(payload.get("notify_on_publish") or False)
    allow_comments = bool(payload.get("allow_comments") or False)
    pub = (payload.get("published_at") or "").strip()

    published_at = _blog_published_at_on_publish(pub) if status == "published" else None

    base_slug = _slugify(payload.get("slug") or title)
    slug = base_slug
    i = 1
    while BlogPost.query.filter_by(slug=slug).first() is not None and i < 10_000:
        i += 1
        slug = f"{base_slug}-{i}"

    post = BlogPost(
        slug=slug,
        title=title[:255],
        excerpt=excerpt[:1000] if excerpt else None,
        body=body or None,
        cover_image_url=cover_image_url,
        category=category,
        visibility=visibility,
        status=status,
        notify_on_publish=notify_on_publish,
        allow_comments=allow_comments,
        published_at=published_at,
        created_by_id=current_user.id,
    )
    db.session.add(post)
    err = _commit_blog_post()
    if err:
        return err
    return jsonify({"post": {"id": post.id, "slug": post.slug}}), 201


@bp.route("/api/blogs/<int:post_id>", methods=["PATCH"])
@login_required
def api_blogs_update(post_id: int):
    if not rbac.user_can_blogs_write(current_user):
        return jsonify({"error": "forbidden"}), 403
    post = db.session.get(BlogPost, post_id)
    if not post:
        return jsonify({"error": "not found"}), 404
    payload = request.get_json(force=True, silent=True) or {}
    if "title" in payload:
        t = (payload.get("title") or "").strip()
        if not t:
            return jsonify({"error": "title required"}), 400
        post.title = t[:255]
    if "excerpt" in payload:
        ex = (payload.get("excerpt") or "").strip()
        post.excerpt = ex[:1000] if ex else None
    if "body" in payload:
        b = (payload.get("body") or "").strip()
        post.body = b or None
    if "cover_image_url" in payload or "image_url" in payload:
        iu = (payload.get("cover_image_url") or payload.get("image_url") or "").strip()
        post.cover_image_url = iu or None
    if "category" in payload:
        post.category = (payload.get("category") or "").strip()[:64] or None
    if "visibility" in payload:
        post.visibility = (payload.get("visibility") or "all").strip().lower() or "all"
    if "allow_comments" in payload:
        post.allow_comments = bool(payload.get("allow_comments") or False)
    if "notify_on_publish" in payload:
        post.notify_on_publish = bool(payload.get("notify_on_publish") or False)
    if "status" in payload:
        st = (payload.get("status") or "").strip().lower()
        if st in ("draft", "published"):
            prev = (post.status or "draft").strip().lower()
            post.status = st
            if st == "published" and (prev != "published" or not post.published_at):
                post.published_at = _blog_published_at_on_publish()
    if "published_at" in payload:
        pub = (payload.get("published_at") or "").strip()
        if not pub:
            if (post.status or "draft") == "published":
                post.published_at = _blog_published_at_on_publish()
        else:
            post.published_at = _blog_published_at_on_publish(pub)
    db.session.add(post)
    err = _commit_blog_post()
    if err:
        return err
    return jsonify({"ok": True})


@bp.route("/api/blogs/<int:post_id>", methods=["DELETE"])
@login_required
def api_blogs_delete(post_id: int):
    if not rbac.user_can_blogs_delete(current_user):
        return jsonify({"error": "forbidden"}), 403
    post = db.session.get(BlogPost, post_id)
    if not post:
        return jsonify({"error": "not found"}), 404
    db.session.delete(post)
    db.session.commit()
    return jsonify({"ok": True})


@bp.route("/api/blogs/upload-image", methods=["POST"])
@login_required
def api_blogs_upload_image():
    if not rbac.user_can_blogs_write(current_user):
        return jsonify({"error": "forbidden"}), 403
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "file required"}), 400
    ct = (f.mimetype or "").lower()
    if not ct.startswith("image/"):
        return jsonify({"error": "image required"}), 400
    ext = ".png"
    if "jpeg" in ct or "jpg" in ct:
        ext = ".jpg"
    elif "webp" in ct:
        ext = ".webp"
    elif "gif" in ct:
        ext = ".gif"

    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "blog_assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid4().hex}{ext}"
    out_path = out_dir / name
    f.save(out_path)
    return jsonify({"ok": True, "url": f"/intranet/media/blog/{name}"}), 201


@bp.route("/media/blog/<path:name>", methods=["GET"])
@login_required
def media_blog(name: str):
    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "blog_assets"
    path = (out_dir / name).resolve()
    try:
        if out_dir.resolve() not in path.parents:
            return jsonify({"error": "not found"}), 404
    except Exception:
        return jsonify({"error": "not found"}), 404
    if not path.exists() or not path.is_file():
        return jsonify({"error": "not found"}), 404
    from flask import send_file

    return send_file(path, conditional=True, max_age=0)


@bp.route("/", methods=["GET"])
@login_required
def intranet_page():
    q = (request.args.get("q") or "").strip()
    cfg = get_setting("home", default={}) or {}
    anns = cfg.get("announcements") if isinstance(cfg, dict) else None
    announcements = anns if isinstance(anns, list) else None
    if not announcements:
        announcements = [
            {"category": "Company", "title": "Welcome", "body": "This is your new portal for documents, news, and events."},
            {"category": "IT", "title": "Security reminder", "body": "Enable MFA and keep your password manager updated."},
        ]

    def _announcement_full_html(a: dict) -> str:
        raw = str(a.get("body_html") or a.get("body") or "").strip()
        if not raw:
            return ""
        html_out = render_about_body_markup(raw)
        if html_out or not str(a.get("body") or "").strip():
            return html_out
        # Legacy markdown image embeds in plain body
        text = html.escape(str(a.get("body") or ""))
        text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")

        def repl(m):
            alt = m.group(1) or "image"
            url = m.group(2) or ""
            url = url.strip()
            if not url:
                return ""
            if not (url.startswith("http://") or url.startswith("https://") or url.startswith("/intranet/media/")):
                return m.group(0)
            alt_esc = html.escape(alt)[:120]
            url_esc = html.escape(url, quote=True)[:2000]
            return f'<img class="nc-ann-img" src="{url_esc}" alt="{alt_esc}">'

        return re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", repl, text)

    announcements_edit = [dict(a) for a in announcements[:50] if isinstance(a, dict)]

    anns_out = []
    for a in announcements[:50]:
        if not isinstance(a, dict):
            continue
        full_html = _announcement_full_html(a)
        row = dict(a)
        raw_show = a.get("show_full_on_home")
        show_full = True if raw_show is None else bool(raw_show)
        row["show_full_on_home"] = show_full
        row["body_html_full"] = full_html
        if show_full:
            row["body_html"] = full_html
            row["is_snippet"] = False
        else:
            row["body_html"] = announcement_snippet_html(full_html) if full_html else ""
            row["is_snippet"] = True
        anns_out.append(row)
    announcements = anns_out

    featured_ids = cfg.get("featured_blog_post_ids") if isinstance(cfg, dict) else None
    featured_posts = []
    if isinstance(featured_ids, list) and featured_ids:
        ids = []
        for x in featured_ids:
            try:
                ids.append(int(x))
            except Exception:
                pass
        if ids:
            rows = BlogPost.query.filter(BlogPost.id.in_(ids)).all()
            by = {p.id: p for p in rows}
            seen: set[int] = set()
            for i in ids:
                if i in seen:
                    continue
                seen.add(i)
                p = by.get(i)
                if not p:
                    continue
                try:
                    d = p.published_at.astimezone().strftime("%d %b %Y") if p.published_at else ""
                except Exception:
                    d = ""
                featured_posts.append(
                    {
                        "id": p.slug,
                        "post_id": p.id,
                        "date": d,
                        "title": p.title,
                        "excerpt": p.excerpt or "",
                        "body": p.body or "",
                        "image": p.cover_image_url or getattr(p, "image_url", None),
                    }
                )
    posts = featured_posts if featured_posts else _news_posts()[:3]

    return render_template(
        "intranet_home.html",
        nav=_nav("home"),
        q=q,
        posts=posts,
        announcements=announcements,
        home_cfg={
            "featured_blog_post_ids": (featured_ids or []),
            "announcements": announcements_edit,
        },
    )


@bp.route("/api/home/upload-image", methods=["POST"])
@login_required
def api_home_upload_image():
    if not rbac.user_can_manage_home(current_user):
        return jsonify({"error": "forbidden", "detail": "Cannot upload images for Home settings."}), 403
    from app.home_settings_service import save_home_upload

    url, err = save_home_upload(request.files.get("file"))
    if err:
        return err
    return jsonify({"ok": True, "url": url}), 201


@bp.route("/media/home/<path:name>", methods=["GET"])
@login_required
def media_home(name: str):
    # Authenticated media; used for pasted images in announcements.
    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "home_assets"
    path = (out_dir / name).resolve()
    try:
        if out_dir.resolve() not in path.parents:
            return jsonify({"error": "not found"}), 404
    except Exception:
        return jsonify({"error": "not found"}), 404
    if not path.exists() or not path.is_file():
        return jsonify({"error": "not found"}), 404
    from flask import send_file

    return send_file(path, conditional=True, max_age=0)


@bp.route("/api/chat/upload-image", methods=["POST"])
@login_required
def api_chat_upload_image():
    # Team Chat: allow any authenticated user to paste screenshots.
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "file required"}), 400
    ct = (f.mimetype or "").lower()
    if not ct.startswith("image/"):
        return jsonify({"error": "image required"}), 400
    ext = ".png"
    if "jpeg" in ct or "jpg" in ct:
        ext = ".jpg"
    elif "webp" in ct:
        ext = ".webp"
    elif "gif" in ct:
        ext = ".gif"

    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "chat_assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid4().hex}{ext}"
    out_path = out_dir / name
    f.save(out_path)
    return jsonify({"ok": True, "url": f"/intranet/media/chat/{name}"}), 201


@bp.route("/api/chat/upload-file", methods=["POST"])
@login_required
def api_chat_upload_file():
    # Team Chat: allow any authenticated user to attach files.
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "file required"}), 400
    # Preserve extension when possible.
    fn = str(getattr(f, "filename", "") or "")
    ext = ""
    if "." in fn:
        ext = "." + fn.rsplit(".", 1)[1].lower()[:12]
        ext = re.sub(r"[^a-z0-9.]+", "", ext)
    if not ext or ext == ".":
        ext = ".bin"

    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "chat_assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid4().hex}{ext}"
    out_path = out_dir / name
    f.save(out_path)

    try:
        size = out_path.stat().st_size
    except Exception:
        size = 0

    return jsonify({"ok": True, "url": f"/intranet/media/chat/{name}", "name": fn[:255], "size": size}), 201


@bp.route("/media/chat/<path:name>", methods=["GET"])
@login_required
def media_chat(name: str):
    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "chat_assets"
    path = (out_dir / name).resolve()
    try:
        if out_dir.resolve() not in path.parents:
            return jsonify({"error": "not found"}), 404
    except Exception:
        return jsonify({"error": "not found"}), 404
    if not path.exists() or not path.is_file():
        return jsonify({"error": "not found"}), 404
    from flask import send_file

    return send_file(path, conditional=True, max_age=0)


def _chat_room_visible_to_user(room_id: int) -> bool:
    return (
        db.session.query(ChatRoomMember.id)
        .filter(ChatRoomMember.room_id == room_id, ChatRoomMember.user_id == current_user.id)
        .first()
        is not None
    )


def _chat_is_portal_admin() -> bool:
    return bool(
        current_user.is_authenticated
        and rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN)
    )


def _chat_room_accessible(room_id: int) -> bool:
    """Member of the room, or portal administrator (``admin.all``)."""
    return _chat_room_visible_to_user(room_id) or _chat_is_portal_admin()


def _chat_can_manage_room(room_id: int) -> bool:
    """Chat group admin or portal administrator."""
    if _chat_is_portal_admin():
        return True
    mine = _chat_my_membership(room_id)
    return mine is not None and str(mine.role or "") == "admin"


def _chat_delete_room_cascade(room_id: int) -> None:
    db.session.query(ChatCallSignal).filter(ChatCallSignal.room_id == room_id).delete(synchronize_session=False)
    db.session.query(ChatMessage).filter(ChatMessage.room_id == room_id).delete(synchronize_session=False)
    db.session.query(ChatRoomMember).filter(ChatRoomMember.room_id == room_id).delete(synchronize_session=False)
    db.session.query(ChatRoom).filter(ChatRoom.id == room_id).delete(synchronize_session=False)


def _chat_my_membership(room_id: int) -> ChatRoomMember | None:
    return (
        db.session.query(ChatRoomMember)
        .filter(ChatRoomMember.room_id == room_id, ChatRoomMember.user_id == current_user.id)
        .first()
    )


def _chat_room_member_counts(room_id: int) -> tuple[int, int]:
    """Return (total_members, admin_count)."""
    rows = db.session.query(ChatRoomMember.role).filter(ChatRoomMember.room_id == room_id).all()
    total = len(rows)
    admins = sum(1 for (r,) in rows if str(r or "") == "admin")
    return total, admins


def _chat_promote_someone_admin(room_id: int) -> None:
    """Ensure at least one admin if any members remain."""
    admins = db.session.query(ChatRoomMember.id).filter(ChatRoomMember.room_id == room_id, ChatRoomMember.role == "admin").first()
    if admins is not None:
        return
    first = db.session.query(ChatRoomMember).filter(ChatRoomMember.room_id == room_id).order_by(ChatRoomMember.joined_at.asc()).first()
    if first is not None:
        first.role = "admin"


def _ensure_chat_schema() -> None:
    """Ensure chat tables exist even if server wasn't restarted."""
    from sqlalchemy import text

    try:
        insp = inspect(db.engine)
        if not insp.has_table("chat_rooms"):
            db.create_all()
        elif insp.has_table("chat_room_members"):
            names = {c["name"] for c in insp.get_columns("chat_room_members")}
            if "last_read_message_id" not in names:
                with db.engine.begin() as conn:
                    conn.execute(
                        text(
                            "ALTER TABLE chat_room_members "
                            "ADD COLUMN last_read_message_id INTEGER NOT NULL DEFAULT 0"
                        )
                    )
    except OperationalError:
        # If the DB is mid-migration/locked, just try create_all once.
        try:
            db.create_all()
        except Exception:
            pass
    except Exception:
        pass
    try:
        insp = inspect(db.engine)
        if insp.has_table("chat_rooms") and not insp.has_table("chat_call_signals"):
            db.create_all()
    except Exception:
        pass
    try:
        insp = inspect(db.engine)
        if insp.has_table("chat_messages"):
            names = {c["name"] for c in insp.get_columns("chat_messages")}
            with db.engine.begin() as conn:
                for col, ddl in (
                    ("muted_at", "ALTER TABLE chat_messages ADD COLUMN muted_at DATETIME"),
                    ("muted_by_id", "ALTER TABLE chat_messages ADD COLUMN muted_by_id INTEGER"),
                    ("muted_original_json", "ALTER TABLE chat_messages ADD COLUMN muted_original_json TEXT"),
                ):
                    if col not in names:
                        conn.execute(text(ddl))
                        names.add(col)
    except Exception:
        pass


CHAT_MESSAGE_MUTED_DISPLAY = (
    "This message was hidden by a moderator. It may have violated workplace communication standards."
)


def _chat_message_public_dict(m: ChatMessage) -> dict:
    u = m.sender
    muted = m.muted_at is not None
    if muted:
        text = CHAT_MESSAGE_MUTED_DISPLAY
        image_url = ""
    else:
        text = m.text or ""
        image_url = m.image_url or ""
    return {
        "id": m.id,
        "at": _iso_utc(m.created_at),
        "text": text,
        "image_url": image_url,
        "muted": muted,
        "from": (_chat_user_stub(u) if u else {"id": m.sender_id, "name": "User", "initials": "U"}),
    }


def _chat_call_signal_dict(sig: ChatCallSignal) -> dict:
    payload = None
    if sig.payload_json:
        try:
            payload = json.loads(sig.payload_json)
        except Exception:
            payload = None
    from_u = sig.from_user
    name = ""
    if from_u:
        name = (from_u.full_name or from_u.username or from_u.email or "").strip()
    return {
        "id": sig.id,
        "kind": sig.kind,
        "from_user_id": sig.from_user_id,
        "from_name": name or f"User {sig.from_user_id}",
        "to_user_id": sig.to_user_id,
        "payload": payload,
        "at": _iso_utc(sig.created_at),
    }


def _purge_old_call_signals(room_id: int) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=2)
    db.session.query(ChatCallSignal).filter(
        ChatCallSignal.room_id == room_id,
        ChatCallSignal.created_at < cutoff,
    ).delete(synchronize_session=False)


def _chat_mark_room_read(room_id: int, user_id: int, up_to_message_id: int) -> None:
    if up_to_message_id <= 0:
        return
    mine = (
        db.session.query(ChatRoomMember)
        .filter(ChatRoomMember.room_id == room_id, ChatRoomMember.user_id == user_id)
        .first()
    )
    if not mine:
        return
    prev = int(mine.last_read_message_id or 0)
    if up_to_message_id > prev:
        mine.last_read_message_id = int(up_to_message_id)
        db.session.add(mine)


def _chat_unread_summary(user_id: int) -> dict:
    """Count messages from others in rooms the user belongs to, after last_read_message_id."""
    uid = int(user_id)
    memberships = db.session.query(ChatRoomMember).filter(ChatRoomMember.user_id == uid).all()
    total = 0
    by_room: dict[str, int] = {}
    for m in memberships:
        last_read = int(m.last_read_message_id or 0)
        count = (
            db.session.query(func.count(ChatMessage.id))
            .filter(
                ChatMessage.room_id == m.room_id,
                ChatMessage.sender_id != uid,
                ChatMessage.id > last_read,
            )
            .scalar()
            or 0
        )
        if count:
            by_room[str(m.room_id)] = int(count)
            total += int(count)
    return {"total": total, "by_room": by_room}


def _merge_duplicate_general_chat_rooms() -> None:
    """Older builds created one 'General' room per user; merge into lowest-id row."""
    try:
        if not inspect(db.engine).has_table("chat_rooms"):
            return
        rooms = (
            db.session.query(ChatRoom)
            .filter(ChatRoom.title == "General")
            .order_by(ChatRoom.id.asc())
            .all()
        )
        if len(rooms) <= 1:
            return
        keep_id = rooms[0].id
        dup_ids = [r.id for r in rooms[1:]]
        for dup_id in dup_ids:
            db.session.execute(update(ChatMessage).where(ChatMessage.room_id == dup_id).values(room_id=keep_id))
            members = db.session.query(ChatRoomMember).filter(ChatRoomMember.room_id == dup_id).all()
            for m in members:
                existing = (
                    db.session.query(ChatRoomMember)
                    .filter(ChatRoomMember.room_id == keep_id, ChatRoomMember.user_id == m.user_id)
                    .first()
                )
                if existing is None:
                    db.session.add(
                        ChatRoomMember(room_id=keep_id, user_id=m.user_id, role=m.role or "member")
                    )
                elif (m.role or "") == "admin" and existing.role != "admin":
                    existing.role = "admin"
            db.session.query(ChatRoomMember).filter(ChatRoomMember.room_id == dup_id).delete(synchronize_session=False)
            db.session.query(ChatRoom).filter(ChatRoom.id == dup_id).delete(synchronize_session=False)
        db.session.commit()
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass


def _user_chat_rooms_query():
    """Rooms the current user is a member of, newest first."""
    return (
        db.session.query(ChatRoom)
        .join(ChatRoomMember, ChatRoomMember.room_id == ChatRoom.id)
        .filter(ChatRoomMember.user_id == current_user.id)
        .order_by(ChatRoom.created_at.desc())
    )


def _chat_user_stub(u: User) -> dict:
    return {
        "id": u.id,
        "name": (u.full_name or u.username or "").strip(),
        "initials": ((u.full_name or u.username or "??")[:2]).upper(),
    }


def _iso_utc(dt: datetime | None) -> str:
    """Return ISO-8601 with 'Z' (UTC). Treat naive datetimes as UTC."""
    if not dt:
        return ""
    try:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except Exception:
        try:
            return str(dt)
        except Exception:
            return ""


@bp.route("/api/chat/rooms", methods=["GET"])
@login_required
def api_chat_rooms_list():
    _ensure_chat_schema()
    _merge_duplicate_general_chat_rooms()
    if _chat_is_portal_admin():
        rows = db.session.query(ChatRoom).order_by(ChatRoom.created_at.desc()).all()
    else:
        rows = _user_chat_rooms_query().all()
    if not rows:
        # Shared default room: join existing "General" if present, else create once for the org.
        try:
            shared = (
                db.session.query(ChatRoom)
                .filter(ChatRoom.title == "General")
                .order_by(ChatRoom.id.asc())
                .first()
            )
            if shared:
                db.session.add(ChatRoomMember(room_id=shared.id, user_id=current_user.id, role="member"))
                db.session.commit()
            else:
                room = ChatRoom(title="General", created_by_id=current_user.id)
                db.session.add(room)
                db.session.flush()
                db.session.add(ChatRoomMember(room_id=room.id, user_id=current_user.id, role="admin"))
                db.session.commit()
            rows = _user_chat_rooms_query().all()
        except Exception:
            try:
                db.session.rollback()
            except Exception:
                pass

    out: list[dict] = []
    for r in rows:
        last = (
            db.session.query(ChatMessage)
            .filter(ChatMessage.room_id == r.id)
            .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
            .first()
        )
        last_at = _iso_utc(last.created_at if last and last.created_at else r.created_at)
        preview = ""
        if last:
            if last.text:
                preview = str(last.text)
            elif last.image_url:
                preview = "📷 Screenshot"
        out.append(
            {
                "id": r.id,
                "title": r.title,
                "last_at": last_at,
                "preview": preview,
                "can_manage": _chat_can_manage_room(int(r.id)),
            }
        )
    return jsonify({"rooms": out, "is_portal_admin": _chat_is_portal_admin()})


@bp.route("/api/chat/unread", methods=["GET"])
@login_required
def api_chat_unread():
    _ensure_chat_schema()
    return jsonify(_chat_unread_summary(int(current_user.id)))


@bp.route("/api/chat/rooms", methods=["POST"])
@login_required
def api_chat_rooms_create():
    _ensure_chat_schema()
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400
    title = str(payload.get("title") or "").strip()[:255]
    if not title:
        return jsonify({"error": "title required"}), 400

    room = ChatRoom(title=title, created_by_id=current_user.id)
    db.session.add(room)
    db.session.flush()
    db.session.add(ChatRoomMember(room_id=room.id, user_id=current_user.id, role="admin"))
    db.session.commit()
    return jsonify({"ok": True, "room": {"id": room.id, "title": room.title}}), 201


@bp.route("/api/chat/rooms/<int:room_id>", methods=["GET"])
@login_required
def api_chat_room_get(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403
    room = db.session.get(ChatRoom, room_id)
    if not room:
        return jsonify({"error": "not found"}), 404
    mem_rows = (
        db.session.query(ChatRoomMember)
        .filter(ChatRoomMember.room_id == room_id)
        .order_by(ChatRoomMember.id.asc())
        .all()
    )
    members: list[dict] = []
    for m in mem_rows:
        if not m.user:
            continue
        members.append({**_chat_user_stub(m.user), "role": m.role})
    mine = _chat_my_membership(room_id)
    return jsonify(
        {
            "room": {
                "id": room.id,
                "title": room.title,
                "members": members,
                "my_role": mine.role if mine else None,
                "can_manage": _chat_can_manage_room(room_id),
            }
        }
    )


@bp.route("/api/chat/rooms/<int:room_id>", methods=["PATCH"])
@login_required
def api_chat_room_patch(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403
    if not _chat_can_manage_room(room_id):
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400
    title = str(payload.get("title") or "").strip()[:255]
    if not title:
        return jsonify({"error": "title required"}), 400

    room = db.session.get(ChatRoom, room_id)
    if not room:
        return jsonify({"error": "not found"}), 404
    room.title = title
    db.session.add(room)
    db.session.commit()
    return jsonify({"ok": True, "room": {"id": room.id, "title": room.title}}), 200


@bp.route("/api/chat/rooms/<int:room_id>", methods=["DELETE"])
@login_required
def api_chat_room_delete(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403
    if not _chat_can_manage_room(room_id):
        return jsonify({"error": "forbidden"}), 403
    room = db.session.get(ChatRoom, room_id)
    if not room:
        return jsonify({"error": "not found"}), 404
    if (room.title or "").strip() == "General":
        return jsonify({"error": "cannot delete the General chat"}), 400
    _chat_delete_room_cascade(room_id)
    db.session.commit()
    return jsonify({"ok": True})


@bp.route("/api/chat/rooms/<int:room_id>/invite-candidates", methods=["GET"])
@login_required
def api_chat_invite_candidates(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403
    q = str(request.args.get("q") or "").strip().lower()[:80]
    in_room_ids = [
        row[0]
        for row in db.session.query(ChatRoomMember.user_id).filter(ChatRoomMember.room_id == room_id).all()
    ]
    qb = db.session.query(User).filter(User.is_active.is_(True))
    if in_room_ids:
        qb = qb.filter(User.id.notin_(in_room_ids))
    if q:
        like = f"%{q}%"
        qb = qb.filter(
            or_(
                db.func.lower(User.username).like(like),
                db.func.lower(db.func.coalesce(User.full_name, "")).like(like),
                db.func.lower(db.func.coalesce(User.email, "")).like(like),
            )
        )
    rows = qb.order_by(db.func.coalesce(User.full_name, User.username).asc()).limit(60).all()
    out = [_chat_user_stub(u) for u in rows]
    return jsonify({"users": out})


@bp.route("/api/chat/rooms/<int:room_id>/members", methods=["POST"])
@login_required
def api_chat_members_add(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400
    try:
        uid = int(payload.get("user_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "user_id required"}), 400
    if uid == current_user.id:
        return jsonify({"error": "already a member"}), 400

    tgt = db.session.get(User, uid)
    if not tgt or not getattr(tgt, "is_active", True):
        return jsonify({"error": "user not found"}), 404

    exists = db.session.query(ChatRoomMember.id).filter(ChatRoomMember.room_id == room_id, ChatRoomMember.user_id == uid).first()
    if exists is not None:
        return jsonify({"error": "already a member"}), 409

    db.session.add(ChatRoomMember(room_id=room_id, user_id=uid, role="member"))
    try:
        db.session.commit()
    except IntegrityError:
        try:
            db.session.rollback()
        except Exception:
            pass
        return jsonify({"error": "already a member"}), 409

    return jsonify({"ok": True, "member": _chat_user_stub(tgt)}), 201


@bp.route("/api/chat/rooms/<int:room_id>/members/<int:user_id>", methods=["DELETE"])
@login_required
def api_chat_members_remove(room_id: int, user_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403

    actor = _chat_my_membership(room_id)
    target = db.session.query(ChatRoomMember).filter(ChatRoomMember.room_id == room_id, ChatRoomMember.user_id == user_id).first()
    if target is None:
        return jsonify({"error": "not found"}), 404

    leaving_self = user_id == current_user.id
    if not leaving_self:
        if not _chat_can_manage_room(room_id):
            return jsonify({"error": "forbidden"}), 403
    elif actor is None and not _chat_is_portal_admin():
        return jsonify({"error": "forbidden"}), 403

    total, _ = _chat_room_member_counts(room_id)
    if total <= 1:
        return jsonify({"error": "cannot remove the only member"}), 400

    db.session.delete(target)
    db.session.flush()
    _chat_promote_someone_admin(room_id)
    db.session.commit()

    return jsonify({"ok": True})


@bp.route("/api/chat/rooms/<int:room_id>/messages", methods=["GET"])
@login_required
def api_chat_messages_list(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403
    after_id = request.args.get("after_id")
    try:
        after = int(after_id) if after_id else 0
    except Exception:
        after = 0

    q = db.session.query(ChatMessage).filter(ChatMessage.room_id == room_id)
    if after > 0:
        q = q.filter(ChatMessage.id > after)
    rows = q.order_by(ChatMessage.id.asc()).limit(300).all()
    out: list[dict] = [_chat_message_public_dict(m) for m in rows]
    if out:
        _chat_mark_room_read(room_id, int(current_user.id), int(out[-1]["id"]))
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
    return jsonify({"messages": out})


@bp.route("/api/chat/rooms/<int:room_id>/messages", methods=["POST"])
@login_required
def api_chat_messages_create(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_visible_to_user(room_id):
        if not _chat_is_portal_admin():
            return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400
    text = str(payload.get("text") or "")[:4000]
    image_url = str(payload.get("image_url") or "")[:1024]
    if not text.strip() and not image_url.strip():
        return jsonify({"error": "message required"}), 400
    if image_url and not (
        image_url.startswith("/intranet/media/chat/")
        or image_url.startswith("/intranet/media/home/")
        or image_url.startswith("/intranet/media/blog/")
        or image_url.startswith("http://")
        or image_url.startswith("https://")
    ):
        return jsonify({"error": "invalid image url"}), 400

    msg = ChatMessage(room_id=room_id, sender_id=current_user.id, text=text.strip() or None, image_url=image_url.strip() or None)
    db.session.add(msg)
    db.session.flush()
    _chat_mark_room_read(room_id, int(current_user.id), int(msg.id))
    db.session.commit()
    return jsonify({"ok": True, "message_id": msg.id}), 201


@bp.route("/api/chat/rooms/<int:room_id>/messages/<int:message_id>", methods=["PATCH"])
@login_required
def api_chat_messages_patch(room_id: int, message_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403
    if not _chat_can_manage_room(room_id):
        return jsonify({"error": "forbidden"}), 403
    msg = (
        db.session.query(ChatMessage)
        .filter(ChatMessage.id == message_id, ChatMessage.room_id == room_id)
        .first()
    )
    if not msg:
        return jsonify({"error": "not found"}), 404
    if msg.muted_at is not None:
        return jsonify({"error": "muted messages cannot be edited"}), 400
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400
    text = str(payload.get("text") or "")[:4000].strip()
    if not text:
        return jsonify({"error": "message text required"}), 400
    msg.text = text
    msg.image_url = None
    db.session.add(msg)
    db.session.commit()
    return jsonify({"ok": True, "message_id": msg.id})


@bp.route("/api/chat/rooms/<int:room_id>/messages/<int:message_id>/mute", methods=["POST"])
@login_required
def api_chat_messages_mute(room_id: int, message_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403
    if not _chat_can_manage_room(room_id):
        return jsonify({"error": "forbidden"}), 403
    msg = (
        db.session.query(ChatMessage)
        .filter(ChatMessage.id == message_id, ChatMessage.room_id == room_id)
        .first()
    )
    if not msg:
        return jsonify({"error": "not found"}), 404
    if msg.muted_at is not None:
        return jsonify({"ok": True, "message": _chat_message_public_dict(msg), "already_muted": True})
    original = {"text": msg.text or "", "image_url": msg.image_url or ""}
    msg.muted_original_json = json.dumps(original)
    msg.muted_at = datetime.now(timezone.utc)
    msg.muted_by_id = int(current_user.id)
    msg.text = CHAT_MESSAGE_MUTED_DISPLAY
    msg.image_url = None
    db.session.add(msg)
    db.session.commit()
    return jsonify({"ok": True, "message": _chat_message_public_dict(msg)})


@bp.route("/api/chat/rooms/<int:room_id>/messages/<int:message_id>", methods=["DELETE"])
@login_required
def api_chat_messages_delete(room_id: int, message_id: int):
    _ensure_chat_schema()
    if not _chat_room_accessible(room_id):
        return jsonify({"error": "forbidden"}), 403
    if not _chat_can_manage_room(room_id):
        return jsonify({"error": "forbidden"}), 403
    msg = (
        db.session.query(ChatMessage)
        .filter(ChatMessage.id == message_id, ChatMessage.room_id == room_id)
        .first()
    )
    if not msg:
        return jsonify({"error": "not found"}), 404
    db.session.delete(msg)
    db.session.commit()
    return jsonify({"ok": True})


@bp.route("/api/chat/rooms/<int:room_id>/call/signals", methods=["GET"])
@login_required
def api_chat_call_signals_list(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_visible_to_user(room_id):
        return jsonify({"error": "forbidden"}), 403
    after_id = request.args.get("after_id", type=int) or 0
    uid = int(current_user.id)
    rows = (
        db.session.query(ChatCallSignal)
        .filter(ChatCallSignal.room_id == room_id, ChatCallSignal.id > after_id)
        .filter(or_(ChatCallSignal.to_user_id == uid, ChatCallSignal.to_user_id.is_(None)))
        .order_by(ChatCallSignal.id.asc())
        .limit(250)
        .all()
    )
    return jsonify({"signals": [_chat_call_signal_dict(s) for s in rows], "me_id": uid})


@bp.route("/api/chat/rooms/<int:room_id>/call/signals", methods=["POST"])
@login_required
def api_chat_call_signals_post(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_visible_to_user(room_id):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    kind = str(payload.get("kind") or "").strip().lower()
    if kind not in ("join", "leave", "offer", "answer", "ice"):
        return jsonify({"error": "invalid kind"}), 400

    to_user_id = payload.get("to_user_id")
    if kind in ("offer", "answer", "ice"):
        try:
            to_uid = int(to_user_id)
        except (TypeError, ValueError):
            return jsonify({"error": "to_user_id required"}), 400
        in_room = (
            db.session.query(ChatRoomMember.id)
            .filter(ChatRoomMember.room_id == room_id, ChatRoomMember.user_id == to_uid)
            .first()
        )
        if not in_room:
            return jsonify({"error": "recipient not in room"}), 400
        to_user_id = to_uid
    else:
        to_user_id = None

    signal_payload = payload.get("payload")
    if signal_payload is not None and not isinstance(signal_payload, (dict, list)):
        return jsonify({"error": "invalid payload"}), 400
    payload_json = json.dumps(signal_payload) if signal_payload is not None else None
    if payload_json and len(payload_json) > 64000:
        return jsonify({"error": "payload too large"}), 400

    sig = ChatCallSignal(
        room_id=room_id,
        from_user_id=int(current_user.id),
        to_user_id=to_user_id,
        kind=kind,
        payload_json=payload_json,
    )
    db.session.add(sig)
    _purge_old_call_signals(room_id)
    db.session.commit()
    return jsonify({"ok": True, "id": sig.id}), 201


@bp.route("/api/chat/rooms/<int:room_id>/call/participants", methods=["GET"])
@login_required
def api_chat_call_participants(room_id: int):
    _ensure_chat_schema()
    if not _chat_room_visible_to_user(room_id):
        return jsonify({"error": "forbidden"}), 403
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=90)
    rows = (
        db.session.query(ChatCallSignal)
        .filter(
            ChatCallSignal.room_id == room_id,
            ChatCallSignal.created_at >= cutoff,
            ChatCallSignal.kind.in_(("join", "leave")),
            ChatCallSignal.to_user_id.is_(None),
        )
        .order_by(ChatCallSignal.id.asc())
        .all()
    )
    active: set[int] = set()
    names: dict[int, str] = {}
    for sig in rows:
        uid = int(sig.from_user_id)
        if sig.kind == "join":
            active.add(uid)
            names[uid] = _chat_call_signal_dict(sig)["from_name"]
        elif sig.kind == "leave":
            active.discard(uid)
    out = [{"user_id": uid, "name": names.get(uid) or f"User {uid}"} for uid in sorted(active)]
    return jsonify({"participants": out})


@bp.route("/api/chat/search", methods=["GET"])
@login_required
def api_chat_search():
    _ensure_chat_schema()
    q = str(request.args.get("q") or "").strip()
    if not q:
        return jsonify({"results": []})
    q = q[:200]
    limit = 50
    try:
        limit = int(request.args.get("limit") or 50)
    except Exception:
        limit = 50
    limit = max(1, min(100, limit))

    # Only search rooms the current user belongs to.
    rows = (
        db.session.query(ChatMessage, ChatRoom)
        .join(ChatRoom, ChatRoom.id == ChatMessage.room_id)
        .join(ChatRoomMember, ChatRoomMember.room_id == ChatRoom.id)
        .filter(ChatRoomMember.user_id == current_user.id)
        .filter(ChatMessage.text.isnot(None))
        .filter(ChatMessage.text.ilike(f"%{q}%"))
        .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .limit(limit)
        .all()
    )

    out: list[dict] = []
    for m, r in rows:
        sender = m.sender
        out.append(
            {
                "room": {"id": r.id, "title": r.title},
                "message": {
                    "id": m.id,
                    "at": _iso_utc(m.created_at),
                    "text": (m.text or ""),
                    "from": (_chat_user_stub(sender) if sender else {"id": m.sender_id, "name": "User", "initials": "U"}),
                },
            }
        )
    return jsonify({"results": out})


@bp.route("/api/home", methods=["GET"])
@login_required
def api_home_get():
    if not rbac.user_can_manage_home(current_user):
        return jsonify({"error": "forbidden"}), 403
    cfg = get_setting("home", default={}) or {}
    posts = _news_posts()
    return jsonify({"config": cfg, "posts": posts})


@bp.route("/api/home", methods=["PUT", "POST"])
@login_required
def api_home_put():
    if not rbac.user_can_manage_home(current_user):
        return (
            jsonify(
                {
                    "error": "forbidden",
                    "detail": (
                        "Your account cannot save Home settings. "
                        "You need the admin role, admin.all, home.write, or Users administration access."
                    ),
                }
            ),
            403,
        )
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid JSON"}), 400
    cfg = payload.get("config") if isinstance(payload.get("config"), dict) else {}
    from app.home_settings_service import persist_home_settings

    out, err = persist_home_settings(cfg)
    if err:
        return err
    return jsonify({"ok": True, "config": out})


@bp.route("/news", methods=["GET"])
@login_required
def news_page():
    q = (request.args.get("q") or "").strip()
    posts = _news_posts()
    if q:
        qq = q.lower()
        posts = [p for p in posts if qq in (p.get("title") or "").lower() or qq in (p.get("excerpt") or "").lower()]
    return render_template("intranet_news.html", nav=_nav("news"), q=q, posts=posts)


def _cal_parse_ym(raw: str | None, fallback: date) -> tuple[int, int]:
    s = (raw or "").strip()
    if len(s) != 7 or s[4] != "-":
        return fallback.year, fallback.month
    try:
        y = int(s[0:4])
        mo = int(s[5:7])
        if mo < 1 or mo > 12:
            return fallback.year, fallback.month
        date(y, mo, 1)
        return y, mo
    except (TypeError, ValueError):
        return fallback.year, fallback.month


def _cal_event_counts(events: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for ev in events:
        k = (ev.get("date") or "").strip()
        if k:
            out[k] = out.get(k, 0) + 1
    return out


_PH_TITLE_PREFIX = "[Public holiday] "


def _cal_month_cell_preview(events: list[dict], d_iso: str, max_lines: int = 2) -> list[dict]:
    """Short labels for month grid cells (public holidays first)."""
    day_evs = [e for e in events if (e.get("date") or "").strip() == d_iso]
    if not day_evs:
        return []
    day_evs.sort(
        key=lambda e: (
            not bool(e.get("publicHoliday")),
            str(e.get("title") or "").lower(),
        )
    )
    rows: list[dict] = []
    for e in day_evs[:max_lines]:
        raw = str(e.get("title") or "").strip() or "(Untitled)"
        if raw.startswith(_PH_TITLE_PREFIX):
            raw = raw[len(_PH_TITLE_PREFIX) :]
        if len(raw) > 34:
            raw = raw[:33] + "…"
        rows.append({"text": raw, "holiday": bool(e.get("publicHoliday"))})
    if len(day_evs) > max_lines:
        rows.append({"text": f"+{len(day_evs) - max_lines} more", "holiday": False})
    return rows


def _cal_month_cells(
    cal_y: int,
    cal_m: int,
    event_by_date: dict[str, int],
    today: date,
    events: list[dict] | None = None,
) -> list[dict]:
    """Build month grid cells (Mon-first) for server-side HTML (matches client layout)."""
    first_wd, dim = calendar_mod.monthrange(cal_y, cal_m)
    lead = first_wd
    ncells = ((lead + dim + 6) // 7) * 7
    focus_iso = today.isoformat() if (cal_y, cal_m) == (today.year, today.month) else None
    cells: list[dict] = []
    for i in range(ncells):
        dnum = i - lead + 1
        if dnum < 1 or dnum > dim:
            cells.append({"kind": "pad"})
            continue
        d_iso = date(cal_y, cal_m, dnum).isoformat()
        cnt = int(event_by_date.get(d_iso, 0))
        preview = _cal_month_cell_preview(events, d_iso) if events is not None and cnt else []
        is_today = d_iso == today.isoformat()
        is_sel = focus_iso is not None and d_iso == focus_iso
        cls = ["nc-cal-cell"]
        if is_today:
            cls.append("nc-cal-cell--today")
        if is_sel:
            cls.append("nc-cal-cell--selected")
        aria = d_iso
        if cnt:
            aria = f"{d_iso}, {cnt} event(s)"
        if preview:
            try:
                aria += "; " + "; ".join(str(p.get("text") or "") for p in preview if p.get("text"))
            except Exception:
                pass
        cells.append(
            {
                "kind": "day",
                "day": dnum,
                "date": d_iso,
                "count": cnt,
                "preview": preview,
                "btn_class": " ".join(cls),
                "aria": aria,
            }
        )
    return cells


@bp.route("/events", methods=["GET"])
@login_required
def events_page():
    q = (request.args.get("q") or "").strip()
    today = date.today()
    cal_y, cal_m = _cal_parse_ym(request.args.get("cal"), today)
    # Load events for the focused year so Month + Year views can render dots without extra fetches.
    y0 = f"{cal_y}-01-01"
    y1 = f"{cal_y}-12-31"
    rows = (
        db.session.query(CalendarEvent)
        .filter(CalendarEvent.date >= y0, CalendarEvent.date <= y1)
        .order_by(CalendarEvent.date.asc())
        .limit(5000)
        .all()
    )
    # Private-by-default: only show events created by the user, or explicitly shared.
    group_ids = set()
    try:
        group_ids = {int(g.id) for g in (current_user.groups or []) if getattr(g, "id", None) is not None}
    except Exception:
        group_ids = set()

    def _visible(ev: CalendarEvent) -> bool:
        try:
            if ev.created_by_id == current_user.id:
                return True
        except Exception:
            pass
        try:
            su = ev.shared_user_ids or []
            if isinstance(su, list) and current_user.id in [int(x) for x in su if str(x).isdigit()]:
                return True
        except Exception:
            pass
        try:
            sg = ev.shared_group_ids or []
            if isinstance(sg, list):
                for x in sg:
                    try:
                        if int(x) in group_ids:
                            return True
                    except Exception:
                        continue
        except Exception:
            pass
        return False

    calendar_events = []
    for ev in rows:
        if not _visible(ev):
            continue
        su = ev.shared_user_ids if isinstance(ev.shared_user_ids, list) else []
        sg = ev.shared_group_ids if isinstance(ev.shared_group_ids, list) else []
        shared_count = 0
        try:
            shared_count = len([x for x in su if x is not None]) + len([x for x in sg if x is not None])
        except Exception:
            shared_count = 0
        calendar_events.append(
            {
                "id": ev.id,
                "date": ev.date,
                "start": (ev.start or ""),
                "end": (ev.end or ""),
                "title": ev.title,
                "allDay": bool(ev.all_day),
                "location": (ev.location or ""),
                "notes": (ev.notes or ""),
                "mine": bool(ev.created_by_id == current_user.id),
                "shared_count": int(shared_count),
                "shared_user_ids": su if ev.created_by_id == current_user.id else [],
                "shared_group_ids": sg if ev.created_by_id == current_user.id else [],
                "publicHoliday": False,
            }
        )
    calendar_events.extend(calendar_au_holidays.au_public_holiday_events_for_calendar_view(cal_y))
    calendar_events.sort(key=lambda x: ((x.get("date") or ""), (x.get("title") or "")))
    cal_month_label = date(cal_y, cal_m, 1).strftime("%B %Y")
    cal_cells = _cal_month_cells(cal_y, cal_m, _cal_event_counts(calendar_events), today, calendar_events)
    return render_template(
        "intranet_events.html",
        nav=_nav("events"),
        q=q,
        calendar_events=calendar_events,
        cal_year=cal_y,
        cal_month=cal_m,
        cal_month_label=cal_month_label,
        cal_cells=cal_cells,
    )


@bp.route("/api/events", methods=["GET"])
@login_required
def api_events_list():
    year = request.args.get("year", type=int)
    if not year or year < 1970 or year > 2100:
        year = date.today().year
    y0 = f"{year}-01-01"
    y1 = f"{year}-12-31"
    rows = (
        db.session.query(CalendarEvent)
        .filter(CalendarEvent.date >= y0, CalendarEvent.date <= y1)
        .order_by(CalendarEvent.date.asc())
        .limit(5000)
        .all()
    )
    out = []
    group_ids = set()
    try:
        group_ids = {int(g.id) for g in (current_user.groups or []) if getattr(g, "id", None) is not None}
    except Exception:
        group_ids = set()

    def _visible(ev: CalendarEvent) -> bool:
        try:
            if ev.created_by_id == current_user.id:
                return True
        except Exception:
            pass
        try:
            su = ev.shared_user_ids or []
            if isinstance(su, list) and current_user.id in [int(x) for x in su if str(x).isdigit()]:
                return True
        except Exception:
            pass
        try:
            sg = ev.shared_group_ids or []
            if isinstance(sg, list):
                for x in sg:
                    try:
                        if int(x) in group_ids:
                            return True
                    except Exception:
                        continue
        except Exception:
            pass
        return False

    for ev in rows:
        if not _visible(ev):
            continue
        su = ev.shared_user_ids if isinstance(ev.shared_user_ids, list) else []
        sg = ev.shared_group_ids if isinstance(ev.shared_group_ids, list) else []
        shared_count = 0
        try:
            shared_count = len([x for x in su if x is not None]) + len([x for x in sg if x is not None])
        except Exception:
            shared_count = 0
        out.append(
            {
                "id": ev.id,
                "date": ev.date,
                "start": (ev.start or ""),
                "end": (ev.end or ""),
                "title": ev.title,
                "allDay": bool(ev.all_day),
                "location": (ev.location or ""),
                "notes": (ev.notes or ""),
                "mine": bool(ev.created_by_id == current_user.id),
                "shared_count": int(shared_count),
                "shared_user_ids": su if ev.created_by_id == current_user.id else [],
                "shared_group_ids": sg if ev.created_by_id == current_user.id else [],
                "publicHoliday": False,
            }
        )
    out.extend(calendar_au_holidays.au_public_holiday_events_for_calendar_view(year))
    out.sort(key=lambda x: ((x.get("date") or ""), (x.get("title") or "")))
    return jsonify({"events": out, "year": year})


@bp.route("/api/people", methods=["GET"])
@login_required
def api_people_list():
    """Lightweight people list for pickers (share dialogs, etc.)."""
    rows = (
        db.session.query(User)
        .filter(User.is_active.is_(True))
        .order_by(User.full_name.asc(), User.username.asc())
        .limit(5000)
        .all()
    )
    out: list[dict] = []
    for u in rows:
        out.append(
            {
                "id": u.id,
                "name": (u.full_name or u.username),
                "email": (u.email or ""),
                "username": (u.username or ""),
            }
        )
    return jsonify({"people": out})


@bp.route("/api/events", methods=["POST"])
@login_required
def api_events_create():
    if not rbac.user_has_permission(current_user, rbac.PERMISSION_EVENTS_WRITE):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title") or "").strip()
    date_s = str(payload.get("date") or "").strip()
    all_day = bool(payload.get("allDay") or payload.get("all_day") or False)
    start = str(payload.get("start") or "").strip()
    end = str(payload.get("end") or "").strip()
    location = str(payload.get("location") or "").strip()
    notes = str(payload.get("notes") or "").strip()

    if not title:
        return jsonify({"error": "title required"}), 400
    if len(title) > 255:
        return jsonify({"error": "title too long"}), 400
    try:
        d = datetime.strptime(date_s, "%Y-%m-%d").date()
        date_s = d.isoformat()
    except Exception:
        return jsonify({"error": "invalid date"}), 400

    def _ok_hhmm(s: str) -> bool:
        if not s:
            return True
        try:
            datetime.strptime(s, "%H:%M")
            return True
        except Exception:
            return False

    if all_day:
        start = ""
        end = ""
    else:
        if not _ok_hhmm(start) or not _ok_hhmm(end):
            return jsonify({"error": "invalid time"}), 400
        if start and end:
            try:
                if datetime.strptime(end, "%H:%M") < datetime.strptime(start, "%H:%M"):
                    return jsonify({"error": "end must be after start"}), 400
            except Exception:
                pass

    ev = CalendarEvent(
        title=title,
        date=date_s,
        all_day=bool(all_day),
        start=(start or None),
        end=(end or None),
        location=(location or None),
        notes=(notes or None),
        shared_user_ids=[],
        shared_group_ids=[],
        created_by_id=current_user.id,
    )
    db.session.add(ev)
    db.session.commit()
    return jsonify(
        {
            "event": {
                "id": ev.id,
                "date": ev.date,
                "start": (ev.start or ""),
                "end": (ev.end or ""),
                "title": ev.title,
                "allDay": bool(ev.all_day),
                "location": (ev.location or ""),
                "notes": (ev.notes or ""),
            }
        }
    ), 201


@bp.route("/api/events/<int:event_id>", methods=["PATCH"])
@login_required
def api_events_update(event_id: int):
    if not rbac.user_has_permission(current_user, rbac.PERMISSION_EVENTS_WRITE):
        return jsonify({"error": "forbidden"}), 403
    if event_id < 0:
        return jsonify({"error": "not found"}), 404
    ev = db.session.get(CalendarEvent, event_id)
    if not ev:
        return jsonify({"error": "not found"}), 404
    if ev.created_by_id != current_user.id and not rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400

    if "title" in payload:
        t = str(payload.get("title") or "").strip()
        if not t:
            return jsonify({"error": "title required"}), 400
        ev.title = t[:255]
    if "date" in payload:
        date_s = str(payload.get("date") or "").strip()
        try:
            d = datetime.strptime(date_s, "%Y-%m-%d").date()
            ev.date = d.isoformat()
        except Exception:
            return jsonify({"error": "invalid date"}), 400
    if "allDay" in payload or "all_day" in payload:
        ev.all_day = bool(payload.get("allDay") or payload.get("all_day") or False)
        if ev.all_day:
            ev.start = None
            ev.end = None
    if "start" in payload:
        s = str(payload.get("start") or "").strip()
        if s:
            try:
                datetime.strptime(s, "%H:%M")
            except Exception:
                return jsonify({"error": "invalid time"}), 400
            ev.start = s
        else:
            ev.start = None
    if "end" in payload:
        s = str(payload.get("end") or "").strip()
        if s:
            try:
                datetime.strptime(s, "%H:%M")
            except Exception:
                return jsonify({"error": "invalid time"}), 400
            ev.end = s
        else:
            ev.end = None
    if ev.start and ev.end:
        try:
            if datetime.strptime(ev.end, "%H:%M") < datetime.strptime(ev.start, "%H:%M"):
                return jsonify({"error": "end must be after start"}), 400
        except Exception:
            pass
    if "location" in payload:
        ev.location = (str(payload.get("location") or "").strip()[:255] or None)
    if "notes" in payload:
        ev.notes = (str(payload.get("notes") or "").strip()[:2000] or None)

    db.session.add(ev)
    db.session.commit()
    return jsonify({"ok": True})


@bp.route("/api/events/<int:event_id>/share", methods=["POST"])
@login_required
def api_events_share(event_id: int):
    if not rbac.user_has_permission(current_user, rbac.PERMISSION_EVENTS_WRITE):
        return jsonify({"error": "forbidden"}), 403
    if event_id < 0:
        return jsonify({"error": "not found"}), 404
    ev = db.session.get(CalendarEvent, event_id)
    if not ev:
        return jsonify({"error": "not found"}), 404
    if ev.created_by_id != current_user.id and not rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400

    users_in = payload.get("users") if isinstance(payload.get("users"), list) else []
    groups_in = payload.get("groups") if isinstance(payload.get("groups"), list) else []

    user_ids: list[int] = []
    for raw in users_in[:200]:
        s = str(raw or "").strip()
        if not s:
            continue
        u = (
            db.session.query(User)
            .filter((func.lower(User.email) == s.lower()) | (func.lower(User.username) == s.lower()))
            .first()
        )
        if u:
            user_ids.append(int(u.id))
    group_ids: list[int] = []
    if groups_in:
        from app.models import Group

        for raw in groups_in[:200]:
            s = str(raw or "").strip()
            if not s:
                continue
            g = db.session.query(Group).filter(func.lower(Group.name) == s.lower()).first()
            if g:
                group_ids.append(int(g.id))

    # de-dupe and never include owner
    user_ids = sorted({i for i in user_ids if i != current_user.id})
    group_ids = sorted(set(group_ids))
    ev.shared_user_ids = user_ids
    ev.shared_group_ids = group_ids
    db.session.add(ev)
    db.session.commit()
    return jsonify({"ok": True, "shared_user_ids": user_ids, "shared_group_ids": group_ids})


@bp.route("/api/events/<int:event_id>", methods=["DELETE"])
@login_required
def api_events_delete(event_id: int):
    if not rbac.user_has_permission(current_user, rbac.PERMISSION_EVENTS_DELETE):
        return jsonify({"error": "forbidden"}), 403
    if event_id < 0:
        return jsonify({"error": "not found"}), 404
    ev = db.session.get(CalendarEvent, event_id)
    if not ev:
        return jsonify({"error": "not found"}), 404
    if ev.created_by_id != current_user.id and not rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
        return jsonify({"error": "forbidden"}), 403
    db.session.delete(ev)
    db.session.commit()
    return jsonify({"ok": True})


def _user_attr_dict(u: User) -> dict:
    a = u.attributes
    return a if isinstance(a, dict) else {}


WORKFORCE_LOCATION_CANONICAL = (
    "Melbourne",
    "Sydney",
    "Canberra",
    "South Australia",
    "Queensland",
    "Other",
)


def _compose_full_name(attrs: dict, fallback_full: str = "") -> str:
    fn = str(attrs.get("first_name") or "").strip()
    sn = str(attrs.get("surname") or "").strip()
    if fn or sn:
        return f"{fn} {sn}".strip()
    return str(fallback_full or "").strip()


def _directory_display_name(u: User) -> str:
    attrs = _user_attr_dict(u)
    composed = _compose_full_name(attrs, u.full_name or "")
    if composed:
        return composed
    return (u.full_name or u.username or "").strip() or "?"


def _directory_location_display(attrs: dict) -> str:
    loc = str(attrs.get("location") or "").strip()
    detail = str(attrs.get("location_detail") or "").strip()
    if loc == "Other" and detail:
        return f"Other ({detail})"
    if loc:
        return loc
    return "—"


# Workforce dashboard "Contracts Expiring" KPI — profile contract end within N calendar days.
WORKFORCE_CONTRACT_EXPIRING_DAYS = 60


def _workforce_contract_end_for_user(
    u: User,
    attrs: dict | None = None,
    project_meta: dict[str, dict] | None = None,
) -> date | None:
    """Soonest applicable end: profile contract end, then assigned project catalog end."""
    attrs = attrs if attrs is not None else _user_attr_dict(u)

    def _s(v) -> str:
        return ("" if v is None else str(v)).strip()

    def _parse(v: str):
        vv = _s(v)
        if not vv:
            return None
        if len(vv) >= 10 and vv[4] in "-/" and vv[:4].isdigit():
            try:
                return datetime.strptime(vv[:10].replace("/", "-"), "%Y-%m-%d").date()
            except Exception:
                pass
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
            try:
                return datetime.strptime(vv, fmt).date()
            except Exception:
                pass
        return None

    ends: list[date] = []
    for key in ("contract_end_date", "contract_end"):
        d = _parse(_s(attrs.get(key)))
        if d:
            ends.append(d)
    if project_meta is not None:
        raw_wp = _workforce_project_raw(u)
        if raw_wp:
            plab = _canonical_directory_project_label(raw_wp)
            if plab.lower() != "unassigned":
                pmd = project_meta.get(plab.lower())
                if pmd:
                    d = _parse(_s(pmd.get("contract_end")))
                    if d:
                        ends.append(d)
    return min(ends) if ends else None


def _workforce_profile_contract_end(attrs: dict) -> date | None:
    """Contract end from resource profile attributes only (not project catalog)."""

    def _s(v) -> str:
        return ("" if v is None else str(v)).strip()

    def _parse(v: str) -> date | None:
        vv = _s(v)
        if not vv:
            return None
        if len(vv) >= 10 and vv[4] in "-/" and vv[:4].isdigit():
            try:
                return datetime.strptime(vv[:10].replace("/", "-"), "%Y-%m-%d").date()
            except Exception:
                pass
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
            try:
                return datetime.strptime(vv, fmt).date()
            except Exception:
                pass
        return None

    ends: list[date] = []
    for key in ("contract_end_date", "contract_end"):
        d = _parse(_s(attrs.get(key)))
        if d:
            ends.append(d)
    return min(ends) if ends else None


def _workforce_contract_expiring_within_days(
    ce: date | None, today: date, *, within_days: int = WORKFORCE_CONTRACT_EXPIRING_DAYS
) -> bool:
    """True when profile contract end is today or within the next ``within_days`` (inclusive)."""
    if not ce:
        return False
    days = (ce - today).days
    return 0 <= days <= within_days


def _profile_attr_filled(val) -> bool:
    """True when a stored profile attribute has a real value (not placeholders)."""
    if val is None:
        return False
    if isinstance(val, bool):
        return True
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return val != 0
    s = str(val).strip()
    if not s:
        return False
    return s not in ("—", "-", "None", "Unassigned")


def _workforce_resource_compliance_gaps(u: User) -> list[str]:
    """Human-readable labels for missing Edit Resource profile fields."""
    attrs = _user_attr_dict(u)
    gaps: list[str] = []

    def need(label: str, val) -> None:
        if not _profile_attr_filled(val):
            gaps.append(label)

    fn = str(attrs.get("first_name") or "").strip()
    sn = str(attrs.get("surname") or "").strip()
    full = (u.full_name or "").strip()
    if not fn and not sn and not full:
        gaps.append("Name")

    need("Email", u.email or u.username)
    need("Phone", u.phone)

    if not _profile_attr_filled(_workforce_project_raw(u)):
        gaps.append("Project")

    need("Department", attrs.get("department"))

    jt = attrs.get("job_title") or attrs.get("title") or attrs.get("position")
    need("Job title", jt)

    loc = str(attrs.get("location") or "").strip()
    if not loc:
        gaps.append("Location")
    elif loc == "Other" and not str(attrs.get("location_detail") or "").strip():
        gaps.append("Location detail")

    need("Reports to", attrs.get("reports_to"))
    need("Start date", attrs.get("start_date"))

    if bool(attrs.get("is_contractor")):
        cc = attrs.get("contractor_company_id")
        try:
            cc_ok = cc is not None and int(cc) > 0
        except (TypeError, ValueError):
            cc_ok = False
        if not cc_ok:
            gaps.append("Company")
        need("Contract sign date", attrs.get("contract_sign_date"))
        need("Contract start date", attrs.get("contract_start_date"))
        need("Contract end date", attrs.get("contract_end_date"))

    return gaps


def _normalize_location_into_attrs(attrs: dict, location: str, location_detail: str) -> None:
    loc = str(location or "").strip()
    detail = str(location_detail or "").strip()[:120]
    allowed = {x.lower(): x for x in WORKFORCE_LOCATION_CANONICAL}
    if loc:
        canon = allowed.get(loc.lower())
        attrs["location"] = canon if canon else loc[:255]
    else:
        attrs.pop("location", None)
    if attrs.get("location") == "Other" and detail:
        attrs["location_detail"] = detail
    else:
        attrs.pop("location_detail", None)


def _directory_initials(u: User) -> str:
    attrs = _user_attr_dict(u)
    fn = str(attrs.get("first_name") or "").strip()
    sn = str(attrs.get("surname") or "").strip()
    if fn and sn:
        return (fn[0] + sn[0]).upper()
    raw = _directory_display_name(u)
    if not raw or raw == "?":
        return "?"
    parts = [p for p in raw.split() if p]
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    return raw[:2].upper()


def _directory_department(u: User) -> str:
    attrs = _user_attr_dict(u)
    dept = attrs.get("department")
    if dept and str(dept).strip():
        return str(dept).strip()
    groups = list(u.groups or [])
    if groups and groups[0].name:
        return str(groups[0].name).strip()
    return "General"


def _workforce_project_raw(u: User) -> str:
    """Primary field for Workforce overview / project doughnuts (see ``workforce_project`` attribute).

    Falls back to ``department`` for legacy contractors who only had department set.
    """
    attrs = _user_attr_dict(u)
    wp = attrs.get("workforce_project")
    if wp and str(wp).strip():
        return str(wp).strip()
    if bool(attrs.get("is_contractor")):
        d = attrs.get("department")
        if d and str(d).strip():
            return str(d).strip()
    return ""


def _collect_workforce_project_options(users: list[User]) -> list[str]:
    """Distinct canonical project labels for directory edit dropdown."""
    seen: set[str] = set()
    out: list[str] = []
    for u in users:
        raw = _workforce_project_raw(u)
        if not raw:
            continue
        lab = _canonical_directory_project_label(raw)
        if not lab or lab.lower() == "unassigned":
            continue
        lk = lab.lower()
        if lk not in seen:
            seen.add(lk)
            out.append(lab)
    out.sort(key=str.lower)
    return out


def _canonical_directory_project_label(proj: str) -> str:
    """Strip repeated leading 'project:' prefixes (case-insensitive) for stable grouping keys."""
    s = str(proj or "").strip()
    while len(s) >= 8 and s[:8].lower() == "project:":
        s = s[8:].lstrip()
    return s.strip() or "Unassigned"


WORKFORCE_DIRECTORY_PROJECTS_KEY = "workforce_directory_projects"


def _normalize_workforce_directory_catalog(raw: object) -> list[dict]:
    """Persisted project shells (name + director + contract end) for shared Workforce directory sections."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw[:500]:
        if not isinstance(item, dict):
            continue
        name = _canonical_directory_project_label(str(item.get("name") or "").strip())
        if not name or name.lower() == "unassigned":
            continue
        director = str(item.get("director") or item.get("Director") or "").strip()[:120]
        ce = str(item.get("contract_end") or item.get("contractEnd") or "").strip()[:80]
        out.append({"name": name, "director": director, "contract_end": ce})
    return out


def _load_workforce_directory_projects_catalog() -> list[dict]:
    return _normalize_workforce_directory_catalog(get_setting(WORKFORCE_DIRECTORY_PROJECTS_KEY, default=[]))


def _directory_projects_meta_lookup(catalog: list[dict]) -> dict[str, dict]:
    """Lowercase project label -> {director, contract_end} for template rendering."""
    lookup: dict[str, dict] = {}
    for e in catalog:
        nm = e.get("name") or ""
        lk = str(nm).strip().lower()
        if lk:
            lookup[lk] = {"director": e.get("director") or "", "contract_end": e.get("contract_end") or ""}
    return lookup


def _merged_contractor_project_groups(
    crows: list[User],
    base_roster: list[User],
    catalog: list[dict],
) -> list[dict]:
    """All project sections every user should see: DB grouping + roster options + saved catalog order."""
    by_proj: dict[str, list] = {}
    try:
        for u in crows:
            raw = _workforce_project_raw(u) or "Unassigned"
            proj = _canonical_directory_project_label(raw)
            by_proj.setdefault(proj, []).append(u)
    except Exception:
        by_proj = {}

    seen_lower: set[str] = set()
    ordered: list[str] = []

    def add_label(lab: str) -> None:
        c = _canonical_directory_project_label(lab)
        if not c or c.lower() == "unassigned":
            return
        lk = c.lower()
        if lk in seen_lower:
            return
        seen_lower.add(lk)
        ordered.append(c)

    for e in catalog:
        add_label(str(e.get("name") or ""))
    try:
        for p in _collect_workforce_project_options(base_roster):
            add_label(p)
    except Exception:
        pass
    for proj in sorted(by_proj.keys(), key=lambda s: str(s).lower()):
        add_label(proj)

    groups: list[dict] = []
    for proj in ordered:
        entries = [_directory_entry_for_user(u) for u in by_proj.get(proj, [])]
        groups.append({"project": proj, "entries": entries, "count": len(entries)})
    return groups


def _directory_job_title(u: User) -> str:
    attrs = _user_attr_dict(u)
    for key in ("job_title", "title", "position"):
        v = attrs.get(key)
        if v and str(v).strip():
            return str(v).strip()
    roles = list(u.roles or [])
    if roles:
        rn = (roles[0].name or "").strip()
        if rn:
            return rn.replace("_", " ").replace(".", " ").title()
    return "Team member"


_PREFERRED_DEPTS = ("Engineering", "Design", "Operations", "Sales", "General")


def _directory_department_tabs(seen: set[str]) -> list[str]:
    ordered: list[str] = []
    for d in _PREFERRED_DEPTS:
        if d in seen:
            ordered.append(d)
    rest = sorted((s for s in seen if s not in ordered), key=str.lower)
    ordered.extend(rest)
    return ordered


_MONTH_ABBREV = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _format_start_date_display(attrs: dict) -> str:
    raw = attrs.get("start_date")
    if raw is None or raw == "":
        return "—"
    s = str(raw).strip()
    if not s:
        return "—"
    try:
        if len(s) >= 10 and s[4] in "-/":
            norm = s[:10].replace("/", "-")
            d = datetime.strptime(norm, "%Y-%m-%d").date()
            return f"{d.day} {_MONTH_ABBREV[d.month - 1]} {d.year}"
    except (ValueError, TypeError):
        pass
    return s


def _contractor_company_public_dict(c: ContractorCompany) -> dict:
    docs_out = {}
    raw = c.documents if isinstance(c.documents, dict) else {}
    for key in ("pi_pl_insurance", "workcover"):
        entry = raw.get(key)
        if isinstance(entry, dict) and entry.get("stored"):
            docs_out[key] = {
                "original_name": str(entry.get("original_name") or entry.get("name") or "document"),
                "url": f"/intranet/media/contractor-company/{c.id}/{entry['stored']}",
            }
    return {
        "id": c.id,
        "name": c.name or "",
        "abn": c.abn or "",
        "acn": c.acn or "",
        "company_rep": c.company_rep or "",
        "documents": docs_out,
    }


def _directory_entry_for_user(u: User) -> dict:
    attrs = _user_attr_dict(u)
    tz_raw = (attrs.get("timezone") or "").strip()
    st, label = _presence_status(getattr(u, "last_seen_at", None))
    is_contractor = bool(attrs.get("is_contractor") or False)
    contractor_company = None
    cc_raw = attrs.get("contractor_company_id")
    if cc_raw is not None:
        try:
            cid = int(cc_raw)
            cobj = db.session.get(ContractorCompany, cid)
            if cobj:
                contractor_company = _contractor_company_public_dict(cobj)
        except (TypeError, ValueError):
            pass
    intranet_on = attrs.get("intranet_login_enabled") is not False
    return {
        "id": u.id,
        "name": _directory_display_name(u),
        "email": u.email or "",
        "email_display": u.email or u.username,
        "phone": u.phone or "",
        "initials": _directory_initials(u),
        "department": _directory_department(u),
        "job_title": _directory_job_title(u),
        "tone": u.id % 6,
        "location": _directory_location_display(attrs),
        "reports_to": (str(attrs.get("reports_to")).strip() if attrs.get("reports_to") else "") or "—",
        "start_date": _format_start_date_display(attrs),
        "timezone": tz_raw or "Australia/Melbourne",
        "last_seen_at": (u.last_seen_at.isoformat() if getattr(u, "last_seen_at", None) else None),
        "presence": {"status": st, "label": label},
        "is_contractor": is_contractor,
        "intranet_login_enabled": intranet_on,
        # Raw editable fields (avoid using "—" sentinels in the editor).
        "edit": {
            "full_name": u.full_name or "",
            "first_name": str(attrs.get("first_name") or "").strip(),
            "surname": str(attrs.get("surname") or "").strip(),
            "email": u.email or "",
            "phone": u.phone or "",
            "department": (str(attrs.get("department")).strip() if attrs.get("department") else ""),
            # Matches `_workforce_project_raw` (stored project or legacy contractor department-as-project).
            "workforce_project": _workforce_project_raw(u) or "",
            "job_title": (str(attrs.get("job_title") or attrs.get("title") or attrs.get("position")).strip() if (attrs.get("job_title") or attrs.get("title") or attrs.get("position")) else ""),
            "location": (str(attrs.get("location")).strip() if attrs.get("location") else ""),
            "location_detail": str(attrs.get("location_detail") or "").strip(),
            "reports_to": (str(attrs.get("reports_to")).strip() if attrs.get("reports_to") else ""),
            "start_date": (str(attrs.get("start_date")).strip() if attrs.get("start_date") else ""),
            "contract_sign_date": (str(attrs.get("contract_sign_date")).strip() if attrs.get("contract_sign_date") else ""),
            "contract_start_date": (str(attrs.get("contract_start_date")).strip() if attrs.get("contract_start_date") else ""),
            "contract_end_date": (str(attrs.get("contract_end_date")).strip() if attrs.get("contract_end_date") else ""),
            "timezone": tz_raw or "",
            "is_contractor": is_contractor,
            "intranet_login_enabled": intranet_on,
            "contractor_company_id": (contractor_company.get("id") if contractor_company else None),
            "contractor_company": contractor_company,
        },
    }


def _presence_status(last_seen_at):
    """Return (status, label) based on last_seen_at."""
    if not last_seen_at:
        return "offline", "Offline"
    try:
        delta_sec = (utcnow() - last_seen_at).total_seconds()
    except Exception:
        return "offline", "Offline"
    if delta_sec < 0:
        delta_sec = 0
    if delta_sec < 5 * 60:
        return "online", "Online now"
    if delta_sec < 30 * 60:
        return "away", "Away"
    return "offline", "Offline"


@bp.route("/api/presence/ping", methods=["POST"])
@login_required
def api_presence_ping():
    # Touch the current user's presence.
    try:
        current_user.last_seen_at = utcnow()
        db.session.add(current_user)
        db.session.commit()
    except Exception:
        db.session.rollback()
    return jsonify({"ok": True})


@bp.route("/api/presence/status", methods=["GET"])
@login_required
def api_presence_status():
    raw = (request.args.get("ids") or "").strip()
    ids = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.append(int(part))
        except Exception:
            continue
    ids = ids[:200]
    if not ids:
        return jsonify({"items": []})
    users = db.session.query(User).filter(User.id.in_(ids), User.is_active.is_(True)).all()
    by = {u.id: u for u in users}
    out = []
    for i in ids:
        u = by.get(i)
        if not u:
            continue
        st, label = _presence_status(getattr(u, "last_seen_at", None))
        out.append({"id": u.id, "status": st, "label": label, "last_seen_at": (u.last_seen_at.isoformat() if u.last_seen_at else None)})
    return jsonify({"items": out})


@bp.route("/security-training", methods=["GET"])
@login_required
def security_training_page():
    from app.security_training_service import page_intro_markup

    q = (request.args.get("q") or "").strip()
    return render_template(
        "intranet_security_training.html",
        nav=_nav("security_training"),
        q=q,
        page_intro_html=page_intro_markup(),
    )


@bp.route("/api/security-training/assets", methods=["GET"])
@login_required
def api_security_training_assets():
    """List training assets from a dedicated Documents folder named 'Security Training'."""
    from app import security_training_service as stsvc

    is_admin = bool(rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN))
    st_cfg = get_setting("security_training", default={}) or {}
    allowed_ids = st_cfg.get("allowed_user_ids") if isinstance(st_cfg, dict) else None
    allowed_ids = allowed_ids if isinstance(allowed_ids, list) else []
    is_allowed_uploader = False
    try:
        is_allowed_uploader = int(current_user.id) in {int(x) for x in allowed_ids}
    except Exception:
        is_allowed_uploader = False

    progress_user = current_user
    view_uid = (request.args.get("user_id") or "").strip()
    if view_uid and is_admin:
        try:
            other = db.session.get(User, int(view_uid))
            if other:
                progress_user = other
        except (TypeError, ValueError):
            pass

    folder = _security_training_folder()
    if not folder and (is_admin or is_allowed_uploader):
        # Create the folder so admins can start uploading training assets.
        folder = FileNode(
            name="Security Training",
            is_folder=True,
            parent_id=None,
            owner_id=int(current_user.id),
            attributes={
                "admin_only": True,
                access.SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR: True,
            },
        )
        db.session.add(folder)
        db.session.commit()
    if not folder:
        return jsonify({"items": [], "folder_id": None, "can_upload": False, "progress": {"total": 0, "completed": 0, "all_complete": False}})

    _fa = dict(folder.attributes or {})
    _st_changed = False
    if not _fa.get(access.SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR):
        _fa[access.SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR] = True
        _st_changed = True
    if not _fa.get("admin_only"):
        _fa["admin_only"] = True
        _st_changed = True
    if _st_changed:
        folder.attributes = _fa
        db.session.add(folder)
        db.session.commit()

    ok, _ = access.can_access_node(current_user, folder, "read")
    if not ok:
        return jsonify(
            {
                "items": [],
                "folder_id": None,
                "can_upload": False,
                "progress": {"total": 0, "completed": 0, "all_complete": False},
            }
        )

    # Upload allowed for admins and explicitly allowed users, but must also have write access.
    can_upload = bool(is_admin or is_allowed_uploader)
    if can_upload:
        okw, _ = access.can_access_node(current_user, folder, "write")
        can_upload = bool(okw)

    done_map = stsvc.completed_map(progress_user)
    out = []
    for row in _security_training_items_for_user(folder, current_user):
        completed_at = done_map.get(str(row["id"]))
        out.append(
            {
                **row,
                "completed": bool(completed_at),
                "completed_at": completed_at,
            }
        )
    file_ids = [int(x["id"]) for x in out]
    progress = stsvc.progress_summary(progress_user, file_ids)
    view_name = (progress_user.full_name or progress_user.email or progress_user.username or "").strip()
    return jsonify(
        {
            "items": out,
            "folder_id": folder.id,
            "can_upload": can_upload,
            "progress": progress,
            "progress_user_id": progress_user.id,
            "progress_user_name": view_name,
            "viewing_self": progress_user.id == current_user.id,
        }
    )


@bp.route("/api/security-training/assets/<int:file_id>/complete", methods=["POST"])
@login_required
def api_security_training_mark_complete(file_id: int):
    from app import security_training_service as stsvc

    folder = _security_training_folder()
    if not folder:
        return jsonify({"error": "Security Training folder not found"}), 404
    ok, _ = access.can_access_node(current_user, folder, "read")
    if not ok:
        return jsonify({"error": "forbidden"}), 403
    node = _security_training_file_in_folder(file_id, folder.id)
    if not node:
        return jsonify({"error": "not a training file"}), 404
    ok2, _ = access.can_access_node(current_user, node, "read")
    if not ok2:
        return jsonify({"error": "forbidden"}), 403
    completed_at = stsvc.mark_completed(current_user, node.id)
    db.session.add(current_user)
    db.session.commit()
    file_ids = [int(x["id"]) for x in _security_training_items_for_user(folder, current_user)]
    return jsonify(
        {
            "ok": True,
            "file_id": node.id,
            "completed_at": completed_at,
            "progress": stsvc.progress_summary(current_user, file_ids),
        }
    )


@bp.route("/directory", methods=["GET"])
@login_required
def directory_page():
    if not _workforce_can_read():
        abort(403)
    q = (request.args.get("q") or "").strip()
    qq = q.lower()
    dept_filter = (request.args.get("dept") or "").strip()
    cdept_filter = (request.args.get("cdept") or "").strip()

    _seed_contractors_if_empty()

    base_all_raw = (
        db.session.query(User)
        .filter(User.is_active.is_(True))
        .order_by(User.full_name.asc(), User.username.asc())
        .all()
    )
    base_all, directory_user_id_alias = _dedupe_users_by_email(base_all_raw)
    base_roster = _workforce_roster_users(base_all)

    base = base_roster
    if qq:
        base = [
            u
            for u in base_roster
            if (
                qq in (u.full_name or "").lower()
                or qq in (u.email or "").lower()
                or qq in (u.username or "").lower()
                or qq in (u.phone or "").lower()
                or qq in _directory_department(u).lower()
                or qq in _directory_job_title(u).lower()
            )
        ]

    # Full roster for client-side project grids (assignments may reference people hidden by dept/search filters).
    directory_resolve_entries = [_directory_entry_for_user(u) for u in base_all]

    def is_contractor_user(u: User) -> bool:
        try:
            attrs = _user_attr_dict(u)
            return bool(attrs.get("is_contractor") or False)
        except Exception:
            return False

    employees = [u for u in base if not is_contractor_user(u)]
    contractors = [u for u in base if is_contractor_user(u)]

    employee_departments = _directory_department_tabs({_directory_department(u) for u in employees})
    contractor_departments = _directory_department_tabs(
        {_canonical_directory_project_label(_workforce_project_raw(u) or "Unassigned") for u in contractors}
    )

    erows = list(employees)
    crows = list(contractors)
    if dept_filter:
        dlow = dept_filter.lower()
        erows = [u for u in erows if _directory_department(u).lower() == dlow]
    if cdept_filter:
        dlow = cdept_filter.lower()
        crows = [
            u
            for u in crows
            if _canonical_directory_project_label(_workforce_project_raw(u) or "Unassigned").lower() == dlow
        ]

    directory_entries = [_directory_entry_for_user(u) for u in (erows + crows)]

    workforce_projects_catalog = _load_workforce_directory_projects_catalog()
    directory_projects_meta_lc = _directory_projects_meta_lookup(workforce_projects_catalog)

    # Contractors grouped by workforce project, merged with saved catalog + roster project labels
    # so every user sees the same project sections (not browser-local project lists).
    try:
        contractor_groups = _merged_contractor_project_groups(crows, base_roster, workforce_projects_catalog)
    except Exception:
        contractor_groups = []

    # Browser seed for project boards / dashboard: everyone maps to their workforce project (or Unassigned).
    project_members_seed = {}
    try:
        for u in base_roster:
            raw = _workforce_project_raw(u)
            proj = _canonical_directory_project_label(raw) if raw else "Unassigned"
            project_members_seed.setdefault(proj, []).append(str(u.id))
    except Exception:
        project_members_seed = {}

    workforce_project_options = _collect_workforce_project_options(base_roster)

    contractor_companies = []
    try:
        cc_rows = db.session.query(ContractorCompany).order_by(ContractorCompany.name.asc()).all()
        contractor_companies = [_contractor_company_public_dict(c) for c in cc_rows]
    except Exception:
        contractor_companies = []

    return render_template(
        "intranet_directory.html",
        nav=_nav("directory"),
        q=q,
        dept_filter=dept_filter,
        cdept_filter=cdept_filter,
        departments=employee_departments,
        contractor_departments=contractor_departments,
        contractor_groups=contractor_groups,
        directory_entries=directory_entries,
        directory_resolve_entries=directory_resolve_entries,
        directory_user_id_aliases=directory_user_id_alias,
        project_members_seed=project_members_seed,
        workforce_project_options=workforce_project_options,
        contractor_companies=contractor_companies,
        workforce_projects_catalog=workforce_projects_catalog,
        directory_projects_meta_lc=directory_projects_meta_lc,
    )


@bp.route("/workforce-dashboard", methods=["GET"])
@login_required
def workforce_dashboard_page():
    """Workforce dashboard (server + browser project stats)."""
    if not _workforce_can_read():
        abort(403)
    _seed_contractors_if_empty()

    base_raw = (
        db.session.query(User)
        .filter(User.is_active.is_(True))
        .order_by(User.full_name.asc(), User.username.asc())
        .all()
    )
    deduped_users, wfd_user_id_alias = _dedupe_users_by_email(base_raw)
    roster = _workforce_roster_users(deduped_users)

    def is_contractor_user(u: User) -> bool:
        try:
            attrs = _user_attr_dict(u)
            return bool(attrs.get("is_contractor") or False)
        except Exception:
            return False

    def s(v) -> str:
        return ("" if v is None else str(v)).strip()

    def parse_ymd(v: str):
        vv = s(v)
        if not vv:
            return None
        if len(vv) >= 10 and vv[4] in "-/" and vv[:4].isdigit():
            try:
                return datetime.strptime(vv[:10].replace("/", "-"), "%Y-%m-%d").date()
            except Exception:
                pass
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
            try:
                return datetime.strptime(vv, fmt).date()
            except Exception:
                pass
        return None

    today = date.today()
    onboarding_since = today - timedelta(days=30)

    workforce_projects_catalog_wfd = _load_workforce_directory_projects_catalog()
    directory_projects_meta_wfd = _directory_projects_meta_lookup(workforce_projects_catalog_wfd)

    def resource_contract_end(u: User) -> date | None:
        return _workforce_contract_end_for_user(u, project_meta=directory_projects_meta_wfd)

    employees = [u for u in roster if not is_contractor_user(u)]
    contractors = [u for u in roster if is_contractor_user(u)]

    # KPI-style counts using existing attributes (best-effort).
    onboarding_30 = 0
    contracts_expiring_60 = 0
    non_compliant_resources = 0
    try:
        for u in roster:
            attrs = _user_attr_dict(u)
            start_raw = s(attrs.get("start_date")) or s(attrs.get("contract_start_date"))
            sd = parse_ymd(start_raw)
            profile_ce = _workforce_profile_contract_end(attrs)
            if sd and onboarding_since <= sd <= today:
                onboarding_30 += 1
            if _workforce_contract_expiring_within_days(profile_ce, today):
                contracts_expiring_60 += 1
            if _workforce_resource_compliance_gaps(u):
                non_compliant_resources += 1
    except Exception:
        onboarding_30 = 0
        contracts_expiring_60 = 0
        non_compliant_resources = 0

    # Contractors grouped by workforce project (legacy: contractor department).
    projects: list[dict] = []
    try:
        by_proj: dict[str, list[User]] = {}
        for u in contractors:
            raw = _workforce_project_raw(u) or "Unassigned"
            proj = _canonical_directory_project_label(raw)
            by_proj.setdefault(proj, []).append(u)
        for proj in sorted(by_proj.keys(), key=lambda s: s.lower()):
            projects.append({"name": proj, "count": len(by_proj[proj])})
    except Exception:
        projects = []

    # Department/role breakdown (best-effort).
    dept_rows: list[dict] = []
    try:
        by_dept: dict[str, dict] = {}
        for u in roster:
            dept = _directory_department(u) or "Unassigned"
            r = by_dept.setdefault(dept, {"dept": dept, "employees": 0, "contractors": 0, "total": 0})
            if is_contractor_user(u):
                r["contractors"] += 1
            else:
                r["employees"] += 1
            r["total"] += 1
        dept_rows = sorted(by_dept.values(), key=lambda x: str(x.get("dept") or "").lower())[:200]
    except Exception:
        dept_rows = []

    # Lightweight list payload for client-side charts (including localStorage projects).
    contractor_company_names: dict[int, str] = {}
    try:
        for c in db.session.query(ContractorCompany).all():
            contractor_company_names[int(c.id)] = s(c.name)
    except Exception:
        contractor_company_names = {}

    people_payload: list[dict] = []
    try:
        for u in roster[:2000]:
            attrs = _user_attr_dict(u)
            raw_wp = _workforce_project_raw(u)
            project_end_date = ""
            if raw_wp:
                plab = _canonical_directory_project_label(raw_wp)
                if plab.lower() != "unassigned":
                    pmd = directory_projects_meta_wfd.get(plab.lower())
                    if pmd:
                        project_end_date = s(pmd.get("contract_end"))
            cc_name = ""
            try:
                cc_raw = attrs.get("contractor_company_id")
                if cc_raw is not None:
                    cc_name = contractor_company_names.get(int(cc_raw), "")
            except (TypeError, ValueError):
                cc_name = ""
            _, presence_label = _presence_status(getattr(u, "last_seen_at", None))
            compliance_gaps = _workforce_resource_compliance_gaps(u)
            eff_end = resource_contract_end(u)
            people_payload.append(
                {
                    "id": str(u.id),
                    "name": s(u.full_name) or s(u.username) or f"User {u.id}",
                    "first_name": s(attrs.get("first_name")),
                    "surname": s(attrs.get("surname")),
                    "email": s(u.email),
                    "phone": s(u.phone),
                    "type": "Contractor" if is_contractor_user(u) else "Employee",
                    "department": _directory_department(u) or "",
                    "role": _directory_job_title(u) or "",
                    "location": _directory_location_display(attrs),
                    "reports_to": s(attrs.get("reports_to")),
                    "timezone": s(attrs.get("timezone")) or "Australia/Melbourne",
                    "project_end_date": project_end_date,
                    "contract_end_date": s(attrs.get("contract_end_date")),
                    "effective_contract_end": eff_end.isoformat() if eff_end else "",
                    "contract_start_date": s(attrs.get("contract_start_date")),
                    "contract_sign_date": s(attrs.get("contract_sign_date")),
                    "start_date": s(attrs.get("start_date")),
                    "intranet_login_enabled": attrs.get("intranet_login_enabled") is not False,
                    "contractor_company": cc_name,
                    "presence_label": presence_label,
                    "compliance_gaps": compliance_gaps,
                }
            )
    except Exception:
        people_payload = []

    # Mirrors Workforce directory grouping so list/table Project column works without LS.
    project_members_seed = {}
    try:
        for u in roster:
            raw = _workforce_project_raw(u)
            proj = _canonical_directory_project_label(raw) if raw else "Unassigned"
            project_members_seed.setdefault(proj, []).append(str(u.id))
    except Exception:
        project_members_seed = {}

    # Same normalization as Workforce page JS (`keyForProject`) for doughnut labels.
    def _wfd_project_key(name: str) -> str:
        s = " ".join(str(name or "").strip().split())
        return (s.lower()[:120]) if s else ""

    project_label_map: dict[str, str] = {}
    try:
        by_wfd: dict[str, list] = {}
        for u in roster:
            raw = _workforce_project_raw(u)
            if not raw:
                continue
            proj = _canonical_directory_project_label(raw)
            by_wfd.setdefault(proj, []).append(u)
        for pname in by_wfd.keys():
            k = _wfd_project_key(pname)
            if k:
                project_label_map[k] = pname
    except Exception:
        project_label_map = {}

    return render_template(
        "intranet_workforce_dashboard.html",
        nav=_nav("workforce_dashboard"),
        q=(request.args.get("q") or "").strip(),
        as_at=today.strftime("%-d %b %Y") if hasattr(today, "strftime") else str(today),
        total=len(roster),
        employees=len(employees),
        contractors=len(contractors),
        project_count=len(projects),
        projects=projects[:200],
        onboarding_30=onboarding_30,
        contracts_expiring_60=contracts_expiring_60,
        non_compliant_resources=non_compliant_resources,
        dept_rows=dept_rows,
        people_json=json.dumps(people_payload),
        project_members_seed=project_members_seed,
        project_label_map=project_label_map,
        user_id_aliases=wfd_user_id_alias,
    )


@bp.route("/team-chat", methods=["GET"])
@login_required
def team_chat_page():
    q = (request.args.get("q") or "").strip()
    webrtc_stun = str(current_app.config.get("WEBRTC_STUN_URL") or "stun:stun.l.google.com:19302").strip()
    voice_mode = str(current_app.config.get("VOICE_CALL_MODE") or "webrtc").strip().lower()
    if voice_mode not in ("webrtc", "jitsi"):
        voice_mode = "webrtc"
    jitsi_base = str(current_app.config.get("JITSI_BASE_URL") or "https://meet.jit.si").strip().rstrip("/")
    return render_template(
        "intranet_team_chat.html",
        nav=_nav("team_chat"),
        q=q,
        webrtc_stun_url=webrtc_stun,
        voice_call_mode=voice_mode,
        jitsi_base_url=jitsi_base,
        chat_portal_admin=rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN),
    )



@bp.route("/timesheets", methods=["GET"])
@login_required
def timesheets_page():
    q = (request.args.get("q") or "").strip()
    return render_template("intranet_timesheets.html", nav=_nav("timesheets"), q=q)


_ABOUT_GLANCE_SLOTS = 4


def _empty_about_glance() -> list[dict[str, str]]:
    return [{"value": "", "label": "", "subtitle": ""} for _ in range(_ABOUT_GLANCE_SLOTS)]


def _normalize_about_glance(raw: Any) -> list[dict[str, str]]:
    out = _empty_about_glance()
    if not isinstance(raw, list):
        return out
    for i in range(_ABOUT_GLANCE_SLOTS):
        it = raw[i] if i < len(raw) and isinstance(raw[i], dict) else {}
        out[i] = {
            "value": str(it.get("value") or "").strip()[:40],
            "label": str(it.get("label") or "").strip()[:60],
            "subtitle": str(it.get("subtitle") or "").strip()[:120],
        }
    return out


@bp.route("/about", methods=["GET"])
@login_required
def about_page():
    q = (request.args.get("q") or "").strip()
    cfg = get_setting("about", default={}) or {}
    if not isinstance(cfg, dict):
        cfg = {}

    who_title = str(cfg.get("who_title") or "").strip() or "Who we are"
    who_body = str(cfg.get("who_body") or "").strip() or "Add your company profile here: mission, vision, and story."

    links_raw = cfg.get("links")
    links = links_raw if isinstance(links_raw, list) else []
    links_out: list[dict] = []
    for it in links[:30]:
        if not isinstance(it, dict):
            continue
        label = str(it.get("label") or "").strip()[:120]
        url = str(it.get("url") or "").strip()[:2000]
        if not label or not url:
            continue
        links_out.append({"label": label, "url": url})
    if not links_out:
        links_out = [
            {"label": "Policies & documents", "url": url_for("intranet.documents_page")},
            {"label": "Employee directory", "url": url_for("intranet.directory_page")},
            {"label": "Files", "url": url_for("intranet.documents_page")},
        ]

    about_payload = {
        "who_title": who_title,
        "who_body": who_body,
        "links": links_out,
        "glance": _normalize_about_glance(cfg.get("glance")),
    }

    return render_template(
        "intranet_about.html",
        nav=_nav("about"),
        q=q,
        about=about_payload,
        glance_items=about_payload["glance"],
        who_body_html=Markup(render_about_body_markup(who_body)),
    )


@bp.route("/api/about", methods=["GET"])
@login_required
def api_about_get():
    cfg = get_setting("about", default={}) or {}
    return jsonify({"about": cfg if isinstance(cfg, dict) else {}})


@bp.route("/api/about", methods=["PUT"])
@login_required
def api_about_put():
    if not rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400

    who_title = str(payload.get("who_title") or "").strip()[:80] or "Who we are"
    who_body_raw = str(payload.get("who_body") or "")
    who_body = sanitize_about_html(who_body_raw)[:280000]
    links_in = payload.get("links") if isinstance(payload.get("links"), list) else []
    links_out: list[dict] = []
    for it in links_in[:30]:
        if not isinstance(it, dict):
            continue
        label = str(it.get("label") or "").strip()[:120]
        url = str(it.get("url") or "").strip()[:2000]
        if not label or not url:
            continue
        links_out.append({"label": label, "url": url})

    out = {
        "who_title": who_title,
        "who_body": who_body,
        "links": links_out,
        "glance": _normalize_about_glance(payload.get("glance")),
    }
    set_setting("about", out)
    return jsonify({"ok": True, "about": out})


def _me_profile_normalize_username(raw, email: str) -> tuple[bool, str]:
    """Return ``(ok, username_or_error)`` — username is lowercased when ``ok``.

    If the submitted username equals the submitted email (case-insensitive), it is accepted
    so users can keep signing in with their email as the identifier (same as ``auth.login``).
    Otherwise only ASCII letters, digits, ``.``, ``_``, and ``-`` are allowed (``User.username`` is 80 chars).
    """
    s = str(raw or "").strip()
    el = str(email or "").strip().lower()
    if not s:
        return False, "Username is required."
    sl = s.lower()
    if sl == el and "@" in el:
        if len(sl) > 80:
            return False, "Sign-in name cannot exceed 80 characters when it is your email address."
        return True, sl
    if len(s) > 80:
        return False, "Username is too long."
    if not re.match(r"^[A-Za-z0-9._-]+$", s):
        return False, "Username may only contain letters, numbers, dots, underscores, and hyphens (or use your email address if it matches the email field above)."
    return True, s.lower()


def _me_profile_email_taken(email: str, exclude_user_id: int) -> bool:
    el = email.strip().lower()
    if User.query.filter(User.id != exclude_user_id, func.lower(User.email) == el).first():
        return True
    return bool(User.query.filter(User.id != exclude_user_id, func.lower(User.username) == el).first())


def _me_profile_username_taken(username: str, exclude_user_id: int) -> bool:
    un = username.strip().lower()
    return bool(User.query.filter(User.id != exclude_user_id, func.lower(User.username) == un).first())


@bp.route("/api/me/profile", methods=["GET", "PATCH"])
@login_required
def api_me_profile():
    if not rbac.user_uses_intranet_profile_modal(current_user):
        return jsonify({"error": "forbidden"}), 403
    u = db.session.get(User, int(current_user.id))
    if not u or not u.is_active:
        abort(404)

    if request.method == "GET":
        return jsonify(
            {
                "user": {
                    "email": (u.email or "").strip(),
                    "full_name": (u.full_name or "").strip(),
                    "username": (u.username or "").strip(),
                    "phone": (u.phone or "").strip(),
                }
            }
        )

    payload = request.get_json(force=True, silent=True) or {}
    email = (payload.get("email") or "").strip()
    full_name = (payload.get("full_name") or "").strip()
    phone = (payload.get("phone") or "").strip()[:64]
    pw = (payload.get("password") or "").strip()
    pw2 = (payload.get("password2") or "").strip()

    if not email or "@" not in email or len(email) > 255:
        return jsonify({"error": "Valid email address is required.", "field": "email"}), 400
    if _me_profile_email_taken(email, u.id):
        return jsonify({"error": "Email address is already in use.", "field": "email"}), 409

    ok_un, un_or_err = _me_profile_normalize_username(payload.get("username"), email)
    if not ok_un:
        return jsonify({"error": un_or_err, "field": "username"}), 400
    un_final = un_or_err
    if _me_profile_username_taken(un_final, u.id):
        return jsonify({"error": "That username is already in use.", "field": "username"}), 409

    if pw or pw2:
        if pw != pw2:
            return jsonify({"error": "Passwords do not match.", "field": "password"}), 400
        if len(pw) < 8:
            return jsonify({"error": "Password must be at least 8 characters.", "field": "password"}), 400
        u.set_password(pw)

    u.email = email.strip()
    u.full_name = full_name or None
    u.username = un_final
    u.phone = phone or None
    db.session.add(u)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({"error": "Could not save your profile (duplicate value)."}), 409

    db.session.refresh(u)
    audit_write(
        user_id=current_user.id,
        username=current_user.username,
        action="intranet.profile.self_update",
        resource_type="user",
        resource_id=str(u.id),
        success=True,
        details={},
    )
    return jsonify(
        {
            "ok": True,
            "user": {
                "email": (u.email or "").strip(),
                "full_name": (u.full_name or "").strip(),
                "username": (u.username or "").strip(),
                "phone": (u.phone or "").strip(),
            },
        }
    )


@bp.route("/admin", methods=["GET"])
@login_required
def admin_page():
    from app import rbac

    if not rbac.user_can_access_users_admin(current_user) and not rbac.user_can_approve_registrations(
        current_user
    ):
        flash("You don’t have permission to access Administration.", "danger")
        return redirect(url_for("intranet.intranet_page"))
    q = (request.args.get("q") or "").strip()
    return render_template(
        "intranet_admin.html",
        nav=_nav("admin"),
        q=q,
        **rbac.users_admin_template_context(current_user),
    )


@bp.route("/search", methods=["GET"])
@login_required
def intranet_search():
    q = (request.args.get("q") or "").strip()
    results: dict[str, list[dict]] = {"news": [], "people": [], "documents": [], "wiki": []}
    if q:
        qq = q.lower()
        blog_hits: list[dict] = []
        for p in _news_posts():
            if qq not in (p.get("title") or "").lower() and qq not in (p.get("excerpt") or "").lower():
                continue
            pid = p.get("post_id") or p.get("id")
            url = url_for("intranet.news_page")
            if pid:
                url = f"{url}?open={pid}"
            blog_hits.append({**p, "url": url, "id": pid})
        results["news"] = blog_hits
        users = db.session.query(User).filter(User.is_active.is_(True)).all()
        results["people"] = [
            {
                "id": u.id,
                "name": (u.full_name or u.username),
                "email": u.email or "",
                "phone": u.phone or "",
                "url": url_for("intranet.directory_page", user_id=u.id),
            }
            for u in users
            if qq in (u.full_name or "").lower()
            or qq in (u.email or "").lower()
            or qq in (u.username or "").lower()
            or qq in (u.phone or "").lower()
        ]

        # Documents (FileNode name search). Respect access rules.
        # If a matching folder is found, also include a slice of its children to act like a "listing".
        try:
            from sqlalchemy import func

            pat = f"%{qq}%"
            candidates = (
                db.session.query(FileNode)
                .filter(FileNode.deleted_at.is_(None))
                .filter(func.lower(FileNode.name).like(pat))
                .order_by(FileNode.is_folder.desc(), FileNode.updated_at.desc())
                .limit(600)
                .all()
            )
        except Exception:
            candidates = []

        doc_hits: list[dict] = []
        seen_doc: set[int] = set()

        def can_see(node: FileNode) -> bool:
            try:
                ok, _reason = access.can_access_node(
                    current_user, node, "list" if node.is_folder else "read"
                )
            except Exception:
                ok = False
            return bool(ok)

        def add_doc(node: FileNode) -> None:
            if node.id in seen_doc:
                return
            if not can_see(node):
                return
            seen_doc.add(node.id)
            url = url_for(
                "intranet.documents_page",
                parent_id=(node.id if node.is_folder else node.parent_id),
                select_id=(None if node.is_folder else node.id),
            )
            doc_hits.append(
                {
                    "id": node.id,
                    "name": node.name,
                    "is_folder": bool(node.is_folder),
                    "parent_id": node.parent_id,
                    "url": url,
                }
            )

        for n in candidates:
            add_doc(n)
            # If a folder matches, include some of its children too (helps users find contents quickly).
            if n.is_folder and len(doc_hits) < 180:
                try:
                    kids = (
                        db.session.query(FileNode)
                        .filter(FileNode.parent_id == n.id, FileNode.deleted_at.is_(None))
                        .order_by(FileNode.is_folder.desc(), FileNode.name.asc())
                        .limit(50)
                        .all()
                    )
                except Exception:
                    kids = []
                for k in kids:
                    add_doc(k)
                    if len(doc_hits) >= 200:
                        break
            if len(doc_hits) >= 200:
                break
        results["documents"] = doc_hits

        from app.intranet_community_routes import _wiki_can_read

        if _wiki_can_read():
            try:
                pat = f"%{qq}%"
                wiki_rows = (
                    db.session.query(WikiPage)
                    .filter(
                        or_(
                            func.lower(WikiPage.title).like(pat),
                            func.lower(WikiPage.slug).like(pat),
                            func.lower(WikiPage.body_md).like(pat),
                            func.lower(func.coalesce(WikiPage.content_html, "")).like(pat),
                        )
                    )
                    .order_by(WikiPage.title.asc())
                    .limit(50)
                    .all()
                )
            except Exception:
                wiki_rows = []
            wiki_hits: list[dict] = []
            wiki_base = url_for("intranet.wiki_page")
            for wp in wiki_rows:
                wiki_hits.append(
                    {
                        "slug": wp.slug,
                        "title": wp.title or wp.slug,
                        "url": f"{wiki_base}?slug={quote(str(wp.slug or ''), safe='')}",
                    }
                )
            results["wiki"] = wiki_hits

    return render_template("intranet_search.html", nav=_nav("home"), q=q, results=results)


@bp.app_context_processor
def _intranet_profile_modal_context():
    from flask_login import current_user

    try:
        if not current_user.is_authenticated:
            return {"intranet_profile_modal": False, "url_api_me_profile": ""}
        modal = rbac.user_uses_intranet_profile_modal(current_user)
        return {
            "intranet_profile_modal": modal,
            "url_api_me_profile": url_for("intranet.api_me_profile") if modal else "",
        }
    except RuntimeError:
        return {"intranet_profile_modal": False, "url_api_me_profile": ""}



def _register_community_intranet_routes() -> None:
    import app.intranet_community_routes  # noqa: F401




_register_community_intranet_routes()
