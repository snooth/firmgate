"""Tests for Resource Calculator rate card logic."""

from __future__ import annotations

import unittest

from app.enterprise.resource_calculator_service import (
    AU_WORK_STATES,
    calculate_rate_card,
    calculate_rate_card_all_states,
    default_settings,
)


class ResourceCalculatorTests(unittest.TestCase):
    def test_obligations_are_percent_of_contractor_daily(self):
        settings = default_settings()
        out = calculate_rate_card(
            loaded_daily=1500,
            work_state="VIC",
            is_contractor=False,
            days_per_year=220,
            settings=settings,
        )
        self.assertTrue(out["ok"])
        self.assertAlmostEqual(out["super_daily"], 1500 * 0.12, places=2)
        self.assertAlmostEqual(out["payroll_tax_daily"], 1500 * 0.0485, places=2)
        self.assertAlmostEqual(out["workers_comp_daily"], 1500 * 0.0025, places=2)

    def test_resulting_charge_is_contractor_minus_obligations(self):
        settings = default_settings()
        out = calculate_rate_card(
            loaded_daily=1500,
            work_state="VIC",
            is_contractor=False,
            days_per_year=220,
            settings=settings,
        )
        self.assertTrue(out["ok"])
        obligations = out["super_daily"] + out["payroll_tax_daily"] + out["workers_comp_daily"] + out["profit_daily"]
        self.assertAlmostEqual(out["resulting_charge_daily"], 1500 - obligations, places=2)
        self.assertAlmostEqual(out["resulting_charge_daily"], out["base_daily"], places=2)

    def test_round_trip_loaded_matches(self):
        settings = default_settings()
        out = calculate_rate_card(
            loaded_daily=1778,
            work_state="NSW",
            is_contractor=False,
            days_per_year=220,
            settings=settings,
        )
        self.assertTrue(out["ok"])
        self.assertAlmostEqual(out["loaded_daily"], out["loaded_annual"] / out["days_per_year"], places=0)

    def test_contractor_skips_obligation_deduction(self):
        settings = default_settings()
        employee = calculate_rate_card(loaded_daily=2000, work_state="VIC", is_contractor=False, settings=settings)
        contractor = calculate_rate_card(loaded_daily=2000, work_state="VIC", is_contractor=True, settings=settings)
        self.assertTrue(employee["ok"])
        self.assertTrue(contractor["ok"])
        self.assertAlmostEqual(contractor["resulting_charge_daily"], 2000)
        self.assertLess(employee["resulting_charge_daily"], 2000)
        self.assertGreater(contractor["margin_value_daily"], 0)

    def test_all_states_same_contractor_different_resulting(self):
        out = calculate_rate_card_all_states(loaded_daily=1778, is_contractor=False)
        self.assertTrue(out["ok"])
        self.assertEqual(len(out["rows"]), 7)
        loaded_values = {round(r["loaded_daily"]) for r in out["rows"]}
        self.assertEqual(loaded_values, {1778})
        resulting_values = {r["resulting_charge_daily"] for r in out["rows"]}
        self.assertGreater(len(resulting_values), 1)

    def test_super_is_twelve_percent_all_states(self):
        settings = default_settings()
        for st in AU_WORK_STATES:
            out = calculate_rate_card(
                loaded_daily=1000,
                work_state=st,
                is_contractor=False,
                settings=settings,
            )
            self.assertTrue(out["ok"], st)
            self.assertAlmostEqual(out["super_percent"], 12.0, places=2, msg=st)
            self.assertAlmostEqual(out["super_daily"], 120.0, places=2, msg=st)
            self.assertAlmostEqual(out["workers_comp_percent"], 0.25, places=2, msg=st)
            self.assertAlmostEqual(out["workers_comp_daily"], 2.5, places=2, msg=st)
            obligations = (
                out["super_daily"]
                + out["payroll_tax_daily"]
                + out["workers_comp_daily"]
                + out["profit_daily"]
            )
            self.assertAlmostEqual(out["resulting_charge_daily"], 1000 - obligations, places=2, msg=st)

    def test_missing_loaded_daily(self):
        out = calculate_rate_card(loaded_daily=0, work_state="NSW")
        self.assertFalse(out["ok"])


if __name__ == "__main__":
    unittest.main()
