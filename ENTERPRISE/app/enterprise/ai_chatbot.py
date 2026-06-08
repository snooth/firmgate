"""General-purpose AI chatbot (OpenAI-compatible LLM, no document index)."""

from __future__ import annotations

import base64
import json
import os
import ssl
import urllib.error
import urllib.request
from pathlib import Path
from collections.abc import Iterator
from typing import Any

from flask import current_app
from werkzeug.datastructures import FileStorage

from app.enterprise.ai_document_search import extract_text_from_bytes
from app.settings import get_setting

_MAX_ATTACHMENTS = 8
_MAX_ATTACH_BYTES = 8 * 1024 * 1024
_MAX_ATTACH_TOTAL_BYTES = 24 * 1024 * 1024
_MAX_STORED_PREVIEW_CHARS = 180_000
_IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif"})
_IMAGE_MIME_PREFIX = "image/"

SETTING_AI_CHATBOT = "ai_chatbot"


_DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful assistant for an organisation's private intranet. "
    "Answer clearly and concisely. If you are unsure, say so. "
    "Do not invent internal policies, file paths, or facts about the organisation."
)


def _settings_row() -> dict[str, Any]:
    raw = get_setting(SETTING_AI_CHATBOT, default={}) or {}
    return raw if isinstance(raw, dict) else {}


def llm_api_key() -> str:
    from app.enterprise.ai_llm_settings import PRODUCT_CHATBOT, llm_api_key as _key

    return _key(PRODUCT_CHATBOT)


def llm_base_url() -> str:
    from app.enterprise.ai_llm_settings import PRODUCT_CHATBOT, llm_base_url as _url

    return _url(PRODUCT_CHATBOT)


def llm_model() -> str:
    from app.enterprise.ai_llm_settings import PRODUCT_CHATBOT, llm_model as _model

    return _model(PRODUCT_CHATBOT)


def llm_system_prompt() -> str:
    row = _settings_row()
    prompt = (row.get("system_prompt") or "").strip()
    return prompt or _DEFAULT_SYSTEM_PROMPT


def llm_temperature() -> float:
    from app.enterprise.ai_llm_settings import PRODUCT_CHATBOT, llm_temperature as _temp

    return _temp(PRODUCT_CHATBOT, default=0.6)


def llm_max_tokens() -> int:
    from app.enterprise.ai_llm_settings import PRODUCT_CHATBOT, llm_max_tokens as _tokens

    return _tokens(PRODUCT_CHATBOT, default=2000)


def llm_skip_tls_verify() -> bool:
    from app.enterprise.ai_llm_settings import PRODUCT_CHATBOT, llm_skip_tls_verify as _skip

    return _skip(PRODUCT_CHATBOT)


def _llm_ssl_context() -> ssl.SSLContext:
    from app.enterprise.ai_llm_settings import PRODUCT_CHATBOT, _llm_ssl_context as _ctx

    return _ctx(PRODUCT_CHATBOT)


def llm_configured() -> bool:
    from app.enterprise.ai_llm_settings import PRODUCT_CHATBOT, llm_configured as _configured

    return _configured(PRODUCT_CHATBOT)


def llm_settings_public() -> dict[str, Any]:
    from app.enterprise.ai_llm_settings import PRODUCT_CHATBOT, llm_settings_public as _public

    row = _settings_row()
    return {
        **_public(PRODUCT_CHATBOT),
        "system_prompt_set": bool((row.get("system_prompt") or "").strip()),
    }


def llm_supports_vision() -> bool:
    """Heuristic: model id suggests multimodal / vision support."""
    m = llm_model().lower()
    hints = (
        "gpt-4o",
        "gpt-4-vision",
        "gpt-4.1",
        "gpt-4.5",
        "gpt-5",
        "claude-3",
        "claude-sonnet-4",
        "claude-opus-4",
        "gemini",
        "pixtral",
        "llava",
        "vision",
    )
    return any(h in m for h in hints)


def _is_image_file(filename: str, mime: str) -> bool:
    if mime.startswith(_IMAGE_MIME_PREFIX):
        return True
    return Path(filename or "").suffix.lower() in _IMAGE_SUFFIXES


def ingest_chat_uploads(files: list[FileStorage]) -> list[dict[str, Any]]:
    """Turn uploaded files into attachment dicts for chat + storage."""
    out: list[dict[str, Any]] = []
    total = 0
    for f in files[:_MAX_ATTACHMENTS]:
        if not f or not getattr(f, "filename", None):
            continue
        name = Path(f.filename).name or "file"
        data = f.read()
        if not data:
            continue
        if len(data) > _MAX_ATTACH_BYTES:
            raise ValueError(f"{name} is too large (max 8 MB per file).")
        total += len(data)
        if total > _MAX_ATTACH_TOTAL_BYTES:
            raise ValueError("Total attachments too large (max 24 MB per message).")
        mime = (getattr(f, "mimetype", None) or "application/octet-stream").split(";")[0].strip()
        is_image = _is_image_file(name, mime)
        row: dict[str, Any] = {"name": name, "kind": "image" if is_image else "file", "size": len(data)}
        if is_image:
            if not mime.startswith(_IMAGE_MIME_PREFIX):
                ext = Path(name).suffix.lower()
                mime = {
                    ".png": "image/png",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".gif": "image/gif",
                    ".webp": "image/webp",
                    ".svg": "image/svg+xml",
                }.get(ext, "image/png")
            b64 = base64.b64encode(data).decode("ascii")
            row["data_url"] = f"data:{mime};base64,{b64}"
        else:
            text = extract_text_from_bytes(name, data)
            if text.strip():
                row["extracted_text"] = text.strip()[:48000]
        out.append(row)
    return out


def _attachment_for_storage(att: dict[str, Any]) -> dict[str, Any]:
    row: dict[str, Any] = {
        "name": str(att.get("name") or "file"),
        "kind": att.get("kind") or "file",
        "size": int(att.get("size") or 0),
    }
    if att.get("kind") == "image":
        preview = str(att.get("data_url") or "")
        if preview and len(preview) <= _MAX_STORED_PREVIEW_CHARS:
            row["preview"] = preview
    excerpt = str(att.get("extracted_text") or "").strip()
    if excerpt:
        row["excerpt"] = excerpt[:800]
    return row


def _build_user_llm_content(message: str, attachments: list[dict[str, Any]] | None) -> str | list[dict[str, Any]]:
    message = (message or "").strip()
    atts = attachments or []
    if not atts:
        return message

    text_blocks: list[str] = []
    if message:
        text_blocks.append(message)

    vision_parts: list[dict[str, Any]] = []
    use_vision = llm_supports_vision()

    for att in atts:
        name = str(att.get("name") or "file")
        if att.get("kind") == "image":
            if use_vision and att.get("data_url"):
                vision_parts.append(
                    {"type": "image_url", "image_url": {"url": str(att["data_url"])}}
                )
            else:
                text_blocks.append(
                    f"[Image: {name}. Configure a vision-capable model (e.g. gpt-4o) to analyse images.]"
                )
        elif att.get("extracted_text"):
            text_blocks.append(f"--- Content of {name} ---\n{att['extracted_text']}")
        else:
            text_blocks.append(f"[File attached: {name} — no extractable text for this format.]")

    combined = "\n\n".join(text_blocks).strip()
    if vision_parts and use_vision:
        parts: list[dict[str, Any]] = [
            {"type": "text", "text": combined or "Please refer to the attached image(s)."}
        ]
        parts.extend(vision_parts)
        return parts
    return combined or "See attached file(s)."


def user_message_display_text(message: str, attachments: list[dict[str, Any]] | None) -> str:
    message = (message or "").strip()
    atts = attachments or []
    if not atts:
        return message
    names = ", ".join(str(a.get("name") or "file") for a in atts)
    if not message:
        return f"Attached: {names}"
    return f"{message}\n\nAttached: {names}"


def _llm_request_headers() -> dict[str, str]:
    from app.enterprise.ai_llm_http import effective_llm_api_key, openai_request_headers

    api_key = llm_api_key()
    base = llm_base_url()
    if not effective_llm_api_key(api_key, base):
        raise RuntimeError(
            "AI Chatbot is not configured. Set the API key under Administration → AI Settings → AI Chatbot, "
            "or point Base URL at a local OpenAI-compatible server (Ollama/LM Studio)."
        )
    return openai_request_headers(api_key, base)


def _raise_llm_url_error(exc: urllib.error.URLError) -> None:
    reason = str(exc.reason or exc)
    if "CERTIFICATE_VERIFY_FAILED" in reason or "certificate verify failed" in reason.lower():
        raise RuntimeError(
            "Could not reach LLM API: TLS certificate verification failed. "
            "Install certifi and restart, or enable skip TLS under Administration → AI Settings."
        ) from exc
    raise RuntimeError(f"Could not reach LLM API: {reason}") from exc


def _raise_llm_http_error(exc: urllib.error.HTTPError) -> None:
    body = exc.read().decode("utf-8", errors="replace")[:500]
    raise RuntimeError(f"LLM request failed ({exc.code}): {body}") from exc


def _chat_completion_body(*, stream: bool) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": llm_model(),
        "temperature": llm_temperature(),
        "max_tokens": llm_max_tokens(),
    }
    if stream:
        body["stream"] = True
    return body


def _chat_completion(messages: list[dict[str, Any]]) -> str:
    url = f"{llm_base_url()}/chat/completions"
    payload = json.dumps({**_chat_completion_body(stream=False), "messages": messages}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers=_llm_request_headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120, context=_llm_ssl_context()) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        _raise_llm_http_error(e)
    except urllib.error.URLError as e:
        _raise_llm_url_error(e)
    try:
        return (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError("Unexpected LLM response format") from e


def iter_chat_completion_deltas(messages: list[dict[str, Any]]) -> Iterator[str]:
    """Yield assistant text chunks from an OpenAI-compatible streaming chat completion."""
    from app.enterprise.ai_llm_stream import iter_chat_completion_deltas as _iter_deltas

    _llm_request_headers()  # validate API key
    yield from _iter_deltas(
        messages,
        url=f"{llm_base_url()}/chat/completions",
        api_key=llm_api_key(),
        model=llm_model(),
        temperature=llm_temperature(),
        max_tokens=llm_max_tokens(),
        ssl_context=_llm_ssl_context(),
        timeout=300,
    )


def build_chat_messages(
    message: str,
    *,
    history: list[dict[str, str]] | None = None,
    attachments: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    message = (message or "").strip()
    atts = attachments or []
    if not message and not atts:
        raise ValueError("Message or attachment is required.")
    if len(message) > 8000:
        raise ValueError("Message is too long.")
    messages: list[dict[str, Any]] = [{"role": "system", "content": llm_system_prompt()}]
    if history:
        messages.extend(history[-16:])
    messages.append({"role": "user", "content": _build_user_llm_content(message, atts)})
    return messages


def chat_reply(
    message: str,
    *,
    history: list[dict[str, str]] | None = None,
    attachments: list[dict[str, Any]] | None = None,
) -> str:
    return _chat_completion(build_chat_messages(message, history=history, attachments=attachments))
