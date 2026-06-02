"""Administration: users, roles, groups (requires admin.all)."""
from __future__ import annotations
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
from functools import wraps
from typing import Any, Callable
import socket
import ssl
import struct
import time as _time
from flask import Blueprint, abort, current_app, flash, jsonify, redirect, render_template, request, send_file, url_for
from flask_login import current_user, login_required
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError, OperationalError
from werkzeug.utils import secure_filename
from app import rbac
from app.audit_service import validate_deletion_justification, write_audit
from app.branding import portal_has_custom_logo, portal_logo_enabled, portal_logo_url as resolve_portal_logo_url
from app.factory_admin import user_is_factory_bootstrap
from app.extensions import db
from app.models import FileNode, Group, NodeUserShare, Permission, Role, User, utcnow
from app import access
from app.file_storage import is_document_blob_store_uploads_relative
from app.files_workspace import ensure_user_workspace_folder
from app import registration_service as regsvc
from app.settings import get_setting, set_setting
bp = Blueprint('admin', __name__, url_prefix='/admin')
SOFTWARE_DISPLAY_VERSION_DEFAULT = '2.0'

def _utc_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')
_DEPLOY_MERGE_FIELDS = ('current_commit', 'current_deployed_at', 'previous_commit', 'previous_deployed_at', 'current_version', 'previous_version', 'deployments')

def _merge_software_deploy(stored: Any) -> dict[str, Any]:
    out: dict[str, Any] = {'display_version': SOFTWARE_DISPLAY_VERSION_DEFAULT, 'git_url': '', **{k: None for k in _DEPLOY_MERGE_FIELDS}}
    if not isinstance(stored, dict):
        return out
    if stored.get('display_version'):
        dv = str(stored['display_version']).strip()
        if dv in ('0.1 Beta', '0.2 Beta'):
            dv = SOFTWARE_DISPLAY_VERSION_DEFAULT
        out['display_version'] = dv
    out['git_url'] = str(stored.get('git_url') or '')
    for k in _DEPLOY_MERGE_FIELDS:
        v = stored.get(k)
        if k == 'deployments':
            out[k] = v if isinstance(v, list) else []
            continue
        out[k] = v if isinstance(v, str) and v.strip() else None
    return out

def _append_deployment(state: dict[str, Any], entry: dict[str, Any]) -> None:
    """Append a deployment entry (most recent first), keeping a bounded history."""
    try:
        items = state.get('deployments')
        if not isinstance(items, list):
            items = []
        items.insert(0, entry)
        state['deployments'] = items[:40]
    except Exception:
        state['deployments'] = []

def _deploy_root_path() -> Path:
    """Git checkout root for upgrade/rollback (production: /root/intranet)."""
    raw = current_app.config.get('DEPLOY_ROOT')
    if raw:
        return Path(str(raw)).expanduser().resolve()
    prod = Path(str(current_app.config.get('PRODUCTION_DEPLOY_ROOT') or '/root/intranet'))
    if (prod / '.git').is_dir():
        return prod.resolve()
    return Path(current_app.root_path).resolve().parent

def _sqlite_db_path() -> Path | None:
    uri = str(current_app.config.get('SQLALCHEMY_DATABASE_URI') or '')
    if uri.startswith('sqlite:///'):
        raw = uri[len('sqlite:///'):]
        try:
            return Path(raw).expanduser().resolve()
        except Exception:
            return None
    return None

def _backup_manifest_dict() -> dict[str, Any]:
    return {'created_at': _utc_iso(), 'tag': 'intranet-backup', 'document_blob_store_included': False}

def _backup_portal_label() -> str:
    """Firmgate or Extranet for backup zip filename (saved portal theme, optional query override)."""
    raw = (request.args.get('variant') or request.args.get('portal') or '').strip().lower()
    if raw in ('intranet', 'extranet', 'firmgate'):
        return 'Extranet' if raw == 'extranet' else portal_shell_name('core_team')
    if raw in ('core_team', 'non_core_team'):
        return portal_shell_name(raw)
    portal = get_setting('portal', default={}) or {}
    theme = portal.get('theme') or 'core_team' if isinstance(portal, dict) else 'core_team'
    return portal_shell_name(str(theme))

def _git_executable() -> str:
    """
    Resolve git binary. systemd/gunicorn often run with PATH="" so bare ``git`` raises
    [Errno 2] No such file or directory — prefer an explicit path or well-known locations.
    """
    raw: str | None = None
    try:
        v = current_app.config.get('GIT_EXECUTABLE')
        if isinstance(v, str) and v.strip():
            raw = v.strip()
        elif v:
            raw = str(v).strip() or None
    except RuntimeError:
        pass
    if raw is None:
        env_v = (os.environ.get('GIT_EXECUTABLE') or '').strip()
        if env_v:
            raw = env_v
    if raw:
        if os.path.isabs(raw) or os.sep in raw:
            return raw
        found = shutil.which(raw)
        if found:
            return found
        return raw
    found = shutil.which('git')
    if found:
        return found
    for p in ('/usr/bin/git', '/bin/git', '/usr/local/bin/git'):
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return 'git'

def _git_capture(cwd: Path, args: list[str], timeout_s: float=180.0) -> tuple[int, str, str]:
    try:
        p = subprocess.run([_git_executable(), *args], cwd=str(cwd), capture_output=True, text=True, timeout=timeout_s)
        return (p.returncode, (p.stdout or '').strip(), (p.stderr or '').strip())
    except subprocess.TimeoutExpired:
        return (124, '', 'Git command timed out.')
    except OSError as e:
        return (1, '', f'Git could not run ({_git_executable()}): {e}')

def _working_tree_clean(cwd: Path) -> tuple[bool, str]:
    code, out, err = _git_capture(cwd, ['status', '--porcelain'], timeout_s=30)
    if code != 0:
        return (False, err or 'Could not read git status.')
    if out.strip():
        return (False, 'Working tree has uncommitted changes; commit or stash before upgrading.')
    return (True, '')

def _git_upstream_ref(cwd: Path) -> str | None:
    """
    Return the upstream ref for the current branch (e.g. origin/main).
    Falls back to origin/HEAD, then origin/main/master.
    """
    code, out, _ = _git_capture(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], timeout_s=30)
    s = (out or '').strip()
    if code == 0 and s and (s != '@{u}'):
        return s
    code2, out2, _ = _git_capture(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], timeout_s=30)
    s2 = (out2 or '').strip()
    if code2 == 0 and s2.startswith('refs/remotes/origin/'):
        return 'origin/' + s2.split('refs/remotes/origin/', 1)[1]
    for cand in ('origin/main', 'origin/master'):
        c, _, _e = _git_capture(cwd, ['rev-parse', '--verify', cand], timeout_s=20)
        if c == 0:
            return cand
    return None

def _git_head(cwd: Path) -> str | None:
    code, out, err = _git_capture(cwd, ['rev-parse', 'HEAD'], timeout_s=40)
    if code != 0 or not out:
        return None
    return out.strip()

def _git_describe_version(cwd: Path) -> str | None:
    """Return a human-friendly version from git, e.g. v1.2.3-4-g<sha>."""
    code, out, _ = _git_capture(cwd, ['describe', '--tags', '--always'], timeout_s=30)
    s = (out or '').strip()
    if code != 0 or not s:
        return None
    return s.replace('-dirty', '')

def _current_repo_version(cwd: Path) -> str | None:
    return _git_describe_version(cwd) or None

def _is_git_clone(cwd: Path) -> bool:
    git_dir = cwd / '.git'
    return git_dir.exists()

def _validate_git_remote_url(url: str) -> tuple[str | None, str]:
    raw = (url or '').strip()
    if not raw:
        return (None, 'Git repository URL is required.')
    if len(raw) > 2048:
        return (None, 'URL is too long.')
    if any((ch in raw for ch in ';|&$`')) or '\n' in raw or '\r' in raw:
        return (None, 'URL contains disallowed characters.')
    if raw.startswith(('https://', 'http://', 'git@')):
        return (raw, '')
    return (None, 'URL must start with https://, http://, or git@.')

def _ensure_git_origin(cwd: Path, url: str) -> tuple[bool, str]:
    code, _, _ = _git_capture(cwd, ['remote', 'get-url', 'origin'], timeout_s=30)
    args = ['remote', 'add', 'origin', url] if code != 0 else ['remote', 'set-url', 'origin', url]
    code2, _, err = _git_capture(cwd, args, timeout_s=30)
    if code2 != 0:
        return (False, err or 'Could not configure remote origin.')
    return (True, '')

def _clip_msg(s: str, n: int=1600) -> str:
    s = (s or '').strip()
    if len(s) <= n:
        return s
    return s[:n - 3] + '…'

def _deploy_python(cwd: Path) -> str:
    """Prefer project .venv when present (matches scripts/update.sh)."""
    vpy = cwd / '.venv' / 'bin' / 'python'
    if vpy.is_file():
        return str(vpy)
    return sys.executable

def _pip_install_requirements(cwd: Path, timeout_s: float=600.0) -> tuple[bool, str]:
    """Install Python deps into the deploy venv (or the running interpreter)."""
    req = cwd / 'requirements.txt'
    if not req.exists():
        return (True, 'No requirements.txt found; skipping dependency install.')
    py = _deploy_python(cwd)
    try:
        p = subprocess.run([py, '-m', 'pip', 'install', '--upgrade', 'pip'], cwd=str(cwd), capture_output=True, text=True, timeout=min(120.0, timeout_s))
        if p.returncode != 0:
            return (False, _clip_msg((p.stderr or p.stdout or 'pip upgrade failed').strip()))
        p = subprocess.run([py, '-m', 'pip', 'install', '-r', str(req)], cwd=str(cwd), capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return (False, 'pip install timed out.')
    except OSError as e:
        return (False, f'pip could not run: {e}')
    if p.returncode != 0:
        msg = _clip_msg((p.stderr or '').strip() or (p.stdout or '').strip() or 'pip install failed')
        return (False, msg)
    try:
        chk = subprocess.run([py, '-c', 'import gunicorn'], capture_output=True, timeout=30)
        if chk.returncode != 0:
            subprocess.run([py, '-m', 'pip', 'install', 'gunicorn'], cwd=str(cwd), capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return (True, 'Dependencies installed.')
_GIT_CLEAN_EXCLUDES = ('instance/', 'instance', '.venv/', '.venv', 'venv/', '.env', '.env.local')

def _upgrade_backup_root(deploy_root: Path) -> Path:
    raw = current_app.config.get('SOFTWARE_UPGRADE_BACKUP_ROOT')
    if raw:
        return Path(str(raw)).expanduser().resolve()
    return Path('/root/intranet-backups')

def _deploy_instance_dir(deploy_root: Path) -> Path:
    return deploy_root / 'instance'

def _deploy_uploads_dir(deploy_root: Path) -> Path:
    ur = current_app.config.get('UPLOAD_ROOT')
    if ur:
        return Path(ur).expanduser().resolve()
    return _deploy_instance_dir(deploy_root) / 'uploads'

def _count_upload_files(uploads: Path) -> int:
    if not uploads.is_dir():
        return 0
    try:
        p = subprocess.run(['find', str(uploads), '-type', 'f'], capture_output=True, text=True, timeout=300)
        if p.returncode == 0:
            return sum((1 for ln in (p.stdout or '').splitlines() if ln.strip()))
    except (OSError, subprocess.TimeoutExpired):
        pass
    return -1

def _instance_size_kb(instance_dir: Path) -> int:
    if not instance_dir.is_dir():
        return 0
    try:
        p = subprocess.run(['du', '-sk', str(instance_dir)], capture_output=True, text=True, timeout=300)
        if p.returncode == 0 and (p.stdout or '').strip():
            return int((p.stdout or '').split()[0])
    except (OSError, subprocess.TimeoutExpired, ValueError):
        pass
    return 0

def _runtime_data_metrics(deploy_root: Path) -> tuple[int, int]:
    uploads = _deploy_uploads_dir(deploy_root)
    return (_count_upload_files(uploads), _instance_size_kb(_deploy_instance_dir(deploy_root)))

def _light_backup_runtime(deploy_root: Path) -> tuple[Path | None, str]:
    """
  Copy only .env and the SQLite DB (not uploads). Matches scripts/update.sh light backup.
    """
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    dest = _upgrade_backup_root(deploy_root) / stamp
    try:
        dest.mkdir(parents=True, exist_ok=True)
        (dest / 'instance').mkdir(exist_ok=True)
    except OSError as e:
        return (None, f'Could not create backup directory: {e}')
    db = _sqlite_db_path()
    if db and db.is_file():
        shutil.copy2(db, dest / 'instance' / db.name)
    else:
        fallback = _deploy_instance_dir(deploy_root) / 'secure_browser.db'
        if fallback.is_file():
            shutil.copy2(fallback, dest / 'instance' / fallback.name)
    env = deploy_root / '.env'
    if env.is_file():
        shutil.copy2(env, dest / '.env')
    try:
        code, out, _ = _git_capture(deploy_root, ['rev-parse', 'HEAD'], timeout_s=30)
        if code == 0 and out:
            (dest / 'git-revision-before.txt').write_text(out.strip() + '\n', encoding='utf-8')
    except OSError:
        pass
    return (dest, f'Light backup at {dest} (.env and database only; document uploads were not copied).')

def _verify_runtime_data_preserved(deploy_root: Path, before_files: int, before_kb: int) -> tuple[bool, str]:
    instance_dir = _deploy_instance_dir(deploy_root)
    if not instance_dir.is_dir():
        return (False, 'instance/ directory is missing after update.')
    after_files, after_kb = _runtime_data_metrics(deploy_root)
    if before_files >= 0 and after_files >= 0 and (before_files > 0) and (after_files < before_files):
        return (False, f'Upload file count dropped ({before_files} → {after_files}). Restore from the latest backup under intranet-backups.')
    if before_kb > 0 and after_kb > 0 and (after_kb < before_kb * 9 // 10):
        return (False, f'instance/ size dropped sharply ({before_kb}KB → {after_kb}KB). Restore from backup before using the app.')
    detail = f'Runtime data OK ({after_files} upload files' if after_files >= 0 else 'Runtime data OK'
    if after_kb > 0:
        detail += f', ~{after_kb}KB under instance/'
    detail += ').'
    return (True, detail)

def _git_clean_preserve_runtime(cwd: Path) -> tuple[bool, str]:
    args = ['clean', '-fd', *[x for pat in _GIT_CLEAN_EXCLUDES for x in ('-e', pat)]]
    code, _, err = _git_capture(cwd, args, timeout_s=120)
    if code != 0:
        return (False, _clip_msg(err or 'git clean failed'))
    return (True, '')

def _git_resolve_upstream(cwd: Path) -> str | None:
    code, _, _ = _git_capture(cwd, ['rev-parse', '--verify', 'origin/main'], timeout_s=20)
    if code == 0:
        return 'origin/main'
    return _git_upstream_ref(cwd)

def _git_checkout_upstream(cwd: Path, upstream: str) -> tuple[bool, str]:
    branch = upstream.split('/', 1)[1] if upstream.startswith('origin/') else 'main'
    c1, _, e1 = _git_capture(cwd, ['branch', '-f', branch, upstream], timeout_s=60)
    if c1 != 0:
        return (False, _clip_msg(e1 or 'git branch failed'))
    c2, _, e2 = _git_capture(cwd, ['checkout', '-B', branch, upstream], timeout_s=60)
    if c2 != 0:
        return (False, _clip_msg(e2 or 'git checkout failed'))
    c3, _, e3 = _git_capture(cwd, ['reset', '--hard', upstream], timeout_s=240)
    if c3 != 0:
        return (False, _clip_msg(e3 or 'git reset --hard failed'))
    return (True, '')

def _try_restart_app_service() -> tuple[bool, str]:
    svc = str(current_app.config.get('SOFTWARE_UPGRADE_SERVICE_NAME') or '').strip()
    if not svc or svc.lower() in ('0', 'false', 'no', 'none', 'skip'):
        return (False, 'Restart the application service manually to load Python changes.')
    if not re.match('^[a-zA-Z0-9_.@-]+$', svc):
        return (False, 'Invalid SOFTWARE_UPGRADE_SERVICE_NAME; restart skipped.')
    try:
        p = subprocess.run(['systemctl', 'restart', svc], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        return (False, f'Could not restart {svc}: {e}')
    if p.returncode != 0:
        msg = _clip_msg((p.stderr or p.stdout or 'systemctl restart failed').strip())
        return (False, f'Service restart failed ({svc}): {msg}')
    try:
        subprocess.run(['systemctl', 'is-active', '--quiet', svc], timeout=30, check=True)
    except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        return (False, f'Restarted {svc} but it is not active — check journalctl.')
    return (True, f'Service {svc} restarted.')

def _git_is_shallow_repo(cwd: Path) -> bool:
    c, out, _ = _git_capture(cwd, ['rev-parse', '--is-shallow-repository'], timeout_s=15)
    if c == 0 and (out or '').strip() == 'true':
        return True
    return (cwd / '.git' / 'shallow').is_file()

def _perform_git_upgrade(cwd: Path, git_url: str) -> tuple[bool, str, str | None, str | None]:
    """
    Safe in-place upgrade (aligned with scripts/update.sh):
    light backup (.env + DB only), fetch/reset, git clean with runtime excludes,
    pip install, verify instance/ uploads, optional systemctl restart.
    """
    forced_notes: list[str] = []
    before_files, before_kb = _runtime_data_metrics(cwd)
    ok, dirty = _working_tree_clean(cwd)
    if not ok:
        _git_capture(cwd, ['reset', '--hard'], timeout_s=60)
        forced_notes.append('Local uncommitted changes were discarded.')
    hb = _git_head(cwd)
    if not hb:
        forced_notes.append('Current HEAD could not be read; attempting recovery from remote.')
    _backup_dir, backup_msg = _light_backup_runtime(cwd)
    if _backup_dir:
        forced_notes.append(backup_msg)
    origin_ok, oerr = _ensure_git_origin(cwd, git_url)
    if not origin_ok:
        return (False, oerr, hb, _git_head(cwd))
    if _git_is_shallow_repo(cwd):
        ucode, _, _ = _git_capture(cwd, ['fetch', 'origin', '--unshallow'], timeout_s=360)
        if ucode != 0:
            forced_notes.append('Shallow clone could not be fully deepened (fetch may be partial).')
    c1, _, e1 = _git_capture(cwd, ['fetch', '--all', '--prune', '--tags', '--force'], timeout_s=300)
    if c1 != 0:
        return (False, _clip_msg(e1 or 'git fetch failed'), hb, _git_head(cwd))
    upstream = _git_resolve_upstream(cwd)
    if not upstream:
        return (False, 'Could not determine the remote tracking branch for this clone.', hb, _git_head(cwd))
    ok_co, cerr = _git_checkout_upstream(cwd, upstream)
    if not ok_co:
        return (False, cerr, hb, _git_head(cwd))
    ok_cl, clerr = _git_clean_preserve_runtime(cwd)
    if not ok_cl:
        return (False, clerr, hb, _git_head(cwd))
    ha = _git_head(cwd)
    if not ha:
        return (False, 'Upgrade finished but HEAD could not be read.', hb, None)
    ok_data, data_msg = _verify_runtime_data_preserved(cwd, before_files, before_kb)
    if not ok_data:
        return (False, data_msg, hb, ha)
    dep_ok, dep_msg = _pip_install_requirements(cwd, timeout_s=600.0)
    forced_prefix = ' '.join(forced_notes) + ' ' if forced_notes else ''
    if not dep_ok:
        return (False, f'{forced_prefix}Code updated but dependency install failed: {dep_msg}', hb, ha)
    _, restart_msg = _try_restart_app_service()
    parts = [forced_prefix.strip(), data_msg, dep_msg, restart_msg]
    tail = ' '.join((p for p in parts if p)).strip()
    if hb == ha:
        return (True, f'Repository already matches {upstream} (no new commits). {tail}', hb, ha)
    return (True, f'Updated to {upstream}. {tail}', hb, ha)

def _validate_commit_ref(ref: str) -> tuple[str | None, str]:
    s = (ref or '').strip()
    if not s or not re.match('^[a-fA-F0-9]{7,40}$', s):
        return (None, 'Invalid stored commit id for rollback.')
    return (s.lower(), '')
_CHANGELOG_COMMIT_CAP = 100

def _changelog_git_range(action: str, from_commit: str, to_commit: str) -> tuple[str, str] | None:
    """
    Return (exclusive_base, tip) for ``git log base..tip`` matching a deployment row.

    Upgrade (old→new): commits on tip not reachable from base → ``from..to``.
    Rollback (new→old): commits that were dropped → ``to..from``.
    """
    vf, _e1 = _validate_commit_ref(from_commit)
    vt, _e2 = _validate_commit_ref(to_commit)
    if not vf or not vt:
        return None
    if str(action or '').strip().lower() == 'rollback':
        return (vt, vf)
    return (vf, vt)

def _git_changelog_commits(cwd: Path, exclusive_base: str, tip: str) -> tuple[list[str], str | None, bool]:
    """Return one-line subject per commit (oldest first), optional error, truncated flag."""
    if exclusive_base == tip:
        return ([], None, False)
    cap = _CHANGELOG_COMMIT_CAP + 1
    code, out, err = _git_capture(cwd, ['log', f'{exclusive_base}..{tip}', '--reverse', '--format=%s', f'-n{cap}'], timeout_s=90)
    if code != 0:
        return ([], _clip_msg(err or out or 'git log failed'), False)
    lines = [ln.strip() for ln in (out or '').splitlines() if ln.strip()]
    truncated = len(lines) > _CHANGELOG_COMMIT_CAP
    if truncated:
        lines = lines[:_CHANGELOG_COMMIT_CAP]
    return (lines, None, truncated)

def _software_changelog_payload(root: Path, state: dict[str, Any]) -> dict[str, Any]:
    """
    Build change-log segments from stored deployment history (git log subjects between SHAs).
    """
    out: dict[str, Any] = {'available': False, 'segments': []}
    if not _is_git_clone(root):
        return out
    out['available'] = True
    segs: list[dict[str, Any]] = []
    raw_items = state.get('deployments')
    items: list[dict[str, Any]] = [x for x in raw_items if isinstance(x, dict)] if isinstance(raw_items, list) else []
    for d in items[:30]:
        fc = str(d.get('from_commit') or '').strip()
        tc = str(d.get('to_commit') or '').strip()
        action = str(d.get('action') or 'upgrade').strip().lower()
        rng = _changelog_git_range(action, fc, tc)
        if not rng:
            continue
        base, tip = rng
        commits, gerr, truncated = _git_changelog_commits(root, base, tip)
        segs.append({'at': d.get('at'), 'action': action, 'from_version': str(d.get('from_version') or ''), 'to_version': str(d.get('to_version') or ''), 'from_commit': fc, 'to_commit': tc, 'commits': commits, 'error': gerr, 'truncated': truncated})
    if not segs:
        pc = str(state.get('previous_commit') or '').strip()
        cc = str(state.get('current_commit') or '').strip()
        rng = _changelog_git_range('upgrade', pc, cc)
        if rng:
            base, tip = rng
            commits, gerr, truncated = _git_changelog_commits(root, base, tip)
            segs.append({'at': state.get('current_deployed_at'), 'action': 'recorded', 'from_version': str(state.get('previous_version') or ''), 'to_version': str(state.get('current_version') or ''), 'from_commit': pc, 'to_commit': cc, 'commits': commits, 'error': gerr, 'truncated': truncated})
    out['segments'] = segs
    return out

def _perform_git_reset(cwd: Path, commit: str) -> tuple[bool, str]:
    before_files, before_kb = _runtime_data_metrics(cwd)
    _light_backup_runtime(cwd)
    ok, dirty = _working_tree_clean(cwd)
    if not ok:
        _git_capture(cwd, ['reset', '--hard'], timeout_s=60)
    c2, _, e2 = _git_capture(cwd, ['reset', '--hard', commit], timeout_s=120)
    if c2 != 0:
        return (False, _clip_msg(e2 or 'git reset --hard failed'))
    ok_data, data_msg = _verify_runtime_data_preserved(cwd, before_files, before_kb)
    if not ok_data:
        return (False, data_msg)
    dep_ok, dep_msg = _pip_install_requirements(cwd, timeout_s=600.0)
    if not dep_ok:
        return (False, f'Rollback applied but dependency install failed: {dep_msg}')
    _, restart_msg = _try_restart_app_service()
    return (True, f'Rollback completed. {data_msg} {dep_msg} {restart_msg}'.strip())

def _audit(action: str, resource_type: str | None, resource_id: str | None, success: bool, details: dict | None=None):
    write_audit(user_id=current_user.id, username=current_user.username, action=action, resource_type=resource_type, resource_id=resource_id, success=success, details=details)

def _forbidden_admin_json_response():
    mode = (request.headers.get('Sec-Fetch-Mode') or '').lower()
    dest = (request.headers.get('Sec-Fetch-Dest') or '').lower()
    xrw = (request.headers.get('X-Requested-With') or '').lower()
    accept = (request.headers.get('Accept') or '').lower()
    wants_html = 'text/html' in accept or 'application/xhtml+xml' in accept or bool(request.accept_mimetypes.accept_html)
    wants_json = 'application/json' in accept or bool(request.accept_mimetypes.accept_json)
    is_nav = (mode == 'navigate' or dest in ('document', 'iframe')) or (wants_html and (not wants_json) and (xrw != 'xmlhttprequest'))
    if is_nav:
        flash('You don’t have permission to access Administration.', 'danger')
        return redirect(url_for('intranet.intranet_page'))
    return (jsonify({'error': 'forbidden'}), 403)

def admin_required_json(fn: Callable[..., Any]):

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        if not current_user.is_authenticated or not rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
            return _forbidden_admin_json_response()
        return fn(*args, **kwargs)
    return wrapper

def users_admin_access_required_json(fn: Callable[..., Any]):
    """Any granular ``users.*`` permission or ``admin.all``."""

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        if not current_user.is_authenticated or not rbac.user_can_access_users_admin(current_user):
            return _forbidden_admin_json_response()
        return fn(*args, **kwargs)
    return wrapper

def home_settings_access_required_json(fn: Callable[..., Any]):
    """Home announcements editor (admin.all, admin role, or Users administration access)."""

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        if not current_user.is_authenticated or not rbac.user_can_manage_home(current_user):
            return _forbidden_admin_json_response()
        return fn(*args, **kwargs)
    return wrapper

def users_create_required_json(fn: Callable[..., Any]):

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        if not current_user.is_authenticated or not rbac.user_can_create_users(current_user):
            return _forbidden_admin_json_response()
        return fn(*args, **kwargs)
    return wrapper

def users_registrations_required_json(fn: Callable[..., Any]):

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        if not current_user.is_authenticated or not rbac.user_can_approve_registrations(current_user):
            return _forbidden_admin_json_response()
        return fn(*args, **kwargs)
    return wrapper

def registration_notifications_required_json(fn: Callable[..., Any]):

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        if not current_user.is_authenticated or not rbac.user_can_manage_registration_notifications(current_user):
            return _forbidden_admin_json_response()
        return fn(*args, **kwargs)
    return wrapper
users_manage_required_json = users_admin_access_required_json

def _admin_role() -> Role | None:
    return db.session.query(Role).filter(Role.name == 'admin').first()

def _assign_standard_role(u: User) -> None:
    rbac.assign_standard_role(u, db.session)

def _roles_assignable_by_current_user(role_ids: list) -> tuple[list[Role], str | None]:
    """Resolve role_ids for user create/update; non-admins cannot assign the admin role."""
    out_r: list[Role] = []
    for rid in role_ids:
        try:
            r = db.session.get(Role, int(rid))
            if r:
                out_r.append(r)
        except (TypeError, ValueError):
            pass
    admin_role = _admin_role()
    if admin_role and (not rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN)):
        if any((r.id == admin_role.id for r in out_r)):
            return ([], 'cannot assign the administrator role')
        out_r = [r for r in out_r if r.id != admin_role.id]
    return (out_r, None)

def _count_active_admins() -> int:
    n = 0
    for u in User.query.filter_by(is_active=True).all():
        if rbac.user_has_permission(u, rbac.PERMISSION_ADMIN):
            n += 1
    return n

def _sync_factory_bootstrap_accounts() -> None:
    """Deactivate factory bootstrap admin once another active administrator exists."""
    from app.factory_admin import sync_factory_bootstrap_accounts as sync_fn
    try:
        if sync_fn(db.session) > 0:
            db.session.commit()
    except Exception:
        db.session.rollback()

def _serialize_user(u: User) -> dict[str, Any]:
    from app.mfa_service import mfa_enrolled
    attrs = u.attributes if isinstance(u.attributes, dict) else {}
    primary = rbac.primary_builtin_role(u)
    return {'id': u.id, 'username': u.username, 'full_name': u.full_name, 'email': u.email, 'phone': u.phone, 'is_active': u.is_active, 'attributes': attrs or {}, 'mfa_enrolled': mfa_enrolled(u), 'factory_bootstrap': user_is_factory_bootstrap(u), 'role_ids': [r.id for r in u.roles], 'primary_role_id': primary.id if primary else None, 'group_ids': [g.id for g in u.groups]}

def _merge_user_attributes(u: User, incoming: dict) -> None:
    from app.mfa_service import MFA_ATTR_ENROLLED, MFA_ATTR_REQUIRED, MFA_ATTR_SECRET_ENC
    old = dict(u.attributes or {}) if isinstance(u.attributes, dict) else {}
    prev_mfa = bool(old.get(MFA_ATTR_REQUIRED))
    old.update(incoming)
    new_mfa = bool(old.get(MFA_ATTR_REQUIRED))
    if prev_mfa and (not new_mfa):
        old.pop(MFA_ATTR_SECRET_ENC, None)
        old.pop(MFA_ATTR_ENROLLED, None)
        old[MFA_ATTR_REQUIRED] = False
    elif new_mfa and (not old.get(MFA_ATTR_SECRET_ENC)):
        old[MFA_ATTR_ENROLLED] = False
    u.attributes = old

def _serialize_group(g: Group) -> dict[str, Any]:
    return {'id': g.id, 'name': g.name, 'description': g.description, 'user_ids': [u.id for u in g.users], 'role_ids': [r.id for r in g.roles]}

def _serialize_role(r: Role) -> dict[str, Any]:
    return {'id': r.id, 'name': r.name, 'permission_ids': [p.id for p in r.permissions]}

def _normalize_email(raw: str | None) -> str | None:
    s = (raw or '').strip()
    return s or None

def _normalize_phone(raw: str | None) -> str | None:
    s = (raw or '').strip()
    return s or None

def _email_taken(email: str, exclude_user_id: int | None=None) -> bool:
    q = User.query.filter(func.lower(User.email) == email.lower())
    if exclude_user_id is not None:
        q = q.filter(User.id != exclude_user_id)
    return q.first() is not None

@bp.route('/')
@login_required
def admin_page():
    if not rbac.user_can_access_users_admin(current_user) and (not rbac.user_can_approve_registrations(current_user)):
        flash('You don’t have permission to access Administration.', 'danger')
        return redirect(url_for('intranet.intranet_page'))
    ctx = rbac.users_admin_template_context(current_user)
    return render_template('admin.html', **ctx)

@bp.route('/api/settings/onlyoffice', methods=['GET'])
@login_required
@admin_required_json
def api_onlyoffice_settings_get():
    v = get_setting('onlyoffice', default={}) or {}
    return jsonify({'url': v.get('url') or '', 'jwt_secret': v.get('jwt_secret') or '', 'app_url': v.get('app_url') or '', 'skip_tls_verify': bool(v.get('skip_tls_verify')), 'enabled': bool(v.get('url'))})

@bp.route('/api/settings/onlyoffice', methods=['PUT'])
@login_required
@admin_required_json
def api_onlyoffice_settings_put():
    payload = request.get_json(force=True, silent=True) or {}
    url = (payload.get('url') or '').strip()
    jwt_secret = (payload.get('jwt_secret') or '').strip()
    app_url = (payload.get('app_url') or '').strip()
    skip_tls_verify = bool(payload.get('skip_tls_verify'))
    if url and (not (url.startswith('http://') or url.startswith('https://'))):
        return (jsonify({'error': 'url must start with http:// or https://'}), 400)
    if app_url and (not (app_url.startswith('http://') or app_url.startswith('https://'))):
        return (jsonify({'error': 'app public url must start with http:// or https://'}), 400)
    set_setting('onlyoffice', {'url': url, 'jwt_secret': jwt_secret, 'app_url': app_url, 'skip_tls_verify': skip_tls_verify})
    _audit('admin.onlyoffice.save', 'setting', 'onlyoffice', True, {'enabled': bool(url)})
    return jsonify({'ok': True})

def _onlyoffice_test_ssl_context(*, skip_verify: bool) -> ssl.SSLContext | None:
    """Return None for default verification, or a context that skips cert verify (integration test only)."""
    if not skip_verify:
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

def _http_get_text(url: str, timeout_s: float=3.0, *, ssl_context: ssl.SSLContext | None=None) -> tuple[int, str]:
    req = urllib.request.Request(url, method='GET', headers={'User-Agent': 'SecureFileBrowser/1.0'})
    open_kw: dict[str, Any] = {'timeout': timeout_s}
    if ssl_context is not None:
        open_kw['context'] = ssl_context
    with urllib.request.urlopen(req, **open_kw) as resp:
        status = getattr(resp, 'status', 200)
        raw = resp.read()
        try:
            text = raw.decode('utf-8', errors='replace')
        except Exception:
            text = ''
        return (int(status), text)

@bp.route('/api/settings/onlyoffice/test', methods=['GET'])
@login_required
@admin_required_json
def api_onlyoffice_settings_test():
    v = get_setting('onlyoffice', default={}) or {}
    base = (v.get('url') or '').strip().rstrip('/')
    app_url = (v.get('app_url') or '').strip().rstrip('/')
    if not base:
        return (jsonify({'ok': False, 'error': 'OnlyOffice URL not set'}), 400)
    hints: list[str] = []
    if 'localhost' in base or '127.0.0.1' in base:
        hints.append("If OnlyOffice is on another machine/container, don't use localhost here — use the network IP/hostname reachable from the Flask server.")
    if not app_url:
        hints.append('Tip: set an App public URL for OnlyOffice if the document server is in Docker/another host, so it can fetch files from your app.')
    health_url = f'{base}/healthcheck'
    api_js_url = f'{base}/web-apps/apps/api/documents/api.js'
    tls_ctx = _onlyoffice_test_ssl_context(skip_verify=bool(v.get('skip_tls_verify')))
    try:
        hs_code, hs_text = _http_get_text(health_url, timeout_s=3.0, ssl_context=tls_ctx)
        js_code, _ = _http_get_text(api_js_url, timeout_s=3.0, ssl_context=tls_ctx)
    except urllib.error.HTTPError as e:
        return (jsonify({'ok': False, 'error': f'HTTP error contacting OnlyOffice: {e.code}', 'hints': hints}), 502)
    except urllib.error.URLError as e:
        reason = getattr(e, 'reason', e)
        rs = str(reason)
        if 'CERTIFICATE_VERIFY_FAILED' in rs or 'certificate verify failed' in rs.lower():
            hints.append('TLS verification failed: install your CA bundle on this server, fix the full certificate chain in Nginx, or enable “Skip TLS verify (test only)” in Integrations and save — then Test again.')
        return (jsonify({'ok': False, 'error': f'Could not reach OnlyOffice: {reason}', 'hints': hints}), 502)
    except Exception as e:
        return (jsonify({'ok': False, 'error': f'Test failed: {e}', 'hints': hints}), 502)
    health_ok = hs_code == 200 and hs_text.strip().lower() == 'true'
    js_ok = js_code == 200
    ok = bool(health_ok and js_ok)
    return jsonify({'ok': ok, 'checks': {'healthcheck': {'url': health_url, 'status': hs_code, 'body': hs_text.strip()[:200]}, 'api_js': {'url': api_js_url, 'status': js_code}}, 'hints': hints})

@bp.route('/api/settings/document-editor', methods=['GET'])
@login_required
@admin_required_json
def api_document_editor_settings_get():
    from app.document_editor_settings import get_document_editor_provider, is_document_editor_configured
    return jsonify({'provider': get_document_editor_provider(), 'configured': is_document_editor_configured()})

@bp.route('/api/settings/document-editor', methods=['PUT'])
@login_required
@admin_required_json
def api_document_editor_settings_put():
    from app.document_editor_settings import VALID_PROVIDERS, get_document_editor_provider, set_document_editor_provider
    payload = request.get_json(force=True, silent=True) or {}
    provider = (payload.get('provider') or '').strip().lower()
    if provider not in VALID_PROVIDERS:
        return (jsonify({'error': 'provider must be onlyoffice'}), 400)
        if not ok:
            return (jsonify({'error': msg}), 403)
    set_document_editor_provider(provider)
    _audit('admin.document_editor.save', 'setting', 'document_editor', True, {'provider': provider})
    return jsonify({'ok': True, 'provider': get_document_editor_provider()})

def _parse_ldap_server_uri(uri: str) -> tuple[str, int, bool]:
    """Return hostname, port, use_ssl from ldap:// or ldaps:// URI."""
    u = urllib.parse.urlparse((uri or '').strip())
    scheme = (u.scheme or '').lower()
    host = (u.hostname or '').strip()
    if not host:
        raise ValueError('LDAP server URI must include a host, e.g. ldap://dc.example.com:389')
    if scheme not in ('ldap', 'ldaps'):
        raise ValueError('LDAP server URI must start with ldap:// or ldaps://')
    use_ssl = scheme == 'ldaps'
    port = u.port
    if port is None:
        port = 636 if use_ssl else 389
    return (host, int(port), use_ssl)

def _ldap_connection_bind_and_probe(cfg: dict[str, Any]) -> tuple[bool, str]:
    """Try LDAP bind using saved settings; optionally BASE search on base_dn."""
    try:
        from ldap3 import Connection, Server, Tls
    except ImportError:
        return (False, 'ldap3 is not installed (pip install ldap3)')
    server_uri = (cfg.get('server_uri') or '').strip()
    bind_dn = (cfg.get('bind_dn') or '').strip()
    bind_pw = cfg.get('bind_password') or ''
    base_dn = (cfg.get('base_dn') or '').strip()
    start_tls = bool(cfg.get('start_tls'))
    skip_cert = bool(cfg.get('skip_cert_verify'))
    if not server_uri or not bind_dn:
        return (False, 'Server URI and Bind DN are required.')
    if not bind_pw:
        return (False, 'Bind password is not set — save credentials first.')
    try:
        host, port, use_ssl = _parse_ldap_server_uri(server_uri)
    except ValueError as e:
        return (False, str(e))
    if use_ssl and start_tls:
        start_tls = False
    tls_obj = None
    if skip_cert:
        tls_obj = Tls(validate=ssl.CERT_NONE)
    server = Server(host, port=port, use_ssl=use_ssl, tls=tls_obj, connect_timeout=10)
    conn = Connection(server, user=bind_dn, password=bind_pw, auto_bind=False, receive_timeout=10)
    try:
        if not conn.open():
            return (False, conn.last_error or 'Could not connect to LDAP server.')
        if start_tls and (not use_ssl):
            if not conn.start_tls():
                return (False, conn.last_error or 'Start TLS failed.')
        if not conn.bind():
            err = conn.last_error or ''
            res = getattr(conn, 'result', None) or {}
            msg = str(res.get('message') or res or err or 'Bind failed.')
            return (False, msg)
        if base_dn:
            ok = conn.search(base_dn, '(objectClass=*)', search_scope='BASE', attributes=['objectClass'], size_limit=1, time_limit=5)
            if not ok:
                return (False, conn.last_error or 'Search at Base DN failed.')
            if not conn.entries:
                return (False, 'Base DN exists but returned no entry (check the DN).')
        return (True, 'LDAP bind succeeded' + (f"; Base DN '{base_dn}' is reachable." if base_dn else '.'))
    finally:
        try:
            conn.unbind()
        except Exception:
            pass

@bp.route('/api/settings/email', methods=['GET'])
@login_required
@admin_required_json
def api_email_settings_get():
    from app.email_service import email_settings_for_api
    return jsonify(email_settings_for_api())

@bp.route('/api/settings/email', methods=['PUT'])
@login_required
@admin_required_json
def api_email_settings_put():
    from app.email_service import email_settings_for_api, save_email_settings
    payload = request.get_json(force=True, silent=True) or {}
    result = save_email_settings(payload)
    if isinstance(result, tuple):
        body, code = result
        return (jsonify(body), code)
    _audit('admin.email.save', 'setting', 'email', True, {'enabled': bool(result.get('enabled')), 'host': result.get('smtp_host') or ''})
    return jsonify(result)

@bp.route('/api/settings/email/test', methods=['POST'])
@login_required
@admin_required_json
def api_email_settings_test():
    from app.email_service import send_test_email
    payload = request.get_json(force=True, silent=True) or {}
    to_addr = (payload.get('to') or '').strip()
    if not to_addr:
        to_addr = (getattr(current_user, 'email', None) or '').strip()
    if not to_addr or '@' not in to_addr:
        return (jsonify({'ok': False, 'error': 'Enter a valid test recipient email address.'}), 400)
    ok, msg = send_test_email(to_addr)
    if not ok:
        return (jsonify({'ok': False, 'error': msg}), 400)
    _audit('admin.email.test', 'setting', 'email', True, {'to': to_addr})
    return jsonify({'ok': True, 'message': msg})

def _branding_dir() -> Path:
    p = Path(current_app.instance_path) / 'branding'
    p.mkdir(parents=True, exist_ok=True)
    return p

@bp.route('/portal/logo', methods=['GET'])
def portal_logo_public():
    portal = get_setting('portal', default={}) or {}
    name = (portal.get('logo_name') or '').strip()
    if not name:
        abort(404)
    fpath = _branding_dir() / name
    if not fpath.exists():
        abort(404)
    return send_file(str(fpath), conditional=True, max_age=60)

@bp.route('/api/settings/portal', methods=['GET'])
@login_required
@admin_required_json
def api_portal_settings_get():
    v = get_setting('portal', default={}) or {}
    raw_theme = v.get('theme') or 'core_team' if isinstance(v, dict) else 'core_team'
    theme = str(raw_theme).strip().lower().replace('-', '_')
    if theme not in ('core_team', 'non_core_team'):
        theme = 'core_team'
    return jsonify({'logo_enabled': portal_logo_enabled(v), 'logo_url': resolve_portal_logo_url(v, static_url=lambda f: url_for('static', filename=f)), 'logo_is_default': portal_logo_enabled(v) and (not portal_has_custom_logo(v)), 'footer_text': v.get('footer_text') or '', 'theme': theme})

@bp.route('/api/settings/home', methods=['PUT'])
@login_required
@home_settings_access_required_json
def api_home_settings_put():
    if not request.is_json:
        return (jsonify({'error': 'JSON body required'}), 400)
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return (jsonify({'error': 'invalid JSON'}), 400)
    cfg = payload.get('config') if isinstance(payload.get('config'), dict) else {}
    from app.home_settings_service import persist_home_settings
    out, err = persist_home_settings(cfg)
    if err:
        return err
    _audit('admin.home.save', 'setting', 'home', True, {'announcements': len(out.get('announcements') or [])})
    return jsonify({'ok': True, 'config': out})

@bp.route('/api/settings/home/upload-image', methods=['POST'])
@login_required
@home_settings_access_required_json
def api_home_settings_upload_image():
    from app.home_settings_service import save_home_upload
    url, err = save_home_upload(request.files.get('file'))
    if err:
        return err
    return (jsonify({'ok': True, 'url': url}), 201)

@bp.route('/api/settings/portal', methods=['PUT'])
@login_required
@admin_required_json
def api_portal_settings_put():
    payload = request.get_json(force=True, silent=True) or {}
    footer_text = (payload.get('footer_text') or '').strip()
    logo_enabled = bool(payload.get('logo_enabled', True))
    raw_theme = payload.get('theme', 'core_team')
    theme = str(raw_theme or 'core_team').strip().lower().replace('-', '_')
    if theme not in ('core_team', 'non_core_team'):
        theme = 'core_team'
    cur = get_setting('portal', default={}) or {}
    nxt = dict(cur)
    nxt['footer_text'] = footer_text
    nxt['logo_enabled'] = bool(logo_enabled)
    nxt['theme'] = theme
    set_setting('portal', nxt)
    _audit('admin.portal.save', 'setting', 'portal', True, {'logo_enabled': bool(logo_enabled), 'theme': theme})
    return jsonify({'ok': True})

@bp.route('/api/settings/portal/logo', methods=['POST'])
@login_required
@admin_required_json
def api_portal_logo_upload():
    if 'logo' not in request.files:
        return (jsonify({'error': "missing file field 'logo'"}), 400)
    f = request.files['logo']
    if not f or not f.filename:
        return (jsonify({'error': 'no file selected'}), 400)
    raw_name = secure_filename(f.filename)
    ext = (raw_name.rsplit('.', 1)[-1] if '.' in raw_name else '').lower()
    if not ext:
        mt = (getattr(f, 'mimetype', None) or '').lower()
        if mt in ('image/png', 'image/x-png'):
            ext = 'png'
        elif mt in ('image/jpeg', 'image/jpg', 'image/pjpeg'):
            ext = 'jpg'
        elif mt in ('image/svg+xml',):
            ext = 'svg'
        elif mt in ('image/webp',):
            ext = 'webp'
    if ext not in ('png', 'jpg', 'jpeg', 'svg', 'webp'):
        return (jsonify({'error': 'unsupported file type (png/jpg/svg/webp)'}), 400)
    stamp = int(utcnow().timestamp())
    out_name = f'logo-{stamp}.{ext}'
    out_path = _branding_dir() / out_name
    f.save(str(out_path))
    try:
        for p in _branding_dir().glob('logo-*.*'):
            if p.name != out_name:
                p.unlink(missing_ok=True)
    except Exception:
        pass
    cur = get_setting('portal', default={}) or {}
    cur = dict(cur)
    cur['logo_name'] = out_name
    cur['logo_enabled'] = True
    set_setting('portal', cur)
    _audit('admin.portal.logo.upload', 'setting', 'portal', True, {'logo_name': out_name})
    return jsonify({'ok': True, 'logo_url': '/admin/portal/logo'})

@bp.route('/api/settings/time', methods=['GET'])
@login_required
@admin_required_json
def api_time_settings_get():
    v = get_setting('time', default={}) or {}
    return jsonify({'timezone': v.get('timezone') or 'Australia/Melbourne', 'ntp_enabled': bool(v.get('ntp_enabled')), 'ntp_server': v.get('ntp_server') or 'pool.ntp.org', 'manual_enabled': bool(v.get('manual_enabled')), 'manual_offset_ms': int(v.get('manual_offset_ms') or 0)})

@bp.route('/api/settings/time', methods=['PUT'])
@login_required
@admin_required_json
def api_time_settings_put():
    payload = request.get_json(force=True, silent=True) or {}
    timezone = (payload.get('timezone') or '').strip() or 'Australia/Melbourne'
    ntp_server = (payload.get('ntp_server') or '').strip() or 'pool.ntp.org'
    ntp_enabled = bool(payload.get('ntp_enabled'))
    set_setting('time', {'timezone': timezone, 'ntp_enabled': ntp_enabled, 'ntp_server': ntp_server})
    _audit('admin.time.save', 'setting', 'time', True, {'timezone': timezone, 'ntp_enabled': ntp_enabled})
    return jsonify({'ok': True})

@bp.route('/api/settings/time/manual', methods=['PUT'])
@login_required
@admin_required_json
def api_time_manual_put():
    payload = request.get_json(force=True, silent=True) or {}
    manual_enabled = bool(payload.get('manual_enabled'))
    try:
        manual_offset_ms = int(payload.get('manual_offset_ms') or 0)
    except Exception:
        return (jsonify({'error': 'invalid manual_offset_ms'}), 400)
    if abs(manual_offset_ms) > 1000 * 60 * 60 * 24 * 365:
        return (jsonify({'error': 'manual_offset_ms too large'}), 400)
    cur = get_setting('time', default={}) or {}
    cur = dict(cur)
    cur['manual_enabled'] = bool(manual_enabled)
    cur['manual_offset_ms'] = int(manual_offset_ms)
    set_setting('time', cur)
    _audit('admin.time.manual.save', 'setting', 'time', True, {'manual_enabled': bool(manual_enabled), 'manual_offset_ms': int(manual_offset_ms)})
    return jsonify({'ok': True, 'manual_offset_ms': int(manual_offset_ms)})

def _ntp_offset_ms(server: str, timeout_s: float=2.0) -> int:
    addr = (server, 123)
    msg = b'\x1b' + 47 * b'\x00'
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout_s)
    try:
        t0 = _time.time()
        s.sendto(msg, addr)
        data, _ = s.recvfrom(1024)
        t1 = _time.time()
    finally:
        try:
            s.close()
        except Exception:
            pass
    if len(data) < 48:
        raise ValueError('invalid NTP response')
    sec, frac = struct.unpack('!II', data[40:48])
    ntp_time = sec - 2208988800 + frac / 2 ** 32
    midpoint = (t0 + t1) / 2.0
    return int(round((ntp_time - midpoint) * 1000.0))

@bp.route('/api/settings/time/ntp-test', methods=['GET'])
@login_required
@admin_required_json
def api_time_ntp_test():
    server = (request.args.get('server') or '').strip() or 'pool.ntp.org'
    if len(server) > 255:
        return (jsonify({'error': 'server too long'}), 400)
    try:
        off = _ntp_offset_ms(server, timeout_s=2.0)
    except Exception as e:
        return (jsonify({'error': f'Could not query NTP server: {e}'}), 502)
    return jsonify({'ok': True, 'server': server, 'offset_ms': off})

@bp.route('/api/settings/audit-syslog', methods=['GET'])
@login_required
@admin_required_json
def api_audit_syslog_settings_get():
    from app.audit_syslog import syslog_settings_for_api
    return jsonify(syslog_settings_for_api())

@bp.route('/api/settings/audit-syslog', methods=['PUT'])
@login_required
@admin_required_json
def api_audit_syslog_settings_put():
    from app.audit_syslog import save_syslog_settings
    payload = request.get_json(force=True, silent=True) or {}
    result = save_syslog_settings(payload)
    if isinstance(result, tuple):
        body, code = result
        return (jsonify(body), code)
    _audit('admin.audit_syslog.save', 'setting', 'audit_syslog', True, {'enabled': bool(result.get('enabled')), 'host': result.get('host') or '', 'port': result.get('port'), 'protocol': result.get('protocol') or 'udp'})
    return jsonify({'ok': True, **result})

@bp.route('/api/settings/audit-syslog/test', methods=['POST'])
@login_required
@admin_required_json
def api_audit_syslog_settings_test():
    from datetime import datetime, timezone
    from app.audit_syslog import build_syslog_message, get_syslog_settings, normalize_syslog_settings, send_syslog_message, send_test_syslog_message
    payload = request.get_json(force=True, silent=True) or {}
    if payload:
        merged = {**(get_setting('audit_syslog', default={}) or {}), **payload}
        cfg = normalize_syslog_settings(merged)
        if not cfg.get('enabled'):
            return (jsonify({'ok': False, 'error': 'Enable syslog forwarding first.'}), 400)
        if not cfg.get('host'):
            return (jsonify({'ok': False, 'error': 'Syslog host is required.'}), 400)
        msg = build_syslog_message(timestamp=datetime.now(timezone.utc), action='admin.audit_syslog.test', username=getattr(current_user, 'username', None), user_id=getattr(current_user, 'id', None), resource_type='setting', resource_id='audit_syslog', ip_address=None, success=True, details={'message': 'Firmgate activity syslog test'}, cfg=cfg)
        ok, err = send_syslog_message(msg, cfg)
    else:
        ok, err = send_test_syslog_message()
    if not ok:
        return (jsonify({'ok': False, 'error': err}), 400)
    _audit('admin.audit_syslog.test', 'setting', 'audit_syslog', True, {})
    return jsonify({'ok': True, 'message': err or 'Test message sent.'})

@bp.route('/api/settings/audit-syslog/replay', methods=['POST'])
@login_required
@admin_required_json
def api_audit_syslog_settings_replay():
    from app.audit_syslog import replay_all_audit_logs_to_syslog
    payload = request.get_json(force=True, silent=True) or {}
    try:
        max_rows = int(payload.get('max_rows') or 50000)
    except (TypeError, ValueError):
        max_rows = 50000
    sent, failed, err = replay_all_audit_logs_to_syslog(max_rows=max_rows)
    if err and sent <= 0:
        return (jsonify({'ok': False, 'error': err, 'sent': sent, 'failed': failed}), 400)
    _audit('admin.audit_syslog.replay', 'setting', 'audit_syslog', True, {'sent': sent, 'failed': failed})
    return jsonify({'ok': True, 'sent': sent, 'failed': failed, 'message': f'Forwarded {sent:,} event(s) to syslog.' + (f' {failed:,} failed.' if failed else '')})

@bp.route('/api/settings/recycle', methods=['GET'])
@login_required
@admin_required_json
def api_recycle_settings_get():
    v = get_setting('recycle', default={}) or {}
    try:
        days = int(v.get('retention_days') or 1)
    except (TypeError, ValueError):
        days = 1
    days = max(0, min(days, 3650))
    return jsonify({'retention_days': days})

@bp.route('/api/settings/recycle', methods=['PUT'])
@login_required
@admin_required_json
def api_recycle_settings_put():
    payload = request.get_json(force=True, silent=True) or {}
    try:
        days = int(payload.get('retention_days'))
    except (TypeError, ValueError):
        days = 1
    days = max(0, min(days, 3650))
    set_setting('recycle', {'retention_days': days})
    _audit('admin.recycle.save', 'setting', 'recycle', True, {'retention_days': days})
    return jsonify({'ok': True, 'retention_days': days})

@bp.route('/api/settings/modules', methods=['GET'])
@login_required
@admin_required_json
def api_modules_settings_get():
    v = get_setting('modules', default={}) or {}
    mods = v.get('modules') if isinstance(v, dict) else None
    if not isinstance(mods, dict):
        mods = {}
    from app.community_edition import apply_community_module_policy, is_community_edition
    mods = apply_community_module_policy(mods)
    return jsonify({'modules': mods, 'community_edition': is_community_edition(), })

@bp.route('/api/settings/modules', methods=['PUT'])
@login_required
@admin_required_json
def api_modules_settings_put():
    payload = request.get_json(force=True, silent=True) or {}
    mods = payload.get('modules')
    if not isinstance(mods, dict):
        return (jsonify({'error': 'modules object required'}), 400)
    allowed_keys = {
        "about",
        "admin",
        "directory",
        "documents",
        "events",
        "game",
        "home",
        "news",
        "security_training",
        "team_chat",
        "wiki",
        "workforce_dashboard",
    }
    out: dict[str, dict] = {}
    for k, raw in mods.items():
        key = str(k or '').strip()
        if key not in allowed_keys:
            continue
        row = raw if isinstance(raw, dict) else {}
        en = row.get('enabled')
        enabled = True if en is None else bool(en)
        restricted = bool(row.get('restricted'))
        ids = row.get('allowed_user_ids')
        if not isinstance(ids, list):
            ids = []
        clean_ids: list[int] = []
        for x in ids[:500]:
            try:
                clean_ids.append(int(x))
            except Exception:
                continue
        seen: set[int] = set()
        clean_ids2: list[int] = []
        for i in clean_ids:
            if i in seen:
                continue
            seen.add(i)
            clean_ids2.append(i)
        out[key] = {'enabled': enabled, 'restricted': restricted, 'allowed_user_ids': clean_ids2}
    from app.community_edition import apply_community_module_policy
    out = apply_community_module_policy(out)
    set_setting('modules', {'modules': out})
    _audit('admin.modules.save', 'setting', 'modules', True, {'count': len(out)})
    from app.community_edition import is_community_edition
    return jsonify({'modules': out, 'community_edition': is_community_edition(), })

def _training_folder() -> FileNode | None:
    """Get or create the Documents folder named 'Security Training' (root folder)."""
    try:
        row = db.session.query(FileNode).filter(FileNode.deleted_at.is_(None), FileNode.is_folder.is_(True), func.lower(FileNode.name) == 'security training').order_by(FileNode.id.desc()).first()
        if row:
            attrs = dict(row.attributes or {})
            changed = False
            if not attrs.get(access.SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR):
                attrs[access.SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR] = True
                changed = True
            if not attrs.get('admin_only'):
                attrs['admin_only'] = True
                changed = True
            if changed:
                row.attributes = attrs
                db.session.add(row)
                db.session.commit()
            return row
    except Exception:
        return None
    try:
        node = FileNode(name='Security Training', is_folder=True, parent_id=None, owner_id=int(current_user.id), attributes={'admin_only': True, access.SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR: True})
        db.session.add(node)
        db.session.commit()
        return node
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass
        return None

def _sync_training_upload_shares(folder: FileNode, allowed_ids: list[int]) -> None:
    """Grant write shares to allowed users and revoke removed users."""
    allow_set = {int(x) for x in allowed_ids if int(x) != int(folder.owner_id)}
    cur_rows = NodeUserShare.query.filter_by(file_node_id=folder.id).all()
    cur_map = {int(r.shared_with_user_id): r for r in cur_rows if r and r.shared_with_user_id is not None}
    for uid, row in cur_map.items():
        if uid not in allow_set:
            try:
                db.session.delete(row)
            except Exception:
                pass
    for uid in sorted(allow_set)[:800]:
        row = cur_map.get(uid)
        if row:
            row.permission = 'write'
            db.session.add(row)
            continue
        db.session.add(NodeUserShare(file_node_id=folder.id, shared_with_user_id=uid, permission='write', granted_by_id=int(current_user.id), created_at=utcnow()))

@bp.route('/api/settings/security-training', methods=['GET'])
@login_required
@admin_required_json
def api_security_training_settings_get():
    from app.security_training_service import security_training_settings_for_api
    return jsonify(security_training_settings_for_api())

@bp.route('/api/settings/security-training', methods=['PUT'])
@login_required
@admin_required_json
def api_security_training_settings_put():
    from app.security_training_service import merge_security_training_settings
    payload = request.get_json(force=True, silent=True) or {}
    if 'allowed_user_ids' in payload:
        ids = payload.get('allowed_user_ids')
        if not isinstance(ids, list):
            ids = []
        clean: list[int] = []
        for x in ids[:800]:
            try:
                clean.append(int(x))
            except Exception:
                continue
        seen: set[int] = set()
        out: list[int] = []
        for i in clean:
            if i in seen:
                continue
            seen.add(i)
            out.append(i)
        folder = _training_folder()
        if folder:
            try:
                attrs = dict(folder.attributes or {})
                attrs['admin_only'] = True
                attrs[access.SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR] = True
                folder.attributes = attrs
                db.session.add(folder)
            except Exception:
                pass
            ok, _ = access.can_access_node(current_user, folder, 'write')
            if ok:
                _sync_training_upload_shares(folder, out)
    result = merge_security_training_settings(payload)
    _audit('admin.security_training.save', 'setting', 'security_training', True, {'uploaders': len(result.get('allowed_user_ids') or []), 'intro_updated': 'page_intro_html' in payload})
    try:
        db.session.commit()
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass
    return jsonify(result)

@bp.route('/api/settings/software-version', methods=['GET'])
@login_required
@admin_required_json
def api_software_version_get():
    enabled = bool(current_app.config.get('ENABLE_SOFTWARE_GIT_UPGRADE', False))
    root = _deploy_root_path()
    state = _merge_software_deploy(get_setting('software_deploy'))
    is_git = _is_git_clone(root)
    live = _git_head(root) if is_git else None
    git_ver = _current_repo_version(root) if is_git else None
    try:
        if is_git and live and (not state.get('current_commit')):
            state['current_commit'] = live
            state['current_deployed_at'] = state.get('current_deployed_at') or _utc_iso()
            state['current_version'] = git_ver or (live[:12] if live else None)
            set_setting('software_deploy', state)
    except Exception:
        pass
    changelog = _software_changelog_payload(root, state)
    return jsonify({'upgrade_enabled': enabled, 'package_upgrade_enabled': bool(current_app.config.get('ENABLE_SOFTWARE_PACKAGE_UPGRADE', True)), 'deploy_root': str(root), 'git_executable': _git_executable(), 'is_git_repo': is_git, 'live_head': live, 'display_version': git_ver or (live[:12] if live else '') or (str(state.get('current_version') or '').strip() or None) or SOFTWARE_DISPLAY_VERSION_DEFAULT, 'git_url': state.get('git_url') or '', 'current_commit': state.get('current_commit'), 'current_deployed_at': state.get('current_deployed_at'), 'previous_commit': state.get('previous_commit'), 'previous_deployed_at': state.get('previous_deployed_at'), 'current_version': state.get('current_version'), 'previous_version': state.get('previous_version'), 'deployments': state.get('deployments') if isinstance(state.get('deployments'), list) else [], 'rollback_available': bool(state.get('previous_commit')), 'changelog': changelog})

@bp.route('/api/settings/software-version/upgrade', methods=['POST'])
@login_required
@admin_required_json
def api_software_version_upgrade_post():
    if not current_app.config.get('ENABLE_SOFTWARE_GIT_UPGRADE', False):
        return (jsonify({'error': 'Git-based upgrades are disabled for this deployment (ENABLE_SOFTWARE_GIT_UPGRADE).'}), 503)
    root = _deploy_root_path()
    if not _is_git_clone(root):
        return (jsonify({'error': f'This deploy path is not a Git working copy (expected a `.git` directory here). Unpacking a ZIP or baking an image without `.git` will not work with Upgrade from Git. Resolved deploy root: {root}. Fix: `git clone` the repo on the server (or set DEPLOY_ROOT to an existing clone). This is separate from the `git` program on PATH — see Software version page for `is_git_repo` / `deploy_root`.'}), 400)
    payload = request.get_json(force=True, silent=True) or {}
    url, verr = _validate_git_remote_url(str(payload.get('git_url') or ''))
    if not url:
        return (jsonify({'error': verr or 'invalid url'}), 400)
    before_version = _current_repo_version(root) or ''
    ok, msg, hb, ha = _perform_git_upgrade(root, url)
    after_version = _current_repo_version(root) or ''
    state = _merge_software_deploy(get_setting('software_deploy'))
    state['git_url'] = url
    heads_changed = bool(ok and hb and ha and (hb != ha))
    if ok:
        old_cur = state.get('current_commit')
        old_cur_at = state.get('current_deployed_at')
        old_ver = state.get('current_version') or before_version or None
        if old_cur:
            state['previous_commit'] = old_cur
            state['previous_deployed_at'] = old_cur_at
            state['previous_version'] = old_ver
        elif hb:
            state['previous_commit'] = hb
            state['previous_deployed_at'] = state.get('previous_deployed_at')
            state['previous_version'] = before_version or None
        now_iso = _utc_iso()
        if ha:
            state['current_commit'] = ha
        state['current_deployed_at'] = now_iso
        state['current_version'] = after_version or before_version or None
        _append_deployment(state, {'action': 'upgrade', 'at': now_iso, 'from_commit': old_cur or hb, 'to_commit': ha or hb, 'from_version': old_ver or before_version or '', 'to_version': after_version or before_version or '', 'message': msg, 'changed': heads_changed})
        set_setting('software_deploy', state)
    _audit('admin.software.upgrade', 'setting', 'software_deploy', bool(ok), {'git_url': url, 'message': msg, 'changed': heads_changed})
    if ok:
        return jsonify({'ok': True, 'message': msg, 'state': state})
    return (jsonify({'error': msg}), 502)

@bp.route('/api/settings/software-version/git-url', methods=['PUT'])
@login_required
@admin_required_json
def api_software_git_url_put():
    """Persist Git remote URL without running an upgrade."""
    payload = request.get_json(force=True, silent=True) or {}
    raw = str(payload.get('git_url') or '').strip()
    if raw:
        url, verr = _validate_git_remote_url(raw)
        if not url:
            return (jsonify({'error': verr or 'invalid url'}), 400)
    else:
        url = ''
    state = _merge_software_deploy(get_setting('software_deploy'))
    state['git_url'] = url
    set_setting('software_deploy', state)
    _audit('admin.software.git_url.save', 'setting', 'software_deploy', True, {'git_url': url})
    return jsonify({'ok': True, 'git_url': url})

@bp.route('/api/settings/software-version/package-upgrade', methods=['POST'])
@login_required
@admin_required_json
def api_software_version_package_upgrade_post():
    if not current_app.config.get('ENABLE_SOFTWARE_PACKAGE_UPGRADE', True):
        return (jsonify({'error': 'Package upload upgrades are disabled (ENABLE_SOFTWARE_PACKAGE_UPGRADE).'}), 503)
    f = request.files.get('file')
    if not f:
        return (jsonify({'error': 'file required'}), 400)
    name = secure_filename(f.filename or 'release.zip')
    if not name.lower().endswith('.zip'):
        return (jsonify({'error': 'zip file required'}), 400)
    root = _deploy_root_path()
    if not root.is_dir():
        return (jsonify({'error': f'Deploy path not found: {root}'}), 400)
    from app.software_package_upgrade import perform_package_upgrade
    with tempfile.TemporaryDirectory(prefix='intranet-pkg-upload-') as td:
        zip_path = Path(td) / 'release.zip'
        try:
            f.save(str(zip_path))
        except Exception as exc:
            return (jsonify({'error': f'Could not save upload: {exc}'}), 400)
        state = _merge_software_deploy(get_setting('software_deploy'))
        before_version = _current_repo_version(root) or str(state.get('current_version') or '')
        ok, msg, meta = perform_package_upgrade(root, zip_path)
        after_version = str(meta.get('after_version') or before_version or '')
        build_id = str(meta.get('build_id') or '')
        if ok:
            old_cur = state.get('current_commit')
            old_cur_at = state.get('current_deployed_at')
            old_ver = state.get('current_version') or before_version or None
            if old_cur or old_ver:
                state['previous_commit'] = old_cur
                state['previous_deployed_at'] = old_cur_at
                state['previous_version'] = old_ver
            elif before_version:
                state['previous_commit'] = f'package:{before_version}' if before_version else None
                state['previous_version'] = before_version or None
            now_iso = _utc_iso()
            state['current_commit'] = f'package:{build_id}' if build_id else None
            state['current_deployed_at'] = now_iso
            state['current_version'] = after_version or before_version or None
            _append_deployment(state, {'action': 'package_upgrade', 'at': now_iso, 'from_commit': old_cur or (f'package:{before_version}' if before_version else ''), 'to_commit': state.get('current_commit') or '', 'from_version': old_ver or before_version or '', 'to_version': after_version or before_version or '', 'message': msg, 'changed': bool(meta.get('changed')), 'package_name': name})
            set_setting('software_deploy', state)
        _audit('admin.software.package_upgrade', 'setting', 'software_deploy', bool(ok), {'file': name, 'message': msg, 'version': after_version})
        if ok:
            return jsonify({'ok': True, 'message': msg, 'state': state})
        return (jsonify({'error': msg}), 502)

@bp.route('/api/settings/software-version/rollback', methods=['POST'])
@login_required
@admin_required_json
def api_software_version_rollback_post():
    if not current_app.config.get('ENABLE_SOFTWARE_GIT_UPGRADE', False):
        return (jsonify({'error': 'Git rollback is disabled for this deployment.'}), 503)
    root = _deploy_root_path()
    state = _merge_software_deploy(get_setting('software_deploy'))
    tgt, terr = _validate_commit_ref(state.get('previous_commit') or '')
    if not tgt:
        return (jsonify({'error': terr or 'No prior commit is recorded yet.'}), 400)
    ok, msg = _perform_git_reset(root, tgt)
    old_cur = state.get('current_commit')
    old_cur_at = state.get('current_deployed_at')
    if ok:
        nh = _git_head(root)
        state['previous_commit'] = old_cur
        state['previous_deployed_at'] = old_cur_at
        state['current_commit'] = nh or tgt
        state['current_deployed_at'] = _utc_iso()
        state['current_version'] = _current_repo_version(root) or (state.get('current_version') or None)
        _append_deployment(state, {'action': 'rollback', 'at': state['current_deployed_at'], 'from_commit': old_cur, 'to_commit': state['current_commit'], 'from_version': state.get('previous_version') or '', 'to_version': state.get('current_version') or '', 'message': msg})
        set_setting('software_deploy', state)
    _audit('admin.software.rollback', 'setting', 'software_deploy', bool(ok), {'target': tgt, 'message': msg})
    if ok:
        return jsonify({'ok': True, 'message': msg, 'state': state})
    return (jsonify({'error': msg}), 502)

@bp.route('/api/settings/registration', methods=['GET'])
@login_required
@admin_required_json
def api_registration_settings_get():
    from app.registration_notifications import notification_settings_for_api
    return jsonify({'self_registration_enabled': regsvc.self_registration_setting_enabled(), 'self_registration_available': regsvc.self_registration_enabled(), 'portal_theme': regsvc.portal_theme_key(), 'notifications': notification_settings_for_api()})

@bp.route('/api/settings/registration/notifications', methods=['GET'])
@login_required
@registration_notifications_required_json
def api_registration_notifications_get():
    from app.registration_notifications import notification_settings_for_api
    return jsonify(notification_settings_for_api())

@bp.route('/api/settings/registration/notifications', methods=['PUT'])
@login_required
@registration_notifications_required_json
def api_registration_notifications_put():
    from app.registration_notifications import notification_settings_for_api, save_notification_settings
    payload = request.get_json(force=True, silent=True) or {}
    result = save_notification_settings(payload)
    if isinstance(result, tuple):
        body, code = result
        return (jsonify(body), code)
    _audit('admin.registration.notifications', 'setting', 'registration_notifications', True, {})
    return jsonify(result)

@bp.route('/api/settings/registration/notifications/test', methods=['POST'])
@login_required
@registration_notifications_required_json
def api_registration_notifications_test():
    from app.registration_notifications import send_test_notification
    payload = request.get_json(force=True, silent=True) or {}
    to_addr = (payload.get('to') or '').strip()
    if not to_addr:
        to_addr = (getattr(current_user, 'email', None) or '').strip()
    if not to_addr or '@' not in to_addr:
        return (jsonify({'ok': False, 'error': 'Enter a valid test recipient email.'}), 400)
    which = (payload.get('which') or 'admin').strip().lower()
    if which not in ('admin', 'registrant', 'approval'):
        which = 'admin'
    ok, msg = send_test_notification(to_addr=to_addr, which=which)
    if not ok:
        return (jsonify({'ok': False, 'error': msg}), 400)
    _audit('admin.registration.notifications.test', 'setting', 'registration_notifications', True, {'to': to_addr, 'which': which})
    return jsonify({'ok': True, 'message': msg})

@bp.route('/api/settings/registration', methods=['PUT'])
@login_required
@admin_required_json
def api_registration_settings_put():
    payload = request.get_json(force=True, silent=True) or {}
    if 'self_registration_enabled' not in payload:
        return (jsonify({'error': 'self_registration_enabled required'}), 400)
    if not regsvc.portal_is_extranet():
        return (jsonify({'error': 'Self-service registration is only available when the portal theme is Extranet.'}), 400)
    if bool(payload.get('self_registration_enabled')):
        from app.premium_license import FEATURE_SELF_REGISTRATION, premium_required
        ok, msg = premium_required(FEATURE_SELF_REGISTRATION)
        if not ok:
            return (jsonify({'error': msg}), 403)
    regsvc.set_self_registration_enabled(bool(payload.get('self_registration_enabled')))
    _audit('admin.registration.settings', 'setting', regsvc.SETTING_SELF_REGISTRATION, True, {'self_registration_enabled': regsvc.self_registration_setting_enabled(), 'portal_theme': regsvc.portal_theme_key()})
    return jsonify({'self_registration_enabled': regsvc.self_registration_setting_enabled(), 'self_registration_available': regsvc.self_registration_enabled(), 'portal_theme': regsvc.portal_theme_key()})

@bp.route('/api/registrations', methods=['GET'])
@login_required
@users_registrations_required_json
def api_registrations_list():
    pending = [regsvc.serialize_registration(u) for u in User.query.order_by(User.id.desc()).all() if regsvc.registration_pending(u)]
    return jsonify({'registrations': pending})

@bp.route('/api/registrations/<int:user_id>/approve', methods=['POST'])
@login_required
@users_registrations_required_json
def api_registration_approve(user_id: int):
    u = db.session.get(User, user_id)
    if not u:
        abort(404)
    if not regsvc.registration_pending(u):
        return (jsonify({'error': 'not a pending registration'}), 400)
    try:
        regsvc.approve_registration(u, db.session)
        db.session.commit()
        _sync_factory_bootstrap_accounts()
        db.session.refresh(u)
        ensure_user_workspace_folder(u)
    except ValueError as exc:
        db.session.rollback()
        return (jsonify({'error': str(exc)}), 400)
    approval_notification: dict[str, Any] = {}
    try:
        from app.registration_notifications import send_registration_approval_notification
        approval_notification = send_registration_approval_notification(u)
    except Exception as exc:
        approval_notification = {'ok': False, 'message': str(exc)}
    _audit('admin.registration.approve', 'user', str(u.id), True, {'email': u.email, 'approval_notification': approval_notification})
    return jsonify({'user': _serialize_user(u), 'approval_notification': approval_notification})

@bp.route('/api/registrations/<int:user_id>/reject', methods=['POST'])
@login_required
@users_registrations_required_json
def api_registration_reject(user_id: int):
    u = db.session.get(User, user_id)
    if not u:
        abort(404)
    if not regsvc.registration_pending(u):
        return (jsonify({'error': 'not a pending registration'}), 400)
    email = u.email or u.username
    regsvc.mark_registration_rejected(u)
    db.session.commit()
    _audit('admin.registration.reject', 'user', str(u.id), True, {'email': email})
    return jsonify({'ok': True})

@bp.route('/api/users', methods=['GET'])
@login_required
@users_admin_access_required_json
def api_users_list():
    users = User.query.order_by(User.username).all()
    return jsonify({'users': [_serialize_user(u) for u in users]})

@bp.route('/api/users', methods=['POST'])
@login_required
@users_create_required_json
def api_users_create():
    payload = request.get_json(force=True, silent=True) or {}
    full_name = (payload.get('full_name') or '').strip() or None
    password = payload.get('password') or ''
    email = _normalize_email(payload.get('email'))
    phone = _normalize_phone(payload.get('phone'))
    if not email:
        return (jsonify({'error': 'email is required'}), 400)
    if len(password) < 6:
        return (jsonify({'error': 'password must be at least 6 characters'}), 400)
    if '@' not in email or len(email) > 255:
        return (jsonify({'error': 'invalid email'}), 400)
    if _email_taken(email):
        return (jsonify({'error': 'email already in use'}), 409)
    if phone and len(phone) > 64:
        return (jsonify({'error': 'phone too long'}), 400)
    username = email.lower()
    if User.query.filter(func.lower(User.username) == username.lower()).first():
        return (jsonify({'error': 'email already in use'}), 409)
    attrs = dict(payload.get('attributes') or {}) if isinstance(payload.get('attributes'), dict) else {}
    if 'mfa_required' not in attrs:
        attrs['mfa_required'] = True
    if attrs.get('mfa_required') and (not rbac.user_can_manage_user_mfa(current_user)):
        return (jsonify({'error': 'forbidden'}), 403)
    if attrs.get('mfa_required') and (not attrs.get('mfa_secret_enc')):
        attrs = dict(attrs)
        attrs['mfa_enrolled'] = False
    u = User(username=username, full_name=full_name, email=email, phone=phone, is_active=bool(payload.get('is_active', True)), attributes=attrs)
    u.set_password(password)
    db.session.add(u)
    db.session.flush()
    _assign_standard_role(u)
    if rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
        group_ids = payload.get('group_ids') or []
        if isinstance(group_ids, list):
            out_g: list[Group] = []
            for gid in group_ids:
                try:
                    g = db.session.get(Group, int(gid))
                    if g:
                        out_g.append(g)
                except (TypeError, ValueError):
                    pass
            u.groups = out_g
    rbac.ensure_user_in_general_group(u, db.session)
    db.session.commit()
    _sync_factory_bootstrap_accounts()
    db.session.refresh(u)
    ensure_user_workspace_folder(u)
    _audit('admin.user.create', 'user', str(u.id), True, {'email': email, 'by_users_create_only': not rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN)})
    return jsonify({'user': _serialize_user(u)})

@bp.route('/api/users/<int:user_id>/reset-mfa', methods=['POST'])
@login_required
@users_admin_access_required_json
def api_users_reset_mfa(user_id: int):
    if not rbac.user_can_reset_user_mfa(current_user):
        return (jsonify({'error': 'forbidden'}), 403)
    from app.mfa_service import mfa_enrolled, mfa_required, reset_user_mfa_enrollment
    u = db.session.get(User, user_id)
    if not u:
        abort(404)
    if not mfa_required(u):
        return (jsonify({'error': 'MFA is not required for this user'}), 400)
    if not mfa_enrolled(u):
        return (jsonify({'error': 'User has not enrolled an authenticator yet'}), 400)
    reset_user_mfa_enrollment(u)
    db.session.commit()
    db.session.refresh(u)
    _audit('admin.user.mfa_reset', 'user', str(u.id), True, {})
    return jsonify({'ok': True, 'user': _serialize_user(u)})

@bp.route('/api/users/<int:user_id>', methods=['PATCH'])
@login_required
@users_admin_access_required_json
def api_users_patch(user_id: int):
    u = db.session.get(User, user_id)
    if not u:
        abort(404)
    payload = request.get_json(force=True, silent=True) or {}
    profile_keys = ('is_active', 'email', 'full_name', 'phone')
    if any((k in payload for k in profile_keys)) and (not rbac.user_can_edit_users(current_user)):
        return (jsonify({'error': 'forbidden'}), 403)
    if 'is_active' in payload:
        new_active = bool(payload['is_active'])
        if not new_active and u.id == current_user.id:
            return (jsonify({'error': 'cannot deactivate yourself'}), 400)
        if not new_active and rbac.user_has_permission(u, rbac.PERMISSION_ADMIN):
            if _count_active_admins() <= 1:
                return (jsonify({'error': 'cannot deactivate the last active administrator'}), 400)
        u.is_active = new_active
    if payload.get('password'):
        if not rbac.user_can_change_user_password(current_user):
            return (jsonify({'error': 'forbidden'}), 403)
        if len(payload['password']) < 6:
            return (jsonify({'error': 'password too short'}), 400)
        u.set_password(payload['password'])
    if 'email' in payload:
        email = _normalize_email(payload.get('email'))
        if email:
            if '@' not in email or len(email) > 255:
                return (jsonify({'error': 'invalid email'}), 400)
            if _email_taken(email, exclude_user_id=u.id):
                return (jsonify({'error': 'email already in use'}), 409)
        u.email = email
        if email:
            u.username = email.lower()
    if 'full_name' in payload:
        u.full_name = (payload.get('full_name') or '').strip() or None
    if 'phone' in payload:
        phone = _normalize_phone(payload.get('phone'))
        if phone and len(phone) > 64:
            return (jsonify({'error': 'phone too long'}), 400)
        u.phone = phone
    if 'attributes' in payload and isinstance(payload['attributes'], dict):
        from app.mfa_service import MFA_ATTR_REQUIRED
        inc = payload['attributes']
        attr_patch: dict = {}
        if MFA_ATTR_REQUIRED in inc:
            if not rbac.user_can_manage_user_mfa(current_user):
                return (jsonify({'error': 'forbidden'}), 403)
            attr_patch[MFA_ATTR_REQUIRED] = inc[MFA_ATTR_REQUIRED]
        for key in ('handle', 'require_pw_change'):
            if key in inc:
                if key == 'require_pw_change' and (not rbac.user_can_change_user_password(current_user)):
                    return (jsonify({'error': 'forbidden'}), 403)
                if key == 'handle' and (not rbac.user_can_edit_users(current_user)):
                    return (jsonify({'error': 'forbidden'}), 403)
                attr_patch[key] = inc[key]
        if attr_patch:
            _merge_user_attributes(u, attr_patch)
    if 'role_ids' in payload and isinstance(payload['role_ids'], list):
        if not rbac.user_can_change_user_role(current_user):
            return (jsonify({'error': 'forbidden'}), 403)
        out_r, role_err = _roles_assignable_by_current_user(payload['role_ids'])
        if role_err:
            return (jsonify({'error': role_err}), 403)
        old_roles = list(u.roles)
        u.roles = out_r
        db.session.flush()
        if _count_active_admins() < 1:
            u.roles = old_roles
            return (jsonify({'error': 'must leave at least one active administrator in the system'}), 400)
    if 'group_ids' in payload and isinstance(payload['group_ids'], list):
        if not rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
            return (jsonify({'error': 'forbidden'}), 403)
        new_groups: list[Group] = []
        for gid in payload['group_ids']:
            try:
                g = db.session.get(Group, int(gid))
                if g:
                    new_groups.append(g)
            except (TypeError, ValueError):
                pass
        u.groups = new_groups
    rbac.ensure_user_in_general_group(u, db.session)
    db.session.commit()
    _sync_factory_bootstrap_accounts()
    db.session.refresh(u)
    _audit('admin.user.patch', 'user', str(u.id), True, {})
    return jsonify({'user': _serialize_user(u)})

@bp.route('/api/users/<int:user_id>', methods=['DELETE'])
@login_required
@users_admin_access_required_json
def api_users_delete(user_id: int):
    if not rbac.user_can_delete_users(current_user):
        return (jsonify({'error': 'forbidden'}), 403)
    if user_id == current_user.id:
        return (jsonify({'error': 'cannot delete yourself'}), 400)
    u = db.session.get(User, user_id)
    if not u:
        abort(404)
    if rbac.user_has_permission(u, rbac.PERMISSION_ADMIN) and _count_active_admins() <= 1:
        return (jsonify({'error': 'cannot delete the last administrator'}), 400)
    payload = request.get_json(force=True, silent=True) or {}
    j_err, justification = validate_deletion_justification(payload)
    if j_err:
        return (jsonify({'error': j_err}), 400)
    uid = u.id
    uname = u.username
    try:
        db.session.delete(u)
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return (jsonify({'error': 'Cannot delete this user while related data still references them.'}), 409)
    except OperationalError:
        db.session.rollback()
        return (jsonify({'error': 'Database error while deleting user.'}), 500)
    _audit('admin.user.delete', 'user', str(uid), True, {'username': uname, 'justification': justification})
    return jsonify({'ok': True})

@bp.route('/api/groups', methods=['GET'])
@login_required
@admin_required_json
def api_groups_list():
    rbac.ensure_builtin_roles(db.session)
    db.session.flush()
    rbac.ensure_general_group(db.session)
    rbac.ensure_all_groups_have_companion_roles(db.session)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise
    groups = Group.query.order_by(Group.name).all()
    return jsonify({'groups': [_serialize_group(g) for g in groups]})

@bp.route('/api/groups', methods=['POST'])
@login_required
@admin_required_json
def api_groups_create():
    payload = request.get_json(force=True, silent=True) or {}
    name = (payload.get('name') or '').strip()
    if not name:
        return (jsonify({'error': 'name required'}), 400)
    if name.strip().lower() == rbac.GENERAL_GROUP_NAME.lower() and rbac.general_group(db.session):
        return (jsonify({'error': 'General group already exists (created automatically for all users).'}), 409)
    if Group.query.filter(func.lower(Group.name) == name.lower()).first():
        return (jsonify({'error': 'group name exists'}), 409)
    g = Group(name=name, description=(payload.get('description') or '').strip() or None)
    db.session.add(g)
    db.session.flush()
    rbac.ensure_group_companion_role(g, db.session)
    rbac.maybe_attach_builtin_roles_for_named_group(g, db.session)
    db.session.commit()
    _audit('admin.group.create', 'group', str(g.id), True, {'name': name})
    return jsonify({'group': _serialize_group(g)})

@bp.route('/api/groups/<int:group_id>', methods=['PATCH'])
@login_required
@admin_required_json
def api_groups_patch(group_id: int):
    g = db.session.get(Group, group_id)
    if not g:
        abort(404)
    payload = request.get_json(force=True, silent=True) or {}
    name_changed = False
    if 'name' in payload:
        nm = (payload['name'] or '').strip()
        if rbac.is_general_group(g) and nm.lower() != rbac.GENERAL_GROUP_NAME.lower():
            return (jsonify({'error': 'The General group cannot be renamed.'}), 400)
        if nm and nm != g.name:
            clash = Group.query.filter(func.lower(Group.name) == nm.lower(), Group.id != g.id).first()
            if clash:
                return (jsonify({'error': 'name taken'}), 409)
            g.name = nm
            name_changed = True
    if 'description' in payload:
        g.description = (payload.get('description') or '').strip() or None
    rbac.ensure_group_companion_role(g, db.session)
    if name_changed:
        rbac.maybe_attach_builtin_roles_for_named_group(g, db.session)
    db.session.commit()
    _audit('admin.group.patch', 'group', str(g.id), True, {})
    return jsonify({'group': _serialize_group(g)})

@bp.route('/api/groups/<int:group_id>', methods=['DELETE'])
@login_required
@admin_required_json
def api_groups_delete(group_id: int):
    g = db.session.get(Group, group_id)
    if not g:
        abort(404)
    if rbac.is_general_group(g):
        return (jsonify({'error': 'The General group cannot be deleted.'}), 400)
    gid = g.id
    companion_rn = rbac.group_companion_role_name(gid)
    db.session.delete(g)
    db.session.flush()
    companion = db.session.query(Role).filter(Role.name == companion_rn).first()
    if companion:
        db.session.delete(companion)
    db.session.commit()
    _audit('admin.group.delete', 'group', str(gid), True, {})
    return jsonify({'ok': True})

@bp.route('/api/groups/<int:group_id>/members', methods=['PUT'])
@login_required
@admin_required_json
def api_groups_put_members(group_id: int):
    g = db.session.get(Group, group_id)
    if not g:
        abort(404)
    payload = request.get_json(force=True, silent=True) or {}
    ids = payload.get('user_ids')
    if not isinstance(ids, list):
        return (jsonify({'error': 'user_ids array required'}), 400)
    if rbac.is_general_group(g):
        users = User.query.order_by(User.id).all()
    else:
        users = [db.session.get(User, int(uid)) for uid in ids]
        users = [u for u in users if u]
        for u in users:
            rbac.ensure_user_in_general_group(u, db.session)
    g.users = users
    db.session.commit()
    _sync_factory_bootstrap_accounts()
    _audit('admin.group.members', 'group', str(g.id), True, {'count': len(users)})
    return jsonify({'group': _serialize_group(g)})

@bp.route('/api/groups/<int:group_id>/roles', methods=['PUT'])
@login_required
@admin_required_json
def api_groups_put_roles(group_id: int):
    g = db.session.get(Group, group_id)
    if not g:
        abort(404)
    payload = request.get_json(force=True, silent=True) or {}
    ids = payload.get('role_ids')
    if not isinstance(ids, list):
        return (jsonify({'error': 'role_ids array required'}), 400)
    roles = [db.session.get(Role, int(rid)) for rid in ids]
    roles = [r for r in roles if r]
    companion_rn = rbac.group_companion_role_name(g.id)
    companion = db.session.query(Role).filter(Role.name == companion_rn).first()
    if not companion:
        rbac.ensure_group_companion_role(g, db.session)
        companion = db.session.query(Role).filter(Role.name == companion_rn).first()
    if companion and companion not in roles:
        roles.append(companion)
    g.roles = roles
    db.session.commit()
    _sync_factory_bootstrap_accounts()
    _audit('admin.group.roles', 'group', str(g.id), True, {'count': len(roles)})
    return jsonify({'group': _serialize_group(g)})

@bp.route('/api/roles', methods=['GET'])
@login_required
@users_admin_access_required_json
def api_roles_list():
    _, _ = rbac.ensure_permission_catalog(db.session)
    rbac.ensure_builtin_roles(db.session)
    db.session.flush()
    rbac.ensure_all_groups_have_companion_roles(db.session)
    db.session.flush()
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise
    roles = Role.query.order_by(Role.name).all()
    if not rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
        admin_role = _admin_role()
        if admin_role:
            roles = [r for r in roles if r.id != admin_role.id]
    perms = Permission.query.order_by(Permission.name).all()
    payload: dict[str, Any] = {'roles': [_serialize_role(r) for r in roles]}
    if rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN):
        payload['permissions'] = [{'id': p.id, 'name': p.name} for p in perms]
    out = jsonify(payload)
    out.headers['Cache-Control'] = 'no-store'
    return out

@bp.route('/api/permissions', methods=['GET'])
@login_required
@admin_required_json
def api_permissions_list():
    _, _ = rbac.ensure_permission_catalog(db.session)
    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise
    perms = Permission.query.order_by(Permission.name).all()
    return jsonify({'permissions': [{'id': p.id, 'name': p.name} for p in perms]})

@bp.route('/api/roles/<int:role_id>/permissions', methods=['PUT'])
@login_required
@admin_required_json
def api_roles_put_permissions(role_id: int):
    r = db.session.get(Role, role_id)
    if not r:
        abort(404)
    payload = request.get_json(force=True, silent=True) or {}
    ids = payload.get('permission_ids')
    if not isinstance(ids, list):
        return (jsonify({'error': 'permission_ids array required'}), 400)
    perms = [db.session.get(Permission, int(pid)) for pid in ids]
    perms = [p for p in perms if p]
    rn = (r.name or '').lower()
    if (rn in ('standard', 'viewer', 'power', 'editor') or rbac.is_group_companion_role_name(r.name)) and any((p.name == rbac.PERMISSION_ADMIN for p in perms)):
        return (jsonify({'error': 'admin.all cannot be assigned to Standard, Power, or per-group roles.'}), 400)
    r.permissions = perms
    db.session.commit()
    db.session.refresh(r)
    _sync_factory_bootstrap_accounts()
    _audit('admin.role.permissions', 'role', str(r.id), True, {'count': len(perms)})
    resp = jsonify({'role': _serialize_role(r)})
    resp.headers['Cache-Control'] = 'no-store'
    return resp
_FACTORY_RESET_CONFIRM = 'FACTORY RESET'

def _unlink_if_exists(path: Path) -> bool:
    try:
        if path.is_file() or path.is_symlink():
            path.unlink()
            return True
    except Exception:
        pass
    return False

def _sqlite_sidecar_paths(db_path: Path) -> tuple[Path, ...]:
    return (db_path, Path(f'{db_path}-wal'), Path(f'{db_path}-shm'), Path(f'{db_path}-journal'), db_path.with_suffix('.bak'))

def _close_sqlalchemy_sqlite_connections() -> None:
    try:
        db.session.remove()
    except Exception:
        pass
    try:
        db.engine.dispose()
    except Exception:
        pass

def _checkpoint_sqlite_before_delete(db_path: Path) -> None:
    """Best-effort WAL flush so delete does not leave a half-written database behind."""
    from sqlalchemy import text
    try:
        with db.engine.connect() as conn:
            conn.execute(text('PRAGMA wal_checkpoint(TRUNCATE)'))
            conn.commit()
    except Exception:
        pass
    _close_sqlalchemy_sqlite_connections()

def _try_remove_sqlite_path(candidate: Path) -> bool:
    """Delete one SQLite path, or rename aside when unlink is blocked (common on Windows/macOS)."""
    if not candidate.exists():
        return True
    if _unlink_if_exists(candidate):
        return not candidate.exists()
    trash = candidate.with_name(f'{candidate.name}.factory-reset-trash.{os.getpid()}.{_time.time_ns()}')
    try:
        if trash.exists():
            trash.unlink()
        candidate.rename(trash)
        trash.unlink(missing_ok=True)
        return not candidate.exists()
    except OSError:
        return not candidate.exists()

def _force_delete_sqlite_database_files(db_path: Path) -> tuple[bool, str]:
    """Remove SQLite database and sidecar files; fail if the main DB file still exists."""
    errors: list[str] = []
    for attempt in range(5):
        _close_sqlalchemy_sqlite_connections()
        if attempt:
            _time.sleep(0.12 * attempt)
        for candidate in _sqlite_sidecar_paths(db_path):
            if not candidate.exists():
                continue
            if _try_remove_sqlite_path(candidate):
                continue
            try:
                errors.append(f'{candidate}: still locked')
            except Exception:
                errors.append(str(candidate))
        if not db_path.exists():
            return (True, '')
    if db_path.exists():
        detail = '; '.join(dict.fromkeys(errors)) if errors else 'file still present after delete attempts'
        return (False, f'Could not remove database file {db_path} ({detail}). Stop other Firmgate processes (Gunicorn workers, a second terminal, Flask debug reloader) and retry.')
    return (True, '')

def _wipe_sqlite_database_in_place(db_path: Path) -> bool:
    """Drop all application tables without deleting the file (works when the OS blocks unlink)."""
    from sqlalchemy import text
    try:
        _checkpoint_sqlite_before_delete(db_path)
        with db.engine.begin() as conn:
            conn.execute(text('PRAGMA foreign_keys=OFF'))
            rows = conn.execute(text("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).fetchall()
            for table_name, in rows:
                safe = str(table_name).replace('"', '""')
                conn.execute(text(f'DROP TABLE IF EXISTS "{safe}"'))
            conn.execute(text('VACUUM'))
        _close_sqlalchemy_sqlite_connections()
        for sidecar in _sqlite_sidecar_paths(db_path):
            if sidecar == db_path:
                continue
            _try_remove_sqlite_path(sidecar)
        return True
    except Exception as exc:
        current_app.logger.warning('in-place SQLite factory wipe failed: %s', exc)
        try:
            db.session.rollback()
        except Exception:
            pass
        _close_sqlalchemy_sqlite_connections()
        return False

def _register_models_for_create_all() -> None:
    pass

def _apply_fresh_database_migrations() -> None:
    """Apply lightweight column/table ensures used on normal app startup."""
    from app import _ensure_blog_post_columns, _ensure_blog_post_published_at_nullable, _ensure_calendar_event_columns, _ensure_file_share_columns, _ensure_node_group_role_share_tables, _ensure_recycle_bin_columns, _ensure_user_contact_columns, _ensure_user_presence_columns, _ensure_wiki_page_content_html_column
    _ensure_user_contact_columns()
    _ensure_user_presence_columns()
    _ensure_recycle_bin_columns()
    _ensure_blog_post_columns()
    _ensure_blog_post_published_at_nullable()
    _ensure_file_share_columns()
    _ensure_calendar_event_columns()
    _ensure_wiki_page_content_html_column()
    _ensure_node_group_role_share_tables()

def _sqlite_core_tables_present() -> bool:
    from sqlalchemy import inspect
    try:
        insp = inspect(db.engine)
        return bool(insp.has_table('permissions') and insp.has_table('users'))
    except Exception:
        return False

def _recreate_sqlite_schema() -> None:
    """Create tables on a brand-new database file and match normal app WAL settings."""
    import sqlite3
    from sqlalchemy import text
    _close_sqlalchemy_sqlite_connections()
    _register_models_for_create_all()
    db.create_all()
    db.session.remove()
    _apply_fresh_database_migrations()
    if not _sqlite_core_tables_present():
        _close_sqlalchemy_sqlite_connections()
        _register_models_for_create_all()
        db.create_all()
        db.session.remove()
        if not _sqlite_core_tables_present():
            raise RuntimeError('Could not create core database tables after factory reset')
    uri = str(current_app.config.get('SQLALCHEMY_DATABASE_URI') or '')
    if uri.startswith('sqlite:///'):
        raw = uri[len('sqlite:///'):]
        try:
            sqlite3.connect(raw).close()
        except Exception:
            pass
    try:
        with db.engine.connect() as conn:
            conn.execute(text('PRAGMA journal_mode=WAL'))
            conn.commit()
    except Exception:
        pass

def _clear_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    for child in list(path.iterdir()):
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            _unlink_if_exists(child)

def _bootstrap_fresh_portal() -> User:
    """Rebuild permissions, roles, and the factory bootstrap admin on an empty database."""
    by_name, _created_perm_names = rbac.ensure_permission_catalog(db.session)
    rbac.ensure_builtin_roles(db.session)
    db.session.flush()
    rbac.apply_standard_power_permission_defaults(db.session, by_name)
    rbac.ensure_admin_role_permissions(db.session, by_name)
    perm = db.session.query(Permission).filter(Permission.name == rbac.PERMISSION_ADMIN).first()
    if not perm:
        perm = Permission(name=rbac.PERMISSION_ADMIN)
        db.session.add(perm)
        db.session.flush()
    role = db.session.query(Role).filter(Role.name == 'admin').first()
    if not role:
        role = Role(name='admin')
        db.session.add(role)
        db.session.flush()
    if perm not in (role.permissions or []):
        role.permissions = list(role.permissions or []) + [perm]
        db.session.add(role)
    email = 'admin@example.com'
    user = User(username=email.lower(), email=email, full_name='Admin', is_active=True, attributes={'department': 'IT', 'factory_bootstrap': True})
    user.set_password('admin')
    user.roles = [role]
    db.session.add(user)
    db.session.flush()
    rbac.ensure_general_group(db.session)
    rbac.ensure_all_users_in_general_group(db.session)
    db.session.commit()
    ensure_user_workspace_folder(user)
    db.session.commit()
    return user

def _emergency_rebuild_after_failed_reset(exc: Exception) -> tuple[bool, str]:
    """If reset deleted the DB but failed mid-flight, rebuild a login-capable portal."""
    try:
        _recreate_sqlite_schema()
        db.session.remove()
        _bootstrap_fresh_portal()
        return (True, f'Factory reset hit an error ({exc}) but the portal was rebuilt. Sign in with admin@example.com / admin, then restart the app server and retry if needed.')
    except Exception as recovery_exc:
        current_app.logger.exception('factory reset emergency recovery failed')
        return (False, f'Factory reset failed ({exc}) and automatic recovery failed ({recovery_exc}). Stop the app server, start it again, then retry factory reset.')

def _perform_factory_reset() -> tuple[bool, str]:
    db_path = _sqlite_db_path()
    if not db_path:
        return (False, 'Factory reset requires a SQLite database.')
    uploads = Path(str(current_app.config.get('UPLOAD_ROOT'))).resolve()
    branding = _branding_dir()
    instance_dir = Path(current_app.instance_path)
    db_wiped = False
    try:
        _checkpoint_sqlite_before_delete(db_path)
        ok_delete, delete_err = _force_delete_sqlite_database_files(db_path)
        if not ok_delete:
            if not _wipe_sqlite_database_in_place(db_path):
                return (False, delete_err)
            db_wiped = True
            current_app.logger.warning('Factory reset: database file could not be unlinked; wiped schema in place (%s)', db_path)
        else:
            db_wiped = True
        _clear_directory(uploads)
        _clear_directory(branding)
        instance_uploads = instance_dir / 'uploads'
        if instance_uploads.resolve() != uploads.resolve():
            _clear_directory(instance_uploads)
        for child in list(instance_dir.iterdir()):
            if child.name in ('branding', 'uploads'):
                continue
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            elif child.is_file():
                _unlink_if_exists(child)
        _recreate_sqlite_schema()
        db.session.remove()
        _bootstrap_fresh_portal()
    except Exception as exc:
        current_app.logger.exception('factory reset failed')
        try:
            db.session.rollback()
        except Exception:
            pass
        _close_sqlalchemy_sqlite_connections()
        if db_wiped:
            recovered, message = _emergency_rebuild_after_failed_reset(exc)
            return (recovered, message)
        return (False, f'Factory reset failed: {exc}')
    return (True, 'Factory reset completed. Sign in with admin@example.com / admin and change the password immediately.')

@bp.route('/api/backup/download', methods=['GET'])
@login_required
@admin_required_json
def api_backup_download():
    db_path = _sqlite_db_path()
    if not db_path or not db_path.exists():
        return (jsonify({'error': 'SQLite database file not found for backup.'}), 400)
    uploads = Path(str(current_app.config.get('UPLOAD_ROOT'))).resolve()
    uploads.mkdir(parents=True, exist_ok=True)
    branding_dir = _branding_dir()
    try:
        import zoneinfo
        syd = zoneinfo.ZoneInfo('Australia/Sydney')
        ts = datetime.now(tz=syd).strftime('%Y-%m-%d_%H%M%S')
    except Exception:
        ts = datetime.now().strftime('%Y-%m-%d_%H%M%S')
    portal_label = _backup_portal_label()
    fname = f'{portal_label}_{ts}.zip'
    mem = io.BytesIO()
    with zipfile.ZipFile(mem, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        z.write(str(db_path), arcname='db.sqlite3')
        for root, _, files in os.walk(str(uploads)):
            for fn in files:
                p = Path(root) / fn
                try:
                    rel = p.relative_to(uploads)
                except Exception:
                    continue
                if is_document_blob_store_uploads_relative(rel):
                    continue
                z.write(str(p), arcname=str(Path('uploads') / rel))
        if branding_dir.is_dir():
            for root, _, files in os.walk(str(branding_dir)):
                for fn in files:
                    bp = Path(root) / fn
                    try:
                        brel = bp.relative_to(branding_dir)
                    except Exception:
                        continue
                    z.write(str(bp), arcname=str(Path('instance') / 'branding' / brel))
        z.writestr('manifest.json', json.dumps(_backup_manifest_dict(), indent=2))
    mem.seek(0)
    _audit('admin.backup.download', 'backup', fname, True, {'db': str(db_path)})
    return send_file(mem, as_attachment=True, download_name=fname, mimetype='application/zip')

@bp.route('/api/backup/restore', methods=['POST'])
@login_required
@admin_required_json
def api_backup_restore():
    f = request.files.get('file')
    if not f:
        return (jsonify({'error': 'file required'}), 400)
    name = secure_filename(f.filename or 'backup.zip')
    if not name.lower().endswith('.zip'):
        return (jsonify({'error': 'zip file required'}), 400)
    db_path = _sqlite_db_path()
    if not db_path:
        return (jsonify({'error': 'Restore requires SQLite database configuration.'}), 400)
    uploads = Path(str(current_app.config.get('UPLOAD_ROOT'))).resolve()
    uploads.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='intranet-restore-') as td:
        tmp = Path(td)
        zip_path = tmp / 'restore.zip'
        f.save(str(zip_path))
        try:
            with zipfile.ZipFile(str(zip_path), 'r') as z:
                z.extractall(str(tmp / 'unzipped'))
        except Exception:
            return (jsonify({'error': 'Could not read zip file.'}), 400)
        unz = (tmp / 'unzipped').resolve()
        new_db = unz / 'db.sqlite3'
        new_uploads = unz / 'uploads'
        if not new_db.exists():
            return (jsonify({'error': 'Zip missing db.sqlite3'}), 400)
        manifest: dict[str, Any] = {}
        mf = unz / 'manifest.json'
        if mf.is_file():
            try:
                raw_m = json.loads(mf.read_text(encoding='utf-8'))
                manifest = raw_m if isinstance(raw_m, dict) else {}
            except Exception:
                manifest = {}
        if 'document_blob_store_included' in manifest:
            doc_blobs_included = bool(manifest.get('document_blob_store_included'))
        else:
            blob_root = new_uploads / 'blobs'
            doc_blobs_included = bool(blob_root.is_dir() and any((p.is_file() for p in blob_root.rglob('*'))))
        try:
            if db_path.exists():
                shutil.copy2(str(db_path), str(db_path.with_suffix('.bak')))
        except Exception:
            pass
        try:
            shutil.copy2(str(new_db), str(db_path))
        except Exception as e:
            return (jsonify({'error': f'Failed to write database: {e}'}), 500)
        preserved_blobs = tmp / '_preserved_uploads_blobs'
        try:
            if new_uploads.exists():
                if not doc_blobs_included:
                    live_blobs = uploads / 'blobs'
                    if live_blobs.exists():
                        shutil.move(str(live_blobs), str(preserved_blobs))
                for child in list(uploads.iterdir()):
                    if child.is_dir():
                        shutil.rmtree(child, ignore_errors=True)
                    else:
                        try:
                            child.unlink()
                        except Exception:
                            pass
                for root, dirs, files in os.walk(str(new_uploads)):
                    rel_root = Path(root).relative_to(new_uploads)
                    if not doc_blobs_included and rel_root.parts and (rel_root.parts[0] == 'blobs'):
                        dirs[:] = []
                        continue
                    out_root = uploads / rel_root
                    out_root.mkdir(parents=True, exist_ok=True)
                    for d in dirs:
                        (out_root / d).mkdir(parents=True, exist_ok=True)
                    for fn in files:
                        src = Path(root) / fn
                        dst = out_root / fn
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(str(src), str(dst))
                if not doc_blobs_included and preserved_blobs.exists():
                    dest_blobs = uploads / 'blobs'
                    if dest_blobs.exists():
                        shutil.rmtree(dest_blobs, ignore_errors=True)
                    shutil.move(str(preserved_blobs), str(dest_blobs))
        except Exception as e:
            return (jsonify({'error': f'Database restored but uploads failed: {e}'}), 500)
        new_branding = unz / 'instance' / 'branding'
        if new_branding.is_dir():
            bd = _branding_dir()
            try:
                for child in list(bd.iterdir()):
                    if child.is_dir():
                        shutil.rmtree(child, ignore_errors=True)
                    else:
                        try:
                            child.unlink()
                        except Exception:
                            pass
                for root, dirs, files in os.walk(str(new_branding)):
                    rel_root = Path(root).relative_to(new_branding)
                    out_root = bd / rel_root
                    out_root.mkdir(parents=True, exist_ok=True)
                    for d in dirs:
                        (out_root / d).mkdir(parents=True, exist_ok=True)
                    for fn in files:
                        src = Path(root) / fn
                        dst = out_root / fn
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(str(src), str(dst))
            except Exception as e:
                return (jsonify({'error': f'Database and uploads restored but portal branding failed: {e}'}), 500)
    _audit('admin.backup.restore', 'backup', name, True, {'db': str(db_path)})
    return jsonify({'ok': True, 'message': 'Restore completed.'})

@bp.route('/api/backup/factory-reset', methods=['POST'])
@login_required
@admin_required_json
def api_backup_factory_reset():
    payload = request.get_json(silent=True) or {}
    phrase = str(payload.get('confirm_phrase') or '').strip()
    if phrase != _FACTORY_RESET_CONFIRM:
        return (jsonify({'error': f'Type "{_FACTORY_RESET_CONFIRM}" to confirm.'}), 400)
    current_app.logger.warning('Factory reset initiated by user_id=%s username=%s', current_user.id, current_user.username)
    ok, message = _perform_factory_reset()
    if not ok:
        return (jsonify({'error': message}), 500)
    return jsonify({'ok': True, 'message': message, 'redirect': url_for('auth.login')})

@bp.route('/api/backup/demo-data', methods=['GET'])
@login_required
@admin_required_json
def api_backup_demo_data_get():
    from app.demo_data_service import demo_data_status
    return jsonify(demo_data_status())

@bp.route('/api/backup/demo-data', methods=['POST'])
@login_required
@admin_required_json
def api_backup_demo_data_post():
    from app.demo_data_service import add_demo_data_batch, demo_data_status
    try:
        added, message = add_demo_data_batch(actor_id=int(current_user.id))
    except Exception as exc:
        current_app.logger.exception('demo data batch failed')
        db.session.rollback()
        return (jsonify({'error': f'Demo data failed: {exc}'}), 500)
    _audit('admin.demo_data.add', 'setting', 'demo_data', True, {'added': added, 'message': message})
    status = demo_data_status()
    return jsonify({'ok': True, 'message': message, 'added': added, 'status': status})
