#!/usr/bin/env python3
"""Legacy header patcher for README screenshots.

Prefer fresh captures from a running app:
  python scripts/capture_readme_screenshots.py
(requires Playwright; server on http://127.0.0.1:5001)
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = ROOT / "docs" / "screenshots"
SVG = ROOT / "app/static/branding" / "firmgate-logo.svg"

LOGO_X = 18
LOGO_Y = 13
LOGO_H = 34
TEXT_X = 62
TITLE_Y = 15
SUB_Y = 34
CLEAR_BOX = (10, 6, 158, 58)
TITLE_COLOR = (15, 23, 42)
SUB_COLOR = (100, 116, 139)


def _font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = []
    if bold:
        names.extend(
            [
                "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                "/Library/Fonts/Arial Bold.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            ]
        )
    names.extend(
        [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            os.environ.get("MANUAL_FONT_PATH", ""),
        ]
    )
    for path in names:
        if path and os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _rasterize_logo(pixel_height: int = 68) -> Image.Image:
    with tempfile.TemporaryDirectory() as tmp:
        td = Path(tmp)
        subprocess.run(
            ["qlmanage", "-t", "-s", str(pixel_height * 2), "-o", str(td), str(SVG)],
            check=True,
            capture_output=True,
        )
        png = td / f"{SVG.name}.png"
        if not png.is_file():
            raise FileNotFoundError(f"Could not rasterize logo via qlmanage: {png}")
        return Image.open(png).convert("RGBA")


def _patch_blogs_cards(img: Image.Image) -> Image.Image:
    """Replace legacy Intranet author labels on blog cards."""
    draw = ImageDraw.Draw(img)
    font = _font(10)
    bg = (255, 255, 255)
    patches = [
        ((36, 248, 150, 262), "07 Feb 2025 - Firmgate"),
        ((36, 264, 250, 282), "Welcome to Firmgate"),
    ]
    for box, text in patches:
        draw.rectangle(box, fill=bg)
        draw.text((box[0], box[1]), text, fill=(100, 116, 139), font=font)
    return img


def _patch_header(img: Image.Image, logo: Image.Image) -> Image.Image:
    out = img.convert("RGB")
    draw = ImageDraw.Draw(out)
    bg = out.getpixel((360, 24))
    draw.rectangle(CLEAR_BOX, fill=bg)

    logo_w = max(1, int(logo.width * LOGO_H / logo.height))
    mark = logo.resize((logo_w, LOGO_H), Image.Resampling.LANCZOS)
    out.paste(mark, (LOGO_X, LOGO_Y), mark)

    draw.text((TEXT_X, TITLE_Y), "Firmgate", fill=TITLE_COLOR, font=_font(15, bold=True))
    draw.text((TEXT_X, SUB_Y), "Online", fill=SUB_COLOR, font=_font(11))
    return out


def main() -> None:
    logo = _rasterize_logo()
    for path in sorted(SCREENSHOTS.glob("*.png")):
        if path.name.startswith("."):
            continue
        patched = _patch_header(Image.open(path), logo)
        if path.name == "blogs.png":
            patched = _patch_blogs_cards(patched)
        patched.save(path, "PNG", optimize=True)
        print(f"updated {path.name}")


if __name__ == "__main__":
    main()
