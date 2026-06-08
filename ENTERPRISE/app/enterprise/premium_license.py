"""Enterprise subscription license verification (public Community Edition).

Signing and key generation live only in PRIVATE/firmgate-premium-licensing/ (Ed25519 private key).
This module verifies FG2 keys with an embedded or configured public key only.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from flask import current_app

from app.settings import get_setting, set_setting

log = logging.getLogger(__name__)

SETTING_KEY = "premium_license"
SETTING_REVOKED = "premium_license_revoked"
LICENSE_PREFIX = "FG2"
LEGACY_LICENSE_PREFIX = "FG1"
LICENSE_PAYLOAD_VERSION = 2
_MAX_LICENSE_KEY_CHARS = 8192
_MAX_LICENSE_BODY_BYTES = 2048
_ED25519_SIG_BYTES = 64
_PUBLIC_KEY_FILE = Path(__file__).with_name("enterprise_license_public.b64")

FEATURE_SELF_REGISTRATION = "self_registration"
FEATURE_OFFICE365 = "office365"
FEATURE_LDAP = "ldap"
FEATURE_SECURITY_OFFICER_EXPORT = "security_officer_export"
FEATURE_SECURITY_OFFICER = "security_officer"
FEATURE_SECURITY_ENCRYPTION = "security_encryption"
FEATURE_AI_DOCUMENT_SEARCH = "ai_document_search"
FEATURE_AI_CHATBOT = "ai_chatbot"
FEATURE_AI_POLICY_ASSISTANT = "ai_policy_assistant"
FEATURE_AI_CV_BUILDER = "ai_cv_builder"
FEATURE_AI_TENDER_ASSISTANT = "ai_tender_assistant"
FEATURE_CRM = "crm"
FEATURE_RESOURCE_POOL = "resource_pool"
FEATURE_RESOURCE_CALCULATOR = "resource_calculator"
FEATURE_SECURITY_CLEARANCE = "security_clearance"
FEATURE_TIMESHEETS = "timesheets"
FEATURE_ENTERPRISE_INTRANET = "enterprise_intranet"

NON_AI_ENTERPRISE_MODULE_FEATURES = frozenset(
    {
        FEATURE_CRM,
        FEATURE_RESOURCE_POOL,
        FEATURE_RESOURCE_CALCULATOR,
        FEATURE_SECURITY_CLEARANCE,
    }
)

AI_ENTERPRISE_FEATURES = frozenset(
    {
        FEATURE_AI_DOCUMENT_SEARCH,
        FEATURE_AI_CHATBOT,
        FEATURE_AI_POLICY_ASSISTANT,
        FEATURE_AI_CV_BUILDER,
        FEATURE_AI_TENDER_ASSISTANT,
    }
)

ALL_FEATURES = frozenset(
    {
        FEATURE_SELF_REGISTRATION,
        FEATURE_OFFICE365,
        FEATURE_LDAP,
        FEATURE_SECURITY_OFFICER_EXPORT,
        FEATURE_SECURITY_OFFICER,
        FEATURE_SECURITY_ENCRYPTION,
        FEATURE_AI_DOCUMENT_SEARCH,
        FEATURE_AI_CHATBOT,
        FEATURE_AI_POLICY_ASSISTANT,
        FEATURE_AI_CV_BUILDER,
        FEATURE_AI_TENDER_ASSISTANT,
        FEATURE_CRM,
        FEATURE_RESOURCE_POOL,
        FEATURE_RESOURCE_CALCULATOR,
        FEATURE_SECURITY_CLEARANCE,
        FEATURE_TIMESHEETS,
        FEATURE_ENTERPRISE_INTRANET,
    }
)

FEATURE_LABELS: dict[str, str] = {
    FEATURE_SELF_REGISTRATION: "Self registration",
    FEATURE_OFFICE365: "Microsoft 365 / Office Online integration",
    FEATURE_LDAP: "LDAP / Active Directory integration",
    FEATURE_SECURITY_OFFICER_EXPORT: "Security Officer report export (PDF)",
    FEATURE_SECURITY_OFFICER: "Security Officer module (portal pages)",
    FEATURE_SECURITY_ENCRYPTION: "Security encryption at rest",
    FEATURE_AI_DOCUMENT_SEARCH: "AI Document Search",
    FEATURE_AI_CHATBOT: "AI Chatbot",
    FEATURE_AI_POLICY_ASSISTANT: "AI Docs and Policy",
    FEATURE_AI_CV_BUILDER: "AI CV Builder",
    FEATURE_AI_TENDER_ASSISTANT: "AI Tender Assistant",
    FEATURE_CRM: "CRM",
    FEATURE_RESOURCE_POOL: "Resource Pool",
    FEATURE_RESOURCE_CALCULATOR: "Casual Calculator",
    FEATURE_SECURITY_CLEARANCE: "Security Clearance",
    FEATURE_TIMESHEETS: "Timesheets (My Timesheet and Timesheet Collection)",
    FEATURE_ENTERPRISE_INTRANET: "Enterprise intranet modules (CRM, Resource Pool, Casual Calculator, Security Clearance)",
}


def _legacy_full_license_unlocks_intranet_modules() -> bool:
    """Older --all keys omitted explicit CRM/Resource Pool/Security Clearance feature ids."""
    feats = licensed_features()
    if not feats:
        return False
    if len(feats) >= 8:
        return True
    if ai_enterprise_licensed() and any(
        feature_enabled(f)
        for f in (
            FEATURE_OFFICE365,
            FEATURE_LDAP,
            FEATURE_SELF_REGISTRATION,
            FEATURE_SECURITY_OFFICER_EXPORT,
            FEATURE_SECURITY_ENCRYPTION,
        )
    ):
        return True
    return False


def enterprise_intranet_modules_licensed() -> bool:
    """CRM, Resource Pool, Casual Calculator, and Security Clearance (enterprise intranet pack)."""
    if feature_enabled(FEATURE_ENTERPRISE_INTRANET):
        return True
    if all(feature_enabled(f) for f in NON_AI_ENTERPRISE_MODULE_FEATURES):
        return True
    if _legacy_full_license_unlocks_intranet_modules():
        return True
    return False


def crm_licensed() -> bool:
    return feature_enabled(FEATURE_CRM) or enterprise_intranet_modules_licensed()


def resource_pool_licensed() -> bool:
    return feature_enabled(FEATURE_RESOURCE_POOL) or enterprise_intranet_modules_licensed()


def resource_calculator_licensed() -> bool:
    return feature_enabled(FEATURE_RESOURCE_CALCULATOR) or enterprise_intranet_modules_licensed()


def security_clearance_licensed() -> bool:
    return feature_enabled(FEATURE_SECURITY_CLEARANCE) or enterprise_intranet_modules_licensed()


def timesheets_licensed() -> bool:
    """Timesheets and Timesheet Collection (enterprise)."""
    return feature_enabled(FEATURE_TIMESHEETS)


def ai_enterprise_licensed() -> bool:
    """True when the active license includes any AI enterprise feature."""
    return any(feature_enabled(f) for f in AI_ENTERPRISE_FEATURES)


def ai_chatbot_licensed() -> bool:
    """AI Chatbot module (enterprise). Legacy keys with only document search still unlock chatbot."""
    return feature_enabled(FEATURE_AI_CHATBOT) or feature_enabled(FEATURE_AI_DOCUMENT_SEARCH)


def ai_policy_assistant_licensed() -> bool:
    """AI Policy Assistant (enterprise). Unlocked with policy feature or full AI pack."""
    return (
        feature_enabled(FEATURE_AI_POLICY_ASSISTANT)
        or feature_enabled(FEATURE_AI_DOCUMENT_SEARCH)
    )


def ai_cv_builder_licensed() -> bool:
    """AI CV Builder (enterprise). Unlocked with cv_builder feature or full AI document search pack."""
    return feature_enabled(FEATURE_AI_CV_BUILDER) or feature_enabled(FEATURE_AI_DOCUMENT_SEARCH)


def ai_tender_assistant_licensed() -> bool:
    """AI Tender Assistant (enterprise). Unlocked with tender feature or full AI document search pack."""
    return (
        feature_enabled(FEATURE_AI_TENDER_ASSISTANT)
        or feature_enabled(FEATURE_AI_DOCUMENT_SEARCH)
    )


def ai_document_search_licensed() -> bool:
    """AI Document Search module (enterprise)."""
    return feature_enabled(FEATURE_AI_DOCUMENT_SEARCH)


AI_ENTERPRISE_NAV_MODULES = frozenset(
    {
        FEATURE_AI_DOCUMENT_SEARCH,
        FEATURE_AI_CHATBOT,
        FEATURE_AI_POLICY_ASSISTANT,
        FEATURE_AI_CV_BUILDER,
        FEATURE_AI_TENDER_ASSISTANT,
    }
)


def enterprise_license_applied() -> bool:
    """True when a valid enterprise license key is active on this server."""
    st = license_state()
    return bool(st.get("valid")) and bool(licensed_features())


def ai_nav_module_licensed(module_key: str) -> bool:
    """Whether an intranet nav module key is licensed (enterprise AI pack)."""
    if not enterprise_license_applied():
        return False
    key = str(module_key or "").strip()
    if key == FEATURE_AI_DOCUMENT_SEARCH:
        return ai_document_search_licensed()
    if key == FEATURE_AI_CHATBOT:
        return ai_chatbot_licensed()
    if key == FEATURE_AI_POLICY_ASSISTANT:
        return ai_policy_assistant_licensed()
    if key == FEATURE_AI_CV_BUILDER:
        return ai_cv_builder_licensed()
    if key == FEATURE_AI_TENDER_ASSISTANT:
        return ai_tender_assistant_licensed()
    return True


def premium_required_ai(feature: str) -> tuple[bool, str]:
    """Require a specific AI enterprise feature (or any AI feature when feature is unknown)."""
    feat = str(feature or "").strip()
    if feat in AI_ENTERPRISE_FEATURES:
        return premium_required(feat)
    if ai_enterprise_licensed():
        return True, ""
    return False, "Enterprise AI features are not licensed. Activate a key under Administration → Enterprise Features."


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def build_license_body(
    *,
    features: list[str],
    expires: str | None = None,
    subject: str = "",
) -> bytes:
    """Canonical signed bytes (shared format; signing is private-only)."""
    feats = sorted({f for f in features if f in ALL_FEATURES})
    if not feats:
        raise ValueError("At least one enterprise feature is required.")
    payload: dict[str, Any] = {"f": feats, "v": LICENSE_PAYLOAD_VERSION}
    if expires:
        payload["exp"] = expires
    sub = (subject or "").strip()
    if sub:
        payload["sub"] = sub[:200]
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _load_public_key_bytes() -> bytes | None:
    b64 = (os.environ.get("FIRMGATE_LICENSE_PUBLIC_KEY") or "").strip()
    if not b64 and _PUBLIC_KEY_FILE.is_file():
        b64 = _PUBLIC_KEY_FILE.read_text(encoding="utf-8").strip()
    if not b64:
        return None
    try:
        raw = base64.b64decode(b64 + ("=" * (-len(b64) % 4)))
    except Exception:
        return None
    if len(raw) != 32:
        return None
    return raw


def license_verification_configured() -> bool:
    return _load_public_key_bytes() is not None


def _public_key() -> Ed25519PublicKey | None:
    raw = _load_public_key_bytes()
    if not raw:
        return None
    try:
        return Ed25519PublicKey.from_public_bytes(raw)
    except Exception:
        return None


def _parse_expiry(exp_raw: Any) -> tuple[date | None, str | None]:
    if not exp_raw:
        return None, None
    s = str(exp_raw).strip()
    if not s:
        return None, None
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
            return date.fromisoformat(s), None
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.date(), None
    except ValueError:
        return None, "Invalid expiry date in license."


def _payload_to_state(raw: str, payload: dict[str, Any]) -> dict[str, Any]:
    feats_raw = payload.get("f") or payload.get("features") or []
    if not isinstance(feats_raw, list):
        raise ValueError("License has no feature list.")
    features = sorted({str(x).strip() for x in feats_raw if str(x).strip() in ALL_FEATURES})
    if not features:
        raise ValueError("License does not include any recognised enterprise features.")
    exp_date, exp_err = _parse_expiry(payload.get("exp"))
    if exp_err:
        raise ValueError(exp_err)
    if exp_date and exp_date < datetime.now(timezone.utc).date():
        raise ValueError(f"License expired on {exp_date.isoformat()}.")
    return {
        "valid": True,
        "features": features,
        "subject": str(payload.get("sub") or "").strip()[:200],
        "expires_at": exp_date.isoformat() if exp_date else None,
        "applied_at": datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "key_fingerprint": hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16],
    }


def verify_license_key_crypto(key: str) -> tuple[dict[str, Any] | None, str]:
    """Verify signature and payload only (no revocation list). Safe for offline vendor tooling."""
    raw = (key or "").strip()
    if not raw:
        return None, "License key is required."
    if len(raw) > _MAX_LICENSE_KEY_CHARS:
        return None, "License key is too long."
    if raw.startswith(f"{LEGACY_LICENSE_PREFIX}-"):
        return (
            None,
            "Legacy FG1 license keys are no longer accepted. Request a new FG2 key from your vendor.",
        )
    if not raw.startswith(f"{LICENSE_PREFIX}."):
        return None, f"License key must start with {LICENSE_PREFIX}."
    pub = _public_key()
    if not pub:
        return None, "Enterprise license verification is not configured (missing public key)."
    rest = raw[len(LICENSE_PREFIX) + 1 :]
    if "." not in rest:
        return None, "Invalid license key format."
    body_b64, sig_b64 = rest.rsplit(".", 1)
    try:
        body = _b64url_decode(body_b64)
        sig = _b64url_decode(sig_b64)
    except Exception:
        return None, "License key could not be decoded."
    if len(body) > _MAX_LICENSE_BODY_BYTES:
        return None, "License payload is too large."
    if len(sig) != _ED25519_SIG_BYTES:
        return None, "Invalid license key signature."
    try:
        pub.verify(sig, body)
    except InvalidSignature:
        return None, "Invalid license key signature."
    except Exception:
        return None, "License key signature could not be verified."
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, "License payload is not valid JSON."
    if not isinstance(payload, dict):
        return None, "Invalid license payload."
    version = payload.get("v")
    if version is not None:
        try:
            if int(version) != LICENSE_PAYLOAD_VERSION:
                return None, "Unsupported license version."
        except (TypeError, ValueError):
            return None, "Unsupported license version."
    try:
        state = _payload_to_state(raw, payload)
    except ValueError as exc:
        return None, str(exc)
    return state, ""


def verify_license_key(key: str) -> tuple[dict[str, Any] | None, str]:
    state, err = verify_license_key_crypto(key)
    if err or not state:
        return state, err
    fp = state.get("key_fingerprint") or ""
    if fp and _is_fingerprint_revoked(fp):
        return None, "This license key has been revoked."
    return state, ""


def license_key_fingerprint(key: str) -> str | None:
    """Stable id for a license key string (first 16 hex chars of SHA-256)."""
    raw = (key or "").strip()
    if not raw.startswith(f"{LICENSE_PREFIX}."):
        return None
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _revoked_store() -> dict[str, Any]:
    v = get_setting(SETTING_REVOKED, default={}) or {}
    return v if isinstance(v, dict) else {}


def _revoked_entries() -> list[dict[str, Any]]:
    raw = _revoked_store().get("entries")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        fp = str(item.get("fingerprint") or "").strip().lower()
        if len(fp) == 16 and all(c in "0123456789abcdef" for c in fp):
            out.append(item)
    return out


def _is_fingerprint_revoked(fingerprint: str) -> bool:
    fp = (fingerprint or "").strip().lower()
    if not fp:
        return False
    for item in _revoked_entries():
        if str(item.get("fingerprint") or "").strip().lower() == fp:
            return True
    return False


def _save_revoked_entries(entries: list[dict[str, Any]]) -> None:
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for item in entries:
        fp = str(item.get("fingerprint") or "").strip().lower()
        if len(fp) != 16 or fp in seen:
            continue
        seen.add(fp)
        normalized.append(
            {
                "fingerprint": fp,
                "subject": str(item.get("subject") or "")[:200],
                "expires_at": item.get("expires_at"),
                "revoked_at": item.get("revoked_at")
                or datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "reason": str(item.get("reason") or "")[:500],
            }
        )
    set_setting(SETTING_REVOKED, {"entries": normalized})


def _append_revoked_entry(
    *,
    fingerprint: str,
    subject: str = "",
    expires_at: str | None = None,
    reason: str = "",
) -> None:
    fp = fingerprint.strip().lower()
    if len(fp) != 16:
        raise ValueError("Invalid license fingerprint (expected 16 hex characters).")
    entries = [e for e in _revoked_entries() if str(e.get("fingerprint") or "").lower() != fp]
    entries.append(
        {
            "fingerprint": fp,
            "subject": (subject or "").strip()[:200],
            "expires_at": expires_at,
            "revoked_at": datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "reason": (reason or "").strip()[:500],
        }
    )
    _save_revoked_entries(entries)


def revoke_license_fingerprint(
    fingerprint: str,
    *,
    subject: str = "",
    expires_at: str | None = None,
    reason: str = "",
) -> None:
    _append_revoked_entry(
        fingerprint=fingerprint,
        subject=subject,
        expires_at=expires_at,
        reason=reason,
    )


def revoke_license_key(key: str, *, reason: str = "") -> dict[str, Any]:
    fp = license_key_fingerprint(key)
    if not fp:
        raise ValueError("License key is required.")
    if _is_fingerprint_revoked(fp):
        return {"fingerprint": fp, "already_revoked": True}
    state, err = verify_license_key_crypto(key)
    subject = ""
    expires_at = None
    if state:
        subject = str(state.get("subject") or "")
        expires_at = state.get("expires_at")
    elif err and "revoked" in err.lower():
        return {"fingerprint": fp, "already_revoked": True}
    elif err and not (key or "").strip().startswith(f"{LICENSE_PREFIX}."):
        raise ValueError(err)
    _append_revoked_entry(
        fingerprint=fp,
        subject=subject,
        expires_at=expires_at,
        reason=reason,
    )
    out: dict[str, Any] = {"fingerprint": fp, "already_revoked": False}
    if state:
        out.update(state)
    return out


def revoke_current_license(*, reason: str = "") -> dict[str, Any] | None:
    persisted = _raw_persisted_license()
    key = _extract_stored_license_key(persisted)
    if not key:
        return None
    info = revoke_license_key(key, reason=reason)
    clear_license()
    return info


def import_revoked_entries(entries: list[dict[str, Any]]) -> int:
    """Merge vendor revocation records. Returns number of new fingerprints added."""
    if not isinstance(entries, list):
        return 0
    existing = {str(e.get("fingerprint") or "").lower() for e in _revoked_entries()}
    merged = list(_revoked_entries())
    added = 0
    for item in entries:
        if not isinstance(item, dict):
            continue
        fp = str(item.get("fingerprint") or "").strip().lower()
        if len(fp) != 16 or fp in existing:
            continue
        merged.append(item)
        existing.add(fp)
        added += 1
    if added:
        _save_revoked_entries(merged)
    return added


def list_revoked_for_api() -> list[dict[str, Any]]:
    return [
        {
            "fingerprint": str(e.get("fingerprint") or ""),
            "subject": e.get("subject") or "",
            "expires_at": e.get("expires_at"),
            "revoked_at": e.get("revoked_at"),
            "reason": e.get("reason") or "",
        }
        for e in _revoked_entries()
    ]


# --- Encrypted storage of activated key (uses app SECRET_KEY; separate from Ed25519) ---

from cryptography.fernet import Fernet, InvalidToken  # noqa: E402


def _license_fernet() -> Fernet:
    pepper = (current_app.config.get("SECRET_KEY") or os.environ.get("SECRET_KEY") or "dev").encode()
    digest = hashlib.sha256(pepper + b":firmgate-license-seal-v1").digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _seal_license_key(key: str) -> str:
    return _license_fernet().encrypt(key.encode("utf-8")).decode("ascii")


def _unseal_license_key(token: str) -> str | None:
    try:
        return _license_fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, TypeError):
        return None


def _raw_persisted_license() -> dict[str, Any]:
    v = get_setting(SETTING_KEY, default={}) or {}
    return v if isinstance(v, dict) else {}


def _extract_stored_license_key(persisted: dict[str, Any]) -> str:
    sealed = persisted.get("license_key_sealed")
    if isinstance(sealed, str) and sealed.strip():
        key = _unseal_license_key(sealed.strip())
        if key:
            return key.strip()
    legacy = persisted.get("license_key")
    if isinstance(legacy, str) and legacy.strip():
        return legacy.strip()
    return ""


def _persist_from_verified(key: str, verified: dict[str, Any]) -> dict[str, Any]:
    return {
        "license_key_sealed": _seal_license_key(key),
        "subject": verified.get("subject") or "",
        "expires_at": verified.get("expires_at"),
        "applied_at": verified.get("applied_at"),
        "key_fingerprint": verified.get("key_fingerprint"),
    }


def sanitize_license_setting_value(value: Any) -> dict[str, Any]:
    if value is None:
        return {"valid": False, "features": []}
    if not isinstance(value, dict):
        return {"valid": False, "features": []}
    if value.get("valid") is False and not value.get("license_key_sealed") and not value.get("license_key"):
        return {"valid": False, "features": []}
    key = ""
    if isinstance(value.get("license_key"), str):
        key = value["license_key"].strip()
    elif isinstance(value.get("license_key_sealed"), str):
        key = _extract_stored_license_key(value)
    if not key:
        return {"valid": False, "features": []}
    verified, err = verify_license_key(key)
    if err or not verified:
        return {"valid": False, "features": []}
    assert verified is not None
    return _persist_from_verified(key, verified)


def _resolve_verified_license() -> dict[str, Any] | None:
    persisted = _raw_persisted_license()
    key = _extract_stored_license_key(persisted)
    if not key:
        return None
    verified, err = verify_license_key(key)
    if err or not verified:
        if persisted.get("license_key_sealed") or persisted.get("license_key"):
            log.warning("Enterprise license in database failed verification: %s", err or "invalid")
        return None
    if not persisted.get("license_key_sealed"):
        try:
            set_setting(SETTING_KEY, _persist_from_verified(key, verified))
        except Exception:
            pass
    return verified


def license_state() -> dict[str, Any]:
    verified = _resolve_verified_license()
    persisted = _raw_persisted_license()
    if verified:
        return {**persisted, **verified, "valid": True}
    return {
        "valid": False,
        "features": [],
        "subject": persisted.get("subject") or "",
        "expires_at": persisted.get("expires_at"),
        "applied_at": persisted.get("applied_at"),
        "key_fingerprint": persisted.get("key_fingerprint"),
    }


def _expired_from_expires_at(expires_at: Any) -> bool:
    if not expires_at:
        return False
    exp_date, exp_err = _parse_expiry(expires_at)
    if exp_err or not exp_date:
        return False
    return exp_date < datetime.now(timezone.utc).date()


def licensed_features() -> set[str]:
    verified = _resolve_verified_license()
    if not verified:
        return set()
    raw = verified.get("features") or []
    if not isinstance(raw, list):
        return set()
    return {str(x).strip() for x in raw if str(x).strip() in ALL_FEATURES}


def feature_enabled(feature: str) -> bool:
    return str(feature or "").strip() in licensed_features()


def sync_enterprise_modules_for_license(*, initial_activate: bool = False) -> None:
    """Align Administration → Modules with the active enterprise license."""
    _enable_licensed_enterprise_modules(initial_activate=initial_activate)


def _enable_licensed_enterprise_modules(*, initial_activate: bool = False) -> None:
    """Turn on CE enterprise nav modules that the active license unlocks."""
    from app.community_edition import (
        ENTERPRISE_MODULE_LICENSE_FEATURES,
        apply_community_module_policy,
        is_community_edition,
    )

    if not is_community_edition():
        return
    cfg = get_setting("modules", default={}) or {}
    mods = cfg.get("modules") if isinstance(cfg, dict) else None
    if not isinstance(mods, dict):
        mods = {}
    changed = False
    licensed_mod_keys: set[str] = set()
    for mod_key, feat in ENTERPRISE_MODULE_LICENSE_FEATURES.items():
        if feature_enabled(feat):
            licensed_mod_keys.add(mod_key)
    if feature_enabled(FEATURE_AI_DOCUMENT_SEARCH):
        licensed_mod_keys.add("ai_chatbot")
    if feature_enabled(FEATURE_AI_POLICY_ASSISTANT) or feature_enabled(FEATURE_AI_DOCUMENT_SEARCH):
        licensed_mod_keys.add("ai_policy_assistant")
    if feature_enabled(FEATURE_AI_CV_BUILDER) or feature_enabled(FEATURE_AI_DOCUMENT_SEARCH):
        licensed_mod_keys.add("ai_cv_builder")
    if feature_enabled(FEATURE_AI_TENDER_ASSISTANT) or feature_enabled(FEATURE_AI_DOCUMENT_SEARCH):
        licensed_mod_keys.add("ai_tender_assistant")
    if crm_licensed():
        licensed_mod_keys.add("crm")
    if resource_pool_licensed():
        licensed_mod_keys.add("resource_pool")
    if resource_calculator_licensed():
        licensed_mod_keys.add("resource_calculator")
    if security_clearance_licensed():
        licensed_mod_keys.add("security_clearance")
    if feature_enabled(FEATURE_SECURITY_OFFICER) or feature_enabled(FEATURE_SECURITY_OFFICER_EXPORT):
        licensed_mod_keys.add("security_officer")
    if timesheets_licensed():
        licensed_mod_keys.add("timesheets")
        licensed_mod_keys.add("timesheets_collection")
    for mod_key in licensed_mod_keys:
        row = mods.get(mod_key) if isinstance(mods.get(mod_key), dict) else {}
        if not initial_activate and mod_key in mods and row.get("enabled") is not None:
            continue
        mods[mod_key] = {
            "enabled": True,
            "restricted": bool(row.get("restricted")),
            "allowed_user_ids": row.get("allowed_user_ids") if isinstance(row.get("allowed_user_ids"), list) else [],
        }
        changed = True
    if changed:
        set_setting("modules", {"modules": apply_community_module_policy(mods)})


def apply_license_key(key: str) -> tuple[dict[str, Any] | None, str]:
    state, err = verify_license_key(key)
    if err:
        return None, err
    assert state is not None
    set_setting(SETTING_KEY, _persist_from_verified(key.strip(), state))
    sync_enterprise_modules_for_license(initial_activate=True)
    return license_state(), ""


def clear_license() -> None:
    set_setting(SETTING_KEY, {"valid": False, "features": []})


def premium_required(feature: str) -> tuple[bool, str]:
    if not license_verification_configured():
        return False, "Enterprise license verification is not configured on this server."
    if feature_enabled(feature):
        return True, ""
    label = FEATURE_LABELS.get(feature, feature)
    return False, f"Enterprise feature not licensed: {label}."


def status_for_api() -> dict[str, Any]:
    feats = licensed_features()
    st = license_state()
    revoked = list_revoked_for_api()
    expired = _expired_from_expires_at(st.get("expires_at"))
    return {
        "valid": bool(st.get("valid")) and bool(feats),
        "expired": expired,
        "features": sorted(feats),
        "feature_labels": {k: FEATURE_LABELS.get(k, k) for k in sorted(ALL_FEATURES)},
        "enabled": {k: k in feats for k in sorted(ALL_FEATURES)},
        "ai_enterprise_features": sorted(AI_ENTERPRISE_FEATURES),
        "ai_enterprise_licensed": ai_enterprise_licensed(),
        "enterprise_intranet_licensed": enterprise_intranet_modules_licensed(),
        "subject": st.get("subject") or "",
        "expires_at": st.get("expires_at"),
        "applied_at": st.get("applied_at"),
        "key_fingerprint": st.get("key_fingerprint"),
        "verification_configured": license_verification_configured(),
        "license_format": LICENSE_PREFIX,
        "revoked_count": len(revoked),
        "revoked": revoked,
    }


def warn_if_license_verification_missing() -> None:
    if license_verification_configured():
        return
    log.warning(
        "Enterprise license public key is missing. "
        "Ship app/enterprise_license_public.b64 or set FIRMGATE_LICENSE_PUBLIC_KEY."
    )


warn_if_license_secret_missing = warn_if_license_verification_missing
