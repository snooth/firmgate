"""Australian public holidays for calendar overlay (SA, VIC, NSW, QLD, ACT)."""
from __future__ import annotations

import hashlib
from collections import defaultdict
from datetime import date
from typing import Any

try:
    import holidays as holidays_lib
except ImportError:  # pragma: no cover
    holidays_lib = None

# Subdivisions requested for the intranet calendar overlay.
AU_CALENDAR_SUBDIVS: tuple[str, ...] = ("SA", "VIC", "NSW", "QLD", "ACT")

# Always merge these years so Month/Year navigation shows holidays without extra logic.
AU_CALENDAR_PRELOAD_YEARS: tuple[int, ...] = (2026, 2027, 2028)


def _stable_synthetic_id(date_iso: str, title_key: str) -> int:
    """Negative id so it never collides with DB primary keys."""
    h = hashlib.sha256(f"{date_iso}\0{title_key}".encode()).hexdigest()
    return -(int(h[:12], 16) % 2_000_000_000) - 1


def au_public_holiday_events_for_year(year: int) -> list[dict[str, Any]]:
    """
    Return calendar event-shaped dicts for all public holidays in the listed states
    for ``year``. Users see these regardless of event sharing (merged server-side).
    """
    if holidays_lib is None:
        return []
    if year < 1970 or year > 2100:
        return []

    # date -> holiday_name -> set of subdiv codes
    by_date: dict[date, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))

    for sub in AU_CALENDAR_SUBDIVS:
        try:
            cal = holidays_lib.country_holidays("AU", subdiv=sub, years=[year])
            for d, name in cal.items():
                by_date[d][str(name).strip() or "Public holiday"].add(sub)
        except Exception:
            continue

    out: list[dict[str, Any]] = []
    for d in sorted(by_date.keys()):
        nm_map = by_date[d]
        for name in sorted(nm_map.keys()):
            states = ", ".join(sorted(nm_map[name]))
            date_iso = d.isoformat()
            out.append(
                {
                    "id": _stable_synthetic_id(date_iso, name),
                    "date": date_iso,
                    "start": "",
                    "end": "",
                    "title": f"[Public holiday] {name}",
                    "allDay": True,
                    "location": states,
                    "notes": f"Public holiday in {states} (SA, VIC, NSW, QLD, ACT subset).",
                    "mine": False,
                    "shared_count": 0,
                    "shared_user_ids": [],
                    "shared_group_ids": [],
                    "publicHoliday": True,
                }
            )
    return out


def au_public_holiday_events_for_calendar_view(year: int) -> list[dict[str, Any]]:
    """
    Public holiday rows for the preload window (see ``AU_CALENDAR_PRELOAD_YEARS``)
    plus the calendar ``year`` being viewed (union, no duplicates across calls —
    same-year holidays appear once).
    """
    years = set(AU_CALENDAR_PRELOAD_YEARS)
    if 1970 <= year <= 2100:
        years.add(year)
    out: list[dict[str, Any]] = []
    for y in sorted(years):
        out.extend(au_public_holiday_events_for_year(y))
    return out
