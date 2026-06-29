#!/usr/bin/env python3
"""Capture README gallery screenshots from a running Firmgate instance."""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots"
BASE = "http://127.0.0.1:5001"
EMAIL = "admin@example.com"
PASSWORD = "admin"
VIEWPORT = {"width": 1440, "height": 900}
SETTLE_MS = 900

SHOTS: list[tuple[str, str, str | None]] = [
    ("home.png", "/intranet/", None),
    ("blogs.png", "/intranet/news", None),
    ("events.png", "/intranet/events", None),
    ("wiki.png", "/intranet/wiki", None),
    ("team-chat.png", "/intranet/team-chat", None),
    ("documents.png", "/intranet/documents", None),
    ("workforce.png", "/intranet/directory", None),
    ("games.png", "/intranet/game", None),
    ("administration-users.png", "/intranet/admin", "users"),
    ("administration-modules.png", "/intranet/admin", "modules"),
]


def _login(page) -> None:
    page.goto(f"{BASE}/login", wait_until="networkidle")
    page.fill('input[name="email"]', EMAIL)
    page.fill('input[name="password"]', PASSWORD)
    page.click('button[type="submit"]')
    page.wait_for_url("**/intranet/**", timeout=30000)


def _open_admin_tab(page, tab: str) -> None:
    tab_btn = page.locator(f'.nc-admin-nav-item[data-tab="{tab}"]')
    if tab_btn.count():
        tab_btn.first.click()
        page.wait_for_timeout(SETTLE_MS)


def _prepare_view(page, path: str, extra: str | None) -> None:
    page.goto(f"{BASE}{path}", wait_until="networkidle")
    page.wait_for_timeout(SETTLE_MS)
    if path.endswith("/team-chat"):
        first = page.locator("#tc-list button[data-id]").first
        if first.count():
            first.click()
            page.wait_for_timeout(SETTLE_MS)
    if path.endswith("/wiki"):
        page.wait_for_selector(".nc-wiki-article, .nc-wiki-main, #nc-wiki-root", timeout=15000)
        page.wait_for_timeout(400)
    if extra:
        _open_admin_tab(page, extra)
        page.wait_for_selector(f"#admin-tab-{extra}", timeout=15000)
        page.wait_for_timeout(400)


def _capture_set(page, shots: list[tuple[str, str, str | None]], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, path, extra in shots:
        _prepare_view(page, path, extra)
        out = out_dir / name
        page.screenshot(path=str(out), full_page=False)
        print(f"captured {out.relative_to(ROOT)}")


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport=VIEWPORT)
        _login(page)
        _capture_set(page, SHOTS, OUT)
        browser.close()


if __name__ == "__main__":
    main()
