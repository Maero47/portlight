"""Check delivery dimensions, PNG formats, transparency and toolbar reductions."""

from pathlib import Path
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent


def check():
    for size in (16, 32, 48, 128, 1024):
        path = ROOT / "icons" / f"icon-{size}.png"
        with Image.open(path) as im:
            im.load()
            assert im.format == "PNG" and im.size == (size, size), path
            assert im.mode == "RGBA", path
            alpha = im.getchannel("A")
            assert alpha.getextrema() == (0, 255), path
            corners = ((0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1))
            assert all(alpha.getpixel(xy) == 0 for xy in corners), path
            assert alpha.getpixel((size // 2, size // 2)) == 0, "Harbor opening lost"
            if size in (16, 32):
                with Image.open(ROOT / "icons/icon-1024.png") as master:
                    scaled = master.resize((size, size), Image.Resampling.LANCZOS)
                    assert ImageChops.difference(im, scaled).getbbox(), "Missing optical reduction"
                # The light and harbor must remain two distinct opaque components.
                pixels = {(x, y) for y in range(size) for x in range(size) if alpha.getpixel((x, y)) >= 128}
                components = 0
                while pixels:
                    components += 1
                    queue = [pixels.pop()]
                    while queue:
                        x, y = queue.pop()
                        for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                            if neighbor in pixels:
                                pixels.remove(neighbor)
                                queue.append(neighbor)
                assert components == 2, "Light merged into harbor or stray opaque pixels"
            print(f"PASS icon-{size}.png: {size}x{size}, RGBA, transparent corners and open center")
    for filename, size in (("promo-440x280.png", (440, 280)), ("marquee-1400x560.png", (1400, 560))):
        with Image.open(ROOT / "store" / filename) as im:
            im.load()
            assert im.format == "PNG" and im.size == size and im.mode == "RGB", filename
            print(f"PASS {filename}: {size[0]}x{size[1]}, opaque RGB")
    for filename, size in (("preview.png", (960, 440)), ("comparison.png", (1120, 360))):
        with Image.open(ROOT / "concepts" / filename) as im:
            im.load()
            assert im.size == size, filename
    print("PASS all 7 delivery images and 2 review sheets; optical toolbar reductions retain two separate shapes")


if __name__ == "__main__":
    check()
