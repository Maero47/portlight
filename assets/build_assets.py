"""Build exact-size Portlight exports from the approved artwork. Requires Pillow."""

from collections import deque
from pathlib import Path
import argparse

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
IVORY = "#F3F2E9"
GRAPHITE = "#28332F"
AMBER = "#E7A343"
AMBER_EDGE = "#986523"
PAPER = "#F7F7F2"
RESAMPLE = Image.Resampling.LANCZOS


def clean_master():
    """Remove isolated transparent-background specks; preserve the two main shapes."""
    im = Image.open(ROOT / "concepts/04-harbor-refined.png").convert("RGBA")
    alpha = im.getchannel("A")
    w, h = im.size
    data = alpha.tobytes()
    seen = bytearray(w * h)
    keep = bytearray(w * h)
    for start, value in enumerate(data):
        if value < 8 or seen[start]:
            continue
        seen[start] = 1
        queue = deque([start])
        component = []
        while queue:
            p = queue.popleft()
            component.append(p)
            x, y = p % w, p // w
            neighbors = []
            if x: neighbors.append(p - 1)
            if x + 1 < w: neighbors.append(p + 1)
            if y: neighbors.append(p - w)
            if y + 1 < h: neighbors.append(p + w)
            for q in neighbors:
                if not seen[q] and data[q] >= 8:
                    seen[q] = 1
                    queue.append(q)
        if len(component) > 2000:
            for p in component:
                keep[p] = data[p]
    im.putalpha(Image.frombytes("L", im.size, bytes(keep)))
    return im.crop(im.getbbox())


def fit_mark(mark, size, width):
    scaled = mark.resize((width, round(mark.height * width / mark.width)), RESAMPLE)
    canvas = Image.new("RGBA", (size, size))
    canvas.alpha_composite(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2))
    return canvas


def toolbar(size):
    """Optical redraw: flat enamel, thicker edges, enlarged light, wider open gaps."""
    scale = 8
    # Independently placed edges for each physical pixel size, not a scaled master.
    if size == 16:
        left, top, right, bottom, arm, floor, radius = 1, 4, 15, 14, 4, 11, 1.4
        light = (6, 2, 10, 6)
        edge = 0.75
    else:
        left, top, right, bottom, arm, floor, radius = 3, 9, 29, 28, 6, 22, 2.5
        light = (12, 4, 20, 12)
        edge = 1.1
    mask = Image.new("L", (size * scale, size * scale))
    d = ImageDraw.Draw(mask)
    def rounded(box, r):
        d.rounded_rectangle(tuple(round(v * scale) for v in box), radius=round(r * scale), fill=255)
    rounded((left, top, left + arm, bottom), radius)
    rounded((right - arm, top, right, bottom), radius)
    rounded((left, floor, right, bottom), radius)
    inner = mask.filter(ImageFilter.MinFilter(2 * round(edge * scale) + 1))
    im = Image.new("RGBA", mask.size)
    im.paste(GRAPHITE, (0, 0), mask)
    im.paste(IVORY, (0, 0), inner)
    ImageDraw.Draw(im).rounded_rectangle(
        tuple(round(v * scale) for v in light), radius=round((0.9 if size == 16 else 1.8) * scale),
        fill=AMBER, outline=AMBER_EDGE, width=round(edge * scale),
    )
    # Area sampling keeps empty pixel-grid gaps empty (no Lanczos ringing).
    return im.resize((size, size), Image.Resampling.BOX)


def wordmark(im, font_path, font_size, x, center_y, color):
    font = ImageFont.truetype(str(font_path), font_size)
    d = ImageDraw.Draw(im)
    box = d.textbbox((0, 0), "Portlight", font=font)
    d.text((x - box[0], center_y - (box[1] + box[3]) / 2), "Portlight", font=font, fill=color)


def store_art(mark, font_path):
    # Compose at 2x to keep the raster wordmark crisp at the delivery dimensions.
    s = 2
    small = Image.new("RGB", (440 * s, 280 * s), GRAPHITE)
    icon = fit_mark(mark, 164 * s, 145 * s)
    small.paste(icon, (138 * s, 24 * s), icon)
    font = ImageFont.truetype(str(font_path), 36 * s)
    length = ImageDraw.Draw(small).textlength("Portlight", font=font)
    wordmark(small, font_path, 36 * s, (440 * s - length) / 2, 223 * s, IVORY)
    small.resize((440, 280), RESAMPLE).save(ROOT / "store/promo-440x280.png")

    marquee = Image.new("RGB", (1400 * s, 560 * s), GRAPHITE)
    icon = fit_mark(mark, 380 * s, 328 * s)
    marquee.paste(icon, (239 * s, 90 * s), icon)
    wordmark(marquee, font_path, 116 * s, 699 * s, 280 * s, IVORY)
    marquee.resize((1400, 560), RESAMPLE).save(ROOT / "store/marquee-1400x560.png")


def preview(font_path):
    im = Image.new("RGB", (960, 440), PAPER)
    d = ImageDraw.Draw(im)
    font = ImageFont.truetype(str(font_path), 16)
    small = ImageFont.truetype(str(font_path), 13)
    d.rectangle((0, 220, 959, 439), fill="#202124")
    for y, color, label in [(0, GRAPHITE, "LIGHT TOOLBAR"), (220, IVORY, "DARK TOOLBAR")]:
        d.text((26, y + 21), label + "   /   actual pixels", font=font, fill=color)
        for x, size in [(48, 16), (146, 32), (252, 48), (378, 128)]:
            icon = Image.open(ROOT / f"icons/icon-{size}.png")
            im.paste(icon, (x, y + 70 + (128 - size) // 2), icon)
            d.text((x, y + 196), f"{size} px", font=small, fill=color)
        for x, size, zoom in [(594, 16, 6), (754, 32, 4)]:
            icon = Image.open(ROOT / f"icons/icon-{size}.png").resize((size * zoom, size * zoom), Image.Resampling.NEAREST)
            im.paste(icon, (x, y + 70 + (128 - icon.height) // 2), icon)
            d.text((x, y + 196), f"{size} px / {zoom}x detail", font=small, fill=color)
    im.save(ROOT / "concepts/preview.png")


def comparison(font_path):
    im = Image.new("RGB", (1120, 360), PAPER)
    d = ImageDraw.Draw(im)
    font = ImageFont.truetype(str(font_path), 16)
    choices = [("01-lighthouse.png", "01 / Lighthouse"), ("02-port-slot.png", "02 / Port slot"),
               ("03-harbor.png", "03 / Harbor"), ("04-harbor-refined.png", "04 / Harbor refined")]
    for i, (filename, label) in enumerate(choices):
        source = Image.open(ROOT / "concepts" / filename).convert("RGBA").resize((250, 250), RESAMPLE)
        im.paste(source, (15 + i * 280, 24), source)
        d.text((24 + i * 280, 310), label, font=font, fill=GRAPHITE)
    im.save(ROOT / "concepts/comparison.png")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, default=Path("/System/Library/Fonts/HelveticaNeue.ttc"))
    args = parser.parse_args()
    mark = clean_master()
    for size, width in [(1024, 820), (128, 110), (48, 42)]:
        fit_mark(mark, size, width).save(ROOT / f"icons/icon-{size}.png")
    for size in [16, 32]:
        toolbar(size).save(ROOT / f"icons/icon-{size}.png")
    store_art(mark, args.font)
    preview(args.font)
    comparison(args.font)
    print("Built 5 transparent icons, 2 store images, toolbar preview and concept comparison.")


if __name__ == "__main__":
    main()
