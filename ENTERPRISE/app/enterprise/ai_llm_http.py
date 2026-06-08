"""HTTP helpers for OpenAI-compatible LLM APIs (OpenAI, Ollama, LM Studio, vLLM, etc.)."""

from __future__ import annotations

from urllib.parse import urlparse

_DEFAULT_OPENAI_BASE = "https://api.openai.com/v1"
_LOCAL_PLACEHOLDER_API_KEY = "ollama"

_LOCAL_HOSTS = frozenset(
    {
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
        "host.docker.internal",
    }
)


def _hostname(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower().strip("[]")
    except Exception:
        return ""


def is_local_llm_host(url: str) -> bool:
    host = _hostname(url)
    if not host:
        return False
    if host in _LOCAL_HOSTS:
        return True
    return host.endswith(".local") or host.endswith(".localhost")


def _path_has_v1(url: str) -> bool:
    try:
        path = (urlparse(url).path or "").rstrip("/")
    except Exception:
        return False
    return path == "/v1" or path.endswith("/v1")


def normalize_openai_base_url(url: str, *, default: str = _DEFAULT_OPENAI_BASE) -> str:
    """Ensure base URL works with paths like ``/chat/completions``."""
    u = (url or "").strip().rstrip("/")
    if not u:
        return default.rstrip("/")
    if _path_has_v1(u):
        return u
    # Azure OpenAI and similar deployment URLs include their own path prefix.
    lower = u.lower()
    if "openai.azure.com" in lower or "/deployments/" in lower:
        return u
    if is_local_llm_host(u) or lower.endswith("api.openai.com") or lower.endswith("openai.com"):
        return f"{u}/v1"
    return u


def effective_llm_api_key(api_key: str, base_url: str) -> str:
    key = (api_key or "").strip()
    if key:
        return key
    if is_local_llm_host(base_url):
        return _LOCAL_PLACEHOLDER_API_KEY
    return ""


def llm_is_configured(*, api_key: str, base_url: str) -> bool:
    if (api_key or "").strip():
        return True
    return is_local_llm_host(normalize_openai_base_url(base_url))


def openai_request_headers(api_key: str, base_url: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    key = effective_llm_api_key(api_key, base_url)
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers
