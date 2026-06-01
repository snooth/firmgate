#!/usr/bin/env python3
"""Print security clearance record counts (run on server: sudo /root/intranet/.venv/bin/python3 scripts/check_clearance_records.py)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import create_app
from app.security_clearance_store import (
    _read_legacy_json_file,
    _records_file_path,
    count_clearance_records,
    load_clearance_records,
    storage_diagnostics,
)


def main() -> int:
    app = create_app()
    with app.app_context():
        diag = storage_diagnostics()
        n = count_clearance_records()
        print("Security clearance storage")
        print("-" * 40)
        for k, v in diag.items():
            print(f"  {k}: {v}")
        print(f"\nSQL rows: {n}")
        if n:
            rows = load_clearance_records()
            print(f"Sample CSIDs: {[r.get('csid') for r in rows[:5]]}")
        snap = _read_legacy_json_file()
        print(f"JSON snapshot: {len(snap) if isinstance(snap, list) else 0} rows at {_records_file_path()}")
        print()
        print("Note: This checks the database on THIS machine only.")
        print("  Your browser must use the same app instance (e.g. local Flask) to see these rows.")
        print("  On a remote server, point DATABASE_URL at that host's instance DB and run this script there too.")
        return 0 if n > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
