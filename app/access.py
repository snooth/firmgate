"""Combine RBAC + ABAC + internal user shares for file operations."""
from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select

from app import abac
from app import rbac
from app import files_workspace

if TYPE_CHECKING:
    from app.models import FileNode, User


def _admin_file_access(user: User) -> bool:
    return rbac.user_has_permission(user, rbac.PERMISSION_FILES_ADMIN) or rbac.user_has_permission(
        user, rbac.PERMISSION_ADMIN
    )


# Marked on the canonical "Security Training" Documents folder — hide from Documents browser for non-admins.
SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR = "security_training_root"


def under_security_training_documents_root(node: FileNode) -> bool:
    """True if ``node`` is that folder or lives under it (by attribute chain)."""
    cur: FileNode | None = node
    while cur is not None:
        if bool((cur.attributes or {}).get(SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR)):
            return True
        cur = cur.parent
    return False


def documents_listing_includes_node(user: User, node: FileNode) -> bool:
    """
    Whether the Documents UI should show this node (lists, search, favorites, shares sidebar).
    Security Training materials use /security-training and /api/security-training/assets instead.
    """
    if _admin_file_access(user):
        return True
    return not under_security_training_documents_root(node)


def can_list_files(user: User) -> bool:
    return rbac.user_has_permission(user, rbac.PERMISSION_FILES_LIST)


def _normalize_share_permission(permission: str | None) -> str:
    p = (permission or "read").lower()
    return p if p in ("read", "write") else "read"


def internal_share_grant(user_id: int, node: FileNode) -> str | None:
    """Best read/write grant from this node up to root (user, group, or role shares)."""
    from app.extensions import db
    from app.models import NodeGroupShare, NodeRoleShare, NodeUserShare, User, user_roles

    rank = {"read": 1, "write": 2}
    best: str | None = None

    def bump(permission: str | None) -> None:
        nonlocal best
        p = _normalize_share_permission(permission)
        if best is None or rank[p] > rank[best]:
            best = p

    user = db.session.get(User, user_id)
    group_ids = {g.id for g in (user.groups or []) if g} if user else set()
    role_ids: set[int] = set()
    if user:
        role_ids = {
            int(rid)
            for (rid,) in db.session.execute(
                select(user_roles.c.role_id).where(user_roles.c.user_id == user_id)
            ).all()
        }

    cur: FileNode | None = node
    while cur is not None:
        for sh in NodeUserShare.query.filter_by(file_node_id=cur.id, shared_with_user_id=user_id):
            bump(sh.permission)
        for sh in NodeGroupShare.query.filter_by(file_node_id=cur.id):
            if sh.group_id in group_ids:
                bump(sh.permission)
        for sh in NodeRoleShare.query.filter_by(file_node_id=cur.id):
            if sh.role_id in role_ids:
                bump(sh.permission)
        cur = cur.parent
    return best


def effective_access_role(user: User, node: FileNode) -> str:
    """owner | admin | write | read | none — for UI."""
    if _admin_file_access(user) and node.owner_id != user.id:
        return "admin"
    if node.owner_id == user.id:
        return "owner"
    g = internal_share_grant(user.id, node)
    if g == "write":
        return "write"
    if g == "read":
        return "read"
    return "none"


def can_manage_user_shares(user: User, node: FileNode) -> bool:
    if not rbac.user_has_permission(user, rbac.PERMISSION_FILES_SHARE):
        return False
    if _admin_file_access(user):
        return True
    return node.owner_id == user.id


def can_access_node(user: User, node: FileNode, action: str) -> tuple[bool, str | None]:
    """
    action: list | read | write | delete | move | share | versions
    """
    if not user.is_active:
        return False, "inactive user"

    is_owner = node.owner_id == user.id

    # Share grant for non-owners (used for admin_only bypass, RBAC, and access checks).
    non_owner_share_grant: str | None = internal_share_grant(user.id, node) if not is_owner else None

    # Admin-only folders: hidden from general browsing unless portal admin, folder owner,
    # or the user has an explicit NodeUserShare on this node or an ancestor (e.g. Security Training).
    try:
        cur: FileNode | None = node
        while cur is not None:
            attrs = cur.attributes or {}
            if bool(attrs.get("admin_only")):
                if rbac.user_has_permission(user, rbac.PERMISSION_ADMIN):
                    break
                if cur.owner_id == user.id:
                    break
                if non_owner_share_grant is not None:
                    break
                return False, "admin-only folder"
            cur = cur.parent
    except Exception:
        pass

    perm_map = {
        "list": rbac.PERMISSION_FILES_LIST,
        "read": rbac.PERMISSION_FILES_READ,
        "write": rbac.PERMISSION_FILES_WRITE,
        "delete": rbac.PERMISSION_FILES_DELETE,
        "move": rbac.PERMISSION_FILES_MOVE,
        "share": rbac.PERMISSION_FILES_SHARE,
        "versions": rbac.PERMISSION_FILES_VERSIONS,
    }
    # Canonical ``Users`` root: list/read for any user with file permissions; no writes for non-admins.
    if files_workspace.is_users_container_folder(node) and not _admin_file_access(user):
        if action in ("read", "list"):
            needed_uc = perm_map.get(action)
            if needed_uc and rbac.user_has_permission(user, needed_uc):
                return True, None
        return False, "users container"

    needed = perm_map.get(action)
    # Enforce granular file permissions for everyone (including owners of their own tree).
    # Portal/files admins bypass via ``_admin_file_access``. Internal shares still lift read/write
    # for recipients when the role omits those permissions (see below).
    if needed and not rbac.user_has_permission(user, needed) and not _admin_file_access(user):
        if is_owner:
            return False, "RBAC: missing permission"
        # Explicit internal share grants access even when the role omits file permissions.
        if non_owner_share_grant is None:
            return False, "RBAC: missing permission"
        if needed not in (
            rbac.PERMISSION_FILES_LIST,
            rbac.PERMISSION_FILES_READ,
            rbac.PERMISSION_FILES_VERSIONS,
            rbac.PERMISSION_FILES_WRITE,
            rbac.PERMISSION_FILES_MOVE,
        ):
            return False, "RBAC: missing permission"
        if needed in (rbac.PERMISSION_FILES_WRITE, rbac.PERMISSION_FILES_MOVE) and non_owner_share_grant != "write":
            return False, "RBAC: missing permission"

    if _admin_file_access(user):
        return True, None

    grant = non_owner_share_grant

    # Personal files/folders are private to the owner unless explicitly shared.
    if (node.attributes or {}).get("personal") and not is_owner:
        if grant is None:
            return False, "personal file (not shared)"

    if action == "delete":
        if not is_owner:
            return False, "only owner can delete"
        ok, reason = abac.evaluate_file_access(user, node, action)
        if not ok:
            return False, reason
        return True, None

    if action == "move":
        if is_owner:
            ok, reason = abac.evaluate_file_access(user, node, action)
            if not ok:
                return False, reason
            return True, None
        # Write share recipients may reorganize within the owner's tree (destination checks in API).
        if grant != "write":
            return False, "read-only share"
        ok, reason = abac.evaluate_file_access(user, node, action)
        if not ok:
            return False, reason
        return True, None

    if action == "share":
        if not is_owner:
            return False, "only owner can manage sharing"
        ok, reason = abac.evaluate_file_access(user, node, action)
        if not ok:
            return False, reason
        return True, None

    if is_owner:
        ok, reason = abac.evaluate_file_access(user, node, action)
        if not ok:
            return False, reason
        return True, None

    if grant is None:
        return False, "not owner"

    if action == "write" and grant == "read":
        return False, "read-only share"

    if action in ("read", "list", "versions", "write"):
        ok, reason = abac.evaluate_file_access(user, node, action)
        if not ok:
            return False, reason
        return True, None

    return False, "not owner"
