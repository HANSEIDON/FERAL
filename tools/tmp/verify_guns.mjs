// 총수 총 검증 — 게임과 같은 AvatarAnim + GunRig 로 동작별로 재서
// 총이 손에 제대로 쥐어졌는지, 교체 때 손에 든 것이 제때 바뀌는지 숫자로 본다.
globalThis.self = globalThis;
URL.createObjectURL = () => 'blob:x';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import fs from 'node:fs';
import { AvatarAnim } from '../../src/game/avatarAnim.js';
import { GunRig, computeGunMounts } from '../../src/game/gunRig.js';
import { MV } from '../../shared/protocol.js';
import { SWAP_SEC } from '../../shared/loadout.js';

THREE.TextureLoader.prototype.load = (u, onLoad) => { const t = new THREE.Texture(); setTimeout(() => onLoad?.(t)); return t; };
const load = async (f) => { const b = fs.readFileSync(f); return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), ''); };
const gunner = await load('public/models/gunner.glb');
const props = await load('public/models/gunner_props.glb');
console.log('Rifle extras', JSON.stringify(props.scene.getObjectByName('Rifle').userData));

const g = new THREE.Group();
const root = clone(gunner.scene);
root.rotation.y = Math.PI;   // 게임과 같다 — 앞이 -Z
g.add(root);
const anim = new AvatarAnim(root, gunner.animations, 'gunner');
const mounts = computeGunMounts(gunner, props);
console.log('mounts', Object.keys(mounts).join(', '), '· 배율', mounts.rifle.scale.x.toFixed(3));
const rig = new GunRig(root, props, mounts);
anim.rigs.push(rig);

const bone = (n) => { let b; root.traverse((o) => { if (!b && o.isBone && o.name.endsWith(n)) b = o; }); return b; };
const W = (o) => { o.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); };
const palm = (side) => W(bone(`${side}Hand`)).lerp(W(bone(`${side}HandMiddle1`)), 0.6);
const fwd = new THREE.Vector3(0, 0, -1);
const cm = (v) => (v * 100).toFixed(0);
const axes = (o) => {
  o.updateWorldMatrix(true, false);
  const q = o.getWorldQuaternion(new THREE.Quaternion());
  return { pos: W(o), z: new THREE.Vector3(0, 0, 1).applyQuaternion(q), y: new THREE.Vector3(0, 1, 0).applyQuaternion(q) };
};
const distToLine = (p, a, dir) => { const d = p.clone().sub(a); return d.sub(dir.clone().multiplyScalar(d.dot(dir))).length(); };

function report(label) {
  g.updateMatrixWorld(true);
  const show = [rig.rifle.visible && '소총', rig.pistol.visible && '권총', rig.rifleSling.visible && '허리에 소총'].filter(Boolean).join('+') || '없음';
  let line = `${label.padEnd(14)} [${anim.currentName}→${anim.current.getClip().name}${anim.upperOn ? ' +상체 ' + anim.upperOn.getClip().name : ''}] 손: ${anim.hands ?? '빈손'} · 보임: ${show}`;
  const held = rig.rifle.visible ? rig.rifle : rig.pistol.visible ? rig.pistol : null;
  if (held) {
    const a = axes(held);
    line += `\n${''.padEnd(14)} 손잡이-오른손 ${cm(a.pos.distanceTo(palm('Right')))}cm · 총구·앞 ${a.z.dot(fwd).toFixed(2)} · 총 위·하늘 ${a.y.y.toFixed(2)}`;
    if (held === rig.rifle) line += ` · 두손잡기 ${rig.twoHand.toFixed(2)} · 왼손-총열덮개밑 ${cm(palm('Left').distanceTo(a.pos.clone().addScaledVector(a.y, 0.0408).addScaledVector(a.z, palm('Left').sub(a.pos).dot(a.z))))}cm · 왼손-총열선 ${cm(distToLine(palm('Left'), a.pos, a.z))}cm (손잡이에서 앞으로 ${cm(palm('Left').sub(a.pos).dot(a.z))}cm)`;
  }
  if (rig.rifleSling.visible) {
    const a = axes(rig.rifleSling), spine = W(bone('Spine2'));
    // 등 쪽(+앞의 반대)에 있어야 한다 — 몸통 중심에서 앞뒤로 얼마나
    line += `\n${''.padEnd(14)} 허리 소총: 척추에서 앞쪽으로 ${cm(a.pos.clone().sub(spine).dot(fwd))}cm · 총구 높이 ${cm(a.pos.clone().addScaledVector(a.z, 0.5).y)}cm`;
  }
  console.log(line);
}
const step = (secs, mv, speed, state = 'alive') => { for (let i = 0; i < Math.round(secs * 60); i++) anim.update(1 / 60, mv, state, speed); };

step(1, 0, 0); report('소총 서 있기');
step(1, MV.FIRE, 0); report('소총 서서 쏘기');
step(1, MV.FWD | MV.FIRE, 4.5); report('소총 달리며 쏘기');
step(1, MV.FWD, 4.5); report('소총 달리기');
step(1, MV.FWD | MV.SPRINT, 6.3); report('소총 질주');
anim.reload(2.2); step(1.1, MV.FWD, 4.5); report('소총 재장전 중');
step(1.5, 0, 0); report('소총 서 있기2');

console.log(`--- 권총으로 (교체 ${SWAP_SEC}s)`);
for (let k = 0; k < 6; k++) { step(SWAP_SEC / 5, MV.ALT, 0); report(`  +${((k + 1) * SWAP_SEC / 5).toFixed(2)}s`); }
step(0.5, MV.ALT, 0); report('권총 서 있기');
step(1, MV.ALT | MV.FIRE, 0); report('권총 서서 쏘기');
step(1, MV.ALT | MV.FWD, 4.5); report('권총 달리기');
anim.reload(1.5); step(0.7, MV.ALT | MV.FWD, 4.5); report('권총 재장전 중');
step(1, MV.ALT | MV.AIR, 0); report('권총 점프');

console.log(`--- 소총으로`);
for (let k = 0; k < 6; k++) { step(SWAP_SEC / 5, 0, 0); report(`  +${((k + 1) * SWAP_SEC / 5).toFixed(2)}s`); }
step(3, 0, 0, 'downed'); report('쓰러짐');
step(1, 0, 0); report('부활');

// ── 허리에 멘 소총이 몸(다리 · 몸통 · 팔)을 뚫는지 — 총 위 점들이 몸 안에 들어가는지 본다.
// 몸 안 판정: 가장 가까운 몸 정점을 그 정점이 주로 붙은 뼈대에서 바깥쪽으로 보고,
// 점이 그 뼈대에 정점보다 가까우면 안쪽이다.
console.log('--- 허리 소총 관통 검사');
const bodies = []; root.traverse((o) => { if (o.isSkinnedMesh) bodies.push(o); });
function slingCheck(label) {
  g.updateMatrixWorld(true);
  const verts = [], v = new THREE.Vector3();
  for (const m of bodies) {
    const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    for (let i = 0; i < m.geometry.attributes.position.count; i++) {
      m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld);
      let best = 0; for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
      verts.push([v.clone(), W(m.skeleton.bones[si.getComponent(i, best)])]);
    }
  }
  const a = axes(rig.rifleSling);
  let inside = 0, minGap = Infinity; const N = 24;
  for (let k = 0; k <= N; k++) {
    const p = a.pos.clone().addScaledVector(a.z, -0.3 + 0.85 * k / N);   // 개머리(-0.3m) ~ 총구(+0.55m)
    let nd = Infinity, near = null;
    for (const vb of verts) { const d = vb[0].distanceToSquared(p); if (d < nd) { nd = d; near = vb; } }
    const gap = Math.sqrt(nd);
    if (p.distanceTo(near[1]) < near[0].distanceTo(near[1])) inside++; else minGap = Math.min(minGap, gap);
  }
  console.log(`${label.padEnd(12)} 총 위 ${N + 1}점 중 몸 안 ${inside}점 · 몸 밖 점의 최소 간격 ${cm(minGap)}cm · 총구 높이 ${cm(a.pos.clone().addScaledVector(a.z, 0.55).y)}cm`);
}
step(SWAP_SEC + 0.5, MV.ALT, 0); slingCheck('권총 서기');
step(1, MV.ALT | MV.FIRE, 0); slingCheck('권총 쏘기');
for (const t of [0.15, 0.3, 0.45, 0.6]) { step(0.15, MV.ALT | MV.FWD, 4.5); slingCheck('권총 달리기' + t); }
step(0.3, MV.ALT | MV.AIR, 0); slingCheck('권총 점프');
