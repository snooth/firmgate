#!/usr/bin/env bash
# Load SolStak Gitea credentials and run authenticated git network commands.
set -euo pipefail

_solstak_auth_loaded=0

solstak_load_env() {
  local root="${1:?repo root required}"
  if [ "$_solstak_auth_loaded" -eq 1 ]; then
    return 0
  fi
  local f
  for f in "$root/.solstak-backup.env" "$root/PRIVATE/.solstak-backup.env"; do
    if [ -f "$f" ]; then
      set -a
      # shellcheck disable=SC1090
      source "$f"
      set +a
      _solstak_auth_loaded=1
      return 0
    fi
  done
  return 1
}

solstak_has_password() {
  [ -n "${SOLSTAK_GIT_PASSWORD:-}" ]
}

solstak_remote_name() {
  printf '%s' "${SOLSTAK_GIT_REMOTE:-origin}"
}

solstak_branch_name() {
  printf '%s' "${SOLSTAK_GIT_BRANCH:-main}"
}

solstak_remote_url() {
  printf '%s' "${SOLSTAK_GIT_URL:-https://git.solstak.com.au/snoothdogg/intranet.git}"
}

solstak_git_env() {
  local root="${1:?repo root required}"
  solstak_load_env "$root" || true
  export GIT_TERMINAL_PROMPT=0
  export GIT_PAGER=cat
  if solstak_has_password; then
    export GIT_ASKPASS="$root/scripts/lib/solstak-git-askpass.sh"
    export SOLSTAK_GIT_USER="${SOLSTAK_GIT_USER:-snoothdogg}"
  fi
}

solstak_git_push() {
  local root="$1"
  shift
  local remote branch
  remote="$(solstak_remote_name)"
  branch="$(solstak_branch_name)"
  solstak_git_env "$root"
  (
    cd "$root"
    git -c push.progress=true push --progress "$@" "$remote" "HEAD:${branch}"
  )
}
