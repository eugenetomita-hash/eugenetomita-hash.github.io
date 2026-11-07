// The daimyo's army at war: two sides clashing in the fog behind him.
//  - up close, a few live pairs duel: each swing is timed so it meets the other man's block,
//    or lands as he staggers; now and then one falls, lies still, and later gets back up
//  - behind them, squads drawn as instances of one skinned mesh: every man in a squad shares
//    one animated skeleton (so they all move, at the cost of a single character each), and
//    sway back and forth where they stand; runners pour in from the rear
//  - arrow volleys arcing overhead, fires with smoke columns, dust kicked up, the fallen,
//    banners, and riders galloping across (the game's own gallop, done on the horse's bones)
import * as THREE from "three";
import { loadCharacter, loadProp, bakePose, placeInstances, lodGeo, poseAstride } from "./assets.js?v=51";

const A = n => `anims/${n}.fbx`;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clips = names => Object.fromEntries([...new Set(names)].map(n => [n, A(n)]));
const pick = (r, list) => list[Math.floor(r() * list.length)];

const ATTACKS = ["great_sword_slash", "great_sword_slash_2", "great_sword_attack"];
const BLOCKS = ["great_sword_blocking", "great_sword_blocking_2"];
const HITS = ["great_sword_impact", "great_sword_impact_2"];
const DEATHS = ["two_handed_sword_death", "two_handed_sword_death_2"];
const DUEL = ["great_sword_idle", ...ATTACKS, ...BLOCKS, ...HITS, ...DEATHS];
// what a squad cycles through, so the men in it never stand still
const SEQS = [
  ["great_sword_slash", "great_sword_blocking", "great_sword_slash_2", "great_sword_impact"],
  ["great_sword_blocking_2", "great_sword_attack", "great_sword_impact_2", "great_sword_slash_3"],
  ["great_sword_high_spin_attack", "great_sword_idle_2", "great_sword_kick", "great_sword_blocking"],
  ["great_sword_impact_3", "great_sword_slash", "great_sword_strafe", "great_sword_attack"],
];

// A skinned mesh drawn many times: one skeleton, a matrix per copy. (three.js draws a mesh as
// both instanced and skinned when it is both; the bones here are in the driver model's own space.)
class InstancedSkinned extends THREE.SkinnedMesh {
  constructor(geometry, material, skeleton, bindMatrix, count) {
    super(geometry, material);
    this.isInstancedMesh = true;
    this.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(count * 16), 16);
    this.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instanceColor = null; this.morphTexture = null; this.count = count;
    this.skeleton = skeleton;
    this.bindMatrix.copy(bindMatrix);
    this.bindMatrixInverse.identity();
    this.frustumCulled = false;
  }
  updateMatrixWorld(force) { THREE.Mesh.prototype.updateMatrixWorld.call(this, force); } // keep bindMatrixInverse = I
  setMatrixAt(i, m) { m.toArray(this.instanceMatrix.array, i * 16); }
  setColorAt(i, c) {
    if (!this.instanceColor) this.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.count * 3).fill(1), 3);
    c.toArray(this.instanceColor.array, i * 3);
  }
}

// A sword far off in the fog doesn't need its 7,700 triangles: a thin bar the same length,
// in the same place, the steel's colour. Small parts (the back flag, the sheath) are kept.
const cheap = new Map();
function farPart(mesh) {
  const g = mesh.geometry, tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
  if (tris < 1500) return { geometry: g, material: mesh.material };
  if (!cheap.has(g)) {
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox, size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const L = Math.max(size.x, size.y, size.z);
    const dims = [size.x, size.y, size.z].map(d => d === L ? L : L * 0.022);
    const bar = new THREE.BoxGeometry(...dims); bar.translate(c.x, c.y, c.z);
    cheap.set(g, { geometry: bar, material: new THREE.MeshStandardMaterial({ color: "#7d838b", metalness: 0.6, roughness: 0.45 }) });
  }
  return cheap.get(g);
}

// Play a clip on a character, cross-fading from whatever it was doing.
function act(K, name, { fade = 0.18, once = true, scale = 1, from = null } = {}) {
  const a = K.actions[name]; if (!a) return 0;
  const prev = K._cur || K.current; // (K.current: the clip loadCharacter started)
  if (prev === a) a.stop();
  a.reset(); a.enabled = true; a.setEffectiveWeight(1); a.timeScale = scale;
  a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); a.clampWhenFinished = once;
  if (from !== null) a.time = from;
  a.play();
  if (prev && prev !== a && prev.isScheduled()) { if (fade > 0) prev.crossFadeTo(a, fade, false); else prev.stop(); }
  K._cur = a;
  return a.getClip().duration / Math.abs(scale);
}

// When in a clip the blade lands (attacks: the fastest the right hand moves) or the guard is up
// (blocks: the hand at its highest), measured on the character itself.
function keyTimes(K) {
  const hand = (() => { let h = null; K.model.traverse(o => { if (o.isBone && /righthand$/i.test(o.name.replace(/[^A-Za-z]/g, ""))) h = h || o; }); return h; })();
  const out = {};
  if (!hand) return out;
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (const a of Object.values(K.actions)) a.stop();
  for (const name of [...ATTACKS, ...BLOCKS]) {
    const a = K.actions[name]; if (!a) continue;
    const d = a.getClip().duration; a.reset().play();
    let best = 0, bt = d * 0.45, hi = -Infinity, ht = d * 0.35;
    for (let f = 0; f <= 60; f++) {
      const t = d * f / 60;
      K.mixer.setTime(t); K.model.updateMatrixWorld(true);
      hand.getWorldPosition(p);
      if (f > 0) { const v = p.distanceTo(q); if (v > best && t < d * 0.8) { best = v; bt = t; } }
      if (p.y > hi && t < d * 0.7) { hi = p.y; ht = t; }
      q.copy(p);
    }
    out[name] = ATTACKS.includes(name) ? bt : ht;
    a.stop();
  }
  K._cur = null;
  return out;
}

export async function buildBattle(root, ctx) {
  const { SMALL, rand, fire, tex, daimyoAt, cameraAt } = ctx;
  const updates = [];
  const T = { now: 0 };

  // ---------------------------------------------------------------- the field: where the pairs fight
  // (placed in the gaps of the stop's view: between the horse and the daimyo, at the left edge, above the text)
  const DUELS = SMALL ? [V(-4.4, 0, -13.6)] : [V(-4.4, 0, -13.6), V(-6.9, 0, -12.8), V(-0.2, 0, -17.0)];
  const LANE = -25.5; // the riders' lane, kept clear
  const pairs = [];
  const want = SMALL ? 20 : 56;
  for (let tries = 0; pairs.length < want && tries < 4000; tries++) {
    const x = -24 + rand() * 44, z = -14 - rand() * 24;
    if (Math.hypot(x - daimyoAt.x, z - daimyoAt.z) < 4.2) continue;
    if (Math.abs(x) < 1.6 && z > -16) continue;                       // the road up to him
    if (!SMALL && Math.abs(z - LANE) < 1.9) continue;
    if (DUELS.some(d => Math.hypot(x - d.x, z - d.z) < 3.0)) continue;
    if (pairs.some(p => Math.hypot(x - p.x, z - p.z) < 2.3)) continue;
    pairs.push({ x, z, yaw: (rand() - 0.5) * 1.3 });
  }

  // ---------------------------------------------------------------- squads (instanced, skinned, animated)
  const tintB = new THREE.Color("#6d6f86"); // the far enemy, a shade darker
  const squads = [];
  const makeSquad = async (url, height, side, seq, level, list, { cast = false, tint = null, run = null } = {}) => {
    if (!list.length) return;
    const K = await loadCharacter(url, clips([...seq, "great_sword_idle"]), height, { weapons: ["drawn", "sashimono"] });
    const mats = [], skinned = [];
    K.model.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
    K.model.updateMatrixWorld(true);
    const meshes = skinned.map(s => {
      const m = new InstancedSkinned(lodGeo(s.geometry, level), s.material, s.skeleton, s.bindMatrix, list.length);
      m.castShadow = cast; m.receiveShadow = true;
      if (tint) list.forEach((_, i) => m.setColorAt(i, tint));
      root.add(m); return m;
    });
    const parts = []; // the weapons and back flags, riding the bones
    for (const w of K.weapons) w.traverse(o => {
      if (!o.isMesh) return;
      const tris = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
      if (tris < 200 || (tris > 2000 && tris < 5000)) return; // the fittings, the sheath (3,100)
      const far = farPart(o);
      const im = new THREE.InstancedMesh(far.geometry, far.material, list.length);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.frustumCulled = false; im.castShadow = cast;
      if (tint) list.forEach((_, i) => im.setColorAt(i, tint));
      root.add(im); parts.push({ src: o, im });
    });
    let i = Math.floor(rand() * seq.length), next = 0;
    const lead = rand() * 3;
    const S = { K, list, meshes, parts, seq, run, step(t) {
      if (t >= next) { const d = act(K, seq[i % seq.length], { fade: 0.25 }); next = t + d - 0.25; i++; }
    } };
    K.mixer.update(lead);
    squads.push(S);
  };
  const near = p => Math.hypot(p.x - cameraAt.x, p.z - cameraAt.z) < (SMALL ? 0 : 17);
  // each pair: the daimyo's man on the near side facing away, the enemy facing him
  const slots = { kitA: [[], [], [], []], kitB: [[], [], [], []], ashA: [[], [], [], []], ashB: [[], [], [], []] };
  pairs.forEach((p, k) => {
    const dx = Math.sin(p.yaw), dz = -Math.cos(p.yaw); // A looks along (dx, dz)
    const g = k % 4, h = (k + 1 + (k >> 2)) % 4;
    const nearOne = near(p);
    (nearOne ? slots.kitA : slots.ashA)[g].push({ x: p.x - dx * 0.85, z: p.z - dz * 0.85, yaw: Math.atan2(dx, dz), ph: rand() * 6.3, s: 0.96 + rand() * 0.08 });
    (nearOne ? slots.kitB : slots.ashB)[h].push({ x: p.x + dx * 0.85, z: p.z + dz * 0.85, yaw: Math.atan2(-dx, -dz), ph: rand() * 6.3, s: 0.96 + rand() * 0.08 });
  });
  // (phones: the squads past the first two groups go to them)
  if (SMALL) for (let g = 2; g < 4; g++) for (const k in slots) slots[k][g % 2].push(...slots[k][g]);
  const groups = SMALL ? 2 : 4;
  const loads = [];
  for (let g = 0; g < groups; g++) {
    loads.push(makeSquad("models/kit_samurai.glb", 1.8, 0, SEQS[g], 2, slots.kitA[g]));
    loads.push(makeSquad("models/kit_ashigaru.glb", 1.76, 1, SEQS[(g + 2) % 4], 2, slots.kitB[g]));
    loads.push(makeSquad("models/ashigaru_simple.glb", 1.74, 0, SEQS[(g + 1) % 4], 2, slots.ashA[g]));
    loads.push(makeSquad("models/ashigaru_simple.glb", 1.74, 1, SEQS[(g + 3) % 4], 2, slots.ashB[g], { tint: tintB }));
  }
  // runners: fresh men pouring in from the enemy's rear, and the daimyo's from the left
  if (!SMALL) {
    const runB = [], runA = [];
    for (let i = 0; i < 9; i++) runB.push({ x: -14 + rand() * 26, z: -40 - rand() * 8, yaw: 0, ph: rand() * 6.3, s: 1, speed: 4.2 + rand() * 0.8 });
    for (let i = 0; i < 6; i++) runA.push({ x: -22 - rand() * 4, z: -15 - rand() * 9, yaw: Math.PI * 0.62, ph: rand() * 6.3, s: 1, speed: 4.4 + rand() * 0.6 });
    loads.push(makeSquad("models/ashigaru_simple.glb", 1.74, 1, ["great_sword_run"], 2, runB, { tint: tintB, run: { from: -48, to: -27, axis: "z", dir: 1 } }));
    loads.push(makeSquad("models/ashigaru_simple.glb", 1.74, 0, ["great_sword_run"], 2, runA, { run: { from: -26, to: -11, axis: "x", dir: 1 } }));
  }

  // ---------------------------------------------------------------- duelists (live, choreographed)
  const duels = [];
  const loadDuel = async (c, k) => {
    const [a, b] = await Promise.all([
      loadCharacter("models/kit_samurai.glb", clips(DUEL), 1.8, { weapons: ["drawn", "sashimono"] }),
      loadCharacter("models/kit_ashigaru.glb", clips(DUEL), 1.76, { weapons: ["drawn", "sashimono"] }),
    ]);
    const yaw = [1.25, -1.1, 1.4][k] || 0; // side-on to the camera, so the swings read
    const dx = Math.sin(yaw) * 0.88, dz = -Math.cos(yaw) * 0.88;
    a.model.position.set(c.x - dx, 0, c.z - dz); a.model.rotation.y = Math.atan2(dx, dz);
    b.model.position.set(c.x + dx, 0, c.z + dz); b.model.rotation.y = Math.atan2(-dx, -dz);
    for (const K of [a, b]) {
      if (k > 0) K.model.traverse(o => { if (o.isSkinnedMesh) o.geometry = lodGeo(o.geometry, 1); });
      K.keys = keyTimes(K);
      K.model.traverse(o => { if (o.isMesh) o.castShadow = !SMALL; });
      act(K, "great_sword_idle", { once: false, fade: 0 });
      root.add(K.model);
    }
    duels.push({ m: [a, b], next: 0.5 + k * 0.7, turn: k % 2, killAt: 14 + k * 9 + rand() * 6, dead: -1 });
  };
  loads.push(...DUELS.map(loadDuel));

  // one exchange: the attacker's blade lands just as the defender's guard comes up (or as he's hit)
  const queue = [];
  const later = (at, fn) => queue.push({ at, fn });
  const exchange = (D, t) => {
    const att = D.m[D.turn], def = D.m[1 - D.turn];
    const atk = pick(rand, ATTACKS), hitT = att.keys[atk] ?? 0.5;
    const kill = t >= D.killAt;
    const r = rand();
    const kind = kill ? "death" : r < 0.68 ? "block" : "hit";
    const dclip = kind === "death" ? pick(rand, DEATHS) : kind === "hit" ? pick(rand, HITS) : pick(rand, BLOCKS);
    const key = kind === "block" ? (def.keys[dclip] ?? 0.3) : 0.1;
    let ta = t, td = t + hitT - key;
    if (td < t) { ta += t - td; td = t; }
    const da = att.actions[atk].getClip().duration, dd = def.actions[dclip].getClip().duration;
    later(ta, () => act(att, atk));
    later(td, () => act(def, dclip));
    const end = Math.max(ta + da, td + dd);
    later(ta + da - 0.2, () => act(att, "great_sword_idle", { once: false, fade: 0.3 }));
    if (kind === "death") {
      D.killAt = Infinity;
      // he lies there a while, then gets back up (the fall played backwards) and fights on
      const up = end + 6 + rand() * 3;
      later(up, () => act(def, dclip, { scale: -1.15, from: dd, fade: 0.05 }));
      later(up + dd / 1.15 - 0.15, () => act(def, "great_sword_idle", { once: false, fade: 0.3 }));
      D.next = up + dd / 1.15 + 0.4;
      D.killAt = D.next + 16 + rand() * 14;
    } else {
      later(td + dd - 0.2, () => act(def, "great_sword_idle", { once: false, fade: 0.3 }));
      D.next = end + 0.15 + rand() * 0.6;
    }
    // mostly they take turns; sometimes one presses on
    D.turn = rand() < 0.7 ? 1 - D.turn : D.turn;
  };

  // ---------------------------------------------------------------- the fallen
  const bodies = [];
  const bakeFallen = async () => {
    const out = [];
    for (const [url, h] of [["models/kit_ashigaru.glb", 1.76], ["models/ashigaru_simple.glb", 1.74]]) {
      const K = await loadCharacter(url, clips(DEATHS), h, { weapons: false });
      for (const n of DEATHS) {
        const d = act(K, n, { fade: 0 }); K.mixer.setTime(d - 0.02); K.model.updateMatrixWorld(true);
        out.push(bakePose(K.model));
        for (const a of Object.values(K.actions)) a.stop(); K._cur = null;
      }
    }
    return out;
  };
  loads.push(bakeFallen().then(poses => {
    const lists = poses.map(() => []);
    for (let i = 0; i < (SMALL ? 6 : 14); i++) {
      const x = -22 + rand() * 40, z = -13 - rand() * 26;
      if (Math.hypot(x - daimyoAt.x, z - daimyoAt.z) < 3.4 || (Math.abs(x) < 1.4 && z > -16) || DUELS.some(d => Math.hypot(x - d.x, z - d.z) < 2.2)) continue;
      lists[i % poses.length].push({ x, z, yaw: rand() * 6.28, s: 0.97 + rand() * 0.06 });
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = V(0, 1, 0);
    poses.forEach((parts, k) => {
      const mats = lists[k].map(it => new THREE.Matrix4().compose(V(it.x, 0, it.z), q.setFromAxisAngle(up, it.yaw), V(it.s, it.s, it.s)));
      for (const part of parts) placeInstances(root, part.geometry, part.material, mats, { cast: false, cell: 200, levels: mats.map(() => 2) });
    });
  }));

  // ---------------------------------------------------------------- arrows
  const arrowGeo = (() => {
    const shaft = new THREE.CylinderGeometry(0.012, 0.012, 1.1, 4); shaft.rotateX(Math.PI / 2);
    const head = new THREE.ConeGeometry(0.03, 0.12, 4); head.rotateX(Math.PI / 2); head.translate(0, 0, 0.6);
    const f1 = new THREE.PlaneGeometry(0.06, 0.16); f1.rotateX(Math.PI / 2); f1.translate(0, 0, -0.5);
    const f2 = f1.clone(); f2.rotateZ(Math.PI / 2);
    const parts = [shaft, head, f1, f2].map(g => g.toNonIndexed());
    for (const g of parts) g.deleteAttribute("uv");
    const n = parts.reduce((s, g) => s + g.attributes.position.count, 0);
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3); let o = 0;
    for (const g of parts) { P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; }
    const out = new THREE.BufferGeometry(); out.setAttribute("position", new THREE.BufferAttribute(P, 3)); out.setAttribute("normal", new THREE.BufferAttribute(N, 3));
    return out;
  })();
  const NA = SMALL ? 40 : 110;
  const arrows = new THREE.InstancedMesh(arrowGeo, new THREE.MeshStandardMaterial({ color: "#2b231d", roughness: 0.8, side: THREE.DoubleSide }), NA);
  arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage); arrows.frustumCulled = false;
  root.add(arrows);
  const flights = Array.from({ length: NA }, () => ({ live: false, stuck: -1 }));
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < NA; i++) arrows.setMatrixAt(i, zero);
  let nextVolley = 1.5, volleySide = 0, ai = 0;
  const volley = t => {
    const n = SMALL ? 16 : 46;
    for (let k = 0; k < n; k++) {
      const f = flights[ai]; ai = (ai + 1) % NA;
      const fromUs = volleySide === 0;
      f.p0 = fromUs ? V(-10 + rand() * 18, 2, 12 + rand() * 8) : V(-16 + rand() * 30, 2, -52 - rand() * 8);
      f.p1 = fromUs ? V(-18 + rand() * 32, 0, -27 - rand() * 14) : V(-15 + rand() * 24, 0, -14 - rand() * 10);
      f.h = 13 + rand() * 5; f.t0 = t + rand() * 0.7; f.dur = 2.8 + rand() * 0.5; f.live = true; f.stuck = -1;
    }
    volleySide = 1 - volleySide;
  };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3(0.9, 0.9, 0.9), _z = new THREE.Vector3(0, 0, 1);
  const flyArrows = t => {
    if (t >= nextVolley) { volley(t); nextVolley = t + 5.5; }
    for (let i = 0; i < NA; i++) {
      const f = flights[i];
      if (!f.live) continue;
      let u = (t - f.t0) / f.dur;
      if (u < 0) { arrows.setMatrixAt(i, zero); continue; }
      let sink = 0;
      if (u >= 1) { if (f.stuck < 0) f.stuck = t; u = 1; sink = 0.35; if (t - f.stuck > 3.5) { f.live = false; arrows.setMatrixAt(i, zero); continue; } }
      _p.lerpVectors(f.p0, f.p1, u); _p.y += 4 * f.h * u * (1 - u);
      _v.subVectors(f.p1, f.p0); _v.y += 4 * f.h * (1 - 2 * u);
      _q.setFromUnitVectors(_z, _v.normalize());
      if (sink) _p.addScaledVector(_v, sink);
      arrows.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    arrows.instanceMatrix.needsUpdate = true;
  };

  // ---------------------------------------------------------------- fires, smoke columns, dust
  const flames = [];
  const smokeTex = tex("tex/smoke.png");
  const FIRES = SMALL ? [V(-13, 0, -31)] : [V(-13, 0, -31), V(11, 0, -34), V(-3, 0, -41), V(17, 0, -22)];
  FIRES.forEach((p, i) => flames.push(fire(root, p.x, 0, p.z, 2.2, { light: i === 0 && !SMALL, intensity: 22, distance: 18 })));
  const smoke = [];
  const PUFFS = SMALL ? 4 : 6;
  for (const p of FIRES) for (let k = 0; k < PUFFS; k++) {
    // (not fogged: columns of smoke stand up out of the haze, the way they do far off)
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: "#6f6a68", transparent: true, depthWrite: false, opacity: 0, fog: false }));
    root.add(s); smoke.push({ s, p, ph: k / PUFFS, spin: rand() * 6 });
  }
  const dust = [];
  for (let k = 0; k < (SMALL ? 6 : 14); k++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: "#b3a58f", transparent: true, depthWrite: false, opacity: 0 }));
    root.add(s); dust.push({ s, t0: -rand() * 3, dur: 2.2 + rand() * 1.4, at: null });
  }
  const air = t => {
    for (const k of smoke) {
      const u = (t * 0.055 + k.ph) % 1;
      k.s.position.set(k.p.x + u * u * 7, 1.2 + u * 17, k.p.z - u * 2);
      const sc = 2.2 + u * 9; k.s.scale.set(sc, sc, 1);
      k.s.material.opacity = Math.sin(Math.PI * Math.min(1, u * 1.15)) * 0.3;
      k.s.material.rotation = k.spin + u * 0.6;
    }
    for (const d of dust) {
      let u = (t - d.t0) / d.dur;
      if (u >= 1 || !d.at) { const p = pairs.length ? pick(rand, pairs) : { x: 0, z: -20 }; d.at = V(p.x + (rand() - 0.5) * 2, 0, p.z + (rand() - 0.5) * 2); d.t0 = t; u = 0; }
      d.s.position.set(d.at.x + u * 0.8, 0.3 + u * 0.9, d.at.z);
      const sc = 0.8 + u * 3.2; d.s.scale.set(sc, sc * 0.7, 1);
      d.s.material.opacity = Math.sin(Math.PI * u) * 0.35;
    }
  };

  // ---------------------------------------------------------------- riders galloping across
  const riders = [];
  if (!SMALL) loads.push((async () => {
    const [h1, h2, r1, r2] = await Promise.all([loadProp("models/war_horse_rigged.glb", 2.25), loadProp("models/war_horse_rigged.glb", 2.25),
      loadCharacter("models/kit_samurai.glb", clips(["great_sword_idle"]), 1.8, { weapons: ["drawn", "sashimono"] }),
      loadCharacter("models/kit_ashigaru.glb", clips(["great_sword_idle"]), 1.76, { weapons: ["drawn", "sashimono"] })]);
    const SEAT = V(0, 1.52, -0.13); // the saddle on the horse at 2.25 m (as in the fortress)
    [[h1, r1, 0], [h2, r2, 5.5]].forEach(([h, r, delay]) => {
      const g = gallop(h); // turns the horse to face +x
      r.mixer.setTime(0.4);
      const hip = poseAstride(r.model);
      const seat = new THREE.Group();
      for (const part of bakePose(r.model)) { const m = new THREE.Mesh(lodGeo(part.geometry, 1), part.material); m.castShadow = true; seat.add(m); }
      seat.position.set(SEAT.z, SEAT.y - hip, 0); seat.rotation.y = Math.PI / 2; // facing +x, a little back of the withers
      const rig = new THREE.Group(); rig.add(h, seat);
      root.add(rig);
      riders.push({ rig, seat, g, delay, z: LANE + (delay ? 1.1 : -0.7), y0: seat.position.y });
    });
  })());

  await Promise.all(loads);

  // the squads' copies: placed where they stand, swaying in and out of the fight (runners run)
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3(), up = V(0, 1, 0);
  const placeSquad = (S, t, dt) => {
    S.list.forEach((it, i) => {
      let x = it.x, z = it.z;
      if (S.run) {
        it.u = ((it.u ?? rand()) + dt * it.speed / (S.run.to - S.run.from)) % 1;
        if (S.run.axis === "z") z = S.run.from + it.u * (S.run.to - S.run.from); else x = S.run.from + it.u * (S.run.to - S.run.from);
      } else {
        const k = 0.28 * Math.sin(t * 0.55 + it.ph);
        x += Math.sin(it.yaw) * k; z += Math.cos(it.yaw) * k;
      }
      q.setFromAxisAngle(up, it.yaw); pos.set(x, 0, z); sc.setScalar(it.s);
      m4.compose(pos, q, sc);
      for (const m of S.meshes) m.setMatrixAt(i, m4);
      for (const p of S.parts) p.im.setMatrixAt(i, _m.multiplyMatrices(m4, p.src.matrixWorld));
    });
    for (const m of S.meshes) m.instanceMatrix.needsUpdate = true;
    for (const p of S.parts) p.im.instanceMatrix.needsUpdate = true;
  };

  return {
    // new meshes were added after the world was first gathered: the portal needs their materials
    dirty: true,
    riders,
    arrive() { if (duels[0]) duels[0].killAt = Math.min(duels[0].killAt, T.now + 2.5); },
    update(dt, t) {
      T.now = t;
      for (const S of squads) { S.step(t); S.K.mixer.update(dt); S.K.model.updateMatrixWorld(true); placeSquad(S, t, dt); }
      for (const D of duels) if (t >= D.next) { D.next = Infinity; exchange(D, t); }
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].at <= t) { const f = queue[i].fn; queue.splice(i, 1); f(); }
      for (const D of duels) for (const K of D.m) K.mixer.update(dt);
      flyArrows(t); air(t);
      for (const f of flames) f(dt, t);
      for (const R of riders) {
        const span = 110, speed = 9.5, cycle = span / speed + 6;
        const u = ((t + R.delay) % cycle) * speed;
        const x = -55 + u;
        R.rig.visible = u < span;
        R.rig.position.set(x, 0, R.z);
        R.seat.position.y = R.y0 + R.g(dt, speed);
      }
    },
  };
}

// The game's horse gait (horse_rig.gd), cut down to a gallop: each leg swings and folds on its own
// beat, the head nods with the stride. Turns the horse to face +x.
function gallop(horse) {
  const norm = n => n.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const B = {}; let skelRoot = null;
  horse.traverse(o => { if (o.isBone) { B[norm(o.name)] = o; if (!o.parent.isBone) skelRoot = o; } });
  const LEGS = [
    ["tripo0leftlimb0", "tripo0leftlimb1", "tripo0leftlimb2", "tripo0leftlimb3"],
    ["tripo0rightlimb0", "tripo0rightlimb1", "tripo0rightlimb2", "tripo0rightlimb3"],
    ["bone44", "bone45", "bone46", "bone47"],
    ["tripo1rightlimb0", "tripo1rightlimb1", "tripo1rightlimb2", "tripo1rightlimb3"],
  ];
  const HOOF = ["tripo0leftlimb4", "tripo0rightlimb4", "bone48", "tripo1rightlimb4"];
  // the rest pose, and each bone's own axes for the skeleton's X (pitch, the rig faces +Z)
  const rest = new Map(), ax = new Map();
  const walk = (b, parentQ) => {
    const g = parentQ.clone().multiply(b.quaternion);
    rest.set(b, b.quaternion.clone());
    ax.set(b, new THREE.Vector3(1, 0, 0).applyQuaternion(g.clone().invert()).normalize());
    for (const c of b.children) if (c.isBone) walk(c, g);
  };
  if (skelRoot) walk(skelRoot, new THREE.Quaternion());
  // the fore hoof's weights that Tripo tied to the hind leg (horse_rig.gd _fix_weights)
  horse.traverse(o => {
    if (!o.isSkinnedMesh) return;
    const lods = o.geometry.userData.lods;
    o.geometry = o.geometry.clone(); o.geometry.userData = { lods }; // (clone() would turn the LOD lists into plain objects)
    const bones = o.skeleton.bones.map(b => norm(b.name));
    const full = [0, 1, 2, 3].map(l => [...LEGS[l], HOOF[l]]);
    const where = bones.map(n => { for (let l = 0; l < 4; l++) { const j = full[l].indexOf(n); if (j >= 0) return [l, j]; } return null; });
    const idxOf = (l, j) => bones.indexOf(full[l][j]);
    const P = o.geometry.attributes.position, S = o.geometry.attributes.skinIndex;
    for (let i = 0; i < P.count; i++) {
      if (P.getY(i) > 0.4) continue;
      const wantLeg = (P.getX(i) > 0 ? 0 : 1) + (P.getZ(i) > -0.08 ? 0 : 2);
      for (let k = 0; k < 4; k++) {
        const w = where[S.getComponent(i, k)];
        if (w && w[0] !== wantLeg) { const n = idxOf(wantLeg, w[1]); if (n >= 0) S.setComponent(i, k, n); }
      }
    }
    S.needsUpdate = true;
    o.geometry = lodGeo(o.geometry, 1); // it crosses far off in the fog
  });
  const legLen = (() => {
    horse.updateMatrixWorld(true);
    const a = B[LEGS[0][0]], h = B[HOOF[0]];
    return a && h ? a.getWorldPosition(new THREE.Vector3()).distanceTo(h.getWorldPosition(new THREE.Vector3())) : 0.9;
  })();
  horse.rotation.y = Math.PI; // the model faces -x
  const G = { hz: 2.0, duty: 0.32, off: [0.52, 0.64, 0.0, 0.1], lift: 1.15 };
  const SP = ["tripospine2", "tripospine3", "tripospine6", "tripospine7", "tripohead0"].map(n => B[n]);
  let cycle = Math.random();
  const qa = new THREE.Quaternion();
  const add = (b, a) => { if (b) b.quaternion.multiply(qa.setFromAxisAngle(ax.get(b), a)); };
  return (dt, v) => {
    cycle = (cycle + G.hz * dt) % 1;
    for (const [b, q] of rest) b.quaternion.copy(q);
    const amp = Math.asin(THREE.MathUtils.clamp(v * G.duty / G.hz / (2 * legLen), 0.05, 0.62));
    for (let leg = 0; leg < 4; leg++) {
      const p = ((cycle - G.off[leg]) % 1 + 1) % 1;
      let sw, lift = 0;
      if (p < G.duty) sw = amp * (1 - 2 * p / G.duty);
      else { const s = (p - G.duty) / (1 - G.duty), e = s * s * (3 - 2 * s); sw = amp * (-1 + 2 * e); lift = Math.sin(Math.PI * s) * G.lift; }
      if (leg >= 2) sw *= 0.92;
      const c = LEGS[leg].map(n => B[n]);
      if (leg < 2) { add(c[0], -sw - lift * 0.18); add(c[1], -lift * 0.25); add(c[2], lift * 1.35); add(c[3], lift * 0.55 + sw * 0.75); }
      else { add(c[0], -sw - lift * 0.35); add(c[1], lift * 0.4); add(c[2], -lift * 0.45); add(c[3], lift * 0.5 + sw * 0.75); }
    }
    const nod = 0.13 * Math.sin(Math.PI * 2 * cycle), pitch = 0.05 * Math.sin(Math.PI * 2 * (cycle - 0.3)), neck = 0.16;
    add(SP[0], -pitch * 0.6); add(SP[1], -pitch * 0.6);
    add(SP[2], neck * 0.5 + nod * 0.5); add(SP[3], neck * 0.5 + nod * 0.3); add(SP[4], -neck * 0.6 + nod * 0.4);
    return 0.06 * Math.sin(Math.PI * 4 * cycle); // the rider's bob in the saddle
  };
}
