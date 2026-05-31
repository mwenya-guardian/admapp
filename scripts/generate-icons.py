"""Generate PWA icon sizes from public/brand/logo.png."""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "public"
LOGO = ROOT / "brand" / "logo.png"
ICONS = ROOT / "icons"
BG = (14, 17, 23, 255)


def square_icon(logo: Image.Image, size: int, *, inner_scale: float = 1.0) -> Image.Image:
    inner = int(size * inner_scale)
    img = logo.copy()
    img.thumbnail((inner, inner), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), BG)
    x = (size - img.width) // 2
    y = (size - img.height) // 2
    canvas.paste(img, (x, y), img)
    return canvas


def main() -> None:
    if not LOGO.is_file():
        raise SystemExit(f"Missing logo: {LOGO}")

    ICONS.mkdir(exist_ok=True)
    logo = Image.open(LOGO).convert("RGBA")

    for size in (32, 192, 384, 512):
        name = "favicon-32.png" if size == 32 else f"icon-{size}.png"
        square_icon(logo, size).save(ICONS / name)
        print(f"wrote {name}")

    square_icon(logo, 512, inner_scale=0.8).save(ICONS / "icon-maskable-512.png")
    print("wrote icon-maskable-512.png")


if __name__ == "__main__":
    main()
