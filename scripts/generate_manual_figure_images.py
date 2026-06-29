#!/usr/bin/env python3
"""Generate placeholder screenshot PNGs for the user manual (docs/manual_figures/)."""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs" / "manual_figures"

# Import figure list
import sys

sys.path.insert(0, str(ROOT / "scripts"))
from user_manual_figures_data import MANUAL_FIGURES  # noqa: E402

W, H = 1280, 720
HEADER_H = 52
ACCENT = (0, 130, 201)
BG = (248, 250, 252)
PANEL = (226, 232, 240)
TEXT_DARK = (15, 23, 42)
TEXT_MUTED = (71, 85, 105)


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        os.environ.get("MANUAL_FONT_PATH", ""),
    ]
    for p in candidates:
        if p and os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render_placeholder(num: int, title: str, subtitle: str, path: Path) -> None:
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, W, HEADER_H], fill=ACCENT)
    font_sm = _font(18)
    font_md = _font(28)
    font_lg = _font(34)
    font_cap = _font(14)

    draw.text((24, 12), "Firmgate", fill=(255, 255, 255), font=font_sm)
    # Fake chrome row under header
    y0 = HEADER_H + 12
    draw.rounded_rectangle([24, y0, W - 24, y0 + 8], radius=4, fill=PANEL)
    # Main placeholder panels (wireframe)
    box_top = y0 + 32
    draw.rounded_rectangle([24, box_top, W // 2 - 12, H - 80], radius=6, outline=PANEL, width=2)
    draw.rounded_rectangle([W // 2 + 12, box_top, W - 24, H - 80], radius=6, outline=PANEL, width=2)
    for i in range(4):
        yy = box_top + 24 + i * 52
        draw.rounded_rectangle([40, yy, W // 2 - 28, yy + 36], radius=4, fill=(241, 245, 249))

    # Overlay title block (readable over wireframe)
    mid_y = box_top + (H - 80 - box_top) // 2 - 40
    draw.text((40, mid_y), f"Figure {num}", fill=ACCENT, font=font_lg)
    draw.text((40, mid_y + 46), title, fill=TEXT_DARK, font=font_md)
    draw.text((40, mid_y + 92), subtitle, fill=TEXT_MUTED, font=font_sm)
    draw.text(
        (40, H - 52),
        "Placeholder — replace with your real screenshot (same dimensions optional)",
        fill=TEXT_MUTED,
        font=font_cap,
    )
    draw.text((40, H - 28), "Firmgate — User Manual", fill=TEXT_MUTED, font=font_cap)

    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)


def patch_html() -> None:
    """Embed manual_figures/*.png into docs/User_Manual.html."""
    import re

    html_path = ROOT / "docs" / "User_Manual.html"
    if not html_path.is_file():
        return
    html = html_path.read_text(encoding="utf-8")
    idx = [0]

    def repl(_m: re.Match[str]) -> str:
        idx[0] += 1
        n = idx[0]
        if n > len(MANUAL_FIGURES):
            return _m.group(0)
        _num, fname, _title, _sub = MANUAL_FIGURES[n - 1]
        return (
            f'<div class="manual-fig-wrap"><img src="manual_figures/{fname}" '
            f'alt="Figure {_num}" class="manual-fig-img" loading="lazy" /></div>'
        )

    html2, count = re.subn(r'<div class="figure">[^<]*</div>', repl, html)
    if count:
        html_path.write_text(html2, encoding="utf-8")
        print(f"Patched HTML ({count} figures): {html_path}")


def main() -> None:
    for num, fname, title, sub in MANUAL_FIGURES:
        render_placeholder(num, title, sub, OUT_DIR / fname)
        print("Wrote", OUT_DIR / fname)
    patch_html()


if __name__ == "__main__":
    main()
