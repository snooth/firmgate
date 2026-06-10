#!/usr/bin/env bash
#
# Push a full workspace backup to SolStak Gitea (origin).
#
# Includes normally gitignored paths: PRIVATE/, release ZIPs, licensing tooling,
# ENTERPRISE/, PUBLIC/ snapshots. Still excludes instance/, .venv/, and raw .env
# at repo root (PRIVATE/.env snapshot from sync is included under PRIVATE/).
#
# Requires .solstak-backup.env (copy from .solstak-backup.env.example).
#
# Usage:
#   ./scripts/solstak-backup-push.sh "Release v2.45"
#   ./scripts/solstak-backup-push.sh --dry-run
#   ./scripts/solstak-backup-push.sh --no-sync
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/lib/solstak-git-auth.sh"

DRY_RUN=0
RUN_SYNC=1
MSG=""

log() { printf '%s\n' "$*"; }
step() { log ">>> $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-sync) RUN_SYNC=0 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    --*) die "Unknown option: $arg" ;;
    *) MSG="${MSG:+$MSG }$arg" ;;
  esac
done

if ! solstak_load_env "$ROOT"; then
  die "Missing .solstak-backup.env — copy .solstak-backup.env.example and set SOLSTAK_GIT_PASSWORD"
fi
if ! solstak_has_password; then
  die "SOLSTAK_GIT_PASSWORD is empty in .solstak-backup.env"
fi

[ -d .git ] || die "Not a git repository: $ROOT"

REMOTE="$(solstak_remote_name)"
BRANCH="$(solstak_branch_name)"
URL="$(solstak_remote_url)"

if [ "$RUN_SYNC" -eq 1 ]; then
  step "Syncing PUBLIC/, ENTERPRISE/, PRIVATE/"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] Would run: ./sync.sh"
  else
    "$ROOT/sync.sh"
  fi
fi

VERSION=""
if [ -f "$ROOT/version" ]; then
  VERSION="$(tr -d '[:space:]' < "$ROOT/version")"
fi
if [ -z "$MSG" ]; then
  MSG="Backup ${VERSION:-$(date -u +%Y-%m-%d)}"
fi

step "Repository: $ROOT"
step "Remote: ${REMOTE} (${URL})  Branch: ${BRANCH}"
log ""

if [ "$DRY_RUN" -eq 1 ]; then
  log "[dry-run] Would stage tracked files + force-add backup paths"
  log "[dry-run] Commit message: $MSG"
  log "[dry-run] Would push to ${REMOTE}/${BRANCH}"
  exit 0
fi

step "Staging tracked files"
git add -A

step "Force-adding private / release backup paths"
_backup_paths=(
  PRIVATE
  firmgate-premium-licensing
  ENTERPRISE
  PUBLIC
  dist
)
for rel in "${_backup_paths[@]}"; do
  if [ -e "$rel" ]; then
    git add -f "$rel"
  fi
done

# Release archives are gitignored by pattern — add explicitly when present.
if [ -d "$ROOT/PRIVATE/RELEASE" ]; then
  find "$ROOT/PRIVATE/RELEASE" -type f \( -name '*.zip' -o -name 'package.zip' \) -print0 2>/dev/null \
    | xargs -0 git add -f 2>/dev/null || true
fi
if [ -d "$ROOT/PRIVATE/RELEASES" ]; then
  find "$ROOT/PRIVATE/RELEASES" -type f -name '*.zip' -print0 2>/dev/null \
    | xargs -0 git add -f 2>/dev/null || true
fi

for forbidden in instance .venv venv .env .solstak-backup.env; do
  if git diff --cached --name-only | grep -qx "$forbidden" \
    || git diff --cached --name-only | grep -q "^${forbidden}$" \
    || git diff --cached --name-only | grep -q "/${forbidden}$"; then
    die "$forbidden must not be included in backup — check staging."
  fi
done

if git diff --cached --quiet; then
  log "Nothing to commit (working tree clean after staging)."
  step "Pushing anyway in case local commits are ahead of remote..."
else
  step "Staged changes:"
  git --no-pager diff --cached --stat
  log ""
  step "Commit"
  git commit -m "$MSG"
fi

LOCAL_REV="$(git rev-parse --short HEAD)"
step "Pushing ${LOCAL_REV} to ${REMOTE}/${BRANCH}"
if ! solstak_git_push "$ROOT"; then
  die "git push failed — check VPN/network and .solstak-backup.env credentials"
fi

REMOTE_REV="$(git rev-parse --short "${REMOTE}/${BRANCH}" 2>/dev/null || echo "?")"
log ""
log "=========================================="
log " SolStak backup push complete."
log " URL:    ${URL%.git}"
log " Local:  ${LOCAL_REV}"
log " Remote: ${REMOTE_REV} (${REMOTE}/${BRANCH})"
log "=========================================="
