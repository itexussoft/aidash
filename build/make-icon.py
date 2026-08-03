#!/usr/bin/env python3
"""
Draws the application icon.

The mark is the app's own meters: three tracks at different fills, with the one
closest to exhaustion picked out in the Itexus green. It reads as "how much is
left" at any size, and reuses the exact palette of the landing page so the two
are recognisably the same product.

    python3 build/make-icon.py

Writes build/icon.png (1024), build/icon.ico, and build/icon.iconset for
iconutil. electron-builder picks these up by convention.
"""

from PIL import Image, ImageDraw
from pathlib import Path

SIZE = 1024
BUILD = Path(__file__).parent

INK = (5, 19, 32, 255)  # #051320 — same as the landing hero
GREEN = (37, 187, 77, 255)  # #25BB4D — the Itexus accent
WHITE = (255, 255, 255, 255)


def over(colour, alpha, base=INK):
    """
    Blends `colour` onto `base` at `alpha`, returning an opaque value.

    ImageDraw writes pixels rather than compositing them, so a translucent fill
    replaces the background — alpha and all — instead of sitting on top of it.
    Pre-blending is what keeps a dim track dim rather than punching a
    transparent hole through the icon.
    """
    return tuple(round(b + (c - b) * alpha) for c, b in zip(colour[:3], base[:3])) + (255,)


TRACK = over(WHITE, 0.16)  # unfilled remainder
DIM = over(WHITE, 0.55)  # a bar with plenty of headroom

# Fractions used up. The green one is nearly full: the icon should read as a
# warning at a glance, which is the app's whole job.
BARS = [
    (0.52, WHITE),
    (0.88, GREEN),
    (0.30, DIM),
]


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def build_icon(size=SIZE):
    # Drawn at 4x and downsampled: PIL has no antialiasing of its own, and the
    # bar caps look ragged without it.
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # macOS rounds its own corners, but the same file ships to Windows and
    # Linux, so the shape is part of the artwork.
    margin = int(s * 0.085)
    rounded(draw, (margin, margin, s - margin, s - margin), radius=int(s * 0.22), fill=INK)

    inner = int(s * 0.20)
    left = inner
    right = s - inner
    span = right - left

    bar_h = int(s * 0.105)
    gap = int(s * 0.075)
    total = len(BARS) * bar_h + (len(BARS) - 1) * gap
    top = (s - total) // 2

    for i, (fraction, colour) in enumerate(BARS):
        y = top + i * (bar_h + gap)
        radius = bar_h // 2
        rounded(draw, (left, y, right, y + bar_h), radius, TRACK)
        filled = max(bar_h, int(span * fraction))
        rounded(draw, (left, y, left + filled, y + bar_h), radius, colour)

    return img.resize((size, size), Image.LANCZOS)


def main():
    icon = build_icon()
    icon.save(BUILD / "icon.png")

    # Windows wants every size inside one file.
    icon.save(BUILD / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # macOS: an iconset directory that iconutil turns into .icns.
    iconset = BUILD / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for px in (16, 32, 64, 128, 256, 512):
        icon.resize((px, px), Image.LANCZOS).save(iconset / f"icon_{px}x{px}.png")
        icon.resize((px * 2, px * 2), Image.LANCZOS).save(iconset / f"icon_{px}x{px}@2x.png")
    icon.save(iconset / "icon_512x512@2x.png")

    print(f"wrote {BUILD/'icon.png'}, {BUILD/'icon.ico'}, {iconset}/")


if __name__ == "__main__":
    main()
