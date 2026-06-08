"""Community Edition — no commercial licensing in this release."""

from __future__ import annotations

from typing import Any

SETTING_KEY = "premium_license"
SETTING_REVOKED = "premium_license_revoked"


def license_verification_configured() -> bool:
    return False


def license_state() -> dict[str, Any]:
    return {"valid": False, "features": []}


def licensed_features() -> set[str]:
    return set()


def feature_enabled(_feature: str) -> bool:
    return False


def premium_required(_feature: str) -> tuple[bool, str]:
    return False, ""


def premium_required_ai(_feature: str) -> tuple[bool, str]:
    return premium_required(_feature)


def sync_modules_for_license(*, initial_activate: bool = False) -> None:
    return None


def status_for_api() -> dict[str, Any]:
    return {
        "valid": False,
        "features": [],
        "community_edition": True,
        "verification_configured": False,
    }


def apply_license_key(_key: str) -> tuple[dict[str, Any] | None, str]:
    return None, "Not available in this edition."


def clear_license() -> None:
    return None


def verify_license_key(_key: str) -> tuple[dict[str, Any] | None, str]:
    return None, "Not available in this edition."


def warn_if_license_verification_missing() -> None:
    return None


def sanitize_license_setting_value(value: Any) -> dict[str, Any]:
    return {"valid": False, "features": []}
