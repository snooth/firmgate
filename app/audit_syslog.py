"""Forward audit / activity log events to a remote syslog collector (RFC 5424)."""

from __future__ import annotations

import json
import socket
from datetime import datetime, timezone
from typing import Any

from flask import current_app

from app.settings import get_setting, set_setting

SETTING_KEY = "audit_syslog"
DEFAULT_APP_NAME = "firmgate"
DEFAULT_PORT = 514
DEFAULT_FACILITY = 16  # local0
DEFAULT_PROTOCOL = "udp"

FACILITY_CHOICES = {
    "kern": 0,
    "user": 1,
    "mail": 2,
    "daemon": 3,
    "auth": 4,
    "syslog": 5,
    "lpr": 6,
    "news": 7,
    "uucp": 8,
    "cron": 9,
    "authpriv": 10,
    "ftp": 11,
    "local0": 16,
    "local1": 17,
    "local2": 18,
    "local3": 19,
    "local4": 20,
    "local5": 21,
    "local6": 22,
    "local7": 23,
}


def _hostname() -> str:
    try:
        return socket.gethostname() or "intranet"
    except OSError:
        return "intranet"


def normalize_syslog_settings(raw: Any) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    protocol = str(data.get("protocol") or DEFAULT_PROTOCOL).strip().lower()
    if protocol not in ("udp", "tcp"):
        protocol = DEFAULT_PROTOCOL
    facility_raw = data.get("facility")
    if isinstance(facility_raw, str):
        facility = FACILITY_CHOICES.get(facility_raw.strip().lower(), DEFAULT_FACILITY)
    else:
        try:
            facility = int(facility_raw)
        except (TypeError, ValueError):
            facility = DEFAULT_FACILITY
    facility = max(0, min(facility, 23))
    try:
        port = int(data.get("port") or DEFAULT_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    port = max(1, min(port, 65535))
    host = str(data.get("host") or "").strip()
    return {
        "enabled": bool(data.get("enabled")),
        "host": host[:255],
        "port": port,
        "protocol": protocol,
        "facility": facility,
        "app_name": (str(data.get("app_name") or DEFAULT_APP_NAME).strip() or DEFAULT_APP_NAME)[:48],
        "hostname": (str(data.get("hostname") or "").strip() or _hostname())[:255],
    }


def get_syslog_settings() -> dict[str, Any]:
    return normalize_syslog_settings(get_setting(SETTING_KEY, default={}))


def save_syslog_settings(payload: dict | None) -> dict[str, Any] | tuple[dict, int]:
    data = payload if isinstance(payload, dict) else {}
    cfg = normalize_syslog_settings(data)
    if cfg["enabled"] and not cfg["host"]:
        return {"error": "Syslog host is required when forwarding is enabled."}, 400
    set_setting(SETTING_KEY, cfg)
    return syslog_settings_for_api(cfg)


def syslog_settings_for_api(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg or get_syslog_settings()
    facility = int(cfg.get("facility") or DEFAULT_FACILITY)
    facility_name = next((k for k, v in FACILITY_CHOICES.items() if v == facility), "local0")
    return {
        "enabled": bool(cfg.get("enabled")),
        "host": cfg.get("host") or "",
        "port": int(cfg.get("port") or DEFAULT_PORT),
        "protocol": cfg.get("protocol") or DEFAULT_PROTOCOL,
        "facility": facility_name,
        "app_name": cfg.get("app_name") or DEFAULT_APP_NAME,
        "hostname": cfg.get("hostname") or _hostname(),
    }


def _severity(success: bool) -> int:
    return 6 if success else 4  # info vs warning


def _priority(facility: int, severity: int) -> int:
    return facility * 8 + severity


def _format_rfc5424_timestamp(ts: datetime | None) -> str:
    if ts is None:
        ts = datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    else:
        ts = ts.astimezone(timezone.utc)
    return ts.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _sanitize_msg(text: str, max_len: int = 32000) -> str:
    s = str(text or "")
    s = s.replace("\r", " ").replace("\n", " ")
    if len(s) > max_len:
        s = s[: max_len - 3] + "..."
    return s


def build_syslog_message(
    *,
    timestamp: datetime | None,
    action: str,
    username: str | None,
    user_id: int | None,
    resource_type: str | None,
    resource_id: str | None,
    ip_address: str | None,
    success: bool,
    details: dict[str, Any] | None,
    audit_id: int | None = None,
    cfg: dict[str, Any] | None = None,
) -> bytes:
    cfg = cfg or get_syslog_settings()
    payload = {
        "audit_id": audit_id,
        "action": action,
        "username": username,
        "user_id": user_id,
        "resource_type": resource_type,
        "resource_id": resource_id,
        "ip_address": ip_address,
        "success": success,
        "details": details if isinstance(details, dict) else None,
    }
    try:
        msg_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        msg_body = _sanitize_msg(str(payload))
    facility = int(cfg.get("facility") or DEFAULT_FACILITY)
    sev = _severity(success)
    pri = _priority(facility, sev)
    ts = _format_rfc5424_timestamp(timestamp)
    hostname = cfg.get("hostname") or _hostname()
    app_name = cfg.get("app_name") or DEFAULT_APP_NAME
    line = (
        f"<{pri}>1 {ts} {hostname} {app_name} - - - "
        f"{_sanitize_msg(msg_body)}"
    )
    return line.encode("utf-8", errors="replace")


def send_syslog_message(message: bytes, cfg: dict[str, Any] | None = None) -> tuple[bool, str]:
    cfg = cfg or get_syslog_settings()
    if not cfg.get("enabled"):
        return False, "Syslog forwarding is disabled."
    host = str(cfg.get("host") or "").strip()
    if not host:
        return False, "Syslog host is not configured."
    port = int(cfg.get("port") or DEFAULT_PORT)
    protocol = str(cfg.get("protocol") or DEFAULT_PROTOCOL).lower()
    timeout = 5.0
    try:
        if protocol == "tcp":
            with socket.create_connection((host, port), timeout=timeout) as sock:
                sock.sendall(message + b"\n")
        else:
            data = message
            if len(data) > 900:
                data = data[:897] + b"..."
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(timeout)
                sock.sendto(data, (host, port))
        return True, "Sent."
    except OSError as e:
        return False, str(e)


def forward_audit_event(
    *,
    timestamp: datetime | None,
    user_id: int | None,
    username: str | None,
    action: str,
    resource_type: str | None = None,
    resource_id: str | None = None,
    success: bool = True,
    details: dict[str, Any] | None = None,
    ip_address: str | None = None,
    audit_id: int | None = None,
) -> None:
    """Best-effort syslog emit; never raises."""
    cfg = get_syslog_settings()
    if not cfg.get("enabled"):
        return
    try:
        msg = build_syslog_message(
            timestamp=timestamp,
            action=action,
            username=username,
            user_id=user_id,
            resource_type=resource_type,
            resource_id=resource_id,
            ip_address=ip_address,
            success=success,
            details=details,
            audit_id=audit_id,
            cfg=cfg,
        )
        ok, err = send_syslog_message(msg, cfg)
        if not ok and current_app:
            current_app.logger.warning("audit syslog: %s", err)
    except Exception:
        if current_app:
            current_app.logger.warning("audit syslog forward failed", exc_info=True)


def forward_audit_row(row: Any, cfg: dict[str, Any] | None = None) -> tuple[bool, str]:
    """Send one AuditLog ORM row to syslog."""
    cfg = cfg or get_syslog_settings()
    if not cfg.get("enabled"):
        return False, "Syslog forwarding is disabled."
    msg = build_syslog_message(
        timestamp=getattr(row, "timestamp", None),
        action=str(getattr(row, "action", "") or ""),
        username=getattr(row, "username_snapshot", None),
        user_id=getattr(row, "user_id", None),
        resource_type=getattr(row, "resource_type", None),
        resource_id=getattr(row, "resource_id", None),
        ip_address=getattr(row, "ip_address", None),
        success=bool(getattr(row, "success", True)),
        details=getattr(row, "details", None),
        audit_id=getattr(row, "id", None),
        cfg=cfg,
    )
    return send_syslog_message(msg, cfg)


def replay_all_audit_logs_to_syslog(*, max_rows: int = 50000) -> tuple[int, int, str | None]:
    """Send stored audit rows to syslog (oldest first). Returns (sent, failed, error)."""
    from app.models import AuditLog

    cfg = get_syslog_settings()
    if not cfg.get("enabled"):
        return 0, 0, "Enable syslog forwarding before replay."
    if not cfg.get("host"):
        return 0, 0, "Syslog host is not configured."

    max_rows = max(1, min(int(max_rows), 50000))
    sent = failed = 0
    q = AuditLog.query.order_by(AuditLog.timestamp.asc(), AuditLog.id.asc()).limit(max_rows)
    for row in q.yield_per(200):
        ok, _ = forward_audit_row(row, cfg)
        if ok:
            sent += 1
        else:
            failed += 1
    if failed and not sent:
        return sent, failed, "Could not deliver any events to the syslog endpoint."
    return sent, failed, None


def send_test_syslog_message() -> tuple[bool, str]:
    cfg = get_syslog_settings()
    if not cfg.get("enabled"):
        return False, "Enable syslog forwarding first."
    msg = build_syslog_message(
        timestamp=datetime.now(timezone.utc),
        action="admin.audit_syslog.test",
        username=None,
        user_id=None,
        resource_type="setting",
        resource_id="audit_syslog",
        ip_address=None,
        success=True,
        details={"message": "Firmgate activity syslog test"},
        cfg=cfg,
    )
    return send_syslog_message(msg, cfg)
