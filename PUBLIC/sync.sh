#!/usr/bin/env bash
# Rebuild ENTERPRISE/, PUBLIC/, and PRIVATE/ from the repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/scripts/sync-public-private.sh" "$@"
