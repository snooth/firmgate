"""Email notifications for KanBan card activity (assignments, comments, moves, due dates)."""

from __future__ import annotations

import html
from datetime import datetime
from typing import Any

from app.branding import portal_display_name_from_settings
from app.email_service import send_email
from app.models import KanbanCard, User

SETTING_KEY = "kanban_notifications"

EVENT_ASSIGNED = "assigned"
EVENT_COMMENTED = "commented"
EVENT_MOVED = "moved"
EVENT_MARKED_DONE = "marked_done"
EVENT_DUE_DATE = "due_date"

EVENTS: tuple[str, ...] = (
    EVENT_ASSIGNED,
    EVENT_COMMENTED,
    EVENT_MOVED,
    EVENT_MARKED_DONE,
    EVENT_DUE_DATE,
)

_EVENT_META: dict[str, dict[str, str]] = {
    EVENT_ASSIGNED: {
        "toggle_key": "notify_assigned",
        "label": "Card assigned",
        "default_subject": 'KanBan: You were assigned to "{card_title}"',
        "default_body": """Hi {first_name},

{actor_name} assigned you to the KanBan card "{card_title}" in the {column_name} column.

View card: {card_url}

— {portal_name}
""",
    },
    EVENT_COMMENTED: {
        "toggle_key": "notify_commented",
        "label": "New comment",
        "default_subject": 'KanBan: New comment on "{card_title}"',
        "default_body": """Hi {first_name},

{actor_name} commented on "{card_title}":

{comment_preview}

View card: {card_url}

— {portal_name}
""",
    },
    EVENT_MOVED: {
        "toggle_key": "notify_moved",
        "label": "Card moved",
        "default_subject": 'KanBan: "{card_title}" moved to {to_column}',
        "default_body": """Hi {first_name},

{actor_name} moved "{card_title}" from {from_column} to {to_column}.

View card: {card_url}

— {portal_name}
""",
    },
    EVENT_MARKED_DONE: {
        "toggle_key": "notify_marked_done",
        "label": "Marked done",
        "default_subject": 'KanBan: "{card_title}" marked done',
        "default_body": """Hi {first_name},

{actor_name} marked "{card_title}" as done ({column_name}).

View card: {card_url}

— {portal_name}
""",
    },
    EVENT_DUE_DATE: {
        "toggle_key": "notify_due_date",
        "label": "Due date set or changed",
        "default_subject": 'KanBan: Due date updated on "{card_title}"',
        "default_body": """Hi {first_name},

{actor_name} set the due date for "{card_title}" to {due_at_label}.

View card: {card_url}

— {portal_name}
""",
    },
}

_PLACEHOLDERS: tuple[str, ...] = (
    "{first_name}",
    "{display_name}",
    "{email}",
    "{actor_name}",
    "{card_title}",
    "{card_url}",
    "{column_name}",
    "{from_column}",
    "{to_column}",
    "{due_at}",
    "{due_at_label}",
    "{comment_preview}",
    "{portal_name}",
)


def _coerce(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def _render_template(template: str, context: dict[str, str]) -> str:
    out = template or ""
    for key, val in context.items():
        out = out.replace("{" + key + "}", val or "")
    return out


def _portal_name() -> str:
    return portal_display_name_from_settings()


def _portal_logo_url() -> str:
    from app.branding import portal_logo_email_url
    from app.settings import get_setting

    portal = get_setting("portal", default={}) or {}
    return portal_logo_email_url(portal)


def _kanban_card_url(card_id: int) -> str:
    from flask import url_for

    from app.extensions import db
    from app.models import KanbanCard, KanbanColumn

    board_id: int | None = None
    card = db.session.get(KanbanCard, int(card_id))
    if card:
        col = db.session.get(KanbanColumn, card.column_id)
        if col:
            board_id = int(col.board_id)
    try:
        if board_id:
            return (
                url_for("intranet.kanban_board_page", board_id=int(board_id), _external=True)
                + f"?card={int(card_id)}"
            )
        return url_for("intranet.kanban_page", _external=True)
    except Exception:
        if board_id:
            return f"/intranet/kanban/board/{int(board_id)}?card={int(card_id)}"
        return f"/intranet/kanban?card={int(card_id)}"


def _user_display_name(user: User | None) -> str:
    if not user:
        return ""
    name = (getattr(user, "full_name", None) or "").strip()
    if name:
        return name
    return (user.username or user.email or f"User {user.id}").strip()


def _user_first_name(user: User) -> str:
    attrs = user.attributes if isinstance(getattr(user, "attributes", None), dict) else {}
    fn = str(attrs.get("first_name") or "").strip()
    if fn:
        return fn
    display = _user_display_name(user)
    return display.split()[0] if display else ""


def _user_email(user: User) -> str:
    for candidate in (user.email, user.username):
        addr = str(candidate or "").strip()
        if addr and "@" in addr:
            return addr
    return ""


def _due_at_label(value: datetime | None) -> str:
    if not value:
        return "none"
    try:
        return value.strftime("%d/%m/%Y, %I:%M %p").replace(" 0", " ")
    except Exception:
        return value.isoformat()


def _event_subject_body(settings: dict[str, Any], event: str) -> tuple[str, str]:
    meta = _EVENT_META[event]
    subject = str(settings.get(f"{event}_subject") or meta["default_subject"]).strip()
    body = str(settings.get(f"{event}_body") or meta["default_body"]).strip()
    return subject, body


def get_notification_settings() -> dict[str, Any]:
    from app.settings import get_setting

    v = _coerce(get_setting(SETTING_KEY, default={}))
    out: dict[str, Any] = {"enabled": bool(v.get("enabled", True))}
    for event in EVENTS:
        meta = _EVENT_META[event]
        out[meta["toggle_key"]] = bool(v.get(meta["toggle_key"], True))
        out[f"{event}_subject"] = str(v.get(f"{event}_subject") or meta["default_subject"]).strip()
        out[f"{event}_body"] = str(v.get(f"{event}_body") or meta["default_body"]).strip()
    return out


def notification_settings_for_api() -> dict[str, Any]:
    from flask_login import current_user

    s = get_notification_settings()
    defaults: dict[str, Any] = {"enabled": True}
    toggles: dict[str, bool] = {}
    for event in EVENTS:
        meta = _EVENT_META[event]
        defaults[meta["toggle_key"]] = True
        defaults[f"{event}_subject"] = meta["default_subject"]
        defaults[f"{event}_body"] = meta["default_body"]
        toggles[event] = {
            "key": meta["toggle_key"],
            "label": meta["label"],
        }
    test_recipient_default = ""
    if current_user.is_authenticated:
        test_recipient_default = _user_email(current_user)
    return {
        **s,
        "events": toggles,
        "placeholders": list(_PLACEHOLDERS),
        "defaults": defaults,
        "test_recipient_default": test_recipient_default,
    }


def save_notification_settings(payload: dict[str, Any]) -> dict[str, Any]:
    from app.settings import get_setting, set_setting

    cur = _coerce(get_setting(SETTING_KEY, default={}))
    nxt = dict(cur)
    nxt["enabled"] = bool(payload.get("enabled"))
    for event in EVENTS:
        meta = _EVENT_META[event]
        if meta["toggle_key"] in payload:
            nxt[meta["toggle_key"]] = bool(payload.get(meta["toggle_key"]))
        if f"{event}_subject" in payload:
            nxt[f"{event}_subject"] = str(payload.get(f"{event}_subject") or "").strip()[:500]
        if f"{event}_body" in payload:
            nxt[f"{event}_body"] = str(payload.get(f"{event}_body") or "").strip()[:20000]
    set_setting(SETTING_KEY, nxt)
    return notification_settings_for_api()


def _build_context(
    *,
    card: KanbanCard,
    actor: User,
    recipient: User,
    comment_preview: str = "",
    from_column: str = "",
    to_column: str = "",
) -> dict[str, str]:
    col = card.column
    column_name = (col.title if col else "") or ""
    cid = getattr(card, "id", None)
    if cid:
        try:
            card_url = _kanban_card_url(int(cid))
        except Exception:
            card_url = "/intranet/kanban"
    else:
        try:
            from flask import url_for

            card_url = url_for("intranet.kanban_page", _external=True)
        except Exception:
            card_url = "/intranet/kanban"
    due = card.due_at
    return {
        "first_name": _user_first_name(recipient),
        "display_name": _user_display_name(recipient),
        "email": _user_email(recipient),
        "actor_name": _user_display_name(actor),
        "card_title": (card.title or "Untitled").strip(),
        "card_url": card_url,
        "column_name": column_name,
        "from_column": from_column or column_name,
        "to_column": to_column or column_name,
        "due_at": due.isoformat() if due else "",
        "due_at_label": _due_at_label(due),
        "comment_preview": (comment_preview or "").strip()[:500],
        "portal_name": _portal_name(),
        "portal_logo_url": _portal_logo_url(),
    }


def _esc(value: str | None) -> str:
    return html.escape(str(value or ""), quote=True)


def _event_email_content(event: str, ctx: dict[str, str]) -> tuple[str, str, list[tuple[str, str]]]:
    """Return headline, message paragraph, and optional card meta rows for HTML email."""
    actor = ctx.get("actor_name") or "Someone"
    card_title = ctx.get("card_title") or "Untitled"
    column = ctx.get("column_name") or ""
    from_col = ctx.get("from_column") or ""
    to_col = ctx.get("to_column") or ""
    due_label = ctx.get("due_at_label") or ""
    comment = (ctx.get("comment_preview") or "").strip()

    if event == EVENT_ASSIGNED:
        headline = "You were assigned to a card"
        message = f"{_esc(actor)} assigned you to <strong>{_esc(card_title)}</strong>"
        if column:
            message += f" in the <strong>{_esc(column)}</strong> column"
        message += "."
        meta = [("Column", column)] if column else []
        return headline, message, meta

    if event == EVENT_COMMENTED:
        headline = "New comment on a card"
        message = f"{_esc(actor)} commented on <strong>{_esc(card_title)}</strong>."
        meta = [("Column", column)] if column else []
        if comment:
            message += (
                '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
                'style="margin-top:16px;background:#fff;border-left:4px solid #2563eb;border-radius:8px;">'
                "<tr><td style=\"padding:14px 16px;color:#475569;font-size:14px;line-height:1.55;\">"
                f"{_esc(comment)}</td></tr></table>"
            )
        return headline, message, meta

    if event == EVENT_MOVED:
        headline = "Card moved"
        message = (
            f"{_esc(actor)} moved <strong>{_esc(card_title)}</strong> "
            f"from <strong>{_esc(from_col or 'a column')}</strong> "
            f"to <strong>{_esc(to_col or 'a column')}</strong>."
        )
        return headline, message, [("From", from_col), ("To", to_col)]

    if event == EVENT_MARKED_DONE:
        headline = "Card marked done"
        message = f"{_esc(actor)} marked <strong>{_esc(card_title)}</strong> as done"
        if column:
            message += f" in <strong>{_esc(column)}</strong>"
        message += "."
        return headline, message, [("Column", column)] if column else []

    if event == EVENT_DUE_DATE:
        headline = "Due date updated"
        message = (
            f"{_esc(actor)} set the due date for <strong>{_esc(card_title)}</strong> "
            f"to <strong>{_esc(due_label or 'none')}</strong>."
        )
        return headline, message, [("Due", due_label)] if due_label else []

    headline = "KanBan update"
    return headline, f"There is an update on <strong>{_esc(card_title)}</strong>.", []


def _build_kanban_email_html(*, event: str, ctx: dict[str, str], subject: str) -> str:
    headline, message, meta_rows = _event_email_content(event, ctx)
    portal = _esc(ctx.get("portal_name") or "Your intranet")
    logo_url = (ctx.get("portal_logo_url") or "").strip()
    first_name = _esc(ctx.get("first_name") or "there")
    card_title = _esc(ctx.get("card_title") or "Untitled")
    card_url = _esc(ctx.get("card_url") or "#")
    subject_text = _esc(subject)

    meta_html = ""
    if meta_rows:
        row_parts = []
        for label, value in meta_rows:
            if not value:
                continue
            row_parts.append(
                "<tr>"
                f'<td style="padding:6px 16px 6px 0;color:#64748b;font-size:12px;white-space:nowrap;">{_esc(label)}</td>'
                f'<td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;">{_esc(value)}</td>'
                "</tr>"
            )
        if row_parts:
            meta_html = (
                '<table role="presentation" cellpadding="0" cellspacing="0" '
                'style="margin-top:12px;width:100%;">'
                + "".join(row_parts)
                + "</table>"
            )

    logo_block = ""
    if logo_url:
        logo_block = f"""          <tr>
            <td style="padding:22px 28px 0;background:#ffffff;">
              <img src="{_esc(logo_url)}" alt="{portal}" height="36" style="display:block;height:36px;width:auto;max-width:200px;border:0;outline:none;text-decoration:none;">
            </td>
          </tr>
"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>{subject_text}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,0.08);">
{logo_block}          <tr>
            <td style="background:linear-gradient(135deg,#2563eb 0%,#1d4ed8 100%);padding:24px 28px;">
              <div style="color:rgba(255,255,255,0.82);font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">KanBan</div>
              <div style="color:#ffffff;font-size:22px;font-weight:700;line-height:1.3;margin-top:8px;">{headline}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.5;">Hi {first_name},</p>
              <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.65;">{message}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:24px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <div style="font-size:11px;font-weight:700;color:#64748b;letter-spacing:0.06em;text-transform:uppercase;">Card</div>
                    <div style="font-size:18px;font-weight:700;color:#0f172a;margin-top:6px;line-height:1.35;">{card_title}</div>
                    {meta_html}
                  </td>
                </tr>
              </table>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background:#2563eb;">
                    <a href="{card_url}" style="display:inline-block;padding:13px 26px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:8px;">Open card</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.55;">
                Sent by {portal}. You received this because KanBan email notifications are enabled for your account.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def _send_kanban_email(
    *,
    to_addr: str,
    subject: str,
    body: str,
    event: str,
    ctx: dict[str, str],
) -> tuple[bool, str]:
    html_body = _build_kanban_email_html(event=event, ctx=ctx, subject=subject)
    return send_email(to_addrs=[to_addr], subject=subject, body=body, html_body=html_body)


def _event_enabled(settings: dict[str, Any], event: str) -> bool:
    if not settings.get("enabled"):
        return False
    meta = _EVENT_META[event]
    return bool(settings.get(meta["toggle_key"], True))


def _dedupe_users(users: list[User]) -> list[User]:
    seen: set[str] = set()
    out: list[User] = []
    for user in users:
        email = _user_email(user).lower()
        if not email or email in seen:
            continue
        seen.add(email)
        out.append(user)
    return out


def _send_event(
    event: str,
    *,
    card: KanbanCard,
    actor: User,
    recipients: list[User],
    comment_preview: str = "",
    from_column: str = "",
    to_column: str = "",
) -> dict[str, Any]:
    settings = get_notification_settings()
    result: dict[str, Any] = {"event": event, "sent": 0, "failed": 0, "skipped": None, "messages": []}
    if not _event_enabled(settings, event):
        result["skipped"] = "disabled"
        return result

    actor_id = int(actor.id)
    targets = _dedupe_users([u for u in recipients if int(u.id) != actor_id and _user_email(u)])
    if not targets:
        result["skipped"] = "no_recipients"
        return result

    subject_tpl, body_tpl = _event_subject_body(settings, event)
    for user in targets:
        ctx = _build_context(
            card=card,
            actor=actor,
            recipient=user,
            comment_preview=comment_preview,
            from_column=from_column,
            to_column=to_column,
        )
        subject = _render_template(subject_tpl, ctx)[:500]
        body = _render_template(body_tpl, ctx)
        ok, msg = _send_kanban_email(
            to_addr=_user_email(user),
            subject=subject,
            body=body,
            event=event,
            ctx=ctx,
        )
        if ok:
            result["sent"] += 1
        else:
            result["failed"] += 1
            result["messages"].append(f"{_user_email(user)}: {msg}")
    return result


def _card_watchers(card: KanbanCard, *, include_assignee: bool = True, include_creator: bool = True) -> list[User]:
    from app.extensions import db

    out: list[User] = []
    if include_assignee and card.assignee_id:
        user = db.session.get(User, int(card.assignee_id))
        if user and user.is_active:
            out.append(user)
    if include_creator and card.created_by_id:
        user = db.session.get(User, int(card.created_by_id))
        if user and user.is_active:
            out.append(user)
    return out


def notify_card_assigned(card: KanbanCard, actor: User) -> dict[str, Any]:
    from app.extensions import db

    assignee = db.session.get(User, int(card.assignee_id)) if card.assignee_id else None
    recipients = [assignee] if assignee and assignee.is_active else []
    return _send_event(EVENT_ASSIGNED, card=card, actor=actor, recipients=recipients)


def notify_card_commented(card: KanbanCard, actor: User, *, comment_preview: str) -> dict[str, Any]:
    return _send_event(
        EVENT_COMMENTED,
        card=card,
        actor=actor,
        recipients=_card_watchers(card),
        comment_preview=comment_preview,
    )


def notify_card_moved(card: KanbanCard, actor: User, *, from_column: str, to_column: str) -> dict[str, Any]:
    return _send_event(
        EVENT_MOVED,
        card=card,
        actor=actor,
        recipients=_card_watchers(card),
        from_column=from_column,
        to_column=to_column,
    )


def notify_card_marked_done(card: KanbanCard, actor: User, *, column_name: str) -> dict[str, Any]:
    return _send_event(
        EVENT_MARKED_DONE,
        card=card,
        actor=actor,
        recipients=_card_watchers(card),
        to_column=column_name,
    )


def notify_card_due_date(card: KanbanCard, actor: User) -> dict[str, Any]:
    assignee = None
    if card.assignee_id:
        from app.extensions import db

        assignee = db.session.get(User, int(card.assignee_id))
    recipients = [assignee] if assignee and assignee.is_active else _card_watchers(card, include_creator=False)
    return _send_event(EVENT_DUE_DATE, card=card, actor=actor, recipients=recipients)


def _settings_from_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    settings = dict(get_notification_settings())
    if not payload:
        return settings
    if "enabled" in payload:
        settings["enabled"] = bool(payload.get("enabled"))
    for event in EVENTS:
        meta = _EVENT_META[event]
        if meta["toggle_key"] in payload:
            settings[meta["toggle_key"]] = bool(payload.get(meta["toggle_key"]))
        sub_key = f"{event}_subject"
        body_key = f"{event}_body"
        if sub_key in payload:
            settings[sub_key] = str(payload.get(sub_key) or "").strip()
        if body_key in payload:
            settings[body_key] = str(payload.get(body_key) or "").strip()
    return settings


def send_test_notification(
    *,
    to_addr: str,
    event: str = EVENT_ASSIGNED,
    settings_override: dict[str, Any] | None = None,
) -> tuple[bool, str]:
    from app.extensions import db

    addr = str(to_addr or "").strip()
    if not addr or "@" not in addr:
        return False, "Enter a valid email address."
    if event not in EVENTS:
        event = EVENT_ASSIGNED

    actor = db.session.query(User).filter(User.is_active.is_(True)).order_by(User.id.asc()).first()
    if not actor:
        return False, "No active users found for sample content."

    card = db.session.query(KanbanCard).order_by(KanbanCard.id.desc()).first()
    if not card:
        card = KanbanCard(title="Sample KanBan card", body="Example description for a test email.")

    settings = _settings_from_payload(settings_override)
    subject_tpl, body_tpl = _event_subject_body(settings, event)
    ctx = _build_context(
        card=card,
        actor=actor,
        recipient=actor,
        comment_preview="This is a sample comment preview.",
        from_column="To do",
        to_column="In progress",
    )
    ctx["first_name"] = "there"
    ctx["display_name"] = addr.split("@", 1)[0] or "there"
    ctx["email"] = addr
    subject = f"[Test] {_render_template(subject_tpl, ctx)}"[:500]
    body = _render_template(body_tpl, ctx)
    ok, msg = _send_kanban_email(
        to_addr=addr,
        subject=subject,
        body=body,
        event=event,
        ctx=ctx,
    )
    if ok:
        return True, f"Test email sent to {addr}."
    return False, msg or "Test email failed."
