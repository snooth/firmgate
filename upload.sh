#!/usr/bin/env bash
#
# Push local changes to the Git remote so servers can pull them (update.sh / git fetch).
#
# Usage:
#   ./upload.sh "Describe your changes"
#   ./upload.sh                    # prompts for a commit message
#   ./upload.sh --dry-run          # show what would be committed, no push
#
# Remote defaults match scripts/update.sh (origin → main).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# Do not pipe git output through less — otherwise the script stops at ":" and waits for a key.
export GIT_PAGER=cat

REMOTE="${GIT_REMOTE:-origin}"
BRANCH="${GIT_BRANCH:-main}"
DRY_RUN=0

log() { printf '%s\n' "$*"; }
step() { log ">>> $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

is_tty() { [ -t 0 ] && [ -t 1 ]; }

warn_large_staged_files() {
  local big=0 path sz
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    [ -f "$path" ] || continue
    sz="$(wc -c <"$path" 2>/dev/null | tr -d ' ')"
    if [ "${sz:-0}" -gt 52428800 ]; then
      log "  WARNING: large staged file (>50MB): $path"
      big=1
    fi
  done <<EOF
$(git diff --cached --name-only 2>/dev/null || true)
EOF
  [ "$big" -eq 0 ] || log "  Large files can make commit/push look frozen — consider Git LFS or .gitignore."
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    --*)
      die "Unknown option: $arg"
      ;;
  esac
done

# Commit message = all non-flag arguments joined.
MSG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) ;;
    *) MSG="${MSG:+$MSG }$arg" ;;
  esac
done

if [ -z "$MSG" ] && [ "$DRY_RUN" -eq 0 ]; then
  if is_tty; then
    printf 'Commit message: '
    read -r MSG
  else
    die "Commit message required when stdin is not a TTY (use: ./upload.sh \"your message\")"
  fi
fi
MSG="$(echo "$MSG" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
[ -n "$MSG" ] || die "Commit message required (or use: ./upload.sh \"your message\")"

[ -d .git ] || die "Not a git repository: $REPO_ROOT"

if [ -f .env ]; then
  if git check-ignore -q .env 2>/dev/null; then
    :
  else
    log "WARNING: .env is not gitignored — it will NOT be added (check .gitignore)."
  fi
fi

# Block accidental commit of runtime data.
for forbidden in instance .venv venv; do
  if git ls-files --error-unmatch "$forbidden" >/dev/null 2>&1; then
    die "$forbidden/ is tracked by git — remove it from the index before pushing."
  fi
done

CURRENT="$(git branch --show-current 2>/dev/null || echo "")"
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$BRANCH" ]; then
  log "NOTE: current branch is '$CURRENT'; pushing to ${REMOTE}/${BRANCH}."
  if is_tty; then
    read -r -p "Continue? [y/N] " ans
    case "$ans" in
      y|Y|yes|YES) ;;
      *) die "Aborted." ;;
    esac
  else
    die "Not on ${BRANCH} — checkout ${BRANCH} or run from a TTY to confirm."
  fi
fi

log ">>> Repository: $REPO_ROOT"
log ">>> Remote: ${REMOTE}  Branch: ${BRANCH}"
log ""

log ">>> Status before staging"
git status -sb
log ""

step "Staging all changes (respects .gitignore)"
if [ "$DRY_RUN" -eq 1 ]; then
  git add -A --dry-run
  log ""
  log "[dry-run] Would commit with message:"
  log "  $MSG"
  log "[dry-run] Would push to ${REMOTE} ${BRANCH}"
  exit 0
fi

git add -A

if git diff --cached --quiet; then
  log "Nothing to commit (working tree clean after staging)."
  step "Pushing anyway in case local commits are ahead of remote..."
else
  step "Staged changes:"
  git --no-pager diff --cached --stat
  warn_large_staged_files
  log ""
  step "Commit"
  git commit -m "$MSG"
fi

LOCAL_REV="$(git rev-parse --short HEAD)"
AHEAD="$(git rev-list --count "${REMOTE}/${BRANCH}..HEAD" 2>/dev/null || echo "?")"
log ""
step "Pushing ${LOCAL_REV} to ${REMOTE}/${BRANCH} (${AHEAD} commit(s) ahead)"
log "    (progress below — if this hangs, Git may be waiting for credentials or a slow network)"

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/lib/solstak-git-auth.sh" 2>/dev/null || true
if solstak_load_env "$REPO_ROOT" 2>/dev/null && solstak_has_password && [ "$REMOTE" = "$(solstak_remote_name)" ]; then
  if ! solstak_git_push "$REPO_ROOT"; then
    die "git push failed — check VPN/network and .solstak-backup.env credentials for ${REMOTE}"
  fi
elif ! git -c push.progress=true push --progress "${REMOTE}" "HEAD:${BRANCH}"; then
  die "git push failed — check VPN/network and credentials for ${REMOTE}"
fi

REMOTE_REV="$(git rev-parse --short "${REMOTE}/${BRANCH}" 2>/dev/null || echo "?")"
log ""
log "=========================================="
log " Upload complete."
log " Local:  ${LOCAL_REV}"
log " Remote: ${REMOTE_REV} (${REMOTE}/${BRANCH})"
log ""
log " On the server, deploy with:"
log "   cd /root && sudo /root/update.sh"
log "   # or: sudo /root/update.sh --full"
log "=========================================="
