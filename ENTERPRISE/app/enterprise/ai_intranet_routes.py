"""Enterprise AI intranet routes (not in PUBLIC Community Edition)."""

from __future__ import annotations

# Re-use shared intranet blueprint
from app.intranet_bp import bp, _nav, _intranet_rel_path  # noqa: F401

import json

from flask import Response, abort, current_app, jsonify, render_template, request, stream_with_context
from flask_login import current_user, login_required

@bp.route("/ai-document-search", methods=["GET"])
@login_required
def ai_document_search_page():
    from app.enterprise.ai_document_search import llm_settings_public
    from app.enterprise.premium_license import FEATURE_AI_DOCUMENT_SEARCH, feature_enabled

    licensed = feature_enabled(FEATURE_AI_DOCUMENT_SEARCH)
    return render_template(
        "intranet_ai_document_search.html",
        nav=_nav("ai_document_search") if licensed else _nav("home"),
        ai_llm=llm_settings_public(),
        ai_licensed=licensed,
    )


@bp.route("/api/ai-document-search/status", methods=["GET"])
@login_required
def api_ai_document_search_status():
    from app.enterprise.ai_document_search import index_stats_for_user, llm_settings_public, sync_index_for_user
    from app.enterprise.premium_license import FEATURE_AI_DOCUMENT_SEARCH, premium_required

    ok, msg = premium_required(FEATURE_AI_DOCUMENT_SEARCH)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    force = request.args.get("force") in ("1", "true", "yes")
    limit = request.args.get("limit", type=int)
    sync = sync_index_for_user(
        current_user,
        limit=limit if limit and limit > 0 else None,
    )
    return jsonify(
        {
            "ok": True,
            **llm_settings_public(),
            "stats": index_stats_for_user(current_user),
            "sync": sync,
            "force": force,
        }
    )


@bp.route("/api/ai-document-search/conversations", methods=["GET"])
@login_required
def api_ai_document_search_conversations_list():
    from app.enterprise.ai_document_search_conversations import list_conversations
    from app.enterprise.premium_license import FEATURE_AI_DOCUMENT_SEARCH, premium_required

    ok, msg = premium_required(FEATURE_AI_DOCUMENT_SEARCH)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    return jsonify({"ok": True, "conversations": list_conversations(current_user)})


@bp.route("/api/ai-document-search/conversations", methods=["POST"])
@login_required
def api_ai_document_search_conversations_create():
    from app.enterprise.ai_document_search_conversations import create_conversation
    from app.enterprise.premium_license import FEATURE_AI_DOCUMENT_SEARCH, premium_required

    ok, msg = premium_required(FEATURE_AI_DOCUMENT_SEARCH)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    conv = create_conversation(current_user)
    return jsonify({"ok": True, "conversation": conv})


@bp.route("/api/ai-document-search/conversations/<int:conversation_id>", methods=["GET"])
@login_required
def api_ai_document_search_conversations_get(conversation_id: int):
    from app.enterprise.ai_document_search_conversations import get_conversation
    from app.enterprise.premium_license import FEATURE_AI_DOCUMENT_SEARCH, premium_required

    ok, msg = premium_required(FEATURE_AI_DOCUMENT_SEARCH)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    conv = get_conversation(current_user, conversation_id)
    if not conv:
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    return jsonify({"ok": True, "conversation": conv})


@bp.route("/api/ai-document-search/conversations/<int:conversation_id>", methods=["DELETE"])
@login_required
def api_ai_document_search_conversations_delete(conversation_id: int):
    from app.enterprise.ai_document_search_conversations import delete_conversation
    from app.enterprise.premium_license import FEATURE_AI_DOCUMENT_SEARCH, premium_required

    ok, msg = premium_required(FEATURE_AI_DOCUMENT_SEARCH)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not delete_conversation(current_user, conversation_id):
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    return jsonify({"ok": True})


@bp.route("/api/ai-document-search/chat", methods=["POST"])
@login_required
def api_ai_document_search_chat():
    from app.enterprise.ai_document_search import answer_question, llm_configured
    from app.enterprise.ai_document_search_conversations import (
        chat_history_for_llm,
        get_conversation,
        save_conversation,
    )
    from app.enterprise.premium_license import FEATURE_AI_DOCUMENT_SEARCH, premium_required

    ok, msg = premium_required(FEATURE_AI_DOCUMENT_SEARCH)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not llm_configured():
        return jsonify(
            {
                "ok": False,
                "error": "AI is not configured. Set the API key under Administration → AI Settings → Document Search.",
            }
        ), 503
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"ok": False, "error": "Message is required."}), 400
    conversation_id = data.get("conversation_id")
    try:
        conversation_id = int(conversation_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "conversation_id is required."}), 400
    conv = get_conversation(current_user, conversation_id)
    if not conv:
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    prior = chat_history_for_llm(conv.get("messages") or [])
    try:
        result = answer_question(current_user, message, history=prior)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 502
    except Exception:
        current_app.logger.exception("ai document search failed")
        return jsonify({"ok": False, "error": "Document search failed. Try again later."}), 500
    stored = list(conv.get("messages") or [])
    stored.append({"role": "user", "content": message})
    stored.append(
        {
            "role": "assistant",
            "content": result.get("answer") or "",
            "sources": result.get("sources") or [],
        }
    )
    updated = save_conversation(current_user, conversation_id, messages=stored)
    return jsonify(
        {
            "ok": True,
            "conversation_id": conversation_id,
            "conversation": updated,
            **result,
        }
    )


@bp.route("/api/ai-document-search/chat/stream", methods=["POST"])
@login_required
def api_ai_document_search_chat_stream():
    from app.enterprise.ai_document_search import (
        iter_document_search_deltas,
        llm_configured,
        prepare_answer_messages,
    )
    from app.enterprise.ai_document_search_conversations import (
        chat_history_for_llm,
        get_conversation,
        save_conversation,
    )
    from app.enterprise.premium_license import FEATURE_AI_DOCUMENT_SEARCH, premium_required

    ok, msg = premium_required(FEATURE_AI_DOCUMENT_SEARCH)
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not llm_configured():
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "AI is not configured. Set the API key under Administration → AI Settings → Document Search.",
                }
            ),
            503,
        )
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"ok": False, "error": "Message is required."}), 400
    conversation_id = data.get("conversation_id")
    try:
        conversation_id = int(conversation_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "conversation_id is required."}), 400
    conv = get_conversation(current_user, conversation_id)
    if not conv:
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    prior = chat_history_for_llm(conv.get("messages") or [])

    @stream_with_context
    def generate():
        parts: list[str] = []
        try:
            prep = prepare_answer_messages(current_user, message, history=prior)
            for piece in iter_document_search_deltas(prep["messages"]):
                parts.append(piece)
                yield _ai_sse_event({"type": "token", "content": piece})
            answer = "".join(parts).strip()
            stored = list(conv.get("messages") or [])
            stored.append({"role": "user", "content": message})
            stored.append(
                {
                    "role": "assistant",
                    "content": answer,
                    "sources": prep["sources"],
                }
            )
            updated = save_conversation(current_user, conversation_id, messages=stored)
            yield _ai_sse_event(
                {
                    "type": "done",
                    "ok": True,
                    "conversation_id": conversation_id,
                    "conversation": updated,
                    "answer": answer,
                    "sources": prep["sources"],
                    "stats": prep["stats"],
                }
            )
        except ValueError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except RuntimeError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except Exception:
            current_app.logger.exception("ai document search stream failed")
            yield _ai_sse_event({"type": "error", "ok": False, "error": "Document search failed. Try again later."})

    return _ai_sse_response(generate)


def _ai_chatbot_premium_required():
    from app.enterprise.premium_license import ai_chatbot_licensed

    if not ai_chatbot_licensed():
        return False, "AI Chatbot requires an enterprise license (ai_chatbot or ai_document_search)."
    return True, ""


@bp.route("/ai-chatbot", methods=["GET"])
@login_required
def ai_chatbot_page():
    from app import rbac
    from app.enterprise.ai_chatbot import llm_settings_public
    from app.enterprise.premium_license import ai_chatbot_licensed

    licensed = ai_chatbot_licensed()
    return render_template(
        "intranet_ai_chatbot.html",
        nav=_nav("ai_chatbot") if licensed else _nav("home"),
        ai_llm=llm_settings_public(),
        ai_licensed=licensed,
        ai_chat_can_delete=bool(
            current_user.is_authenticated
            and rbac.user_has_permission(current_user, rbac.PERMISSION_ADMIN)
        ),
    )


@bp.route("/api/ai-chatbot/conversations", methods=["GET"])
@login_required
def api_ai_chatbot_conversations_list():
    from app.enterprise.ai_chatbot_conversations import list_conversations

    ok, msg = _ai_chatbot_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    return jsonify({"ok": True, "conversations": list_conversations(current_user)})


@bp.route("/api/ai-chatbot/conversations", methods=["POST"])
@login_required
def api_ai_chatbot_conversations_create():
    from app.enterprise.ai_chatbot_conversations import create_conversation

    ok, msg = _ai_chatbot_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    conv = create_conversation(current_user)
    return jsonify({"ok": True, "conversation": conv})


@bp.route("/api/ai-chatbot/conversations/<int:conversation_id>", methods=["GET"])
@login_required
def api_ai_chatbot_conversations_get(conversation_id: int):
    from app.enterprise.ai_chatbot_conversations import get_conversation

    ok, msg = _ai_chatbot_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    conv = get_conversation(current_user, conversation_id)
    if not conv:
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    return jsonify({"ok": True, "conversation": conv})


@bp.route("/api/ai-chatbot/conversations/<int:conversation_id>", methods=["DELETE"])
@login_required
def api_ai_chatbot_conversations_delete(conversation_id: int):
    from app.enterprise.ai_chatbot_conversations import delete_conversation

    ok, msg = _ai_chatbot_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not delete_conversation(current_user, conversation_id):
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    return jsonify({"ok": True})


def _ai_sse_event(payload: dict) -> str:
    from app.enterprise.ai_llm_stream import sse_event

    return sse_event(payload)


def _ai_sse_response(generate):
    """Wrap a generator function (already decorated with @stream_with_context) as SSE."""

    def stream():
        yield ": connected\n\n"
        yield from generate()

    return Response(
        stream_with_context(stream)(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _parse_ai_chatbot_chat_request():
    from app.enterprise.ai_chatbot import ingest_chat_uploads

    attachments: list = []
    uploaded = [f for f in request.files.getlist("file") if f and getattr(f, "filename", None)]
    if uploaded:
        message = (request.form.get("message") or "").strip()
        conversation_id = request.form.get("conversation_id")
        attachments = ingest_chat_uploads(uploaded)
    else:
        data = request.get_json(silent=True) or {}
        message = (data.get("message") or "").strip()
        conversation_id = data.get("conversation_id")
    if not message and not attachments:
        raise ValueError("Message or attachment is required.")
    try:
        conversation_id = int(conversation_id)
    except (TypeError, ValueError):
        raise ValueError("conversation_id is required.")
    return message, conversation_id, attachments


def _ai_chatbot_chat_precheck():
    ok, msg = _ai_chatbot_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    from app.enterprise.ai_chatbot import llm_configured

    if not llm_configured():
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "AI is not configured. Set API key and base URL under Administration → AI Settings → AI Chatbot.",
                }
            ),
            503,
        )
    return None


@bp.route("/api/ai-chatbot/chat", methods=["POST"])
@login_required
def api_ai_chatbot_chat():
    from app.enterprise.ai_chatbot import (
        _attachment_for_storage,
        chat_reply,
        user_message_display_text,
    )
    from app.enterprise.ai_chatbot_conversations import chat_history_for_llm, get_conversation, save_conversation

    blocked = _ai_chatbot_chat_precheck()
    if blocked is not None:
        return blocked
    try:
        message, conversation_id, attachments = _parse_ai_chatbot_chat_request()
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    conv = get_conversation(current_user, conversation_id)
    if not conv:
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    prior = chat_history_for_llm(conv.get("messages") or [])
    try:
        answer = chat_reply(message, history=prior, attachments=attachments)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 502
    except Exception:
        current_app.logger.exception("ai chatbot failed")
        return jsonify({"ok": False, "error": "Chat failed. Try again later."}), 500
    stored = list(conv.get("messages") or [])
    user_row: dict = {
        "role": "user",
        "content": user_message_display_text(message, attachments),
    }
    if attachments:
        user_row["attachments"] = [_attachment_for_storage(a) for a in attachments]
    stored.append(user_row)
    stored.append({"role": "assistant", "content": answer})
    updated = save_conversation(current_user, conversation_id, messages=stored)
    return jsonify(
        {
            "ok": True,
            "conversation_id": conversation_id,
            "conversation": updated,
            "answer": answer,
        }
    )


@bp.route("/api/ai-chatbot/chat/stream", methods=["POST"])
@login_required
def api_ai_chatbot_chat_stream():
    from app.enterprise.ai_chatbot import (
        _attachment_for_storage,
        build_chat_messages,
        iter_chat_completion_deltas,
        user_message_display_text,
    )
    from app.enterprise.ai_chatbot_conversations import chat_history_for_llm, get_conversation, save_conversation

    blocked = _ai_chatbot_chat_precheck()
    if blocked is not None:
        return blocked
    try:
        message, conversation_id, attachments = _parse_ai_chatbot_chat_request()
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    conv = get_conversation(current_user, conversation_id)
    if not conv:
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    prior = chat_history_for_llm(conv.get("messages") or [])

    @stream_with_context
    def generate():
        parts: list[str] = []
        try:
            llm_messages = build_chat_messages(message, history=prior, attachments=attachments)
            for piece in iter_chat_completion_deltas(llm_messages):
                parts.append(piece)
                yield _ai_sse_event({"type": "token", "content": piece})
            answer = "".join(parts).strip()
            stored = list(conv.get("messages") or [])
            user_row: dict = {
                "role": "user",
                "content": user_message_display_text(message, attachments),
            }
            if attachments:
                user_row["attachments"] = [_attachment_for_storage(a) for a in attachments]
            stored.append(user_row)
            stored.append({"role": "assistant", "content": answer})
            updated = save_conversation(current_user, conversation_id, messages=stored)
            yield _ai_sse_event(
                {
                    "type": "done",
                    "ok": True,
                    "conversation_id": conversation_id,
                    "conversation": updated,
                    "answer": answer,
                }
            )
        except ValueError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except RuntimeError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except Exception:
            current_app.logger.exception("ai chatbot stream failed")
            yield _ai_sse_event({"type": "error", "ok": False, "error": "Chat failed. Try again later."})

    return _ai_sse_response(generate)


def _ai_policy_premium_required():
    from app.enterprise.premium_license import ai_policy_assistant_licensed

    if not ai_policy_assistant_licensed():
        return False, "AI Docs and Policy requires an enterprise license (ai_policy_assistant or ai_document_search)."
    return True, ""


@bp.route("/ai-policy-assistant", methods=["GET"])
@login_required
def ai_policy_assistant_page():
    from app.enterprise.ai_policy_assistant import llm_settings_public
    from app.enterprise.premium_license import ai_policy_assistant_licensed

    licensed = ai_policy_assistant_licensed()
    return render_template(
        "intranet_ai_policy_assistant.html",
        nav=_nav("ai_policy_assistant") if licensed else _nav("home"),
        ai_llm=llm_settings_public(),
        ai_licensed=licensed,
    )


@bp.route("/api/ai-policy-assistant/status", methods=["GET"])
@login_required
def api_ai_policy_assistant_status():
    from app.enterprise.ai_policy_assistant import (
        index_stats_for_user,
        list_policy_documents,
        llm_settings_public,
        sync_policy_index_for_user,
    )

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    sync = sync_policy_index_for_user(current_user)
    return jsonify(
        {
            "ok": True,
            "stats": index_stats_for_user(current_user),
            "documents": list_policy_documents(current_user),
            "sync": sync,
            "llm": llm_settings_public(),
        }
    )


@bp.route("/api/ai-policy-assistant/upload", methods=["POST"])
@login_required
def api_ai_policy_assistant_upload():
    from app.enterprise.ai_policy_assistant import llm_configured, upload_policy_files

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not llm_configured():
        return jsonify(
            {
                "ok": False,
                "error": "AI is not configured. Set API key and base URL under Administration → AI Settings → AI Docs and Policy.",
            }
        ), 503
    files = request.files.getlist("file")
    if not files:
        return jsonify({"ok": False, "error": "No files uploaded."}), 400
    try:
        results = upload_policy_files(current_user, files)
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception:
        current_app.logger.exception("policy upload failed")
        return jsonify({"ok": False, "error": "Upload failed."}), 500
    return jsonify({"ok": True, "results": results})


@bp.route("/api/ai-policy-assistant/documents/<int:node_id>", methods=["DELETE"])
@login_required
def api_ai_policy_assistant_delete_document(node_id: int):
    from app.enterprise.ai_policy_assistant import remove_policy_document

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not remove_policy_document(current_user, node_id):
        return jsonify({"ok": False, "error": "Document not found or cannot be removed."}), 404
    return jsonify({"ok": True})


@bp.route("/api/ai-policy-assistant/reindex", methods=["POST"])
@login_required
def api_ai_policy_assistant_reindex():
    from app.enterprise.ai_policy_assistant import index_stats_for_user, sync_policy_index_for_user

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    sync = sync_policy_index_for_user(current_user)
    return jsonify({"ok": True, "sync": sync, "stats": index_stats_for_user(current_user)})


@bp.route("/api/ai-policy-assistant/conversations", methods=["GET"])
@login_required
def api_ai_policy_assistant_conversations_list():
    from app.enterprise.ai_policy_assistant_conversations import list_conversations

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    return jsonify({"ok": True, "conversations": list_conversations(current_user)})


@bp.route("/api/ai-policy-assistant/conversations", methods=["POST"])
@login_required
def api_ai_policy_assistant_conversations_create():
    from app.enterprise.ai_policy_assistant_conversations import create_conversation

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    conv = create_conversation(current_user)
    return jsonify({"ok": True, "conversation": conv})


@bp.route("/api/ai-policy-assistant/conversations/<int:conversation_id>", methods=["GET"])
@login_required
def api_ai_policy_assistant_conversations_get(conversation_id: int):
    from app.enterprise.ai_policy_assistant_conversations import get_conversation

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    conv = get_conversation(current_user, conversation_id)
    if not conv:
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    return jsonify({"ok": True, "conversation": conv})


@bp.route("/api/ai-policy-assistant/conversations/<int:conversation_id>", methods=["DELETE"])
@login_required
def api_ai_policy_assistant_conversations_delete(conversation_id: int):
    from app.enterprise.ai_policy_assistant_conversations import delete_conversation

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not delete_conversation(current_user, conversation_id):
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    return jsonify({"ok": True})


@bp.route("/api/ai-policy-assistant/chat", methods=["POST"])
@login_required
def api_ai_policy_assistant_chat():
    from app.enterprise.ai_policy_assistant import answer_policy_question, llm_configured
    from app.enterprise.ai_policy_assistant_conversations import (
        chat_history_for_llm,
        get_conversation,
        save_conversation,
    )

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not llm_configured():
        return jsonify(
            {
                "ok": False,
                "error": "AI is not configured. Set API key and base URL under Administration → AI Settings → AI Docs and Policy.",
            }
        ), 503
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"ok": False, "error": "Message is required."}), 400
    conversation_id = data.get("conversation_id")
    try:
        conversation_id = int(conversation_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "conversation_id is required."}), 400
    conv = get_conversation(current_user, conversation_id)
    if not conv:
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    prior = chat_history_for_llm(conv.get("messages") or [])
    try:
        result = answer_policy_question(current_user, message, history=prior)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 502
    except Exception:
        current_app.logger.exception("ai policy assistant failed")
        return jsonify({"ok": False, "error": "Policy assistant failed. Try again later."}), 500
    stored = list(conv.get("messages") or [])
    stored.append({"role": "user", "content": message})
    stored.append(
        {
            "role": "assistant",
            "content": result.get("answer") or "",
            "sources": result.get("sources") or [],
        }
    )
    updated = save_conversation(current_user, conversation_id, messages=stored)
    return jsonify(
        {
            "ok": True,
            "conversation_id": conversation_id,
            "conversation": updated,
            **result,
        }
    )


@bp.route("/api/ai-policy-assistant/chat/stream", methods=["POST"])
@login_required
def api_ai_policy_assistant_chat_stream():
    from app.enterprise.ai_policy_assistant import (
        iter_policy_answer_deltas,
        llm_configured,
        prepare_policy_answer_messages,
    )
    from app.enterprise.ai_policy_assistant_conversations import (
        chat_history_for_llm,
        get_conversation,
        save_conversation,
    )

    ok, msg = _ai_policy_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not llm_configured():
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "AI is not configured. Set API key and base URL under Administration → AI Settings → AI Docs and Policy.",
                }
            ),
            503,
        )
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    if not message:
        return jsonify({"ok": False, "error": "Message is required."}), 400
    conversation_id = data.get("conversation_id")
    try:
        conversation_id = int(conversation_id)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "conversation_id is required."}), 400
    conv = get_conversation(current_user, conversation_id)
    if not conv:
        return jsonify({"ok": False, "error": "Conversation not found."}), 404
    prior = chat_history_for_llm(conv.get("messages") or [])

    @stream_with_context
    def generate():
        parts: list[str] = []
        try:
            yield _ai_sse_event({"type": "status", "content": "Searching policies…"})
            prep = prepare_policy_answer_messages(current_user, message, history=prior)
            for piece in iter_policy_answer_deltas(prep["messages"]):
                parts.append(piece)
                yield _ai_sse_event({"type": "token", "content": piece})
            answer = "".join(parts).strip()
            stored = list(conv.get("messages") or [])
            stored.append({"role": "user", "content": message})
            stored.append(
                {
                    "role": "assistant",
                    "content": answer,
                    "sources": prep["sources"],
                }
            )
            updated = save_conversation(current_user, conversation_id, messages=stored)
            yield _ai_sse_event(
                {
                    "type": "done",
                    "ok": True,
                    "conversation_id": conversation_id,
                    "conversation": updated,
                    "answer": answer,
                    "sources": prep["sources"],
                    "stats": prep["stats"],
                }
            )
        except ValueError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except RuntimeError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except Exception:
            current_app.logger.exception("ai policy assistant stream failed")
            yield _ai_sse_event({"type": "error", "ok": False, "error": "Policy assistant failed. Try again later."})

    return _ai_sse_response(generate)


def _ai_cv_builder_premium_required():
    from app.enterprise.premium_license import ai_cv_builder_licensed

    if not ai_cv_builder_licensed():
        return False, "AI CV Builder requires an enterprise license (ai_cv_builder or ai_document_search)."
    return True, ""


@bp.route("/ai-cv-builder", methods=["GET"])
@login_required
def ai_cv_builder_page():
    from app.enterprise.premium_license import ai_cv_builder_licensed

    licensed = ai_cv_builder_licensed()
    return render_template(
        "intranet_ai_cv_builder.html",
        nav=_nav("ai_cv_builder") if licensed else _nav("home"),
        ai_licensed=licensed,
    )


@bp.route("/api/ai-cv-builder/status", methods=["GET"])
@login_required
def api_ai_cv_builder_status():
    from app.enterprise.ai_cv_builder import public_status

    ok, msg = _ai_cv_builder_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    return jsonify({"ok": True, **public_status(current_user.id)})


@bp.route("/api/ai-cv-builder/template", methods=["POST"])
@login_required
def api_ai_cv_builder_template():
    from app.enterprise.ai_cv_builder import save_template

    ok, msg = _ai_cv_builder_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "Template file required (.docx)."}), 400
    data = f.read()
    try:
        info = save_template(current_user.id, f.filename, data)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception:
        current_app.logger.exception("cv template upload failed")
        return jsonify({"ok": False, "error": "Upload failed."}), 500
    return jsonify({"ok": True, "template": info})


@bp.route("/api/ai-cv-builder/source", methods=["POST"])
@login_required
def api_ai_cv_builder_source():
    from app.enterprise.ai_cv_builder import save_source

    ok, msg = _ai_cv_builder_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "Source CV file required (PDF or Word)."}), 400
    data = f.read()
    try:
        info = save_source(current_user.id, f.filename, data)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception:
        current_app.logger.exception("cv source upload failed")
        return jsonify({"ok": False, "error": "Upload failed."}), 500
    return jsonify({"ok": True, "source": info})


@bp.route("/api/ai-cv-builder/build", methods=["POST"])
@login_required
def api_ai_cv_builder_build():
    from app.enterprise.ai_cv_builder import build_cv, llm_configured, public_status

    ok, msg = _ai_cv_builder_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not llm_configured():
        return jsonify(
            {
                "ok": False,
                "error": "AI is not configured. Set API key and base URL under Administration → AI Settings → AI CV Builder.",
            }
        ), 503
    data = request.get_json(silent=True) or {}
    instructions = (data.get("instructions") or "").strip()
    try:
        result = build_cv(current_user.id, extra_instructions=instructions)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 502
    except Exception:
        current_app.logger.exception("ai cv build failed")
        return jsonify({"ok": False, "error": "Build failed. Try again later."}), 500
    return jsonify({"ok": True, **result, "status": public_status(current_user.id)})


@bp.route("/api/ai-cv-builder/build/stream", methods=["POST"])
@login_required
def api_ai_cv_builder_build_stream():
    from app.enterprise.ai_cv_builder import (
        build_cv_messages,
        finalize_cv_build,
        iter_cv_build_deltas,
        llm_configured,
        public_status,
    )

    ok, msg = _ai_cv_builder_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not llm_configured():
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "AI is not configured. Set API key and base URL under Administration → AI Settings → AI CV Builder.",
                }
            ),
            503,
        )
    data = request.get_json(silent=True) or {}
    instructions = (data.get("instructions") or "").strip()
    user_id = current_user.id

    @stream_with_context
    def generate():
        parts: list[str] = []
        try:
            messages, template_bytes, slots = build_cv_messages(user_id, extra_instructions=instructions)
            for piece in iter_cv_build_deltas(messages):
                parts.append(piece)
                yield _ai_sse_event({"type": "token", "content": piece})
            raw = "".join(parts).strip()
            result = finalize_cv_build(user_id, raw, template_bytes, slots)
            yield _ai_sse_event(
                {
                    "type": "done",
                    "ok": True,
                    **result,
                    "status": public_status(user_id),
                }
            )
        except ValueError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except RuntimeError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except Exception:
            current_app.logger.exception("ai cv build stream failed")
            yield _ai_sse_event({"type": "error", "ok": False, "error": "Build failed. Try again later."})

    return _ai_sse_response(generate)


@bp.route("/api/ai-cv-builder/download", methods=["GET"])
@login_required
def api_ai_cv_builder_download():
    from app.enterprise.ai_cv_builder import output_file_path

    ok, msg = _ai_cv_builder_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    path = output_file_path(current_user.id)
    if not path:
        return jsonify({"ok": False, "error": "No built CV available yet."}), 404
    from flask import send_file

    return send_file(
        path,
        as_attachment=True,
        download_name="cv-built.docx",
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )


def _ai_tender_assistant_premium_required():
    from app.enterprise.premium_license import ai_tender_assistant_licensed

    if not ai_tender_assistant_licensed():
        return False, "AI Tender Assistant requires an enterprise license (ai_tender_assistant or ai_document_search)."
    return True, ""


@bp.route("/ai-tender-assistant", methods=["GET"])
@login_required
def ai_tender_assistant_page():
    from app.enterprise.premium_license import ai_tender_assistant_licensed

    licensed = ai_tender_assistant_licensed()
    return render_template(
        "intranet_ai_tender_assistant.html",
        nav=_nav("ai_tender_assistant") if licensed else _nav("home"),
        ai_licensed=licensed,
    )


@bp.route("/api/ai-tender-assistant/status", methods=["GET"])
@login_required
def api_ai_tender_assistant_status():
    from app.enterprise.ai_tender_assistant import public_status

    ok, msg = _ai_tender_assistant_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    return jsonify({"ok": True, **public_status(current_user.id)})


@bp.route("/api/ai-tender-assistant/upload", methods=["POST"])
@login_required
def api_ai_tender_assistant_upload():
    from app.enterprise.ai_tender_assistant import upload_document

    ok, msg = _ai_tender_assistant_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"ok": False, "error": "Tender document file required."}), 400
    doc_type = (request.form.get("doc_type") or "other").strip()
    data = f.read()
    try:
        info = upload_document(current_user.id, f.filename, data, doc_type)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as exc:
        current_app.logger.exception("tender document upload failed")
        return jsonify({"ok": False, "error": str(exc) or "Upload failed."}), 500
    return jsonify({"ok": True, "document": info})


@bp.route("/api/ai-tender-assistant/documents/<doc_id>", methods=["DELETE"])
@login_required
def api_ai_tender_assistant_delete_document(doc_id: str):
    from app.enterprise.ai_tender_assistant import delete_document, public_status

    ok, msg = _ai_tender_assistant_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not delete_document(current_user.id, doc_id):
        return jsonify({"ok": False, "error": "Document not found."}), 404
    return jsonify({"ok": True, **public_status(current_user.id)})


@bp.route("/api/ai-tender-assistant/analyze", methods=["POST"])
@login_required
def api_ai_tender_assistant_analyze():
    from app.enterprise.ai_tender_assistant import analyze_tender, llm_configured, public_status

    ok, msg = _ai_tender_assistant_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not llm_configured():
        return jsonify(
            {
                "ok": False,
                "error": "AI is not configured. Set API key and base URL under Administration → AI Settings → AI Tender Assistant.",
            }
        ), 503
    data = request.get_json(silent=True) or {}
    instructions = (data.get("instructions") or "").strip()
    try:
        result = analyze_tender(current_user.id, extra_instructions=instructions)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 502
    except Exception:
        current_app.logger.exception("ai tender analysis failed")
        return jsonify({"ok": False, "error": "Analysis failed. Try again later."}), 500
    return jsonify({"ok": True, **result, "status": public_status(current_user.id)})


@bp.route("/api/ai-tender-assistant/analyze/stream", methods=["POST"])
@login_required
def api_ai_tender_assistant_analyze_stream():
    from app.enterprise.ai_tender_assistant import (
        build_tender_analysis_messages,
        finalize_tender_analysis,
        iter_tender_analysis_deltas,
        llm_configured,
        public_status,
    )

    ok, msg = _ai_tender_assistant_premium_required()
    if not ok:
        return jsonify({"ok": False, "error": msg}), 403
    if not llm_configured():
        return jsonify(
            {
                "ok": False,
                "error": "AI is not configured. Set API key and base URL under Administration → AI Settings → AI Tender Assistant.",
            }
        ), 503
    data = request.get_json(silent=True) or {}
    instructions = (data.get("instructions") or "").strip()
    user_id = current_user.id

    @stream_with_context
    def generate():
        parts: list[str] = []
        try:
            messages, refs = build_tender_analysis_messages(user_id, extra_instructions=instructions)
            for piece in iter_tender_analysis_deltas(messages):
                parts.append(piece)
                yield _ai_sse_event({"type": "token", "content": piece})
            raw = "".join(parts).strip()
            result = finalize_tender_analysis(user_id, raw, refs)
            yield _ai_sse_event(
                {
                    "type": "done",
                    "ok": True,
                    **result,
                    "status": public_status(user_id),
                }
            )
        except ValueError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except RuntimeError as e:
            yield _ai_sse_event({"type": "error", "ok": False, "error": str(e)})
        except Exception:
            current_app.logger.exception("ai tender analysis stream failed")
            yield _ai_sse_event({"type": "error", "ok": False, "error": "Analysis failed. Try again later."})

    return _ai_sse_response(generate)

