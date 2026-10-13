// FBX 의 실제 scale/변환 값을 재서 IBS 를 올바르게 계산
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';

const buf = fs.readFileSync('C:/Users/haki0/Downloads/모션/Standing Idle 01.fbx');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const group = new FBXLoader().parse(ab, '');

let mesh = null, hips = null;
group.traverse(o => {
  if (o.isMesh && !mesh) mesh = o;
  if (o.isBone && o.name === 'mixamorigHips') hips = o;
});

console.log('group (Armature) name:', group.name, 'type:', group.type);
console.log('group.scale:', group.scale.toArray());
console.log('group.position:', group.position.toArray());
console.log('group.matrixWorld (before update):', group.matrixWorld.toArray().map(v=>+v.toFixed(5)));

// mesh 의 local transform
console.log('\nmesh.name:', mesh.name);
console.log('mesh.scale:', mesh.scale.toArray());
console.log('mesh.position:', mesh.position.toArray());
console.log('mesh.matrix:', mesh.matrix.toArray().map(v=>+v.toFixed(5)));

// local position bbox
const pos = mesh.geometry.attributes.position;
const bb = new THREE.Box3().setFromBufferAttribute(pos);
console.log('\nmesh LOCAL bbox:', bb.min.toArray().map(v=>+v.toFixed(3)), '->', bb.max.toArray().map(v=>+v.toFixed(3)));
console.log('mesh LOCAL height:', (bb.max.y-bb.min.y).toFixed(4));

group.updateMatrixWorld(true);
console.log('\n--- after updateMatrixWorld ---');
console.log('group.matrixWorld:', group.matrixWorld.toArray().map(v=>+v.toFixed(5)));
console.log('mesh.matrixWorld:', mesh.matrixWorld.toArray().map(v=>+v.toFixed(5)));
console.log('hips.name:', hips.name);
console.log('hips.parent:', hips.parent?.name || hips.parent?.type);
console.log('hips.position (local):', hips.position.toArray().map(v=>+v.toFixed(4)));
console.log('hips.matrixWorld:', hips.matrixWorld.toArray().map(v=>+v.toFixed(5)));

// skeleton.bones[0] 이 누구인지
const sk = mesh.skeleton;
console.log('\nsk.bones[0]:', sk.bones[0].name);
console.log('sk.bones[0].parent:', sk.bones[0].parent?.name || sk.bones[0].parent?.type);
// hips 의 sk.bones 안 인덱스
const hipsIdx = sk.bones.findIndex(b => b === hips);
console.log('hips index in sk.bones:', hipsIdx);

// skinIndex 가 가리키는 bone 확인 (첫 vertex)
const si = mesh.geometry.attributes.skinIndex.array;
const sw = mesh.geometry.attributes.skinWeight.array;
console.log('\nvertex0 skinIndex:', Array.from(si.slice(0,4)), 'weights:', Array.from(sw.slice(0,4)).map(w=>+w.toFixed(3)));
console.log('vertex0 bones:', Array.from(si.slice(0,4)).map(i=>sk.bones[i]?.name));
