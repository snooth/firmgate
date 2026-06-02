"""TOTP MFA (Google Authenticator, Microsoft Authenticator, etc.)."""

from __future__ import annotations

import base64
import hashlib
import io
from typing import TYPE_CHECKING

import pyotp
import qrcode
from cryptography.fernet import Fernet, InvalidToken
from flask import current_app

if TYPE_CHECKING:
    from app.models import User

MFA_ATTR_REQUIRED = "mfa_required"
MFA_ATTR_ENROLLED = "mfa_enrolled"
MFA_ATTR_SECRET_ENC = "mfa_secret_enc"


def _user_attrs(user: User) -> dict:
    a = user.attributes
    return a if isinstance(a, dict) else {}


def mfa_required(user: User) -> bool:
    return bool(_user_attrs(user).get(MFA_ATTR_REQUIRED))


def mfa_enrolled(user: User) -> bool:
    attrs = _user_attrs(user)
    return bool(attrs.get(MFA_ATTR_ENROLLED) and attrs.get(MFA_ATTR_SECRET_ENC))


def mfa_pending(user: User) -> bool:
    """User must complete MFA at sign-in (verify or first-time setup)."""
    return mfa_required(user)


def _fernet() -> Fernet:
    pepper = (current_app.config.get("SECRET_KEY") or "dev").encode()
    digest = hashlib.sha256(pepper + b":mfa-totp").digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(secret: str) -> str:
    return _fernet().encrypt(secret.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str) -> str | None:
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, TypeError):
        return None


def get_user_totp_secret(user: User) -> str | None:
    enc = _user_attrs(user).get(MFA_ATTR_SECRET_ENC)
    if not enc or not isinstance(enc, str):
        return None
    return decrypt_secret(enc)


def set_user_totp_secret(user: User, secret: str) -> None:
    attrs = dict(_user_attrs(user))
    attrs[MFA_ATTR_SECRET_ENC] = encrypt_secret(secret)
    attrs[MFA_ATTR_ENROLLED] = True
    user.attributes = attrs


def clear_user_mfa(user: User) -> None:
    attrs = dict(_user_attrs(user))
    attrs.pop(MFA_ATTR_SECRET_ENC, None)
    attrs.pop(MFA_ATTR_ENROLLED, None)
    attrs[MFA_ATTR_REQUIRED] = False
    user.attributes = attrs


def reset_user_mfa_enrollment(user: User) -> None:
    """Clear authenticator enrollment so the user can enroll again (keeps MFA required)."""
    attrs = dict(_user_attrs(user))
    attrs.pop(MFA_ATTR_SECRET_ENC, None)
    attrs[MFA_ATTR_ENROLLED] = False
    user.attributes = attrs


def apply_mfa_required_flag(user: User, required: bool) -> None:
    attrs = dict(_user_attrs(user))
    attrs[MFA_ATTR_REQUIRED] = bool(required)
    if not required:
        attrs.pop(MFA_ATTR_SECRET_ENC, None)
        attrs.pop(MFA_ATTR_ENROLLED, None)
    elif not attrs.get(MFA_ATTR_SECRET_ENC):
        attrs[MFA_ATTR_ENROLLED] = False
    user.attributes = attrs


def generate_secret() -> str:
    return pyotp.random_base32()


def issuer_name() -> str:
    cfg = current_app.config
    return (
        (cfg.get("MFA_ISSUER") or cfg.get("PORTAL_PRODUCT_NAME") or "Firmgate").strip() or "Firmgate"
    )


def provisioning_uri(user: User, secret: str) -> str:
    label = (user.email or user.username or str(user.id)).strip()
    return pyotp.TOTP(secret).provisioning_uri(name=label, issuer_name=issuer_name())


def verify_totp(secret: str, code: str) -> bool:
    code_s = (code or "").strip().replace(" ", "")
    if not code_s.isdigit() or len(code_s) != 6:
        return False
    totp = pyotp.TOTP(secret)
    return bool(totp.verify(code_s, valid_window=1))


def qr_data_url(otpauth_uri: str) -> str:
    img = qrcode.make(otpauth_uri)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{b64}"
