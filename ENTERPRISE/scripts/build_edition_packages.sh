#!/usr/bin/env bash
# Build Community and Enterprise upgrade ZIPs into PRIVATE/RELEASE/{COMMUNITY,ENTERPRISE}/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RELEASE_ROOT="${RELEASE_ROOT:-$ROOT/PRIVATE/RELEASE}"
COMMUNITY_DIR="$RELEASE_ROOT/COMMUNITY"
ENTERPRISE_DIR="$RELEASE_ROOT/ENTERPRISE"
mkdir -p "$COMMUNITY_DIR" "$ENTERPRISE_DIR"

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
DATE_TAG="$(date -u +%Y-%m-%d)"

if [ ! -d "$ROOT/PUBLIC/app" ]; then
  echo "PUBLIC/ missing — run ./sync.sh first." >&2
  exit 1
fi

build_zip() {
  local edition="$1"
  local source_dir="$2"
  local out_dir="$3"
  local zip_basename="$4"

  local staging
  staging="$(mktemp -d "${TMPDIR:-/tmp}/firmgate-${edition}.XXXXXX")"
  local pkg_root="$staging/firmgate"
  mkdir -p "$pkg_root"

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
    --exclude 'firmgate-premium-licensing/' \
    --exclude 'PRIVATE/' \
    --exclude 'PUBLIC/' \
    --exclude 'ENTERPRISE/' \
    "$source_dir/" "$pkg_root/"

  export PKG_ROOT="$pkg_root" VERSION edition DATE_TAG
  python3 - <<'PY'
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["PKG_ROOT"])
edition = os.environ["edition"]
manifest = {
    "tag": "firmgate-release-package",
    "edition": edition,
    "version": os.environ["VERSION"],
    "build_date": os.environ["DATE_TAG"],
    "created_at": datetime.now(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "includes": ["application source", "requirements.txt", "static assets", "templates", "Dockerfile", "docker-compose.yml"],
    "preserved_on_server": ["instance/", ".env", ".venv/"],
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

checks = {}
for rel in ("manifest.json", "requirements.txt", "version"):
    p = root / rel
    if p.is_file():
        checks[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
(root / "checksums.sha256.json").write_text(json.dumps(checks, indent=2) + "\n", encoding="utf-8")
PY

  local zip_name="${zip_basename}-${VERSION}-${STAMP}.zip"
  local zip_path="$out_dir/$zip_name"
  (
    cd "$staging"
    zip -r -q "$zip_path" firmgate
  )
  rm -rf "$staging"
  ln -sf "$(basename "$zip_path")" "$out_dir/package.zip"
  echo "$zip_path"
}

echo "Building Community Edition package from PUBLIC/ ..."
COMMUNITY_ZIP="$(build_zip community "$ROOT/PUBLIC" "$COMMUNITY_DIR" "community_package")"
echo "  → $COMMUNITY_ZIP"

echo "Building Enterprise Edition package from repo root ..."
ENTERPRISE_ZIP="$(build_zip enterprise "$ROOT" "$ENTERPRISE_DIR" "enterprise_package")"
echo "  → $ENTERPRISE_ZIP"

if [ ! -f "$RELEASE_ROOT/README.md" ]; then
  cat >"$RELEASE_ROOT/README.md" <<'EOF'
# Release packages (by edition)

| Folder | Contents |
|--------|----------|
| `COMMUNITY/` | Community Edition upgrade ZIPs (built from `PUBLIC/`) |
| `ENTERPRISE/` | Enterprise Edition upgrade ZIPs (full app from repo root) |

Built with `scripts/build_edition_packages.sh`. Upload via **Administration → Software version → Upgrade from package**.

Legacy combined builds may still appear under `PRIVATE/RELEASES/` from `scripts/build_release_package.sh`.
EOF
fi

echo ""
echo "Done."
echo "  Community:  $COMMUNITY_ZIP"
echo "  Enterprise: $ENTERPRISE_ZIP"
echo "  package.zip → COMMUNITY/ and ENTERPRISE/ (latest build)"

if [ "${SOLSTAK_BACKUP_AFTER_BUILD:-1}" != "0" ]; then
  if [ -f "$ROOT/.solstak-backup.env" ] || [ -f "$ROOT/PRIVATE/.solstak-backup.env" ]; then
    BACKUP_MSG="${SOLSTAK_BACKUP_MESSAGE:-Release packages ${VERSION} (${STAMP})}"
    echo ""
    echo ">>> Pushing full backup to Gitea..."
    "$ROOT/scripts/solstak-backup-push.sh" --no-sync "$BACKUP_MSG"
  else
    echo ""
    echo "NOTE: Skipping Gitea backup — create .solstak-backup.env (see .solstak-backup.env.example)."
  fi
fi
