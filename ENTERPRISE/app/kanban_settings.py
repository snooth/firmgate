"""KanBan board and portal display settings (Administration → KanBan)."""

from __future__ import annotations

from typing import Any

from app.extensions import db
from app.models import KanbanBoard, KanbanCard, KanbanColumn

SETTING_KEY = "kanban_settings"
DEFAULT_BOARD_SUBTITLE = "Drag cards between columns to update status."


def _coerce(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def get_board_subtitle() -> str:
    from app.settings import get_setting

    v = _coerce(get_setting(SETTING_KEY, default={}))
    text = str(v.get("board_subtitle") or DEFAULT_BOARD_SUBTITLE).strip()
    return text[:240] if text else DEFAULT_BOARD_SUBTITLE


def _kanban_page_url() -> str:
    from flask import url_for

    try:
        return url_for("intranet.kanban_page")
    except Exception:
        return "/intranet/kanban"


def _board_stats(board: KanbanBoard) -> dict[str, Any]:
    columns = sorted(board.columns or [], key=lambda c: (int(c.position or 0), int(c.id)))
    card_count = (
        db.session.query(KanbanCard.id)
        .join(KanbanColumn, KanbanCard.column_id == KanbanColumn.id)
        .filter(KanbanColumn.board_id == int(board.id))
        .count()
    )
    return {
        "board_id": int(board.id),
        "board_name": (board.name or "KanBan").strip() or "KanBan",
        "board_subtitle": get_board_subtitle(),
        "column_count": len(columns),
        "card_count": int(card_count),
        "columns": [
            {
                "id": int(col.id),
                "title": col.title or "",
                "color_token": col.color_token or "",
                "position": int(col.position or 0),
                "card_count": len(col.cards or []),
            }
            for col in columns
        ],
        "kanban_url": _kanban_page_url(),
    }


def kanban_settings_for_api() -> dict[str, Any]:
    from app.kanban_service import ensure_default_board

    board = ensure_default_board()
    board = db.session.get(KanbanBoard, board.id)
    if not board:
        return {
            "board_name": "KanBan",
            "board_subtitle": DEFAULT_BOARD_SUBTITLE,
            "column_count": 0,
            "card_count": 0,
            "columns": [],
            "kanban_url": _kanban_page_url(),
            "defaults": {"board_subtitle": DEFAULT_BOARD_SUBTITLE},
        }
    stats = _board_stats(board)
    return {
        **stats,
        "defaults": {"board_subtitle": DEFAULT_BOARD_SUBTITLE},
    }


def save_kanban_settings(payload: dict[str, Any]) -> dict[str, Any] | tuple[dict[str, str], int]:
    from app.kanban_service import ensure_default_board
    from app.settings import get_setting, set_setting

    board = ensure_default_board()
    board = db.session.get(KanbanBoard, board.id)
    if not board:
        return {"error": "KanBan board not found."}, 404

    if "board_name" in payload:
        name = str(payload.get("board_name") or "").strip()[:120]
        if not name:
            return {"error": "Board name is required."}, 400
        board.name = name

    cur = _coerce(get_setting(SETTING_KEY, default={}))
    nxt = dict(cur)
    if "board_subtitle" in payload:
        subtitle = str(payload.get("board_subtitle") or "").strip()[:240]
        nxt["board_subtitle"] = subtitle or DEFAULT_BOARD_SUBTITLE
    set_setting(SETTING_KEY, nxt)

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        return {"error": "Could not save KanBan settings."}, 500

    return kanban_settings_for_api()
