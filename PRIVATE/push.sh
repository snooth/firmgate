#!/usr/bin/env bash
# Convenience wrapper — same as upload.sh with a default commit message.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$REPO_ROOT/upload.sh" "$@"
