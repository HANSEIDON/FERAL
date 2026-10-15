// 디버깅: 같은 시점에서 GLB 뼈대 vs FBX 뼈대 의 세계행렬 비교
globalThis.self = globalThis;
globalThis.document = { createElementNS: () => ({ style: {} }) };
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
// 받은 원본이 있는 다운로드 폴더 — 다른 곳이면 FERAL_DOWNLOADS 로 바꾼다
const DOWNLOADS_DIR = process.env.FERAL_DOWNLOADS ?? `${homedir()}/Downloads`;

const MOTION = DOWNLOADS_DIR + '/모션';
const buf = fs.readFileSync(path.join(process.cwd(), 'public/models/hunter.glb'));
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
let mesh = null;
gltf.scene.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
const k = mesh.skeleton.bones[0] ? undefined : undefined;
let armature = null;
gltf.scene.traverse((o) => { if (o.name === 'Armature') armature = o; });
const scale = armature.scale.x;

const fbuf = fs.readFileSync(path.join(MOTION, 'Standing Run Forward.fbx'));
const fg = new FBXLoader().parse(fbuf.buffer.slice(fbuf.byteOffset, fbuf.byteOffset + fbuf.byteLength), '');
let fm = null; fg.traverse((o) => { if (o.isMesh) fm = o; });
fg.scale.setScalar(scale);
fg.updateMatrixWorld(true);
fm.skeleton.calculateInverses();

const t = 0.43;
const mixer = new THREE.AnimationMixer(gltf.scene);
mixer.clipAction(gltf.animations.find((a) => a.name === 'run')).play();
mixer.setTime(t);
gltf.scene.updateMatrixWorld(true);

const fmixer = new THREE.AnimationMixer(fg);
fmixer.clipAction(fg.animations[0]).play();
fmixer.setTime(t);
fg.updateMatrixWorld(true);

const gBones = new Map();
gltf.scene.traverse((o) => { if (o.isBone) gBones.set(o.name, o); });
const fBones = new Map();
fg.traverse((o) => { if (o.isBone) fBones.set(o.name, o); });

for (const name of ['mixamorigHips', 'mixamorigSpine', 'mixamorigHead', 'mixamorigLeftHand', 'mixamorigRightFoot']) {
  const g = gBones.get(name), f = fBones.get(name);
  if (!g || !f) { console.log(name, '누락', !!g, !!f); continue; }
  const gp = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld);
  const fp = new THREE.Vector3().setFromMatrixPosition(f.matrixWorld);
  console.log(`${name}: GLB=(${gp.x.toFixed(3)},${gp.y.toFixed(3)},${gp.z.toFixed(3)}) FBX=(${fp.x.toFixed(3)},${fp.y.toFixed(3)},${fp.z.toFixed(3)}) diff=${gp.distanceTo(fp).toFixed(4)}`);
}

// IBS 비교 (0번 뼈대)
const gi = mesh.skeleton.boneInverses[0];
const fi = fm.skeleton.boneInverses[0];
console.log('IBS[0] GLB :', gi.elements.slice(0, 4).map((n) => n.toFixed(3)).join(' '));
console.log('IBS[0] FBX :', fi.elements.slice(0, 4).map((n) => n.toFixed(3)).join(' '));
console.log('스케일 k =', scale);
