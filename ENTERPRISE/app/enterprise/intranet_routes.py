"""Enterprise intranet routes (licensed modules — excluded from PUBLIC export)."""

from __future__ import annotations

import calendar as calendar_mod
import html
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

from flask import Blueprint, abort, current_app, jsonify, render_template, request, send_file, url_for
from flask_login import current_user, login_required
from markupsafe import Markup
from werkzeug.utils import secure_filename
from sqlalchemy import func, inspect, or_, update
from sqlalchemy.exc import IntegrityError, OperationalError

from app.branding import portal_core_name, portal_shell_name
from app.extensions import db
from app.html_clean import announcement_snippet_html, render_about_body_markup, sanitize_about_html, strip_data_uri_images
from app.models import (
    BlogPost,
    CalendarEvent,
    ChatCallSignal,
    ChatMessage,
    ChatRoom,
    ChatRoomMember,
    CRMActivity,
    ContractorCompany,
    CRMCompany,
    CRMLead,
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
from app.intranet_bp import bp, _nav, _intranet_rel_path, _workforce_roster_users, _directory_display_name, _user_attr_dict, _dedupe_users_by_email, _norm_email_for_dedupe, _workforce_can_read, _workforce_can_create, _workforce_can_delete, _presence_status


@bp.before_request
def _enterprise_module_intranet_guard():
    """Block enterprise module URLs without a valid license."""
    from app.community_edition import abort_if_module_locked

    rel = _intranet_rel_path()
    if rel.startswith("/crm") or rel.startswith("/api/crm"):
        abort_if_module_locked("crm")
    if rel.startswith("/security-clearance") or rel.startswith("/api/security-clearance"):
        abort_if_module_locked("security_clearance")
    if rel.startswith("/resource-pool") or rel.startswith("/api/resource-pool"):
        abort_if_module_locked("resource_pool")
    if rel.startswith("/resource-calculator") or rel.startswith("/api/resource-calculator"):
        abort_if_module_locked("resource_calculator")
    return None


@bp.before_request
def _enterprise_ai_intranet_guard():
    from flask import abort
    from app.community_edition import is_community_edition
    if not is_community_edition():
        return None
    from app.enterprise.premium_license import (
        ai_chatbot_licensed,
        ai_cv_builder_licensed,
        ai_document_search_licensed,
        ai_policy_assistant_licensed,
        ai_tender_assistant_licensed,
        enterprise_license_applied,
    )
    rel = _intranet_rel_path()
    if not (
        rel.startswith("/ai-document-search")
        or rel.startswith("/api/ai-document-search")
        or rel.startswith("/ai-chatbot")
        or rel.startswith("/api/ai-chatbot")
        or rel.startswith("/ai-policy-assistant")
        or rel.startswith("/api/ai-policy-assistant")
        or rel.startswith("/ai-cv-builder")
        or rel.startswith("/api/ai-cv-builder")
        or rel.startswith("/ai-tender-assistant")
        or rel.startswith("/api/ai-tender-assistant")
    ):
        return None
    if not enterprise_license_applied():
        abort(404)
    if rel.startswith("/ai-document-search") or rel.startswith("/api/ai-document-search"):
        if not ai_document_search_licensed():
            abort(404)
    elif rel.startswith("/ai-chatbot") or rel.startswith("/api/ai-chatbot"):
        if not ai_chatbot_licensed():
            abort(404)
    elif rel.startswith("/ai-policy-assistant") or rel.startswith("/api/ai-policy-assistant"):
        if not ai_policy_assistant_licensed():
            abort(404)
    elif rel.startswith("/ai-cv-builder") or rel.startswith("/api/ai-cv-builder"):
        if not ai_cv_builder_licensed():
            abort(404)
    elif rel.startswith("/ai-tender-assistant") or rel.startswith("/api/ai-tender-assistant"):
        if not ai_tender_assistant_licensed():
            abort(404)
    return None


from app.enterprise.security_clearance_import import parse_json_record_list, parse_workbook_bytes
from app.enterprise.resource_pool_cv_import import allowed_cv_suffix, parse_cv_file
from app.enterprise.resource_pool_service import (
    append_resource_note,
    build_resource_pool_payload,
    clear_resource_cv,
    create_resource as rp_create_resource,
    create_resource_with_cv,
    cv_upload_dir,
    delete_resource as rp_delete_resource,
    get_resource as rp_get_resource,
    resolve_cv_path,
    resource_to_api_dict,
    set_resource_cv,
    update_resource as rp_update_resource,
    update_resource_experience,
    update_resource_notes_from_text,
    update_resource_overview,
    update_resource_skills,
)
from app.enterprise.security_clearance_store import (
    count_clearance_records,
    ensure_clearance_table,
    ensure_sql_populated_from_backups,
    import_clearance_records,
    load_clearance_records,
    migrate_legacy_clearance_records,
    repair_clearance_storage,
    replace_clearance_records,
    storage_diagnostics,
    sync_clearance_records,
)

def _security_clearance_module_allowed(user: User) -> bool:
    """Users on the restricted Security Clearance module allowlist (Administration → Modules)."""
    if not user or not getattr(user, "is_authenticated", False):
        return False
    if rbac.user_has_permission(user, rbac.PERMISSION_ADMIN):
        return True
    try:
        cfg = get_setting("modules", default={}) or {}
        mods = cfg.get("modules") if isinstance(cfg, dict) else None
        mods = mods if isinstance(mods, dict) else {}
        rule = mods.get("security_clearance") if isinstance(mods, dict) else None
        rule = rule if isinstance(rule, dict) else {}
        if rule.get("enabled") is False:
            return False
        if not bool(rule.get("restricted")):
            return False
        ids = rule.get("allowed_user_ids")
        ids = ids if isinstance(ids, list) else []
        uid = getattr(user, "id", None)
        if uid is None:
            return False
        return int(uid) in {int(x) for x in ids}
    except Exception:
        return False


def _security_can_read() -> bool:
    """View Security Clearance module (`security.read`)."""
    return rbac.user_can_security_read(current_user) or _security_clearance_module_allowed(current_user)


def _security_can_write() -> bool:
    """Add/edit/import clearance records (`security.write`)."""
    return rbac.user_can_security_write(current_user) or _security_clearance_module_allowed(current_user)


def _security_can_delete() -> bool:
    return rbac.user_can_security_delete(current_user) or _security_clearance_module_allowed(current_user)


def _security_clearance_setting() -> dict:
    cfg = get_setting("security_clearance", default={}) or {}
    return cfg if isinstance(cfg, dict) else {}


def _normalize_security_clearance_records(raw) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for r in raw[:5000]:
        if not isinstance(r, dict):
            continue
        csid = str(r.get("csid") or "").strip()[:120]
        if not csid:
            continue
        key = csid.upper()
        if key in seen:
            continue
        seen.add(key)
        notes_raw = r.get("notes")
        notes_out: list[dict] = []
        if isinstance(notes_raw, list):
            for n in notes_raw[:500]:
                if not isinstance(n, dict):
                    continue
                note = {
                    "by": str(n.get("by") or "")[:120],
                    "at": str(n.get("at") or "")[:40],
                    "text": str(n.get("text") or "")[:8000],
                }
                atts = n.get("attachments")
                if isinstance(atts, list):
                    clean_atts = []
                    for a in atts[:20]:
                        if not isinstance(a, dict):
                            continue
                        data = str(a.get("data") or "")
                        if len(data) > 2_000_000:
                            data = data[:2_000_000]
                        clean_atts.append(
                            {
                                "name": str(a.get("name") or "")[:240],
                                "mime": str(a.get("mime") or "")[:120],
                                "data": data,
                            }
                        )
                    if clean_atts:
                        note["attachments"] = clean_atts
                notes_out.append(note)
        signed_pdfs_out: list[dict] = []
        pdfs_raw = r.get("signed_pdfs")
        if isinstance(pdfs_raw, list):
            for a in pdfs_raw[:20]:
                if not isinstance(a, dict):
                    continue
                data = str(a.get("data") or "")
                if len(data) > 2_500_000:
                    data = data[:2_500_000]
                name = str(a.get("name") or "")[:240]
                if not name:
                    continue
                signed_pdfs_out.append(
                    {
                        "id": str(a.get("id") or "")[:64],
                        "name": name,
                        "mime": str(a.get("mime") or "application/pdf")[:120],
                        "data": data,
                    }
                )
        if not signed_pdfs_out:
            legacy_name = str(r.get("signed_pdf_name") or "")[:240].strip()
            if legacy_name:
                signed_pdfs_out.append(
                    {
                        "id": "legacy-name-only",
                        "name": legacy_name,
                        "mime": "application/pdf",
                        "data": "",
                    }
                )
        out.append(
            {
                "created_at": int(r.get("created_at") or 0) or 0,
                "csid": csid,
                "given": str(r.get("given") or "")[:200],
                "family": str(r.get("family") or "")[:200],
                "agent_request_from": str(r.get("agent_request_from") or "")[:120],
                "level": str(r.get("level") or "")[:40],
                "dob": str(r.get("dob") or "")[:32],
                "email": str(r.get("email") or "")[:240],
                "phone": str(r.get("phone") or "")[:80],
                "signed_pdfs": signed_pdfs_out,
                "revalidation": str(r.get("revalidation") or "")[:32],
                "grant_date": str(r.get("grant_date") or "")[:32],
                "expiry": str(r.get("expiry") or "")[:32],
                "status": str(r.get("status") or "Active")[:40],
                "archived": bool(r.get("archived")),
                "notes": notes_out,
            }
        )
    return out


def _sc2_attachment_has_data(att: dict) -> bool:
    data = str(att.get("data") or "")
    return data.startswith("data:") or (len(data) > 64 and not data.startswith("http"))


def _merge_sc2_attachment_lists(incoming: list, previous: list) -> list:
    """Keep stored file bytes when the client omits heavy data URLs (bulk save)."""
    if not isinstance(previous, list):
        previous = []
    prev_by_id: dict[str, dict] = {}
    for a in previous:
        if not isinstance(a, dict):
            continue
        aid = str(a.get("id") or "").strip()
        if aid:
            prev_by_id[aid] = a
    out: list[dict] = []
    if not isinstance(incoming, list):
        return out
    for a in incoming:
        if not isinstance(a, dict):
            continue
        row = dict(a)
        aid = str(row.get("id") or "").strip()
        if aid and not _sc2_attachment_has_data(row) and aid in prev_by_id:
            prev = prev_by_id[aid]
            if _sc2_attachment_has_data(prev):
                row["data"] = prev.get("data")
                if not row.get("mime"):
                    row["mime"] = prev.get("mime")
        out.append(row)
    return out


def _merge_sc2_record_fields(incoming: dict, previous: dict) -> dict:
    merged = dict(incoming)
    merged["signed_pdfs"] = _merge_sc2_attachment_lists(
        incoming.get("signed_pdfs"), previous.get("signed_pdfs")
    )
    notes_in = incoming.get("notes")
    notes_prev = previous.get("notes")
    if isinstance(notes_in, list) and isinstance(notes_prev, list):
        prev_notes = list(notes_prev)
        notes_out: list[dict] = []
        for idx, note in enumerate(notes_in):
            if not isinstance(note, dict):
                continue
            note_row = dict(note)
            prev_note = prev_notes[idx] if idx < len(prev_notes) else None
            if isinstance(prev_note, dict):
                atts_in = note_row.get("attachments")
                atts_prev = prev_note.get("attachments")
                if isinstance(atts_in, list):
                    note_row["attachments"] = _merge_sc2_attachment_lists(atts_in, atts_prev)
            notes_out.append(note_row)
        merged["notes"] = notes_out
    return merged


def _merge_security_clearance_save(incoming: list[dict], existing: list[dict]) -> list[dict]:
    existing_by = {str(r.get("csid") or "").strip().upper(): r for r in existing if r.get("csid")}
    merged: list[dict] = []
    for rec in incoming:
        key = str(rec.get("csid") or "").strip().upper()
        prev = existing_by.get(key)
        merged.append(_merge_sc2_record_fields(rec, prev) if prev else rec)
    return merged


def _security_clearance_records_load() -> list[dict]:
    migrate_legacy_clearance_records(_normalize_security_clearance_records)
    ensure_sql_populated_from_backups(_normalize_security_clearance_records)
    rows = load_clearance_records()
    return _normalize_security_clearance_records(rows)


def _security_clearance_records_save(records: list[dict]) -> int:
    norm = _normalize_security_clearance_records(records)
    if not norm and records:
        raise RuntimeError("All records were rejected (each row needs a CSID).")
    n = sync_clearance_records(norm)
    if len(norm) > 0 and n < len(norm):
        raise RuntimeError(f"Only {n} of {len(norm)} clearance records were stored.")
    return n


def _sc2_agent_options_from_cfg(cfg: dict) -> list[str]:
    raw = cfg.get("agent_request_from_options")
    items = raw if isinstance(raw, list) else []
    out: list[str] = []
    seen: set[str] = set()
    for it in items[:500]:
        s = str(it or "").strip()[:120]
        if not s:
            continue
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(s)
    return out


def _apply_sc2_import_row(existing: dict | None, incoming: dict) -> dict:
    """Merge spreadsheet/import row onto an existing clearance record."""
    if not existing:
        return dict(incoming)
    out = dict(existing)
    for key in (
        "given",
        "family",
        "agent_request_from",
        "level",
        "dob",
        "email",
        "phone",
        "revalidation",
        "grant_date",
        "expiry",
        "status",
    ):
        val = incoming.get(key)
        if val is not None and str(val).strip() != "":
            out[key] = val
    if incoming.get("archived") is False:
        out["archived"] = False
    return out


def _import_parsed_rows(
    parsed_rows: list[dict], *, skipped_blank: int = 0
) -> tuple[list[dict], int, int, int]:
    incoming = _normalize_security_clearance_records(parsed_rows)
    if not incoming:
        raise RuntimeError(
            "No valid clearance rows to import. Each row needs a CSID "
            "(column names like CSID, CS ID, or Personnel ID)."
        )
    added, updated, sql_n = import_clearance_records(incoming, merge_import=True)
    records = _security_clearance_records_load()
    if sql_n <= 0 or not records:
        raise RuntimeError(
            f"Import wrote 0 rows to SQL ({len(incoming)} parsed, "
            f"{added} added, {updated} updated)."
        )
    return records, added, updated, skipped_blank


def _import_security_clearance_records(raw_rows: list) -> tuple[list[dict], int, int, int]:
    parsed = parse_json_record_list(raw_rows)
    return _import_parsed_rows(parsed)


def _security_clearance_admin_tools() -> bool:
    return bool(rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN))

def _crm_can_read() -> bool:
    """View CRM pages and lead data (`crm.read`)."""
    return rbac.user_can_crm_read(current_user)


def _crm_can_create() -> bool:
    """Create or update CRM leads, contacts, notes (`crm.create`)."""
    return rbac.user_can_crm_create(current_user)


def _crm_can_delete() -> bool:
    return rbac.user_can_crm_delete(current_user)

@bp.route("/security-clearance", methods=["GET"])
@login_required
def security_clearance_page():
    if not _security_can_read():
        abort(403)
    q = (request.args.get("q") or "").strip()
    cfg = get_setting("security_clearance", default={}) or {}
    if not isinstance(cfg, dict):
        cfg = {}
    opts_raw = cfg.get("agent_request_from_options")
    opts = opts_raw if isinstance(opts_raw, list) else []
    out: list[str] = []
    for it in opts[:200]:
        s = str(it or "").strip()
        if s:
            out.append(s[:120])
    if not out:
        out = ["Admin", "HR", "Project Manager", "Recruiter"]
    clearance_level_options = ["Baseline", "NV1", "NV2", "PV"]
    ensure_clearance_table()
    ensure_sql_populated_from_backups(_normalize_security_clearance_records)
    security_clearance_records = _security_clearance_records_load()
    server_count = count_clearance_records()
    sc2_diag = None
    if _security_clearance_admin_tools():
        sc2_diag = storage_diagnostics()
    return render_template(
        "intranet_security_clearance.html",
        nav=_nav("security_clearance"),
        q=q,
        agent_request_from_options=out,
        clearance_level_options=clearance_level_options,
        security_clearance_records=security_clearance_records,
        security_clearance_server_count=server_count,
        security_clearance_diag=sc2_diag,
        security_can_write=_security_can_write(),
        security_can_delete=_security_can_delete(),
        security_is_admin=_security_clearance_admin_tools(),
    )


@bp.route("/api/security-clearance/records", methods=["GET"])
@login_required
def api_security_clearance_records_get():
    if not _security_can_read():
        return jsonify({"error": "forbidden"}), 403
    records = _security_clearance_records_load()
    sql_count = count_clearance_records()
    payload: dict = {
        "records": records,
        "count": sql_count,
        "loaded": len(records),
        "storage": "sql",
    }
    if _security_clearance_admin_tools():
        payload["diagnostics"] = storage_diagnostics()
    return jsonify(payload)


@bp.route("/api/security-clearance/records/status", methods=["GET"])
@login_required
def api_security_clearance_records_status():
    """Storage health check (admins only) — record count + DB path."""
    if not _security_clearance_admin_tools():
        return jsonify({"error": "forbidden"}), 403
    diag = storage_diagnostics()
    diag["sql_count"] = count_clearance_records()
    return jsonify(diag)


@bp.route("/api/security-clearance/records/repair", methods=["POST"])
@login_required
def api_security_clearance_records_repair():
    """Reload clearance rows from settings/JSON backups into SQL."""
    if not _security_can_write():
        return jsonify({"error": "forbidden"}), 403
    try:
        result = repair_clearance_storage(_normalize_security_clearance_records)
    except RuntimeError as e:
        return jsonify({"error": str(e), "diagnostics": storage_diagnostics()}), 500
    records = _security_clearance_records_load()
    return jsonify(
        {
            "ok": True,
            "records": records,
            "count": len(records),
            "stored_count": count_clearance_records(),
            **result,
        }
    )


@bp.route("/api/security-clearance/records", methods=["PUT"])
@login_required
def api_security_clearance_records_put():
    if not _security_can_write():
        return jsonify({"error": "forbidden"}), 403
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400
    payload = request.get_json(force=True, silent=True)
    if payload is None:
        return (
            jsonify(
                {
                    "error": "Could not read request body (payload too large or invalid JSON). "
                    "Records were not changed."
                }
            ),
            413,
        )
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400
    raw = payload.get("records")
    if raw is None:
        return jsonify({"error": "records array required"}), 400
    if not isinstance(raw, list):
        return jsonify({"error": "records must be an array"}), 400

    existing = _security_clearance_records_load()
    incoming = _normalize_security_clearance_records(raw)

    if not incoming and existing:
        allow_clear = bool(payload.get("confirm_clear"))
        if not allow_clear:
            return (
                jsonify(
                    {
                        "error": f"Refusing to clear {len(existing)} clearance record(s). "
                        "Send confirm_clear only if intentional."
                    }
                ),
                400,
            )

    records = _merge_security_clearance_save(incoming, existing)
    try:
        stored_count = _security_clearance_records_save(records)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    records = _security_clearance_records_load()
    audit_write(
        user_id=current_user.id,
        username=current_user.username,
        action="intranet.security_clearance.records.save",
        resource_type="security_clearance",
        resource_id="records",
        success=True,
        details={"count": stored_count},
    )
    return jsonify({"ok": True, "records": records, "count": len(records), "stored_count": stored_count})


@bp.route("/api/security-clearance/records/import-file", methods=["POST"])
@login_required
def api_security_clearance_records_import_file():
    """Upload .xlsx and import on the server (reliable persistence)."""
    if not _security_can_write():
        return jsonify({"error": "forbidden"}), 403
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    ensure_clearance_table()
    try:
        data = f.read()
        parsed = parse_workbook_bytes(data, f.filename)
    except ValueError as e:
        return jsonify({"error": str(e), "diagnostics": storage_diagnostics()}), 400
    except ImportError as e:
        return (
            jsonify(
                {
                    "error": "openpyxl is not installed on the server. Run: sudo /root/update.sh --recreate-venv",
                    "diagnostics": storage_diagnostics(),
                }
            ),
            500,
        )
    if not parsed:
        return (
            jsonify(
                {
                    "error": "No importable rows found. Ensure the first row has headers and a CSID column.",
                    "rows_parsed": 0,
                }
            ),
            400,
        )
    try:
        records, added, updated, skipped = _import_parsed_rows(parsed, skipped_blank=0)
    except RuntimeError as e:
        current_app.logger.exception("security clearance import-file failed")
        return jsonify({"error": str(e), "rows_parsed": len(parsed)}), 500
    sql_count = count_clearance_records()
    if sql_count <= 0:
        diag = storage_diagnostics()
        current_app.logger.error(
            "security clearance import-file stored 0 SQL rows (parsed=%s, diag=%s)",
            len(parsed),
            diag,
        )
        return (
            jsonify(
                {
                    "error": "Import completed but database has 0 rows.",
                    "rows_parsed": len(parsed),
                    "diagnostics": diag,
                }
            ),
            500,
        )
    audit_write(
        user_id=current_user.id,
        username=current_user.username,
        action="intranet.security_clearance.records.import_file",
        resource_type="security_clearance",
        resource_id="records",
        success=True,
        details={
            "added": added,
            "updated": updated,
            "skipped": skipped,
            "total": sql_count,
            "filename": f.filename,
        },
    )
    return jsonify(
        {
            "ok": True,
            "records": records,
            "added": added,
            "updated": updated,
            "skipped": skipped,
            "rows_parsed": len(parsed),
            "total": sql_count,
            "stored_count": sql_count,
            "sql_count": sql_count,
            "diagnostics": storage_diagnostics(),
        }
    )


@bp.route("/api/security-clearance/records/import", methods=["POST"])
@login_required
def api_security_clearance_records_import():
    """Import JSON rows (legacy); prefer import-file for Excel."""
    if not _security_can_write():
        return jsonify({"error": "forbidden"}), 403
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400
    payload = request.get_json(force=True, silent=True)
    if payload is None or not isinstance(payload, dict):
        return jsonify({"error": "invalid JSON body"}), 400
    raw = payload.get("records")
    if not isinstance(raw, list):
        return jsonify({"error": "records array required"}), 400
    if not raw:
        return jsonify({"error": "no records to import"}), 400
    try:
        records, added, updated, skipped = _import_security_clearance_records(raw)
    except RuntimeError as e:
        return jsonify({"error": str(e), "rows_received": len(raw)}), 500
    sql_count = count_clearance_records()
    if sql_count <= 0:
        return jsonify(
            {
                "error": "Import completed but nothing was stored in SQL.",
                "rows_received": len(raw),
                "diagnostics": storage_diagnostics(),
            }
        ), 500
    audit_write(
        user_id=current_user.id,
        username=current_user.username,
        action="intranet.security_clearance.records.import",
        resource_type="security_clearance",
        resource_id="records",
        success=True,
        details={"added": added, "updated": updated, "skipped": skipped, "total": sql_count},
    )
    return jsonify(
        {
            "ok": True,
            "records": records,
            "added": added,
            "updated": updated,
            "skipped": skipped,
            "total": sql_count,
            "stored_count": sql_count,
            "sql_count": sql_count,
        }
    )


@bp.route("/api/security-clearance/records/export", methods=["GET"])
@login_required
def api_security_clearance_records_export():
    if not _security_clearance_admin_tools():
        return jsonify({"error": "forbidden"}), 403
    cfg = _security_clearance_setting()
    records = _security_clearance_records_load()
    return jsonify(
        {
            "version": 1,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "record_count": len(records),
            "agent_request_from_options": _sc2_agent_options_from_cfg(cfg),
            "records": records,
        }
    )


@bp.route("/api/security-clearance/records/restore", methods=["POST"])
@login_required
def api_security_clearance_records_restore():
    if not _security_clearance_admin_tools():
        return jsonify({"error": "forbidden"}), 403
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400
    payload = request.get_json(force=True, silent=True)
    if payload is None or not isinstance(payload, dict):
        return jsonify({"error": "invalid JSON body"}), 400
    raw = payload.get("records")
    if not isinstance(raw, list):
        return jsonify({"error": "records array required"}), 400
    if not raw:
        return jsonify({"error": "backup contains no records"}), 400
    mode = str(payload.get("mode") or "replace").strip().lower()
    if mode not in ("replace", "merge"):
        return jsonify({"error": "mode must be replace or merge"}), 400

    existing = _security_clearance_records_load()
    incoming = _normalize_security_clearance_records(raw)

    if mode == "merge":
        try:
            records, added, updated, skipped = _import_security_clearance_records(raw)
        except RuntimeError as e:
            return jsonify({"error": str(e)}), 500
        audit_write(
            user_id=current_user.id,
            username=current_user.username,
            action="intranet.security_clearance.records.restore",
            resource_type="security_clearance",
            resource_id="records",
            success=True,
            details={"mode": "merge", "added": added, "updated": updated, "total": len(records)},
        )
        return jsonify(
            {
                "ok": True,
                "mode": "merge",
                "records": records,
                "added": added,
                "updated": updated,
                "skipped": skipped,
                "total": len(records),
            }
        )

    records = incoming
    try:
        stored_count = replace_clearance_records(records)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    opts_raw = payload.get("agent_request_from_options")
    if isinstance(opts_raw, list):
        cfg = dict(_security_clearance_setting())
        cfg["agent_request_from_options"] = _sc2_agent_options_from_cfg(
            {"agent_request_from_options": opts_raw}
        )
        cfg.pop("records", None)
        set_setting("security_clearance", cfg)
    records = _security_clearance_records_load()
    audit_write(
        user_id=current_user.id,
        username=current_user.username,
        action="intranet.security_clearance.records.restore",
        resource_type="security_clearance",
        resource_id="records",
        success=True,
        details={"mode": "replace", "total": len(records), "previous": len(existing)},
    )
    return jsonify(
        {
            "ok": True,
            "mode": "replace",
            "records": records,
            "total": len(records),
            "stored_count": stored_count,
        }
    )


@bp.route("/api/security-clearance/record-delete-audit", methods=["POST"])
@login_required
def api_security_clearance_record_delete_audit():
    """Record audit trail before client removes a clearance row from browser storage."""
    if not _security_can_delete():
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    j_err, justification = validate_deletion_justification(payload)
    if j_err:
        return jsonify({"error": j_err}), 400
    csid = str(payload.get("csid") or "").strip()[:120]
    if not csid:
        return jsonify({"error": "Clearance record id (csid) is required."}), 400
    audit_write(
        user_id=current_user.id,
        username=current_user.username,
        action="intranet.security_clearance.record.delete",
        resource_type="security_clearance",
        resource_id=csid[:64],
        success=True,
        details={"justification": justification},
    )
    return jsonify({"ok": True})


def _resource_pool_payload() -> dict:
    return build_resource_pool_payload()


@bp.route("/resource-pool", methods=["GET"])
@login_required
def resource_pool_page():
    if not _workforce_can_read():
        abort(403)
    payload = _resource_pool_payload()
    u = current_user
    author_name = _directory_display_name(u) if u.is_authenticated else ""
    if not author_name and u.is_authenticated:
        author_name = (getattr(u, "full_name", None) or getattr(u, "username", None) or "User").strip()
    return render_template(
        "intranet_resource_pool.html",
        nav=_nav("resource_pool"),
        pool_json=json.dumps(payload),
        can_create=_workforce_can_create(),
        can_delete=_workforce_can_delete(),
        rp_user_json=json.dumps(
            {
                "id": int(u.id) if u.is_authenticated else 0,
                "name": author_name or "User",
            }
        ),
    )


@bp.route("/api/resource-pool", methods=["GET"])
@login_required
def resource_pool_api():
    if not _workforce_can_read():
        abort(403)
    return jsonify(_resource_pool_payload())


@bp.route("/api/resource-pool/import/preview", methods=["POST"])
@login_required
def resource_pool_import_preview_api():
    if not _workforce_can_create():
        abort(403)
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    data = f.read()
    if not data:
        return jsonify({"error": "empty file"}), 400
    payload = _resource_pool_payload()
    known_skills = list(payload.get("filters", {}).get("skills") or [])
    try:
        extracted = parse_cv_file(f.filename, data, known_skills=known_skills)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500
    except Exception:
        return jsonify({"error": "could not read CV"}), 500
    return jsonify({"extracted": extracted, "filename": secure_filename(f.filename) or "cv.pdf"})


@bp.route("/api/resource-pool/import", methods=["POST"])
@login_required
def resource_pool_import_create_api():
    if not _workforce_can_create():
        abort(403)
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    file_data = f.read()
    if not file_data:
        return jsonify({"error": "empty file"}), 400
    orig = secure_filename(f.filename) or "cv.pdf"
    suf = allowed_cv_suffix(orig)
    if not suf:
        return jsonify({"error": "PDF or Word (.docx) required"}), 400

    skills_raw = (request.form.get("skills") or "").strip()
    skills_list = [s.strip() for s in skills_raw.replace(";", ",").split(",") if s.strip()]

    given = (request.form.get("given_name") or "").strip()[:120]
    family = (request.form.get("family_name") or "").strip()[:120]
    full = (request.form.get("full_name") or "").strip()[:255]
    if not full and (given or family):
        full = f"{given} {family}".strip()[:255]
    if not full:
        return jsonify({"error": "name required"}), 400

    body = {
        "full_name": full,
        "given_name": given,
        "family_name": family,
        "email": (request.form.get("email") or "").strip()[:255],
        "location": (request.form.get("location") or "").strip()[:255],
        "clearance_level": (request.form.get("clearance_level") or "").strip()[:40],
        "job_title": (request.form.get("job_title") or "").strip()[:255],
        "skills": skills_list,
    }
    mime = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        if suf == ".docx"
        else "application/pdf"
    )
    try:
        row = create_resource_with_cv(
            body,
            file_bytes=file_data,
            original_name=orig,
            mime=mime,
            actor_id=getattr(current_user, "id", None),
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception:
        db.session.rollback()
        return jsonify({"error": "could not import resource"}), 500
    return jsonify({"resource": resource_to_api_dict(row)}), 201


@bp.route("/api/resource-pool/resources", methods=["POST"])
@login_required
def resource_pool_create_api():
    if not _workforce_can_create():
        abort(403)
    data = request.get_json(force=True, silent=True) or {}
    try:
        row = rp_create_resource(data, actor_id=getattr(current_user, "id", None))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception:
        db.session.rollback()
        return jsonify({"error": "could not create resource"}), 500
    return jsonify({"resource": resource_to_api_dict(row)}), 201


@bp.route("/api/resource-pool/resources/<int:resource_id>", methods=["GET", "PATCH", "DELETE"])
@login_required
def resource_pool_resource_api(resource_id: int):
    row = rp_get_resource(resource_id)
    if request.method == "GET":
        if not _workforce_can_read():
            abort(403)
        if not row:
            return jsonify({"error": "not found"}), 404
        return jsonify({"resource": resource_to_api_dict(row)})

    if request.method == "PATCH":
        if not _workforce_can_create():
            abort(403)
        if not row:
            return jsonify({"error": "not found"}), 404
        data = request.get_json(force=True, silent=True) or {}
        try:
            row = rp_update_resource(row, data, actor_id=getattr(current_user, "id", None))
        except Exception:
            db.session.rollback()
            return jsonify({"error": "could not update resource"}), 500
        return jsonify({"resource": resource_to_api_dict(row)})

    if not _workforce_can_delete():
        abort(403)
    if not row:
        return jsonify({"error": "not found"}), 404
    try:
        rp_delete_resource(row)
    except Exception:
        db.session.rollback()
        return jsonify({"error": "could not delete resource"}), 500
    return jsonify({"ok": True})


@bp.route("/api/resource-pool/resources/<int:resource_id>/skills", methods=["PATCH"])
@login_required
def resource_pool_skills_api(resource_id: int):
    if not _workforce_can_create():
        abort(403)
    row = rp_get_resource(resource_id)
    if not row:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(force=True, silent=True) or {}
    raw = data.get("skills")
    if raw is None:
        raw = data.get("skills_text", "")
    try:
        row = update_resource_skills(row, raw, actor_id=getattr(current_user, "id", None))
    except Exception:
        db.session.rollback()
        return jsonify({"error": "could not update skills"}), 500
    return jsonify({"resource": resource_to_api_dict(row)})


@bp.route("/api/resource-pool/resources/<int:resource_id>/overview", methods=["PATCH"])
@login_required
def resource_pool_overview_api(resource_id: int):
    if not _workforce_can_create():
        abort(403)
    row = rp_get_resource(resource_id)
    if not row:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(force=True, silent=True) or {}
    try:
        row = update_resource_overview(row, data, actor_id=getattr(current_user, "id", None))
    except Exception:
        db.session.rollback()
        return jsonify({"error": "could not update overview"}), 500
    return jsonify({"resource": resource_to_api_dict(row)})


@bp.route("/api/resource-pool/resources/<int:resource_id>/experience", methods=["PATCH"])
@login_required
def resource_pool_experience_api(resource_id: int):
    if not _workforce_can_create():
        abort(403)
    row = rp_get_resource(resource_id)
    if not row:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(force=True, silent=True) or {}
    try:
        row = update_resource_experience(row, data, actor_id=getattr(current_user, "id", None))
    except Exception:
        db.session.rollback()
        return jsonify({"error": "could not update experience"}), 500
    return jsonify({"resource": resource_to_api_dict(row)})


@bp.route("/api/resource-pool/resources/<int:resource_id>/notes", methods=["POST", "PATCH"])
@login_required
def resource_pool_notes_api(resource_id: int):
    if not _workforce_can_create():
        abort(403)
    row = rp_get_resource(resource_id)
    if not row:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(force=True, silent=True) or {}

    if request.method == "POST" or data.get("body_html") is not None:
        raw_html = str(data.get("body_html") or data.get("body") or "").strip()
        author_name = _directory_display_name(current_user)
        if not author_name:
            author_name = (
                getattr(current_user, "full_name", None) or getattr(current_user, "username", None) or "User"
            ).strip()
        try:
            row = append_resource_note(
                row,
                body_html=raw_html,
                actor_id=getattr(current_user, "id", None),
                author_name=author_name,
            )
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except Exception:
            db.session.rollback()
            return jsonify({"error": "could not post note"}), 500
        return jsonify({"resource": resource_to_api_dict(row)}), 201

    text = data.get("notes_text")
    if text is None and isinstance(data.get("notes"), list):
        row.notes = data["notes"]
        row.updated_by_id = getattr(current_user, "id", None)
        row.updated_at = utcnow()
        db.session.commit()
        return jsonify({"resource": resource_to_api_dict(row)})
    try:
        row = update_resource_notes_from_text(row, str(text or ""), actor_id=getattr(current_user, "id", None))
    except Exception:
        db.session.rollback()
        return jsonify({"error": "could not update notes"}), 500
    return jsonify({"resource": resource_to_api_dict(row)})


@bp.route("/api/resource-pool/resources/<int:resource_id>/cv", methods=["POST", "DELETE"])
@login_required
def resource_pool_cv_api(resource_id: int):
    row = rp_get_resource(resource_id)
    if not row:
        return jsonify({"error": "not found"}), 404
    if request.method == "DELETE":
        if not _workforce_can_create():
            abort(403)
        try:
            clear_resource_cv(row, actor_id=getattr(current_user, "id", None))
        except Exception:
            db.session.rollback()
            return jsonify({"error": "could not remove CV"}), 500
        return jsonify({"resource": resource_to_api_dict(row)})

    if not _workforce_can_create():
        abort(403)
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    orig = secure_filename(f.filename) or "cv.pdf"
    suf = Path(orig).suffix.lower()
    if suf not in (".pdf", ".docx"):
        return jsonify({"error": "PDF or Word (.docx) required"}), 400
    stored = f"{uuid4().hex}{suf}"
    mime = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        if suf == ".docx"
        else "application/pdf"
    )
    out_dir = cv_upload_dir(resource_id)
    old = row.cv_document if isinstance(row.cv_document, dict) else {}
    old_stored = str(old.get("stored") or "").strip()
    if old_stored:
        try:
            old_path = out_dir / old_stored
            if old_path.is_file():
                old_path.unlink()
        except Exception:
            pass
    f.save(out_dir / stored)
    try:
        row = set_resource_cv(
            row,
            original_name=orig,
            stored=stored,
            mime=mime,
            actor_id=getattr(current_user, "id", None),
        )
    except Exception:
        db.session.rollback()
        return jsonify({"error": "could not save CV"}), 500
    return jsonify({"resource": resource_to_api_dict(row)}), 201


@bp.route("/media/resource-pool/<int:resource_id>/<path:stored>", methods=["GET"])
@login_required
def media_resource_pool_cv(resource_id: int, stored: str):
    if not _workforce_can_read():
        abort(403)
    row = rp_get_resource(resource_id)
    if not row:
        abort(404)
    cv = row.cv_document if isinstance(row.cv_document, dict) else {}
    if str(cv.get("stored") or "").strip() != str(stored or "").strip():
        abort(404)
    path = resolve_cv_path(resource_id, stored)
    if not path:
        abort(404)
    return send_file(path, mimetype=cv.get("mime") or "application/pdf", conditional=True, max_age=0)




@bp.route("/crm/dashboard", methods=["GET"])
@login_required
def crm_dashboard_page():
    if not _crm_can_read():
        abort(403)
    q = (request.args.get("q") or "").strip()
    return render_template(
        "intranet_crm_dashboard.html",
        nav=_nav("crm"),
        q=q,
    )


@bp.route("/crm", methods=["GET"])
@login_required
def crm_page():
    if not _crm_can_read():
        abort(403)
    q = (request.args.get("q") or "").strip()
    return render_template(
        "intranet_crm.html",
        nav=_nav("crm"),
        q=q,
    )


def _crm_seed_if_empty() -> None:
    """No built-in CRM sample leads; create companies and leads from the CRM UI."""
    return


def _crm_lead_row(l: CRMLead) -> dict:
    try:
        created = l.created_at.astimezone().strftime("%b %d, %Y") if l.created_at else ""
    except Exception:
        created = ""
    owner_name = ""
    try:
        if l.owner:
            owner_name = l.owner.full_name or l.owner.username
    except Exception:
        owner_name = ""
    comp = ""
    try:
        comp = l.company.name if l.company else ""
    except Exception:
        comp = ""
    return {
        "id": l.id,
        "name": l.full_name,
        "email": l.email or "",
        "company": comp,
        "status": l.status or "New",
        "owner": owner_name or "",
        "source": l.source or "",
        "created": created,
        "score": int(l.score or 0),
    }


def _crm_lead_json(l: CRMLead) -> dict:
    d = _crm_lead_row(l)
    attrs = l.attributes if isinstance(l.attributes, dict) else {}
    comp = None
    try:
        if l.company:
            comp = {
                "id": l.company.id,
                "name": l.company.name,
                "website": l.company.website or "",
                "phone": l.company.phone or "",
                "email": l.company.email or "",
                "location": l.company.location or "",
                "attributes": (l.company.attributes or {}) if isinstance(l.company.attributes, dict) else {},
            }
    except Exception:
        comp = None

    contacts = []
    try:
        rows = l.contacts.order_by(CRMContact.is_primary.desc(), CRMContact.full_name.asc()).limit(200).all()
        for c in rows:
            contacts.append(
                {
                    "id": c.id,
                    "full_name": c.full_name,
                    "email": c.email or "",
                    "phone": c.phone or "",
                    "title": c.title or "",
                    "is_primary": bool(c.is_primary),
                }
            )
    except Exception:
        contacts = []

    files = []
    try:
        rawf = attrs.get("files")
        if isinstance(rawf, list):
            for it in rawf[:50]:
                if not isinstance(it, dict):
                    continue
                url = str(it.get("url") or "").strip()
                if not url:
                    continue
                files.append(
                    {
                        "url": url[:2000],
                        "name": str(it.get("name") or "")[:255],
                        "size": int(it.get("size") or 0) if str(it.get("size") or "").strip().isdigit() else 0,
                    }
                )
    except Exception:
        files = []
    d.update(
        {
            "phone": l.phone or "",
            "title": l.title or "",
            "location": l.location or "",
            "company_id": l.company_id,
            "owner_id": l.owner_id,
            "notes": l.notes or "",
            "company": comp,
            "contacts": contacts,
            "tags": attrs.get("tags") if isinstance(attrs.get("tags"), list) else [],
            "about": str(attrs.get("about") or ""),
            "budget": str(attrs.get("budget") or ""),
            "timeline": str(attrs.get("timeline") or ""),
            "files": files,
            "created_at": (l.created_at.isoformat().replace("+00:00", "Z") if l.created_at else ""),
            "updated_at": (l.updated_at.isoformat().replace("+00:00", "Z") if l.updated_at else ""),
        }
    )
    return d


@bp.route("/crm/leads", methods=["GET"])
@login_required
def crm_leads_page():
    if not _crm_can_read():
        abort(403)
    q = (request.args.get("q") or "").strip()
    _crm_seed_if_empty()
    qry = db.session.query(CRMLead)
    if q:
        like = f"%{q}%"
        qry = qry.filter(or_(CRMLead.full_name.ilike(like), CRMLead.email.ilike(like)))
    rows = qry.order_by(CRMLead.created_at.desc()).limit(200).all()
    return render_template(
        "intranet_crm_leads.html",
        nav=_nav("crm"),
        q=q,
        leads=[_crm_lead_row(r) for r in rows],
    )


@bp.route("/crm/leads/<int:lead_id>", methods=["GET"])
@login_required
def crm_lead_detail_page(lead_id: int):
    if not _crm_can_read():
        abort(403)
    q = (request.args.get("q") or "").strip()
    _crm_seed_if_empty()
    lead = db.session.get(CRMLead, int(lead_id))
    if not lead:
        lead = db.session.query(CRMLead).order_by(CRMLead.created_at.desc()).first()
    lead_json = _crm_lead_json(lead) if lead else {}
    return render_template(
        "intranet_crm_lead.html",
        nav=_nav("crm"),
        q=q,
        lead=lead,
        lead_json=lead_json,
    )


@bp.route("/crm/leads/<int:lead_id>/panel", methods=["GET"])
@login_required
def crm_lead_panel_page(lead_id: int):
    """Lightweight quick view for the leads table drawer (embed + inline)."""
    if not _crm_can_read():
        abort(403)
    q = (request.args.get("q") or "").strip()
    _crm_seed_if_empty()
    lead = db.session.get(CRMLead, int(lead_id))
    if not lead:
        abort(404)
    return render_template(
        "intranet_crm_lead_panel.html",
        nav=_nav("crm"),
        q=q,
        lead=lead,
    )


@bp.route("/crm/leads/new", methods=["GET"])
@login_required
def crm_lead_new_page():
    if not _crm_can_create():
        abort(403)
    q = (request.args.get("q") or "").strip()
    return render_template("intranet_crm_lead_form.html", nav=_nav("crm"), q=q, mode="new", lead=None)


@bp.route("/crm/leads/<int:lead_id>/edit", methods=["GET"])
@login_required
def crm_lead_edit_page(lead_id: int):
    if not _crm_can_create():
        abort(403)
    q = (request.args.get("q") or "").strip()
    lead = db.session.get(CRMLead, int(lead_id))
    return render_template("intranet_crm_lead_form.html", nav=_nav("crm"), q=q, mode="edit", lead=lead)


@bp.route("/api/crm/leads", methods=["GET", "POST"])
@login_required
def api_crm_leads():
    if request.method == "GET":
        if not _crm_can_read():
            return jsonify({"error": "forbidden"}), 403
        _crm_seed_if_empty()
        q = (request.args.get("q") or "").strip()
        status = (request.args.get("status") or "").strip()
        owner_id = request.args.get("owner_id")

        qry = db.session.query(CRMLead)
        if q:
            like = f"%{q}%"
            qry = qry.filter(or_(CRMLead.full_name.ilike(like), CRMLead.email.ilike(like)))
        if status:
            qry = qry.filter(CRMLead.status == status)
        if owner_id and str(owner_id).isdigit():
            qry = qry.filter(CRMLead.owner_id == int(owner_id))
        rows = qry.order_by(CRMLead.created_at.desc()).limit(500).all()
        return jsonify({"leads": [_crm_lead_row(r) for r in rows]})

    if not _crm_can_create():
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(silent=True) or {}
    full_name = str(payload.get("full_name") or "").strip()
    if not full_name:
        return jsonify({"error": "full_name required"}), 400

    company_name = str(payload.get("company_name") or "").strip()
    company = None
    if company_name:
        company = db.session.query(CRMCompany).filter(CRMCompany.name == company_name).first()
        if not company:
            company = CRMCompany(name=company_name, created_by_id=int(current_user.id))
            db.session.add(company)
            db.session.flush()

    notes_raw = str(payload.get("notes") or "").strip()
    lead = CRMLead(
        full_name=full_name,
        email=str(payload.get("email") or "").strip() or None,
        phone=str(payload.get("phone") or "").strip() or None,
        status=str(payload.get("status") or "New").strip() or "New",
        source=str(payload.get("source") or "").strip() or None,
        title=str(payload.get("title") or "").strip() or None,
        location=str(payload.get("location") or "").strip() or None,
        notes=notes_raw or None,
        company_id=(company.id if company else None),
        owner_id=int(current_user.id),
        created_by_id=int(current_user.id),
    )
    db.session.add(lead)
    db.session.commit()
    return jsonify({"lead": _crm_lead_json(lead)})


@bp.route("/api/crm/leads/<int:lead_id>", methods=["GET", "PATCH", "DELETE"])
@login_required
def api_crm_lead_one(lead_id: int):
    lead = db.session.get(CRMLead, int(lead_id))
    if not lead:
        return jsonify({"error": "not found"}), 404

    if request.method == "GET":
        if not _crm_can_read():
            return jsonify({"error": "forbidden"}), 403
        return jsonify({"lead": _crm_lead_json(lead)})

    if request.method == "DELETE":
        if not _crm_can_delete():
            return jsonify({"error": "forbidden"}), 403
        payload = request.get_json(force=True, silent=True) or {}
        j_err, justification = validate_deletion_justification(payload)
        if j_err:
            return jsonify({"error": j_err}), 400
        snap = {
            "full_name": (lead.full_name or "")[:255],
            "email": (lead.email or "")[:255],
            "company_id": lead.company_id,
        }
        lid = lead.id
        db.session.delete(lead)
        db.session.commit()
        audit_write(
            user_id=current_user.id,
            username=current_user.username,
            action="intranet.crm.lead.delete",
            resource_type="crm_lead",
            resource_id=str(lid),
            success=True,
            details={"justification": justification, **snap},
        )
        return jsonify({"ok": True})

    if not _crm_can_create():
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(silent=True) or {}
    if "full_name" in payload:
        nm = str(payload.get("full_name") or "").strip()
        if nm:
            lead.full_name = nm
    if "email" in payload:
        lead.email = str(payload.get("email") or "").strip() or None
    if "phone" in payload:
        lead.phone = str(payload.get("phone") or "").strip() or None
    if "status" in payload:
        lead.status = str(payload.get("status") or "New").strip() or "New"
    if "source" in payload:
        lead.source = str(payload.get("source") or "").strip() or None
    if "title" in payload:
        lead.title = str(payload.get("title") or "").strip() or None
    if "location" in payload:
        lead.location = str(payload.get("location") or "").strip() or None
    if "notes" in payload:
        n = str(payload.get("notes") or "").strip()
        lead.notes = n or None
    if "score" in payload:
        try:
            sraw = payload.get("score")
            sval = int(sraw) if sraw is not None and str(sraw).strip() != "" else 0
            lead.score = max(0, min(100, sval))
        except Exception:
            pass

    # Optional structured extras stored in attributes
    if "tags" in payload:
        raw = str(payload.get("tags") or "").strip()
        parts = [p.strip() for p in raw.split(",")] if raw else []
        tags = [p[:40] for p in parts if p][:25]
        attrs = dict(lead.attributes or {})
        attrs["tags"] = tags
        lead.attributes = attrs
    for k in ("budget", "timeline", "about"):
        if k in payload:
            v = str(payload.get(k) or "").strip()
            attrs = dict(lead.attributes or {})
            if v:
                attrs[k] = v[:400]
            else:
                attrs.pop(k, None)
            lead.attributes = attrs

    if "company_name" in payload:
        company_name = str(payload.get("company_name") or "").strip()
        if company_name:
            company = db.session.query(CRMCompany).filter(CRMCompany.name == company_name).first()
            if not company:
                company = CRMCompany(name=company_name, created_by_id=int(current_user.id))
                db.session.add(company)
                db.session.flush()
            lead.company_id = company.id
        else:
            lead.company_id = None

    # Company field updates (if the lead has a company after company_name handling).
    if any(k in payload for k in ("company_website", "company_phone", "company_email", "company_location")):
        if lead.company_id:
            co = db.session.get(CRMCompany, int(lead.company_id))
            if co:
                if "company_website" in payload:
                    co.website = str(payload.get("company_website") or "").strip()[:512] or None
                if "company_phone" in payload:
                    co.phone = str(payload.get("company_phone") or "").strip()[:64] or None
                if "company_email" in payload:
                    co.email = str(payload.get("company_email") or "").strip()[:255] or None
                if "company_location" in payload:
                    co.location = str(payload.get("company_location") or "").strip()[:255] or None
                db.session.add(co)

    # Contacts upsert (optional) from payload["contacts"] list
    contacts_payload = payload.get("contacts")
    if isinstance(contacts_payload, list):
        seen_ids: set[int] = set()
        make_primary_id: int | None = None
        for it in contacts_payload[:200]:
            if not isinstance(it, dict):
                continue
            cid_raw = it.get("id")
            cid = int(cid_raw) if cid_raw is not None and str(cid_raw).strip().isdigit() else None
            full_name = str(it.get("full_name") or "").strip()[:255]
            if not full_name:
                continue
            email = str(it.get("email") or "").strip()[:255] or None
            phone = str(it.get("phone") or "").strip()[:64] or None
            title = str(it.get("title") or "").strip()[:255] or None
            is_primary = bool(it.get("is_primary"))

            row = None
            if cid:
                row = db.session.get(CRMContact, int(cid))
                if row and row.lead_id != lead.id:
                    row = None
            if not row:
                row = CRMContact(
                    lead_id=lead.id,
                    company_id=lead.company_id,
                    created_by_id=int(current_user.id),
                )
            row.full_name = full_name
            row.email = email
            row.phone = phone
            row.title = title
            row.is_primary = is_primary
            if is_primary:
                make_primary_id = row.id if row.id else make_primary_id
            db.session.add(row)
            db.session.flush()
            seen_ids.add(int(row.id))

        # Ensure only one primary per lead (keep latest requested).
        if make_primary_id:
            db.session.query(CRMContact).filter(CRMContact.lead_id == lead.id, CRMContact.id != int(make_primary_id)).update(
                {"is_primary": False}
            )
        # Delete removed contacts (only those attached to this lead).
        existing_ids = db.session.query(CRMContact.id).filter(CRMContact.lead_id == lead.id).all()
        for (eid,) in existing_ids:
            if int(eid) not in seen_ids:
                row = db.session.get(CRMContact, int(eid))
                if row:
                    db.session.delete(row)

    # Lead attached files stored in attributes["files"]
    files_payload = payload.get("files")
    if isinstance(files_payload, list):
        out_files: list[dict] = []
        for it in files_payload[:50]:
            if not isinstance(it, dict):
                continue
            url = str(it.get("url") or "").strip()
            if not url:
                continue
            out_files.append(
                {
                    "url": url[:2000],
                    "name": str(it.get("name") or "")[:255],
                    "size": int(it.get("size") or 0) if str(it.get("size") or "").strip().isdigit() else 0,
                }
            )
        attrs = dict(lead.attributes or {})
        attrs["files"] = out_files
        lead.attributes = attrs

    db.session.add(lead)
    db.session.commit()
    return jsonify({"lead": _crm_lead_json(lead)})


def _crm_note_json(a: CRMActivity, viewer_id: int | None = None) -> dict:
    author = ""
    initials = "?"
    try:
        if a.created_by:
            author = (a.created_by.full_name or a.created_by.username or "").strip()
    except Exception:
        author = ""
    if author:
        parts = author.split()
        initials = (
            (parts[0][0] + parts[-1][0]).upper()
            if len(parts) >= 2
            else author[: min(2, len(author))].upper()
        )
    vid = viewer_id if viewer_id is not None else getattr(current_user, "id", None)
    atts = []
    try:
        attrs = a.attributes if isinstance(a.attributes, dict) else {}
        raw = attrs.get("attachments")
        if isinstance(raw, list):
            for it in raw[:20]:
                if not isinstance(it, dict):
                    continue
                url = str(it.get("url") or "").strip()
                if not url:
                    continue
                atts.append(
                    {
                        "url": url[:2000],
                        "name": str(it.get("name") or "")[:255],
                        "size": int(it.get("size") or 0) if str(it.get("size") or "").strip().isdigit() else 0,
                        "is_image": bool(it.get("is_image")),
                    }
                )
    except Exception:
        atts = []

    return {
        "id": a.id,
        "body": a.body or "",
        "title": (a.title or "") or None,
        "created_at": _iso_utc(a.created_at),
        "author": author,
        "author_initials": initials,
        "mine": bool(vid is not None and a.created_by_id == vid),
        "attachments": atts,
    }


@bp.route("/api/crm/leads/<int:lead_id>/notes", methods=["GET", "POST"])
@login_required
def api_crm_lead_notes(lead_id: int):
    lead = db.session.get(CRMLead, int(lead_id))
    if not lead:
        return jsonify({"error": "not found"}), 404
    viewer_id = int(current_user.id)

    if request.method == "GET":
        if not _crm_can_read():
            return jsonify({"error": "forbidden"}), 403
        rows = (
            db.session.query(CRMActivity)
            .filter(CRMActivity.lead_id == lead.id, CRMActivity.kind == "note")
            .order_by(CRMActivity.created_at.asc())
            .limit(500)
            .all()
        )
        return jsonify({"notes": [_crm_note_json(r, viewer_id) for r in rows]})

    if not _crm_can_create():
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body") or "").strip()
    attachments = payload.get("attachments")
    attachments = attachments if isinstance(attachments, list) else []
    if not body and not attachments:
        return jsonify({"error": "body required"}), 400
    title = str(payload.get("title") or "").strip()[:255] or None
    note = CRMActivity(
        kind="note",
        title=title,
        body=body[:8000],
        lead_id=lead.id,
        created_by_id=viewer_id,
    )
    if attachments:
        safe_atts: list[dict] = []
        for it in attachments[:20]:
            if not isinstance(it, dict):
                continue
            url = str(it.get("url") or "").strip()
            if not url:
                continue
            safe_atts.append(
                {
                    "url": url[:2000],
                    "name": str(it.get("name") or "")[:255],
                    "size": int(it.get("size") or 0) if str(it.get("size") or "").strip().isdigit() else 0,
                    "is_image": bool(it.get("is_image")),
                }
            )
        if safe_atts:
            note.attributes = {"attachments": safe_atts}
    db.session.add(note)
    db.session.commit()
    return jsonify({"note": _crm_note_json(note, viewer_id)})


from app.enterprise.resource_calculator_service import (
    build_rate_card_bootstrap,
    calculate_rate_card,
    calculate_rate_card_all_states,
)


@bp.route("/resource-calculator", methods=["GET"])
@login_required
def resource_calculator_page():
    if not _workforce_can_read():
        abort(403)
    payload = build_rate_card_bootstrap()
    return render_template(
        "intranet_resource_calculator.html",
        nav=_nav("resource_calculator"),
        rc_json=json.dumps(payload),
    )


@bp.route("/api/resource-calculator/calculate", methods=["POST"])
@login_required
def resource_calculator_calculate_api():
    if not _workforce_can_read():
        abort(403)
    payload = request.get_json(force=True, silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid payload"}), 400
    loaded_daily = float(payload.get("loaded_daily") or payload.get("daily_rate") or 0)
    work_state = str(payload.get("work_state") or "").strip().upper()
    is_contractor = bool(payload.get("is_contractor"))
    days_per_year = payload.get("days_per_year")
    include_pi_pl = bool(payload.get("include_pi_pl_for_employees"))
    cfg = build_rate_card_bootstrap()["settings"]
    settings = {
        "super_percent": cfg["super_percent"],
        "days_per_year": cfg["days_per_year"],
        "include_pi_pl_for_employees": include_pi_pl,
        "states": cfg["state_rates"],
    }
    if payload.get("all_states"):
        return jsonify(
            calculate_rate_card_all_states(
                loaded_daily=loaded_daily,
                is_contractor=is_contractor,
                days_per_year=days_per_year,
                settings=settings,
            )
        )
    return jsonify(
        calculate_rate_card(
            loaded_daily=loaded_daily,
            work_state=work_state,
            is_contractor=is_contractor,
            days_per_year=days_per_year,
            settings=settings,
        )
    )

