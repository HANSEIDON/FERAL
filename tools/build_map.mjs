// 맵 겉모습 — 받은 에셋을 게임용으로 줄여서 굽는다
//
//   node tools/build_map.mjs            전부
//   node tools/build_map.mjs models     GLB 만 (텍스처 · 하늘은 건너뜀 — EXR 풀기가 느리다)
//
//   public/models/map_props.glb               컨테이너 · 크레인 · 트레일러 · 선반 · 방호벽 · 소품
//   public/textures/map/<이름>_{col,nrm,orm}.jpg  바닥 · 벽 · 하역장 타일 텍스처
//   public/textures/map/night_env.exr          밤하늘 조명 (작게)  · night_sky.jpg 배경
//
// 모델은 게임 좌표(m, y 위, 바닥 y = 0, 가운데 x = z = 0)와 맵 충돌 박스 크기
// (shared/map.js)로 구워 넣는다. 클라이언트(src/game/mapArt.js)는 박스 자리에 놓기만 한다.
//
// 가볍게:
//   - 삼각형을 meshopt 로 줄인다 (선반 19.7k → 2.5k, 방호벽 23.8k → 0.6k …)
//   - 텍스처는 1K 이하 JPEG. 재질이 여럿인 모델은 한 장(아틀라스)으로 모아 드로우콜을 줄인다
//   - 같은 모델을 여러 번 쓰는 건(컨테이너 · 선반 · 소품) 클라이언트가 인스턴싱한다
//
// 출처 (public/models/CREDITS.md):
//   Sketchfab CC-BY — Shipping Containers (Arsen Ismailov) · Post Apocalyptic Shipping Container
//   (Sahir Virmani) · Gantry crane (Randonavt) · Semi trailer freestanding (zairiq zairiq) ·
//   Warehouse Assets (big guy)
//   Poly Haven CC0 — 텍스처 · 방호벽 · 가로등 · 보안등 · 셔터 · 타이어 · 쓰레기통 · 나무상자 · 드럼통 · 밤하늘

import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { EXRExporter } from 'three/addons/exporters/EXRExporter.js';
import sharp from 'sharp';
import { MeshoptSimplifier } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
// 받은 원본이 있는 다운로드 폴더 — 다른 곳이면 FERAL_DOWNLOADS 로 바꾼다
const DOWNLOADS_DIR = process.env.FERAL_DOWNLOADS ?? `${homedir()}/Downloads`;

const DL = DOWNLOADS_DIR;
const PH = `${DL}/polyhaven_gltf`;
const OUT_GLB = path.join(process.cwd(), 'public/models/map_props.glb');
const OUT_TEX = path.join(process.cwd(), 'public/textures/map');
const ONLY_MODELS = process.argv[2] === 'models';

const log = (...a) => console.log(...a);
const die = (m) => { console.error('✗', m); process.exit(1); };
await MeshoptSimplifier.ready;

// ────────────────────────────────────────────────────────────────
// glTF 읽기 — 메시 노드를 프리미티브 단위 부품으로 (노드 변환은 정점에 구워 넣는다)
// ────────────────────────────────────────────────────────────────
function readGltf(dir, file = 'scene.gltf') {
  const j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const bins = j.buffers.map((b) => fs.readFileSync(path.join(dir, decodeURIComponent(b.uri))));
  const read = (i) => {
    const a = j.accessors[i], bv = j.bufferViews[a.bufferView], bin = bins[bv.buffer];
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
    const get = {
      5126: (o) => dv.getFloat32(o, true), 5125: (o) => dv.getUint32(o, true),
      5123: (o) => dv.getUint16(o, true), 5121: (o) => dv.getUint8(o),
    }[a.componentType];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const stride = bv.byteStride || n * size, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = a.componentType === 5126 ? new Float32Array(a.count * n) : new Uint32Array(a.count * n);
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = get(base + k * stride + c * size);
    return out;
  };
  const parts = [];
  const walk = (ni, parent) => {
    const n = j.nodes[ni], m = new THREE.Matrix4();
    if (n.matrix) m.fromArray(n.matrix);
    else m.compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
    const world = parent.clone().multiply(m);
    if (n.mesh !== undefined) {
      for (const p of j.meshes[n.mesh].primitives) {
        const pos = read(p.attributes.POSITION);
        const nrm = p.attributes.NORMAL !== undefined ? read(p.attributes.NORMAL) : null;
        const uv = p.attributes.TEXCOORD_0 !== undefined ? read(p.attributes.TEXCOORD_0) : new Float32Array(pos.length / 3 * 2);
        const index = p.indices !== undefined ? read(p.indices) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        const part = { node: n.name ?? '', material: p.material, matName: j.materials[p.material]?.name ?? '', pos, nrm, uv, index };
        if (!nrm) part.nrm = computeNormals(part);
        xform(part, world);
        parts.push(part);
      }
    }
    for (const c of n.children ?? []) walk(c, world);
  };
  for (const r of j.scenes[j.scene ?? 0].nodes) walk(r, new THREE.Matrix4());
  const img = (t) => (t ? path.join(dir, decodeURIComponent(j.images[j.textures[t.index].source].uri)) : null);
  const materials = j.materials.map((m) => ({
    name: m.name,
    color: img(m.pbrMetallicRoughness?.baseColorTexture),
    mr: img(m.pbrMetallicRoughness?.metallicRoughnessTexture),
    normal: img(m.normalTexture),
    occlusion: !!m.occlusionTexture,
    colorFactor: m.pbrMetallicRoughness?.baseColorFactor,
    metallic: m.pbrMetallicRoughness?.metallicFactor ?? 1,
    roughness: m.pbrMetallicRoughness?.roughnessFactor ?? 1,
  }));
  return { parts, materials };
}

function computeNormals(p) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
  g.setIndex(new THREE.BufferAttribute(p.index, 1));
  g.computeVertexNormals();
  return g.attributes.normal.array;
}

/** 정점을 행렬로 옮긴다 (법선은 회전만 — 뒤집힌 행렬이면 삼각형 감기도 뒤집는다). */
function xform(p, matrix) {
  const nm = new THREE.Matrix3().getNormalMatrix(matrix), v = new THREE.Vector3();
  for (let i = 0; i < p.pos.length; i += 3) {
    v.fromArray(p.pos, i).applyMatrix4(matrix).toArray(p.pos, i);
    v.fromArray(p.nrm, i).applyMatrix3(nm).normalize().toArray(p.nrm, i);
  }
  if (matrix.determinant() < 0) for (let t = 0; t < p.index.length; t += 3) [p.index[t + 1], p.index[t + 2]] = [p.index[t + 2], p.index[t + 1]];
  return p;
}
const clone = (p) => ({ ...p, pos: p.pos.slice(), nrm: p.nrm.slice(), uv: p.uv.slice(), index: p.index.slice() });

function boxOf(parts) {
  const b = new THREE.Box3(), v = new THREE.Vector3();
  for (const p of [parts].flat()) for (let i = 0; i < p.pos.length; i += 3) b.expandByPoint(v.fromArray(p.pos, i));
  return b;
}

/** 부품들을 바닥 가운데 기준으로 옮기고 크기를 [w, h, d] 에 맞춘다 (축마다 따로). */
function fitTo(parts, [w, h, d]) {
  const b = boxOf(parts), s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  const m = new THREE.Matrix4().makeScale(w / s.x, h / s.y, d / s.z).multiply(new THREE.Matrix4().makeTranslation(-c.x, -b.min.y, -c.z));
  for (const p of parts) xform(p, m);
  return parts;
}
/** 크기는 그대로 두고 바닥 가운데로만 옮긴다. */
function ground(parts) {
  const b = boxOf(parts), c = b.getCenter(new THREE.Vector3());
  const m = new THREE.Matrix4().makeTranslation(-c.x, -b.min.y, -c.z);
  for (const p of parts) xform(p, m);
  return parts;
}

/** 부품들을 메시 하나로 합친다. */
function merge(parts) {
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

/**
 * 삼각형을 target 개 안팎으로 줄인다. maxError 는 메시 크기 대비 비율이라, 부품을 따로
 * 줄이면 작은 부품(문 · 손잡이)은 그만큼 덜 뭉개진다.
 * Prune — 오차보다 작은 떨어진 조각(볼트 · 잠금 막대 끝)은 통째로 지운다. 이게 없으면
 * 조각마다 삼각형이 몇 개씩 남아 목표까지 못 내려간다.
 */
function simplify(m, target, label, maxError = 0.01, flags = ['Prune']) {
  const before = m.index.length / 3;
  if (before <= target) return m;
  const [index, err] = MeshoptSimplifier.simplifyWithAttributes(
    m.index, m.pos, 3, m.nrm, 3, [0.5, 0.5, 0.5], null, target * 3, maxError, flags);
  log(`    ${label}: 삼각형 ${before} → ${index.length / 3} (오차 ${(err * MeshoptSimplifier.getScale(m.pos, 3) * 100).toFixed(1)}cm)`);
  return { ...m, index };
}
const tris = (m) => m.index.length / 3;

// ────────────────────────────────────────────────────────────────
// 텍스처
// ────────────────────────────────────────────────────────────────
/** 이미지 파일 → sharp. EXR(법선 · 거칠기)은 풀어서 8비트로 (선형 값 그대로). */
function image(file) {
  if (!file.endsWith('.exr')) return sharp(file);
  const buf = fs.readFileSync(file);
  const r = new EXRLoader().setDataType(THREE.FloatType).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const n = r.width * r.height, out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(r.data[i * 4 + c] * 255)));
  // EXR 은 아래 줄부터 저장돼 있다 (EXRLoader 가 뒤집지 않는다)
  return sharp(out, { raw: { width: r.width, height: r.height, channels: 3 } }).flip();
}
const jpeg = (file, px, q) => image(file).resize(px, px, { kernel: 'lanczos3' }).removeAlpha().jpeg({ quality: q, mozjpeg: true }).toBuffer();
const grey = async (file, px) => (await image(file).resize(px, px, { kernel: 'lanczos3' }).greyscale().raw().toBuffer());

/** 거칠기 · 금속 흑백 맵 → glTF ORM 한 장 (R = AO 1, G = 거칠기, B = 금속). */
async function orm(rough, metal, px) {
  const g = await grey(rough, px), b = metal ? await grey(metal, px) : null;
  const out = Buffer.alloc(px * px * 3);
  for (let i = 0; i < px * px; i++) { out[i * 3] = 255; out[i * 3 + 1] = g[i]; out[i * 3 + 2] = b ? b[i] : 0; }
  return sharp(out, { raw: { width: px, height: px, channels: 3 } }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

/** 재질별 텍스처를 cols × rows 칸 한 장으로 (칸 하나 tile px). 빈 칸은 bg. */
async function atlas(files, cols, rows, tile, q, bg) {
  const tiles = await Promise.all(files.map((f) => (f ? image(f).resize(tile, tile, { kernel: 'lanczos3' }).removeAlpha().toBuffer() : null)));
  return sharp({ create: { width: cols * tile, height: rows * tile, channels: 3, background: bg } })
    .composite(tiles.flatMap((input, i) => (input ? [{ input, left: (i % cols) * tile, top: Math.floor(i / cols) * tile }] : [])))
    .jpeg({ quality: q, mozjpeg: true }).toBuffer();
}
/** 부품 UV 를 아틀라스 칸으로 옮긴다 (원래 UV 는 0~1 안이어야 한다). */
function toTile(p, i, cols, rows) {
  const tx = i % cols, ty = Math.floor(i / cols);
  for (let k = 0; k < p.uv.length; k += 2) {
    p.uv[k] = (Math.min(1, Math.max(0, p.uv[k])) + tx) / cols;
    p.uv[k + 1] = (Math.min(1, Math.max(0, p.uv[k + 1])) + ty) / rows;
  }
}

// ────────────────────────────────────────────────────────────────
// GLB 쓰기 — 노드(이름) 하나 = 메시 하나, 프리미티브마다 재질 하나
// ────────────────────────────────────────────────────────────────
const MATS = new Map();   // 이름 → { color, mr, normal: Buffer, occlusion, factor…}
const ITEMS = [];         // { name, prims: [{ mesh, mat }], extras }
const material = (name, def) => { MATS.set(name, { name, ...def }); return name; };
const item = (name, prims, extras) => {
  ITEMS.push({ name, prims, extras });
  log(`  ▸ ${name}: 삼각형 ${prims.reduce((s, p) => s + tris(p.mesh), 0)} · 재질 ${[...new Set(prims.map((p) => p.mat))].join(', ')}`);
};

function writeGlb(outPath) {
  const json = {
    asset: { version: '2.0', generator: 'zombie-fps tools/build_map.mjs' },
    scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [],
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
  const texIndex = new Map();
  const addTexture = (bytes) => {
    if (texIndex.has(bytes)) return texIndex.get(bytes);
    json.images.push({ bufferView: addView(new Uint8Array(bytes)), mimeType: 'image/jpeg' });
    json.textures.push({ source: json.images.length - 1, sampler: 0 });
    texIndex.set(bytes, json.textures.length - 1);
    return json.textures.length - 1;
  };
  const matIndex = new Map();
  const addMaterial = (name) => {
    if (matIndex.has(name)) return matIndex.get(name);
    const t = MATS.get(name);
    if (!t) die(`재질 ${name} 없음`);
    const pbr = { metallicFactor: t.metallic ?? (t.mr ? 1 : 0), roughnessFactor: t.roughness ?? 1 };
    if (t.factor) pbr.baseColorFactor = t.factor;
    if (t.color) pbr.baseColorTexture = { index: addTexture(t.color) };
    if (t.mr) pbr.metallicRoughnessTexture = { index: addTexture(t.mr) };
    const mat = { name, pbrMetallicRoughness: pbr };
    if (t.normal) mat.normalTexture = { index: addTexture(t.normal) };
    if (t.occlusion && t.mr) mat.occlusionTexture = { index: addTexture(t.mr) };   // R = AO
    if (t.emissive) mat.emissiveFactor = t.emissive;
    if (t.blend) mat.alphaMode = 'BLEND';
    if (t.doubleSided) mat.doubleSided = true;
    json.materials.push(mat);
    matIndex.set(name, json.materials.length - 1);
    return json.materials.length - 1;
  };
  const meshCache = new Map();   // 같은 메시 객체 → 같은 접근자 (재질만 다른 변종이 정점을 나눠 쓴다)
  const addMesh = (m) => {
    if (meshCache.has(m)) return meshCache.get(m);
    // 쓰는 정점만 남긴다 (줄인 메시에는 안 쓰는 정점이 남아 있다)
    const used = new Map();
    for (const v of m.index) if (!used.has(v)) used.set(v, used.size);
    const pick = (src, k) => {
      const out = new Float32Array(used.size * k);
      for (const [o, nw] of used) for (let c = 0; c < k; c++) out[nw * k + c] = src[o * k + c];
      return out;
    };
    const Idx = used.size > 65535 ? Uint32Array : Uint16Array;
    const r = {
      attributes: {
        POSITION: addAccessor(pick(m.pos, 3), 'VEC3', 34962, true),
        NORMAL: addAccessor(pick(m.nrm, 3), 'VEC3', 34962),
        TEXCOORD_0: addAccessor(pick(m.uv, 2), 'VEC2', 34962),
      },
      indices: addAccessor(Idx.from(m.index, (v) => used.get(v)), 'SCALAR', 34963),
    };
    meshCache.set(m, r);
    return r;
  };
  for (const { name, prims, extras } of ITEMS) {
    json.meshes.push({ name, primitives: prims.map((p) => ({ ...addMesh(p.mesh), material: addMaterial(p.mat) })) });
    json.nodes.push({ name, mesh: json.meshes.length - 1, ...(extras ? { extras } : {}) });
    json.scenes[0].nodes.push(json.nodes.length - 1);
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
  const texBytes = [...texIndex.keys()].reduce((s, b) => s + b.length, 0);
  log(`\n✅ ${outPath} — ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB (텍스처 ${texIndex.size}장 ${(texBytes / 1024).toFixed(0)} KB)`);
}

// ════════════════════════════════════════════════════════════════
// 1. 타일 텍스처 (바닥 · 벽) — Poly Haven 4K → 1K
// ════════════════════════════════════════════════════════════════
// 크기(m) = 텍스처 한 장이 덮는 실제 크기 (Poly Haven 표기). mapArt.js 가 이 값으로 반복한다.
const TILES = {
  asphalt: { src: 'asphalt_02', m: 3.0, rough: 'rough_4k.jpg' },                          // 야적장 바닥
  hangar: { src: 'hangar_concrete_floor', m: 2.0, rough: 'rough_4k.exr' },                // 창고 바닥
  concrete_wall: { src: 'concrete_wall_006', m: 2.0, rough: 'rough_4k.exr' },             // 바깥 담
  corrugated: { src: 'corrugated_iron_02', m: 2.7, rough: 'rough_4k.exr', metal: 'metal_4k.exr' },   // 창고 벽
  dock: { src: 'concrete_floor_damaged_01', m: 5.0, rough: 'rough_4k.exr' },              // 하역장 윗면
  rust: { src: 'rust_coarse_01', m: 2.2, rough: 'rough_4k.exr' },                         // 하역장 앞면 철판
  metal_plate: { src: 'metal_plate', m: 0.5, rough: 'rough_4k.exr', metal: 'metal_4k.exr' },   // 하역장 계단
};
if (!ONLY_MODELS) {
  fs.mkdirSync(OUT_TEX, { recursive: true });
  log('타일 텍스처');
  for (const [name, t] of Object.entries(TILES)) {
    const dir = `${DL}/${t.src}_4k.blend/textures/${t.src}_`;
    const files = {
      col: await jpeg(`${dir}diff_4k.jpg`, 1024, 82),
      nrm: await jpeg(`${dir}nor_gl_4k.exr`, 512, 90),
      orm: await orm(`${dir}${t.rough}`, t.metal ? `${dir}${t.metal}` : null, 512),
    };
    for (const [k, b] of Object.entries(files)) fs.writeFileSync(path.join(OUT_TEX, `${name}_${k}.jpg`), b);
    log(`  ${name.padEnd(14)} ${t.m}m · ${Object.entries(files).map(([k, b]) => `${k} ${(b.length / 1024).toFixed(0)}KB`).join(' · ')}`);
  }
  fs.writeFileSync(path.join(OUT_TEX, 'tiles.json'), JSON.stringify(Object.fromEntries(Object.entries(TILES).map(([k, t]) => [k, { m: t.m, metal: !!t.metal }])), null, 1));

  // ── 밤하늘 — 조명용은 작게(EXR), 배경은 톤을 눌러 JPEG 로 ──
  log('밤하늘 (dikhololo_night)');
  const buf = fs.readFileSync(`${DL}/dikhololo_night_4k.exr`);
  const hdr = new EXRLoader().setDataType(THREE.FloatType).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const down = (W, H) => {   // 상자 평균으로 줄인다 (별 · 가로등 같은 밝은 점이 사라지지 않게)
    const out = new Float32Array(W * H * 4), fx = hdr.width / W, fy = hdr.height / H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0];
      for (let sy = Math.floor(y * fy); sy < Math.floor((y + 1) * fy); sy++) for (let sx = Math.floor(x * fx); sx < Math.floor((x + 1) * fx); sx++) {
        const i = (sy * hdr.width + sx) * 4;
        for (let c = 0; c < 3; c++) acc[c] += hdr.data[i + c];
      }
      const n = Math.floor(fx) * Math.floor(fy), o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = acc[c] / n;
      out[o + 3] = 1;
    }
    return out;
  };
  const env = new THREE.DataTexture(down(512, 256), 512, 256, THREE.RGBAFormat, THREE.FloatType);
  const exr = await new EXRExporter().parse(env, { type: THREE.HalfFloatType, compression: 3 /* ZIP */ });
  fs.writeFileSync(path.join(OUT_TEX, 'night_env.exr'), exr);
  // 배경: 노출을 올리고 ACES 근사로 눌러 sRGB 로. 게임에선 톤매핑 없이 그대로 깐다.
  const W = 2048, H = 1024, sky = down(W, H), px = Buffer.alloc(W * H * 3);
  const aces = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  const SKY_EXPOSURE = 6;
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) px[i * 3 + c] = Math.round(255 * Math.pow(aces(sky[i * 4 + c] * SKY_EXPOSURE), 1 / 2.2));
  const skyJpg = await sharp(px, { raw: { width: W, height: H, channels: 3 } }).flip().jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  fs.writeFileSync(path.join(OUT_TEX, 'night_sky.jpg'), skyJpg);
  log(`  조명 night_env.exr ${(exr.length / 1024).toFixed(0)}KB · 배경 night_sky.jpg ${(skyJpg.length / 1024).toFixed(0)}KB`);
}

// ════════════════════════════════════════════════════════════════
// 2. 컨테이너 — 20ft 하나를 6m 칸 크기로. 12m 칸은 클라이언트가 둘을 이어 놓는다
// ════════════════════════════════════════════════════════════════
export const CONTAINER = [2.5, 2.6, 6.0];   // shared/map.js 컨테이너 한 칸 (폭 · 한 단 높이 · 20ft 길이)
log('\n컨테이너');
{
  // 원본은 같은 20ft 컨테이너 10개를 흩어 놓은 장면 — 문이 둘 다 닫힌 .005 를 쓴다
  const src = readGltf(`${DL}/shipping_containers`);
  const parts = src.parts.filter((p) => /(Main|DoorL|DoorR)\.005_/.test(p.node));
  if (parts.length !== 3) die(`컨테이너 .005 부품이 ${parts.length}개`);
  fitTo(parts, CONTAINER);
  if (boxOf(parts.find((p) => /DoorL/.test(p.node))).min.z < 0) die('컨테이너 문이 -Z 쪽 — 방향 확인');
  const body = merge(parts.map((p) => (/Main/.test(p.node) ? simplifyPart(p, 1600, '몸통', 0.012) : simplifyPart(p, 600, '문', 0.03, ['Prune', 'Permissive']))));
  const v = src.materials;
  const nrm = await jpeg(v[0].normal, 1024, 90);
  const mats = await Promise.all([0, 1, 2].map(async (i) => material(`Container${i + 1}`, {
    color: await jpeg(v[i].color, 1024, 82), mr: await jpeg(v[i].mr, 512, 88), normal: nrm, doubleSided: true,
  })));
  // 정점은 하나, 재질만 셋 — 클라이언트가 색마다 인스턴싱한다
  mats.forEach((m, i) => item(`Container${i + 1}`, [{ mesh: body, mat: m }]));
}
function simplifyPart(p, target, label, err, flags) { return simplify(merge([p]), target, label, err, flags); }

// 녹슨 컨테이너 (다른 작가) — 재질 둘(Root · mat_ao)을 2×1 아틀라스로
{
  const src = readGltf(`${DL}/post_apocalyptic_shipping_container`);
  const tex = src.materials;
  const tileOf = (p) => (tex[p.material].color === tex.find((m) => m.name === 'Root').color ? 0 : 1);
  for (const p of src.parts) toTile(p, tileOf(p), 2, 1);
  fitTo(src.parts, CONTAINER);
  const doorZ = boxOf(src.parts.find((p) => p.matName === 'Root')).getCenter(new THREE.Vector3()).z;
  if (doorZ < 0) for (const p of src.parts) xform(p, new THREE.Matrix4().makeRotationY(Math.PI));   // 문을 +Z 로
  const mesh = merge(src.parts.map((p) => simplifyPart(p, p.matName === 'Root' ? 700 : 1000, p.node, 0.02)));
  const root = tex.find((m) => m.name === 'Root'), ao = tex.find((m) => m.name === 'mat_ao');
  const pair = (k, q, bg) => atlasWide([root[k], ao[k]], q, bg);
  item('ContainerRust', [{
    mesh,
    mat: material('ContainerRust', { color: await pair('color', 82, '#000'), mr: await pair('mr', 88, '#ffff00'), normal: await pair('normal', 90, '#8080ff'), doubleSided: true }),
  }]);
}
/** 두 장을 가로로 나란히 (512 × 2). */
function atlasWide(files, q, bg) { return atlas(files, 2, 1, 512, q, bg); }

// ════════════════════════════════════════════════════════════════
// 3. 크레인 — 거더가 X 로 가로지르게 돌리고, 다리(기둥)가 x = ±9 에 오게 키운다
// ════════════════════════════════════════════════════════════════
export const CRANE_LEG_X = 9;
log('\n크레인');
{
  const src = readGltf(`${DL}/gantry_crane`);
  // 원본: 레일이 X 방향, 거더가 Z 방향. 바닥(레일 콘크리트 밑면)이 y 2.67
  const floorY = boxOf(src.parts.filter((p) => /tracks/.test(p.node))).min.y;
  // 거더를 X 로: Y 축으로 90° (원래 Z → X)
  const turn = new THREE.Matrix4().makeRotationY(Math.PI / 2).multiply(new THREE.Matrix4().makeTranslation(0, -floorY, 0));
  for (const p of src.parts) xform(p, turn);
  // 기둥 아래 끝 — 노란 다리 정점 중 바닥에서 1m 안쪽, 네 귀퉁이로 나눠 가운데를 잰다
  const legs = {};
  for (const p of src.parts.filter((q) => /yellow_metal_0/.test(q.node))) {
    const minY = boxOf(p).min.y;
    for (let i = 0; i < p.pos.length; i += 3) {
      if (p.pos[i + 1] > minY + 1) continue;
      const k = `${Math.sign(p.pos[i])},${Math.sign(p.pos[i + 2])}`;
      (legs[k] ??= new THREE.Box3()).expandByPoint(new THREE.Vector3().fromArray(p.pos, i));
    }
  }
  const legX = Object.values(legs).reduce((s, b) => s + Math.abs(b.getCenter(new THREE.Vector3()).x), 0) / Object.keys(legs).length;
  const s = CRANE_LEG_X / legX;
  // 레일은 원본 길이(25.6m × 배율)면 광장 끝 컨테이너 밑까지 들어간다 — 레일 방향(Z)으로만 줄인다
  const RAIL_LEN = 24;
  for (const p of src.parts.filter((q) => /tracks/.test(q.node))) {
    const len = boxOf(p).getSize(new THREE.Vector3()).z;
    xform(p, new THREE.Matrix4().makeScale(1, 1, RAIL_LEN / (len * s)));
  }
  for (const p of src.parts) xform(p, new THREE.Matrix4().makeScale(s, s, s));
  const all = boxOf(src.parts);
  log(`  원본 다리 x ±${legX.toFixed(2)} → ×${s.toFixed(3)} · 전체 ${all.getSize(new THREE.Vector3()).toArray().map((x) => x.toFixed(2)).join('×')} (높이 ${all.max.y.toFixed(1)}m)`);
  for (const [k, b] of Object.entries(legs)) {
    const c = b.getCenter(new THREE.Vector3()).multiplyScalar(s), sz = b.getSize(new THREE.Vector3()).multiplyScalar(s);
    log(`  다리 ${k}: 가운데 (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) 바닥 크기 ${sz.x.toFixed(2)}×${sz.z.toFixed(2)}`);
  }
  // 빨간 바퀴 대차(다리 발마다 하나) 크기 — map.js 충돌 박스로 옮긴다
  const red = src.parts.filter((p) => /red_metal_0/.test(p.node));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const b = new THREE.Box3();
    for (const p of red) for (let i = 0; i < p.pos.length; i += 3) if (Math.sign(p.pos[i]) === sx && Math.sign(p.pos[i + 2]) === sz) b.expandByPoint(new THREE.Vector3().fromArray(p.pos, i));
    const c = b.getCenter(new THREE.Vector3()), z = b.getSize(new THREE.Vector3());
    log(`  대차 (${sx},${sz}): 가운데 (${c.x.toFixed(2)}, ${c.z.toFixed(2)}) 크기 ${z.x.toFixed(2)}×${z.z.toFixed(2)} 높이 ${b.max.y.toFixed(2)}`);
  }
  for (const sx of [-1, 1]) {
    const b = new THREE.Box3();
    for (const p of src.parts.filter((q) => /tracks_concrete/.test(q.node))) for (let i = 0; i < p.pos.length; i += 3) if (Math.sign(p.pos[i]) === sx) b.expandByPoint(new THREE.Vector3().fromArray(p.pos, i));
    log(`  레일 바닥 x${sx > 0 ? '+' : '-'}: x ${b.min.x.toFixed(2)}~${b.max.x.toFixed(2)} · z ${b.min.z.toFixed(2)}~${b.max.z.toFixed(2)} · 높이 ${b.max.y.toFixed(2)}`);
  }
  // 재질을 텍스처끼리 묶는다 (같은 그림을 쓰는 .001 재질은 합친다)
  const tex = src.materials;
  const GROUPS = {
    CraneYellow: ['yellow_metal', 'yellow_metal.001'], CraneRed: ['red_metal', 'red_metal.001'],
    CraneGrey: ['grey_metal', 'Material'], CraneConcrete: ['concrete'], CraneCable: ['cables'], CraneDark: ['Material.001', 'Material.002'],
  };
  const TARGET = { CraneYellow: 3500, CraneRed: 3000, CraneGrey: 1200, CraneConcrete: 200, CraneCable: 300, CraneDark: 300 };
  const prims = [];
  for (const [g, names] of Object.entries(GROUPS)) {
    const ps = src.parts.filter((p) => names.includes(p.matName));
    if (!ps.length) continue;
    const t = tex.find((m) => m.name === names[0]);
    const mesh = merge(ps.map((p) => simplifyPart(p, Math.max(60, Math.round(TARGET[g] * tris(p) / ps.reduce((a, q) => a + tris(q), 0))), `${g} ${p.node}`, 0.006)));
    prims.push({
      mesh,
      mat: material(g, {
        color: t.color ? await jpeg(t.color, 512, 82) : null, mr: t.mr ? await jpeg(t.mr, 256, 88) : null,
        factor: t.colorFactor, metallic: t.metallic, roughness: t.roughness, doubleSided: true,
      }),
    });
  }
  item('Crane', prims);
}

// ════════════════════════════════════════════════════════════════
// 4. 트레일러 — 높이 3.6m 에 맞춰 통째로 줄인다 (길이 11.6m)
// ════════════════════════════════════════════════════════════════
export const TRAILER_H = 3.6;
log('\n트레일러');
{
  const src = readGltf(`${DL}/semi_trailer_freestanding`);
  ground(src.parts);
  const sz = boxOf(src.parts).getSize(new THREE.Vector3()), s = TRAILER_H / sz.y;
  for (const p of src.parts) xform(p, new THREE.Matrix4().makeScale(s, s, s));
  const out = boxOf(src.parts).getSize(new THREE.Vector3());
  log(`  ×${s.toFixed(3)} → ${out.toArray().map((x) => x.toFixed(2)).join('×')}`);
  item('Trailer', [{ mesh: simplify(merge(src.parts), 2500, '트레일러', 0.006), mat: material('Trailer', { color: await jpeg(src.materials[0].color, 1024, 82), metallic: 0.2, roughness: 0.75, doubleSided: true }) }],
    { size: out.toArray() });
}

// ════════════════════════════════════════════════════════════════
// 5. 창고 선반 — 선반 한 칸(3m)에 상자 · 드럼통 · 팔레트를 얹어 한 덩어리로
// ════════════════════════════════════════════════════════════════
export const RACK = [1.2, 3.2, 3.0];   // shared/map.js 선반 폭 · 높이, 한 칸 길이
log('\n선반');
{
  const src = readGltf(`${DL}/warehouse_assets`);
  const tex = src.materials;
  // 아틀라스 칸: 0 선반 · 1 큰 상자 · 2 드럼통 · 3 팔레트
  const TILE = { shelf_mat: 0, warehouse_box2_mat: 1, barrel_closed: 2, pallet_mat: 3 };
  const byName = (re) => src.parts.find((p) => re.test(p.node));
  const shelf = clone(byName(/^shelf\.001/));   // Z 방향으로 긴 선반
  toTile(shelf, 0, 2, 2);
  fitTo([shelf], RACK);
  // 판 높이 — 기둥에 구멍이 줄줄이 뚫려 있어 위를 보는 면으로는 못 찾는다. 원본 장면에서
  // 짐이 놓여 있던 높이(0.37 · 1.24 · 2.10m, 선반 높이 2.16m)를 늘린 비율대로 옮긴다.
  // 맨 윗판(3.1m)은 비운다 — 짐이 충돌 박스(3.2m) 위로 삐져나온다.
  const levels = [0.37, 1.24].map((y) => +(y * RACK[1] / 2.16).toFixed(3));
  log(`  선반 판 높이: ${levels.join(' · ')}m`);
  const shelfMesh = simplify(merge([shelf]), 2500, '선반', 0.02, ['Prune', 'Permissive']);

  // 짐 — 원본 크기 그대로, 판 위에 놓는다. 선반 폭(1.2)을 넘으면 줄인다
  const prop = (re, tile, target) => {
    const p = clone(byName(re));
    toTile(p, tile, 2, 2);
    ground([p]);
    return simplify(merge([p]), target, p.node, 0.03, ['Prune', 'Permissive']);
  };
  const box2 = prop(/^warehouse_box2_/, 1, 200), barrel = prop(/^metal barrel_/, 2, 400), pallet = prop(/^pallet_/, 3, 250);
  const place = (m, x, y, z, rotY = 0, maxW = RACK[0] - 0.08) => {
    const p = { ...m, pos: m.pos.slice(), nrm: m.nrm.slice() };
    const b = boxOf([p]).getSize(new THREE.Vector3());
    const w = rotY ? b.z : b.x, s = Math.min(1, maxW / w);
    return xform(p, new THREE.Matrix4().makeTranslation(x, y, z).multiply(new THREE.Matrix4().makeRotationY(rotY)).multiply(new THREE.Matrix4().makeScale(s, s, s)));
  };
  const L = levels, h = RACK[2] / 2;
  // 두 가지 짐 배치 — 클라이언트가 칸마다 번갈아 쓴다
  const loads = {
    RackA: [place(barrel, 0, L[0], -h + 0.45), place(barrel, -0.05, L[0], -h + 1.1), place(box2, 0, L[0], h - 0.75, Math.PI / 2),
      place(box2, 0, L[1], -h + 0.75, Math.PI / 2), place(pallet, 0, L[1], h - 0.8, Math.PI / 2), place(box2, 0, L[1] + 0.2, h - 0.8, Math.PI / 2)],
    RackB: [place(pallet, 0, L[0], -h + 0.8, Math.PI / 2), place(box2, 0, L[0] + 0.2, -h + 0.8, Math.PI / 2), place(barrel, 0, L[0], h - 0.5),
      place(barrel, 0, L[1], -h + 0.5), place(barrel, 0, L[1], -h + 1.15), place(box2, 0, L[1], h - 0.75, Math.PI / 2)],
  };
  const files = (k) => ['shelf_mat', 'warehouse_box2_mat', 'barrel_closed', 'pallet_mat'].map((n) => tex.find((m) => m.name === n)[k]);
  const mat = material('Rack', {
    color: await atlas(files('color'), 2, 2, 512, 82, '#000'), mr: await atlas(files('mr'), 2, 2, 512, 88, '#ffff00'),
    normal: await atlas(files('normal'), 2, 2, 512, 90, '#8080ff'), doubleSided: true,
  });
  for (const [name, parts] of Object.entries(loads)) item(name, [{ mesh: merge([shelfMesh, ...parts]), mat }]);
}

// ════════════════════════════════════════════════════════════════
// 6. Poly Haven 소품 (CC0) — 1K glTF 를 512 텍스처로
// ════════════════════════════════════════════════════════════════
log('\n소품');
const phTex = async (m, px = 512) => ({
  color: await jpeg(m.color, px, 82), mr: m.mr ? await jpeg(m.mr, px, 88) : null, normal: m.normal ? await jpeg(m.normal, px, 90) : null, occlusion: m.occlusion,
});
const ph = (name) => readGltf(`${PH}/${name}`, `${name}_1k.gltf`);

{ // 방호벽 1.57 × 1.11 × 0.44 — map.js barrier 박스 하나에 둘씩
  const src = ph('concrete_road_barrier_02');
  ground(src.parts);
  item('Barrier', [{ mesh: simplify(merge(src.parts), 600, '방호벽', 0.015), mat: material('Barrier', await phTex(src.materials[0])) }],
    { size: boxOf(src.parts).getSize(new THREE.Vector3()).toArray() });
}
{ // 나무 상자 0.53 × 0.46 × 1.17 (긴 쪽 Z) — map.js crate 박스를 쌓아서 채운다
  const src = ph('wooden_crate_02');
  ground(src.parts);
  item('Crate', [{ mesh: simplify(merge(src.parts), 700, '나무 상자', 0.015), mat: material('Crate', await phTex(src.materials[0])) }],
    { size: boxOf(src.parts).getSize(new THREE.Vector3()).toArray() });
}
{ // 드럼통
  const src = ph('barrel_03');
  ground(src.parts);
  item('Barrel', [{ mesh: simplify(merge(src.parts), 600, '드럼통', 0.015), mat: material('Barrel', await phTex(src.materials[0])) }],
    { size: boxOf(src.parts).getSize(new THREE.Vector3()).toArray() });
}
{ // 쓰레기통 둘 (깨끗한 것 · 녹슨 것) — 한 장면에 나란히 있다
  const src = ph('metal_trash_can');
  for (const [name, re, mi] of [['TrashCan', /^metal_trash_can(?!_rust)/, 0], ['TrashCanRust', /^metal_trash_can_rust/, 1]]) {
    const parts = src.parts.filter((p) => re.test(p.node)).map(clone);
    ground(parts);
    item(name, [{ mesh: simplify(merge(parts), 900, name, 0.015), mat: material(name, await phTex(src.materials[mi])) }],
      { size: boxOf(parts).getSize(new THREE.Vector3()).toArray() });
  }
}
{ // 타이어 더미 — 눕힌 타이어 셋을 조금씩 어긋나게
  const src = ph('old_tyre');
  const one = simplify(merge(src.parts), 450, '타이어', 0.015);
  const flat = xform({ ...one, pos: one.pos.slice(), nrm: one.nrm.slice() }, new THREE.Matrix4().makeRotationX(Math.PI / 2));
  ground([flat]);
  const th = boxOf([flat]).getSize(new THREE.Vector3()).y;
  const stack = [[0, 0, 0, 0], [0.03, 1, -0.02, 0.7], [-0.02, 2, 0.03, 1.9]].map(([dx, k, dz, r]) =>
    xform({ ...flat, pos: flat.pos.slice(), nrm: flat.nrm.slice() }, new THREE.Matrix4().makeTranslation(dx, k * th * 0.96, dz).multiply(new THREE.Matrix4().makeRotationY(r))));
  item('TyreStack', [{ mesh: merge(stack), mat: material('Tyre', await phTex(src.materials[0])) }], { size: boxOf(stack).getSize(new THREE.Vector3()).toArray() });
}
{ // 셔터 둘 (그냥 · 낙서) — 원본은 폭 1.08m 라 가로로 늘려 2.7m 차고 문으로
  const src = ph('rollershutter_door');
  for (const [name, mi] of [['Shutter', 0], ['ShutterGraffiti', 1]]) {
    const parts = src.parts.filter((p) => p.material === mi).map(clone);
    ground(parts);
    for (const p of parts) xform(p, new THREE.Matrix4().makeScale(2.5, 1, 1));
    // 벽에 붙는 면(뒤)이 z = 0 이 되게
    const b = boxOf(parts);
    for (const p of parts) xform(p, new THREE.Matrix4().makeTranslation(0, 0, -b.min.z));
    item(name, [{ mesh: merge(parts), mat: material(name, await phTex(src.materials[mi])) }], { size: boxOf(parts).getSize(new THREE.Vector3()).toArray() });
  }
}
{ // 가로등 — 기둥 · 유리 · 전구. 유리와 전구는 스스로 빛나게
  const src = ph('street_lamp_01');
  ground(src.parts);
  const by = (n) => src.parts.filter((p) => p.matName === n);
  const glow = [1.0, 0.72, 0.42];
  item('Lamp', [
    { mesh: simplify(merge(by('street_lamp_01')), 1500, '가로등', 0.01), mat: material('Lamp', await phTex(src.materials[0])) },
    { mesh: merge([...by('street_lamp_01_glass'), ...by('street_lamp_01_bulb')]), mat: material('LampGlow', { factor: [1, 0.85, 0.6, 1], emissive: glow, metallic: 0, roughness: 0.4 }) },
  ], { size: boxOf(src.parts).getSize(new THREE.Vector3()).toArray(), light: boxOf(by('street_lamp_01_bulb')).getCenter(new THREE.Vector3()).toArray() });
}
{ // 보안등 — 벽에 붙는 쪽이 z = 0, 앞(+Z)으로 비춘다
  const src = ph('security_light');
  const b = boxOf(src.parts);
  for (const p of src.parts) xform(p, new THREE.Matrix4().makeTranslation(-b.getCenter(new THREE.Vector3()).x, 0, -b.min.z));
  const by = (n) => src.parts.filter((p) => p.matName === n);
  item('SecurityLight', [
    { mesh: simplify(merge(by('security_light')), 700, '보안등', 0.02), mat: material('SecurityLight', await phTex(src.materials[0])) },
    { mesh: merge([...by('security_light_bulb'), ...by('security_light_glass')]), mat: material('SecurityGlow', { factor: [1, 0.95, 0.85, 1], emissive: [1, 0.9, 0.75], metallic: 0, roughness: 0.4 }) },
  ], { light: boxOf(by('security_light_bulb')).getCenter(new THREE.Vector3()).toArray() });
}

writeGlb(OUT_GLB);
