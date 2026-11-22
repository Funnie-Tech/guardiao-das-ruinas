"""Build a low-poly stone golem out of rigid rock chunks and render its animations in 8 isometric directions,
with a normal-map pass and an emissive pass (the molten core, eyes and seams).
blender -b --factory-startup --python-exit-code 1 --python scripts/render_golem.py -- out_dir [px_per_unit=80] [supersample=4] [passes=ne] [golem|minion]
"""
import bpy, bmesh, sys, os, math, json, random
import numpy as np
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import iso
from iso import DIRS

args = sys.argv[sys.argv.index("--") + 1:]
outdir = args[0]
PPU = float(args[1]) if len(args) > 1 else 80
SS = int(args[2]) if len(args) > 2 else 4
PASSES = args[3] if len(args) > 3 else "ne"
VARIANT = args[4] if len(args) > 4 else "golem"  # "minion": half size, green fire, fewer animations
K = .5 if VARIANT == "minion" else 1
THIGH, SHIN = 0.32 * K, 0.31 * K  # hip-knee and knee-ankle
LEG = THIGH + SHIN

random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


STONE = [iso.material("stone_a", (.24, .25, .30)), iso.material("stone_b", (.17, .19, .24)), iso.material("stone_c", (.30, .29, .31))]
EMBER = iso.material("ember", (.08, 1.0, .35) if VARIANT == "minion" else (1.0, .42, .06), glow=True)
EYE = iso.material("eye", (1.0, .75, .25), glow=True)

# The model faces -Y, its left is +X, feet on z=0.  Joints are empties; the rocks hang off them rigidly.
JOINTS = [  # name, parent, rest position
    ("hips", None, (0, 0, .76)),
    ("spine", "hips", (0, 0, .88)),
    ("head", "spine", (0, -.06, 1.66)),
    ("arm.L", "spine", (.62, 0, 1.46)), ("forearm.L", "arm.L", (.74, 0, 1.02)),
    ("arm.R", "spine", (-.62, 0, 1.46)), ("forearm.R", "arm.R", (-.74, 0, 1.02)),
    ("thigh.L", "hips", (.25, 0, .72)), ("shin.L", "thigh.L", (.27, 0, .40)),
    ("thigh.R", "hips", (-.25, 0, .72)), ("shin.R", "thigh.R", (-.27, 0, .40)),
    ("foot.L", "shin.L", (.27, 0, .09)), ("foot.R", "shin.R", (-.27, 0, .09)),
]
ROCKS = [  # joint, offset from the joint, half-size, material (None = random stone), icosphere subdivisions
    ("hips", (0, 0, -.02), (.34, .26, .20), None, 2),
    ("spine", (0, .02, .38), (.56, .40, .46), None, 2),          # chest
    ("spine", (0, -.02, .08), (.38, .30, .22), None, 2),         # belly
    ("spine", (.24, .24, .74), (.22, .19, .17), None, 1),        # back humps
    ("spine", (-.27, .20, .70), (.17, .17, .22), None, 1),
    ("spine", (.02, .30, .50), (.20, .16, .24), None, 1),
    ("spine", (0, -.37, .40), (.15, .10, .18), EMBER, 1),        # the core, set in the chest
    ("spine", (0, -.04, -.02), (.30, .24, .07), EMBER, 1),       # molten seam at the waist
    ("head", (0, 0, .16), (.21, .22, .19), None, 2),
    ("head", (0, -.11, .27), (.21, .12, .07), None, 1),          # brow
    ("head", (.09, -.19, .17), (.04, .03, .035), EYE, 1),
    ("head", (-.09, -.19, .17), (.04, .03, .035), EYE, 1),
]
for side, sx in ((".L", 1), (".R", -1)):
    ROCKS += [
        ("arm" + side, (0, 0, .04), (.28, .28, .24), None, 2),               # shoulder
        ("arm" + side, (.05 * sx, 0, -.24), (.19, .20, .26), None, 1),
        ("forearm" + side, (0, 0, 0), (.12, .12, .12), EMBER, 1),            # elbow
        ("forearm" + side, (0, 0, -.26), (.22, .23, .34), None, 2),
        ("forearm" + side, (0, -.02, -.60), (.27, .28, .22), None, 2),       # fist
        ("thigh" + side, (0, 0, -.16), (.21, .23, .25), None, 2),
        ("shin" + side, (0, -.01, -.17), (.21, .24, .20), None, 1),
        ("foot" + side, (0, -.09, -.005), (.25, .34, .085), None, 1),
    ]

pivot = bpy.data.objects.new("pivot", None)  # turntable: the camera and the light never move
scene.collection.objects.link(pivot)
joints, rest = {}, {}
for name, parent, pos in JOINTS:
    j = joints[name] = bpy.data.objects.new(name, None)
    scene.collection.objects.link(j)
    j.parent = joints[parent] if parent else pivot
    rest[name] = (Vector(pos) - (Vector(dict((n, p) for n, _, p in JOINTS)[parent]) if parent else Vector())) * K
for i, (joint, offset, half, mat, subdiv) in enumerate(ROCKS):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1)
    for v in bm.verts:  # knock every vertex in or out a little, then squash to size: a faceted boulder
        k = 1 + random.uniform(-.16, .16)
        v.co = Vector((v.co.x * half[0] * k, v.co.y * half[1] * k, v.co.z * half[2] * k)) * K
    me = bpy.data.meshes.new(f"rock{i}")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(f"rock{i}", me)  # new meshes are flat shaded, which is the look we want
    scene.collection.objects.link(ob)
    me.materials.append(mat or random.choice(STONE))
    ob.parent, ob.location = joints[joint], Vector(offset) * K
    ob.rotation_euler = [random.uniform(-.25, .25) for _ in range(3)]
rocks = [o for o in scene.objects if o.type == "MESH"]


def apply(p):
    """p maps joint -> degrees about X, or (x, y, z) degrees (X: negative swings a hanging limb forward;
    Z: positive turns left), relative to the parent.  "<joint>+" moves a joint, "lift"/"fwd" move the hips."""
    for name, _, _ in JOINTS:
        v = p.get(name, 0)
        joints[name].rotation_euler = [math.radians(a) for a in (v if isinstance(v, tuple) else (v, 0, 0))]
        joints[name].location = rest[name] + Vector(p.get(name + "+", (0, 0, 0))) * K
    joints["hips"].location += Vector((0, -p.get("fwd", 0), p.get("lift", 0)))


def world_verts():
    bpy.context.view_layer.update()
    out = []
    for o in rocks:
        co = np.empty(len(o.data.vertices) * 3)
        o.data.vertices.foreach_get("co", co)
        m = np.array(o.matrix_world)
        out.append(co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3])
    return np.concatenate(out)


def legs(L, R, plant=None):
    """Both legs from (thigh, knee) angles.  The hips sit at the height that puts the lower foot on z=0; with
    plant=".L" or ".R" they also move forward so that foot stays where it stands in the rest pose (a step)."""
    p, reach = {}, []
    for side, (thigh, knee) in ((".L", L), (".R", R)):
        p["thigh" + side], p["shin" + side], p["foot" + side] = thigh, knee, -(thigh + knee)  # feet flat
        a, b = math.radians(thigh), math.radians(thigh + knee)
        reach.append(THIGH * math.cos(a) + SHIN * math.cos(b))
        if side == plant:
            p["fwd"] = THIGH * math.sin(a) + SHIN * math.sin(b)
    p["lift"] = max(reach) - LEG
    return p


def both(k):
    return legs((-k, 2 * k), (-k, 2 * k))  # knees bent evenly


def arms(L, R, fore=-12):
    return {"arm.L": L, "arm.R": R, "forearm.L": fore, "forearm.R": fore}


def idle(t):
    b = math.sin(2 * math.pi * t)  # slow breathing
    return {**both(8 + 2 * b), "spine": 4 + 2 * b, "head": -2 - b, **arms((2 * b, -10 - 2 * b, 0), (2 * b, 10 + 2 * b, 0))}


WALK_SWING = 22


def walk(t):
    ph = 2 * math.pi * t
    s, c = math.sin(ph), math.cos(ph)
    up_l, up_r = max(0.0, c), max(0.0, -c)  # 1 while that leg is lifted and passing the other
    return {**legs((-WALK_SWING * s - 10 * up_l, 40 * up_l), (WALK_SWING * s - 10 * up_r, 40 * up_r)),
            "hips": (0, 0, -6 * s), "spine": (6, -4 * c, 8 * s), "head": (-4, 0, -2 * s),  # sways onto the planted leg
            **arms((20 * s, -10, 0), (-20 * s, 10, 0), -14)}


def lerp(a, b, t):
    out = {}
    for k in set(a) | set(b):
        va, vb = a.get(k, 0), b.get(k, 0)
        if isinstance(va, tuple) or isinstance(vb, tuple):
            va, vb = (va if isinstance(va, tuple) else (va, 0, 0)), (vb if isinstance(vb, tuple) else (vb, 0, 0))
            out[k] = tuple(x + (y - x) * t for x, y in zip(va, vb))
        else:
            out[k] = va + (vb - va) * t
    return out


STAGGER = {**legs((2, 8), (8, 6)), "spine": (-22, 0, 10), "head": (-18, 0, 0), **arms((20, -50, 0), (25, 45, 0), -30)}
BUCKLE = {**both(46), "spine": (18, 0, -6), "head": (20, 0, 0), **arms((10, -20, 0), (10, 20, 0), -10)}
RUBBLE = {"thigh.L": (-80, -20, 0), "shin.L": 110, "thigh.R": (-75, 25, 0), "shin.R": 100, "lift": -.58 * K,
          "spine": (62, 0, -12), "spine+": (0, -.05, -.06), "head": (50, 30, 20), "head+": (.25, -.55, -.62),
          "arm.L": (40, -75, 0), "arm.L+": (.20, .10, -.62), "forearm.L": (-50, 0, 30), "forearm.L+": (.15, -.2, .05),
          "arm.R": (60, 80, 0), "arm.R+": (-.25, .05, -.66), "forearm.R": (-30, 0, -40), "forearm.R+": (-.2, -.25, .1)}
ROAR = {**both(4), "spine": -14, "head": -12, **arms((-10, -125, 0), (-10, 125, 0), -30)}  # upright, arms flung wide
ANIMS = {  # one pose per frame.  idle and walk loop; the rest play once
    "idle": [idle(i / 6) for i in range(6)],
    "walk": [walk(i / 8) for i in range(8)],
    # Right arm sweeps from behind-right across the front, stepping in with the right foot
    "swipe": [
        {**both(12), "hips": (0, 0, -10), "spine": (-4, 0, -22), "head": (0, 0, 25),
         **arms((-15, -15, 0), (25, 60, 0), -28)},
        {**both(12), "hips": (0, 0, -15), "spine": (-8, 0, -36), "head": (4, 0, 42),
         **arms((-25, -15, 0), (35, 80, 0), -36)},                                           # wound up
        {**legs((10, 12), (-26, 38), plant=".L"), "spine": (10, 0, 5), "head": (-6, 0, -5),
         **arms((10, -20, 0), (-85, 0, -35), -10)},                                          # strike
        {**legs((16, 14), (-34, 46), plant=".L"), "hips": (0, 0, 12), "spine": (16, 0, 34), "head": (-10, 0, -40),
         **arms((25, -25, 0), (-80, 0, 45), -6)},
        {**legs((16, 14), (-34, 46), plant=".L"), "hips": (0, 0, 14), "spine": (18, 0, 40), "head": (-10, 0, -48),
         **arms((28, -25, 0), (-70, 0, 62), -10)},                                           # follow-through
        {**legs((8, 10), (-18, 26), plant=".L"), "hips": (0, 0, 6), "spine": (8, 0, 16), "head": (-4, 0, -20),
         **arms((8, -12, 0), (-30, 10, 20), -15)},
        {**both(9), "spine": 4, **arms((0, -10, 0), (-8, 10, 5))},
    ],
    # Both fists go up, then come down on the ground in front
    "slam": [
        {**both(10), "spine": -4, **arms((-80, -8, 0), (-80, 8, 0), -15)},
        {**both(6), "spine": -12, "head": -8, **arms((-150, 12, 0), (-150, -12, 0), -20)},
        {**both(4), "spine": -18, "head": -12, **arms((-172, 14, 0), (-172, -14, 0), -25)},  # held at the top
        {**both(20), "spine": 18, "head": -10, **arms((-110, 4, 0), (-110, -4, 0), -5)},
        {**both(35), "spine": 50, "head": -35, **arms((-65, 0, 0), (-65, 0, 0), 0)},         # impact
        {**both(37), "spine": 53, "head": -36, **arms((-62, 0, 0), (-62, 0, 0), 0)},
        {**both(35), "spine": 48, "head": -34, **arms((-66, 0, 0), (-66, 0, 0), 0)},
        {**both(22), "spine": 26, "head": -18, **arms((-40, -6, 0), (-40, 6, 0), -8)},
        {**both(10), "spine": 8, **arms((-10, -10, 0), (-10, 10, 0))},
    ],
    # Arms spread and rise while the core charges, then snap down as the spell goes off
    "cast": [
        {**both(10), "spine": -4, **arms((0, -55, 0), (0, 55, 0), -10)},
        {**both(6), "spine": -10, "head": -8, **arms((-10, -105, 0), (-10, 105, 0), -20)},
        {**both(4), "spine": -14, "head": -12, **arms((-10, -125, 0), (-10, 125, 0), -30)},  # charging
        {**both(4), "spine": (-12, 0, 4), "head": -10, **arms((-10, -120, 0), (-10, 120, 0), -30)},
        {**both(25), "spine": 22, "head": -14, **arms((-50, -35, 0), (-50, 35, 0), -5)},     # release
        {**both(28), "spine": 26, "head": -16, **arms((-45, -40, 0), (-45, 40, 0), -5)},
        {**both(14), "spine": 10, **arms((-12, -18, 0), (-12, 18, 0), -10)},
    ],
    "hurt": [
        {**legs((-4, 10), (6, 10)), "hips": (0, 0, 8), "spine": (-18, 0, 12), "head": (-10, 0, -10),
         **arms((15, -35, 0), (20, 30, 0), -25)},
        {**legs((-8, 16), (-2, 14)), "spine": (-8, 0, 5), **arms((6, -20, 0), (8, 18, 0), -16)},
    ],
    # Staggers, drops to its knees and falls apart; the last frame is the pile that stays on the ground
    "death": [STAGGER, lerp(STAGGER, BUCKLE, .6), BUCKLE, lerp(BUCKLE, RUBBLE, .25), lerp(BUCKLE, RUBBLE, .55),
              lerp(BUCKLE, RUBBLE, .85), RUBBLE],
    # Waking: it starts as the same heap of rubble, stirs, pulls itself together onto its knees, stands and roars.
    # The first frame is what lies in the hall until the hero comes close.
    "rise": [RUBBLE, lerp(RUBBLE, BUCKLE, .06), lerp(RUBBLE, BUCKLE, .25), lerp(RUBBLE, BUCKLE, .5), lerp(RUBBLE, BUCKLE, .78), BUCKLE,
             lerp(BUCKLE, ROAR, .55), ROAR, lerp(ROAR, idle(0), .55)],
}
MS = {"idle": [160] * 6, "walk": [110] * 8, "hurt": [90, 110],  # ms per frame
      "swipe": [120, 170, 60, 60, 170, 110, 90],
      "slam": [110, 130, 220, 60, 70, 150, 140, 110, 90],
      "cast": [120, 150, 180, 180, 70, 200, 120],
      "death": [130, 140, 150, 110, 110, 120, 400],
      "rise": [260, 200, 170, 150, 140, 150, 150, 480, 180]}
if VARIANT == "minion":
    ANIMS = {k: ANIMS[k] for k in ("idle", "walk", "swipe", "hurt", "death")}
assert all(len(MS[a]) == len(ANIMS[a]) for a in ANIMS)


def posed_points():
    for anim, poses in ANIMS.items():
        for f, p in enumerate(poses):
            apply(p)
            pts = world_verts()
            if pts[:, 2].min() < -0.05 * K and anim not in ("death", "rise"):
                print(f"WARN {anim} frame {f} goes {-pts[:, 2].min():.3f} below the ground")
            yield pts


size, yc = iso.fit(posed_points(), PPU)
iso.setup(scene, size, size, PPU, SS, centre=iso.UP * yc)

os.makedirs(outdir, exist_ok=True)
for anim, poses in ANIMS.items():
    for f, p in enumerate(poses):
        apply(p)
        for i, d in enumerate(DIRS):
            pivot.rotation_euler.z = i * math.pi / 4
            iso.render(scene, os.path.join(outdir, f"{anim}_{d}_{f}"), PASSES)

meta = {"dirs": DIRS, "anims": {k: len(v) for k, v in ANIMS.items()}, "ms": {k: MS[k] for k in ANIMS}, "size": size,
        "passes": PASSES, "ppu": PPU, "elevation_deg": math.degrees(iso.ELEV),
        "anchor": [size / 2, size / 2 + yc * PPU],
        "stride": {"walk": 4 * LEG * math.sin(math.radians(WALK_SWING)) * PPU}}
json.dump(meta, open(os.path.join(outdir, "meta.json"), "w"))
print("META", json.dumps(meta))
