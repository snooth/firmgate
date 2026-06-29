"""Documents layout: canonical ``Users`` root with one folder per account (``Users/<username>/``)."""

from __future__ import annotations

from app import rbac
from app.extensions import db
from app.models import FileNode, Role, User, utcnow

USERS_ROOT_FOLDER_NAME = "Users"
USERS_ROOT_DISPLAY_NAME = "Users Folder"
USERS_CONTAINER_ATTR = "users_container"
# Must match ``access.SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR`` (avoid importing access here).
_SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR = "security_training_root"


def _skip_when_migrating_user_root_nodes(node: FileNode) -> bool:
    """Do not reparent system roots (Users container, Security Training tree, etc.)."""
    attrs = node.attributes or {}
    if attrs.get(_SECURITY_TRAINING_DOCUMENTS_ROOT_ATTR):
        return True
    if attrs.get(USERS_CONTAINER_ATTR) and node.name == USERS_ROOT_FOLDER_NAME and node.parent_id is None:
        return True
    return False


def is_users_container_folder(node: FileNode) -> bool:
    return bool(
        node
        and node.is_folder
        and node.parent_id is None
        and node.name == USERS_ROOT_FOLDER_NAME
        and (node.attributes or {}).get(USERS_CONTAINER_ATTR)
    )


def is_user_workspace_folder(node: FileNode, user: User) -> bool:
    """True if ``node`` is the canonical ``Users/<username>`` folder for ``user``."""
    if not node or not node.is_folder or not user:
        return False
    p = node.parent
    if not p or not is_users_container_folder(p):
        return False
    return (node.name or "") == (user.username or "")


def _path_key_for(node: FileNode) -> str:
    if node.parent_id is None:
        return "/" + node.name
    parent = node.parent
    if not parent:
        return "/" + node.name
    base = (parent.path_key or _path_key_for(parent)).rstrip("/")
    return base + "/" + node.name


def _collect_subtree(root: FileNode) -> list[FileNode]:
    out: list[FileNode] = []
    stack = [root]
    while stack:
        n = stack.pop()
        out.append(n)
        if n.is_folder:
            for ch in n.children:
                stack.append(ch)
    return out


def _users_root_owner_user_id() -> int:
    row = (
        db.session.query(User.id)
        .join(User.roles)
        .filter(Role.name == "admin")
        .order_by(User.id.asc())
        .first()
    )
    if row:
        return int(row[0])
    u = User.query.order_by(User.id.asc()).first()
    if not u:
        raise RuntimeError("no users in database")
    return int(u.id)


def _safe_username_folder_name(username: str) -> str:
    s = (username or "").strip() or "user"
    return s.replace("/", "_").replace("\\", "_")[:512]


def find_users_root_folder() -> FileNode | None:
    """Return the canonical ``Users`` root if it exists (does not create)."""
    for c in (
        FileNode.query.filter_by(parent_id=None, name=USERS_ROOT_FOLDER_NAME, is_folder=True)
        .filter(FileNode.deleted_at.is_(None))
        .all()
    ):
        if (c.attributes or {}).get(USERS_CONTAINER_ATTR):
            return c
    return None


def get_or_create_users_root() -> FileNode:
    """Return the canonical ``Users`` root folder (creates on first use)."""
    existing = find_users_root_folder()
    if existing:
        return existing

    owner_id = _users_root_owner_user_id()
    users = FileNode(
        name=USERS_ROOT_FOLDER_NAME,
        parent_id=None,
        is_folder=True,
        owner_id=owner_id,
        attributes={USERS_CONTAINER_ATTR: True},
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.session.add(users)
    db.session.flush()
    users.path_key = _path_key_for(users)
    db.session.add(users)
    db.session.commit()
    return users


def _migrate_legacy_root_nodes_into_workspace(user: User, workspace: FileNode) -> None:
    """Move this user's former root-level nodes under ``workspace`` (except the workspace itself)."""
    loose = [
        n
        for n in (
            FileNode.query.filter_by(parent_id=None, owner_id=user.id)
            .filter(FileNode.deleted_at.is_(None))
            .filter(FileNode.id != workspace.id)
            .all()
        )
        if not _skip_when_migrating_user_root_nodes(n)
    ]
    if not loose:
        return

    legacy_home = next((n for n in loose if n.is_folder and n.name == "Home"), None)
    others = [n for n in loose if n.id != (legacy_home.id if legacy_home else None)]

    if legacy_home:
        legacy_home.parent_id = workspace.id
        db.session.add(legacy_home)
        for n in others:
            if n.is_folder:
                n.parent_id = workspace.id
            else:
                n.parent_id = legacy_home.id
            db.session.add(n)
    else:
        for n in others:
            n.parent_id = workspace.id
            db.session.add(n)

    db.session.flush()
    for n in _collect_subtree(workspace):
        n.path_key = _path_key_for(n)
        db.session.add(n)


def ensure_user_workspace_folder(user: User) -> FileNode:
    """
    Ensure ``Users/<username>/`` exists (owned by ``user``) and legacy root content is migrated under it.
    Commits when creating or migrating.
    """
    users_root = get_or_create_users_root()
    uname = _safe_username_folder_name(user.username)
    ws = (
        FileNode.query.filter_by(parent_id=users_root.id, name=uname, is_folder=True)
        .filter(FileNode.deleted_at.is_(None))
        .first()
    )
    if not ws:
        ws = FileNode(
            name=uname,
            parent_id=users_root.id,
            is_folder=True,
            owner_id=user.id,
            attributes={},
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        db.session.add(ws)
        db.session.flush()
        ws.path_key = _path_key_for(ws)
        db.session.add(ws)

    _migrate_legacy_root_nodes_into_workspace(user, ws)
    db.session.commit()
    db.session.refresh(ws)
    return ws


def default_document_home_for_user(user_id: int) -> FileNode | None:
    """
    Profile folder for Documents "All files": ``Users/<username>/`` (created on demand).
    Legacy ``Home`` subfolders remain visible inside that listing but are not the virtual root.
    """
    user = db.session.get(User, user_id)
    if not user:
        return None
    return ensure_user_workspace_folder(user)


def destination_is_blocked_users_root(user: User, dest: FileNode) -> bool:
    """Non-admins may not move/upload/create directly under the ``Users`` container."""
    if not is_users_container_folder(dest):
        return False
    return not (
        rbac.user_has_permission(user, rbac.PERMISSION_FILES_ADMIN) or rbac.user_has_permission(user, rbac.PERMISSION_ADMIN)
    )


def filter_users_root_children_for_lister(user: User, children: list[FileNode]) -> list[FileNode]:
    """Non-admins listing ``Users`` only see their own username folder."""
    if rbac.user_has_permission(user, rbac.PERMISSION_FILES_ADMIN) or rbac.user_has_permission(user, rbac.PERMISSION_ADMIN):
        return children
    uname = (user.username or "").strip()
    return [c for c in children if c.name == uname]
