"""Vendor license ledgers (issued + revoked) — private folder only."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

_TOOL_DIR = Path(__file__).resolve().parent
ISSUED_FILE = _TOOL_DIR / "issued_licenses.json"
REVOKE_FILE = _TOOL_DIR / "revoked_licenses.json"


def _read_entries(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid {path.name}: {exc}") from exc
    entries = data.get("entries")
    return entries if isinstance(entries, list) else []


def _write_entries(path: Path, entries: list[dict]) -> None:
    path.write_text(
        json.dumps({"entries": entries}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def load_issued_entries() -> list[dict]:
    return _read_entries(ISSUED_FILE)


def get_issued_entry(fingerprint: str) -> dict | None:
    fp = (fingerprint or "").strip().lower()
    if len(fp) != 16:
        return None
    for item in load_issued_entries():
        if str(item.get("fingerprint") or "").strip().lower() == fp:
            return dict(item)
    return None


def load_revoked_entries() -> list[dict]:
    return _read_entries(REVOKE_FILE)


def save_revoked_entries(entries: list[dict]) -> None:
    _write_entries(REVOKE_FILE, entries)


def record_issued_license(
    *,
    fingerprint: str,
    features: list[str],
    expires_at: str | None = None,
    subject: str = "",
    license_key: str | None = None,
) -> bool:
    fp = fingerprint.strip().lower()
    if len(fp) != 16:
        raise ValueError("Invalid license fingerprint.")
    entries = load_issued_entries()
    for item in entries:
        if str(item.get("fingerprint") or "").lower() == fp:
            return False
    entries.append(
        {
            "fingerprint": fp,
            "subject": (subject or "").strip()[:200],
            "expires_at": expires_at,
            "features": sorted({str(f).strip() for f in features if str(f).strip()}),
            "issued_at": datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "license_key": (license_key or "").strip(),
        }
    )
    _write_entries(ISSUED_FILE, entries)
    return True


def update_issued_license_key(*, fingerprint: str, license_key: str) -> bool:
    """Persist the full FG2 key string on an existing issued ledger row."""
    fp = (fingerprint or "").strip().lower()
    key = (license_key or "").strip()
    if len(fp) != 16 or not key:
        return False
    entries = load_issued_entries()
    updated = False
    for item in entries:
        if str(item.get("fingerprint") or "").strip().lower() != fp:
            continue
        item["license_key"] = key
        updated = True
        break
    if not updated:
        return False
    _write_entries(ISSUED_FILE, entries)
    return True


def list_all_licenses() -> list[dict]:
    """Merge issued ledger with revocation status."""
    revoked_fps = {str(e.get("fingerprint") or "").lower() for e in load_revoked_entries()}
    revoked_by_fp = {
        str(e.get("fingerprint") or "").lower(): e for e in load_revoked_entries()
    }
    seen: set[str] = set()
    rows: list[dict] = []

    for item in load_issued_entries():
        fp = str(item.get("fingerprint") or "").lower()
        if not fp or fp in seen:
            continue
        seen.add(fp)
        rev = revoked_by_fp.get(fp)
        rows.append(
            {
                "fingerprint": fp,
                "subject": item.get("subject") or "",
                "expires_at": item.get("expires_at"),
                "features": item.get("features") or [],
                "issued_at": item.get("issued_at"),
                "license_key": item.get("license_key"),
                "status": "revoked" if fp in revoked_fps else "active",
                "revoked_at": rev.get("revoked_at") if rev else None,
                "revoke_reason": rev.get("reason") if rev else "",
            }
        )

    for item in load_revoked_entries():
        fp = str(item.get("fingerprint") or "").lower()
        if not fp or fp in seen:
            continue
        seen.add(fp)
        rows.append(
            {
                "fingerprint": fp,
                "subject": item.get("subject") or "",
                "expires_at": item.get("expires_at"),
                "features": [],
                "issued_at": None,
                "status": "revoked",
                "revoked_at": item.get("revoked_at"),
                "revoke_reason": item.get("reason") or "",
            }
        )

    rows.sort(key=lambda r: (r.get("issued_at") or "", r.get("fingerprint") or ""), reverse=True)
    return rows


def recover_license_key_for_entry(entry: dict) -> str | None:
    """Re-sign from ledger metadata when the FG2 string was never stored."""
    from license_signing import sign_license_key

    from app.premium_license import license_key_fingerprint

    expected_fp = str(entry.get("fingerprint") or "").strip().lower()
    if len(expected_fp) != 16:
        return None
    feats = entry.get("features") if isinstance(entry.get("features"), list) else []
    feats = [str(f).strip() for f in feats if str(f).strip()]
    if not feats:
        return None
    expires = entry.get("expires_at")
    expires_s = str(expires).strip() if expires else None
    subject = str(entry.get("subject") or "").strip()
    try:
        key = sign_license_key(features=feats, expires=expires_s, subject=subject)
    except Exception:
        return None
    if license_key_fingerprint(key) != expected_fp:
        return None
    return key


def resolve_license_key(
    fingerprint: str,
    *,
    persist_recovered: bool = True,
) -> tuple[str | None, str]:
    """Return (license_key, source) where source is stored|recovered|missing."""
    entry = get_issued_entry(fingerprint)
    if not entry:
        return None, "missing"
    stored = str(entry.get("license_key") or "").strip()
    if stored:
        return stored, "stored"
    recovered = recover_license_key_for_entry(entry)
    if not recovered:
        return None, "missing"
    if persist_recovered:
        update_issued_license_key(fingerprint=fingerprint, license_key=recovered)
    return recovered, "recovered"


def delete_issued_license(*, fingerprint: str) -> bool:
    """Remove an issued license entry from issued_licenses.json (vendor tooling only)."""
    fp = (fingerprint or "").strip().lower()
    if len(fp) != 16:
        raise ValueError("Invalid license fingerprint.")
    entries = load_issued_entries()
    before = len(entries)
    entries = [e for e in entries if str(e.get("fingerprint") or "").strip().lower() != fp]
    if len(entries) == before:
        return False
    _write_entries(ISSUED_FILE, entries)
    return True


def delete_revoked_license(*, fingerprint: str) -> bool:
    """Remove a revoked entry from revoked_licenses.json (vendor tooling only)."""
    fp = (fingerprint or "").strip().lower()
    if len(fp) != 16:
        raise ValueError("Invalid license fingerprint.")
    entries = load_revoked_entries()
    before = len(entries)
    entries = [e for e in entries if str(e.get("fingerprint") or "").strip().lower() != fp]
    if len(entries) == before:
        return False
    _write_entries(REVOKE_FILE, entries)
    return True
