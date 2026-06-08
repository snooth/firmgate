"""Enterprise license verification — re-exported from app.enterprise when present."""

from __future__ import annotations

try:
    from app.enterprise.premium_license import *  # noqa: F403,F401
except ImportError:
    from app.premium_license_ce import *  # noqa: F403,F401
