// jump 클립의 Hips 상대 상승량 확인 (점프 중 slam을 미리 틀어도 이상한지 판단용)
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
if (typeof self === 'undefined') globalThis.self = globalThis;
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const buf = readFileSync(new URL('../../public/models/zombie.glb', import.meta.url));
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(0), '', res, rej));
const root = gltf.scene;
root.updateMatrixWorld(true);
const hips = root.getObjectByName('mixamorigHips');
for (const name of ['jump', 'jump_short', 'idle']) {
  const clip = gltf.animations.find((a) => a.name === name);
  if (!clip) { console.log(name, ': 없음'); continue; }
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const tmp = new THREE.Vector3();
  let min = Infinity, max = -Infinity;
  for (let i = 0; i <= 40; i++) {
    action.time = (i / 40) * clip.duration;
    mixer.update(0);
    root.updateMatrixWorld(true);
    const y = hips.getWorldPosition(tmp).y;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  console.log(`${name}: 길이=${clip.duration.toFixed(2)}s  hipsY min=${min.toFixed(2)} max=${max.toFixed(2)} (상대 상승 ${max - min.toFixed(2)}m)`);
}
