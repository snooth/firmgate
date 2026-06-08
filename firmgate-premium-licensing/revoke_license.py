#!/usr/bin/env python3
"""Record revoked enterprise license keys (vendor ledger).

Updates revoked_licenses.json in this folder. Import the same entries on each
customer server (see README).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

_TOOL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_TOOL_DIR))

import license_signing  # noqa: E402
from license_ledger import (  # noqa: E402
    REVOKE_FILE,
    list_all_licenses,
    load_revoked_entries,
    save_revoked_entries,
)

from app.premium_license import license_key_fingerprint, verify_license_key_crypto  # noqa: E402


def _load_entries() -> list[dict]:
    return load_revoked_entries()


def _save_entries(entries: list[dict]) -> None:
    save_revoked_entries(entries)


def _normalize_fp(fp: str) -> str:
    s = (fp or "").strip().lower()
    if len(s) != 16 or any(c not in "0123456789abcdef" for c in s):
        raise ValueError("Fingerprint must be 16 hexadecimal characters.")
    return s


def _append_entry(
    *,
    fingerprint: str,
    subject: str = "",
    expires_at: str | None = None,
    reason: str = "",
) -> bool:
    fp = _normalize_fp(fingerprint)
    entries = _load_entries()
    for item in entries:
        if str(item.get("fingerprint") or "").lower() == fp:
            return False
    entries.append(
        {
            "fingerprint": fp,
            "subject": (subject or "")[:200],
            "expires_at": expires_at,
            "revoked_at": datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "reason": (reason or "")[:500],
        }
    )
    _save_entries(entries)
    return True


def _entry_from_key(key: str, reason: str) -> dict:
    fp = license_key_fingerprint(key)
    if not fp:
        raise ValueError("License key must be a valid FG2 key string.")
    state, err = verify_license_key_crypto(key)
    subject = ""
    expires_at = None
    if state:
        subject = str(state.get("subject") or "")
        expires_at = state.get("expires_at")
    elif err:
        print(f"Warning: key did not verify ({err}); recording fingerprint only.", file=sys.stderr)
    return {
        "fingerprint": fp,
        "subject": subject,
        "expires_at": expires_at,
        "reason": reason,
    }


def main() -> int:
    p = argparse.ArgumentParser(description="Record a revoked Firmgate enterprise license (vendor ledger).")
    p.add_argument("--key", help="Full FG2 license key to revoke")
    p.add_argument("--fingerprint", help="16-character key fingerprint (if key string unavailable)")
    p.add_argument("--subject", default="", help="Organisation label (with --fingerprint)")
    p.add_argument("--expires", metavar="YYYY-MM-DD", help="Original expiry (with --fingerprint)")
    p.add_argument("--reason", default="", help="Optional revocation reason (internal)")
    p.add_argument("--list", action="store_true", help="List revoked entries only")
    p.add_argument(
        "--list-all",
        action="store_true",
        help="List all licenses (issued and revoked) from the vendor ledger",
    )
    p.add_argument(
        "--print-import",
        action="store_true",
        help="Print JSON suitable for Administration API import_revoked",
    )
    args = p.parse_args()

    if args.list_all:
        rows = list_all_licenses()
        if not rows:
            print("No licenses in the vendor ledger.")
            return 0
        for row in rows:
            fp = row.get("fingerprint") or ""
            sub = row.get("subject") or "(no subject)"
            exp = row.get("expires_at") or "—"
            status = row.get("status") or "?"
            feats = ", ".join(row.get("features") or []) or "—"
            issued = row.get("issued_at") or "—"
            line = f"{fp}  {status:8}  {sub}  exp={exp}  features=[{feats}]  issued={issued}"
            if status == "revoked" and row.get("revoked_at"):
                line += f"  revoked={row.get('revoked_at')}"
            print(line)
        print(f"\n{len(rows)} license(s) total.")
        return 0

    if args.list:
        entries = _load_entries()
        if not entries:
            print("No revoked licenses recorded.")
            print("Tip: use --list-all to see issued licenses from issued_licenses.json.")
            return 0
        for item in entries:
            fp = item.get("fingerprint") or ""
            sub = item.get("subject") or ""
            print(f"{fp}  {sub or '(no subject)'}  revoked={item.get('revoked_at') or ''}")
        return 0

    if args.print_import:
        entries = _load_entries()
        print(json.dumps({"import_revoked": entries}, indent=2))
        return 0

    if not args.key and not args.fingerprint:
        p.error("Specify --key, --fingerprint, --list, --list-all, or --print-import.")
        return 2

    if args.key:
        meta = _entry_from_key(args.key.strip(), args.reason)
        added = _append_entry(**meta)
        fp = meta["fingerprint"]
    else:
        fp = _normalize_fp(args.fingerprint)
        added = _append_entry(
            fingerprint=fp,
            subject=args.subject,
            expires_at=args.expires,
            reason=args.reason,
        )

    if not added:
        print(f"Fingerprint {fp} is already in {REVOKE_FILE.name}.")
        return 0

    print(f"Recorded revocation: fingerprint {fp}")
    print(f"Vendor ledger: {REVOKE_FILE}")
    print()
    print("On the customer server, either:")
    print("  • Administration → Enterprise Features → Revoke license (if still active), or")
    print("  • PUT /admin/api/settings/premium-license with import_revoked (see README).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
