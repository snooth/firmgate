"""Enterprise license verification tests (stdlib unittest)."""

from __future__ import annotations

import base64
import os
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

_TEST_PRIVATE = Ed25519PrivateKey.generate()
_TEST_PUBLIC_B64 = base64.b64encode(
    _TEST_PRIVATE.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
).decode("ascii")
from app import create_app  # noqa: E402
from app.premium_license import (  # noqa: E402
    FEATURE_OFFICE365,
    LICENSE_PREFIX,
    apply_license_key,
    build_license_body,
    clear_license,
    feature_enabled,
    licensed_features,
    revoke_license_key,
    verify_license_key,
)


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _sign_test_license(
    *,
    features: list[str],
    expires: str | None = None,
    subject: str = "",
) -> str:
    body = build_license_body(features=features, expires=expires, subject=subject)
    sig = _TEST_PRIVATE.sign(body)
    return f"{LICENSE_PREFIX}.{_b64url_encode(body)}.{_b64url_encode(sig)}"


class PremiumLicenseTests(unittest.TestCase):
    def setUp(self):
        self._prev_public_key = os.environ.get("FIRMGATE_LICENSE_PUBLIC_KEY")
        os.environ["FIRMGATE_LICENSE_PUBLIC_KEY"] = _TEST_PUBLIC_B64
        self.app = create_app()
        self.app.config["TESTING"] = True
        self.ctx = self.app.app_context()
        self.ctx.push()

    def tearDown(self):
        clear_license()
        self.ctx.pop()
        if self._prev_public_key is None:
            os.environ.pop("FIRMGATE_LICENSE_PUBLIC_KEY", None)
        else:
            os.environ["FIRMGATE_LICENSE_PUBLIC_KEY"] = self._prev_public_key

    def test_round_trip_key(self):
        key = _sign_test_license(
            features=[FEATURE_OFFICE365], expires="2099-12-31", subject="Test"
        )
        state, err = verify_license_key(key)
        self.assertEqual(err, "")
        self.assertIsNotNone(state)
        assert state is not None
        self.assertIn(FEATURE_OFFICE365, state["features"])

    def test_tampered_signature_rejected(self):
        key = _sign_test_license(features=[FEATURE_OFFICE365])
        bad = key[:-4] + "AAAA"
        state, err = verify_license_key(bad)
        self.assertIsNone(state)
        self.assertIn("signature", err.lower())

    def test_legacy_fg1_rejected(self):
        state, err = verify_license_key("FG1-deadbeef")
        self.assertIsNone(state)
        self.assertIn("FG1", err)

    def test_db_tamper_without_key_does_not_enable(self):
        key = _sign_test_license(features=[FEATURE_OFFICE365])
        apply_license_key(key)
        self.assertTrue(feature_enabled(FEATURE_OFFICE365))
        from app.settings import set_setting

        set_setting(
            "premium_license",
            {"valid": True, "features": [FEATURE_OFFICE365, "ldap"]},
        )
        self.assertFalse(feature_enabled("ldap"))
        self.assertFalse(feature_enabled(FEATURE_OFFICE365))

    def test_apply_and_clear(self):
        key = _sign_test_license(features=[FEATURE_OFFICE365])
        state, err = apply_license_key(key)
        self.assertEqual(err, "")
        self.assertIsNotNone(state)
        self.assertEqual(licensed_features(), {FEATURE_OFFICE365})
        clear_license()
        self.assertEqual(licensed_features(), set())

    def test_revoked_key_rejected(self):
        key = _sign_test_license(features=[FEATURE_OFFICE365], expires="2099-12-31")
        apply_license_key(key)
        revoke_license_key(key, reason="test")
        clear_license()
        state, err = verify_license_key(key)
        self.assertIsNone(state)
        self.assertIn("revoked", err.lower())
        apply_state, apply_err = apply_license_key(key)
        self.assertIsNone(apply_state)
        self.assertIn("revoked", apply_err.lower())


if __name__ == "__main__":
    unittest.main()
