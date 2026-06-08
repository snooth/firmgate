"""Helpers for security-encryption admin (validate RSA public key PEM). File pipeline integration is separate."""
from __future__ import annotations

import hashlib


def normalize_public_key_pem(pem: str) -> str:
    s = (pem or "").strip()
    if not s:
        return ""
    return s


def validate_rsa_public_key_pem(pem: str) -> tuple[bool, str | None, str | None]:
    """
    Return (ok, fingerprint_hex16, error_message).
    Fingerprint: first 16 hex chars of SHA-256 of normalized PEM bytes.
    """
    pem = normalize_public_key_pem(pem)
    if not pem:
        return False, None, "Public key is empty"
    if "BEGIN" not in pem or "PUBLIC KEY" not in pem:
        return False, None, "Expected PEM text starting with -----BEGIN PUBLIC KEY----- or -----BEGIN RSA PUBLIC KEY-----"

    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        return (
            False,
            None,
            "Python package 'cryptography' is missing on this server. SSH to the host that runs Firmgate, "
            "activate its virtualenv (if any), then run: pip install -r requirements.txt "
            "(or pip install 'cryptography>=42.0.0'). Restart the app service (e.g. gunicorn/systemd).",
        )

    try:
        key = serialization.load_pem_public_key(pem.encode("utf-8"))
    except Exception as e:
        return False, None, f"Invalid PEM: {e}"

    if not isinstance(key, rsa.RSAPublicKey):
        return False, None, "Key must be an RSA public key"

    fp = hashlib.sha256(pem.encode("utf-8")).hexdigest()[:16]
    return True, fp, None
