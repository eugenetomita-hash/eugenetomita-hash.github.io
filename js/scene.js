// Six worlds joined by torii gates. Each gate shows the next world through its opening;
// walking through it puts you there. Every world is its own scene; they share one camera.
import * as THREE from "three";
import { WORLDS } from "./worlds.js?v=51";
import { createKuro } from "./kuro.js?v=51";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { Pass } from "three/addons/postprocessing/Pass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// the light version is for phones and small tablets (a touch screen under ~900 px on its short side),
// decided by the device, not the window: a narrow desktop window keeps the full look
const SMALL = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 900;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
// desktop: draw into a buffer, then soft bloom on fires and lanterns, a vignette and the tone mapping
const POST = !SMALL && !/[?&]nopost/.test(location.search);

// The torii's opening, measured from the model at 4.6 m tall (pillars and beam overlap the edges).
const OPEN_W = 2.66, OPEN_H = 3.12;

export async function createWorld(canvas, onProgress) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, SMALL ? 1.5 : 1.75));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !SMALL;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.autoClear = false;
  renderer.localClippingEnabled = true; // (Kurō, half through a gate, is cut at its plane)

  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 500);
  const ctx = { SMALL, REDUCED, renderer, POST };

  // Lay the worlds end to end: each one's entrance sits exactly on the previous gate,
  // turned to face the way you walk through it (a gate can face sideways: you turn into it).
  const UP = new THREE.Vector3(0, 1, 0);
  const worlds = WORLDS.map(W => ({ def: W, ready: false, scene: null, yaw: 0, matrix: new THREE.Matrix4() }));
  for (let i = 1; i < worlds.length; i++) {
    const prev = worlds[i - 1], cur = worlds[i].def, g = prev.def.gate, turn = prev.def.turn || 0;
    worlds[i].yaw = prev.yaw + turn;
    worlds[i].matrix.copy(prev.matrix)
      .multiply(new THREE.Matrix4().makeTranslation(g.x, g.y, g.z))
      .multiply(new THREE.Matrix4().makeRotationY(turn))
      .multiply(new THREE.Matrix4().makeTranslation(-cur.entry.x, -cur.entry.y, -cur.entry.z));
  }
  worlds.forEach((w, i) => {
    w.index = i;
    w.toGlobal = v => v.clone().applyMatrix4(w.matrix);
    w.poses = w.def.stops.map(s => ({ ...s, pos: w.toGlobal(s.pos), look: w.toGlobal(s.look) }));
    const ks = w.def.stops[0].kuro; // where Kurō stands at this stop, and who he faces
    if (ks) w.kuroStop = { at: w.toGlobal(ks.at), face: w.toGlobal(ks.face), act: ks.act, world: w };
    if (w.def.gate) {
      const g = w.def.gate, turn = w.def.turn || 0;
      const dir = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, turn); // the way you walk through, in local space
      const at = (along, y) => w.toGlobal(g.clone().addScaledVector(dir, along).setY(g.y + y));
      w.gatePos = w.toGlobal(g);
      w.gateDir = dir.clone().applyAxisAngle(UP, w.yaw);
      w.gateYaw = w.yaw + turn;
      // lining up in front of the gate, then the first step through it
      w.approach = { pos: at(-6.5, 1.6), look: at(12, 1.5) };
      w.through = { pos: at(1.2, 1.55), look: at(16, 1.45) };
      // Kurō walks a few steps ahead of you: up to the gate, then through it
      w.kuroApproach = at(-2.4, 0);
      w.kuroThrough = at(5.4, 0);
    }
  });
  // how far past a world's gate a point is (negative: still in front of it)
  const past = (w, p) => w.def.gate ? w.gateDir.dot(p.clone().sub(w.gatePos)) : -Infinity;

  // A world's materials (the portal pass switches their stencil test) and, for the pass seen through
  // a gate, the meshes it may skip. Gathered again when a world adds things after it opened.
  const gather = w => {
    w.materials = [];
    w.scene.traverse(o => {
      if (!o.material) return;
      for (const m of [].concat(o.material)) if (!w.materials.includes(m) && m !== (w.mask && w.mask.material)) w.materials.push(m);
    });
    w.cullList = null;
  };

  // Build a world: its own scene, sky, lights and the gate with its portal.
  const build = async (w, progress) => {
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.matrix.copy(w.matrix);
    scene.add(root);
    root.updateMatrixWorld(true);
    const api = await w.def.build({ ...ctx, scene, root, progress });
    w.scene = scene; w.root = root; w.api = api;
    // the portal surface sits in the gate's opening
    if (w.def.gate) {
      const g = w.def.gate;
      const mask = new THREE.Mesh(new THREE.PlaneGeometry(OPEN_W, OPEN_H), new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: false,
        stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
      }));
      mask.position.set(g.x, g.y + OPEN_H / 2 - 0.02, g.z);
      mask.rotation.y = w.def.turn || 0;
      mask.renderOrder = 10;
      root.add(mask);
      w.mask = mask;
    }
    w.gather = () => gather(w);
    gather(w);
    w.ready = true;
  };

  // The first two worlds load before the page opens; the rest load in the background, in order.
  let shown = 0;
  const report = n => { shown += n; onProgress && onProgress(Math.min(1, shown)); };
  await build(worlds[0], f => report(f * 0.55));
  await build(worlds[1], f => report(f * 0.45));
  onProgress && onProgress(1);
  (async () => {
    for (let i = 2; i < worlds.length; i++) {
      try { await build(worlds[i], () => {}); } catch (e) { console.error("world", i, e); }
    }
  })();

  return { renderer, camera, worlds, past, REDUCED, SMALL, POST };
}


export function startLoop(w, getTarget) {
  const { renderer, camera, worlds, past } = w;
  const clock = new THREE.Clock();
  const pos = new THREE.Vector3(), look = new THREE.Vector3();
  const mouse = { x: 0, y: 0 };
  addEventListener("pointermove", e => { mouse.x = e.clientX / innerWidth - 0.5; mouse.y = e.clientY / innerHeight - 0.5; }, { passive: true });
  const resize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.fov = innerWidth / innerHeight < 0.8 ? 58 : 40; // narrow screens: wider view keeps characters in frame
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  };
  addEventListener("resize", resize); resize();

  const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  const setStencil = (list, on) => {
    for (const m of list) {
      m.stencilWrite = on;
      m.stencilRef = 1;
      m.stencilFunc = on ? THREE.EqualStencilFunc : THREE.AlwaysStencilFunc;
      m.stencilZPass = THREE.KeepStencilOp;
    }
  };

  // Kurō loads after the page opens; until then the walk goes on without him
  let kuro = null;
  createKuro().then(k => { kuro = k; window.__kuro = k; }).catch(e => console.error("kuro", e));
  const back = new THREE.Plane(), kClip = [back];
  const kuroClip = list => { for (const m of kuro.mats) m.clippingPlanes = list; };

  let cur = 0, first = true, lastStop = null;
  const _ink = new THREE.Color();
  const tick = () => {
    const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
    const path = getTarget();
    const tgt = window.__camOverride || path; // __camOverride: for close-up checks from the console
    const k = first || w.REDUCED ? 1 : 1 - Math.exp(-dt * 3.2);
    first = false;
    pos.lerp(tgt.pos, k); look.lerp(tgt.look, k);
    camera.position.copy(pos);
    if (!w.REDUCED) { camera.position.x += mouse.x * 0.35; camera.position.y -= mouse.y * 0.18; }
    camera.lookAt(look);
    camera.updateMatrixWorld();

    // which world are we standing in? Walking past a gate moves you into the next one.
    const cp = camera.position;
    // (switch a hair before the gate, so the camera's near plane never cuts into the opening)
    // The worlds don't sit in a straight line (a gate can turn you back the way you came), so the
    // gate test is only trusted for the one gate you're walking through: the scroll says which world
    // you're heading for, and a jump of more than one world (a menu link) switches straight to it.
    const s = tgt.stop;
    if (s === undefined) {
      while (cur < worlds.length - 1 && past(worlds[cur], cp) > -0.2 && worlds[cur + 1].ready) cur++;
      while (cur > 0 && past(worlds[cur - 1], cp) <= -0.2) cur--;
    } else if (Math.abs(s - cur) > 1) {
      let j = s; while (j > 0 && !worlds[j].ready) j--;
      cur = j;
    } else {
      if (cur < s && worlds[cur + 1].ready && past(worlds[cur], cp) > -0.2) cur++;
      else if (cur > s && past(worlds[cur - 1], cp) <= -0.2) cur--;
      // arrived without passing through a gate (a jump): you're where the scroll says
      if (cur !== s && worlds[s].ready && cp.distanceTo(tgt.pos) < 1.5) cur = s;
    }
    const here = worlds[cur], next = worlds[cur + 1];
    window.__cur = cur;

    for (const x of worlds) if (x.ready && x.api.dirty) { x.api.dirty = false; x.gather(); }
    here.api.update(dt, t, camera, tgt);
    const showNext = next && next.ready && here.mask;
    if (showNext) next.api.update(dt, t, camera, tgt);

    if (tgt.stop !== lastStop) { lastStop = tgt.stop; for (const x of worlds) if (x.ready && x.api.arrive) x.api.arrive(tgt.stop); }
    if (kuro && path.kuro) kuro.update(dt, window.__kuroOverride || path, worlds, cur, past);

    if (printPass) {
      // the print's two inks follow the world you're in, and slip out of register as you pass a gate
      const U = printPass.uniforms, prev = worlds[cur - 1];
      const dNext = next && here.def.gate ? -past(here, cp) : Infinity;   // metres before the next gate
      const dPrev = prev ? past(prev, cp) : Infinity;                      // metres past the last one
      let a = here.def, b = here.def, k = 0;
      if (dNext < 6) { b = next.def; k = 0.5 * (1 - Math.max(0, dNext) / 6); }
      else if (dPrev < 4) { a = prev.def; k = 0.5 + 0.5 * dPrev / 4; }
      U.inkA.value.set(a.ink || "#22264b").lerp(_ink.set(b.ink || "#22264b"), k);
      U.paperA.value.set(a.paper || "#e6e3dc").lerp(_ink.set(b.paper || "#e6e3dc"), k);
      const near = Math.min(Math.abs(dNext), Math.abs(dPrev));
      U.wipe.value = Math.exp(-near * near / 2.2);
      U.t.value = t;
    }
    draw = () => drawFrame(here, next, showNext, cp, t);
    if (composer) composer.render(dt); else { renderer.setRenderTarget(null); draw(); }
  };
  renderer.setAnimationLoop(tick);
  window.__tick = tick; // one frame on demand, for checks while the page is in the background

  // Only the part of the next world seen through the gate's opening gets drawn: a frustum cut down
  // to the opening's rectangle on screen, and nothing on this side of the gate.
  const _c = new THREE.Vector3(), _fr = new THREE.Frustum(), _crop = new THREE.Matrix4(), _vp = new THREE.Matrix4(), _sph = new THREE.Sphere();
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector3(x * OPEN_W / 2, y * OPEN_H / 2, 0));
  const hidden = [];
  const cullNext = (here, next) => {
    let x0 = 1, x1 = -1, y0 = 1, y1 = -1;
    for (const k of corners) {
      _c.copy(k).applyMatrix4(here.mask.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      if (_c.z > -camera.near) return true;               // a corner behind the eye: draw it all
      _c.applyMatrix4(camera.projectionMatrix);
      x0 = Math.min(x0, _c.x); x1 = Math.max(x1, _c.x); y0 = Math.min(y0, _c.y); y1 = Math.max(y1, _c.y);
    }
    x0 = Math.max(x0, -1); x1 = Math.min(x1, 1); y0 = Math.max(y0, -1); y1 = Math.min(y1, 1);
    if (x0 >= x1 || y0 >= y1) return false;                // the opening is off screen
    const sx = 2 / (x1 - x0), sy = 2 / (y1 - y0);
    _crop.set(sx, 0, 0, -(x0 + x1) / (x1 - x0), 0, sy, 0, -(y0 + y1) / (y1 - y0), 0, 0, 1, 0, 0, 0, 0, 1);
    _fr.setFromProjectionMatrix(_vp.multiplyMatrices(_crop, camera.projectionMatrix).multiply(camera.matrixWorldInverse));
    if (!next.cullList) { next.cullList = []; next.scene.traverse(o => { if ((o.isMesh || o.isPoints) && o.frustumCulled && !o.isSkinnedMesh) next.cullList.push(o); }); }
    for (const o of next.cullList) {
      if (!o.visible) continue;
      const bs = o.isInstancedMesh ? (o.boundingSphere || o.computeBoundingSphere() || o.boundingSphere) : (o.geometry.boundingSphere || (o.geometry.computeBoundingSphere(), o.geometry.boundingSphere));
      _sph.copy(bs).applyMatrix4(o.matrixWorld);
      if (!_fr.intersectsSphere(_sph) || clip.distanceToPoint(_sph.center) < -_sph.radius) { o.visible = false; hidden.push(o); }
    }
    return true;
  };

  let draw = null;
  const drawFrame = (here, next, showNext, cp, t) => {
    renderer.clear(true, true, true);
    // Kurō is drawn in the world he stands in; stepping through a gate, in both, each cut at its plane
    let kHere = false, kNext = false;
    if (kuro) {
      const g = here.def.gate ? past(here, kuro.pos) : -Infinity;
      kHere = g < 0.8; kNext = showNext && g > -0.8;
      if (kHere) {
        here.scene.add(kuro.model);
        if (kNext) { back.normal.copy(here.gateDir).negate(); back.constant = here.gateDir.dot(here.gatePos); kuroClip(kClip); } else kuroClip(null);
      } else kuro.model.removeFromParent();
    }
    renderer.render(here.scene, camera);
    if (showNext) clip.normal.copy(here.gateDir), clip.constant = -here.gateDir.dot(here.gatePos);
    if (showNext && !cullNext(here, next)) showNext = false;
    if (showNext) {
      // only where the gate's opening is visible, and only what lies beyond it
      clip.normal.copy(here.gateDir); clip.constant = -here.gateDir.dot(here.gatePos);
      setStencil(next.materials, true);
      if (kNext) { next.scene.add(kuro.model); kuroClip(null); setStencil(kuro.mats, true); }
      if (next.mask) next.mask.visible = false;
      renderer.clippingPlanes = [clip];
      renderer.clearDepth();
      renderer.render(next.scene, camera);
      renderer.clippingPlanes = [];
      for (const o of hidden) o.visible = true;
      hidden.length = 0;
      if (next.mask) next.mask.visible = true;
      setStencil(next.materials, false);
      if (kNext) setStencil(kuro.mats, false);
    }
  };

  // the frame goes into a buffer (with stencil for the portal, and 4x MSAA), then the passes
  let composer = null, printPass = null;
  if (w.POST) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true, samples: 4 });
    rt.resolveDepthBuffer = rt.resolveStencilBuffer = false; // (copying those out costs ~10 ms a frame on ANGLE, and nothing reads them)
    composer = new EffectComposer(renderer, rt);
    composer.renderTarget2.dispose(); // the second buffer only takes the finished colour: no MSAA, no depth
    composer.renderTarget2 = composer.writeBuffer = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, depthBuffer: false });
    const scenePass = new Pass(); scenePass.needsSwap = false;
    scenePass.render = (r, writeBuffer, readBuffer) => { r.setRenderTarget(readBuffer); draw && draw(); };
    composer.addPass(scenePass);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.26, 0.5, 1.0));
    composer.addPass(new OutputPass());
    printPass = new ShaderPass(PRINT);
    composer.addPass(printPass);
    composer.setPixelRatio(renderer.getPixelRatio());
    const fit = () => { composer.setSize(innerWidth, innerHeight); renderer.getDrawingBufferSize(printPass.uniforms.res.value); };
    fit(); addEventListener("resize", fit);
  }
}

// The look of a print: ink lines where the picture changes sharply and a two-ink grade, kept sharp
// (no halftone, grain or doubled plates: those read as a blurry retro filter). inkA / paperA: the world's two inks.
// wipe (0..1): passing through a gate, the plates slip and ink bleeds in from the edges.
const PRINT = {
  uniforms: {
    tDiffuse: { value: null }, t: { value: 0 }, wipe: { value: 0 },
    res: { value: new THREE.Vector2(1, 1) },
    inkA: { value: new THREE.Color("#22264b") }, paperA: { value: new THREE.Color("#e6e3dc") },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float t, wipe; uniform vec2 res; uniform vec3 inkA, paperA; varying vec2 vUv;
    float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
    float L(vec2 o){ return lum(texture2D(tDiffuse, vUv + o).rgb); }
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
    void main(){
      vec2 px = 1.0 / res;
      // the plates only slip out of register while passing through a gate (kept sharp otherwise)
      vec2 off = px * (wipe * 3.0) * vec2(1.0, -0.6);
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      vec3 c = vec3(texture2D(tDiffuse, vUv + off).r, base.g, texture2D(tDiffuse, vUv - off).b);
      // ink lines
      vec2 e = px * 1.5;
      float tl = L(vec2(-e.x, e.y)), tc = L(vec2(0.0, e.y)), tr = L(e), ml = L(vec2(-e.x, 0.0)), mr = L(vec2(e.x, 0.0));
      float bl = L(-e), bc = L(vec2(0.0, -e.y)), br = L(vec2(e.x, -e.y));
      float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl), gy = (tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br);
      float edge = smoothstep(0.22, 0.6, length(vec2(gx, gy)));
      float l = lum(c);
      // two-ink grade: shadows lean to the world's ink, light to its paper
      c = mix(c, mix(inkA, paperA, smoothstep(0.02, 0.95, l)), 0.3);
      c = mix(c, inkA * 0.55, edge * 0.5);
      // passing through a gate: ink bleeds in from the frame's edges
      vec2 d = vUv - 0.5;
      float rad = length(d * vec2(1.35, 1.0));
      float n = vn(vUv * vec2(7.0, 4.5) + t * 0.6) * 0.6 + vn(vUv * 19.0 - t) * 0.4;
      float reach = 0.98 - wipe * 0.3 - n * 0.14;
      float inkIn = smoothstep(reach, reach + 0.03, rad);
      c = mix(c, inkA * 0.5, inkIn * smoothstep(0.02, 0.2, wipe));
      // vignette
      c *= 1.0 - smoothstep(0.35, 0.95, rad) * 0.32;
      gl_FragColor = vec4(c, 1.0);
    }`,
};
