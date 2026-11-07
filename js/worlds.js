// The six settings, in walking order. Each is built in its own local space: you walk toward -z,
// enter at `entry` and leave through the torii at `gate`. One portfolio section per world.
import * as THREE from "three";
import { loadCharacter, loadProp, loadGLB, bakePose, crowd, poseAstride, placeInstances, lodBudget } from "./assets.js?v=51";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildBattle } from "./battle.js?v=52";

const A = n => `anims/${n}.fbx`;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// camera framing: the character on one side of the screen, the text panel on the other
const framing = (c, side, wide) => wide
  ? { pos: V(c.x - side * 2.5, c.y + 1.45, c.z + 4.8), look: V(c.x - side * 1.6, c.y + 1.1, c.z - 0.8) }
  : { pos: V(c.x - side * 1.75, c.y + 1.45, c.z + 4.8), look: V(c.x - side * 0.25, c.y + 1.1, c.z - 0.8) };

// Where the characters stand in each world (the game scenes aren't flat everywhere).
const SPOT = {
  daimyo: V(-1.25, 0, -9.4),
  boss: V(1.25, 0.6, -6.4),
  goro: V(-1.5, 0.1, -0.9),
  monk: V(1.3, 0, -0.4),
  samurai: V(-1.25, 0.03, -5.4),
};

// After the first gate, each world's gate stands off to one side (away from the character),
// so it can't be seen through the gate you came in by; you turn to it and walk through.
// turn: which way you face going through it (-PI/2 = turned right, PI/2 = turned left).
const RIGHT = -Math.PI / 2, LEFT = Math.PI / 2;
export const WORLDS = [
  {
    id: "shrine", ink: "#1d3a6e", paper: "#fff4e2", entry: V(0, 0, 0), gate: V(0, 0, 0), turn: 0,
    stops: [{ id: "hero", pos: V(0.2, 1.55, 15), look: V(-0.6, 2.6, -12), kuro: { at: V(0.45, 0, 10), face: V(0.2, 0, 0) } }],
    build: buildShrine,
  },
  {
    id: "army", ink: "#1d3a6e", paper: "#fff4e2", entry: V(0, 0, 0), gate: V(6.5, 0, -6), turn: RIGHT,
    stops: [{ id: "long", ...framing(V(-1.25, 0.25, -9.4), -1), kuro: { at: V(-2.2, 0, -7.7), face: SPOT.daimyo, act: "kneel" } }],
    build: buildArmy,
  },
  { // turned around so the forest is ahead and the river behind you
    id: "camp", ink: "#1d3a6e", paper: "#fff4e2", entry: V(0, 0, 8), gate: V(7, 0.2, -3), turn: RIGHT,
    stops: [{ id: "short", ...framing(SPOT.goro, -1, true), kuro: { at: V(-2.7, 0.1, -2.3), face: SPOT.goro, act: "nod" } }],
    build: buildCamp,
  },
  {
    id: "monastery", ink: "#1d3a6e", paper: "#fff4e2", entry: V(0, 0, 21), gate: V(-8, 0, 3.5), turn: LEFT,
    stops: [{ id: "tools", ...framing(SPOT.monk, 1), kuro: { at: V(-0.1, 0, 0.2), face: SPOT.monk, act: "bow" } }],
    build: buildMonastery,
  },
  { // the game's cave is turned a quarter so you walk from its tunnel to the chief's dais
    id: "cave", ink: "#1d3a6e", paper: "#fff4e2", entry: V(0, 0, 11), gate: V(-8.6, 0, 2.0), turn: LEFT,
    stops: [{ id: "trailer", ...framing(SPOT.boss, 1), kuro: { at: V(0.4, 0.6, -6.05), face: SPOT.boss, act: "punch" } }],
    build: buildCave,
  },
  {
    id: "fortress", ink: "#1d3a6e", paper: "#fff4e2", entry: V(0, 0, 14), gate: null,
    stops: [{ id: "about", pos: V(1.2, 2.2, 1.5), look: V(-0.8, 2.4, -38), kuro: { at: V(-0.1, 0.03, -4.6), face: SPOT.samurai, act: "ack" } }],
    build: buildFortress,
  },
];
const W = id => WORLDS.find(w => w.id === id);

// ---------------------------------------------------------------- shared pieces

function mulberry(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function noiseTex(base, spread, size = 256) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"); g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * size / 6; i++) {
    const v = (Math.random() - 0.5) * spread;
    g.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 240 : 0},${v > 0 ? 220 : 0},${Math.abs(v)})`;
    g.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const texLoader = new THREE.TextureLoader();
const texCache = new Map();
function tex(url) {
  if (!texCache.has(url)) { const t = texLoader.load(url); t.colorSpace = THREE.SRGBColorSpace; texCache.set(url, t); }
  return texCache.get(url);
}

// counts finished loads so the loader bar moves
function tracker(progress) {
  let n = 0, d = 0;
  return p => { n++; p.then(() => progress(++d / n)); return p; };
}

// sky dome, fog, sun with shadows, a soft light from the viewer
function atmosphere(scene, ctx, o) {
  scene.fog = new THREE.FogExp2(o.fog, o.density);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(300, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        sun: { value: o.glowDir.clone().normalize() },
        top: { value: new THREE.Color(o.top) }, mid: { value: new THREE.Color(o.mid) }, low: { value: new THREE.Color(o.low) },
        glow: { value: new THREE.Color(o.glow) }, glowAmt: { value: o.glowAmt ?? 0.9 }, disc: { value: o.disc ?? 2.0 },
        post: { value: ctx.POST ? 1 : 0 }, exposure: { value: ctx.renderer ? ctx.renderer.toneMappingExposure : 1 },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      // With post-processing on, the frame is tone mapped at the end. The sky was painted for
      // the screen as-is, so it writes the light that comes out as the same colour after ACES.
      fragmentShader: `
        uniform vec3 sun, top, mid, low, glow; uniform float glowAmt, disc, post, exposure; varying vec3 vDir;
        vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
        vec3 unAces(vec3 L){
          const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
          const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
          vec3 y = clamp(inverse(OUT) * L, 0.0, 0.995);
          vec3 A = 1.0 - 0.983729 * y, B = 0.0245786 - 0.432951 * y, C = -0.000090537 - 0.238081 * y;
          vec3 v = max((-B + sqrt(B * B - 4.0 * A * C)) / (2.0 * A), 0.0);
          return max(inverse(IN) * v * 0.6 / exposure, 0.0);
        }
        void main(){
          float h = clamp(vDir.y, -0.2, 1.0);
          vec3 c = mix(low, mid, smoothstep(0.0, 0.18, h));
          c = mix(c, top, smoothstep(0.18, 0.75, h));
          float s = max(dot(normalize(vDir), sun), 0.0);
          c += glow * pow(s, 18.0) * glowAmt + vec3(1.0, 0.92, 0.8) * pow(s, 600.0) * disc;
          if (post > 0.5) c = min(unAces(toLin(clamp(c, 0.0, 1.0))), vec3(1.6));
          gl_FragColor = vec4(c, 1.0);
        }`,
    })
  );
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);
  // the sky, blurred, as the light metal and lacquer reflect (blades, armour, the iron pot)
  if (ctx.renderer && !ctx.SMALL) {
    const pm = new THREE.PMREMGenerator(ctx.renderer);
    const s2 = new THREE.Scene(); const sk2 = sky.clone(); sk2.position.set(0, 0, 0); s2.add(sk2);
    scene.environment = pm.fromScene(s2, 0.02, 0.1, 1000).texture;
    scene.environmentIntensity = o.env ?? 0.45;
    pm.dispose();
  }
  scene.add(new THREE.HemisphereLight(o.hemiSky, o.hemiGround, o.hemi));
  const sun = new THREE.DirectionalLight(o.sunColor, o.sunI);
  sun.castShadow = !ctx.SMALL && o.sunI > 0;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 110 });
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.025;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(o.fillColor || "#d4cdf5", o.fillI ?? 1.15);
  scene.add(fill, fill.target);
  const fwd = new THREE.Vector3(), at = new THREE.Vector3();
  return (camera) => {
    sky.position.copy(camera.position);
    camera.getWorldDirection(fwd);
    at.copy(camera.position).addScaledVector(fwd, 7);
    sun.target.position.copy(at).setY(0);
    sun.position.copy(sun.target.position).add(o.sunOffset);
    fill.target.position.copy(at);
    fill.position.copy(camera.position).add(new THREE.Vector3(0, 2, 2));
  };
}

// Ground materials from the game's Poly Haven textures. UVs are laid in metres / tile size.
const groundMats = new Map();
function groundMat(name) {
  if (!groundMats.has(name)) {
    const load = (kind, srgb) => {
      const t = texLoader.load(`tex/ground/${name}_${kind}.jpg`);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    groundMats.set(name, new THREE.MeshStandardMaterial({ map: load("diff", true), normalMap: load("nor_gl", false), roughness: 0.95 }));
  }
  return groundMats.get(name);
}
// lay a top-down texture over a geometry already in place: one tile every `tile` metres
function planarUV(geo, tile) {
  const pos = geo.attributes.position, uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) / tile; uv[i * 2 + 1] = pos.getZ(i) / tile; }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}
function ground(root, name, tile, w, len, x0, z0, y = 0) {
  const g = new THREE.PlaneGeometry(w, len); g.rotateX(-Math.PI / 2); g.translate(x0, y, z0);
  planarUV(g, tile);
  const m = new THREE.Mesh(g, groundMat(name)); m.receiveShadow = true;
  root.add(m);
  return m;
}

// Many copies of one prop, instanced. place: [{ x, z, h, rot }]
function scatter(root, src, list, shadows = false, lod = null) {
  const meshes = [];
  src.updateMatrixWorld(true);
  src.traverse(o => { if (o.isMesh) meshes.push(o); });
  const box = new THREE.Box3().setFromObject(src);
  const h = box.max.y - box.min.y;
  const q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (const mesh of meshes) {
    const mats = list.map(it => {
      const s = it.h / h;
      q.setFromAxisAngle(up, it.rot || 0);
      p.set(it.x, (it.y || 0) - box.min.y * s, it.z); sc.set(s, s, s);
      return new THREE.Matrix4().compose(p, q, sc).multiply(mesh.matrixWorld);
    });
    placeInstances(root, mesh.geometry, mesh.material, mats, { lod, cast: shadows });
  }
}

// Distance from the walking path (entry, each stop, the spot before the gate, the gate), in a world's
// local x/z: copies near it keep full detail, far ones are drawn coarser (assets.js placeInstances).
function lodFor(def, budget, near = 11, far = 26) {
  const pts = [def.entry, ...def.stops.map(s => s.pos)];
  if (def.gate) {
    const dir = V(0, 0, -1).applyAxisAngle(V(0, 1, 0), def.turn || 0);
    pts.push(def.gate.clone().addScaledVector(dir, -6.5), def.gate.clone());
  }
  const seg = (x, z, a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz;
    const t = L ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L)) : 0;
    return Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
  };
  return {
    near, far, budget: budget ? lodBudget(budget) : null,
    dist: (x, z) => { let d = Infinity; for (let i = 0; i < pts.length; i++) d = Math.min(d, seg(x, z, pts[i], pts[Math.min(i + 1, pts.length - 1)])); return d; },
  };
}

// A flickering fire: animated flame sprite, a soft glow and a warm light.
function fire(parent, x, y, z, s = 1, { light = true, intensity = 9, distance = 11 } = {}) {
  const t = texLoader.load("tex/flames.png"); // its own copy: each fire scrolls its own frames
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.repeat.set(0.25, 1);
  const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, color: "#ffb35c", blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  flame.scale.set(0.75 * s, 1.0 * s, 1); flame.position.set(x, y + 0.42 * s, z);
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, color: "#fff0c0", blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6 }));
  core.scale.set(0.45 * s, 0.6 * s, 1); core.position.set(x, y + 0.28 * s, z + 0.01);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex("tex/light_01.png"), color: "#ff8a3d", blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.45 }));
  glow.scale.set(2.6 * s, 2.6 * s, 1); glow.position.set(x, y + 0.35 * s, z);
  parent.add(flame, core, glow);
  let pl = null;
  if (light) { pl = new THREE.PointLight("#ff9548", intensity, distance, 1.5); pl.position.set(x, y + 0.7 * s, z); parent.add(pl); }
  let acc = Math.random() * 4;
  const seed = Math.random() * 10;
  return (dt, time) => {
    acc += dt * 11;
    t.offset.x = (Math.floor(acc) % 4) * 0.25;
    const f = 0.82 + 0.12 * Math.sin(time * 13 + seed) + 0.08 * Math.sin(time * 7.3 + seed * 2);
    if (pl) pl.intensity = intensity * f;
    flame.scale.y = 1.0 * s * (0.92 + 0.1 * f);
  };
}

// Low drifting mist: a few see-through layers near the ground with slow moving noise in them,
// thinning out at the edges and near the eye, warmed by a fire or lantern if given.
// Returns a function to call each frame with the time.
function mist(root, { SMALL, x, z, w, d, color, opacity, height = 1.1, warm = null, clear = null, contrast = 0.28 }) {
  const n = SMALL ? 3 : 6, layers = [];
  const geo = new THREE.PlaneGeometry(w, d); geo.rotateX(-Math.PI / 2);
  for (let i = 0; i < n; i++) {
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, clipping: true,
      uniforms: {
        t: { value: 0 }, seed: { value: i * 17.3 }, color: { value: new THREE.Color(color) }, opacity: { value: opacity * (1.15 - i / n * 0.5) },
        warmPos: { value: warm ? warm.pos.clone() : V(0, -999, 0) }, warmColor: { value: new THREE.Color(warm ? warm.color : "#000") }, warmR: { value: warm ? warm.r : 1 },
        clearAt: { value: clear ? V(clear.x, 0, clear.z) : V(0, 0, 0) }, clearR: { value: clear ? clear.r : 0 }, lo: { value: contrast },
      },
      vertexShader: `
        #include <clipping_planes_pars_vertex>
        varying vec2 vUv; varying vec3 vLocal, vWorld;
        void main(){
          vUv = uv; vLocal = position; vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          #include <clipping_planes_vertex>
          gl_Position = projectionMatrix * mvPosition;
        }`,
      fragmentShader: `
        #include <clipping_planes_pars_fragment>
        uniform float t, seed, opacity, warmR, clearR, lo; uniform vec3 color, warmPos, warmColor, clearAt;
        varying vec2 vUv; varying vec3 vLocal, vWorld;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int k = 0; k < 4; k++) { s += a * vn(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
        void main(){
          #include <clipping_planes_fragment>
          vec2 p = vWorld.xz * 0.16 + seed;
          float n = fbm(p + vec2(t * 0.035, t * 0.02) + 0.6 * fbm(p * 0.7 - t * 0.02));
          float a = opacity * smoothstep(lo, lo + 0.5, n);
          vec2 e = min(vUv, 1.0 - vUv); a *= smoothstep(0.0, 0.18, min(e.x, e.y));      // thin out at the edges
          a *= smoothstep(2.5, 8.0, distance(vWorld, cameraPosition));                  // and near the eye (the hero stays clear)
          if (clearR > 0.0) a *= smoothstep(clearR * 0.5, clearR * 1.6, distance(vWorld.xz, clearAt.xz)); // the hero stands clear
          float wd = distance(vWorld, warmPos) / warmR;
          vec3 c = color + warmColor * exp(-wd * wd) * (0.9 + 0.1 * sin(t * 9.0 + seed));
          gl_FragColor = vec4(c, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, 0.06 + height * Math.pow(i / Math.max(1, n - 1), 1.3), z);
    mesh.renderOrder = 2; root.add(mesh); layers.push(m);
  }
  return t => { for (const m of layers) m.uniforms.t.value = t; };
}

// Petals drifting down through a gate, all drawn in one go; they move in the shader.
function petals(n) {
  const rand = mulberry(77), pos = [], seed = [], uv = [], idx = [];
  for (let i = 0; i < n; i++) {
    const s = [(rand() - 0.5) * 7, rand() * 5, -2.5 + rand() * 7, rand()];
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pos.push(x * 0.045, y * 0.03, 0); uv.push(x * 0.5 + 0.5, y * 0.5 + 0.5); seed.push(...s); }
    const b = i * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("seed", new THREE.Float32BufferAttribute(seed, 4));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, clipping: true,
    uniforms: { t: { value: 0 }, color: { value: new THREE.Color("#f4efe8") } },
    vertexShader: `
      #include <clipping_planes_pars_vertex>
      attribute vec4 seed; uniform float t; varying vec2 vUv; varying float vShade;
      void main(){
        float ph = seed.w;
        float y = mod(seed.y - t * (0.32 + 0.25 * fract(ph * 7.3)), 5.0);
        vec3 c = vec3(seed.x + sin(t * 0.7 + ph * 6.2) * 0.5, y, seed.z + cos(t * 0.5 + ph * 4.1) * 0.4);
        float a = t * (1.0 + fract(ph * 3.1)) * 2.0 + ph * 6.28;
        vec3 off = vec3(position.x * cos(a), position.y + position.x * 0.4 * sin(a * 0.7), position.x * sin(a));
        vec4 mvPosition = modelViewMatrix * vec4(c + off, 1.0);
        #include <clipping_planes_vertex>
        vUv = uv; vShade = 0.7 + 0.3 * abs(cos(a));
        gl_Position = projectionMatrix * mvPosition;
      }`,
    fragmentShader: `
      #include <clipping_planes_pars_fragment>
      uniform vec3 color; varying vec2 vUv; varying float vShade;
      void main(){
        #include <clipping_planes_fragment>
        vec2 q = vUv * 2.0 - 1.0;
        if (dot(q, q) > 1.0 || (q.x > 0.55 && abs(q.y) < 0.18)) discard; // an oval with a notch
        gl_FragColor = vec4(color * vShade, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.onBeforeRender = () => { mat.uniforms.t.value = performance.now() / 1000; };
  return m;
}

// A range of hills cut from flat colour, like the background of a woodblock print: the ridge
// is noise, the colour darkens up to the ridge line and fades into mist at its foot.
function paintedRange(root, { x = 0, z, w, h, y = 0, top, foot, seed = 1, rough = 1 }) {
  const mat = new THREE.ShaderMaterial({
    clipping: true, fog: false,
    uniforms: { top: { value: new THREE.Color(top) }, foot: { value: new THREE.Color(foot) }, seed: { value: seed }, rough: { value: rough } },
    vertexShader: `
      #include <clipping_planes_pars_vertex>
      varying vec2 vUv;
      void main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        #include <clipping_planes_vertex>
        gl_Position = projectionMatrix * mvPosition; }`,
    fragmentShader: `
      #include <clipping_planes_pars_fragment>
      uniform vec3 top, foot; uniform float seed, rough; varying vec2 vUv;
      float h(float p){ return fract(sin(p * 127.1 + seed * 31.7) * 43758.5453); }
      float vn(float p){ float i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(h(i), h(i + 1.0), f); }
      void main(){
        #include <clipping_planes_fragment>
        float x = vUv.x * 6.0;
        float ridge = 0.35 + 0.38 * vn(x) + 0.17 * rough * vn(x * 2.7 + 4.0) + 0.06 * rough * vn(x * 9.0);
        if (vUv.y > ridge) discard;
        float k = vUv.y / ridge;
        vec3 c = mix(foot, top, smoothstep(0.0, 1.0, k));
        c = mix(c, top * 0.82, smoothstep(0.9, 1.0, k));   // a darker line along the crest
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(x, y + h / 2, z); root.add(m);
  return m;
}
function sunDisc(root, x, y, z, r, color) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 64), new THREE.MeshBasicMaterial({ color, fog: false, toneMapped: false }));
  m.position.set(x, y, z); root.add(m);
  return m;
}

// The torii you leave through, with two lit stone lanterns in front of it.
function gateWithLanterns(root, P, def, { lanternLight = true, lanterns = true } = {}) {
  const g = def.gate, turn = def.turn || 0;
  const t = P.torii.clone(); t.position.copy(g); t.rotation.y = turn; root.add(t);
  const at = (x, z) => V(x, 0, z).applyAxisAngle(V(0, 1, 0), turn).add(g); // a spot in the gate's own frame
  const glowMat = new THREE.MeshBasicMaterial({ color: "#ffc27a" });
  if (lanterns) for (const sx of [-1, 1]) {
    const p = at(sx * 2.7, 3.2), y = groundAt(root, p.x, p.z, g.y);
    const l = P.lantern.clone(); l.position.set(p.x, y, p.z); l.rotation.y = turn + sx * 0.3; root.add(l);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.16), glowMat);
    glow.position.set(p.x, y + 1.12, p.z); glow.rotation.y = turn; root.add(glow);
  }
  // a straw shimenawa rope under the beam, with zigzag paper shide, and petals falling through
  const deco = new THREE.Group(); deco.position.copy(g); deco.rotation.y = turn; root.add(deco);
  const sag = new THREE.CatmullRomCurve3([V(-1.42, 3.12, 0.12), V(-0.7, 2.93, 0.14), V(0, 2.86, 0.15), V(0.7, 2.93, 0.14), V(1.42, 3.12, 0.12)]);
  const rope = new THREE.Mesh(new THREE.TubeGeometry(sag, 40, 0.06, 7), new THREE.MeshStandardMaterial({ color: "#c9ad73", roughness: 0.95 }));
  rope.castShadow = true; deco.add(rope);
  const zig = new THREE.Shape(); const zw = 0.09, zs = 0.1;
  zig.moveTo(0, 0); for (let k = 0; k < 4; k++) { const dx = k % 2 ? 0 : zw; zig.lineTo(dx, -(k + 1) * zs); zig.lineTo(dx + zw * 0.55, -(k + 1) * zs); } zig.lineTo(zw * 0.55, 0);
  const paperM = new THREE.MeshStandardMaterial({ color: "#f5f2ec", side: THREE.DoubleSide, roughness: 0.8, emissive: "#3a3530" });
  for (const x of [-0.85, -0.3, 0.3, 0.85]) { const sh = new THREE.Mesh(new THREE.ShapeGeometry(zig), paperM); sh.position.copy(sag.getPoint((x + 1.42) / 2.84)).add(V(-0.05, -0.04, 0.02)); sh.rotation.y = (x > 0 ? 0.2 : -0.2); deco.add(sh); }
  deco.add(petals(60));
  if (lanternLight) {
    const p = at(0, 3.4);
    const pl = new THREE.PointLight("#ffae63", 5, 8, 1.6);
    pl.position.set(p.x, g.y + 1.6, p.z); root.add(pl);
  }
}

// a character who stands at a stop: idle loop, plus an accent move played once on arrival
function placeHero(root, c, x, z, yaw, idle, accent) {
  c.model.position.set(x, 0, z); c.model.rotation.y = yaw; root.add(c.model);
  if (accent) c.mixer.addEventListener("finished", e => { if (e.action === c.actions[accent]) c.play(idle, 0.5); });
  return stopIdx => { if (accent) c.play(accent, 0.35, true); };
}

const loadGatePieces = track => ({
  torii: track(loadProp("models/torii.glb", 4.6)),
  lantern: track(loadProp("models/stone_lantern.glb", 1.5)),
});
// The game scene's file: the sharper export on desktop, the light one on phones.
const sceneURL = (name, SMALL) => SMALL ? `models/scenes/${name}.glb` : `models/scenes/hd/${name}.glb`;

// A scene exported from the game. Meshes used many times (trees, rocks, roof tiles) are drawn
// as instances; the rest are merged per material so it draws fast.
// drop(box): leave that piece out. ground(box): [texture, tile] to re-cover a ground piece.
// cast: whether the set throws shadows (desktop).
async function loadEnv(url, yaw = 0, pos = V(0, 0, 0), { drop, ground: reground, cast = false, lod = null } = {}) {
  const src = await loadGLB(url);
  src.rotation.y = yaw; src.position.copy(pos);
  src.updateMatrixWorld(true);
  const groups = new Map(), inst = new Map();
  const box = new THREE.Box3(), size = new THREE.Vector3(), mid = new THREE.Vector3();
  const kept = [];
  src.traverse(o => {
    if (!o.isMesh) return;
    box.setFromObject(o); box.getSize(size); box.getCenter(mid);
    if (drop && drop(size, mid)) return;
    const re = reground && reground(size, mid);
    kept.push({ o, re, big: Math.max(size.x, size.z) });
  });
  const uses = new Map();
  for (const k of kept) if (!k.re) uses.set(k.o.geometry, (uses.get(k.o.geometry) || 0) + 1);
  for (const { o, re, big } of kept) {
    if (!re && uses.get(o.geometry) >= 4) {
      const key = o.geometry.uuid + "|" + o.material.uuid;
      if (!inst.has(key)) inst.set(key, { geometry: o.geometry, material: o.material, mats: [] });
      inst.get(key).mats.push(o.matrixWorld.clone());
      continue;
    }
    const c = o.geometry.clone(); c.applyMatrix4(o.matrixWorld);
    c.morphAttributes = {};
    let material = o.material;
    if (re) { material = groundMat(re[0]); planarUV(c, re[1]); for (const k of Object.keys(c.attributes)) if (!["position", "normal", "uv"].includes(k)) c.deleteAttribute(k); }
    const isGround = !!re || big > 60; // the big ground pieces take shadows but don't throw them
    const key = material.uuid + "|" + Object.keys(c.attributes).sort().join(",") + "|" + !!c.index + "|" + isGround;
    if (!groups.has(key)) groups.set(key, { material, list: [], isGround });
    groups.get(key).list.push(c);
  }
  const out = new THREE.Group();
  for (const { material, list, isGround } of groups.values()) {
    const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!geo) continue;
    const m = new THREE.Mesh(geo, material);
    m.receiveShadow = true; m.castShadow = cast && !isGround;
    out.add(m);
  }
  for (const { geometry, material, mats } of inst.values()) placeInstances(out, geometry, material, mats, { lod, cast });
  return out;
}

// Height of the ground under (x, z), in a world's local space.
function groundAt(root, x, z, fallback = 0) {
  const rc = new THREE.Raycaster();
  root.updateMatrixWorld(true);
  rc.set(root.localToWorld(V(x, 30, z)), V(0, -1, 0));
  const solid = [];
  root.traverse(o => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) return;
    const m = o.material; if (!m || m.isShaderMaterial || m.transparent || m.isMeshBasicMaterial) return; // mist, glows, the portal
    solid.push(o);
  });
  const hit = rc.intersectObjects(solid, false)[0];
  return hit ? root.worldToLocal(hit.point.clone()).y : fallback;
}

// triangles a world's repeated meshes may draw on desktop (the whole frame, with the next world
// seen through the gate, should stay near 2 million)
const REPEAT_BUDGET = +new URLSearchParams(location.search).get("tris") || 700000; // (?tris=N to try another)

const all = async obj => Object.fromEntries(await Promise.all(Object.entries(obj).map(async ([k, v]) => [k, await v])));

// ---------------------------------------------------------------- 1. bamboo shrine path (Haru)

async function buildShrine({ scene, root, progress, SMALL, renderer, POST }) {
  const LOD = lodFor(W("shrine"), SMALL ? 300000 : REPEAT_BUDGET);
  const track = tracker(progress);
  const P = await all({
    ...loadGatePieces(track),
    bamboo: track(loadGLB("models/bamboo_clump.glb")),
    bush: track(loadGLB("models/dwarf_bush.glb")),
    boulder: track(loadGLB("models/mossy_boulder.glb")),
    stumps: track(loadProp("models/bamboo_stumps.glb", 0.6)),
    fallen: track(loadProp("models/fallen_bamboo.glb", 0.45)),
    haru: track(loadCharacter("models/haru.glb", { kneeling_idle: A("kneeling_idle") }, 1.78)),
  });
  const sky = atmosphere(scene, { SMALL, renderer, POST }, {
    fog: "#b3b8c1", density: 0.034, top: "#6f86a6", mid: "#a9b6c6", low: "#e6dccd", glow: "#fff1d6", glowDir: V(0.15, 0.25, -1), glowAmt: 0.6, disc: 1.2,
    hemiSky: "#dfe6f2", hemiGround: "#4a463f", hemi: 1.3, sunColor: "#fff0d8", sunI: 2.2, sunOffset: V(-8, 18, -20),
  });
  ground(root, "forrest_ground_01", 4, 90, 90, 0, -5);
  ground(root, "rocky_trail_02", 3, 3.2, 90, 0, -5, 0.012);
  gateWithLanterns(root, P, W("shrine"), { lanternLight: false });
  const haruLight = new THREE.PointLight("#ffae63", SMALL ? 5 : 7, 8, 1.6); // lantern light on Haru's face
  haruLight.position.set(-1.7, 1.6, 3.9); root.add(haruLight);
  const rand = mulberry(7);
  const bam = [], bush = [], rocks = [];
  for (let z = 30; z > -30; z -= SMALL ? 4.2 : 3.0) for (const sx of [-1, 1]) {
    bam.push({ x: sx * (4.6 + rand() * 2.2), z: z + rand() * 2, h: 7 + rand() * 4, rot: rand() * 6.28 });
    if (!SMALL && rand() > 0.35) bam.push({ x: sx * (8 + rand() * 5), z: z + rand() * 3, h: 8 + rand() * 4, rot: rand() * 6.28 });
  }
  for (let z = 30; z > -30; z -= 2.6) for (const sx of [-1, 1]) if (rand() > 0.3) bush.push({ x: sx * (2.1 + rand() * 2.2), z: z + rand() * 2, h: 0.35 + rand() * 0.5, rot: rand() * 6.28 });
  for (let z = 30; z > -30; z -= 7) if (rand() > 0.4) rocks.push({ x: (rand() > 0.5 ? 1 : -1) * (2.3 + rand() * 2.5), z: z + rand() * 3, h: 0.35 + rand() * 0.7, rot: rand() * 6.28 });
  scatter(root, P.bamboo, bam, false, LOD); scatter(root, P.bush, bush, false, LOD); scatter(root, P.boulder, rocks, false, LOD);
  const st = P.stumps.clone(); st.position.set(3.8, 0, -5); root.add(st);
  const fa = P.fallen.clone(); fa.position.set(-3.6, 0, 9); fa.rotation.y = 0.9; root.add(fa);
  placeHero(root, P.haru, -1.25, 2.6, 0.5, "kneeling_idle");
  const fogLayers = mist(root, { SMALL, x: 0, z: 2, w: 34, d: 64, color: "#e6e4ee", opacity: 0.45, height: 0.9, clear: { x: -1.25, z: 2.6, r: 2.2 }, warm: { pos: V(-1.7, 0.6, 3.9), color: "#ffb77a", r: 4 } });

  // drifting embers near the lanterns
  const n = SMALL ? 50 : 110;
  const eg = new THREE.BufferGeometry(), ep = new Float32Array(n * 3), seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) { ep[i * 3] = (rand() - 0.5) * 7; ep[i * 3 + 1] = rand() * 3; ep[i * 3 + 2] = 5 - rand() * 7; seeds[i] = rand() * 100; }
  eg.setAttribute("position", new THREE.BufferAttribute(ep, 3));
  const embers = new THREE.Points(eg, new THREE.PointsMaterial({ color: "#ffbf80", size: 0.05, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
  root.add(embers);
  const pa = eg.attributes.position;

  LOD.budget.finish();
  return {
    update(dt, t, camera) {
      sky(camera); fogLayers(t);
      P.haru.mixer.update(dt);
      for (let i = 0; i < n; i++) {
        let y = pa.getY(i) + dt * 0.12; if (y > 3.2) y = 0.2;
        pa.setY(i, y); pa.setX(i, pa.getX(i) + Math.sin(t * 0.7 + seeds[i]) * dt * 0.08);
      }
      pa.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- 2. the daimyo before his army

async function buildArmy({ scene, root, progress, SMALL, renderer, POST }) {
  const LOD = lodFor(W("army"), SMALL ? 150000 : 250000); // (less than the others: the battle needs the rest)
  const track = tracker(progress);
  const P = await all({
    ...loadGatePieces(track),
    daimyo: track(loadCharacter("models/daimyo.glb", { talking: A("talking"), pointing_forward: A("pointing_forward"), standing_taunt_battlecry: A("standing_taunt_battlecry") }, 1.8, { weapons: "sheathed" })),
    horse: track(loadProp("models/war_horse_rigged.glb", 2.25)),
    bush: track(loadGLB("models/dwarf_bush.glb")),
    field: track(loadEnv(sceneURL("army", SMALL), 0, V(-1.25, 0, -13.4), { cast: !SMALL, lod: LOD, drop: (s, c) => Math.hypot(c.x - SPOT.daimyo.x, c.z - SPOT.daimyo.z) < 0.8 && s.y < 0.7 && Math.max(s.x, s.z) < 0.8, ground: s => s.x > 500 && s.y < 0.5 ? ["leafy_grass", 5] : null })), // the game's muster field; its lord's spot is the daimyo's
  });
  root.add(P.field);
  const sky = atmosphere(scene, { SMALL, renderer, POST }, {
    fog: "#aab0b9", density: 0.04, top: "#6f86a6", mid: "#a9b6c6", low: "#e6dccd", glow: "#fff1d6", glowDir: V(-0.25, 0.25, -1), glowAmt: 0.6, disc: 1.2,
    hemiSky: "#dfe6f2", hemiGround: "#4a463f", hemi: 1.3, sunColor: "#fff0d8", sunI: 2.2, sunOffset: V(9, 18, -22),
  });
  ground(root, "rocky_trail_02", 3, 3.4, 18, 0, -1, 0.02);
  ground(root, "rocky_trail_02", 3, 9, 3.4, 4.5, -6, 0.021); // the path turns right to the gate
  gateWithLanterns(root, P, W("army"));

  // the daimyo on a low rise at the front, commanding; his horse beside him
  const RISE = 0.42;
  const rise = new THREE.LatheGeometry([[1.9, 0], [1.55, RISE * 0.3], [1.15, RISE * 0.8], [0.8, RISE], [0, RISE]].map(([r, y]) => new THREE.Vector2(r, y)), 28);
  rise.translate(SPOT.daimyo.x, 0, SPOT.daimyo.z); planarUV(rise, 3);
  const mound = new THREE.Mesh(rise, groundMat("rocky_trail_02")); mound.receiveShadow = true; root.add(mound);
  P.daimyo.model.position.copy(SPOT.daimyo); P.daimyo.model.position.y += RISE; P.daimyo.model.rotation.y = 0.35; root.add(P.daimyo.model);
  P.horse.position.set(-3.9, 0, -11.4); P.horse.rotation.y = Math.PI / 2 + 0.35; root.add(P.horse);
  // he talks, points his men on, roars them forward, and talks again
  const orders = ["talking", "pointing_forward", "talking", "standing_taunt_battlecry"];
  let order = 0;
  P.daimyo.mixer.addEventListener("finished", () => { order = (order + 1) % orders.length; P.daimyo.play(orders[order], 0.4, orders[order] !== "talking"); });
  setInterval(() => { if (orders[order] === "talking") { order = (order + 1) % orders.length; P.daimyo.play(orders[order], 0.4, true); } }, 6500);
  const rand = mulberry(11);

  // tall banners over the fight: the daimyo's clan on the near side, the black crane beyond

  const bannerUniforms = { t: { value: 0 } };
  const bannerMat = tex => {
    const m = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9 });
    m.onBeforeCompile = sh => {
      sh.uniforms.t = bannerUniforms.t;
      sh.vertexShader = "uniform float t;\n" + sh.vertexShader.replace("#include <begin_vertex>",
        `#include <begin_vertex>
         float ph = modelMatrix[3].x * 1.7 + modelMatrix[3].z * 0.9;
         float sway = (1.0 - uv.x) * 0.0 + uv.x;
         transformed.z += sin(t * 2.2 + uv.y * 4.0 + ph) * 0.07 * (0.3 + uv.x);`);
    };
    return m;
  };
  const flagGeo = new THREE.PlaneGeometry(0.62, 1.6, 6, 10); flagGeo.translate(0.31 + 0.03, 0, 0);
  const mats = [bannerMat(tex("tex/banner_clan.png")), bannerMat(tex("tex/banner_black_crane.png"))];
  const poleGeo = new THREE.CylinderGeometry(0.025, 0.03, 4.6, 5); poleGeo.translate(0, 2.3, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: "#1d1611", roughness: 0.8 });
  const bannerSpots = [];
  for (let i = 0; i < (SMALL ? 6 : 12); i++) bannerSpots.push({ x: -20 + i * 3.4 + rand() * 1.5, z: -15 - rand() * 9, side: 0 });
  for (let i = 0; i < (SMALL ? 6 : 12); i++) bannerSpots.push({ x: -21 + i * 3.6 + rand() * 1.5, z: -29 - rand() * 12, side: 1 });
  bannerSpots.forEach(b => {
    const g = new THREE.Group(); g.position.set(b.x, 0, b.z); g.rotation.y = (b.x > 0 ? -1 : 1) * 0.15;
    const pole = new THREE.Mesh(poleGeo, poleMat); pole.castShadow = !SMALL;
    const flag = new THREE.Mesh(flagGeo, mats[b.side]); flag.position.y = 3.65; flag.castShadow = !SMALL;
    if (b.x > 0) { flag.scale.x = -1; }
    g.add(pole, flag); root.add(g);
  });

  // grass tufts along the road
  const bushes = [];
  for (let z = 2; z > -13; z -= 2.2) for (const sx of [-1, 1]) if (rand() > 0.45 && !(sx < 0 && z < -6)) bushes.push({ x: sx * (1.9 + rand() * 1.5), z: z + rand(), h: 0.25 + rand() * 0.3, rot: rand() * 6.28 });
  scatter(root, P.bush, bushes, false, LOD);
  sunDisc(root, 26, 34, -230, 15, "#ff5a4e");
  paintedRange(root, { x: 10, z: -200, w: 560, h: 56, y: -4, top: "#7d96c4", foot: "#e6dfd6", seed: 5, rough: 0.7 });
  paintedRange(root, { x: -10, z: -150, w: 420, h: 30, y: -3, top: "#4a6aa6", foot: "#e2ddd6", seed: 13, rough: 1.0 });
  paintedRange(root, { x: -20, z: -105, w: 300, h: 15, y: -2, top: "#22427a", foot: "#dcd8d2", seed: 17, rough: 1.3 });
  const fogLayers = mist(root, { SMALL, x: 0, z: -14, w: 46, d: 46, color: "#e6e4ee", opacity: 0.4, height: 1.0, clear: { x: SPOT.daimyo.x, z: SPOT.daimyo.z, r: 1.6 } });

  LOD.budget.finish();
  // the battle behind him loads after the page has opened
  let battle = null;
  const api = {
    update(dt, t, camera) { sky(camera); fogLayers(t); bannerUniforms.t.value = t; P.daimyo.mixer.update(dt); if (battle) battle.update(dt, t); },
    arrive(stop) { if (stop === 1 && battle) battle.arrive(); },
  };
  buildBattle(root, {
    SMALL, rand: mulberry(29), fire, tex, daimyoAt: SPOT.daimyo, cameraAt: V(0.5, 0, -4.6),
  }).then(b => { battle = b; api.dirty = true; window.__battle = b; }).catch(e => console.error("battle", e));
  return api;
}

// ---------------------------------------------------------------- 3. the bandit boss in his cave

// game cave coords (gx, gy, gz) -> this world's local coords, after turning it a quarter
const caveSpot = ([gx, gy, gz]) => V(gz, gy, -gx);

async function buildCave({ scene, root, progress, SMALL, renderer, POST }) {
  const LOD = lodFor(W("cave"), SMALL ? 300000 : REPEAT_BUDGET);
  const track = tracker(progress);
  const P = await all({
    ...loadGatePieces(track),
    room: track(loadEnv(sceneURL("cave", SMALL), Math.PI / 2, V(0, 0, 0), { cast: !SMALL, lod: LOD })),
    boss: track(loadCharacter("models/bandit_boss.glb", { standing_idle: A("standing_idle"), standing_taunt_battlecry: A("standing_taunt_battlecry"), react: A("standing_react_large_gut") }, 1.85)),
    sitters: Promise.all([0, 1].map(() => track(loadCharacter("models/bandit.glb", { kneeling_idle: A("kneeling_idle") }, 1.75)))),
    talker: track(loadCharacter("models/bandit.glb", { talking: A("talking") }, 1.75)),
    guard: track(loadCharacter("models/bandit.glb", { unarmed_idle_looking_ver_1: A("unarmed_idle_looking_ver_1") }, 1.75)),
    jars: track(loadProp("models/sake_jars.glb", 0.7)),
    mat: track(loadProp("models/straw_mat.glb", 0.12)),
    rack: track(loadProp("models/drying_rack.glb", 1.7)),
  });
  root.add(P.room);
  const sky = atmosphere(scene, { SMALL, renderer, POST }, {
    fog: "#151a23", density: 0.04, top: "#0b0d12", mid: "#12161e", low: "#1a1f29", glow: "#000000", glowDir: V(0, 1, 0), glowAmt: 0, disc: 0,
    hemiSky: "#7a6f92", hemiGround: "#2a1b14", hemi: 0.6, sunColor: "#ffb07a", sunI: 0.0, sunOffset: V(0, 14, 0), fillColor: "#c9bde8", fillI: 0.8,
  });
  gateWithLanterns(root, P, W("cave"), { lanternLight: false, lanterns: false });

  // the game's torch spots round the wall, the braziers by the dais and the fire pit
  const flames = [];
  const torches = [[-16.0, 2.82, 0.0], [8.2, 2.02, 4.38], [2.02, 2.02, 9.85], [-5.67, 2.02, 7.9], [-5.67, 2.02, -7.9], [2.02, 2.02, -9.85], [8.2, 2.02, -4.38]];
  torches.forEach((t, i) => { const p = caveSpot(t); flames.push(fire(root, p.x, p.y, p.z, 0.5, { light: i === 1 || i === 6 || i === 3, intensity: 6, distance: 10 })); });
  for (const t of [[5.8, 1.05, -3.4], [5.8, 1.05, 3.4]]) { const p = caveSpot(t); flames.push(fire(root, p.x, p.y, p.z, 0.6, { intensity: 7, distance: 9 })); }
  const pit = caveSpot([0.5, 0, -4.4]);
  flames.push(fire(root, pit.x, 0.05, pit.z, 1.0, { intensity: 14, distance: 13 }));
  const logGeo = new THREE.CylinderGeometry(0.07, 0.08, 0.9, 6);
  const logMat = new THREE.MeshStandardMaterial({ color: "#2b1d14", roughness: 1 });
  for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(logGeo, logMat); l.position.set(pit.x, 0.08, pit.z); l.rotation.set(Math.PI / 2 - 0.25, i * Math.PI / 4, 0, "YXZ"); root.add(l); }

  // the chief on his dais; his men round the fire and along the walls
  P.boss.model.position.copy(SPOT.boss); P.boss.model.rotation.y = -0.25; root.add(P.boss.model);
  const key = new THREE.PointLight("#ffa060", SMALL ? 5 : 7, 7, 1.6); // brazier light on his face
  key.position.set(SPOT.boss.x - 1.4, SPOT.boss.y + 2.0, SPOT.boss.z + 2.6); root.add(key);
  P.boss.mixer.addEventListener("finished", e => { if (e.action === P.boss.actions.standing_taunt_battlecry) P.boss.play("standing_idle", 0.5); });
  const around = [[pit.x - 1.1, pit.z + 0.5], [pit.x + 1.0, pit.z - 0.7]];
  P.sitters.forEach((c, i) => {
    const [x, z] = around[i];
    c.model.position.set(x, 0, z); c.model.rotation.y = Math.atan2(pit.x - x, pit.z - z); root.add(c.model); c.mixer.setTime(i * 1.3);
    const m = P.mat.clone(); m.position.set(x, 0.01, z); root.add(m);
  });
  P.talker.model.position.set(pit.x - 0.3, 0, pit.z - 1.4); P.talker.model.rotation.y = 0.4; root.add(P.talker.model);
  P.guard.model.position.set(3.0, 0, -3.2); P.guard.model.rotation.y = -0.7; root.add(P.guard.model);
  P.guard.mixer.update(0.6); P.guard.model.updateMatrixWorld(true);
  const rand = mulberry(23);
  const standers = [V(-6.2, 0, -5.2), V(5.8, 0, 0.8), V(-3.0, 0, -7.6), V(4.2, 0, -7.4), V(6.4, 0, 3.6)].slice(0, SMALL ? 3 : 5);
  crowd(root, bakePose(P.guard.model), standers.map(p => ({ x: p.x, z: p.z, yaw: Math.atan2(-p.x, 2 - p.z) + (rand() - 0.5) * 0.4 })), !SMALL, LOD);
  const j1 = P.jars.clone(); j1.position.set(-7.4, 0, -1.5); j1.rotation.y = 0.8; root.add(j1);
  const j2 = P.jars.clone(); j2.position.set(6.8, 0, -3.5); j2.rotation.y = -0.6; root.add(j2);
  const r1 = P.rack.clone(); r1.position.set(4.6, 0, 6.2); r1.rotation.y = -0.5; root.add(r1);

  const mixers = [P.boss.mixer, P.talker.mixer, P.guard.mixer, ...P.sitters.map(c => c.mixer)];
  let reactT = 0;
  LOD.budget.finish();
  return {
    update(dt, t, camera) { sky(camera); for (const f of flames) f(dt, t); for (const m of mixers) m.update(dt); },
    arrive(stop) { if (stop === 2) P.boss.play("standing_taunt_battlecry", 0.35, true); },
    // Kurō's smack lands: he doubles over (no blood), then stands back up
    react() {
      P.boss.play("react", 0.12, true);
      clearTimeout(reactT);
      reactT = setTimeout(() => P.boss.play("standing_idle", 0.6), (P.boss.actions.react.getClip().duration - 0.35) * 1000);
    },
  };
}

// ---------------------------------------------------------------- 4. Goro's campfire in the forest

async function buildCamp({ scene, root, progress, SMALL, renderer, POST }) {
  const LOD = lodFor(W("camp"), SMALL ? 300000 : REPEAT_BUDGET);
  const track = tracker(progress);
  const P = await all({
    ...loadGatePieces(track),
    bank: track(loadEnv(sceneURL("camp", SMALL), Math.PI, V(0, 0, 0), { cast: !SMALL, lod: LOD,
      // the log Goro's feet went through
      drop: (s, c) => s.y < 0.6 && c.y < 0.5 && Math.max(s.x, s.z) < 4 && Math.max(s.x, s.z) > 0.6 && Math.hypot(c.x - SPOT.goro.x, c.z - SPOT.goro.z) < 1.4,
      ground: s => s.x > 200 && s.y < 5 ? ["forest_ground_05", 4] : null })),
    goro: track(loadCharacter("models/goro.glb", { unarmed_idle_looking_ver_1: A("unarmed_idle_looking_ver_1"), pointing_forward: A("pointing_forward") }, 1.9)),
  });
  slingOnBack(P.goro, 1.9); // his club on his back, the way the game carries it
  root.add(P.bank);
  const sky = atmosphere(scene, { SMALL, renderer, POST }, {
    fog: "#a9afb8", density: 0.045, top: "#6f86a6", mid: "#a9b6c6", low: "#e6dccd", glow: "#fff1d6", glowDir: V(0.4, 0.25, -1), glowAmt: 0.6, disc: 1.2,
    hemiSky: "#dfe6f2", hemiGround: "#4a463f", hemi: 1.2, sunColor: "#fff0d8", sunI: 1.9, sunOffset: V(10, 18, -22),
  });
  gateWithLanterns(root, P, W("camp"));

  // the fire, with an iron pot hanging from a tripod over it: a bed of ash, a neat ring of
  // stones, a teepee of logs, and the tripod standing outside the ring
  const fx = 0, fz = 0, fy = groundAt(root, fx, fz, 0);
  const flame = fire(root, fx, fy + 0.05, fz, 0.95, { intensity: 16, distance: 12 });
  const ash = new THREE.Mesh(new THREE.CircleGeometry(0.6, 32), new THREE.MeshStandardMaterial({ color: "#1c1714", roughness: 1 }));
  ash.rotation.x = -Math.PI / 2; ash.position.set(fx, fy + 0.012, fz); ash.receiveShadow = true; root.add(ash);
  const stoneGeo = new THREE.IcosahedronGeometry(0.12, 1), stoneMat = new THREE.MeshStandardMaterial({ color: "#3a3631", roughness: 1 });
  const ringN = 16;
  for (let i = 0; i < ringN; i++) {
    const a = i / ringN * Math.PI * 2, st = new THREE.Mesh(stoneGeo, stoneMat), k = 1 + 0.06 * Math.sin(i * 2.3);
    st.position.set(fx + Math.cos(a) * 0.68, fy + 0.05, fz + Math.sin(a) * 0.68);
    st.rotation.y = -a; st.scale.set(0.95 * k, 0.6 * k, 1.25 * k); st.castShadow = !SMALL; st.receiveShadow = true; root.add(st);
  }
  const logMat = new THREE.MeshStandardMaterial({ color: "#3a281b", roughness: 1 });
  const stick = (geo, mat, from, to) => { // a cylinder from one point to another
    const m = new THREE.Mesh(geo, mat); m.position.copy(from).add(to).multiplyScalar(0.5);
    root.add(m); m.lookAt(root.localToWorld(to.clone())); m.rotateX(Math.PI / 2); m.castShadow = !SMALL; return m;
  };
  const logTop = V(fx, fy + 0.5, fz);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2 + 0.26, base = V(fx + Math.cos(a) * 0.42, fy + 0.05, fz + Math.sin(a) * 0.42);
    stick(new THREE.CylinderGeometry(0.045, 0.06, base.distanceTo(logTop) + 0.06, 7), logMat, base, logTop);
  }
  const wood = new THREE.MeshStandardMaterial({ color: "#3a2a1c", roughness: 0.9 });
  const top = V(fx, fy + 1.62, fz);
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + 0.4, base = V(fx + Math.cos(a) * 0.95, fy, fz + Math.sin(a) * 0.95);
    const over = top.clone().add(top.clone().sub(base).normalize().multiplyScalar(0.14)); // the legs cross a little above the tie
    stick(new THREE.CylinderGeometry(0.025, 0.032, base.distanceTo(over), 6), wood, base, over);
  }
  const potProfile = [[0.0, 0], [0.16, 0.0], [0.24, 0.06], [0.27, 0.16], [0.26, 0.27], [0.21, 0.33], [0.22, 0.36]].map(([x, y]) => new THREE.Vector2(x, y));
  const pot = new THREE.Mesh(new THREE.LatheGeometry(potProfile, 24), new THREE.MeshStandardMaterial({ color: "#26221f", metalness: 0.7, roughness: 0.55, side: THREE.DoubleSide }));
  pot.position.set(fx, fy + 0.66, fz); pot.castShadow = !SMALL; root.add(pot);
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.6, 4), iron());
  chain.position.set(fx, fy + 1.32, fz); root.add(chain);
  const rand = mulberry(31);
  const fogLayers = mist(root, { SMALL, x: 0, z: -3, w: 34, d: 34, color: "#e6e4ee", opacity: 0.42, height: 0.9, contrast: 0.36, clear: { x: SPOT.goro.x, z: SPOT.goro.z, r: 1.2 }, warm: { pos: V(fx, fy + 0.4, fz), color: "#ff9a52", r: 4.5 } });
  const steam = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex("tex/smoke.png"), color: "#9aa6c0", transparent: true, opacity: 0.18, depthWrite: false }));
  steam.scale.set(1.2, 1.6, 1); steam.position.set(fx, fy + 1.5, fz); root.add(steam);

  const g = SPOT.goro;
  P.goro.model.position.set(g.x, groundAt(root, g.x, g.z, g.y), g.z); P.goro.model.rotation.y = 0.35; root.add(P.goro.model);
  P.goro.mixer.addEventListener("finished", e => { if (e.action === P.goro.actions.pointing_forward) P.goro.play("unarmed_idle_looking_ver_1", 0.5); });

  // fireflies at the edge of the trees
  const n = SMALL ? 30 : 70;
  const eg = new THREE.BufferGeometry(), ep = new Float32Array(n * 3), seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) { ep[i * 3] = (rand() - 0.5) * 14; ep[i * 3 + 1] = 0.6 + rand() * 2.5; ep[i * 3 + 2] = 2 - rand() * 16; seeds[i] = rand() * 100; }
  eg.setAttribute("position", new THREE.BufferAttribute(ep, 3));
  const flies = new THREE.Points(eg, new THREE.PointsMaterial({ color: "#d8ff9a", size: 0.045, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
  root.add(flies);
  const pa = eg.attributes.position;

  LOD.budget.finish();
  return {
    update(dt, t, camera) {
      sky(camera); fogLayers(t); flame(dt, t); P.goro.mixer.update(dt);
      steam.material.rotation = Math.sin(t * 0.4) * 0.2; steam.position.y = fy + 1.5 + Math.sin(t * 0.7) * 0.05;
      for (let i = 0; i < n; i++) {
        pa.setX(i, pa.getX(i) + Math.sin(t * 0.5 + seeds[i]) * dt * 0.15);
        pa.setY(i, pa.getY(i) + Math.cos(t * 0.8 + seeds[i]) * dt * 0.1);
      }
      pa.needsUpdate = true;
    },
    arrive(stop) { if (stop === 3) P.goro.play("pointing_forward", 0.35, true); },
  };
}
function iron() { return new THREE.MeshStandardMaterial({ color: "#2a2522", metalness: 0.6, roughness: 0.6 }); }

// ---------------------------------------------------------------- 5. the monk among his brothers

const MONK_H = 2.8; // the heavy monk at the head of the path

// The game's sling (model_rig.gd set_slung): a man with empty hands carries his naginata or club strapped
// diagonally across his back, butt by his left hip, blade up past his right shoulder, just off the
// back. Moves the weapon from his hand to his chest bone, so it rides with him.
function slingOnBack(K, height) {
  const w = K.weapons.find(x => /naginata|kanabo/i.test(x.name));
  if (!w) return;
  const m = K.model, keepP = m.position.clone(), keepR = m.rotation.clone();
  m.position.set(0, m.position.y, 0); m.rotation.set(0, 0, 0); m.updateMatrixWorld(true);
  let spine = null;
  m.traverse(o => { if (!spine && o.isBone && /spine2$/i.test(o.name.replace(/[^A-Za-z0-9]/g, ""))) spine = o; });
  if (spine) {
    // the weapon's length, and which end is the blade (the end he holds up)
    const inv = new THREE.Matrix4().copy(w.matrixWorld).invert(), box = new THREE.Box3();
    w.traverse(o => { if (o.isMesh) { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld))); } });
    const size = box.getSize(V(0, 0, 0)), c = box.getCenter(V(0, 0, 0));
    const ax = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
    const dir = V(0, 0, 0).setComponent(ax, 1), half = size.getComponent(ax) / 2;
    const top = c.clone().addScaledVector(dir, half).applyMatrix4(w.matrixWorld), bot = c.clone().addScaledVector(dir, -half).applyMatrix4(w.matrixWorld);
    // the blade is the wide end: compare how far the mesh spreads off the axis near each end
    const spread = [0, 0], v = V(0, 0, 0), toW = new THREE.Matrix4();
    w.traverse(o => {
      if (!o.isMesh) return;
      toW.multiplyMatrices(inv, o.matrixWorld);
      const P = o.geometry.attributes.position;
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(toW);
        const u = (v.getComponent(ax) - c.getComponent(ax)) / half; // -1 .. 1 along it
        if (Math.abs(u) < 0.7) continue;
        let off = 0; for (let k = 0; k < 3; k++) if (k !== ax) off = Math.max(off, Math.abs(v.getComponent(k) - c.getComponent(k)));
        const e = u > 0 ? 0 : 1; spread[e] = Math.max(spread[e], off);
      }
    });
    if (spread[1] > spread[0]) dir.negate();
    const len = top.distanceTo(bot), ws = w.getWorldScale(V(0, 0, 0));
    // the shaft's line across his back (he faces +z; +x is his left)
    const hs = height / 1.75, tilt = THREE.MathUtils.degToRad(32), sn = Math.sin(tilt), cs = Math.cos(tilt);
    const chest = spine.getWorldPosition(V(0, 0, 0));
    const mid = V(0, chest.y - 0.5 * hs + len / 2 * cs, 0), up = V(-sn, cs, 0);
    // how far back his body reaches under that line
    let back = Infinity; const p = V(0, 0, 0);
    m.traverse(o => {
      if (!o.isSkinnedMesh) return;
      const n = o.geometry.attributes.position.count;
      for (let i = 0; i < n; i += 2) {
        o.getVertexPosition(i, p); o.localToWorld(p);
        const dx = p.x - mid.x, dy = p.y - mid.y;
        if (Math.abs(-dx * sn + dy * cs) < len / 2 && Math.abs(dx * cs + dy * sn) < 0.09 * hs && p.z < back) back = p.z;
      }
    });
    if (back < Infinity) mid.z = back - 0.035 * hs;
    const q = new THREE.Quaternion().setFromUnitVectors(dir, up);
    const pos = mid.clone().sub(c.clone().multiply(ws).applyQuaternion(q));
    const M = new THREE.Matrix4().compose(pos, q, ws);
    spine.add(w);
    new THREE.Matrix4().copy(spine.matrixWorld).invert().multiply(M).decompose(w.position, w.quaternion, w.scale);
  }
  m.position.copy(keepP); m.rotation.copy(keepR); m.updateMatrixWorld(true);
}

async function buildMonastery({ scene, root, progress, SMALL, renderer, POST }) {
  const LOD = lodFor(W("monastery"), SMALL ? 300000 : REPEAT_BUDGET);
  const track = tracker(progress);
  const P = await all({
    ...loadGatePieces(track),
    hall: track(loadEnv(sceneURL("monastery", SMALL), 0, V(0, 0, 0), {
      cast: !SMALL, lod: LOD,
      drop: (s, c) => (Math.hypot(c.x, c.z) < 1.5 && s.y < 3.5) // a bare untextured tree at the centre, right in front of the monk
        || (s.y > 10 && Math.abs(c.x) < 3 && c.z < -4 && c.z > -20) // the temple hall behind him
        || (s.y > 15 && Math.abs(c.x) < 22 && c.z < -30), // the boulder wall that stood behind the hall
      ground: (s) =>
      s.y > 0.3 ? null : s.x > 1000 ? ["leafy_grass", 5] : s.x > 40 ? ["gravel_floor_02", 3] : s.z > 100 ? ["rocky_trail_02", 3] : s.z > 25 ? ["grey_stone_path", 2.5] : null })),
    monk: track(loadCharacter("models/warrior_monk_heavy_rigged.glb", { unarmed_idle_looking_ver_1: A("unarmed_idle_looking_ver_1") }, MONK_H)),
    kneelY: track(loadCharacter("models/warrior_monk_yellow_rigged.glb", { kneeling_idle: A("kneeling_idle") }, 1.78)),
    kneelH: track(loadCharacter("models/warrior_monk_heavy_rigged.glb", { kneeling_idle: A("kneeling_idle") }, 1.78)),
    standY: track(loadCharacter("models/warrior_monk_yellow_rigged.glb", { standing_idle: A("standing_idle") }, 1.78)),
    temple: track(loadProp("models/fortress_temple.glb", 12)),
  });
  // every monk carries his naginata slung on his back, hands empty
  slingOnBack(P.monk, MONK_H); slingOnBack(P.kneelY, 1.78); slingOnBack(P.kneelH, 1.78); slingOnBack(P.standY, 1.78);
  const sky = atmosphere(scene, { SMALL, renderer, POST }, {
    fog: "#a7adb5", density: 0.018, top: "#6f86a6", mid: "#a9b6c6", low: "#e6dccd", glow: "#fff1d6", glowDir: V(-0.5, 0.25, -1), glowAmt: 0.6, disc: 1.2,
    hemiSky: "#dfe6f2", hemiGround: "#5a5248", hemi: 1.3, sunColor: "#fff0d8", sunI: 2.2, sunOffset: V(-12, 18, -14),
  });
  root.add(P.hall);
  gateWithLanterns(root, P, W("monastery"), { lanternLight: false });
  // where the hall stood: a woodblock view of far mountains under a big red sun
  sunDisc(root, -18, 40, -240, 17, "#ff5a4e");
  paintedRange(root, { z: -220, w: 620, h: 62, y: -4, top: "#7d96c4", foot: "#e6dfd6", seed: 3, rough: 0.6 });
  paintedRange(root, { z: -165, w: 470, h: 34, y: -3, top: "#4a6aa6", foot: "#e2ddd6", seed: 7 });
  paintedRange(root, { z: -118, w: 340, h: 17, y: -2, top: "#22427a", foot: "#dcd8d2", seed: 11, rough: 1.3 });
  // the stone path runs on behind the monk, out over the plain toward the far hills, and doesn't end
  ground(root, "leafy_grass", 5, 420, 260, 0, -150, -0.05);
  const edge = ground(root, "gravel_floor_02", 2, 4.0, 300, 0.4, -152, 0.02); // dark gravel either side, so it reads to the horizon
  edge.material = edge.material.clone(); edge.material.color.set("#5d5951");
  const road = ground(root, "grey_stone_path", 2.5, 3.0, 300, 0.4, -152, 0.025);
  road.material = road.material.clone(); road.material.color.set("#a29d94");
  // the fog only half covers the road, so it stays in sight all the way to the hills
  for (const m of [edge.material, road.material]) {
    m.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace("#include <fog_fragment>", `#ifdef USE_FOG
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor * 0.62);
      #endif`); };
    m.customProgramCacheKey = () => "thin-fog";
  }
  // pairs of stone lanterns either side of it, fading into the mist (far ones drawn lighter)
  const lamps = [];
  for (let i = 0; i < (SMALL ? 5 : 8); i++) for (const sx of [-1, 1]) { // (up to the temple's steps)
    const z = -6 - i * 6, x = 0.4 + sx * 2.5;
    lamps.push({ x, y: groundAt(root, x, z, 0), z, h: 1.5, rot: sx * 0.2 });
  }
  scatter(root, P.lantern, lamps, !SMALL, LOD);
  const fogLayers = mist(root, { SMALL, x: 0, z: -8, w: 70, d: 60, color: "#e6e4ee", opacity: 0.4, height: 0.8, clear: { x: SPOT.monk.x, z: SPOT.monk.z, r: 1.5 } });

  // a temple at the end of the road, far off in the haze
  P.temple.position.set(0.4, 0, -60); root.add(P.temple);

  // the heavy monk, a head and more above his brothers, where the hall stood
  P.monk.model.position.copy(SPOT.monk); P.monk.model.rotation.y = -0.15; root.add(P.monk.model);

  // his brothers kneel along both sides of the path, facing it; more stand behind him
  for (const c of [P.kneelY, P.kneelH, P.standY]) { c.mixer.setTime(0.5); c.model.updateMatrixWorld(true); }
  const kY = bakePose(P.kneelY.model), kH = bakePose(P.kneelH.model), sY = bakePose(P.standY.model);
  const rowsZ = SMALL ? [6.5, 9.5, 12.5] : [6.5, 9.5, 12.5, 15.5, 18.5];
  const L = [], R = [];
  rowsZ.forEach((z, i) => {
    const a = { x: -3.2, z, yaw: Math.PI / 2 }, b = { x: 3.2, z, yaw: -Math.PI / 2 };
    (i % 2 ? L : R).push(a); (i % 2 ? R : L).push(b);
  });
  crowd(root, kY, L, !SMALL, LOD); crowd(root, kH, R, !SMALL, LOD);
  crowd(root, sY, [{ x: -2.4, z: -1.1, yaw: 0.1 }, { x: 4.6, z: 0.5, yaw: -0.12 }, { x: -6.0, z: 0.67, yaw: 0.17 }, { x: -4.4, z: 0.51, yaw: 0.12 }, { x: 6.2, z: 0.9, yaw: -0.17 }], !SMALL, LOD);

  // incense smoke curling up from braziers by the hall
  const flames = [];
  for (const [x, z] of [[-6.5, -1.9], [6.5, -1.9], [-6.2, 11], [6.2, 11]]) flames.push(fire(root, x, 1.0, z, 0.4, { light: false }));

  LOD.budget.finish();
  return {
    update(dt, t, camera) { sky(camera); fogLayers(t); for (const f of flames) f(dt, t); P.monk.mixer.update(dt); },
  };
}

// ---------------------------------------------------------------- 6. the samurai in the castle courtyard

// A castle wall from (x0, z0) to (x1, z1): a sloped stone base, white plaster above a dark timber
// band, and a dark tiled cap along the top. Its face looks toward the left of the line's direction.
function castleWall(root, x0, z0, x1, z1, { SMALL }) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const g = new THREE.Group();
  g.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2); g.rotation.y = Math.atan2(-(z1 - z0), x1 - x0);
  // texture coordinates on the faces: along the wall and up it, one tile every `tile` m
  const faceUV = (geo, tile) => {
    const P = geo.attributes.position, N = geo.attributes.normal, uv = new Float32Array(P.count * 2);
    for (let i = 0; i < P.count; i++) {
      const side = Math.abs(N.getY(i)) > 0.7 ? P.getZ(i) : P.getY(i);
      uv[i * 2] = (Math.abs(N.getX(i)) > 0.7 ? P.getZ(i) : P.getX(i)) / tile; uv[i * 2 + 1] = side / tile;
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  };
  const BASE = 2.3, PLASTER = 2.1;
  const base = new THREE.BoxGeometry(len, BASE, 2.6); base.translate(0, BASE / 2, 0);
  { const P = base.attributes.position; for (let i = 0; i < P.count; i++) if (P.getY(i) > BASE / 2) P.setZ(i, P.getZ(i) * 0.55); base.computeVertexNormals(); }
  faceUV(base, 2.2);
  const stone = groundMat("grey_stone_path").clone(); stone.color.set("#9a958c");
  const plaster = new THREE.MeshStandardMaterial({ color: "#ebe5d9", roughness: 0.95 });
  const timber = new THREE.MeshStandardMaterial({ color: "#2a2420", roughness: 0.85 });
  const tile = new THREE.MeshStandardMaterial({ color: "#2e333b", roughness: 0.7, metalness: 0.1 });
  const wall = new THREE.BoxGeometry(len, PLASTER, 0.55); wall.translate(0, BASE + PLASTER / 2, 0);
  const band = new THREE.BoxGeometry(len, 0.4, 0.6); band.translate(0, BASE + 0.2, 0);
  const capShape = new THREE.Shape([new THREE.Vector2(-0.75, 0), new THREE.Vector2(0.75, 0), new THREE.Vector2(0.12, 0.42), new THREE.Vector2(-0.12, 0.42)]);
  const cap = new THREE.ExtrudeGeometry(capShape, { depth: len + 0.6, bevelEnabled: false });
  cap.translate(0, 0, -(len + 0.6) / 2); cap.rotateY(Math.PI / 2); cap.translate(0, BASE + PLASTER, 0);
  for (const [geo, mat] of [[base, stone], [wall, plaster], [band, timber], [cap, tile]]) {
    const m = new THREE.Mesh(geo, mat); m.castShadow = !SMALL; m.receiveShadow = true; g.add(m);
  }
  // little square loopholes along the plaster, as the castle's walls have
  const holes = Math.floor(len / 3.2);
  if (holes > 0) {
    const hole = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, 0.28, 0.6), timber, holes * 2);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < holes; i++) for (const sz of [-1, 1]) hole.setMatrixAt(i * 2 + (sz > 0 ? 1 : 0), m4.makeTranslation(-len / 2 + (i + 0.5) * len / holes, BASE + PLASTER * 0.58, sz * 0.02));
    g.add(hole);
  }
  root.add(g);
}

async function buildFortress({ scene, root, progress, SMALL, renderer, POST }) {
  const LOD = lodFor(W("fortress"), SMALL ? 300000 : REPEAT_BUDGET);
  const track = tracker(progress);
  const P = await all({
    yard: track(loadEnv(sceneURL("fortress", SMALL), 0, V(0, 0, 0), {
      cast: !SMALL, lod: LOD,
      // leave out the big hall at the back of the square; the cavalry stands there instead
      drop: (s, c) => Math.abs(c.x) < 16 && c.z < -8.5 && c.z > -29 && s.y > 3,
      ground: s => s.y > 0.3 ? null : s.x > 300 ? ["leafy_grass", 5] : s.x > 60 ? ["gravel_floor_02", 3] : s.x > 20 ? ["clean_pebbles", 2.5] : s.z > 12 ? ["grey_stone_path", 2.5] : null,
    })),
    horse: track(loadProp("models/war_horse_rigged.glb", 2.25)),
    riderA: track(loadCharacter("models/kit_samurai.glb", { standing_idle: A("standing_idle") }, 1.8, { weapons: "sheathed" })),
    riderB: track(loadCharacter("models/ashigaru_simple.glb", { standing_idle: A("standing_idle") }, 1.72, { weapons: false })),
    samurai: track(loadCharacter("models/kit_samurai.glb", { talking: A("talking"), pointing_forward: A("pointing_forward") }, 1.8, { weapons: "sheathed" })),
    guardA: track(loadCharacter("models/kit_ashigaru.glb", { standing_idle: A("standing_idle") }, 1.76)),
    guardB: track(loadCharacter("models/kit_samurai.glb", { standing_idle: A("standing_idle") }, 1.8)),
    guardC: track(loadCharacter("models/ashigaru_simple.glb", { standing_idle: A("standing_idle") }, 1.72)),
    lantern: track(loadProp("models/stone_lantern.glb", 1.5)),
  });
  root.add(P.yard);
  const sky = atmosphere(scene, { SMALL, renderer, POST }, {
    fog: "#a7adb5", density: 0.018, top: "#6f86a6", mid: "#a9b6c6", low: "#e6dccd", glow: "#fff1d6", glowDir: V(0.6, 0.25, -1), glowAmt: 0.6, disc: 1.2,
    hemiSky: "#dfe6f2", hemiGround: "#5a5248", hemi: 1.3, sunColor: "#fff0d8", sunI: 2.4, sunOffset: V(-14, 18, -20),
  });
  sunDisc(root, 22, 44, -240, 16, "#ff5a4e");
  paintedRange(root, { z: -220, w: 620, h: 70, y: -4, top: "#7d96c4", foot: "#e6dfd6", seed: 23, rough: 0.6 });
  paintedRange(root, { z: -160, w: 470, h: 40, y: -3, top: "#4a6aa6", foot: "#e2ddd6", seed: 29 });

  // the samurai, ringed by his men
  const S = SPOT.samurai;
  P.samurai.model.position.copy(S); P.samurai.model.rotation.y = 0.35; root.add(P.samurai.model);
  P.samurai.mixer.addEventListener("finished", e => { if (e.action === P.samurai.actions.pointing_forward) P.samurai.play("talking", 0.5); });
  for (const c of [P.guardA, P.guardB, P.guardC]) { c.mixer.setTime(0.8); c.model.updateMatrixWorld(true); }
  const bakes = [bakePose(P.guardA.model), bakePose(P.guardB.model), bakePose(P.guardC.model)];
  const groups = [[], [], []];
  const cx = S.x, cz = S.z - 1, count = SMALL ? 9 : 14;
  for (let i = 0; i < count; i++) {
    const a = Math.PI * (0.12 + 0.76 * i / (count - 1)) + Math.PI; // a horseshoe behind him, open toward you
    const r = 3.2 + (i % 2) * 0.9;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    groups[i % 3].push({ x, y: S.y, z, yaw: Math.atan2(cx - x, cz - z) });
  }
  const rand = mulberry(41);
  for (let r = 0; r < (SMALL ? 2 : 4); r++) for (let c = 0; c < 4; c++) for (const sx of [-1, 1]) // lines down both sides of the yard
    groups[(r + c) % 3].push({ x: sx * (6.5 + c * 1.0), y: S.y, z: -2 - r * 3 - rand(), yaw: -sx * Math.PI / 2 * 0.8 });
  groups.forEach((g, i) => crowd(root, bakes[i], g, !SMALL, LOD));
  for (const sx of [-1, 1]) for (const z of [0, -12]) { const l = P.lantern.clone(); l.position.set(sx * 3, S.y, z); root.add(l); }

  // samurai on horseback, ranked across the back of the square where the hall stood, facing him
  // (seated the way the game's rider script does it: on the saddle, legs astride)
  const horse = bakePose(P.horse); // the horse model faces -x; turned a quarter it faces +z
  const SEAT = V(0, 1.52, -0.13);   // the saddle, measured on the horse at 2.25 m
  const riders = [P.riderA, P.riderB].map(r => {
    r.mixer.setTime(0.5);
    const hip = poseAstride(r.model);
    return { parts: bakePose(r.model), y: SEAT.y - hip };
  });
  const cols = SMALL ? 5 : 7, rows = SMALL ? 2 : 3;
  const horses = [], mounted = [[], []], flags = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = (c - (cols - 1) / 2) * 2.3 + (rand() - 0.5) * 0.3 + (r % 2) * 1.1;
    const z = -15 - r * 4.2 + (rand() - 0.5) * 0.4;
    const yaw = (rand() - 0.5) * 0.12;
    horses.push({ x, y: S.y, z, yaw: Math.PI / 2 + yaw });
    const seat = V(0, 0, SEAT.z).applyAxisAngle(V(0, 1, 0), yaw);
    const kind = r === 0 ? 0 : 1; // armoured samurai in front, ashigaru riders behind
    mounted[kind].push({ x: x + seat.x, y: S.y + riders[kind].y, z: z + seat.z, yaw });
    flags.push({ x: x + seat.x, z: z + seat.z - 0.32, yaw, y: S.y + SEAT.y });
  }
  crowd(root, horse, horses, !SMALL, LOD);
  mounted.forEach((list, k) => crowd(root, riders[k].parts, list, !SMALL, LOD));
  // a clan flag on each rider's back
  const flagGeo = new THREE.PlaneGeometry(0.42, 1.0); flagGeo.translate(0.21, 0, 0);
  const flagMat = new THREE.MeshStandardMaterial({ map: tex("tex/banner_clan.png"), side: THREE.DoubleSide, roughness: 0.9 });
  const poleGeo = new THREE.CylinderGeometry(0.012, 0.012, 1.5, 4); poleGeo.translate(0, 0.75, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: "#1d1611" });
  const fm = new THREE.InstancedMesh(flagGeo, flagMat, flags.length), pm = new THREE.InstancedMesh(poleGeo, poleMat, flags.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = V(1, 1, 1);
  flags.forEach((f, i) => {
    q.setFromAxisAngle(V(0, 1, 0), f.yaw + Math.PI / 2);
    pm.setMatrixAt(i, m4.compose(V(f.x, f.y + 0.3, f.z), q, one));
    fm.setMatrixAt(i, m4.compose(V(f.x, f.y + 1.25, f.z), q, one));
  });
  root.add(fm, pm);

  // the castle wall closing the courtyard in behind the riders and down both sides
  castleWall(root, -19, -34, 19, -34, { SMALL });
  castleWall(root, -19, -9, -19, -34, { SMALL });
  castleWall(root, 19, -34, 19, -9, { SMALL });

  // the game's torches along the side walls
  const flames = [];
  for (const [x, y, z] of [[-18.4, 1.2, -7.0], [-18.4, 1.2, 0.0], [-18.4, 1.2, 6.9], [18.4, 1.2, -7.0], [18.4, 1.2, 0.0], [18.4, 1.2, 6.9]])
    flames.push(fire(root, x, y, z, 0.5, { light: false }));

  LOD.budget.finish();
  return {
    update(dt, t, camera) { sky(camera); for (const f of flames) f(dt, t); P.samurai.mixer.update(dt); },
    arrive(stop) { if (stop === 5) P.samurai.play("pointing_forward", 0.35, true); },
  };
}
