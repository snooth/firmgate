"""SIP / WebRTC phone client — global server settings and per-user credentials."""

from __future__ import annotations

from typing import Any

from flask_login import current_user

from app.settings import get_setting, set_setting

SETTING_SIP = "sip_client"
SETTING_USER_CREDS = "sip_user_credentials"

_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "sip_domain": "",
    "sip_server_host": "",
    "sip_server_port": 5060,
    "websocket_uri": "",
    "outbound_proxy": "",
    "registration_expires": 300,
    "stun_server": "stun:stun.l.google.com:19302",
    "use_session_timers": True,
    "dtmf_mode": "info",
    "allow_insecure_websocket": False,
}


def _coerce_settings(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return dict(_DEFAULTS)
    out = dict(_DEFAULTS)
    out.update(raw)
    try:
        out["sip_server_port"] = max(1, min(int(out.get("sip_server_port") or 5060), 65535))
    except (TypeError, ValueError):
        out["sip_server_port"] = 5060
    try:
        out["registration_expires"] = max(60, min(int(out.get("registration_expires") or 300), 86400))
    except (TypeError, ValueError):
        out["registration_expires"] = 300
    out["enabled"] = bool(out.get("enabled"))
    out["use_session_timers"] = bool(out.get("use_session_timers", True))
    out["allow_insecure_websocket"] = bool(out.get("allow_insecure_websocket"))
    for key in (
        "sip_domain",
        "sip_server_host",
        "websocket_uri",
        "outbound_proxy",
        "stun_server",
        "dtmf_mode",
    ):
        out[key] = str(out.get(key) or "").strip()
    if out["dtmf_mode"] not in ("info", "rtp"):
        out["dtmf_mode"] = "info"
    return out


def get_sip_settings() -> dict[str, Any]:
    return _coerce_settings(get_setting(SETTING_SIP, default={}))


def sip_configured() -> bool:
    cfg = get_sip_settings()
    if not cfg.get("enabled"):
        return False
    # Only the server address is required — the WebSocket URI is derived from it
    # when not explicitly provided.
    return bool(cfg.get("sip_server_host") or cfg.get("sip_domain"))


def derive_websocket_uri(cfg: dict[str, Any], *, secure: bool = True) -> str:
    """Return the explicit WebSocket URI, or derive a sensible default from the host.

    Asterisk/FreePBX/Grandstream UCM expose the WebSocket transport on
    ``wss://host:8089/ws`` (TLS) by default; the plain ``ws://host:8088/ws``
    transport is usually disabled. We therefore default to the secure 8089
    endpoint, which a browser can use even from a plain-HTTP page. Only fall
    back to plain ``ws`` when the admin has explicitly allowed insecure
    WebSockets (e.g. a dev PBX with port 8088 enabled and no TLS).
    """
    explicit = (cfg.get("websocket_uri") or "").strip()
    if explicit:
        return explicit
    host = (cfg.get("sip_server_host") or cfg.get("sip_domain") or "").strip()
    if not host:
        return ""
    return f"wss://{host}:8089/ws"


def sip_settings_for_api() -> dict[str, Any]:
    cfg = get_sip_settings()
    return {
        "enabled": bool(cfg.get("enabled")),
        "sip_domain": cfg.get("sip_domain") or "",
        "sip_server_host": cfg.get("sip_server_host") or "",
        "sip_server_port": cfg.get("sip_server_port"),
        "websocket_uri": cfg.get("websocket_uri") or "",
        "outbound_proxy": cfg.get("outbound_proxy") or "",
        "registration_expires": cfg.get("registration_expires"),
        "stun_server": cfg.get("stun_server") or "",
        "use_session_timers": bool(cfg.get("use_session_timers")),
        "dtmf_mode": cfg.get("dtmf_mode") or "info",
        "allow_insecure_websocket": bool(cfg.get("allow_insecure_websocket")),
        "configured": sip_configured(),
    }


def save_sip_settings(payload: dict[str, Any]) -> dict[str, Any] | tuple[dict[str, str], int]:
    existing = get_sip_settings()
    enabled = bool(payload.get("enabled")) if "enabled" in payload else bool(existing.get("enabled"))
    sip_server_host = (payload.get("sip_server_host") or existing.get("sip_server_host") or "").strip()
    sip_domain = (payload.get("sip_domain") or existing.get("sip_domain") or "").strip()
    websocket_uri = (payload.get("websocket_uri") or existing.get("websocket_uri") or "").strip()

    # The address is the only thing we truly need. Treat host and domain as
    # interchangeable so the admin can fill in just one of them.
    if not sip_server_host and sip_domain:
        sip_server_host = sip_domain
    if not sip_domain and sip_server_host:
        sip_domain = sip_server_host

    if enabled and not (sip_server_host or sip_domain):
        return {"error": "Enter the SIP server address (e.g. pbx.example.com or pbx.local)."}, 400

    if websocket_uri and not websocket_uri.lower().startswith(("ws://", "wss://")):
        return {"error": "WebSocket URI must start with ws:// or wss://"}, 400

    allow_insecure = bool(payload.get("allow_insecure_websocket"))

    try:
        sip_server_port = int(payload.get("sip_server_port") or existing.get("sip_server_port") or 5060)
    except (TypeError, ValueError):
        return {"error": "sip_server_port must be a number"}, 400
    if sip_server_port < 1 or sip_server_port > 65535:
        return {"error": "sip_server_port must be between 1 and 65535"}, 400

    try:
        registration_expires = int(
            payload.get("registration_expires") or existing.get("registration_expires") or 300
        )
    except (TypeError, ValueError):
        return {"error": "registration_expires must be a number"}, 400

    dtmf_mode = str(payload.get("dtmf_mode") or existing.get("dtmf_mode") or "info").strip().lower()
    if dtmf_mode not in ("info", "rtp"):
        dtmf_mode = "info"

    merged = {
        **existing,
        "enabled": enabled,
        "sip_domain": sip_domain,
        "sip_server_host": sip_server_host,
        "sip_server_port": sip_server_port,
        "websocket_uri": websocket_uri,
        "outbound_proxy": (payload.get("outbound_proxy") or existing.get("outbound_proxy") or "").strip(),
        "registration_expires": max(60, min(registration_expires, 86400)),
        "stun_server": (payload.get("stun_server") or existing.get("stun_server") or "").strip(),
        "use_session_timers": bool(payload.get("use_session_timers"))
        if "use_session_timers" in payload
        else bool(existing.get("use_session_timers", True)),
        "dtmf_mode": dtmf_mode,
        "allow_insecure_websocket": allow_insecure
        if "allow_insecure_websocket" in payload
        else bool(existing.get("allow_insecure_websocket")),
    }
    set_setting(SETTING_SIP, merged)
    return sip_settings_for_api()


def _user_creds_store() -> dict[str, Any]:
    raw = get_setting(SETTING_USER_CREDS, default={}) or {}
    return raw if isinstance(raw, dict) else {}


def _user_key(user_id: int) -> str:
    return str(int(user_id))


def get_user_sip_credentials(user_id: int) -> dict[str, Any]:
    row = _user_creds_store().get(_user_key(user_id))
    if not isinstance(row, dict):
        return {}
    return {
        "extension": str(row.get("extension") or "").strip(),
        "password": str(row.get("password") or "").strip(),
        "display_name": str(row.get("display_name") or "").strip(),
        "stay_registered": bool(row.get("stay_registered")),
    }


def set_user_stay_registered(user_id: int, enabled: bool) -> None:
    store = _user_creds_store()
    key = _user_key(user_id)
    row = store.get(key)
    if not isinstance(row, dict):
        return
    row["stay_registered"] = bool(enabled)
    store[key] = row
    set_setting(SETTING_USER_CREDS, store)


def save_user_sip_credentials(user_id: int, payload: dict[str, Any]) -> dict[str, Any] | tuple[dict[str, str], int]:
    extension = str(payload.get("extension") or "").strip()
    password_in = payload.get("password")
    display_name = str(payload.get("display_name") or "").strip()

    existing = get_user_sip_credentials(user_id)
    if isinstance(password_in, str) and password_in.strip() != "":
        password = password_in.strip()
    else:
        password = existing.get("password") or ""

    if not extension:
        return {"error": "Extension is required."}, 400
    if not password:
        return {"error": "SIP password is required."}, 400
    if len(extension) > 64 or len(password) > 128:
        return {"error": "Extension or password is too long."}, 400

    store = _user_creds_store()
    store[_user_key(user_id)] = {
        "extension": extension,
        "password": password,
        "display_name": display_name[:120],
    }
    set_setting(SETTING_USER_CREDS, store)
    return user_sip_status(user_id)


def user_sip_status(user_id: int) -> dict[str, Any]:
    cfg = sip_settings_for_api()
    creds = get_user_sip_credentials(user_id)
    ext = creds.get("extension") or ""
    return {
        **cfg,
        "credentials_set": bool(ext and creds.get("password")),
        "extension": ext,
        "display_name": creds.get("display_name") or "",
        "password_set": bool(creds.get("password")),
        "stay_registered": bool(creds.get("stay_registered")),
    }


def user_sip_registration_config(
    user_id: int, *, default_display_name: str = "", secure: bool = True
) -> dict[str, Any] | None:
    """Full client config including password — only for the authenticated user's browser."""
    if not sip_configured():
        return None
    creds = get_user_sip_credentials(user_id)
    ext = creds.get("extension") or ""
    password = creds.get("password") or ""
    if not ext or not password:
        return None
    cfg = get_sip_settings()
    domain = (cfg.get("sip_domain") or cfg.get("sip_server_host") or "").strip()
    display = creds.get("display_name") or default_display_name or ext
    ice_servers: list[dict[str, str]] = []
    stun = (cfg.get("stun_server") or "").strip()
    if stun:
        ice_servers.append({"urls": stun})
    return {
        "websocket_uri": derive_websocket_uri(cfg, secure=secure),
        "sip_domain": domain,
        "uri": f"sip:{ext}@{domain}",
        "extension": ext,
        "password": password,
        "display_name": display[:120],
        "registration_expires": cfg.get("registration_expires"),
        "outbound_proxy": cfg.get("outbound_proxy") or "",
        "use_session_timers": bool(cfg.get("use_session_timers")),
        "dtmf_mode": cfg.get("dtmf_mode") or "info",
        "ice_servers": ice_servers,
    }


def current_user_display_name() -> str:
    if not current_user.is_authenticated:
        return ""
    return str(getattr(current_user, "full_name", None) or getattr(current_user, "username", None) or "").strip()
