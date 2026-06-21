from __future__ import annotations

import re
from typing import TYPE_CHECKING

_GROUP_COMPANION_ROLE_RE = re.compile(r"^__group_id_(\d+)__$")

if TYPE_CHECKING:
    from app.models import Permission as PermissionModel
    from app.models import User


PERMISSION_FILES_LIST = "files.list"
PERMISSION_FILES_READ = "files.read"
PERMISSION_FILES_WRITE = "files.write"
PERMISSION_FILES_CREATE_FOLDERS = "files.create_folders"
PERMISSION_FILES_DELETE = "files.delete"
PERMISSION_FILES_MOVE = "files.move"
PERMISSION_FILES_SHARE = "files.share"
PERMISSION_FILES_VERSIONS = "files.versions"
PERMISSION_AUDIT_READ = "audit.read"
PERMISSION_FILES_ADMIN = "files.admin"
PERMISSION_ADMIN = "admin.all"
PERMISSION_USERS_CREATE = "users.create"
PERMISSION_USERS_EDIT = "users.edit"
PERMISSION_USERS_DELETE = "users.delete"
PERMISSION_USERS_PASSWORD = "users.password"
PERMISSION_USERS_ROLE = "users.role"
PERMISSION_USERS_RESET_MFA = "users.reset_mfa"
PERMISSION_USERS_MFA = "users.mfa"
PERMISSION_USERS_REGISTRATIONS = "users.registrations"
PERMISSION_USERS_REGISTRATION_NOTIFICATIONS = "users.registration_notifications"

USERS_ADMIN_PERMISSION_NAMES: tuple[str, ...] = (
    PERMISSION_USERS_CREATE,
    PERMISSION_USERS_EDIT,
    PERMISSION_USERS_DELETE,
    PERMISSION_USERS_PASSWORD,
    PERMISSION_USERS_ROLE,
    PERMISSION_USERS_RESET_MFA,
    PERMISSION_USERS_MFA,
    PERMISSION_USERS_REGISTRATIONS,
)

# Blogs
PERMISSION_BLOGS_WRITE = "blogs.write"
PERMISSION_BLOGS_DELETE = "blogs.delete"

# Events
PERMISSION_EVENTS_WRITE = "events.write"
PERMISSION_EVENTS_DELETE = "events.delete"

# Home page announcements
PERMISSION_HOME_WRITE = "home.write"

# Wiki
PERMISSION_WIKI_READ = "wiki.read"
PERMISSION_WIKI_WRITE = "wiki.write"
PERMISSION_WIKI_DELETE = "wiki.delete"
PERMISSION_WIKI_FEEDBACK = "wiki.feedback"

# KanBan
PERMISSION_KANBAN_READ = "kanban.read"
PERMISSION_KANBAN_WRITE = "kanban.write"
PERMISSION_KANBAN_DELETE = "kanban.delete"

# Security clearance (browser-backed records + audit)
PERMISSION_SECURITY_READ = "security.read"
PERMISSION_SECURITY_WRITE = "security.write"
PERMISSION_SECURITY_DELETE = "security.delete"

# CRM (leads)
PERMISSION_CRM_READ = "crm.read"
PERMISSION_CRM_CREATE = "crm.create"
PERMISSION_CRM_DELETE = "crm.delete"

# Workforce (directory, roster edits, contractor companies, project catalog)
PERMISSION_WORKFORCE_READ = "workforce.read"
PERMISSION_WORKFORCE_CREATE = "workforce.create"
PERMISSION_WORKFORCE_DELETE = "workforce.delete"

# Single source of truth for Permission rows and the admin Access Control matrix.
ALL_PERMISSION_NAMES: tuple[str, ...] = (
    PERMISSION_ADMIN,
    PERMISSION_USERS_CREATE,
    PERMISSION_USERS_EDIT,
    PERMISSION_USERS_DELETE,
    PERMISSION_USERS_PASSWORD,
    PERMISSION_USERS_ROLE,
    PERMISSION_USERS_RESET_MFA,
    PERMISSION_USERS_MFA,
    PERMISSION_USERS_REGISTRATIONS,
    PERMISSION_USERS_REGISTRATION_NOTIFICATIONS,
    PERMISSION_AUDIT_READ,
    PERMISSION_FILES_LIST,
    PERMISSION_FILES_READ,
    PERMISSION_FILES_WRITE,
    PERMISSION_FILES_CREATE_FOLDERS,
    PERMISSION_FILES_DELETE,
    PERMISSION_FILES_MOVE,
    PERMISSION_FILES_SHARE,
    PERMISSION_FILES_VERSIONS,
    PERMISSION_FILES_ADMIN,
    PERMISSION_BLOGS_WRITE,
    PERMISSION_BLOGS_DELETE,
    PERMISSION_HOME_WRITE,
    PERMISSION_EVENTS_WRITE,
    PERMISSION_EVENTS_DELETE,
    PERMISSION_WIKI_READ,
    PERMISSION_WIKI_WRITE,
    PERMISSION_WIKI_DELETE,
    PERMISSION_WIKI_FEEDBACK,
    PERMISSION_KANBAN_READ,
    PERMISSION_KANBAN_WRITE,
    PERMISSION_KANBAN_DELETE,
    PERMISSION_SECURITY_READ,
    PERMISSION_SECURITY_WRITE,
    PERMISSION_SECURITY_DELETE,
    PERMISSION_CRM_READ,
    PERMISSION_CRM_CREATE,
    PERMISSION_CRM_DELETE,
    PERMISSION_WORKFORCE_READ,
    PERMISSION_WORKFORCE_CREATE,
    PERMISSION_WORKFORCE_DELETE,
)


def ensure_permission_catalog(db_session) -> tuple[dict[str, PermissionModel], set[str]]:
    """Create any missing Permission rows (e.g. older DBs).

    Returns ``(name → Permission, names_created_this_run)``. The second value is used so
    additive role defaults apply only to brand-new permission rows, not on every request
    (which would undo admin changes in Access Control).
    """
    from app.models import Permission

    by_name: dict[str, Permission] = {}
    created: set[str] = set()
    for name in ALL_PERMISSION_NAMES:
        p = db_session.query(Permission).filter(Permission.name == name).first()
        if not p:
            p = Permission(name=name)
            db_session.add(p)
            db_session.flush()
            created.add(name)
        by_name[name] = p
    return by_name, created


def standard_role(db_session) -> "Role | None":
    from app.models import Role

    return (
        db_session.query(Role).filter(Role.name == "standard").first()
        or db_session.query(Role).filter(Role.name == "viewer").first()
    )


def assign_standard_role(user, db_session) -> None:
    """New intranet accounts start as Standard User until an administrator changes role."""
    ensure_builtin_roles(db_session)
    db_session.flush()
    std = standard_role(db_session)
    if std:
        user.roles = [std]


def primary_builtin_role(user) -> "Role | None":
    """Role shown in Administration UI (admin > standard > power)."""
    from app.models import Role

    roles = list(user.roles or [])
    if not roles:
        return None
    by_name = {(r.name or "").strip().lower(): r for r in roles}
    for name in ("admin", "standard", "viewer", "power", "editor"):
        r = by_name.get(name)
        if r:
            return r
    return roles[0]


def ensure_builtin_roles(db_session) -> None:
    """Ensure ``standard`` and ``power`` roles exist (Administration UI + assignments)."""
    from app.models import Role

    for rn in ("standard", "power"):
        if not db_session.query(Role).filter(Role.name == rn).first():
            db_session.add(Role(name=rn))


def group_companion_role_name(group_id: int) -> str:
    """Stable Role.name for the Access Control matrix row tied to a group (must fit Role.name length)."""
    return f"__group_id_{int(group_id)}__"


def is_group_companion_role_name(name: str | None) -> bool:
    return bool(_GROUP_COMPANION_ROLE_RE.fullmatch((name or "").strip()))


def seed_companion_role_permissions_from_standard(companion_role, db_session) -> None:
    """Copy permission list from the builtin ``standard`` role (Standard User defaults)."""
    from app.models import Role

    std = db_session.query(Role).filter(Role.name == "standard").first()
    if not std:
        return
    companion_role.permissions = list(std.permissions or [])
    db_session.add(companion_role)


def ensure_group_companion_role(group, db_session):
    """Create the per-group companion Role if missing and ensure it is linked to the group."""
    from app.models import Role

    if group.id is None:
        db_session.flush()
    rn = group_companion_role_name(group.id)
    role = db_session.query(Role).filter(Role.name == rn).first()
    if not role:
        role = Role(name=rn)
        db_session.add(role)
        db_session.flush()
        seed_companion_role_permissions_from_standard(role, db_session)
    cur = list(group.roles or [])
    if role not in cur:
        group.roles = cur + [role]
        db_session.add(group)
    return role


def ensure_all_groups_have_companion_roles(db_session) -> None:
    """Attach companion roles for every group (self-heal after upgrades or partial failures)."""
    from app.models import Group

    for g in db_session.query(Group).order_by(Group.id).all():
        ensure_group_companion_role(g, db_session)


GENERAL_GROUP_NAME = "General"
GENERAL_GROUP_DESCRIPTION = "Default group; every user is a member automatically."


def is_general_group(group) -> bool:
    if group is None:
        return False
    return (getattr(group, "name", None) or "").strip().lower() == GENERAL_GROUP_NAME.lower()


def general_group(db_session) -> "Group | None":
    from sqlalchemy import func

    from app.models import Group

    return (
        db_session.query(Group)
        .filter(func.lower(Group.name) == GENERAL_GROUP_NAME.lower())
        .first()
    )


def ensure_general_group(db_session):
    """Create the org-wide General group if missing (with companion role for Access Control)."""
    from app.models import Group

    g = general_group(db_session)
    if g:
        return g
    g = Group(name=GENERAL_GROUP_NAME, description=GENERAL_GROUP_DESCRIPTION)
    db_session.add(g)
    db_session.flush()
    ensure_group_companion_role(g, db_session)
    return g


def ensure_user_in_general_group(user, db_session) -> None:
    """Add user to General without removing other group memberships."""
    g = ensure_general_group(db_session)
    cur = list(user.groups or [])
    if any(is_general_group(x) for x in cur):
        return
    user.groups = cur + [g]
    db_session.add(user)


def ensure_all_users_in_general_group(db_session) -> None:
    """Backfill: every account is a member of General."""
    from app.models import User

    g = ensure_general_group(db_session)
    for u in db_session.query(User).order_by(User.id).all():
        cur = list(u.groups or [])
        if any(is_general_group(x) for x in cur):
            continue
        u.groups = cur + [g]
        db_session.add(u)


def maybe_attach_builtin_roles_for_named_group(group, db_session) -> bool:
    """Attach ``standard`` / ``power`` to conventionally named groups when that builtin is missing.

    Groups always carry a companion role for per-group Access Control; this merges in Standard/Power
    when the group name matches common patterns (see ``ensure_group_companion_role``).
    """
    from app.models import Role

    nm = (group.name or "").strip().lower()
    std = db_session.query(Role).filter(Role.name == "standard").first()
    powr = db_session.query(Role).filter(Role.name == "power").first()
    cur = list(group.roles or [])
    changed = False
    if nm in ("standard users", "standard user") and std and std not in cur:
        cur.append(std)
        changed = True
    elif nm in ("power users", "power user") and powr and powr not in cur:
        cur.append(powr)
        changed = True
    if changed:
        group.roles = cur
        db_session.add(group)
    return changed


def apply_standard_power_permission_defaults(
    db_session,
    by_name: dict[str, PermissionModel],
    *,
    only_add_permissions: frozenset[str] | None = None,
) -> None:
    """
    Additive baseline permissions for Standard and Power roles, plus safety strips.

    ``only_add_permissions``:
      - ``None`` (e.g. ``seed_data``): add every missing permission from the baseline sets.
      - A frozenset (possibly empty): only add permissions whose **names** are in this set
        and are part of the baseline sets — used on app startup / admin list so existing
        installs keep admin edits unless a **new** catalog row was just created.
    """
    from app.models import Role

    want_power = {
        PERMISSION_FILES_LIST,
        PERMISSION_FILES_READ,
        PERMISSION_FILES_WRITE,
        PERMISSION_FILES_DELETE,
        PERMISSION_FILES_MOVE,
        PERMISSION_FILES_SHARE,
        PERMISSION_FILES_VERSIONS,
        PERMISSION_BLOGS_WRITE,
        PERMISSION_HOME_WRITE,
        PERMISSION_EVENTS_WRITE,
        PERMISSION_EVENTS_DELETE,
        PERMISSION_WIKI_READ,
        PERMISSION_WIKI_WRITE,
        PERMISSION_WIKI_DELETE,
        PERMISSION_WIKI_FEEDBACK,
        PERMISSION_KANBAN_READ,
        PERMISSION_KANBAN_WRITE,
        PERMISSION_KANBAN_DELETE,
        PERMISSION_SECURITY_READ,
        PERMISSION_SECURITY_WRITE,
        PERMISSION_SECURITY_DELETE,
        PERMISSION_CRM_READ,
        PERMISSION_CRM_CREATE,
        PERMISSION_CRM_DELETE,
        PERMISSION_WORKFORCE_READ,
        PERMISSION_WORKFORCE_CREATE,
        PERMISSION_WORKFORCE_DELETE,
        PERMISSION_USERS_CREATE,
        PERMISSION_USERS_REGISTRATIONS,
    }
    for role_name in ("power", "editor"):
        editor = db_session.query(Role).filter(Role.name == role_name).first()
        if not editor:
            continue
        cur = {pp.name for pp in (editor.permissions or [])}
        add = [
            by_name[n]
            for n in sorted(want_power)
            if n in by_name
            and n not in cur
            and (only_add_permissions is None or n in only_add_permissions)
        ]
        if add:
            editor.permissions = list(editor.permissions or []) + add
            db_session.add(editor)

    # Self-heal: Power (and legacy editor) keep users.create / users.registrations when rows predate baseline.
    for perm_name in (PERMISSION_USERS_CREATE, PERMISSION_USERS_REGISTRATIONS):
        perm = by_name.get(perm_name)
        if not perm:
            continue
        for role_name in ("power", "editor"):
            role = db_session.query(Role).filter(Role.name == role_name).first()
            if role and perm not in (role.permissions or []):
                role.permissions = list(role.permissions or []) + [perm]
                db_session.add(role)

    viewer = db_session.query(Role).filter(Role.name == "standard").first()
    if viewer:
        want_std = {
            PERMISSION_FILES_LIST,
            PERMISSION_FILES_READ,
            PERMISSION_FILES_CREATE_FOLDERS,
            PERMISSION_BLOGS_WRITE,
            PERMISSION_WIKI_READ,
            PERMISSION_WIKI_WRITE,
            PERMISSION_WIKI_FEEDBACK,
            PERMISSION_KANBAN_READ,
            PERMISSION_KANBAN_WRITE,
            PERMISSION_SECURITY_READ,
            PERMISSION_SECURITY_WRITE,
            PERMISSION_CRM_READ,
            PERMISSION_WORKFORCE_READ,
        }
        cur = {pp.name for pp in (viewer.permissions or [])}
        add = [
            by_name[n]
            for n in sorted(want_std)
            if n in by_name
            and n not in cur
            and (only_add_permissions is None or n in only_add_permissions)
        ]
        if add:
            viewer.permissions = list(viewer.permissions or []) + add
            db_session.add(viewer)

    try:
        bd = by_name.get(PERMISSION_BLOGS_DELETE)
        if bd:
            for rn in ("standard", "power"):
                role = db_session.query(Role).filter(Role.name == rn).first()
                if role and bd in (role.permissions or []):
                    role.permissions = [p for p in (role.permissions or []) if p.id != bd.id]
                    db_session.add(role)
    except Exception:
        pass

    try:
        wd = by_name.get(PERMISSION_WIKI_DELETE)
        if wd:
            for rn in ("standard", "viewer"):
                role = db_session.query(Role).filter(Role.name == rn).first()
                if role and wd in (role.permissions or []):
                    role.permissions = [p for p in (role.permissions or []) if p.id != wd.id]
                    db_session.add(role)
    except Exception:
        pass

    try:
        sd = by_name.get(PERMISSION_SECURITY_DELETE)
        if sd:
            for rn in ("standard", "viewer"):
                role = db_session.query(Role).filter(Role.name == rn).first()
                if role and sd in (role.permissions or []):
                    role.permissions = [p for p in (role.permissions or []) if p.id != sd.id]
                    db_session.add(role)
    except Exception:
        pass

    try:
        cd = by_name.get(PERMISSION_CRM_DELETE)
        if cd:
            for rn in ("standard", "viewer"):
                role = db_session.query(Role).filter(Role.name == rn).first()
                if role and cd in (role.permissions or []):
                    role.permissions = [p for p in (role.permissions or []) if p.id != cd.id]
                    db_session.add(role)
    except Exception:
        pass

    try:
        wfd = by_name.get(PERMISSION_WORKFORCE_DELETE)
        if wfd:
            for rn in ("standard", "viewer"):
                role = db_session.query(Role).filter(Role.name == rn).first()
                if role and wfd in (role.permissions or []):
                    role.permissions = [p for p in (role.permissions or []) if p.id != wfd.id]
                    db_session.add(role)
    except Exception:
        pass

    try:
        adm = by_name.get(PERMISSION_ADMIN)
        if adm:
            for rn in ("standard", "viewer", "power", "editor"):
                role = db_session.query(Role).filter(Role.name == rn).first()
                if role and adm in (role.permissions or []):
                    role.permissions = [p for p in (role.permissions or []) if p.id != adm.id]
                    db_session.add(role)
    except Exception:
        pass

    try:
        adm = by_name.get(PERMISSION_ADMIN)
        if adm:
            for role in db_session.query(Role).all():
                if is_group_companion_role_name(role.name) and adm in (role.permissions or []):
                    role.permissions = [p for p in (role.permissions or []) if p.id != adm.id]
                    db_session.add(role)
    except Exception:
        pass

    try:
        reg_notify = by_name.get(PERMISSION_USERS_REGISTRATION_NOTIFICATIONS)
        if reg_notify:
            for rn in ("standard", "viewer", "power", "editor"):
                role = db.session.query(Role).filter(Role.name == rn).first()
                if role and reg_notify in (role.permissions or []):
                    role.permissions = [p for p in (role.permissions or []) if p.id != reg_notify.id]
                    db.session.add(role)
            for role in db.session.query(Role).all():
                if is_group_companion_role_name(role.name) and reg_notify in (role.permissions or []):
                    role.permissions = [p for p in (role.permissions or []) if p.id != reg_notify.id]
                    db.session.add(role)
    except Exception:
        pass


def _role_grants_permission(role, permission_name: str) -> bool:
    for perm in role.permissions or []:
        if perm.name == PERMISSION_ADMIN or perm.name == permission_name:
            return True
    return False


def _role_name_is_admin(role) -> bool:
    n = (getattr(role, "name", None) or "").strip().lower()
    return n in ("admin", "administrator", "administrators", "site admin", "site administrator")


def user_has_permission(user: User, permission_name: str) -> bool:
    if not user or not user.is_active:
        return False
    for role in user.roles or []:
        if _role_grants_permission(role, permission_name):
            return True
    for group in user.groups or []:
        for role in group.roles or []:
            if _role_grants_permission(role, permission_name):
                return True
    return False


def user_can_create_users(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_USERS_CREATE)


def user_can_approve_registrations(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_USERS_REGISTRATIONS)


def user_can_manage_registration_notifications(user: User) -> bool:
    """Change registration email notification templates and recipients (administrators by default)."""
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(
        user, PERMISSION_USERS_REGISTRATION_NOTIFICATIONS
    )


def user_can_edit_users(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_USERS_EDIT)


def user_can_delete_users(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_USERS_DELETE)


def user_can_change_user_password(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_USERS_PASSWORD)


def user_can_change_user_role(user: User) -> bool:
    """Only full administrators may change another user's role."""
    return user_has_permission(user, PERMISSION_ADMIN)


def user_can_reset_user_mfa(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_USERS_RESET_MFA)


def user_can_manage_user_mfa(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_USERS_MFA)


def user_can_access_users_admin(user: User) -> bool:
    if user_has_permission(user, PERMISSION_ADMIN):
        return True
    return any(user_has_permission(user, name) for name in USERS_ADMIN_PERMISSION_NAMES)


def users_admin_template_context(user: User | None) -> dict[str, bool]:
    """Template / admin UI flags for Users administration."""
    if not user or not getattr(user, "is_active", True):
        return {
            "admin_full_access": False,
            "can_access_users_admin": False,
            "can_create_users": False,
            "can_approve_registrations": False,
            "can_manage_registration_notifications": False,
            "users_can_edit": False,
            "users_can_delete": False,
            "users_can_password": False,
            "users_can_role": False,
            "users_can_reset_mfa": False,
            "users_can_mfa": False,
        }
    full = user_has_permission(user, PERMISSION_ADMIN)
    return {
        "admin_full_access": full,
        "can_access_users_admin": user_can_access_users_admin(user),
        "can_create_users": user_can_create_users(user),
        "can_approve_registrations": user_can_approve_registrations(user),
        "can_manage_registration_notifications": user_can_manage_registration_notifications(user),
        "users_can_edit": user_can_edit_users(user),
        "users_can_delete": user_can_delete_users(user),
        "users_can_password": user_can_change_user_password(user),
        "users_can_role": user_can_change_user_role(user),
        "users_can_reset_mfa": user_can_reset_user_mfa(user),
        "users_can_mfa": user_can_manage_user_mfa(user),
    }


def user_uses_intranet_profile_modal(user: User | None) -> bool:
    """Standard / Power users without ``admin.all`` use the simplified profile dialog."""
    if not user or not getattr(user, "is_active", True):
        return False
    if user_has_permission(user, PERMISSION_ADMIN):
        return False
    for role in user.roles or []:
        n = (role.name or "").strip().lower()
        if n in ("standard", "power"):
            return True
    return False


def user_can_security_read(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_SECURITY_READ)


def user_can_security_write(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_SECURITY_WRITE)


def user_can_security_delete(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_SECURITY_DELETE)


def user_can_crm_read(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_CRM_READ)


def user_can_crm_create(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_CRM_CREATE)


def user_can_crm_delete(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_CRM_DELETE)


def user_can_workforce_read(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_WORKFORCE_READ)


def user_can_workforce_create(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_WORKFORCE_CREATE)


def user_can_workforce_delete(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_WORKFORCE_DELETE)


def user_can_blogs_write(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_BLOGS_WRITE)


def user_can_blogs_delete(user: User) -> bool:
    return user_has_permission(user, PERMISSION_ADMIN) or user_has_permission(user, PERMISSION_BLOGS_DELETE)


def user_has_admin_role(user: User) -> bool:
    """True when the account carries the built-in ``admin`` role (directly or via a group)."""
    if not user:
        return False
    for role in user.roles or []:
        if _role_name_is_admin(role):
            return True
    for group in user.groups or []:
        for role in group.roles or []:
            if _role_name_is_admin(role):
                return True
    return False


def user_can_manage_home(user: User) -> bool:
    """Edit Home announcements — portal admins and user administrators."""
    if not user or not getattr(user, "is_active", True):
        return False
    if user_has_permission(user, PERMISSION_ADMIN):
        return True
    if user_has_permission(user, PERMISSION_HOME_WRITE):
        return True
    if user_has_admin_role(user):
        return True
    if user_can_access_users_admin(user):
        return True
    if user_has_permission(user, PERMISSION_BLOGS_WRITE) and user_has_permission(
        user, PERMISSION_USERS_CREATE
    ):
        return True
    return False


def ensure_admin_role_permissions(db_session, by_name: dict) -> None:
    """Grant the admin role admin.all plus explicit blog/event permissions for the access matrix."""
    from app.models import Role

    role = db_session.query(Role).filter(Role.name == "admin").first()
    if not role:
        return
    want = (
        PERMISSION_ADMIN,
        PERMISSION_HOME_WRITE,
        PERMISSION_BLOGS_WRITE,
        PERMISSION_BLOGS_DELETE,
        PERMISSION_EVENTS_WRITE,
        PERMISSION_EVENTS_DELETE,
    )
    cur = list(role.permissions or [])
    changed = False
    for pname in want:
        perm = by_name.get(pname)
        if perm and perm not in cur:
            cur.append(perm)
            changed = True
    if changed:
        role.permissions = cur
        db_session.add(role)
