"""Home page settings (announcements, featured blogs) — shared by intranet and admin APIs."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

from flask import current_app, jsonify

from app.extensions import db
from app.html_clean import sanitize_about_html, strip_data_uri_images
from app.settings import set_setting

_HOME_ANNOUNCEMENT_HTML_MAX = 200_000


def persist_home_settings(cfg: dict[str, Any]) -> tuple[dict[str, Any], Any]:
    """
    Validate and save home settings.

    Returns (config_dict, None) on success or (partial_config, flask_response) on error.
    """
    anns_in = cfg.get("announcements")
    anns: list[dict] = []
    if isinstance(anns_in, list):
        for i, a in enumerate(anns_in[:50]):
            if not isinstance(a, dict):
                continue
            cat = str(a.get("category") or "").strip()[:40]
            title = str(a.get("title") or "").strip()[:120]
            body_html_raw = strip_data_uri_images(str(a.get("body_html") or a.get("body") or "").strip())
            if len(body_html_raw) > _HOME_ANNOUNCEMENT_HTML_MAX:
                return (
                    {},
                    (
                        jsonify(
                            {
                                "error": (
                                    f"Announcement {i + 1} is too large to save. "
                                    "Paste images with Ctrl+V so they upload, or use the image button — "
                                    "do not embed huge inline pictures."
                                )
                            }
                        ),
                        413,
                    ),
                )
            body_html = sanitize_about_html(body_html_raw)[:50000] if body_html_raw else ""
            if not (cat or title or body_html_raw):
                continue
            anns.append(
                {
                    "category": cat or "General",
                    "title": title or "Announcement",
                    "body_html": body_html,
                    "show_full_on_home": a.get("show_full_on_home") is True,
                }
            )

    ids_in = cfg.get("featured_blog_post_ids")
    ids: list[int] = []
    if isinstance(ids_in, list):
        for x in ids_in[:20]:
            try:
                ids.append(int(x))
            except Exception:
                pass
    if ids:
        seen_ids: set[int] = set()
        uniq: list[int] = []
        for i in ids:
            if i in seen_ids:
                continue
            seen_ids.add(i)
            uniq.append(i)
        ids = uniq

    out = {"announcements": anns, "featured_blog_post_ids": ids}
    try:
        set_setting("home", out)
    except Exception as exc:
        current_app.logger.exception("persist_home_settings failed")
        db.session.rollback()
        return {}, (jsonify({"error": f"could not save home settings: {exc}"}), 500)
    return out, None


def save_home_upload(file) -> tuple[str | None, Any]:
    """Store an uploaded image; returns (url, error_response)."""
    if not file:
        return None, (jsonify({"error": "file required"}), 400)
    ct = (file.mimetype or "").lower()
    if not ct.startswith("image/"):
        return None, (jsonify({"error": "image required"}), 400)
    ext = ".png"
    if "jpeg" in ct or "jpg" in ct:
        ext = ".jpg"
    elif "webp" in ct:
        ext = ".webp"
    elif "gif" in ct:
        ext = ".gif"
    root = Path(str(current_app.config.get("UPLOAD_ROOT")))
    out_dir = root / "home_assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid4().hex}{ext}"
    out_path = out_dir / name
    file.save(out_path)
    return f"/intranet/media/home/{name}", None
