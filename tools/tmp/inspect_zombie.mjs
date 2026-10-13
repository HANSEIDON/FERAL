// zombie.glb (게임에서 동작하는 모델) 의 구조를 참고용으로 파싱
import fs from 'node:fs';
const buf = fs.readFileSync('public/models/zombie.glb');
const chunkLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + chunkLen).toString('utf8'));

console.log('=== zombie.glb 구조 ===');
console.log('scenes:', JSON.stringify(json.scenes));
console.log('nodes:', json.nodes.length);
console.log('skins:', json.skins.length);
console.log('animations:', json.animations.length);
console.log('meshes:', json.meshes.length);
console.log('materials:', json.materials.length);
console.log('images:', json.images.length, 'textures:', json.textures.length);
console.log('buffers:', json.buffers.map(b=>`${b.byteLength}b`));
console.log('bufferViews:', json.bufferViews.length, 'accessors:', json.accessors.length);

// 루트 노드 (scene 이 가리키는 노드)
const rootIdx = json.scenes[0].nodes;
console.log('\n--- scene root nodes:', rootIdx);
for (const i of rootIdx) {
  const n = json.nodes[i];
  console.log(`node[${i}] name=${n.name} mesh=${n.mesh} skins=${n.skins} children=${n.children} translation=${n.translation} scale=${n.scale}`);
}

// skin 구조
for (const s of json.skins) {
  console.log('\n--- skin:', 'joints.length=', s.joints.length, 'skeleton=', s.skeleton, 'inverseBindMatrices accessor=', s.inverseBindMatrices);
  console.log('  first 5 joints (node idx):', s.joints.slice(0,5));
  // 그 노드 이름
  console.log('  first 5 joint names:', s.joints.slice(0,5).map(j=>json.nodes[j].name));
}

// mesh primitive
const m0 = json.meshes[0];
console.log('\n--- mesh[0] primitives:', m0.primitives.length);
for (const p of m0.primitives) {
  console.log('  attrs:', Object.keys(p.attributes), 'targets:', p.targets?.length, 'material:', p.material, 'mode:', p.mode);
}

// bone 계층 일부 (root bone 의 children)
if (json.skins[0]) {
  const rootJoint = json.skins[0].joints[0];
  console.log('\n--- root joint node:', json.nodes[rootJoint].name, 'children:', json.nodes[rootJoint].children);
}

// animations
for (const a of json.animations) {
  console.log(`\n--- anim: ${a.name} channels=${a.channels.length} samplers=${a.samplers.length}`);
  if (a.channels[0]) console.log('  ch0 target node=', a.channels[0].target.node, 'path=', a.channels[0].target.path, 'sampler=', a.channels[0].sampler);
}
