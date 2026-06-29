from flask import Blueprint, abort, jsonify, render_template, request
from flask_login import current_user, login_required

from app import rbac
from app.extensions import db
from app.models import AuditLog
from sqlalchemy import String, or_

bp = Blueprint("audit", __name__, url_prefix="/audit")


@bp.route("/")
@login_required
def audit_page():
    if not rbac.user_has_permission(current_user, rbac.PERMISSION_AUDIT_READ):
        abort(403)
    return render_template("audit_log.html")


@bp.route("/api", methods=["GET"])
@login_required
def audit_api():
    if not rbac.user_has_permission(current_user, rbac.PERMISSION_AUDIT_READ):
        return jsonify({"error": "forbidden"}), 403
    page = request.args.get("page", default=1, type=int)
    per_page = min(request.args.get("per_page", default=10, type=int), 200)
    search = (request.args.get("q") or "").strip()
    user = (request.args.get("user") or "").strip()
    action = (request.args.get("action") or "").strip()
    sort = (request.args.get("sort") or "newest").strip().lower()
    ok = request.args.get("ok")

    q = db.session.query(AuditLog)
    if search:
        like = f"%{search}%"
        q = q.filter(
            or_(
                AuditLog.action.ilike(like),
                AuditLog.resource_type.ilike(like),
                AuditLog.resource_id.ilike(like),
                AuditLog.username_snapshot.ilike(like),
                AuditLog.ip_address.ilike(like),
            )
        )
    if user:
        like = f"%{user}%"
        q = q.filter(or_(AuditLog.username_snapshot.ilike(like), AuditLog.user_id.cast(String).ilike(like)))
    if action:
        q = q.filter(AuditLog.action == action)
    if ok in ("true", "false"):
        q = q.filter(AuditLog.success.is_(ok == "true"))

    if sort in ("oldest", "asc"):
        q = q.order_by(AuditLog.timestamp.asc())
    else:
        q = q.order_by(AuditLog.timestamp.desc())
    total = q.count()
    rows = q.offset((page - 1) * per_page).limit(per_page).all()
    return jsonify(
        {
            "total": total,
            "page": page,
            "per_page": per_page,
            "items": [
                {
                    "id": r.id,
                    "timestamp": r.timestamp.isoformat(),
                    "user_id": r.user_id,
                    "username": r.username_snapshot,
                    "action": r.action,
                    "resource_type": r.resource_type,
                    "resource_id": r.resource_id,
                    "ip_address": r.ip_address,
                    "success": r.success,
                    "details": r.details,
                }
                for r in rows
            ],
        }
    )
