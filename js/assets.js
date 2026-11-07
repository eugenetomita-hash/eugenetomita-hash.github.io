// Loads the game models and plays Mixamo animations on them.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

const gltf = new GLTFLoader();
const fbx = new FBXLoader();
const cache = new Map();

// sharper textures at grazing angles (ground, walls, roofs seen from a walking height)
const sharpen = g => {
  g.scene.traverse(o => {
    if (!o.material) return;
    for (const m of [].concat(o.material)) for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap"])
      if (m[k]) m[k].anisotropy = 8;
  });
  return g;
};

// Level-of-detail index lists made offline by tools/lod (Godot's simplifier), beside the GLB as
// <x>.lod.json + <x>.lod.bin. They index the GLB's own vertices, so a coarser copy only swaps the index.
let lodIndex = null;
async function withLods(url, g) {
  lodIndex ||= fetch("models/lod-index.json").then(r => r.ok ? r.json() : []).catch(() => []);
  if (!(await lodIndex).includes(url)) return g;
  const base = url.slice(0, -4);
  const [meta, bin] = await Promise.all([fetch(base + ".lod.json").then(r => r.json()), fetch(base + ".lod.bin").then(r => r.arrayBuffer())]);
  g.scene.traverse(o => {
    const a = o.isMesh && g.parser.associations.get(o);
    const e = a && a.primitives !== undefined && meta.prims[a.meshes + "," + a.primitives];
    if (e) o.geometry.userData.lods = e.map(([off, n, b]) => b === 2 ? new Uint16Array(bin, off, n) : new Uint32Array(bin, off, n));
  });
  return g;
}

// The same geometry drawn with a coarser index (level 0 = as loaded). Shares the vertex buffers.
export function lodGeo(geo, level) {
  const L = geo.userData.lods;
  if (!level || !L || !L.length) return geo;
  const k = Math.min(level, L.length);
  const c = geo.userData.lodGeo ||= {};
  if (!c[k]) {
    const g = new THREE.BufferGeometry();
    for (const n in geo.attributes) g.setAttribute(n, geo.attributes[n]);
    g.setIndex(new THREE.BufferAttribute(L[k - 1], 1));
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    g.boundingSphere = geo.boundingSphere.clone();
    c[k] = g;
  }
  return c[k];
}

// Many copies of one mesh. mats: Matrix4[] (in parent space). Copies are grouped by level of detail
// (lod.dist(x, z) from the walking path: under lod.near full detail, under lod.far level 1, past it level 2)
// and by a square cell, so a group off screen is skipped as a whole.
// With lod.budget (a world's triangle budget, from lodBudget) the copies are only collected here and
// placed by its finish(), which picks every copy's level so the whole world fits.
export function placeInstances(parent, geometry, material, mats, { lod, cell = 16, cast = false, receive = true, levels } = {}) {
  if (lod && lod.budget && !levels) { lod.budget.add(parent, geometry, material, mats, { lod, cell, cast, receive }); return []; }
  const groups = new Map(), p = new THREE.Vector3();
  mats.forEach((m, i) => {
    p.setFromMatrixPosition(m);
    const d = lod ? lod.dist(p.x, p.z) : 0;
    const level = levels ? levels[i] : !lod || d < lod.near ? 0 : d < lod.far ? 1 : 2;
    if (level < 0) return;
    const key = level + "|" + Math.floor(p.x / cell) + "," + Math.floor(p.z / cell);
    if (!groups.has(key)) groups.set(key, { level, list: [] });
    groups.get(key).list.push(m);
  });
  const out = [];
  for (const { level, list } of groups.values()) {
    const im = new THREE.InstancedMesh(lodGeo(geometry, level), material, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere();
    im.castShadow = cast; im.receiveShadow = receive;
    parent.add(im); out.push(im);
  }
  return out;
}

// A world's budget for its repeated meshes (crowds, scattered props, the game set's copies), in triangles.
// Every copy starts at full detail; then, smallest on screen first (its size over its distance from
// the walking path), copies drop a level until the total fits. Unique meshes aren't counted here.
export function lodBudget(limit) {
  const reqs = [];
  const tris = (g, level) => {
    if (level && g.userData.lods && g.userData.lods.length) return g.userData.lods[Math.min(level, g.userData.lods.length) - 1].length / 3;
    return (g.index ? g.index.count : g.attributes.position.count) / 3;
  };
  return {
    add(parent, geometry, material, mats, opts) { reqs.push({ parent, geometry, material, mats, opts }); },
    finish() {
      const all = [], p = new THREE.Vector3();
      let total = 0;
      for (const r of reqs) {
        if (!r.geometry.boundingSphere) r.geometry.computeBoundingSphere();
        const t = [0, 1, 2].map(l => tris(r.geometry, l));
        r.levels = r.mats.map(m => {
          p.setFromMatrixPosition(m);
          const size = r.geometry.boundingSphere.radius * m.getMaxScaleOnAxis();
          const d = r.opts.lod.dist(p.x, p.z);
          all.push({ r, i: all.length, e: size / Math.max(2, d), d, t });
          total += t[0];
          return 0;
        });
        let k = 0; for (const it of all) if (it.r === r) it.i = k++;
      }
      all.sort((a, b) => a.e - b.e);
      for (const level of [1, 2]) for (const it of all) {
        if (total <= limit) break;
        total -= it.t[level - 1] - it.t[level];
        it.r.levels[it.i] = level;
      }
      // still over at the coarsest level (leaf cards don't simplify): leave out far copies, smallest first
      for (const it of all) {
        if (total <= limit) break;
        if (it.d < it.r.opts.lod.far) continue;
        total -= it.t[2];
        it.r.levels[it.i] = -1;
      }
      for (const r of reqs) placeInstances(r.parent, r.geometry, r.material, r.mats, { ...r.opts, levels: r.levels });
      reqs.length = 0;
      return Math.round(total);
    },
  };
}

export function loadGLB(url) {
  if (!cache.has(url)) cache.set(url, gltf.loadAsync(url).then(sharpen).then(g => withLods(url, g)));
  return cache.get(url).then(g => SkeletonUtils.clone(g.scene));
}

// An animation file: its skeleton (in its rest pose) plus the clip.
const animCache = new Map();
function loadAnim(url) {
  if (!animCache.has(url)) animCache.set(url, fbx.loadAsync(url).then(root => {
    const bones = boneMap(root);
    const rest = {};
    for (const [n, b] of Object.entries(bones)) rest[n] = { q: b.quaternion.clone(), p: b.position.clone() };
    return { root, bones, rest, clip: root.animations[0] };
  }));
  return animCache.get(url);
}

function boneMap(root) {
  const m = {};
  root.traverse(o => { if (o.isBone && !(o.name in m)) m[o.name] = o; });
  return m;
}
const hipsOf = bones => Object.values(bones).find(b => /hips$/i.test(b.name));

// Length of the left thigh + shin bones, used to compare skeleton sizes.
function legLength(bones) {
  let n = 0;
  for (const b of Object.values(bones)) if (/(LeftLeg|LeftFoot)$/.test(b.name)) n += b.position.length();
  return n;
}

// Rotation of the hips' parent, measured from the character's own root (both face +Z there).
function frameOf(root, hips) {
  root.updateMatrixWorld(true);
  const r = new THREE.Quaternion(), p = new THREE.Quaternion();
  root.getWorldQuaternion(r);
  hips.parent.getWorldQuaternion(p);
  return r.invert().multiply(p);
}

// Body-space rotation of every bone, walking down from the hips.
function chainRotations(hips, frame, getLocal) {
  const out = {};
  const walk = (b, parentQ) => {
    const q = parentQ.clone().multiply(getLocal(b));
    out[boneName(b.name)] = q; // (by plain name: 'mixamorig:Hips', 'mixamorig_Hips' and 'mixamorigHips' are one bone)
    for (const c of b.children) if (c.isBone) walk(c, q);
  };
  walk(hips, frame);
  return out;
}

// Proper retarget: the model's joints point their axes differently from the Mixamo
// skeleton's, so copying rotations twists limbs. Instead, take how far each joint turned
// from its rest pose in the animation (in body space) and turn the model's joint the same way.
function retarget(anim, model) {
  const { root, bones: sB, rest, clip } = anim;
  const tB = boneMap(model);
  const sHips = hipsOf(sB), tHips = hipsOf(tB);
  if (!sHips || !tHips) return new THREE.AnimationClip(clip.name, clip.duration, []);

  const tRestLocal = {};
  for (const [n, b] of Object.entries(tB)) tRestLocal[n] = b.quaternion.clone();
  const tRestPos = tHips.position.clone();

  for (const [n, r] of Object.entries(rest)) { sB[n].quaternion.copy(r.q); sB[n].position.copy(r.p); }
  const sFrame = frameOf(root, sHips), tFrame = frameOf(model, tHips);
  const sRestW = chainRotations(sHips, sFrame, b => b.quaternion);
  const tRestW = chainRotations(tHips, tFrame, b => tRestLocal[b.name]);
  const sRestPos = rest[sHips.name].p.clone();
  const scale = legLength(tB) / (legLength(sB) || 1);

  // sample the animation at 30 fps on the source skeleton
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip); action.play();
  const fps = 30, frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frames);
  const qvals = {}; for (const n of Object.keys(tB)) qvals[n] = new Float32Array(frames * 4);
  const pvals = new Float32Array(frames * 3);
  const inv = new THREE.Quaternion(), d = new THREE.Quaternion(), loc = new THREE.Quaternion();

  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    mixer.setTime(t);
    const sW = chainRotations(sHips, sFrame, b => b.quaternion);
    const walk = (b, parentW) => {
      let w;
      const n = boneName(b.name);
      if (sW[n] && sRestW[n]) {
        d.copy(sW[n]).multiply(inv.copy(sRestW[n]).invert()); // how far it turned from rest
        w = d.clone().multiply(tRestW[n]);
      } else {
        w = parentW.clone().multiply(tRestLocal[b.name]);               // no data: keep rest
      }
      loc.copy(parentW).invert().multiply(w);
      loc.toArray(qvals[b.name], f * 4);
      for (const c of b.children) if (c.isBone) walk(c, w);
    };
    walk(tHips, tFrame);
    // hips: same up/down movement, scaled to the model; stay in place sideways
    const dy = (sHips.position.y - sRestPos.y) * scale;
    pvals[f * 3] = tRestPos.x; pvals[f * 3 + 1] = tRestPos.y + dy; pvals[f * 3 + 2] = tRestPos.z;
  }
  action.stop(); mixer.uncacheRoot(root);
  for (const [n, r] of Object.entries(rest)) { sB[n].quaternion.copy(r.q); sB[n].position.copy(r.p); }

  const tracks = [];
  const addTracks = b => { tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, qvals[b.name])); for (const c of b.children) if (c.isBone) addTracks(c); };
  addTracks(tHips);
  tracks.push(new THREE.VectorKeyframeTrack(`${tHips.name}.position`, times, pvals));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

// Scale an object so its height is `h` metres and its feet sit on y = 0.
export function fitHeight(obj, h) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const s = h / Math.max(1e-6, box.max.y - box.min.y);
  obj.scale.multiplyScalar(s);
  obj.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(obj);
  obj.position.y -= b2.min.y;
  return obj;
}

const clipFor = new Map();

// The game's weapons for a model, exported from model_rig.gd's placements:
// models/weapons/loadouts/<model>.json = [{ glb, bone, pos, quat, scale, set? }], each local to its bone.
// `set` (optional) names a variant, e.g. "drawn" or "sheathed"; a character asks for one with opts.weapons.
// loadouts/index.json lists the models that have one, so nobody asks for a file that isn't there.
const loadoutCache = new Map();
let loadoutIndex = null;
function loadout(url) {
  const name = url.split("/").pop().replace(/\.glb$/, "");
  loadoutIndex ||= fetch("models/weapons/loadouts/index.json").then(r => r.ok ? r.json() : []).catch(() => []);
  if (!loadoutCache.has(name)) loadoutCache.set(name, loadoutIndex.then(list =>
    list.includes(name) ? fetch(`models/weapons/loadouts/${name}.json`).then(r => r.ok ? r.json() : []).catch(() => []) : []));
  return loadoutCache.get(name);
}
const boneName = n => n.replace(/[^A-Za-z0-9]/g, "").replace(/^mixamorig\d*/i, "").toLowerCase();

// Hang the weapons on the bones. Done before any pose is baked, so crowds carry them too.
async function arm(model, url, which = "drawn") {
  let items = await loadout(url);
  if (!Array.isArray(items)) items = items.items || [];
  if (which === false) return [];
  items = items.filter(it => !it.set || !which || [].concat(which).includes(it.set));
  if (!items.length) return [];
  const bones = {};
  model.traverse(o => { if (o.isBone) bones[boneName(o.name)] = o; });
  const out = [];
  await Promise.all(items.map(async it => {
    const bone = bones[boneName(it.bone)];
    if (!bone) { console.warn("no bone", it.bone, "on", url); return; }
    const src = it.glb.startsWith("models/") ? it.glb : "models/" + it.glb.replace(/^\.?\//, "");
    const w = await loadGLB(src);
    if (it.pos) w.position.fromArray(it.pos);
    if (it.quat) w.quaternion.fromArray(it.quat);
    if (it.scale) Array.isArray(it.scale) ? w.scale.fromArray(it.scale) : w.scale.setScalar(it.scale);
    w.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    w.name = "weapon:" + (it.name || src.split("/").pop());
    bone.add(w);
    out.push(w);
  }));
  model.updateMatrixWorld(true);
  return out;
}

// A character with a mixer and named actions. Call .play(name) to cross-fade.
// opts.weapons: which loadout set(s) to hang on him (default "drawn"; untagged items always; false: none).
export async function loadCharacter(url, anims, height, opts = {}) {
  const model = await loadGLB(url);
  model.traverse(o => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
  });
  if (height) fitHeight(model, height); // measured in the rest pose, before any animation
  const weapons = await arm(model, url, opts.weapons);
  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const [name, u] of Object.entries(anims)) {
    // clones of one model share bone names, so one converted clip serves them all
    const key = url + "|" + u;
    if (!clipFor.has(key)) clipFor.set(key, retarget(await loadAnim(u), model));
    actions[name] = mixer.clipAction(clipFor.get(key));
  }
  let current = null;
  const play = (name, fade = 0.4, once = false) => {
    const a = actions[name];
    if (!a || a === current) return;
    a.reset();
    if (once) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    a.play();
    if (current) current.crossFadeTo(a, fade, false);
    current = a;
  };
  const first = Object.keys(actions)[0];
  if (first) { play(first, 0); mixer.update(0); }
  return { model, mixer, actions, play, weapons, get current() { return current; } };
}

// Freeze a posed character into plain meshes, so a crowd can be drawn as instances.
// Returns [{ geometry, material }] in the model's own (scaled) space, feet on y = 0.
export function bakePose(model) {
  const keep = { p: model.position.clone(), r: model.rotation.clone() };
  model.position.set(0, model.position.y, 0); model.rotation.set(0, 0, 0);
  model.updateMatrixWorld(true);
  const out = [];
  const m4 = new THREE.Matrix4(), acc = new THREE.Matrix4(), toWorld = new THREE.Matrix4(), nm = new THREE.Matrix3();
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  model.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry, pos = g.attributes.position, nor = g.attributes.normal;
    const P = new Float32Array(pos.count * 3), N = new Float32Array(pos.count * 3);
    if (o.isSkinnedMesh) {
      o.skeleton.update();
      const bm = o.skeleton.boneMatrices, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      for (let i = 0; i < pos.count; i++) {
        acc.elements.fill(0);
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k); if (!w) continue;
          m4.fromArray(bm, si.getComponent(i, k) * 16);
          for (let e = 0; e < 16; e++) acc.elements[e] += m4.elements[e] * w;
        }
        toWorld.copy(o.matrixWorld).multiply(o.bindMatrixInverse).multiply(acc).multiply(o.bindMatrix);
        v.fromBufferAttribute(pos, i).applyMatrix4(toWorld); v.toArray(P, i * 3);
        if (nor) { nm.getNormalMatrix(toWorld); n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); n.toArray(N, i * 3); }
      }
    } else {
      nm.getNormalMatrix(o.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); v.toArray(P, i * 3);
        if (nor) { n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); n.toArray(N, i * 3); }
      }
    }
    const b = new THREE.BufferGeometry();
    b.setAttribute("position", new THREE.BufferAttribute(P, 3));
    if (nor) b.setAttribute("normal", new THREE.BufferAttribute(N, 3)); else b.computeVertexNormals();
    if (g.attributes.uv) b.setAttribute("uv", g.attributes.uv);
    if (g.index) b.setIndex(g.index);
    if (g.userData.lods) b.userData.lods = g.userData.lods; // same vertex order, so the LOD lists still fit
    b.computeBoundingSphere();
    out.push({ geometry: b, material: o.material });
  });
  model.position.copy(keep.p); model.rotation.copy(keep.r);
  return out;
}

// Sit a standing character astride a horse, the way the game's rider script does it:
// thighs out and forward round the barrel, shins hanging a little back, hands forward on the reins.
// Call after the animation has been set; directions are in the character's own frame (+z ahead, +x its left).
export function poseAstride(model) {
  const keepR = model.rotation.clone(), keepP = model.position.clone();
  model.rotation.set(0, 0, 0); model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  const bones = boneMap(model);
  const find = n => Object.values(bones).find(b => b.name.endsWith(n));
  const pos = b => b.getWorldPosition(new THREE.Vector3());
  // turn bone `b` so the line from it to `child` points along `dir`
  const aim = (b, child, dir) => {
    const cur = pos(child).sub(pos(b)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize());
    const wq = b.getWorldQuaternion(new THREE.Quaternion());
    const pq = b.parent.getWorldQuaternion(new THREE.Quaternion());
    b.quaternion.copy(pq.invert().multiply(q.multiply(wq)));
    b.updateMatrixWorld(true);
  };
  const keepWorld = (b, wq) => {
    const pq = b.parent.getWorldQuaternion(new THREE.Quaternion());
    b.quaternion.copy(pq.invert().multiply(wq)); b.updateMatrixWorld(true);
  };
  for (const [side, sgn] of [["Left", 1], ["Right", -1]]) {
    const up = find(side + "UpLeg"), knee = find(side + "Leg"), foot = find(side + "Foot");
    const arm = find(side + "Arm"), fore = find(side + "ForeArm"), hand = find(side + "Hand");
    if (up && knee && foot) {
      const fq = foot.getWorldQuaternion(new THREE.Quaternion());
      aim(up, knee, new THREE.Vector3(0.55 * sgn, -0.62, 0.5));
      aim(knee, foot, new THREE.Vector3(0.12 * sgn, -1.0, -0.22));
      keepWorld(foot, fq);
    }
    if (arm && fore && hand) {
      aim(arm, fore, new THREE.Vector3(0.18 * sgn, -0.85, 0.45));
      aim(fore, hand, new THREE.Vector3(-0.25 * sgn, -0.15, 1.0));
    }
  }
  const hips = find("Hips");
  const seat = hips ? pos(hips).y : 0;
  model.rotation.copy(keepR); model.position.copy(keepP);
  model.updateMatrixWorld(true);
  return seat; // height of the hips above the model's origin
}

// Draw many copies of a baked pose. list: [{ x, z, yaw, s }]
// lod: see placeInstances (far ones drawn coarser).
export function crowd(parent, parts, list, shadows = true, lod = null) {
  const q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const mats = list.map(it => {
    q.setFromAxisAngle(up, it.yaw || 0); p.set(it.x, it.y || 0, it.z); s.setScalar(it.s || 1);
    return new THREE.Matrix4().compose(p, q, s);
  });
  for (const part of parts) placeInstances(parent, part.geometry, part.material, mats, { lod, cast: shadows });
}

export async function loadProp(url, height) {
  const m = await loadGLB(url);
  m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  if (height) fitHeight(m, height);
  return m;
}
