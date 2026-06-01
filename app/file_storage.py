from __future__ import annotations

import hashlib
import os
import shutil
import uuid
from pathlib import Path

from flask import current_app
from werkzeug.utils import secure_filename

# Content-addressed file bytes for Documents, OnlyOffice, .eml bodies, etc. (under UPLOAD_ROOT).
DOCUMENT_BLOB_STORE_PREFIX = "blobs"


def is_document_blob_store_uploads_relative(path: Path) -> bool:
    """True if ``path`` is relative to UPLOAD_ROOT and lives under ``blobs/``."""
    parts = path.parts
    return bool(parts) and parts[0] == DOCUMENT_BLOB_STORE_PREFIX


def upload_root() -> Path:
    return Path(current_app.config["UPLOAD_ROOT"])


def _blob_dir() -> Path:
    p = upload_root() / DOCUMENT_BLOB_STORE_PREFIX
    p.mkdir(parents=True, exist_ok=True)
    return p


def store_stream_and_digest(stream, original_name: str) -> tuple[str, int, str, str | None]:
    """Save to temp, hash, move to final. Returns relpath, size, sha256, mime guess."""
    safe = secure_filename(original_name) or "upload"
    tmp_name = f"{uuid.uuid4().hex}_{safe}"
    tmp_path = _blob_dir() / tmp_name
    h = hashlib.sha256()
    size = 0
    with open(tmp_path, "wb") as out:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            h.update(chunk)
            size += len(chunk)
    digest = h.hexdigest()
    prefix = digest[:2] + "/" + digest[2:4]
    final_dir = _blob_dir() / prefix
    final_dir.mkdir(parents=True, exist_ok=True)
    final_path = final_dir / digest
    if not final_path.exists():
        shutil.move(str(tmp_path), str(final_path))
    else:
        os.unlink(tmp_path)
    relpath = f"blobs/{prefix}/{digest}"
    mime = None
    try:
        import mimetypes

        mime, _ = mimetypes.guess_type(original_name)
    except Exception:
        pass
    return relpath, size, digest, mime


def absolute_path(relpath: str) -> Path:
    root = upload_root()
    target = (root / relpath).resolve()
    if not str(target).startswith(str(root.resolve())):
        raise ValueError("invalid path")
    return target


def copy_blob_to_new_version(src_relpath: str) -> tuple[str, int, str, str | None]:
    src = absolute_path(src_relpath)
    size = src.stat().st_size
    h = hashlib.sha256()
    with open(src, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    digest = h.hexdigest()
    prefix = digest[:2] + "/" + digest[2:4]
    final_dir = _blob_dir() / prefix
    final_dir.mkdir(parents=True, exist_ok=True)
    final_path = final_dir / digest
    if not final_path.exists():
        shutil.copy2(src, final_path)
    relpath = f"blobs/{prefix}/{digest}"
    return relpath, size, digest, None
