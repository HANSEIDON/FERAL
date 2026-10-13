import { readFileSync } from 'node:fs';
const buf = readFileSync(new URL('../../public/models/zombie.glb', import.meta.url));
let off = 12, json = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4E4F534A) json = JSON.parse(data.toString('utf8'));
  if (type === 0x004E4942) bin = data;
  off += 8 + len;
}
const nodes = json.nodes;
const parent = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => (parent[c] = i)));
function readAcc(accIdx) {
  const acc = json.accessors[accIdx];
  const tv = json.bufferViews[acc.bufferView];
  const bo = (acc.byteOffset ?? 0) + (tv.byteOffset ?? 0);
  const nComp = acc.type === 'VEC3' ? 3 : acc.type === 'SCALAR' ? 1 : 4;
  return { arr: new Float32Array(bin.buffer, bin.byteOffset + bo, acc.count * nComp), nComp };
}
const walk = json.animations.find((a) => a.name === 'walk');
const hipsIdx = nodes.findIndex((n) => n.name === 'mixamorig:Hips');
const root = json.scenes[0].nodes[0];
// Hips translation track at t=0
const ch = walk.channels.find((c) => c.target.node === hipsIdx && c.target.path === 'translation');
const s = walk.samplers[ch.sampler];
const times = readAcc(s.input).arr;
const vals = readAcc(s.output).arr;
console.log('Hips trans track: times[0..2]', [...times.slice(0,3)], 'vals[0..2]', [...vals.slice(0,3)]);
console.log('Hips static trans', JSON.stringify(nodes[hipsIdx].translation));
console.log('Hips static rot', JSON.stringify(nodes[hipsIdx].rotation));
// Armature
console.log('Armature', root, 'scale', JSON.stringify(nodes[root].scale), 'rot', JSON.stringify(nodes[root].rotation), 'trans', JSON.stringify(nodes[root].translation));
// check if Armature has animated tracks in walk
const armChs = walk.channels.filter((c) => c.target.node === root);
console.log('Armature animated channels in walk:', armChs.length, armChs.map(c => c.target.path));
// check Hips rotation track
const chR = walk.channels.find((c) => c.target.node === hipsIdx && c.target.path === 'rotation');
if (chR) {
  const sR = walk.samplers[chR.sampler];
  const tR = readAcc(sR.input).arr;
  const vR = readAcc(sR.output).arr;
  console.log('Hips rot track first quat', [...vR.slice(0,4)], 'norm', Math.hypot(...vR.slice(0,4)));
}
