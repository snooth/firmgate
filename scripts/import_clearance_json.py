#!/usr/bin/env python3
"""
Import security clearance records from a JSON backup into the server database.

Run on the production server (same .env / instance path as the live app):

  sudo /root/intranet/.venv/bin/python3 /root/intranet/scripts/import_clearance_json.py \\
    /root/intranet/instance/security_clearances_export.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import create_app
from app.intranet_bp import _normalize_security_clearance_records
from app.security_clearance_store import (
    count_clearance_records,
    import_clearance_records,
    replace_clearance_records,
    storage_diagnostics,
)


def main() -> int:
    p = argparse.ArgumentParser(description="Import clearance records from JSON backup")
    p.add_argument("json_file", type=Path, help="Backup JSON (export or admin backup format)")
    p.add_argument(
        "--merge",
        action="store_true",
        help="Upsert by CSID instead of replacing all rows",
    )
    args = p.parse_args()

    if not args.json_file.is_file():
        print(f"File not found: {args.json_file}", file=sys.stderr)
        return 1

    raw = json.loads(args.json_file.read_text(encoding="utf-8"))
    records = raw.get("records") if isinstance(raw, dict) else raw
    if not isinstance(records, list) or not records:
        print("JSON has no records array.", file=sys.stderr)
        return 1

    app = create_app()
    with app.app_context():
        print("Before:", storage_diagnostics())
        norm = _normalize_security_clearance_records(records)
        if not norm:
            print("No valid rows (each needs a CSID).", file=sys.stderr)
            return 1
        if args.merge:
            added, updated, sql_n = import_clearance_records(norm, merge_import=True)
            print(f"Merged: {added} added, {updated} updated, sql_count={sql_n}")
        else:
            n = replace_clearance_records(norm)
            print(f"Replaced table with {n} row(s).")
        print("After:", storage_diagnostics())
        sql_n = count_clearance_records()
        print("SQL count:", sql_n)
        return 0 if sql_n > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
