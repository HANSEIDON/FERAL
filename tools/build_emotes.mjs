// 춤(비매너 이모트) — Mixamo FBX → 동작만 담은 GLB
//
//   node tools/build_emotes.mjs   →   public/models/emotes.glb
//
// 세 캐릭터(좀비 · 사냥꾼 · 총수) 모두 Mixamo 뼈대라 뼈 이름이 같다. 그래서 메시 없이
// 뼈 이름 노드 + 동작만 담아 두고, 게임에서 캐릭터마다 엉덩이 높이 비율만 맞춰 쓴다
// (src/game/emotes.js). 받은 FBX 는 "Without Skin" 이라 엉덩이 기준 높이가 95.4cm 다.
//
//   emote1  Head Spinning        헤드스핀 (0.83초 반복)
//   emote2  Snake Hip Hop Dance  힙합 (15.3초)
//   emote3  Flair                플레어 (1초 반복)
//   crawl   Low Crawl            쓰러진 생존자가 기어가기 (2.33초 반복, 제자리로 바꿔 둠)
//   dying   Dying                죽을 때 (6.8초, 한 번 — 끝 자세로 누워 있는다)
//   cpr_get / cpr_give  Receiving · Administering Cpr — 한 장면에서 같이 찍은 짝 동작이다.
//           둘 다 살려지는 사람의 엉덩이가 원점에 오게 같은 만큼 옮겨 둔다 → 게임에서 두 몸의
//           원점을 같은 자리 · 같은 방향에 두면 살리는 사람이 정확히 옆에 무릎 꿇고 앉는다.

globalThis.self = globalThis;   // FBXLoader 가 쓰는 브라우저 전역
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
import path from 'node:path';

const DL = 'C:/Users/haki0/Downloads';
const EMOTES = [
  ['emote1', 'Head Spinning'],
  ['emote2', 'Snake Hip Hop Dance'],
  ['emote3', 'Flair'],
  ['crawl', 'Low Crawl', { inPlace: true }],
  ['dying', 'Dying'],
  ['cpr_get', 'Receiving Cpr', { pairOrigin: true }],
  ['cpr_give', 'Administering Cpr', { pairShift: true }],
];
let pairOff = null;   // 살려지는 사람 엉덩이의 첫 수평 위치 (cm) — 두 CPR 동작에서 같이 뺀다
const OUT = path.join(process.cwd(), 'public/models/emotes.glb');
THREE.TextureLoader.prototype.load = () => new THREE.Texture();

// 받은 FBX 를 지웠으면 이미 만든 emotes.glb 에서 그 동작을 그대로 가져온다 (한 번 손본 값 그대로)
function readOld() {
  if (!fs.existsSync(OUT)) return { clips: new Map(), extras: {} };
  const b = fs.readFileSync(OUT), len = b.readUInt32LE(12);
  const j = JSON.parse(b.slice(20, 20 + len)), bin = b.slice(20 + len + 8);
  const acc = (i) => { const a = j.accessors[i], v = j.bufferViews[a.bufferView], n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
    return new Float32Array(bin.buffer.slice(bin.byteOffset + v.byteOffset, bin.byteOffset + v.byteOffset + a.count * n * 4)); };
  const clips = new Map();
  for (const an of j.animations) {
    const tracks = an.channels.map((c) => ({
      name: `${j.nodes[c.target.node].name}.${c.target.path === 'translation' ? 'position' : 'quaternion'}`,
      times: acc(an.samplers[c.sampler].input), values: acc(an.samplers[c.sampler].output),
    }));
    clips.set(an.name, { name: an.name, tracks, duration: Math.max(...tracks.map((t) => t.times[t.times.length - 1])) });
  }
  return { clips, extras: j.extras ?? {} };
}
const old = readOld();

const clips = [];
let hipsRest = old.extras.hipsRest ?? null, legLen = old.extras.legLen ?? null, crawlSpeed = old.extras.crawlSpeed ?? null;
for (const [name, file, opt] of EMOTES) {
  if (!fs.existsSync(`${DL}/${file}.fbx`)) {
    const c = old.clips.get(name);
    if (!c) throw new Error(`${file}.fbx 도 없고 예전 emotes.glb 에도 ${name} 이 없다`);
    clips.push(c);
    console.log(`${name}: 예전 emotes.glb 에서 · ${c.duration.toFixed(2)}초`);
    continue;
  }
  const buf = fs.readFileSync(`${DL}/${file}.fbx`);
  const g = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  g.traverse((o) => { if (o.isBone && /Hips$/.test(o.name)) hipsRest ??= o.position.y; });
  // 다리 길이(허벅지 + 정강이) — 게임에서 캐릭터마다 크기 비율을 이걸로 잰다
  legLen ??= g.getObjectByName('mixamorigLeftLeg').position.length() + g.getObjectByName('mixamorigLeftFoot').position.length();
  const c = g.animations[0];
  // 엉덩이만 위치가 움직인다. 나머지 뼈 위치 · 크기 트랙은 버린다 (캐릭터마다 뼈 길이가 달라
  // 남의 뼈 길이를 덮어쓰면 팔다리가 늘어난다)
  c.tracks = c.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === 'mixamorigHips.position');
  c.name = name;
  if (opt?.inPlace) {
    // 엉덩이가 앞(+Z)으로 나아가는 만큼을 빼서 제자리 반복 동작으로. 이동은 게임이 맡고,
    // 원래 나아가던 속도(cm/초)는 남겨 둬서 재생 속도를 실제 이동 속도에 맞춘다.
    const t = c.tracks.find((tr) => tr.name === 'mixamorigHips.position');
    const v = t.values, n = t.times.length, dz = v[n * 3 - 1] - v[2];
    for (let i = 0; i < n; i++) v[i * 3 + 2] -= (t.times[i] / c.duration) * dz;
    crawlSpeed = dz / c.duration;
  }
  if (opt?.pairOrigin || opt?.pairShift) {
    const t = c.tracks.find((tr) => tr.name === 'mixamorigHips.position');
    if (opt.pairOrigin) pairOff = [t.values[0], t.values[2]];
    for (let i = 0; i < t.values.length; i += 3) { t.values[i] -= pairOff[0]; t.values[i + 2] -= pairOff[1]; }
  }
  clips.push(c);
  console.log(`${name}: ${file} · ${c.duration.toFixed(2)}초 · 트랙 ${c.tracks.length}`);
}

// ── GLB: 뼈 이름 노드(위계 없음) + 동작 ──
const nodeNames = [...new Set(clips.flatMap((c) => c.tracks.map((t) => t.name.split('.')[0])))];
const json = {
  asset: { version: '2.0', generator: 'zombie-fps tools/build_emotes.mjs' },
  scene: 0, scenes: [{ nodes: nodeNames.map((_, i) => i) }],
  nodes: nodeNames.map((name) => ({ name })),
  animations: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
  extras: { hipsRest, legLen, crawlSpeed },
};
const chunks = [];
let cursor = 0;
const accessor = (arr, type) => {
  const f = Float32Array.from(arr);
  const bytes = Buffer.from(f.buffer);
  chunks.push(bytes);
  json.bufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: bytes.length });
  cursor += bytes.length;
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const acc = { bufferView: json.bufferViews.length - 1, componentType: 5126, count: f.length / n, type };
  if (type === 'SCALAR') { acc.min = [Math.min(...f)]; acc.max = [Math.max(...f)]; }
  json.accessors.push(acc);
  return json.accessors.length - 1;
};
for (const c of clips) {
  const anim = { name: c.name, samplers: [], channels: [] };
  for (const t of c.tracks) {
    const [node, prop] = t.name.split('.');
    anim.samplers.push({ input: accessor(t.times, 'SCALAR'), output: accessor(t.values, prop === 'position' ? 'VEC3' : 'VEC4'), interpolation: 'LINEAR' });
    anim.channels.push({ sampler: anim.samplers.length - 1, target: { node: nodeNames.indexOf(node), path: prop === 'position' ? 'translation' : 'rotation' } });
  }
  json.animations.push(anim);
}
json.buffers[0].byteLength = cursor;
const pad4 = (n) => (4 - (n % 4)) % 4;
const jsonStr = JSON.stringify(json);
const jsonBytes = Buffer.from(jsonStr + ' '.repeat(pad4(Buffer.byteLength(jsonStr))));
const bin = Buffer.concat([...chunks, Buffer.alloc(pad4(cursor))]);
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
const ch = (len, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.writeUInt32LE(type, 4); return h; };
fs.writeFileSync(OUT, Buffer.concat([head, ch(jsonBytes.length, 0x4e4f534a), jsonBytes, ch(bin.length, 0x004e4942), bin]));
console.log(`✅ ${OUT} — ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB · 엉덩이 기준 높이 ${hipsRest.toFixed(1)} · 다리 길이 ${legLen.toFixed(1)}`);
