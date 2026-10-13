import { readFileSync } from 'node:fs';
globalThis.self = globalThis;
import { Box3 } from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const fbx = new FBXLoader();
const f = 'C:/Users/haki0/Downloads/모션/Standing Idle 01.fbx';
const obj = fbx.parse(toAB(readFileSync(f)), '');
// rest pose bbox
obj.updateMatrixWorld(true);
const box = new Box3().setFromObject(obj);
console.log('FBX rest bbox min:', box.min.toArray().map(v=>v.toFixed(3)));
console.log('FBX rest bbox max:', box.max.toArray().map(v=>v.toFixed(3)));
console.log('FBX rest bbox size:', box.size.toArray().map(v=>v.toFixed(3)));
// bones
const bones = [];
obj.traverse(o => { if (o.isBone) bones.push(o); });
console.log('bone count:', bones.length);
// key bones positions (world)
for (const name of ['mixamorigHips','mixamorigSpine','mixamorigSpine1','mixamorigSpine2','mixamorigNeck','mixamorigHead','mixamorigLeftArm','mixamorigLeftForeArm','mixamorigLeftHand','mixamorigRightArm','mixamorigRightForeArm','mixamorigRightHand','mixamorigLeftUpLeg','mixamorigLeftLeg','mixamorigLeftFoot','mixamorigRightUpLeg','mixamorigRightLeg','mixamorigRightFoot']) {
  const b = bones.find(x => x.name === name);
  if (b) { b.updateWorldMatrix(true,false); const p = b.getWorldPosition(new (b.position.constructor)()); console.log(`  ${name}: (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`); }
  else console.log(`  ${name}: NOT FOUND`);
}
// skinned mesh
let skinned = null;
obj.traverse(o => { if (o.isSkinnedMesh && !skinned) skinned = o; });
if (skinned) {
  console.log('skinned mesh:', skinned.name, 'verts:', skinned.geometry.attributes.position.count);
  const gbox = new Box3().setFromBufferAttribute(skinned.geometry.attributes.position);
  console.log('skinned geom bbox min:', gbox.min.toArray().map(v=>v.toFixed(3)));
  console.log('skinned geom bbox max:', gbox.max.toArray().map(v=>v.toFixed(3)));
}
