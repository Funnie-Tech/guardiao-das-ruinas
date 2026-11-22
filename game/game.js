// Guardião das Ruínas: an isometric level of dark ruins ending in a boss.  Phaser 3 draws the lit world; menus,
// HUD and dialogue are DOM.
const json = n => fetch(`assets/${n}.json`).then(r => r.json());
const [HERO, GOLEM, MINION, ROOM] = await Promise.all(['hero', 'golem', 'minion', 'room'].map(json));
await document.fonts.load('800 20px Inter').catch(() => {});
const $ = id => document.getElementById(id);
const W = 960, H = 540, RATIO = ROOM.ratio, [HW, HH] = ROOM.cell;  // HW, HH: half a floor tile on screen
let CX = 0, CY = 0;  // the pixel of the current room's grid centre (rooms are larger than the screen; the camera follows the hero)
const fit = () => $('frame').style.setProperty('--s', Math.min(innerWidth / W, innerHeight / H));
addEventListener('resize', fit); fit();
// The loading screen: one stone block per tenth of the files, laid as they arrive
const BLOCK = '<svg viewBox="0 0 40 44"><polygon class="l" points="2,11 20,20 20,42 2,33"/><polygon class="r" points="38,11 20,20 20,42 38,33"/><polygon class="t" points="20,2 38,11 20,20 2,11"/></svg>';
$('stones').innerHTML = BLOCK.repeat(10);
function loading(v) {  // v: 0..1
  [...$('stones').children].forEach((b, i) => b.classList.toggle('on', v * 10 >= i + 1 - 1e-6));
  $('loadText').textContent = `Erguendo as ruínas  ${Math.round(v * 100)}%`;
}
loading(0);

// ---------------------------------------------------------------- the level
// Seven rooms, each built from its own tile map (assets/room.json, made by scripts/render_rooms.py).  Doors sit on
// the four diagonal sides of the grid; the way through goes up-right, down-right, up-right, up-left, up-left and
// down-left to the golem:   start -NE-> hall -SE-> runes -NE-> crypt -NW-> plates -NW-> gallery -SW-> arena
// Positions are tile cells [i, j].  foes: [kind, i, j].  items: potions lying in the room.  drop: the potion that
// appears when the room is beaten.  exit: the door a puzzle keeps shut (the way back stays open).
const LEVEL = {
  start: { links: { NE: 'hall' }, spawn: [1, 3], items: [['mp', 4, 1]], note: 'A estocada (J) dispara um raio e gasta mana. Poções azuis repõem. Porta aberta: seta dourada. Trancada: grade vermelha.' },
  hall: { links: { SW: 'start', SE: 'runes' }, foes: [['minion', 8, 2], ['minion', 12, 4], ['minion', 6, 5], ['minion', 11, 1]], drop: ['hp', 7, 3] },
  runes: { links: { NW: 'hall', NE: 'crypt' }, exit: 'NE', puzzle: 'R', drop: ['mp', 4, 2], note: 'As pedras voltam cada uma ao encaixe com o seu símbolo. E pega e coloca.' },
  crypt: { links: { SW: 'runes', NW: 'plates' }, foes: [['minion', 9, 1], ['minion', 6, 4], ['minion', 3, 7], ['wisp', 10, 4], ['wisp', 4, 5]],
           items: [['mp', 11, 0]], drop: ['hp', 5, 2] },
  plates: { links: { SE: 'crypt', NW: 'gallery' }, exit: 'NW', puzzle: 'L', drop: ['hp', 4, 2], note: 'Duas placas precisam de peso ao mesmo tempo. E agarra o bloco para empurrar ou puxar.' },
  gallery: { links: { SE: 'plates', SW: 'arena' }, foes: [['minion', 8, 3], ['minion', 9, 6], ['wisp', 1, 2], ['wisp', 10, 4], ['wisp', 6, 7]],
             items: [['hp', 11, 7]], drop: ['mp', 8, 4] },
  arena: { links: { NE: 'gallery' }, boss: true, spawn: [7, 3], items: [['mp', 2, 3], ['mp', 7, 7], ['hp', 5, 2]] },
};
const STEP = { NE: [1, 0], NW: [0, 1], SW: [-1, 0], SE: [0, -1] }, ALONG = { NE: [0, 1], SW: [0, 1], NW: [1, 0], SE: [1, 0] }, BACK = { NE: 'SW', SW: 'NE', NW: 'SE', SE: 'NW' };
const SCATTER = [[7, 7], [1, 7], [7, 1], [1, 1]];  // where the blast throws each rune stone: the corner farthest from its own socket
const SOLID = ' PSACXTOW';  // map letters nobody can stand on (see the legend in render_rooms.py)

let S, state = 'menu', screen = 'loading', paused = false, freeze = 0, talk = null, back = [];
let hint, hero, golem, music, fires, coreLight, heroLight, chargeLight, chargeGlow, sparks, chips, dust, fire, motes;
let room = 'start', prog = {}, checkpoint = null, bossOn = false, puzzle = null, scenery = [];
const foes = [], items = [], bolts = [], shots = [], waves = [], eruptions = [], gates = [];

// ---------------------------------------------------------------- settings, input
const vol = { music: .6, sfx: .8 };
try { Object.assign(vol, JSON.parse(localStorage.getItem('ruinas-vol') || '{}')); } catch { /* storage blocked: defaults */ }
const keys = new Set(), hit = new Set();  // held keys, and keys pressed since the last frame
addEventListener('keydown', e => {
  // in a menu Up/Down move the focus (not the slider); in play the arrows and Space must not scroll or click
  if (screen ? /ArrowUp|ArrowDown/.test(e.code) : /^Arrow|Space/.test(e.code)) e.preventDefault();
  if (!e.repeat) hit.add(e.code);
  keys.add(e.code);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const pad = { x: 0, y: 0, down: new Set(), pressed: new Set(), nav: 0 };
function readInput(dt) {
  // Standard-mapping gamepad: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 7 RT, 9 Start, 12-15 d-pad, axes 0/1 left stick
  const gp = [...navigator.getGamepads()].find(g => g && g.connected), prev = pad.down;
  pad.down = new Set(); pad.x = pad.y = 0;
  if (gp) {
    gp.buttons.forEach((b, i) => b.pressed && pad.down.add(i));
    if (Math.hypot(gp.axes[0], gp.axes[1]) > .25) { pad.x = gp.axes[0]; pad.y = gp.axes[1]; }
    if (pad.down.has(14)) pad.x = -1; if (pad.down.has(15)) pad.x = 1;
    if (pad.down.has(12)) pad.y = -1; if (pad.down.has(13)) pad.y = 1;
  }
  pad.pressed = new Set([...pad.down].filter(i => !prev.has(i)));
  const k = (...c) => c.some(x => keys.has(x)), p = (...c) => c.some(x => hit.has(x)), b = (...n) => n.some(i => pad.pressed.has(i));
  let x = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'), y = k('KeyS', 'ArrowDown') - k('KeyW', 'ArrowUp'), mag = x || y ? 1 : 0;
  if (!mag && (pad.x || pad.y)) { x = pad.x; y = pad.y; mag = Math.min(1, Math.hypot(x, y)); }  // a light push on the stick walks
  // Menu navigation from the stick or d-pad: one step per push, repeating while held
  const sx = Math.round(pad.x), sy = Math.round(pad.y);
  pad.nav = sx || sy ? pad.nav - dt : 0;
  const step = (sx || sy) && pad.nav <= 0;
  if (step) pad.nav = 170;
  const inp = { x, y, mag, thrust: p('KeyJ') || b(2), held: k('KeyJ') || pad.down.has(2), heavy: p('KeyK') || b(3), spin: p('KeyL') || b(5),
                jump: p('Space') || b(0), use: p('KeyE') || b(7), roll: p('ShiftLeft', 'ShiftRight') || b(1), parry: p('KeyQ') || b(4), pause: p('Escape') || b(9),
                ok: p('Enter', 'Space', 'KeyJ') || b(0), padOk: b(0), back: p('Backspace') || b(1),
                navY: p('ArrowDown') - p('ArrowUp') || (step ? sy : 0), navX: step ? sx : 0 };
  hit.clear();
  return inp;
}

// ---------------------------------------------------------------- lighting
// Phaser's Light2D keeps every light almost in the screen plane, which lights an isometric floor on one side
// only.  This variant treats each pixel as a point on the ground and the light as LIGHT_H px above its own
// ground point, so the camera-space direction is exact for the floor (round pools of light, drawn as ellipses)
// and a fair approximation for the upright sprites.  Light x/y are therefore GROUND positions.
const LIGHT_FS = `
#define SHADER_NAME ISO_LIGHT_FS
precision mediump float;
struct Light { vec2 position; vec3 color; float intensity; float radius; };
const int kMaxLights = %LIGHT_COUNT%;
const float LIGHT_H = 42.0;
uniform sampler2D uMainSampler;
uniform sampler2D uNormSampler;
uniform vec3 uAmbientLightColor;
uniform Light uLights[kMaxLights];
uniform mat3 uInverseRotationMatrix;
uniform int uLightCount;
varying vec2 outTexCoord;
varying float outTintEffect;
varying vec4 outTint;
void main () {
  vec4 texel = vec4(outTint.bgr * outTint.a, outTint.a);
  vec4 tex = texture2D(uMainSampler, outTexCoord);
  vec4 color = tex * texel;
  if (outTintEffect == 1.0) color.rgb = mix(tex.rgb, outTint.bgr * outTint.a, tex.a);
  vec3 normal = normalize(uInverseRotationMatrix * (texture2D(uNormSampler, outTexCoord).rgb * 2.0 - 1.0));
  vec3 lit = uAmbientLightColor;
  for (int i = 0; i < kMaxLights; ++i) {
    if (i < uLightCount) {
      Light light = uLights[i];
      vec2 d = light.position - gl_FragCoord.xy;  // screen px, y up
      // true isometric: 1 px up the screen on the ground is sqrt(3) px of depth
      vec3 dir = vec3(d.x, d.y + 0.8165 * LIGHT_H, -1.4142 * d.y + 0.5774 * LIGHT_H);
      float dist2 = d.x * d.x + 3.0 * d.y * d.y + LIGHT_H * LIGHT_H;
      float att = clamp(1.0 - dist2 / (light.radius * light.radius), 0.0, 1.0);
      lit += light.color * (max(dot(normal, normalize(dir)), 0.0) * att * att * light.intensity);
    }
  }
  gl_FragColor = vec4(color.rgb * lit, color.a);
}`;
class IsoLight extends Phaser.Renderer.WebGL.Pipelines.LightPipeline {
  constructor(game) { super({ game, name: 'IsoLight', fragShader: LIGHT_FS }); }
}

// ---------------------------------------------------------------- helpers
const total = (M, a) => M.ms[a].reduce((s, v) => s + v, 0);
// frame shown t ms into an animation, or -1 once it has ended
function frameAt(M, a, t) { for (let i = 0; i < M.ms[a].length; i++) { t -= M.ms[a][i]; if (t < 0) return i; } return -1; }
// Positions are screen px of the feet.  Depth on screen is squashed by RATIO, so distances and angles are
// measured on the ground: ang 0 = east, +90 deg = south (towards the camera).
const gd = (a, b) => Math.hypot(b.x - a.x, (b.y - a.y) / RATIO);
const ang = (a, b) => Math.atan2((b.y - a.y) / RATIO, b.x - a.x);
const faceOf = an => ((Math.round((Math.PI / 2 - an) / (Math.PI / 4)) % 8) + 8) % 8;  // -> row of the sprite sheet (S, SE, E, ...)
const angOf = dir => Math.PI / 2 - dir * Math.PI / 4;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const ahead = (a, d, an = angOf(a.dir)) => ({ x: a.x + Math.cos(an) * d, y: a.y + Math.sin(an) * d * RATIO });
const tilt = an => Math.atan2(Math.sin(an) * RATIO, Math.cos(an));  // a ground angle as drawn on screen
// The floor grid: cell (i, j) of the current room <-> the screen
const spot = (i, j) => { const [cu, cv] = ROOM.rooms[room].grid; return { x: CX + (i - j - cu) * HW, y: CY - (i + j - cv) * HH }; };
function ok(x, y) {  // is there floor here?
  const [cu, cv] = ROOM.rooms[room].grid, u = (x - CX) / HW + cu, v = (CY - y) / HH + cv;
  const ch = ROOM.rooms[room].map[Math.round((v - u) / 2)]?.[Math.round((u + v) / 2)];
  return ch !== undefined && !SOLID.includes(ch);
}
// Room for a body, not just a point.  The body is a small square aligned with the floor grid, so its sides run
// parallel to the walls and it slides along them instead of catching.
const BODY = .24;  // half its side, in tiles
const free = (x, y) => ok(x, y) && [[1, -1], [-1, 1], [1, 1], [-1, -1]].every(([sx, sy]) => ok(x + sx * BODY * HW, y + sy * BODY * HH));
const AXES = [[HW, -HH], [HW, HH]].map(([x, y]) => [x / Math.hypot(x, y), y / Math.hypot(x, y)]);  // the two directions walls run in, on screen
function keepIn(a) {  // walls and furniture stop a mover, but never hold it: it slides along a wall and slips round a corner
  if (free(a.x, a.y)) { a.px = a.x; a.py = a.y; return false; }
  a.px ??= hero.x; a.py ??= hero.y;
  const dx = a.x - a.px, dy = a.y - a.py, step = Math.hypot(dx, dy);
  let to = null;
  for (const [ux, uy] of AXES) {  // keep whatever part of the step runs along a wall
    const t = dx * ux + dy * uy, x = a.px + ux * t, y = a.py + uy * t;
    if (!to && Math.abs(t) > .05 && free(x, y)) to = [x, y];
  }
  for (const side of [1, -1]) {  // head-on against a corner: step sideways if that clears it
    const x = a.px - dy * side, y = a.py + dx * side;
    if (!to && step > .05 && free(x, y) && free(x + dx, y + dy)) to = [x, y];
  }
  [a.x, a.y] = to || [a.px, a.py];
  a.px = a.x; a.py = a.y;
  return true;
}
// the middle of a door (two tiles wide), k tiles out from the floor's edge; name must be the current room
const doorAt = (side, k = .3) => { const [i, j] = ROOM.rooms[room].doors[side]; return spot(i + ALONG[side][0] / 2 + STEP[side][0] * k, j + ALONG[side][1] / 2 + STEP[side][1] * k); };
function slide(a, dt) {  // knockback: a ground velocity that dies off quickly
  a.x += a.kx * dt / 1000; a.y += a.ky * RATIO * dt / 1000;
  const k = Math.exp(-dt / 110); a.kx *= k; a.ky *= k;
}
function push(a, from, speed) { const an = ang(from, a); a.kx = Math.cos(an) * speed; a.ky = Math.sin(an) * speed; }
const alive = () => foes.filter(f => f.hp > 0);
const nearest = (from, max) => alive().filter(f => gd(from, f) < max).sort((a, b) => gd(from, a) - gd(from, b))[0];

const sfx = (k, v = 1, rate = 1) => music && S.sound.play(k, { volume: vol.sfx * v, rate: rate * (.94 + Math.random() * .12) });
const shake = (ms, amt) => S.cameras.main.shake(ms, amt);
function light(x, y, color, radius, intensity, ms) {  // a flash that fades out
  const l = S.lights.addLight(x, y, radius, color, intensity);
  S.tweens.add({ targets: l, intensity: 0, duration: ms, ease: 'Quad.easeIn', onComplete: () => S.lights.removeLight(l) });
}
function squash(a, sx, sy, ms = 420) {  // squash and stretch from the feet, springing back
  S.tweens.add({ targets: a, sx: { from: sx, to: 1 }, sy: { from: sy, to: 1 }, duration: ms, ease: 'Elastic.easeOut' });
}
function burst(key, x, y, tint, from, to, ms, depth = 2500) {  // one-shot additive sprite that grows and fades
  const s = S.add.image(x, y, key).setBlendMode('ADD').setTint(tint).setDepth(depth).setRotation(from.r ?? 0)
    .setScale(from.sx ?? from.s, from.sy ?? from.s).setAlpha(from.a ?? 1);
  S.tweens.add({ targets: s, scaleX: to.sx ?? to.s, scaleY: to.sy ?? to.s, alpha: 0, duration: ms, ease: 'Quad.easeOut', onComplete: () => s.destroy() });
}
const ring = (x, y, tint, r0, r1, ms) =>  // a circle lying on the ground; the ring texture is 120 px in radius
  burst('ring', x, y, tint, { sx: r0 / 120, sy: r0 / 120 * RATIO }, { sx: r1 / 120, sy: r1 / 120 * RATIO }, ms, 6);
const disc = (x, y, tint, r, depth = 2) =>  // a soft glow lying on the ground (the glow texture is 64 px in radius)
  S.add.image(x, y, 'glow').setBlendMode('ADD').setTint(tint).setDepth(depth).setScale(r / 64, r / 64 * RATIO);
function number(x, y, n, color) {  // damage number: pops in with a bounce, drifts up, fades
  const t = S.add.text(x, y, n, { fontFamily: 'Inter', fontSize: 24, fontStyle: '800', color, stroke: '#0a0816', strokeThickness: 5 })
    .setOrigin(.5).setDepth(3000).setScale(.3);
  S.tweens.add({ targets: t, scale: 1, y: y - 34, duration: 320, ease: 'Back.easeOut' });
  S.tweens.add({ targets: t, alpha: 0, y: y - 62, delay: 430, duration: 300, onComplete: () => t.destroy() });
}
function restart(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }  // replay a CSS animation
function bars(shook) {
  for (const [id, v] of [['boss', golem.hp / golem.max], ['hp', hero.hp / hero.max], ['mp', hero.mp / 100]]) {
    for (const i of $(id).querySelectorAll('i')) i.style.width = Math.max(0, v * 100) + '%';
    if (id === shook) restart($(id), 'shake');
  }
}
function note(text) { $('note').hidden = !text; $('note').textContent = text || ''; $('note').classList.remove('thought'); }
function think(text) {  // the hero talking to himself: shown for a few seconds
  note(text); $('note').classList.add('thought');
  S.time.delayedCall(4500, () => $('note').textContent === text && note(''));
}

// ---------------------------------------------------------------- actors (anything drawn from a sprite sheet)
function actor(name, M, hp) {
  const o = [M.anchor[0] / M.w, M.anchor[1] / M.h], a = { name, M, hp, max: hp, sx: 1, sy: 1, kx: 0, ky: 0, white: 0, anim: 'idle', f: 0, t: 0, dir: 0, walked: 0 };
  a.shadow = S.add.image(0, 0, 'shadow').setDepth(3).setScale(name === 'golem' ? 2.4 : name === 'minion' ? 1.3 : 1);
  a.spr = S.add.sprite(0, 0, name + '_idle').setOrigin(...o).setPipeline('IsoLight');
  if (name !== 'hero') a.glow = S.add.sprite(0, 0, name + '_idle_e').setOrigin(...o).setBlendMode('ADD');  // molten parts ignore the dark
  a.flash = S.add.sprite(0, 0, name + '_idle').setOrigin(...o).setTintFill(0xffffff);                       // white hit flash
  a.parts = [a.shadow, a.spr, a.glow, a.flash].filter(Boolean);
  return a;
}
function draw(a, dt) {
  const n = a.M.anims[a.anim], idx = a.dir * n + Math.max(0, Math.min(n - 1, a.f)), key = `${a.name}_${a.anim}`;
  a.white = Math.max(0, a.white - dt / 110);
  for (const [s, k, z] of [[a.spr, key, 0], [a.glow, key + '_e', .1], [a.flash, key, .2]])
    if (s) s.setTexture(k, idx).setPosition(Math.round(a.x), Math.round(a.y)).setScale(a.sx, a.sy).setDepth(a.y + z);
  a.flash.setAlpha(a.white);
  a.shadow.setPosition(a.x, a.y);
}

// ---------------------------------------------------------------- hero
const RUN = 300, WALK = 140, GAIT = 1.35;  // ground px/s, and how much faster the leg cycle plays than it was rendered
const TEMPO = { thrust: 1.45, attack: 1.3, spin: 1.35, jump: 1.3, roll: 1.3, parry: 1.15, pickup: 1.25 };  // playback speed of each action
const ATK = {  // frames: when the blade can connect.  reach: from the hero to the enemy's edge.  arc: half-angle
  thrust: { dmg: 12, frames: [3, 4], reach: 95, arc: .55, sfx: 'swing_light', stop: 55 },
  attack: { dmg: 30, frames: [4, 5], reach: 82, arc: 1.2, sfx: 'swing_heavy', stop: 130, heavy: true },
  spin: { dmg: 16, frames: [1, 2, 3, 4, 5, 6], reach: 80, arc: 4, sfx: 'swing_spin', stop: 70 },
  charged: { dmg: 36, frames: [1, 2, 3, 4, 5, 6], reach: 118, arc: 4, sfx: 'swing_spin', stop: 150, heavy: true },  // the spin released from a full charge
  bolt: { dmg: 14, stop: 40 },                                                                                      // the thrust's magic
};
const CHARGE_MS = 800, HOLD = 4;  // how long the thrust must be held, and the thrust frame he holds meanwhile (blade out in front)
const BOLT_COST = 10;
function heroTick(dt, inp) {
  const h = hero;
  for (const k of ['inv', 'stun', 'cd', 'rollCd']) h[k] = Math.max(0, h[k] - dt);
  slide(h, dt);
  if (h.stun > 0) { h.anim = 'jump'; h.f = 6; }  // flinch: the crouched landing frame
  else {
    if (h.act === 'charge') charging(dt, inp);
    if (h.act === 'grab') grabbing(dt, inp);
    else if (!h.act && inp.use) interact();  // E: pick up, set down, take hold of the block
    const want = h.act ? null : inp.roll && !h.rollCd ? 'roll' : inp.parry ? 'parry' : inp.thrust ? 'thrust' : inp.heavy ? 'attack'
      : inp.spin && !h.cd ? 'spin' : inp.jump ? 'jump' : null;
    const aimed = inp.mag ? faceOf(Math.atan2(inp.y, inp.x)) : h.dir;
    if (want) {
      Object.assign(h, { act: want, t: 0, last: -1, struck: new Set() });
      if (want === 'spin') h.cd = 1300;
      if (want === 'roll') { h.dir = aimed; sfx('roll', .8); dust.explode(6, h.x, h.y); }  // rolls whichever way is held
      else if (want !== 'jump') { h.target = nearest(h, 300); h.dir = h.target ? faceOf(ang(h, h.target)) : aimed; }  // blade and guard lock on when close
    }
    if (h.act === 'roll') Object.assign(h, ahead(h, (h.f >= 1 && h.f <= 5 ? 560 : 170) * dt / 1000));  // fast through the tumble, slow at both ends
    else if (inp.mag && (!h.act || h.act === 'jump')) {
      const run = inp.mag > .6, d = (run ? RUN : WALK) * dt / 1000, n = Math.hypot(inp.x, inp.y);
      h.x += inp.x / n * d; h.y += inp.y / n * d * RATIO;
      h.dir = aimed; h.walked += dt;
      if (!h.act) { h.anim = run ? 'run' : 'walk'; h.f = Math.floor(h.walked * GAIT / HERO.ms[h.anim][0]) % 8; }
    } else if (!h.act) { h.anim = 'idle'; h.f = 0; h.walked = 0; }
    if (h.act && h.act !== 'charge' && h.act !== 'grab') {
      h.t += dt * TEMPO[h.act];
      const f = frameAt(HERO, h.act, h.t), A = h.power ?? ATK[h.act];
      if (f < 0) { if (h.act === 'roll') h.rollCd = 120; h.act = h.power = null; }
      else {
        h.anim = h.act; h.f = f;
        for (let i = h.last + 1; i <= f; i++) {  // things that happen once, on entering a frame (none skipped on a slow frame)
          if (A && i === A.frames[0]) swing(h.act, A);
          if (h.act === 'jump' && i === 2) { sfx('jump', .8); dust.explode(6, h.x, h.y); }
          if ((h.act === 'jump' || h.act === 'roll') && i === 6) { sfx('land', .8); dust.explode(8, h.x, h.y); squash(h, 1.25, .75); }
          if (h.act === 'jump' && i === 6) landed();
          if (h.act === 'pickup' && i === 2) h.then?.();  // the hand reaches the floor: the thing is taken, or set down
        }
        h.last = f;
        if (A && A.frames.includes(f)) for (const e of alive())  // the blade connects with every enemy in reach, once each
          if (!h.struck.has(e) && gd(h, e) - e.r < A.reach && Math.abs(wrap(ang(h, e) - angOf(h.dir))) < A.arc) { h.struck.add(e); strike(e, A); }
        if (h.act === 'thrust' && f === HOLD && inp.held) {  // still holding at full reach: keep the blade out and start gathering light
          Object.assign(h, { act: 'charge', charge: 0 });
          h.hum.play({ volume: vol.sfx * .45, rate: 1.7 });
        }
      }
    }
  }
  h.air = h.act === 'jump' && h.f >= 2 && h.f <= 5;    // over the shockwave and the swipe
  h.safe = h.act === 'roll' && h.f >= 1 && h.f <= 5;   // the roll passes through everything
  h.guard = h.act === 'parry' && h.t < 300;            // the window in which a blow is turned aside
  for (const e of alive()) if (e.solid && gd(h, e) < e.r + 14) Object.assign(h, ahead(e, e.r + 14, ang(e, h)));  // can't walk through them
  const blk = puzzle?.kind === 'L' && h.act !== 'grab' && prog[room].block;
  if (blk && gd(h, blk) < 36) Object.assign(h, ahead(blk, 36, ang(blk, h)));  // nor through the block: it has to be taken hold of
  keepIn(h);
  h.spr.setAlpha(h.inv > 0 && Math.floor(h.inv / 70) % 2 ? .35 : 1);  // blink while invulnerable
}
function charging(dt, inp) {  // blade held out, drawing light in.  He can walk; letting go when it is full releases the spin
  const h = hero, was = h.charge, full = was >= CHARGE_MS;
  if (inp.mag) {
    const n = Math.hypot(inp.x, inp.y), d = 175 * dt / 1000;
    h.x += inp.x / n * d; h.y += inp.y / n * d * RATIO;
    h.dir = faceOf(Math.atan2(inp.y, inp.x));  // the held pose turns with him
  }
  h.charge += dt;
  const tip = ahead(h, 54);
  if (Math.floor(h.charge / 240) > Math.floor(was / 240)) ring(h.x, h.y - 4, full ? 0xfff0c0 : 0xb9a6ff, 84, 12, 240);  // rings closing in on him
  if (!full && h.charge >= CHARGE_MS) {  // the moment it is ready
    sfx('charge_ready'); squash(h, 1.12, .92, 300); sparks.explode(16, tip.x, tip.y - 30);
    burst('glow', tip.x, tip.y - 30, 0xfff0c0, { s: .4 }, { s: 1.7 }, 260); light(h.x, h.y, 0xfff0c0, 320, 2.6, 300);
  }
  if (full && Math.random() < dt / 60) sparks.explode(1, tip.x, tip.y - 30);
  h.white = (full ? .3 + .18 * Math.sin(h.charge / 45) : .16 * h.charge / CHARGE_MS) + dt / 110;  // the figure brightens, then shimmers
  if (inp.roll && !h.rollCd) { h.hum.stop(); h.act = null; }  // rolling away drops the charge
  else if (!inp.held) {
    h.hum.stop();
    if (full) Object.assign(h, { act: 'spin', t: 0, last: -1, struck: new Set(), power: ATK.charged });
    else Object.assign(h, { act: 'thrust', t: HERO.ms.thrust.slice(0, HOLD + 1).reduce((s, v) => s + v, 0), last: HOLD });  // too soon: just draw the blade back
  }
}
function heroDown(dt) {  // the death animation; its last frame stays
  const h = hero;
  slide(h, dt); keepIn(h);
  h.t += dt;
  const f = frameAt(HERO, 'death', h.t);
  h.f = f < 0 ? HERO.anims.death - 1 : f;
  if (h.f >= 5 && h.last < 5) { dust.explode(14, ...Object.values(ahead(h, 26))); shake(150, .007); }  // hits the floor
  h.last = h.f;
}
function swing(act, A) {  // the blade's trail, its flash of light, and for the thrust the bolt of magic
  const h = hero;
  let an = angOf(h.dir);
  sfx(A.sfx);
  if (A === ATK.charged) {  // the charged spin throws its light much wider
    sfx('swing_heavy', .8, .8); shake(220, .01); ring(h.x, h.y - 26, 0xfff0c0, 30, 150, 380); ring(h.x, h.y - 26, 0xd9c9ff, 20, 110, 300);
    burst('glow', h.x, h.y - 30, 0xfff0c0, { s: .5 }, { s: 2.6 }, 320); light(h.x, h.y, 0xfff0c0, 400, 3.2, 380); return;
  }
  if (act === 'spin') { ring(h.x, h.y - 26, 0xd9c9ff, 26, 82, 320); light(h.x, h.y, 0xcbb8ff, 280, 1.8, 320); return; }
  const p = ahead(h, act === 'thrust' ? 60 : 44);
  if (act === 'thrust') burst('streak', p.x, p.y - 30, 0xe6dcff, { sx: .3, sy: 1, r: tilt(an) }, { sx: 1.6, sy: .4 }, 160);
  else burst('arc', p.x, p.y - 34, 0xf3ecff, { s: .75, r: tilt(an) }, { s: 1.35 }, 210);
  light(p.x, p.y, 0xcbb8ff, A.heavy ? 250 : 180, A.heavy ? 2 : 1.4, 200);
  if (act === 'thrust' && h.mp >= BOLT_COST) {  // the thrust looses a bolt along the blade, bending a little towards a locked target
    h.mp -= BOLT_COST; bars(); sfx('bolt', .8);
    const t = h.target && h.target.hp > 0 && Math.abs(wrap(ang(h, h.target) - an)) < .5 ? h.target : null;
    if (t) an = ang(h, t);
    bolts.push({ ...p, an, life: 900, img: S.add.image(p.x, p.y - 30, 'streak').setBlendMode('ADD').setTint(0x9fd0ff).setDepth(2400).setRotation(tilt(an)).setScale(.5, 1.6),
                 light: S.lights.addLight(p.x, p.y, 190, 0x6fb4ff, 1.8) });
  } else if (act === 'thrust') number(h.x, h.y - 84, 'sem mana', '#7fb8ff');
}
function strike(e, A) {  // an enemy takes a hit: the flash, the freeze, the debris, then whatever that enemy does about it
  const big = !!A.heavy, p = ahead(e, e.r * .6, ang(e, hero));
  p.y -= e.tall;
  e.hp -= A.dmg; e.white = 1; freeze = Math.max(freeze, A.stop);
  shake(big ? 220 : 110, big ? .012 : .005);
  if (e.a) squash(e.a, big ? 1.16 : 1.07, big ? .86 : .94);
  push(e, hero, (big ? 230 : 70) * e.light);
  chips.explode(big ? 20 : 8, p.x, p.y); sparks.explode(big ? 22 : 10, p.x, p.y);
  burst('glow', p.x, p.y, 0xe6dcff, { s: .3 }, { s: big ? 1.7 : 1 }, 170);
  light(p.x, p.y + e.tall, 0xd9c9ff, big ? 340 : 240, big ? 3.4 : 2.2, 240);
  number(p.x, p.y - 34, A.dmg, big ? '#ffd98a' : '#e6dcff');
  sfx(big ? 'hit_heavy' : 'hit_stone'); if (big || e.hp <= 0) sfx('golem_hurt', .7, e.kind === 'golem' ? 1 : 1.5);
  e.onHit(big);
}
function hurtHero(dmg, from, by) {  // `by`: the enemy whose own body dealt the blow, which can then be parried
  const h = hero;
  if (h.inv > 0 || h.safe || h.dead || state !== 'play') return;
  if (by && h.guard) return parried(by);
  Object.assign(h, { hp: h.hp - dmg, inv: 900, stun: 170, act: null, power: null, white: 1 });
  h.hum.stop();
  push(h, from, 430); freeze = 90; shake(180, .012); squash(h, .8, 1.2);
  sparks.explode(12, h.x, h.y - 36); number(h.x, h.y - 78, dmg, '#ff6a7a'); sfx('hero_hurt');
  light(h.x, h.y, 0xff3050, 250, 2.4, 280);
  restart($('hurt'), 'on');
  bars('hp');
  if (h.hp > 0) return;
  Object.assign(h, { dead: true, anim: 'death', t: 0, f: 0, last: -1, stun: 0, inv: 0 });  // falls on his face, sword out ahead
  h.spr.setAlpha(1); state = 'over'; sfx('hero_death');
  S.time.delayedCall(2000, () => end(false));
}
function parried(e) {  // the blow is turned aside: no damage, and the attacker is left wide open
  const h = hero, p = ahead(h, 24);
  p.y -= 48;
  freeze = 150; shake(200, .012); sfx('parry'); sfx('golem_hurt', .6, e.kind === 'golem' ? 1 : 1.5);
  sparks.explode(28, p.x, p.y); burst('glow', p.x, p.y, 0xffffff, { s: .3 }, { s: 1.9 }, 220); ring(h.x, h.y, 0xe6dcff, 20, 120, 280);
  light(h.x, h.y, 0xffffff, 340, 3.4, 280); number(p.x, p.y - 30, 'APARADO', '#ffffff');
  h.inv = 450; squash(h, 1.14, .9);
  Object.assign(e, { state: 'hurt', anim: 'hurt', t: 0, charge: 0, open: 1000, white: 1 });
  push(e, h, 170 * e.light); squash(e.a, .92, 1.08);
}
function boltsTick(dt) {
  for (const b of [...bolts]) {
    const d = 620 * dt / 1000;
    Object.assign(b, ahead(b, d, b.an)); b.life -= dt;
    b.img.setPosition(b.x, b.y - 30); b.light.setPosition(b.x, b.y);
    if (Math.random() < .6) sparks.explode(1, b.x, b.y - 30);
    const e = alive().find(e => gd(b, e) < e.r + 14);
    if (e) strike(e, ATK.bolt);
    if (e || b.life <= 0 || !ok(b.x, b.y)) {
      burst('glow', b.x, b.y - 30, 0x9fd0ff, { s: .3 }, { s: 1.1 }, 180);
      b.img.destroy(); S.lights.removeLight(b.light); bolts.splice(bolts.indexOf(b), 1);
    }
  }
}

// ---------------------------------------------------------------- enemies
// Every enemy is { kind, x, y, r, tall, light (how easily it is knocked back), hp, onHit } plus its own fields.
function spawnMinion(x, y) {
  const a = actor('minion', MINION, 40);
  Object.assign(a, { kind: 'minion', a, x, y, r: 22, tall: 34, light: 1.8, solid: true, state: 'idle', wait: 500 + Math.random() * 700 });
  a.onHit = big => {
    if (a.hp <= 0) { Object.assign(a, { state: 'dead', anim: 'death', t: 0 }); S.tweens.add({ targets: a.parts, alpha: 0, delay: 1300, duration: 500 }); }
    else Object.assign(a, { state: 'hurt', anim: 'hurt', t: 0 });
  };
  foes.push(a);
}
function minionTick(m, dt) {
  const h = hero;
  slide(m, dt); keepIn(m);
  if (m.state === 'dead') { m.t += dt; const f = frameAt(MINION, 'death', m.t); m.f = f < 0 ? MINION.anims.death - 1 : f; return; }
  if (m.state === 'hurt') {
    m.t += dt; m.f = frameAt(MINION, 'hurt', m.t);
    if (m.f < 0) Object.assign(m, { state: 'idle', anim: 'idle', f: 0, wait: m.open || 250, open: 0 });
    return;
  }
  if (m.state === 'atk') {
    m.t += dt * 1.15;
    const f = frameAt(MINION, 'swipe', m.t);
    if (f < 0) return Object.assign(m, { state: 'idle', anim: 'idle', t: 0, f: 0, wait: 500 + Math.random() * 500 });
    for (let i = m.f + 1; i <= f; i++) if (i === 3) {
      sfx('golem_swipe', .5, 1.6);
      const p = ahead(m, 42); burst('arc', p.x, p.y - 26, 0x7dffb0, { s: .7, r: tilt(angOf(m.dir)) }, { s: 1.2 }, 200);
      if (gd(m, h) < 74 && Math.abs(wrap(ang(m, h) - angOf(m.dir))) < 1.1 && !h.air) hurtHero(8, m, m);
    }
    m.f = f; return;
  }
  for (const o of alive()) if (o !== m && o.solid && gd(m, o) < m.r + o.r) Object.assign(m, ahead(o, m.r + o.r, ang(o, m)));  // don't pile up
  const d = gd(m, h);
  m.dir = faceOf(ang(m, h)); m.wait -= dt;
  if (h.dead) { m.anim = 'idle'; m.f = 0; }
  else if (!(m.awake ||= d < 330 || m.hp < m.max)) { m.anim = 'idle'; m.t += dt; m.f = frameAt(MINION, 'idle', m.t % total(MINION, 'idle')); }  // asleep until he comes near
  else if (d > 58) {
    const v = 100 * dt / 1000, an = ang(m, h) + (m.veer || 0), x0 = m.x, y0 = m.y;
    m.x += Math.cos(an) * v; m.y += Math.sin(an) * v * RATIO; m.walked += v;
    keepIn(m);
    // making no headway (a sarcophagus or a column in the way): veer to one side for a moment, then head for him again
    m.stuck = Math.hypot(m.x - x0, (m.y - y0) / RATIO) < v * .4 ? (m.stuck || 0) + dt : 0;
    if (m.stuck > 150) { m.veer = (Math.random() < .5 ? 1 : -1) * 1.2; m.veerT = 500; m.stuck = 0; }
    if (m.veer && (m.veerT -= dt) <= 0) m.veer = 0;
    m.anim = 'walk'; m.f = Math.floor(m.walked / MINION.stride.walk * 8) % 8;
  } else if (m.wait <= 0) Object.assign(m, { state: 'atk', anim: 'swipe', t: 0, f: -1 });
  else { m.anim = 'idle'; m.t += dt; m.f = frameAt(MINION, 'idle', m.t % total(MINION, 'idle')); }
}
function spawnWisp(x, y) {  // a drifting ember that keeps its distance and spits fire
  const w = { kind: 'wisp', x, y, r: 16, tall: 44, light: 2.4, hp: 24, kx: 0, ky: 0, white: 0, wait: 1200 + Math.random() * 1500, phase: Math.random() * 7,
              img: S.add.image(x, y, 'glow').setBlendMode('ADD').setTint(0x5dffa0), core: S.add.image(x, y, 'dot').setBlendMode('ADD').setScale(1.6),
              light: S.lights.addLight(x, y, 170, 0x40ff90, 1.2) };
  w.onHit = () => {
    if (w.hp > 0) return;
    fire.explode(14, w.x, w.y - w.tall); burst('glow', w.x, w.y - w.tall, 0x7dffb0, { s: .4 }, { s: 1.6 }, 260);
    w.img.destroy(); w.core.destroy(); S.lights.removeLight(w.light);
  };
  foes.push(w);
}
function wispTick(w, dt, time) {
  const h = hero, d = gd(w, h), an = ang(w, h);
  slide(w, dt);
  const v = (d > 270 ? 80 : d < 170 ? -95 : 0) * dt / 1000, side = 40 * dt / 1000;  // closes in, backs off, and always circles
  w.x += Math.cos(an) * v - Math.sin(an) * side; w.y += (Math.sin(an) * v + Math.cos(an) * side) * RATIO;
  keepIn(w);
  w.wait -= dt; w.white = Math.max(0, w.white - dt / 110);
  const charge = w.wait < 450 ? 1 - w.wait / 450 : 0, y = w.y - w.tall + 5 * Math.sin(time / 300 + w.phase);
  w.img.setPosition(w.x, y).setScale(.3 + .25 * charge).setDepth(w.y).setTint(w.white ? 0xffffff : 0x5dffa0);
  w.core.setPosition(w.x, y).setDepth(w.y + .1);
  w.light.setPosition(w.x, w.y).setIntensity(1.2 + 1.4 * charge);
  if (w.wait > 0 || h.dead || d > 460) return;  // too far to bother
  w.wait = 2100 + Math.random() * 900; sfx('magic_burst', .35, 1.8);
  shots.push({ x: w.x, y: w.y, an, life: 2600, img: S.add.image(w.x, w.y - 40, 'glow').setBlendMode('ADD').setTint(0x7dffb0).setScale(.22).setDepth(2400) });
}
function shotsTick(dt) {
  for (const s of [...shots]) {
    Object.assign(s, ahead(s, 240 * dt / 1000, s.an)); s.life -= dt;
    s.img.setPosition(s.x, s.y - 34);
    const hitHero = gd(s, hero) < 20 && !hero.safe && !hero.dead;
    if (hitHero) hurtHero(10, s);
    if (hitHero || s.life <= 0 || !ok(s.x, s.y)) { burst('glow', s.x, s.y - 34, 0x7dffb0, { s: .25 }, { s: .8 }, 160); s.img.destroy(); shots.splice(shots.indexOf(s), 1); }
  }
}
function golemTick(dt) {
  const g = golem, h = hero, rage = g.hp < g.max / 2 ? 1.25 : 1;  // below half health everything speeds up
  slide(g, dt); keepIn(g);
  if (g.state === 'dead') { g.t += dt; const f = frameAt(GOLEM, 'death', g.t); g.f = f < 0 ? GOLEM.anims.death - 1 : f; return; }
  if (g.state === 'hurt') {
    g.t += dt; g.f = frameAt(GOLEM, 'hurt', g.t);
    if (g.f < 0) Object.assign(g, { state: 'idle', anim: 'idle', f: 0, wait: g.open || Math.min(g.wait, 350), open: 0 });  // after a parry it stays open longer
    return;
  }
  if (g.state === 'atk') {
    g.t += dt * rage * (g.anim === 'swipe' && g.f < 2 ? .75 : 1);  // the swipe's wind-up is held a little longer, to be readable
    const f = frameAt(GOLEM, g.anim, g.t);
    if (f < 0) Object.assign(g, { state: 'idle', anim: 'idle', t: 0, f: 0, charge: 0, wait: (480 + Math.random() * 480) / rage });
    else { for (let i = g.f + 1; i <= f; i++) golemEvent(g.anim, i, rage); g.f = f; }
    return;
  }
  const d = gd(g, h), fighting = bossOn && state === 'play' && !h.dead;
  g.dir = faceOf(ang(g, h));
  if (fighting && (g.wait -= dt) <= 0) {
    const r = Math.random(), pick = d < 165 ? (r < .6 ? 'swipe' : 'slam') : d < 340 ? (r < .45 ? 'slam' : r < .8 ? 'cast' : 0) : (r < .6 ? 'cast' : 0);
    if (pick) return Object.assign(g, { state: 'atk', anim: pick, t: 0, f: -1 });
    g.wait = 500;  // too far for anything it wants to do: keep walking and think again
  }
  if (fighting && d > 150) {
    const v = 112 * rage * dt / 1000, an = ang(g, h), was = g.f;
    g.x += Math.cos(an) * v; g.y += Math.sin(an) * v * RATIO; g.walked += v;
    g.anim = 'walk'; g.f = Math.floor(g.walked / GOLEM.stride.walk * 8) % 8;  // frames follow the distance: no sliding feet
    if (g.f !== was && (g.f === 2 || g.f === 6)) { sfx('golem_step', .45); shake(70, .002); dust.explode(4, g.x, g.y); }
  } else { g.anim = 'idle'; g.t += dt; g.f = frameAt(GOLEM, 'idle', g.t % total(GOLEM, 'idle')); }
}
function golemEvent(anim, f, rage) {  // what happens as each attack reaches a frame
  const g = golem, h = hero, an = angOf(g.dir);
  if (anim === 'swipe' && f === 2) sfx('golem_swipe');
  if (anim === 'swipe' && f === 3) {
    const p = ahead(g, 105);
    burst('arc', p.x, p.y - 62, 0xff9a40, { s: 1.7, r: tilt(an) }, { s: 2.7 }, 250);
    dust.explode(10, p.x, p.y); light(p.x, p.y, 0xff8a30, 300, 2, 260);
    if (gd(g, h) < 170 && Math.abs(wrap(ang(g, h) - an)) < 1.1 && !h.air) hurtHero(16, g, g);  // back off, get behind it, jump the arm, roll or parry
  }
  if (anim === 'slam' && f === 4) {  // fists land: a shockwave runs out along the ground.  Jump over it
    const p = ahead(g, 88);
    sfx('golem_slam'); shake(420, .022); dust.explode(26, p.x, p.y); chips.explode(14, p.x, p.y - 10);
    light(p.x, p.y, 0xff8a30, 420, 3.6, 420); burst('glow', p.x, p.y - 10, 0xffa040, { sx: .6, sy: .3 }, { sx: 3, sy: 1.5 }, 260, 7);
    waves.push({ ...p, r: 40, hit: false, img: S.add.image(p.x, p.y, 'ring').setBlendMode('ADD').setTint(0xffa050).setDepth(6) });
    if (gd(p, h) < 96 && !h.air) hurtHero(22, p, g);
  }
  if (anim === 'cast' && f === 1) { sfx('magic_charge'); g.charge = 1; }
  if (anim === 'cast' && f === 4) {  // fire erupts where the hero stands, and around
    g.charge = 0; shake(160, .008);
    for (let i = 0; i < (rage > 1 ? 5 : 3); i++) {
      const p = i ? ahead(h, 70 + Math.random() * 110, Math.random() * 7) : { x: h.x, y: h.y };
      if (!ok(p.x, p.y)) Object.assign(p, { x: h.x, y: h.y });
      eruptions.push({ ...p, t: -i * 150, img: disc(p.x, p.y, 0xff6a1a, 0),
                       rim: S.add.image(p.x, p.y, 'ring').setBlendMode('ADD').setTint(0xffb060).setDepth(2).setScale(58 / 120, 58 / 120 * RATIO) });
    }
  }
}
function hazards(dt) {
  const h = hero;
  for (const w of [...waves]) {
    w.r += 330 * dt / 1000;
    w.img.setScale(w.r / 120, w.r / 120 * RATIO).setAlpha(1 - w.r / 400);
    if (Math.random() < .5) dust.explode(1, ...Object.values(ahead(w, w.r, Math.random() * 7)));
    if (!w.hit && Math.abs(gd(w, h) - w.r) < 18 && !h.air && !h.safe) { w.hit = true; hurtHero(18, w); }
    if (w.r > 400) { w.img.destroy(); waves.splice(waves.indexOf(w), 1); }
  }
  for (const e of [...eruptions]) {
    e.t += dt;
    const k = Math.max(0, e.t / 850);  // 0..1: the warning mark fills in, then it blows
    e.img.setScale(k * .95, k * .95 * RATIO).setAlpha(e.t < 0 ? 0 : .35 + .3 * Math.sin(e.t / 40));
    e.rim.setAlpha(e.t < 0 ? 0 : .8);
    if (k < 1) continue;
    fire.explode(28, e.x, e.y); sfx('magic_burst', .7); shake(120, .006);
    light(e.x, e.y, 0xff7a1f, 330, 3.6, 420); burst('glow', e.x, e.y - 46, 0xffa040, { sx: .45, sy: 1 }, { sx: 1.1, sy: 2.6 }, 320);
    ring(e.x, e.y, 0xffb060, 30, 90, 300);
    if (gd(e, h) < 60) hurtHero(18, e);
    e.img.destroy(); e.rim.destroy(); eruptions.splice(eruptions.indexOf(e), 1);
  }
}
function wakeTick(dt, time) {  // the heap of rubble in the boss's hall, until the hero comes close; then it pulls itself together
  const g = golem, h = hero;
  if (g.state === 'sleep') {
    g.glow.setAlpha(.12 + .06 * Math.sin(time / 500));  // a faint ember still alive in the pile
    if (state !== 'play' || gd(h, g) > 200) return;
    Object.assign(g, { state: 'rise', t: 0, f: 0, dir: faceOf(ang(g, h)) });
    state = 'scene'; note(''); Object.assign(h, { act: null, power: null, dir: faceOf(ang(h, g)) }); h.hum.stop();
    sfx('golem_death', .9, 1.25); sfx('magic_charge', .9, .7); shake(1300, .006); music.explore.stop();
    return;
  }
  g.t += dt;
  const f = frameAt(GOLEM, 'rise', g.t), k = Math.min(1, g.t / total(GOLEM, 'rise'));
  g.glow.setAlpha(.15 + .85 * k);
  coreLight.setPosition(g.x, g.y).setRadius(180 + 220 * k).setIntensity(3.6 * k);  // the light swells out of the stones
  if (Math.random() < dt / 45) { const p = ahead(g, 20 + Math.random() * 60, Math.random() * 7); chips.explode(2, p.x, p.y - 20 - 90 * k); dust.explode(1, p.x, p.y); }
  if (f >= 0) {
    for (let i = g.f + 1; i <= f; i++) {
      if (i >= 2 && i <= 5) { sfx('golem_step', .8, .7 + .1 * i); shake(140, .008); }  // stone grinding onto stone
      if (i === 7) { sfx('golem_roar'); shake(700, .02); light(g.x, g.y, 0xffb060, 520, 4, 700); ring(g.x, g.y, 0xffa050, 30, 300, 600); fire.explode(30, g.x, g.y - 80); restart($('hurt'), 'on'); }
    }
    g.f = f; return;
  }
  Object.assign(g, { state: 'idle', anim: 'idle', t: 0, f: 0 });  // on its feet: now it speaks
  foes.push(g); prog[room].met = true; state = 'dialog'; say(0);
}
function golemHit(big) {
  const g = golem;
  bars('boss');
  if (g.hp > 0) { if (big && g.state !== 'atk') Object.assign(g, { state: 'hurt', anim: 'hurt', t: 0 }); return; }  // a heavy blow staggers it, unless it is mid-attack
  Object.assign(g, { state: 'dead', anim: 'death', t: 0, charge: 0 }); state = 'over'; freeze = 240;
  sfx('golem_death'); shake(900, .018); music.battle.setVolume(vol.music * .25);
  for (let i = 0; i < 6; i++) S.time.delayedCall(i * 190, () => {
    const p = { x: g.x + (Math.random() - .5) * 110, y: g.y - 20 - Math.random() * 100 };
    chips.explode(14, p.x, p.y); sparks.explode(14, p.x, p.y); fire.explode(8, p.x, p.y);
    light(g.x, g.y, 0xffb060, 380, 3, 260); burst('glow', p.x, p.y, 0xffc070, { s: .4 }, { s: 1.8 }, 240);
  });
  S.tweens.add({ targets: g.glow, alpha: 0, delay: 700, duration: 1200 });  // the fire in it goes out
  S.time.delayedCall(2300, () => end(true));
}

// ---------------------------------------------------------------- rooms: potions, doors, puzzles
function addItem(kind, x, y, id) {
  const tint = kind === 'hp' ? 0xff4660 : 0x4fa3ff;
  items.push({ kind, x, y, id, img: S.add.image(x, y, 'flask').setTint(tint), halo: disc(x, y, tint, 26, 4), light: S.lights.addLight(x, y, 110, tint, .9) });
}
function itemsTick(time) {
  const h = hero;
  for (const it of [...items]) {
    it.img.setPosition(it.x, it.y - 14 - 3 * Math.sin(time / 260 + it.x)).setDepth(it.y);
    it.halo.setAlpha(.45 + .2 * Math.sin(time / 260 + it.x));
    const full = it.kind === 'hp' ? h.hp >= h.max : h.mp >= 100;
    if (gd(it, h) > 30 || full || h.dead) continue;  // a potion he has no use for stays where it is
    if (it.kind === 'hp') h.hp = Math.min(h.max, h.hp + 45); else h.mp = Math.min(100, h.mp + 50);
    const tint = it.kind === 'hp' ? 0xff6a7a : 0x7fb8ff;
    sfx('potion'); bars(); number(h.x, h.y - 84, it.kind === 'hp' ? '+45 vida' : '+50 mana', it.kind === 'hp' ? '#ff8a96' : '#8fc2ff');
    ring(h.x, h.y, tint, 16, 70, 300); light(h.x, h.y, tint, 240, 2, 320); squash(h, .92, 1.1, 300);
    prog[room].taken.add(it.id);
    it.img.destroy(); it.halo.destroy(); S.lights.removeLight(it.light); items.splice(items.indexOf(it), 1);
  }
}
const locked = side => {  // enemies shut every door; a puzzle shuts only the way onward
  const L = LEVEL[room], p = prog[room];
  return alive().length > 0 || (L.puzzle && !p.solved && side === L.exit);
};
function beaten() {  // the room's fight or puzzle is done: the doors grind open and its reward appears
  const L = LEVEL[room], p = prog[room];
  if (p.done) return;
  p.done = true; sfx('door'); shake(260, .006); note('');
  for (const side in L.links) { const { x, y } = doorAt(side); light(x, y, 0xfff0c0, 300, 2.4, 500); sparks.explode(18, x, y - 30); }
  if (L.drop && !p.taken.has('drop')) { const d = spot(L.drop[1], L.drop[2]); addItem(L.drop[0], d.x, d.y, 'drop'); ring(d.x, d.y, 0xfff0c0, 10, 80, 400); }
}
function doorsTick(time) {
  const L = LEVEL[room], h = hero;
  if (!L.boss && !L.puzzle && !alive().length) beaten();
  for (const g of gates) {  // shut: a grate of red bars and red light.  Open: a gold arrow drifting out through the doorway
    const shut = locked(g.side), k = (time / 500) % 1;
    for (const b of g.bars) b.setVisible(shut).setAlpha(.75 + .25 * Math.sin(time / 150));
    g.arrow.setVisible(!shut).setPosition(g.x + g.ox * k * 18, g.y - 22 + g.oy * k * 18).setAlpha(1 - k);
    g.light.setColor(shut ? 0xff2040 : 0xffd070).setIntensity(shut ? 1.6 : 1.1);
  }
  if (h.dead || h.act === 'roll') return;
  for (const side in L.links) {
    const near = gd(doorAt(side), h) < 42;
    if (!near && h.came === side) h.came = null;  // he has stepped away from the door he came in by
    if (near && h.came !== side && !locked(side)) return enter(L.links[side], side);
  }
}
// ---- puzzle 1: four rune stones, each with its own symbol and its own socket.  They sit in place for a moment,
// overload, and the blast throws them to the corners; the hero carries them back one at a time.
function runesSetup(marks) {
  const p = prog[room], z = puzzle;
  p.stones ??= marks.map((m, k) => ({ x: m.x, y: m.y, slot: k }));  // first visit: every stone in its socket
  marks.forEach((m, k) => z.gfx.push(S.add.image(m.x, m.y, 'sym' + k).setTint(0x8fe0ff).setAlpha(.3).setDepth(2).setScale(1.5, 1.5 * RATIO)));  // the symbol cut into each socket
  z.stones = p.stones.map((st, k) => ({ st, lift: 0, base: S.add.image(0, 0, 'stone'), sym: S.add.image(0, 0, 'sym' + k).setTint(0x8fe0ff).setScale(.8) }));
  for (const s of z.stones) z.gfx.push(s.base, s.sym);
  z.fuse = p.blown ? 0 : 1700;
  if (!p.blown) sfx('magic_charge', .8);
}
function runesTick(dt, time) {
  const z = puzzle, h = hero, p = prog[room];
  if (!p.blown && (z.fuse -= dt) <= 0) {  // the overload: everything goes up, the stones fly
    p.blown = true; sfx('magic_burst'); sfx('golem_slam', .6); shake(500, .02); restart($('hurt'), 'on');
    const c = spot(4, 4); light(c.x, c.y, 0x8fe0ff, 520, 4, 700); fire.explode(40, c.x, c.y); ring(c.x, c.y, 0x8fe0ff, 30, 260, 500);
    z.stones.forEach((s, k) => {
      const from = { ...s.st }, to = spot(...SCATTER[k]), fly = { t: 0 };
      s.st.slot = null;
      S.tweens.add({ targets: fly, t: 1, duration: 750 + k * 60, ease: 'Quad.easeOut', onUpdate: () => { s.st.x = from.x + (to.x - from.x) * fly.t; s.st.y = from.y + (to.y - from.y) * fly.t; s.lift = 110 * Math.sin(Math.PI * fly.t); },
                     onComplete: () => { dust.explode(8, to.x, to.y); sfx('land', .7, .8); } });
    });
    think('“As pedras... preciso devolver cada uma ao seu encaixe.”');
  }
  const hot = p.blown ? 0 : 1 - z.fuse / 1700;  // 0..1 as the overload builds
  z.marks.forEach((m, k) => m.glow.setAlpha(p.stones[k].slot === k ? .55 + .45 * hot + (hot ? .2 * Math.sin(time / 30) : 0) : .1));
  z.stones.forEach((s, k) => {
    const held = h.carry === k, x = held ? h.x : s.st.x + (hot ? (Math.random() - .5) * 5 * hot : 0), y = held ? h.y - 92 : s.st.y - 9 - s.lift;
    s.base.setPosition(x, y).setDepth((held ? h.y : s.st.y) + .5); s.sym.setPosition(x, y).setDepth((held ? h.y : s.st.y) + .6);
  });
}
function useRunes() {
  const z = puzzle, h = hero, p = prog[room];
  if (!p.blown || p.solved) return false;
  const start = then => Object.assign(h, { act: 'pickup', t: 0, last: -1, struck: new Set(), then });
  if (h.carry != null) {  // setting a stone down: into a free socket if he is at one, otherwise on the floor
    const k = h.carry, slot = z.marks.findIndex((m, i) => gd(m, h) < 46 && !p.stones.some(s => s.slot === i)), m = z.marks[slot];
    return start(() => {
      const st = p.stones[k];
      h.carry = null;
      if (!m) { Object.assign(st, { x: h.x, y: h.y }); sfx('land', .6); return; }
      if (slot !== k) {  // not its socket: the stone is thrown back out
        Object.assign(st, { x: h.x, y: h.y }); sfx('ui_move', .9, .5); shake(140, .006); ring(m.x, m.y, 0xff4050, 50, 14, 300); light(m.x, m.y, 0xff3040, 220, 2, 300);
        return;
      }
      Object.assign(st, { x: m.x, y: m.y, slot: k });
      sfx('charge_ready', .7, .8 + .12 * k); ring(m.x, m.y, 0xfff0c0, 12, 70, 320); light(m.x, m.y, 0x8fe0ff, 260, 2.4, 400);
      if (p.stones.every((s, i) => s.slot === i)) { p.solved = true; sfx('solved'); beaten(); }
    });
  }
  const k = p.stones.findIndex(s => s.slot === null && gd(s, h) < 46);
  return k >= 0 && start(() => { h.carry = k; sfx('ui_move', .8, 1.4); });
}
// ---- puzzle 2: the block goes on one plate (taken hold of with E, then pushed or pulled); the other plate is
// jammed and only gives when it is jumped on twice.
function grabbing(dt, inp) {
  const h = hero, b = prog[room].block;
  h.dir = faceOf(ang(h, b)); h.anim = 'push';
  if (inp.use || inp.roll || inp.jump || gd(h, b) > 76) { h.act = null; inp.use = false; return; }  // let go
  if (inp.mag) {
    const n = Math.hypot(inp.x, inp.y), d = 88 * dt / 1000, dx = inp.x / n * d, dy = inp.y / n * d * RATIO;
    if (free(h.x + dx, h.y + dy) && free(b.x + dx, b.y + dy)) {  // they move as one, or not at all
      h.x += dx; h.y += dy; b.x += dx; b.y += dy;
      h.phase += d * Math.sign(dx * (b.x - h.x) + dy * (b.y - h.y) / RATIO / RATIO);  // forwards when pushing, backwards when pulling
      if (Math.random() < .2) dust.explode(1, b.x, b.y);
    }
  }
  h.f = ((Math.floor(h.phase / 7) % 8) + 8) % 8;
}
function useBlock() {
  const h = hero, b = prog[room].block;
  if (gd(h, b) > 62) return false;
  Object.assign(h, { act: 'grab', anim: 'push', f: 0, phase: 0 }); sfx('land', .6, .7);
  return true;
}
function landed() {  // coming down from a jump: on a jammed plate, that is what moves it
  if (puzzle?.kind !== 'L') return;
  const p = prog[room], i = puzzle.marks.findIndex(m => gd(m, hero) < 34 && gd(m, p.block) >= 30);
  if (i < 0 || p.jumps[i] >= 2) return;
  const m = puzzle.marks[i];
  p.jumps[i]++; shake(160, .008); dust.explode(12, m.x, m.y); sfx('golem_step', .9, 1.2 - .25 * p.jumps[i]);
  if (p.jumps[i] === 2) { sfx('door', .5, 1.6); ring(m.x, m.y, 0xffc060, 10, 70, 320); }
}
function platesTick(dt) {
  const z = puzzle, h = hero, p = prog[room], b = p.block;
  z.img.setPosition(Math.round(b.x), Math.round(b.y)).setDepth(b.y); z.shadow.setPosition(b.x, b.y);
  const state = z.marks.map((m, i) => gd(m, b) < 30 ? 'block' : gd(m, h) < 32 && !h.air ? (p.jumps[i] >= 2 ? 'hero' : 'jammed') : null);
  z.marks.forEach((m, i) => {
    m.glow.setAlpha(p.solved || state[i] === 'block' || state[i] === 'hero' ? .75 : p.jumps[i] === 1 ? .3 : .1);
    if (state[i] === 'jammed' && !m.on) p.visits++;  // stepped onto it again, and nothing
    if ((state[i] === 'block' || state[i] === 'hero') && m.on !== state[i]) sfx('ui_move', .8, .7);
    m.on = state[i];
  });
  if (p.solved) return;
  if (p.visits) p.clock += dt;
  if (p.visits >= 4 || p.clock > 60000) { think('“Oh... esta placa está emperrada!”'); p.visits = 0; p.clock = 0; }  // he works it out for himself, more or less
  if (state.includes('block') && state.includes('hero')) { p.solved = true; sfx('solved'); for (const m of z.marks) ring(m.x, m.y, 0xfff0c0, 12, 80, 400); beaten(); }
}
const interact = () => puzzle?.kind === 'R' ? useRunes() : puzzle?.kind === 'L' ? useBlock() : false;
function hintTick() {  // a small label over his head when E would do something
  const h = hero, p = prog[room];
  let t = '';
  if (puzzle?.kind === 'R' && p.blown && !p.solved && !h.act)
    t = h.carry != null ? (puzzle.marks.some((m, i) => gd(m, h) < 46 && !p.stones.some(s => s.slot === i)) ? 'E  colocar' : 'E  soltar') : p.stones.some(s => s.slot === null && gd(s, h) < 46) ? 'E  pegar' : '';
  if (puzzle?.kind === 'L' && !p.solved) t = h.act === 'grab' ? 'E  soltar' : !h.act && gd(h, p.block) <= 62 ? 'E  agarrar' : '';
  hint.setText(t).setPosition(h.x, h.y - (h.carry != null ? 124 : 104)).setVisible(!!t);
}
function clearRoom() {
  for (const e of foes) if (e !== golem) { e.parts?.forEach(s => s.destroy()); if (e.kind === 'wisp' && e.hp > 0) { e.img.destroy(); e.core.destroy(); S.lights.removeLight(e.light); } }
  for (const s of scenery) s.destroy();
  scenery = [];
  for (const g of gates) { g.bars.forEach(b => b.destroy()); g.arrow.destroy(); S.lights.removeLight(g.light); }
  gates.length = 0;
  for (const o of [...waves, ...eruptions, ...shots, ...bolts, ...items]) { o.img.destroy(); o.rim?.destroy(); o.halo?.destroy(); if (o.light) S.lights.removeLight(o.light); }
  if (puzzle) for (const g of puzzle.gfx) g.destroy();
  foes.length = waves.length = eruptions.length = shots.length = bolts.length = items.length = gates.length = 0;
  puzzle = null;
}
function enter(name, side) {  // walk into a room through the door on `side` of the room being left (null: appear in the middle)
  const L = LEVEL[name], R = ROOM.rooms[name], h = hero, p = prog[name] ??= { taken: new Set() };
  if (h.carry != null) Object.assign(prog[room].stones[h.carry], { x: h.px ?? h.x, y: h.py ?? h.y });  // a stone in hand stays behind, where he stood
  h.carry = null;
  clearRoom();
  room = name; checkpoint = { name, side, hp: h.hp, mp: h.mp };
  restart($('fade'), 'on');
  [CX, CY] = R.origin;
  S.cameras.main.setBounds(0, 0, ...R.size);
  for (const [stem, y] of R.layers)  // the room's layers: floor and far walls, the rows of tall things sorted by depth, the near kerbs
    scenery.push(S.add.image(...ROOM.at[stem], 'room_' + stem).setOrigin(0).setPipeline('IsoLight').setDepth(y ?? (stem.endsWith('_bg') ? 0 : 1000)));
  fires.forEach((f, i) => {  // torches and braziers: a flame, and its light on the ground beneath
    const on = i < R.fires.length, [x, y, gx, gy, z] = R.fires[i] || [0, 0, 0, 0, 0];
    f.on = on; f.light.setPosition(gx, gy); f.glow.setPosition(x, y).setVisible(on).setDepth(z + 20);
    f.embers.setPosition(x, y).setDepth(z + 20); on ? f.embers.start() : f.embers.stop();
  });
  const from = side ? doorAt(BACK[side], -.2) : spot(...(L.spawn || [0, 0]));  // he arrives just inside the matching door of the new room
  Object.assign(h, { x: from.x, y: from.y, px: from.x, py: from.y, came: side ? BACK[side] : null, kx: 0, ky: 0, act: null, power: null });
  if (side) h.dir = faceOf(Math.atan2(-STEP[side][0] - STEP[side][1], STEP[side][0] - STEP[side][1]));  // facing into the room
  h.hum.stop();
  S.cameras.main.centerOn(h.x, h.y);  // no camera glide between rooms
  for (const s in L.links) {
    const d = doorAt(s, .5), [ai, aj] = ALONG[s], [di, dj] = STEP[s];
    // each bar is sorted by where it stands on the floor, like everything else: in front of a far door the fighters cover it
    const bars = [-.8, -.4, 0, .4, .8].map(t => { const y = d.y - (ai + aj) * HH * t; return S.add.image(d.x + (ai - aj) * HW * t, y - 34, 'bar').setBlendMode('ADD').setTint(0xff3048).setDepth(y - 4); });
    const ox = (di - dj) * HW / 50, oy = -(di + dj) * HH / 50;  // the way out, on screen
    gates.push({ side: s, ...d, ox, oy, bars, light: S.lights.addLight(d.x, d.y, 200, 0xffd070, 1),
                 arrow: S.add.image(d.x, d.y, 'chev').setBlendMode('ADD').setTint(0xffd070).setDepth(d.y - 4).setRotation(Math.atan2(oy, ox)) });
  }
  const put = (fn, kind, i, j, id) => { const c = spot(i, j); fn(kind, c.x, c.y, id); };
  if (!p.done) for (const [kind, i, j] of L.foes || []) put((k, x, y) => k === 'minion' ? spawnMinion(x, y) : spawnWisp(x, y), kind, i, j);
  (L.items || []).forEach(([kind, i, j], n) => p.taken.has(n) || put(addItem, kind, i, j, n));
  if (p.done && L.drop && !p.taken.has('drop')) put(addItem, ...L.drop, 'drop');
  if (L.puzzle) {  // the puzzle pieces are letters in the room's map: R rune sockets, L plates, B the block
    const find = ch => R.map.flatMap((row, j) => [...row].map((c, i) => c === ch ? spot(i, j) : null)).filter(Boolean);
    const marks = find(L.puzzle).map(m => ({ ...m, glow: disc(m.x, m.y, L.puzzle === 'R' ? 0x7fd0ff : 0xffc060, 36), on: null }));
    puzzle = { kind: L.puzzle, marks, gfx: marks.map(m => m.glow) };
    if (L.puzzle === 'R') runesSetup(marks);
    else {
      Object.assign(p, { block: p.block ?? find('B')[0], jumps: p.jumps ?? [0, 0], visits: p.visits ?? 0, clock: p.clock ?? 0 });
      puzzle.img = S.add.image(0, 0, 'room_block').setPipeline('IsoLight');
      puzzle.img.setOrigin((ROOM.block[0] - ROOM.at.block[0]) / puzzle.img.width, (ROOM.block[1] - ROOM.at.block[1]) / puzzle.img.height);  // the trimmed image's anchor: where the block stands
      puzzle.shadow = S.add.image(0, 0, 'shadow').setDepth(3).setScale(1.5);
      puzzle.gfx.push(puzzle.img, puzzle.shadow);
    }
  }
  golem.parts.forEach(s => s.setVisible(!!L.boss));
  if (L.boss) Object.assign(golem, spot(5, 7), { kx: 0, ky: 0 });  // the golem waits before its gate
  bossOn = false; $('boss').hidden = true;
  if (!L.boss && !L.puzzle && !L.foes) p.done = true;  // nothing to beat here: the doors are simply open
  note(p.seen ? '' : L.note); p.seen = true;
  if (L.boss && golem.hp > 0) {
    if (p.met) { foes.push(golem); bossFight(); }  // he has been here before: it is already up, and the door shuts behind him
    else Object.assign(golem, { state: 'sleep', anim: 'rise', f: 0, t: 0, dir: 0 });  // first time: only a heap of rubble in the middle of the hall
  }
  bars();
}

// ---------------------------------------------------------------- flow: title -> rooms -> boss -> result
const LINES = [
  ['golem', 'Golem', 'QUEM... PERTURBA... O SONO DAS RUÍNAS?'],
  ['hero', 'Guerreiro', 'Só um viajante. Dizem que o portão atrás de você guarda o que eu procuro.'],
  ['golem', 'Golem', 'NINGUÉM... ATRAVESSA. EU SOU... A ÚLTIMA PEDRA.'],
  ['hero', 'Guerreiro', 'Então vou ter que derrubar a pedra.'],
];
function say(i) {
  if (i >= LINES.length) return bossFight();
  const el = $('dialog');
  talk = { i, n: 0 };
  el.hidden = false; el.className = LINES[i][0]; el.firstChild.textContent = LINES[i][1];
}
function dialogTick(dt, inp) {
  const [who, , text] = LINES[talk.i], was = Math.floor(talk.n);
  talk.n = Math.min(text.length, talk.n + dt / 26);
  if (Math.floor(talk.n) > was && was % 3 === 0) sfx('ui_move', .3, who === 'golem' ? .55 : 1.35);  // each voice has its own blip
  if (inp.ok) talk.n < text.length ? talk.n = text.length : (sfx('ui_move', .5), say(talk.i + 1));
  if (talk) $('dialog').lastChild.textContent = text.slice(0, Math.floor(talk.n));
}
function playLogo() {  // the title's logo assembles itself, then settles into its flickering loop
  const intro = $('logoIntro'), loop = $('logoLoop');
  if (intro.readyState < 2 || loop.readyState < 2) return;  // videos missing or not ready: the still logo stays
  loop.classList.remove('on'); intro.classList.add('on'); $('logo').classList.add('live');
  intro.currentTime = 0; intro.play().catch(() => {});
  intro.onended = () => { loop.currentTime = 0; loop.play().catch(() => {}); loop.classList.add('on'); intro.classList.remove('on'); };
}
function show(id) {  // one menu screen at a time, or none
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  screen = id;
  if (id === 'menu') playLogo(); else { $('logoIntro').pause(); $('logoLoop').pause(); }
  if (id) document.querySelector(`#${id} :is(button:not(:disabled), input)`)?.focus();
}
function newGame() {  // from the first room, with everything in the level as it was
  prog = {};
  Object.assign(hero, { hp: hero.max, mp: 60, dead: false, anim: 'idle', f: 0, inv: 0, stun: 0, cd: 0, rollCd: 0, charge: 0, air: false, safe: false, guard: false, sx: 1, sy: 1 });
  Object.assign(golem, { hp: golem.max, state: 'idle', anim: 'idle', wait: 0, charge: 0, open: 0, kx: 0, ky: 0 });
  S.tweens.killTweensOf(golem.glow); golem.glow.setAlpha(1);
  state = 'play'; show(null);
  for (const id of ['hp', 'mp']) $(id).hidden = false;
  music.menu.stop(); music.battle.stop(); music.amb.play(); music.explore.play();
  enter('start', null);
}
function retry() {  // back to the door he came in by, as he was then (but never with less than half his health)
  const c = checkpoint;
  Object.assign(hero, { hp: Math.max(c.hp, hero.max / 2), mp: Math.max(c.mp, 30), dead: false, anim: 'idle', f: 0, inv: 0, stun: 0, sx: 1, sy: 1 });
  if (LEVEL[c.name].boss) { Object.assign(golem, { hp: golem.max, state: 'idle', anim: 'idle', charge: 0, open: 0 }); S.tweens.killTweensOf(golem.glow); golem.glow.setAlpha(1); }
  state = 'play'; show(null);
  music.battle.stop(); if (!music.explore.isPlaying) music.explore.play();
  enter(c.name, c.side);
}
function bossFight() {
  talk = null; state = 'play'; bossOn = true; golem.wait = 1100;
  $('dialog').hidden = true; note('');
  for (const id of ['boss', 'banner']) $(id).hidden = false;
  $('banner').firstChild.textContent = 'Lute'; $('banner').firstChild.style.animation = 'none'; void $('banner').offsetWidth; $('banner').firstChild.style.animation = '';
  bars(); shake(300, .008); squash(golem, 1.12, .9, 700);
  music.explore.stop(); music.battle.setVolume(vol.music * .8); music.battle.play();
}
function end(won) {
  if (state !== 'over') return;  // left for the menu, or restarted, while the last blow was still playing out
  state = 'end'; music.battle.stop(); music.explore.stop(); sfx(won ? 'victory' : 'defeat');
  $('end').children[0].textContent = won ? 'O guardião caiu' : 'O guerreiro caiu';
  $('end').children[1].textContent = won ? 'Vitória' : 'Derrota';
  document.querySelector('[data-act=again]').textContent = won ? 'Jogar de novo' : 'Tentar de novo';
  $('end').dataset.won = won ? 1 : '';
  show('end');
}
function pause(on) {
  if (on === paused || (on && state !== 'play')) return;
  paused = on; back = [];
  S.tweens[on ? 'pauseAll' : 'resumeAll'](); S.time.paused = on; S.sound[on ? 'pauseAll' : 'resumeAll']();
  show(on ? 'pause' : null);
}
function toMenu() {
  pause(false); state = 'menu'; talk = null; back = [];
  for (const id of ['boss', 'hp', 'mp', 'dialog', 'banner']) $(id).hidden = true;
  note('');
  for (const k of ['battle', 'amb', 'explore']) music[k].stop();
  music.menu.play();
  prog = {}; hero.dead = false; hero.hp = hero.max; golem.hp = golem.max; golem.state = 'idle';
  enter('arena', null); state = 'menu'; $('dialog').hidden = true; talk = null; prog = {};  // the title shows the golem's hall
  show('menu');
}
const ACT = {  // what each menu button does (its data-act)
  play() { if (state === 'menu' && music) newGame(); },
  options() { back.push(screen); show('options'); },
  back() { show(back.pop() ?? 'menu'); },
  resume() { pause(false); },
  restart() { pause(false); retry(); },
  again() { $('end').dataset.won ? newGame() : retry(); },
  quit: toMenu,
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled && music) { sfx('ui_confirm', .5); ACT[b.dataset.act](); }
});
document.addEventListener('mouseover', e => e.target.closest?.('nav button:not(:disabled), input')?.focus());  // one highlight for mouse, keys and pad
function menuTick(inp) {  // arrows and the gamepad move the focus; the browser handles Enter, Space and the sliders' own keys
  const list = [...document.querySelectorAll(`#${screen} :is(button:not(:disabled), input)`)];
  if (!list.length) return;
  let i = list.indexOf(document.activeElement);
  if (i < 0 || inp.navY) { i = i < 0 ? 0 : (i + inp.navY + list.length) % list.length; list[i].focus(); if (inp.navY) sfx('ui_move', .5); }
  list.forEach((el, j) => el.classList.toggle('on', j === i));
  if (list[i].type === 'range' && inp.navX) { list[i].value = +list[i].value + inp.navX * 5; list[i].dispatchEvent(new Event('input')); }
  if (inp.padOk && list[i].tagName === 'BUTTON') list[i].click();
}
for (const [id, key] of [['volMusic', 'music'], ['volSfx', 'sfx']]) {
  const el = $(id), paint = () => { el.nextElementSibling.textContent = el.value; el.style.setProperty('--p', el.value + '%'); };
  el.value = vol[key] * 100; paint();
  el.addEventListener('input', () => {
    vol[key] = el.value / 100; paint();
    try { localStorage.setItem('ruinas-vol', JSON.stringify(vol)); } catch { /* not saved, still applied */ }
    if (!music) return;
    for (const [k, m] of Object.entries(music)) m.setVolume(vol.music * (k === 'explore' ? .6 : .8));
    if (key === 'sfx') sfx('hit_stone', .7);
  });
}
$('dialog').onclick = () => hit.add('Enter');

// ---------------------------------------------------------------- scene
function preload() {
  S = this;
  this.load.on('progress', loading);
  for (const [name, M] of [['hero', HERO], ['golem', GOLEM], ['minion', MINION]]) for (const a in M.anims) {
    const size = { frameWidth: M.w, frameHeight: M.h };
    this.load.spritesheet(`${name}_${a}`, [`assets/${name}_${a}.png`, `assets/${name}_${a}_n.png`], size);  // colour + normal map
    if (name !== 'hero') this.load.spritesheet(`${name}_${a}_e`, `assets/${name}_${a}_e.png`, size);
  }
  for (const l of ROOM.layers) this.load.image('room_' + l, [`assets/room_${l}.png`, `assets/room_${l}_n.png`]);
  for (const k of ['swing_light', 'swing_heavy', 'swing_spin', 'hit_stone', 'hit_heavy', 'jump', 'land', 'roll', 'parry', 'hero_hurt', 'hero_death',
                   'charge_ready', 'bolt', 'potion', 'door', 'solved', 'golem_roar', 'golem_step', 'golem_swipe', 'golem_slam', 'magic_charge',
                   'magic_burst', 'golem_hurt', 'golem_death', 'ui_move', 'ui_confirm', 'victory', 'defeat', 'ambience', 'music_menu',
                   'music_explore', 'music_battle']) this.load.audio(k, `assets/audio/${k}.mp3`);
}
function create() {
  this.renderer.pipelines.add('IsoLight', new IsoLight(this.game));
  // Effect textures, drawn once
  const g = this.make.graphics();
  const tex = (key, w, h, paint) => { g.clear(); paint(); g.generateTexture(key, w, h); };
  tex('dot', 8, 8, () => g.fillStyle(0xffffff).fillCircle(4, 4, 3));
  tex('chip', 8, 8, () => g.fillStyle(0xffffff).fillTriangle(0, 7, 4, 0, 8, 6));
  tex('glow', 128, 128, () => { for (let i = 32; i > 0; i--) g.fillStyle(0xffffff, .035).fillCircle(64, 64, i * 2); });
  tex('shadow', 64, 36, () => { for (let i = 6; i > 0; i--) g.fillStyle(0x000000, .1).fillEllipse(32, 18, i * 9, i * 5); });
  tex('ring', 256, 256, () => g.lineStyle(16, 0xffffff, .3).strokeCircle(128, 128, 116).lineStyle(6, 0xffffff, 1).strokeCircle(128, 128, 120));
  tex('streak', 128, 16, () => g.fillStyle(0xffffff, .45).fillEllipse(64, 8, 128, 12).fillStyle(0xffffff, 1).fillEllipse(64, 8, 104, 4));
  tex('arc', 200, 200, () => { for (let i = 0; i < 8; i++) g.lineStyle(26 - i * 3, 0xffffff, .16 + i * .05).beginPath().arc(40, 100, 78, -1.05 + i * .07, 1.05 - i * .07).strokePath(); });
  tex('bar', 6, 70, () => g.fillStyle(0xffffff).fillRect(1, 0, 4, 70));
  tex('chev', 28, 28, () => g.fillStyle(0xffffff).fillTriangle(4, 4, 26, 14, 4, 24));  // an arrow pointing right
  tex('stone', 30, 30, () => g.fillStyle(0x2a3350).fillCircle(15, 15, 14).lineStyle(2, 0x8fa0c8).strokeCircle(15, 15, 13));  // a rune stone; its symbol is drawn over it
  const glyph = [() => g.strokeTriangle(12, 3, 21, 20, 3, 20), () => g.strokeCircle(12, 12, 8), () => g.strokeRect(5, 5, 14, 14), () => g.lineBetween(4, 4, 20, 20).lineBetween(20, 4, 4, 20)];
  glyph.forEach((draw, k) => tex('sym' + k, 24, 24, () => { g.lineStyle(3, 0xffffff); draw(); }));
  tex('flask', 16, 20, () => g.fillStyle(0xffffff).fillCircle(8, 13, 6).fillRect(6, 3, 4, 6).fillStyle(0xffffff, .6).fillRect(5, 1, 6, 3));  // a potion bottle, tinted per kind

  this.lights.enable().setAmbientColor(0x3b4070);  // deep night: the torches, the potions and the blows do the lighting
  const part = (key, cfg) => this.add.particles(0, 0, key, { emitting: false, ...cfg }).setDepth(2600);
  sparks = part('dot', { speed: { min: 80, max: 340 }, lifespan: { min: 220, max: 460 }, scale: { start: 1.2, end: 0 }, tint: [0xffffff, 0xd9c9ff, 0xffd98a], blendMode: 'ADD' });
  chips = part('chip', { speed: { min: 70, max: 260 }, angle: { min: 200, max: 340 }, gravityY: 700, lifespan: { min: 450, max: 800 }, rotate: { min: 0, max: 360 }, scale: { start: 1.1, end: .5 }, tint: [0x8a8fa8, 0x565b74, 0xb0b3c6] });
  dust = part('glow', { speed: { min: 15, max: 80 }, angle: { min: 180, max: 360 }, lifespan: { min: 450, max: 900 }, scale: { start: .12, end: .5 }, alpha: { start: .4, end: 0 }, tint: 0x9d95b0 });
  fire = part('dot', { speedX: { min: -70, max: 70 }, speedY: { min: -330, max: -60 }, gravityY: -120, lifespan: { min: 350, max: 800 }, scale: { start: 1.8, end: 0 }, tint: [0xffe08a, 0xff9a33, 0xff5511], blendMode: 'ADD' });
  // dust motes drifting through the dark, catching no light of their own
  motes = this.add.particles(0, 0, 'dot', { x: { min: 0, max: W }, y: { min: 0, max: H }, frequency: 260, lifespan: 6000, speedX: { min: -8, max: 8 }, speedY: { min: -10, max: -3 },
                                           scale: { min: .3, max: .7 }, alpha: { start: .3, end: 0 }, tint: 0xb9a6ff, blendMode: 'ADD' }).setDepth(2700).setScrollFactor(0);
  // A fixed set of flames, moved to wherever the current room has its torches and braziers
  fires = Array.from({ length: Math.max(...Object.values(ROOM.rooms).map(r => r.fires.length)) }, () => ({
    light: this.lights.addLight(0, 0, 300, 0xff9440, 0), glow: this.add.image(0, 0, 'glow').setBlendMode('ADD').setTint(0xff5a14),
    embers: this.add.particles(0, 0, 'dot', { frequency: 110, lifespan: 900, speedX: { min: -9, max: 9 }, speedY: { min: -46, max: -16 }, scale: { start: 1, end: 0 }, tint: [0xffcc55, 0xff7722], blendMode: 'ADD' }),
  }));
  coreLight = this.lights.addLight(0, 0, 210, 0xff6a1a, 0);
  heroLight = this.lights.addLight(0, 0, 190, 0xb9a6ff, 1);  // his own small pool of light in the dark
  chargeLight = this.lights.addLight(0, 0, 200, 0xb9a6ff, 0);
  chargeGlow = this.add.image(0, 0, 'glow').setBlendMode('ADD').setDepth(2550).setAlpha(0);  // the light gathering on the blade
  hero = actor('hero', HERO, 100);
  Object.assign(hero, { mp: 60, inv: 0, stun: 0, cd: 0, rollCd: 0, charge: 0, r: 0 });
  hint = this.add.text(0, 0, '', { fontFamily: 'Inter', fontSize: 13, fontStyle: '700', color: '#ffd98a', stroke: '#0a0816', strokeThickness: 4 }).setOrigin(.5).setDepth(3000);
  hero.hum = this.sound.add('magic_charge');  // the charge-up hum, on its own channel so it can be cut short
  golem = actor('golem', GOLEM, 520);
  Object.assign(golem, { kind: 'golem', a: golem, r: 50, tall: 62, light: 1, solid: true, state: 'idle', wait: 0, charge: 0, open: 0, onHit: golemHit, x: 0, y: 0 });
  music = { menu: this.sound.add('music_menu', { loop: true }), battle: this.sound.add('music_battle', { loop: true }),
            explore: this.sound.add('music_explore', { loop: true }), amb: this.sound.add('ambience', { loop: true }) };
  for (const [k, m] of Object.entries(music)) m.setVolume(vol.music * (k === 'explore' ? .6 : .8));
  enter('arena', null); state = 'menu'; $('dialog').hidden = true; talk = null; prog = {};  // the title shows the golem's hall
  this.cameras.main.startFollow(hero, true, .12, .12);  // rooms are larger than the screen
  music.menu.play();  // starts as soon as the browser allows sound (first click or key)
  loading(1);
  this.time.delayedCall(450, () => screen === 'loading' && show('menu'));  // let the keystone land before the menu comes in
}
function update(time, delta) {
  const dt = Math.min(delta, 50), inp = readInput(dt);
  if (inp.pause) screen === 'options' ? ACT.back() : pause(!paused);
  else if (inp.back && screen === 'options') ACT.back();
  else if (inp.back && screen === 'pause') pause(false);
  if (screen) menuTick(inp);
  if (!paused) {
    if (state === 'dialog') dialogTick(dt, inp);
    if (freeze > 0) freeze -= dt;  // hit-stop: the world holds still for a few frames on every solid hit
    else {
      if (hero.dead) heroDown(dt);
      else if (state === 'play') heroTick(dt, inp);
      else Object.assign(hero, { anim: 'idle', f: 0 });
      for (const e of [...foes]) {
        if (e.kind === 'golem') golemTick(dt); else if (e.kind === 'minion') minionTick(e, dt); else if (e.hp > 0) wispTick(e, dt, time);
      }
      hazards(dt); boltsTick(dt); shotsTick(dt);
      if (state === 'play') {
        itemsTick(time);
        if (puzzle?.kind === 'R') runesTick(dt, time); else if (puzzle) platesTick(dt);
        hintTick();
        doorsTick(time);
      }
    }
  }
  draw(hero, paused ? 0 : dt);
  for (const e of foes) if (e.parts) draw(e, paused ? 0 : dt);
  const waking = LEVEL[room].boss && !foes.includes(golem) && golem.hp > 0;
  if (waking) { if (!paused) wakeTick(dt, time); draw(golem, paused ? 0 : dt); }
  // Living light: fires flicker, the golem's core breathes and swells while it casts
  const flick = .85 + .15 * Math.sin(time / 90) * Math.sin(time / 37);
  for (const f of fires) { f.light.intensity = f.on ? 1.7 * flick : 0; f.glow.setScale(.8 * flick).setAlpha(.5 * flick); }
  const here = foes.includes(golem), up = here && golem.state !== 'dead', c = ahead(golem, 28);
  if (!waking || golem.state === 'sleep') coreLight.setPosition(c.x, c.y).setIntensity(up ? (golem.charge ? 3.4 : 1 + .3 * Math.sin(time / 300)) : Math.max(0, coreLight.intensity - dt / 600));
  if (!waking) coreLight.setRadius(golem.charge ? 340 : 210);
  if (up) golem.glow.setAlpha(golem.charge ? 1 : .75 + .25 * Math.sin(time / 300));
  heroLight.setPosition(hero.x, hero.y);
  const ch = hero.act === 'charge' ? Math.min(1, hero.charge / CHARGE_MS) : 0, tip = ahead(hero, 54), gold = ch === 1 ? 0xfff0c0 : 0xb9a6ff;
  chargeGlow.setPosition(tip.x, tip.y - 30).setTint(gold).setAlpha(ch ? .35 + .65 * ch : 0).setScale(.22 + .45 * ch + (ch === 1 ? .1 * Math.sin(time / 45) : 0));
  chargeLight.setPosition(hero.x, hero.y).setColor(gold).setRadius(170 + 140 * ch).setIntensity(ch * (ch === 1 ? 1.7 : 1.3));
}
const phaser = new Phaser.Game({ type: Phaser.WEBGL, parent: 'game', width: W, height: H, pixelArt: true, backgroundColor: '#07060d', banner: false,
                                 scale: { mode: Phaser.Scale.NONE }, render: { maxLights: 24 }, scene: { preload, create, update } });
window.game = { get state() { return state; }, get screen() { return screen; }, get paused() { return paused; }, get hero() { return hero; }, get golem() { return golem; },
                get room() { return room; }, get prog() { return prog; }, get puzzle() { return puzzle; }, LEVEL, foes, items, bolts, enter, hit, phaser };  // for debugging in the console
