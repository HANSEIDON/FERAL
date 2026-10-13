// 새 캐릭터(GLB)와 모션(FBX) 파일 구조 검사용 임시 스크립트
import { readFileSync, readdirSync } from 'node:fs';
globalThis.self = globalThis;   // GLTFLoader 가 쓰는 브라우저 전역
import { Box3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const GLB = 'C:/Users/haki0/Downloads/ComfyUI_00018.glb';
const MOT = 'C:/Users/haki0/Downloads/모션';

// Node Buffer 는 ArrayBuffer 가 아니라서 로더가 텍스트로 오인한다
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

new GLTFLoader().parse(toAB(readFileSync(GLB)), '', (gltf) => {
  console.log('== GLB ==');
  console.log('animations:', gltf.animations.map(a => `${a.name} (${a.duration.toFixed(2)}s)`));
  const box = new Box3().setFromObject(gltf.scene);
  console.log('bbox size:', box.size.toArray().map(v => v.toFixed(2)).join(', '));
  console.log('bbox min:', box.min.toArray().map(v => v.toFixed(2)).join(', '));
  let bones = 0, rootBone = null, skinned = [];
  gltf.scene.traverse((o) => {
    if (o.isBone) { bones++; if (!(o.parent && o.parent.isBone)) rootBone = o.name; }
    if (o.isSkinnedMesh) skinned.push(o.name);
  });
  console.log('bones:', bones, 'rootBone:', rootBone);
  console.log('skinned meshes:', skinned);
}, (err) => console.log('GLB ERR', err.message));

const fbx = new FBXLoader();
for (const f of readdirSync(MOT)) {
  if (!f.toLowerCase().endsWith('.fbx')) continue;
  try {
    const obj = fbx.parse(toAB(readFileSync(`${MOT}/${f}`)), '');
    console.log('== FBX:', f);
    for (const a of obj.animations) console.log('   ', a.name, `(${a.duration.toFixed(2)}s)`, 'tracks:', a.tracks.length);
    if (!obj.animations.length) console.log('    (no animations)');
    let rootBone = null, bones = 0;
    obj.traverse((o) => { if (o.isBone) { bones++; if (!(o.parent && o.parent.isBone)) rootBone = o.name; } });
    console.log('    bones:', bones, 'rootBone:', rootBone);
  } catch (e) { console.log('== FBX ERR', f, e.message); }
}
