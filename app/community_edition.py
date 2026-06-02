"""Community Edition: fixed module allowlist (public release)."""

from __future__ import annotations

import os
from typing import Any

from app.settings import get_setting, set_setting

SETTING_MODULES = "modules"

COMMUNITY_EDITION_MODULES = frozenset(
    {
        "home",
        "news",
        "events",
        "wiki",
        "team_chat",
        "directory",
        "workforce_dashboard",
        "security_training",
        "documents",
        "about",
        "game",
        "admin",
    }
)


def is_community_edition() -> bool:
    return os.environ.get("COMMUNITY_EDITION", "1").lower() in ("1", "true", "yes")


def community_module_available(module_key: str) -> bool:
    key = str(module_key or "").strip()
    if not is_community_edition():
        return True
    return key in COMMUNITY_EDITION_MODULES or key == "admin"


def default_community_module_rows() -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for key in COMMUNITY_EDITION_MODULES:
        rows[key] = {
            "enabled": True,
            "restricted": False,
            "allowed_user_ids": [],
        }
    return rows


def apply_community_module_policy(mods: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if not is_community_edition():
        return mods
    out: dict[str, dict[str, Any]] = {}
    defaults = default_community_module_rows()
    for key, default in defaults.items():
        raw = mods.get(key) if isinstance(mods, dict) else None
        row = raw if isinstance(raw, dict) else {}
        en = row.get("enabled")
        enabled = default["enabled"] if en is None else bool(en)
        restricted = False
        ids = row.get("allowed_user_ids")
        if not isinstance(ids, list):
            ids = []
        clean_ids: list[int] = []
        for x in ids[:500]:
            try:
                clean_ids.append(int(x))
            except Exception:
                continue
        out[key] = {
            "enabled": enabled,
            "restricted": restricted,
            "allowed_user_ids": clean_ids,
        }
    return out


def ensure_community_module_defaults() -> None:
    if not is_community_edition():
        return
    cfg = get_setting(SETTING_MODULES, default={}) or {}
    mods = cfg.get("modules") if isinstance(cfg, dict) else None
    if isinstance(mods, dict) and mods:
        merged = apply_community_module_policy(mods)
        if merged != mods:
            set_setting(SETTING_MODULES, {"modules": merged})
        return
    set_setting(SETTING_MODULES, {"modules": default_community_module_rows()})


def abort_if_module_locked(module_key: str) -> None:
    from flask import abort

    if not community_module_available(module_key):
        abort(404)
