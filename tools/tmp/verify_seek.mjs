// playOneshot 의 slam 시크 로직을 그대로 흉내 내어 검증한다.
// reset → time=1.87 → timeScale → play → (mixer.update 로 진행) → 끝에서 clamp
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
const a = mixer.clipAction(clip);

const SLAM_IMPACT = 1.87;
const rate = 2.2; // 꽉 모은 충전 (가장 빠른 경우)

// playOneshot 흉내
a.reset();
a.time = SLAM_IMPACT;
a.timeScale = rate;
a.setLoop(THREE.LoopOnce, 1);
a.clampWhenFinished = true;
a.enabled = true;
a.setEffectiveWeight(1);
a.play();

const tmp = new THREE.Vector3();
console.log('재생 시작 직후:');
console.log(`  action.time=${a.time.toFixed(3)}s  (임팩트=${SLAM_IMPACT}s)`);
root.updateMatrixWorld(true);
console.log(`  hipsY=${hips.getWorldPosition(tmp).y.toFixed(3)}  rHandY=${rHand.getWorldPosition(tmp).y.toFixed(3)}  lHandY=${lHandY(lHand, tmp)}`);

// 재생 진행 시뮬레이션 (실시간 0.1s마다)
console.log('\n재생 진행 (rate=2.2x, 실시간 기준):');
for (let real = 0.1; real <= 1.5; real += 0.1) {
  mixer.update(0.1);
  root.updateMatrixWorld(true);
  const hy = hips.getWorldPosition(tmp).y;
  const rhy = rHand.getWorldPosition(tmp).y;
  const lhy = lHand.getWorldPosition(tmp).y;
  const done = !a.isRunning() || a.time >= clip.duration;
  console.log(`  +${real.toFixed(1)}s  clipTime=${a.time.toFixed(2)}/${clip.duration.toFixed(2)}  hipsY=${hy.toFixed(2)} hands=${Math.min(rhy, lhy).toFixed(2)}${done ? '  [완료]' : ''}`);
  if (a.time >= clip.duration) break;
}
console.log(`\n최종: isRunning=${a.isRunning()}  time=${a.time.toFixed(3)}  (끝=${clip.duration.toFixed(3)}에서 clamp)`);

function lHandY(bone, v) { return bone.getWorldPosition(v).y.toFixed(3); }
