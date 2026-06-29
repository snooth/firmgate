"""Render Word (.docx) documents to a standalone, self-contained HTML page for inline viewing.

Used to display uploaded CVs in the browser without forcing a download. Prefers
``mammoth`` when available (better fidelity); falls back to a ``python-docx``
based renderer that preserves paragraphs, headings, basic run formatting, lists,
and tables.
"""

from __future__ import annotations

import html
from io import BytesIO

_PAGE_CSS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2.25rem clamp(1rem, 4vw, 3rem);
  background: #f1f5f9;
  color: #0f172a;
  font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
  line-height: 1.55;
  font-size: 15px;
}
.nc-docx-page {
  max-width: 880px;
  margin: 0 auto;
  background: #ffffff;
  padding: clamp(1.5rem, 4vw, 3.25rem);
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12), 0 8px 24px rgba(15, 23, 42, 0.06);
}
.nc-docx-page h1, .nc-docx-page h2, .nc-docx-page h3,
.nc-docx-page h4, .nc-docx-page h5, .nc-docx-page h6 {
  line-height: 1.25;
  margin: 1.3em 0 0.5em;
  color: #0b1220;
}
.nc-docx-page h1 { font-size: 1.9rem; }
.nc-docx-page h2 { font-size: 1.5rem; }
.nc-docx-page h3 { font-size: 1.25rem; }
.nc-docx-page p { margin: 0 0 0.7em; }
.nc-docx-page ul, .nc-docx-page ol { margin: 0 0 0.8em 1.4em; padding: 0; }
.nc-docx-page li { margin: 0.15em 0; }
.nc-docx-page table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.6em 0 1.1em;
  font-size: 0.95em;
}
.nc-docx-page td, .nc-docx-page th {
  border: 1px solid #cbd5e1;
  padding: 0.4rem 0.6rem;
  vertical-align: top;
  text-align: left;
}
.nc-docx-page img { max-width: 100%; height: auto; }
.nc-docx-empty { color: #64748b; font-style: italic; }
"""


def _wrap_html(body_html: str, *, title: str = "Document") -> str:
    safe_title = html.escape(title or "Document")
    return (
        "<!DOCTYPE html>"
        '<html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{safe_title}</title><style>{_PAGE_CSS}</style></head>"
        f'<body><div class="nc-docx-page">{body_html}</div></body></html>'
    )


def _runs_to_html(paragraph) -> str:
    parts: list[str] = []
    for run in paragraph.runs:
        text = run.text or ""
        if not text:
            continue
        chunk = html.escape(text).replace("\n", "<br>")
        if run.bold:
            chunk = f"<strong>{chunk}</strong>"
        if run.italic:
            chunk = f"<em>{chunk}</em>"
        if run.underline:
            chunk = f"<u>{chunk}</u>"
        parts.append(chunk)
    if not parts:
        return html.escape(paragraph.text or "")
    return "".join(parts)


def _heading_level(style_name: str) -> int | None:
    name = (style_name or "").strip().lower()
    if name.startswith("title"):
        return 1
    if name.startswith("heading"):
        digits = "".join(ch for ch in name if ch.isdigit())
        if digits:
            return min(6, max(1, int(digits)))
        return 2
    return None


def _is_list_paragraph(style_name: str) -> tuple[bool, bool]:
    """Return (is_list, is_ordered)."""
    name = (style_name or "").strip().lower()
    if "list number" in name or "numbered" in name:
        return True, True
    if "list" in name and "bullet" in name:
        return True, False
    if "list paragraph" in name or "list" in name:
        return True, False
    return False, False


def _docx_to_html_pydocx(data: bytes) -> str:
    from docx import Document
    from docx.document import Document as _DocCls  # noqa: F401
    from docx.oxml.ns import qn
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(BytesIO(data))

    def _iter_block_items(parent):
        body = parent.element.body
        for child in body.iterchildren():
            if child.tag == qn("w:p"):
                yield Paragraph(child, parent)
            elif child.tag == qn("w:tbl"):
                yield Table(child, parent)

    out: list[str] = []
    open_list: str | None = None  # "ul" | "ol" | None

    def _close_list() -> None:
        nonlocal open_list
        if open_list:
            out.append(f"</{open_list}>")
            open_list = None

    for block in _iter_block_items(doc):
        if isinstance(block, Table):
            _close_list()
            out.append("<table>")
            for row in block.rows:
                out.append("<tr>")
                for cell in row.cells:
                    cell_html = "<br>".join(
                        _runs_to_html(p) for p in cell.paragraphs if (p.text or "").strip()
                    )
                    out.append(f"<td>{cell_html or '&nbsp;'}</td>")
                out.append("</tr>")
            out.append("</table>")
            continue

        para = block
        style_name = ""
        try:
            style_name = para.style.name if para.style else ""
        except Exception:
            style_name = ""

        text = (para.text or "").strip()
        level = _heading_level(style_name)
        if level and text:
            _close_list()
            out.append(f"<h{level}>{_runs_to_html(para)}</h{level}>")
            continue

        is_list, is_ordered = _is_list_paragraph(style_name)
        if is_list and text:
            want = "ol" if is_ordered else "ul"
            if open_list != want:
                _close_list()
                out.append(f"<{want}>")
                open_list = want
            out.append(f"<li>{_runs_to_html(para)}</li>")
            continue

        _close_list()
        if text:
            out.append(f"<p>{_runs_to_html(para)}</p>")

    _close_list()
    if not out:
        return '<p class="nc-docx-empty">This document has no readable text.</p>'
    return "".join(out)


def _docx_to_html_mammoth(data: bytes) -> str | None:
    try:
        import mammoth  # type: ignore
    except Exception:
        return None
    try:
        result = mammoth.convert_to_html(BytesIO(data))
        return result.value or ""
    except Exception:
        return None


def docx_to_html_page(data: bytes, *, title: str = "Document") -> str:
    """Convert .docx bytes into a full standalone HTML page string."""
    body = _docx_to_html_mammoth(data)
    if not body:
        body = _docx_to_html_pydocx(data)
    return _wrap_html(body, title=title)
