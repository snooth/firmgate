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
VIEWPORT = {"width": 1280, "height": 800}

SHOTS: list[tuple[str, str, str | None]] = [
    ("home.png", "/intranet/", None),
    ("blogs.png", "/intranet/news", None),
    ("team-chat.png", "/intranet/team-chat", None),
    ("security-clearance.png", "/intranet/security-clearance", None),
    ("documents.png", "/intranet/documents", None),
    ("crm-dashboard.png", "/intranet/crm/dashboard", None),
    ("games.png", "/intranet/game", None),
    ("administration-users.png", "/intranet/admin", "users"),
]


def _login(page) -> None:
    page.goto(f"{BASE}/login", wait_until="networkidle")
    page.fill('input[name="email"]', EMAIL)
    page.fill('input[name="password"]', PASSWORD)
    page.click('button[type="submit"]')
    page.wait_for_url("**/intranet/**", timeout=30000)


def _open_admin_users(page) -> None:
    users_tab = page.locator("#admin-tab-users")
    if users_tab.count():
        users_tab.click()
        page.wait_for_timeout(400)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport=VIEWPORT)
        _login(page)
        for name, path, extra in SHOTS:
            page.goto(f"{BASE}{path}", wait_until="networkidle")
            page.wait_for_timeout(500)
            if extra == "users":
                _open_admin_users(page)
            out = OUT / name
            page.screenshot(path=str(out), full_page=False)
            print(f"captured {name}")
        browser.close()


if __name__ == "__main__":
    main()
