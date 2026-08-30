"""Generate a multi-resolution assets/notebook.ico from assets/notebook.png.

Run in CI before `cargo build` so build.rs embeds an icon that carries dedicated
small sizes. Windows picks the closest entry instead of rescaling one large
bitmap at draw time, which is what makes 16px list views and the taskbar crisp.

Only sizes that do not exceed the source resolution are emitted - upscaling a
small source would just bake in blur. Feed it a 256px (or vector-derived) PNG to
get the full range.
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "notebook.png"
OUT = ROOT / "assets" / "notebook.ico"

ALL_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def main() -> int:
    if not SRC.is_file():
        print(f"error: missing source {SRC}", file=sys.stderr)
        return 1

    img = Image.open(SRC).convert("RGBA")
    longest = max(img.size)
    sizes = [s for s in ALL_SIZES if s <= longest]
    if not sizes:
        sizes = [longest]

    if img.width != img.height:
        side = longest
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        img = square
        print(f"note: source was {img.width}x{img.height}, padded to square")

    img.save(OUT, format="ICO", sizes=[(s, s) for s in sizes])
    print(f"source  : {SRC.name} {longest}x{longest}")
    print(f"written : {OUT.name} ({OUT.stat().st_size} bytes)")
    print(f"sizes   : {', '.join(str(s) for s in sizes)}")
    if 256 not in sizes:
        print(
            f"warning: no 256px entry (source is only {longest}px) - high-DPI and "
            "large-icon views will upscale. Supply a 256px source to fix.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
