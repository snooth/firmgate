#!/usr/bin/env bash
# Build a .zip for Administration → Software version → Upgrade from package.
# Excludes runtime data (.env, instance/, .venv) and VCS metadata.
#
# Usage:
#   ./scripts/build_upgrade_package.sh
#   ./scripts/build_upgrade_package.sh /path/to/intranet-release.zip

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d)"
OUT="${1:-${ROOT}/intranet-upgrade-${STAMP}.zip}"

cd "$ROOT"
zip -r "$OUT" . \
  -x '.git/*' -x '*/.git/*' \
  -x 'instance/*' -x '*/instance/*' \
  -x '.venv/*' -x 'venv/*' -x '*/.venv/*' \
  -x '.env' -x '.env.*' \
  -x '__pycache__/*' -x '*/__pycache__/*' -x '*.pyc' \
  -x '.DS_Store' -x '*/.DS_Store' \
  -x 'intranet-upgrade-*.zip'

echo "Upgrade package: $OUT"
