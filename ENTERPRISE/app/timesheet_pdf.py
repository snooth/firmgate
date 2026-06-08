"""PDF export for intranet monthly timesheets (NMP60202-style layout)."""

from __future__ import annotations

import base64
import re
from datetime import date
from io import BytesIO
from pathlib import Path
from typing import Any

from fpdf import FPDF

from app.timesheet_holidays import fmt_period_date, fmt_row_date, holiday_name, is_weekend, normalize_state, parse_iso_date


def _pdf_text(value: str) -> str:
    return value.encode("latin-1", "replace").decode("latin-1")


def _decode_signature_image(data_url: str) -> tuple[BytesIO, str] | None:
    raw = str(data_url or "").strip()
    if not raw.startswith("data:image/"):
        return None
    match = re.match(r"^data:image/(png|jpe?g|webp);base64,(.+)$", raw, flags=re.I | re.S)
    if not match:
        return None
    fmt = match.group(1).lower()
    try:
        payload = base64.b64decode(match.group(2), validate=True)
    except (ValueError, TypeError):
        return None
    if not payload or len(payload) > 512_000:
        return None
    img_type = "PNG" if fmt == "png" else "JPEG" if fmt in ("jpg", "jpeg") else "PNG"
    return BytesIO(payload), img_type


def _signature_image_size(bio: BytesIO) -> tuple[int, int] | None:
    try:
        from PIL import Image

        bio.seek(0)
        with Image.open(bio) as img:
            w, h = img.size
            if w > 0 and h > 0:
                return w, h
    except Exception:
        pass
    return None


def _fit_image_in_box(img_w: int, img_h: int, max_w: float, max_h: float) -> tuple[float, float]:
    scale = min(max_w / img_w, max_h / img_h)
    return img_w * scale, img_h * scale


def _draw_signature_box(
    pdf: FPDF,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    text: str = "",
    image_data_url: str = "",
) -> None:
    pdf.rect(x, y, w, h)
    decoded = _decode_signature_image(image_data_url)
    if decoded:
        bio, img_type = decoded
        try:
            max_w = w - 3
            max_h = h - 2
            size = _signature_image_size(bio)
            if size:
                img_w, img_h = size
                draw_w, draw_h = _fit_image_in_box(img_w, img_h, max_w, max_h)
                draw_x = x + 1.5 + (max_w - draw_w) / 2
                draw_y = y + 1 + (max_h - draw_h) / 2
            else:
                draw_w, draw_h = max_w, max_h
                draw_x = x + 1.5
                draw_y = y + 1
            bio.seek(0)
            pdf.image(bio, x=draw_x, y=draw_y, w=draw_w, h=draw_h, type=img_type)
            return
        except Exception:
            pass
    if text:
        pdf.set_xy(x + 2, y + (h / 2) - 2)
        pdf.cell(w - 4, 4, _pdf_text(text), border=0)


def _as_float(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


_GOLD_LINE = (139, 119, 42)


def _draw_branded_header(
    pdf: FPDF,
    *,
    content_w: float,
    company_lines: list[str],
    logo_path: Path | None,
    period_start: date | None,
    period_end: date | None,
    project_branch: str,
) -> None:
    x0 = pdf.l_margin
    y0 = pdf.get_y()
    left_w = content_w * 0.58
    right_w = content_w - left_w
    right_x = x0 + left_w

    y_right = y0
    if company_lines:
        pdf.set_font("Helvetica", "", 7)
        pdf.set_text_color(0, 0, 0)
        for line in company_lines[:3]:
            pdf.set_xy(right_x, y_right)
            pdf.cell(right_w, 3.1, _pdf_text(line), align="R")
            y_right += 3.1

    y_left = y0
    if logo_path and logo_path.exists():
        try:
            ext = logo_path.suffix.lower().lstrip(".")
            img_type = "PNG" if ext == "png" else "JPEG" if ext in ("jpg", "jpeg") else ""
            logo_w = min(52, left_w * 0.45)
            logo_h = 11
            pdf.image(str(logo_path), x=x0, y=y_left, w=logo_w, h=logo_h, type=img_type or "")
            y_left += logo_h + 1.5
        except Exception:
            pass

    pdf.set_xy(x0, y_left)
    pdf.set_font("Helvetica", "", 8)
    pdf.cell(left_w, 3.4, _pdf_text("Time Sheet for Period:"))
    y_left += 3.4

    start_s = fmt_period_date(period_start) if period_start else ""
    end_s = fmt_period_date(period_end) if period_end else ""
    if start_s and end_s:
        period_text = f"{start_s} | {end_s}"
    else:
        period_text = start_s or end_s

    pdf.set_xy(x0, y_left)
    pdf.set_font("Helvetica", "B", 9)
    pdf.cell(left_w, 4, _pdf_text(period_text))
    y_left += 4

    pdf.set_xy(x0, y_left)
    pdf.set_font("Helvetica", "", 8)
    pdf.cell(left_w, 3.4, _pdf_text(f"PROJECT: {project_branch}"))
    y_left += 3.4

    pdf.set_y(max(y_left, y_right) + 2.5)


def _draw_table_header_row(pdf: FPDF, col_w: list[float], headers: list[str], h: float) -> None:
    x0 = pdf.l_margin
    y0 = pdf.get_y()
    total_w = sum(col_w)

    pdf.set_draw_color(*_GOLD_LINE)
    pdf.set_line_width(0.35)
    pdf.line(x0, y0, x0 + total_w, y0)

    pdf.set_font("Helvetica", "BI", 7)
    pdf.set_text_color(0, 0, 0)
    pdf.set_fill_color(255, 255, 255)
    for i, hdr in enumerate(headers):
        pdf.set_xy(x0 + sum(col_w[:i]), y0)
        pdf.cell(col_w[i], h, _pdf_text(hdr), border="LR", align="C", fill=True)

    y1 = y0 + h
    pdf.line(x0, y1, x0 + total_w, y1)
    pdf.set_draw_color(0, 0, 0)
    pdf.set_line_width(0.2)
    pdf.set_xy(x0, y1)


def build_timesheet_pdf(
    payload: dict[str, Any],
    *,
    company_lines: list[str] | None = None,
    logo_path: Path | None = None,
) -> bytes:
    period_start = parse_iso_date(str(payload.get("period_start") or ""))
    period_end = parse_iso_date(str(payload.get("period_end") or ""))
    project_branch = str(payload.get("project_branch") or "").strip()
    declaration = str(payload.get("declaration_text") or "").strip()
    employee_sig = str(payload.get("employee_signature") or "").strip()
    employee_sig_image = str(payload.get("employee_signature_image") or "").strip()
    supervisor_sig = str(payload.get("supervisor_signature") or "").strip()
    if company_lines is None:
        payload_lines = payload.get("company_lines") if isinstance(payload.get("company_lines"), list) else []
        company_lines = [str(x or "").strip() for x in payload_lines[:4] if str(x or "").strip()]
    else:
        company_lines = [str(x or "").strip() for x in company_lines[:4] if str(x or "").strip()]
    rows_in = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    timesheet_state = normalize_state(str(payload.get("state") or ""))
    row_count = sum(1 for raw in rows_in if isinstance(raw, dict))
    if row_count <= 0:
        row_count = 31

    margin = 7
    table_head_h = 4.2
    row_h = 3.35 if row_count >= 30 else 3.8 if row_count >= 28 else 4.2
    total_h = 4
    sig_h = 8
    sig_label_h = 4

    pdf = FPDF(orientation="L", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=False)
    pdf.set_margins(margin, margin, margin)
    pdf.add_page()

    content_w = pdf.w - pdf.l_margin - pdf.r_margin
    _draw_branded_header(
        pdf,
        content_w=content_w,
        company_lines=company_lines,
        logo_path=logo_path,
        period_start=period_start,
        period_end=period_end,
        project_branch=project_branch,
    )

    col_w = [22, 26, 26, 11, 0]
    col_w[4] = content_w - sum(col_w[:4])
    headers = ["Date", "Consultant", "Role", "Hours", "Project / Notes"]

    _draw_table_header_row(pdf, col_w, headers, table_head_h)

    total_hours = 0.0
    pdf.set_font("Helvetica", "", 6.8)

    def _draw_row(date_s: str, consultant: str, role: str, hours_s: str, project: str, fill_rgb: tuple[int, int, int]) -> None:
        pdf.set_fill_color(*fill_rgb)
        x0 = pdf.l_margin
        y0 = pdf.get_y()
        values = [date_s, consultant, role, hours_s, project]
        aligns = ["C", "C", "C", "C", "L"]
        for i, txt in enumerate(values):
            pdf.set_xy(x0 + sum(col_w[:i]), y0)
            pdf.cell(col_w[i], row_h, _pdf_text(txt), border=1, align=aligns[i], fill=True)
        pdf.set_xy(x0, y0 + row_h)

    for raw in rows_in:
        if not isinstance(raw, dict):
            continue
        d = parse_iso_date(str(raw.get("date") or ""))
        consultant = str(raw.get("consultant") or "").strip()
        role = str(raw.get("role") or "").strip()
        project = str(raw.get("project") or "").strip()
        hours = _as_float(raw.get("hours"))
        state_hol = holiday_name(d, state=timesheet_state) if d else ""
        hol = bool(state_hol) and not bool(raw.get("holiday_override"))
        if hol:
            project = state_hol
            consultant = ""
            role = ""
            hours = None

        wknd = bool(raw.get("is_weekend")) if raw.get("is_weekend") is not None else (is_weekend(d) if d else False)
        overridden_hol = bool(state_hol) and bool(raw.get("holiday_override"))

        if overridden_hol:
            fill_rgb = (184, 230, 230)
        elif hol or wknd:
            fill_rgb = (169, 209, 142)
        else:
            fill_rgb = (255, 255, 255)

        date_s = fmt_row_date(d) if d else str(raw.get("date") or "")
        hours_s = ""
        if hours is not None and hours > 0:
            hours_s = str(int(hours) if float(hours).is_integer() else hours)
            total_hours += float(hours)

        _draw_row(date_s, consultant, role, hours_s, project, fill_rgb)

    pdf.set_fill_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 7)
    pdf.cell(col_w[0], total_h, "", border=1)
    pdf.cell(col_w[1], total_h, "", border=1)
    pdf.cell(col_w[2], total_h, _pdf_text("TOTAL Hours"), border=1, align="R")
    total_s = str(int(total_hours) if float(total_hours).is_integer() else round(total_hours, 2))
    pdf.cell(col_w[3], total_h, _pdf_text(total_s), border=1, align="R")
    pdf.cell(col_w[4], total_h, "", border=1, new_x="LMARGIN", new_y="NEXT")

    pdf.ln(1)
    if declaration:
        pdf.set_font("Helvetica", "", 7)
        pdf.multi_cell(0, 3.1, _pdf_text(declaration), border=1)

    pdf.ln(1)
    sig_w = (pdf.w - pdf.l_margin - pdf.r_margin) / 2 - 2
    gap = 3
    pdf.set_font("Helvetica", "B", 7)
    pdf.cell(sig_w, sig_label_h, _pdf_text("Employee Signature"), border=1)
    pdf.cell(gap, sig_label_h, "")
    pdf.cell(sig_w, sig_label_h, _pdf_text("Supervisor Signature"), border=1, new_x="LMARGIN", new_y="NEXT")
    y_boxes = pdf.get_y()
    x0 = pdf.l_margin
    _draw_signature_box(
        pdf,
        x0,
        y_boxes,
        sig_w,
        sig_h,
        text=employee_sig,
        image_data_url=employee_sig_image,
    )
    _draw_signature_box(pdf, x0 + sig_w + gap, y_boxes, sig_w, sig_h, text=supervisor_sig)
    pdf.set_y(y_boxes + sig_h)

    pdf.set_font("Helvetica", "", 6.5)
    today = date.today().strftime("%Y.%m.%d")
    pdf.set_x(x0)
    pdf.cell(sig_w, 3, _pdf_text(f"Date: {today}"), border=0)
    pdf.cell(gap, 3, "")
    pdf.cell(sig_w, 3, "", border=0)

    out = pdf.output()
    return out if isinstance(out, (bytes, bytearray)) else out.encode("latin-1")
