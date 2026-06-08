"""Sanitize rich HTML for wiki storage (Quill / WYSIWYG output)."""

from __future__ import annotations

import html

_WIKI_ALLOWED_TAGS = frozenset(
    {
        "p",
        "br",
        "span",
        "div",
        "s",
        "strike",
        "del",
        "strong",
        "b",
        "em",
        "i",
        "u",
        "sub",
        "sup",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "ol",
        "ul",
        "li",
        "blockquote",
        "pre",
        "code",
        "a",
        "img",
        "video",
        "source",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "th",
        "td",
        "colgroup",
        "col",
        "hr",
    }
)

_WIKI_ATTRIBUTES = {
    "*": ["class", "style", "dir"],
    "a": ["href", "title", "target", "rel"],
    "img": ["src", "alt", "title", "width", "height", "class", "style"],
    "video": ["src", "controls", "width", "height", "class", "style"],
    "source": ["src", "type"],
    "col": ["span", "width", "style"],
    "td": ["colspan", "rowspan", "class", "style"],
    "th": ["colspan", "rowspan", "class", "style"],
}

_WIKI_CSS_PROPERTIES = frozenset(
    {
        "color",
        "background-color",
        "text-align",
        "font-size",
        "font-family",
        "font-weight",
        "font-style",
        "text-decoration",
        "width",
        "height",
        "max-width",
        "min-height",
        "margin",
        "margin-top",
        "margin-bottom",
        "margin-left",
        "margin-right",
        "padding",
        "padding-top",
        "padding-bottom",
        "padding-left",
        "padding-right",
        "border",
        "border-radius",
        "list-style",
        "list-style-type",
        "white-space",
        "vertical-align",
        "line-height",
        "direction",
        "padding-left",
    }
)


def sanitize_wiki_html(fragment: str) -> str:
    """Return XSS-safe HTML for trusted editors (wiki.write)."""
    if not (fragment or "").strip():
        return ""
    try:
        import bleach
        from bleach.css_sanitizer import CSSSanitizer

        css = CSSSanitizer(allowed_css_properties=_WIKI_CSS_PROPERTIES)
        return bleach.clean(
            fragment,
            tags=_WIKI_ALLOWED_TAGS,
            attributes=_WIKI_ATTRIBUTES,
            protocols=["http", "https", "mailto", "data"],
            css_sanitizer=css,
            strip=True,
        )
    except ModuleNotFoundError:
        return f'<pre class="nc-wiki-md-fallback">{html.escape(fragment, quote=False)}</pre>'
