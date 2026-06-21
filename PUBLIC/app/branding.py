"""Product naming for portal shell, MFA, and user-facing copy."""

from __future__ import annotations

from typing import Any, Callable

from config import Config

DEFAULT_LOGO_STATIC = "branding/firmgate-logo.svg"
CUSTOM_LOGO_URL = "/admin/portal/logo"


def portal_core_name() -> str:
    name = (Config.PORTAL_PRODUCT_NAME or "Firmgate").strip()
    return name or "Firmgate"


def portal_shell_name(theme_key: str | None = None) -> str:
    key = str(theme_key or "core_team").strip().lower().replace("-", "_")
    if key == "non_core_team":
        return "Extranet"
    return portal_core_name()


def portal_display_name(portal: Any, theme_key: str | None = None) -> str:
    """User-facing portal name from Browser tab title, else theme default (Firmgate / Extranet)."""
    custom = str(_portal_dict(portal).get("browser_tab_title") or "").strip()
    if custom:
        return custom[:80]
    return portal_shell_name(theme_key)


def portal_display_name_from_settings(*, theme_key: str | None = None) -> str:
    from app.settings import get_setting

    portal = get_setting("portal", default={}) or {}
    if theme_key is None:
        from app.registration_service import portal_is_extranet

        theme_key = "non_core_team" if portal_is_extranet() else "core_team"
    return portal_display_name(portal, theme_key)


def portal_browser_tab_title(portal: Any, theme_key: str | None = None) -> str:
    """Label used in HTML <title> tags; falls back to portal shell name."""
    return portal_display_name(portal, theme_key)


def _portal_dict(portal: Any) -> dict[str, Any]:
    return portal if isinstance(portal, dict) else {}


def portal_logo_enabled(portal: Any) -> bool:
    cfg = _portal_dict(portal)
    if "logo_enabled" in cfg:
        return bool(cfg.get("logo_enabled"))
    return True


def portal_has_custom_logo(portal: Any) -> bool:
    return bool((_portal_dict(portal).get("logo_name") or "").strip())


def portal_logo_url(portal: Any, *, static_url: Callable[[str], str] | None = None) -> str:
    """Custom uploaded logo, else bundled Firmgate mark, unless disabled."""
    if not portal_logo_enabled(portal):
        return ""
    if portal_has_custom_logo(portal):
        return CUSTOM_LOGO_URL
    if static_url is None:
        return ""
    return static_url(DEFAULT_LOGO_STATIC)


def portal_logo_is_default(portal: Any) -> bool:
    return portal_logo_enabled(portal) and not portal_has_custom_logo(portal)


def portal_logo_email_url(portal: Any) -> str:
    """Absolute URL for portal logo images in outbound email."""
    if not portal_logo_enabled(portal):
        return ""
    try:
        from flask import url_for

        if portal_has_custom_logo(portal):
            return url_for("admin.portal_logo_public", _external=True)
        return url_for("static", filename=DEFAULT_LOGO_STATIC, _external=True)
    except Exception:
        return ""
