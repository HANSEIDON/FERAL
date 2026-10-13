// 춤(이모트) — Ctrl+1 · 2 · 3. 세 캐릭터 공통 동작 (tools/build_emotes.mjs → emotes.glb).
//
// 동작은 Mixamo 기본 뼈대(Y 위, cm) 기준이다. 캐릭터마다 두 가지를 맞춘 사본을 만들어 둔다:
//   크기 — 엉덩이 위치 트랙을 다리 길이 비율로 늘이거나 줄인다 (단위 · 키가 다 다르다)
//   축   — 엉덩이 바로 위 노드(Armature)가 돌아가 있으면 엉덩이 트랙을 그만큼 되돌린다.
//          좀비는 Blender 에서 만들어 Armature 가 90° 눕혀져 있다 — 안 돌리면 바닥에 눕는다.
// 엉덩이 아래 뼈들의 회전은 그대로 쓴다 — 셋 다 Mixamo 자동 리깅이라 뼈 방향이 같다.

import { Quaternion, Vector3 } from 'three';
import { ASSET_BASE, loadModel } from '../core/assets.js';

export const EMOTE_COUNT = 3;
let source = null;              // { clips: Map(name → clip), legLen, crawlSpeed }
const fitted = new Map();       // `${name}@${배율}@${축}` → clip

export function loadEmotes() {
  return loadModel(`${ASSET_BASE}models/emotes.glb`).then((g) => {
    source = {
      clips: new Map(g.animations.map((c) => [c.name, c])),
      legLen: g.parser.json.extras?.legLen ?? 77.7,
      crawlSpeed: g.parser.json.extras?.crawlSpeed ?? 61.6,
    };
  }).catch((e) => console.warn('[emote] 춤 동작을 못 받았습니다', e));
}

const _v = new Vector3(), _q = new Quaternion();

/** n 번 춤을 이 아바타(뼈대 루트)에 맞춘 클립. 아직 못 받았으면 null. */
export function emoteClip(n, root) { return motionClip(`emote${n}`, root); }

/**
 * 쓰러진 생존자 기어가기(Low Crawl) 클립과, 1배속일 때 이 아바타가 나아가는 속도(m/s).
 * 원본은 Mixamo 기본 키 기준 0.62m/s — 다리 길이 비율만큼 달라진다.
 */
export function crawlClip(root) {
  const clip = motionClip('crawl', root);
  if (!clip) return null;
  return { clip, speed: (source.crawlSpeed / 100) * legRatio(root) };
}

/** 엉덩이 아래 다리 길이 비율 (아바타 크기 ÷ 원본). 아바타 바깥 크기(m)까지 곱한다. */
function legRatio(root) {
  const leg = root.getObjectByName('mixamorigLeftLeg'), foot = root.getObjectByName('mixamorigLeftFoot');
  const hips = root.getObjectByName('mixamorigHips');
  const local = (leg.position.length() + foot.position.length()) / source.legLen;
  // 세계 크기 — 원본은 cm 이고 아바타 엉덩이 위 노드들의 크기가 단위를 바꾼다
  const s = new Vector3();
  hips.parent.getWorldScale(s);
  const r = new Vector3();
  root.getWorldScale(r);
  return (local * s.x * 100) / r.x;
}

/** 이름(emotes.glb 의 동작)으로 이 아바타에 맞춘 클립 — dying · cpr_get · cpr_give 등 */
export function motionClip(name, root) {
  const base = source?.clips.get(name);
  const hips = root.getObjectByName('mixamorigHips');
  const leg = root.getObjectByName('mixamorigLeftLeg'), foot = root.getObjectByName('mixamorigLeftFoot');
  if (!base || !hips || !leg || !foot) return null;
  const k = (leg.position.length() + foot.position.length()) / source.legLen;
  const fix = hips.parent.quaternion.clone().invert();
  const key = `${base.name}@${k.toFixed(4)}@${fix.toArray().map((v) => v.toFixed(3)).join(',')}`;
  if (!fitted.has(key)) {
    const c = base.clone();
    for (const t of c.tracks) {
      if (t.name === 'mixamorigHips.position') {
        const v = t.values;
        for (let i = 0; i < v.length; i += 3) _v.fromArray(v, i).applyQuaternion(fix).multiplyScalar(k).toArray(v, i);
      } else if (t.name === 'mixamorigHips.quaternion') {
        const v = t.values;
        for (let i = 0; i < v.length; i += 4) _q.fromArray(v, i).premultiply(fix).toArray(v, i);
      }
    }
    fitted.set(key, c);
  }
  return fitted.get(key);
}
