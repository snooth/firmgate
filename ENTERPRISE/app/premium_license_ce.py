"""Community Edition stub — no enterprise license verification (PUBLIC export only)."""

from __future__ import annotations

from typing import Any

SETTING_KEY = "premium_license"
SETTING_REVOKED = "premium_license_revoked"
LICENSE_PREFIX = "FG2"

FEATURE_SELF_REGISTRATION = "self_registration"
FEATURE_OFFICE365 = "office365"
FEATURE_LDAP = "ldap"
FEATURE_SECURITY_OFFICER_EXPORT = "security_officer_export"
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

AI_ENTERPRISE_NAV_MODULES = frozenset(
    {
        FEATURE_AI_DOCUMENT_SEARCH,
        FEATURE_AI_CHATBOT,
        FEATURE_AI_POLICY_ASSISTANT,
        FEATURE_AI_CV_BUILDER,
        FEATURE_AI_TENDER_ASSISTANT,
    }
)

FEATURE_LABELS: dict[str, str] = {}


def license_verification_configured() -> bool:
    return False


def license_state() -> dict[str, Any]:
    return {"valid": False, "features": []}


def licensed_features() -> set[str]:
    return set()


def feature_enabled(_feature: str) -> bool:
    return False


def enterprise_license_applied() -> bool:
    return False


def ai_enterprise_licensed() -> bool:
    return False


def ai_nav_module_licensed(_module_key: str) -> bool:
    return False


def ai_document_search_licensed() -> bool:
    return False


def ai_chatbot_licensed() -> bool:
    return False


def ai_policy_assistant_licensed() -> bool:
    return False


def ai_cv_builder_licensed() -> bool:
    return False


def ai_tender_assistant_licensed() -> bool:
    return False


def crm_licensed() -> bool:
    return False


def resource_pool_licensed() -> bool:
    return False


def resource_calculator_licensed() -> bool:
    return False


def security_clearance_licensed() -> bool:
    return False


def timesheets_licensed() -> bool:
    return False


def premium_required(_feature: str) -> tuple[bool, str]:
    return False, "Enterprise features are not available in Community Edition."


def premium_required_ai(_feature: str) -> tuple[bool, str]:
    return premium_required(_feature)


def sync_enterprise_modules_for_license(*, initial_activate: bool = False) -> None:
    return None


def status_for_api() -> dict[str, Any]:
    return {
        "valid": False,
        "features": [],
        "community_edition": True,
        "verification_configured": False,
    }


def apply_license_key(_key: str) -> tuple[dict[str, Any] | None, str]:
    return None, "Enterprise licensing is not included in Community Edition."


def clear_license() -> None:
    return None


def verify_license_key(_key: str) -> tuple[dict[str, Any] | None, str]:
    return None, "Enterprise licensing is not included in Community Edition."


def warn_if_license_verification_missing() -> None:
    return None


def sanitize_license_setting_value(value: Any) -> dict[str, Any]:
    return {"valid": False, "features": []}
