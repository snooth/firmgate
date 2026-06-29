"""
Attribute-based checks layered on top of RBAC.

Policies use JSON attributes on User (`user.attributes`) and FileNode (`node.attributes`).
Default keys (all optional):
  - user: clearance (int), department (str)
  - resource: classification (int), allowed_departments (list[str])
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.models import FileNode, User


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def evaluate_file_access(user: User, node: FileNode, action: str) -> tuple[bool, str | None]:
    """
    Return (allowed, denial_reason). If allowed, denial_reason is None.
    Owner always passes ABAC (RBAC still applies separately).
    """
    if user.id == node.owner_id:
        return True, None

    ua = user.attributes or {}
    ra = node.attributes or {}

    user_clearance = _as_int(ua.get("clearance"), 0)
    file_class = _as_int(ra.get("classification"), 0)
    if file_class > 0 and user_clearance < file_class:
        return False, "ABAC: insufficient clearance for resource classification"

    allowed_depts = ra.get("allowed_departments")
    if isinstance(allowed_depts, list) and allowed_depts:
        dept = ua.get("department")
        if dept not in allowed_depts:
            return False, "ABAC: department not allowed for this resource"

    sensitive_write = ra.get("sensitive_write_only_owner")
    if sensitive_write and action in ("write", "delete", "move"):
        return False, "ABAC: only owner may modify this sensitive resource"

    return True, None
