// 손에 드는 소품 — Sketchfab glTF → 게임용 GLB 두 개
//   hunter_props.glb  사냥꾼 활 · 화살
//   gunner_props.glb  총수 소총 · 권총
//   ammo_props.glb    맵에 깔리는 탄약상자 (소총 · 권총)
//
//   node tools/build_props.mjs
//
// 출처 (CC-BY-4.0, public/models/CREDITS.md):
//   활   "Asian composite bow" by fly4xy
//   화살 "CC0 - Wooden Arrow" by plaggy
//   소총 "M4 (Free)" by Skabl
//   권총 "Colt 1911 game ready" by 8mister.corost2013
//   소총 탄약 "Case Bullet" by Daniel Martins · 권총 탄약 "Ammo Case" by Replexx
//
// 하는 일:
//   - 활: 시위를 떼어낸다. 박혀 있는 시위는 움직이지 않으니, 게임에서 코드로
//         그려 오른손을 따라 당겨지게 한다 (bowRig.js). 떼어낸 시위의 양끝은
//         노드 extras(stringTop · stringBottom)로 남긴다.
//   - 좌표를 게임 규약으로: 활은 손잡이 = 원점, 활대 = +Y(위), 쏘는 쪽 = +Z.
//     화살은 오늬(시위에 거는 끝) = 원점, 촉 = +Z.
//   - 크기: 활 시위 길이 1.05m, 화살 0.95m (사냥꾼 풀장전 때 두 손 간격이 0.87m 라
//     촉이 손잡이 앞으로 나오도록).
//   - 텍스처: 활 2K → 1K, 화살 4K → 512 JPEG.

import * as THREE from 'three';
import sharp from 'sharp';
import { MeshoptSimplifier } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';

const BOW_DIR = 'C:/Users/haki0/Downloads/asian_composite_bow';
const ARROW_DIR = 'C:/Users/haki0/Downloads/cc0_-_wooden_arrow';
const OUT_PATH = path.join(process.cwd(), 'public/models/hunter_props.glb');
const GUN_OUT_PATH = path.join(process.cwd(), 'public/models/gunner_props.glb');
const AMMO_OUT_PATH = path.join(process.cwd(), 'public/models/ammo_props.glb');
const STRING_LEN = 1.05;
const ARROW_LEN = 0.95;

const log = (...a) => console.log(...a);
const die = (m) => { console.error('✗', m); process.exit(1); };

// ────────────────────────────────────────────────────────────────
// glTF(.gltf + .bin) 읽기 — 노드 변환을 정점에 구워 넣은 메시 하나로
// ────────────────────────────────────────────────────────────────
function readGltf(dir) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'scene.gltf'), 'utf8'));
  const bin = fs.readFileSync(path.join(dir, j.buffers[0].uri));
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const read = (i) => {
    const a = j.accessors[i], bv = j.bufferViews[a.bufferView];
    const [C, get] = {
      5126: [Float32Array, (o) => dv.getFloat32(o, true)],
      5125: [Uint32Array, (o) => dv.getUint32(o, true)],
      5123: [Uint16Array, (o) => dv.getUint16(o, true)],
    }[a.componentType];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const stride = bv.byteStride || n * C.BYTES_PER_ELEMENT;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new C(a.count * n);
    for (let k = 0; k < a.count; k++) {
      for (let c = 0; c < n; c++) out[k * n + c] = get(base + k * stride + c * C.BYTES_PER_ELEMENT);
    }
    return out;
  };

  // 메시가 걸린 노드의 세계 행렬
  let found = null;
  const walk = (ni, parent) => {
    const n = j.nodes[ni];
    const m = new THREE.Matrix4();
    if (n.matrix) m.fromArray(n.matrix);
    else m.compose(
      new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
      new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
      new THREE.Vector3(...(n.scale ?? [1, 1, 1])),
    );
    const world = parent.clone().multiply(m);
    if (n.mesh !== undefined) {
      if (found) die(`${dir}: 메시가 둘 이상 — 이 스크립트는 하나만 다룬다`);
      found = { mesh: j.meshes[n.mesh], world };
    }
    for (const c of n.children ?? []) walk(c, world);
  };
  for (const r of j.scenes[j.scene ?? 0].nodes) walk(r, new THREE.Matrix4());
  if (!found || found.mesh.primitives.length !== 1) die(`${dir}: 프리미티브 하나짜리 메시가 아님`);

  const p = found.mesh.primitives[0];
  const pos = read(p.attributes.POSITION), nrm = read(p.attributes.NORMAL), uv = read(p.attributes.TEXCOORD_0);
  const index = read(p.indices);
  const nm = new THREE.Matrix3().getNormalMatrix(found.world);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) {
    v.fromArray(pos, i).applyMatrix4(found.world).toArray(pos, i);
    v.fromArray(nrm, i).applyMatrix3(nm).normalize().toArray(nrm, i);
  }
  const mat = j.materials[p.material];
  const img = (t) => (t ? path.join(dir, j.images[j.textures[t.index].source].uri) : null);
  return {
    pos, nrm, uv, index,
    tex: {
      color: img(mat.pbrMetallicRoughness?.baseColorTexture),
      mr: img(mat.pbrMetallicRoughness?.metallicRoughnessTexture),
      normal: img(mat.normalTexture),
      occlusion: !!mat.occlusionTexture,
    },
  };
}

/** 정점 좌표를 행렬로 옮긴다 (법선은 회전만). */
function transform(m, matrix) {
  const nm = new THREE.Matrix3().getNormalMatrix(matrix);
  const v = new THREE.Vector3();
  for (let i = 0; i < m.pos.length; i += 3) {
    v.fromArray(m.pos, i).applyMatrix4(matrix).toArray(m.pos, i);
    v.fromArray(m.nrm, i).applyMatrix3(nm).normalize().toArray(m.nrm, i);
  }
}

/** 삼각형을 위치로 이어진 덩어리별로 나눈다 (UV 이음매로 갈라진 정점은 같은 것으로 본다). */
function components(m) {
  const key = (v) => `${Math.round(m.pos[v * 3] * 1e4)},${Math.round(m.pos[v * 3 + 1] * 1e4)},${Math.round(m.pos[v * 3 + 2] * 1e4)}`;
  const weld = new Map();
  const id = new Int32Array(m.pos.length / 3);
  for (let v = 0; v < id.length; v++) {
    const k = key(v);
    if (!weld.has(k)) weld.set(k, weld.size);
    id[v] = weld.get(k);
  }
  const par = Array.from({ length: weld.size }, (_, i) => i);
  const find = (x) => (par[x] === x ? x : (par[x] = find(par[x])));
  for (let t = 0; t < m.index.length; t += 3) {
    const a = find(id[m.index[t]]);
    par[find(id[m.index[t + 1]])] = a;
    par[find(id[m.index[t + 2]])] = a;
  }
  const out = new Map();
  for (let t = 0; t < m.index.length; t += 3) {
    const r = find(id[m.index[t]]);
    if (!out.has(r)) out.set(r, { tris: [], box: new THREE.Box3() });
    const c = out.get(r);
    c.tris.push(t);
    for (let k = 0; k < 3; k++) c.box.expandByPoint(new THREE.Vector3().fromArray(m.pos, m.index[t + k] * 3));
  }
  return [...out.values()];
}

// ────────────────────────────────────────────────────────────────
// 1. 활 — 시위 떼기 · 좌표 맞추기
// ────────────────────────────────────────────────────────────────
const bow = readGltf(BOW_DIR);
const parts = components(bow);
const size = (c) => c.box.getSize(new THREE.Vector3());
// 시위: 활 길이 방향(x)으로 길고 나머지 두 방향으로는 가는 덩어리
const string = parts.find((c) => { const s = size(c); return s.x > 1.5 && s.y < 0.02 && s.z < 0.03; });
if (!string) die('활에서 시위 덩어리를 찾지 못함');
const keep = parts.filter((c) => c !== string);
log(`활: 덩어리 ${parts.length}개 (삼각형 ${parts.map((c) => c.tris.length).join(' · ')}) — 시위(${string.tris.length}) 제거`);

// 시위 양끝 (원래 좌표)
const tipNear = (sign) => {
  const p = new THREE.Vector3(); let n = 0;
  const edge = sign > 0 ? string.box.max.x : string.box.min.x;
  for (const t of string.tris) for (let k = 0; k < 3; k++) {
    const v = new THREE.Vector3().fromArray(bow.pos, bow.index[t + k] * 3);
    if (Math.abs(v.x - edge) < 0.01) { p.add(v); n++; }
  }
  return p.divideScalar(n);
};
const tipA = tipNear(1), tipB = tipNear(-1);
const stringLen = tipA.distanceTo(tipB);

// 쏘는 쪽: 시위에서 손잡이 쪽으로 (손잡이는 x≈0 인 몸통 부분)
const grip = new THREE.Vector3(); let gripN = 0;
for (const c of keep) for (const t of c.tris) for (let k = 0; k < 3; k++) {
  const v = new THREE.Vector3().fromArray(bow.pos, bow.index[t + k] * 3);
  if (Math.abs(v.x) < 0.04) { grip.add(v); gripN++; }
}
grip.divideScalar(gripN);
const fwdSign = Math.sign(grip.y - (tipA.y + tipB.y) / 2);

// 원래 (x=길이, y=앞뒤, z=두께) → 게임 (x=두께, y=길이, z=앞)
const basis = new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 1, 0),             // 원래 x → +Y
  new THREE.Vector3(0, 0, fwdSign),       // 원래 y → ±Z (손잡이 쪽이 +Z)
  new THREE.Vector3(fwdSign, 0, 0),       // 원래 z → 오른손 좌표계가 되게
);
const bowScale = STRING_LEN / stringLen;
const bowMatrix = new THREE.Matrix4().makeScale(bowScale, bowScale, bowScale)
  .multiply(basis)
  .multiply(new THREE.Matrix4().makeTranslation(-grip.x, -grip.y, -grip.z));
transform(bow, bowMatrix);
const stringTop = tipA.clone().applyMatrix4(bowMatrix);
const stringBottom = tipB.clone().applyMatrix4(bowMatrix);
if (stringTop.y < stringBottom.y) die('활 위아래가 뒤집힘');
bow.index = Uint16Array.from(keep.flatMap((c) => c.tris.flatMap((t) => [bow.index[t], bow.index[t + 1], bow.index[t + 2]])));
log(`  시위 길이 ${stringLen.toFixed(3)} → ${STRING_LEN}m (×${bowScale.toFixed(3)}) · 시위 끝 위 [${stringTop.toArray().map((x) => x.toFixed(3))}] 아래 [${stringBottom.toArray().map((x) => x.toFixed(3))}]`);

// ────────────────────────────────────────────────────────────────
// 2. 화살 — 촉을 +Z, 오늬를 원점으로
// ────────────────────────────────────────────────────────────────
const arrow = readGltf(ARROW_DIR);
{
  // 가장 긴 축 = 화살대 (주성분)
  const n = arrow.pos.length / 3;
  const c = new THREE.Vector3();
  for (let i = 0; i < n; i++) c.add(new THREE.Vector3().fromArray(arrow.pos, i * 3));
  c.divideScalar(n);
  let axis = new THREE.Vector3(1, 0, 0);
  for (let it = 0; it < 30; it++) {   // 거듭제곱법
    const next = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const d = new THREE.Vector3().fromArray(arrow.pos, i * 3).sub(c);
      next.addScaledVector(d, d.dot(axis));
    }
    axis = next.normalize();
  }
  // 축을 따라 굵기를 재서 깃(길게 넓음)과 촉(짧게 넓음)을 가린다
  let lo = Infinity, hi = -Infinity;
  const along = new Float32Array(n), radial = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = new THREE.Vector3().fromArray(arrow.pos, i * 3).sub(c);
    along[i] = d.dot(axis);
    radial[i] = d.addScaledVector(axis, -along[i]).length();
    lo = Math.min(lo, along[i]); hi = Math.max(hi, along[i]);
  }
  // 넓게 퍼진 정점(깃 · 촉)이 각 끝에서 화살대를 따라 얼마나 길게 이어지는지.
  // 깃은 길이의 15~20% 를 덮고 촉은 5% 남짓이다. (화살대는 원통이라 정점이
  // 양끝에만 있어서, 구간별 굵기로 재면 가운데가 비어 버린다)
  const maxR = Math.max(...radial);
  const mid = (lo + hi) / 2;
  const span = (side) => {
    let a = Infinity, b = -Infinity;
    for (let i = 0; i < n; i++) {
      if (radial[i] < maxR * 0.4 || Math.sign(along[i] - mid) !== side) continue;
      a = Math.min(a, along[i]); b = Math.max(b, along[i]);
    }
    return b > a ? (b - a) / (hi - lo) : 0;
  };
  const wideLo = span(-1), wideHi = span(1);
  log(`화살: 넓은 부분이 덮는 길이 — 한쪽 끝 ${(wideLo * 100).toFixed(0)}%, 반대쪽 끝 ${(wideHi * 100).toFixed(0)}% (긴 쪽이 깃)`);
  if (Math.abs(wideLo - wideHi) < 0.04) die('깃과 촉을 가리지 못함 — 화살 모델을 눈으로 확인할 것');
  // 깃이 있는 쪽이 오늬(뒤) — 촉이 +Z 를 보게 축 방향을 정한다
  if (wideLo < wideHi) axis.negate();   // lo 쪽이 촉이면 축을 뒤집어 촉이 +축이 되게
  const q = new THREE.Quaternion().setFromUnitVectors(axis, new THREE.Vector3(0, 0, 1));
  const len = hi - lo;
  const s = ARROW_LEN / len;
  const m = new THREE.Matrix4().makeScale(s, s, s)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  transform(arrow, m);
  // 오늬 끝이 z=0 이 되게 민다
  let minZ = Infinity;
  for (let i = 2; i < arrow.pos.length; i += 3) minZ = Math.min(minZ, arrow.pos[i]);
  for (let i = 2; i < arrow.pos.length; i += 3) arrow.pos[i] -= minZ;
  log(`  길이 ${len.toFixed(3)} → ${ARROW_LEN}m (×${s.toFixed(3)})`);
}

// ────────────────────────────────────────────────────────────────
// 3. 총 (총수) — 여러 부품 · 여러 재질
// ────────────────────────────────────────────────────────────────
// 좌표: 손잡이(오른손이 쥐는 곳) = 원점, 총구 = +Z, 위 = +Y (단위 m).
const RIFLE_DIR = 'C:/Users/haki0/Downloads/m4_free';
const PISTOL_DIR = 'C:/Users/haki0/Downloads/colt_1911_game_ready';
const RIFLE_LEN = 0.84;     // M4 개머리판을 편 길이
// M1911 실물은 21.6cm 인데 3인칭에서 두 손에 묻혀 작아 보인다 — 조금 키운다
const PISTOL_LEN = 0.25;
const RIFLE_TRIS = 3500;    // 3인칭에서 보이는 크기라 이 정도면 충분하다
const PISTOL_TRIS = 2500;   // 목표 — 실제로는 이음매 때문에 4.4천에서 멈춘다

/** 메시 노드를 전부 읽어 부품(프리미티브)별로 — 노드 변환을 구워 넣는다. */
function readParts(dir) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'scene.gltf'), 'utf8'));
  const bin = fs.readFileSync(path.join(dir, j.buffers[0].uri));
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const read = (i) => {
    const a = j.accessors[i], bv = j.bufferViews[a.bufferView];
    const [C, get] = {
      5126: [Float32Array, (o) => dv.getFloat32(o, true)],
      5125: [Uint32Array, (o) => dv.getUint32(o, true)],
      5123: [Uint16Array, (o) => dv.getUint16(o, true)],
    }[a.componentType];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const stride = bv.byteStride || n * C.BYTES_PER_ELEMENT, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Float32Array(a.count * n);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = get(base + k * stride + c * C.BYTES_PER_ELEMENT);
    return out;
  };
  const parts = [];
  const walk = (ni, parent, label) => {
    const n = j.nodes[ni], m = new THREE.Matrix4();
    if (n.matrix) m.fromArray(n.matrix);
    else m.compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
    const world = parent.clone().multiply(m);
    if (n.mesh !== undefined) {
      const nm = new THREE.Matrix3().getNormalMatrix(world), v = new THREE.Vector3();
      for (const p of j.meshes[n.mesh].primitives) {
        const pos = read(p.attributes.POSITION), nrm = read(p.attributes.NORMAL), uv = read(p.attributes.TEXCOORD_0);
        for (let i = 0; i < pos.length; i += 3) {
          v.fromArray(pos, i).applyMatrix4(world).toArray(pos, i);
          v.fromArray(nrm, i).applyMatrix3(nm).normalize().toArray(nrm, i);
        }
        parts.push({ name: label, material: p.material, pos, nrm, uv, index: Uint32Array.from(read(p.indices)) });
      }
    }
    for (const c of n.children ?? []) walk(c, world, n.mesh === undefined ? n.name : label);
  };
  for (const r of j.scenes[j.scene ?? 0].nodes) walk(r, new THREE.Matrix4(), '');
  const img = (t) => (t ? path.join(dir, j.images[j.textures[t.index].source].uri) : null);
  const textures = j.materials.map((m) => ({
    color: img(m.pbrMetallicRoughness?.baseColorTexture),
    mr: img(m.pbrMetallicRoughness?.metallicRoughnessTexture),
    normal: img(m.normalTexture),
    occlusion: !!m.occlusionTexture,
  }));
  return { parts, textures };
}

/** 부품들을 메시 하나로 합친다. */
function mergeParts(parts) {
  const nv = parts.reduce((s, p) => s + p.pos.length / 3, 0), ni = parts.reduce((s, p) => s + p.index.length, 0);
  const m = { pos: new Float32Array(nv * 3), nrm: new Float32Array(nv * 3), uv: new Float32Array(nv * 2), index: new Uint32Array(ni) };
  let vo = 0, io = 0;
  for (const p of parts) {
    m.pos.set(p.pos, vo * 3); m.nrm.set(p.nrm, vo * 3); m.uv.set(p.uv, vo * 2);
    for (let i = 0; i < p.index.length; i++) m.index[io + i] = p.index[i] + vo;
    vo += p.pos.length / 3; io += p.index.length;
  }
  return m;
}

const centroid = (pos, filter = () => true) => {
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < pos.length; i += 3) { v.fromArray(pos, i); if (filter(v)) { c.add(v); n++; } }
  return c.divideScalar(n || 1);
};
const boxOf = (pos) => {
  const b = new THREE.Box3(), v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) b.expandByPoint(v.fromArray(pos, i));
  return b;
};

/** 삼각형을 target 개 안팎으로 줄인다 (법선을 같이 봐서 각진 면이 뭉개지지 않게). */
async function simplify(m, target, label, maxError = 0.01) {
  await MeshoptSimplifier.ready;
  const before = m.index.length / 3;
  if (before <= target) return m;
  const [index, err] = MeshoptSimplifier.simplifyWithAttributes(
    m.index, m.pos, 3, m.nrm, 3, [0.5, 0.5, 0.5], null, target * 3, maxError);
  log(`  ${label}: 삼각형 ${before} → ${index.length / 3} (모양 오차 ${(err * MeshoptSimplifier.getScale(m.pos, 3) * 100).toFixed(2)}cm)`);
  return { ...m, index };
}

// 3a. 소총 — 부품 이름(러시아어 음차)으로 손잡이 · 총열 덮개 · 개머리판 · 운반 손잡이를 찾는다
const rifleSrc = readParts(RIFLE_DIR);
const part = (prefix) => {
  const p = rifleSrc.parts.find((q) => q.name.startsWith(prefix));
  if (!p) die(`소총 부품 ${prefix} 없음`);
  return { c: centroid(p.pos), box: boxOf(p.pos) };
};
const rGrip = part('ruchka'), handguard = part('tzevyo'), stock = part('priklad'), carry = part('derjat');
if (!(stock.c.z < handguard.c.z)) die('소총 앞뒤가 예상과 다름 (개머리판이 -Z 여야 한다)');
if (!(carry.c.y > rGrip.c.y)) die('소총 위아래가 예상과 다름 (운반 손잡이가 +Y 여야 한다)');
let rifle = mergeParts(rifleSrc.parts);
{
  const len = boxOf(rifle.pos).getSize(new THREE.Vector3()).z, s = RIFLE_LEN / len;
  transform(rifle, new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-rGrip.c.x, -rGrip.c.y, -rGrip.c.z)));
  rifle.extras = { handguardY: +((handguard.box.min.y - rGrip.c.y) * s).toFixed(4) };   // 왼손이 받치는 높이
  rifle.tex = rifleSrc.textures[0];
  log(`소총: 부품 ${rifleSrc.parts.length}개 · 길이 ${len.toFixed(3)} → ${RIFLE_LEN}m · 총열 덮개 밑면 ${rifle.extras.handguardY}m`);
}
rifle = { ...rifle, ...(await simplify(rifle, RIFLE_TRIS, '소총')) };

// 3b. 권총 — 재질 3개를 텍스처 한 장(2×2 칸)에 모은다 (드로우콜 1회)
const pistolSrc = readParts(PISTOL_DIR);
const TILE = [[0, 0], [1, 0], [0, 1]];   // 재질 번호 → 칸 (glTF UV 는 위가 0)
for (const p of pistolSrc.parts) {
  const [tx, ty] = TILE[p.material];
  for (let i = 0; i < p.uv.length; i += 2) { p.uv[i] = (p.uv[i] + tx) / 2; p.uv[i + 1] = (p.uv[i + 1] + ty) / 2; }
}
let pistol = mergeParts(pistolSrc.parts);
{
  // 원본은 총구가 -Z — 반 바퀴 돌려 +Z 로. 손잡이는 슬라이드 아래 · 뒤쪽 정점들
  transform(pistol, new THREE.Matrix4().makeRotationY(Math.PI));
  const box = boxOf(pistol.pos), mid = box.getCenter(new THREE.Vector3());
  const slideBottom = box.max.y - (box.max.y - box.min.y) * 0.3;
  const g = centroid(pistol.pos, (v) => v.y < slideBottom && v.z < mid.z);
  const len = box.getSize(new THREE.Vector3()).z, s = PISTOL_LEN / len;
  transform(pistol, new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-g.x, -g.y, -g.z)));
  log(`권총: 부품 ${pistolSrc.parts.length}개 · 길이 ${len.toFixed(3)} → ${PISTOL_LEN}m`);
}
// 재질 이음매가 많아 4천 개 대에서 더 안 줄어든다 (오차를 2.5% 까지 풀어도 4.2천) — 1% 로 둔다
pistol = { ...pistol, ...(await simplify(pistol, PISTOL_TRIS, '권총')) };

// 3c. 탄약상자 — 바닥 = y 0, 가운데 = 원점, 긴 쪽 = X. 줍는 물건이라 멀리서도 보이게
//     실물보다 조금 크게 잡는다 (예전 임시 상자가 0.4m).
// 둘 다 군용 탄약통이다. 소총은 "5.56MM M855" 가 찍힌 Case Bullet — 총수 소총(M4)의 탄이다.
// 권총은 Ammo Case(7.62mm 표기라 권총탄은 아니다). 멀리서 구분되게 소총 쪽을 더 크게 잡는다.
const AMMO = {
  rifle: { dir: 'C:/Users/haki0/Downloads/case_bullet', len: 0.40, tris: 1500 },
  // 두께가 9cm 뿐이라 옆에서 보면 막대처럼 가늘다 — 조금 키운다
  pistol: { dir: 'C:/Users/haki0/Downloads/ammo_case', len: 0.36, tris: 1500 },
};
const ammo = {};
for (const [type, a] of Object.entries(AMMO)) {
  const src = readParts(a.dir);
  if (src.textures.length !== 1) die(`탄약상자 ${type}: 재질이 ${src.textures.length}개 — 하나여야 한다`);
  let m = mergeParts(src.parts);
  const box = boxOf(m.pos), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const turn = size.z > size.x ? Math.PI / 2 : 0;   // 긴 쪽을 X 로
  const s = a.len / Math.max(size.x, size.z);
  transform(m, new THREE.Matrix4().makeScale(s, s, s)
    .multiply(new THREE.Matrix4().makeRotationY(turn))
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z)));
  const out = boxOf(m.pos).getSize(new THREE.Vector3());
  log(`탄약상자 ${type}: 부품 ${src.parts.length}개 · ${out.toArray().map((v) => (v * 100).toFixed(0)).join('×')}cm (가로×높이×세로)`);
  m = { ...m, ...(await simplify(m, a.tris, `탄약상자 ${type}`)) };
  m.tex = src.textures[0];
  ammo[type] = m;
}

// ────────────────────────────────────────────────────────────────
// 4. 텍스처
// ────────────────────────────────────────────────────────────────
const jpeg = (file, px, q) => (file ? sharp(file).resize(px, px, { kernel: 'lanczos3' }).jpeg({ quality: q, mozjpeg: true }).toBuffer() : null);
const texSet = async (t, px) => ({
  color: await jpeg(t.color, px, 85), mr: await jpeg(t.mr, px, 90), normal: await jpeg(t.normal, px, 92), occlusion: t.occlusion,
});
const bowTex = await texSet(bow.tex, 1024);
const arrowTex = await texSet(arrow.tex, 512);
const rifleTex = await texSet(rifle.tex, 1024);
/** 재질별 텍스처를 2×2 칸 한 장으로 (칸 하나 512). */
async function atlas(files, q, bg) {
  const tiles = await Promise.all(files.map((f) => sharp(f).resize(512, 512, { kernel: 'lanczos3' }).toBuffer()));
  return sharp({ create: { width: 1024, height: 1024, channels: 3, background: bg } })
    .composite(tiles.map((input, m) => ({ input, left: TILE[m][0] * 512, top: TILE[m][1] * 512 })))
    .jpeg({ quality: q, mozjpeg: true }).toBuffer();
}
const pt = pistolSrc.textures;
const pistolTex = {
  color: await atlas(pt.map((t) => t.color), 85, { r: 0, g: 0, b: 0 }),
  mr: await atlas(pt.map((t) => t.mr), 90, { r: 255, g: 255, b: 0 }),
  normal: await atlas(pt.map((t) => t.normal), 92, { r: 128, g: 128, b: 255 }),
  occlusion: pt.every((t) => t.occlusion),
};

// ────────────────────────────────────────────────────────────────
// 5. GLB
// ────────────────────────────────────────────────────────────────
/** items: [{ name, mesh: {pos, nrm, uv, index}, tex: {color, mr, normal, occlusion}, extras }] */
function writeGlb(outPath, items) {
  const json = {
    asset: { version: '2.0', generator: 'zombie-fps tools/build_props.mjs' },
    scene: 0, scenes: [{ nodes: items.map((_, i) => i) }], nodes: [], meshes: [], materials: [],
    textures: [], images: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
  };
  const chunks = [];
  let cursor = 0;
  const addView = (typed, target) => {
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); cursor += pad; }
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    chunks.push(bytes);
    json.bufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: bytes.length, ...(target ? { target } : {}) });
    cursor += bytes.length;
    return json.bufferViews.length - 1;
  };
  const COMP = { Float32Array: 5126, Uint16Array: 5123, Uint32Array: 5125 };
  const addAccessor = (typed, type, target, minmax) => {
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
    const acc = { bufferView: addView(typed, target), componentType: COMP[typed.constructor.name], count: typed.length / n, type };
    if (minmax) {
      acc.min = Array(n).fill(Infinity); acc.max = Array(n).fill(-Infinity);
      typed.forEach((x, i) => { acc.min[i % n] = Math.min(acc.min[i % n], x); acc.max[i % n] = Math.max(acc.max[i % n], x); });
    }
    json.accessors.push(acc);
    return json.accessors.length - 1;
  };
  const addTexture = (bytes) => {
    json.images.push({ bufferView: addView(new Uint8Array(bytes)), mimeType: 'image/jpeg' });
    json.textures.push({ source: json.images.length - 1, sampler: 0 });
    return json.textures.length - 1;
  };
  for (const { name, mesh: m, tex, extras } of items) {
    // 쓰는 정점만 남긴다 (시위를 뗀 활 · 줄인 총은 안 쓰는 정점이 남아 있다)
    const used = new Map();
    for (const v of m.index) if (!used.has(v)) used.set(v, used.size);
    const pick = (src, k) => {
      const out = new Float32Array(used.size * k);
      for (const [o, nw] of used) for (let c = 0; c < k; c++) out[nw * k + c] = src[o * k + c];
      return out;
    };
    const index = Uint16Array.from(m.index, (v) => used.get(v));
    const mr = addTexture(tex.mr);
    const mat = {
      name,
      pbrMetallicRoughness: { baseColorTexture: { index: addTexture(tex.color) }, metallicRoughnessTexture: { index: mr } },
      normalTexture: { index: addTexture(tex.normal) },
    };
    if (tex.occlusion) mat.occlusionTexture = { index: mr };   // R 채널 = AO (Sketchfab ORM)
    json.materials.push(mat);
    json.meshes.push({
      name,
      primitives: [{
        attributes: {
          POSITION: addAccessor(pick(m.pos, 3), 'VEC3', 34962, true),
          NORMAL: addAccessor(pick(m.nrm, 3), 'VEC3', 34962),
          TEXCOORD_0: addAccessor(pick(m.uv, 2), 'VEC2', 34962),
        },
        indices: addAccessor(index, 'SCALAR', 34963),
        material: json.materials.length - 1,
      }],
    });
    json.nodes.push({ name, mesh: json.meshes.length - 1, ...(extras ? { extras } : {}) });
    log(`  ${name}: 삼각형 ${index.length / 3} · 정점 ${used.size}`);
  }
  json.buffers[0].byteLength = cursor;
  const pad4 = (n) => (4 - (n % 4)) % 4;
  const jsonStr = JSON.stringify(json);
  const jsonBytes = Buffer.from(jsonStr + ' '.repeat(pad4(Buffer.byteLength(jsonStr))));
  const bin = Buffer.concat([...chunks, Buffer.alloc(pad4(cursor))]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
  const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  fs.writeFileSync(outPath, Buffer.concat([head, ch(jsonBytes.length, 0x4e4f534a), jsonBytes, ch(bin.length, 0x004e4942), bin]));
  log(`✅ 저장: ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)\n`);
}

writeGlb(OUT_PATH, [
  { name: 'Bow', mesh: bow, tex: bowTex, extras: { stringTop: stringTop.toArray(), stringBottom: stringBottom.toArray() } },
  { name: 'Arrow', mesh: arrow, tex: arrowTex },
]);
writeGlb(GUN_OUT_PATH, [
  { name: 'Rifle', mesh: rifle, tex: rifleTex, extras: rifle.extras },
  { name: 'Pistol', mesh: pistol, tex: pistolTex },
]);
writeGlb(AMMO_OUT_PATH, [
  { name: 'AmmoRifle', mesh: ammo.rifle, tex: await texSet(ammo.rifle.tex, 512) },
  { name: 'AmmoPistol', mesh: ammo.pistol, tex: await texSet(ammo.pistol.tex, 512) },
]);
