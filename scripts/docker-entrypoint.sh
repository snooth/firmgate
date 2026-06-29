#!/bin/sh
set -eu

DATA_ROOT="${FIRMGATE_DATA_ROOT:-/data/instance}"
export UPLOAD_ROOT="${UPLOAD_ROOT:-${DATA_ROOT}/uploads}"
export DATABASE_URL="${DATABASE_URL:-sqlite:////data/instance/secure_browser.db}"

mkdir -p "${DATA_ROOT}/uploads" "${DATA_ROOT}/branding"

# Create / migrate schema and bootstrap admin on first run.
python -c "from app import create_app; create_app()"

exec gunicorn \
  --bind "0.0.0.0:${PORT:-5001}" \
  --worker-class "${GUNICORN_WORKER_CLASS:-eventlet}" \
  --workers "${GUNICORN_WORKERS:-1}" \
  --timeout "${GUNICORN_TIMEOUT:-300}" \
  "run:socketio"
