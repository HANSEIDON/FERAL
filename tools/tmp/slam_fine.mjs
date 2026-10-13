// slam 클립 임팩트 시점 정밀 측정 (1.4~2.4s 구간, 0.01s 간격)
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
if (typeof self === 'undefined') globalThis.self = globalThis;
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const buf = readFileSync(new URL('../../public/models/zombie.glb', import.meta.url));
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(0), '', res, rej));
const root = gltf.scene;
root.updateMatrixWorld(true);
const hips = root.getObjectByName('mixamorigHips');
const rHand = root.getObjectByName('mixamorigRightHand');
const lHand = root.getObjectByName('mixamorigLeftHand');
const clip = gltf.animations.find((a) => a.name === 'slam');
const mixer = new THREE.AnimationMixer(root);
const action = mixer.clipAction(clip);
action.setLoop(THREE.LoopOnce, 1);
action.clampWhenFinished = true;
action.play();
const tmp = new THREE.Vector3();
let best = { t: 0, m: Infinity };
for (let t = 1.4; t <= 2.4; t += 0.01) {
  action.time = t;
  mixer.update(0);
  root.updateMatrixWorld(true);
  const hy = hips.getWorldPosition(tmp).y;
  const rhy = rHand.getWorldPosition(tmp).y;
  const lhy = lHand.getWorldPosition(tmp).y;
  const m = Math.min(rhy, lhy);
  if (m < best.m) best = { t, m, hy };
}
console.log(`손 최저점: t=${best.t.toFixed(2)}s  handY=${best.m.toFixed(3)}  hipsY=${best.hy.toFixed(3)}`);
console.log(`클립 길이: ${clip.duration.toFixed(3)}s  → 임팩트 위치 ${(best.t / clip.duration * 100).toFixed(1)}%`);
