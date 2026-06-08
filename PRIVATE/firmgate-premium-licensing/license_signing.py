"""Ed25519 enterprise license signing — vendor tooling only (never publish)."""

from __future__ import annotations

import base64
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in (here.parent, here.parent.parent):
        if (candidate / "app" / "premium_license.py").is_file():
            return candidate
    return here.parent


APP_ROOT = _repo_root()
if str(APP_ROOT) not in sys.path:
    sys.path.insert(0, str(APP_ROOT))

from app.premium_license import LICENSE_PREFIX, build_license_body  # noqa: E402


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _private_key_path() -> Path:
    env = (os.environ.get("FIRMGATE_LICENSE_PRIVATE_KEY") or "").strip()
    if env:
        return Path(env).expanduser()
    return Path(__file__).with_name("enterprise_license_private.pem")


def load_private_key() -> Ed25519PrivateKey:
    path = _private_key_path()
    if not path.is_file():
        raise FileNotFoundError(
            f"Private signing key not found: {path}\n"
            "Run ./generate_keypair.py once to create vendor keys."
        )
    data = path.read_bytes()
    key = serialization.load_pem_private_key(data, password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise TypeError("Enterprise license private key must be Ed25519")
    return key


def sign_license_key(
    *,
    features: list[str],
    expires: str | None = None,
    subject: str = "",
) -> str:
    body = build_license_body(features=features, expires=expires, subject=subject)
    private_key = load_private_key()
    sig = private_key.sign(body)
    return f"{LICENSE_PREFIX}.{_b64url_encode(body)}.{_b64url_encode(sig)}"


def generate_keypair_files(
    *,
    private_path: Path | None = None,
    public_b64_path: Path | None = None,
) -> tuple[Path, Path]:
    private_path = private_path or _private_key_path()
    public_b64_path = public_b64_path or APP_ROOT / "app" / "enterprise_license_public.b64"

    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()

    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    private_path.parent.mkdir(parents=True, exist_ok=True)
    private_path.write_bytes(pem)
    try:
        os.chmod(private_path, 0o600)
    except OSError:
        pass

    pub_raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    public_b64_path.parent.mkdir(parents=True, exist_ok=True)
    public_b64_path.write_text(base64.b64encode(pub_raw).decode("ascii") + "\n", encoding="utf-8")

    return private_path, public_b64_path
