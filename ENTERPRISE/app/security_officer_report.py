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


def _user_display_name(u: dict) -> str:
    """Name + email on separate lines so the PDF table can wrap cleanly."""
    name = (u.get("full_name") or u.get("username") or u.get("email") or "User").strip()
    email = str(u.get("email") or "").strip()
    if email and email.lower() not in name.lower():
        return f"{name}\n{email}"
    return name


def _wrapped_line_count(pdf: FPDF, w: float, text: str, line_h: float) -> int:
    lines = pdf.multi_cell(w, line_h, _pdf_text(text), split_only=True)
    return max(1, len(lines))


def _table_col_widths(pdf: FPDF) -> tuple[float, float, float, float]:
    """Even column spacing across the printable page width."""
    content_w = pdf.w - pdf.l_margin - pdf.r_margin
    return (
        content_w * 0.46,
        content_w * 0.24,
        content_w * 0.18,
        content_w * 0.12,
    )


def _draw_user_progress_header(pdf: FPDF, col_w: tuple[float, float, float, float], *, line_h: float = 5.0) -> None:
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_fill_color(241, 245, 249)
    for i, label in enumerate(("User", "Status", "Completed", "%")):
        align = "L" if i < 2 else "R"
        pdf.cell(col_w[i], 7, _pdf_text(label), border=1, fill=True, align=align)
    pdf.ln()


def _draw_user_progress_row(
    pdf: FPDF,
    col_w: tuple[float, float, float, float],
    cells: tuple[str, str, str, str],
    *,
    line_h: float = 4.5,
    pad_x: float = 1.2,
    pad_y: float = 1.0,
) -> None:
    """Draw one table row with wrapped text and a shared row height."""
    aligns = ("L", "L", "R", "R")
    x0 = pdf.l_margin
    y0 = pdf.get_y()
    row_h = max(_wrapped_line_count(pdf, col_w[i] - (pad_x * 2), cells[i], line_h) * line_h for i in range(4))
    row_h = max(row_h + (pad_y * 2), line_h + (pad_y * 2))

    if y0 + row_h > pdf.page_break_trigger:
        pdf.add_page()
        y0 = pdf.get_y()
        _draw_user_progress_header(pdf, col_w, line_h=line_h)
        y0 = pdf.get_y()

    x = x0
    for i, (w, text) in enumerate(zip(col_w, cells)):
        pdf.rect(x, y0, w, row_h)
        pdf.set_xy(x + pad_x, y0 + pad_y)
        pdf.multi_cell(w - (pad_x * 2), line_h, _pdf_text(text), border=0, align=aligns[i])
        x += w

    pdf.set_xy(x0, y0 + row_h)


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

    col_w = _table_col_widths(pdf)
    line_h = 4.5
    _draw_user_progress_header(pdf, col_w, line_h=line_h)

    pdf.set_font("Helvetica", "", 9)
    if not users:
        pdf.cell(sum(col_w), 8, _pdf_text("No users in scope."), border=1)
        pdf.ln()
    else:
        for u in users:
            if not isinstance(u, dict):
                continue
            status = _status_label(str(u.get("status") or ""))
            total = int(u.get("total") or 0)
            done = int(u.get("completed") or 0)
            pct = f"{round((done / total) * 100)}%" if total else "0%"
            _draw_user_progress_row(
                pdf,
                col_w,
                (
                    _user_display_name(u),
                    status,
                    f"{done} / {total}",
                    pct,
                ),
                line_h=line_h,
            )

    out = pdf.output()
    return out if isinstance(out, (bytes, bytearray)) else bytes(out)
