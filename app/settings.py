from __future__ import annotations

from app.extensions import db
from app.models import AppSetting


def get_setting(key: str, default=None):
    row = db.session.get(AppSetting, key)
    if not row:
        return default
    return row.value if row.value is not None else default


def set_setting(key: str, value) -> None:
    if key == "premium_license":
        from app.premium_license import sanitize_license_setting_value

        value = sanitize_license_setting_value(value)
    row = db.session.get(AppSetting, key)
    if not row:
        row = AppSetting(key=key, value=value)
        db.session.add(row)
    else:
        row.value = value
    db.session.commit()

