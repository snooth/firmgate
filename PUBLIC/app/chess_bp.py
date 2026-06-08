"""Intranet Game — async chess."""

from __future__ import annotations

from datetime import datetime, timezone

from pathlib import Path

from flask import Blueprint, abort, current_app, jsonify, render_template, request, url_for
from flask_login import current_user, login_required
from sqlalchemy import func, inspect, or_

from app.chess_service import (
    apply_move,
    create_game,
    game_for_api,
    join_game,
    resign_game,
)
from app.extensions import db
from app.models import ChessChatMessage, ChessGame, ChessGameChatRead, SkyControlScore, User

bp = Blueprint("chess", __name__, url_prefix="/intranet")


def _game_by_public_id(public_id: str) -> ChessGame | None:
    pid = (public_id or "").strip().lower()
    if not pid:
        return None
    return ChessGame.query.filter_by(public_id=pid).first()


def _ensure_chess_chat_schema() -> None:
    try:
        insp = inspect(db.engine)
        if not insp.has_table("chess_chat_messages") or not insp.has_table("chess_game_chat_reads"):
            db.create_all()
    except Exception:
        try:
            db.create_all()
        except Exception:
            pass


def _ensure_sky_control_schema() -> None:
    try:
        insp = inspect(db.engine)
        if not insp.has_table("sky_control_scores"):
            db.create_all()
    except Exception:
        try:
            db.create_all()
        except Exception:
            pass


def _sky_user_label(u: User | None) -> str:
    if not u:
        return "Unknown"
    return (u.full_name or u.username or u.email or "Player").strip() or "Player"


def _sky_score_dict(row: SkyControlScore, rank: int) -> dict:
    u = row.user
    return {
        "rank": rank,
        "user_id": int(row.user_id),
        "name": _sky_user_label(u),
        "score": int(row.score),
        "landed": int(row.landed),
        "wave": int(row.wave),
        "played_at": row.created_at.isoformat() if row.created_at else None,
        "is_you": bool(current_user.is_authenticated and int(row.user_id) == int(current_user.id)),
    }


def _chess_user_game_ids(user_id: int) -> list[int]:
    uid = int(user_id)
    rows = (
        db.session.query(ChessGame.id)
        .filter(
            or_(
                ChessGame.white_user_id == uid,
                ChessGame.black_user_id == uid,
                ChessGame.creator_id == uid,
            )
        )
        .all()
    )
    return [int(r[0]) for r in rows]


def _chess_mark_game_chat_read(game_id: int, user_id: int, up_to_message_id: int) -> None:
    if up_to_message_id <= 0:
        return
    uid = int(user_id)
    gid = int(game_id)
    row = (
        db.session.query(ChessGameChatRead)
        .filter(ChessGameChatRead.game_id == gid, ChessGameChatRead.user_id == uid)
        .first()
    )
    if row is None:
        row = ChessGameChatRead(game_id=gid, user_id=uid, last_read_message_id=0)
        db.session.add(row)
    prev = int(row.last_read_message_id or 0)
    if up_to_message_id > prev:
        row.last_read_message_id = int(up_to_message_id)


def _chess_chat_unread_summary(user_id: int) -> dict:
    uid = int(user_id)
    game_ids = _chess_user_game_ids(uid)
    if not game_ids:
        return {"total": 0, "by_game": {}}
    read_rows = (
        db.session.query(ChessGameChatRead)
        .filter(ChessGameChatRead.user_id == uid, ChessGameChatRead.game_id.in_(game_ids))
        .all()
    )
    last_read = {int(r.game_id): int(r.last_read_message_id or 0) for r in read_rows}
    games = {g.id: g for g in ChessGame.query.filter(ChessGame.id.in_(game_ids)).all()}
    total = 0
    by_game: dict[str, int] = {}
    for gid in game_ids:
        lr = last_read.get(gid, 0)
        count = (
            db.session.query(func.count(ChessChatMessage.id))
            .filter(
                ChessChatMessage.game_id == gid,
                ChessChatMessage.user_id != uid,
                ChessChatMessage.id > lr,
            )
            .scalar()
            or 0
        )
        if count:
            g = games.get(gid)
            key = g.public_id if g else str(gid)
            by_game[key] = int(count)
            total += int(count)
    return {"total": total, "by_game": by_game}


def _chess_game_member(game: ChessGame, user_id: int) -> bool:
    uid = int(user_id)
    if game.white_user_id == uid or game.black_user_id == uid:
        return True
    if game.status == "waiting" and game.creator_id == uid:
        return True
    return False


def _chess_user_label(u: User | None) -> str:
    if not u:
        return "User"
    return (u.full_name or u.username or u.email or "User").strip() or "User"


def _iso_utc(dt: datetime | None) -> str:
    if not dt:
        return ""
    try:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except Exception:
        return ""


def _chess_chat_message_dict(m: ChessChatMessage) -> dict:
    u = m.author
    return {
        "id": m.id,
        "at": _iso_utc(m.created_at),
        "text": m.text or "",
        "from": {
            "id": m.user_id,
            "name": _chess_user_label(u),
            "initials": (_chess_user_label(u)[:2] or "??").upper(),
        },
    }


@bp.route("/game", methods=["GET"])
@login_required
def game_lobby_page():
    from app.intranet_bp import _nav

    return render_template(
        "intranet_game.html",
        nav=_nav("game"),
        lemmings_game_url=_lemmings_game_url(),
    )


def _lemmings_game_url() -> str:
    """Iframe URL for LemmingsJS. Local bundle needs config.json + lemmings/MAIN.DAT (see upstream LemmingsJS)."""
    custom = str(current_app.config.get("LEMMINGS_GAME_URL") or "").strip()
    if custom:
        return custom
    static_root = Path(current_app.static_folder or "")
    lem = static_root / "vendor" / "lemmings"
    if (lem / "config.json").is_file() and (lem / "lemmings" / "MAIN.DAT").is_file():
        return url_for("static", filename="vendor/lemmings/index.html")
    return "https://oklemenz.github.io/LemmingsJS/"


@bp.route("/api/sky-control/leaderboard", methods=["GET"])
@login_required
def api_sky_control_leaderboard():
    _ensure_sky_control_schema()
    limit = 20
    rows = (
        SkyControlScore.query.order_by(
            SkyControlScore.score.desc(), SkyControlScore.landed.desc(), SkyControlScore.id.desc()
        )
        .limit(limit)
        .all()
    )
    entries = [_sky_score_dict(r, i + 1) for i, r in enumerate(rows)]

    you = None
    uid = int(current_user.id)
    best = (
        SkyControlScore.query.filter_by(user_id=uid)
        .order_by(SkyControlScore.score.desc(), SkyControlScore.id.desc())
        .first()
    )
    if best:
        higher = SkyControlScore.query.filter(SkyControlScore.score > best.score).count()
        tied_higher = (
            SkyControlScore.query.filter(
                SkyControlScore.score == best.score, SkyControlScore.id < best.id
            ).count()
        )
        rank = int(higher + tied_higher + 1)
        you = {
            "rank": rank,
            "score": int(best.score),
            "landed": int(best.landed),
            "wave": int(best.wave),
            "played_at": best.created_at.isoformat() if best.created_at else None,
            "on_board": any(e["user_id"] == uid for e in entries),
        }

    return jsonify({"entries": entries, "you": you})


@bp.route("/api/sky-control/scores", methods=["POST"])
@login_required
def api_sky_control_submit_score():
    _ensure_sky_control_schema()
    data = request.get_json(silent=True) or {}
    try:
        score_val = int(data.get("score", 0))
        landed_val = int(data.get("landed", 0))
        wave_val = int(data.get("wave", 1))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid score payload."}), 400

    if score_val < 0 or score_val > 10_000_000:
        return jsonify({"error": "Score out of range."}), 400
    if landed_val < 0 or landed_val > 10_000:
        return jsonify({"error": "Landed count out of range."}), 400
    if wave_val < 1 or wave_val > 999:
        return jsonify({"error": "Wave out of range."}), 400
    if score_val == 0 and landed_val == 0:
        return jsonify({"error": "Nothing to record."}), 400

    row = SkyControlScore(
        user_id=int(current_user.id),
        score=score_val,
        landed=landed_val,
        wave=wave_val,
    )
    db.session.add(row)
    db.session.commit()

    higher = SkyControlScore.query.filter(SkyControlScore.score > score_val).count()
    tied_higher = (
        SkyControlScore.query.filter(SkyControlScore.score == score_val, SkyControlScore.id < row.id).count()
    )
    rank = int(higher + tied_higher + 1)

    return jsonify(
        {
            "ok": True,
            "rank": rank,
            "entry": _sky_score_dict(row, rank),
        }
    )


@bp.route("/game/chess/<public_id>", methods=["GET"])
@login_required
def chess_game_page(public_id: str):
    from app.intranet_bp import _nav

    g = _game_by_public_id(public_id)
    if not g:
        abort(404)
    me = current_user
    me_name = (me.full_name or me.username or "You").strip() if me else "You"
    return render_template(
        "intranet_chess.html",
        nav=_nav("game"),
        game_public_id=g.public_id,
        chess_me_id=int(me.id) if me else 0,
        chess_me_name=me_name,
    )


@bp.route("/api/chess/chat/unread", methods=["GET"])
@login_required
def api_chess_chat_unread():
    _ensure_chess_chat_schema()
    return jsonify(_chess_chat_unread_summary(int(current_user.id)))


@bp.route("/api/chess/games", methods=["GET"])
@login_required
def api_chess_games_list():
    uid = int(current_user.id)
    rows = (
        ChessGame.query.filter(
            (ChessGame.white_user_id == uid)
            | (ChessGame.black_user_id == uid)
            | (ChessGame.creator_id == uid)
        )
        .order_by(func.coalesce(ChessGame.last_move_at, ChessGame.created_at).desc())
        .limit(100)
        .all()
    )
    unread_by_game = _chess_chat_unread_summary(uid).get("by_game") or {}
    out = []
    for g in rows:
        pid = g.public_id
        out.append(
            {
                "id": pid,
                "status": g.status,
                "white_name": (g.white_player.full_name or g.white_player.username) if g.white_player else "—",
                "black_name": (g.black_player.full_name or g.black_player.username) if g.black_player else "Waiting…",
                "result": g.result,
                "updated_at": (g.last_move_at or g.created_at).isoformat() if (g.last_move_at or g.created_at) else "",
                "url": f"/intranet/game/chess/{pid}",
                "unread_chat": int(unread_by_game.get(pid, 0)),
            }
        )
    return jsonify({"games": out})


@bp.route("/api/chess/games", methods=["POST"])
@login_required
def api_chess_games_create():
    payload = request.get_json(force=True, silent=True) or {}
    play_white = payload.get("color", "white") != "black"
    g = create_game(current_user, play_white=play_white)
    db.session.add(g)
    db.session.commit()
    return jsonify({"ok": True, "game": game_for_api(g, int(current_user.id))})


@bp.route("/api/chess/games/<public_id>", methods=["GET"])
@login_required
def api_chess_game_get(public_id: str):
    g = _game_by_public_id(public_id)
    if not g:
        return jsonify({"error": "not found"}), 404
    return jsonify({"game": game_for_api(g, int(current_user.id))})


@bp.route("/api/chess/games/<public_id>/join", methods=["POST"])
@login_required
def api_chess_game_join(public_id: str):
    g = _game_by_public_id(public_id)
    if not g:
        return jsonify({"error": "not found"}), 404
    ok, err = join_game(g, current_user)
    if not ok:
        return jsonify({"error": err}), 400
    db.session.add(g)
    db.session.commit()
    return jsonify({"ok": True, "game": game_for_api(g, int(current_user.id))})


@bp.route("/api/chess/games/<public_id>/move", methods=["POST"])
@login_required
def api_chess_game_move(public_id: str):
    g = _game_by_public_id(public_id)
    if not g:
        return jsonify({"error": "not found"}), 404
    payload = request.get_json(force=True, silent=True) or {}
    uci = (payload.get("uci") or payload.get("move") or "").strip()
    if not uci:
        return jsonify({"error": "move required (UCI, e.g. e2e4)"}), 400
    ok, err, db_move = apply_move(g, current_user, uci)
    if not ok:
        return jsonify({"error": err}), 400
    if db_move:
        db.session.add(db_move)
    db.session.add(g)
    db.session.commit()
    return jsonify({"ok": True, "game": game_for_api(g, int(current_user.id))})


@bp.route("/api/chess/games/<public_id>/chat", methods=["GET"])
@login_required
def api_chess_game_chat_list(public_id: str):
    _ensure_chess_chat_schema()
    g = _game_by_public_id(public_id)
    if not g:
        return jsonify({"error": "not found"}), 404
    if not _chess_game_member(g, int(current_user.id)):
        return jsonify({"error": "forbidden"}), 403
    after_id = request.args.get("after_id", type=int) or 0
    q = (
        db.session.query(ChessChatMessage)
        .filter(ChessChatMessage.game_id == g.id)
        .order_by(ChessChatMessage.id.asc())
    )
    if after_id > 0:
        q = q.filter(ChessChatMessage.id > after_id)
    rows = q.limit(200).all()
    if rows:
        _chess_mark_game_chat_read(g.id, int(current_user.id), int(rows[-1].id))
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
    return jsonify({"messages": [_chess_chat_message_dict(m) for m in rows]})


@bp.route("/api/chess/games/<public_id>/chat", methods=["POST"])
@login_required
def api_chess_game_chat_post(public_id: str):
    _ensure_chess_chat_schema()
    g = _game_by_public_id(public_id)
    if not g:
        return jsonify({"error": "not found"}), 404
    if not _chess_game_member(g, int(current_user.id)):
        return jsonify({"error": "forbidden"}), 403
    payload = request.get_json(force=True, silent=True) or {}
    body = (payload.get("text") or "").strip()
    if not body:
        return jsonify({"error": "message required"}), 400
    if len(body) > 2000:
        body = body[:2000]
    msg = ChessChatMessage(game_id=g.id, user_id=int(current_user.id), text=body)
    db.session.add(msg)
    db.session.commit()
    return jsonify({"ok": True, "message": _chess_chat_message_dict(msg)}), 201


@bp.route("/api/chess/games/<public_id>/resign", methods=["POST"])
@login_required
def api_chess_game_resign(public_id: str):
    g = _game_by_public_id(public_id)
    if not g:
        return jsonify({"error": "not found"}), 404
    ok, err = resign_game(g, current_user)
    if not ok:
        return jsonify({"error": err}), 400
    db.session.add(g)
    db.session.commit()
    return jsonify({"ok": True, "game": game_for_api(g, int(current_user.id))})
