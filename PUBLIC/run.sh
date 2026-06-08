#!/usr/bin/env bash

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck source=/dev/null
source .venv/bin/activate

python -m pip install -q --upgrade pip
python -m pip install -q -r requirements.txt

port_free() {
  PORT_TRY="$1" python - <<'PY'
import os, socket, sys
p = int(os.environ["PORT_TRY"])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(("127.0.0.1", p))
except OSError:
    sys.exit(1)
finally:
    s.close()
sys.exit(0)
PY
}

if [ -z "${PORT:-}" ]; then
  PORT=""
  for p in {5001..5010}; do
    if port_free "$p"; then
      PORT=$p
      break
    fi
  done
  if [ -z "$PORT" ]; then
    echo "No free port found in 5001–5010. Stop another listener or set PORT explicitly." >&2
    exit 1
  fi
  export PORT
  echo "Starting on port $PORT (export PORT=… to pin a port)." >&2
elif ! port_free "$PORT"; then
  echo "Port $PORT is already in use. Try PORT=$((PORT + 1)) $0" >&2
  echo "Or stop the listener, e.g. kill \$(lsof -t -iTCP:$PORT -sTCP:LISTEN)" >&2
  exit 1
else
  export PORT
fi

# Optional: python seed_data.py
python run.py
