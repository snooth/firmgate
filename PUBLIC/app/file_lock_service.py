"""Exclusive edit locks for Documents files."""

from __future__ import annotations

from typing import Any

from app.extensions import db
from app.models import FileNode, FileNodeLock, User, utcnow


def _user_display_name(u: User | None) -> str:
    if not u:
        return "Unknown user"
    return (u.full_name or u.username or u.email or f"User {u.id}").strip()


def lock_payload(lock: FileNodeLock | None) -> dict[str, Any] | None:
    if not lock:
        return None
    u = lock.locked_by or db.session.get(User, lock.locked_by_id)
    return {
        "locked": True,
        "locked_by_id": lock.locked_by_id,
        "locked_by_name": _user_display_name(u),
        "locked_at": lock.locked_at.isoformat() if lock.locked_at else None,
    }


def get_lock_for_node(node_id: int) -> FileNodeLock | None:
    return (
        db.session.query(FileNodeLock)
        .filter_by(file_node_id=int(node_id))
        .first()
    )


def locks_for_node_ids(node_ids: list[int]) -> dict[int, FileNodeLock]:
    if not node_ids:
        return {}
    rows = db.session.query(FileNodeLock).filter(FileNodeLock.file_node_id.in_(node_ids)).all()
    return {int(r.file_node_id): r for r in rows}


def attach_lock_fields(items: list[dict[str, Any]]) -> None:
    """Mutate serialized file nodes in place with lock metadata."""
    file_ids = [int(it["id"]) for it in items if not it.get("is_folder")]
    if not file_ids:
        return
    by_id = locks_for_node_ids(file_ids)
    user_ids = {lk.locked_by_id for lk in by_id.values()}
    users = {}
    if user_ids:
        for u in db.session.query(User).filter(User.id.in_(user_ids)).all():
            users[u.id] = u
    for it in items:
        if it.get("is_folder"):
            continue
        lk = by_id.get(int(it["id"]))
        if not lk:
            it["lock"] = None
            continue
        u = users.get(lk.locked_by_id) or lk.locked_by
        it["lock"] = {
            "locked": True,
            "locked_by_id": lk.locked_by_id,
            "locked_by_name": _user_display_name(u),
            "locked_at": lk.locked_at.isoformat() if lk.locked_at else None,
        }


def is_locked_by_other(node: FileNode, user_id: int) -> bool:
    if node.is_folder:
        return False
    lk = get_lock_for_node(node.id)
    return bool(lk and int(lk.locked_by_id) != int(user_id))


def assert_can_edit_locked_node(node: FileNode, user: User, *, files_admin: bool = False) -> tuple[bool, str | None]:
    """Return (ok, error_message) when a write action is attempted on a locked file."""
    if node.is_folder:
        return True, None
    lk = get_lock_for_node(node.id)
    if not lk:
        return True, None
    if int(lk.locked_by_id) == int(user.id) or files_admin:
        return True, None
    u = lk.locked_by or db.session.get(User, lk.locked_by_id)
    return False, f"Locked by {_user_display_name(u)}"


def acquire_lock(node: FileNode, user: User) -> tuple[dict[str, Any] | None, str | None]:
    if node.is_folder:
        return None, "Folders cannot be locked"
    if node.deleted_at is not None:
        return None, "File not found"
    existing = get_lock_for_node(node.id)
    if existing:
        if int(existing.locked_by_id) == int(user.id):
            return lock_payload(existing), None
        u = existing.locked_by or db.session.get(User, existing.locked_by_id)
        return None, f"Already locked by {_user_display_name(u)}"
    lk = FileNodeLock(file_node_id=node.id, locked_by_id=user.id, locked_at=utcnow())
    db.session.add(lk)
    db.session.commit()
    return lock_payload(lk), None


def release_lock(node: FileNode, user: User, *, files_admin: bool = False) -> tuple[bool, str | None]:
    """Release a lock. ``files_admin`` = portal admin (admin.all) may release any lock."""
    if node.is_folder:
        return False, "Folders cannot be locked"
    lk = get_lock_for_node(node.id)
    if not lk:
        return True, None
    if int(lk.locked_by_id) != int(user.id) and not files_admin:
        u = lk.locked_by or db.session.get(User, lk.locked_by_id)
        return False, f"Locked by {_user_display_name(u)} — only they or a files admin can release it"
    db.session.delete(lk)
    db.session.commit()
    return True, None
