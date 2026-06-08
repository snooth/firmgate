from urllib.parse import urljoin, urlparse

from flask import Blueprint, flash, redirect, render_template, request, session, url_for
from flask_login import current_user, login_required, login_user, logout_user

from app.audit_service import write_audit
from app.extensions import db
from app.mfa_service import (
    generate_secret,
    get_user_totp_secret,
    issuer_name,
    mfa_enrolled,
    mfa_pending,
    mfa_required,
    provisioning_uri,
    qr_data_url,
    set_user_totp_secret,
    verify_totp,
)
from app.models import User
from app.onboarding import clear_password_change_required, password_change_required
from app import registration_service as regsvc


def _intranet_login_allowed(user: User) -> bool:
    """Resources without an intranet login cannot authenticate (see Workforce Resource profile)."""
    attrs = user.attributes if isinstance(user.attributes, dict) else {}
    return attrs.get("intranet_login_enabled") is not False


bp = Blueprint("auth", __name__, url_prefix="")

_SESSION_USER = "mfa_pending_user_id"
_SESSION_REMEMBER = "mfa_pending_remember"
_SESSION_NEXT = "mfa_pending_next"
_SESSION_SETUP_SECRET = "mfa_setup_secret"
_REG_SESSION_USER = "reg_pending_user_id"
_REG_SESSION_SETUP_SECRET = "reg_setup_secret"


def _is_safe_next(target: str) -> bool:
    """Allow only same-host redirects to avoid open redirects."""
    try:
        ref = urlparse(request.host_url)
        test = urlparse(urljoin(request.host_url, target))
        return (test.scheme in ("http", "https")) and (ref.netloc == test.netloc)
    except Exception:
        return False


def _clear_mfa_session() -> None:
    for key in (_SESSION_USER, _SESSION_REMEMBER, _SESSION_NEXT, _SESSION_SETUP_SECRET):
        session.pop(key, None)


def _pending_user() -> User | None:
    uid = session.get(_SESSION_USER)
    if not uid:
        return None
    try:
        u = db.session.get(User, int(uid))
    except (TypeError, ValueError):
        return None
    if not u or not u.is_active or not _intranet_login_allowed(u):
        _clear_mfa_session()
        return None
    return u


def _remember() -> bool:
    return bool(session.get(_SESSION_REMEMBER))


def _next_url() -> str:
    return session.get(_SESSION_NEXT) or ""


def _finish_login(user: User, remember: bool, next_url: str):
    if password_change_required(user):
        return _start_password_change_flow(user, remember, next_url)
    _clear_mfa_session()
    login_user(user, remember=remember)
    if next_url and _is_safe_next(next_url):
        return redirect(next_url)
    return redirect(url_for("intranet.intranet_page"))


def _continue_after_onboarding(user: User):
    """After password change (or when MFA is the next step)."""
    remember = _remember()
    nxt = _next_url()
    if mfa_pending(user):
        return _start_mfa_flow(user, remember, nxt)
    return _finish_login(user, remember, nxt)


def _start_password_change_flow(user: User, remember: bool, next_url: str):
    session[_SESSION_USER] = user.id
    session[_SESSION_REMEMBER] = remember
    session[_SESSION_NEXT] = next_url
    session.pop(_SESSION_SETUP_SECRET, None)
    return redirect(url_for("auth.login_change_password"))


def _start_mfa_flow(user: User, remember: bool, next_url: str):
    if password_change_required(user):
        return _start_password_change_flow(user, remember, next_url)
    session[_SESSION_USER] = user.id
    session[_SESSION_REMEMBER] = remember
    session[_SESSION_NEXT] = next_url
    session.pop(_SESSION_SETUP_SECRET, None)
    if mfa_enrolled(user):
        return redirect(url_for("auth.login_mfa"))
    return redirect(url_for("auth.login_mfa_setup"))


def _ensure_onboarding_order(user: User):
    """Redirect to password change before MFA when both are required."""
    if password_change_required(user):
        return redirect(url_for("auth.login_change_password"))
    return None


@bp.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        if password_change_required(current_user):
            return _start_password_change_flow(current_user, False, "")
        return redirect(url_for("intranet.intranet_page"))
    if request.method == "POST":
        email = (request.form.get("email") or "").strip()
        password = request.form.get("password") or ""
        user = None
        if email:
            e = email.lower()
            user = (
                User.query.filter(
                    (db.func.lower(User.email) == e) | (db.func.lower(User.username) == e)
                ).first()
            )
        pwd_ok = bool(user and user.check_password(password))
        if user and pwd_ok and not user.is_active:
            if regsvc.registration_pending(user):
                flash(
                    "Your registration is awaiting administrator approval. You will be able to sign in once approved.",
                    "info",
                )
            elif regsvc.registration_rejected(user):
                flash("Your registration was not approved. Contact an administrator.", "warning")
            else:
                flash("This account is inactive. Contact an administrator.", "warning")
        if user and user.is_active and pwd_ok and not _intranet_login_allowed(user):
            flash("No intranet login is enabled for this profile. Contact an administrator.", "warning")
        ok = bool(user and pwd_ok and user.is_active and _intranet_login_allowed(user))
        write_audit(
            user_id=user.id if user else None,
            username=email,
            action="auth.login",
            resource_type="user",
            resource_id=str(user.id) if user else None,
            success=ok,
            details={"email": email, "stage": "password"},
        )
        if ok:
            remember = bool(request.form.get("remember"))
            nxt = (request.args.get("next") or "").strip()
            if password_change_required(user):
                return _start_password_change_flow(user, remember, nxt)
            if mfa_pending(user):
                return _start_mfa_flow(user, remember, nxt)
            return _finish_login(user, remember, nxt)
        flash("Invalid credentials.", "danger")
    return render_template("login.html", show_register=regsvc.self_registration_enabled())


@bp.route("/login/change-password", methods=["GET", "POST"])
def login_change_password():
    user = _pending_user()
    if not user and current_user.is_authenticated:
        user = db.session.get(User, int(current_user.id))
        if user and password_change_required(user) and not session.get(_SESSION_USER):
            session[_SESSION_USER] = user.id
            session[_SESSION_REMEMBER] = False
            session[_SESSION_NEXT] = ""

    if not user:
        flash("Your sign-in session expired. Please sign in again.", "warning")
        return redirect(url_for("auth.login"))

    if not password_change_required(user):
        return _continue_after_onboarding(user)

    mfa_next = mfa_required(user)

    if request.method == "POST":
        current_pw = request.form.get("current_password") or ""
        new_pw = (request.form.get("password") or "").strip()
        new_pw2 = (request.form.get("password2") or "").strip()

        if not user.check_password(current_pw):
            flash("Current password is incorrect.", "danger")
        elif len(new_pw) < 8:
            flash("New password must be at least 8 characters.", "danger")
        elif new_pw != new_pw2:
            flash("New passwords do not match.", "danger")
        elif user.check_password(new_pw):
            flash("New password must be different from your current password.", "danger")
        else:
            user.set_password(new_pw)
            clear_password_change_required(user)
            db.session.add(user)
            db.session.commit()
            write_audit(
                user_id=user.id,
                username=user.username,
                action="auth.password_change",
                resource_type="user",
                resource_id=str(user.id),
                success=True,
                details={"first_login": True},
            )
            flash("Password updated.", "success")
            return _continue_after_onboarding(user)

    return render_template(
        "login_change_password.html",
        email=user.email or user.username,
        mfa_next=mfa_next,
    )


@bp.route("/login/mfa", methods=["GET", "POST"])
def login_mfa():
    if current_user.is_authenticated:
        return redirect(url_for("intranet.intranet_page"))
    user = _pending_user()
    if not user:
        flash("Your sign-in session expired. Please sign in again.", "warning")
        return redirect(url_for("auth.login"))
    redirect_pw = _ensure_onboarding_order(user)
    if redirect_pw:
        return redirect_pw
    if not mfa_required(user):
        return _finish_login(user, _remember(), _next_url())
    if not mfa_enrolled(user):
        return redirect(url_for("auth.login_mfa_setup"))

    if request.method == "POST":
        code = (request.form.get("code") or "").strip()
        secret = get_user_totp_secret(user)
        if secret and verify_totp(secret, code):
            write_audit(
                user_id=user.id,
                username=user.username,
                action="auth.login.mfa",
                resource_type="user",
                resource_id=str(user.id),
                success=True,
                details={},
            )
            return _finish_login(user, _remember(), _next_url())
        write_audit(
            user_id=user.id,
            username=user.username,
            action="auth.login.mfa",
            resource_type="user",
            resource_id=str(user.id),
            success=False,
            details={},
        )
        flash("Invalid authentication code. Try again.", "danger")

    return render_template(
        "login_mfa.html",
        email=user.email or user.username,
        setup_url=url_for("auth.login_mfa_setup"),
    )


@bp.route("/login/mfa/setup", methods=["GET", "POST"])
def login_mfa_setup():
    if current_user.is_authenticated:
        return redirect(url_for("intranet.intranet_page"))
    user = _pending_user()
    if not user:
        flash("Your sign-in session expired. Please sign in again.", "warning")
        return redirect(url_for("auth.login"))
    redirect_pw = _ensure_onboarding_order(user)
    if redirect_pw:
        return redirect_pw
    if not mfa_required(user):
        return _finish_login(user, _remember(), _next_url())
    if mfa_enrolled(user):
        return redirect(url_for("auth.login_mfa"))

    secret = session.get(_SESSION_SETUP_SECRET)
    if not secret:
        secret = generate_secret()
        session[_SESSION_SETUP_SECRET] = secret

    uri = provisioning_uri(user, secret)
    qr_src = qr_data_url(uri)

    if request.method == "POST":
        code = (request.form.get("code") or "").strip()
        if verify_totp(secret, code):
            set_user_totp_secret(user, secret)
            db.session.add(user)
            db.session.commit()
            write_audit(
                user_id=user.id,
                username=user.username,
                action="auth.mfa.enroll",
                resource_type="user",
                resource_id=str(user.id),
                success=True,
                details={},
            )
            return _finish_login(user, _remember(), _next_url())
        write_audit(
            user_id=user.id,
            username=user.username,
            action="auth.mfa.enroll",
            resource_type="user",
            resource_id=str(user.id),
            success=False,
            details={},
        )
        flash("Invalid code. Scan the QR code again or enter the current 6-digit code.", "danger")

    return render_template(
        "login_mfa_setup.html",
        email=user.email or user.username,
        qr_src=qr_src,
        secret=secret,
        issuer=issuer_name(),
    )


def _clear_reg_session() -> None:
    session.pop(_REG_SESSION_USER, None)
    session.pop(_REG_SESSION_SETUP_SECRET, None)


def _pending_reg_user() -> User | None:
    uid = session.get(_REG_SESSION_USER)
    if not uid:
        return None
    try:
        u = db.session.get(User, int(uid))
    except (TypeError, ValueError):
        return None
    if not u or not regsvc.registration_pending(u):
        _clear_reg_session()
        return None
    return u


def _find_user_by_email(email: str) -> User | None:
    e = email.lower()
    return (
        User.query.filter((db.func.lower(User.email) == e) | (db.func.lower(User.username) == e))
        .first()
    )


def _apply_registration_name(user: User, first_name: str, surname: str) -> None:
    attrs = dict(user.attributes) if isinstance(user.attributes, dict) else {}
    attrs["first_name"] = first_name
    attrs["surname"] = surname
    user.attributes = attrs
    composed = f"{first_name} {surname}".strip()
    if composed:
        user.full_name = composed


def _register_form_context() -> dict:
    return {
        "email": (request.form.get("email") or "").strip(),
        "first_name": (request.form.get("first_name") or "").strip(),
        "last_name": (request.form.get("last_name") or "").strip(),
    }


@bp.route("/register", methods=["GET", "POST"])
def register():
    if current_user.is_authenticated:
        return redirect(url_for("intranet.intranet_page"))
    if not regsvc.self_registration_enabled():
        flash("Self-service registration is not available. Contact an administrator.", "warning")
        return redirect(url_for("auth.login"))
    form = _register_form_context()
    email = form["email"]
    if request.method == "POST":
        password = request.form.get("password") or ""
        password2 = request.form.get("password2") or ""
        first_name = form["first_name"]
        last_name = form["last_name"]
        email_norm = email.lower()
        if not first_name or len(first_name) > 120:
            flash("Enter your first name (up to 120 characters).", "danger")
        elif not last_name or len(last_name) > 120:
            flash("Enter your last name (up to 120 characters).", "danger")
        elif not email or "@" not in email or len(email) > 255:
            flash("Enter a valid email address.", "danger")
        elif len(password) < 8:
            flash("Password must be at least 8 characters.", "danger")
        elif password != password2:
            flash("Passwords do not match.", "danger")
        else:
            existing = _find_user_by_email(email_norm)
            if existing and existing.is_active:
                flash("An account with this email already exists. Sign in instead.", "danger")
            elif existing and regsvc.registration_pending(existing):
                flash("A registration for this email is already awaiting approval.", "warning")
            else:
                if existing and regsvc.registration_rejected(existing):
                    u = existing
                    u.set_password(password)
                    _apply_registration_name(u, first_name, last_name)
                    regsvc.mark_registration_pending(u)
                else:
                    if existing:
                        flash("This email cannot be used for registration. Contact an administrator.", "danger")
                        return render_template("register.html", **form)
                    u = User(
                        username=email_norm,
                        email=email.strip(),
                        is_active=False,
                        attributes={},
                    )
                    u.set_password(password)
                    _apply_registration_name(u, first_name, last_name)
                    regsvc.mark_registration_pending(u)
                    db.session.add(u)
                db.session.commit()
                session[_REG_SESSION_USER] = u.id
                session.pop(_REG_SESSION_SETUP_SECRET, None)
                write_audit(
                    user_id=u.id,
                    username=u.username,
                    action="auth.register",
                    resource_type="user",
                    resource_id=str(u.id),
                    success=True,
                    details={
                        "email": email_norm,
                        "first_name": first_name,
                        "surname": last_name,
                    },
                )
                return redirect(url_for("auth.register_mfa_setup"))
    return render_template("register.html", **form)


@bp.route("/register/mfa/setup", methods=["GET", "POST"])
def register_mfa_setup():
    if current_user.is_authenticated:
        return redirect(url_for("intranet.intranet_page"))
    if not regsvc.self_registration_enabled():
        return redirect(url_for("auth.login"))
    user = _pending_reg_user()
    if not user:
        flash("Your registration session expired. Please start again.", "warning")
        return redirect(url_for("auth.register"))
    if mfa_enrolled(user):
        return redirect(url_for("auth.register_pending"))

    secret = session.get(_REG_SESSION_SETUP_SECRET)
    if not secret:
        secret = generate_secret()
        session[_REG_SESSION_SETUP_SECRET] = secret

    uri = provisioning_uri(user, secret)
    qr_src = qr_data_url(uri)

    if request.method == "POST":
        code = (request.form.get("code") or "").strip()
        if verify_totp(secret, code):
            set_user_totp_secret(user, secret)
            db.session.add(user)
            db.session.commit()
            try:
                from app.registration_notifications import send_registration_notifications

                notify_result = send_registration_notifications(user)
            except Exception:
                notify_result = {"error": "notify_failed"}
                try:
                    from flask import current_app

                    current_app.logger.exception("registration notification email failed")
                except Exception:
                    pass
            _clear_reg_session()
            write_audit(
                user_id=user.id,
                username=user.username,
                action="auth.register.mfa",
                resource_type="user",
                resource_id=str(user.id),
                success=True,
                details={"notify": notify_result if isinstance(notify_result, dict) else {}},
            )
            flash("Registration submitted. An administrator must approve your account before you can sign in.", "success")
            return redirect(url_for("auth.register_pending", email=user.email or user.username))
        flash("Invalid code. Scan the QR code again or enter the current 6-digit code.", "danger")

    return render_template(
        "register_mfa_setup.html",
        email=user.email or user.username,
        qr_src=qr_src,
        secret=secret,
        issuer=issuer_name(),
    )


@bp.route("/register/pending")
def register_pending():
    email = (request.args.get("email") or "").strip()
    return render_template("register_pending.html", email=email)


@bp.route("/logout")
@login_required
def logout():
    write_audit(
        user_id=current_user.id,
        username=current_user.username,
        action="auth.logout",
        resource_type="user",
        resource_id=str(current_user.id),
    )
    logout_user()
    _clear_mfa_session()
    return redirect(url_for("auth.login"))
