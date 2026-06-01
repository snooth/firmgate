#!/usr/bin/env bash
# Build a self-contained release ZIP for Administration → Software version → Upgrade from package.
# Includes application source and requirements.txt; server keeps instance/, .env, and .venv on upgrade.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${1:-$ROOT/dist}"
mkdir -p "$OUT_DIR"

VERSION=""
if command -v git >/dev/null 2>&1 && [ -d "$ROOT/.git" ]; then
  VERSION="$(git describe --tags --always 2>/dev/null | sed 's/-dirty$//' || true)"
fi
if [ -z "$VERSION" ]; then
  if [ -f "$ROOT/version" ]; then
    VERSION="$(tr -d '[:space:]' < "$ROOT/version")"
  fi
fi
if [ -z "$VERSION" ]; then
  VERSION="dev-$(date -u +%Y%m%d%H%M%S)"
fi

STAMP="$(date -u +%Y%m%d-%H%M%S)"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/firmgate-pkg.XXXXXX")"
PKG_ROOT="$STAGING/firmgate"
mkdir -p "$PKG_ROOT"

rsync -a \
  --exclude '.git/' \
  --exclude '.githooks/' \
  --exclude '.venv/' \
  --exclude 'venv/' \
  --exclude 'instance/' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude '.DS_Store' \
  --exclude 'dist/' \
  --exclude '.cursor/' \
  --exclude '.*.bkp' \
  --exclude '.agent-transcripts/' \
  "$ROOT/" "$PKG_ROOT/"

export PKG_ROOT VERSION
python3 - <<'PY'
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["PKG_ROOT"])
manifest = {
    "tag": "firmgate-release-package",
    "version": os.environ["VERSION"],
    "created_at": datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "includes": ["application source", "requirements.txt", "static assets", "templates", "Dockerfile", "docker-compose.yml"],
    "preserved_on_server": ["instance/", ".env", ".venv/"],
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

# SHA-256 checksums for manifest.json and requirements.txt (enterprise / air-gap verification).
checks = {}
for rel in ("manifest.json", "requirements.txt", "version"):
    p = root / rel
    if p.is_file():
        checks[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
(root / "checksums.sha256.json").write_text(json.dumps(checks, indent=2) + "\n", encoding="utf-8")
PY

ZIP_NAME="firmgate-release-${VERSION}-${STAMP}.zip"
ZIP_PATH="$OUT_DIR/$ZIP_NAME"
(
  cd "$STAGING"
  zip -r -q "$ZIP_PATH" firmgate
)

rm -rf "$STAGING"
echo "Built: $ZIP_PATH"
echo "Upload via Administration → Software version → Upgrade from package (when package upgrades are enabled)."
