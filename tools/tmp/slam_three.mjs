// three.js 로 slam 클립을 실제로 구동해 Hips·손끝의 월드 높이를 시계열로 뽑는다.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

// Node에는 self가 없는데 GLTFLoader가 참조함 → shim
if (typeof self === 'undefined') globalThis.self = globalThis;
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

const buf = readFileSync(new URL('../../public/models/zombie.glb', import.meta.url));
const loader = new GLTFLoader();
const gltf = await new Promise((res, rej) => loader.parse(buf.buffer.slice(0), '', res, rej));

const root = gltf.scene;
root.updateMatrixWorld(true);

const hips = root.getObjectByName('mixamorigHips');
const rHand = root.getObjectByName('mixamorigRightHand');
const lHand = root.getObjectByName('mixamorigLeftHand');
console.log('hips:', !!hips, 'rHand:', !!rHand, 'lHand:', !!lHand);

const clip = gltf.animations.find((a) => a.name === 'slam');
console.log('clip duration:', clip.duration);

const mixer = new THREE.AnimationMixer(root);
const action = mixer.clipAction(clip);
action.setLoop(THREE.LoopOnce, 1);
action.clampWhenFinished = true;
action.play();

const dur = clip.duration;
const N = 40;
const v = { h: [], rh: [], lh: [] };
const tmp = new THREE.Vector3();
for (let i = 0; i <= N; i++) {
  const t = (i / N) * dur;
  action.time = t;
  mixer.update(0);
  root.updateMatrixWorld(true);
  const hy = hips.getWorldPosition(tmp).y;
  const rhy = rHand.getWorldPosition(tmp).y;
  const lhy = lHand.getWorldPosition(tmp).y;
  v.h.push(hy); v.rh.push(rhy); v.lh.push(lhy);
  console.log(`t=${t.toFixed(2)}s (${(t/dur*100).toFixed(0)}%)  hipsY=${hy.toFixed(3)}  rHandY=${rhy.toFixed(3)}  lHandY=${lhy.toFixed(3)}`);
}
const minH = Math.min(...v.h), maxH = Math.max(...v.h);
const minR = Math.min(...v.rh), minL = Math.min(...v.lh);
console.log(`\nhips  min=${minH.toFixed(3)} max=${maxH.toFixed(3)}`);
console.log(`rHand min=${minR.toFixed(3)}  lHand min=${minL.toFixed(3)}`);
console.log(`hips 최저점 시점: t=${(v.h.indexOf(minH)/N*dur).toFixed(2)}s (${(v.h.indexOf(minH)/N*100).toFixed(0)}%)`);
console.log(`rHand 최저점 시점: t=${(v.rh.indexOf(minR)/N*dur).toFixed(2)}s (${(v.rh.indexOf(minR)/N*100).toFixed(0)}%)`);
console.log(`lHand 최저점 시점: t=${(v.lh.indexOf(minL)/N*dur).toFixed(2)}s (${(v.lh.indexOf(minL)/N*100).toFixed(0)}%)`);
