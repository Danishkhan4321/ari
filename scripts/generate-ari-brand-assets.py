"""Generate deterministic Ari desktop and browser icon assets.

Requires Pillow. The source geometry mirrors dashboard/public/ari-mark.svg.
"""

from pathlib import Path
from shutil import copyfile

from PIL import Image, ImageDraw, ImageOps


ROOT = Path(__file__).resolve().parents[1]
DASHBOARD_PUBLIC = ROOT / "dashboard" / "public"
DESKTOP_BUILD = ROOT / "desktop" / "build"

SOURCE_SIZE = 160
OUTPUT_SIZE = 1024
RENDER_SIZE = 4096
RENDER_SCALE = RENDER_SIZE / SOURCE_SIZE

RIGHT = [(28, 126), (68, 34), (90, 34), (132, 126), (107, 126), (79, 64), (53, 126)]
LEFT = [(28, 126), (68, 34), (80, 64), (53, 126)]
CROSSBAR = [(58, 99), (102, 99), (95, 83), (65, 83)]

COLORS = {
    "midnight_start": "#2D204D",
    "midnight_end": "#120E1C",
    "right": "#8A65FF",
    "left": "#5A37D6",
    "crossbar": "#D8CCFF",
}


def scaled(points):
    return [(round(x * RENDER_SCALE), round(y * RENDER_SCALE)) for x, y in points]


def gradient_tile():
    gradient_size = RENDER_SIZE * 2
    ramp = Image.linear_gradient("L").resize(
        (gradient_size, gradient_size),
        Image.Resampling.BICUBIC,
    )
    ramp = ramp.rotate(-45, resample=Image.Resampling.BICUBIC, expand=False)
    offset = RENDER_SIZE // 2
    ramp = ramp.crop((offset, offset, offset + RENDER_SIZE, offset + RENDER_SIZE))
    gradient = ImageOps.colorize(
        ramp,
        black=COLORS["midnight_start"],
        white=COLORS["midnight_end"],
    ).convert("RGBA")

    mask = Image.new("L", (RENDER_SIZE, RENDER_SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, RENDER_SIZE - 1, RENDER_SIZE - 1),
        radius=round(35 * RENDER_SCALE),
        fill=255,
    )
    gradient.putalpha(mask)
    return gradient


def render_icon():
    image = gradient_tile()
    draw = ImageDraw.Draw(image)
    draw.polygon(scaled(RIGHT), fill=COLORS["right"])
    draw.polygon(scaled(LEFT), fill=COLORS["left"])
    draw.polygon(scaled(CROSSBAR), fill=COLORS["crossbar"])
    return image.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.Resampling.LANCZOS)


def write_assets():
    DASHBOARD_PUBLIC.mkdir(parents=True, exist_ok=True)
    DESKTOP_BUILD.mkdir(parents=True, exist_ok=True)

    icon = render_icon()
    dashboard_png = DASHBOARD_PUBLIC / "ari-icon.png"
    desktop_png = DESKTOP_BUILD / "icon.png"
    favicon = DASHBOARD_PUBLIC / "favicon.ico"
    desktop_ico = DESKTOP_BUILD / "icon.ico"
    desktop_icns = DESKTOP_BUILD / "icon.icns"

    icon.save(dashboard_png, format="PNG", optimize=True)
    copyfile(dashboard_png, desktop_png)
    icon.save(favicon, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    icon.save(desktop_ico, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    icon.save(desktop_icns, format="ICNS")

    for output in [dashboard_png, favicon, desktop_png, desktop_ico, desktop_icns]:
        print(f"generated {output.relative_to(ROOT)} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    write_assets()
