#!/usr/bin/env python3
from PIL import Image
import os

script_dir = os.path.dirname(os.path.abspath(__file__))
output_dir = os.path.normpath(os.path.join(script_dir, "../src/generated_icons"))
if not os.path.isdir(output_dir):
  raise IOError(f"Output directory does not exist: {output_dir}")

sprite_img = {
  16: Image.open(os.path.join(script_dir, "sprites16.png")).convert("RGBA"),
  32: Image.open(os.path.join(script_dir, "sprites32.png")).convert("RGBA"),
}

# Images from spritesXX.png: [x, y, w, h]
sprite_big = {
  "4": {16: (1, 1, 9, 14),
        32: (1, 1, 21, 28)},
  "6": {16: (11, 1, 9, 14),
        32: (23, 1, 21, 28)},
  "q": {16: (21, 1, 9, 14),
        32: (45, 1, 21, 28)},
}

sprite_small = {
  "4": {16: (31, 1, 6, 6),
        32: (67, 1, 10, 10)},
  "6": {16: (31, 8, 6, 6),
        32: (67, 12, 10, 10)},
}

# Destination coordinates: [x, y]
target_big = {
  16: (0, 1),
  32: (0, 2)
}
target_small1 = {
  16: (10, 1),
  32: (22, 2)
}
target_small2 = {
  16: (10, 8),
  32: (22, 14)
}

def draw_sprite(canvas, size, targets, sources):
  (x, y, w, h) = sources[size]
  region = sprite_img[size].crop((x, y, x+w, y+h))
  target = targets[size]
  canvas.paste(region, target)

# pattern is 0..3 characters, each '4', '6', or '?'.
# size is 16 or 32.
# color is "lightfg" or "darkfg".
def build_icon(pattern, size, color):
  canvas = Image.new("RGBA", (size, size), (0,0,0,0))

  if len(pattern) >= 1:
    draw_sprite(canvas, size, target_big, sprite_big[pattern[0]])
  if len(pattern) >= 2:
    draw_sprite(canvas, size, target_small1, sprite_small[pattern[1]])
  if len(pattern) >= 3:
    draw_sprite(canvas, size, target_small2, sprite_small[pattern[2]])

  if color == "lightfg":
    pixels = canvas.load()
    for y in range(size):
      for x in range(size):
        r, g, b, a = pixels[x, y]
        if a > 0:  # only modify non-transparent pixels
          r = min(r + 128, 255)
          g = min(g + 128, 255)
          b = min(b + 128, 255)
          pixels[x, y] = (r, g, b, a)

  return canvas

for color in ["lightfg", "darkfg"]:
  for size in [16, 32]:
    for prefix in sprite_big.keys():
      for suffix in ["", "4", "6", "46"]:
        pattern = prefix + suffix
        img = build_icon(pattern, size, color)
        out_file = os.path.join(output_dir, f"{color}{size}_{pattern}.png")
        print(f"Writing {out_file}")
        img.save(out_file)

print("Done!")
