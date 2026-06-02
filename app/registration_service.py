"""Self-service registration pending administrator approval."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

from app.mfa_service import MFA_ATTR_REQUIRED, apply_mfa_required_flag, mfa_enrolled

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.models import User

ATTR_REGISTRATION_PENDING = "registration_pending"
ATTR_REGISTRATION_SUBMITTED_AT = "registration_submitted_at"
ATTR_REGISTRATION_REJECTED = "registration_rejected"

SETTING_SELF_REGISTRATION = "self_registration_enabled"
PORTAL_THEME_EXTRANET = "non_core_team"
PORTAL_THEME_INTRANET = "core_team"


def portal_theme_key() -> str:
    """Saved portal theme: core_team (Firmgate) or non_core_team (Extranet)."""
    from app.settings import get_setting

    portal = get_setting("portal", default={}) or {}
    raw = (portal.get("theme") or PORTAL_THEME_INTRANET) if isinstance(portal, dict) else PORTAL_THEME_INTRANET
    theme = str(raw or PORTAL_THEME_INTRANET).strip().lower().replace("-", "_")
    if theme not in (PORTAL_THEME_INTRANET, PORTAL_THEME_EXTRANET):
        return PORTAL_THEME_INTRANET
    return theme


def portal_is_extranet() -> bool:
    return portal_theme_key() == PORTAL_THEME_EXTRANET


def _user_attrs(user: User) -> dict:
    a = user.attributes
    return dict(a) if isinstance(a, dict) else {}


def self_registration_setting_enabled() -> bool:
    from app.premium_license import FEATURE_SELF_REGISTRATION, feature_enabled

    if not feature_enabled(FEATURE_SELF_REGISTRATION):
        return False
    """Administrator toggle (only applies when portal theme is Extranet)."""
    from app.settings import get_setting

    val = get_setting(SETTING_SELF_REGISTRATION, default=True)
    return val is not False and val != "0" and val != 0


def self_registration_enabled() -> bool:
    """Public registration is only available on the Extranet portal theme."""
    if not portal_is_extranet():
        return False
    return self_registration_setting_enabled()


def set_self_registration_enabled(enabled: bool) -> None:
    from app.settings import set_setting

    set_setting(SETTING_SELF_REGISTRATION, bool(enabled))


def registration_pending(user: User) -> bool:
    return bool(_user_attrs(user).get(ATTR_REGISTRATION_PENDING))


def registration_rejected(user: User) -> bool:
    return bool(_user_attrs(user).get(ATTR_REGISTRATION_REJECTED))


def registration_submitted_at(user: User) -> str | None:
    v = _user_attrs(user).get(ATTR_REGISTRATION_SUBMITTED_AT)
    return str(v).strip() if v else None


def mark_registration_pending(user: User) -> None:
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    attrs = _user_attrs(user)
    attrs[ATTR_REGISTRATION_PENDING] = True
    attrs[ATTR_REGISTRATION_SUBMITTED_AT] = now
    attrs.pop(ATTR_REGISTRATION_REJECTED, None)
    attrs.pop("registration_notify_sent", None)
    user.attributes = attrs
    user.is_active = False
    apply_mfa_required_flag(user, True)


def mark_registration_rejected(user: User) -> None:
    attrs = _user_attrs(user)
    attrs[ATTR_REGISTRATION_PENDING] = False
    attrs[ATTR_REGISTRATION_REJECTED] = True
    user.attributes = attrs
    user.is_active = False


def clear_registration_flags(user: User) -> None:
    attrs = _user_attrs(user)
    attrs.pop(ATTR_REGISTRATION_PENDING, None)
    attrs.pop(ATTR_REGISTRATION_SUBMITTED_AT, None)
    attrs.pop(ATTR_REGISTRATION_REJECTED, None)
    user.attributes = attrs


def approve_registration(user: User, db_session: Session) -> None:
    from app import rbac

    if not registration_pending(user):
        raise ValueError("not a pending registration")
    if not mfa_enrolled(user):
        raise ValueError("MFA not enrolled")

    clear_registration_flags(user)
    user.is_active = True
    rbac.assign_standard_role(user, db_session)
    rbac.ensure_user_in_general_group(user, db_session)
    db_session.add(user)


def registration_display_name(user: User) -> str:
    attrs = _user_attrs(user)
    fn = str(attrs.get("first_name") or "").strip()
    sn = str(attrs.get("surname") or "").strip()
    if fn or sn:
        return f"{fn} {sn}".strip()
    return (user.full_name or "").strip()


def serialize_registration(user: User) -> dict:
    name = registration_display_name(user)
    return {
        "id": user.id,
        "email": user.email or user.username,
        "username": user.username,
        "display_name": name,
        "first_name": str(_user_attrs(user).get("first_name") or "").strip(),
        "surname": str(_user_attrs(user).get("surname") or "").strip(),
        "submitted_at": registration_submitted_at(user),
        "mfa_enrolled": mfa_enrolled(user),
        "ready": registration_pending(user) and mfa_enrolled(user),
    }
