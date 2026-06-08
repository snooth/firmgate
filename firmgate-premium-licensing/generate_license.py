#!/usr/bin/env python3
"""Generate Firmgate enterprise license keys (FG2 — Ed25519)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_TOOL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_TOOL_DIR))

import license_signing  # noqa: E402  # sets repo root on sys.path
from license_ledger import list_all_licenses, record_issued_license  # noqa: E402
from license_signing import sign_license_key  # noqa: E402

from app.premium_license import ALL_FEATURES, FEATURE_LABELS, license_key_fingerprint  # noqa: E402


def _print_license_list() -> int:
    rows = list_all_licenses()
    if not rows:
        print("No licenses in the vendor ledger (issued_licenses.json / revoked_licenses.json).")
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


def main() -> int:
    p = argparse.ArgumentParser(description="Sign a Firmgate enterprise license key (FG2).")
    p.add_argument(
        "--feature",
        action="append",
        dest="features",
        choices=sorted(ALL_FEATURES),
        help="Enterprise feature id (repeatable)",
    )
    p.add_argument("--all", action="store_true", help="Include all enterprise features")
    p.add_argument(
        "--ai",
        action="store_true",
        help="Include all AI enterprise features (ai_document_search, ai_chatbot, ai_policy_assistant, ai_cv_builder, ai_tender_assistant)",
    )
    p.add_argument(
        "--enterprise",
        action="store_true",
        help="Include enterprise intranet modules (enterprise_intranet: CRM, Resource Pool, Security Clearance)",
    )
    p.add_argument("--expires", metavar="YYYY-MM-DD", help="Optional expiry date (YYYY-MM-DD)")
    p.add_argument("--subject", default="", help="Optional organisation label")
    p.add_argument(
        "--list-all",
        action="store_true",
        help="List all licenses in the vendor ledger (issued and revoked)",
    )
    args = p.parse_args()

    if args.list_all:
        return _print_license_list()

    if args.all:
        feats = list(ALL_FEATURES)
    elif args.ai:
        from app.premium_license import AI_ENTERPRISE_FEATURES

        feats = sorted(AI_ENTERPRISE_FEATURES)
    elif args.enterprise:
        from app.premium_license import FEATURE_ENTERPRISE_INTRANET

        feats = [FEATURE_ENTERPRISE_INTRANET]
    else:
        feats = args.features or []
    if not feats:
        p.error("Specify --all, --ai, --enterprise, or one or more --feature options.")
        return 2

    key = sign_license_key(features=feats, expires=args.expires, subject=args.subject)
    fp = license_key_fingerprint(key)
    if fp:
        record_issued_license(
            fingerprint=fp,
            features=feats,
            expires_at=args.expires,
            subject=args.subject,
        )
    print("Enterprise features:")
    for f in sorted(set(feats)):
        print(f"  - {FEATURE_LABELS.get(f, f)} ({f})")
    if args.expires:
        print(f"Expires: {args.expires}")
    if args.subject:
        print(f"Subject: {args.subject}")
    print()
    print(key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
