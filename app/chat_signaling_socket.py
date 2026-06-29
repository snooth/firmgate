"""Socket.IO signaling for Team Chat WebRTC calls (closed-loop intranet)."""

from __future__ import annotations

import logging
from typing import Any

from flask import request
from flask_login import current_user
from flask_socketio import SocketIO, disconnect, emit, join_room, leave_room

from app.extensions import db
from app.intranet_signaling import get_intranet_signaling_settings, intranet_signaling_configured
from app.models import User

log = logging.getLogger(__name__)

socketio = SocketIO(cors_allowed_origins="*", manage_session=False, logger=False, engineio_logger=False)

# sid -> {user_id, room_id, name}
_sessions: dict[str, dict[str, Any]] = {}
# room_id -> {user_id: count of tabs}
_room_counts: dict[int, dict[int, int]] = {}


def _room_key(room_id: int) -> str:
    return f"chat_room_{int(room_id)}"


def _user_room_count(room_id: int) -> int:
    counts = _room_counts.get(int(room_id)) or {}
    return len(counts)


def _chat_room_visible_to_user(room_id: int, user_id: int) -> bool:
    from app.intranet_bp import _chat_user_can_access_room

    return _chat_user_can_access_room(room_id, user_id)


def _display_name(user: User) -> str:
    return (user.full_name or user.username or f"User {user.id}").strip()


def _leave_session(sid: str, *, broadcast_leave: bool = True) -> None:
    sess = _sessions.pop(sid, None)
    if not sess:
        return
    room_id = sess.get("room_id")
    user_id = sess.get("user_id")
    if room_id is None or user_id is None:
        return
    rid = int(room_id)
    uid = int(user_id)
    counts = _room_counts.get(rid)
    if counts and uid in counts:
        counts[uid] -= 1
        if counts[uid] <= 0:
            del counts[uid]
            if broadcast_leave:
                emit(
                    "call_signal",
                    {
                        "kind": "leave",
                        "from_user_id": uid,
                        "from_name": sess.get("name") or f"User {uid}",
                        "payload": {},
                    },
                    room=_room_key(rid),
                    include_self=False,
                )
        if not counts:
            _room_counts.pop(rid, None)
    try:
        leave_room(_room_key(rid))
    except Exception:
        pass


def register_chat_signaling_handlers() -> None:
    @socketio.on("connect", namespace="/chat-signaling")
    def on_connect():
        if not intranet_signaling_configured():
            return False
        cfg = get_intranet_signaling_settings()
        if not cfg.get("use_socket_signaling"):
            return False
        if not current_user.is_authenticated:
            return False
        return True

    @socketio.on("disconnect", namespace="/chat-signaling")
    def on_disconnect():
        _leave_session(request.sid)

    @socketio.on("call_join", namespace="/chat-signaling")
    def on_call_join(data):
        if not current_user.is_authenticated:
            disconnect()
            return
        if not intranet_signaling_configured():
            emit("call_error", {"error": "Intranet signaling is disabled."})
            return

        payload = data if isinstance(data, dict) else {}
        try:
            room_id = int(payload.get("room_id"))
        except (TypeError, ValueError):
            emit("call_error", {"error": "room_id required"})
            return

        uid = int(current_user.id)
        if not _chat_room_visible_to_user(room_id, uid):
            emit("call_error", {"error": "forbidden"})
            return

        cfg = get_intranet_signaling_settings()
        max_p = int(cfg.get("max_participants") or 40)
        counts = _room_counts.setdefault(room_id, {})
        if uid not in counts and _user_room_count(room_id) >= max_p:
            emit("call_error", {"error": f"Call is full (max {max_p} participants)."})
            return

        # Leave previous room if switching
        old = _sessions.get(request.sid)
        if old and old.get("room_id") and int(old["room_id"]) != room_id:
            _leave_session(request.sid)

        name = str(payload.get("name") or "").strip() or _display_name(current_user)
        counts[uid] = counts.get(uid, 0) + 1
        _sessions[request.sid] = {"user_id": uid, "room_id": room_id, "name": name}
        join_room(_room_key(room_id))

        emit(
            "call_signal",
            {
                "kind": "join",
                "from_user_id": uid,
                "from_name": name,
                "payload": {"name": name},
            },
            room=_room_key(room_id),
            include_self=False,
        )
        emit("call_joined", {"room_id": room_id, "me_id": uid})

    @socketio.on("call_leave", namespace="/chat-signaling")
    def on_call_leave(_data=None):
        _leave_session(request.sid)

    @socketio.on("call_signal", namespace="/chat-signaling")
    def on_call_signal(data):
        if not current_user.is_authenticated:
            disconnect()
            return
        sess = _sessions.get(request.sid)
        if not sess:
            emit("call_error", {"error": "not in call"})
            return

        payload = data if isinstance(data, dict) else {}
        kind = str(payload.get("kind") or "").strip().lower()
        if kind not in ("join", "leave", "offer", "answer", "ice"):
            emit("call_error", {"error": "invalid kind"})
            return

        room_id = int(sess["room_id"])
        uid = int(sess["user_id"])
        name = str(sess.get("name") or _display_name(current_user))
        signal_payload = payload.get("payload")
        if signal_payload is not None and not isinstance(signal_payload, (dict, list)):
            emit("call_error", {"error": "invalid payload"})
            return

        to_user_id = payload.get("to_user_id")
        out = {
            "kind": kind,
            "from_user_id": uid,
            "from_name": name,
            "payload": signal_payload or {},
        }

        if kind in ("offer", "answer", "ice"):
            try:
                to_uid = int(to_user_id)
            except (TypeError, ValueError):
                emit("call_error", {"error": "to_user_id required"})
                return
            if not _chat_room_visible_to_user(room_id, to_uid):
                emit("call_error", {"error": "recipient not in room"})
                return
            out["to_user_id"] = to_uid
            # Deliver to all tabs of the recipient
            for sid, s in list(_sessions.items()):
                if int(s.get("user_id") or 0) == to_uid and int(s.get("room_id") or 0) == room_id:
                    emit("call_signal", out, to=sid)
            return

        emit("call_signal", out, room=_room_key(room_id), include_self=False)
