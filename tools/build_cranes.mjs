// 크레인 두 대 — 받은 glTF(Sketchfab) → 게임용 GLB
//
//   node tools/build_cranes.mjs   →   public/models/crane_sokol.glb · crane_tower.glb
//
// 원본은 tools/tmp/crane_src/ (다운로드 폴더에서 복사, 저장소엔 없다).
//   Port crane "Sokol"  — Vitaliy Kovalchuk, CC BY 4.0. 26.7초 동작(팔 오르내림 · 짐 옮기기)을 그대로 둔다.
//                         밑에 깔린 흙 · 콘크리트 판(Decor_Decor_0)은 뺀다 — 맵 바닥과 겹친다.
//   Tower Crane         — Chamod, CC BY 4.0. 맵 바깥 배경이라 멀리서만 보인다 → 색 텍스처만 작게.
//
// 메시는 그대로 두고 텍스처만 줄여서 JPEG 로 GLB 안에 넣는다 (원본 PNG 4K 가 77MB).

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { MeshoptSimplifier } from 'meshoptimizer';

await MeshoptSimplifier.ready;

const SRC = path.join(process.cwd(), 'tools/tmp/crane_src');
const OUT = path.join(process.cwd(), 'public/models');

const JOBS = [
  { src: 'sokol', out: 'crane_sokol.glb', drop: ['Decor_Decor_0'], size: { baseColor: 1024, normal: 512, metallicRoughness: 512 } },
  { src: 'tower', out: 'crane_tower.glb', drop: [], size: { baseColor: 512 }, onlyColor: true, simplify: 0.35 },
];

for (const job of JOBS) {
  const dir = path.join(SRC, job.src);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'scene.gltf'), 'utf8'));
  let bin = fs.readFileSync(path.join(dir, j.buffers[0].uri));
  if (job.simplify) bin = repackMeshes(j, bin, job.simplify);

  // 빼는 노드는 메시만 떼어 낸다 (노드 · 동작 대상 번호가 어긋나지 않게)
  for (const n of j.nodes) if (job.drop.includes(n.name)) delete n.mesh;

  // 배경용은 노멀 · 금속성 맵을 버린다
  if (job.onlyColor) {
    for (const m of j.materials) {
      delete m.normalTexture;
      delete m.occlusionTexture;
      if (m.pbrMetallicRoughness) delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  const used = new Set();
  for (const m of j.materials) {
    for (const t of [m.pbrMetallicRoughness?.baseColorTexture, m.pbrMetallicRoughness?.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture]) {
      if (t) used.add(j.textures[t.index].source);
    }
  }

  // 버퍼: 원래 bin 뒤에 줄인 이미지들을 붙인다
  const chunks = [bin];
  let cursor = bin.length;
  const pad = () => { const p = (4 - (cursor % 4)) % 4; if (p) { chunks.push(Buffer.alloc(p)); cursor += p; } };
  let texBytes = 0;
  for (const [i, img] of j.images.entries()) {
    if (!used.has(i)) { j.images[i] = { name: img.uri, mimeType: 'image/jpeg', bufferView: null }; continue; }
    const kind = Object.keys(job.size).find((k) => img.uri.includes(k)) ?? 'baseColor';
    const px = job.size[kind] ?? 512;
    const data = await sharp(path.join(dir, img.uri)).resize(px, px, { fit: 'inside' }).jpeg({ quality: kind === 'normal' ? 92 : 85 }).toBuffer();
    pad();
    j.bufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: data.length });
    chunks.push(data); cursor += data.length; texBytes += data.length;
    j.images[i] = { name: path.basename(img.uri), mimeType: 'image/jpeg', bufferView: j.bufferViews.length - 1 };
  }
  // 안 쓰는 이미지는 아주 작은 검은 칸으로 채운다 (번호를 지키려고)
  for (const img of j.images) {
    if (img.bufferView !== null) continue;
    const data = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).jpeg().toBuffer();
    pad();
    j.bufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: data.length });
    chunks.push(data); cursor += data.length;
    img.bufferView = j.bufferViews.length - 1;
  }
  pad();
  j.buffers = [{ byteLength: cursor }];
  j.asset.generator = 'zombie-fps tools/build_cranes.mjs';

  const body = Buffer.concat(chunks);
  let json = Buffer.from(JSON.stringify(j));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + body.length, 8);
  const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
  fs.writeFileSync(path.join(OUT, job.out), Buffer.concat([head, ch(json.length, 0x4e4f534a), json, ch(body.length, 0x004e4942), body]));
  console.log(`${job.out}: ${(fs.statSync(path.join(OUT, job.out)).size / 1048576).toFixed(1)} MB (텍스처 ${(texBytes / 1048576).toFixed(1)} MB)`);
}

/**
 * 메시를 새 버퍼로 다시 싼다 — 위치 · 노멀 · UV 만 남기고(탄젠트 · 2·3번 UV 버림), 삼각형을 ratio 만큼으로 줄이고,
 * 안 쓰게 된 정점은 지운다. 배경용(멀리서 실루엣) 모델에만 쓴다.
 */
function repackMeshes(j, bin, ratio) {
  const read = (ai, n) => {
    const a = j.accessors[ai], v = j.bufferViews[a.bufferView];
    const stride = v.byteStride ?? n * 4, base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = bin.readFloatLE(base + i * stride + k * 4);
    return out;
  };
  const readIdx = (ai) => {
    const a = j.accessors[ai], v = j.bufferViews[a.bufferView], base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Uint32Array(a.count);
    for (let i = 0; i < a.count; i++) out[i] = a.componentType === 5125 ? bin.readUInt32LE(base + i * 4) : bin.readUInt16LE(base + i * 2);
    return out;
  };
  const chunks = [], views = [], accs = [];
  let cursor = 0, before = 0, after = 0;
  const push = (arr, type, target, minmax) => {
    const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    chunks.push(buf);
    views.push({ buffer: 0, byteOffset: cursor, byteLength: buf.length, target });
    cursor += buf.length;
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
    const acc = { bufferView: views.length - 1, componentType: arr instanceof Uint32Array ? 5125 : 5126, count: arr.length / n, type };
    if (minmax) { acc.min = [0, 1, 2].map((k) => Math.min(...arr.filter((_, i) => i % 3 === k))); acc.max = [0, 1, 2].map((k) => Math.max(...arr.filter((_, i) => i % 3 === k))); }
    accs.push(acc);
    return accs.length - 1;
  };
  for (const m of j.meshes) {
    for (const p of m.primitives) {
      const pos = read(p.attributes.POSITION, 3), nor = p.attributes.NORMAL !== undefined ? read(p.attributes.NORMAL, 3) : null;
      const uv = p.attributes.TEXCOORD_0 !== undefined ? read(p.attributes.TEXCOORD_0, 2) : null;
      let idx = readIdx(p.indices);
      before += idx.length / 3;
      const target = Math.max(3, Math.floor((idx.length * ratio) / 3) * 3);
      if (idx.length > 300) [idx] = MeshoptSimplifier.simplify(idx, pos, 3, target, 0.08, ['Prune', 'LockBorder']);
      after += idx.length / 3;
      // 남은 정점만 모은다
      const remap = new Map(), keep = [];
      const ni = new Uint32Array(idx.length);
      idx.forEach((v, i) => { if (!remap.has(v)) { remap.set(v, keep.length); keep.push(v); } ni[i] = remap.get(v); });
      const pick = (src, n) => { const o = new Float32Array(keep.length * n); keep.forEach((v, i) => { for (let k = 0; k < n; k++) o[i * n + k] = src[v * n + k]; }); return o; };
      const attrs = { POSITION: push(pick(pos, 3), 'VEC3', 34962, true) };
      if (nor) attrs.NORMAL = push(pick(nor, 3), 'VEC3', 34962);
      if (uv) attrs.TEXCOORD_0 = push(pick(uv, 2), 'VEC2', 34962);
      p.attributes = attrs;
      p.indices = push(ni, 'SCALAR', 34963);
    }
  }
  // 동작 · 스킨이 없는 모델이라 메시 데이터만 갈아 끼우면 된다
  j.bufferViews = views;
  j.accessors = accs;
  console.log(`  삼각형 ${before} → ${after}`);
  return Buffer.concat(chunks);
}
