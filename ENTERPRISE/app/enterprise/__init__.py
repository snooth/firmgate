"""Enterprise modules (licensed). Omitted from PUBLIC Community Edition export."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flask import Flask


def register_enterprise(app: "Flask") -> None:
    """Register enterprise blueprints and ensure intranet enterprise routes are loaded."""
    from app.enterprise.office365_bp import bp as office365_bp

    app.register_blueprint(office365_bp)
    import app.enterprise.intranet_routes  # noqa: F401
    import app.enterprise.ai_intranet_routes  # noqa: F401
