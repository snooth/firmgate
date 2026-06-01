from __future__ import annotations

import json
import os
import re
import secrets
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from flask import Blueprint, abort, current_app, jsonify, render_template, request, url_for
from flask_login import current_user, login_required
from itsdangerous import BadSignature, TimestampSigner

from app import access
from app.intranet_bp import _nav as intranet_nav
from app.extensions import db
from app.file_storage import store_stream_and_digest
from app.models import FileNode, FileVersion, utcnow
from app.document_editor_settings import PROVIDER_OFFICE365, get_document_editor_provider, redirect_with_query
from app.settings import get_setting


bp = Blueprint("onlyoffice", __name__, url_prefix="/onlyoffice")

# Presentation / slideshow formats: fit zoom + optional StartSlideShow for Security Training embeds.
_SLIDE_EXT = frozenset({"ppt", "pptx", "odp", "pps", "ppsx", "ppsm", "pptm", "pot", "potx", "potm"})


def _signer() -> TimestampSigner:
    secret = current_app.config.get("SECRET_KEY") or "onlyoffice"
    return TimestampSigner(str(secret))


def _signed_token(node_id: int, user_id: int, *, version_id: int | None = None) -> str:
    payload: dict[str, Any] = {"node_id": node_id, "user_id": user_id}
    if version_id is not None:
        payload["version_id"] = int(version_id)
    return _signer().sign(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("utf-8")


def _unsign_token(token: str, max_age_s: int) -> dict[str, Any] | None:
    try:
        raw = _signer().unsign(token.encode("utf-8"), max_age=max_age_s)
    except BadSignature:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def _onlyoffice_cfg() -> dict[str, Any]:
    v = get_setting("onlyoffice", default={}) or {}
    return {
        "url": (v.get("url") or "").rstrip("/"),
        "jwt_secret": (v.get("jwt_secret") or ""),
        "app_url": (v.get("app_url") or "").rstrip("/"),
        "skip_tls_verify": bool(v.get("skip_tls_verify")),
    }


def _onlyoffice_ssl_context() -> ssl.SSLContext | None:
    if not _onlyoffice_cfg().get("skip_tls_verify"):
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


_PRIVATE_DOWNLOAD_HOST = re.compile(
    r"^(localhost|127\.0\.0\.1|onlyoffice|documentserver|host\.docker\.internal)(:\d+)?$",
    re.I,
)


def _onlyoffice_public_download_url(download_url: str) -> str | None:
    """If DS returned a private/docker host, rewrite to the configured Document Server URL."""
    public = (_onlyoffice_cfg().get("url") or "").strip().rstrip("/")
    if not public or not download_url:
        return None
    try:
        u = urllib.parse.urlparse(download_url)
        host = (u.hostname or "").lower()
        if not host or not _PRIVATE_DOWNLOAD_HOST.match(host + (f":{u.port}" if u.port else "")):
            # Also rewrite bare docker bridge IPs when public URL is explicit.
            if not re.match(r"^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.", host):
                return None
        p = urllib.parse.urlparse(public)
        rewritten = urllib.parse.urlunparse((p.scheme, p.netloc, u.path, u.params, u.query, u.fragment))
        return rewritten if rewritten != download_url else None
    except Exception:
        return None


def _onlyoffice_download_url_candidates(download_url: str) -> list[str]:
    """Try the URL from the callback first, then an optional public rewrite."""
    out: list[str] = []
    if download_url:
        out.append(download_url)
    alt = _onlyoffice_public_download_url(download_url)
    if alt and alt not in out:
        out.append(alt)
    return out


def _onlyoffice_close_url(*, shell: str, node: FileNode) -> str:
    """Documents/files listing URL to open after closing the editor (same folder as the file)."""
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


def _onlyoffice_app_base_url() -> str:
    """URL Document Server uses to call back into this app (must be reachable from DS)."""
    cfg = _onlyoffice_cfg()
    base = (cfg.get("app_url") or "").strip().rstrip("/")
    if not base:
        base = (current_app.config.get("ONLYOFFICE_APP_URL") or os.environ.get("ONLYOFFICE_APP_URL") or "").strip().rstrip("/")
    if not base:
        base = request.url_root.rstrip("/")
    return base


def _onlyoffice_bearer_tokens(download_url: str, secret: str) -> list[str]:
    """Build JWT variants (plain and payload-wrapped) accepted by different Document Server builds."""
    out: list[str] = []
    for claims in ({"url": download_url}, {"payload": {"url": download_url}}):
        tok = jwt.encode(claims, secret, algorithm="HS256")
        if isinstance(tok, bytes):
            tok = tok.decode("utf-8", errors="ignore")
        if tok and tok not in out:
            out.append(tok)
    return out


def _open_onlyoffice_saved_file(download_url: str):
    """Download saved bytes from Document Server (JWT + TLS options when configured)."""
    cfg = _onlyoffice_cfg()
    secret = (cfg.get("jwt_secret") or "").strip()
    open_kw: dict[str, Any] = {"timeout": 300}
    ctx = _onlyoffice_ssl_context()
    if ctx is not None:
        open_kw["context"] = ctx

    last_err: Exception | None = None
    for url in _onlyoffice_download_url_candidates(download_url):
        header_sets: list[dict[str, str]] = [{"User-Agent": "FirmgateOnlyOffice/1.0"}]
        for tok in _onlyoffice_bearer_tokens(url, secret) if secret else []:
            header_sets.append(
                {"User-Agent": "FirmgateOnlyOffice/1.0", "Authorization": f"Bearer {tok}"}
            )
        for headers in header_sets:
            try:
                return urllib.request.urlopen(urllib.request.Request(url, headers=headers), **open_kw)
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code not in (401, 403):
                    current_app.logger.warning(
                        "onlyoffice download HTTP %s url_host=%s",
                        e.code,
                        urllib.parse.urlparse(url).netloc or "?",
                    )
                    break
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_err = e
                current_app.logger.warning(
                    "onlyoffice download failed url_host=%s err=%s",
                    urllib.parse.urlparse(url).netloc or "?",
                    e,
                )
                break
    if last_err:
        raise last_err
    raise RuntimeError("onlyoffice download failed")


def _node_or_404(node_id: int) -> FileNode:
    node = db.session.get(FileNode, node_id)
    if not node:
        abort(404)
    return node


def _document_session_key(node_id: int) -> str:
    """Unique per editor open; OnlyOffice must not reuse keys across sessions."""
    return f"{node_id}-{secrets.token_hex(16)}"


def _apply_onlyoffice_save_to_version(
    fv: FileVersion,
    node: FileNode,
    *,
    user_id: int,
    download_url: str,
    original_name: str,
) -> bool:
    """Persist Document Server output onto an existing version row (same version id for the session)."""
    log = current_app.logger
    try:
        with _open_onlyoffice_saved_file(download_url) as resp:
            relpath, size, sha256, mime = store_stream_and_digest(resp, original_name)
    except Exception:
        log.exception(
            "onlyoffice callback download failed node_id=%s url_host=%s",
            node.id,
            urllib.parse.urlparse(download_url).netloc or "?",
        )
        return False

    fv.storage_relpath = relpath
    fv.size_bytes = size
    fv.sha256 = sha256
    if mime:
        fv.mime_type = mime
    fv.is_current = True
    db.session.query(FileVersion).filter(
        FileVersion.file_node_id == node.id,
        FileVersion.id != fv.id,
    ).update({"is_current": False}, synchronize_session=False)
    node.updated_at = utcnow()
    db.session.commit()
    return True


@bp.route("/editor/<int:node_id>")
@login_required
def editor(node_id: int):
    if get_document_editor_provider() == PROVIDER_OFFICE365:
        return redirect_with_query("office365.editor", node_id=node_id)

    cfg = _onlyoffice_cfg()
    if not cfg["url"]:
        abort(404)

    node = _node_or_404(node_id)
    if node.is_folder:
        abort(400)
    ok, _ = access.can_access_node(current_user, node, "read")
    if not ok:
        abort(403)
    can_edit, _ = access.can_access_node(current_user, node, "write")

    cur = (
        db.session.query(FileVersion)
        .filter_by(file_node_id=node.id, is_current=True)
        .order_by(FileVersion.version_number.desc())
        .first()
    )
    if not cur:
        abort(404)

    # Pin version_id in the signed token so /file serves immutable bytes for this session.
    # (Serving "current" after an autosave callback changes the file under the same key and
    # triggers OnlyOffice "Version changed" / reload, which can discard in-progress edits.)
    token = _signed_token(node.id, current_user.id, version_id=cur.id)
    token_q = urllib.parse.quote(token, safe="")
    base_app = _onlyoffice_app_base_url()
    file_url = base_app + f"/onlyoffice/file/{node.id}?token={token_q}"
    callback_url = base_app + f"/onlyoffice/callback/{node.id}?token={token_q}"

    ext = (node.name.rsplit(".", 1)[-1] if "." in node.name else "").lower()
    # OnlyOffice requires `document.key` to match pattern `0-9-.a-zA-Z_=` (no colon).
    key = _document_session_key(node.id)

    doc_cfg = {
        "document": {
            "fileType": ext,
            "key": key,
            "title": node.name,
            "url": file_url,
            "permissions": {
                "edit": bool(can_edit),
                "download": True,
                "print": True,
                "comment": True,
                "review": bool(can_edit),
            },
        },
        # OnlyOffice 6.1+: use "slide" (not deprecated "presentation").
        "documentType": "text"
        if ext in ("doc", "docx", "odt", "rtf", "txt")
        else "spreadsheet"
        if ext in ("xls", "xlsx", "ods", "csv")
        else "slide",
        "editorConfig": {
            "callbackUrl": callback_url,
            "mode": "edit" if can_edit else "view",
            "user": {"id": str(current_user.id), "name": current_user.username},
        },
    }

    # Optional query overrides (used by in-app embeds like Security Training)
    force_view = (request.args.get("view") or "").strip().lower() in ("1", "true", "yes", "view")
    slideshow = (request.args.get("slideshow") or "").strip().lower() in ("1", "true", "yes")
    embed = (request.args.get("embed") or "").strip().lower() in ("1", "true", "yes")
    if force_view:
        doc_cfg["editorConfig"]["mode"] = "view"
        try:
            doc_cfg["document"]["permissions"]["edit"] = False
            doc_cfg["document"]["permissions"]["review"] = False
        except Exception:
            pass
    elif can_edit:
        doc_cfg.setdefault("editorConfig", {}).setdefault("customization", {})["forcesave"] = True
    if slideshow:
        # Best-effort "presentation mode" UX: locked view mode + minimal chrome.
        doc_cfg["editorConfig"]["mode"] = "view"
        try:
            doc_cfg["document"]["permissions"]["edit"] = False
            doc_cfg["document"]["permissions"]["review"] = False
            doc_cfg["document"]["permissions"]["comment"] = False
        except Exception:
            pass
        try:
            custom = {
                "compactToolbar": True,
                "compactHeader": True,
                "hideRightMenu": True,
                "hideRulers": True,
                "toolbarNoTabs": True,
                "comments": False,
            }
            # Fit slide to the embed viewer (avoids tiny e.g. 5% zoom from saved local prefs).
            if ext in _SLIDE_EXT:
                custom["zoom"] = -1
            doc_cfg["editorConfig"]["customization"] = custom
        except Exception:
            pass

    if embed:
        ec = doc_cfg.setdefault("editorConfig", {})
        ec["type"] = "embedded"
        ec.setdefault("width", "100%")
        ec.setdefault("height", "100%")

    # If Document Server JWT is enabled, sign the config.
    # OnlyOffice expects a JWT token over the config payload in `token`.
    if cfg.get("jwt_secret"):
        token = jwt.encode(doc_cfg, cfg["jwt_secret"], algorithm="HS256")
        # pyjwt may return bytes in some environments
        if isinstance(token, bytes):
            token = token.decode("utf-8", errors="ignore")
        doc_cfg["token"] = token

    shell = (request.args.get("shell") or "").strip().lower()
    doc_title = node.name
    close_url = _onlyoffice_close_url(shell=shell, node=node)
    # StartSlideShow via Automation API connector (embed template); presentations only.
    slideshow_start = bool(slideshow and ext in _SLIDE_EXT)
    ctx = {
        "onlyoffice_url": cfg["url"],
        "doc_config": json.dumps(doc_cfg),
        "doc_title": doc_title,
        "close_url": close_url,
        "onlyoffice_force_view": bool(force_view),
        "onlyoffice_slideshow": bool(slideshow),
        "onlyoffice_slideshow_start": slideshow_start,
    }
    if embed:
        return render_template("onlyoffice_embed.html", **ctx)
    if shell == "intranet":
        ctx["nav"] = intranet_nav("documents")
        ctx["q"] = (request.args.get("q") or "").strip()
        return render_template("onlyoffice_editor_intranet.html", **ctx)
    return render_template("onlyoffice_editor.html", **ctx)


@bp.route("/file/<int:node_id>")
def file(node_id: int):
    cfg = _onlyoffice_cfg()
    if not cfg["url"]:
        abort(404)
    token = request.args.get("token") or ""
    payload = _unsign_token(token, max_age_s=60 * 60)
    if not payload or payload.get("node_id") != node_id:
        abort(403)

    node = _node_or_404(node_id)
    if node.is_folder:
        abort(400)
    # OnlyOffice Document Server fetches this URL server-to-server (no user session cookies).
    # Treat a valid signed token as sufficient authorization to fetch the document bytes.

    version_id = payload.get("version_id")
    if version_id is not None:
        try:
            version_id = int(version_id)
        except (TypeError, ValueError):
            version_id = None
    if version_id:
        cur = db.session.get(FileVersion, version_id)
        if not cur or cur.file_node_id != node.id:
            abort(404)
    else:
        cur = (
            db.session.query(FileVersion)
            .filter_by(file_node_id=node.id, is_current=True)
            .order_by(FileVersion.version_number.desc())
            .first()
        )
    if not cur:
        abort(404)
    from app.file_storage import absolute_path

    p = absolute_path(cur.storage_relpath)
    resp = current_app.response_class(p.read_bytes(), mimetype=cur.mime_type or "application/octet-stream")
    resp.headers["Content-Disposition"] = f'inline; filename="{node.name}"'
    return resp


@bp.route("/callback/<int:node_id>", methods=["POST"])
def callback(node_id: int):
    # OnlyOffice calls this server-to-server; we authenticate via signed token in query string.
    token = request.args.get("token") or ""
    payload = _unsign_token(token, max_age_s=60 * 60 * 6)
    if not payload or payload.get("node_id") != node_id:
        return jsonify({"error": "forbidden"}), 403

    body = request.get_json(force=True, silent=True) or {}
    status = body.get("status")
    try:
        status = int(status)
    except (TypeError, ValueError):
        status = None

    log = current_app.logger
    log.warning(
        "onlyoffice callback node_id=%s status=%s has_url=%s",
        node_id,
        status,
        bool(body.get("url")),
    )

    # 2 = ready to save, 3 = save error on DS side, 6/7 = force save; 4 = closed unchanged
    if status == 4:
        return jsonify({"error": 0})
    if status == 3:
        log.error("onlyoffice callback node_id=%s document server reported save error (status 3)", node_id)
        return jsonify({"error": 0})
    if status == 7:
        log.error("onlyoffice callback node_id=%s force-save error (status 7)", node_id)
        return jsonify({"error": 0})
    if status not in (2, 6):
        return jsonify({"error": 0})

    url = body.get("url")
    if not url:
        log.warning("onlyoffice callback node_id=%s status=%s missing url", node_id, status)
        return jsonify({"error": 0})

    node = _node_or_404(node_id)
    if node.is_folder:
        return jsonify({"error": 0})

    user_id = int(payload.get("user_id") or 0) or 1
    pin_version_id = payload.get("version_id")
    if pin_version_id is not None:
        try:
            pin_version_id = int(pin_version_id)
        except (TypeError, ValueError):
            pin_version_id = None

    if pin_version_id:
        fv = db.session.get(FileVersion, pin_version_id)
        if not fv or fv.file_node_id != node.id:
            return jsonify({"error": 1})
        ok = _apply_onlyoffice_save_to_version(
            fv,
            node,
            user_id=user_id,
            download_url=url,
            original_name=node.name,
        )
        if ok:
            log.warning("onlyoffice callback saved node_id=%s version_id=%s", node_id, pin_version_id)
        else:
            log.error("onlyoffice callback save failed node_id=%s version_id=%s", node_id, pin_version_id)
        return jsonify({"error": 0 if ok else 1})

    # Legacy callback tokens without version_id: append a new version row.
    try:
        with _open_onlyoffice_saved_file(url) as resp:
            relpath, size, sha256, mime = store_stream_and_digest(resp, node.name)
    except Exception:
        log.exception(
            "onlyoffice callback download failed node_id=%s url_host=%s",
            node.id,
            urllib.parse.urlparse(url).netloc or "?",
        )
        return jsonify({"error": 1})

    cur = (
        db.session.query(FileVersion)
        .filter_by(file_node_id=node.id, is_current=True)
        .order_by(FileVersion.version_number.desc())
        .first()
    )
    next_v = (cur.version_number + 1) if cur else 1
    if cur:
        cur.is_current = False
    fv = FileVersion(
        file_node_id=node.id,
        version_number=next_v,
        storage_relpath=relpath,
        size_bytes=size,
        sha256=sha256,
        mime_type=mime,
        created_at=utcnow(),
        created_by_id=user_id,
        is_current=True,
    )
    db.session.add(fv)
    node.updated_at = utcnow()
    db.session.commit()
    return jsonify({"error": 0})

