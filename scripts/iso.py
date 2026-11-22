"""Shared by the Blender render scripts: the true-isometric orthographic camera, the fixed light, the sprite
framing, and a render call that can also write a normal-map pass and an emissive pass."""
import bpy, math
import numpy as np
from mathutils import Vector

ELEV = math.atan(1 / math.sqrt(2))  # 35.2644 deg = true isometric. 2:1 "game iso" is math.radians(30).
PHI = math.pi / 2 - ELEV            # camera tilt from straight down = 54.7356 deg
DIRS = ["S", "SE", "E", "NE", "N", "NW", "W", "SW"]  # i * 45 deg about Z; S = facing the camera
UP = Vector((0, math.cos(PHI), math.sin(PHI)))        # screen-up in world space
VIEW = Vector((0, math.sin(PHI), -math.cos(PHI)))     # the direction the camera looks


def fit(point_sets, ppu):
    """Square frame that holds every pose in all 8 turntable rotations, so scale and anchor are identical in
    every sprite.  Returns (size in px, yc): yc is how far above the origin, along screen-up, its centre sits."""
    halfw, ys = 0.0, []
    for pts in point_sets:
        for i in range(8):
            c, s = math.cos(i * math.pi / 4), math.sin(i * math.pi / 4)
            x = pts[:, 0] * c - pts[:, 1] * s
            y = pts[:, 0] * s + pts[:, 1] * c
            v = y * math.cos(PHI) + pts[:, 2] * math.sin(PHI)  # screen-up coordinate
            halfw = max(halfw, np.abs(x).max())
            ys += [v.min(), v.max()]
    size = 2 * math.ceil(max(2 * halfw, max(ys) - min(ys)) * ppu / 2) + 4  # even, +2px margin for the outline
    return size, (min(ys) + max(ys)) / 2


def setup(scene, width, height, ppu, ss, centre=(0, 0, 0), sun=3.0, ambient=0.45):
    """Camera framing width x height sprite pixels (ppu px per world unit, rendered ss times larger) centred on
    the world point `centre`, a key light from the screen upper-left (pixel-art convention) and flat ambient."""
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = max(width, height) / ppu
    cam.rotation_euler = (PHI, 0, 0)
    cam.location = Vector(centre) - VIEW * 20
    light = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    scene.collection.objects.link(light)
    light.rotation_euler = (math.radians(50), 0, math.radians(-40))
    light.data.energy = sun
    world = bpy.data.worlds.new("w")
    scene.world = world
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (1, 1, 1, 1)
    bg.inputs[1].default_value = ambient
    r = scene.render
    r.engine = "BLENDER_EEVEE"
    r.film_transparent = True
    r.resolution_x, r.resolution_y = width * ss, height * ss
    r.resolution_percentage = 100
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"  # keep texture colours, no filmic desaturation


def material(name, color, glow=False):
    """Rough stone-like material, or with glow=True a flat emissive one that the "e" pass keeps."""
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    if glow:
        sh = nt.nodes.new("ShaderNodeEmission")
        sh.inputs["Color"].default_value = (*color, 1)
        m["glow"] = color
    else:
        sh = nt.nodes.new("ShaderNodeBsdfPrincipled")
        sh.inputs["Base Color"].default_value = (*color, 1)
        sh.inputs["Roughness"].default_value = 0.85
    nt.links.new(sh.outputs[0], out.inputs["Surface"])
    return m


_pass_materials = {}


def _pass_material(src, kind):
    """Emission-only stand-in for `src`.  kind "n": the colour is the camera-space shading normal packed into
    0..1 (x right, y up, z towards the viewer), keeping the detail of src's normal-map texture if it has one.
    kind "e": src["glow"] if the material has that custom property, black otherwise."""
    key = (src.name, kind)
    if key in _pass_materials:
        return _pass_materials[key]
    m = _pass_materials[key] = bpy.data.materials.new(f"{src.name}_{kind}")
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    if kind == "e":
        em.inputs["Color"].default_value = (*src.get("glow", (0, 0, 0)), 1)
        return m
    bump = next((n for n in src.node_tree.nodes if n.type == "NORMAL_MAP" and n.inputs["Color"].links), None)
    if bump:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = bump.inputs["Color"].links[0].from_node.image
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
        normal = nm.outputs["Normal"]
    else:
        normal = nt.nodes.new("ShaderNodeNewGeometry").outputs["Normal"]
    to_cam = nt.nodes.new("ShaderNodeVectorTransform")
    to_cam.vector_type, to_cam.convert_from, to_cam.convert_to = "NORMAL", "WORLD", "CAMERA"
    pack = nt.nodes.new("ShaderNodeVectorMath")
    pack.operation = "MULTIPLY_ADD"
    pack.inputs[1].default_value = NORMAL_SCALE
    pack.inputs[2].default_value = (.5, .5, .5)
    nt.links.new(normal, to_cam.inputs[0])
    nt.links.new(to_cam.outputs[0], pack.inputs[0])
    nt.links.new(pack.outputs[0], em.inputs["Color"])
    return m


NORMAL_SCALE = (.5, .5, -.5)  # Blender's shader camera space has +Z pointing away from the viewer; flip it


def render(scene, path, passes=""):
    """Render path.png.  For each letter in passes also render path_<letter>.png with every material swapped:
    "n" = normal map, "e" = emissive parts only (black elsewhere, so it can be drawn additively)."""
    scene.render.filepath = path + ".png"
    bpy.ops.render.render(write_still=True)
    slots = [s for o in scene.objects if o.type == "MESH" for s in o.material_slots]
    for kind in passes:
        original = [s.material for s in slots]
        for s in slots:
            s.material = _pass_material(s.material, kind)
        dither = scene.render.dither_intensity
        if kind == "n":  # write the numbers as they are: no display curve, no dither noise
            scene.view_settings.view_transform, scene.render.dither_intensity = "Raw", 0
        scene.render.filepath = f"{path}_{kind}.png"
        bpy.ops.render.render(write_still=True)
        scene.view_settings.view_transform, scene.render.dither_intensity = "Standard", dither
        for s, mat in zip(slots, original):
            s.material = mat
