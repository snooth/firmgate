"""Human-readable application version labels for Administration → Software version."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_VERSION_FILE = "version"
_GIT_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$", re.I)
_SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)(?:\.(\d+))?", re.I)
_BUILD_SUFFIX_RE = re.compile(r"\s*[·•]\s*build\s+[0-9a-f]+\s*$", re.I)


def is_git_sha_like(value: str | None) -> bool:
    s = (value or "").strip()
    if not s:
        return False
    if s.startswith("package:"):
        s = s.split(":", 1)[1]
    return bool(_GIT_SHA_RE.fullmatch(s))


def is_meaningless_version(value: str | None) -> bool:
    """True when a stored label is a bare git sha or package build hash."""
    s = (value or "").strip()
    if not s:
        return True
    if is_git_sha_like(s):
        return True
    if s.startswith("package-"):
        return True
    if _BUILD_SUFFIX_RE.search(s):
        return True
    return False


def normalize_version_label(value: str | None) -> str:
    """Normalize to vMAJOR.MINOR[.PATCH] when possible."""
    s = (value or "").strip()
    if not s:
        return ""
    s = _BUILD_SUFFIX_RE.sub("", s).strip()
    if is_git_sha_like(s):
        return ""
    if s.startswith("package-"):
        return ""
    m = _SEMVER_RE.match(s)
    if m:
        major, minor, patch = m.group(1), m.group(2), m.group(3)
        if patch is not None:
            return f"v{major}.{minor}.{patch}"
        return f"v{major}.{minor}"
    if s.lower().startswith("v"):
        return s
    return s


def read_version_file(root: Path) -> str:
    path = root / _VERSION_FILE
    try:
        if not path.is_file():
            return ""
        return normalize_version_label(path.read_text(encoding="utf-8"))
    except OSError:
        return ""


def resolve_deploy_version(root: Path, git_describe: str | None = None) -> str:
    """
    Best human version for a deploy tree: version file first, then a tagged git
    describe (never a bare commit sha).
    """
    from_file = read_version_file(root)
    if from_file:
        return from_file
    git_label = normalize_version_label(git_describe)
    if git_label:
        return git_label
    return ""


def format_deploy_version(base: str, revision: int) -> str:
    """
    First deploy of a release shows v2.44; subsequent deploys of the same release
    increment the patch: v2.44.1, v2.44.2, …
    """
    base = normalize_version_label(base)
    if not base:
        base = "v2.0"
    rev = max(1, int(revision or 1))
    if rev <= 1:
        return base
    m = _SEMVER_RE.match(base)
    if m and m.group(3) is None:
        major, minor = m.group(1), m.group(2)
        return f"v{major}.{minor}.{rev - 1}"
    if m and m.group(3) is not None:
        major, minor, patch = m.group(1), m.group(2), m.group(3)
        return f"v{major}.{minor}.{int(patch) + rev - 1}"
    return f"{base}.{rev - 1}"


def record_deploy_version(state: dict[str, Any], base: str) -> str:
    """Bump deploy revision for this release base and return the display label."""
    base = normalize_version_label(base) or "v2.0"
    prev_base = normalize_version_label(str(state.get("release_base") or ""))
    rev = int(state.get("deploy_revision") or 0)
    if not prev_base or prev_base != base:
        rev = 0
    rev += 1
    state["release_base"] = base
    state["deploy_revision"] = rev
    label = format_deploy_version(base, rev)
    state["current_version"] = label
    state["display_version"] = label
    return label


def software_display_version(
    state: dict[str, Any],
    *,
    deploy_root: Path,
    git_describe: str | None = None,
) -> str:
    recorded = normalize_version_label(str(state.get("current_version") or ""))
    if recorded and not is_meaningless_version(recorded) and state.get("current_deployed_at"):
        rev = int(state.get("deploy_revision") or 0)
        base = normalize_version_label(str(state.get("release_base") or "")) or recorded
        if rev > 1:
            return format_deploy_version(base, rev)
        return recorded
    resolved = resolve_deploy_version(deploy_root, git_describe)
    if resolved:
        rev = int(state.get("deploy_revision") or 0) or 1
        base = normalize_version_label(str(state.get("release_base") or "")) or resolved
        if rev > 1 and base == resolved:
            return format_deploy_version(base, rev)
        return resolved
    stored = normalize_version_label(str(state.get("display_version") or ""))
    if stored and not is_meaningless_version(stored):
        return stored
    return "v2.0"
