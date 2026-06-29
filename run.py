import os
import signal
import subprocess
import time

from app import create_app


def _free_port(port: int) -> None:
    """Terminate any existing server listening on `port` so only one instance runs.

    Prevents the "two servers, one on stale code" problem: starting a new server
    always replaces the previous one bound to the same port.
    """
    try:
        result = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return

    me = os.getpid()
    killed = False
    for line in result.stdout.split():
        try:
            pid = int(line)
        except ValueError:
            continue
        if pid == me:
            continue
        try:
            os.kill(pid, signal.SIGTERM)
            killed = True
            print(f"Replaced existing server on port {port} (pid {pid}).")
        except (ProcessLookupError, PermissionError):
            continue
    if killed:
        time.sleep(1)


app = create_app()

from app.chat_signaling_socket import socketio  # noqa: E402 — after create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    # Skip in the Werkzeug reloader child so it never kills its own parent.
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        _free_port(port)
    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=bool(app.config.get("DEBUG")),
        allow_unsafe_werkzeug=True,
    )
