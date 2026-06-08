"""Sanitize rich HTML for trusted admin-authored About page content (whitelist)."""

from __future__ import annotations

import html as html_mod
import re
from html.parser import HTMLParser

_ABOUT_HTML_HINT = re.compile(r"<\s*/?\s*(?:!--|[a-zA-Z])")


def looks_like_html_fragment(s: str) -> bool:
    return bool(s and _ABOUT_HTML_HINT.search(s))


VOID_TAGS = frozenset({"br", "hr", "img"})

ALLOWED_TAGS = frozenset(
    {
        "p",
        "br",
        "b",
        "strong",
        "i",
        "em",
        "u",
        "s",
        "strike",
        "h1",
        "h2",
        "h3",
        "h4",
        "ul",
        "ol",
        "li",
        "a",
        "img",
        "blockquote",
        "hr",
        "div",
        "span",
        "font",
        "pre",
        "code",
    }
)

_ALLOWED_ATTR_KEYS = {
    "a": frozenset({"href", "target", "rel", "title"}),
    "img": frozenset({"src", "alt", "title", "width", "height"}),
    "font": frozenset({"face", "size", "color"}),
    "div": frozenset({"align", "style"}),
    "p": frozenset({"align", "style"}),
    "span": frozenset({"style"}),
    "blockquote": frozenset({"class"}),
}


def _sanitize_style(style_val: str) -> str | None:
    """Allow only harmless inline styles from execCommand (alignment, font)."""
    s = str(style_val or "").strip()
    if not s:
        return None
    parts_ok: list[str] = []
    for piece in s.split(";"):
        p = piece.strip()
        if not p:
            continue
        low = p.lower()
        if re.fullmatch(r"text-align\s*:\s*(left|center|right|justify)", p, re.I):
            m = re.search(r":\s*(.+)$", p, re.I)
            if not m:
                continue
            al = m.group(1).strip().lower()
            parts_ok.append(f"text-align:{al}")
            continue
        m = re.match(r"font-family\s*:\s*(.+)$", p, re.I)
        if m:
            val = m.group(1).strip().strip("\"'")
            vlow = val.lower()
            if "url(" in vlow or "expression" in vlow or "<script" in vlow:
                continue
            safe = html_mod.escape(val, quote=True)
            parts_ok.append(f"font-family:{safe}")
            continue
        m = re.match(r"font-size\s*:\s*(.+)$", p, re.I)
        if m:
            val = m.group(1).strip().lower()
            if re.fullmatch(r"[\d.]+\s*(px|pt|em|rem|%|small|medium|large|smaller|larger)", val):
                parts_ok.append(f"font-size:{val}")
    if not parts_ok:
        return None
    return "; ".join(parts_ok)


def _sanitize_attr(tag: str, name: str, value: str) -> tuple[str, str] | None:
    n = name.lower()
    allowed = _ALLOWED_ATTR_KEYS.get(tag)
    if not allowed or n not in allowed:
        return None
    v = str(value or "")
    if n in ("href", "src"):
        t = v.strip()
        low = t.lower()
        if not t or low.startswith("javascript:") or low.startswith("data:"):
            return None
        if n == "href":
            return "href", html_mod.escape(t, quote=True)
        return "src", html_mod.escape(t, quote=True)
    if n in ("target", "rel"):
        return n, html_mod.escape(v.strip()[:64], quote=True)
    if n == "title":
        return "title", html_mod.escape(v.strip()[:200], quote=True)
    if n == "alt":
        return "alt", html_mod.escape(v.strip()[:500], quote=True)
    if n in ("width", "height"):
        t = v.strip()
        if re.fullmatch(r"\d+", t):
            return n, t
        return None
    if n == "align":
        al = v.strip().lower()
        if al in ("left", "center", "right", "justify"):
            return "align", al
        return None
    if n == "face":
        face = v.strip()[:120]
        if not face:
            return None
        return "face", html_mod.escape(face, quote=True)
    if n == "size":
        if re.fullmatch(r"[1-7]", v.strip()):
            return "size", v.strip()
        return None
    if n == "color":
        c = v.strip()[:64]
        if re.fullmatch(r"#[0-9a-fA-F]{3,8}|[a-zA-Z]+", c):
            return "color", html_mod.escape(c, quote=True)
        return None
    if n == "class":
        cl = v.strip()[:120]
        if re.fullmatch(r"[\w\-\s]+", cl or ""):
            return "class", html_mod.escape(cl, quote=True)
        return None
    if n == "style":
        st = _sanitize_style(v)
        if st:
            return "style", st
        return None
    return None


def _fmt_open_tag(tag: str, attrs: list[tuple[str, str | None]]) -> str:
    parts = [f"<{tag}"]
    for k, v in attrs:
        if v is None:
            continue
        parts.append(f' {k}="{v}"')
    if tag in VOID_TAGS:
        parts.append(" />")
    else:
        parts.append(">")
    return "".join(parts)


class _SanitizeParser(HTMLParser):
    """Rebuild HTML with only allowed tags/attributes; drop everything else."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._out: list[str] = []
        self._ignore = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if self._ignore > 0:
            self._ignore += 1
            return
        if t not in ALLOWED_TAGS:
            self._ignore = 1
            return
        clean_attrs: list[tuple[str, str | None]] = []
        ad = dict(attrs)
        for name, raw in ad.items():
            pair = _sanitize_attr(t, name, raw or "")
            if pair:
                clean_attrs.append(pair)
        self._out.append(_fmt_open_tag(t, clean_attrs))
        if t in VOID_TAGS:
            return

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if self._ignore > 0:
            self._ignore -= 1
            return
        if t not in ALLOWED_TAGS or t in VOID_TAGS:
            return
        self._out.append(f"</{t}>")

    def handle_data(self, data: str) -> None:
        if self._ignore > 0:
            return
        self._out.append(html_mod.escape(data, quote=False))

    def handle_entityref(self, name: str) -> None:
        if self._ignore > 0:
            return
        self._out.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if self._ignore > 0:
            return
        self._out.append(f"&#{name};")

    def error(self, message: str) -> None:  # pragma: no cover - html.parser compat
        pass


def strip_data_uri_images(html: str) -> str:
    """Remove inline base64 images (breaks saves behind small reverse-proxy body limits)."""
    return re.sub(
        r'<img\b[^>]*\bsrc\s*=\s*["\']?\s*data:image/[^"\'>\s]+["\']?[^>]*>',
        "",
        str(html or ""),
        flags=re.I,
    )


def sanitize_about_html(fragment: str) -> str:
    """Return sanitized HTML fragment safe to embed with Markup.|safe."""
    if not fragment or not str(fragment).strip():
        return ""
    fragment = strip_data_uri_images(str(fragment))
    if not fragment.strip():
        return ""
    parser = _SanitizeParser()
    try:
        parser.feed(fragment)
        parser.close()
    except Exception:
        return ""
    return "".join(parser._out).strip()


def plain_about_body_to_html(body: str) -> str:
    text = html_mod.escape(str(body or "").strip())
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")
    return text


def render_about_body_markup(body: str) -> str:
    """Readable HTML for About page card (legacy plain newline or sanitized rich)."""
    raw = str(body or "").strip()
    if not raw:
        return ""
    if looks_like_html_fragment(raw):
        return sanitize_about_html(raw)
    return plain_about_body_to_html(raw)


def html_fragment_to_plain(fragment: str, *, max_len: int | None = None) -> str:
    """Strip tags and collapse whitespace (for announcement snippets)."""
    s = re.sub(r"<[^>]+>", " ", str(fragment or ""))
    s = html_mod.unescape(re.sub(r"\s+", " ", s)).strip()
    if max_len is not None and len(s) > max_len:
        cut = s[: max_len + 1].rsplit(" ", 1)[0] or s[:max_len]
        if len(cut) < len(s):
            cut = cut.rstrip(".,;:") + "…"
        s = cut
    return s


def announcement_snippet_html(full_html: str, *, max_len: int = 220) -> str:
    """Plain-text excerpt wrapped for Home preview (escaped)."""
    raw = str(full_html or "")
    plain = html_fragment_to_plain(raw, max_len=max_len)
    if not plain:
        if re.search(r"<img\b", raw, re.I):
            return html_mod.escape("Includes image — open Edit to view the full announcement.")
        return ""
    return html_mod.escape(plain)
