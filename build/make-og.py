#!/usr/bin/env python3
"""
Draws the link-preview card.

A landing with no og:image is posted as a bare grey rectangle with a URL under
it, which undoes whatever the page itself looks like. This is the same drawing
as the hero — ink, one green light source above the headline, the gauge mark —
at the 1200x630 every social card is cropped from.

    python3 build/make-og.py

Writes worker/src/og.png, which the Worker imports and serves at /og.png.
Helvetica Neue stands in for Heebo: the web font is not installed here, and at
this size the two grotesques differ by less than the JPEG a scraper will make
of it anyway.
"""

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

W, H = 1200, 630
ROOT = Path(__file__).parent.parent
OUT = ROOT / 'worker' / 'src' / 'og.png'

INK = (5, 19, 32, 255)  # #051320 — the landing hero
GREEN = (37, 187, 77, 255)  # #25BB4D — the Itexus accent
WHITE = (255, 255, 255, 255)

FONT = '/System/Library/Fonts/HelveticaNeue.ttc'
BOLD, MEDIUM, REGULAR = 1, 10, 0  # face indices inside the collection


def font(size, face=BOLD):
    return ImageFont.truetype(FONT, size, index=face)


def glow(size, colour, strength):
    """A soft radial light, as a layer to composite over the ink."""
    # radial_gradient is white at the edge and black in the middle, which is
    # the mask upside down. Its falloff is linear in radius, which spreads far
    # too far to read as a light source — the exponent pulls it back in.
    mask = Image.radial_gradient('L').resize((size, size), Image.LANCZOS)
    mask = mask.point(lambda v: int((((255 - v) / 255) ** 2.4) * 255 * strength))
    layer = Image.new('RGBA', (size, size), colour[:3] + (0,))
    layer.putalpha(mask)
    return layer


def main():
    img = Image.new('RGBA', (W, H), INK)

    # A grid faint enough to be felt rather than seen, fading out before it
    # reaches the edges — the same trick the hero plays in CSS.
    grid = Image.new('RGBA', (W, H), (255, 255, 255, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(0, W, 76):
        gd.line([(x, 0), (x, H)], fill=(255, 255, 255, 16))
    for y in range(0, H, 76):
        gd.line([(0, y), (W, y)], fill=(255, 255, 255, 16))
    fade = Image.radial_gradient('L').resize((1500, 1500), Image.LANCZOS).point(lambda v: 255 - v)
    grid.putalpha(Image.composite(grid.getchannel('A'), Image.new('L', (W, H), 0),
                                  fade.crop((0, 0, 1500, 1500)).resize((W, H))))
    img.alpha_composite(grid)

    # Centred above the top edge, so what lands on the card is the tail of the
    # light rather than its middle.
    light = glow(1600, GREEN, 0.7)
    img.alpha_composite(light, (W // 2 - 800, -1150))

    d = ImageDraw.Draw(img)

    # The gauge mark, drawn the way the app icon draws it: one thick arc, open
    # at the top left, so the ring reads as a proportion rather than a circle.
    cx, cy, r, w = 108, 96, 32, 13
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 48), width=w)
    d.arc([cx - r, cy - r, cx + r, cy + r], start=-90, end=180, fill=GREEN, width=w)

    word = font(46, BOLD)
    d.text((166, 70), 'ai', font=word, fill=WHITE)
    d.text((166 + d.textlength('ai', font=word), 70), 'dash', font=word, fill=GREEN)

    head = font(82, BOLD)
    d.text((80, 236), 'Every AI quota', font=head, fill=WHITE)
    d.text((80, 330), 'on one screen', font=head, fill=(228, 235, 239, 255))

    sub = font(30, REGULAR)
    d.text((80, 452), 'Every Claude and Codex limit in one window — and a way to', font=sub, fill=(255, 255, 255, 175))
    d.text((80, 494), 'hand a session to the account that still has room.', font=sub, fill=(255, 255, 255, 175))

    foot = font(26, MEDIUM)
    d.text((80, 556), 'aidash.itex.us', font=foot, fill=GREEN)
    tail = 'free · open source · nothing leaves your machine'
    d.text((W - 80 - d.textlength(tail, font=foot), 556), tail, font=foot, fill=(255, 255, 255, 120))

    img.convert('RGB').save(OUT, optimize=True)
    print(f'wrote {OUT} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
