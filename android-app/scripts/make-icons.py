"""Generate Android launcher icons from the master app icon (shared/app-icon.jpeg).

Outputs, relative to android-app/app/src/main/res:
  mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png   (legacy, full square)
  drawable/ic_launcher_foreground.png                        (432px, white shape on transparent)
  values/colors.xml                                          (adaptive background = sampled pink)

The master is a white shape on solid pink; the adaptive background is the
sampled pink, the foreground only the white pixels, so launcher masking never
crops the shape.
"""
from PIL import Image
import os

SRC = os.path.join(os.path.dirname(__file__), "..", "..", "shared", "app-icon.jpeg")
RES = os.path.join(os.path.dirname(__file__), "..", "app", "src", "main", "res")

src = Image.open(SRC).convert("RGB")
w, h = src.size
bg = src.getpixel((8, 8))
print("sampled background:", bg)

# Legacy full-square icons
for dpi, size in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96),
                  ("xxhdpi", 144), ("xxxhdpi", 192)]:
    d = os.path.join(RES, f"mipmap-{dpi}")
    os.makedirs(d, exist_ok=True)
    src.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher.png"))

# Adaptive foreground: keep only near-white pixels (the plane shape)
fg = Image.new("RGBA", (w, h), (0, 0, 0, 0))
px, out = src.load(), fg.load()
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if r > 200 and g > 200 and b > 200:
            out[x, y] = (255, 255, 255, 255)
fg = fg.resize((432, 432), Image.LANCZOS)
d = os.path.join(RES, "drawable")
os.makedirs(d, exist_ok=True)
fg.save(os.path.join(d, "ic_launcher_foreground.png"))

# Adaptive background color resource
hexcolor = "#{:02X}{:02X}{:02X}".format(*bg)
values = os.path.join(RES, "values")
colors_path = os.path.join(values, "colors.xml")
entry = f'<color name="ic_launcher_background">{hexcolor}</color>'
if os.path.exists(colors_path):
    content = open(colors_path).read()
    if "ic_launcher_background" not in content:
        content = content.replace("</resources>", f"    {entry}\n</resources>")
        open(colors_path, "w").write(content)
else:
    os.makedirs(values, exist_ok=True)
    open(colors_path, "w").write(
        f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    {entry}\n</resources>\n'
    )
print("colors:", entry)
print("done")
