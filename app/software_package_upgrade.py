"""Apply a self-contained release ZIP when Git-based upgrades are unavailable."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PACKAGE_MANIFEST_TAG = "firmgate-release-package"
LEGACY_PACKAGE_MANIFEST_TAG = "intranet-release-package"

# Top-level names never overwritten or removed during a package upgrade.
_PRESERVE_TOP = frozenset(
    {
        "instance",
        ".venv",
        "venv",
        ".git",
    }
)
_PRESERVE_FILES = frozenset({".env", ".env.local"})


def _utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def _safe_zip_member(name: str) -> bool:
    n = (name or "").replace("\\", "/").strip()
    if not n or n.endswith("/"):
        return True
    parts = [p for p in n.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return False
    return True


def _resolve_package_root(extracted: Path) -> tuple[Path | None, dict[str, Any] | None, str]:
    manifest = extracted / "manifest.json"
    if manifest.is_file():
        root = extracted
    else:
        children = [p for p in extracted.iterdir() if p.name not in (".", "..")]
        if len(children) == 1 and children[0].is_dir() and (children[0] / "manifest.json").is_file():
            root = children[0]
        else:
            return None, None, "Zip must contain manifest.json at the top level or inside a single folder."

    manifest = root / "manifest.json"
    try:
        raw = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return None, None, "Could not read manifest.json."

    tag = raw.get("tag")
    if tag not in (PACKAGE_MANIFEST_TAG, LEGACY_PACKAGE_MANIFEST_TAG):
        return None, None, f"Invalid package manifest (expected tag {PACKAGE_MANIFEST_TAG!r})."

    req = root / "requirements.txt"
    app_init = root / "app" / "__init__.py"
    if not req.is_file():
        return None, None, "Package missing requirements.txt."
    if not app_init.is_file():
        return None, None, "Package missing app/__init__.py."

    return root, raw, ""


def _package_relative_files(root: Path) -> set[str]:
    out: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root)
        if rel_dir.parts and rel_dir.parts[0] in _PRESERVE_TOP:
            dirnames[:] = []
            continue
        for fn in filenames:
            rel = rel_dir / fn if rel_dir.parts else Path(fn)
            rel_s = rel.as_posix()
            if rel_s.split("/", 1)[0] in _PRESERVE_TOP:
                continue
            if rel.name in _PRESERVE_FILES:
                continue
            out.add(rel_s)
    return out


def _should_skip_deploy_rel(rel: Path) -> bool:
    if not rel.parts:
        return True
    if rel.parts[0] in _PRESERVE_TOP:
        return True
    if rel.name in _PRESERVE_FILES:
        return True
    return False


def _sync_package_to_deploy(package_root: Path, deploy_root: Path) -> tuple[bool, str, int]:
    package_files = _package_relative_files(package_root)
    if not package_files:
        return False, "Package contains no deployable application files.", 0

    copied = 0
    for rel_s in sorted(package_files):
        src = package_root / rel_s
        if not src.is_file():
            continue
        dest = deploy_root / rel_s
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        copied += 1

    removed = 0
    for dirpath, dirnames, filenames in os.walk(deploy_root, topdown=True):
        rel_dir = Path(dirpath).relative_to(deploy_root)
        if rel_dir.parts and rel_dir.parts[0] in _PRESERVE_TOP:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in _PRESERVE_TOP]
        for fn in list(filenames):
            rel = rel_dir / fn if rel_dir.parts else Path(fn)
            if _should_skip_deploy_rel(rel):
                continue
            rel_s = rel.as_posix()
            if rel_s in package_files:
                continue
            target = deploy_root / rel
            try:
                target.unlink()
                removed += 1
            except OSError:
                pass
        # Remove empty directories (except preserved roots handled above).
        for d in list(dirnames):
            rel = rel_dir / d if rel_dir.parts else Path(d)
            if _should_skip_deploy_rel(rel):
                continue
            rel_s = rel.as_posix()
            if rel_s in package_files:
                continue
            dp = deploy_root / rel
            try:
                if dp.is_dir() and not any(dp.iterdir()):
                    dp.rmdir()
            except OSError:
                pass

    return True, f"Applied {copied} file(s); removed {removed} obsolete file(s).", copied


def perform_package_upgrade(deploy_root: Path, zip_path: Path) -> tuple[bool, str, dict[str, Any]]:
    """
    Extract a release package, sync code to deploy_root (preserving instance/, .env, .venv),
    reinstall Python dependencies, verify runtime data, and optionally restart the service.

    Returns (ok, message, metadata dict with version/build_id/before_version/changed).
    """
    from app.admin_bp import (
        _clip_msg,
        _current_repo_version,
        _light_backup_runtime,
        _pip_install_requirements,
        _runtime_data_metrics,
        _try_restart_app_service,
        _verify_runtime_data_preserved,
    )

    deploy_root = deploy_root.resolve()
    meta: dict[str, Any] = {
        "before_version": _current_repo_version(deploy_root) or "",
        "after_version": "",
        "build_id": "",
        "changed": False,
    }
    forced_notes: list[str] = []
    before_files, before_kb = _runtime_data_metrics(deploy_root)

    _backup_dir, backup_msg = _light_backup_runtime(deploy_root)
    if _backup_dir:
        forced_notes.append(backup_msg)

    digest = hashlib.sha256()
    try:
        with zip_path.open("rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError as exc:
        return False, f"Could not read upload: {exc}", meta
    meta["build_id"] = digest.hexdigest()[:16]

    with tempfile.TemporaryDirectory(prefix="intranet-pkg-") as td:
        tmp = Path(td)
        extract_dir = tmp / "unzipped"
        extract_dir.mkdir(parents=True, exist_ok=True)
        try:
            with zipfile.ZipFile(str(zip_path), "r") as zf:
                for info in zf.infolist():
                    if not _safe_zip_member(info.filename):
                        return False, "Package zip contains unsafe paths.", meta
                zf.extractall(str(extract_dir))
        except zipfile.BadZipFile:
            return False, "Could not read zip file.", meta
        except Exception as exc:
            return False, _clip_msg(f"Extract failed: {exc}"), meta

        package_root, manifest, perr = _resolve_package_root(extract_dir)
        if not package_root or not manifest:
            return False, perr or "Invalid package.", meta

        pkg_version = str(manifest.get("version") or "").strip()
        if not pkg_version:
            pkg_version = f"package-{meta['build_id']}"
        meta["after_version"] = pkg_version

        ok_sync, sync_msg, _copied = _sync_package_to_deploy(package_root, deploy_root)
        if not ok_sync:
            return False, sync_msg, meta

        ok_data, data_msg = _verify_runtime_data_preserved(deploy_root, before_files, before_kb)
        if not ok_data:
            return False, data_msg, meta

        dep_ok, dep_msg = _pip_install_requirements(deploy_root, timeout_s=900.0)
        forced_prefix = (" ".join(forced_notes) + " ") if forced_notes else ""
        if not dep_ok:
            return False, f"{forced_prefix}Files updated but dependency install failed: {dep_msg}", meta

        _, restart_msg = _try_restart_app_service()
        meta["changed"] = True
        parts = [forced_prefix.strip(), sync_msg, data_msg, dep_msg, restart_msg]
        tail = " ".join(p for p in parts if p).strip()
        return True, f"Updated to package {pkg_version}. {tail}", meta
