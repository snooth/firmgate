"""Async correspondence chess (python-chess)."""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import chess

if TYPE_CHECKING:
    from app.models import ChessGame, ChessMove, User

START_FEN = chess.STARTING_FEN


def new_public_id() -> str:
    return secrets.token_hex(8)


def _as_utc(dt: datetime | None) -> datetime | None:
    """Normalize DB datetimes (often naive from SQLite) to UTC-aware."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _ms_between(a: datetime | None, b: datetime) -> int:
    if a is None:
        return 0
    a_utc = _as_utc(a)
    b_utc = _as_utc(b)
    if a_utc is None or b_utc is None:
        return 0
    try:
        delta = b_utc - a_utc
        return max(0, int(delta.total_seconds() * 1000))
    except Exception:
        return 0


def _clock_ms(game: ChessGame, color: str, now: datetime) -> int:
    """Committed think time plus elapsed time for the side currently on the clock."""
    base = int(game.white_total_ms or 0) if color == "w" else int(game.black_total_ms or 0)
    if game.status != "active" or game.turn != color:
        return base
    anchor = game.last_move_at or game.started_at
    return base + _ms_between(anchor, now)


def format_duration_ms(ms: int | None) -> str:
    if ms is None or ms < 0:
        ms = 0
    total_sec = ms // 1000
    h, rem = divmod(total_sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _user_label(u: User | None) -> str:
    if not u:
        return ""
    return (u.full_name or u.username or u.email or "").strip() or f"User {u.id}"


def game_for_api(game: ChessGame, viewer_id: int) -> dict[str, Any]:
    from app.models import ChessMove, User

    moves = (
        ChessMove.query.filter_by(game_id=game.id)
        .order_by(ChessMove.ply.asc())
        .all()
    )
    now = datetime.now(timezone.utc)
    started = game.started_at
    finished = game.finished_at
    if finished:
        total_ms = _ms_between(started, finished)
    elif started:
        total_ms = _ms_between(started, now)
    else:
        total_ms = 0

    white = game.white_player
    black = game.black_player
    last_move_at = game.last_move_at or started
    white_ms = _clock_ms(game, "w", now)
    black_ms = _clock_ms(game, "b", now)

    return {
        "id": game.public_id,
        "status": game.status,
        "fen": game.fen or START_FEN,
        "turn": game.turn,
        "result": game.result,
        "end_reason": game.end_reason,
        "created_at": game.created_at.isoformat() if game.created_at else "",
        "started_at": started.isoformat() if started else "",
        "finished_at": finished.isoformat() if finished else "",
        "last_move_at": last_move_at.isoformat() if last_move_at else "",
        "white": {
            "user_id": game.white_user_id,
            "name": _user_label(white),
            "total_ms": int(game.white_total_ms or 0),
            "clock_ms": white_ms,
            "total_display": format_duration_ms(white_ms),
        },
        "black": {
            "user_id": game.black_user_id,
            "name": _user_label(black),
            "total_ms": int(game.black_total_ms or 0),
            "clock_ms": black_ms,
            "total_display": format_duration_ms(black_ms),
        },
        "server_now": now.isoformat(),
        "total_game_ms": total_ms,
        "total_game_display": format_duration_ms(total_ms),
        "viewer_color": (
            "w"
            if game.white_user_id == viewer_id
            else "b"
            if game.black_user_id == viewer_id
            else None
        ),
        "can_join": (
            game.status == "waiting"
            and viewer_id not in (game.white_user_id, game.black_user_id)
            and (game.white_user_id is None or game.black_user_id is None)
        ),
        "can_chat": (
            viewer_id == game.white_user_id
            or viewer_id == game.black_user_id
            or (game.status == "waiting" and viewer_id == game.creator_id)
        ),
        "is_your_turn": game.status == "active"
        and (
            (game.turn == "w" and game.white_user_id == viewer_id)
            or (game.turn == "b" and game.black_user_id == viewer_id)
        ),
        "moves": [
            {
                "ply": m.ply,
                "uci": m.move_uci,
                "san": m.move_san,
                "by": _user_label(m.player),
                "think_ms": int(m.think_ms or 0),
                "think_display": format_duration_ms(int(m.think_ms or 0)),
                "at": m.created_at.isoformat() if m.created_at else "",
            }
            for m in moves
        ],
    }


def create_game(creator: User, *, play_white: bool = True) -> ChessGame:
    from app.models import ChessGame

    uid = int(creator.id)
    g = ChessGame(
        public_id=new_public_id(),
        creator_id=uid,
        white_user_id=uid if play_white else None,
        black_user_id=None if play_white else uid,
        status="waiting",
        fen=START_FEN,
        turn="w",
    )
    if not play_white:
        g.status = "waiting"
    return g


def join_game(game: ChessGame, user: User) -> tuple[bool, str]:
    uid = int(user.id)
    if game.status != "waiting":
        return False, "This game is no longer waiting for a player."
    if uid in (game.white_user_id, game.black_user_id):
        return False, "You are already in this game."
    if game.white_user_id is None:
        game.white_user_id = uid
    elif game.black_user_id is None:
        game.black_user_id = uid
    else:
        return False, "This game already has two players."
    if game.white_user_id and game.black_user_id:
        game.status = "active"
        game.started_at = datetime.now(timezone.utc)
        game.last_move_at = game.started_at
    return True, ""


def apply_move(game: ChessGame, user: User, uci: str) -> tuple[bool, str, ChessMove | None]:
    if game.status != "active":
        return False, "Game is not in progress.", None
    uid = int(user.id)
    board = chess.Board(game.fen or START_FEN)
    turn_color = "w" if board.turn == chess.WHITE else "b"
    if turn_color == "w" and game.white_user_id != uid:
        return False, "Not your turn.", None
    if turn_color == "b" and game.black_user_id != uid:
        return False, "Not your turn.", None

    uci_s = (uci or "").strip().lower()
    try:
        move = chess.Move.from_uci(uci_s)
    except Exception:
        return False, "Invalid move notation.", None
    if move not in board.legal_moves:
        return False, "Illegal move.", None

    now = datetime.now(timezone.utc)
    think_ms = _ms_between(game.last_move_at, now)
    if turn_color == "w":
        game.white_total_ms = int(game.white_total_ms or 0) + think_ms
    else:
        game.black_total_ms = int(game.black_total_ms or 0) + think_ms

    san = board.san(move)
    board.push(move)
    ply = board.ply()

    from app.models import ChessMove

    db_move = ChessMove(
        game_id=game.id,
        user_id=uid,
        move_uci=uci_s,
        move_san=san,
        ply=ply,
        think_ms=think_ms,
    )
    game.fen = board.fen()
    game.turn = "w" if board.turn == chess.WHITE else "b"
    game.last_move_at = now

    if board.is_game_over():
        game.status = "finished"
        game.finished_at = now
        if board.is_checkmate():
            game.result = "w" if board.turn == chess.BLACK else "b"
            game.end_reason = "checkmate"
        elif board.is_stalemate():
            game.result = "draw"
            game.end_reason = "stalemate"
        elif board.is_insufficient_material():
            game.result = "draw"
            game.end_reason = "insufficient_material"
        elif board.can_claim_threefold_repetition():
            game.result = "draw"
            game.end_reason = "repetition"
        else:
            game.result = "draw"
            game.end_reason = "game_over"

    return True, "", db_move


def resign_game(game: ChessGame, user: User) -> tuple[bool, str]:
    if game.status != "active":
        return False, "Game is not in progress."
    uid = int(user.id)
    if uid == game.white_user_id:
        game.result = "b"
    elif uid == game.black_user_id:
        game.result = "w"
    else:
        return False, "You are not a player in this game."
    game.status = "finished"
    game.finished_at = datetime.now(timezone.utc)
    game.end_reason = "resignation"
    return True, ""
