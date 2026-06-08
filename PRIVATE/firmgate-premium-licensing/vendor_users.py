"""Portal-only user accounts for the Firmgate premium licensing web UI."""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from werkzeug.security import check_password_hash, generate_password_hash

_DIR = Path(__file__).resolve().parent
_USERS_PATH = _DIR / "vendor_users.json"
_LEGACY_ACCOUNT_PATH = _DIR / "vendor_account.json"

ROLE_ADMIN = "admin"
ROLE_OPERATOR = "operator"
ROLE_LABELS = {ROLE_ADMIN: "Administrator", ROLE_OPERATOR: "Operator"}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def env_username() -> str:
    return (os.environ.get("LICENSING_WEB_USERNAME") or "admin@example.com").strip()


def env_password() -> str:
    return (os.environ.get("LICENSING_WEB_PASSWORD") or "admin").strip()


def _norm_username(username: str) -> str:
    return (username or "").strip().lower()


def _read_store() -> dict[str, Any]:
    if not _USERS_PATH.exists():
        return {"users": []}
    try:
        data = json.loads(_USERS_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"users": []}
        users = data.get("users")
        if not isinstance(users, list):
            data["users"] = []
        return data
    except (OSError, json.JSONDecodeError):
        return {"users": []}


def _write_store(data: dict[str, Any]) -> None:
    data["updated_at"] = _utc_now_iso()
    _USERS_PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _read_legacy_account() -> dict[str, Any]:
    if not _LEGACY_ACCOUNT_PATH.exists():
        return {}
    try:
        data = json.loads(_LEGACY_ACCOUNT_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _new_user_record(
    *,
    username: str,
    password: str,
    role: str,
    display_name: str = "",
    email: str = "",
    phone: str = "",
    timezone: str = "Australia/Melbourne",
    organization: str = "Firmgate licensing",
    password_hash: str | None = None,
) -> dict[str, Any]:
    un = username.strip()
    now = _utc_now_iso()
    pw_hash = password_hash or generate_password_hash(password)
    dn = (display_name or "").strip() or (un.split("@")[0] if "@" in un else un)
    return {
        "id": str(uuid.uuid4()),
        "username": un,
        "password_hash": pw_hash,
        "role": role if role in (ROLE_ADMIN, ROLE_OPERATOR) else ROLE_OPERATOR,
        "display_name": dn[:120],
        "email": ((email or un).strip() or un)[:255],
        "phone": (phone or "").strip()[:64],
        "timezone": (timezone or "Australia/Melbourne").strip()[:80] or "Australia/Melbourne",
        "organization": (organization or "Firmgate licensing").strip()[:120],
        "created_at": now,
        "updated_at": now,
    }


def ensure_users_store() -> None:
    """Seed, migrate legacy single-account file, or create default admin from env."""
    data = _read_store()
    users: list[dict[str, Any]] = [u for u in data.get("users", []) if isinstance(u, dict) and u.get("id")]

    legacy = _read_legacy_account()
    if legacy:
        un = str(legacy.get("username") or env_username()).strip()
        norm = _norm_username(un)
        if not any(_norm_username(str(u.get("username") or "")) == norm for u in users):
            pw_hash = str(legacy.get("password_hash") or "").strip()
            users.append(
                _new_user_record(
                    username=un,
                    password=env_password(),
                    role=ROLE_ADMIN,
                    display_name=str(legacy.get("display_name") or ""),
                    email=str(legacy.get("email") or un),
                    phone=str(legacy.get("phone") or ""),
                    timezone=str(legacy.get("timezone") or "Australia/Melbourne"),
                    organization=str(legacy.get("organization") or "Firmgate licensing"),
                    password_hash=pw_hash or None,
                )
            )

    if not users:
        un = env_username()
        users.append(
            _new_user_record(
                username=un,
                password=env_password(),
                role=ROLE_ADMIN,
                email=un,
            )
        )

    data["users"] = users
    _write_store(data)


def _users_list() -> list[dict[str, Any]]:
    ensure_users_store()
    return list(_read_store().get("users") or [])


def _save_users(users: list[dict[str, Any]]) -> None:
    data = _read_store()
    data["users"] = users
    _write_store(data)


def get_user_by_id(user_id: str) -> dict[str, Any] | None:
    uid = (user_id or "").strip()
    if not uid:
        return None
    for u in _users_list():
        if str(u.get("id") or "") == uid:
            return dict(u)
    return None


def get_user_by_username(username: str) -> dict[str, Any] | None:
    norm = _norm_username(username)
    if not norm:
        return None
    for u in _users_list():
        if _norm_username(str(u.get("username") or "")) == norm:
            return dict(u)
    return None


def list_users_public() -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for u in _users_list():
        role = str(u.get("role") or ROLE_OPERATOR)
        out.append(
            {
                "id": str(u.get("id") or ""),
                "username": str(u.get("username") or ""),
                "display_name": str(u.get("display_name") or ""),
                "email": str(u.get("email") or ""),
                "role": role,
                "role_label": ROLE_LABELS.get(role, role),
                "created_at": str(u.get("created_at") or ""),
                "updated_at": str(u.get("updated_at") or ""),
            }
        )
    out.sort(key=lambda x: (x.get("role") != ROLE_ADMIN, (x.get("display_name") or x.get("username") or "").lower()))
    return out


def is_admin(user: dict[str, Any] | None) -> bool:
    return bool(user and str(user.get("role") or "") == ROLE_ADMIN)


def admin_count() -> int:
    return sum(1 for u in _users_list() if str(u.get("role") or "") == ROLE_ADMIN)


def verify_login(username: str, password: str) -> dict[str, Any] | None:
    u = get_user_by_username(username)
    if not u:
        return None
    pw = password or ""
    if not pw:
        return None
    stored = str(u.get("password_hash") or "").strip()
    if not stored or not check_password_hash(stored, pw):
        return None
    return {k: v for k, v in u.items() if k != "password_hash"}


def profile_public(user_id: str) -> dict[str, str]:
    u = get_user_by_id(user_id)
    if not u:
        return {
            "id": "",
            "username": "",
            "display_name": "Unknown",
            "email": "",
            "phone": "",
            "timezone": "Australia/Melbourne",
            "organization": "Firmgate licensing",
            "role": ROLE_OPERATOR,
            "role_label": ROLE_LABELS[ROLE_OPERATOR],
            "updated_at": "",
        }
    role = str(u.get("role") or ROLE_OPERATOR)
    return {
        "id": str(u.get("id") or ""),
        "username": str(u.get("username") or ""),
        "display_name": str(u.get("display_name") or ""),
        "email": str(u.get("email") or ""),
        "phone": str(u.get("phone") or ""),
        "timezone": str(u.get("timezone") or "Australia/Melbourne"),
        "organization": str(u.get("organization") or "Firmgate licensing"),
        "role": role,
        "role_label": ROLE_LABELS.get(role, role),
        "updated_at": str(u.get("updated_at") or ""),
    }


def update_profile(
    user_id: str,
    *,
    display_name: str,
    email: str,
    phone: str,
    timezone: str,
    organization: str,
) -> tuple[bool, str]:
    users = _users_list()
    idx = next((i for i, u in enumerate(users) if str(u.get("id") or "") == user_id), None)
    if idx is None:
        return False, "User not found."
    users[idx]["display_name"] = (display_name or "").strip()[:120]
    users[idx]["email"] = (email or "").strip()[:255]
    users[idx]["phone"] = (phone or "").strip()[:64]
    users[idx]["timezone"] = (timezone or "").strip()[:80] or "Australia/Melbourne"
    users[idx]["organization"] = (organization or "").strip()[:120]
    users[idx]["updated_at"] = _utc_now_iso()
    _save_users(users)
    return True, ""


def update_credentials(
    user_id: str,
    *,
    current_password: str,
    new_username: str,
    new_password: str,
) -> tuple[bool, str]:
    u = get_user_by_id(user_id)
    if not u:
        return False, "User not found."
    if not verify_login(str(u.get("username") or ""), current_password):
        return False, "Current password is incorrect."
    un = (new_username or "").strip()
    if not un:
        return False, "Username is required."
    if len(un) > 255:
        return False, "Username is too long."
    if "@" not in un and len(un) < 3:
        return False, "Username must be at least 3 characters (or use an email address)."
    norm = _norm_username(un)
    for other in _users_list():
        if str(other.get("id") or "") == user_id:
            continue
        if _norm_username(str(other.get("username") or "")) == norm:
            return False, "That username is already in use."
    pw = (new_password or "").strip()
    if pw and len(pw) < 8:
        return False, "New password must be at least 8 characters."
    users = _users_list()
    idx = next((i for i, x in enumerate(users) if str(x.get("id") or "") == user_id), None)
    if idx is None:
        return False, "User not found."
    users[idx]["username"] = un
    if pw:
        users[idx]["password_hash"] = generate_password_hash(pw)
    users[idx]["updated_at"] = _utc_now_iso()
    _save_users(users)
    return True, ""


def create_user(
    *,
    username: str,
    password: str,
    role: str,
    display_name: str = "",
    email: str = "",
) -> tuple[bool, str]:
    un = (username or "").strip()
    if not un:
        return False, "Username is required."
    if get_user_by_username(un):
        return False, "That username is already in use."
    pw = (password or "").strip()
    if len(pw) < 8:
        return False, "Password must be at least 8 characters."
    r = (role or ROLE_OPERATOR).strip()
    if r not in (ROLE_ADMIN, ROLE_OPERATOR):
        r = ROLE_OPERATOR
    users = _users_list()
    users.append(
        _new_user_record(
            username=un,
            password=pw,
            role=r,
            display_name=display_name,
            email=email or un,
        )
    )
    _save_users(users)
    return True, ""


def delete_user(*, actor_id: str, target_id: str) -> tuple[bool, str]:
    actor_id = (actor_id or "").strip()
    target_id = (target_id or "").strip()
    if not target_id:
        return False, "User not found."
    if actor_id == target_id:
        return False, "You cannot delete your own account."
    target = get_user_by_id(target_id)
    if not target:
        return False, "User not found."
    if str(target.get("role") or "") == ROLE_ADMIN and admin_count() <= 1:
        return False, "Cannot delete the last administrator."
    users = [u for u in _users_list() if str(u.get("id") or "") != target_id]
    _save_users(users)
    return True, ""


# Back-compat helpers used during transition
def effective_username() -> str:
    users = _users_list()
    if users:
        admins = [u for u in users if str(u.get("role") or "") == ROLE_ADMIN]
        pick = admins[0] if admins else users[0]
        return str(pick.get("username") or env_username())
    return env_username()
