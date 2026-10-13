// GLB(인덱스) ↔ FBX(비인덱스) 삼각형 대응을 검증한다.
// fbxPos[i] ≈ glbPos[glbIndex[i]] 가 전부 성립하면 스킨 가중치 이식이 가능하다.
import { readFileSync } from 'node:fs';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const GLB = 'C:/Users/haki0/Downloads/ComfyUI_00018.glb';
const FBX = 'C:/Users/haki0/Downloads/모션/Standing Idle 01.fbx';

const buf = readFileSync(GLB);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 12, json = null, bin = null;
while (off < dv.getUint32(8, true)) {
  const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
  else if (type === 0x004e4942) bin = data;
  off += 8 + len;
}
const prim = json.meshes[0].primitives[0];
function attrView(idx) {
  const a = json.accessors[idx];
  const bv = json.bufferViews[a.bufferView];
  const compSize = { 5126: 4, 5123: 2, 5125: 4 }[a.componentType];
  const typeSize = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const byteOffset = bv.byteOffset + (a.byteOffset ?? 0);
  const count = a.count * typeSize;
  return { arr: new Float32Array(bin.buffer, bin.byteOffset + byteOffset, count), typeSize };
}
const glbPos = attrView(prim.attributes.POSITION);
const glbUV = attrView(prim.attributes.TEXCOORD_0);
const idxAcc = json.accessors[prim.indices];
const idxBV = json.bufferViews[idxAcc.bufferView];
const idxCount = idxAcc.count;
const glbIndex = new Uint32Array(bin.buffer, bin.byteOffset + idxBV.byteOffset + (idxAcc.byteOffset ?? 0), idxCount);

const fbuf = readFileSync(FBX);
const fbxGroup = new FBXLoader().parse(fbuf.buffer.slice(fbuf.byteOffset, fbuf.byteOffset + fbuf.byteLength), '');
let fbxMesh = null;
fbxGroup.traverse(o => { if (o.isSkinnedMesh) fbxMesh = o; });
const fbxPos = fbxMesh.geometry.attributes.position.array;
const fbxUV = fbxMesh.geometry.attributes.uv.array;

const nVerts = fbxPos.length / 3;
let posMatch = 0, uvMatch = 0;
const EPS = 1e-4;
for (let i = 0; i < nVerts; i++) {
  const v = glbIndex[i];
  const ok = Math.abs(fbxPos[i * 3] - glbPos.arr[v * 3]) < EPS
    && Math.abs(fbxPos[i * 3 + 1] - glbPos.arr[v * 3 + 1]) < EPS
    && Math.abs(fbxPos[i * 3 + 2] - glbPos.arr[v * 3 + 2]) < EPS;
  if (ok) posMatch++;
  if (Math.abs(fbxUV[i * 2] - glbUV.arr[v * 2]) < EPS && Math.abs(fbxUV[i * 2 + 1] - glbUV.arr[v * 2 + 1]) < EPS) uvMatch++;
}
console.log('삼각형 개수: GLB', idxCount / 3, 'FBX', nVerts / 3);
console.log('POSITION 대응 일치:', posMatch, '/', nVerts, (100 * posMatch / nVerts).toFixed(2) + '%');
console.log('UV 대응 일치:', uvMatch, '/', nVerts, (100 * uvMatch / nVerts).toFixed(2) + '%');
