"""Community Edition intranet routes (wiki, documents, workforce APIs).

Registered from app.intranet_bp for both CE and Enterprise builds.
Enterprise-only modules remain in app.enterprise.intranet_routes.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from flask import abort, current_app, jsonify, render_template, request, send_file, url_for
from flask_login import current_user, login_required
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models import (
    ContractorCompany,
    KanbanBoard,
    KanbanCard,
    KanbanCardActivity,
    KanbanCardAttachment,
    KanbanCardComment,
    KanbanColumn,
    Group,
    User,
    WikiPage,
    WikiPageNote,
    WikiPageVote,
    WikiPageWatch,
    utcnow,
)
from app import rbac
from app.audit_service import validate_deletion_justification, write_audit as audit_write
from app.files_workspace import ensure_user_workspace_folder
from app.intranet_bp import (
    WORKFORCE_DIRECTORY_PROJECTS_KEY,
    bp,
    _nav,
    _canonical_directory_project_label,
    _compose_full_name,
    _contractor_company_public_dict,
    _dedupe_users_by_email,
    _directory_entry_for_user,
    _load_workforce_directory_projects_catalog,
    _normalize_location_into_attrs,
    _normalize_workforce_directory_catalog,
    _user_attr_dict,
    _workforce_can_create,
    _workforce_can_delete,
    _workforce_can_read,
    _workforce_project_raw,
    _workforce_roster_users,
)
from app.settings import set_setting

@bp.route("/api/users/<int:user_id>", methods=["GET", "PATCH"])
@login_required
def api_update_user(user_id: int):
    u = db.session.get(User, user_id)
    if request.method == "GET":
        if not _workforce_can_read():
            return jsonify({"error": "forbidden"}), 403
        if not u or not u.is_active:
            return jsonify({"error": "not found"}), 404
        return jsonify({"user": _directory_entry_for_user(u)})

    if not _workforce_can_create():
        return jsonify({"error": "forbidden"}), 403

    if not u:
        return jsonify({"error": "not found"}), 404

    payload = request.get_json(force=True, silent=True) or {}

    def s(key: str, limit: int = 255) -> str:
        v = payload.get(key)
        if v is None:
            return ""
        out = str(v).strip()
        if len(out) > limit:
            out = out[:limit]
        return out

    full_name = s("full_name", 255)
    first_name = s("first_name", 120)
    surname = s("surname", 120)
    email = s("email", 255)
    phone = s("phone", 64)
    department = s("department", 120)
    workforce_project = s("workforce_project", 120)
    job_title = s("job_title", 255)
    location = s("location", 255)
    location_detail = s("location_detail", 120)
    reports_to = s("reports_to", 255)
    start_date = s("start_date", 32)
    contract_sign_date = s("contract_sign_date", 32)
    contract_start_date = s("contract_start_date", 32)
    contract_end_date = s("contract_end_date", 32)
    timezone = s("timezone", 80)
    is_contractor_raw = payload.get("is_contractor", None)
    is_contractor = None
    if is_contractor_raw is not None:
        if isinstance(is_contractor_raw, bool):
            is_contractor = is_contractor_raw
        else:
            is_contractor = str(is_contractor_raw).strip().lower() in ("1", "true", "yes", "y", "on")

    if "full_name" in payload and "first_name" not in payload and "surname" not in payload:
        u.full_name = full_name or None

    if "email" in payload:
        if not email or "@" not in email:
            return jsonify({"error": "email is required as the resource identifier"}), 400
        el = email.lower()
        dup = db.session.query(User).filter(User.id != u.id, func.lower(User.email) == el).first()
        if dup:
            return jsonify({"error": "email already in use"}), 409
        dup_un = db.session.query(User).filter(User.id != u.id, User.username == el).first()
        if dup_un:
            return jsonify({"error": "email already in use"}), 409
        u.email = email
        u.username = el

    if "phone" in payload:
        u.phone = phone or None

    attrs = dict(u.attributes or {})
    if "first_name" in payload:
        if first_name:
            attrs["first_name"] = first_name
        else:
            attrs.pop("first_name", None)
    if "surname" in payload:
        if surname:
            attrs["surname"] = surname
        else:
            attrs.pop("surname", None)
    if "first_name" in payload or "surname" in payload:
        u.full_name = _compose_full_name(attrs, "") or None

    if "intranet_login_enabled" in payload:
        raw_il = payload.get("intranet_login_enabled")
        attrs["intranet_login_enabled"] = (
            bool(raw_il)
            if isinstance(raw_il, bool)
            else str(raw_il).strip().lower() in ("1", "true", "yes", "y", "on")
        )
    if "department" in payload:
        if department:
            attrs["department"] = department
        else:
            attrs.pop("department", None)
    if "workforce_project" in payload:
        if workforce_project:
            attrs["workforce_project"] = workforce_project
        else:
            attrs.pop("workforce_project", None)
    if "job_title" in payload:
        if job_title:
            attrs["job_title"] = job_title
        else:
            attrs.pop("job_title", None)
            attrs.pop("title", None)
            attrs.pop("position", None)
    if "location" in payload or "location_detail" in payload:
        loc_val = location if "location" in payload else str(attrs.get("location") or "")
        ld_val = location_detail if "location_detail" in payload else str(attrs.get("location_detail") or "")
        _normalize_location_into_attrs(attrs, loc_val, ld_val)
    if "reports_to" in payload:
        if reports_to:
            attrs["reports_to"] = reports_to
        else:
            attrs.pop("reports_to", None)
    if "start_date" in payload:
        if start_date:
            attrs["start_date"] = start_date
        else:
            attrs.pop("start_date", None)
    if "contract_sign_date" in payload:
        if contract_sign_date:
            attrs["contract_sign_date"] = contract_sign_date
        else:
            attrs.pop("contract_sign_date", None)
    if "contract_start_date" in payload:
        if contract_start_date:
            attrs["contract_start_date"] = contract_start_date
        else:
            attrs.pop("contract_start_date", None)
    if "contract_end_date" in payload:
        if contract_end_date:
            attrs["contract_end_date"] = contract_end_date
        else:
            attrs.pop("contract_end_date", None)
    if "timezone" in payload:
        if timezone:
            attrs["timezone"] = timezone
        else:
            attrs.pop("timezone", None)
    if "is_contractor" in payload and is_contractor is not None:
        attrs["is_contractor"] = bool(is_contractor)

    final_contractor = bool(attrs.get("is_contractor"))
    if not final_contractor:
        attrs.pop("contractor_company_id", None)
    elif "contractor_company_id" in payload:
        cc_raw = payload.get("contractor_company_id")
        if cc_raw is None or (isinstance(cc_raw, str) and not cc_raw.strip()):
            attrs.pop("contractor_company_id", None)
        else:
            try:
                cid = int(cc_raw)
                if db.session.get(ContractorCompany, cid):
                    attrs["contractor_company_id"] = cid
                else:
                    attrs.pop("contractor_company_id", None)
            except (TypeError, ValueError):
                attrs.pop("contractor_company_id", None)

    u.attributes = attrs
    db.session.add(u)
    db.session.commit()

    return jsonify({"user": _directory_entry_for_user(u)})


@bp.route("/api/users", methods=["POST"])
@login_required
def api_create_user():
    if not _workforce_can_create():
        return jsonify({"error": "forbidden"}), 403

    payload = request.get_json(force=True, silent=True) or {}

    def s(key: str, limit: int = 255) -> str:
        v = payload.get(key)
        if v is None:
            return ""
        out = str(v).strip()
        if len(out) > limit:
            out = out[:limit]
        return out

    full_name = s("full_name", 255)
    first_name = s("first_name", 120)
    surname = s("surname", 120)
    email = s("email", 255)
    phone = s("phone", 64)
    department = s("department", 120)
    workforce_project = s("workforce_project", 120)
    job_title = s("job_title", 255)
    location = s("location", 255)
    location_detail = s("location_detail", 120)
    reports_to = s("reports_to", 255)
    start_date = s("start_date", 32)
    contract_sign_date = s("contract_sign_date", 32)
    contract_start_date = s("contract_start_date", 32)
    contract_end_date = s("contract_end_date", 32)
    timezone = s("timezone", 80)
    password_plain = (payload.get("password") or "").strip()
    handle = s("handle", 120)

    is_contractor_raw = payload.get("is_contractor", False)
    is_contractor = is_contractor_raw if isinstance(is_contractor_raw, bool) else str(is_contractor_raw).strip().lower() in ("1", "true", "yes", "y", "on")

    cia_raw = payload.get("create_intranet_account")
    if isinstance(cia_raw, bool):
        create_intranet_account = cia_raw
    elif cia_raw is None:
        create_intranet_account = bool(password_plain)
    else:
        create_intranet_account = str(cia_raw).strip().lower() in ("1", "true", "yes", "y", "on")

    if not email or "@" not in email:
        return jsonify({"error": "email is required as the resource identifier"}), 400

    el = email.lower()
    clash = db.session.query(User.id).filter(or_(func.lower(User.email) == el, User.username == el)).first()
    if clash:
        return jsonify({"error": "email already in use"}), 409

    u = User(username=el, email=email)
    attrs: dict = {}

    if first_name:
        attrs["first_name"] = first_name
    if surname:
        attrs["surname"] = surname
    u.full_name = _compose_full_name(attrs, full_name) or None

    if phone:
        u.phone = phone

    if department:
        attrs["department"] = department
    if workforce_project:
        attrs["workforce_project"] = workforce_project
    if job_title:
        attrs["job_title"] = job_title
    _normalize_location_into_attrs(attrs, location, location_detail)
    if reports_to:
        attrs["reports_to"] = reports_to
    if start_date:
        attrs["start_date"] = start_date
    if contract_sign_date:
        attrs["contract_sign_date"] = contract_sign_date
    if contract_start_date:
        attrs["contract_start_date"] = contract_start_date
    if contract_end_date:
        attrs["contract_end_date"] = contract_end_date
    if timezone:
        attrs["timezone"] = timezone
    attrs["is_contractor"] = bool(is_contractor)
    if is_contractor:
        cc_raw = payload.get("contractor_company_id")
        if cc_raw is not None and not (isinstance(cc_raw, str) and not cc_raw.strip()):
            try:
                cid = int(cc_raw)
                if db.session.get(ContractorCompany, cid):
                    attrs["contractor_company_id"] = cid
            except (TypeError, ValueError):
                pass
    if handle:
        attrs["handle"] = handle

    import secrets

    if create_intranet_account:
        attrs["intranet_login_enabled"] = True
        rp_raw = payload.get("require_pw_change")
        if rp_raw is not None:
            attrs["require_pw_change"] = (
                bool(rp_raw) if isinstance(rp_raw, bool) else str(rp_raw).strip().lower() in ("1", "true", "yes", "y", "on")
            )
        elif password_plain:
            attrs["require_pw_change"] = True
        if password_plain:
            if len(password_plain) < 8:
                return jsonify({"error": "password must be at least 8 characters"}), 400
            u.set_password(password_plain)
        else:
            return jsonify({"error": "password required when creating an intranet login"}), 400
    else:
        attrs["intranet_login_enabled"] = False
        u.set_password(secrets.token_urlsafe(36))

    u.attributes = attrs
    db.session.add(u)

    if create_intranet_account:
        try:
            rbac.assign_standard_role(u, db.session)
        except Exception:
            pass
        rbac.ensure_user_in_general_group(u, db.session)
    else:
        u.roles = []

    db.session.commit()
    ensure_user_workspace_folder(u)
    return jsonify({"user": _directory_entry_for_user(u)}), 201


@bp.route("/api/workforce-projects", methods=["PUT"])
@login_required
def api_workforce_projects_put():
    """Persist Workforce directory project shells (shared across all users)."""
    if not _workforce_can_create():
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    raw_list = payload.get("projects")
    if raw_list is None:
        raw_list = []
    if not isinstance(raw_list, list):
        return jsonify({"error": "projects array required"}), 400
    normalized = _normalize_workforce_directory_catalog(raw_list)
    set_setting(WORKFORCE_DIRECTORY_PROJECTS_KEY, normalized)
    return jsonify({"ok": True, "projects": normalized})


@bp.route("/api/workforce-projects/remove", methods=["POST"])
@login_required
def api_workforce_projects_remove():
    """Drop a project from the shared catalog and unassign every roster member (including legacy contractor department)."""
    if not _workforce_can_delete():
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    j_err, justification = validate_deletion_justification(payload)
    if j_err:
        return jsonify({"error": j_err}), 400
    raw_name = str(payload.get("name") or "").strip()
    target = _canonical_directory_project_label(raw_name) if raw_name else ""
    if not target or target.lower() == "unassigned":
        return jsonify({"error": "invalid project name"}), 400
    tlow = target.lower()

    base_raw = (
        db.session.query(User)
        .filter(User.is_active.is_(True))
        .order_by(User.full_name.asc(), User.username.asc())
        .all()
    )
    deduped_users, _ = _dedupe_users_by_email(base_raw)
    roster = _workforce_roster_users(deduped_users)

    cleared_ids: list[str] = []
    for u in roster:
        attrs = dict(u.attributes or {})
        raw = _workforce_project_raw(u)
        if not raw:
            continue
        proj = _canonical_directory_project_label(raw)
        if proj.lower() != tlow:
            continue
        wp = attrs.get("workforce_project")
        if wp and str(wp).strip():
            attrs.pop("workforce_project", None)
        elif bool(attrs.get("is_contractor")):
            dept = attrs.get("department")
            if dept and str(dept).strip():
                attrs.pop("department", None)
        u.attributes = attrs
        cleared_ids.append(str(u.id))

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "could not update users"}), 500

    catalog = _load_workforce_directory_projects_catalog()
    next_cat = [
        e
        for e in catalog
        if _canonical_directory_project_label(str(e.get("name") or "").strip()).lower() != tlow
    ]
    set_setting(WORKFORCE_DIRECTORY_PROJECTS_KEY, next_cat)

    audit_write(
        user_id=current_user.id,
        username=current_user.username,
        action="intranet.workforce_project.remove",
        resource_type="workforce_project",
        resource_id=target[:64],
        success=True,
        details={"justification": justification, "cleared": len(cleared_ids)},
    )

    return jsonify({"ok": True, "cleared": len(cleared_ids), "cleared_ids": cleared_ids, "projects": next_cat})


@bp.route("/api/contractor-companies", methods=["GET", "POST"])
@login_required
def api_contractor_companies():
    if request.method == "GET":
        if not _workforce_can_read():
            return jsonify({"error": "forbidden"}), 403
        rows = db.session.query(ContractorCompany).order_by(ContractorCompany.name.asc()).all()
        return jsonify({"companies": [_contractor_company_public_dict(r) for r in rows]})

    if not _workforce_can_create():
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    name = str(payload.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400

    def lim(v: object, n: int) -> str:
        return str(v if v is not None else "").strip()[:n]

    c = ContractorCompany(
        name=name,
        abn=lim(payload.get("abn"), 32) or None,
        acn=lim(payload.get("acn"), 32) or None,
        company_rep=lim(payload.get("company_rep"), 255) or None,
        documents={},
    )
    db.session.add(c)
    db.session.commit()
    return jsonify({"company": _contractor_company_public_dict(c)}), 201


@bp.route("/api/contractor-companies/<int:company_id>", methods=["PATCH", "DELETE"])
@login_required
def api_contractor_company_update(company_id: int):
    c = db.session.get(ContractorCompany, company_id)
    if not c:
        return jsonify({"error": "not found"}), 404

    if request.method == "DELETE":
        if not _workforce_can_delete():
            return jsonify({"error": "forbidden"}), 403
        payload = request.get_json(force=True, silent=True) or {}
        j_err, justification = validate_deletion_justification(payload)
        if j_err:
            return jsonify({"error": j_err}), 400
        name_snap = (c.name or "")[:255]
        for u in db.session.query(User).all():
            attrs = _user_attr_dict(u)
            cid = attrs.get("contractor_company_id")
            try:
                if cid is not None and int(cid) == int(company_id):
                    return jsonify({"error": "Cannot delete company while workforce resources still reference it."}), 409
            except (TypeError, ValueError):
                continue
        try:
            db.session.delete(c)
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({"error": "Could not delete company."}), 500
        audit_write(
            user_id=current_user.id,
            username=current_user.username,
            action="intranet.contractor_company.delete",
            resource_type="contractor_company",
            resource_id=str(company_id),
            success=True,
            details={"justification": justification, "name": name_snap},
        )
        return jsonify({"ok": True})

    if not _workforce_can_create():
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}

    def lim(v: object, n: int) -> str:
        return str(v if v is not None else "").strip()[:n]

    if "name" in payload:
        nm = str(payload.get("name") or "").strip()
        if nm:
            c.name = nm
    if "abn" in payload:
        c.abn = lim(payload.get("abn"), 32) or None
    if "acn" in payload:
        c.acn = lim(payload.get("acn"), 32) or None
    if "company_rep" in payload:
        c.company_rep = lim(payload.get("company_rep"), 255) or None
    db.session.commit()
    return jsonify({"company": _contractor_company_public_dict(c)})


_CONTRACTOR_DOC_KEYS = frozenset({"pi_pl_insurance", "workcover"})


@bp.route("/api/contractor-companies/<int:company_id>/documents/<kind>", methods=["POST"])
@login_required
def api_contractor_company_document_upload(company_id: int, kind: str):
    if kind not in _CONTRACTOR_DOC_KEYS:
        return jsonify({"error": "invalid document type"}), 400
    if not _workforce_can_create():
        return jsonify({"error": "forbidden"}), 403
    c = db.session.get(ContractorCompany, company_id)
    if not c:
        return jsonify({"error": "not found"}), 404
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    orig = secure_filename(f.filename) or "document"
    suf = Path(orig).suffix.lower()
    allowed = (
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".gif",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".txt",
        ".zip",
    )
    ext = suf if suf in allowed else ".bin"
    stored = f"{uuid4().hex}{ext}"
    out_dir = Path(str(current_app.config.get("UPLOAD_ROOT"))) / "contractor_companies" / str(company_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / stored
    f.save(out_path)
    docs = dict(c.documents) if isinstance(c.documents, dict) else {}
    docs[kind] = {"original_name": orig, "stored": stored}
    c.documents = docs
    db.session.commit()
    return jsonify({"company": _contractor_company_public_dict(c)}), 201


@bp.route("/media/contractor-company/<int:company_id>/<path:stored>", methods=["GET"])
@login_required
def media_contractor_company(company_id: int, stored: str):
    root = Path(str(current_app.config.get("UPLOAD_ROOT"))) / "contractor_companies" / str(company_id)
    path = None
    try:
        base = root.resolve()
        path = (base / stored).resolve()
        if base not in path.parents and path != base:
            abort(404)
    except Exception:
        abort(404)
    if path is None or not path.is_file():
        abort(404)
    return send_file(path, conditional=True, max_age=0)


@bp.route("/documents/upload-worker", methods=["GET"])
@login_required
def documents_upload_worker():
    """Separate window (or Turbo-persistent iframe) for XMLHttpRequest uploads while navigating."""
    embed = request.args.get("embed") == "1"
    return render_template("intranet_upload_worker.html", upload_worker_embed=embed)


@bp.route("/documents", methods=["GET"])
@login_required
def documents_page():
    q = (request.args.get("q") or "").strip()
    from app.document_editor_settings import files_template_context
    from app.files_bp import _is_files_tree_admin, _is_portal_admin

    return render_template(
        "intranet_documents.html",
        nav=_nav("documents"),
        q=q,
        files_tree_admin=_is_files_tree_admin(current_user),
        portal_admin=_is_portal_admin(current_user),
        **files_template_context(),
    )


def _wiki_can_read() -> bool:
    """View wiki pages and list content (``wiki.read``). Administrators always can."""
    return rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN) or rbac.user_has_permission(
        current_user, rbac.PERMISSION_WIKI_READ
    )


def _wiki_can_write() -> bool:
    """Create and edit wiki pages (``wiki.write``). Administrators always can."""
    return rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN) or rbac.user_has_permission(
        current_user, rbac.PERMISSION_WIKI_WRITE
    )


def _wiki_can_delete() -> bool:
    return rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN) or rbac.user_has_permission(
        current_user, rbac.PERMISSION_WIKI_DELETE
    )


def _wiki_can_edit_page(page: WikiPage) -> bool:
    """Only the page author may edit article content (admins may edit pages with no author)."""
    if not _wiki_can_write():
        return False
    author_id = page.created_by_id
    if author_id is None:
        return rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN)
    return int(author_id) == int(current_user.id)


def _wiki_author_display(page: WikiPage) -> str:
    u = page.created_by
    if u:
        return (u.full_name or u.username or u.email or "").strip() or "Unknown"
    return ""


def _wiki_can_feedback() -> bool:
    return rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN) or rbac.user_has_permission(
        current_user, rbac.PERMISSION_WIKI_FEEDBACK
    )


def _wiki_feedback_bundle(page: WikiPage) -> dict:
    uid = int(current_user.id) if getattr(current_user, "is_authenticated", False) else None
    rows = db.session.query(WikiPageVote).filter(WikiPageVote.wiki_page_id == page.id).all()
    up = sum(1 for v in rows if int(v.value or 0) > 0)
    down = sum(1 for v in rows if int(v.value or 0) < 0)
    my_vote = None
    if uid:
        mv = (
            db.session.query(WikiPageVote)
            .filter(WikiPageVote.wiki_page_id == page.id, WikiPageVote.user_id == uid)
            .first()
        )
        if mv:
            my_vote = int(mv.value)
    return {
        "helpful_up": up,
        "helpful_down": down,
        "my_vote": my_vote,
        "can_vote": _wiki_can_feedback(),
    }


def _wiki_user_watching(page: WikiPage) -> bool:
    uid = int(current_user.id)
    return (
        db.session.query(WikiPageWatch.id)
        .filter(WikiPageWatch.wiki_page_id == page.id, WikiPageWatch.user_id == uid)
        .first()
        is not None
    )


def _wiki_display_html(p: WikiPage) -> str:
    """Rendered article HTML (rich content or Markdown)."""
    from app.wiki_md import wiki_markdown_to_html
    from app.wiki_sanitize import sanitize_wiki_html

    if (p.content_html or "").strip():
        return sanitize_wiki_html(p.content_html)
    return wiki_markdown_to_html(p.body_md or "")


def _wiki_slugify(raw: str) -> str:
    s = (raw or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")[:160]
    return s or "page"


def _wiki_ensure_default_page() -> None:
    try:
        if db.session.query(WikiPage.id).first():
            return
        uid = getattr(current_user, "id", None)
        p = WikiPage(
            slug="welcome",
            title="Welcome",
            body_md=(
                "# Welcome\n\n"
                "This is your **team wiki**. Open pages from the sidebar; users with **wiki write** "
                "(or administrators) can create and edit articles.\n\n"
                "## Markdown\n\n"
                "- Lists and **bold**\n"
                "- [Links](https://commonmark.org/help/)\n\n"
                "```text\n"
                "Code blocks\n"
                "```\n"
            ),
            created_by_id=uid,
            updated_by_id=uid,
        )
        db.session.add(p)
        db.session.commit()
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass


@bp.route("/wiki", methods=["GET"])
@login_required
def wiki_page():
    if not _wiki_can_read():
        abort(403)
    _wiki_ensure_default_page()
    return render_template(
        "intranet_wiki.html",
        nav=_nav("wiki"),
        wiki_can_edit=_wiki_can_write(),
        wiki_can_delete=_wiki_can_delete(),
        wiki_can_feedback=_wiki_can_feedback(),
    )


@bp.route("/api/wiki/pages", methods=["GET"])
@login_required
def api_wiki_pages_list():
    if not _wiki_can_read():
        return jsonify({"error": "forbidden"}), 403
    _wiki_ensure_default_page()
    rows = WikiPage.query.order_by(WikiPage.title.asc()).all()
    out = []
    for r in rows:
        try:
            ua = r.updated_at.isoformat() if r.updated_at else ""
        except Exception:
            ua = ""
        out.append({"slug": r.slug, "title": r.title, "updated_at": ua})
    return jsonify({"pages": out})


@bp.route("/api/wiki/upload-image", methods=["POST"])
@login_required
def api_wiki_upload_image():
    """Store pasted / inserted images for wiki articles and page notes."""
    if not (_wiki_can_write() or _wiki_can_read()):
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
    elif "svg" in ct:
        ext = ".svg"

    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "wiki_assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid4().hex}{ext}"
    out_path = out_dir / name
    f.save(out_path)
    return (
        jsonify(
            {
                "ok": True,
                "url": url_for("intranet.media_wiki", name=name, _external=True),
            }
        ),
        201,
    )


@bp.route("/media/wiki/<path:name>", methods=["GET"])
@login_required
def media_wiki(name: str):
    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "wiki_assets"
    path = (out_dir / name).resolve()
    try:
        if out_dir.resolve() not in path.parents:
            return jsonify({"error": "not found"}), 404
    except Exception:
        return jsonify({"error": "not found"}), 404
    if not path.exists() or not path.is_file():
        return jsonify({"error": "not found"}), 404
    return send_file(path, conditional=True, max_age=0)


@bp.route("/api/wiki/page/<slug>", methods=["GET"])
@login_required
def api_wiki_page_get(slug: str):
    if not _wiki_can_read():
        return jsonify({"error": "forbidden"}), 403

    s = (slug or "").strip().lower()
    r = WikiPage.query.filter_by(slug=s).first()
    if not r:
        return jsonify({"error": "not found"}), 404
    try:
        ua = r.updated_at.isoformat() if r.updated_at else ""
    except Exception:
        ua = ""
    author = _wiki_author_display(r)
    return jsonify(
        {
            "slug": r.slug,
            "title": r.title,
            "body_md": r.body_md or "",
            "body_html": _wiki_display_html(r),
            "has_rich_content": bool((r.content_html or "").strip()),
            "updated_at": ua,
            "author_name": author,
            "created_by_id": r.created_by_id,
            "can_edit": _wiki_can_edit_page(r),
            "can_delete": _wiki_can_delete(),
            "watching": _wiki_user_watching(r),
            "feedback": _wiki_feedback_bundle(r),
        }
    )


@bp.route("/api/wiki/pages", methods=["POST"])
@login_required
def api_wiki_page_create():
    if not _wiki_can_write():
        return jsonify({"error": "forbidden"}), 403
    from app.wiki_sanitize import sanitize_wiki_html

    payload = request.get_json(force=True, silent=True) or {}
    title = (payload.get("title") or "").strip() or "Untitled"
    body_md = str(payload.get("body_md") if "body_md" in payload else payload.get("body") or "")
    ch_raw = payload.get("content_html")
    raw_slug = (payload.get("slug") or "").strip()
    slug = _wiki_slugify(raw_slug or title)
    if WikiPage.query.filter_by(slug=slug).first():
        return jsonify({"error": "A page with this link already exists."}), 409
    uid = int(current_user.id)
    content_html = None
    if ch_raw is not None and str(ch_raw).strip():
        content_html = sanitize_wiki_html(str(ch_raw)) or None
        if content_html:
            body_md = ""
    p = WikiPage(
        title=title[:255],
        slug=slug,
        body_md=body_md,
        content_html=content_html,
        created_by_id=uid,
        updated_by_id=uid,
    )
    db.session.add(p)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({"error": "Could not create page."}), 409

    return jsonify(
        {
            "ok": True,
            "page": {
                "slug": p.slug,
                "title": p.title,
                "body_md": p.body_md,
                "body_html": _wiki_display_html(p),
                "has_rich_content": bool((p.content_html or "").strip()),
                "can_edit": _wiki_can_edit_page(p),
                "can_delete": _wiki_can_delete(),
            },
        }
    )


@bp.route("/api/wiki/page/<slug>", methods=["PATCH"])
@login_required
def api_wiki_page_patch(slug: str):
    from app.wiki_sanitize import sanitize_wiki_html

    s = (slug or "").strip().lower()
    r = WikiPage.query.filter_by(slug=s).first()
    if not r:
        return jsonify({"error": "not found"}), 404
    if not _wiki_can_edit_page(r):
        return jsonify({"error": "Only the page author can edit this article."}), 403
    payload = request.get_json(force=True, silent=True) or {}
    if "title" in payload:
        t = (payload.get("title") or "").strip()
        if t:
            r.title = t[:255]
    if "content_html" in payload:
        ch = payload.get("content_html")
        if ch is None:
            r.content_html = None
        else:
            cleaned = sanitize_wiki_html(str(ch))
            r.content_html = cleaned or None
            if r.content_html:
                r.body_md = ""
    elif "body_md" in payload or "body" in payload:
        r.body_md = str(payload.get("body_md") if "body_md" in payload else payload.get("body") or "")
        r.content_html = None
    r.updated_by_id = int(current_user.id)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Save failed."}), 500

    try:
        ua = r.updated_at.isoformat() if r.updated_at else ""
    except Exception:
        ua = ""

    return jsonify(
        {
            "ok": True,
            "page": {
                "slug": r.slug,
                "title": r.title,
                "body_md": r.body_md,
                "body_html": _wiki_display_html(r),
                "has_rich_content": bool((r.content_html or "").strip()),
                "updated_at": ua,
                "can_edit": _wiki_can_edit_page(r),
                "can_delete": _wiki_can_delete(),
            },
        }
    )


def _wiki_note_json(n: WikiPageNote) -> dict:
    from app.wiki_sanitize import sanitize_wiki_html

    u = n.user
    name = ""
    if u:
        name = (u.full_name or u.username or u.email or "").strip()
    try:
        ca = n.created_at.isoformat() if n.created_at else ""
    except Exception:
        ca = ""
    return {
        "id": n.id,
        "body_html": sanitize_wiki_html(n.body_html or ""),
        "created_at": ca,
        "author_name": name or "User",
        "author_id": n.user_id,
        "is_mine": int(n.user_id) == int(current_user.id),
    }


@bp.route("/api/wiki/page/<slug>/notes", methods=["GET"])
@login_required
def api_wiki_page_notes_list(slug: str):
    if not _wiki_can_read():
        return jsonify({"error": "forbidden"}), 403
    s = (slug or "").strip().lower()
    r = WikiPage.query.filter_by(slug=s).first()
    if not r:
        return jsonify({"error": "not found"}), 404
    rows = (
        WikiPageNote.query.filter_by(wiki_page_id=r.id)
        .order_by(WikiPageNote.created_at.asc())
        .all()
    )
    return jsonify({"notes": [_wiki_note_json(n) for n in rows]})


@bp.route("/api/wiki/page/<slug>/notes", methods=["POST"])
@login_required
def api_wiki_page_notes_create(slug: str):
    if not _wiki_can_read():
        return jsonify({"error": "forbidden"}), 403
    from app.wiki_sanitize import sanitize_wiki_html

    s = (slug or "").strip().lower()
    r = WikiPage.query.filter_by(slug=s).first()
    if not r:
        return jsonify({"error": "not found"}), 404
    payload = request.get_json(force=True, silent=True) or {}
    raw = str(payload.get("body_html") or payload.get("body") or "").strip()
    if not raw:
        return jsonify({"error": "Note cannot be empty."}), 400
    cleaned = sanitize_wiki_html(raw)
    if not cleaned or cleaned == "<p><br></p>":
        return jsonify({"error": "Note cannot be empty."}), 400
    if len(cleaned) > 100_000:
        return jsonify({"error": "Note is too long."}), 400
    n = WikiPageNote(wiki_page_id=r.id, user_id=int(current_user.id), body_html=cleaned)
    db.session.add(n)
    db.session.commit()
    return jsonify({"ok": True, "note": _wiki_note_json(n)})


@bp.route("/api/wiki/page/<slug>", methods=["DELETE"])
@login_required
def api_wiki_page_delete(slug: str):
    if not _wiki_can_delete():
        return jsonify({"error": "forbidden"}), 403
    s = (slug or "").strip().lower()
    r = WikiPage.query.filter_by(slug=s).first()
    if not r:
        return jsonify({"error": "not found"}), 404
    db.session.query(WikiPageVote).filter(WikiPageVote.wiki_page_id == r.id).delete(synchronize_session=False)
    db.session.query(WikiPageWatch).filter(WikiPageWatch.wiki_page_id == r.id).delete(synchronize_session=False)
    db.session.query(WikiPageNote).filter(WikiPageNote.wiki_page_id == r.id).delete(synchronize_session=False)
    db.session.delete(r)
    db.session.commit()
    return jsonify({"ok": True})


@bp.route("/api/wiki/watches", methods=["GET"])
@login_required
def api_wiki_watches_list():
    if not _wiki_can_read():
        return jsonify({"error": "forbidden"}), 403
    uid = int(current_user.id)
    rows = (
        db.session.query(WikiPage.slug)
        .join(WikiPageWatch, WikiPageWatch.wiki_page_id == WikiPage.id)
        .filter(WikiPageWatch.user_id == uid)
        .order_by(WikiPage.title.asc())
        .all()
    )
    slugs = [t[0] for t in rows]
    return jsonify({"slugs": slugs})


@bp.route("/api/wiki/page/<slug>/watch", methods=["PUT"])
@login_required
def api_wiki_page_watch_put(slug: str):
    if not _wiki_can_read():
        return jsonify({"error": "forbidden"}), 403
    s = (slug or "").strip().lower()
    r = WikiPage.query.filter_by(slug=s).first()
    if not r:
        return jsonify({"error": "not found"}), 404
    payload = request.get_json(force=True, silent=True) or {}
    watch = bool(payload.get("watch"))
    uid = int(current_user.id)
    row = (
        db.session.query(WikiPageWatch)
        .filter(WikiPageWatch.wiki_page_id == r.id, WikiPageWatch.user_id == uid)
        .first()
    )
    if watch:
        if not row:
            db.session.add(WikiPageWatch(user_id=uid, wiki_page_id=r.id))
    elif row:
        db.session.delete(row)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not update watch."}), 500
    return jsonify({"ok": True, "watching": watch})


@bp.route("/api/wiki/page/<slug>/feedback", methods=["PUT"])
@login_required
def api_wiki_page_feedback_put(slug: str):
    if not _wiki_can_read():
        return jsonify({"error": "forbidden"}), 403
    if not _wiki_can_feedback():
        return jsonify({"error": "forbidden"}), 403
    s = (slug or "").strip().lower()
    r = WikiPage.query.filter_by(slug=s).first()
    if not r:
        return jsonify({"error": "not found"}), 404
    payload = request.get_json(force=True, silent=True) or {}
    raw = payload.get("vote")
    try:
        vote = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        vote = None
    uid = int(current_user.id)
    row = (
        db.session.query(WikiPageVote)
        .filter(WikiPageVote.wiki_page_id == r.id, WikiPageVote.user_id == uid)
        .first()
    )
    if vote == 0 or vote is None:
        if row and int(row.value or 0) == 1:
            return jsonify({"error": "You can only mark helpful once per page; that vote cannot be removed."}), 400
        if row:
            db.session.delete(row)
    elif vote in (1, -1):
        if vote == 1 and row and int(row.value or 0) == 1:
            pass
        elif row:
            row.value = vote
        else:
            db.session.add(WikiPageVote(user_id=uid, wiki_page_id=r.id, value=vote))
    else:
        return jsonify({"error": "vote must be -1, 0, or 1"}), 400
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not save feedback."}), 500
    return jsonify({"ok": True, "feedback": _wiki_feedback_bundle(r)})


def _kanban_board_id_from_request(*, required: bool = True) -> int | None:
    raw = None
    if request.view_args and request.view_args.get("board_id") is not None:
        raw = request.view_args.get("board_id")
    elif request.args.get("board_id") not in (None, ""):
        raw = request.args.get("board_id")
    elif request.method in ("POST", "PUT", "PATCH"):
        payload = request.get_json(silent=True) or {}
        if isinstance(payload, dict) and payload.get("board_id") not in (None, ""):
            raw = payload.get("board_id")
    if raw is None:
        if required:
            abort(400, description="board_id required")
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        abort(400, description="invalid board_id")


def _kanban_board(board_id: int | None = None) -> KanbanBoard:
    from app.kanban_service import get_board_for_user

    bid = int(board_id) if board_id is not None else int(_kanban_board_id_from_request())
    board = get_board_for_user(bid, current_user)
    if not board:
        abort(404)
    return board


def _kanban_access_for(board: KanbanBoard) -> str | None:
    from app.kanban_service import kanban_user_board_access

    return kanban_user_board_access(current_user, board)


def _kanban_can_read_board(board: KanbanBoard | None = None) -> bool:
    from app.kanban_service import kanban_can_read_board

    target = board or _kanban_board()
    return kanban_can_read_board(current_user, target)


def _kanban_can_write_board(board: KanbanBoard | None = None) -> bool:
    from app.kanban_service import kanban_can_write_board

    target = board or _kanban_board()
    return kanban_can_write_board(current_user, target)


def _kanban_can_delete_board(board: KanbanBoard | None = None) -> bool:
    from app.kanban_service import kanban_can_delete_board

    target = board or _kanban_board()
    return kanban_can_delete_board(current_user, target)


def _kanban_can_read() -> bool:
    from app.kanban_service import ensure_default_board, list_accessible_boards

    if rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
        return True
    if rbac.user_has_permission(current_user, rbac.PERMISSION_KANBAN_READ):
        return True
    ensure_default_board(user_id=int(current_user.id))
    return bool(list_accessible_boards(current_user))


def _kanban_can_write() -> bool:
    return _kanban_can_write_board(_kanban_board())


def _kanban_can_delete() -> bool:
    return _kanban_can_delete_board(_kanban_board())


def _kanban_can_create_board() -> bool:
    return rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN) or rbac.user_has_permission(
        current_user, rbac.PERMISSION_KANBAN_WRITE
    )


def _kanban_can_admin_delete_board() -> bool:
    from app.kanban_service import kanban_can_admin_delete_board

    return kanban_can_admin_delete_board(current_user)


def _kanban_access() -> str | None:
    return _kanban_access_for(_kanban_board())


def _kanban_board_payload(board: KanbanBoard) -> dict:
    from app.kanban_service import serialize_board

    row = db.session.get(KanbanBoard, board.id)
    return serialize_board(row or board)


def _kanban_board_for_column(col: KanbanColumn) -> KanbanBoard:
    board = db.session.get(KanbanBoard, col.board_id)
    if not board:
        abort(404)
    return board


def _kanban_board_for_card(card: KanbanCard) -> KanbanBoard:
    col = db.session.get(KanbanColumn, card.column_id)
    if not col:
        abort(404)
    return _kanban_board_for_column(col)


def _kanban_parse_due_at(raw) -> datetime | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _kanban_card_or_404(card_id: int, *, include_deleted: bool = False) -> KanbanCard:
    card = db.session.get(KanbanCard, card_id)
    if not card:
        abort(404)
    if not include_deleted and card.deleted_at is not None:
        abort(404)
    return card


def _kanban_notify_safe(fn, *args, **kwargs) -> None:
    try:
        fn(*args, **kwargs)
    except Exception:
        current_app.logger.exception("KanBan email notification failed")


@bp.route("/kanban", methods=["GET"])
@login_required
def kanban_page():
    if not _kanban_can_read():
        abort(403)
    from app.kanban_service import ensure_default_board

    ensure_default_board(user_id=int(current_user.id))
    return render_template(
        "intranet_kanban.html",
        nav=_nav("kanban"),
        kanban_can_create=_kanban_can_create_board(),
        kanban_can_delete_board=_kanban_can_admin_delete_board(),
    )


@bp.route("/kanban/board/<int:board_id>", methods=["GET"])
@login_required
def kanban_board_page(board_id: int):
    board = _kanban_board(board_id)
    if not _kanban_can_read_board(board):
        abort(403)
    return render_template(
        "intranet_kanban_board.html",
        nav=_nav(f"kanban_board_{board_id}"),
        board=board,
        kanban_can_edit=_kanban_can_write_board(board),
        kanban_can_delete=_kanban_can_delete_board(board),
        kanban_can_delete_board=_kanban_can_admin_delete_board(),
        kanban_can_manage_shares=_kanban_can_write_board(board),
    )


@bp.route("/api/kanban/boards", methods=["GET", "POST"])
@login_required
def api_kanban_boards():
    if not _kanban_can_read():
        return jsonify({"error": "forbidden"}), 403
    from app.kanban_service import create_board, ensure_default_board, list_accessible_boards, serialize_board_summary

    if request.method == "GET":
        ensure_default_board(user_id=int(current_user.id))
        boards = list_accessible_boards(current_user)
        return jsonify({"boards": [serialize_board_summary(b, user=current_user) for b in boards]})

    if not _kanban_can_create_board():
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    name = str(payload.get("name") or "").strip()[:120]
    if not name:
        return jsonify({"error": "name required"}), 400
    subtitle = str(payload.get("subtitle") or "").strip()[:240] or None
    board = create_board(name=name, user_id=int(current_user.id), subtitle=subtitle)
    return jsonify({"ok": True, "board": serialize_board_summary(board, user=current_user)})


@bp.route("/api/kanban/boards/<int:board_id>", methods=["GET", "PATCH", "DELETE"])
@login_required
def api_kanban_board_mutate(board_id: int):
    board = _kanban_board(board_id)
    if request.method == "DELETE":
        if not _kanban_can_admin_delete_board():
            return jsonify({"error": "forbidden"}), 403
        from app.kanban_service import delete_board

        name = board.name or "Board"
        try:
            delete_board(board)
        except Exception:
            db.session.rollback()
            return jsonify({"error": "Could not delete board."}), 500
        return jsonify({"ok": True, "deleted_id": int(board_id), "name": name})

    if request.method == "PATCH":
        if not _kanban_can_write_board(board):
            return jsonify({"error": "forbidden"}), 403
        payload = request.get_json(force=True, silent=True) or {}
        from app.kanban_service import DEFAULT_BOARD_SUBTITLE, log_board_activity, serialize_board, serialize_board_general

        changes: dict[str, object] = {}
        if "name" in payload:
            name = str(payload.get("name") or "").strip()[:120]
            if not name:
                return jsonify({"error": "name required"}), 400
            if name != (board.name or ""):
                changes["name"] = name
                board.name = name
        if "subtitle" in payload:
            subtitle = str(payload.get("subtitle") or "").strip()[:240] or DEFAULT_BOARD_SUBTITLE
            if subtitle != (board.subtitle or DEFAULT_BOARD_SUBTITLE):
                changes["subtitle"] = subtitle
                board.subtitle = subtitle
        if not changes:
            access = _kanban_access_for(board) or ""
            return jsonify(
                {
                    "ok": True,
                    "board": serialize_board(board),
                    "general": serialize_board_general(board, access=access),
                }
            )
        log_board_activity(
            board,
            user_id=int(current_user.id),
            action="settings_updated",
            details=changes,
        )
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({"error": "Could not save board settings."}), 500
        board = db.session.get(KanbanBoard, board.id)
        access = _kanban_access_for(board) or ""
        return jsonify(
            {
                "ok": True,
                "board": serialize_board(board),
                "general": serialize_board_general(board, access=access),
            }
        )

    if not _kanban_can_read_board(board):
        return jsonify({"error": "forbidden"}), 403
    return jsonify({"board": _kanban_board_payload(board)})


@bp.route("/api/kanban/columns", methods=["POST"])
@login_required
def api_kanban_column_create():
    payload = request.get_json(force=True, silent=True) or {}
    board = _kanban_board(_kanban_board_id_from_request())
    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    title = str(payload.get("title") or "").strip()[:120]
    if not title:
        return jsonify({"error": "title required"}), 400
    from app.kanban_service import next_column_position, serialize_board

    col = KanbanColumn(
        board_id=board.id,
        title=title,
        position=next_column_position(board.id),
        color_token=str(payload.get("color_token") or "").strip()[:32] or None,
    )
    db.session.add(col)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not create column."}), 500
    board = db.session.get(KanbanBoard, board.id)
    return jsonify({"ok": True, "board": serialize_board(board)})


@bp.route("/api/kanban/columns/<int:column_id>", methods=["PATCH", "DELETE"])
@login_required
def api_kanban_column_mutate(column_id: int):
    col = db.session.get(KanbanColumn, column_id)
    if not col:
        return jsonify({"error": "not found"}), 404
    board = _kanban_board_for_column(col)
    if request.method == "DELETE":
        if not _kanban_can_delete_board(board):
            return jsonify({"error": "forbidden"}), 403
        board_id = int(col.board_id)
        db.session.delete(col)
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({"error": "Could not delete column."}), 500
        from app.kanban_service import serialize_board

        board = db.session.get(KanbanBoard, board_id)
        return jsonify({"ok": True, "board": serialize_board(board)})

    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    if "title" in payload:
        title = str(payload.get("title") or "").strip()[:120]
        if not title:
            return jsonify({"error": "title required"}), 400
        col.title = title
    if "color_token" in payload:
        col.color_token = str(payload.get("color_token") or "").strip()[:32] or None
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not update column."}), 500
    from app.kanban_service import serialize_board

    board = db.session.get(KanbanBoard, col.board_id)
    return jsonify({"ok": True, "board": serialize_board(board)})


@bp.route("/api/kanban/assignees", methods=["GET"])
@login_required
def api_kanban_assignees():
    if not _kanban_can_read():
        return jsonify({"error": "forbidden"}), 403
    rows = (
        db.session.query(User)
        .filter(User.is_active.is_(True))
        .order_by(User.full_name.asc(), User.username.asc())
        .limit(500)
        .all()
    )
    out = []
    for u in rows:
        name = (u.full_name or u.username or u.email or "").strip()
        if not name:
            continue
        out.append({"id": int(u.id), "name": name, "email": (u.email or "").strip()})
    return jsonify({"users": out})


@bp.route("/api/kanban/cards", methods=["POST"])
@login_required
def api_kanban_card_create():
    payload = request.get_json(force=True, silent=True) or {}
    title = str(payload.get("title") or "").strip()[:255]
    column_id = payload.get("column_id")
    try:
        column_id = int(column_id)
    except (TypeError, ValueError):
        return jsonify({"error": "column_id required"}), 400
    if not title:
        return jsonify({"error": "title required"}), 400
    col = db.session.get(KanbanColumn, column_id)
    if not col:
        return jsonify({"error": "column not found"}), 404
    board = _kanban_board_for_column(col)
    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    from app.kanban_service import is_todo_column, log_kanban_activity, next_card_position, normalize_kanban_priority, serialize_board, serialize_card_detail

    if not is_todo_column(col):
        return jsonify({"error": "Cards can only be added to the To do column."}), 400

    body = str(payload.get("body") or "").strip()[:4000] or None
    priority = normalize_kanban_priority(payload.get("priority"))
    card = KanbanCard(
        column_id=col.id,
        title=title,
        body=body,
        priority=priority,
        position=next_card_position(col.id),
        created_by_id=int(current_user.id),
    )
    db.session.add(card)
    db.session.flush()
    log_kanban_activity(card, user_id=int(current_user.id), action="created", details={"title": title})
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not create card."}), 500
    board = db.session.get(KanbanBoard, col.board_id)
    card = db.session.get(KanbanCard, card.id)
    return jsonify({"ok": True, "board": serialize_board(board), "card": serialize_card_detail(card)})


@bp.route("/api/kanban/cards/<int:card_id>", methods=["GET", "PATCH", "DELETE"])
@login_required
def api_kanban_card_mutate(card_id: int):
    card = _kanban_card_or_404(card_id)
    col = db.session.get(KanbanColumn, card.column_id)
    board = _kanban_board_for_column(col) if col else None
    board_id = int(board.id) if board else 0

    if request.method == "GET":
        if not board or not _kanban_can_read_board(board):
            return jsonify({"error": "forbidden"}), 403
        from app.kanban_service import serialize_card_detail

        return jsonify({"card": serialize_card_detail(card)})

    if request.method == "DELETE":
        if not board:
            return jsonify({"error": "not found"}), 404
        if not _kanban_can_delete_board(board) and not _kanban_can_write_board(board):
            return jsonify({"error": "forbidden"}), 403
        from app.kanban_service import log_board_activity, log_kanban_activity, serialize_board, soft_delete_card

        card_title = card.title or ""
        soft_delete_card(card, user_id=int(current_user.id))
        log_kanban_activity(
            card,
            user_id=int(current_user.id),
            action="deleted",
            details={"title": card_title},
        )
        log_board_activity(
            board,
            user_id=int(current_user.id),
            action="card_deleted",
            details={"title": card_title},
            card_id=int(card.id),
        )
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
            return jsonify({"error": "Could not delete card."}), 500
        board = db.session.get(KanbanBoard, board_id)
        return jsonify({"ok": True, "board": serialize_board(board)})

    if not board or not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    from app.kanban_service import log_kanban_activity, move_card, normalize_kanban_priority, serialize_board, serialize_card_detail
    from app.wiki_sanitize import sanitize_wiki_html

    prev_assignee_id = int(card.assignee_id) if card.assignee_id else None
    changes: dict[str, object] = {}
    if "title" in payload:
        title = str(payload.get("title") or "").strip()[:255]
        if not title:
            return jsonify({"error": "title required"}), 400
        card.title = title
        changes["title"] = title
    if "body" in payload:
        card.body = str(payload.get("body") or "").strip()[:4000] or None
        changes["body"] = True
    if "body_html" in payload:
        cleaned = sanitize_wiki_html(str(payload.get("body_html") or ""))
        card.body_html = cleaned or None
        card.body = None
        changes["description"] = True
    if "assignee_id" in payload:
        raw = payload.get("assignee_id")
        if raw in (None, "", 0, "0"):
            card.assignee_id = None
            changes["assignee_id"] = None
        else:
            try:
                uid = int(raw)
            except (TypeError, ValueError):
                return jsonify({"error": "invalid assignee_id"}), 400
            user = db.session.get(User, uid)
            if not user or not user.is_active:
                return jsonify({"error": "assignee not found"}), 404
            card.assignee_id = uid
            changes["assignee_id"] = uid
    if "due_at" in payload:
        card.due_at = _kanban_parse_due_at(payload.get("due_at"))
        changes["due_at"] = card.due_at.isoformat() if card.due_at else None
    if "priority" in payload:
        card.priority = normalize_kanban_priority(payload.get("priority"))
        changes["priority"] = card.priority
    if "column_id" in payload:
        try:
            new_col_id = int(payload.get("column_id"))
        except (TypeError, ValueError):
            return jsonify({"error": "invalid column_id"}), 400
        target_col = db.session.get(KanbanColumn, new_col_id)
        if not target_col or int(target_col.board_id) != board_id:
            return jsonify({"error": "column not found"}), 404
        if int(card.column_id) != new_col_id:
            old_title = col.title if col else ""
            move_card(card=card, column_id=new_col_id, position=0)
            changes["column_id"] = new_col_id
            changes["from_column"] = old_title
            changes["to_column"] = target_col.title
    card.updated_at = utcnow()
    if changes:
        log_kanban_activity(
            card,
            user_id=int(current_user.id),
            action="updated" if "column_id" not in changes else "moved",
            details=changes,
        )
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not update card."}), 500
    board = db.session.get(KanbanBoard, board_id)
    card = db.session.get(KanbanCard, card.id)
    from app.kanban_notifications import notify_card_assigned, notify_card_due_date, notify_card_moved

    if card.assignee_id and int(card.assignee_id) != int(prev_assignee_id or 0):
        _kanban_notify_safe(notify_card_assigned, card, current_user)
    if "due_at" in changes:
        _kanban_notify_safe(notify_card_due_date, card, current_user)
    if "from_column" in changes:
        _kanban_notify_safe(
            notify_card_moved,
            card,
            current_user,
            from_column=str(changes.get("from_column") or ""),
            to_column=str(changes.get("to_column") or ""),
        )
    return jsonify({"ok": True, "board": serialize_board(board), "card": serialize_card_detail(card)})


@bp.route("/api/kanban/cards/<int:card_id>/done", methods=["POST"])
@login_required
def api_kanban_card_mark_done(card_id: int):
    card = _kanban_card_or_404(card_id)
    col = db.session.get(KanbanColumn, card.column_id)
    if not col:
        return jsonify({"error": "column not found"}), 404
    board = _kanban_board_for_column(col)
    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    from app.kanban_service import find_done_column, log_kanban_activity, move_card, serialize_board, serialize_card_detail

    done_col = find_done_column(board)
    if not done_col:
        return jsonify({"error": "No Done column configured."}), 400
    if int(card.column_id) == int(done_col.id):
        return jsonify({"ok": True, "board": serialize_board(board), "card": serialize_card_detail(card)})
    move_card(card=card, column_id=int(done_col.id), position=0)
    log_kanban_activity(
        card,
        user_id=int(current_user.id),
        action="marked_done",
        details={"column": done_col.title},
    )
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not mark card done."}), 500
    board = db.session.get(KanbanBoard, board.id)
    card = db.session.get(KanbanCard, card.id)
    from app.kanban_notifications import notify_card_marked_done

    _kanban_notify_safe(notify_card_marked_done, card, current_user, column_name=done_col.title or "Done")
    return jsonify({"ok": True, "board": serialize_board(board), "card": serialize_card_detail(card)})


@bp.route("/api/kanban/cards/<int:card_id>/comment-images", methods=["POST"])
@login_required
def api_kanban_card_comment_image_upload(card_id: int):
    card = _kanban_card_or_404(card_id)
    board = _kanban_board_for_card(card)
    if not _kanban_can_read_board(board):
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
    elif "svg" in ct:
        ext = ".svg"

    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "kanban_assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid4().hex}{ext}"
    out_path = out_dir / name
    f.save(out_path)
    return (
        jsonify(
            {
                "ok": True,
                "url": url_for("intranet.media_kanban", name=name, _external=False),
            }
        ),
        201,
    )


@bp.route("/media/kanban/<path:name>", methods=["GET"])
@login_required
def media_kanban(name: str):
    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "kanban_assets"
    path = (out_dir / name).resolve()
    try:
        if out_dir.resolve() not in path.parents:
            return jsonify({"error": "not found"}), 404
    except Exception:
        return jsonify({"error": "not found"}), 404
    if not path.exists() or not path.is_file():
        return jsonify({"error": "not found"}), 404
    return send_file(path, conditional=True, max_age=0)


@bp.route("/api/kanban/cards/<int:card_id>/comments", methods=["POST"])
@login_required
def api_kanban_card_comment_create(card_id: int):
    card = _kanban_card_or_404(card_id)
    board = _kanban_board_for_card(card)
    if not _kanban_can_read_board(board):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    from app.kanban_service import comment_html_to_plain, log_kanban_activity, serialize_card_detail
    from app.wiki_sanitize import sanitize_wiki_html

    body_html_raw = str(payload.get("body_html") or "").strip()
    body_plain = str(payload.get("body") or "").strip()
    body_html: str | None = None
    if body_html_raw:
        body_html = sanitize_wiki_html(body_html_raw) or None
        body = comment_html_to_plain(body_html or body_html_raw) or body_plain
    else:
        body = body_plain
    body = body[:4000]
    if not body and not body_html:
        return jsonify({"error": "body required"}), 400

    row = KanbanCardComment(
        card_id=card.id,
        user_id=int(current_user.id),
        body=body or comment_html_to_plain(body_html or "")[:4000] or "Comment",
        body_html=body_html,
    )
    db.session.add(row)
    preview = body[:120] if body else comment_html_to_plain(body_html or "")[:120]
    log_kanban_activity(card, user_id=int(current_user.id), action="commented", details={"preview": preview})
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not add comment."}), 500
    card = db.session.get(KanbanCard, card.id)
    from app.kanban_notifications import notify_card_commented

    _kanban_notify_safe(notify_card_commented, card, current_user, comment_preview=preview)
    return jsonify({"ok": True, "card": serialize_card_detail(card)})


@bp.route("/api/kanban/cards/<int:card_id>/attachments", methods=["POST"])
@login_required
def api_kanban_card_attachment_upload(card_id: int):
    card = _kanban_card_or_404(card_id)
    board = _kanban_board_for_card(card)
    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    from app.file_storage import store_stream_and_digest
    from app.kanban_service import log_kanban_activity, serialize_card_detail

    try:
        relpath, size, _sha, mime = store_stream_and_digest(f.stream, f.filename)
    except Exception:
        return jsonify({"error": "Could not store attachment."}), 500
    att = KanbanCardAttachment(
        card_id=card.id,
        filename=(f.filename or "attachment")[:255],
        storage_relpath=relpath,
        size=int(size or 0),
        mime_type=mime,
        uploaded_by_id=int(current_user.id),
    )
    db.session.add(att)
    log_kanban_activity(
        card,
        user_id=int(current_user.id),
        action="attachment_added",
        details={"filename": att.filename},
    )
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not save attachment."}), 500
    card = db.session.get(KanbanCard, card.id)
    return jsonify({"ok": True, "card": serialize_card_detail(card)})


@bp.route("/api/kanban/attachments/<int:attachment_id>", methods=["GET", "DELETE"])
@login_required
def api_kanban_attachment_mutate(attachment_id: int):
    att = db.session.get(KanbanCardAttachment, attachment_id)
    if not att:
        return jsonify({"error": "not found"}), 404
    card = db.session.get(KanbanCard, att.card_id)
    if not card:
        return jsonify({"error": "not found"}), 404
    board = _kanban_board_for_card(card)
    if request.method == "GET":
        if not _kanban_can_read_board(board):
            return jsonify({"error": "forbidden"}), 403
        from app.file_storage import absolute_path

        try:
            path = absolute_path(att.storage_relpath)
        except ValueError:
            abort(404)
        if not path.is_file():
            abort(404)
        return send_file(path, as_attachment=True, download_name=att.filename, mimetype=att.mime_type)

    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    from app.kanban_service import log_kanban_activity, serialize_card_detail

    filename = att.filename
    db.session.delete(att)
    log_kanban_activity(
        card,
        user_id=int(current_user.id),
        action="attachment_removed",
        details={"filename": filename},
    )
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not delete attachment."}), 500
    card = db.session.get(KanbanCard, card.id)
    return jsonify({"ok": True, "card": serialize_card_detail(card)})


@bp.route("/api/kanban/cards/<int:card_id>/move", methods=["PATCH"])
@login_required
def api_kanban_card_move(card_id: int):
    card = db.session.get(KanbanCard, card_id)
    if not card or card.deleted_at is not None:
        return jsonify({"error": "not found"}), 404
    board = _kanban_board_for_card(card)
    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    try:
        column_id = int(payload.get("column_id"))
        position = int(payload.get("position", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "column_id and position required"}), 400
    target_col = db.session.get(KanbanColumn, column_id)
    if not target_col:
        return jsonify({"error": "column not found"}), 404
    from app.kanban_service import log_kanban_activity, move_card, serialize_board

    old_col = db.session.get(KanbanColumn, card.column_id)
    try:
        move_card(card=card, column_id=column_id, position=position)
        if old_col and int(old_col.id) != int(column_id):
            target_col = db.session.get(KanbanColumn, column_id)
            log_kanban_activity(
                card,
                user_id=int(current_user.id),
                action="moved",
                details={
                    "from_column": old_col.title,
                    "to_column": target_col.title if target_col else "",
                },
            )
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not move card."}), 500
    board = db.session.get(KanbanBoard, target_col.board_id)
    card = db.session.get(KanbanCard, card.id)
    if old_col and int(old_col.id) != int(column_id):
        from app.kanban_notifications import notify_card_moved

        _kanban_notify_safe(
            notify_card_moved,
            card,
            current_user,
            from_column=old_col.title or "",
            to_column=(target_col.title if target_col else ""),
        )
    return jsonify({"ok": True, "board": serialize_board(board)})


@bp.route("/api/kanban/general", methods=["GET"])
@login_required
def api_kanban_general_get():
    board = _kanban_board(_kanban_board_id_from_request())
    if not _kanban_can_read_board(board):
        return jsonify({"error": "forbidden"}), 403
    from app.kanban_service import serialize_board_general

    access = _kanban_access_for(board) or ""
    return jsonify({"general": serialize_board_general(board, access=access)})


@bp.route("/api/kanban/share-targets", methods=["GET"])
@login_required
def api_kanban_share_targets():
    board = _kanban_board(_kanban_board_id_from_request())
    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    from app.kanban_service import list_kanban_share_targets

    return jsonify(list_kanban_share_targets())


@bp.route("/api/kanban/shares", methods=["PUT"])
@login_required
def api_kanban_shares_put():
    board = _kanban_board(_kanban_board_id_from_request())
    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    from app.kanban_service import (
        log_board_activity,
        normalize_group_shares,
        normalize_user_shares,
        serialize_board_general,
    )

    users_in = payload.get("users") if isinstance(payload.get("users"), list) else []
    groups_in = payload.get("groups") if isinstance(payload.get("groups"), list) else []
    user_rows: list[dict[str, object]] = []
    for row in users_in[:200]:
        if not isinstance(row, dict):
            continue
        try:
            uid = int(row.get("user_id"))
        except (TypeError, ValueError):
            continue
        if uid == int(current_user.id):
            continue
        user = db.session.get(User, uid)
        if not user or not user.is_active:
            continue
        user_rows.append({"user_id": uid, "can_edit": bool(row.get("can_edit"))})
    group_rows: list[dict[str, object]] = []
    for row in groups_in[:200]:
        if not isinstance(row, dict):
            continue
        try:
            gid = int(row.get("group_id"))
        except (TypeError, ValueError):
            continue
        group = db.session.get(Group, gid)
        if not group:
            continue
        group_rows.append({"group_id": gid, "can_edit": bool(row.get("can_edit"))})
    board.shared_users = normalize_user_shares(user_rows)
    board.shared_groups = normalize_group_shares(group_rows)
    log_board_activity(
        board,
        user_id=int(current_user.id),
        action="shares_updated",
        details={"users": len(board.shared_users or []), "groups": len(board.shared_groups or [])},
    )
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not save sharing settings."}), 500
    access = _kanban_access_for(board) or ""
    return jsonify({"ok": True, "general": serialize_board_general(board, access=access)})


@bp.route("/api/kanban/deleted", methods=["GET"])
@login_required
def api_kanban_deleted_cards():
    board = _kanban_board(_kanban_board_id_from_request())
    if not _kanban_can_read_board(board):
        return jsonify({"error": "forbidden"}), 403
    from app.kanban_service import serialize_deleted_card
    rows = (
        db.session.query(KanbanCard)
        .join(KanbanColumn, KanbanCard.column_id == KanbanColumn.id)
        .filter(KanbanColumn.board_id == int(board.id), KanbanCard.deleted_at.isnot(None))
        .order_by(KanbanCard.deleted_at.desc(), KanbanCard.id.desc())
        .limit(200)
        .all()
    )
    return jsonify({"cards": [serialize_deleted_card(c) for c in rows]})


@bp.route("/api/kanban/cards/<int:card_id>/restore", methods=["POST"])
@login_required
def api_kanban_card_restore(card_id: int):
    card = _kanban_card_or_404(card_id, include_deleted=True)
    if card.deleted_at is None:
        return jsonify({"error": "not deleted"}), 400
    col = db.session.get(KanbanColumn, card.column_id)
    if not col:
        return jsonify({"error": "not found"}), 404
    board = _kanban_board_for_column(col)
    if not _kanban_can_write_board(board):
        return jsonify({"error": "forbidden"}), 403
    from app.kanban_service import log_board_activity, log_kanban_activity, restore_card, serialize_board

    title = card.title or ""
    restore_card(card)
    log_kanban_activity(card, user_id=int(current_user.id), action="restored", details={"title": title})
    log_board_activity(
        board,
        user_id=int(current_user.id),
        action="card_restored",
        details={"title": title},
        card_id=int(card.id),
    )
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not restore card."}), 500
    board = db.session.get(KanbanBoard, col.board_id)
    return jsonify({"ok": True, "board": serialize_board(board)})


@bp.route("/api/kanban/cards/<int:card_id>/purge", methods=["DELETE"])
@login_required
def api_kanban_card_purge(card_id: int):
    card = _kanban_card_or_404(card_id, include_deleted=True)
    if card.deleted_at is None:
        return jsonify({"error": "not deleted"}), 400
    col = db.session.get(KanbanColumn, card.column_id)
    if not col:
        return jsonify({"error": "not found"}), 404
    board = _kanban_board_for_column(col)
    if not _kanban_can_delete_board(board):
        return jsonify({"error": "forbidden"}), 403
    board_id = int(board.id)
    db.session.delete(card)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return jsonify({"error": "Could not permanently delete card."}), 500
    from app.kanban_service import serialize_board

    board = db.session.get(KanbanBoard, board_id)
    return jsonify({"ok": True, "board": serialize_board(board) if board else {}})


@bp.route("/api/kanban/activity", methods=["GET"])
@login_required
def api_kanban_board_activity():
    board = _kanban_board(_kanban_board_id_from_request())
    if not _kanban_can_read_board(board):
        return jsonify({"error": "forbidden"}), 403
    from app.kanban_service import board_activity_feed
    limit = request.args.get("limit", 100)
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 100
    return jsonify({"activity": board_activity_feed(int(board.id), limit=limit)})
