#!/usr/bin/env bash
#
# Release workflow: bump version → sync → build edition ZIPs → push full backup to Gitea.
#
# Usage:
#   ./scripts/release-and-backup.sh
#   ./scripts/release-and-backup.sh "Enterprise hotfix"
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '%s\n' "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

SUFFIX=""
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    --*) die "Unknown option: $arg" ;;
    *) SUFFIX="${SUFFIX:+$SUFFIX }$arg" ;;
  esac
done

[ -f "$ROOT/.solstak-backup.env" ] || [ -f "$ROOT/PRIVATE/.solstak-backup.env" ] || \
  die "Create .solstak-backup.env first (copy from .solstak-backup.env.example)"

NEW_VERSION="$(sh "$ROOT/scripts/intranet-bump-version.sh")"
log ">>> Version bumped to ${NEW_VERSION}"

"$ROOT/sync.sh"

export SOLSTAK_BACKUP_MESSAGE="Release ${NEW_VERSION}${SUFFIX:+ — ${SUFFIX}}"
"$ROOT/scripts/build_edition_packages.sh"

log ""
log "Release ${NEW_VERSION} built and backed up to Gitea."
