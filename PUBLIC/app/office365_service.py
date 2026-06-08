"""Microsoft Graph helpers for Office 365 document editing."""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from app.settings import get_setting

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
TOKEN_URL_TEMPLATE = "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"

_token_cache: dict[str, dict[str, Any]] = {}


def office365_cfg() -> dict[str, Any]:
    v = get_setting("office365", default={}) or {}
    staging = (v.get("staging_folder") or "FirmgateEdits").strip().strip("/")
    return {
        "tenant_id": (v.get("tenant_id") or "").strip(),
        "client_id": (v.get("client_id") or "").strip(),
        "client_secret": (v.get("client_secret") or "").strip(),
        "site_hostname": (v.get("site_hostname") or "").strip(),
        "site_path": (v.get("site_path") or "").strip().strip("/"),
        "drive_id": (v.get("drive_id") or "").strip(),
        "staging_folder": staging or "FirmgateEdits",
        "skip_tls_verify": bool(v.get("skip_tls_verify")),
    }


def office365_settings_configured() -> bool:
    c = office365_cfg()
    return bool(c["tenant_id"] and c["client_id"] and c["client_secret"] and c["site_hostname"])


def _ssl_context(*, skip_verify: bool) -> ssl.SSLContext | None:
    if not skip_verify:
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _graph_open_kw(*, skip_verify: bool) -> dict[str, Any]:
    kw: dict[str, Any] = {"timeout": 60}
    ctx = _ssl_context(skip_verify=skip_verify)
    if ctx is not None:
        kw["context"] = ctx
    return kw


def _request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    skip_verify: bool = False,
) -> tuple[int, dict[str, Any] | list[Any] | None, str]:
    hdrs = {"User-Agent": "FirmgateOffice365/1.0", "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=body, method=method.upper(), headers=hdrs)
    try:
        with urllib.request.urlopen(req, **_graph_open_kw(skip_verify=skip_verify)) as resp:
            raw = resp.read()
            text = raw.decode("utf-8", errors="replace") if raw else ""
            if not text.strip():
                return int(getattr(resp, "status", 200)), None, ""
            try:
                return int(getattr(resp, "status", 200)), json.loads(text), text
            except json.JSONDecodeError:
                return int(getattr(resp, "status", 200)), None, text
    except urllib.error.HTTPError as e:
        raw = e.read()
        text = raw.decode("utf-8", errors="replace") if raw else str(e)
        try:
            payload = json.loads(text) if text.strip() else None
        except json.JSONDecodeError:
            payload = None
        return int(e.code), payload if isinstance(payload, (dict, list)) else None, text


def _request_bytes(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    skip_verify: bool = False,
) -> tuple[int, bytes, str]:
    hdrs = {"User-Agent": "FirmgateOffice365/1.0"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=body, method=method.upper(), headers=hdrs)
    try:
        with urllib.request.urlopen(req, **_graph_open_kw(skip_verify=skip_verify)) as resp:
            return int(getattr(resp, "status", 200)), resp.read(), ""
    except urllib.error.HTTPError as e:
        raw = e.read()
        text = raw.decode("utf-8", errors="replace") if raw else str(e)
        return int(e.code), raw or b"", text


def _graph_error_message(payload: dict[str, Any] | list[Any] | None, fallback: str) -> str:
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or err.get("code")
            if msg:
                return str(msg)
    return fallback


def get_access_token(*, skip_verify: bool | None = None) -> str:
    c = office365_cfg()
    if not office365_settings_configured():
        raise RuntimeError("Office 365 integration is not fully configured")

    if skip_verify is None:
        skip_verify = c["skip_tls_verify"]

    cache_key = f"{c['tenant_id']}:{c['client_id']}"
    now = time.time()
    cached = _token_cache.get(cache_key)
    if cached and float(cached.get("expires_at") or 0) > now + 60:
        return str(cached["token"])

    token_url = TOKEN_URL_TEMPLATE.format(tenant_id=urllib.parse.quote(c["tenant_id"], safe=""))
    form = urllib.parse.urlencode(
        {
            "client_id": c["client_id"],
            "client_secret": c["client_secret"],
            "scope": "https://graph.microsoft.com/.default",
            "grant_type": "client_credentials",
        }
    ).encode("utf-8")
    status, payload, text = _request_json(
        "POST",
        token_url,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=form,
        skip_verify=bool(skip_verify),
    )
    if status >= 400 or not isinstance(payload, dict) or not payload.get("access_token"):
        raise RuntimeError(_graph_error_message(payload, text or f"Token request failed ({status})"))

    token = str(payload["access_token"])
    expires_in = int(payload.get("expires_in") or 3600)
    _token_cache[cache_key] = {"token": token, "expires_at": now + expires_in}
    return token


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def resolve_drive_id(*, token: str, skip_verify: bool) -> tuple[str, str]:
    c = office365_cfg()
    if c["drive_id"]:
        url = f"{GRAPH_BASE}/drives/{urllib.parse.quote(c['drive_id'], safe='')}"
        status, payload, text = _request_json("GET", url, headers=_auth_headers(token), skip_verify=skip_verify)
        if status >= 400 or not isinstance(payload, dict):
            raise RuntimeError(_graph_error_message(payload, text or f"Could not read drive ({status})"))
        name = str(payload.get("name") or c["drive_id"])
        return str(payload.get("id") or c["drive_id"]), name

    hostname = c["site_hostname"]
    site_path = c["site_path"]
    if site_path:
        site_ref = f"{hostname}:/{site_path}:/"
    else:
        site_ref = f"{hostname}:/"
    site_url = f"{GRAPH_BASE}/sites/{urllib.parse.quote(site_ref, safe='')}:/drive"
    status, payload, text = _request_json("GET", site_url, headers=_auth_headers(token), skip_verify=skip_verify)
    if status >= 400 or not isinstance(payload, dict) or not payload.get("id"):
        raise RuntimeError(_graph_error_message(payload, text or f"Could not resolve SharePoint drive ({status})"))
    name = str(payload.get("name") or "SharePoint drive")
    return str(payload["id"]), name


def test_office365_connection() -> dict[str, Any]:
    c = office365_cfg()
    if not c["tenant_id"] or not c["client_id"]:
        return {"ok": False, "error": "Tenant ID and Client ID are required"}
    if not c["client_secret"]:
        return {"ok": False, "error": "Client secret is required (save a secret first)"}
    if not c["site_hostname"]:
        return {"ok": False, "error": "SharePoint site hostname is required (e.g. contoso.sharepoint.com)"}

    skip = c["skip_tls_verify"]
    try:
        token = get_access_token(skip_verify=skip)
    except Exception as e:
        return {"ok": False, "error": f"Could not obtain access token: {e}"}

    org_url = f"{GRAPH_BASE}/organization?$select=displayName"
    status, org_payload, org_text = _request_json("GET", org_url, headers=_auth_headers(token), skip_verify=skip)
    if status >= 400:
        return {"ok": False, "error": _graph_error_message(org_payload, org_text or f"Organization lookup failed ({status})")}

    org_name = ""
    if isinstance(org_payload, dict):
        values = org_payload.get("value")
        if isinstance(values, list) and values:
            org_name = str(values[0].get("displayName") or "")

    try:
        drive_id, drive_name = resolve_drive_id(token=token, skip_verify=skip)
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "hints": [
                "Ensure the Azure app registration has application permissions Files.ReadWrite.All and Sites.ReadWrite.All with admin consent.",
                "Verify SharePoint site hostname and site path (e.g. sites/YourSite).",
            ],
        }

    msg = f"Connected to {org_name or 'Microsoft 365'} — drive “{drive_name}” ({drive_id})."
    return {"ok": True, "message": msg, "drive_id": drive_id, "drive_name": drive_name}


def _safe_staging_name(filename: str) -> str:
    base = filename.replace("\\", "/").split("/")[-1] or "document.bin"
    safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in base)
    return safe[:180] or "document.bin"


def upload_for_edit_session(
    *,
    filename: str,
    content: bytes,
    session_key: str,
    mime_type: str | None = None,
) -> dict[str, str]:
    c = office365_cfg()
    skip = c["skip_tls_verify"]
    token = get_access_token(skip_verify=skip)
    drive_id, _ = resolve_drive_id(token=token, skip_verify=skip)

    staging = c["staging_folder"]
    safe_name = _safe_staging_name(filename)
    item_path = f"{staging}/{session_key}_{safe_name}"
    encoded_path = urllib.parse.quote(item_path, safe="/")
    upload_url = f"{GRAPH_BASE}/drives/{urllib.parse.quote(drive_id, safe='')}/root:/{encoded_path}:/content"

    headers = _auth_headers(token)
    headers["Content-Type"] = mime_type or "application/octet-stream"
    status, payload, text = _request_json(
        "PUT",
        upload_url,
        headers=headers,
        body=content,
        skip_verify=skip,
    )
    if status >= 400 or not isinstance(payload, dict) or not payload.get("id"):
        raise RuntimeError(_graph_error_message(payload, text or f"Upload failed ({status})"))

    return {"drive_id": drive_id, "item_id": str(payload["id"]), "item_path": item_path}


def create_office_link(*, drive_id: str, item_id: str, edit: bool = True) -> str:
    c = office365_cfg()
    skip = c["skip_tls_verify"]
    token = get_access_token(skip_verify=skip)
    link_url = (
        f"{GRAPH_BASE}/drives/{urllib.parse.quote(drive_id, safe='')}/items/"
        f"{urllib.parse.quote(item_id, safe='')}/createLink"
    )
    body = json.dumps({"type": "edit" if edit else "view", "scope": "organization"}).encode("utf-8")
    status, payload, text = _request_json(
        "POST",
        link_url,
        headers={**_auth_headers(token), "Content-Type": "application/json"},
        body=body,
        skip_verify=skip,
    )
    if status >= 400 or not isinstance(payload, dict):
        raise RuntimeError(_graph_error_message(payload, text or f"createLink failed ({status})"))
    link = payload.get("link")
    if isinstance(link, dict) and link.get("webUrl"):
        return str(link["webUrl"])
    raise RuntimeError("createLink did not return a webUrl")


def download_drive_item(*, drive_id: str, item_id: str) -> bytes:
    c = office365_cfg()
    skip = c["skip_tls_verify"]
    token = get_access_token(skip_verify=skip)
    url = (
        f"{GRAPH_BASE}/drives/{urllib.parse.quote(drive_id, safe='')}/items/"
        f"{urllib.parse.quote(item_id, safe='')}/content"
    )
    status, data, text = _request_bytes("GET", url, headers=_auth_headers(token), skip_verify=skip)
    if status >= 400:
        raise RuntimeError(text or f"Download failed ({status})")
    return data


def delete_drive_item(*, drive_id: str, item_id: str) -> None:
    c = office365_cfg()
    skip = c["skip_tls_verify"]
    token = get_access_token(skip_verify=skip)
    url = (
        f"{GRAPH_BASE}/drives/{urllib.parse.quote(drive_id, safe='')}/items/"
        f"{urllib.parse.quote(item_id, safe='')}"
    )
    _request_json("DELETE", url, headers=_auth_headers(token), skip_verify=skip)
