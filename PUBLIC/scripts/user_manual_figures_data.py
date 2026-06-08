"""Shared figure list for user manual PNG generation and Word/HTML embedding."""

from __future__ import annotations

FIGURES_DIR = "manual_figures"  # under docs/

# Each figure: display number, filename, heading on placeholder image, instruction subtitle
MANUAL_FIGURES: list[tuple[int, str, str, str]] = [
    (
        1,
        "figure-01.png",
        "Home — signed-in view",
        "Capture full browser window with top navigation",
    ),
    (2, "figure-02.png", "Sign in", "Redact password before sharing this manual"),
    (3, "figure-03.png", "Main navigation", "Show search + module tabs + profile"),
    (4, "figure-04.png", "Home & news", "At least one news card or post"),
    (5, "figure-05.png", "Blogs", "List or open post view"),
    (6, "figure-06.png", "Events (calendar)", "Month view with an event or holiday"),
    (7, "figure-07.png", "Team Chat", "Room list and messages"),
    (8, "figure-08.png", "Workforce / dashboard", "Your most-used screen"),
    (9, "figure-09.png", "Security clearance", "Landing or main page"),
    (10, "figure-10.png", "Security training", "File list + viewer or empty state"),
    (11, "figure-11.png", "Documents", "All files / Home and shared sections"),
    (12, "figure-12.png", "Upload or menu (optional)", "Context menu or upload dialog"),
    (13, "figure-13.png", "CRM", "Main CRM screen"),
    (14, "figure-14.png", "About company", "Public about page"),
    (15, "figure-15.png", "Administration", "Sidebar only — redact secrets"),
]
