from __future__ import annotations

import json
import logging
import secrets
from io import BytesIO
from typing import Any

from flask import Blueprint, abort, current_app, jsonify, render_template, request
from flask_login import current_user, login_required
from itsdangerous import BadSignature, TimestampSigner

from app import access
from app.document_editor_settings import (
    PROVIDER_ONLYOFFICE,
    document_editor_close_url,
    get_document_editor_provider,
    redirect_with_query,
)
from app.extensions import db
from app.file_storage import store_stream_and_digest
from app.intranet_bp import _nav as intranet_nav
from app.models import FileNode, FileVersion, utcnow
from app.enterprise.office365_service import (
    create_office_link,
    delete_drive_item,
    download_drive_item,
    office365_settings_configured,
    upload_for_edit_session,
)

log = logging.getLogger(__name__)

bp = Blueprint("office365", __name__, url_prefix="/office365")


@bp.before_request
def _require_office365_premium():
    from app.enterprise.premium_license import FEATURE_OFFICE365, feature_enabled

    if not feature_enabled(FEATURE_OFFICE365):
        abort(404)


def _signer() -> TimestampSigner:
    secret = current_app.config.get("SECRET_KEY") or "office365"
    return TimestampSigner(str(secret))


def _session_token(payload: dict[str, Any]) -> str:
    return _signer().sign(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("utf-8")


def _unsign_session_token(token: str, *, max_age_s: int = 60 * 60 * 8) -> dict[str, Any] | None:
    try:
        raw = _signer().unsign(token.encode("utf-8"), max_age=max_age_s)
    except BadSignature:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def _node_or_404(node_id: int) -> FileNode:
    node = db.session.get(FileNode, node_id)
    if not node or node.deleted_at is not None:
        abort(404)
    return node


def _apply_graph_bytes_to_version(*, node: FileNode, fv: FileVersion, data: bytes, mime: str | None) -> bool:
    stream = BytesIO(data)
    relpath, size, sha256 = store_stream_and_digest(stream)
    fv.storage_relpath = relpath
    fv.size_bytes = size
    fv.sha256 = sha256
    if mime:
        fv.mime_type = mime
    fv.is_current = True
    db.session.query(FileVersion).filter(
        FileVersion.file_node_id == node.id,
        FileVersion.id != fv.id,
    ).update({"is_current": False}, synchronize_session=False)
    node.updated_at = utcnow()
    db.session.commit()
    return True


@bp.route("/editor/<int:node_id>")
@login_required
def editor(node_id: int):
    if get_document_editor_provider() == PROVIDER_ONLYOFFICE:
        return redirect_with_query("onlyoffice.editor", node_id=node_id)

    if not office365_settings_configured():
        abort(404)

    node = _node_or_404(node_id)
    if node.is_folder:
        abort(400)
    ok, _ = access.can_access_node(current_user, node, "read")
    if not ok:
        abort(403)
    can_edit, _ = access.can_access_node(current_user, node, "write")

    cur = (
        db.session.query(FileVersion)
        .filter_by(file_node_id=node.id, is_current=True)
        .order_by(FileVersion.version_number.desc())
        .first()
    )
    if not cur:
        abort(404)

    from app.file_storage import absolute_path

    file_bytes = absolute_path(cur.storage_relpath).read_bytes()
    session_key = f"nc{node.id}v{cur.id}{secrets.token_hex(4)}"
    try:
        uploaded = upload_for_edit_session(
            filename=node.name,
            content=file_bytes,
            session_key=session_key,
            mime_type=cur.mime_type,
        )
        force_view = (request.args.get("view") or "").strip().lower() in ("1", "true", "yes", "view")
        edit_mode = bool(can_edit) and not force_view
        edit_url = create_office_link(
            drive_id=uploaded["drive_id"],
            item_id=uploaded["item_id"],
            edit=edit_mode,
        )
    except Exception as e:
        log.exception("office365 editor setup failed node_id=%s", node_id)
        abort(502, description=str(e))

    sync_token = _session_token(
        {
            "node_id": node.id,
            "user_id": current_user.id,
            "version_id": cur.id,
            "drive_id": uploaded["drive_id"],
            "item_id": uploaded["item_id"],
            "can_edit": bool(can_edit),
        }
    )

    shell = (request.args.get("shell") or "").strip().lower()
    embed = (request.args.get("embed") or "").strip().lower() in ("1", "true", "yes")
    close_url = document_editor_close_url(shell=shell, node=node)
    ctx = {
        "doc_title": node.name,
        "edit_url": edit_url,
        "close_url": close_url,
        "sync_url": f"/office365/sync/{node.id}",
        "sync_token": sync_token,
        "can_sync": bool(can_edit and not force_view),
    }
    if embed:
        return render_template("office365_embed.html", **ctx)
    if shell == "intranet":
        ctx["nav"] = intranet_nav("documents")
        ctx["q"] = (request.args.get("q") or "").strip()
        return render_template("office365_editor_intranet.html", **ctx)
    return render_template("office365_editor.html", **ctx)


@bp.route("/sync/<int:node_id>", methods=["POST"])
@login_required
def sync(node_id: int):
    if not office365_settings_configured():
        return jsonify({"ok": False, "error": "Office 365 not configured"}), 404

    payload = request.get_json(force=True, silent=True) or {}
    token = (payload.get("token") or request.args.get("token") or "").strip()
    session = _unsign_session_token(token)
    if not session or int(session.get("node_id") or 0) != node_id:
        return jsonify({"ok": False, "error": "Invalid or expired session"}), 403
    if int(session.get("user_id") or 0) != current_user.id:
        return jsonify({"ok": False, "error": "Forbidden"}), 403

    node = _node_or_404(node_id)
    can_edit, _ = access.can_access_node(current_user, node, "write")
    if not can_edit or not session.get("can_edit"):
        return jsonify({"ok": True, "skipped": True})

    version_id = int(session.get("version_id") or 0)
    fv = db.session.get(FileVersion, version_id) if version_id else None
    if not fv or fv.file_node_id != node.id:
        return jsonify({"ok": False, "error": "File version not found"}), 404

    drive_id = str(session.get("drive_id") or "")
    item_id = str(session.get("item_id") or "")
    if not drive_id or not item_id:
        return jsonify({"ok": False, "error": "Missing drive item"}), 400

    try:
        data = download_drive_item(drive_id=drive_id, item_id=item_id)
        ok = _apply_graph_bytes_to_version(node=node, fv=fv, data=data, mime=fv.mime_type)
    except Exception as e:
        log.exception("office365 sync failed node_id=%s", node_id)
        return jsonify({"ok": False, "error": str(e)}), 502
    finally:
        try:
            delete_drive_item(drive_id=drive_id, item_id=item_id)
        except Exception:
            log.warning("office365 staging cleanup failed node_id=%s item_id=%s", node_id, item_id)

    return jsonify({"ok": bool(ok)})
