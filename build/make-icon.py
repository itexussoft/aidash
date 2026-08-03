#!/usr/bin/env python3
"""
Draws the application icon.

One thick gauge arc: a proportion, which is what a quota is. It reads at every
size a dock or taskbar asks for.

Two earlier attempts failed for opposite reasons. Three horizontal bars looked
like a hamburger menu — a control rather than a measure. Two concentric arcs
said "several quotas", which is truer, but the inner ring turned to mush below
32px, and that is exactly the size an icon spends its life at.

    python3 build/make-icon.py

Writes build/icon.png (1024), build/icon.ico, and build/icon.iconset for
iconutil. electron-builder picks these up by convention.
"""

from PIL import Image, ImageDraw
from pathlib import Path

SIZE = 1024
BUILD = Path(__file__).parent

INK = (5, 19, 32, 255)  # #051320 — the landing hero
GREEN = (37, 187, 77, 255)  # #25BB4D — the Itexus accent
WHITE = (255, 255, 255, 255)


def over(colour, alpha, base=INK):
    """
    Blends `colour` onto `base`, returning an opaque value.

    ImageDraw writes pixels rather than compositing them, so a translucent fill
    replaces the background — alpha and all — instead of sitting on top of it.
    """
    return tuple(round(b + (c - b) * alpha) for c, b in zip(colour[:3], base[:3])) + (255,)


TRACK = over(WHITE, 0.14)

# Arcs start at twelve o'clock and run clockwise, so the filled part reads the
# way a gauge does.
START = -90

# Insets are measured from the canvas edge, and each ring needs its own stroke
# plus a visible gap before the next one starts — otherwise the inner arc has no
# hole left and renders as a disc.
# A single ring, thick enough to survive downsampling. The gap left unfilled is
# the point of the mark, so it has to stay obvious at 16px.
RINGS = [
    {"inset": 0.255, "stroke": 0.115, "fraction": 0.7, "colour": GREEN},
]


def build_icon(size=SIZE):
    # Drawn at 4x and downsampled: PIL does no antialiasing of its own, and arc
    # ends look ragged without it.
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # macOS rounds its own corners, but the same artwork ships to Windows and
    # Linux, so the shape is part of the icon.
    margin = int(s * 0.085)
    draw.rounded_rectangle((margin, margin, s - margin, s - margin), radius=int(s * 0.22), fill=INK)

    for ring in RINGS:
        pad = int(s * ring["inset"])
        stroke = int(s * ring["stroke"])
        box = (pad, pad, s - pad, s - pad)
        draw.arc(box, 0, 360, fill=TRACK, width=stroke)
        draw.arc(box, START, START + 360 * ring["fraction"], fill=ring["colour"], width=stroke)

    return img.resize((size, size), Image.LANCZOS)


def main():
    icon = build_icon()
    icon.save(BUILD / "icon.png")
    icon.save(BUILD / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    iconset = BUILD / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for px in (16, 32, 64, 128, 256, 512):
        icon.resize((px, px), Image.LANCZOS).save(iconset / f"icon_{px}x{px}.png")
        icon.resize((px * 2, px * 2), Image.LANCZOS).save(iconset / f"icon_{px}x{px}@2x.png")
    icon.save(iconset / "icon_512x512@2x.png")

    print(f"wrote {BUILD/'icon.png'}, {BUILD/'icon.ico'}, {iconset}/")


if __name__ == "__main__":
    main()
