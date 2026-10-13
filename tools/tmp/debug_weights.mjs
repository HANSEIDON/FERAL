// 특정 정점의 스킨 가중치 비교: GLB vs FBX
globalThis.self = globalThis;
globalThis.document = { createElementNS: () => ({ style: {} }) };
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
import path from 'node:path';

const buf = fs.readFileSync(path.join(process.cwd(), 'public/models/hunter.glb'));
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
let mesh = null;
gltf.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
const gSI = mesh.geometry.attributes.skinIndex.array;
const gSW = mesh.geometry.attributes.skinWeight.array;
const gBones = mesh.skeleton.bones.map((b) => b.name);

const fbuf = fs.readFileSync('C:/Users/haki0/Downloads/모션/Standing Run Forward.fbx');
const fg = new FBXLoader().parse(fbuf.buffer.slice(fbuf.byteOffset, fbuf.byteOffset + fbuf.byteLength), '');
let fm = null; fg.traverse((o) => { if (o.isMesh) fm = o; });
const fSI = fm.geometry.attributes.skinIndex.array;
const fSW = fm.geometry.attributes.skinWeight.array;
const fBones = fm.skeleton.bones.map((b) => b.name);

console.log('뼈대 순서 동일:', JSON.stringify(gBones) === JSON.stringify(fBones));

// GLB 인덱스로 FBX 정점 위치 찾기
const obuf = fs.readFileSync('C:/Users/haki0/Downloads/ComfyUI_00018.glb');
const ogltf = await new GLTFLoader().parseAsync(
  obuf.buffer.slice(obuf.byteOffset, obuf.byteOffset + obuf.byteLength), '');
let oMesh = null;
ogltf.scene.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) oMesh = o; });
const indices = oMesh.geometry.index.array;
const glbToFbx = new Int32Array(oMesh.geometry.attributes.position.count).fill(-1);
for (let i = 0; i < indices.length; i++) {
  const v = indices[i];
  if (glbToFbx[v] === -1) glbToFbx[v] = i;
}

for (const v of [0, 100, 5000, 12000, 20000]) {
  const i = glbToFbx[v];
  const gw = Array.from(gSW.slice(v * 4, v * 4 + 4)).map((n) => n.toFixed(3));
  const gi = Array.from(gSI.slice(v * 4, v * 4 + 4));
  const fw = Array.from(fSW.slice(i * 4, i * 4 + 4)).map((n) => n.toFixed(3));
  const fi = Array.from(fSI.slice(i * 4, i * 4 + 4));
  console.log(`v=${v} (fbx i=${i})`);
  console.log(`  GLB: idx=[${gi}] bones=[${gi.map((b) => gBones[b]).join(',')}] w=[${gw}] sum=${gw.reduce((a, b) => a + +b, 0).toFixed(3)}`);
  console.log(`  FBX: idx=[${fi}] bones=[${fi.map((b) => fBones[b]).join(',')}] w=[${fw}] sum=${fw.reduce((a, b) => a + +b, 0).toFixed(3)}`);
}
