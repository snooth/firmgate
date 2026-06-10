"""Resource Calculator — daily rate card with loaded cost by AU state/territory."""

from __future__ import annotations

from typing import Any

AU_WORK_STATES = ("ACT", "NSW", "VIC", "QLD", "SA", "WA", "NT")

DEFAULT_DAYS_PER_YEAR = 220.0
DEFAULT_HOURS_PER_DAY = 8.0
DEFAULT_SUPER_PERCENT = 12.0

# Indicative rates (% of contractor daily). Adjust in code if your org updates benchmarks.
_DEFAULT_STATE_RATES: dict[str, dict[str, float]] = {
    "ACT": {"payroll_tax_percent": 6.85, "workers_comp_percent": 0.25},
    "NSW": {"payroll_tax_percent": 5.45, "workers_comp_percent": 0.25},
    "VIC": {"payroll_tax_percent": 4.85, "workers_comp_percent": 0.25},
    "QLD": {"payroll_tax_percent": 4.75, "workers_comp_percent": 0.25},
    "SA": {"payroll_tax_percent": 4.95, "workers_comp_percent": 0.25},
    "WA": {"payroll_tax_percent": 5.65, "workers_comp_percent": 0.25},
    "NT": {"payroll_tax_percent": 5.65, "workers_comp_percent": 0.25},
}


def default_settings() -> dict[str, Any]:
    return {
        "super_percent": DEFAULT_SUPER_PERCENT,
        "days_per_year": DEFAULT_DAYS_PER_YEAR,
        "hours_per_day": DEFAULT_HOURS_PER_DAY,
        "profit_margin_percent": 0.0,
        "states": {k: dict(v) for k, v in _DEFAULT_STATE_RATES.items()},
    }


def build_rate_card_bootstrap() -> dict[str, Any]:
    cfg = default_settings()
    return {
        "states": list(AU_WORK_STATES),
        "settings": {
            "super_percent": cfg["super_percent"],
            "days_per_year": cfg["days_per_year"],
            "hours_per_day": cfg["hours_per_day"],
            "state_rates": cfg["states"],
        },
    }


def calculate_rate_card(
    *,
    loaded_daily: float,
    work_state: str,
    is_contractor: bool = False,
    days_per_year: float | None = None,
    settings: dict[str, Any] | None = None,
    daily_rate: float | None = None,
) -> dict[str, Any]:
    """Calculate casual rate from contractor daily charge minus on-cost percentages."""
    rate = _resolve_loaded_daily(loaded_daily, daily_rate)
    cfg = settings if isinstance(settings, dict) else default_settings()
    dpy = max(1.0, _num(days_per_year, cfg.get("days_per_year", DEFAULT_DAYS_PER_YEAR)))
    st = str(work_state or "").strip().upper()
    if rate <= 0:
        return {
            "ok": False,
            "work_state": st,
            "loaded_daily": round(rate, 2),
            "days_per_year": round(dpy, 1),
            "message": "Enter a loaded daily rate greater than zero.",
        }
    if st not in AU_WORK_STATES:
        return {
            "ok": False,
            "work_state": st,
            "loaded_daily": round(rate, 2),
            "days_per_year": round(dpy, 1),
            "loaded_annual": round(rate * dpy, 2),
            "message": "Select a work state (ACT, NSW, VIC, QLD, SA, WA, NT).",
        }
    return _calculate_from_loaded_daily(rate, st, is_contractor, dpy, cfg)


def calculate_rate_card_all_states(
    *,
    loaded_daily: float,
    is_contractor: bool = False,
    days_per_year: float | None = None,
    settings: dict[str, Any] | None = None,
    daily_rate: float | None = None,
) -> dict[str, Any]:
    rate = _resolve_loaded_daily(loaded_daily, daily_rate)
    cfg = settings if isinstance(settings, dict) else default_settings()
    dpy = max(1.0, _num(days_per_year, cfg.get("days_per_year", DEFAULT_DAYS_PER_YEAR)))
    if rate <= 0:
        return {
            "ok": False,
            "loaded_daily": 0.0,
            "days_per_year": round(dpy, 1),
            "rows": [],
            "message": "Enter a loaded daily rate.",
        }
    rows = [_calculate_from_loaded_daily(rate, st, is_contractor, dpy, cfg) for st in AU_WORK_STATES]
    return {
        "ok": True,
        "loaded_daily": round(rate, 2),
        "days_per_year": round(dpy, 1),
        "is_contractor": bool(is_contractor),
        "rows": rows,
    }


def _resolve_loaded_daily(loaded_daily: float, daily_rate: float | None) -> float:
    if loaded_daily and float(loaded_daily) > 0:
        return max(0.0, float(loaded_daily))
    if daily_rate and float(daily_rate) > 0:
        return max(0.0, float(daily_rate))
    return max(0.0, float(loaded_daily or 0.0))


def _calculate_from_loaded_daily(
    loaded_daily: float,
    st: str,
    is_contractor: bool,
    days_per_year: float,
    settings: dict[str, Any],
) -> dict[str, Any]:
    state_rates = settings.get("states") if isinstance(settings.get("states"), dict) else {}
    rates = state_rates.get(st) if isinstance(state_rates.get(st), dict) else {}
    super_pct = _num(settings.get("super_percent"), DEFAULT_SUPER_PERCENT) / 100.0
    payroll_pct = _num(rates.get("payroll_tax_percent"), 0.0) / 100.0
    wc_pct = _num(rates.get("workers_comp_percent"), 0.0) / 100.0
    profit_pct = _num(settings.get("profit_margin_percent"), 0.0) / 100.0
    dpy = max(1.0, days_per_year)
    contractor_daily = float(loaded_daily)
    contractor_annual = contractor_daily * dpy

    super_daily = contractor_daily * super_pct
    payroll_tax_daily = contractor_daily * payroll_pct
    workers_comp_daily = contractor_daily * wc_pct
    profit_daily = contractor_daily * profit_pct
    obligations_daily = super_daily + payroll_tax_daily + workers_comp_daily + profit_daily
    obligations_annual = obligations_daily * dpy

    super_amt = super_daily * dpy
    payroll_tax = payroll_tax_daily * dpy
    workers_comp = workers_comp_daily * dpy
    profit_amt = profit_daily * dpy

    if is_contractor:
        resulting_charge_daily = contractor_daily
        resulting_charge_annual = contractor_annual
    else:
        resulting_charge_daily = max(0.0, contractor_daily - obligations_daily)
        resulting_charge_annual = resulting_charge_daily * dpy

    hours_per_day = max(0.1, _num(settings.get("hours_per_day"), DEFAULT_HOURS_PER_DAY))
    resulting_charge_hourly = resulting_charge_daily / hours_per_day
    margin_percent = (
        (obligations_daily / resulting_charge_daily) * 100.0
        if resulting_charge_daily > 0
        else ((obligations_daily / contractor_daily) * 100.0 if contractor_daily > 0 else 0.0)
    )

    return {
        "ok": True,
        "is_contractor": bool(is_contractor),
        "work_state": st,
        "loaded_daily": round(contractor_daily, 2),
        "base_daily": round(resulting_charge_daily, 2),
        "resulting_charge_daily": round(resulting_charge_daily, 2),
        "resulting_charge_annual": round(resulting_charge_annual, 2),
        "resulting_charge_hourly": round(resulting_charge_hourly, 2),
        "hours_per_day": round(hours_per_day, 2),
        "daily_rate": round(resulting_charge_daily, 2),
        "days_per_year": round(dpy, 1),
        "base_annual": round(resulting_charge_annual, 2),
        "super": round(super_amt, 2),
        "super_percent": round(super_pct * 100.0, 2),
        "payroll_tax": round(payroll_tax, 2),
        "payroll_tax_percent": round(payroll_pct * 100.0, 2),
        "workers_comp": round(workers_comp, 2),
        "workers_comp_percent": round(wc_pct * 100.0, 2),
        "profit": round(profit_amt, 2),
        "profit_margin_percent": round(profit_pct * 100.0, 2),
        "loaded_annual": round(contractor_annual, 2),
        "loaded_monthly": round(contractor_annual / 12.0, 2),
        "margin_percent": round(margin_percent, 1),
        "margin_value_daily": round(obligations_daily, 2),
        "margin_value_annual": round(obligations_annual, 2),
        "super_daily": round(super_daily, 2),
        "payroll_tax_daily": round(payroll_tax_daily, 2),
        "workers_comp_daily": round(workers_comp_daily, 2),
        "profit_daily": round(profit_daily, 2),
    }


def _num(v: Any, default: float = 0.0) -> float:
    try:
        if v is None or v == "":
            return float(default)
        return float(v)
    except (TypeError, ValueError):
        return float(default)
