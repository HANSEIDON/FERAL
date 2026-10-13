// 사냥꾼 활 검증 — 게임과 같은 AvatarAnim + BowRig 로 동작별 자세를 재서
// 활이 손에 제대로 쥐어졌는지, 시위·화살이 손가락을 따라가는지 숫자로 본다.
globalThis.self = globalThis;
URL.createObjectURL = () => 'blob:x';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import fs from 'node:fs';
import { AvatarAnim } from '../../src/game/avatarAnim.js';
import { BowRig, computeBowMount } from '../../src/game/bowRig.js';
import { MV } from '../../shared/protocol.js';

THREE.TextureLoader.prototype.load = (u, onLoad) => { const t = new THREE.Texture(); setTimeout(() => onLoad?.(t)); return t; };
const load = async (f) => { const b = fs.readFileSync(f); return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), ''); };
const hunter = await load('public/models/hunter.glb');
const props = await load('public/models/hunter_props.glb');
const bowNode = props.scene.getObjectByName('Bow');
console.log('Bow extras:', JSON.stringify(bowNode.userData));

// 게임과 같은 구성 — 바깥 Group(서버 yaw) 안에 π 돌린 모델
const g = new THREE.Group();
const root = clone(hunter.scene);
root.rotation.y = Math.PI;
g.add(root);
const anim = new AvatarAnim(root, hunter.animations, 'hunter');
const mount = computeBowMount(hunter);
console.log('mount scale', mount.scale.toArray().map((v) => v.toFixed(3)).join(','));
const rig = new BowRig(root, props, mount);
anim.rigs.push(rig);

const bone = (n) => { let b; root.traverse((o) => { if (!b && o.isBone && o.name.endsWith(n)) b = o; }); return b; };
const W = (o) => { o.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); };
const toWorld = (v) => v.clone().applyMatrix4(rig.bow.matrixWorld);
const fwd = new THREE.Vector3(0, 0, -1);   // 게임 규약 앞 (-Z)
const cm = (v) => (v * 100).toFixed(0);

function report(label) {
  g.updateMatrixWorld(true);
  const top = toWorld(rig.top), bottom = toWorld(rig.bottom), grip = toWorld(new THREE.Vector3());
  const bowUp = top.clone().sub(bottom).normalize();
  const lh = W(bone('LeftHand')), head = W(bone('Head'));
  const fingers = W(bone('RightHandIndex2')).add(W(bone('RightHandMiddle2'))).multiplyScalar(0.5);
  const nock = toWorld(rig.upper.position);
  let line = `${label.padEnd(10)} ${rig.bow.visible ? '' : '(활 숨김) '}활 위끝 y=${cm(top.y)} 아래끝 y=${cm(bottom.y)}cm  기울기 ${(Math.acos(Math.min(1, Math.abs(bowUp.y))) * 180 / Math.PI).toFixed(0)}°  손잡이-왼손 ${cm(grip.distanceTo(lh))}cm  머리-활 ${cm(distToSegment(head, top, bottom))}cm`;
  if (rig.arrow.visible) {
    const tail = toWorld(rig.arrow.position);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.arrow.getWorldQuaternion(new THREE.Quaternion()));
    const tip = tail.clone().addScaledVector(dir, 0.95);
    line += `\n${''.padEnd(10)} 시위중앙-손가락 ${cm(nock.distanceTo(fingers))}cm  화살 방향·앞 ${dir.dot(fwd).toFixed(2)}  촉이 손잡이 앞으로 ${cm(tip.clone().sub(grip).dot(dir))}cm  화살-손잡이 거리 ${cm(distToSegment(grip, tail, tip))}cm`;
  }
  console.log(line);
}
function distToSegment(p, a, b) {
  const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}
const run = (secs, mv, speed, state = 'alive') => { for (let i = 0; i < secs * 60; i++) anim.update(1 / 60, mv, state, speed); };

run(1, 0, 0); report('서 있기');
run(0.5, MV.FIRE, 0); report('당김 0.5s');
run(1.5, MV.FIRE, 0); report('풀장전');
run(1 / 60, 0, 0); report('놓음');
run(1, MV.FWD, 4.5); report('달리기');
run(1, MV.FWD | MV.FIRE, 1.6); report('조준 걷기');
run(0.3, MV.AIR, 0); report('점프');
run(3, 0, 0, 'downed'); report('쓰러짐');
