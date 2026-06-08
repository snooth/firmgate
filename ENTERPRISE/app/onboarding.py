"""First-login onboarding flags (password change, etc.)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models import User

PW_CHANGE_ATTR = "require_pw_change"


def _user_attrs(user: User) -> dict:
    a = user.attributes
    return a if isinstance(a, dict) else {}


def password_change_required(user: User) -> bool:
    return bool(_user_attrs(user).get(PW_CHANGE_ATTR))


def clear_password_change_required(user: User) -> None:
    attrs = dict(_user_attrs(user))
    attrs[PW_CHANGE_ATTR] = False
    user.attributes = attrs
