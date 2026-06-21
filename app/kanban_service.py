"""KanBan board helpers: default board seeding, serialization, card moves."""

from __future__ import annotations

from typing import Any

from app.extensions import db
from app.models import (
    Group,
    KanbanBoard,
    KanbanBoardActivity,
    KanbanCard,
    KanbanCardActivity,
    KanbanCardAttachment,
    KanbanCardComment,
    KanbanColumn,
    User,
    utcnow,
)

DEFAULT_TODO_TITLE = "To do"

DEFAULT_COLUMNS: tuple[tuple[str, str], ...] = (
    (DEFAULT_TODO_TITLE, "blue"),
)


DEFAULT_BOARD_SUBTITLE = "Drag cards between columns to update status."


def _seed_board_columns(board: KanbanBoard) -> None:
    for idx, (title, color) in enumerate(DEFAULT_COLUMNS):
        db.session.add(
            KanbanColumn(
                board_id=board.id,
                title=title,
                position=idx,
                color_token=color,
            )
        )


def create_board(*, name: str, user_id: int | None = None, subtitle: str | None = None) -> KanbanBoard:
    board = KanbanBoard(
        name=(name or "KanBan").strip()[:120] or "KanBan",
        subtitle=(subtitle or DEFAULT_BOARD_SUBTITLE).strip()[:240] or DEFAULT_BOARD_SUBTITLE,
        created_by_id=user_id,
    )
    db.session.add(board)
    db.session.flush()
    _seed_board_columns(board)
    db.session.commit()
    return board


def ensure_default_board(*, user_id: int | None = None) -> KanbanBoard:
    board = db.session.query(KanbanBoard).order_by(KanbanBoard.id.asc()).first()
    if board:
        return board
    return create_board(name="Team board", user_id=user_id)


def get_board_for_user(board_id: int, user: User) -> KanbanBoard | None:
    board = db.session.get(KanbanBoard, int(board_id))
    if not board or not kanban_can_read_board(user, board):
        return None
    return board


def list_accessible_boards(user: User) -> list[KanbanBoard]:
    boards = db.session.query(KanbanBoard).order_by(KanbanBoard.name.asc(), KanbanBoard.id.asc()).all()
    return [board for board in boards if kanban_can_read_board(user, board)]


def board_active_card_count(board_id: int) -> int:
    return int(
        db.session.query(KanbanCard.id)
        .join(KanbanColumn, KanbanCard.column_id == KanbanColumn.id)
        .filter(KanbanColumn.board_id == int(board_id), KanbanCard.deleted_at.is_(None))
        .count()
    )


def serialize_board_summary(board: KanbanBoard, *, user: User | None = None) -> dict[str, Any]:
    from flask import url_for

    columns = sorted(board.columns or [], key=lambda c: (int(c.position or 0), int(c.id)))
    card_count = board_active_card_count(int(board.id))
    done_col = find_done_column(board)
    done_count = len(_active_cards(done_col.cards)) if done_col else 0
    try:
        board_url = url_for("intranet.kanban_board_page", board_id=int(board.id))
    except Exception:
        board_url = f"/intranet/kanban/board/{int(board.id)}"
    out = {
        "id": int(board.id),
        "name": board.name or "KanBan",
        "subtitle": (board.subtitle or DEFAULT_BOARD_SUBTITLE).strip(),
        "column_count": len(columns),
        "card_count": card_count,
        "done_count": done_count,
        "open_count": max(0, card_count - done_count),
        "url": board_url,
    }
    if user is not None:
        out["can_delete"] = kanban_can_admin_delete_board(user)
    return out


def _user_label(user: User | None) -> str:
    if not user:
        return ""
    return (user.full_name or user.username or user.email or "").strip()


def _active_cards(cards: list[KanbanCard] | None) -> list[KanbanCard]:
    rows = cards or []
    return [c for c in rows if getattr(c, "deleted_at", None) is None]


def _coerce_json_list(raw: Any) -> list[Any]:
    return raw if isinstance(raw, list) else []


def normalize_user_shares(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[int] = set()
    for row in _coerce_json_list(raw):
        if not isinstance(row, dict):
            continue
        try:
            uid = int(row.get("user_id"))
        except (TypeError, ValueError):
            continue
        if uid in seen:
            continue
        seen.add(uid)
        out.append({"user_id": uid, "can_edit": bool(row.get("can_edit"))})
    return out[:200]


def normalize_group_shares(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[int] = set()
    for row in _coerce_json_list(raw):
        if not isinstance(row, dict):
            continue
        try:
            gid = int(row.get("group_id"))
        except (TypeError, ValueError):
            continue
        if gid in seen:
            continue
        seen.add(gid)
        out.append({"group_id": gid, "can_edit": bool(row.get("can_edit"))})
    return out[:200]


def kanban_user_group_ids(user: User) -> set[int]:
    return {int(g.id) for g in (user.groups or [])}


def kanban_user_board_access(user: User, board: KanbanBoard) -> str | None:
    from app import rbac

    if rbac.user_has_permission(user, rbac.PERMISSION_ADMIN):
        return "admin"
    if board.created_by_id and int(board.created_by_id) == int(user.id):
        return "write"
    for entry in normalize_user_shares(board.shared_users):
        if int(entry["user_id"]) == int(user.id):
            return "write" if entry.get("can_edit") else "read"
    group_ids = kanban_user_group_ids(user)
    for entry in normalize_group_shares(board.shared_groups):
        if int(entry["group_id"]) in group_ids:
            return "write" if entry.get("can_edit") else "read"
    if rbac.user_has_permission(user, rbac.PERMISSION_KANBAN_WRITE):
        return "write"
    if rbac.user_has_permission(user, rbac.PERMISSION_KANBAN_READ):
        return "read"
    return None


def kanban_can_read_board(user: User, board: KanbanBoard) -> bool:
    return kanban_user_board_access(user, board) is not None


def kanban_can_write_board(user: User, board: KanbanBoard) -> bool:
    return kanban_user_board_access(user, board) in ("write", "admin")


def kanban_can_delete_board(user: User, board: KanbanBoard) -> bool:
    from app import rbac

    role = kanban_user_board_access(user, board)
    if role == "admin":
        return True
    if role != "write":
        return False
    return rbac.user_has_permission(user, rbac.PERMISSION_KANBAN_DELETE) or rbac.user_has_permission(
        user, rbac.PERMISSION_ADMIN
    )


def kanban_can_admin_delete_board(user: User) -> bool:
    from app import rbac

    return rbac.user_has_permission(user, rbac.PERMISSION_ADMIN)


def delete_board(board: KanbanBoard) -> None:
    from app.file_storage import absolute_path

    row = db.session.get(KanbanBoard, int(board.id)) or board
    for col in row.columns or []:
        for card in col.cards or []:
            for att in card.attachments or []:
                try:
                    path = absolute_path(att.storage_relpath)
                    if path.is_file():
                        path.unlink()
                except Exception:
                    pass
    db.session.delete(row)
    db.session.commit()


def list_kanban_share_targets() -> dict[str, list[dict[str, Any]]]:
    users = (
        db.session.query(User)
        .filter(User.is_active.is_(True))
        .order_by(User.full_name.asc(), User.username.asc())
        .limit(500)
        .all()
    )
    groups = db.session.query(Group).order_by(Group.name.asc()).limit(200).all()
    return {
        "users": [
            {
                "id": int(u.id),
                "name": (u.full_name or u.username or u.email or "").strip(),
                "email": (u.email or "").strip(),
            }
            for u in users
            if (u.full_name or u.username or u.email or "").strip()
        ],
        "groups": [
            {
                "id": int(g.id),
                "name": (g.name or "").strip(),
                "member_count": len(g.users or []),
            }
            for g in groups
            if (g.name or "").strip()
        ],
    }


def serialize_board_share_user(entry: dict[str, Any]) -> dict[str, Any]:
    user = db.session.get(User, int(entry["user_id"]))
    return {
        "user_id": int(entry["user_id"]),
        "can_edit": bool(entry.get("can_edit")),
        "name": _user_label(user),
        "email": (user.email or user.username or "").strip() if user else "",
        "is_active": bool(user and user.is_active),
    }


def serialize_board_share_group(entry: dict[str, Any]) -> dict[str, Any]:
    group = db.session.get(Group, int(entry["group_id"]))
    return {
        "group_id": int(entry["group_id"]),
        "can_edit": bool(entry.get("can_edit")),
        "name": (group.name or "").strip() if group else "",
        "member_count": len(group.users or []) if group else 0,
    }


def serialize_board_general(board: KanbanBoard, *, access: str | None = None) -> dict[str, Any]:
    users = normalize_user_shares(board.shared_users)
    groups = normalize_group_shares(board.shared_groups)
    deleted_count = (
        db.session.query(KanbanCard.id)
        .join(KanbanColumn, KanbanCard.column_id == KanbanColumn.id)
        .filter(KanbanColumn.board_id == int(board.id), KanbanCard.deleted_at.isnot(None))
        .count()
    )
    out: dict[str, Any] = {
        "board_id": int(board.id),
        "board_name": board.name or "KanBan",
        "board_subtitle": (board.subtitle or DEFAULT_BOARD_SUBTITLE).strip(),
        "access": access or "",
        "can_edit_settings": access in ("write", "admin"),
        "can_manage_shares": access in ("write", "admin"),
        "shared_users": [serialize_board_share_user(u) for u in users],
        "shared_groups": [serialize_board_share_group(g) for g in groups],
        "deleted_count": int(deleted_count),
    }
    if access in ("write", "admin"):
        out["share_targets"] = list_kanban_share_targets()
    return out


def serialize_deleted_card(card: KanbanCard) -> dict[str, Any]:
    col = card.column
    return {
        "id": int(card.id),
        "title": card.title or "",
        "column_title": (col.title if col else "") or "",
        "deleted_at": card.deleted_at.isoformat() if card.deleted_at else None,
        "deleted_by_name": _user_label(card.deleted_by),
    }


def serialize_board_activity_item(
    *,
    action: str,
    created_at,
    user_name: str,
    details: dict[str, Any] | None = None,
    card_id: int | None = None,
    card_title: str = "",
    source: str = "board",
    item_id: int | None = None,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "source": source,
        "action": action or "",
        "details": details if isinstance(details, dict) else {},
        "created_at": created_at.isoformat() if created_at else None,
        "user_name": user_name or "",
        "card_id": int(card_id) if card_id else None,
        "card_title": card_title or "",
    }


def board_activity_feed(board_id: int, *, limit: int = 100) -> list[dict[str, Any]]:
    limit = max(1, min(200, int(limit)))
    board_rows = (
        db.session.query(KanbanBoardActivity)
        .filter(KanbanBoardActivity.board_id == int(board_id))
        .order_by(KanbanBoardActivity.created_at.desc(), KanbanBoardActivity.id.desc())
        .limit(limit)
        .all()
    )
    card_rows = (
        db.session.query(KanbanCardActivity, KanbanCard)
        .join(KanbanCard, KanbanCardActivity.card_id == KanbanCard.id)
        .join(KanbanColumn, KanbanCard.column_id == KanbanColumn.id)
        .filter(KanbanColumn.board_id == int(board_id))
        .order_by(KanbanCardActivity.created_at.desc(), KanbanCardActivity.id.desc())
        .limit(limit)
        .all()
    )
    merged: list[dict[str, Any]] = []
    for row in board_rows:
        card_title = ""
        if row.card_id:
            card = db.session.get(KanbanCard, int(row.card_id))
            card_title = (card.title if card else "") or ""
        merged.append(
            serialize_board_activity_item(
                action=row.action or "",
                created_at=row.created_at,
                user_name=_user_label(row.user),
                details=row.details if isinstance(row.details, dict) else {},
                card_id=int(row.card_id) if row.card_id else None,
                card_title=card_title,
                source="board",
                item_id=int(row.id),
            )
        )
    for activity, card in card_rows:
        merged.append(
            serialize_board_activity_item(
                action=activity.action or "",
                created_at=activity.created_at,
                user_name=_user_label(activity.user),
                details=activity.details if isinstance(activity.details, dict) else {},
                card_id=int(card.id),
                card_title=card.title or "",
                source="card",
                item_id=int(activity.id),
            )
        )
    merged.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return merged[:limit]


def log_board_activity(
    board: KanbanBoard,
    *,
    user_id: int | None,
    action: str,
    details: dict[str, Any] | None = None,
    card_id: int | None = None,
) -> None:
    db.session.add(
        KanbanBoardActivity(
            board_id=int(board.id),
            user_id=user_id,
            card_id=int(card_id) if card_id else None,
            action=(action or "").strip()[:64],
            details=details or {},
        )
    )


def soft_delete_card(card: KanbanCard, *, user_id: int | None) -> None:
    card.deleted_at = utcnow()
    card.deleted_by_id = user_id
    card.updated_at = utcnow()
    db.session.add(card)


def restore_card(card: KanbanCard) -> None:
    card.deleted_at = None
    card.deleted_by_id = None
    card.updated_at = utcnow()
    card.position = next_card_position(int(card.column_id))
    db.session.add(card)

    if not user:
        return ""
    return (user.full_name or user.username or user.email or "").strip()


def _column_meta(column: KanbanColumn | None) -> dict[str, Any]:
    if not column:
        return {"column_title": "", "column_color_token": ""}
    return {
        "column_title": column.title or "",
        "column_color_token": column.color_token or "",
    }


KANBAN_PRIORITIES = frozenset({"none", "low", "medium", "high", "urgent"})


def normalize_kanban_priority(value: object, *, default: str = "medium") -> str:
    raw = str(value or default).strip().lower()
    return raw if raw in KANBAN_PRIORITIES else default


def serialize_card(card: KanbanCard, *, include_counts: bool = False) -> dict[str, Any]:
    col = card.column
    out: dict[str, Any] = {
        "id": int(card.id),
        "column_id": int(card.column_id),
        "title": card.title or "",
        "body": card.body or "",
        "body_html": card.body_html or "",
        "position": int(card.position or 0),
        "assignee_id": int(card.assignee_id) if card.assignee_id else None,
        "assignee_name": _user_label(card.assignee),
        "priority": normalize_kanban_priority(getattr(card, "priority", None)),
        "due_at": card.due_at.isoformat() if card.due_at else None,
        "created_at": card.created_at.isoformat() if card.created_at else None,
        "updated_at": card.updated_at.isoformat() if card.updated_at else None,
        "created_by_id": int(card.created_by_id) if card.created_by_id else None,
        "created_by_name": _user_label(card.created_by),
        **_column_meta(col),
    }
    if include_counts:
        out["comment_count"] = len(card.comments or [])
        out["attachment_count"] = len(card.attachments or [])
    return out


def comment_html_to_plain(html: str) -> str:
    import re
    from html import unescape

    text = re.sub(r"<[^>]+>", " ", html or "")
    return unescape(re.sub(r"\s+", " ", text)).strip()


def serialize_comment(row: KanbanCardComment) -> dict[str, Any]:
    return {
        "id": int(row.id),
        "body": row.body or "",
        "body_html": row.body_html or "",
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "user_id": int(row.user_id),
        "user_name": _user_label(row.user),
    }


def serialize_attachment(row: KanbanCardAttachment) -> dict[str, Any]:
    return {
        "id": int(row.id),
        "filename": row.filename or "",
        "size": int(row.size or 0),
        "mime_type": row.mime_type or "",
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "uploaded_by_name": _user_label(row.uploaded_by),
    }


def serialize_activity(row: KanbanCardActivity) -> dict[str, Any]:
    return {
        "id": int(row.id),
        "action": row.action or "",
        "details": row.details if isinstance(row.details, dict) else {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "user_name": _user_label(row.user),
    }


def serialize_card_detail(card: KanbanCard) -> dict[str, Any]:
    data = serialize_card(card)
    data["comments"] = [serialize_comment(c) for c in (card.comments or [])]
    data["attachments"] = [serialize_attachment(a) for a in (card.attachments or [])]
    data["activity"] = [serialize_activity(a) for a in (card.activity or [])]
    return data


def serialize_column(column: KanbanColumn) -> dict[str, Any]:
    cards = sorted(_active_cards(column.cards), key=lambda c: (int(c.position or 0), int(c.id)))
    return {
        "id": int(column.id),
        "board_id": int(column.board_id),
        "title": column.title or "",
        "position": int(column.position or 0),
        "color_token": column.color_token or "",
        "is_todo": is_todo_column(column),
        "cards": [serialize_card(c, include_counts=True) for c in cards],
    }


def serialize_board(board: KanbanBoard) -> dict[str, Any]:
    columns = sorted(board.columns or [], key=lambda c: (int(c.position or 0), int(c.id)))
    return {
        "id": int(board.id),
        "name": board.name or "KanBan",
        "subtitle": (board.subtitle or DEFAULT_BOARD_SUBTITLE).strip(),
        "columns": [serialize_column(c) for c in columns],
    }


def log_kanban_activity(
    card: KanbanCard,
    *,
    user_id: int | None,
    action: str,
    details: dict[str, Any] | None = None,
) -> None:
    db.session.add(
        KanbanCardActivity(
            card_id=int(card.id),
            user_id=user_id,
            action=(action or "").strip()[:64],
            details=details or {},
        )
    )


def is_todo_column(column: KanbanColumn | None) -> bool:
    if not column:
        return False
    title = (column.title or "").strip().lower().replace("-", " ")
    return title in {"to do", "todo"}


def find_todo_column(board: KanbanBoard) -> KanbanColumn | None:
    columns = sorted(board.columns or [], key=lambda c: (int(c.position or 0), int(c.id)))
    for col in columns:
        if is_todo_column(col):
            return col
    return columns[0] if columns else None


def find_done_column(board: KanbanBoard) -> KanbanColumn | None:
    columns = sorted(board.columns or [], key=lambda c: (int(c.position or 0), int(c.id)))
    for col in columns:
        title = (col.title or "").strip().lower()
        if title == "done" or title.endswith(" done"):
            return col
    for col in reversed(columns):
        token = (col.color_token or "").strip().lower()
        if token == "green":
            return col
    return columns[-1] if columns else None


def next_column_position(board_id: int) -> int:
    last = (
        db.session.query(KanbanColumn.position)
        .filter(KanbanColumn.board_id == board_id)
        .order_by(KanbanColumn.position.desc(), KanbanColumn.id.desc())
        .first()
    )
    return int(last[0] + 1) if last else 0


def next_card_position(column_id: int) -> int:
    last = (
        db.session.query(KanbanCard.position)
        .filter(KanbanCard.column_id == column_id, KanbanCard.deleted_at.is_(None))
        .order_by(KanbanCard.position.desc(), KanbanCard.id.desc())
        .first()
    )
    return int(last[0] + 1) if last else 0


def _column_card_query(column_id: int):
    return (
        db.session.query(KanbanCard)
        .filter(KanbanCard.column_id == column_id, KanbanCard.deleted_at.is_(None))
        .order_by(KanbanCard.position.asc(), KanbanCard.id.asc())
    )


def _renumber_column_cards(column_id: int, ordered_ids: list[int]) -> None:
    for idx, card_id in enumerate(ordered_ids):
        card = db.session.get(KanbanCard, int(card_id))
        if not card or int(card.column_id) != int(column_id):
            continue
        card.position = idx
        card.updated_at = utcnow()


def move_card(*, card: KanbanCard, column_id: int, position: int) -> None:
    """Move card to column at zero-based position and renumber affected columns."""
    target_col = db.session.get(KanbanColumn, int(column_id))
    if not target_col:
        raise ValueError("column not found")

    source_col_id = int(card.column_id)
    target_col_id = int(column_id)
    pos = max(0, int(position))

    if source_col_id == target_col_id:
        ordered = [int(c.id) for c in _column_card_query(source_col_id).all()]
        ordered = [cid for cid in ordered if cid != int(card.id)]
        pos = min(pos, len(ordered))
        ordered.insert(pos, int(card.id))
        _renumber_column_cards(target_col_id, ordered)
    else:
        source_ids = [
            int(c.id)
            for c in _column_card_query(source_col_id).filter(KanbanCard.id != card.id).all()
        ]
        target_ids = [int(c.id) for c in _column_card_query(target_col_id).all()]
        pos = min(pos, len(target_ids))
        target_ids.insert(pos, int(card.id))
        card.column_id = target_col_id
        _renumber_column_cards(source_col_id, source_ids)
        _renumber_column_cards(target_col_id, target_ids)

    card.updated_at = utcnow()
    db.session.add(card)
