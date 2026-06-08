"""Shared OpenAI-compatible chat completion streaming for enterprise AI features."""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

from app.enterprise.ai_llm_http import llm_is_configured, openai_request_headers


def sse_event(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def delta_text_from_stream_chunk(obj: dict[str, Any]) -> str:
    choices = obj.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    c0 = choices[0]
    if not isinstance(c0, dict):
        return ""
    delta = c0.get("delta")
    if isinstance(delta, dict):
        content = delta.get("content")
        if content:
            return str(content)
    message = c0.get("message")
    if isinstance(message, dict) and message.get("content"):
        return str(message["content"])
    text = c0.get("text")
    return str(text) if text else ""


def iter_chat_completion_deltas(
    messages: list[dict[str, Any]],
    *,
    url: str,
    api_key: str,
    model: str,
    temperature: float,
    max_tokens: int,
    ssl_context: ssl.SSLContext,
    timeout: int = 300,
    extra_body: dict[str, Any] | None = None,
) -> Iterator[str]:
    """Yield assistant text chunks from an OpenAI-compatible streaming chat completion."""
    from app.enterprise.ai_llm_http import llm_is_configured

    base_url = url.rsplit("/chat/completions", 1)[0] if "/chat/completions" in url else url
    if not llm_is_configured(api_key=api_key, base_url=base_url):
        raise RuntimeError(
            "LLM API key is not configured. Set an API key under Administration → AI Settings, "
            "or use a local server URL (e.g. http://127.0.0.1:11434/v1 for Ollama)."
        )
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    if extra_body:
        body.update(extra_body)
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers=openai_request_headers(api_key, base_url),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as resp:
            while True:
                raw = resp.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                if line.startswith("data:"):
                    line = line[5:].strip()
                if line == "[DONE]":
                    break
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(obj, dict):
                    continue
                piece = delta_text_from_stream_chunk(obj)
                if piece:
                    yield piece
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"LLM request failed ({e.code}): {body_txt}") from e
    except urllib.error.URLError as e:
        reason = str(e.reason or e)
        if "CERTIFICATE_VERIFY_FAILED" in reason or "certificate verify failed" in reason.lower():
            raise RuntimeError(
                "Could not reach LLM API: TLS certificate verification failed. "
                "Install certifi and restart, or enable skip TLS under Administration → AI Settings."
            ) from e
        raise RuntimeError(f"Could not reach LLM API: {reason}") from e
