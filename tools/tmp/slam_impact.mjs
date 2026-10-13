// slam (jump attack) 클립에서 "내려찍는 임팩트" 시점을 찾는다.
// Hips Y(몸 높이)와 손끝 Y 를 시계열로 뽑아, 점프 후 가장 낮아지는 순간을 임팩트로 본다.
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
  const byteOffset = (acc.byteOffset ?? 0) + (tv.byteOffset ?? 0);
  const nComp = acc.type === 'VEC3' ? 3 : acc.type === 'SCALAR' ? 1 : 4;
  return { arr: new Float32Array(bin.buffer, bin.byteOffset + byteOffset, acc.count * nComp), nComp };
}

function buildTracks(anim) {
  const tr = new Map();
  for (const ch of anim.channels ?? []) {
    const { node, path } = ch.target;
    const s = anim.samplers[ch.sampler];
    const times = readAcc(s.input).arr;
    const vals = readAcc(s.output);
    if (!tr.has(node)) tr.set(node, {});
    tr.get(node)[path] = { times, vals: vals.arr, nComp: vals.nComp };
  }
  return tr;
}

function evalNode(tr, i, t, out) {
  const n = nodes[i];
  let pos = n.translation ?? [0, 0, 0];
  let rot = n.rotation ?? [0, 0, 0, 1];
  let scl = n.scale ?? [1, 1, 1];
  const e = tr.get(i);
  if (e) {
    const pick = (track) => {
      const { times, vals, nComp } = track;
      let j = 0;
      while (j < times.length - 1 && times[j + 1] < t) j++;
      const t0 = times[j], t1 = times[Math.min(j + 1, times.length - 1)];
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      const a = vals.subarray(j * nComp, j * nComp + nComp);
      const b = vals.subarray(Math.min(j + 1, times.length - 1) * nComp, Math.min(j + 1, times.length - 1) * nComp);
      const r = new Array(nComp);
      for (let k = 0; k < nComp; k++) r[k] = a[k] + (b[k] - a[k]) * f;
      if (nComp === 4) { const d = Math.hypot(...r); for (let k = 0; k < 4; k++) r[k] /= d; }
      return r;
    };
    if (e.translation) pos = pick(e.translation);
    if (e.rotation) rot = pick(e.rotation);
    if (e.scale) scl = pick(e.scale);
  }
  const [x, y, z] = pos, [sx, sy, sz] = scl;
  const [ix, iy, iz, iw] = rot;
  const x2 = ix + ix, y2 = iy + iy, z2 = iz + iz;
  const xx = ix * x2, xy = iy * x2, xz = iz * x2;
  const yy = iy * y2, yz = iz * y2, zz = iz * z2;
  const xw = iw * x2, yw = iw * y2, zw = iw * z2;
  const m = [
    (1 - (yy + zz)) * sx, (xy - zw) * sx, (xz + yw) * sx, 0,
    (xy + zw) * sy, (1 - (xx + zz)) * sy, (yz - xw) * sy, 0,
    (xz - yw) * sz, (yz + xw) * sz, (1 - (xx + yy)) * sz, 0,
    x, y, z, 1,
  ];
  for (let k = 0; k < 16; k++) out[k] = m[k];
}

function worldPos(tr, root, i, t, cache) {
  if (cache.has(i)) return cache.get(i);
  const m = new Array(16);
  evalNode(tr, i, t, m);
  let w = m;
  let p = parent[i];
  const chain = [i];
  while (p !== root && p >= 0) { chain.push(p); p = parent[p]; }
  for (let k = chain.length - 1; k >= 0; k--) {
    if (k === 0) continue;
    const pm = new Array(16);
    evalNode(tr, chain[k], t, pm);
    const r = new Array(16);
    for (let c = 0; c < 4; c++)
      for (let row = 0; row < 4; row++) {
        let s = 0;
        for (let k2 = 0; k2 < 4; k2++) s += pm[c * 4 + k2] * w[k2 * 4 + row];
        r[c * 4 + row] = s;
      }
    w = r;
  }
  cache.set(i, w);
  return w;
}

const root = json.scenes[0].nodes[0];
const nameIdx = Object.fromEntries(nodes.map((n, i) => [n.name, i]));
const hips = nameIdx['mixamorig:Hips'];
const hands = ['mixamorig:RightHand', 'mixamorig:LeftHand']
  .map((n) => [n, nameIdx[n]]).filter(([, i]) => i !== undefined);

const anim = json.animations.find((a) => a.name === 'slam');
if (!anim) { console.log('slam 클립을 찾을 수 없음'); process.exit(1); }
const tr = buildTracks(anim);
const times = [];
tr.forEach((e) => e.translation && times.push(...e.translation.times));
const allT = [...new Set(times)].sort((a, b) => a - b);
const dur = allT.at(-1);

console.log(`slam 클립: ${allT.length}개 키프레임, 0~${dur.toFixed(3)}s\n`);
console.log('t(s)    hipsY      RHandY     LHandY');
let minHips = { t: 0, y: Infinity };
let minHand = { t: 0, y: Infinity };
let maxHips = { t: 0, y: -Infinity };
for (const t of allT) {
  const cache = new Map();
  const hy = worldPos(tr, root, hips, t, cache)[13];
  let handY = Infinity;
  for (const [n, i] of hands) handY = Math.min(handY, worldPos(tr, root, i, t, cache)[13]);
  if (hy < minHips.y) minHips = { t, y: hy };
  if (hy > maxHips.y) maxHips = { t, y: hy };
  if (handY < minHand.y) minHand = { t, y: handY };
  console.log(t.toFixed(3).padEnd(7) + hy.toFixed(3).padEnd(10) + handY.toFixed(3).padEnd(12) + handY.toFixed(3).padEnd(12));
}
console.log(`\n>> hips 최고점(점프 꼭대기): t=${maxHips.t.toFixed(3)}s (${(maxHips.t / dur * 100).toFixed(0)}%)`);
console.log(`>> hips 최저점(착지 압축):   t=${minHips.t.toFixed(3)}s (${(minHips.t / dur * 100).toFixed(0)}%)`);
console.log(`>> 손끝 최저점(내려찍기):    t=${minHand.t.toFixed(3)}s (${(minHand.t / dur * 100).toFixed(0)}%)`);
