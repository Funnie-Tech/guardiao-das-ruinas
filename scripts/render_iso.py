"""Rig the warrior GLB, then render idle, walk, run, attack, thrust, spin attack, jump, roll, parry, death, pickup and push in 8 isometric directions
(orthographic camera).
blender -b --factory-startup --python-exit-code 1 --python scripts/render_iso.py -- model.glb out_dir [px_per_unit=101] [supersample=8] [passes]
passes "n" also writes a normal map for every frame (name_n.png), for engines that light the sprites.
"""
import bpy, sys, os, math, json
import numpy as np
from mathutils import Vector, Matrix
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import iso
from iso import DIRS

args = sys.argv[sys.argv.index("--") + 1:]
glb, outdir = args[0], args[1]
PPU = float(args[2]) if len(args) > 2 else 101  # sprite pixels per world unit
SS = int(args[3]) if len(args) > 3 else 8       # render at SS x sprite size; pixelate.py box-filters it down
PASSES = args[4] if len(args) > 4 else ""
SWING, KNEE = 28, 55      # walk: thigh swing and knee bend of the lifted leg (deg)
THIGH, SHIN = 0.13, 0.10  # leg segment lengths, hip-knee and knee-ankle
LEG = THIGH + SHIN

# Joints measured on THIS model (+Z up, faces -Y, its left is +X, feet on z=0, centred on the origin).
# A different model needs its own numbers.  (name, parent, head, tail)
BONES = [
    ("hips", None, (0, .03, .28), (0, .03, .38)),
    ("spine", "hips", (0, .03, .38), (0, .04, .54)),
    ("head", "spine", (.02, .04, .54), (.02, .05, .90)),
    ("cape", "spine", (.15, .10, .52), (.24, .14, .15)),
    ("thigh.L", "hips", (.10, .03, .28), (.11, .02, .15)),
    ("shin.L", "thigh.L", (.11, .02, .15), (.115, .03, .05)),
    ("foot.L", "shin.L", (.115, .03, .05), (.12, -.06, .02)),
    ("thigh.R", "hips", (-.08, .03, .28), (-.085, .02, .15)),
    ("shin.R", "thigh.R", (-.085, .02, .15), (-.085, .03, .05)),
    ("foot.R", "shin.R", (-.085, .03, .05), (-.09, -.06, .02)),
    ("arm.L", "spine", (.14, .04, .50), (.165, .04, .39)),
    ("forearm.L", "arm.L", (.165, .04, .39), (.18, .02, .26)),
    ("arm.R", "spine", (-.14, .04, .50), (-.165, .03, .39)),
    ("forearm.R", "arm.R", (-.165, .03, .39), (-.18, -.04, .28)),
    ("sword", "forearm.R", (-.19, -.07, .27), (-.285, -.30, .03)),
]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
scene = bpy.context.scene
view_layer = bpy.context.view_layer
body = next(o for o in scene.objects if o.type == "MESH")  # this model is one mesh
view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.remove_doubles(threshold=1e-5)  # weld UV-seam duplicates so the skin doesn't crack when it bends
bpy.ops.object.mode_set(mode="OBJECT")

rig = bpy.data.objects.new("rig", bpy.data.armatures.new("rig"))
scene.collection.objects.link(rig)
view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
for name, parent, head, tail in BONES:
    b = rig.data.edit_bones.new(name)
    b.head, b.tail = head, tail
    if parent:
        b.parent = rig.data.edit_bones[parent]
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
rig.select_set(True)
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
unweighted = sum(1 for v in body.data.vertices if not v.groups)
assert unweighted == 0, f"automatic weights failed for {unweighted} vertices"

pivot = bpy.data.objects.new("pivot", None)  # turntable: the camera and the light never move
scene.collection.objects.link(pivot)
rig.parent = pivot


def lr(**kw):
    """Same angle on the left and right bone: lr(thigh=-25) -> {"thigh.L": -25, "thigh.R": -25}"""
    return {f"{k}{side}": v for k, v in kw.items() for side in (".L", ".R")}


def legs(L, R, plant=None):
    """Both legs from (thigh, knee) angles.  The hips sit at the height that puts the lower foot on z=0; with
    plant=".L" or ".R" they also move forward so that foot stays where it stands in the rest pose (a step or lunge)."""
    p, reach = {}, []
    for side, (thigh, knee) in ((".L", L), (".R", R)):
        p["thigh" + side], p["shin" + side], p["foot" + side] = thigh, knee, -(thigh + knee)  # feet flat
        a, b = math.radians(thigh), math.radians(thigh + knee)
        reach.append(THIGH * math.cos(a) + SHIN * math.cos(b))
        if side == plant:
            p["fwd"] = THIGH * math.sin(a) + SHIN * math.sin(b)
    p["lift"] = max(reach) - LEG
    return p


def crouch(k):
    """Knees bent with both feet flat on the ground; k=1 lowers the hips about 5 cm."""
    return legs((-40 * k, 80 * k), (-40 * k, 80 * k))


def aim(x, y, z):
    """Point a bone along this direction, in the character's own axes whatever its parents do
    (+X its left, -Y forward, +Z up)."""
    return Vector((x, y, z))


def look(x, y, z):
    """Head orientation: face this direction and stay level, whatever the body does."""
    return Vector((x, y, z)).to_track_quat("-Y", "Z")


def gait(t, run):
    """One point (t in 0..1) of the walk or run cycle, in place."""
    swing, knee, raise_, lean, arm, elbow = (40, 100, 25, 12, 40, 70) if run else (SWING, KNEE, 12, 3, 22, 8)
    ph = 2 * math.pi * t
    s = math.sin(ph)
    p = {}
    for side, sw, up in ((".L", s, max(0.0, math.cos(ph))), (".R", -s, max(0.0, -math.cos(ph)))):
        # sw: +1 leg fully forward, -1 fully back.  up: 1 while this leg is lifted and passing the other
        thigh = -swing * sw - raise_ * up
        shin = knee * up + (15 if run else 0)
        p["thigh" + side], p["shin" + side] = thigh, shin
        p["foot" + side] = -(thigh + shin) * (1 - 0.6 * up)  # planted foot stays flat on the ground
    # walk: hips drop as the legs spread so the planted foot stays on z=0.  run: airborne while the legs are spread
    p["lift"] = 0.06 * s * s if run else -LEG * (1 - math.cos(math.radians(swing * s)))
    twist = 14 if run else 10
    p["hips"] = (0, 0, -6 * s)                        # pelvis follows the leading leg
    p["spine"] = (lean, 0, twist * s)                 # lean into it, shoulders counter the hips
    p["head"] = (-0.8 * lean, 0, (6 - twist) * s)     # head keeps facing the direction of travel
    p["arm.L"] = arm * s                              # arms swing opposite to the legs
    p["forearm.L"] = -elbow - 12 * max(0.0, -s)
    p["arm.R"] = -0.45 * arm * s                      # sword arm swings less
    p["forearm.R"] = -30 if run else -4
    p["sword"] = 0 if run else -13 * max(0.0, -s)     # wrist lifts the tip clear of the ground on the back swing
    p["cape"] = (30 if run else 4) + (8 if run else 5) * math.sin(2 * ph - 1.0)  # trails behind the body bob
    return p


def apply(p):
    """Pose the rig.  p maps bone -> one of:
      degrees about X (the side-to-side axis), or (x, y, z) degrees about the armature axes, relative to the parent
        (X: negative swings a hanging limb forward, the model faces -Y.  Z: positive turns left);
      aim(...)  -> the bone points that way;   look(...) -> the bone takes that orientation.
    "lift" raises the hips and "fwd" moves them forward.  Bones left out stay in the rest pose."""
    total = {}  # armature-space rotation of each bone, parents included
    for name, parent, head, tail in BONES:  # parents come before their children
        v = p.get(name, 0)
        A = total.get(parent, Matrix.Identity(3))
        if isinstance(v, Vector):
            rest = (Vector(tail) - Vector(head)).normalized()
            R = A.inverted() @ rest.rotation_difference(v.normalized()).to_matrix()
        elif hasattr(v, "to_matrix"):
            R = A.inverted() @ v.to_matrix()
        else:
            x, y, z = v if isinstance(v, tuple) else (v, 0, 0)
            R = (Matrix.Rotation(math.radians(z), 3, "Z") @ Matrix.Rotation(math.radians(y), 3, "Y")
                 @ Matrix.Rotation(math.radians(x), 3, "X"))
        total[name] = A @ R
        pb = rig.pose.bones[name]
        B = pb.bone.matrix_local.to_3x3()
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = (B.inverted() @ R @ B).to_quaternion()
    hips = rig.pose.bones["hips"]
    hips.location = hips.bone.matrix_local.to_3x3().inverted() @ Vector((0, -p.get("fwd", 0), p.get("lift", 0)))


def world_verts():
    view_layer.update()
    ev = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    return co.reshape(-1, 3)  # body sits at the origin with the turntable at 0, so local == world


SPIN = {**crouch(.35), "spine": 8, "head": -6, "arm.R": (0, 80, 0), "arm.L": (0, -55, 0), "forearm.L": -30,
        "cape": (30, -25, 0)}
TUCK = {**lr(thigh=-105, shin=125, foot=-15), "spine": 42, "head": 30, "arm.L": (-55, -8, 0), "forearm.L": -85,
        "arm.R": (-45, 12, 0), "forearm.R": -70, "sword": 35, "cape": 10}  # curled up for the roll
RUN_STRIDE = 0.70  # ground covered per run cycle, world units (the run has a flight phase, so this is a choice)
FWD = look(0, -1, 0)  # eyes on the target
ANIMS = {  # one pose per frame.  walk and run loop; the rest play once
    "idle": [{}],
    "walk": [gait(i / 8, False) for i in range(8)],
    "run": [gait(i / 8, True) for i in range(8)],
    # Heavy diagonal cut: coil up to the right, then blade and body drive down to the lower left while the
    # right foot steps in.  Frames 1-2 and 5-6 are near-identical on purpose: the holds are what give it weight.
    "attack": [
        {**legs(L=(-6, 12), R=(6, 10)), "hips": (0, 0, -10), "spine": (-5, 0, -18), "head": FWD,
         "arm.R": aim(-.6, -.2, .5), "forearm.R": aim(-.45, .1, .9), "sword": aim(-.35, .3, .9),
         "arm.L": aim(.35, -.5, -.8), "forearm.L": aim(.1, -.9, -.4)},
        {**legs(L=(-4, 8), R=(12, 14)), "hips": (0, 0, -18), "spine": (-14, 0, -32), "head": FWD,   # full coil
         "arm.R": aim(-.5, .3, .8), "forearm.R": aim(-.3, .6, .75), "sword": aim(-.3, .85, .45),
         "arm.L": aim(.2, -.75, -.6), "forearm.L": aim(-.15, -.95, -.2), "cape": -8},
        {**legs(L=(-4, 8), R=(14, 18)), "hips": (0, 0, -20), "spine": (-17, 0, -36), "head": FWD,   # hold
         "arm.R": aim(-.5, .38, .78), "forearm.R": aim(-.3, .68, .67), "sword": aim(-.3, .93, .25),
         "arm.L": aim(.15, -.8, -.55), "forearm.L": aim(-.2, -.97, -.1), "cape": -10},
        {**legs(L=(10, 10), R=(-40, 55), plant=".L"), "spine": (12, 0, -4), "head": FWD,           # strike
         "arm.R": aim(-.3, -.8, .5), "forearm.R": aim(-.15, -.9, .4), "sword": aim(-.2, -.55, .8),
         "arm.L": aim(.5, -.2, -.85), "forearm.L": aim(.5, .1, -.85), "cape": 20},
        {**legs(L=(28, 22), R=(-52, 62), plant=".L"), "hips": (0, 0, 14), "spine": (34, 0, 26),
         "head": FWD,                                                                               # impact
         "arm.R": aim(.3, -.7, -.65), "forearm.R": aim(.4, -.72, -.56), "sword": aim(.45, -.8, -.4),
         "arm.L": aim(.6, .5, -.6), "forearm.L": aim(.5, .7, -.5), "cape": aim(.3, .6, -.75)},
        {**legs(L=(32, 24), R=(-56, 68), plant=".L"), "hips": (0, 0, 22), "spine": (46, 0, 42),
         "head": look(.25, -1, -.25),                                                               # follow-through
         "arm.R": aim(.7, -.25, -.67), "forearm.R": aim(.8, -.1, -.6), "sword": aim(.85, .15, -.5),
         "arm.L": aim(.5, .75, -.4), "forearm.L": aim(.4, .85, -.3), "cape": aim(.35, .45, -.82)},
        {**legs(L=(32, 24), R=(-56, 68), plant=".L"), "hips": (0, 0, 20), "spine": (42, 0, 38),
         "head": look(.2, -1, -.2),                                                                 # settle
         "arm.R": aim(.68, -.2, -.7), "forearm.R": aim(.78, -.05, -.62), "sword": aim(.8, .25, -.55),
         "arm.L": aim(.5, .7, -.5), "forearm.L": aim(.4, .8, -.45), "cape": aim(.3, .3, -.9)},
        {**legs(L=(12, 12), R=(-25, 32), plant=".L"), "hips": (0, 0, 8), "spine": (16, 0, 14), "head": FWD,
         "arm.R": aim(.2, -.35, -.9), "forearm.R": aim(.2, -.55, -.8), "sword": aim(.15, -.72, -.68),
         "arm.L": aim(.3, .2, -.93), "cape": 6},                                                     # recover
    ],
    # Fencing lunge: profile stance with the sword arm drawn back, then a long step onto the right foot with
    # the rear leg straight and shoulder, arm and blade in one line.
    "thrust": [
        {**legs(L=(20, 26), R=(-45, 50), plant=".L"), "hips": (0, 0, 12), "spine": (4, 0, 30), "head": FWD,   # en garde
         "arm.R": aim(-.3, .5, -.8), "forearm.R": aim(-.1, -.9, -.3), "sword": aim(0, -1, .1),
         "arm.L": aim(.45, .75, .2), "forearm.L": aim(.2, .45, .87), "cape": 5},
        {**legs(L=(22, 30), R=(-50, 54), plant=".L"), "hips": (0, 0, 14), "spine": (0, 0, 36), "head": FWD,   # coil
         "arm.R": aim(-.3, .6, -.72), "forearm.R": aim(-.1, -.92, -.1), "sword": aim(0, -1, .08),
         "arm.L": aim(.4, .8, .3), "forearm.L": aim(.15, .4, .9)},
        {**legs(L=(38, 8), R=(-62, 40), plant=".L"), "hips": (0, 0, 12), "spine": (10, 0, 42), "head": FWD,   # front foot flies
         "arm.R": aim(-.15, -.9, -.35), "forearm.R": aim(-.05, -1, -.05), "sword": aim(0, -1, .04),
         "arm.L": aim(.4, .85, -.1), "forearm.L": aim(.3, .9, .1), "cape": 25},
        {**legs(L=(52, 0), R=(-72, 72), plant=".L"), "hips": (0, 0, 10), "spine": (18, 0, 48), "head": FWD,   # full lunge
         "arm.R": aim(-.04, -1, 0), "forearm.R": aim(0, -1, .02), "sword": aim(0, -1, .02),
         "arm.L": aim(.3, .85, -.45), "forearm.L": aim(.25, .9, -.4), "cape": aim(.2, .9, -.4)},
        {**legs(L=(54, 0), R=(-74, 74), plant=".L"), "hips": (0, 0, 10), "spine": (22, 0, 50), "head": FWD,   # hold
         "arm.R": aim(-.04, -1, -.02), "forearm.R": aim(0, -1, 0), "sword": aim(0, -1, 0),
         "arm.L": aim(.3, .85, -.5), "forearm.L": aim(.25, .9, -.45), "cape": aim(.2, .8, -.6)},
        {**legs(L=(24, 28), R=(-48, 52), plant=".L"), "hips": (0, 0, 12), "spine": (6, 0, 32), "head": FWD,   # back to guard
         "arm.R": aim(-.25, .3, -.9), "forearm.R": aim(-.1, -.9, -.1), "sword": aim(0, -1, .15),
         "arm.L": aim(.45, .7, 0), "forearm.L": aim(.3, .6, .6), "cape": 10},
        {**legs(L=(10, 12), R=(-20, 24), plant=".L"), "hips": (0, 0, 5), "spine": (3, 0, 12), "head": FWD,
         "arm.R": aim(-.2, -.05, -.98), "forearm.R": aim(-.12, -.6, -.79), "sword": aim(-.2, -.72, -.66)},
    ],
    "spin": [
        # coil to the right, then a full turn to the left with the blade held out level
        {**crouch(.55), "hips": (0, 0, -50), "spine": (10, 0, -25), "head": (-6, 0, 40),
         "arm.R": (20, 55, 0), "arm.L": (-40, -20, 0), "forearm.L": -40},
        *[{**SPIN, "hips": (0, 0, a)} for a in (20, 90, 160, 230, 300, 360)],
        {**crouch(.2), "spine": (5, 0, 12), "head": (-4, 0, -10), "arm.R": (0, 30, 0), "arm.L": (0, -15, 0),
         "cape": (10, -5, 0)},
    ],
    "jump": [  # the height is baked into the frames ("lift"); the shadow stays on the ground
        {**crouch(.6), "spine": 12, "head": -8, "arm.L": 30, "forearm.R": -25, "sword": -15},
        {**crouch(1), "spine": 20, "head": -12, "arm.L": 45, "forearm.R": -35, "sword": -20, "cape": -5},
        {**lr(foot=35), "lift": .07, "spine": -4, "arm.L": -70, "forearm.L": -20, "arm.R": -25, "cape": -8},  # push-off
        {**lr(thigh=-25, shin=50), "lift": .25, "arm.L": -110, "forearm.L": -20, "arm.R": -40, "cape": 8},
        {**lr(thigh=-45, shin=80, foot=10), "lift": .36, "spine": 5, "arm.L": -120, "forearm.L": -25,
         "arm.R": -50, "cape": 25},                                                                            # apex
        {**lr(thigh=-22, shin=35), "lift": .26, "arm.L": -95, "forearm.L": -15, "arm.R": -35, "cape": 50},    # falling
        {**crouch(.9), "spine": 18, "head": -10, "arm.L": 10, "forearm.R": -35, "sword": -20, "cape": 30},                         # landing
        {**crouch(.3), "spine": 6, "head": -4, "forearm.R": -15, "sword": -8, "cape": 8},
    ],
    # Dodge roll: dive, tuck and go once around, head over heels.  The game moves the sprite along.
    "roll": [
        {**crouch(.9), "hips": (25, 0, 0), "spine": 30, "head": 15, "arm.L": -50, "forearm.L": -40, "arm.R": -30,
         "forearm.R": -30, "ground": True},
        *[{**TUCK, "hips": (a, 0, 0), "ground": "centre"} for a in (70, 130, 190, 250, 310)],
        {**crouch(.9), "spine": 26, "head": -6, "arm.L": 20, "arm.R": 10, "forearm.R": -30, "sword": -15},
        {**crouch(.35), "spine": 8, "forearm.R": -15, "sword": -8},
    ],
    # Parry: the blade snaps up across the body with the off hand braced behind it
    "parry": [
        {**crouch(.25), "spine": (-2, 0, -8), "head": FWD,
         "arm.R": aim(-.5, -.7, .2), "forearm.R": aim(-.25, -.7, .65), "sword": aim(.3, -.45, .85),
         "arm.L": aim(.35, -.7, -.2), "forearm.L": aim(.1, -.8, .5)},
        {**crouch(.4), "spine": (-4, 0, -14), "head": FWD,
         "arm.R": aim(-.45, -.6, .66), "forearm.R": aim(-.12, -.55, .82), "sword": aim(.55, -.3, .78),
         "arm.L": aim(.4, -.65, .25), "forearm.L": aim(.1, -.6, .79)},
        {**crouch(.5), "spine": (-8, 0, -14), "head": FWD,                                              # braced
         "arm.R": aim(-.45, -.55, .7), "forearm.R": aim(-.12, -.5, .86), "sword": aim(.58, -.22, .78),
         "arm.L": aim(.4, -.6, .3), "forearm.L": aim(.1, -.55, .83)},
        {**crouch(.45), "spine": (-6, 0, -14), "head": FWD,
         "arm.R": aim(-.45, -.58, .68), "forearm.R": aim(-.12, -.52, .84), "sword": aim(.56, -.26, .78),
         "arm.L": aim(.4, -.62, .28), "forearm.L": aim(.1, -.57, .81)},
        {**crouch(.2), "spine": (-2, 0, -5), "head": FWD,
         "arm.R": aim(-.35, -.55, -.76), "forearm.R": aim(-.2, -.8, -.56), "sword": aim(0, -.8, .6), "arm.L": aim(.3, -.3, -.9)},
    ],
    # Picking something up off the floor (played again to set it down): crouch, reach with the free hand, rise
    "pickup": [
        {**crouch(.45), "spine": 18, "head": 6, "forearm.R": -25, "sword": -15, "arm.L": aim(.3, -.5, -.8)},
        {**crouch(.95), "spine": 38, "head": 10, "forearm.R": -40, "sword": -25, "arm.L": aim(.2, -.6, -.78), "forearm.L": aim(.12, -.65, -.75)},
        {**crouch(1.15), "spine": 50, "head": 12, "forearm.R": -45, "sword": -30, "arm.L": aim(.15, -.5, -.85), "forearm.L": aim(.08, -.55, -.83)},  # hand on it
        {**crouch(.95), "spine": 36, "head": 8, "forearm.R": -40, "sword": -25, "arm.L": aim(.2, -.6, -.6), "forearm.L": aim(.1, -.8, -.2)},
        {**crouch(.45), "spine": 16, "head": 2, "forearm.R": -25, "sword": -15, "arm.L": aim(.25, -.6, -.4), "forearm.L": aim(.1, -.7, .3)},
        {**crouch(.15), "spine": 5, "forearm.R": -10, "sword": -5, "arm.L": aim(.3, -.4, -.7), "forearm.L": aim(.15, -.7, 0)},
    ],
    # Hands on a block, leaning into it and walking: pushing.  Played backwards while stepping back it is pulling.
    "push": [{**gait(i / 8, False), "spine": (24, 0, 0), "head": FWD, "hips": (4, 0, 0),
              "arm.L": aim(.3, -.92, -.05), "forearm.L": aim(.08, -1, .05), "arm.R": aim(-.3, -.92, -.05), "forearm.R": aim(-.08, -1, .05),
              "sword": aim(-.55, -.25, .8), "cape": 10} for i in range(8)],
    # Death: staggers, drops to his knees and falls on his face with the sword arm thrown out ahead.
    # The last frame is the one that stays.
    "death": [
        {**legs(L=(-8, 14), R=(10, 8)), "hips": (-6, 0, 0), "spine": (-14, 0, -6), "head": (-12, 0, 8),
         "arm.R": 14, "forearm.R": -18, "arm.L": (10, -22, 0), "forearm.L": -25, "cape": -6},
        {**crouch(.75), "hips": (6, 0, 0), "spine": 14, "head": 10,
         "arm.R": aim(-.25, -.5, -.83), "forearm.R": aim(-.15, -.75, -.64), "sword": aim(-.1, -.9, -.42),
         "arm.L": (5, -18, 0), "forearm.L": -20},
        {**legs(L=(-25, 115), R=(-25, 115)), "fwd": .02, "hips": (22, 0, 0), "spine": 20, "head": 14,       # on his knees
         "arm.R": aim(-.15, -.8, -.58), "forearm.R": aim(-.08, -.9, -.42), "sword": aim(0, -.97, -.24),
         "arm.L": aim(.35, -.45, -.82), "cape": 20},
        {**lr(thigh=-35, shin=75, foot=-20), "fwd": .04, "hips": (50, 0, 0), "spine": 16, "head": 6, "ground": True,
         "arm.R": aim(-.1, -.93, -.36), "forearm.R": aim(-.05, -.97, -.24), "sword": aim(0, -1, -.12),
         "arm.L": aim(.4, -.7, -.6), "forearm.L": aim(.3, -.85, -.43), "cape": 30},
        {**lr(thigh=-22, shin=38, foot=10), "fwd": .05, "hips": (72, 0, 0), "spine": 10, "head": (-8, 0, 10), "ground": True,
         "arm.R": aim(-.08, -.98, -.18), "forearm.R": aim(-.04, -1, -.1), "sword": aim(0, -1, -.05),
         "arm.L": aim(.45, -.8, -.4), "forearm.L": aim(.35, -.9, -.25), "cape": 20},
        {**lr(thigh=-4, shin=8, foot=30), "fwd": .06, "hips": (88, 0, 0), "spine": 4, "head": (-14, 0, 22), "ground": True,
         "arm.R": aim(-.06, -1, -.04), "forearm.R": aim(-.02, -1, -.02), "sword": aim(0, -1, 0),            # hits the floor
         "arm.L": aim(.5, -.85, -.1), "forearm.L": aim(.2, -.97, -.05), "cape": 6},
        {**lr(thigh=-8, shin=14, foot=30), "fwd": .06, "hips": (83, 0, 0), "spine": 7, "head": (-18, 0, 22), "ground": True,
         "arm.R": aim(-.06, -1, .0), "forearm.R": aim(-.02, -1, .02), "sword": aim(0, -1, .03),              # small bounce
         "arm.L": aim(.5, -.85, -.06), "forearm.L": aim(.2, -.97, -.02), "cape": 12},
        {**lr(thigh=-4, shin=8, foot=30), "fwd": .06, "hips": (88, 0, 0), "spine": 4, "head": (-6, 0, 28), "ground": True,
         "arm.R": aim(-.06, -1, -.04), "forearm.R": aim(-.02, -1, -.02), "sword": aim(0, -1, 0),
         "arm.L": aim(.5, -.85, -.1), "forearm.L": aim(.2, -.97, -.05), "cape": 4},
    ],
}
MS = {"idle": [500], "walk": [100] * 8, "run": [70] * 8, "spin": [60] * 8, "jump": [80] * 8,  # ms per frame
      "attack": [70, 90, 120, 45, 45, 130, 110, 80],  # slow coil, fast strike, long follow-through
      "thrust": [80, 110, 40, 45, 140, 80, 70],
      "roll": [50, 55, 55, 55, 55, 55, 70, 70], "parry": [50, 90, 110, 110, 90],
      "death": [90, 100, 110, 90, 80, 90, 130, 500],
      "pickup": [70, 80, 110, 80, 70, 60], "push": [110] * 8}
assert all(len(MS[a]) == len(ANIMS[a]) for a in ANIMS)

# Poses flagged "ground" leave the feet (the roll, the fall): the body is dropped until its lowest point rests
# on z=0, and with "centre" also slid along Y so it stays over the origin.  The sword doesn't count as body.
sword = body.vertex_groups["sword"].index
is_body = np.array([not any(g.group == sword and g.weight > .5 for g in v.groups) for v in body.data.vertices])
for poses in ANIMS.values():
    for p in poses:
        if p.get("ground"):
            apply(p)
            pts = world_verts()[is_body]
            p["lift"] = p.get("lift", 0) - pts[:, 2].min()
            if p["ground"] == "centre":
                p["fwd"] = p.get("fwd", 0) + (pts[:, 1].min() + pts[:, 1].max()) / 2

def posed_points():
    for anim, poses in ANIMS.items():
        for f, p in enumerate(poses):
            apply(p)
            pts = world_verts()
            if pts[:, 2].min() < -0.02 and not p.get("ground"):
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

meta = {"dirs": DIRS, "anims": {k: len(v) for k, v in ANIMS.items()}, "ms": MS, "size": size,
        "passes": PASSES, "ppu": PPU, "elevation_deg": math.degrees(iso.ELEV),
        # where the turntable axis touches the ground, in sprite pixels (x, y from top)
        "anchor": [size / 2, size / 2 + yc * PPU],
        # ground covered by one cycle, in sprite pixels: move this far per cycle and the feet don't slide
        "stride": {"walk": 4 * LEG * math.sin(math.radians(SWING)) * PPU, "run": RUN_STRIDE * PPU}}
json.dump(meta, open(os.path.join(outdir, "meta.json"), "w"))
print("META", json.dumps(meta))
