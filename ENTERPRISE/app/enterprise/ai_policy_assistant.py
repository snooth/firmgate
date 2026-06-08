"""AI Policy Assistant — upload policy documents and ask questions with citations."""

from __future__ import annotations

import logging
from typing import Any

from flask import url_for

from app import access, files_workspace
from app.enterprise.ai_document_search import (
    _build_context,
    index_file_node,
    is_indexable_filename,
    search_chunks,
)
from app.enterprise.ai_llm_settings import (
    PRODUCT_POLICY_ASSISTANT,
    chat_completion,
    iter_chat_completion_deltas,
    llm_configured as _llm_configured,
    llm_settings_public as _llm_settings_public,
)
from app.extensions import db
from app.file_storage import store_stream_and_digest
from app.models import AiDocChunk, FileNode, FileVersion, User, utcnow
from app.settings import get_setting, set_setting

SETTING_AI_POLICY = "ai_policy_assistant"
POLICY_FOLDER_NAME = "Policy Library"
INDEX_KIND = "policy"

log = logging.getLogger(__name__)


def llm_configured() -> bool:
    return _llm_configured(PRODUCT_POLICY_ASSISTANT)


def llm_settings_public() -> dict[str, Any]:
    return _llm_settings_public(PRODUCT_POLICY_ASSISTANT)


def _path_key_for(node: FileNode) -> str:
    if node.parent_id is None:
        return "/" + node.name
    parent = node.parent
    if not parent:
        return "/" + node.name
    base = (parent.path_key or _path_key_for(parent)).rstrip("/")
    return base + "/" + node.name


def _settings_row() -> dict[str, Any]:
    raw = get_setting(SETTING_AI_POLICY, default={}) or {}
    return raw if isinstance(raw, dict) else {}


def _user_folders_map() -> dict[str, int]:
    row = _settings_row()
    ufs = row.get("user_folders")
    if not isinstance(ufs, dict):
        return {}
    out: dict[str, int] = {}
    for k, v in ufs.items():
        try:
            out[str(k)] = int(v)
        except (TypeError, ValueError):
            continue
    return out


def policy_folder_ids() -> set[int]:
    return set(_user_folders_map().values())


def node_under_policy_folder(node: FileNode) -> bool:
    roots = policy_folder_ids()
    if not roots:
        return False
    n: FileNode | None = node
    seen = 0
    while n is not None and seen < 64:
        if n.id in roots:
            return True
        if n.parent_id is None:
            break
        n = db.session.get(FileNode, n.parent_id)
        seen += 1
    return False


def _save_user_folder_id(user_id: int, folder_id: int) -> None:
    row = dict(_settings_row())
    ufs = dict(_user_folders_map())
    ufs[str(user_id)] = int(folder_id)
    row["user_folders"] = ufs
    set_setting(SETTING_AI_POLICY, row)


def _next_available_name(parent_id: int, desired: str) -> str:
    base = (desired or "file").strip() or "file"
    if "/" in base or "\\" in base:
        base = base.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    name = base
    n = 1
    while (
        FileNode.query.filter_by(parent_id=parent_id, name=name, is_folder=False)
        .filter(FileNode.deleted_at.is_(None))
        .first()
    ):
        if "." in base:
            stem, dot, ext = base.rpartition(".")
            name = f"{stem} ({n}){dot}{ext}" if dot else f"{base} ({n})"
        else:
            name = f"{base} ({n})"
        n += 1
    return name


def policy_folder_for_user(user: User) -> FileNode | None:
    ufs = _user_folders_map()
    fid = ufs.get(str(user.id))
    if fid:
        folder = db.session.get(FileNode, int(fid))
        if folder and folder.is_folder and folder.deleted_at is None:
            ok, _ = access.can_access_node(user, folder, "write")
            if ok:
                return folder
    home = files_workspace.default_document_home_for_user(user.id)
    if not home:
        return None
    folder = (
        FileNode.query.filter_by(parent_id=home.id, name=POLICY_FOLDER_NAME, is_folder=True)
        .filter(FileNode.deleted_at.is_(None))
        .first()
    )
    if not folder:
        ok, _ = access.can_access_node(user, home, "write")
        if not ok:
            return None
        folder = FileNode(
            name=POLICY_FOLDER_NAME,
            is_folder=True,
            parent_id=home.id,
            owner_id=home.owner_id,
            attributes={"ai_policy_library": True},
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        db.session.add(folder)
        db.session.flush()
        folder.path_key = _path_key_for(folder)
        db.session.commit()
    _save_user_folder_id(user.id, folder.id)
    return folder


def list_policy_documents(user: User) -> list[dict[str, Any]]:
    folder = policy_folder_for_user(user)
    if not folder:
        return []
    rows = (
        FileNode.query.filter_by(parent_id=folder.id, is_folder=False)
        .filter(FileNode.deleted_at.is_(None))
        .order_by(FileNode.name.asc())
        .all()
    )
    out: list[dict[str, Any]] = []
    for node in rows:
        ok, _ = access.can_access_node(user, node, "read")
        if not ok:
            continue
        chunk_n = (
            db.session.query(AiDocChunk.id).filter_by(file_node_id=node.id, index_kind=INDEX_KIND).count()
        )
        out.append(
            {
                "id": node.id,
                "name": node.name,
                "updated_at": node.updated_at.isoformat() if node.updated_at else None,
                "indexed": chunk_n > 0,
                "url": url_for("intranet.documents_page", parent_id=folder.id, select_id=node.id),
            }
        )
    return out


def index_stats_for_user(user: User) -> dict[str, int]:
    file_ids: set[int] = set()
    chunk_count = 0
    rows = db.session.query(AiDocChunk).filter_by(index_kind=INDEX_KIND).all()
    for row in rows:
        node = db.session.get(FileNode, row.file_node_id)
        if not node or node.deleted_at or not access.can_access_node(user, node, "read")[0]:
            continue
        if not node_under_policy_folder(node):
            continue
        file_ids.add(row.file_node_id)
        chunk_count += 1
    return {"indexed_files": len(file_ids), "indexed_chunks": chunk_count}


def sync_policy_index_for_user(user: User) -> dict[str, int]:
    folder = policy_folder_for_user(user)
    if not folder:
        return {"indexed_now": 0, "skipped_no_folder": 1}
    nodes = (
        FileNode.query.filter_by(parent_id=folder.id, is_folder=False)
        .filter(FileNode.deleted_at.is_(None))
        .order_by(FileNode.updated_at.desc())
        .all()
    )
    indexed = 0
    skipped = 0
    for node in nodes:
        if not is_indexable_filename(node.name):
            skipped += 1
            continue
        if index_file_node(user, node, force=False, index_kind=INDEX_KIND):
            indexed += 1
    return {"indexed_now": indexed, "skipped": skipped}


def upload_policy_files(user: User, files) -> list[dict[str, Any]]:
    folder = policy_folder_for_user(user)
    if not folder:
        raise RuntimeError("Could not access your policy library folder.")
    ok, reason = access.can_access_node(user, folder, "write")
    if not ok:
        raise RuntimeError(reason or "Cannot upload to policy library.")

    results: list[dict[str, Any]] = []
    for f in files or []:
        if not f or not getattr(f, "filename", None):
            continue
        name = _next_available_name(folder.id, f.filename)
        relpath, size, sha256, mime = store_stream_and_digest(f.stream, name)
        node = FileNode(
            name=name,
            is_folder=False,
            parent_id=folder.id,
            owner_id=folder.owner_id,
            attributes={"ai_policy_upload": True},
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        db.session.add(node)
        db.session.flush()
        node.path_key = _path_key_for(node)
        ver = FileVersion(
            file_node_id=node.id,
            version_number=1,
            storage_relpath=relpath,
            size_bytes=size,
            sha256=sha256,
            mime_type=mime,
            created_by_id=user.id,
            is_current=True,
        )
        db.session.add(ver)
        db.session.commit()
        indexed = index_file_node(user, node, force=True, index_kind=INDEX_KIND)
        results.append(
            {
                "name": name,
                "id": node.id,
                "indexed": bool(indexed),
                "url": url_for("intranet.documents_page", parent_id=folder.id, select_id=node.id),
            }
        )
    return results


def remove_policy_document(user: User, node_id: int) -> bool:
    node = db.session.get(FileNode, int(node_id))
    if not node or node.deleted_at or node.is_folder:
        return False
    if not node_under_policy_folder(node):
        return False
    ok, _ = access.can_access_node(user, node, "write")
    if not ok:
        return False
    db.session.query(AiDocChunk).filter_by(file_node_id=node.id, index_kind=INDEX_KIND).delete()
    node.deleted_at = utcnow()
    db.session.commit()
    return True


def _policy_system_prompt() -> str:
    return (
        "You are a policy and compliance assistant for an organisation's private intranet. "
        "Answer using ONLY the policy document excerpts provided (policies, SOPs, work instructions, security manuals). "
        "If the excerpts do not contain enough information, say so clearly. "
        "Cite sources as [Source N] matching the excerpt labels. "
        "Do not invent policy requirements. Be concise and practical."
    )


def prepare_policy_answer_messages(
    user: User,
    question: str,
    *,
    history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    question = (question or "").strip()
    if not question:
        raise ValueError("Question is required.")
    if len(question) > 8000:
        raise ValueError("Question is too long.")
    hits = search_chunks(user, question, index_kind=INDEX_KIND)
    context = _build_context(hits)
    user_content = f"Policy excerpts:\n\n{context}\n\nUser question: {question}"
    messages: list[dict[str, str]] = [{"role": "system", "content": _policy_system_prompt()}]
    if history:
        for m in history[-8:]:
            role = (m.get("role") or "").strip().lower()
            content = (m.get("content") or "").strip()
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content[:6000]})
    messages.append({"role": "user", "content": user_content})
    return {
        "messages": messages,
        "sources": hits,
        "stats": index_stats_for_user(user),
    }


def iter_policy_answer_deltas(messages: list[dict[str, str]]):
    return iter_chat_completion_deltas(PRODUCT_POLICY_ASSISTANT, messages)


def answer_policy_question(
    user: User,
    question: str,
    *,
    history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    prep = prepare_policy_answer_messages(user, question, history=history)
    answer = chat_completion(PRODUCT_POLICY_ASSISTANT, prep["messages"])
    return {
        "answer": answer,
        "sources": prep["sources"],
        "stats": prep["stats"],
    }
