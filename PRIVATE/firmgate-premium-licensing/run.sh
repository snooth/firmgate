#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

PY="${PYTHON:-python3}"
VENV_DIR="${VENV_DIR:-.venv}"
PORT="${PORT:-5055}"

if [ ! -d "$VENV_DIR" ]; then
  "$PY" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements-web.txt >/dev/null

export FLASK_APP="webapp:create_app"
export FLASK_ENV="${FLASK_ENV:-development}"
export PORT="$PORT"

echo "Starting licensing webapp on http://127.0.0.1:${PORT}"
python -c "from webapp import create_app; create_app().run(host='127.0.0.1', port=int('${PORT}'), debug=True)"
