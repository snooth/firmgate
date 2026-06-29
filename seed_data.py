"""Optional seed: permission catalog, built-in roles, factory bootstrap admin only (no demo users)."""

from app import create_app
from app import rbac
from app.extensions import db
from app.files_workspace import ensure_user_workspace_folder
from app.models import Permission, Role, User, utcnow


def main():
    app = create_app()
    with app.app_context():
        by_name, _created_perm_names = rbac.ensure_permission_catalog(db.session)
        rbac.ensure_builtin_roles(db.session)
        db.session.flush()
        rbac.apply_standard_power_permission_defaults(db.session, by_name)

        perm = (
            db.session.query(Permission)
            .filter(Permission.name == rbac.PERMISSION_ADMIN)
            .first()
        )
        if not perm:
            perm = Permission(name=rbac.PERMISSION_ADMIN)
            db.session.add(perm)
            db.session.flush()

        role = db.session.query(Role).filter(Role.name == "admin").first()
        if not role:
            role = Role(name="admin")
            db.session.add(role)
            db.session.flush()
        if perm not in (role.permissions or []):
            role.permissions = list(role.permissions or []) + [perm]
            db.session.add(role)

        email = "admin@example.com"
        u = User.query.filter(db.func.lower(User.email) == email.lower()).first()
        if not u:
            u = User(
                username=email.lower(),
                email=email,
                full_name="Admin",
                is_active=True,
                attributes={"department": "IT", "factory_bootstrap": True},
            )
            u.set_password("admin")
            u.roles = [role]
            db.session.add(u)
        else:
            attrs = dict(u.attributes or {})
            attrs["factory_bootstrap"] = True
            u.attributes = attrs
            u.roles = [role]

        db.session.commit()

        ensure_user_workspace_folder(u)

        print("Seed complete. Only user: admin@example.com / admin (factory bootstrap).")


if __name__ == "__main__":
    main()
