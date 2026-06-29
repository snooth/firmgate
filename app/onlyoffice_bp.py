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
from app.document_version_service import append_document_version
from app.file_storage import store_stream_and_digest
from app.models import FileNode, FileNodeEditSession, FileVersion, utcnow
from app.document_editor_settings import redirect_with_query
from app.settings import get_setting


bp = Blueprint("onlyoffice", __name__, url_prefix="/onlyoffice")

# Presentation / slideshow formats: fit zoom + optional StartSlideShow for Security Training embeds.
_SLIDE_EXT = frozenset({"ppt", "pptx", "odp", "pps", "ppsx", "ppsm", "pptm", "pot", "potx", "potm"})


def _signer() -> TimestampSigner:
    secret = current_app.config.get("SECRET_KEY") or "onlyoffice"
    return TimestampSigner(str(secret))


def _signed_token(
    node_id: int,
    user_id: int,
    *,
    version_id: int | None = None,
    review: bool = False,
) -> str:
    payload: dict[str, Any] = {"node_id": node_id, "user_id": user_id}
    if version_id is not None:
        payload["version_id"] = int(version_id)
    if review:
        payload["review"] = True
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


def _onlyoffice_review_doc_key(node_id: int, version_id: int) -> str:
    return f"{node_id}-{version_id}-review"


def _onlyoffice_view_doc_key(node_id: int, version_id: int, sha256: str) -> str:
    """View-only key tied to content so reopen after edits avoids Document Server cache clashes."""
    digest = (sha256 or "0").strip().lower()[:32]
    return f"{node_id}-{version_id}-{digest}"


def _resolve_onlyoffice_edit_doc_key(node: FileNode, version: FileVersion) -> str:
    """Stable key while editors are open; fresh key when a new editing session starts.

    OnlyOffice caches documents by key. Reusing the same key after saves (same version id,
    new bytes) triggers "Version changed" and can corrupt the file on reload.
    """
    from app.file_edit_session_service import SESSION_STALE_AFTER, _prune_stale_sessions

    _prune_stale_sessions()
    locked = db.session.query(FileNode).filter_by(id=int(node.id)).with_for_update().one()
    cutoff = utcnow() - SESSION_STALE_AFTER
    active_count = (
        db.session.query(FileNodeEditSession)
        .filter(
            FileNodeEditSession.file_node_id == locked.id,
            FileNodeEditSession.last_seen_at >= cutoff,
        )
        .count()
    )
    if active_count > 0 and locked.onlyoffice_doc_key:
        return locked.onlyoffice_doc_key

    key = f"{locked.id}-{version.id}-{secrets.token_hex(8)}"
    locked.onlyoffice_doc_key = key
    db.session.commit()
    return key


def _apply_onlyoffice_save_to_version(
    fv: FileVersion,
    node: FileNode,
    *,
    user_id: int,
    download_url: str,
    original_name: str,
) -> bool:
    """Persist Document Server output as a new version (prior versions kept)."""
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

    created, new_fv = append_document_version(
        node,
        user_id=user_id,
        relpath=relpath,
        size=size,
        sha256=sha256,
        mime=mime,
    )
    if created and new_fv:
        log.warning(
            "onlyoffice callback new version node_id=%s version_number=%s version_id=%s",
            node.id,
            new_fv.version_number,
            new_fv.id,
        )
    elif new_fv:
        log.warning(
            "onlyoffice callback unchanged node_id=%s version_number=%s",
            node.id,
            new_fv.version_number,
        )
    return new_fv is not None


@bp.route("/editor/<int:node_id>")
@login_required
def editor(node_id: int):
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

    from app.file_lock_service import get_lock_for_node

    lock_row = get_lock_for_node(node.id)
    locked_by_other = bool(
        lock_row and int(lock_row.locked_by_id) != int(current_user.id)
    )
    if locked_by_other:
        can_edit = False

    review_mode = (request.args.get("review") or "").strip().lower() in ("1", "true", "yes", "review")
    req_version_id = request.args.get("version_id", type=int)

    cur = (
        db.session.query(FileVersion)
        .filter_by(file_node_id=node.id, is_current=True)
        .order_by(FileVersion.version_number.desc())
        .first()
    )
    if not cur:
        abort(404)

    target_version = cur
    if req_version_id is not None:
        fv = db.session.get(FileVersion, int(req_version_id))
        if not fv or fv.file_node_id != node.id:
            abort(404)
        target_version = fv
        if not fv.is_current:
            review_mode = True

    if review_mode:
        ok_versions, _ = access.can_access_node(current_user, node, "versions")
        if not ok_versions:
            abort(403)
        can_edit = False

    editing_mode = bool(can_edit) and not review_mode
    if editing_mode:
        from app.file_edit_session_service import touch_edit_session

        touch_edit_session(node, current_user)

    # Pin version_id in the signed token so /file serves immutable bytes for this session.
    # (Serving "current" after an autosave callback changes the file under the same key and
    # triggers OnlyOffice "Version changed" / reload, which can discard in-progress edits.)
    token = _signed_token(
        node.id,
        current_user.id,
        version_id=target_version.id,
        review=review_mode,
    )
    token_q = urllib.parse.quote(token, safe="")
    base_app = _onlyoffice_app_base_url()
    file_url = base_app + f"/onlyoffice/file/{node.id}?token={token_q}"
    callback_url = base_app + f"/onlyoffice/callback/{node.id}?token={token_q}"

    ext = (node.name.rsplit(".", 1)[-1] if "." in node.name else "").lower()
    # OnlyOffice requires `document.key` to match pattern `0-9-.a-zA-Z_=` (no colon).
    # Edit sessions share one key until all editors close; view/review keys include content id.
    if review_mode:
        key = _onlyoffice_review_doc_key(node.id, target_version.id)
    elif editing_mode:
        key = _resolve_onlyoffice_edit_doc_key(node, target_version)
    else:
        key = _onlyoffice_view_doc_key(node.id, target_version.id, target_version.sha256)
    display_name = (current_user.full_name or current_user.username or f"User {current_user.id}").strip()
    doc_title = node.name
    if review_mode:
        doc_title = f"{node.name} — Previous version v{target_version.version_number}"

    doc_cfg = {
        "document": {
            "fileType": ext,
            "key": key,
            "title": doc_title,
            "url": file_url,
            "permissions": {
                "edit": bool(can_edit) and not review_mode,
                "download": True,
                "print": True,
                "comment": not review_mode,
                "review": bool(can_edit) and not review_mode,
            },
        },
        # OnlyOffice 6.1+: word / cell / slide (text / spreadsheet / presentation are deprecated).
        "documentType": "word"
        if ext in ("doc", "docx", "odt", "rtf", "txt")
        else "cell"
        if ext in ("xls", "xlsx", "xlsm", "xlsb", "ods", "csv")
        else "slide",
        "editorConfig": {
            "callbackUrl": callback_url,
            "mode": "edit" if can_edit else "view",
            "user": {"id": str(current_user.id), "name": display_name},
        },
    }

    # Optional query overrides (used by in-app embeds like Security Training)
    force_view = (request.args.get("view") or "").strip().lower() in ("1", "true", "yes", "view")
    slideshow = (request.args.get("slideshow") or "").strip().lower() in ("1", "true", "yes")
    embed = (request.args.get("embed") or "").strip().lower() in ("1", "true", "yes")
    if review_mode:
        force_view = True
    if force_view:
        doc_cfg["editorConfig"]["mode"] = "view"
        try:
            doc_cfg["document"]["permissions"]["edit"] = False
            doc_cfg["document"]["permissions"]["review"] = False
        except Exception:
            pass
    elif can_edit:
        ec = doc_cfg.setdefault("editorConfig", {})
        ec.setdefault("customization", {})["forcesave"] = True
        ec["coEditing"] = {"mode": "fast", "change": True}
    if review_mode:
        doc_cfg["document"]["info"] = {
            "owner": "Version history (read-only preview)",
            "uploaded": target_version.created_at.isoformat() if target_version.created_at else "",
        }
        try:
            doc_cfg["document"]["permissions"]["edit"] = False
            doc_cfg["document"]["permissions"]["review"] = False
            doc_cfg["document"]["permissions"]["comment"] = False
        except Exception:
            pass
        doc_cfg["editorConfig"]["mode"] = "view"
        doc_cfg["editorConfig"].pop("coEditing", None)
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
    close_url = _onlyoffice_close_url(shell=shell, node=node)
    # StartSlideShow via Automation API connector (embed template); presentations only.
    slideshow_start = bool(slideshow and ext in _SLIDE_EXT)
    ctx = {
        "onlyoffice_url": cfg["url"],
        "doc_config": json.dumps(doc_cfg),
        "doc_title": doc_title,
        "close_url": close_url,
        "onlyoffice_force_view": bool(force_view or locked_by_other or review_mode),
        "onlyoffice_slideshow": bool(slideshow),
        "onlyoffice_slideshow_start": slideshow_start,
        "onlyoffice_locked_by_other": locked_by_other,
        "onlyoffice_lock_holder": (
            (lock_row.locked_by.full_name or lock_row.locked_by.username)
            if locked_by_other and lock_row and lock_row.locked_by
            else None
        ),
        "onlyoffice_version_review": review_mode,
        "onlyoffice_version_number": target_version.version_number if review_mode else None,
        "onlyoffice_track_edit_session": doc_cfg.get("editorConfig", {}).get("mode") == "edit"
        and bool(doc_cfg.get("document", {}).get("permissions", {}).get("edit")),
        "onlyoffice_node_id": node.id,
        "files_api_base": url_for("files.api_list").rsplit("/api/list", 1)[0],
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

    if payload.get("review"):
        return jsonify({"error": 0})

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
    from app.file_lock_service import get_lock_for_node

    lock_row = get_lock_for_node(node.id)
    if lock_row and int(lock_row.locked_by_id) != user_id:
        log.warning("onlyoffice callback denied node_id=%s locked by %s", node_id, lock_row.locked_by_id)
        return jsonify({"error": 1})

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
            log.warning(
                "onlyoffice callback saved node_id=%s session_version_id=%s",
                node_id,
                pin_version_id,
            )
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

    created, new_fv = append_document_version(
        node,
        user_id=user_id,
        relpath=relpath,
        size=size,
        sha256=sha256,
        mime=mime,
    )
    if created and new_fv:
        log.warning(
            "onlyoffice callback legacy new version node_id=%s version_number=%s",
            node_id,
            new_fv.version_number,
        )
    return jsonify({"error": 0 if new_fv else 1})

