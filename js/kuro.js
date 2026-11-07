// Kurō, the rōnin, walks the path with you: a few steps ahead of the camera, through each gate,
// up to each world's character. The scroll moves him; how far he moved sets his walking pace.
// At a stop he does his part: kneels to the daimyo, smacks the bandit chief, bows to the monk.
import * as THREE from "three";
import { loadCharacter } from "./assets.js?v=51";

const A = n => `anims/${n}.fbx`;
const UP = new THREE.Vector3(0, 1, 0);
const WALK_SPEED = 1.25; // metres a second the walk clip covers at normal speed

export async function createKuro() {
  const K = await loadCharacter("models/kuro.glb", {
    idle: A("unarmed_idle"),
    walk: A("unarmed_walk_forward"),
    kneel: A("kneeling_idle"),
    punch: A("standing_melee_punch"),
    nod: A("head_nod_yes"),
    ack: A("acknowledging"),
  }, 1.8, { weapons: false });
  const { model, mixer, actions } = K;
  model.name = "kuro";
  // the toes as they were when his sandals were fitted: the clips bend them, which pulls the
  // sandals (tied mostly to the toe bones) off his feet, so they're held there every frame
  let body = null; model.traverse(o => { if (!body && o.isSkinnedMesh) body = o; });
  const toes = [];
  if (body) {
    const keep = body.skeleton.bones.map(b => [b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
    body.skeleton.pose();
    model.traverse(o => { if (o.isBone && /toebase$/i.test(o.name)) toes.push([o, o.quaternion.clone()]); });
    body.skeleton.bones.forEach((b, i) => { b.position.copy(keep[i][0]); b.quaternion.copy(keep[i][1]); b.scale.copy(keep[i][2]); });
  }
  const mats = [];
  model.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) if (!mats.includes(m)) mats.push(m); });
  // every clip runs; their weights are set each frame
  if (K.current) K.current.stop();
  for (const a of Object.values(actions)) { a.enabled = true; a.setEffectiveWeight(0); a.play(); }
  for (const n of ["punch", "nod", "ack"]) { actions[n].setLoop(THREE.LoopOnce, 1); actions[n].clampWhenFinished = true; }
  const bones = {};
  model.traverse(o => { if (o.isBone) bones[o.name.replace(/^mixamorig\d*[_:]?/i, "").toLowerCase()] = o; });
  const spine = ["spine", "spine1", "spine2", "neck", "head"].map(n => bones[n]).filter(Boolean);

  const pos = new THREE.Vector3(), prev = new THREE.Vector3();
  let yaw = 0, first = true, walkW = 0, act = null, actW = 0, actT = 0, actDone = null, bow = 0, hitSent = false;
  const _d = new THREE.Vector3(), _ax = new THREE.Vector3(), _q = new THREE.Quaternion(), _qb = new THREE.Quaternion();

  // the ground under him, from whichever world he stands in (cached on a 25 cm grid)
  const cache = new Map();
  const solids = w => w.solids || (w.solids = (() => {
    const out = [];
    w.scene.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o === w.mask) return;
      const m = [].concat(o.material)[0];
      if (!m || m.isShaderMaterial || m.isMeshBasicMaterial || m.transparent) return;
      out.push(o);
    });
    return out;
  })());
  const rc = new THREE.Raycaster(); rc.far = 3.2;
  const groundY = (w, x, z, base) => {
    const key = `${w.index}|${Math.round(x * 4)}|${Math.round(z * 4)}`;
    if (cache.has(key)) return cache.get(key);
    rc.set(_d.set(x, base + 1.3, z), new THREE.Vector3(0, -1, 0));
    const hit = rc.intersectObjects(solids(w), false)[0];
    const y = hit ? hit.point.y : base;
    cache.set(key, y);
    return y;
  };

  const startAct = name => {
    act = name; actT = 0; hitSent = false;
    if (actions[name]) actions[name].reset().play();
  };

  // tgt.kuro: where the scroll puts him; tgt.kact: { face, act, world } when he's at a stop
  const update = (dt, tgt, worlds, cur, past) => {
    const k = first ? 1 : 1 - Math.exp(-dt * 3.2);
    prev.copy(pos);
    pos.x += (tgt.kuro.x - pos.x) * k; pos.z += (tgt.kuro.z - pos.z) * k;
    // which world his feet are in, and the ground there
    let j = cur;
    // (only the gates either side of the camera's world: the worlds don't all lie in a line)
    if (j < worlds.length - 1 && worlds[j].def.gate && past(worlds[j], pos) > 0 && worlds[j + 1].ready) j++;
    else if (j > 0 && past(worlds[j - 1], pos) < 0) j--;
    const gy = worlds[j].ready ? groundY(worlds[j], pos.x, pos.z, tgt.kuro.y) : tgt.kuro.y;
    pos.y = first ? gy : pos.y + (gy - pos.y) * Math.min(1, dt * 12);
    const speed = first ? 0 : Math.hypot(pos.x - prev.x, pos.z - prev.z) / Math.max(dt, 1e-3);
    first = false;

    // facing: the way he walks; standing still, toward whoever he came to see
    // (scrolling back up, he steps backward, still facing the way the path goes)
    const fx = tgt.kdir ? tgt.kdir.x : 0, fz = tgt.kdir ? tgt.kdir.z : 0;
    const back = speed > 0.25 && (pos.x - prev.x) * fx + (pos.z - prev.z) * fz < 0;
    let want = null;
    if (speed > 0.25) want = back ? Math.atan2(fx, fz) : Math.atan2(pos.x - prev.x, pos.z - prev.z);
    else if (tgt.kact) { _d.subVectors(tgt.kact.face, pos); want = Math.atan2(_d.x, _d.z); }
    else if (fx || fz) want = Math.atan2(fx, fz);
    if (want !== null) {
      let dy = want - yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      yaw += dy * Math.min(1, dt * (speed > 0.25 ? 6 : 4));
    }
    model.position.copy(pos);
    model.rotation.y = yaw;

    // arrived and standing still: his moment, once per visit
    const here = tgt.kact && pos.distanceTo(_d.copy(tgt.kact.at).setY(pos.y)) < 0.35 && speed < 0.3;
    if (here && actDone !== tgt.kact && !act) {
      actDone = tgt.kact;
      if (tgt.kact.act) startAct(tgt.kact.act);
    }
    if (!tgt.kact || pos.distanceTo(_d.copy(tgt.kact.at).setY(pos.y)) > 1.2) { if (actDone && !here) actDone = null; }
    const moving = speed > 0.3;
    if (act) {
      actT += dt;
      const a = actions[act];
      const len = a ? a.getClip().duration : 2.6;
      let end = false;
      if (act === "kneel") end = moving;                    // he stays down until you walk on
      else if (act === "bow") end = actT > 2.8 || moving;
      else end = actT > len - 0.25 || (moving && actT > 0.6);
      if (act === "punch" && !hitSent && actT > len * 0.42) { hitSent = true; tgt.kact && tgt.kact.world.api && tgt.kact.world.api.react && tgt.kact.world.api.react(); }
      actW = end ? Math.max(0, actW - dt * 2.5) : Math.min(1, actW + dt * 3.5);
      if (end && actW === 0) act = null;
    }
    // a bow: bend at the waist and neck while standing (no clip for it), down, hold, up
    const bowTarget = act === "bow" ? (actT < 2.2 ? 1 : 0) : 0;
    bow += (bowTarget - bow) * Math.min(1, dt * (bowTarget ? 3 : 2.4));

    walkW += ((moving ? 1 : 0) - walkW) * Math.min(1, dt * 6);
    const clipAct = act && actions[act] ? actW : 0;
    actions.walk.setEffectiveWeight((1 - clipAct) * walkW);
    actions.walk.timeScale = (back ? -0.8 : 1) * THREE.MathUtils.clamp(speed / WALK_SPEED, 0.5, 2.4);
    actions.idle.setEffectiveWeight((1 - clipAct) * (1 - walkW));
    for (const n of ["kneel", "punch", "nod", "ack"]) actions[n].setEffectiveWeight(n === act ? clipAct : 0);
    mixer.update(dt);
    for (const [b, q] of toes) b.quaternion.copy(q);

    if (bow > 0.002 && spine.length) {
      model.updateMatrixWorld(true);
      _ax.set(1, 0, 0).applyAxisAngle(UP, yaw); // his left, so a positive turn tips him forward
      const amt = [0.42, 0.3, 0.18, 0.12, 0.14];
      spine.forEach((b, i) => {
        b.getWorldQuaternion(_q).invert();
        const local = _ax.clone().applyQuaternion(_q);
        b.quaternion.multiply(_qb.setFromAxisAngle(local, amt[i] * bow));
        b.updateMatrixWorld(true);
      });
    }
    return j;
  };
  return { model, mats, update, get pos() { return pos; }, get act() { return act; } };
}
