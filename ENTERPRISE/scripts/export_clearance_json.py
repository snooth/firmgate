#!/usr/bin/env python3
"""Export security clearance records to a JSON backup file."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import create_app
from app.intranet_bp import _normalize_security_clearance_records
from app.security_clearance_store import load_clearance_records, storage_diagnostics


def main() -> int:
    p = argparse.ArgumentParser(description="Export clearance records to JSON")
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        default=ROOT / "instance" / "security_clearances_export.json",
        help="Output file path",
    )
    args = p.parse_args()

    app = create_app()
    with app.app_context():
        diag = storage_diagnostics()
        rows = _normalize_security_clearance_records(load_clearance_records())
        if not rows:
            print("No records to export.", file=sys.stderr)
            print(diag, file=sys.stderr)
            return 1
        payload = {
            "version": 1,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "record_count": len(rows),
            "records": rows,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Exported {len(rows)} record(s) to {args.output}")
        print(f"Database: {diag.get('database_path')}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
