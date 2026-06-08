"""Deactivate the factory bootstrap account once another administrator exists."""

from __future__ import annotations

FACTORY_BOOTSTRAP_ATTR = "factory_bootstrap"


def user_is_factory_bootstrap(user) -> bool:
    attrs = user.attributes if isinstance(user.attributes, dict) else {}
    if attrs.get(FACTORY_BOOTSTRAP_ATTR) is True:
        return True
    # Legacy rows created before the flag was stored
    return (user.email or "").strip().lower() == "admin@example.com"


def sync_factory_bootstrap_accounts(db_session) -> int:
    """
    For each active factory-bootstrap user, set is_active=False if another active user has admin.all.

    Returns how many users were deactivated (0 or 1 in normal setups).
    """
    from app import rbac
    from app.models import User

    all_users = db_session.query(User).all()
    factory_users = [u for u in all_users if user_is_factory_bootstrap(u)]
    if not factory_users:
        return 0

    def other_active_admins(exclude_id: int) -> bool:
        for u in all_users:
            if not u.is_active or u.id == exclude_id:
                continue
            if rbac.user_has_permission(u, rbac.PERMISSION_ADMIN):
                return True
        return False

    disabled = 0
    for fu in factory_users:
        if not fu.is_active:
            continue
        if other_active_admins(fu.id):
            fu.is_active = False
            db_session.add(fu)
            disabled += 1
    return disabled
