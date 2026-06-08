"""Persisted conversation threads for AI Document Search."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import inspect

from app.extensions import db
from app.models import AiDocConversation, User, utcnow

_MAX_CONVERSATIONS_PER_USER = 80
_MAX_STORED_MESSAGES = 120


def _ensure_conversations_schema() -> None:
    try:
        insp = inspect(db.engine)
        if not insp.has_table("ai_doc_conversations"):
            db.create_all()
    except Exception:
        try:
            db.create_all()
        except Exception:
            pass


def _parse_messages(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data[:_MAX_STORED_MESSAGES]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role not in ("user", "assistant", "meta"):
            continue
        msg: dict[str, Any] = {"role": role, "content": str(item.get("content") or "")[:12000]}
        if item.get("welcome"):
            msg["welcome"] = True
        sources = item.get("sources")
        if isinstance(sources, list):
            msg["sources"] = sources[:30]
        out.append(msg)
    return out


def _serialize_messages(messages: list[dict[str, Any]]) -> str:
    clean: list[dict[str, Any]] = []
    for item in messages[-_MAX_STORED_MESSAGES:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role not in ("user", "assistant", "meta"):
            continue
        row: dict[str, Any] = {"role": role, "content": str(item.get("content") or "")[:12000]}
        if item.get("welcome"):
            row["welcome"] = True
        if isinstance(item.get("sources"), list):
            row["sources"] = item["sources"][:30]
        clean.append(row)
    return json.dumps(clean, separators=(",", ":"))


def _title_from_messages(messages: list[dict[str, Any]], fallback: str = "New chat") -> str:
    for item in messages:
        if str(item.get("role") or "").lower() == "user":
            t = str(item.get("content") or "").strip().replace("\n", " ")
            if t:
                return (t[:72] + "…") if len(t) > 72 else t
    return fallback


def list_conversations(user: User) -> list[dict[str, Any]]:
    _ensure_conversations_schema()
    rows = (
        db.session.query(AiDocConversation)
        .filter_by(user_id=user.id)
        .order_by(AiDocConversation.updated_at.desc())
        .limit(_MAX_CONVERSATIONS_PER_USER)
        .all()
    )
    return [
        {
            "id": row.id,
            "title": row.title or "New chat",
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            "message_count": len(_parse_messages(row.messages_json)),
        }
        for row in rows
    ]


def get_conversation(user: User, conversation_id: int) -> dict[str, Any] | None:
    _ensure_conversations_schema()
    row = db.session.get(AiDocConversation, int(conversation_id))
    if not row or row.user_id != user.id:
        return None
    return {
        "id": row.id,
        "title": row.title or "New chat",
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "messages": _parse_messages(row.messages_json),
    }


def create_conversation(user: User, *, title: str = "New chat") -> dict[str, Any]:
    _ensure_conversations_schema()
    welcome = [
        {
            "role": "assistant",
            "content": (
                "Hello! I can search PDFs, Word, Excel, PowerPoint, and text files you have access to, "
                "then reason over what I find."
            ),
            "welcome": True,
        }
    ]
    row = AiDocConversation(
        user_id=user.id,
        title=(title or "New chat")[:200],
        messages_json=_serialize_messages(welcome),
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.session.add(row)
    db.session.commit()
    _trim_old_conversations(user.id)
    return get_conversation(user, row.id) or {}


def save_conversation(
    user: User,
    conversation_id: int,
    *,
    messages: list[dict[str, Any]],
    title: str | None = None,
) -> dict[str, Any] | None:
    _ensure_conversations_schema()
    row = db.session.get(AiDocConversation, int(conversation_id))
    if not row or row.user_id != user.id:
        return None
    parsed = _parse_messages(_serialize_messages(messages))
    row.messages_json = _serialize_messages(parsed)
    if title:
        row.title = title[:200]
    elif row.title in ("", "New chat"):
        row.title = _title_from_messages(parsed)
    row.updated_at = utcnow()
    db.session.commit()
    return get_conversation(user, row.id)


def delete_conversation(user: User, conversation_id: int) -> bool:
    _ensure_conversations_schema()
    row = db.session.get(AiDocConversation, int(conversation_id))
    if not row or row.user_id != user.id:
        return False
    db.session.delete(row)
    db.session.commit()
    return True


def _trim_old_conversations(user_id: int) -> None:
    rows = (
        db.session.query(AiDocConversation.id)
        .filter_by(user_id=user_id)
        .order_by(AiDocConversation.updated_at.desc())
        .all()
    )
    if len(rows) <= _MAX_CONVERSATIONS_PER_USER:
        return
    for (cid,) in rows[_MAX_CONVERSATIONS_PER_USER:]:
        db.session.query(AiDocConversation).filter_by(id=cid).delete()
    db.session.commit()


def chat_history_for_llm(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Strip UI-only fields for the LLM API."""
    out: list[dict[str, str]] = []
    for item in messages:
        if item.get("welcome"):
            continue
        if item.get("sources") is not None and str(item.get("role") or "") == "meta":
            continue
        role = str(item.get("role") or "").strip().lower()
        content = str(item.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            out.append({"role": role, "content": content})
    return out[-16:]
