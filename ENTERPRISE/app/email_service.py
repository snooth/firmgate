"""SMTP outbound email (admin-configured)."""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from typing import Any

from app.settings import get_setting, set_setting

SETTING_KEY = "email"

# Presets shown in Admin → Email Settings (provider dropdown).
EMAIL_PROVIDER_PRESETS: dict[str, dict[str, Any]] = {
    "custom": {
        "label": "Custom SMTP",
        "smtp_host": "",
        "smtp_port": 587,
        "use_tls": True,
        "use_ssl": False,
        "help": [],
    },
    "office365": {
        "label": "Microsoft 365 / Office 365",
        "smtp_host": "smtp.office365.com",
        "smtp_port": 587,
        "use_tls": True,
        "use_ssl": False,
        "help": [
            "Host smtp.office365.com, port 587, STARTTLS enabled (defaults below).",
            "Username must be the full mailbox email (same as “From email” unless you use Send As).",
            "Password is the mailbox password, or an app password if MFA is enabled and your tenant allows it.",
            "In Microsoft 365 admin: enable SMTP AUTH for this mailbox (Mail → Manage email apps → Authenticated SMTP).",
            "The From address must be a licensed mailbox that is allowed to send via SMTP AUTH.",
            "If basic authentication is disabled tenant-wide, use a custom SMTP relay or enable SMTP AUTH for this account.",
        ],
    },
    "gmail": {
        "label": "Google Workspace / Gmail",
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 587,
        "use_tls": True,
        "use_ssl": False,
        "help": [
            "Use an app password if the account has 2-step verification (Google Account → Security → App passwords).",
            "Username is the full Gmail / Workspace address.",
        ],
    },
}


def _coerce_settings(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def _normalize_provider(raw: Any) -> str:
    key = ("" if raw is None else str(raw)).strip().lower()
    return key if key in EMAIL_PROVIDER_PRESETS else "custom"


def get_email_settings() -> dict[str, Any]:
    return _coerce_settings(get_setting(SETTING_KEY, default={}))


def email_providers_for_api() -> list[dict[str, Any]]:
    return [
        {
            "id": pid,
            "label": preset["label"],
            "smtp_host": preset.get("smtp_host") or "",
            "smtp_port": int(preset.get("smtp_port") or 587),
            "use_tls": bool(preset.get("use_tls", True)),
            "use_ssl": bool(preset.get("use_ssl")),
            "help": list(preset.get("help") or []),
        }
        for pid, preset in EMAIL_PROVIDER_PRESETS.items()
    ]


def email_settings_for_api() -> dict[str, Any]:
    v = get_email_settings()
    port = v.get("smtp_port")
    try:
        smtp_port = int(port) if port is not None else 587
    except (TypeError, ValueError):
        smtp_port = 587
    provider = _normalize_provider(v.get("provider"))
    if provider == "custom" and not v.get("provider"):
        host = (v.get("smtp_host") or "").strip().lower()
        if host in ("smtp.office365.com", "smtp-mail.outlook.com"):
            provider = "office365"
        elif host == "smtp.gmail.com":
            provider = "gmail"
    return {
        "provider": provider,
        "providers": email_providers_for_api(),
        "enabled": bool(v.get("enabled")),
        "smtp_host": (v.get("smtp_host") or "").strip(),
        "smtp_port": smtp_port,
        "use_tls": bool(v.get("use_tls", True)),
        "use_ssl": bool(v.get("use_ssl")),
        "skip_tls_verify": bool(v.get("skip_tls_verify")),
        "username": (v.get("username") or "").strip(),
        "password_set": bool(v.get("password")),
        "from_email": (v.get("from_email") or "").strip(),
        "from_name": (v.get("from_name") or "").strip(),
        "default_reply_to": (v.get("default_reply_to") or "").strip(),
    }


def save_email_settings(payload: dict[str, Any]) -> dict[str, Any] | tuple[dict[str, str], int]:
    existing = get_email_settings()
    enabled = bool(payload.get("enabled"))
    provider = _normalize_provider(payload.get("provider"))
    preset = EMAIL_PROVIDER_PRESETS.get(provider) or EMAIL_PROVIDER_PRESETS["custom"]

    smtp_host = (payload.get("smtp_host") or "").strip()
    if not smtp_host and preset.get("smtp_host"):
        smtp_host = str(preset["smtp_host"]).strip()

    try:
        smtp_port = int(payload.get("smtp_port") or preset.get("smtp_port") or 587)
    except (TypeError, ValueError):
        return {"error": "smtp_port must be a number"}, 400
    if smtp_port < 1 or smtp_port > 65535:
        return {"error": "smtp_port must be between 1 and 65535"}, 400

    use_ssl = bool(payload.get("use_ssl")) if "use_ssl" in payload else bool(preset.get("use_ssl"))
    if "use_tls" in payload:
        use_tls = bool(payload.get("use_tls")) if not use_ssl else False
    else:
        use_tls = bool(preset.get("use_tls", True)) if not use_ssl else False

    skip_tls_verify = bool(payload.get("skip_tls_verify"))
    username = (payload.get("username") or "").strip()
    from_email = (payload.get("from_email") or "").strip()
    from_name = (payload.get("from_name") or "").strip()
    default_reply_to = (payload.get("default_reply_to") or "").strip()

    pw_in = payload.get("password")
    if isinstance(pw_in, str) and pw_in.strip() != "":
        password = pw_in
    else:
        password = existing.get("password") or ""

    if enabled:
        if not smtp_host:
            return {"error": "SMTP host is required when email is enabled"}, 400
        if not from_email or "@" not in from_email:
            return {"error": "From email address is required when email is enabled"}, 400
        if provider in ("office365", "gmail") and not username:
            return {
                "error": "SMTP username (mailbox email) is required for Microsoft 365 / Gmail",
            }, 400
        if provider in ("office365", "gmail") and not password:
            return {"error": "SMTP password is required when email is enabled"}, 400

    set_setting(
        SETTING_KEY,
        {
            "provider": provider,
            "enabled": enabled,
            "smtp_host": smtp_host,
            "smtp_port": smtp_port,
            "use_tls": use_tls,
            "use_ssl": use_ssl,
            "skip_tls_verify": skip_tls_verify,
            "username": username,
            "password": password,
            "from_email": from_email,
            "from_name": from_name,
            "default_reply_to": default_reply_to,
        },
    )
    return email_settings_for_api()


def _ssl_context(skip_verify: bool) -> ssl.SSLContext:
    if skip_verify:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def _format_send_error(exc: BaseException, settings: dict[str, Any]) -> str:
    msg = str(exc)
    provider = _normalize_provider(settings.get("provider"))
    hints: list[str] = []

    if isinstance(exc, ssl.SSLError) or "CERTIFICATE_VERIFY_FAILED" in msg or "certificate verify failed" in msg.lower():
        hints.append(
            "TLS certificate verification failed. On macOS or minimal Linux images, run: "
            "pip install certifi, then restart the app. For local dev only, you can enable "
            "“Skip TLS certificate verification”, save, and test again."
        )
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        if provider == "office365":
            hints.append(
                "Microsoft 365: confirm SMTP AUTH is enabled for the mailbox, username is the full email, "
                "and the password is correct (app password if MFA). Check tenant policies for basic auth / SMTP AUTH."
            )
        elif provider == "gmail":
            hints.append("Gmail: use an app password if 2-step verification is on.")
    if hints:
        return f"{msg} — {' '.join(hints)}"
    return msg


def send_email(
    *,
    to_addrs: list[str],
    subject: str,
    body: str,
    html_body: str | None = None,
    settings: dict[str, Any] | None = None,
) -> tuple[bool, str]:
    v = _coerce_settings(settings) if settings is not None else get_email_settings()
    if not v.get("enabled"):
        return False, "Outbound email is not enabled."

    host = (v.get("smtp_host") or "").strip()
    if not host:
        return False, "SMTP host is not configured."

    try:
        port = int(v.get("smtp_port") or 587)
    except (TypeError, ValueError):
        port = 587

    from_email = (v.get("from_email") or "").strip()
    if not from_email:
        return False, "From email address is not configured."

    recipients = [a.strip() for a in to_addrs if (a or "").strip()]
    if not recipients:
        return False, "No recipients."

    from_name = (v.get("from_name") or "").strip()
    reply_to = (v.get("default_reply_to") or "").strip()
    username = (v.get("username") or "").strip()
    password = v.get("password") or ""
    use_ssl = bool(v.get("use_ssl"))
    use_tls = bool(v.get("use_tls")) and not use_ssl
    skip_verify = bool(v.get("skip_tls_verify"))

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((from_name, from_email)) if from_name else from_email
    msg["To"] = ", ".join(recipients)
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(body)
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    try:
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, timeout=30, context=_ssl_context(skip_verify)) as smtp:
                if username:
                    smtp.login(username, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                smtp.ehlo()
                if use_tls:
                    smtp.starttls(context=_ssl_context(skip_verify))
                    smtp.ehlo()
                if username:
                    smtp.login(username, password)
                smtp.send_message(msg)
    except smtplib.SMTPException as e:
        return False, f"SMTP error: {_format_send_error(e, v)}"
    except (ssl.SSLError, OSError) as e:
        label = "TLS error" if isinstance(e, ssl.SSLError) else "Connection error"
        return False, f"{label}: {_format_send_error(e, v)}"

    return True, f"Message sent to {', '.join(recipients)}."


def send_test_email(to_addr: str) -> tuple[bool, str]:
    return send_email(
        to_addrs=[to_addr],
        subject="Firmgate email test",
        body="This is a test message from your intranet Email Settings.",
    )
