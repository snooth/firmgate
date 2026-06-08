"""Document editor provider (OnlyOffice) for Community Edition."""

from __future__ import annotations

import os
import urllib.parse
from typing import Any

from flask import current_app, redirect, request, url_for

from app.settings import get_setting, set_setting

PROVIDER_ONLYOFFICE = "onlyoffice"
VALID_PROVIDERS = frozenset({PROVIDER_ONLYOFFICE})


def get_document_editor_provider() -> str:
    return PROVIDER_ONLYOFFICE


def set_document_editor_provider(provider: str) -> None:
    set_setting("document_editor", {"provider": PROVIDER_ONLYOFFICE})


def onlyoffice_is_configured() -> bool:
    oo = get_setting("onlyoffice", default={}) or {}
    return bool((oo.get("url") or "").strip())


def is_document_editor_configured() -> bool:
    return onlyoffice_is_configured()


def document_editor_blueprint_prefix() -> str:
    return PROVIDER_ONLYOFFICE


def files_template_context() -> dict[str, str]:
    oo = get_setting("onlyoffice", default={}) or {}
    return {
        "onlyoffice_url": (oo.get("url") or ""),
        "document_editor_provider": PROVIDER_ONLYOFFICE,
        "document_editor_enabled": "1" if is_document_editor_configured() else "0",
    }


def document_editor_close_url(*, shell: str, node) -> str:
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
    oo = get_setting("onlyoffice", default={}) or {}
    base = (oo.get("app_url") or "").strip().rstrip("/")
    if not base:
        base = (current_app.config.get("ONLYOFFICE_APP_URL") or os.environ.get("ONLYOFFICE_APP_URL") or "").strip().rstrip("/")
    if not base:
        base = request.url_root.rstrip("/")
    return base


def redirect_with_query(endpoint: str, **values: Any):
    args = request.args.to_dict(flat=True)
    args.update(values)
    return redirect(url_for(endpoint, **args))
