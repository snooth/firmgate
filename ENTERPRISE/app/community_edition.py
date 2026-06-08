"""Community Edition: fixed module allowlist and default navigation policy."""

from __future__ import annotations

import os
from typing import Any

from app.settings import get_setting, set_setting

SETTING_MODULES = "modules"

# Modules included in the public Community Edition release.
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

# Not available in Community Edition (enterprise / full build only).
ENTERPRISE_ONLY_MODULES = frozenset(
    {
        "security_clearance",
        "security_officer",
        "crm",
        "resource_pool",
        "resource_calculator",
        "ai_document_search",
        "ai_chatbot",
        "ai_policy_assistant",
        "ai_cv_builder",
        "ai_tender_assistant",
        "timesheets",
        "timesheets_collection",
    }
)

# Enterprise nav modules unlocked by a subscription feature (not the full edition pack).
ENTERPRISE_MODULE_LICENSE_FEATURES: dict[str, str] = {
    "ai_document_search": "ai_document_search",
    "ai_chatbot": "ai_chatbot",
    "ai_policy_assistant": "ai_policy_assistant",
    "ai_cv_builder": "ai_cv_builder",
    "ai_tender_assistant": "ai_tender_assistant",
    "crm": "crm",
    "resource_pool": "resource_pool",
    "resource_calculator": "resource_calculator",
    "security_clearance": "security_clearance",
    "security_officer": "security_officer",
    "timesheets": "timesheets",
    "timesheets_collection": "timesheets",
}


def is_community_edition() -> bool:
    return os.environ.get("COMMUNITY_EDITION", "1").lower() in ("1", "true", "yes")


def enterprise_module_licensed(module_key: str) -> bool:
    """True when CE ships the module key and the active license includes its feature."""
    key = str(module_key or "").strip()
    if key == "ai_chatbot":
        from app.premium_license import ai_chatbot_licensed

        return ai_chatbot_licensed()
    if key == "ai_policy_assistant":
        from app.premium_license import ai_policy_assistant_licensed

        return ai_policy_assistant_licensed()
    if key == "ai_cv_builder":
        from app.premium_license import ai_cv_builder_licensed

        return ai_cv_builder_licensed()
    if key == "ai_tender_assistant":
        from app.premium_license import ai_tender_assistant_licensed

        return ai_tender_assistant_licensed()
    if key == "crm":
        from app.premium_license import crm_licensed

        return crm_licensed()
    if key == "resource_pool":
        from app.premium_license import resource_pool_licensed

        return resource_pool_licensed()
    if key == "resource_calculator":
        from app.premium_license import resource_calculator_licensed

        return resource_calculator_licensed()
    if key == "security_clearance":
        from app.premium_license import security_clearance_licensed

        return security_clearance_licensed()
    if key == "security_officer":
        # Backwards compatible: older keys used `security_officer_export`.
        from app.premium_license import feature_enabled
        from app.premium_license import FEATURE_SECURITY_OFFICER, FEATURE_SECURITY_OFFICER_EXPORT

        return feature_enabled(FEATURE_SECURITY_OFFICER) or feature_enabled(FEATURE_SECURITY_OFFICER_EXPORT)
    if key == "timesheets":
        from app.premium_license import timesheets_licensed

        return timesheets_licensed()
    feat = ENTERPRISE_MODULE_LICENSE_FEATURES.get(key)
    if not feat:
        return False
    from app.premium_license import feature_enabled

    return feature_enabled(feat)


def licensed_enterprise_modules() -> list[str]:
    return sorted(k for k in ENTERPRISE_ONLY_MODULES if enterprise_module_licensed(k))


def community_module_available(module_key: str) -> bool:
    key = str(module_key or "").strip()
    if key in ENTERPRISE_ONLY_MODULES:
        return enterprise_module_licensed(key)
    if not is_community_edition():
        return True
    if key in COMMUNITY_EDITION_MODULES:
        return True
    return False


def enterprise_only_module(module_key: str) -> bool:
    key = str(module_key or "").strip()
    return is_community_edition() and key in ENTERPRISE_ONLY_MODULES and not enterprise_module_licensed(key)


def default_community_module_rows() -> dict[str, dict[str, Any]]:
    """Default Administration → Modules policy for Community Edition."""
    rows: dict[str, dict[str, Any]] = {}
    all_keys = COMMUNITY_EDITION_MODULES | ENTERPRISE_ONLY_MODULES
    for key in all_keys:
        enabled = key in COMMUNITY_EDITION_MODULES
        restricted = False
        allowed_user_ids: list[int] = []
        rows[key] = {
            "enabled": enabled,
            "restricted": restricted,
            "allowed_user_ids": allowed_user_ids,
        }
    return rows


def apply_community_module_policy(mods: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Force enterprise-only modules off; keep community modules as stored."""
    if not is_community_edition():
        return mods
    out: dict[str, dict[str, Any]] = {}
    defaults = default_community_module_rows()
    for key, default in defaults.items():
        raw = mods.get(key) if isinstance(mods, dict) else None
        row = raw if isinstance(raw, dict) else {}
        if key in ENTERPRISE_ONLY_MODULES:
            if enterprise_module_licensed(key):
                en = row.get("enabled")
                enabled = True if en is None else bool(en)
                restricted = bool(row.get("restricted")) and enabled
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
            else:
                out[key] = {
                    "enabled": False,
                    "restricted": False,
                    "allowed_user_ids": [],
                }
            continue
        en = row.get("enabled")
        enabled = default["enabled"] if en is None else bool(en)
        restricted = bool(row.get("restricted")) and enabled
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
    """On startup, seed module policy for Community Edition when unset."""
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
