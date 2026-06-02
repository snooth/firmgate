"""Community Edition intranet routes (wiki, documents, workforce APIs).

Community Edition intranet routes (wiki, documents, workforce APIs).
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from flask import abort, current_app, jsonify, render_template, request, send_file, url_for
from flask_login import current_user, login_required
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models import ContractorCompany, User, WikiPage, WikiPageNote, WikiPageVote, WikiPageWatch
from app import rbac
from app.files_workspace import ensure_user_workspace_folder
from app.intranet_bp import (
    bp,
    _nav,
    _workforce_can_read,
    _workforce_can_create,
    _workforce_can_delete,
    _directory_entry_for_user,
    _contractor_company_public_dict,
    _compose_full_name,
    _normalize_location_into_attrs,
)

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
    from app.files_bp import _is_files_tree_admin

    return render_template(
        "intranet_documents.html",
        nav=_nav("documents"),
        q=q,
        files_tree_admin=_is_files_tree_admin(current_user),
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
