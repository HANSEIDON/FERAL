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
const nameIdx = Object.fromEntries(nodes.map((n, i) => [n.name, i]));
const anim = json.animations.find((a) => a.name === 'slam');
console.log('clips:', json.animations.map(a => a.name).join(', '));
console.log('hips idx:', nameIdx['mixamorig:Hips']);
console.log('root scene node:', json.scenes[0].nodes[0], 'name:', nodes[json.scenes[0].nodes[0]].name);
// which nodes are animated in slam, and by which paths
const paths = new Map();
for (const ch of anim.channels ?? []) {
  const nm = nodes[ch.target.node].name;
  const key = nm + ' :: ' + ch.target.path;
  if (!paths.has(key)) paths.set(key, 0);
  paths.set(key, paths.get(key) + 1);
}
console.log('\nanimated nodes in slam:');
for (const [k, v] of [...paths.entries()].sort()) console.log('  ', k, '(' + v + ' samplers)');
// print Hips translation track head
function readAcc(i){const a=json.accessors[i];const tv=json.bufferViews[a.bufferView];const bo=(a.byteOffset??0)+(tv.byteOffset??0);const nc=a.type==='VEC3'?3:a.type==='SCALAR'?1:4;return new Float32Array(bin.buffer,bin.byteOffset+bo,a.count*nc);}
for (const ch of anim.channels ?? []) {
  if (nodes[ch.target.node].name === 'mixamorig:Hips' && ch.target.path === 'translation') {
    const s = anim.samplers[ch.sampler];
    const times = readAcc(s.input), vals = readAcc(s.output);
    console.log('\nHips translation: count=', times.length);
    console.log('first 6 times:', [...times.slice(0,6)]);
    console.log('first 6 vals :', [...vals.slice(0,18)]);
    console.log('last 3 vals  :', [...vals.slice(-9)]);
  }
}
