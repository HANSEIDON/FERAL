// ComfyUI GLB 와 Mixamo FBX 의 토폴로지를 비교한다.
// GLB 는 바이너리 직접 파싱 (Node 에 DOM 이 없어서), FBX 는 FBXLoader.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const GLB = 'C:/Users/haki0/Downloads/ComfyUI_00018.glb';
const FBX = 'C:/Users/haki0/Downloads/모션/Standing Idle 01.fbx';

// ── GLB 바이너리 파싱 ──
const buf = readFileSync(GLB);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const magic = dv.getUint32(0, true);
if ((magic & 0xffffffff) !== 0x46546c67) throw new Error('not a GLB');
const totalLen = dv.getUint32(8, true);
let off = 12;
let json = null, bin = null;
while (off < totalLen) {
  const chunkLen = dv.getUint32(off, true);
  const chunkType = dv.getUint32(off + 4, true);
  const data = buf.subarray(off + 8, off + 8 + chunkLen);
  if (chunkType === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
  else if (chunkType === 0x004e4942) bin = data;
  off += 8 + chunkLen;
}
console.log('=== ComfyUI GLB (바이너리 파싱) ===');
console.log('meshes:', json.meshes?.length, 'skins:', json.skins?.length, 'nodes:', json.nodes?.length, 'animations:', json.animations?.length ?? 0);
console.log('images:', json.images?.length, json.images?.map(i => i.mimeType));
console.log('materials:', JSON.stringify(json.materials, null, 1));

// mesh 의 primitive 접근자
const prim = json.meshes[0].primitives[0];
const acc = (idx) => {
  const a = json.accessors[idx];
  const bv = json.bufferViews[a.bufferView];
  return { type: a.type, comp: a.componentType, count: a.count, byteOffset: bv.byteOffset + (a.byteOffset ?? 0), target: bv.target };
};
const compSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const typeSize = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
for (const [attr, idx] of Object.entries(prim.attributes)) {
  const a = acc(idx);
  const bytes = a.count * typeSize[a.type] * compSize[a.comp];
  console.log(`attr ${attr}: count=${a.count} comp=${a.comp} type=${a.type} bytes=${bytes}`);
}
console.log('indices:', acc(prim.indices).count);
// 첫 정점 3개
const pos = acc(prim.attributes.POSITION);
const p = new Float32Array(bin.buffer, bin.byteOffset + pos.byteOffset, 9);
console.log('first 3 verts:', [...p]);
// 첫 UV
if (prim.attributes.TEXCOORD_0) {
  const uv = acc(prim.attributes.TEXCOORD_0);
  const u = new Float32Array(bin.buffer, bin.byteOffset + uv.byteOffset, 8);
  console.log('first 4 UVs:', [...u]);
}

// ── FBX ──
const fbxLoader = new FBXLoader();
const fbuf = readFileSync(FBX);
const fbxGroup = fbxLoader.parse(fbuf.buffer.slice(fbuf.byteOffset, fbuf.byteOffset + fbuf.byteLength), '');
console.log('\n=== Mixamo FBX (Standing Idle 01) ===');
console.log('animations:', fbxGroup.animations.length, fbxGroup.animations.map(c => `${c.name} (${c.duration.toFixed(2)}s)`));
let fbxMesh = null, boneCount = 0, rootBone = null;
fbxGroup.traverse(o => {
  if (o.isSkinnedMesh && !fbxMesh) fbxMesh = o;
  if (o.isBone) {
    boneCount++;
    if (!(o.parent && o.parent.isBone)) rootBone = o;
  }
});
console.log('bones:', boneCount, 'root:', rootBone?.name);
const fg = fbxMesh.geometry;
console.log('FBX vertices:', fg.attributes.position.count, 'index:', fg.index?.count);
for (const name of Object.keys(fg.attributes)) {
  const a = fg.attributes[name];
  console.log(`  attr ${name}: count=${a.count} itemSize=${a.itemSize}`);
}
console.log('material:', fbxMesh.material?.name, fbxMesh.material?.type);
const box = new THREE.Box3().setFromObject(fbxMesh);
console.log('FBX mesh bbox:', box.min.toArray().map(v => +v.toFixed(3)), box.max.toArray().map(v => +v.toFixed(3)));

// ── 비교 ──
const glbVerts = acc(prim.attributes.POSITION).count;
console.log('\n=== 비교 ===');
console.log('GLB vertices:', glbVerts, '| FBX vertices:', fg.attributes.position.count, '| 일치:', glbVerts === fg.attributes.position.count);
if (glbVerts === fg.attributes.position.count) {
  const a = new Float32Array(bin.buffer, bin.byteOffset + pos.byteOffset, 12);
  const b = fg.attributes.position.array;
  let match = 0;
  for (let i = 0; i < 12; i++) if (Math.abs(a[i] - b[i]) < 1e-4) match++;
  console.log('POSITION 첫 12개 값 일치:', match, '/12');
  if (prim.attributes.TEXCOORD_0 && fg.attributes.uv) {
    const uv = acc(prim.attributes.TEXCOORD_0);
    const ua = new Float32Array(bin.buffer, bin.byteOffset + uv.byteOffset, 8);
    const ub = fg.attributes.uv.array;
    let um = 0;
    for (let i = 0; i < 8; i++) if (Math.abs(ua[i] - ub[i]) < 1e-4) um++;
    console.log('UV 첫 8개 값 일치:', um, '/8');
  }
}
