"""Intranet WebRTC signaling settings for Team Chat voice/video calls."""

from __future__ import annotations

from typing import Any

from app.settings import get_setting, set_setting

SETTING_INTRANET_SIGNALING = "intranet_signaling"

_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "voice_enabled": True,
    "video_enabled": True,
    "max_participants": 40,
    "stun_server": "stun:stun.l.google.com:19302",
    "turn_server": "",
    "turn_username": "",
    "turn_password": "",
    "use_socket_signaling": True,
    "allow_http_signaling_fallback": True,
}


def _coerce_settings(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return dict(_DEFAULTS)
    out = dict(_DEFAULTS)
    out.update(raw)
    out["enabled"] = bool(out.get("enabled"))
    out["voice_enabled"] = bool(out.get("voice_enabled", True))
    out["video_enabled"] = bool(out.get("video_enabled", True))
    out["use_socket_signaling"] = bool(out.get("use_socket_signaling", True))
    out["allow_http_signaling_fallback"] = bool(out.get("allow_http_signaling_fallback", True))
    try:
        out["max_participants"] = max(2, min(int(out.get("max_participants") or 40), 40))
    except (TypeError, ValueError):
        out["max_participants"] = 40
    for key in ("stun_server", "turn_server", "turn_username", "turn_password"):
        out[key] = str(out.get(key) or "").strip()
    return out


def get_intranet_signaling_settings() -> dict[str, Any]:
    return _coerce_settings(get_setting(SETTING_INTRANET_SIGNALING, default={}))


def intranet_signaling_configured() -> bool:
    cfg = get_intranet_signaling_settings()
    return bool(cfg.get("enabled"))


def ice_servers_for_client() -> list[dict[str, Any]]:
    cfg = get_intranet_signaling_settings()
    servers: list[dict[str, Any]] = []
    stun = (cfg.get("stun_server") or "").strip()
    if stun:
        servers.append({"urls": stun})
    turn = (cfg.get("turn_server") or "").strip()
    if turn:
        entry: dict[str, Any] = {"urls": turn}
        user = (cfg.get("turn_username") or "").strip()
        cred = (cfg.get("turn_password") or "").strip()
        if user:
            entry["username"] = user
        if cred:
            entry["credential"] = cred
        servers.append(entry)
    if not servers:
        servers.append({"urls": "stun:stun.l.google.com:19302"})
    return servers


def signaling_settings_for_api() -> dict[str, Any]:
    cfg = get_intranet_signaling_settings()
    return {
        "enabled": bool(cfg.get("enabled")),
        "voice_enabled": bool(cfg.get("voice_enabled")),
        "video_enabled": bool(cfg.get("video_enabled")),
        "max_participants": int(cfg.get("max_participants") or 40),
        "stun_server": cfg.get("stun_server") or "",
        "turn_server": cfg.get("turn_server") or "",
        "turn_username": cfg.get("turn_username") or "",
        "turn_password_set": bool((cfg.get("turn_password") or "").strip()),
        "use_socket_signaling": bool(cfg.get("use_socket_signaling")),
        "allow_http_signaling_fallback": bool(cfg.get("allow_http_signaling_fallback")),
        "configured": intranet_signaling_configured(),
    }


def team_chat_signaling_for_client() -> dict[str, Any]:
    cfg = get_intranet_signaling_settings()
    return {
        "enabled": bool(cfg.get("enabled")),
        "voice_enabled": bool(cfg.get("voice_enabled")),
        "video_enabled": bool(cfg.get("video_enabled")),
        "max_participants": int(cfg.get("max_participants") or 40),
        "ice_servers": ice_servers_for_client(),
        "use_socket_signaling": bool(cfg.get("use_socket_signaling")),
        "allow_http_signaling_fallback": bool(cfg.get("allow_http_signaling_fallback")),
    }


def save_intranet_signaling_settings(
    payload: dict[str, Any],
) -> dict[str, Any] | tuple[dict[str, str], int]:
    existing = get_intranet_signaling_settings()
    turn_password = existing.get("turn_password") or ""
    if "turn_password" in payload:
        pw = str(payload.get("turn_password") or "").strip()
        if pw:
            turn_password = pw

    cfg = _coerce_settings(
        {
            "enabled": bool(payload.get("enabled")) if "enabled" in payload else existing.get("enabled"),
            "voice_enabled": (
                bool(payload.get("voice_enabled"))
                if "voice_enabled" in payload
                else existing.get("voice_enabled", True)
            ),
            "video_enabled": (
                bool(payload.get("video_enabled"))
                if "video_enabled" in payload
                else existing.get("video_enabled", True)
            ),
            "max_participants": payload.get("max_participants", existing.get("max_participants")),
            "stun_server": payload.get("stun_server", existing.get("stun_server")),
            "turn_server": payload.get("turn_server", existing.get("turn_server")),
            "turn_username": payload.get("turn_username", existing.get("turn_username")),
            "turn_password": turn_password,
            "use_socket_signaling": (
                bool(payload.get("use_socket_signaling"))
                if "use_socket_signaling" in payload
                else existing.get("use_socket_signaling", True)
            ),
            "allow_http_signaling_fallback": (
                bool(payload.get("allow_http_signaling_fallback"))
                if "allow_http_signaling_fallback" in payload
                else existing.get("allow_http_signaling_fallback", True)
            ),
        }
    )
    set_setting(SETTING_INTRANET_SIGNALING, cfg)
    return signaling_settings_for_api()
