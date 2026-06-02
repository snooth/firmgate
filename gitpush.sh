#!/usr/bin/env bash
#
# Stage, commit, and push to the public GitHub repository.
#
# Usage:
#   ./gitpush.sh "Describe your changes"
#   ./gitpush.sh                    # prompts for a commit message
#   ./gitpush.sh --dry-run          # show what would be committed, no push
#   ./gitpush.sh --everything "Fresh public tree"
#       Nuclear option: one new commit with the full PUBLIC/ tree, force-push
#       (replaces remote branch history; files only in the new tree remain on main)
#
# Default remote: github → https://github.com/snooth/firmgate.git
# Default branch: main
#
# Your existing origin remote is left unchanged (e.g. internal mirror).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Prefer monorepo root when running ./PUBLIC/gitpush.sh (not the PUBLIC/ export folder alone).
if [ -x "$SCRIPT_DIR/../scripts/sync-public-private.sh" ] && [ -f "$SCRIPT_DIR/../app/__init__.py" ]; then
  WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -x "$SCRIPT_DIR/scripts/sync-public-private.sh" ]; then
  WORKSPACE_ROOT="$SCRIPT_DIR"
else
  echo "ERROR: Cannot find scripts/sync-public-private.sh (run from repo root or PUBLIC/)." >&2
  exit 1
fi
# Always refresh PUBLIC/ before pushing to GitHub.
"$WORKSPACE_ROOT/scripts/sync-public-private.sh"
REPO_ROOT="$WORKSPACE_ROOT/PUBLIC"
cd "$REPO_ROOT"

export GIT_PAGER=cat

GITHUB_URL="${GITHUB_URL:-https://github.com/snooth/firmgate.git}"
REMOTE="${GITHUB_REMOTE:-github}"
BRANCH="${GIT_BRANCH:-main}"
DRY_RUN=0
EVERYTHING=0

log() { printf '%s\n' "$*"; }
step() { log ">>> $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

is_tty() { [ -t 0 ] && [ -t 1 ]; }

ensure_github_remote() {
  if git remote get-url "$REMOTE" >/dev/null 2>&1; then
    local current
    current="$(git remote get-url "$REMOTE")"
    if [ "$current" != "$GITHUB_URL" ]; then
      step "Updating ${REMOTE} URL → ${GITHUB_URL}"
      if [ "$DRY_RUN" -eq 1 ]; then
        log "[dry-run] Would run: git remote set-url ${REMOTE} ${GITHUB_URL}"
      else
        git remote set-url "$REMOTE" "$GITHUB_URL"
      fi
    fi
  else
    step "Adding remote ${REMOTE} → ${GITHUB_URL}"
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] Would run: git remote add ${REMOTE} ${GITHUB_URL}"
    else
      git remote add "$REMOTE" "$GITHUB_URL"
    fi
  fi
}

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
    --everything) EVERYTHING=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    --*)
      die "Unknown option: $arg (try --help)"
      ;;
  esac
done

MSG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run|--everything) ;;
    *) MSG="${MSG:+$MSG }$arg" ;;
  esac
done

if [ -z "$MSG" ] && [ "$DRY_RUN" -eq 0 ]; then
  if is_tty; then
    printf 'Commit message: '
    read -r MSG
  else
    die "Commit message required when stdin is not a TTY (use: ./gitpush.sh \"your message\")"
  fi
fi
MSG="$(echo "$MSG" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
[ -n "$MSG" ] || die "Commit message required (or use: ./gitpush.sh \"your message\")"

if [ ! -d .git ]; then
  step "Initializing git repository in PUBLIC/"
  git init -b "$BRANCH"
  ensure_github_remote
fi

if [ -f .env ]; then
  if git check-ignore -q .env 2>/dev/null; then
    :
  else
    log "WARNING: .env is not gitignored — it will NOT be added (check .gitignore)."
  fi
fi

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

ensure_github_remote

log ">>> Repository: $REPO_ROOT"
log ">>> Remote: ${REMOTE} (${GITHUB_URL})  Branch: ${BRANCH}"
if [ "$EVERYTHING" -eq 1 ]; then
  log ">>> Mode: --everything (fresh orphan commit + force push)"
fi
log ""

if [ "$EVERYTHING" -eq 1 ]; then
  log ">>> Status before nuclear push"
  git status -sb 2>/dev/null || true
  log ""
  log "WARNING: --everything replaces ${REMOTE}/${BRANCH} with a single new commit"
  log "         containing the current PUBLIC/ tree. Prior branch history on GitHub"
  log "         will no longer be reachable from main (force push)."
  log ""
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] Would run:"
    log "  git checkout --orphan <fresh>"
    log "  git add -A"
    log "  git commit -m \"$MSG\""
    log "  git branch -M ${BRANCH}"
    log "  git push --force -u ${REMOTE} ${BRANCH}"
    exit 0
  fi
  if is_tty; then
    read -r -p "Force-push fresh tree to ${REMOTE}/${BRANCH}? [y/N] " ans
    case "$ans" in
      y|Y|yes|YES) ;;
      *) die "Aborted." ;;
    esac
  else
    die "--everything requires a TTY to confirm, or use a normal ./gitpush.sh without --everything."
  fi

  step "Nuclear push: orphan commit with full PUBLIC/ tree"
  ORPHAN_BRANCH="firmgate-fresh-$$"
  git checkout --orphan "$ORPHAN_BRANCH"
  git add -A
  if git diff --cached --quiet; then
    die "Nothing to commit after staging — is PUBLIC/ empty?"
  fi
  git --no-pager diff --cached --stat
  warn_large_staged_files
  log ""
  git commit -m "$MSG"
  git branch -M "$BRANCH"

  LOCAL_REV="$(git rev-parse --short HEAD)"
  log ""
  step "Force-pushing ${LOCAL_REV} to ${REMOTE}/${BRANCH} (replaces remote history)"
  log "    (progress below — Git may prompt for GitHub credentials)"
  if ! git -c push.progress=true push --progress --force -u "${REMOTE}" "${BRANCH}"; then
    die "git push --force failed — check network and GitHub credentials for ${REMOTE} (${GITHUB_URL})"
  fi

  REMOTE_REV="$(git rev-parse --short "${REMOTE}/${BRANCH}" 2>/dev/null || echo "?")"
  log ""
  log "=========================================="
  log " GitHub nuclear push complete."
  log " Local:   ${LOCAL_REV}"
  log " GitHub:  ${REMOTE_REV} (${REMOTE}/${BRANCH}) — fresh history"
  log " URL:     ${GITHUB_URL%.git}"
  log "=========================================="
  exit 0
fi

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
log "    (progress below — Git may prompt for GitHub credentials)"
if ! git -c push.progress=true push --progress -u "${REMOTE}" "HEAD:${BRANCH}"; then
  die "git push failed — check network and GitHub credentials for ${REMOTE} (${GITHUB_URL})"
fi

REMOTE_REV="$(git rev-parse --short "${REMOTE}/${BRANCH}" 2>/dev/null || echo "?")"
log ""
log "=========================================="
log " GitHub push complete."
log " Local:   ${LOCAL_REV}"
log " GitHub:  ${REMOTE_REV} (${REMOTE}/${BRANCH})"
log " URL:     ${GITHUB_URL%.git}"
log "=========================================="
