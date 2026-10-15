// gunner.glb 검증 — 새 GLB 와 원본 Ch35 FBX 에 같은 클립·같은 시점을 틀어서
// 세계공간 스킨드 정점 좌표를 비교한다 (IBM · 가중치 · 트랙 · 스케일 · 줄인 메시 전체).
// 줄인 메시의 정점은 원본 정점을 그대로 골라 쓴 것이라 좌표로 짝을 찾는다.
globalThis.self = globalThis;
URL.createObjectURL = () => 'blob:x';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
// 받은 원본이 있는 다운로드 폴더 — 다른 곳이면 FERAL_DOWNLOADS 로 바꾼다
const DOWNLOADS_DIR = process.env.FERAL_DOWNLOADS ?? `${homedir()}/Downloads`;

// 이미지는 비교와 무관하다 — 디코드하지 않고 빈 텍스처로 바로 넘긴다
THREE.TextureLoader.prototype.load = (url, onLoad) => { const t = new THREE.Texture(); setTimeout(() => onLoad?.(t)); return t; };
const DIR = DOWNLOADS_DIR + '/총모션';
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const glbBuf = fs.readFileSync(path.join(process.cwd(), 'public/models/gunner.glb'));
const gltf = await new GLTFLoader().parseAsync(toAB(glbBuf), '');
let mesh = null, arm = null;
gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !mesh) mesh = o; if (o.name === 'Armature') arm = o; });
const meshes = []; gltf.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
console.log(`스킨드 메시 ${meshes.length}(재질별) · 뼈대 ${mesh.skeleton.bones.length} · 클립 ${gltf.animations.map((a) => `${a.name}(${a.duration.toFixed(2)})`).join(' ')}`);

const src = new FBXLoader().parse(toAB(fs.readFileSync(path.join(DIR, 'Ch35_nonPBR.fbx'))), '');
let fm = null; src.traverse((o) => { if (o.isSkinnedMesh) fm = o; });
const armMat = new THREE.Matrix4().compose(arm.position, arm.quaternion, arm.scale);

// 원본 좌표 → 원본 정점 번호
const key = (x, y, z) => `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
const fp = fm.geometry.attributes.position;
const byPos = new Map();
for (let i = 0; i < fp.count; i++) byPos.set(key(fp.getX(i), fp.getY(i), fp.getZ(i)), i);
const gp = mesh.geometry.attributes.position;
const pair = [];
for (let v = 0; v < gp.count; v += 5) {
  const i = byPos.get(key(gp.getX(v), gp.getY(v), gp.getZ(v)));
  if (i === undefined) { console.error('✗ 원본에 없는 정점', v); process.exit(1); }
  pair.push([v, i]);
}

// [원본 FBX (총모션 기준 상대 경로), 잘라낸 시작초]. p_aim 은 두 클립을 합친 것이라 비교하지 않는다
const files = {
  idle: ['Rifle Idle.fbx', 0], run: ['Run Forward.fbx', 0], sprint: ['Sprint Forward.fbx', 0], aim: ['Firing Rifle.fbx', 0],
  aim_fwd: ['Firing Rifle (1).fbx', 0], reload: ['Reloading.fbx', 0], jump: ['Rifle Jump.fbx', 0], death: ['Dying.fbx', 0],
  holster_rifle: ['../Rifle Put Away.fbx', 0], draw_rifle: ['Rifle Pull Out.fbx', 0],
  p_idle: ['../권총모션/Pistol Idle.fbx', 0], p_walk: ['../권총모션/Pistol Walk.fbx', 0],
  p_run: ['../권총모션/Pistol Run.fbx', 0], p_jump: ['../권총모션/Pistol Jump.fbx', 24 / 30],
};
const a = new THREE.Vector3(), b = new THREE.Vector3();
let fail = false;
for (const clip of gltf.animations) {
  if (!files[clip.name]) { console.log(`   ${clip.name.padEnd(13)} (합성 클립 — 비교 생략)`); continue; }
  const [file, offset] = files[clip.name];
  const mc = new FBXLoader().parse(toAB(fs.readFileSync(path.join(DIR, file))), '').animations[0];
  const mixer = new THREE.AnimationMixer(gltf.scene); mixer.clipAction(clip).play();
  const fmixer = new THREE.AnimationMixer(src); fmixer.clipAction(mc).play();
  let eMax = 0, lo = Infinity, hi = -Infinity;
  for (const u of [0, 0.25, 0.5, 0.75, 0.99]) {
    const t = clip.duration * u;
    mixer.setTime(t); gltf.scene.updateMatrixWorld(true);
    fmixer.setTime(t + offset); src.updateMatrixWorld(true);
    let minY = Infinity;
    for (const [v, i] of pair) {
      mesh.getVertexPosition(v, a).applyMatrix4(mesh.matrixWorld);
      fm.getVertexPosition(i, b).applyMatrix4(fm.matrixWorld).applyMatrix4(armMat);
      eMax = Math.max(eMax, a.distanceTo(b));
      minY = Math.min(minY, a.y);
    }
    lo = Math.min(lo, minY); hi = Math.max(hi, minY);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene); fmixer.stopAllAction(); fmixer.uncacheRoot(src);
  const ok = eMax < 0.005;
  console.log(`${ok ? '✅' : '✗'} ${clip.name.padEnd(13)} 오차 max=${(eMax * 100).toFixed(3)}cm  최저점 y=${(lo * 100).toFixed(1)}~${(hi * 100).toFixed(1)}cm`);
  if (!ok) fail = true;
}
if (fail) { console.error('✗ 엔드투엔드 검증 실패'); process.exit(1); }
console.log('✅ 엔드투엔드 애니메이션 정상');
