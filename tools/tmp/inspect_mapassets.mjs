// 임시 — 받은 맵 에셋(glTF) 구조 보기: 메시 노드 · 재질 · 삼각형 · 세계 좌표 크기
//   node tools/tmp/inspect_mapassets.mjs <폴더> [gltf 파일 이름]
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const file = process.argv[3] ?? 'scene.gltf';
const j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const bin = fs.readFileSync(path.join(dir, j.buffers[0].uri));
const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
const readPos = (i) => {
  const a = j.accessors[i], bv = j.bufferViews[a.bufferView];
  const stride = bv.byteStride || 12, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float32Array(a.count * 3);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < 3; c++) out[k * 3 + c] = dv.getFloat32(base + k * stride + c * 4, true);
  return out;
};
const all = new THREE.Box3();
const rows = [];
const walk = (ni, parent, depth) => {
  const n = j.nodes[ni], m = new THREE.Matrix4();
  if (n.matrix) m.fromArray(n.matrix);
  else m.compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])));
  const world = parent.clone().multiply(m);
  if (n.mesh !== undefined) {
    for (const p of j.meshes[n.mesh].primitives) {
      const pos = readPos(p.attributes.POSITION), b = new THREE.Box3(), v = new THREE.Vector3();
      for (let i = 0; i < pos.length; i += 3) b.expandByPoint(v.fromArray(pos, i).applyMatrix4(world));
      all.union(b);
      const tris = (p.indices !== undefined ? j.accessors[p.indices].count : pos.length / 3) / 3;
      rows.push({ node: n.name, mat: j.materials[p.material]?.name, tris, attrs: Object.keys(p.attributes).join(','), b });
    }
  }
  for (const c of n.children ?? []) walk(c, world, depth + 1);
};
for (const r of j.scenes[j.scene ?? 0].nodes) walk(r, new THREE.Matrix4(), 0);
const f = (b) => {
  const s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  return `크기 ${s.toArray().map((x) => x.toFixed(2)).join('×')} 중심 ${c.toArray().map((x) => x.toFixed(2)).join(',')} 바닥y ${b.min.y.toFixed(2)}`;
};
console.log(`${dir}\n  전체 ${f(all)} · 프리미티브 ${rows.length} · 삼각형 ${rows.reduce((s, r) => s + r.tris, 0)}`);
console.log('  재질:', j.materials.map((m, i) => `${i}:${m.name}${m.pbrMetallicRoughness?.baseColorTexture ? '[색]' : ''}${m.normalTexture ? '[법선]' : ''}${m.pbrMetallicRoughness?.metallicRoughnessTexture ? '[MR]' : ''}${m.occlusionTexture ? '[AO]' : ''}${m.alphaMode ? '[' + m.alphaMode + ']' : ''}`).join(' '));
const lim = +(process.env.ROWS ?? 40);
for (const r of rows.slice(0, lim)) console.log(`   ${String(r.tris).padStart(6)}  ${(r.node ?? '').slice(0, 34).padEnd(34)} ${String(r.mat).slice(0, 26).padEnd(26)} ${f(r.b)}`);
if (rows.length > lim) console.log(`   … ${rows.length - lim}개 더`);
