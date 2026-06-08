"""Project groups for Timesheet Collection (Administration → Timesheets management)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from app.models import User
from app.settings import get_setting, set_setting

SETTING_KEY = "timesheet_collection_groups"
_MAX_GROUPS = 50
_MAX_NAME_LEN = 120


def _coerce_groups(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        gid = str(item.get("id") or "").strip() or str(uuid4())
        name = str(item.get("name") or "").strip()[:_MAX_NAME_LEN]
        if not name:
            continue
        user_ids: list[int] = []
        seen: set[int] = set()
        for uid in item.get("user_ids") or []:
            try:
                n = int(uid)
            except (TypeError, ValueError):
                continue
            if n in seen:
                continue
            seen.add(n)
            user_ids.append(n)
        out.append({"id": gid, "name": name, "user_ids": user_ids})
    return out


def list_collection_groups() -> list[dict[str, Any]]:
    return _coerce_groups(get_setting(SETTING_KEY, default=[]))


def collection_group_users_for_admin() -> list[dict[str, Any]]:
    users = (
        User.query.filter(User.is_active.is_(True))
        .order_by(User.full_name.asc(), User.username.asc())
        .all()
    )
    out: list[dict[str, Any]] = []
    for u in users:
        label = (u.full_name or u.username or f"User {u.id}").strip()
        out.append({"id": u.id, "label": label})
    return out


def collection_groups_for_api() -> dict[str, Any]:
    return {
        "groups": list_collection_groups(),
        "users": collection_group_users_for_admin(),
    }


def save_collection_groups(payload: dict[str, Any]) -> dict[str, Any] | tuple[dict[str, str], int]:
    raw_groups = payload.get("groups")
    if not isinstance(raw_groups, list):
        return {"error": "groups must be a list."}, 400
    if len(raw_groups) > _MAX_GROUPS:
        return {"error": f"At most {_MAX_GROUPS} project groups allowed."}, 400

    active_ids = {u["id"] for u in collection_group_users_for_admin()}
    normalized: list[dict[str, Any]] = []
    assigned: dict[int, str] = {}

    for idx, item in enumerate(raw_groups):
        if not isinstance(item, dict):
            return {"error": f"Group {idx + 1} is invalid."}, 400
        gid = str(item.get("id") or "").strip() or str(uuid4())
        name = str(item.get("name") or "").strip()[:_MAX_NAME_LEN]
        if not name:
            return {"error": f"Group {idx + 1} needs a project name."}, 400
        user_ids: list[int] = []
        seen: set[int] = set()
        for uid in item.get("user_ids") or []:
            try:
                n = int(uid)
            except (TypeError, ValueError):
                continue
            if n not in active_ids:
                continue
            if n in seen:
                continue
            if n in assigned:
                return {
                    "error": f"User is assigned to more than one group ({assigned[n]} and {name}).",
                }, 400
            seen.add(n)
            assigned[n] = name
            user_ids.append(n)
        normalized.append({"id": gid, "name": name, "user_ids": user_ids})

    set_setting(SETTING_KEY, normalized)
    return collection_groups_for_api()


def group_collection_rows(
    rows: list[dict[str, Any]],
    groups: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Split collection rows into ordered sections for display."""
    groups = groups if groups is not None else list_collection_groups()
    if not groups:
        sorted_rows = sorted(rows, key=lambda r: str(r.get("employee_name") or "").lower())
        return [{"id": "", "name": "", "show_header": False, "rows": sorted_rows}]

    row_by_uid = {int(r["user_id"]): r for r in rows if r.get("user_id") is not None}
    assigned: set[int] = set()
    sections: list[dict[str, Any]] = []

    for group in groups:
        group_rows: list[dict[str, Any]] = []
        for uid in group.get("user_ids") or []:
            try:
                n = int(uid)
            except (TypeError, ValueError):
                continue
            if n in assigned:
                continue
            row = row_by_uid.get(n)
            if row:
                group_rows.append(row)
                assigned.add(n)
        group_rows.sort(key=lambda r: str(r.get("employee_name") or "").lower())
        sections.append(
            {
                "id": str(group.get("id") or ""),
                "name": str(group.get("name") or ""),
                "show_header": True,
                "rows": group_rows,
            }
        )

    ungrouped = [r for uid, r in row_by_uid.items() if uid not in assigned]
    ungrouped.sort(key=lambda r: str(r.get("employee_name") or "").lower())
    if ungrouped:
        sections.append(
            {
                "id": "",
                "name": "Ungrouped",
                "show_header": True,
                "rows": ungrouped,
            }
        )
    return [s for s in sections if s.get("rows")]
