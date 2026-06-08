#!/usr/bin/env bash
#
# Safe in-place update for Firmgate (Flask).
# Preserves runtime data under instance/ (SQLite DB + document uploads) and local .env.
#
# Typical install layout:
#   /root/intranet/            ← git checkout (APP_DIR)
#   /root/intranet_instance/   ← optional external data (DB + uploads), linked as instance/
#   /root/intranet-backups/    ← timestamped backups (BACKUP_ROOT)
#
# Usage:
#   sudo ./scripts/update.sh              # in-place; light backup (.env + DB only)
#   sudo ./scripts/update.sh --recreate-venv
#   sudo ./scripts/update.sh --full       # fresh clone + swap (moves instance/, no upload copy)
#
# Run the script from OUTSIDE APP_DIR (e.g. sudo /root/update.sh). If you run it from
# inside APP_DIR/scripts, --full removes that path during the swap and pip can fail.
#   sudo ./scripts/update.sh --backup-full  # also rsync all of instance/ (slow if uploads are huge)
#   sudo ./scripts/update.sh --no-backup
#   sudo ./scripts/update.sh --dry-run
#
# Optional config: /etc/intranet-update.conf (see scripts/update.conf.example)
#
# Production layout is fixed — all pull redeployments use:
#   APP_DIR=/root/intranet   INSTANCE_DATA_DIR=/root/intranet_instance   BACKUP_ROOT=/root/intranet-backups
# Run: sudo /root/update.sh   (wrapper) or: sudo /root/intranet/scripts/update.sh

set -euo pipefail

PRODUCTION_APP_DIR="/root/intranet"
PRODUCTION_INSTANCE_DATA="/root/intranet_instance"
PRODUCTION_BACKUP_ROOT="/root/intranet-backups"

APP_DIR="${APP_DIR:-$PRODUCTION_APP_DIR}"
BACKUP_ROOT="${BACKUP_ROOT:-$PRODUCTION_BACKUP_ROOT}"
REPO_URL="${REPO_URL:-https://github.com/your-org/intranet.git}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-intranet}"
VENV_DIR="${VENV_DIR:-.venv}"
PYTHON="${PYTHON:-python3}"
INSTANCE_DATA_DIR="${INSTANCE_DATA_DIR:-$PRODUCTION_INSTANCE_DATA}"
INSTANCE_LINK_MODE="${INSTANCE_LINK_MODE:-symlink}"

DRY_RUN=0
RECREATE_VENV=0
FULL_SWAP=0
FORCE=0
BACKUP_FULL=0
NO_BACKUP=0

log() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] $*"
  else
    "$@"
  fi
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --recreate-venv) RECREATE_VENV=1 ;;
    --full) FULL_SWAP=1 ;;
    --force) FORCE=1 ;;
    --backup-full) BACKUP_FULL=1 ;;
    --no-backup) NO_BACKUP=1 ;;
    -h|--help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *)
      die "Unknown option: $arg (try --help)"
      ;;
  esac
done

if [ "$NO_BACKUP" -eq 1 ] && [ "$BACKUP_FULL" -eq 1 ]; then
  die "Use either --no-backup or --backup-full, not both."
fi

# Optional overrides (production paths are re-applied after sourcing).
if [ -f /etc/intranet-update.conf ]; then
  # shellcheck source=/dev/null
  source /etc/intranet-update.conf
fi

apply_production_paths() {
  if [ ! -d "$PRODUCTION_APP_DIR" ]; then
    return 0
  fi
  if [ "$APP_DIR" != "$PRODUCTION_APP_DIR" ]; then
    log "NOTE: Using ${PRODUCTION_APP_DIR} (was APP_DIR=${APP_DIR})"
  fi
  APP_DIR="$PRODUCTION_APP_DIR"
  BACKUP_ROOT="${BACKUP_ROOT:-$PRODUCTION_BACKUP_ROOT}"
  INSTANCE_DATA_DIR="${INSTANCE_DATA_DIR:-$PRODUCTION_INSTANCE_DATA}"
}

apply_production_paths

INSTANCE_DIR="${APP_DIR}/instance"
UPLOADS_DIR="${INSTANCE_DIR}/uploads"
DB_FILE="${INSTANCE_DIR}/secure_browser.db"
ENV_FILE="${APP_DIR}/.env"
VENV_PATH="${APP_DIR}/${VENV_DIR}"

# Absolute APP_DIR (config may override the default).
if [ -d "$APP_DIR" ]; then
  APP_DIR="$(cd "$APP_DIR" && pwd)"
  INSTANCE_DIR="${APP_DIR}/instance"
  UPLOADS_DIR="${INSTANCE_DIR}/uploads"
  DB_FILE="${INSTANCE_DIR}/secure_browser.db"
  ENV_FILE="${APP_DIR}/.env"
  VENV_PATH="${APP_DIR}/${VENV_DIR}"
fi

# Leave APP_DIR so --full swap does not delete the shell cwd (breaks pip: os.getcwd()).
leave_stable_cwd() {
  local parent
  parent="$(dirname "$APP_DIR")"
  if [ -d "$parent" ]; then
    cd "$parent"
  else
    cd / || true
  fi
}

resolve_instance_data_dir() {
  if [ -n "${INSTANCE_DATA_DIR}" ] && [ -d "${INSTANCE_DATA_DIR}" ]; then
    printf '%s\n' "${INSTANCE_DATA_DIR}"
    return 0
  fi
  if [ -d "$PRODUCTION_INSTANCE_DATA" ]; then
    printf '%s\n' "$PRODUCTION_INSTANCE_DATA"
  fi
}

instance_data_has_content() {
  local dir="$1"
  [ -f "${dir}/secure_browser.db" ] && return 0
  if [ -d "${dir}/uploads" ]; then
    find "${dir}/uploads" -type f 2>/dev/null | head -1 | grep -q .
    return $?
  fi
  return 1
}

instance_paths_match() {
  local a b
  [ -e "$1" ] && [ -e "$2" ] || return 1
  a="$(readlink -f "$1" 2>/dev/null || echo "$1")"
  b="$(readlink -f "$2" 2>/dev/null || echo "$2")"
  [ "$a" = "$b" ]
}

# Wire APP_DIR/instance -> external data dir (e.g. /root/intranet_instance) without copying uploads.
ensure_instance_linked() {
  local data_dir
  data_dir="$(resolve_instance_data_dir || true)"
  [ -n "$data_dir" ] || return 0
  [ -d "$data_dir" ] || {
    log "WARNING: INSTANCE_DATA_DIR is not a directory: ${data_dir}"
    return 0
  }
  instance_data_has_content "$data_dir" || return 0

  log ">>> Runtime data directory: ${data_dir}"

  if [ -e "$INSTANCE_DIR" ] && instance_paths_match "$INSTANCE_DIR" "$data_dir"; then
    log "  ${INSTANCE_DIR} already uses ${data_dir}"
    return 0
  fi

  local use_external=0
  if [ ! -e "$INSTANCE_DIR" ]; then
    use_external=1
  elif [ -L "$INSTANCE_DIR" ]; then
    log "  Replacing stale instance/ symlink"
    run rm -f "$INSTANCE_DIR"
    use_external=1
  elif instance_data_has_content "$data_dir" && ! instance_data_has_content "$INSTANCE_DIR"; then
    log "  ${INSTANCE_DIR} looks empty; using external data at ${data_dir}"
    use_external=1
  elif instance_data_has_content "$INSTANCE_DIR" && instance_data_has_content "$data_dir"; then
    local local_kb ext_kb
    local_kb="$(du -sk "$INSTANCE_DIR" 2>/dev/null | awk '{print $1}')"
    ext_kb="$(du -sk "$data_dir" 2>/dev/null | awk '{print $1}')"
    if [ "${ext_kb:-0}" -gt 0 ] && [ "${local_kb:-0}" -lt $((ext_kb / 10)) ]; then
      log "  ${INSTANCE_DIR} is much smaller than ${data_dir}; relinking"
      use_external=1
    else
      log "  ${INSTANCE_DIR} already has data; leaving as-is"
      return 0
    fi
  fi

  [ "$use_external" -eq 1 ] || return 0

  if [ -e "$INSTANCE_DIR" ] && [ ! -L "$INSTANCE_DIR" ]; then
    run mv "$INSTANCE_DIR" "${INSTANCE_DIR}.empty.$(date +%Y%m%d%H%M%S)"
  elif [ -e "$INSTANCE_DIR" ]; then
    run rm -rf "$INSTANCE_DIR"
  fi

  if [ "${INSTANCE_LINK_MODE}" = "move" ]; then
    log "  Moving ${data_dir} -> ${INSTANCE_DIR}"
    run mv "$data_dir" "$INSTANCE_DIR"
  else
    log "  Linking ${INSTANCE_DIR} -> ${data_dir}"
    run ln -s "$data_dir" "$INSTANCE_DIR"
  fi
}

restore_instance_after_swap() {
  local tmp="$1"
  local preserve="$2"
  local data_dir
  data_dir="$(resolve_instance_data_dir || true)"

  if [ -n "$data_dir" ] && [ -d "$data_dir" ] && instance_data_has_content "$data_dir"; then
    if [ "${INSTANCE_LINK_MODE}" = "move" ] && [ -d "$preserve" ] && ! [ -L "$preserve" ]; then
      run mv "$preserve" "${tmp}/instance"
    else
      run ln -s "$data_dir" "${tmp}/instance"
    fi
    return 0
  fi

  if [ -d "$preserve" ]; then
    if [ -L "$preserve" ]; then
      local target
      target="$(readlink "$preserve" 2>/dev/null || true)"
      if [ -n "$target" ]; then
        run ln -s "$target" "${tmp}/instance"
        return 0
      fi
    fi
    run mv "$preserve" "${tmp}/instance"
  else
    run mkdir -p "${tmp}/instance"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_cmd git
require_cmd systemctl
require_cmd "$PYTHON"

if [ ! -d "$APP_DIR" ]; then
  die "APP_DIR does not exist: ${APP_DIR}. Clone the repo to ${PRODUCTION_APP_DIR} (see README)."
fi
[ -d "$APP_DIR/.git" ] || die "APP_DIR is not a git repository: $APP_DIR"

if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  log "WARNING: not running as root; systemctl restart may fail without sudo."
fi

# Full find|wc on large upload trees can take many minutes and looks like a freeze.
UPLOAD_COUNT_TIMEOUT="${UPLOAD_COUNT_TIMEOUT:-25}"
INSTANCE_DU_TIMEOUT="${INSTANCE_DU_TIMEOUT:-45}"

count_upload_files() {
  if [ ! -d "$UPLOADS_DIR" ]; then
    echo "0"
    return
  fi
  local count=""
  if command -v timeout >/dev/null 2>&1; then
    count="$(timeout "$UPLOAD_COUNT_TIMEOUT" sh -c 'find "$1" -type f 2>/dev/null | wc -l' _ "$UPLOADS_DIR" | tr -d ' ')" || count="skip"
  else
    count="$(find "$UPLOADS_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')"
  fi
  echo "${count:-skip}"
}

instance_byte_size() {
  if [ ! -d "$INSTANCE_DIR" ]; then
    echo "0"
    return
  fi
  local kb=""
  if command -v timeout >/dev/null 2>&1; then
    kb="$(timeout "$INSTANCE_DU_TIMEOUT" du -sk "$INSTANCE_DIR" 2>/dev/null | awk '{print $1}')" || kb="skip"
  else
    kb="$(du -sk "$INSTANCE_DIR" 2>/dev/null | awk '{print $1}')"
  fi
  echo "${kb:-skip}"
}

verify_instance_preserved() {
  local before_files="$1" before_kb="$2"
  local after_files after_kb

  log ">>> Verifying instance/ was preserved (may take up to ${UPLOAD_COUNT_TIMEOUT}s on large uploads)..."
  after_files="$(count_upload_files)"
  after_kb="$(instance_byte_size)"

  if [ ! -d "$INSTANCE_DIR" ]; then
    die "instance/ directory missing after update — restore from backup immediately."
  fi

  if [ -f "$DB_FILE" ]; then
    : # ok
  else
    log "WARNING: ${DB_FILE} not found (new install or custom DATABASE_URL?)."
  fi

  if [ "$before_files" = "skip" ] || [ "$after_files" = "skip" ]; then
    log "  Upload file count check skipped (large tree or timed out after ${UPLOAD_COUNT_TIMEOUT}s)"
  elif [ "$before_files" != "0" ] && [ "$after_files" -lt "$before_files" ]; then
    die "Upload file count dropped (${before_files} → ${after_files}). Check ${BACKUP_LATEST} and restore instance/."
  fi

  if [ "$before_kb" = "skip" ] || [ "$after_kb" = "skip" ]; then
    log "  instance/ size check skipped (du timed out after ${INSTANCE_DU_TIMEOUT}s)"
  elif [ "$before_kb" != "0" ] && [ "$after_kb" -lt $((before_kb * 9 / 10)) ]; then
    die "instance/ size dropped sharply (${before_kb}KB → ${after_kb}KB). Check backup and restore."
  fi

  if [ "$after_files" = "skip" ] || [ "$after_kb" = "skip" ]; then
    log "  instance/ OK — uploads present (exact count/size skipped for speed)"
  else
    log "  instance/ OK — uploads: ${after_files} files, ~${after_kb}KB"
  fi
}

backup_runtime_data() {
  local stamp dest
  stamp="$(date +%Y%m%d-%H%M%S)"
  dest="${BACKUP_ROOT}/${stamp}"
  BACKUP_LATEST="$dest"

  if [ "$NO_BACKUP" -eq 1 ]; then
    log ">>> Skipping backup (--no-backup); instance/ and uploads are not copied"
    run mkdir -p "$dest"
    run git -C "$APP_DIR" rev-parse HEAD > "${dest}/git-revision-before.txt" 2>/dev/null || true
    echo "$dest"
    return
  fi

  log ">>> Backing up to ${dest}"
  run mkdir -p "$dest"

  if [ "$BACKUP_FULL" -eq 1 ]; then
    command -v rsync >/dev/null 2>&1 || die "rsync required for --backup-full"
    log "  Full instance/ backup (includes uploads — can be slow for large data)"
    if [ -d "$INSTANCE_DIR" ]; then
      run rsync -a --delete "${INSTANCE_DIR}/" "${dest}/instance/"
    else
      log "  (no instance/ yet — skipping)"
    fi
  else
    log "  Light backup only (.env + SQLite); uploads stay in ${INSTANCE_DIR} (not copied)"
    run mkdir -p "${dest}/instance"
    if [ -f "$DB_FILE" ]; then
      run cp -a "$DB_FILE" "${dest}/instance/"
    else
      log "  (no ${DB_FILE} — skipping DB copy)"
    fi
  fi

  if [ -f "$ENV_FILE" ]; then
    run cp -a "$ENV_FILE" "${dest}/.env"
  fi

  if [ -f "$VENV_PATH/bin/activate" ]; then
    run "${VENV_PATH}/bin/pip" freeze > "${dest}/pip-freeze.txt" 2>/dev/null || true
  fi

  run git -C "$APP_DIR" rev-parse HEAD > "${dest}/git-revision-before.txt" 2>/dev/null || true
  echo "$dest"
}

git_test_remote() {
  log ">>> Testing Git remote access..."
  if [ -n "${REPO_URL:-}" ]; then
    run git ls-remote "$REPO_URL" "refs/heads/${GIT_BRANCH}" >/dev/null
  else
    run git -C "$APP_DIR" ls-remote "$GIT_REMOTE" "refs/heads/${GIT_BRANCH}" >/dev/null
  fi
}

check_clean_enough() {
  local dirty
  dirty="$(git -C "$APP_DIR" status --porcelain --untracked-files=no)"
  if [ -n "$dirty" ] && [ "$FORCE" -ne 1 ]; then
    log "$dirty"
    die "Tracked files have local modifications. Commit/stash them or re-run with --force."
  fi
}

pip_install_deps() {
  log ">>> Updating Python dependencies in ${VENV_PATH} (may take a few minutes — not frozen)"
  leave_stable_cwd
  local py="${VENV_PATH}/bin/python"
  if [ ! -x "$py" ]; then
    log "  Creating virtualenv..."
    run "$PYTHON" -m venv "$VENV_PATH"
    py="${VENV_PATH}/bin/python"
  fi
  [ -f "${APP_DIR}/requirements.txt" ] || die "missing ${APP_DIR}/requirements.txt"
  # Use venv python directly (do not rely on activate + cwd).
  export PIP_PROGRESS_BAR="${PIP_PROGRESS_BAR:-on}"
  run "$py" -m pip install --upgrade pip
  run "$py" -m pip install -r "${APP_DIR}/requirements.txt"
  if ! "$py" -c "import gunicorn" 2>/dev/null; then
    run "$py" -m pip install gunicorn
  fi
  log "  Python dependencies OK"
}

inplace_git_update() {
  local ref="${GIT_REMOTE}/${GIT_BRANCH}"

  log ">>> In-place Git update (${ref})"
  check_clean_enough

  run git -C "$APP_DIR" fetch "$GIT_REMOTE" --prune
  run git -C "$APP_DIR" branch -f "$GIT_BRANCH" "$ref" 2>/dev/null || true
  run git -C "$APP_DIR" checkout -B "$GIT_BRANCH" "$ref"
  run git -C "$APP_DIR" reset --hard "$ref"

  # Remove untracked junk only; never delete ignored runtime data (instance/, .env, .venv).
  # Explicit -e guards in case someone changes .gitignore.
  run git -C "$APP_DIR" clean -fd \
    -e instance/ \
    -e instance \
    -e .venv/ \
    -e .venv \
    -e venv/ \
    -e .env \
    -e .env.local
}

full_swap_update() {
  local tmp="${APP_DIR}.new"
  local old="${APP_DIR}.old"
  local ref="${GIT_REMOTE}/${GIT_BRANCH}"
  local preserve_instance="${APP_DIR}.preserve-instance"
  local preserve_env="${APP_DIR}.preserve-env"

  log ">>> Full directory swap (clone fresh; instance/ moved, not copied)"
  leave_stable_cwd
  git_test_remote

  log ">>> Moving runtime data aside (no upload copy)"
  run rm -rf "$preserve_instance" "$preserve_env"
  if [ -d "$INSTANCE_DIR" ]; then
    run mv "$INSTANCE_DIR" "$preserve_instance"
  fi
  if [ -f "$ENV_FILE" ]; then
    run mv "$ENV_FILE" "$preserve_env"
  fi
  if [ "$RECREATE_VENV" -ne 1 ] && [ -d "$VENV_PATH" ]; then
    run mv "$VENV_PATH" "${APP_DIR}.preserve-venv"
  fi

  run rm -rf "$tmp"
  if [ -n "${REPO_URL:-}" ]; then
    run git clone --branch "$GIT_BRANCH" "$REPO_URL" "$tmp"
  else
    run git clone "$APP_DIR" "$tmp"
    run git -C "$tmp" remote set-url origin "$(git -C "$APP_DIR" remote get-url origin)"
    run git -C "$tmp" fetch origin
    run git -C "$tmp" checkout -B "$GIT_BRANCH" "$ref"
    run git -C "$tmp" reset --hard "$ref"
  fi

  restore_instance_after_swap "$tmp" "$preserve_instance"
  if [ -f "$preserve_env" ]; then
    run mv "$preserve_env" "${tmp}/.env"
  fi
  if [ -d "${APP_DIR}.preserve-venv" ]; then
    run mv "${APP_DIR}.preserve-venv" "${tmp}/${VENV_DIR}"
  fi

  log ">>> Swapping ${APP_DIR}"
  run rm -rf "$old"
  if [ -d "$APP_DIR" ]; then
    run mv "$APP_DIR" "$old"
  fi
  run mv "$tmp" "$APP_DIR"
  run rm -rf "$old" "$preserve_instance" "$preserve_env" "${APP_DIR}.preserve-venv" 2>/dev/null || true

  if [ "$RECREATE_VENV" -eq 1 ]; then
    log ">>> Recreating virtualenv"
    run rm -rf "$VENV_PATH"
  fi
  pip_install_deps
}

restart_service() {
  log ">>> Restarting ${SERVICE_NAME}..."
  run systemctl restart "$SERVICE_NAME"
  if [ "$DRY_RUN" -eq 0 ]; then
    log "  Waiting for ${SERVICE_NAME} to become active..."
    sleep 2
    systemctl is-active --quiet "$SERVICE_NAME" || die "Service ${SERVICE_NAME} is not active after restart."
    systemctl status "$SERVICE_NAME" --no-pager -l | head -n 20 || true
    log "  ${SERVICE_NAME} is active"
  fi
}

# --- main ---
log "=========================================="
log " Firmgate safe update"
log " APP_DIR=${APP_DIR}"
log " Branch=${GIT_BRANCH} remote=${GIT_REMOTE}"
if [ "$DRY_RUN" -eq 1 ]; then log " (dry-run)"; fi
if [ "$FULL_SWAP" -eq 1 ]; then log " mode=full-swap"; else log " mode=in-place"; fi
if [ "$NO_BACKUP" -eq 1 ]; then log " backup=none"; elif [ "$BACKUP_FULL" -eq 1 ]; then log " backup=full-instance"; else log " backup=light (.env+DB)"; fi
log "=========================================="

leave_stable_cwd

ensure_instance_linked

log ">>> Measuring instance/ (skipped or quick if uploads are huge)..."
BEFORE_FILES="$(count_upload_files)"
BEFORE_KB="$(instance_byte_size)"
if [ "$BEFORE_FILES" = "skip" ] || [ "$BEFORE_KB" = "skip" ]; then
  log ">>> Pre-update instance: uploads present (exact metrics skipped for speed)"
else
  log ">>> Pre-update instance: ${BEFORE_FILES} upload files, ~${BEFORE_KB}KB under instance/"
fi

git_test_remote
BACKUP_LATEST="$(backup_runtime_data)"

if [ "$FULL_SWAP" -eq 1 ]; then
  full_swap_update
else
  inplace_git_update
  if [ "$RECREATE_VENV" -eq 1 ]; then
    log ">>> Recreating virtualenv (--recreate-venv)"
    run rm -rf "$VENV_PATH"
  fi
  pip_install_deps
fi

ensure_instance_linked

verify_instance_preserved "$BEFORE_FILES" "$BEFORE_KB"

NEW_REV="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
log ">>> Git revision now: ${NEW_REV}"
log ">>> Backup saved at: ${BACKUP_LATEST}"

restart_service

log "=========================================="
log " Update complete."
log " Documents & DB live under: ${INSTANCE_DIR}"
if [ -f "${BACKUP_LATEST}/instance/secure_browser.db" ]; then
  log " Restore DB:  cp -a ${BACKUP_LATEST}/instance/secure_browser.db ${DB_FILE}"
fi
if [ -f "${BACKUP_LATEST}/.env" ]; then
  log " Restore .env: cp -a ${BACKUP_LATEST}/.env ${ENV_FILE}"
fi
if [ -d "${BACKUP_LATEST}/instance/uploads" ]; then
  log " Restore uploads (full backup only): rsync -a ${BACKUP_LATEST}/instance/ ${INSTANCE_DIR}/"
fi
log "=========================================="
