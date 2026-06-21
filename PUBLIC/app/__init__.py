from pathlib import Path

from flask import Flask

from config import Config
from app.branding import (
    portal_core_name,
    portal_has_custom_logo,
    portal_logo_url as resolve_portal_logo_url,
)
from app.branding import portal_display_name
from app.extensions import db, login_manager


def _ensure_user_contact_columns() -> None:
    """Add email/phone columns when upgrading an older SQLite or other DB."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    if not insp.has_table("users"):
        return
    names = {c["name"] for c in insp.get_columns("users")}
    stmts: list[str] = []
    if "full_name" not in names:
        stmts.append("ALTER TABLE users ADD COLUMN full_name VARCHAR(255)")
    if "email" not in names:
        stmts.append("ALTER TABLE users ADD COLUMN email VARCHAR(255)")
    if "phone" not in names:
        stmts.append("ALTER TABLE users ADD COLUMN phone VARCHAR(64)")
    if not stmts:
        return
    with db.engine.begin() as conn:
        for stmt in stmts:
            conn.execute(text(stmt))


def _ensure_user_presence_columns() -> None:
    """Add last_seen_at column to users when upgrading an older DB."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    if not insp.has_table("users"):
        return
    names = {c["name"] for c in insp.get_columns("users")}
    if "last_seen_at" in names:
        return
    with db.engine.begin() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN last_seen_at DATETIME"))


def _ensure_recycle_bin_columns() -> None:
    """Add soft-delete columns to file_nodes when upgrading an older DB."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    if not insp.has_table("file_nodes"):
        return
    names = {c["name"] for c in insp.get_columns("file_nodes")}
    stmts: list[str] = []
    if "deleted_at" not in names:
        stmts.append("ALTER TABLE file_nodes ADD COLUMN deleted_at DATETIME")
    if "deleted_by_id" not in names:
        stmts.append("ALTER TABLE file_nodes ADD COLUMN deleted_by_id INTEGER")
    if "original_parent_id" not in names:
        stmts.append("ALTER TABLE file_nodes ADD COLUMN original_parent_id INTEGER")
    if not stmts:
        return
    with db.engine.begin() as conn:
        for stmt in stmts:
            conn.execute(text(stmt))


def _ensure_blog_post_columns() -> None:
    """Add blog_posts columns when upgrading an older DB."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    if not insp.has_table("blog_posts"):
        return
    names = {c["name"] for c in insp.get_columns("blog_posts")}
    stmts: list[str] = []
    if "category" not in names:
        stmts.append("ALTER TABLE blog_posts ADD COLUMN category VARCHAR(64)")
    if "visibility" not in names:
        stmts.append("ALTER TABLE blog_posts ADD COLUMN visibility VARCHAR(32)")
    if "status" not in names:
        stmts.append("ALTER TABLE blog_posts ADD COLUMN status VARCHAR(16)")
    if "cover_image_url" not in names:
        stmts.append("ALTER TABLE blog_posts ADD COLUMN cover_image_url VARCHAR(1024)")
    if "allow_comments" not in names:
        stmts.append("ALTER TABLE blog_posts ADD COLUMN allow_comments BOOLEAN")
    if "notify_on_publish" not in names:
        stmts.append("ALTER TABLE blog_posts ADD COLUMN notify_on_publish BOOLEAN")
    if not stmts:
        return
    with db.engine.begin() as conn:
        for stmt in stmts:
            conn.execute(text(stmt))


def _ensure_blog_post_published_at_nullable() -> None:
    """Older blog_posts schemas required published_at even for drafts."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    if not insp.has_table("blog_posts"):
        return
    cols = {c["name"]: c for c in insp.get_columns("blog_posts")}
    pub = cols.get("published_at")
    if pub is None or pub.get("nullable"):
        return

    with db.engine.begin() as conn:
        rows = conn.execute(text("PRAGMA table_info(blog_posts)")).fetchall()
        parts: list[str] = []
        col_names: list[str] = []
        for _cid, name, ctype, notnull, dflt, pk in rows:
            col_names.append(name)
            nn = " NOT NULL" if (notnull and name != "published_at") else ""
            dfl_sql = ""
            if dflt is not None:
                dfl_sql = f" DEFAULT {dflt}"
            pk_sql = " PRIMARY KEY" if pk else ""
            parts.append(f"{name} {ctype}{nn}{dfl_sql}{pk_sql}")
        conn.execute(text(f"CREATE TABLE blog_posts__pub_fix ({', '.join(parts)})"))
        cols_csv = ", ".join(col_names)
        conn.execute(
            text(f"INSERT INTO blog_posts__pub_fix ({cols_csv}) SELECT {cols_csv} FROM blog_posts")
        )
        conn.execute(text("DROP TABLE blog_posts"))
        conn.execute(text("ALTER TABLE blog_posts__pub_fix RENAME TO blog_posts"))
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_blog_posts_slug ON blog_posts (slug)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_blog_posts_published_at ON blog_posts (published_at)")
        )


def _ensure_file_share_columns() -> None:
    """Add file_shares columns when upgrading an older DB."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    if not insp.has_table("file_shares"):
        return
    names = {c["name"] for c in insp.get_columns("file_shares")}
    stmts: list[str] = []
    if "created_at" not in names:
        stmts.append("ALTER TABLE file_shares ADD COLUMN created_at DATETIME")
    if "max_downloads" not in names:
        stmts.append("ALTER TABLE file_shares ADD COLUMN max_downloads INTEGER")
    if "download_count" not in names:
        stmts.append("ALTER TABLE file_shares ADD COLUMN download_count INTEGER")
    if not stmts:
        return
    with db.engine.begin() as conn:
        for stmt in stmts:
            conn.execute(text(stmt))


def _ensure_kanban_tables() -> None:
    """Create KanBan tables on upgraded installs."""
    from sqlalchemy import inspect, text

    from app.models import (
        KanbanBoard,
        KanbanBoardActivity,
        KanbanCard,
        KanbanCardActivity,
        KanbanCardAttachment,
        KanbanCardComment,
        KanbanColumn,
    )

    insp = inspect(db.engine)
    if not insp.has_table("kanban_boards"):
        KanbanBoard.__table__.create(db.engine, checkfirst=True)
    else:
        names = {c["name"] for c in insp.get_columns("kanban_boards")}
        stmts: list[str] = []
        if "shared_users" not in names:
            stmts.append("ALTER TABLE kanban_boards ADD COLUMN shared_users JSON")
        if "shared_groups" not in names:
            stmts.append("ALTER TABLE kanban_boards ADD COLUMN shared_groups JSON")
        if "subtitle" not in names:
            stmts.append("ALTER TABLE kanban_boards ADD COLUMN subtitle VARCHAR(240)")
        if stmts:
            with db.engine.begin() as conn:
                for stmt in stmts:
                    conn.execute(text(stmt))
    if not insp.has_table("kanban_columns"):
        KanbanColumn.__table__.create(db.engine, checkfirst=True)
    if not insp.has_table("kanban_cards"):
        KanbanCard.__table__.create(db.engine, checkfirst=True)
    else:
        names = {c["name"] for c in insp.get_columns("kanban_cards")}
        stmts: list[str] = []
        if "due_at" not in names:
            stmts.append("ALTER TABLE kanban_cards ADD COLUMN due_at DATETIME")
        if "body_html" not in names:
            stmts.append("ALTER TABLE kanban_cards ADD COLUMN body_html TEXT")
        if "deleted_at" not in names:
            stmts.append("ALTER TABLE kanban_cards ADD COLUMN deleted_at DATETIME")
        if "deleted_by_id" not in names:
            stmts.append("ALTER TABLE kanban_cards ADD COLUMN deleted_by_id INTEGER")
        if "priority" not in names:
            stmts.append("ALTER TABLE kanban_cards ADD COLUMN priority VARCHAR(16) NOT NULL DEFAULT 'medium'")
        if stmts:
            with db.engine.begin() as conn:
                for stmt in stmts:
                    conn.execute(text(stmt))
    if not insp.has_table("kanban_card_comments"):
        KanbanCardComment.__table__.create(db.engine, checkfirst=True)
    else:
        names = {c["name"] for c in insp.get_columns("kanban_card_comments")}
        if "body_html" not in names:
            with db.engine.begin() as conn:
                conn.execute(text("ALTER TABLE kanban_card_comments ADD COLUMN body_html TEXT"))
    if not insp.has_table("kanban_card_attachments"):
        KanbanCardAttachment.__table__.create(db.engine, checkfirst=True)
    if not insp.has_table("kanban_card_activity"):
        KanbanCardActivity.__table__.create(db.engine, checkfirst=True)
    if not insp.has_table("kanban_board_activity"):
        KanbanBoardActivity.__table__.create(db.engine, checkfirst=True)


def _ensure_wiki_page_content_html_column() -> None:
    """Add wiki_pages.content_html for rich-text (Quill) bodies."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    if not insp.has_table("wiki_pages"):
        return
    names = {c["name"] for c in insp.get_columns("wiki_pages")}
    if "content_html" in names:
        return
    with db.engine.begin() as conn:
        conn.execute(text("ALTER TABLE wiki_pages ADD COLUMN content_html TEXT"))


def _ensure_calendar_event_columns() -> None:
    """Add calendar_events sharing columns when upgrading an older DB."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    if not insp.has_table("calendar_events"):
        return
    names = {c["name"] for c in insp.get_columns("calendar_events")}
    stmts: list[str] = []
    if "shared_user_ids" not in names:
        stmts.append("ALTER TABLE calendar_events ADD COLUMN shared_user_ids JSON")
    if "shared_group_ids" not in names:
        stmts.append("ALTER TABLE calendar_events ADD COLUMN shared_group_ids JSON")
    if "is_private" not in names:
        stmts.append("ALTER TABLE calendar_events ADD COLUMN is_private BOOLEAN DEFAULT 0")
    if not stmts:
        return
    with db.engine.begin() as conn:
        for stmt in stmts:
            conn.execute(text(stmt))








def _ensure_file_node_locks_table() -> None:
    """Create file_node_locks table on upgraded installs."""
    from sqlalchemy import inspect

    from app.models import FileNodeLock

    insp = inspect(db.engine)
    if insp.has_table("file_node_locks"):
        return
    FileNodeLock.__table__.create(db.engine, checkfirst=True)


def _ensure_file_node_onlyoffice_doc_key_column() -> None:
    """Add OnlyOffice session key column to file_nodes when upgrading an older DB."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    if not insp.has_table("file_nodes"):
        return
    names = {c["name"] for c in insp.get_columns("file_nodes")}
    if "onlyoffice_doc_key" in names:
        return
    with db.engine.begin() as conn:
        conn.execute(text("ALTER TABLE file_nodes ADD COLUMN onlyoffice_doc_key VARCHAR(128)"))


def _ensure_file_node_edit_sessions_table() -> None:
    """Create file_node_edit_sessions table on upgraded installs."""
    from sqlalchemy import inspect

    from app.models import FileNodeEditSession

    insp = inspect(db.engine)
    if insp.has_table("file_node_edit_sessions"):
        return
    FileNodeEditSession.__table__.create(db.engine, checkfirst=True)


def _ensure_node_group_role_share_tables() -> None:
    """Align node_group_shares / node_role_shares with current models on upgraded DBs."""
    from sqlalchemy import inspect, text

    insp = inspect(db.engine)
    with db.engine.begin() as conn:
        if insp.has_table("node_group_shares"):
            names = {c["name"] for c in insp.get_columns("node_group_shares")}
            if "group_id" not in names and "shared_with_group_id" in names:
                conn.execute(
                    text(
                        "ALTER TABLE node_group_shares "
                        "RENAME COLUMN shared_with_group_id TO group_id"
                    )
                )
            elif "group_id" not in names:
                conn.execute(
                    text("ALTER TABLE node_group_shares ADD COLUMN group_id INTEGER")
                )
        if not insp.has_table("node_role_shares"):
            conn.execute(
                text(
                    """
                    CREATE TABLE IF NOT EXISTS node_role_shares (
                        id INTEGER NOT NULL PRIMARY KEY,
                        file_node_id INTEGER NOT NULL,
                        role_id INTEGER NOT NULL,
                        permission VARCHAR(16) NOT NULL,
                        granted_by_id INTEGER NOT NULL,
                        created_at DATETIME NOT NULL,
                        CONSTRAINT uq_node_role_share UNIQUE (file_node_id, role_id),
                        FOREIGN KEY(file_node_id) REFERENCES file_nodes (id),
                        FOREIGN KEY(role_id) REFERENCES roles (id),
                        FOREIGN KEY(granted_by_id) REFERENCES users (id)
                    )
                    """
                )
            )


def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)
    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    app.config["UPLOAD_ROOT"] = Path(app.config["UPLOAD_ROOT"])
    app.config["UPLOAD_ROOT"].mkdir(parents=True, exist_ok=True)

    db_uri = app.config.get("SQLALCHEMY_DATABASE_URI") or ""
    if isinstance(db_uri, str) and db_uri.startswith("sqlite:///"):
        raw = db_uri[len("sqlite:///") :]
        Path(raw).resolve().parent.mkdir(parents=True, exist_ok=True)

    db.init_app(app)
    login_manager.init_app(app)

    from app.models import User

    @login_manager.user_loader
    def load_user(user_id):
        from sqlalchemy.orm import joinedload
        from sqlalchemy.orm.exc import ObjectDeletedError

        from app.models import Group, Role, User

        try:
            uid = int(user_id)
        except (TypeError, ValueError):
            return None
        try:
            user = (
                db.session.query(User)
                .options(
                    joinedload(User.roles).joinedload(Role.permissions),
                    joinedload(User.groups).joinedload(Group.roles).joinedload(Role.permissions),
                )
                .filter_by(id=uid)
                .first()
            )
        except ObjectDeletedError:
            db.session.expunge_all()
            return None
        if user is None or not user.is_active:
            return None
        try:
            db.session.refresh(user, attribute_names=["is_active"])
        except ObjectDeletedError:
            db.session.expunge(user)
            return None
        return user

    @app.before_request
    def _reconcile_stale_login_session():
        """Clear cookies that still reference a user row removed from the database."""
        from flask import session
        from flask_login import logout_user

        from app.models import User

        raw = session.get("_user_id")
        if raw is None:
            return
        try:
            uid = int(raw)
        except (TypeError, ValueError):
            logout_user()
            db.session.expunge_all()
            return
        row = db.session.query(User.id).filter_by(id=uid, is_active=True).first()
        if row is None:
            logout_user()
            db.session.expunge_all()

    from app.auth import bp as auth_bp
    from app.admin_bp import bp as admin_bp
    from app.files_bp import bp as files_bp
    from app.shares_bp import bp as shares_bp
    from app.audit_bp import bp as audit_bp
    from app.onlyoffice_bp import bp as onlyoffice_bp
    from app.intranet_bp import bp as intranet_bp
    from app.chess_bp import bp as chess_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(files_bp)
    app.register_blueprint(shares_bp)
    app.register_blueprint(audit_bp)
    app.register_blueprint(onlyoffice_bp)
    app.register_blueprint(intranet_bp)
    app.register_blueprint(chess_bp)


    with app.app_context():
        # Import models for metadata registration (must not use `import app.models` — shadows Flask app).
        db.create_all()
        _ensure_user_contact_columns()
        _ensure_user_presence_columns()
        _ensure_recycle_bin_columns()
        _ensure_blog_post_columns()
        _ensure_blog_post_published_at_nullable()
        _ensure_file_share_columns()
        _ensure_calendar_event_columns()
        _ensure_kanban_tables()
        _ensure_wiki_page_content_html_column()
        _ensure_node_group_role_share_tables()
        _ensure_security_clearance_records_table()
        _ensure_file_node_locks_table()
        _ensure_file_node_edit_sessions_table()
        _ensure_file_node_onlyoffice_doc_key_column()
        _ensure_resource_pool_resources_table()
        _ensure_resource_pool_resources_columns()
        try:
            from app.community_edition import ensure_community_module_defaults

            ensure_community_module_defaults()
        except Exception:
            app.logger.exception("community edition module defaults failed")
        if isinstance(db_uri, str) and db_uri.startswith("sqlite:///"):
            try:
                from sqlalchemy import text

                with db.engine.connect() as conn:
                    conn.execute(text("PRAGMA journal_mode=WAL"))
                    conn.commit()
            except Exception:
                app.logger.warning("SQLite WAL enable failed", exc_info=True)
        # First-run bootstrap: create a default admin user on a brand-new install.
        try:
            from app import rbac
            from app.models import Permission, Role, User

            if db.session.query(User).count() == 0:
                # Ensure the global admin permission exists.
                perm = (
                    db.session.query(Permission)
                    .filter(Permission.name == rbac.PERMISSION_ADMIN)
                    .first()
                )
                if not perm:
                    perm = Permission(name=rbac.PERMISSION_ADMIN)
                    db.session.add(perm)
                    db.session.flush()

                # Ensure an "admin" role exists and grants admin.all.
                role = db.session.query(Role).filter(Role.name == "admin").first()
                if not role:
                    role = Role(name="admin")
                    db.session.add(role)
                    db.session.flush()
                if perm not in (role.permissions or []):
                    role.permissions = list(role.permissions or []) + [perm]
                    db.session.add(role)

                # Create default admin user (see attributes.factory_bootstrap in seed / admin).
                email = "admin@example.com"
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
                db.session.commit()
        except Exception:
            try:
                db.session.rollback()
            except Exception:
                pass

    # Ensure standard RBAC permissions exist (and keep "editor" role useful).
    try:
        from app import rbac
        from app.models import Role

        by_name, created_perm_names = rbac.ensure_permission_catalog(db.session)

        # Rename legacy roles to friendly names (one-time).
        # viewer -> standard, editor -> power
        try:
            legacy_viewer = db.session.query(Role).filter(Role.name == "viewer").first()
            has_standard = db.session.query(Role).filter(Role.name == "standard").first()
            if legacy_viewer and not has_standard:
                legacy_viewer.name = "standard"
                db.session.add(legacy_viewer)
        except Exception:
            pass
        try:
            legacy_editor = db.session.query(Role).filter(Role.name == "editor").first()
            has_power = db.session.query(Role).filter(Role.name == "power").first()
            if legacy_editor and not has_power:
                legacy_editor.name = "power"
                db.session.add(legacy_editor)
        except Exception:
            pass

        # If both legacy and new roles exist, merge assignments and remove legacy.
        try:
            from sqlalchemy import text

            std = db.session.query(Role).filter(Role.name == "standard").first()
            powr = db.session.query(Role).filter(Role.name == "power").first()
            legacy_viewer = db.session.query(Role).filter(Role.name == "viewer").first()
            legacy_editor = db.session.query(Role).filter(Role.name == "editor").first()

            def _merge_role(old: Role | None, new: Role | None) -> None:
                if not old or not new:
                    return
                if int(old.id) == int(new.id):
                    return
                # Move role_permissions, user_roles, group_roles join rows.
                db.session.execute(
                    text("UPDATE OR IGNORE role_permissions SET role_id=:new WHERE role_id=:old"),
                    {"old": int(old.id), "new": int(new.id)},
                )
                db.session.execute(
                    text("UPDATE OR IGNORE user_roles SET role_id=:new WHERE role_id=:old"),
                    {"old": int(old.id), "new": int(new.id)},
                )
                db.session.execute(
                    text("UPDATE OR IGNORE group_roles SET role_id=:new WHERE role_id=:old"),
                    {"old": int(old.id), "new": int(new.id)},
                )
                # Ensure permissions relationship includes any not yet attached.
                try:
                    cur = {p.id for p in (new.permissions or [])}
                    for p in (old.permissions or []):
                        if p.id not in cur:
                            new.permissions = list(new.permissions or []) + [p]
                            cur.add(p.id)
                except Exception:
                    pass
                db.session.delete(old)

            _merge_role(legacy_viewer, std)
            _merge_role(legacy_editor, powr)
        except Exception:
            pass

        rbac.ensure_builtin_roles(db.session)
        db.session.flush()
        rbac.apply_standard_power_permission_defaults(
            db.session, by_name, only_add_permissions=frozenset(created_perm_names)
        )
        rbac.ensure_admin_role_permissions(db.session, by_name)

        db.session.commit()

        # One-time: direct user roles → Standard only for accounts that are not administrators
        # (admin.all via user role or group). New admin-created users also default to Standard
        # when no role_ids are sent (see admin_bp.api_users_create).
        try:
            from app.settings import get_setting, set_setting
            from app.models import User

            _flag = "rbac_migrated_non_admin_roles_to_standard_v1"
            if not get_setting(_flag, default=False):
                std = db.session.query(Role).filter(Role.name == "standard").first()
                if std:
                    for u in db.session.query(User).all():
                        if rbac.user_has_permission(u, rbac.PERMISSION_ADMIN):
                            continue
                        roles = list(u.roles or [])
                        if (
                            len(roles) == 1
                            and (roles[0].name or "").strip().lower() == "standard"
                        ):
                            continue
                        u.roles = [std]
                        db.session.add(u)
                    db.session.commit()
                    set_setting(_flag, True)
        except Exception:
            try:
                db.session.rollback()
            except Exception:
                pass

        # One-time: accounts still on legacy ``viewer`` role → Standard User
        try:
            from app.models import Role, User
            from app.settings import get_setting, set_setting

            _vflag = "rbac_viewer_role_users_to_standard_v1"
            if not get_setting(_vflag, default=False):
                std = db.session.query(Role).filter(Role.name == "standard").first()
                viewer = db.session.query(Role).filter(Role.name == "viewer").first()
                if std and viewer and int(std.id) != int(viewer.id):
                    for u in db.session.query(User).all():
                        if rbac.user_has_permission(u, rbac.PERMISSION_ADMIN):
                            continue
                        if any(int(r.id) == int(viewer.id) for r in (u.roles or [])):
                            u.roles = [std]
                            db.session.add(u)
                    db.session.commit()
                set_setting(_vflag, True)
        except Exception:
            try:
                db.session.rollback()
            except Exception:
                pass

        # General group: create if missing (idempotent); one-time backfill all users into it
        try:
            import logging

            from app.settings import get_setting, set_setting

            _gen_log = logging.getLogger(__name__)
            _genflag = "general_group_all_users_v1"
            rbac.ensure_general_group(db.session)
            if not get_setting(_genflag, default=False):
                rbac.ensure_all_users_in_general_group(db.session)
                set_setting(_genflag, True)
            db.session.commit()
        except Exception as exc:
            try:
                import logging

                logging.getLogger(__name__).warning("General group bootstrap failed: %s", exc)
                db.session.rollback()
            except Exception:
                pass

        # One-time: groups named like "Standard Users" / "Power Users" with no roles → attach builtin role
        try:
            from app.settings import get_setting, set_setting
            from app.models import Group

            _gflag = "group_named_builtin_roles_v1"
            if not get_setting(_gflag, default=False):
                rbac.ensure_builtin_roles(db.session)
                db.session.flush()
                for g in db.session.query(Group).all():
                    rbac.maybe_attach_builtin_roles_for_named_group(g, db.session)
                db.session.commit()
                set_setting(_gflag, True)
        except Exception:
            try:
                db.session.rollback()
            except Exception:
                pass

        # One-time: per-group companion roles for Access Control matrix + merge Standard/Power for named groups
        try:
            from app.settings import get_setting, set_setting
            from app.models import Group

            _gcflag = "group_companion_roles_v1"
            if not get_setting(_gcflag, default=False):
                rbac.ensure_builtin_roles(db.session)
                db.session.flush()
                for g in db.session.query(Group).all():
                    rbac.ensure_group_companion_role(g, db.session)
                    rbac.maybe_attach_builtin_roles_for_named_group(g, db.session)
                db.session.commit()
                set_setting(_gcflag, True)
        except Exception:
            try:
                db.session.rollback()
            except Exception:
                pass

        # One-time: empty per-group companion roles → same permission checks as Standard User
        try:
            from app.settings import get_setting, set_setting
            from app.models import Role

            _seedflag = "companion_roles_permissions_from_standard_v1"
            if not get_setting(_seedflag, default=False):
                rbac.ensure_builtin_roles(db.session)
                db.session.flush()
                std = db.session.query(Role).filter(Role.name == "standard").first()
                if std:
                    for r in db.session.query(Role).all():
                        if rbac.is_group_companion_role_name(r.name) and not list(r.permissions or []):
                            r.permissions = list(std.permissions or [])
                            db.session.add(r)
                db.session.commit()
                set_setting(_seedflag, True)
        except Exception:
            try:
                db.session.rollback()
            except Exception:
                pass
    except Exception:
        try:
            db.session.rollback()
        except Exception:
            pass

    @app.before_request
    def _enforce_required_password_change():
        from flask import redirect, request, url_for
        from flask_login import current_user

        from app.onboarding import password_change_required

        if not current_user.is_authenticated:
            return
        ep = request.endpoint or ""
        if ep in (
            "auth.login",
            "auth.login_change_password",
            "auth.login_mfa",
            "auth.login_mfa_setup",
            "auth.logout",
            "static",
        ):
            return
        if request.path.startswith("/static/"):
            return
        if password_change_required(current_user):
            return redirect(url_for("auth.login_change_password"))

    @app.before_request
    def _touch_presence():
        # Keep presence accurate site-wide (not just on the Directory page).
        # Throttle updates to avoid a DB write on every request.
        from flask import request
        from flask_login import current_user

        from app.onboarding import password_change_required

        try:
            if not current_user.is_authenticated:
                return
            if request.endpoint == "static":
                return
            if request.path.startswith("/static/"):
                return
            if password_change_required(current_user):
                return

            from app.models import utcnow

            now = utcnow()
            last = getattr(current_user, "last_seen_at", None)
            if last is not None:
                try:
                    if (now - last).total_seconds() < 60:
                        return
                except Exception:
                    pass

            current_user.last_seen_at = now
            db.session.add(current_user)
            db.session.commit()
        except Exception:
            try:
                db.session.rollback()
            except Exception:
                pass

    @app.errorhandler(403)
    def forbidden(_e):
        # Avoid raw JSON / Werkzeug 403 for normal browser navigations.
        # Keep JSON 403 for APIs, fetch/XHR, and OnlyOffice / Document Server callbacks.
        from flask import flash, jsonify, redirect, request, url_for
        from flask_login import current_user

        path = request.path or ""

        def must_return_json() -> bool:
            if (
                path.startswith("/files/api/")
                or path.startswith("/admin/api/")
                or path.startswith("/intranet/api/")
                or path.startswith("/audit/")
            ):
                return True
            if path.startswith("/onlyoffice/file") or path.startswith("/onlyoffice/callback"):
                return True
            if (request.headers.get("X-Requested-With") or "").lower() == "xmlhttprequest":
                return True
            accept = (request.headers.get("Accept") or "").lower()
            if "application/json" in accept and "text/html" not in accept:
                return True
            return False

        mode = (request.headers.get("Sec-Fetch-Mode") or "").lower()
        dest = (request.headers.get("Sec-Fetch-Dest") or "").lower()
        accept = (request.headers.get("Accept") or "").lower()
        # Real browser tab navigations send Sec-Fetch-Mode: navigate. fetch() uses e.g. cors — must stay JSON.
        # Legacy clients without Sec-Fetch: only treat GET + HTML-ish Accept as a page visit.
        looks_like_page_nav = mode == "navigate" or dest in ("document", "iframe") or (
            request.method == "GET"
            and not mode
            and ("text/html" in accept or "*/*" in accept or not accept)
        )

        if not must_return_json() and looks_like_page_nav:
            if not current_user.is_authenticated:
                return redirect(url_for("auth.login", next=request.path))
            flash("You don’t have permission to access that page.", "danger")
            return redirect(url_for("intranet.intranet_page"))

        return jsonify({"error": "forbidden"}), 403

    @app.context_processor
    def inject_nav():
        from flask_login import current_user

        from app import rbac
        from app.settings import get_setting

        # Enterprise feature gates used across templates (avoid per-page plumbing).
        try:
            from app.premium_license import FEATURE_SECURITY_OFFICER_EXPORT, feature_enabled

            premium_officer_export = bool(feature_enabled(FEATURE_SECURITY_OFFICER_EXPORT))
        except Exception:
            premium_officer_export = False

        can_audit = current_user.is_authenticated and rbac.user_has_permission(
            current_user, rbac.PERMISSION_AUDIT_READ
        )
        can_admin = current_user.is_authenticated and rbac.user_has_permission(
            current_user, rbac.PERMISSION_ADMIN
        )
        users_ctx = rbac.users_admin_template_context(current_user if current_user.is_authenticated else None)
        can_create_users = users_ctx["can_create_users"]
        can_approve_registrations = users_ctx["can_approve_registrations"]
        can_access_users_admin = users_ctx["can_access_users_admin"]
        u = current_user if current_user.is_authenticated else None
        can_blogs = bool(u) and rbac.user_can_blogs_write(u)
        workforce_can_manage = bool(u) and rbac.user_can_workforce_create(u)
        workforce_can_delete = bool(u) and rbac.user_can_workforce_delete(u)
        security_can_write = bool(u) and rbac.user_can_security_write(u)
        security_can_delete = bool(u) and rbac.user_can_security_delete(u)
        can_blogs_delete = bool(u) and rbac.user_can_blogs_delete(u)
        can_events = current_user.is_authenticated and rbac.user_has_permission(
            current_user, rbac.PERMISSION_EVENTS_WRITE
        )
        portal = get_setting("portal", default={}) or {}
        time_cfg = get_setting("time", default={}) or {}
        from flask import url_for

        logo_url = resolve_portal_logo_url(portal, static_url=lambda f: url_for("static", filename=f))
        raw_theme = (portal.get("theme") or "core_team") if isinstance(portal, dict) else "core_team"
        theme_key = str(raw_theme).strip().lower().replace("-", "_")
        if theme_key not in ("core_team", "non_core_team"):
            theme_key = "core_team"
        portal_theme_class = "nc-theme-non-core-team" if theme_key == "non_core_team" else ""
        portal_shell_name = portal_display_name(portal, theme_key)
        portal_tab_title = portal_shell_name
        return {
            "can_view_audit": can_audit,
            "can_view_admin": can_admin or can_access_users_admin or can_approve_registrations,
            "admin_full_access": can_admin,
            "premium_officer_export": premium_officer_export,
            "can_create_users": can_create_users,
            "can_approve_registrations": can_approve_registrations,
            "can_access_users_admin": can_access_users_admin,
            "users_can_edit": users_ctx["users_can_edit"],
            "users_can_delete": users_ctx["users_can_delete"],
            "users_can_password": users_ctx["users_can_password"],
            "users_can_role": users_ctx["users_can_role"],
            "users_can_reset_mfa": users_ctx["users_can_reset_mfa"],
            "users_can_mfa": users_ctx["users_can_mfa"],
            "workforce_can_manage": workforce_can_manage,
            "workforce_can_delete": workforce_can_delete,
            "security_can_write": security_can_write,
            "security_can_delete": security_can_delete,
            "can_manage_blogs": can_blogs or can_admin,
            "can_delete_blogs": can_blogs_delete or can_admin,
            "can_manage_events": can_events or can_admin,
            "can_manage_home": bool(u) and rbac.user_can_manage_home(u),
            "portal_footer_text": (portal.get("footer_text") or "").strip(),
            "portal_logo_url": logo_url,
            "portal_has_custom_logo": portal_has_custom_logo(portal),
            "portal_product_name": portal_core_name(),
            "portal_theme": theme_key,
            "portal_theme_class": portal_theme_class,
            "portal_shell_name": portal_shell_name,
            "portal_tab_title": portal_tab_title,
            "app_time_zone": (time_cfg.get("timezone") or "Australia/Melbourne"),
            "app_time_offset_ms": int(time_cfg.get("manual_offset_ms") or 0) if bool(time_cfg.get("manual_enabled")) else 0,
        }

    @app.route("/")
    def root():
        from flask import redirect, url_for
        from flask_login import current_user

        if current_user.is_authenticated:
            return redirect(url_for("intranet.intranet_page"))
        return redirect(url_for("auth.login"))

    @app.route("/health")
    def health():
        return {"status": "ok"}, 200

    with app.app_context():
        try:
            from app.factory_admin import sync_factory_bootstrap_accounts

            sync_factory_bootstrap_accounts(db.session)
            db.session.commit()
        except Exception:
            try:
                db.session.rollback()
            except Exception:
                pass

    if not app.config.get("TESTING"):
        import threading
        import time

        def _timesheet_reminder_loop() -> None:
            while True:
                time.sleep(3600)
                with app.app_context():
                    try:
                        from app.timesheet_notifications import run_scheduled_timesheet_reminders

                        run_scheduled_timesheet_reminders()
                    except Exception:
                        app.logger.exception("timesheet reminder scheduler failed")

        threading.Thread(target=_timesheet_reminder_loop, daemon=True, name="timesheet-reminders").start()

    return app
