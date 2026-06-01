"""Document editor provider (OnlyOffice vs Microsoft 365) and shared helpers."""

from __future__ import annotations

import os
import urllib.parse
from typing import Any

from flask import current_app, request, url_for

from app.settings import get_setting, set_setting

PROVIDER_ONLYOFFICE = "onlyoffice"
PROVIDER_OFFICE365 = "office365"
VALID_PROVIDERS = frozenset({PROVIDER_ONLYOFFICE, PROVIDER_OFFICE365})


def get_document_editor_provider() -> str:
    v = get_setting("document_editor", default={}) or {}
    p = (v.get("provider") or PROVIDER_ONLYOFFICE).strip().lower()
    return p if p in VALID_PROVIDERS else PROVIDER_ONLYOFFICE


def set_document_editor_provider(provider: str) -> None:
    p = (provider or PROVIDER_ONLYOFFICE).strip().lower()
    if p not in VALID_PROVIDERS:
        p = PROVIDER_ONLYOFFICE
    set_setting("document_editor", {"provider": p})


def onlyoffice_is_configured() -> bool:
    oo = get_setting("onlyoffice", default={}) or {}
    return bool((oo.get("url") or "").strip())


def office365_is_configured() -> bool:
    from app.office365_service import office365_settings_configured

    return office365_settings_configured()


def is_document_editor_configured() -> bool:
    provider = get_document_editor_provider()
    if provider == PROVIDER_OFFICE365:
        return office365_is_configured()
    return onlyoffice_is_configured()


def document_editor_blueprint_prefix() -> str:
    if get_document_editor_provider() == PROVIDER_OFFICE365:
        return PROVIDER_OFFICE365
    return PROVIDER_ONLYOFFICE


def files_template_context() -> dict[str, str]:
    oo = get_setting("onlyoffice", default={}) or {}
    provider = get_document_editor_provider()
    return {
        "onlyoffice_url": (oo.get("url") or ""),
        "document_editor_provider": provider,
        "document_editor_enabled": "1" if is_document_editor_configured() else "0",
    }


def document_editor_close_url(*, shell: str, node) -> str:
    """Documents/files listing URL to open after closing the editor."""
    return_parent_id = request.args.get("return_parent_id", type=int)
    if return_parent_id is None:
        return_parent_id = node.parent_id
    return_nav = (request.args.get("return_nav") or "").strip().lower()
    allowed_nav = frozenset({"personal", "favorites", "shares", "recycle", "admin"})
    if return_nav not in allowed_nav:
        return_nav = ""

    if shell == "intranet":
        close_url = url_for("intranet.documents_page")
    else:
        close_url = url_for("files.browser")

    params: list[tuple[str, str]] = []
    if return_parent_id is not None:
        params.append(("parent_id", str(int(return_parent_id))))
    if return_nav:
        params.append(("nav", return_nav))
    if params:
        close_url += "?" + urllib.parse.urlencode(params)
    return close_url


def document_editor_app_base_url() -> str:
    """Public base URL external services use to reach this app."""
    oo = get_setting("onlyoffice", default={}) or {}
    base = (oo.get("app_url") or "").strip().rstrip("/")
    if not base:
        base = (current_app.config.get("ONLYOFFICE_APP_URL") or os.environ.get("ONLYOFFICE_APP_URL") or "").strip().rstrip("/")
    if not base:
        base = request.url_root.rstrip("/")
    return base


def redirect_with_query(endpoint: str, **values: Any):
    from flask import redirect

    args = request.args.to_dict(flat=True)
    args.update(values)
    return redirect(url_for(endpoint, **args))
