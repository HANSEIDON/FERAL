// Mixamo 캐릭터 FBX(텍스처 내장) + 스킨 없는 Mixamo 모션 FBX → 게임용 gunner.glb
//
//   node tools/build_gunner.mjs
//
// 생존자 총수 (Mixamo Ch35). 원본은 136MB 인데 그중 134MB 가 4096² PNG 12장이다.
// 가벼운 게임에 맞게 줄인다:
//   - 텍스처  재질 3개 × (색 · 노멀) 6장만 1024² JPEG 로. 스페큘러·광택 맵은
//             옛날식(Phong) 재질용이라 버리고, 거칠기는 값 하나로 준다.
//   - 메시    FBX 는 삼각형마다 정점을 따로 들고 있다(12만 개). 같은 정점을
//             합친 뒤 meshoptimizer 로 삼각형을 절반으로 줄인다.
//   - 크기    cm 단위 → Armature 스케일로 키 1.75m.
//
// 뼈대·IBM 은 FBX 바인드 포즈를 스케일 없이 그대로 쓴다 (build_hunter.mjs 참고 —
// 정점 좌표와 같은 원본 공간이어야 Armature 스케일이 메시와 뼈대에 똑같이 걸린다).
//
// 모션은 Mixamo 에서 Ch35 를 고른 채 "Without Skin" 으로 받은 것.
// 출력: public/models/gunner.glb

globalThis.self = globalThis;   // FBXLoader 가 쓰는 브라우저 전역

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
// 받은 원본이 있는 다운로드 폴더 — 다른 곳이면 FERAL_DOWNLOADS 로 바꾼다
const DOWNLOADS_DIR = process.env.FERAL_DOWNLOADS ?? `${homedir()}/Downloads`;

const DOWNLOADS = DOWNLOADS_DIR;
const MOTION_DIR = path.join(DOWNLOADS, '총모션');
const SRC = path.join(MOTION_DIR, 'Ch35_nonPBR.fbx');
const OUT_PATH = path.join(process.cwd(), 'public/models/gunner.glb');
const TARGET_HEIGHT = 1.75;
const TEX_SIZE = 1024;
const TRI_KEEP = 0.47;       // 삼각형을 이 비율만 남긴다 (검수기 캐릭터 예산 2만 개 안)
const SIMPLIFY_ERROR = 0.01; // 이보다 모양이 틀어지면 덜 줄인다 (메시 크기 대비)
const ROUGHNESS = 0.75;

// 모션 FBX (Downloads 기준) → 게임 클립명 (avatarAnim.js 가 이 이름으로 고른다)
// [이름, 시작초, 끝초] 이면 그 구간만 잘라 쓴다.
const CLIP_MAP = {
  // 소총 (1번 무기)
  '총모션/Rifle Idle.fbx':       'idle',
  '총모션/Run Forward.fbx':      'run',
  '총모션/Sprint Forward.fbx':   'sprint',
  '총모션/Firing Rifle.fbx':     'aim',       // 서서 쏘기 — 발사 버튼을 누르는 동안
  '총모션/Firing Rifle (1).fbx': 'aim_fwd',   // 달리며 쏘기
  '총모션/Reloading.fbx':        'reload',    // 상체에만 겹쳐 튼다 — 걸으면서도 재장전
  '총모션/Rifle Jump.fbx':       'jump',
  '총모션/Dying.fbx':            'death',
  // 무기 교체 — 상체에만 겹쳐 튼다
  'Rifle Put Away.fbx':          'holster_rifle',   // 소총을 등에 메고 손을 허리로
  '총모션/Rifle Pull Out.fbx':   'draw_rifle',      // 등에서 소총을 꺼내 든다
  // 권총 (2번 무기) — 셋 다 두 손으로 앞을 겨눈 채 움직인다
  '권총모션/Pistol Idle.fbx':    'p_idle',
  '권총모션/Pistol Walk.fbx':    'p_walk',
  '권총모션/Pistol Run.fbx':     'p_run',
  // 앞 0.8초는 웅크리기, 1.43초 뒤는 착지 후 일어서기 — 공중 구간만.
  // 경계를 원본 30fps 프레임(24 · 43번)에 맞춰야 다시 샘플링해도 키가 어긋나지 않는다
  '권총모션/Pistol Jump.fbx':    ['p_jump', 24 / 30, 43 / 30],
};

/**
 * 권총 서서 쏘기 — 받은 권총 모션에 없다. Pistol Idle 은 총구를 내린 경계 자세라
 * 쏘는 모습으로는 어색하다. 서 있는 다리(Pistol Idle)에 겨누며 걷는 상체
 * (Pistol Walk 의 한 프레임)를 얹어 만든다.
 */
const COMPOSE = { name: 'p_aim', legs: 'p_idle', upper: 'p_walk', at: 0.3 };

const log = (...a) => console.log(...a);
const die = (m) => { console.error('✗', m); process.exit(1); };

// ────────────────────────────────────────────────────────────────
// 1. 원본 FBX — 메시 · 뼈대 · 내장 텍스처
// ────────────────────────────────────────────────────────────────
// 내장 텍스처는 FBXLoader 가 Blob URL 로 만든다. URL 대신 Blob 을 붙잡아 두고
// 텍스처에는 그 URL 만 달아둔다 (Node 에는 이미지 디코더가 없다).
const blobs = new Map();
URL.createObjectURL = (blob) => { const id = `blob:${blobs.size}`; blobs.set(id, blob); return id; };
THREE.TextureLoader.prototype.load = function (url) {
  const t = new THREE.Texture();
  t.userData.url = url;
  return t;
};

const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const fbxLoader = new FBXLoader();
const loadFBX = (file) => fbxLoader.parse(toAB(fs.readFileSync(file)), '');

const src = loadFBX(SRC);
let mesh = null;
src.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
if (!mesh) die('스킨드 메시를 찾지 못함');
const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
const srcGeo = mesh.geometry;
log(`원본: 정점 ${srcGeo.attributes.position.count} 삼각형 ${srcGeo.attributes.position.count / 3} 재질 ${mats.length}`);

// ────────────────────────────────────────────────────────────────
// 2. 메시 — 정점 합치기 → 줄이기 → 쓰는 정점만 남기기
// ────────────────────────────────────────────────────────────────
// 원본은 비인덱스라 삼각형 t 의 재질은 그룹(정점 구간)으로 알 수 있다.
const triCount = srcGeo.attributes.position.count / 3;
const triMat = new Uint8Array(triCount);
for (const g of srcGeo.groups) {
  for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) triMat[t] = g.materialIndex;
}

const base = new THREE.BufferGeometry();
for (const k of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) {
  base.setAttribute(k, srcGeo.attributes[k]);
}
// mergeVertices 는 정점 순서대로 인덱스를 만든다 — 인덱스 3t..3t+2 가 원래 삼각형 t
const geo = mergeVertices(base);
const vCount = geo.attributes.position.count;
log(`정점 합치기: ${srcGeo.attributes.position.count} → ${vCount}`);

// 정점마다 재질 — 재질 경계는 UV 이음매라 정점이 나뉘어 있어야 한다
const vMat = new Int16Array(vCount).fill(-1);
const idx0 = geo.index.array;
for (let i = 0; i < idx0.length; i++) {
  const v = idx0[i], m = triMat[(i / 3) | 0];
  if (vMat[v] === -1) vMat[v] = m;
  else if (vMat[v] !== m) die(`정점 ${v} 가 재질 두 개에 걸쳐 있음 — 재질별로 따로 줄여야 한다`);
}

await MeshoptSimplifier.ready;
const positions = geo.attributes.position.array;
const normals = geo.attributes.normal.array;
const [simplified, err] = MeshoptSimplifier.simplifyWithAttributes(
  new Uint32Array(idx0), positions, 3, normals, 3, [0.5, 0.5, 0.5], null,
  Math.floor(triCount * TRI_KEEP) * 3, SIMPLIFY_ERROR,
);
const scaleCm = MeshoptSimplifier.getScale(positions, 3);
log(`삼각형 줄이기: ${triCount} → ${simplified.length / 3} (모양 오차 ${(err * scaleCm).toFixed(2)}cm)`);

// 쓰는 정점만 남기고 번호를 다시 매긴다
const [remap, used] = MeshoptSimplifier.compactMesh(simplified);
const pick = (attr, size, Type) => {
  const out = new Type(used * size);
  for (let v = 0; v < vCount; v++) {
    const n = remap[v];
    if (n === 0xffffffff) continue;
    for (let j = 0; j < size; j++) out[n * size + j] = attr.array[v * size + j];
  }
  return out;
};
const outPos = pick(geo.attributes.position, 3, Float32Array);
const outNrm = pick(geo.attributes.normal, 3, Float32Array);
const outUv = pick(geo.attributes.uv, 2, Float32Array);
const outJoints = pick(geo.attributes.skinIndex, 4, Uint16Array);
const outWeights = pick(geo.attributes.skinWeight, 4, Float32Array);
const outMat = new Int16Array(used);
for (let v = 0; v < vCount; v++) if (remap[v] !== 0xffffffff) outMat[remap[v]] = vMat[v];
log(`정점: ${vCount} → ${used}`);

// glTF 는 UV 원점이 위쪽이다 (three 의 FBX UV 는 아래쪽)
for (let i = 1; i < outUv.length; i += 2) outUv[i] = 1 - outUv[i];
// FBXLoader 는 5번째 이후 가중치를 버리기만 하고 정규화는 안 한다 (glTF 는 합 1 필수)
for (let v = 0; v < used; v++) {
  let s = 0;
  for (let j = 0; j < 4; j++) s += outWeights[v * 4 + j];
  if (s > 0) for (let j = 0; j < 4; j++) outWeights[v * 4 + j] /= s;
}

// 재질별 인덱스 — 줄인 뒤의 삼각형도 정점이 한 재질 안에서만 이어진다
const matTris = mats.map(() => []);
for (let i = 0; i < simplified.length; i += 3) {
  const a = simplified[i], b = simplified[i + 1], c = simplified[i + 2];
  matTris[outMat[a]].push(a, b, c);
}
const IndexType = used < 65536 ? Uint16Array : Uint32Array;
const matIndices = matTris.map((t) => IndexType.from(t));

// ────────────────────────────────────────────────────────────────
// 3. 뼈대 · 스케일 · 바닥
// ────────────────────────────────────────────────────────────────
const skeleton = mesh.skeleton;
const bones = skeleton.bones;
const inverses = skeleton.boneInverses.map((m) => new THREE.Matrix4().multiplyMatrices(m, mesh.bindMatrix));
const rootBone = bones.find((b) => !(b.parent && b.parent.isBone));
log(`뼈대 ${bones.length} 루트 ${rootBone.name}`);

const bb = new THREE.Box3().setFromBufferAttribute(srcGeo.attributes.position);
const k = TARGET_HEIGHT / (bb.max.y - bb.min.y);
log(`키 ${(bb.max.y - bb.min.y).toFixed(1)}(cm) → ${TARGET_HEIGHT}m, 스케일 ${k.toFixed(6)}`);

/** 클립 첫 프레임에서 스킨드 메시의 최저점 y (원본 단위). */
function footY(clip) {
  const mixer = new THREE.AnimationMixer(src);
  mixer.clipAction(clip).play();
  mixer.setTime(0);
  src.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let minY = Infinity;
  for (let i = 0; i < srcGeo.attributes.position.count; i += 3) {
    mesh.getVertexPosition(i, v);
    if (v.y < minY) minY = v.y;
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(src);
  return minY;
}

// ────────────────────────────────────────────────────────────────
// 4. 모션
// ────────────────────────────────────────────────────────────────
const boneNames = new Set(bones.map((b) => b.name));
const boneOf = (track) => track.name.slice(0, track.name.lastIndexOf('.'));

/**
 * from~to 초 구간을 30fps 로 다시 샘플링해 0초부터 시작하는 클립으로 만든다.
 * AnimationUtils.subclip 은 구간 안에 키가 없는 트랙을 통째로 버린다 (build_hunter.mjs 참고).
 */
function trimClip(clip, from, to, fps = 30) {
  const n = Math.round((to - from) * fps);
  const tracks = clip.tracks.map((t) => {
    const size = t.getValueSize(), interp = t.createInterpolant();
    const times = new Float32Array(n + 1), values = new Float32Array((n + 1) * size);
    for (let i = 0; i <= n; i++) { times[i] = i / fps; values.set(interp.evaluate(from + i / fps), i * size); }
    return new t.constructor(t.name, times, values);
  });
  return new THREE.AnimationClip(clip.name, n / fps, tracks);
}

const clips = [];
for (const [file, entry] of Object.entries(CLIP_MAP)) {
  const [name, from, to] = Array.isArray(entry) ? entry : [entry];
  const full = path.join(DOWNLOADS, file);
  if (!fs.existsSync(full)) { log(`  ⚠ 없음: ${file}`); continue; }
  const g = loadFBX(full);
  let clip = g.animations?.[0];
  if (!clip) { log(`  ⚠ 애니메이션 없음: ${file}`); continue; }
  if (from !== undefined) clip = trimClip(clip, from, to);
  clip.name = name;
  const missing = clip.tracks.filter((t) => !boneNames.has(boneOf(t)));
  if (missing.length) die(`${file}: 뼈대에 없는 트랙 ${missing.map((t) => t.name).join(', ')} — Ch35 로 받은 모션인지 확인`);
  clips.push(clip);
  log(`  ✓ ${name.padEnd(13)} ${clip.duration.toFixed(2)}s ${clip.tracks.length}트랙 ← ${file}`);
}

// 상체 + 다리 합치기 (COMPOSE 참고) — 상체 = Spine 과 그 아래 전부
{
  const legs = clips.find((c) => c.name === COMPOSE.legs);
  const upperSrc = clips.find((c) => c.name === COMPOSE.upper);
  if (!legs || !upperSrc) die(`${COMPOSE.name}: ${COMPOSE.legs} · ${COMPOSE.upper} 클립이 필요`);
  const upper = new Set();
  bones.find((b) => b.name.endsWith('Spine')).traverse((o) => { if (o.isBone) upper.add(o.name); });
  const tracks = legs.tracks.filter((t) => !upper.has(boneOf(t)));
  for (const t of upperSrc.tracks) {
    if (!upper.has(boneOf(t))) continue;
    const v = t.createInterpolant().evaluate(COMPOSE.at).slice();
    tracks.push(new t.constructor(t.name, [0, legs.duration], [...v, ...v]));
  }
  clips.push(new THREE.AnimationClip(COMPOSE.name, legs.duration, tracks));
  log(`  ✓ ${COMPOSE.name.padEnd(13)} ${legs.duration.toFixed(2)}s ${tracks.length}트랙 ← ${COMPOSE.legs} 다리 + ${COMPOSE.upper}@${COMPOSE.at}s 상체`);
}
const idle = clips.find((c) => c.name === 'idle');
if (!idle) die('idle 클립이 없음');
// Mixamo 클립의 Hips 높이가 이미 발을 바닥 근처에 놓는다 — idle 첫 프레임 발바닥만 0 에 맞춘다
const armY = -footY(idle) * k;
log(`Armature y ${armY.toFixed(4)} (idle 발바닥 y=0)`);

// ────────────────────────────────────────────────────────────────
// 5. 텍스처 — 1024² JPEG
// ────────────────────────────────────────────────────────────────
async function jpeg(tex, quality) {
  const blob = blobs.get(tex?.userData.url);
  if (!blob) return null;
  const buf = Buffer.from(await blob.arrayBuffer());
  return sharp(buf).resize(TEX_SIZE, TEX_SIZE, { kernel: 'lanczos3' }).jpeg({ quality, mozjpeg: true }).toBuffer();
}
const texSets = [];
for (const m of mats) {
  // 노멀은 방향이 데이터라 색보다 압축 손실에 민감하다 — 품질을 더 준다
  texSets.push({ name: m.name, color: await jpeg(m.map, 85), normal: await jpeg(m.normalMap, 92) });
}
log(`텍스처: ${texSets.map((t) => `${t.name}(${((t.color?.length ?? 0) / 1024).toFixed(0)}KB+${((t.normal?.length ?? 0) / 1024).toFixed(0)}KB)`).join(' ')}`);

// ────────────────────────────────────────────────────────────────
// 6. glTF 조립
// ────────────────────────────────────────────────────────────────
const json = {
  asset: { version: '2.0', generator: 'zombie-fps tools/build_gunner.mjs' },
  scene: 0, scenes: [{ nodes: [] }],
  nodes: [], meshes: [], materials: [], textures: [], images: [], samplers: [],
  accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }], skins: [], animations: [],
};
const chunks = [];
let cursor = 0;
function addView(typed, target) {
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); cursor += pad; }
  const bytes = typed instanceof Uint8Array ? typed : new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  chunks.push(bytes);
  const view = { buffer: 0, byteOffset: cursor, byteLength: bytes.byteLength };
  if (target) view.target = target;
  cursor += bytes.byteLength;
  json.bufferViews.push(view);
  return json.bufferViews.length - 1;
}
const COMP = { Float32Array: 5126, Uint16Array: 5123, Uint32Array: 5125 };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function addAccessor(typed, type, target, minmax = false) {
  const acc = { bufferView: addView(typed, target), componentType: COMP[typed.constructor.name], count: typed.length / SIZE[type], type };
  if (minmax) {
    const n = SIZE[type];
    acc.min = Array(n).fill(Infinity); acc.max = Array(n).fill(-Infinity);
    for (let i = 0; i < typed.length; i++) {
      acc.min[i % n] = Math.min(acc.min[i % n], typed[i]);
      acc.max[i % n] = Math.max(acc.max[i % n], typed[i]);
    }
  }
  json.accessors.push(acc);
  return json.accessors.length - 1;
}

// 6a. 재질 · 텍스처
json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
function addTexture(bytes) {
  if (!bytes) return undefined;
  json.images.push({ bufferView: addView(new Uint8Array(bytes)), mimeType: 'image/jpeg' });
  json.textures.push({ source: json.images.length - 1, sampler: 0 });
  return json.textures.length - 1;
}
for (const t of texSets) {
  const color = addTexture(t.color), normal = addTexture(t.normal);
  const mat = { name: t.name, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: ROUGHNESS } };
  if (color !== undefined) mat.pbrMetallicRoughness.baseColorTexture = { index: color };
  if (normal !== undefined) mat.normalTexture = { index: normal };
  json.materials.push(mat);
}

// 6b. 메시 — 정점 속성은 재질(프리미티브)끼리 같이 쓴다
const attributes = {
  POSITION: addAccessor(outPos, 'VEC3', 34962, true),
  NORMAL: addAccessor(outNrm, 'VEC3', 34962),
  TEXCOORD_0: addAccessor(outUv, 'VEC2', 34962),
  JOINTS_0: addAccessor(outJoints, 'VEC4', 34962),
  WEIGHTS_0: addAccessor(outWeights, 'VEC4', 34962),
};
json.meshes.push({
  name: 'Ch35',
  primitives: matIndices
    .map((ind, m) => ({ attributes, indices: ind.length ? addAccessor(ind, 'SCALAR', 34963) : -1, material: m }))
    .filter((p) => p.indices >= 0),
});

// 6c. 노드 — 0: Armature, 1: 메시, 2..: 뼈대
json.nodes.push({ name: 'Armature', translation: [0, armY, 0], scale: [k, k, k], children: [1] });
json.nodes.push({ name: 'Ch35', mesh: 0, skin: 0 });
const boneNode = new Map(bones.map((b, i) => [b, i + 2]));
for (const b of bones) {
  const node = {
    name: b.name,
    translation: b.position.toArray(),
    rotation: b.quaternion.toArray(),
  };
  if (b.scale.x !== 1 || b.scale.y !== 1 || b.scale.z !== 1) node.scale = b.scale.toArray();
  const children = b.children.filter((c) => boneNode.has(c)).map((c) => boneNode.get(c));
  if (children.length) node.children = children;
  json.nodes.push(node);
}
// 부모가 뼈대 목록에 없는 뼈대(루트 포함)는 Armature 아래로
for (const b of bones) if (!boneNode.has(b.parent)) json.nodes[0].children.push(boneNode.get(b));
json.scenes[0].nodes.push(0);

const ibm = new Float32Array(bones.length * 16);
inverses.forEach((m, i) => m.toArray(ibm, i * 16));
json.skins.push({ joints: bones.map((b) => boneNode.get(b)), inverseBindMatrices: addAccessor(ibm, 'MAT4') });

// 6d. 애니메이션
const nodeByName = new Map(bones.map((b) => [b.name, boneNode.get(b)]));
const PATH = { position: ['translation', 'VEC3'], quaternion: ['rotation', 'VEC4'], scale: ['scale', 'VEC3'] };
for (const clip of clips) {
  const anim = { name: clip.name, samplers: [], channels: [] };
  for (const t of clip.tracks) {
    const dot = t.name.lastIndexOf('.');
    const [p, type] = PATH[t.name.slice(dot + 1)] ?? [];
    if (!p) continue;
    anim.samplers.push({
      input: addAccessor(Float32Array.from(t.times), 'SCALAR', undefined, true),
      output: addAccessor(Float32Array.from(t.values), type),
      interpolation: 'LINEAR',
    });
    anim.channels.push({ sampler: anim.samplers.length - 1, target: { node: nodeByName.get(t.name.slice(0, dot)), path: p } });
  }
  json.animations.push(anim);
}

// ────────────────────────────────────────────────────────────────
// 7. GLB
// ────────────────────────────────────────────────────────────────
json.buffers[0].byteLength = cursor;
const pad4 = (n) => (4 - (n % 4)) % 4;
const jsonStr = JSON.stringify(json);
const jsonBytes = Buffer.from(jsonStr + ' '.repeat(pad4(Buffer.byteLength(jsonStr))));
const bin = Buffer.concat([...chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), Buffer.alloc(pad4(cursor))]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
const chunkHead = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
fs.writeFileSync(OUT_PATH, Buffer.concat([
  header, chunkHead(jsonBytes.length, 0x4e4f534a), jsonBytes, chunkHead(bin.length, 0x004e4942), bin,
]));
const mb = (fs.statSync(OUT_PATH).size / 1048576).toFixed(2);
log(`\n✅ 저장: ${OUT_PATH} (${mb} MB)`);
log(`   삼각형 ${simplified.length / 3} · 재질 ${json.materials.length} · 클립 ${json.animations.map((a) => a.name).join(', ')}`);
