// hunter.glb 검증
// 1) GLTFLoader 로 로드 → 스킨드 메시·스켈레톤·클립 확인
// 2) 엔드투엔드: 새 GLB 와 원본 Mixamo FBX 를 같은 클립·같은 시점으로 재생해서
//    세계공간 스킨드 정점 좌표를 비교 (IBM·가중치·트랙·스케일 전체 검증)
//    FBX 는 자기 바인드 포즈(boneInverses) 그대로 두고, 결과에 Armature 의
//    T·S(k) 만 곱한다 — 기준 쪽에서 IBM 을 다시 구하면 같은 실수를 따라 하게 된다.
// 3) 발바닥이 바닥(y=0) 근처에 있는지 (공중부양·가라앉음)
globalThis.self = globalThis;
globalThis.document = { createElementNS: () => ({ style: {} }) };
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
// 받은 원본이 있는 다운로드 폴더 — 다른 곳이면 FERAL_DOWNLOADS 로 바꾼다
const DOWNLOADS_DIR = process.env.FERAL_DOWNLOADS ?? `${homedir()}/Downloads`;

const OUT = path.join(process.cwd(), 'public/models/hunter.glb');
const MOTION = DOWNLOADS_DIR + '/모션';
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

const gltf = await new GLTFLoader().parseAsync(toAB(fs.readFileSync(OUT)), '');
let mesh = null, armature = null;
gltf.scene.traverse((o) => {
  if (o.isSkinnedMesh) mesh = o;
  if (o.name === 'Armature') armature = o;
});
if (!mesh) { console.error('✗ 스킨드 메시 없음'); process.exit(1); }
console.log('뼈대:', mesh.skeleton.bones.length, ' Armature k:', armature.scale.x.toFixed(4), ' y:', armature.position.y.toFixed(4));
console.log('클립:', gltf.animations.map((a) => `${a.name}(${a.duration.toFixed(2)}s)`).join(', '));

// GLB 정점 v ↔ FBX 비인덱스 정점 (첫 등장 위치)
const index = mesh.geometry.index.array;
const glbToFbx = new Int32Array(mesh.geometry.attributes.position.count).fill(-1);
for (let i = 0; i < index.length; i++) if (glbToFbx[index[i]] === -1) glbToFbx[index[i]] = i;

const armMat = new THREE.Matrix4().compose(
  armature.position, armature.quaternion, armature.scale);

// [GLB 클립, 원본 FBX, 원본에서 잘라낸 시작초]
const samples = [
  ['idle', 'Standing Idle 01.fbx', 0],
  ['idle_long', 'Standing Idle 03 Examine.fbx', 0],
  ['run', 'Standing Run Forward.fbx', 0],
  ['aim', 'Standing Aim Overdraw.fbx', 0],
  ['aim_fwd', 'Standing Aim Walk Forward.fbx', 0],
  ['aim_back', 'Standing Aim Walk Back.fbx', 0],
  ['aim_left', 'Standing Aim Walk Left.fbx', 0],
  ['aim_right', 'Standing Aim Walk Right.fbx', 0],
  ['death', 'Standing Death Backward 01.fbx', 0],
  ['jump', 'Standing Jump Running To Run Forward.fbx', 0.43],
];
const a = new THREE.Vector3(), b = new THREE.Vector3();
let fail = false;
for (const [clipName, file, offset] of samples) {
  const clip = gltf.animations.find((c) => c.name === clipName);
  if (!clip) { console.error(`✗ 클립 없음: ${clipName}`); fail = true; continue; }
  if (clip.tracks.length !== mesh.skeleton.bones.length + 1) { console.error(`✗ ${clipName} 트랙 ${clip.tracks.length}개 (뼈대마다 하나 + Hips 위치여야 한다)`); fail = true; }
  const fg = new FBXLoader().parse(toAB(fs.readFileSync(path.join(MOTION, file))), '');
  let fm = null; fg.traverse((o) => { if (o.isSkinnedMesh) fm = o; });
  const fclip = fg.animations[0];

  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(clip).play();
  const fmixer = new THREE.AnimationMixer(fg);
  fmixer.clipAction(fclip).play();

  let eMax = 0, footMin = Infinity, footMax = -Infinity;
  for (const u of [0, 0.25, 0.5, 0.75, 0.99]) {
    const t = clip.duration * u;
    mixer.setTime(t); gltf.scene.updateMatrixWorld(true);
    fmixer.setTime(t + offset); fg.updateMatrixWorld(true);
    let minY = Infinity;
    for (let v = 0; v < glbToFbx.length; v += 7) {
      mesh.getVertexPosition(v, a).applyMatrix4(mesh.matrixWorld);
      fm.getVertexPosition(glbToFbx[v], b).applyMatrix4(fm.matrixWorld).applyMatrix4(armMat);
      eMax = Math.max(eMax, a.distanceTo(b));
      minY = Math.min(minY, a.y);
    }
    footMin = Math.min(footMin, minY); footMax = Math.max(footMax, minY);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
  const ok = eMax < 0.005;
  console.log(`${ok ? '✅' : '✗'} ${clipName.padEnd(9)} 오차 max=${(eMax * 100).toFixed(3)}cm  최저점 y=${(footMin * 100).toFixed(1)}~${(footMax * 100).toFixed(1)}cm`);
  if (!ok) fail = true;
}
if (fail) { console.error('✗ 엔드투엔드 검증 실패'); process.exit(1); }
console.log('✅ 엔드투엔드 애니메이션 정상');
