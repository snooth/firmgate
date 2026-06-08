"""Back-compat shim — licensing portal users live in vendor_users.py."""

from vendor_users import (  # noqa: F401
    ROLE_ADMIN,
    ROLE_OPERATOR,
    admin_count,
    create_user,
    delete_user,
    effective_username,
    ensure_users_store,
    env_password,
    env_username,
    get_user_by_id,
    get_user_by_username,
    is_admin,
    list_users_public,
    profile_public,
    update_credentials,
    update_profile,
    verify_login,
)
