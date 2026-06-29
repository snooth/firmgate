#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck source=/dev/null
source .venv/bin/activate

python -m pip install --upgrade pip setuptools wheel

echo "Installing/upgrading dependencies from requirements.txt..." >&2
python -m pip install --upgrade -r requirements.txt

echo "Verifying key packages..." >&2
python - <<'PY'
import importlib.util
required = ("flask", "fpdf", "endesive", "cryptography")
missing = [m for m in required if importlib.util.find_spec(m) is None]
if missing:
    raise SystemExit(f"Missing packages after install: {', '.join(missing)}")
print("Dependencies OK.", flush=True)
PY

# Pin to a single, predictable port. run.py replaces any existing server on this
# port, so repeated launches never leave two instances running on stale code.
export PORT="${PORT:-5001}"
echo "Starting intranet on port $PORT (single instance — any existing server on this port is replaced)." >&2

python run.py
