"""Per-product OpenAI-compatible LLM connection settings (API key, base URL, model)."""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request
from typing import Any

from flask import current_app

from app.enterprise.ai_llm_http import (
    effective_llm_api_key,
    llm_is_configured,
    normalize_openai_base_url,
    openai_request_headers,
)
from app.settings import get_setting, set_setting

PRODUCT_DOCUMENT_SEARCH = "document_search"
PRODUCT_CHATBOT = "chatbot"
PRODUCT_POLICY_ASSISTANT = "policy_assistant"
PRODUCT_CV_BUILDER = "cv_builder"
PRODUCT_TENDER_ASSISTANT = "tender_assistant"

ALL_LLM_PRODUCTS = (
    PRODUCT_DOCUMENT_SEARCH,
    PRODUCT_CHATBOT,
    PRODUCT_POLICY_ASSISTANT,
    PRODUCT_CV_BUILDER,
    PRODUCT_TENDER_ASSISTANT,
)

SETTING_KEY_BY_PRODUCT: dict[str, str] = {
    PRODUCT_DOCUMENT_SEARCH: "ai_document_search",
    PRODUCT_CHATBOT: "ai_chatbot",
    PRODUCT_POLICY_ASSISTANT: "ai_policy_assistant",
    PRODUCT_CV_BUILDER: "ai_cv_builder",
    PRODUCT_TENDER_ASSISTANT: "ai_tender_assistant",
}

PRODUCT_LABELS: dict[str, str] = {
    PRODUCT_DOCUMENT_SEARCH: "AI Document Search",
    PRODUCT_CHATBOT: "AI Chatbot",
    PRODUCT_POLICY_ASSISTANT: "AI Docs and Policy",
    PRODUCT_CV_BUILDER: "AI CV Builder",
    PRODUCT_TENDER_ASSISTANT: "AI Tender Assistant",
}

_DEFAULT_MODEL = "gpt-4o-mini"
_DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"

_ENV_API_KEY: dict[str, tuple[str, ...]] = {
    PRODUCT_DOCUMENT_SEARCH: ("AI_LLM_API_KEY", "OPENAI_API_KEY"),
    PRODUCT_CHATBOT: ("AI_CHATBOT_API_KEY", "AI_LLM_API_KEY", "OPENAI_API_KEY"),
    PRODUCT_POLICY_ASSISTANT: ("AI_POLICY_ASSISTANT_API_KEY", "AI_LLM_API_KEY", "OPENAI_API_KEY"),
    PRODUCT_CV_BUILDER: ("AI_CV_BUILDER_API_KEY", "AI_LLM_API_KEY", "OPENAI_API_KEY"),
    PRODUCT_TENDER_ASSISTANT: ("AI_TENDER_ASSISTANT_API_KEY", "AI_LLM_API_KEY", "OPENAI_API_KEY"),
}

_ENV_BASE_URL: dict[str, tuple[str, ...]] = {
    PRODUCT_DOCUMENT_SEARCH: ("AI_LLM_BASE_URL",),
    PRODUCT_CHATBOT: ("AI_CHATBOT_BASE_URL", "AI_LLM_BASE_URL"),
    PRODUCT_POLICY_ASSISTANT: ("AI_POLICY_ASSISTANT_BASE_URL", "AI_LLM_BASE_URL"),
    PRODUCT_CV_BUILDER: ("AI_CV_BUILDER_BASE_URL", "AI_LLM_BASE_URL"),
    PRODUCT_TENDER_ASSISTANT: ("AI_TENDER_ASSISTANT_BASE_URL", "AI_LLM_BASE_URL"),
}

_ENV_MODEL: dict[str, tuple[str, ...]] = {
    PRODUCT_DOCUMENT_SEARCH: ("AI_LLM_MODEL",),
    PRODUCT_CHATBOT: ("AI_CHATBOT_MODEL", "AI_LLM_MODEL"),
    PRODUCT_POLICY_ASSISTANT: ("AI_POLICY_ASSISTANT_MODEL", "AI_LLM_MODEL"),
    PRODUCT_CV_BUILDER: ("AI_CV_BUILDER_MODEL", "AI_LLM_MODEL"),
    PRODUCT_TENDER_ASSISTANT: ("AI_TENDER_ASSISTANT_MODEL", "AI_LLM_MODEL"),
}

_ENV_SKIP_TLS: dict[str, tuple[str, ...]] = {
    PRODUCT_DOCUMENT_SEARCH: ("AI_LLM_SKIP_TLS_VERIFY",),
    PRODUCT_CHATBOT: ("AI_CHATBOT_SKIP_TLS_VERIFY", "AI_LLM_SKIP_TLS_VERIFY"),
    PRODUCT_POLICY_ASSISTANT: ("AI_POLICY_ASSISTANT_SKIP_TLS_VERIFY", "AI_LLM_SKIP_TLS_VERIFY"),
    PRODUCT_CV_BUILDER: ("AI_CV_BUILDER_SKIP_TLS_VERIFY", "AI_LLM_SKIP_TLS_VERIFY"),
    PRODUCT_TENDER_ASSISTANT: ("AI_TENDER_ASSISTANT_SKIP_TLS_VERIFY", "AI_LLM_SKIP_TLS_VERIFY"),
}

_CONFIG_API_KEY: dict[str, str] = {
    PRODUCT_DOCUMENT_SEARCH: "AI_LLM_API_KEY",
    PRODUCT_CHATBOT: "AI_CHATBOT_API_KEY",
    PRODUCT_POLICY_ASSISTANT: "AI_POLICY_ASSISTANT_API_KEY",
    PRODUCT_CV_BUILDER: "AI_CV_BUILDER_API_KEY",
    PRODUCT_TENDER_ASSISTANT: "AI_TENDER_ASSISTANT_API_KEY",
}

_CONFIG_BASE_URL: dict[str, str] = {
    PRODUCT_DOCUMENT_SEARCH: "AI_LLM_BASE_URL",
    PRODUCT_CHATBOT: "AI_CHATBOT_BASE_URL",
    PRODUCT_POLICY_ASSISTANT: "AI_POLICY_ASSISTANT_BASE_URL",
    PRODUCT_CV_BUILDER: "AI_CV_BUILDER_BASE_URL",
    PRODUCT_TENDER_ASSISTANT: "AI_TENDER_ASSISTANT_BASE_URL",
}

_CONFIG_MODEL: dict[str, str] = {
    PRODUCT_DOCUMENT_SEARCH: "AI_LLM_MODEL",
    PRODUCT_CHATBOT: "AI_CHATBOT_MODEL",
    PRODUCT_POLICY_ASSISTANT: "AI_POLICY_ASSISTANT_MODEL",
    PRODUCT_CV_BUILDER: "AI_CV_BUILDER_MODEL",
    PRODUCT_TENDER_ASSISTANT: "AI_TENDER_ASSISTANT_MODEL",
}

_CONFIG_SKIP_TLS: dict[str, str] = {
    PRODUCT_DOCUMENT_SEARCH: "AI_LLM_SKIP_TLS_VERIFY",
    PRODUCT_CHATBOT: "AI_CHATBOT_SKIP_TLS_VERIFY",
    PRODUCT_POLICY_ASSISTANT: "AI_POLICY_ASSISTANT_SKIP_TLS_VERIFY",
    PRODUCT_CV_BUILDER: "AI_CV_BUILDER_SKIP_TLS_VERIFY",
    PRODUCT_TENDER_ASSISTANT: "AI_TENDER_ASSISTANT_SKIP_TLS_VERIFY",
}


def product_setting_key(product: str) -> str:
    if product not in SETTING_KEY_BY_PRODUCT:
        raise ValueError(f"Unknown AI product: {product}")
    return SETTING_KEY_BY_PRODUCT[product]


def _settings_row(product: str) -> dict[str, Any]:
    raw = get_setting(product_setting_key(product), default={}) or {}
    return raw if isinstance(raw, dict) else {}


def _env_first(*names: str) -> str:
    for name in names:
        val = (os.environ.get(name) or "").strip()
        if val:
            return val
    return ""


def _config_first(*keys: str) -> str:
    for key in keys:
        val = current_app.config.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def llm_api_key(product: str) -> str:
    row = _settings_row(product)
    key = (row.get("api_key") or "").strip()
    if key:
        return key
    env_names = _ENV_API_KEY.get(product, ())
    cfg_name = _CONFIG_API_KEY.get(product, "")
    return _env_first(*env_names) or (cfg_name and _config_first(cfg_name) or "")


def llm_base_url(product: str) -> str:
    row = _settings_row(product)
    url = (row.get("base_url") or "").strip()
    if url:
        return normalize_openai_base_url(url)
    env_names = _ENV_BASE_URL.get(product, ())
    cfg_name = _CONFIG_BASE_URL.get(product, "")
    env_or_cfg = _env_first(*env_names) or (cfg_name and _config_first(cfg_name) or "")
    return normalize_openai_base_url(env_or_cfg)


def llm_model(product: str) -> str:
    row = _settings_row(product)
    model = (row.get("model") or "").strip()
    if model:
        return model
    env_names = _ENV_MODEL.get(product, ())
    cfg_name = _CONFIG_MODEL.get(product, "")
    return _env_first(*env_names) or (cfg_name and _config_first(cfg_name) or "") or _DEFAULT_MODEL


def llm_skip_tls_verify(product: str) -> bool:
    row = _settings_row(product)
    if "skip_tls_verify" in row:
        return bool(row.get("skip_tls_verify"))
    for name in _ENV_SKIP_TLS.get(product, ()):
        if (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes"):
            return True
    cfg = _CONFIG_SKIP_TLS.get(product, "")
    return bool(cfg and current_app.config.get(cfg))


def _llm_ssl_context(product: str) -> ssl.SSLContext:
    if llm_skip_tls_verify(product):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def llm_configured(product: str) -> bool:
    return llm_is_configured(api_key=llm_api_key(product), base_url=llm_base_url(product))


_DEFAULT_MAX_TOKENS: dict[str, int] = {
    PRODUCT_DOCUMENT_SEARCH: 1800,
    PRODUCT_CHATBOT: 2000,
    PRODUCT_POLICY_ASSISTANT: 1800,
    PRODUCT_CV_BUILDER: 4096,
    PRODUCT_TENDER_ASSISTANT: 8192,
}


def llm_max_tokens(product: str, *, default: int | None = None) -> int:
    row = _settings_row(product)
    try:
        if "max_tokens" in row and row["max_tokens"] is not None:
            return max(256, min(int(row["max_tokens"]), 8192))
    except (TypeError, ValueError):
        pass
    if product == PRODUCT_CHATBOT:
        try:
            cap = default if default is not None else _DEFAULT_MAX_TOKENS[PRODUCT_CHATBOT]
            return max(256, min(int(os.environ.get("AI_CHATBOT_MAX_TOKENS", str(cap))), 8000))
        except (TypeError, ValueError):
            pass
    if default is not None:
        return default
    return _DEFAULT_MAX_TOKENS.get(product, 1800)


def llm_temperature(product: str, *, default: float = 0.35) -> float:
    row = _settings_row(product)
    try:
        if "temperature" in row and row["temperature"] is not None:
            return max(0.0, min(float(row["temperature"]), 2.0))
    except (TypeError, ValueError):
        pass
    if product == PRODUCT_CHATBOT:
        try:
            return max(0.0, min(float(os.environ.get("AI_CHATBOT_TEMPERATURE", "0.6")), 2.0))
        except (TypeError, ValueError):
            pass
    defaults = {
        PRODUCT_TENDER_ASSISTANT: 0.2,
        PRODUCT_CV_BUILDER: 0.25,
    }
    return defaults.get(product, default)


def llm_settings_public(product: str) -> dict[str, Any]:
    row = _settings_row(product)
    return {
        "product": product,
        "label": PRODUCT_LABELS.get(product, product),
        "configured": llm_configured(product),
        "model": llm_model(product),
        "base_url": llm_base_url(product),
        "base_url_set": bool((row.get("base_url") or "").strip()),
        "api_key_set": bool((row.get("api_key") or "").strip()),
        "skip_tls_verify": llm_skip_tls_verify(product),
        "max_tokens": llm_max_tokens(product),
        "temperature": llm_temperature(product),
    }


def merge_llm_connection_payload(
    product: str,
    payload: dict[str, Any],
    *,
    existing: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str | None]:
    """Apply API connection fields from admin payload. Returns (merged_row, error)."""
    if product not in SETTING_KEY_BY_PRODUCT:
        return {}, f"Unknown AI product: {product}"

    row = dict(existing if existing is not None else _settings_row(product))

    api_key_in = payload.get("api_key")
    if isinstance(api_key_in, str) and api_key_in.strip() != "":
        api_key = api_key_in.strip()
    else:
        api_key = (row.get("api_key") or "").strip()

    base_url = normalize_openai_base_url(
        (payload.get("base_url") or "").strip() or (row.get("base_url") or "")
    )
    model = (payload.get("model") or "").strip() or (row.get("model") or "").strip() or _DEFAULT_MODEL

    from app.enterprise.ai_llm_http import is_local_llm_host

    if not api_key:
        if is_local_llm_host(base_url):
            api_key = "ollama"
        else:
            label = PRODUCT_LABELS.get(product, product)
            return {}, (
                f"API key is required for {label} when using a cloud LLM API. "
                "For Ollama/LM Studio, set a local Base URL (e.g. http://127.0.0.1:11434/v1)."
            )

    row["api_key"] = api_key
    row["base_url"] = base_url
    row["model"] = model
    if "skip_tls_verify" in payload:
        row["skip_tls_verify"] = bool(payload.get("skip_tls_verify"))
    if "max_tokens" in payload:
        try:
            row["max_tokens"] = max(256, min(int(payload["max_tokens"]), 8192))
        except (TypeError, ValueError):
            pass
    if "temperature" in payload:
        try:
            row["temperature"] = max(0.0, min(float(payload["temperature"]), 2.0))
        except (TypeError, ValueError):
            pass

    set_setting(product_setting_key(product), row)
    return row, None


def chat_completion(
    product: str,
    messages: list[dict[str, Any]],
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> str:
    api_key = llm_api_key(product)
    base = llm_base_url(product)
    if not effective_llm_api_key(api_key, base):
        label = PRODUCT_LABELS.get(product, product)
        raise RuntimeError(
            f"{label} is not configured. Set API key and base URL under Administration → AI Settings."
        )
    url = f"{base}/chat/completions"
    temp = llm_temperature(product) if temperature is None else temperature
    tokens = llm_max_tokens(product) if max_tokens is None else max_tokens
    body = json.dumps(
        {
            "model": llm_model(product),
            "messages": messages,
            "temperature": temp,
            "max_tokens": tokens,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers=openai_request_headers(api_key, base),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120, context=_llm_ssl_context(product)) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"LLM request failed ({e.code}): {err_body}") from e
    except urllib.error.URLError as e:
        reason = str(e.reason or e)
        if "CERTIFICATE_VERIFY_FAILED" in reason or "certificate verify failed" in reason.lower():
            raise RuntimeError(
                "Could not reach LLM API: TLS certificate verification failed. "
                "Enable skip TLS under Administration → AI Settings for this product."
            ) from e
        raise RuntimeError(f"Could not reach LLM API: {reason}") from e
    try:
        return (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError("Unexpected LLM response format") from e


def iter_chat_completion_deltas(
    product: str,
    messages: list[dict[str, Any]],
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
    timeout: int = 300,
):
    from app.enterprise.ai_llm_stream import iter_chat_completion_deltas as _iter

    api_key = llm_api_key(product)
    base = llm_base_url(product)
    if not llm_is_configured(api_key=api_key, base_url=base):
        label = PRODUCT_LABELS.get(product, product)
        raise RuntimeError(
            f"{label} is not configured. Set API key and base URL under Administration → AI Settings."
        )
    temp = llm_temperature(product) if temperature is None else temperature
    tokens = llm_max_tokens(product) if max_tokens is None else max_tokens
    yield from _iter(
        messages,
        url=f"{base}/chat/completions",
        api_key=api_key,
        model=llm_model(product),
        temperature=temp,
        max_tokens=tokens,
        ssl_context=_llm_ssl_context(product),
        timeout=timeout,
    )
