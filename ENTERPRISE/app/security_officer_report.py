"""PDF report builder for the Security Officer training dashboard."""

from __future__ import annotations

from datetime import date
from typing import Any

from fpdf import FPDF

REPORT_TITLE = "Security Officer — Training Completion Report"


def _pdf_text(value: str) -> str:
    """Keep PDF core fonts happy (Helvetica latin-1 subset)."""
    return value.encode("latin-1", "replace").decode("latin-1")


def _status_label(status: str) -> str:
    if status == "complete":
        return "Fully completed"
    if status == "in_progress":
        return "In progress"
    if status == "not_started":
        return "Not started"
    return "-"


def _kind_label(kind: str) -> str:
    labels = {
        "video": "Video",
        "slides": "Slides",
        "pdf": "PDF",
        "document": "Document",
        "spreadsheet": "Spreadsheet",
    }
    return labels.get((kind or "").lower(), "File")


def build_security_officer_report_pdf(payload: dict[str, Any], *, portal_name: str = "Firmgate") -> bytes:
    """Render dashboard stats + user table as a downloadable PDF."""
    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    users = payload.get("users") if isinstance(payload.get("users"), list) else []
    training_items = payload.get("training_items") if isinstance(payload.get("training_items"), list) else []
    modules = int(payload.get("training_modules") or 0)
    as_at = date.today().strftime("%d %b %Y")

    users_in_scope = int(summary.get("users_in_scope") or 0)
    all_complete = int(summary.get("all_complete") or 0)
    in_progress = int(summary.get("in_progress") or 0)
    not_started = int(summary.get("not_started") or 0)
    rate = summary.get("completion_rate_pct")
    rate_s = f"{rate}%" if rate is not None else "0%"

    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=14)
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 9, _pdf_text(REPORT_TITLE), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.multi_cell(
        0,
        5,
        _pdf_text(
            f"{portal_name} - Training completion overview for users who can access "
            f"Security Training materials. As at {as_at}."
        ),
    )
    pdf.ln(2)

    pdf.set_font("Helvetica", "B", 10)
    mod_heading = f"Training modules ({modules})" if modules else "Training modules"
    pdf.cell(0, 6, _pdf_text(mod_heading), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    if not training_items:
        pdf.cell(0, 5, _pdf_text("No training files uploaded."), new_x="LMARGIN", new_y="NEXT")
    else:
        line_w = pdf.w - pdf.l_margin - pdf.r_margin
        for i, item in enumerate(training_items, start=1):
            if not isinstance(item, dict):
                continue
            fname = str(item.get("name") or "Untitled").strip()
            kind = _kind_label(str(item.get("kind") or ""))
            ext = str(item.get("ext") or "").strip().upper()
            detail = f" ({kind}" + (f", {ext}" if ext else "") + ")"
            pdf.set_x(pdf.l_margin)
            pdf.multi_cell(line_w, 5, _pdf_text(f"{i}. {fname}{detail}"))
    pdf.ln(2)

    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, _pdf_text("Summary"), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    summary_lines = [
        f"Users in scope: {users_in_scope}",
        f"Fully completed: {all_complete}",
        f"In progress: {in_progress}",
        f"Not started: {not_started}",
        f"Completion rate: {rate_s} ({modules} training module{'s' if modules != 1 else ''})",
    ]
    for line in summary_lines:
        pdf.cell(0, 5, _pdf_text(line), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 7, _pdf_text("User progress"), new_x="LMARGIN", new_y="NEXT")

    col_w = (72, 38, 38, 22)
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_fill_color(241, 245, 249)
    for i, label in enumerate(("User", "Status", "Completed", "%")):
        pdf.cell(col_w[i], 7, _pdf_text(label), border=1, fill=True, align="L" if i < 2 else "R")
    pdf.ln()

    pdf.set_font("Helvetica", "", 9)
    if not users:
        pdf.cell(sum(col_w), 8, _pdf_text("No users in scope."), border=1)
        pdf.ln()
    else:
        for u in users:
            if not isinstance(u, dict):
                continue
            name = (u.get("full_name") or u.get("username") or u.get("email") or "User").strip()
            email = str(u.get("email") or "").strip()
            if email and email.lower() not in name.lower():
                name = f"{name} ({email})"
            status = _status_label(str(u.get("status") or ""))
            total = int(u.get("total") or 0)
            done = int(u.get("completed") or 0)
            pct = f"{round((done / total) * 100)}%" if total else "0%"
            row_h = 7
            pdf.cell(col_w[0], row_h, _pdf_text(name[:90]), border=1)
            pdf.cell(col_w[1], row_h, _pdf_text(status), border=1)
            pdf.cell(col_w[2], row_h, _pdf_text(f"{done} / {total}"), border=1, align="R")
            pdf.cell(col_w[3], row_h, _pdf_text(pct), border=1, align="R")
            pdf.ln()

    out = pdf.output()
    return out if isinstance(out, (bytes, bytearray)) else bytes(out)
