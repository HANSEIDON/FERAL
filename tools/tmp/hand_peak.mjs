// 클립별 손끝 전방 위치 시계열 + 이동량(시작 대비). 어느 손이 펀치하는지 확인용.
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
function readAcc(a) {
  const acc = json.accessors[a];
  const tv = json.bufferViews[acc.bufferView];
  const bo = (acc.byteOffset ?? 0) + (tv.byteOffset ?? 0);
  const nc = acc.type === 'VEC3' ? 3 : acc.type === 'SCALAR' ? 1 : 4;
  return { arr: new Float32Array(bin.buffer, bin.byteOffset + bo, acc.count * nc), nComp: nc };
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
  let pos = n.translation ?? [0,0,0], rot = n.rotation ?? [0,0,0,1], scl = n.scale ?? [1,1,1];
  const e = tr.get(i);
  if (e) {
    const pick = (track) => {
      const { times, vals, nComp } = track;
      let j = 0;
      while (j < times.length - 1 && times[j+1] < t) j++;
      const t0 = times[j], t1 = times[Math.min(j+1, times.length-1)];
      const f = t1 > t0 ? (t - t0)/(t1 - t0) : 0;
      const a = vals.subarray(j*nComp, j*nComp+nComp);
      const b = vals.subarray(Math.min(j+1, times.length-1)*nComp, (Math.min(j+1, times.length-1)+1)*nComp);
      const r = new Array(nComp);
      for (let k=0;k<nComp;k++) r[k] = a[k] + (b[k]-a[k])*f;
      if (nComp===4){ const d=Math.hypot(...r); for(let k=0;k<4;k++) r[k]/=d; }
      return r;
    };
    if (e.translation) pos = pick(e.translation);
    if (e.rotation) rot = pick(e.rotation);
    if (e.scale) scl = pick(e.scale);
  }
  const [x,y,z]=pos,[sx,sy,sz]=scl,[ix,iy,iz,iw]=rot;
  const x2=ix+ix,y2=iy+iy,z2=iz+iz;
  const xx=ix*x2,xy=iy*x2,xz=iz*x2,yy=iy*y2,yz=iz*y2,zz=iz*z2;
  const xw=iw*x2,yw=iw*y2,zw=iw*z2;
  const m=[(1-(yy+zz))*sx,(xy-zw)*sx,(xz+yw)*sx,0,(xy+zw)*sy,(1-(xx+zz))*sy,(yz-xw)*sy,0,(xz-yw)*sz,(yz+xw)*sz,(1-(xx+yy))*sz,0,x,y,z,1];
  for (let k=0;k<16;k++) out[k]=m[k];
}
function worldPos(tr, root, i, t, cache) {
  if (cache.has(i)) return cache.get(i);
  const m = new Array(16); evalNode(tr,i,t,m);
  let w = m; let p = parent[i]; const chain=[i];
  while (p !== root && p >= 0) { chain.push(p); p = parent[p]; }
  for (let k=chain.length-1;k>0;k--) {
    const pm = new Array(16); evalNode(tr,chain[k],t,pm);
    const r = new Array(16);
    for (let c=0;c<4;c++) for (let row=0;row<4;row++){ let s=0; for(let k2=0;k2<4;k2++) s+=pm[c*4+k2]*w[k2*4+row]; r[c*4+row]=s; }
    w = r;
  }
  cache.set(i,w); return w;
}
const root = json.scenes[0].nodes[0];
const nameIdx = Object.fromEntries(nodes.map((n,i)=>[n.name,i]));
const hands = ['mixamorig:RightHandIndex4','mixamorig:LeftHandIndex4']
  .map(n=>[n.replace('mixamorig:',''), nameIdx[n]]).filter(([,i])=>i!==undefined);
for (const clipName of ['attack','attack2']) {
  const anim = json.animations.find(a=>a.name===clipName);
  const tr = buildTracks(anim);
  const times = new Set();
  tr.forEach(e => e.translation && e.translation.times.forEach(t=>times.add(t)));
  const allT = [...times].sort((a,b)=>a-b);
  const dur = allT.at(-1);
  const series = {};
  for (const [label] of hands) series[label] = [];
  for (const t of allT) {
    const cache = new Map();
    for (const [label, i] of hands) {
      const w = worldPos(tr, root, i, t, cache);
      series[label].push([t, w[13]]);
    }
  }
  console.log(`\n=== ${clipName} (길이 ${dur.toFixed(2)}s) ===`);
  console.log('t(s)      ' + hands.map(([l]) => l.padEnd(16)).join(''));
  for (let i = 0; i < allT.length; i++) {
    const row = hands.map(([l]) => `${series[l][i][1].toFixed(1)}`.padEnd(16));
    console.log(allT[i].toFixed(3).padEnd(9) + row.join(''));
  }
  for (const [label] of hands) {
    const s = series[label];
    const start = s[0][1];
    let peak = { z: -Infinity, t: 0 };
    for (const [t, z] of s) if (z > peak.z) peak = { z, t };
    console.log(`  ${label}: 시작 ${start.toFixed(1)} → 피크 ${peak.z.toFixed(1)} (이동 +${(peak.z-start).toFixed(1)}cm) @ ${peak.t.toFixed(3)}s (${(peak.t/dur*100).toFixed(0)}%)`);
  }
}
