"""Live edit-session presence for Documents (who has a file open in the editor)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from app.extensions import db
from app.models import FileNode, FileNodeEditSession, User, utcnow

SESSION_STALE_AFTER = timedelta(seconds=90)


def _user_display_name(u: User | None) -> str:
    if not u:
        return "Unknown user"
    return (u.full_name or u.username or u.email or f"User {u.id}").strip()


def clear_onlyoffice_doc_key_if_idle(node_id: int) -> None:
    """Drop stored OnlyOffice key when nobody has the file open."""
    remaining = (
        db.session.query(FileNodeEditSession.id)
        .filter_by(file_node_id=int(node_id))
        .first()
    )
    if remaining:
        return
    db.session.query(FileNode).filter_by(id=int(node_id)).update({"onlyoffice_doc_key": None})
    db.session.commit()


def _prune_stale_sessions() -> None:
    cutoff = utcnow() - SESSION_STALE_AFTER
    stale_node_ids = [
        int(r[0])
        for r in db.session.query(FileNodeEditSession.file_node_id)
        .filter(FileNodeEditSession.last_seen_at < cutoff)
        .distinct()
        .all()
    ]
    deleted = (
        db.session.query(FileNodeEditSession)
        .filter(FileNodeEditSession.last_seen_at < cutoff)
        .delete(synchronize_session=False)
    )
    if deleted:
        db.session.commit()
        for nid in stale_node_ids:
            clear_onlyoffice_doc_key_if_idle(nid)


def _session_payload(rows: list[FileNodeEditSession]) -> list[dict[str, Any]]:
    if not rows:
        return []
    user_ids = {r.user_id for r in rows}
    users = {}
    if user_ids:
        for u in db.session.query(User).filter(User.id.in_(user_ids)).all():
            users[u.id] = u
    out: list[dict[str, Any]] = []
    for r in rows:
        u = users.get(r.user_id) or r.user
        out.append(
            {
                "user_id": r.user_id,
                "user_name": _user_display_name(u),
                "last_seen_at": r.last_seen_at.isoformat() if r.last_seen_at else None,
            }
        )
    return out


def touch_edit_session(node: FileNode, user: User) -> dict[str, Any] | None:
    if node.is_folder or node.deleted_at is not None:
        return None
    _prune_stale_sessions()
    row = (
        db.session.query(FileNodeEditSession)
        .filter_by(file_node_id=int(node.id), user_id=int(user.id))
        .first()
    )
    now = utcnow()
    if row:
        row.last_seen_at = now
    else:
        row = FileNodeEditSession(file_node_id=int(node.id), user_id=int(user.id), last_seen_at=now)
        db.session.add(row)
    db.session.commit()
    return _session_payload([row])[0]


def release_edit_session(node: FileNode, user: User) -> None:
    if node.is_folder:
        return
    node_id = int(node.id)
    (
        db.session.query(FileNodeEditSession)
        .filter_by(file_node_id=node_id, user_id=int(user.id))
        .delete(synchronize_session=False)
    )
    db.session.commit()
    clear_onlyoffice_doc_key_if_idle(node_id)


def active_sessions_for_node_ids(node_ids: list[int]) -> dict[int, list[FileNodeEditSession]]:
    if not node_ids:
        return {}
    _prune_stale_sessions()
    rows = (
        db.session.query(FileNodeEditSession)
        .filter(FileNodeEditSession.file_node_id.in_(node_ids))
        .order_by(FileNodeEditSession.last_seen_at.desc())
        .all()
    )
    out: dict[int, list[FileNodeEditSession]] = {int(nid): [] for nid in node_ids}
    for r in rows:
        out.setdefault(int(r.file_node_id), []).append(r)
    return out


def attach_edit_fields(items: list[dict[str, Any]]) -> None:
    """Mutate serialized file nodes in place with active editor presence."""
    file_ids = [int(it["id"]) for it in items if not it.get("is_folder")]
    if not file_ids:
        return
    by_id = active_sessions_for_node_ids(file_ids)
    for it in items:
        if it.get("is_folder"):
            continue
        rows = by_id.get(int(it["id"])) or []
        it["editing"] = _session_payload(rows) if rows else []


def edit_sessions_map(node_ids: list[int]) -> dict[str, list[dict[str, Any]]]:
    by_id = active_sessions_for_node_ids(node_ids)
    return {str(nid): _session_payload(by_id.get(int(nid)) or []) for nid in node_ids}
