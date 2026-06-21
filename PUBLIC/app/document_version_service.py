"""Append-only version history for office documents edited in OnlyOffice / Office 365."""

from __future__ import annotations

from app.extensions import db
from app.models import FileNode, FileVersion, utcnow

OFFICE_EDITABLE_EXTENSIONS = frozenset(
    {
        "doc",
        "docx",
        "dot",
        "dotx",
        "odt",
        "rtf",
        "txt",
        "xls",
        "xlsx",
        "xlsm",
        "ods",
        "csv",
        "ppt",
        "pptx",
        "pps",
        "ppsx",
        "odp",
    }
)


def is_office_editable_filename(name: str) -> bool:
    n = (name or "").strip().lower()
    if "." not in n:
        return False
    return n.rsplit(".", 1)[-1] in OFFICE_EDITABLE_EXTENSIONS


def append_document_version(
    node: FileNode,
    *,
    user_id: int,
    relpath: str,
    size: int,
    sha256: str,
    mime: str | None,
    skip_if_unchanged: bool = True,
) -> tuple[bool, FileVersion | None]:
    """Create a new current version row; keep prior versions for history.

    Returns (created_new_row, version_row). When content is unchanged and
    skip_if_unchanged is True, returns (False, current_version).
    """
    cur = (
        db.session.query(FileVersion)
        .filter_by(file_node_id=node.id, is_current=True)
        .order_by(FileVersion.version_number.desc())
        .first()
    )
    if skip_if_unchanged and cur and (cur.sha256 or "").lower() == (sha256 or "").lower():
        return False, cur

    last_v = (
        db.session.query(FileVersion)
        .filter_by(file_node_id=node.id)
        .order_by(FileVersion.version_number.desc())
        .first()
    )
    next_v = (last_v.version_number + 1) if last_v else 1
    if cur:
        cur.is_current = False

    fv = FileVersion(
        file_node_id=node.id,
        version_number=next_v,
        storage_relpath=relpath,
        size_bytes=int(size),
        sha256=sha256,
        mime_type=mime,
        created_at=utcnow(),
        created_by_id=int(user_id),
        is_current=True,
    )
    db.session.add(fv)
    node.updated_at = utcnow()
    db.session.commit()
    return True, fv
