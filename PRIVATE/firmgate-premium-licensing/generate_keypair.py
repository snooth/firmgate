#!/usr/bin/env python3
"""Generate Ed25519 vendor keypair (private PEM here, public key in app/)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import license_signing  # noqa: E402
from license_signing import generate_keypair_files  # noqa: E402


def main() -> int:
    priv, pub = generate_keypair_files()
    print("Created vendor signing keypair:")
    print(f"  Private (NEVER commit): {priv}")
    print(f"  Public (ship with app):  {pub}")
    print()
    print("Restart the app after updating the public key, then run ./generate_license.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
