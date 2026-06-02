from __future__ import annotations

from typing import Any

from flask import Request, has_request_context

from app.extensions import db
from app.models import AuditLog, utcnow


def validate_deletion_justification(
    payload: dict | None,
    *,
    min_len: int = 10,
    max_len: int = 4000,
) -> tuple[str | None, str]:
    """Validate JSON payload ``justification`` for destructive actions.

    Returns ``(error_message_or_None, justification_text)``. On error, justification is ``""``.
    """
    data = payload if isinstance(payload, dict) else {}
    j = str(data.get("justification") or "").strip()
    if len(j) < min_len:
        return "Enter a justification of at least 10 characters.", ""
    if len(j) > max_len:
        j = j[:max_len]
    return None, j


def write_audit(
    *,
    user_id: int | None,
    username: str | None,
    action: str,
    resource_type: str | None = None,
    resource_id: str | None = None,
    success: bool = True,
    details: dict[str, Any] | None = None,
    request: Request | None = None,
) -> None:
    req = request
    if req is None and has_request_context():
        from flask import request as flask_request

        req = flask_request

    ip = None
    ua = None
    if req:
        ip = req.remote_addr or req.headers.get("X-Forwarded-For", "").split(",")[0].strip() or None
        ua = (req.headers.get("User-Agent") or "")[:512]

    row = AuditLog(
        timestamp=utcnow(),
        user_id=user_id,
        username_snapshot=username,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        ip_address=ip,
        user_agent=ua,
        success=success,
        details=details,
    )
    db.session.add(row)
    db.session.commit()
    try:
        from app.audit_syslog import forward_audit_event

        forward_audit_event(
            timestamp=row.timestamp,
            user_id=user_id,
            username=username,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            success=success,
            details=details,
            ip_address=ip,
            audit_id=row.id,
        )
    except Exception:
        if has_request_context():
            from flask import current_app

            current_app.logger.warning("audit syslog forward failed", exc_info=True)
