"""Australian public holidays for timesheets (SA, VIC, NSW, QLD, ACT)."""

from __future__ import annotations

from collections import defaultdict
from datetime import date

try:
    import holidays as holidays_lib
except ImportError:  # pragma: no cover
    holidays_lib = None

TIMESHEET_AU_SUBDIVS: tuple[str, ...] = ("SA", "VIC", "NSW", "QLD", "ACT")
DEFAULT_TIMESHEET_STATE = "VIC"


def normalize_state(raw: str | None) -> str | None:
    code = str(raw or "").strip().upper()
    if code in TIMESHEET_AU_SUBDIVS:
        return code
    return None


def _pad2(n: int) -> str:
    return f"{n:02d}"


def _fmt_key(d: date) -> str:
    return f"{d.year}-{_pad2(d.month)}-{_pad2(d.day)}"


def _label_for_date_names(names_map: dict[str, set[str]]) -> str:
    names = sorted(names_map.keys())
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    return " / ".join(names)


def _holidays_for_subdiv(sub: str, year: int) -> dict[date, str]:
    if holidays_lib is None:
        return {}
    try:
        return dict(holidays_lib.country_holidays("AU", subdiv=sub, years=[year]))
    except Exception:
        return {}


def holidays_lookup_for_year(year: int, state: str | None = None) -> dict[str, str]:
    """Map ``YYYY-MM-DD`` to a display label for the given calendar year."""
    if year < 1970 or year > 2100:
        return {}

    subdivs = [normalize_state(state)] if state else list(TIMESHEET_AU_SUBDIVS)
    subdivs = [s for s in subdivs if s]
    if not subdivs:
        return {}

    if len(subdivs) == 1:
        out: dict[str, str] = {}
        sub = subdivs[0]
        for d, name in _holidays_for_subdiv(sub, year).items():
            nm = str(name).strip() or "Public holiday"
            out[_fmt_key(d)] = nm
        return out

    if holidays_lib is None:
        return {}

    by_date: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for sub in subdivs:
        for d, name in _holidays_for_subdiv(sub, year).items():
            nm = str(name).strip() or "Public holiday"
            by_date[_fmt_key(d)][nm].add(sub)

    out: dict[str, str] = {}
    for key, names in by_date.items():
        label = _label_for_date_names(names)
        if label:
            out[key] = label
    return out


def holiday_name(d: date, state: str | None = None) -> str:
    return holidays_lookup_for_year(d.year, state=state).get(_fmt_key(d), "")


def holiday_name_vic(d: date) -> str:
    """Backward-compatible alias."""
    return holiday_name(d, state="VIC")


def holidays_for_year(year: int, state: str | None = None) -> list[dict[str, str]]:
    """Public holidays for a calendar year (sorted)."""
    lookup = holidays_lookup_for_year(year, state=state)
    out: list[dict[str, str]] = []
    for key in sorted(lookup.keys()):
        d = date.fromisoformat(key)
        out.append(
            {
                "date": key,
                "label": lookup[key],
                "display_date": d.strftime("%d %b %Y"),
            }
        )
    return out


def parse_iso_date(raw: str) -> date | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def fmt_period_date(d: date) -> str:
    return d.strftime("%b %d, %Y")


def fmt_row_date(d: date) -> str:
    wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d.weekday()]
    mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.month - 1]
    return f"{wd}-{d.day}-{mon}"


def is_weekend(d: date) -> bool:
    return d.weekday() >= 5
