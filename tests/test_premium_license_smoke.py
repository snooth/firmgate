"""Public-safe license checks: rejection paths only (no signing examples)."""

from __future__ import annotations

import unittest

# Uses app/enterprise_license_public.b64 (do not set FIRMGATE_LICENSE_PUBLIC_KEY here).

from app.premium_license import verify_license_key  # noqa: E402


class PremiumLicenseSmokeTests(unittest.TestCase):
    def test_empty_key_rejected(self):
        state, err = verify_license_key("")
        self.assertIsNone(state)
        self.assertTrue(err)

    def test_legacy_fg1_rejected(self):
        state, err = verify_license_key("FG1-deadbeef")
        self.assertIsNone(state)
        self.assertIn("FG1", err)

    def test_malformed_fg2_rejected(self):
        state, err = verify_license_key("FG2.not-valid")
        self.assertIsNone(state)
        self.assertTrue(err)

    def test_wrong_signature_rejected(self):
        # Valid-looking FG2 shape with a bogus signature (not a signing recipe).
        state, err = verify_license_key(
            "FG2.eyJmIjpbIm9mZmljZTM2NSJdLCJ2IjoyfQ"
            ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        )
        self.assertIsNone(state)
        self.assertIn("signature", err.lower())


if __name__ == "__main__":
    unittest.main()
