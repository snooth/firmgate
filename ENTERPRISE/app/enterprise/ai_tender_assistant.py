"""AI Tender Assistant — analyse RFT, ATM, and RFQ documents for tender response work."""

from __future__ import annotations

import json
import logging
import uuid
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import current_app
from werkzeug.utils import secure_filename

from app.enterprise.ai_document_search import extract_text_from_bytes
from app.enterprise.ai_llm_settings import (
    PRODUCT_TENDER_ASSISTANT,
    iter_chat_completion_deltas,
    llm_api_key as _llm_api_key,
    llm_base_url as _llm_base_url,
    llm_configured as _llm_configured,
    llm_max_tokens as _llm_max_tokens,
    llm_model as _llm_model,
    llm_settings_public as _llm_settings_public,
    llm_temperature as _llm_temperature,
    _llm_ssl_context,
)

log = logging.getLogger(__name__)


def llm_configured() -> bool:
    return _llm_configured(PRODUCT_TENDER_ASSISTANT)


def llm_settings_public() -> dict[str, Any]:
    return _llm_settings_public(PRODUCT_TENDER_ASSISTANT)

_MAX_BYTES = 20 * 1024 * 1024
_MAX_DOCS = 12
_ALLOWED_SUFFIXES = frozenset({".pdf", ".docx", ".txt", ".md"})
_DOC_TYPES = frozenset({"rft", "atm", "rfq", "other"})
_DOC_TYPE_LABELS = {
    "rft": "RFT (Request for Tender)",
    "atm": "ATM (Approach to Market)",
    "rfq": "RFQ (Request for Quotation)",
    "other": "Other tender document",
}


def _user_dir(user_id: int) -> Path:
    root = Path(current_app.instance_path) / "ai_tender_assistant" / str(int(user_id))
    root.mkdir(parents=True, exist_ok=True)
    return root


def _meta_path(user_id: int) -> Path:
    return _user_dir(user_id) / "meta.json"


def _load_meta(user_id: int) -> dict[str, Any]:
    p = _meta_path(user_id)
    if not p.is_file():
        return {"documents": [], "analysis": None}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"documents": [], "analysis": None}
        docs = data.get("documents")
        if not isinstance(docs, list):
            data["documents"] = []
        return data
    except Exception:
        return {"documents": [], "analysis": None}


def _save_meta(user_id: int, meta: dict[str, Any]) -> None:
    _meta_path(user_id).write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _normalize_doc_type(value: str) -> str:
    t = str(value or "").strip().lower()
    return t if t in _DOC_TYPES else "other"


def _doc_record(meta: dict[str, Any], doc_id: str) -> dict[str, Any] | None:
    for d in meta.get("documents") or []:
        if isinstance(d, dict) and str(d.get("id")) == doc_id:
            return d
    return None


def _public_doc(rec: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": rec.get("id"),
        "name": rec.get("name") or "",
        "doc_type": rec.get("doc_type") or "other",
        "doc_type_label": _DOC_TYPE_LABELS.get(rec.get("doc_type") or "other", "Document"),
        "uploaded_at": rec.get("uploaded_at"),
        "size": rec.get("size"),
    }


def public_status(user_id: int) -> dict[str, Any]:
    meta = _load_meta(user_id)
    docs = [_public_doc(d) for d in (meta.get("documents") or []) if isinstance(d, dict)]
    analysis = meta.get("analysis")
    has_analysis = bool(analysis and isinstance(analysis, dict) and analysis.get("analyzed_at"))
    return {
        "documents": docs,
        "document_count": len(docs),
        "analysis": _public_analysis(analysis) if has_analysis else None,
        "llm": llm_settings_public(),
    }


def _public_analysis(analysis: dict[str, Any] | None) -> dict[str, Any]:
    if not analysis or not isinstance(analysis, dict):
        return {}
    return {
        "analyzed_at": analysis.get("analyzed_at"),
        "summary_markdown": analysis.get("summary_markdown") or "",
        "requirements": analysis.get("requirements") or [],
        "compliance_matrix": analysis.get("compliance_matrix") or [],
        "risks": analysis.get("risks") or [],
        "draft_responses": analysis.get("draft_responses") or [],
    }


def upload_document(user_id: int, filename: str, data: bytes, doc_type: str) -> dict[str, Any]:
    if len(data) > _MAX_BYTES:
        raise ValueError("File is too large (max 20 MB).")
    meta = _load_meta(user_id)
    docs = meta.get("documents") or []
    if len(docs) >= _MAX_DOCS:
        raise ValueError(f"Maximum {_MAX_DOCS} tender documents per workspace.")

    name = secure_filename(filename) or "tender.pdf"
    low = name.lower()
    if not any(low.endswith(s) for s in _ALLOWED_SUFFIXES):
        raise ValueError("Supported formats: PDF, Word (.docx), or plain text (.txt, .md).")

    doc_id = uuid.uuid4().hex[:12]
    stored = f"{doc_id}{Path(name).suffix.lower() or '.pdf'}"
    path = _user_dir(user_id) / stored
    path.write_bytes(data)

    rec = {
        "id": doc_id,
        "name": name,
        "stored": stored,
        "doc_type": _normalize_doc_type(doc_type),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "size": len(data),
    }
    docs.append(rec)
    meta["documents"] = docs
    _save_meta(user_id, meta)
    return _public_doc(rec)


def delete_document(user_id: int, doc_id: str) -> bool:
    meta = _load_meta(user_id)
    docs = meta.get("documents") or []
    kept: list[dict[str, Any]] = []
    removed = False
    for d in docs:
        if not isinstance(d, dict):
            continue
        if str(d.get("id")) == str(doc_id):
            removed = True
            stored = str(d.get("stored") or "")
            if stored:
                p = _user_dir(user_id) / stored
                try:
                    p.unlink(missing_ok=True)
                except OSError:
                    pass
            continue
        kept.append(d)
    if not removed:
        return False
    meta["documents"] = kept
    if meta.get("analysis"):
        meta["analysis"] = None
    _save_meta(user_id, meta)
    return True


def _collect_document_text(user_id: int) -> tuple[str, list[dict[str, str]]]:
    meta = _load_meta(user_id)
    parts: list[str] = []
    refs: list[dict[str, str]] = []
    for d in meta.get("documents") or []:
        if not isinstance(d, dict):
            continue
        stored = str(d.get("stored") or "")
        if not stored:
            continue
        path = _user_dir(user_id) / stored
        if not path.is_file():
            continue
        data = path.read_bytes()
        name = str(d.get("name") or stored)
        text = extract_text_from_bytes(name, data)
        if not text.strip():
            continue
        dtype = _normalize_doc_type(str(d.get("doc_type") or "other"))
        label = _DOC_TYPE_LABELS.get(dtype, dtype.upper())
        header = f"=== {label}: {name} ==="
        parts.append(f"{header}\n{text.strip()}")
        refs.append({"id": str(d.get("id")), "name": name, "doc_type": dtype})
    return "\n\n".join(parts), refs


def _chat_completion_json(messages: list[dict[str, str]], *, max_tokens: int | None = None) -> str:
    from app.enterprise.ai_llm_http import effective_llm_api_key, openai_request_headers

    api_key = _llm_api_key(PRODUCT_TENDER_ASSISTANT)
    base = _llm_base_url(PRODUCT_TENDER_ASSISTANT)
    if not effective_llm_api_key(api_key, base):
        raise RuntimeError(
            "AI Tender Assistant is not configured. Set API key and base URL under Administration → AI Settings → AI Tender Assistant."
        )
    url = f"{base}/chat/completions"

    def _request(body: dict) -> str:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers=openai_request_headers(api_key, base),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=240, context=_llm_ssl_context(PRODUCT_TENDER_ASSISTANT)) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        try:
            return (data["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError) as e:
            raise RuntimeError("Unexpected LLM response format") from e

    tokens = max_tokens if max_tokens is not None else _llm_max_tokens(PRODUCT_TENDER_ASSISTANT)
    base_body = {
        "model": _llm_model(PRODUCT_TENDER_ASSISTANT),
        "messages": messages,
        "temperature": _llm_temperature(PRODUCT_TENDER_ASSISTANT),
        "max_tokens": tokens,
    }
    try:
        return _request({**base_body, "response_format": {"type": "json_object"}})
    except urllib.error.HTTPError as e:
        if e.code in (400, 422):
            try:
                return _request(base_body)
            except urllib.error.HTTPError as e2:
                body_txt = e2.read().decode("utf-8", errors="replace")[:500]
                raise RuntimeError(f"LLM request failed ({e2.code}): {body_txt}") from e2
        body_txt = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"LLM request failed ({e.code}): {body_txt}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach LLM API: {e.reason}") from e


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _parse_analysis(raw: str) -> dict[str, Any]:
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        obj = {}
    if not isinstance(obj, dict):
        obj = {}

    requirements = []
    for i, row in enumerate(_as_list(obj.get("requirements"))):
        if not isinstance(row, dict):
            continue
        requirements.append(
            {
                "id": str(row.get("id") or f"R{i + 1}"),
                "text": str(row.get("text") or "").strip(),
                "section": str(row.get("section") or "").strip(),
                "priority": str(row.get("priority") or "must").strip().lower(),
                "source_ref": str(row.get("source_ref") or "").strip(),
            }
        )

    compliance_matrix = []
    for row in _as_list(obj.get("compliance_matrix")):
        if not isinstance(row, dict):
            continue
        compliance_matrix.append(
            {
                "requirement_id": str(row.get("requirement_id") or ""),
                "requirement": str(row.get("requirement") or "").strip(),
                "response_location": str(row.get("response_location") or "").strip(),
                "compliant": str(row.get("compliant") or "tbd").strip().lower(),
                "evidence_notes": str(row.get("evidence_notes") or "").strip(),
            }
        )

    risks = []
    for row in _as_list(obj.get("risks")):
        if not isinstance(row, dict):
            continue
        risks.append(
            {
                "title": str(row.get("title") or "").strip(),
                "severity": str(row.get("severity") or "medium").strip().lower(),
                "description": str(row.get("description") or "").strip(),
                "mitigation": str(row.get("mitigation") or "").strip(),
            }
        )

    draft_responses = []
    for row in _as_list(obj.get("draft_responses")):
        if not isinstance(row, dict):
            continue
        draft_responses.append(
            {
                "section": str(row.get("section") or "").strip(),
                "question_or_ref": str(row.get("question_or_ref") or "").strip(),
                "draft": str(row.get("draft") or "").strip(),
            }
        )

    summary = str(obj.get("summary_markdown") or "").strip()
    return {
        "requirements": requirements,
        "compliance_matrix": compliance_matrix,
        "risks": risks,
        "draft_responses": draft_responses,
        "summary_markdown": summary,
    }


def build_tender_analysis_messages(
    user_id: int, *, extra_instructions: str = ""
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    if not llm_configured():
        raise RuntimeError(
            "AI is not configured. Set the API key under Administration → AI Settings → Document Search."
        )
    combined, refs = _collect_document_text(user_id)
    if not combined.strip():
        raise ValueError("Upload at least one tender document (RFT, ATM, or RFQ) with readable text.")

    doc_list = "\n".join(
        f"- {r['name']} ({_DOC_TYPE_LABELS.get(r['doc_type'], r['doc_type'])})" for r in refs
    )
    instr = (extra_instructions or "").strip()
    prompt = (
        "You are an expert bid manager analysing Australian/NZ government and commercial tenders.\n\n"
        f"DOCUMENTS PROVIDED:\n{doc_list}\n\n"
        f"TENDER TEXT (may be truncated):\n{combined[:48000]}\n\n"
    )
    if instr:
        prompt += f"ADDITIONAL INSTRUCTIONS:\n{instr}\n\n"
    prompt += (
        "Analyse the tender pack and return JSON only with this structure:\n"
        "{\n"
        '  "summary_markdown": "Executive summary in markdown",\n'
        '  "requirements": [{"id":"R1","text":"...","section":"...","priority":"must|should|may","source_ref":"doc clause"}], ...],\n'
        '  "compliance_matrix": [{"requirement_id":"R1","requirement":"...","response_location":"Section X","compliant":"yes|partial|no|tbd","evidence_notes":"..."}], ...],\n'
        '  "risks": [{"title":"...","severity":"high|medium|low","description":"...","mitigation":"..."}], ...],\n'
        '  "draft_responses": [{"section":"...","question_or_ref":"...","draft":"Suggested response text"}], ...]\n'
        "}\n"
        "Extract concrete, actionable requirements. Build a compliance matrix aligned to those requirement IDs. "
        "Identify bid risks (legal, commercial, resourcing, timeline, compliance). "
        "Draft response text placeholders the bidder can refine — do not invent company-specific facts. "
        "Be thorough but concise."
    )
    messages = [
        {
            "role": "system",
            "content": "You analyse tender documents for proposal teams. Output valid JSON only.",
        },
        {"role": "user", "content": prompt},
    ]
    return messages, refs


def iter_tender_analysis_deltas(messages: list[dict[str, str]]):
    return iter_chat_completion_deltas(PRODUCT_TENDER_ASSISTANT, messages, timeout=360)


def finalize_tender_analysis(user_id: int, raw: str, refs: list[dict[str, str]]) -> dict[str, Any]:
    parsed = _parse_analysis(raw)
    parsed["analyzed_at"] = datetime.now(timezone.utc).isoformat()
    parsed["document_refs"] = refs

    meta = _load_meta(user_id)
    meta["analysis"] = parsed
    _save_meta(user_id, meta)

    return {
        "analysis": _public_analysis(parsed),
        "analyzed_at": parsed["analyzed_at"],
    }


def analyze_tender(user_id: int, *, extra_instructions: str = "") -> dict[str, Any]:
    messages, refs = build_tender_analysis_messages(user_id, extra_instructions=extra_instructions)
    raw = _chat_completion_json(messages)
    return finalize_tender_analysis(user_id, raw, refs)
