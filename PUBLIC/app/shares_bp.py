from __future__ import annotations

from datetime import timedelta

from flask import Blueprint, abort, jsonify, redirect, render_template, request, send_file, session, url_for
from flask_login import current_user, login_required
from werkzeug.security import check_password_hash, generate_password_hash

from app import access
from app.audit_service import write_audit
from app.extensions import db
from app.file_storage import absolute_path
from app.models import FileNode, FileShare, FileVersion, utcnow

bp = Blueprint("shares", __name__)


def _share_session_key(token: str) -> str:
    return f"share_unlock_{token}"


def _get_share(token: str) -> FileShare | None:
    return FileShare.query.filter_by(token=token).first()


def _share_covers_node(root: FileNode, node: FileNode) -> bool:
    p: FileNode | None = node
    while p:
        if p.id == root.id:
            return True
        p = p.parent
    return False


@bp.route("/shares/api", methods=["POST"])
@login_required
def create_share():
    payload = request.get_json(force=True, silent=True) or {}
    node_id = payload.get("file_node_id")
    if node_id is None:
        return jsonify({"error": "file_node_id required"}), 400
    node = db.session.get(FileNode, int(node_id))
    if not node:
        abort(404)
    ok, reason = access.can_access_node(current_user, node, "share")
    if not ok:
        write_audit(
            user_id=current_user.id,
            username=current_user.username,
            action="share.create.denied",
            resource_type="file",
            resource_id=str(node.id),
            success=False,
            details={"reason": reason},
        )
        return jsonify({"error": "forbidden", "reason": reason}), 403

    perm = (payload.get("permission") or "read").lower()
    if perm not in ("read", "write"):
        return jsonify({"error": "invalid permission"}), 400
    expires_hours = payload.get("expires_hours")
    expires_at = None
    if expires_hours is not None:
        try:
            expires_at = utcnow() + timedelta(hours=float(expires_hours))
        except (TypeError, ValueError):
            return jsonify({"error": "invalid expires_hours"}), 400

    raw_pw = payload.get("password") or None
    pw_hash = generate_password_hash(raw_pw) if raw_pw else None

    import secrets

    sh = FileShare(
        token=secrets.token_urlsafe(24),
        file_node_id=node.id,
        created_by_id=current_user.id,
        permission=perm,
        expires_at=expires_at,
        password_hash=pw_hash,
        max_downloads=payload.get("max_downloads"),
    )
    db.session.add(sh)
    db.session.commit()

    write_audit(
        user_id=current_user.id,
        username=current_user.username,
        action="share.create",
        resource_type="share",
        resource_id=str(sh.id),
        details={"file_node_id": node.id, "permission": perm},
    )
    url = url_for("shares.public_share", token=sh.token, _external=True)
    return jsonify({"token": sh.token, "url": url, "permission": perm, "expires_at": expires_at.isoformat() if expires_at else None})


@bp.route("/public/shares/<token>", methods=["GET", "POST"])
def public_share(token: str):
    sh = _get_share(token)
    if not sh:
        abort(404)

    now = utcnow()
    if sh.expires_at and sh.expires_at < now:
        return render_template("share_error.html", reason="expired"), 403
    if sh.max_downloads is not None and sh.download_count >= sh.max_downloads:
        return render_template("share_error.html", reason="download limit reached"), 403

    unlocked = bool(session.get(_share_session_key(token)))
    if sh.password_hash and not unlocked:
        password = None
        if request.method == "POST":
            password = (request.form.get("password") or "").strip() or None
        if password and check_password_hash(sh.password_hash, password):
            session[_share_session_key(token)] = True
            unlocked = True
        else:
            err = None if request.method == "GET" else "invalid password"
            return render_template("share_unlock.html", token=token, error=err), 401

    root = sh.file_node
    parent = root
    if root.is_folder:
        parent_id = request.args.get("parent_id", type=int)
        if parent_id is not None:
            cand = db.session.get(FileNode, parent_id)
            if not cand or not cand.is_folder or not _share_covers_node(root, cand):
                abort(404)
            parent = cand
        children = parent.children.order_by(FileNode.is_folder.desc(), FileNode.name).all()
        items = [{"id": c.id, "name": c.name, "is_folder": c.is_folder} for c in children]
    else:
        items = [{"id": root.id, "name": root.name, "is_folder": False}]

    write_audit(
        user_id=None,
        username="anonymous",
        action="share.access",
        resource_type="share",
        resource_id=str(sh.id),
        details={"token_prefix": token[:8]},
    )
    return render_template(
        "public_share.html",
        token=token,
        root=root,
        parent=parent if root.is_folder else root,
        items=items,
        permission=sh.permission,
    )


@bp.route("/public/shares/<token>/download/<int:node_id>", methods=["GET"])
def public_download(token: str, node_id: int):
    sh = _get_share(token)
    if not sh:
        abort(404)
    now = utcnow()
    if sh.expires_at and sh.expires_at < now:
        abort(403)
    if sh.max_downloads is not None and sh.download_count >= sh.max_downloads:
        abort(403)
    if sh.password_hash and not session.get(_share_session_key(token)):
        abort(403)

    node = db.session.get(FileNode, node_id)
    if not node or node.is_folder:
        abort(404)
    root = sh.file_node
    if not _share_covers_node(root, node):
        abort(404)

    ver = (
        db.session.query(FileVersion)
        .filter_by(file_node_id=node.id, is_current=True)
        .order_by(FileVersion.version_number.desc())
        .first()
    )
    if not ver:
        abort(404)

    sh.download_count += 1
    db.session.commit()

    write_audit(
        user_id=None,
        username="anonymous",
        action="share.download",
        resource_type="file",
        resource_id=str(node.id),
        details={"share_id": sh.id},
    )
    path = absolute_path(ver.storage_relpath)
    return send_file(path, as_attachment=True, download_name=node.name)


@bp.route("/public/shares/<token>/browse", methods=["GET"])
def public_browse(token: str):
    sh = _get_share(token)
    if not sh:
        abort(404)
    now = utcnow()
    if sh.expires_at and sh.expires_at < now:
        return jsonify({"error": "expired"}), 403
    if sh.max_downloads is not None and sh.download_count >= sh.max_downloads:
        return jsonify({"error": "download limit"}), 403
    if sh.password_hash and not session.get(_share_session_key(token)):
        return jsonify({"error": "password required"}), 403
    parent_id = request.args.get("parent_id", type=int)
    root = sh.file_node
    if not root.is_folder:
        return jsonify({"error": "not a folder share"}), 400
    if parent_id is None:
        parent = root
    else:
        parent = db.session.get(FileNode, parent_id)
        if not parent or not parent.is_folder or not _share_covers_node(root, parent):
            abort(404)
    children = parent.children.order_by(FileNode.is_folder.desc(), FileNode.name).all()
    return jsonify(
        {
            "parent": {"id": parent.id, "name": parent.name},
            "items": [{"id": c.id, "name": c.name, "is_folder": c.is_folder} for c in children],
        }
    )
