// walk/run 클립의 "자연 속도"를 재다.
//
// 이 GLB 는 Armature(루트)에 scale(0.00988)·X축 90도 회전이 박혀 있다.
// 그래서 Hips 의 world 위치 = Armature_R × (Armature_S × Hips_local_T).
// 1사이클 동안 world 수평(XZ, Y=up) 이동량을 잰 게 클립 원속도(V)다.
// 게임에서 실제 속도 S 로 움직이려면 rate = S / V 로 재생해야 발이 미끄러지지 않는다.
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
function readAcc(accIdx) {
  const acc = json.accessors[accIdx];
  const tv = json.bufferViews[acc.bufferView];
  const bo = (acc.byteOffset ?? 0) + (tv.byteOffset ?? 0);
  const nComp = acc.type === 'VEC3' ? 3 : acc.type === 'SCALAR' ? 1 : 4;
  return { arr: new Float32Array(bin.buffer, bin.byteOffset + bo, acc.count * nComp), nComp };
}
function clipDuration(anim) {
  let d = 0;
  for (const ch of anim.channels ?? []) {
    const times = readAcc(anim.samplers[ch.sampler].input).arr;
    if (times.length) d = Math.max(d, times[times.length - 1]);
  }
  return d;
}
function trackAt(anim, node, path, t) {
  const ch = anim.channels.find((c) => c.target.node === node && c.target.path === path);
  if (!ch) return null;
  const s = anim.samplers[ch.sampler];
  const times = readAcc(s.input).arr;
  const vals = readAcc(s.output).arr;
  const nComp = vals.length / times.length;
  let j = 0;
  while (j < times.length - 1 && times[j + 1] < t) j++;
  const t0 = times[j], t1 = times[Math.min(j + 1, times.length - 1)];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const a = vals.subarray(j * nComp, j * nComp + nComp);
  const b = vals.subarray(Math.min(j + 1, times.length - 1) * nComp, Math.min(j + 1, times.length - 1) * nComp);
  const r = new Array(nComp);
  for (let k = 0; k < nComp; k++) r[k] = a[k] + (b[k] - a[k]) * f;
  return r;
}

const root = json.scenes[0].nodes[0];
const hipsIdx = nodes.findIndex((n) => n.name === 'mixamorig:Hips');
const armScale = nodes[root].scale ?? [1, 1, 1];
// Armature 회전은 X축 90도 → (x,y,z) -> (x, -z, y). scale 은 균일.
function hipsWorld(anim, t) {
  const T = trackAt(anim, hipsIdx, 'translation', t) ?? nodes[hipsIdx].translation;
  const s = armScale[0]; // 균일 scale
  const lx = T[0] * s, ly = T[1] * s, lz = T[2] * s;
  return [lx, -lz, ly]; // RotX90
}

console.log('Armature scale', armScale.map(v => v.toFixed(5)));
for (const clipName of ['walk', 'run']) {
  const anim = json.animations.find((a) => a.name === clipName);
  if (!anim) { console.log(`${clipName}: 없음`); continue; }
  const dur = clipDuration(anim);
  const w0 = hipsWorld(anim, 0);
  const w1 = hipsWorld(anim, dur);
  const dx = w1[0] - w0[0], dy = w1[1] - w0[1], dz = w1[2] - w0[2];
  const horiz = Math.hypot(dx, dz);
  const V = horiz / dur;
  console.log(`\n=== ${clipName} (${dur.toFixed(2)}s) ===`);
  console.log(`world t0=(${w0.map(v => v.toFixed(3))}) t1=(${w1.map(v => v.toFixed(3))})`);
  console.log(`1사이클 수평 이동 ${horiz.toFixed(3)}m → 자연 속도 V = ${V.toFixed(3)} m/s`);
  for (const S of [2.275, 6.0, 6.5, 8.775, 9.3]) {
    console.log(`  ${S} m/s → rate ${(S / V).toFixed(2)}x`);
  }
}
