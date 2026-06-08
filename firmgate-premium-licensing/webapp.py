#!/usr/bin/env python3
"""Small vendor web UI for managing Firmgate FG2 licenses (private tooling)."""

from __future__ import annotations

import os
import sys
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import Flask, flash, redirect, render_template, request, session, url_for

_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_DIR))

# Ensure app/ is importable (feature ids, fingerprinting, etc.)
import license_signing  # noqa: E402  # sets repo root on sys.path

from license_ledger import (  # noqa: E402
    delete_issued_license,
    delete_revoked_license,
    list_all_licenses,
    load_issued_entries,
    load_revoked_entries,
    record_issued_license,
    resolve_license_key,
    save_revoked_entries,
)
from license_signing import sign_license_key  # noqa: E402
from revoke_license import _append_entry as _revoke_append_entry  # noqa: E402
from vendor_users import (  # noqa: E402
    ROLE_ADMIN,
    ROLE_OPERATOR,
    create_user,
    delete_user,
    effective_username,
    ensure_users_store,
    list_users_public,
    profile_public,
    update_credentials,
    update_profile,
    verify_login,
)
from app.premium_license import (  # noqa: E402
    ALL_FEATURES,
    AI_ENTERPRISE_FEATURES,
    FEATURE_CRM,
    FEATURE_ENTERPRISE_INTRANET,
    FEATURE_LDAP,
    FEATURE_LABELS,
    FEATURE_OFFICE365,
    FEATURE_RESOURCE_POOL,
    FEATURE_SECURITY_CLEARANCE,
    FEATURE_SECURITY_ENCRYPTION,
    FEATURE_SECURITY_OFFICER,
    FEATURE_SECURITY_OFFICER_EXPORT,
    FEATURE_SELF_REGISTRATION,
    FEATURE_TIMESHEETS,
    license_key_fingerprint,
)


def license_feature_groups() -> list[tuple[str, list[str]]]:
    """Grouped feature ids for the custom license picker."""
    groups: list[tuple[str, list[str]]] = [
        (
            "Platform & integrations",
            sorted(
                [
                    FEATURE_SELF_REGISTRATION,
                    FEATURE_OFFICE365,
                    FEATURE_LDAP,
                    FEATURE_SECURITY_ENCRYPTION,
                ]
            ),
        ),
        ("AI", sorted(AI_ENTERPRISE_FEATURES)),
        (
            "Intranet modules",
            sorted(
                [
                    FEATURE_CRM,
                    FEATURE_RESOURCE_POOL,
                    FEATURE_SECURITY_CLEARANCE,
                    FEATURE_TIMESHEETS,
                    FEATURE_SECURITY_OFFICER,
                    FEATURE_SECURITY_OFFICER_EXPORT,
                    FEATURE_ENTERPRISE_INTRANET,
                ]
            ),
        ),
    ]
    out: list[tuple[str, list[str]]] = []
    seen: set[str] = set()
    for title, feats in groups:
        filtered = [f for f in feats if f in ALL_FEATURES]
        if filtered:
            out.append((title, filtered))
            seen.update(filtered)
    rest = sorted(ALL_FEATURES - seen)
    if rest:
        out.append(("Other", rest))
    return out


def create_app() -> Flask:
    app = Flask(
        __name__,
        static_folder=str(_DIR / "static"),
        static_url_path="/static",
    )
    app.secret_key = (os.environ.get("FLASK_SECRET_KEY") or "dev-only-change-me").strip()
    app.config.update(
        SESSION_COOKIE_NAME=os.environ.get("LICENSING_SESSION_COOKIE") or "fg2_licensing_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=False,
        PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 14,
    )

    def _is_authed() -> bool:
        return bool(session.get("licensing_authed") and session.get("licensing_user_id"))

    def _current_user_id() -> str:
        return str(session.get("licensing_user_id") or "").strip()

    def _is_portal_admin() -> bool:
        return session.get("licensing_role") == ROLE_ADMIN

    def _profile_for_template() -> dict:
        p = profile_public(_current_user_id())
        dn = (p.get("display_name") or p.get("username") or "?").strip()
        initials = "".join(ch for ch in dn if ch.isalnum())[:2].upper() or "?"
        p["initials"] = initials
        return p

    def login_required(fn):
        view_name = fn.__name__

        @wraps(fn)
        def wrapped(*args, **kwargs):
            if _is_authed():
                return fn(*args, **kwargs)
            nxt = request.full_path if request.query_string else request.path
            return redirect(url_for("login", next=nxt))

        wrapped.__name__ = view_name
        return wrapped

    def admin_required(fn):
        view_name = fn.__name__

        @wraps(fn)
        @login_required
        def wrapped(*args, **kwargs):
            if not _is_portal_admin():
                flash("Administrator access is required.", "error")
                return redirect(url_for("index"))
            return fn(*args, **kwargs)

        wrapped.__name__ = view_name
        return wrapped

    @app.get("/login")
    def login():
        if _is_authed():
            return redirect(url_for("index"))
        nxt = (request.args.get("next") or "").strip()
        return render_template("login.html", next=nxt, default_user=effective_username())

    @app.post("/login")
    def login_post():
        u = (request.form.get("username") or "").strip()
        p = (request.form.get("password") or "").strip()
        nxt = (request.form.get("next") or "").strip()
        user = verify_login(u, p)
        if user:
            session["licensing_authed"] = True
            session["licensing_user_id"] = str(user.get("id") or "")
            session["licensing_username"] = str(user.get("username") or u)
            session["licensing_role"] = str(user.get("role") or ROLE_OPERATOR)
            session.permanent = True
            flash("Logged in.", "ok")
            if nxt and nxt.startswith("/"):
                return redirect(nxt)
            return redirect(url_for("index"))
        flash("Invalid username or password.", "error")
        return redirect(url_for("login", next=nxt))

    @app.post("/logout")
    def logout():
        session.pop("licensing_authed", None)
        session.pop("licensing_user_id", None)
        session.pop("licensing_username", None)
        session.pop("licensing_role", None)
        flash("Logged out.", "ok")
        return redirect(url_for("login"))

    @app.context_processor
    def inject_auth():
        out = {
            "licensing_authed": _is_authed(),
            "licensing_is_admin": _is_portal_admin() if _is_authed() else False,
            "licensing_url_profile": "/profile",
            "licensing_url_account": "/account",
            "licensing_url_users": "/users",
            "licensing_current_user_id": _current_user_id(),
        }
        if _is_authed():
            out["licensing_profile"] = _profile_for_template()
        return out

    @app.template_filter("dt")
    def _fmt_dt(s: str | None) -> str:
        if not s:
            return "—"
        return s

    @app.get("/")
    @login_required
    def index():
        q = (request.args.get("q") or "").strip().lower()
        rows = list_all_licenses()
        if q:

            def _hit(r: dict) -> bool:
                if q in str(r.get("fingerprint") or "").lower():
                    return True
                if q in str(r.get("subject") or "").lower():
                    return True
                if q in str(r.get("status") or "").lower():
                    return True
                feats = ",".join(r.get("features") or [])
                if q in feats.lower():
                    return True
                return False

            rows = [r for r in rows if _hit(r)]
        return render_template(
            "index.html",
            rows=rows,
            q=q,
            all_features=sorted(ALL_FEATURES),
            feature_labels=FEATURE_LABELS,
        )

    @app.get("/new")
    @login_required
    def new_license_form():
        return render_template(
            "new.html",
            all_features=sorted(ALL_FEATURES),
            feature_groups=license_feature_groups(),
            feature_labels=FEATURE_LABELS,
            default_expires=(datetime.utcnow().date().replace(year=datetime.utcnow().date().year + 1)).isoformat(),
        )

    def _collect_features_from_form() -> list[str]:
        mode = (request.form.get("preset") or "custom").strip().lower()
        if mode == "all":
            return list(sorted(ALL_FEATURES))
        if mode == "ai":
            return list(sorted(AI_ENTERPRISE_FEATURES))
        if mode == "enterprise":
            return [FEATURE_ENTERPRISE_INTRANET]
        raw = request.form.getlist("features")
        feats = sorted({str(x).strip() for x in raw if str(x).strip()})
        return [f for f in feats if f in ALL_FEATURES]

    @app.post("/new")
    @login_required
    def new_license_submit():
        subject = (request.form.get("subject") or "").strip()
        expires = (request.form.get("expires") or "").strip() or None
        feats = _collect_features_from_form()
        if not feats:
            flash("Select at least one feature (or a preset).", "error")
            return redirect(url_for("new_license_form"))

        key = sign_license_key(features=feats, expires=expires, subject=subject)
        fp = license_key_fingerprint(key) or ""
        if not fp:
            flash("Failed to compute fingerprint for generated key.", "error")
            return redirect(url_for("new_license_form"))

        ok = record_issued_license(
            fingerprint=fp,
            features=feats,
            expires_at=expires,
            subject=subject,
            license_key=key,
        )
        if not ok:
            flash(f"Fingerprint {fp} already exists in issued ledger. Key was generated but not recorded.", "error")
        else:
            flash(f"Issued license {fp}.", "ok")
        return redirect(url_for("view_license", fingerprint=fp))

    @app.get("/license/<fingerprint>")
    @login_required
    def view_license(fingerprint: str):
        fp = (fingerprint or "").strip().lower()
        rows = list_all_licenses()
        row = next((r for r in rows if str(r.get("fingerprint") or "").lower() == fp), None)
        if not row:
            flash("License not found.", "error")
            return redirect(url_for("index"))
        license_key, key_source = resolve_license_key(fp, persist_recovered=True)
        row = dict(row)
        if license_key:
            row["license_key"] = license_key
        if key_source == "recovered":
            flash("License code recovered from ledger metadata and saved for future use.", "ok")
        elif key_source == "missing" and row.get("features"):
            flash(
                "Could not recover the license code — metadata may not match the original key "
                "(features/expiry/subject changed).",
                "error",
            )
        return render_template(
            "view.html",
            row=row,
            feature_labels=FEATURE_LABELS,
            key_source=key_source,
        )

    @app.post("/revoke")
    @login_required
    def revoke_license():
        fp = (request.form.get("fingerprint") or "").strip().lower()
        reason = (request.form.get("reason") or "").strip()

        issued = next((e for e in load_issued_entries() if str(e.get("fingerprint") or "").lower() == fp), None)
        subject = (issued.get("subject") if isinstance(issued, dict) else "") or ""
        expires_at = issued.get("expires_at") if isinstance(issued, dict) else None

        try:
            added = _revoke_append_entry(
                fingerprint=fp,
                subject=str(subject or ""),
                expires_at=str(expires_at) if expires_at else None,
                reason=reason,
            )
        except Exception as exc:
            flash(str(exc), "error")
            return redirect(url_for("index"))

        flash("Recorded revocation." if added else "Already revoked.", "ok")
        return redirect(url_for("view_license", fingerprint=fp))

    @app.post("/delete")
    @login_required
    def delete_license():
        fp = (request.form.get("fingerprint") or "").strip().lower()
        which = (request.form.get("which") or "issued").strip().lower()
        try:
            if which == "revoked":
                ok = delete_revoked_license(fingerprint=fp)
            else:
                ok = delete_issued_license(fingerprint=fp)
        except Exception as exc:
            flash(str(exc), "error")
            return redirect(url_for("index"))
        flash("Deleted." if ok else "Nothing to delete.", "ok")
        return redirect(url_for("index"))

    @app.post("/unrevoke")
    @login_required
    def unrevoke_license():
        fp = (request.form.get("fingerprint") or "").strip().lower()
        try:
            ok = delete_revoked_license(fingerprint=fp)
        except Exception as exc:
            flash(str(exc), "error")
            return redirect(url_for("index"))
        flash("Removed from revoked list." if ok else "Not in revoked list.", "ok")
        return redirect(url_for("view_license", fingerprint=fp))

    @app.route("/profile", methods=["GET", "POST"], endpoint="profile_page")
    @login_required
    def profile_page():
        uid = _current_user_id()
        if request.method == "POST":
            ok, err = update_profile(
                uid,
                display_name=(request.form.get("display_name") or "").strip(),
                email=(request.form.get("email") or "").strip(),
                phone=(request.form.get("phone") or "").strip(),
                timezone=(request.form.get("timezone") or "").strip(),
                organization=(request.form.get("organization") or "").strip(),
            )
            if not ok:
                flash(err, "error")
                return redirect(url_for("profile_page"))
            flash("Profile saved.", "ok")
            return redirect(url_for("profile_page"))
        return render_template("profile.html", profile=_profile_for_template())

    @app.route("/account", methods=["GET", "POST"], endpoint="account_page")
    @login_required
    def account_page():
        uid = _current_user_id()
        if request.method == "POST":
            new_pw = (request.form.get("new_password") or "").strip()
            new_pw2 = (request.form.get("new_password2") or "").strip()
            if new_pw != new_pw2:
                flash("New passwords do not match.", "error")
                return redirect(url_for("account_page"))
            ok, err = update_credentials(
                uid,
                current_password=(request.form.get("current_password") or ""),
                new_username=(request.form.get("new_username") or "").strip(),
                new_password=new_pw,
            )
            if not ok:
                flash(err, "error")
                return redirect(url_for("account_page"))
            session["licensing_username"] = (request.form.get("new_username") or "").strip() or session.get(
                "licensing_username"
            )
            flash("Account updated. Use your new credentials next time you sign in.", "ok")
            return redirect(url_for("account_page"))
        return render_template("account.html", profile=_profile_for_template())

    @app.route("/users", methods=["GET", "POST"], endpoint="users_page")
    @admin_required
    def users_page():
        if request.method == "POST" and (request.form.get("action") or "").strip() == "add":
            ok, err = create_user(
                username=(request.form.get("username") or "").strip(),
                password=(request.form.get("password") or ""),
                role=(request.form.get("role") or ROLE_OPERATOR).strip(),
                display_name=(request.form.get("display_name") or "").strip(),
                email=(request.form.get("email") or "").strip(),
            )
            if not ok:
                flash(err, "error")
            else:
                flash("User added.", "ok")
            return redirect(url_for("users_page"))
        return render_template(
            "users.html",
            users=list_users_public(),
            current_user_id=_current_user_id(),
        )

    @app.post("/users/<user_id>/delete", endpoint="users_delete")
    @admin_required
    def users_delete(user_id: str):
        ok, err = delete_user(actor_id=_current_user_id(), target_id=user_id)
        if not ok:
            flash(err, "error")
        else:
            flash("User deleted.", "ok")
        return redirect(url_for("users_page"))

    @app.before_request
    def _ensure_local_data_files():
        ensure_users_store()
        try:
            load_revoked_entries()
        except Exception:
            return
        if not (_DIR / "revoked_licenses.json").exists():
            save_revoked_entries([])

    for _required in ("profile_page", "account_page", "users_page", "users_delete"):
        if _required not in app.view_functions:
            raise RuntimeError(f"Licensing webapp failed to register route endpoint: {_required}")

    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or 5055)
    create_app().run(host="127.0.0.1", port=port, debug=True)
