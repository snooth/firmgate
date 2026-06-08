"""Render wiki Markdown to HTML (trusted editors only)."""

import html


def wiki_markdown_to_html(md: str) -> str:
    try:
        import markdown

        return markdown.markdown(
            md or "",
            extensions=["fenced_code", "tables", "nl2br", "sane_lists"],
            output_format="html",
        )
    except ModuleNotFoundError:
        # Deployments missing ``pip install -r requirements.txt`` should still show raw text safely.
        text = html.escape(md or "", quote=False)
        return f'<pre class="nc-wiki-md-fallback">{text}</pre>'
