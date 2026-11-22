"""Hi-res renders -> pixel art: box downscale, hard alpha, one shared palette, 1px outline.

python3 scripts/pixelate.py hires_dir out_dir [colors=24]
    one PNG per frame (warrior_{DIR}.png for idle, {anim}/{DIR}/{frame}.png) + meta.js, for the sprite viewer
python3 scripts/pixelate.py hires_dir out_dir [colors] --sheets NAME
    NAME_{anim}.png sheets (rows = the 8 directions, columns = frames) + NAME.json, for the game
python3 scripts/pixelate.py hires_dir out_dir [colors] --layers NAME
    flat scene layers NAME_{layer}.png + NAME.json (no outline)
With --sheets/--layers, renders that have passes also get NAME_..._n.png (normal map) and NAME_..._e.png (emissive).
"""
import sys, os, json, math
from PIL import Image, ImageChops, ImageEnhance

argv = sys.argv[1:]
mode = name = None
for flag in ("--sheets", "--layers"):
    if flag in argv:
        i = argv.index(flag)
        mode, name = flag[2:], argv[i + 1]
        del argv[i:i + 2]
src, dst = argv[0], argv[1]
COLORS = int(argv[2]) if len(argv) > 2 else 24
meta = json.load(open(os.path.join(src, "meta.json")))
passes = meta.get("passes", "ne" if mode == "layers" else "") if mode else ""
if mode == "layers":
    stems, size = meta["layers"], None  # every layer has its own size
else:
    stems = [f"{a}_{d}_{f}" for a, n in meta["anims"].items() for d in meta["dirs"] for f in range(n)]
    size = (meta["size"], meta["size"])
FLAT = (128, 128, 255)  # a normal pointing straight at the viewer


def shrink(stem):
    """Box-filter a render down to sprite size.  Premultiplied, so edge pixels don't average toward black."""
    im = Image.open(os.path.join(src, stem + ".png")).convert("RGBA").convert("RGBa")
    return im.resize(size or tuple(meta["sizes"][stem.rsplit("_", 1)[0] if stem.endswith(("_n", "_e")) else stem]), Image.Resampling.BOX).convert("RGBA")


frames, masks = [], []
for stem in stems:
    im = shrink(stem)
    masks.append(im.getchannel("A").point(lambda v: 255 if v >= 128 else 0))  # no semi-transparent pixels
    rgb = ImageEnhance.Color(im.convert("RGB")).enhance(1.3)
    frames.append(ImageEnhance.Contrast(rgb).enhance(1.15))

# One palette for every frame, built from opaque pixels only.  A few million pixels are plenty, so with
# many frames only every step-th one is read.
boxes = [m.getbbox() or (0, 0, 1, 1) for m in masks]
area = sum((b[2] - b[0]) * (b[3] - b[1]) for b in boxes)
step = max(1, area // 3_000_000)
px = bytearray()
for f, m, b in list(zip(frames, masks, boxes))[::step]:
    fb, mb = f.crop(b).tobytes(), m.crop(b).tobytes()
    for i in range(len(mb)):
        if mb[i]:
            px += fb[3 * i:3 * i + 3]
strip = Image.frombytes("RGB", (len(px) // 3, 1), bytes(px))
pal = strip.quantize(COLORS, method=Image.Quantize.MEDIANCUT, kmeans=8, dither=Image.Dither.NONE)
colors = [c for _, c in pal.convert("RGB").getcolors()]
outline = tuple(v // 2 for v in min(colors, key=sum)) + (255,)  # darkest palette colour, halved

if mode == "layers":
    box = (0, 0, 1, 1)
else:
    union = masks[0]
    for m in masks[1:]:
        union = ImageChops.lighter(union, m)
    x0, y0, x1, y1 = union.getbbox()
    box = (x0 - 1, y0 - 1, x1 + 1, y1 + 1)  # same crop for every frame keeps the anchor fixed; +1 for the outline
    assert box[0] >= 0 and box[1] >= 0 and box[2] <= size[0] and box[3] <= size[1], "sprite touches the frame edge"
w, h = box[2] - box[0], box[3] - box[1]


def finished(i):
    """Frame i as it ships: palette colours, hard alpha, dark outline (sprites only), cropped."""
    f, m = frames[i], masks[i]
    out = Image.new("RGBA", f.size, (0, 0, 0, 0))
    if mode != "layers":
        edge = m
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            edge = ImageChops.lighter(edge, ImageChops.offset(m, dx, dy))
        out.paste(outline, mask=edge)
    out.paste(f.quantize(palette=pal, dither=Image.Dither.NONE).convert("RGB"), mask=m)
    return out.crop(masks[i].getbbox() or (0, 0, 1, 1)) if mode == "layers" else out.crop(box)  # scene layers are trimmed, each to its own content


def extra(i, kind):
    """The normal ("n") or emissive ("e") pass of frame i, inside the same silhouette.  Normals stay smooth;
    the outline pixels get a flat normal and no glow."""
    out = Image.new("RGB", masks[i].size, FLAT if kind == "n" else (0, 0, 0))
    out.paste(shrink(f"{stems[i]}_{kind}").convert("RGB"), mask=masks[i])
    return out.crop(masks[i].getbbox() or (0, 0, 1, 1)) if mode == "layers" else out.crop(box)


os.makedirs(dst, exist_ok=True)
info = {"w": w, "h": h, "colors": len(colors) + 1}
if mode == "layers":
    for i, layer in enumerate(stems):
        finished(i).save(os.path.join(dst, f"{name}_{layer}.png"))
        for kind in passes:
            extra(i, kind).save(os.path.join(dst, f"{name}_{layer}_{kind}.png"))
    info.update(meta)
    info["at"] = {layer: list((masks[i].getbbox() or (0, 0, 1, 1))[:2]) for i, layer in enumerate(stems)}  # where each trimmed layer goes
else:
    info.update({"dirs": meta["dirs"], "anims": meta["anims"], "ms": meta["ms"],
                 "anchor": [round(meta["anchor"][0] - box[0], 2), round(meta["anchor"][1] - box[1], 2)],
                 "stride": {k: round(v, 2) for k, v in meta["stride"].items()},  # px of ground covered by one cycle
                 "tileRatio": math.sin(math.radians(meta["elevation_deg"])),  # ground diamond height / width
                 "elevationDeg": meta["elevation_deg"]})
    i = 0
    for a, n in meta["anims"].items():
        if mode == "sheets":
            sheets = {"": Image.new("RGBA", (n * w, len(meta["dirs"]) * h))}
            sheets.update({kind: Image.new("RGB", (n * w, len(meta["dirs"]) * h)) for kind in passes})
        for row, d in enumerate(meta["dirs"]):
            for f in range(n):
                if mode == "sheets":
                    sheets[""].paste(finished(i), (f * w, row * h))
                    for kind in passes:
                        sheets[kind].paste(extra(i, kind), (f * w, row * h))
                else:
                    path = os.path.join(dst, f"warrior_{d}.png" if a == "idle" else f"{a}/{d}/{f}.png")
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    finished(i).save(path)
                i += 1
        if mode == "sheets":
            for kind, sheet in sheets.items():
                sheet.save(os.path.join(dst, f"{name}_{a}{'_' + kind if kind else ''}.png"))
if mode:
    json.dump(info, open(os.path.join(dst, name + ".json"), "w"))
else:
    open(os.path.join(dst, "meta.js"), "w").write("const SPRITE_META = " + json.dumps(info) + ";\n")
print(info)
