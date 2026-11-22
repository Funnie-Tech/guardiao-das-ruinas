"""A modular kit (tileset) of ruin pieces -- floor tiles, walls, door arches with torches, columns, sarcophagi,
statues... -- and the level's rooms, each assembled from its own tile map and theme.  Every room is rendered from
the same isometric camera as the sprites into flat layers with normal maps: bg (floor and the far walls), fg (the
near kerbs and door posts) and one layer per row of tall things standing inside the room, so the game can sort
the fighters between them.  Also renders the pushable block and a preview sheet of the kit.
blender -b --factory-startup --python-exit-code 1 --python scripts/render_rooms.py -- out_dir [px_per_unit=80] [supersample=4]
"""
import bpy, bmesh, sys, os, math, json, random
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import iso

args = sys.argv[sys.argv.index("--") + 1:]
outdir = args[0]
PPU = float(args[1]) if len(args) > 1 else 80
SS = int(args[2]) if len(args) > 2 else 4
W, H = 960, 540
T = 0.8                   # tile size
HALF = T * math.sqrt(.5)  # the grid is turned 45 degrees: cell (i, j) sits at ((i - j), (i + j)) * HALF
# Map legend.  ' ' nothing   . floor   = carpet   R rune   L pressure plate   B where the block starts   (walkable)
#              P column   S sarcophagus   A statue   C crates   X rubble   T brazier   O obelisk   W water   (blocked)
# i runs along each string (towards screen up-right, NE), j down the list (towards screen up-left, NW).
# doors: side -> the first of the two cells that door opens from (doors are two tiles wide; the second is the next
# one along the wall).  NE and NW walls are the tall far ones; SW and SE the near kerbs.
ROOMS = {
    "start": dict(theme="moss", doors={"NE": (7, 3)}, map=[
        "........",
        ".C....X.",
        "........",
        "..====..",
        "........",
        ".X....C.",
        "........"]),
    "hall": dict(theme="sand", doors={"SW": (0, 3), "SE": (11, 0)}, map=[
        "..............",
        ".P..P..P..P...",
        "..............",
        "==============",
        "..............",
        ".P..P..P..P...",
        ".............."]),
    "runes": dict(theme="slate", doors={"NW": (4, 8), "NE": (8, 4)}, map=[
        "W.......W",
        ".........",
        "..R...R..",
        ".........",
        "....O....",
        ".........",
        "..R...R..",
        ".........",
        "W.......W"]),
    "crypt": dict(theme="bone", doors={"SW": (0, 4), "NW": (2, 9)}, map=[
        "............",
        ".S..S..S....",
        "............",
        ".S..S..S..T.",
        "............",
        "......      ",
        ".X....      ",
        "......      ",
        "......      ",
        "......      "]),
    "plates": dict(theme="bronze", doors={"SE": (3, 0), "NW": (3, 8)}, map=[
        "   ...   ",
        "   ...   ",
        "   ...   ",
        ".........",
        ".L..B..L.",
        ".........",
        "   ...   ",
        "   ...   ",
        "   ...   "]),
    "gallery": dict(theme="moss", doors={"SE": (2, 0), "SW": (4, 5)}, map=[
        "........    ",
        ".A......    ",
        "........    ",
        "    ........",
        "    ...A....",
        "    ........",
        "    ...A....",
        "    ........"]),
    "arena": dict(theme="arena", doors={"NE": (10, 4)}, gate=(5, 10), map=[
        "   .....   ",
        "  .......  ",
        " .T.....T. ",
        "...........",
        "...........",
        ".....=.....",
        "...........",
        "...........",
        " .T.....T. ",
        "  .......  ",
        "   .....   "]),
    "kit": dict(theme="sand", doors={"NE": (8, 0), "SE": (0, 0)}, map=[".........", "..RL=W...", ".PSACXTO.", "........."]),  # one of everything, for the preview sheet
}
THEMES = {  # floor tones, wall tones
    "moss": ([(.26, .31, .26), (.30, .32, .30), (.22, .28, .24)], [(.34, .36, .33), (.28, .31, .29)]),
    "sand": ([(.44, .38, .30), (.40, .35, .29), (.47, .42, .34)], [(.46, .40, .32), (.38, .33, .27)]),
    "slate": ([(.24, .28, .38), (.28, .31, .40), (.21, .24, .33)], [(.30, .33, .44), (.24, .27, .36)]),
    "bone": ([(.46, .45, .42), (.40, .40, .39), (.50, .48, .44)], [(.42, .41, .40), (.34, .34, .35)]),
    "bronze": ([(.38, .30, .24), (.33, .28, .25), (.42, .34, .26)], [(.36, .30, .27), (.30, .26, .25)]),
    "arena": ([(.33, .32, .34), (.28, .28, .31), (.37, .35, .34)], [(.40, .38, .37), (.33, .33, .36)]),
}
STEP = {"NE": (1, 0), "NW": (0, 1), "SW": (-1, 0), "SE": (0, -1)}
ALONG = {"NE": (0, 1), "SW": (0, 1), "NW": (1, 0), "SE": (1, 0)}  # the way a wall on that side runs
SOLID = "PSACXTOW"

for _name, _r in ROOMS.items():  # every door needs open floor on both its tiles and the two behind them, and nothing beyond
    def _at(i, j, m=_r["map"]):
        return m[j][i] if 0 <= j < len(m) and 0 <= i < len(m[j]) else " "
    for _side, (_i, _j) in _r["doors"].items():
        for _k in (0, 1):
            _ci, _cj = _i + ALONG[_side][0] * _k, _j + ALONG[_side][1] * _k
            assert _at(_ci, _cj) in ".=" and _at(_ci - STEP[_side][0], _cj - STEP[_side][1]) in ".=", f"{_name} {_side}: door blocked"
            assert _at(_ci + STEP[_side][0], _cj + STEP[_side][1]) == " ", f"{_name} {_side}: door is not on an outer edge"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
M = {k: iso.material(k, c) for k, c in dict(dark=(.13, .13, .17), void=(.01, .01, .015), rune=(.16, .34, .50), plate=(.55, .40, .18),
                                           carpet=(.36, .08, .10), gold=(.70, .48, .12), wood=(.30, .19, .10), earth=(.05, .055, .06)).items()}
M["fire"] = iso.material("fire", (1.0, .2, .02), glow=True)   # linear values: a deep orange on screen
M["water"] = iso.material("water", (.02, .10, .22), glow=True)


def add(bm, loc, mat, rot=(0, 0, 0), d=None):
    """Turn a bmesh into an object.  d: its depth row (i + j) if it stands up and must be sorted against the fighters."""
    me = bpy.data.meshes.new("m")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("o", me)
    scene.collection.objects.link(ob)
    me.materials.append(mat)
    ob.location, ob.rotation_euler = loc, rot
    ob["d"] = -999 if d is None else d
    return ob


def box(size, loc, mat, rot=(0, 0, 0), d=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    return add(bm, loc, mat, rot, d)


def rock(half, loc, mat, d=None):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1)
    for v in bm.verts:
        k = 1 + random.uniform(-.2, .2)
        v.co = Vector((v.co.x * half[0] * k, v.co.y * half[1] * k, v.co.z * half[2] * k))
    return add(bm, loc, mat, [random.uniform(0, 3) for _ in range(3)], d)


def cone(height, r1, r2, loc, mat, segments=10, broken=False, d=None, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=r1, radius2=r2, depth=height)
    if broken:
        for v in bm.verts:
            if v.co.z > 0:
                v.co.z -= random.uniform(0, .3)
    return add(bm, loc, mat, rot, d)


class Room:
    def __init__(self, spec):
        self.spec, self.map = spec, spec["map"]
        self.cells = {(i, j): ch for j, row in enumerate(self.map) for i, ch in enumerate(row) if ch != " "}
        us, vs = [i - j for i, j in self.cells], [i + j for i, j in self.cells]
        self.cu, self.cv = (min(us) + max(us)) / 2, (min(vs) + max(vs)) / 2
        # the picture: the floor plus room for the far walls above and a margin all round, and never smaller than the screen
        hw, hh = HALF * PPU, HALF * PPU * math.cos(iso.PHI)
        w = max(W, 2 * math.ceil(((max(us) - min(us)) / 2 + 1) * hw + 90))
        top, bottom = (max(vs) - self.cv + 1) * hh + 210, (self.cv - min(vs) + 1) * hh + 80
        h = max(H, 2 * math.ceil((top + bottom) / 2))
        self.size, self.origin = (w, h), (w / 2, top + (h - top - bottom) / 2)  # origin: the pixel of the grid's middle
        floor, wall = THEMES[spec["theme"]]
        self.floor = [iso.material("f", c) for c in floor]
        self.stone = [iso.material("w", c) for c in wall]
        self.fires = []

    def at(self, i, j, z=0):  # world position of a cell's middle (i, j may be fractional)
        return Vector(((i - j - self.cu) * HALF, (i + j - self.cv) * HALF, z))

    def screen(self, p):
        return [round(self.origin[0] + p.x * PPU, 1), round(self.origin[1] - (p.y * math.cos(iso.PHI) + p.z * math.sin(iso.PHI)) * PPU, 1)]

    def torch(self, p, d):  # a flame; remembered so the game can put a light under it
        rock((.11, .11, .14), p, M["fire"], d)
        self.fires.append((p, d))

    # ---- the kit
    def tile(self, i, j, ch):
        m = M["carpet"] if ch == "=" else random.choice(self.floor)
        if random.random() < .12 and ch == ".":  # a cracked tile: two halves, one sunk
            for s in (-1, 1):
                box((T / 2 - .04, T - .05, .12), self.at(i, j, -.06 - (.04 if s > 0 else 0)) + Vector((s * .14, s * .14, 0)), m, (0, 0, math.pi / 4))
        else:
            box((T - .05, T - .05, .12), self.at(i, j, -.06 - random.uniform(0, .025)), m, (random.uniform(-.02, .02), random.uniform(-.02, .02), math.pi / 4))
        if ch == "R":
            cone(.05, .30, .30, self.at(i, j, .02), M["rune"], 8)
        if ch == "L":
            cone(.05, .30, .30, self.at(i, j, .02), M["plate"], 6)

    def edge(self, i, j, side):  # middle of a cell's edge, the angle a wall along it runs at, and its depth row
        di, dj = STEP[side]
        # Depth: a wall runs diagonally across the screen, so it is sorted by its FAR corner (a far wall) or its NEAR
        # corner (a near kerb).  Sorted by its middle, someone standing in the cell beside it could end up drawn behind it.
        return self.at(i + di / 2, j + dj / 2), math.radians(135 if side in ("NE", "SW") else 45), i + j + (di + dj)

    def wall(self, i, j, side):
        p, a, d = self.edge(i, j, side)
        along = Vector((math.cos(a), math.sin(a), 0))
        if side in ("SW", "SE"):  # near side: a low kerb, so the floor stays in view
            box((T, .2, .26), p + Vector((0, 0, .07)), self.wall_m(), (0, 0, a), d)
            return
        courses = 3 if random.random() < .75 else 2  # far side: courses of block, the top one broken here and there
        for c in range(courses):
            for s in (-1, 1):
                if c == courses - 1 and random.random() < .3:
                    continue
                box((T / 2 - .02, .26, .5), p + along * (s * T / 4 + (c % 2) * .0) + Vector((0, 0, .25 + c * .51)), self.wall_m(), (0, 0, a + random.uniform(-.03, .03)), d)

    def wall_m(self):
        return random.choice(self.stone)

    def door(self, i, j, side):  # the way out: unmistakable.  A dark arch with a gold keystone in a far wall, torch posts in a near one
        ai, aj = ALONG[side]
        p, a, d = self.edge(i + ai / 2, j + aj / 2, side)  # two tiles wide: centred between them
        along, into = Vector((math.cos(a), math.sin(a), 0)), self.at(i + ai / 2, j + aj / 2) - p
        into.normalize()
        for k in (0, 1):
            box((T - .1, T - .1, .05), self.at(i + ai * k, j + aj * k, .02), M["gold"], (0, 0, math.pi / 4))  # a gold threshold on the floor
        box((2 * T - .1, .5, .1), p - into * .35 + Vector((0, 0, -.04)), M["gold"], (0, 0, a))            # and a step beyond it
        if side in ("SW", "SE"):
            for s in (-1, 1):
                q = p + along * (s * (T - .06))
                box((.24, .24, 1.0), q + Vector((0, 0, .5)), self.stone[0], (0, 0, a), d)
                box((.32, .32, .08), q + Vector((0, 0, 1.04)), M["dark"], (0, 0, a), d)
                self.torch(q + Vector((0, 0, 1.2)), d)
            return
        for s in (-1, 1):
            q = p + along * (s * (T - .1))
            box((.24, .36, 1.9), q + Vector((0, 0, .95)), self.stone[0], (0, 0, a), d)
            self.torch(q + into * .26 + Vector((0, 0, 1.15)), d)
            box((.1, .2, .1), q + into * .2 + Vector((0, 0, 1.0)), M["dark"], (0, 0, a), d)
        box((2 * T + .1, .4, .32), p + Vector((0, 0, 2.06)), self.stone[1], (0, 0, a), d)
        box((.3, .44, .38), p + Vector((0, 0, 2.06)), M["gold"], (0, 0, a), d)           # keystone
        box((2 * T - .44, .1, 1.9), p - into * .1 + Vector((0, 0, .95)), M["void"], (0, 0, a), d)  # the dark beyond

    def gate(self, i, j):  # the sealed gate the golem guards, three cells wide in the far wall
        p, a, d = self.edge(i, j, "NW")
        along = Vector((math.cos(a), math.sin(a), 0))
        for s in (-1, 1):
            box((.5, .5, 2.5), p + along * (s * T * 1.1) + Vector((0, 0, 1.25)), self.stone[0], (0, 0, a), d)
        box((T * 2.9, .5, .4), p + Vector((0, 0, 2.55)), self.stone[1], (0, 0, a), d)
        box((T * 1.9, .14, 2.4), p + Vector((0, 0, 1.2)), M["dark"], (0, 0, a), d)
        for k in (-1, 0, 1):
            box((.08, .2, 2.4), p + along * (k * T * .6) + Vector((0, 0, 1.2)), M["gold"], (0, 0, a), d)

    def prop(self, i, j, ch):
        p, d, m = self.at(i, j), i + j, self.wall_m()
        if ch == "P":
            h = random.choice((1.7, 1.9, 1.1, .8))
            box((.56, .56, .16), p + Vector((0, 0, .08)), m, (0, 0, math.pi / 4), d)
            cone(h, .21, .19, p + Vector((0, 0, .16 + h / 2)), m, broken=h < 1.5, d=d)
            if h >= 1.5:
                box((.52, .52, .16), p + Vector((0, 0, .24 + h)), m, (0, 0, math.pi / 4), d)
        elif ch == "S":
            box((.62, 1.0, .42), p + Vector((0, 0, .21)), m, (0, 0, math.pi / 4), d)
            box((.7, 1.08, .1), p + Vector((.04, 0, .47)), self.stone[1], (0, .06, math.pi / 4 + random.uniform(-.2, .2)), d)
            box((.16, .5, .04), p + Vector((.04, 0, .53)), M["gold"], (0, .06, math.pi / 4), d)
        elif ch == "A":
            box((.6, .6, .5), p + Vector((0, 0, .25)), m, (0, 0, math.pi / 4), d)
            rock((.2, .16, .34), p + Vector((0, 0, .84)), self.stone[1], d)
            rock((.13, .13, .14), p + Vector((0, 0, 1.28)), self.stone[1], d)
        elif ch == "C":
            box((.5, .5, .5), p + Vector((0, 0, .25)), M["wood"], (0, 0, random.uniform(0, 1)), d)
            box((.36, .36, .36), p + Vector((.1, -.05, .68)), M["wood"], (0, 0, random.uniform(0, 1)), d)
        elif ch == "X":
            for _ in range(5):
                s = random.uniform(.1, .24)
                rock((s, s, s * .8), p + Vector((random.uniform(-.2, .2), random.uniform(-.2, .2), s * .5)), m, d)
        elif ch == "T":
            box((.3, .3, .6), p + Vector((0, 0, .3)), m, (0, 0, math.pi / 4), d)
            cone(.2, .13, .3, p + Vector((0, 0, .7)), M["dark"], 8, d=d)
            self.torch(p + Vector((0, 0, .88)), d)
        elif ch == "O":
            box((.6, .6, .2), p + Vector((0, 0, .1)), m, (0, 0, math.pi / 4), d)
            cone(1.5, .2, .07, p + Vector((0, 0, .95)), M["dark"], 4, d=d, rot=(0, 0, math.pi / 4))
            box((.1, .1, .1), p + Vector((0, 0, 1.2)), M["rune"], (0, 0, math.pi / 4), d)

    # ---- putting a room together
    def build(self):
        spec, cells = self.spec, self.cells
        box((60, 60, .1), Vector((0, 0, -.2)), M["earth"])
        doors = {}
        for side, (di, dj) in spec["doors"].items():
            doors[(di, dj)] = side
            doors[(di + ALONG[side][0], dj + ALONG[side][1])] = side + "2"  # the door's second tile: no wall there either
        for (i, j), ch in cells.items():
            if ch == "W":
                box((T, T, .04), self.at(i, j, -.1), M["water"], (0, 0, math.pi / 4))
            else:
                self.tile(i, j, ch if ch in ".=RL" else ".")
                self.prop(i, j, ch)
            for side, (di, dj) in STEP.items():
                if (i + di, j + dj) in cells:
                    continue
                if doors.get((i, j), "").rstrip("2") == side:
                    if doors[(i, j)] == side:
                        self.door(i, j, side)
                elif spec.get("gate") and side == "NW" and abs(i - spec["gate"][0]) <= 1 and j == spec["gate"][1]:
                    if i == spec["gate"][0]:
                        self.gate(i, j)
                else:
                    self.wall(i, j, side)

    def layer_of(self, ob):
        """bg, fg, or a depth row.  Far walls with no floor behind them are plain background, near kerbs with no
        floor in front are plain foreground; anything else must be sorted against the fighters."""
        d = ob["d"]
        if d == -999:
            return "bg"
        u = (ob.location.x / HALF) + self.cu
        near = [i + j for (i, j), ch in self.cells.items() if abs((i - j) - u) < 1.4 and ch not in SOLID]  # walkable cells it lines up with on screen
        if not any(0 < v - d <= 5 for v in near):
            return "bg"  # nobody can stand behind it
        if not any(0 < d - v <= 2 for v in near):
            return "fg"  # nobody can stand in front of it
        return round(d * 2) / 2


def clear():
    for o in [o for o in scene.objects if o.type == "MESH"]:
        bpy.data.objects.remove(o)


iso.setup(scene, W, H, PPU, SS, sun=2.2, ambient=.75)
os.makedirs(outdir, exist_ok=True)


def frame(size, origin):
    """Point the camera so that the world origin lands on pixel `origin` of a picture of `size`."""
    scene.render.resolution_x, scene.render.resolution_y = size[0] * SS, size[1] * SS
    scene.camera.data.ortho_scale = max(size) / PPU
    centre = Vector(((size[0] / 2 - origin[0]) / PPU, 0, 0)) - iso.UP * ((size[1] / 2 - origin[1]) / PPU)
    scene.camera.location = centre - iso.VIEW * 20


meta = {"layers": [], "sizes": {}, "ppu": PPU, "ratio": math.cos(iso.PHI), "passes": "n", "screen": [W, H],
        "cell": [HALF * PPU, HALF * PPU * math.cos(iso.PHI)],  # half a tile's width and height on screen
        "rooms": {}}
for n, (name, spec) in enumerate(ROOMS.items()):
    random.seed(n + 11)
    room = Room(spec)
    room.build()
    frame(room.size, room.origin)
    groups = {}
    for o in [o for o in scene.objects if o.type == "MESH"]:
        groups.setdefault(room.layer_of(o), []).append(o)
    layers = []
    for key in sorted(groups, key=lambda k: {"bg": -1e9, "fg": 1e9}.get(k, -k if not isinstance(k, str) else 0)):
        for k, obs in groups.items():
            for o in obs:
                o.visible_camera = k == key  # hidden objects still cast their shadows
        stem = f"{name}_{key}".replace(".", "_")
        iso.render(scene, os.path.join(outdir, stem), "n")
        meta["layers"].append(stem)
        meta["sizes"][stem] = room.size
        # the y the game sorts this layer at: the row's own line on the floor
        layers.append([stem, None if isinstance(key, str) else room.screen(Vector((0, (key - room.cv) * HALF, 0)))[1]])
    meta["rooms"][name] = {
        "map": spec["map"], "grid": [room.cu, room.cv], "size": room.size, "origin": room.origin, "layers": layers,
        "doors": {side: list(c) for side, c in spec["doors"].items()},
        "fires": [room.screen(p) + room.screen(Vector((p.x, p.y, 0))) + [room.screen(Vector((0, (d - room.cv) * HALF, 0)))[1]] for p, d in room.fires],  # flame x, y; ground x, y under it; sort y
    }
    clear()
frame((160, 160), (80, 110))
meta["sizes"]["block"], meta["block"] = (160, 160), (80, 110)
box((.7, .7, .7), (0, 0, .35), iso.material("blk", (.44, .41, .37)), (0, 0, math.pi / 4))  # the block of the plate puzzle
iso.render(scene, os.path.join(outdir, "block"), "n")
meta["layers"].append("block")
json.dump(meta, open(os.path.join(outdir, "meta.json"), "w"))
print("META", {k: len(v["layers"]) for k, v in meta["rooms"].items()})
