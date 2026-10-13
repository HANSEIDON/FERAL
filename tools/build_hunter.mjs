// ComfyUI GLB(텍스처) + Mixamo FBX(스켈레톤·모션) → 게임용 hunter.glb
//
//   node tools/build_hunter.mjs
//
// 전략:
//   - ComfyUI GLB 의 지오메트리·머티리얼·텍스처를 그대로 쓴다 (BIN chunk 복사)
//   - Mixamo FBX 에서 스켈레톤(뼈대 계층)·스킨 가중치·애니메이션을 뽑아온다
//   - 두 메시는 토폴로지·UV·좌표가 100% 동일하므로 (검증됨)
//     GLB 인덱스 배열로 FBX 비인덱스 정점 ↔ GLB 인덱스 정점 대응
//   - IBM 은 FBX 의 바인드 포즈를 **스케일 없이** 그대로 쓴다.
//     glTF 스킨 정점 = joint.matrixWorld × IBM × 정점좌표 이고, 정점좌표는
//     원본 크기(0.89m) 그대로다. IBM 도 같은 원본 공간이어야
//     Armature 스케일 k 가 메시와 뼈대에 똑같이 걸린다.
//     (예전엔 k 로 키운 뒤 IBM 을 구해서 정점이 뼈대 위치와 1/k 만큼 어긋나
//      메시가 찢어졌다)
//   - Mixamo 클립의 Hips 높이가 이미 발을 바닥에 놓는다. Armature 로 따로
//     띄우면 그만큼 공중에 뜬다 — idle 첫 프레임 발바닥 기준으로만 맞춘다.
//
// 출력: public/models/hunter.glb

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const GLB_PATH = 'C:/Users/haki0/Downloads/ComfyUI_00018.glb';
const MOTION_DIR = 'C:/Users/haki0/Downloads/모션';
const OUT_PATH = path.join(ROOT, 'public/models/hunter.glb');
const TARGET_HEIGHT = 1.75;

// FBX 파일명(소문자, 확장자 제외) → 게임 클립명 (avatarAnim.js 가 이 이름으로 고른다)
// [이름, 시작초, 끝초] 이면 그 구간만 잘라 쓴다.
const CLIP_MAP = {
  'standing idle 01':                     'idle',
  'standing idle 03 examine':             'idle_long',
  'standing run forward':                 'run',
  // 활을 당기고 있는 동안 — 서 있으면 aim, 움직이면 방향별 조준 걷기
  'standing aim overdraw':                'aim',
  'standing aim walk forward':            'aim_fwd',
  'standing aim walk back':               'aim_back',
  'standing aim walk left':               'aim_left',
  'standing aim walk right':              'aim_right',
  'standing death backward 01':           'death',
  // 앞 0.45초는 달리기, 1.07초 뒤로는 다시 달리기다. 공중에 뜬 구간만 남긴다
  // (게임 점프 체공 0.65초와 거의 같다). 처음부터 틀면 공중에서 달리는 것처럼 보인다.
  'standing jump running to run forward': ['jump', 0.43, 1.07],
};

const log = (...a) => console.log(...a);
const die = (m) => { console.error('✗', m); process.exit(1); };

// ────────────────────────────────────────────────────────────────
// 1. ComfyUI GLB 파싱 (JSON + BIN)
// ────────────────────────────────────────────────────────────────
const glbBuf = fs.readFileSync(GLB_PATH);
if (glbBuf.readUInt32LE(0) !== 0x46546c67) die('GLB magic 오류');
const jsonChunkLen = glbBuf.readUInt32LE(12);
const jsonChunkType = glbBuf.readUInt32LE(16);
if (jsonChunkType !== 0x4e4f534a) die('JSON chunk 타입 오류');
const json = JSON.parse(glbBuf.subarray(20, 20 + jsonChunkLen).toString('utf8'));

const binHeaderOffset = 20 + jsonChunkLen;
const binChunkLen = glbBuf.readUInt32LE(binHeaderOffset);
const binChunkType = glbBuf.readUInt32LE(binHeaderOffset + 4);
if (binChunkType !== 0x004e4942) die('BIN chunk 타입 오류');
const binDataStart = binHeaderOffset + 8;
const binData = glbBuf.subarray(binDataStart, binDataStart + binChunkLen);
log(`GLB: JSON ${jsonChunkLen}B, BIN ${binChunkLen}B`);
log(`  nodes=${json.nodes.length} meshes=${json.meshes.length} materials=${json.materials.length}`);
log(`  images=${json.images.length} textures=${json.textures.length} bufferViews=${json.bufferViews.length} accessors=${json.accessors.length}`);

const prim = json.meshes[0].primitives[0];
const posAcc = json.accessors[prim.attributes.POSITION];
const glbVertexCount = posAcc.count;
const indexAcc = json.accessors[prim.indices];
const indexBv = json.bufferViews[indexAcc.bufferView];
const indexOffset = indexBv.byteOffset + (indexAcc.byteOffset || 0);
let indices;
if (indexAcc.componentType === 5123) indices = new Uint16Array(binData.buffer, binData.byteOffset + indexOffset, indexAcc.count);
else if (indexAcc.componentType === 5125) indices = new Uint32Array(binData.buffer, binData.byteOffset + indexOffset, indexAcc.count);
else die(`인덱스 타입 예상과 다름: ${indexAcc.componentType}`);
log(`  GLB 정점=${glbVertexCount} 인덱스=${indices.length}`);

// ────────────────────────────────────────────────────────────────
// 2. Mixamo FBX 로드 (스켈레톤 + 스킨 가중치 기준)
// ────────────────────────────────────────────────────────────────
const fbxLoader = new FBXLoader();
function loadFBX(file) {
  const buf = fs.readFileSync(path.join(MOTION_DIR, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return fbxLoader.parse(ab, '');
}

/** idle 첫 프레임에서 스킨드 메시의 최저점 y (FBX 원본 단위). */
function idleFootY() {
  const g = loadFBX('Standing Idle 01.fbx');
  let m = null;
  g.traverse(o => { if (o.isSkinnedMesh) m = o; });
  const mixer = new THREE.AnimationMixer(g);
  mixer.clipAction(g.animations[0]).play();
  mixer.setTime(0);
  g.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let minY = Infinity;
  for (let i = 0; i < m.geometry.attributes.position.count; i++) {
    m.getVertexPosition(i, v);
    if (v.y < minY) minY = v.y;
  }
  return minY;
}

const baseGroup = loadFBX('Standing Idle 01.fbx');
let baseMesh = null;
baseGroup.traverse(o => { if (o.isMesh) baseMesh = o; });
if (!baseMesh) die('기준 FBX 에서 메시를 찾지 못함');

const bb = new THREE.Box3().setFromBufferAttribute(baseMesh.geometry.attributes.position);
const currentHeight = bb.max.y - bb.min.y;
const k = TARGET_HEIGHT / currentHeight;
log(`\nFBX 높이=${currentHeight.toFixed(4)}m → 목표 ${TARGET_HEIGHT}m, 스케일 k=${k.toFixed(5)}`);

const skeleton = baseMesh.skeleton;
const bones = skeleton.bones;
log(`스켈레톤 뼈대=${bones.length}`);
// FBX 바인드 포즈 그대로 (원본 크기). bindMatrix 는 바인드 당시 메시의 세계행렬 —
// glTF 는 메시 노드 변환을 무시하므로 IBM 에 같이 접어 넣는다.
const inverses = skeleton.boneInverses.map(m => new THREE.Matrix4().multiplyMatrices(m, baseMesh.bindMatrix));

// 루트 뼈대 (부모가 뼈대가 아닌 것)
let rootBone = null;
for (const b of bones) if (!(b.parent && b.parent.isBone)) { rootBone = b; break; }
if (!rootBone) die('루트 뼈대를 찾지 못함');
log(`루트 뼈대: ${rootBone.name}`);

// ────────────────────────────────────────────────────────────────
// 3. 스킨 가중치 매핑 (FBX 비인덱스 → GLB 인덱스)
// ────────────────────────────────────────────────────────────────
const glbToFbx = new Int32Array(glbVertexCount).fill(-1);
for (let i = 0; i < indices.length; i++) {
  const v = indices[i];
  if (glbToFbx[v] === -1) glbToFbx[v] = i;
}
let unmapped = 0;
for (let v = 0; v < glbVertexCount; v++) if (glbToFbx[v] === -1) unmapped++;
if (unmapped) die(`GLB 정점 ${unmapped}개 매핑 실패`);

const fbxSI = baseMesh.geometry.attributes.skinIndex.array;
const fbxSW = baseMesh.geometry.attributes.skinWeight.array;
let maxSkinIdx = 0;
for (let i = 0; i < fbxSI.length; i++) if (fbxSI[i] > maxSkinIdx) maxSkinIdx = fbxSI[i];
if (maxSkinIdx >= bones.length) die(`skinIndex ${maxSkinIdx} >= bones ${bones.length}`);

const glbSI = new Uint16Array(glbVertexCount * 4);
const glbSW = new Float32Array(glbVertexCount * 4);
for (let v = 0; v < glbVertexCount; v++) {
  const f = glbToFbx[v];
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    glbSI[v * 4 + j] = fbxSI[f * 4 + j];
    glbSW[v * 4 + j] = fbxSW[f * 4 + j];
    sum += fbxSW[f * 4 + j];
  }
  // FBXLoader 는 5번째 이후 가중치를 버리기만 하고 정규화는 안 한다 (glTF 는 합 1 필수)
  if (sum > 0) for (let j = 0; j < 4; j++) glbSW[v * 4 + j] /= sum;
}
log(`스킨 가중치 매핑 완료 (maxSkinIndex=${maxSkinIdx})`);

// ────────────────────────────────────────────────────────────────
// 4. 노드 계층 구성
//    node[0]=메시(기존) node[1]=Armature node[2..]=뼈대
// ────────────────────────────────────────────────────────────────
const boneToNode = new Map();
let nIdx = 2;
for (const b of bones) boneToNode.set(b, nIdx++);
const armatureNode = 1;
const meshNode = 0;

// 뼈대 자식 관계 (스켈레톤에 포함된 뼈대끼리만)
const boneChildren = new Map();
for (const b of bones) boneChildren.set(b, []);
let orphanRoots = 0;
for (const b of bones) {
  if (b === rootBone) continue;
  if (b.parent && b.parent.isBone && boneToNode.has(b.parent)) {
    boneChildren.get(b.parent).push(b);
  } else {
    orphanRoots++;
  }
}
if (orphanRoots) log(`  ⚠ 부모가 스켈레톤에 없는 뼈대 ${orphanRoots}개 (Armature 로 연결)`);

const newNodes = new Array(nIdx);
newNodes[meshNode] = json.nodes[0] || {};           // 기존 메시 노드 유지
// Armature translation: idle 첫 프레임의 발바닥을 y=0(바닥)에 맞춘다.
// 바인드 포즈는 메시 중심이 원점(발이 -0.44)이지만, Mixamo 클립의 Hips
// 높이(≈0.40)가 이미 발을 0 근처에 올려놓는다. 바인드 포즈 기준으로 띄우면
// 게임에선 늘 클립이 돌기 때문에 캐릭터가 0.87m 공중에 뜬다.
const armY = -idleFootY() * k;
log(`Armature translation: [0, ${armY.toFixed(4)}, 0] (idle 발바닥 y=0 보정)`);
newNodes[armatureNode] = {
  name: 'Armature',
  children: [meshNode, boneToNode.get(rootBone)],
  translation: [0, armY, 0],
  scale: [k, k, k],
};
for (const b of bones) {
  const node = { name: b.name };
  node.translation = [b.position.x, b.position.y, b.position.z];
  node.rotation = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
  if (b.scale.x !== 1 || b.scale.y !== 1 || b.scale.z !== 1) {
    node.scale = [b.scale.x, b.scale.y, b.scale.z];
  }
  const ch = boneChildren.get(b);
  if (ch && ch.length) node.children = ch.map(c => boneToNode.get(c));
  // 부모가 스켈레톤에 없는 뼈대는 Armature 의 자식으로
  newNodes[boneToNode.get(b)] = node;
}
// 고아 루트(부모가 스켈레톤 밖)는 Armature children 에 추가
for (const b of bones) {
  if (b === rootBone) continue;
  if (!(b.parent && b.parent.isBone && boneToNode.has(b.parent))) {
    if (!newNodes[armatureNode].children.includes(boneToNode.get(b))) {
      newNodes[armatureNode].children.push(boneToNode.get(b));
    }
  }
}
json.nodes = newNodes;
log(`노드 구성: Armature + 메시 + 뼈대 ${bones.length} = ${nIdx}개`);

// ────────────────────────────────────────────────────────────────
// 5. 애니메이션 추출 (FBX 7개)
// ────────────────────────────────────────────────────────────────
const nameToBone = new Map(bones.map(b => [b.name, b]));

/**
 * from~to 초 구간을 30fps 로 다시 샘플링해 0초부터 시작하는 클립으로 만든다.
 * AnimationUtils.subclip 은 구간 안에 키가 없는 트랙(손가락처럼 값이 안 변하는
 * 뼈대)을 통째로 버려서, 그 뼈대가 재생 중에 바인드 포즈로 튄다.
 */
function trimClip(clip, from, to, fps = 30) {
  const n = Math.round((to - from) * fps);
  const tracks = clip.tracks.map((t) => {
    const size = t.getValueSize();
    const interp = t.createInterpolant();
    const times = new Float32Array(n + 1);
    const values = new Float32Array((n + 1) * size);
    for (let i = 0; i <= n; i++) {
      times[i] = i / fps;
      values.set(interp.evaluate(from + i / fps), i * size);
    }
    return new t.constructor(t.name, times, values);
  });
  return new THREE.AnimationClip(clip.name, n / fps, tracks);
}

const clips = [];
for (const [fileStem, entry] of Object.entries(CLIP_MAP)) {
  const [clipName, from, to] = Array.isArray(entry) ? entry : [entry];
  const file = fileStem + '.fbx';
  if (!fs.existsSync(path.join(MOTION_DIR, file))) { log(`  ⚠ 없음: ${file}`); continue; }
  const group = loadFBX(file);
  let clip = group.animations && group.animations[0];
  if (!clip) { log(`  ⚠ 애니메이션 없음: ${file}`); continue; }
  if (from !== undefined) clip = trimClip(clip, from, to);
  clip.name = clipName;
  clips.push({ name: clipName, clip, tracks: clip.tracks.length, duration: clip.duration });
  log(`  ✓ ${clipName} (${clip.duration.toFixed(2)}s, ${clip.tracks.length}트랙) ← ${file}`);
}
if (!clips.length) die('클립이 하나도 없음');

// ────────────────────────────────────────────────────────────────
// 6. 버퍼 조립 (BIN 에 새 데이터 추가)
// ────────────────────────────────────────────────────────────────
// 새 데이터 조각들을 모은 뒤 BIN 뒤에 붙인다. 4바이트 정렬.
const chunks = [];          // { bytes: Uint8Array }
let cursor = binChunkLen;   // BIN 내 오프셋 (기존 데이터 이후)
const newBufferViews = [];
const newAccessors = [];

function align(off, a) { return Math.ceil(off / a) * a; }

function pushBytes(bytes) {
  const off = align(cursor, 4);
  if (off > cursor) chunks.push({ pad: off - cursor });
  chunks.push({ bytes });
  cursor = off + bytes.byteLength;
  return off;
}

function addBufferView(typedArray, target) {
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const off = pushBytes(bytes);
  const bvIdx = json.bufferViews.length + newBufferViews.length;
  const bv = { buffer: 0, byteOffset: off, byteLength: bytes.byteLength };
  if (target) bv.target = target;
  newBufferViews.push(bv);
  return bvIdx;
}

function addAccessor(bvIdx, componentType, count, type, min, max) {
  const accIdx = json.accessors.length + newAccessors.length;
  const acc = { bufferView: bvIdx, componentType, count, type };
  if (min) acc.min = min.map(Number);
  if (max) acc.max = max.map(Number);
  newAccessors.push(acc);
  return accIdx;
}

// 6a. JOINTS_0 (skinIndex) — VEC2? 아니 VEC4 uint16
const siBv = addBufferView(glbSI, 34962);
const siAcc = addAccessor(siBv, 5123, glbVertexCount, 'VEC4');
prim.attributes.JOINTS_0 = siAcc;

// 6b. WEIGHTS_0 (skinWeight) — VEC4 float
const swBv = addBufferView(glbSW, 34962);
const swAcc = addAccessor(swBv, 5126, glbVertexCount, 'VEC4');
prim.attributes.WEIGHTS_0 = swAcc;

// 6c. inverseBindMatrices — 52 × MAT4 (16 float)
const ibsFlat = new Float32Array(bones.length * 16);
inverses.forEach((m, i) => m.toArray(ibsFlat, i * 16));
const ibsBv = addBufferView(ibsFlat, undefined);
const ibsAcc = addAccessor(ibsBv, 5126, bones.length, 'MAT4');

// 6d. skin
const joints = bones.map(b => boneToNode.get(b));
json.skins = [{ joints, inverseBindMatrices: ibsAcc }];
// 이 three.js 의 GLTFLoader 는 primitive.skins 가 아니라 노드의 skin 속성으로
// SkinnedMesh 를 판별한다 (_markDefs). 두 가지 다 걸어둔다.
newNodes[meshNode].skin = 0;
prim.skins = [0];

// 6e. 애니메이션
const newAnimations = [];
for (const { name, clip } of clips) {
  const samplers = [];
  const channels = [];
  for (const track of clip.tracks) {
    // 트랙명: "boneName.position|quaternion|scale"
    const dot = track.name.lastIndexOf('.');
    if (dot < 0) continue;
    const boneName = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    const bone = nameToBone.get(boneName);
    if (!bone) { log(`    ⚠ 트랙 뼈대 없음: ${boneName}`); continue; }
    const nodeIdx = boneToNode.get(bone);
    let compType, type, path;
    if (prop === 'position')      { compType = 5126; type = 'VEC3'; path = 'translation'; }
    else if (prop === 'quaternion') { compType = 5126; type = 'VEC4'; path = 'rotation'; }
    else if (prop === 'scale')     { compType = 5126; type = 'VEC3'; path = 'scale'; }
    else continue;

    const times = new Float32Array(track.times);
    const values = new Float32Array(track.values);
    const tBv = addBufferView(times, 34962);
    const tAcc = addAccessor(tBv, 5126, times.length, 'SCALAR');
    const vBv = addBufferView(values, 34962);
    const vAcc = addAccessor(vBv, 5126, values.length / (type === 'VEC4' ? 4 : 3), type);

    const samplerIdx = samplers.length;
    samplers.push({ input: tAcc, interpolation: 'LINEAR', output: vAcc });
    channels.push({ sampler: samplerIdx, target: { node: nodeIdx, path } });
  }
  newAnimations.push({ name, samplers, channels });
}
json.animations = newAnimations;

// 6f. scene → Armature
json.scenes[0].nodes = [armatureNode];

// 6g. bufferViews / accessors / buffer byteLength
json.bufferViews = json.bufferViews.concat(newBufferViews);
json.accessors = json.accessors.concat(newAccessors);
const newBinLength = cursor;
json.buffers[0].byteLength = newBinLength;
log(`\n버퍼: 기존 ${binChunkLen}B + 새 데이터 ${newBinLength - binChunkLen}B = ${newBinLength}B`);
log(`  새 bufferViews=${newBufferViews.length} 새 accessors=${newAccessors.length}`);
log(`  애니메이션=${json.animations.length} (채널 총 ${json.animations.reduce((s,a)=>s+a.channels.length,0)})`);

// ────────────────────────────────────────────────────────────────
// 7. GLB 바이너리 조립
// ────────────────────────────────────────────────────────────────
let jsonStr = JSON.stringify(json);
// JSON chunk 는 4바이트 정렬 (0x20 스페이스 패딩)
let jsonBytes = new TextEncoder().encode(jsonStr);
while (jsonBytes.length % 4 !== 0) {
  const extra = new Uint8Array(4 - (jsonBytes.length % 4));
  extra.fill(0x20);
  const merged = new Uint8Array(jsonBytes.length + extra.length);
  merged.set(jsonBytes); merged.set(extra, jsonBytes.length);
  jsonBytes = merged;
}

// BIN chunk 조립 (기존 + 새 조각, 패딩 포함)
let binOut = new Uint8Array(newBinLength);
binOut.set(new Uint8Array(binData.buffer, binData.byteOffset, binChunkLen), 0);
let w = binChunkLen;
for (const c of chunks) {
  if (c.pad) { /* 이미 0 으로 초기화 */ w += c.pad; }
  else { binOut.set(c.bytes, w); w += c.bytes.byteLength; }
}
// BIN 도 4바이트 정렬 (이미 cursor 가 4 정렬이므로 OK)
while (binOut.length % 4 !== 0) {
  const merged = new Uint8Array(binOut.length + (4 - binOut.length % 4));
  merged.set(binOut); binOut = merged;
}

const totalLength = 12 + (8 + jsonBytes.length) + (8 + binOut.length);
const out = new ArrayBuffer(totalLength);
const dv = new DataView(out);
const u8 = new Uint8Array(out);
dv.setUint32(0, 0x46546c67, true);   // magic 'glTF'
dv.setUint32(4, 2, true);            // version
dv.setUint32(8, totalLength, true);  // total length
let o = 12;
dv.setUint32(o, jsonBytes.length, true); o += 4;
dv.setUint32(o, 0x4e4f534a, true); o += 4;   // 'JSON'
u8.set(jsonBytes, o); o += jsonBytes.length;
dv.setUint32(o, binOut.length, true); o += 4;
dv.setUint32(o, 0x004e4942, true); o += 4;   // 'BIN'
u8.set(binOut, o); o += binOut.length;

fs.writeFileSync(OUT_PATH, Buffer.from(out));
const mb = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2);
log(`\n✅ 저장: ${OUT_PATH} (${mb} MB)`);
log(`   클립 ${json.animations.length}개: ${json.animations.map(a=>a.name).join(', ')}`);
