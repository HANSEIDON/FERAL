// 전투 — 무기 상태와 명중 판정.
//
// 명중은 쏜 사람 브라우저가 판정해서 서버에 보고한다. 서버는 사거리와
// 데미지 상한만 확인한다 (server/index.js 의 applyHit). 친구끼리 하는
// 게임이라 이 정도가 적당하고, 지연 없이 즉각 반응하는 게 더 중요하다.
//
// 수치는 전부 loadout.weapon 에서 읽는다 — 직업이 바뀌면 무기가 따라온다.

import { Ray, Sphere, Vector3 } from 'three';
import { BASE } from '../../shared/config.js';
import { SWAP_SEC } from '../../shared/loadout.js';
import { lineBlocked } from './world.js';

/**
 * 히트박스: 머리 · 가슴 · 배 · 다리 구 넷. 아바타 뼈대(Mixamo)의 지금 위치를 따라간다 —
 * 좀비는 거북목이라 머리가 몸 앞쪽 아래에 있고, 돌진 · 광폭화 · 쓰러짐 동작마다 자세가
 * 크게 바뀐다. 발 위 고정 높이에 구를 두던 예전 방식은 그 차이만큼 헤드샷이 빗나갔다.
 * 뼈대가 없는 아바타(모델 로딩 전 캡슐)는 예전 고정 높이 구 둘로 대신한다.
 */
export const HEAD_MUL = 2.0;

const BONES = { head: 'Head', top: 'HeadTop_End', neck: 'Neck', chest: 'Spine2', spine: 'Spine', hips: 'Hips' };
const _a = new Vector3(), _b = new Vector3(), _c = new Vector3();

/** 아바타에서 판정용 뼈를 찾아 둔다 (이름 앞 'mixamorig' · 'mixamorig:' 는 모델마다 다르다). */
function hitBones(avatar) {
  if (avatar.userData.hitBones !== undefined) return avatar.userData.hitBones;
  const found = {};
  avatar.traverse((o) => {
    if (!o.isBone) return;
    const n = o.name.replace(/^mixamorig:?/, '');
    for (const [k, v] of Object.entries(BONES)) if (n === v) found[k] = o;
  });
  const ok = found.head && found.neck && found.chest && found.hips;
  return (avatar.userData.hitBones = ok ? found : null);
}

/** 뼈 위치로 만든 구 (세계 좌표 중심). 머리부터 — 겹치면 헤드샷이 이긴다. */
function boneHitboxes(role, avatar) {
  const k = hitBones(avatar);
  if (!k) return null;
  const r = (BASE[role] ?? BASE.survivor).radius;
  const head = k.head.getWorldPosition(new Vector3());
  const neck = k.neck.getWorldPosition(_a);
  // 머리 가운데 — 정수리 끝 뼈가 있으면 둘의 중간, 없으면 목→머리 방향으로 그만큼 더
  const center = k.top ? k.top.getWorldPosition(_b).add(head).multiplyScalar(0.5)
    : _b.subVectors(head, neck).multiplyScalar(0.9).add(head);
  const headR = Math.max(0.12, center.distanceTo(head) * 1.35);
  const chest = k.chest.getWorldPosition(new Vector3());
  const hips = k.hips.getWorldPosition(new Vector3());
  const belly = (k.spine ? k.spine.getWorldPosition(_c) : _c.lerpVectors(hips, chest, 0.5)).clone();
  const legs = new Vector3(hips.x, avatar.position.y + (hips.y - avatar.position.y) * 0.5, hips.z);
  return [
    { c: center.clone(), r: headR, head: true },
    { c: chest, r: r * (role === 'zombie' ? 1.15 : 1.0), head: false },   // 좀비는 어깨가 넓다
    { c: belly, r: r * 1.0, head: false },
    { c: legs, r: r * 0.85, head: false },
  ];
}

/** 대상의 히트박스 — 뼈대가 있으면 뼈 위치, 없으면 발 기준 고정 높이 */
function partsOf(tgt, low) {
  if (!low && tgt.avatar) {
    const bone = boneHitboxes(tgt.role, tgt.avatar);
    if (bone) return bone;
  }
  return hitboxes(tgt.role, low).map((p) => ({ c: new Vector3(tgt.pos.x, tgt.pos.y + p.y, tgt.pos.z), r: p.r, head: p.head }));
}

/**
 * @param low  잽(오른손) 판정. 잽은 아래에서 주먹이 위로 올라가므로
 *             타격점이 스윙보다 낮다 — 히트박스를 통째로 아래로 내린다.
 */
function hitboxes(role, low = false) {
  const b = BASE[role] ?? BASE.survivor;
  const h = b.height;
  if (low) {
    return [
      { y: h * 0.58, r: b.radius * 0.55, head: true },    // 턱·목
      { y: h * 0.36, r: b.radius * 1.2, head: false },    // 몸통
    ];
  }
  return [
    { y: h * 0.75, r: b.radius * 0.52, head: true },    // 머리
    { y: h * 0.45, r: b.radius * 1.15, head: false },   // 몸통
  ];
}


export class Weapon {
  constructor() {
    this.spec = null;
    this.ammo = 0;
    this.reloading = false;
    this.reloadEnd = 0;
    this.nextShot = 0;

    /** 슬롯별 상태. 무기를 바꿔도 탄약이 각자 남아 있어야 한다. */
    this.slots = [];
    this.index = 0;
  }

  /** 로드아웃의 무기 전부를 슬롯에 넣고 1번을 든다. */
  equipAll(list) {
    this.slots = list.map((spec) => ({
      spec,
      id: spec.id,   // 탄약상자 종류(권총/소총)를 슬롯에 매칭할 때 쓴다
      ammo: Number.isFinite(spec.mag) ? spec.mag : Infinity,
      // 보급탄 — 탄약상자를 주워 채운다. 시작은 탄창 2개 분량.
      reserve: Number.isFinite(spec.mag) ? spec.mag * 2 : Infinity,
    }));
    this.index = 0;
    this.reloading = false;
    this.nextShot = 0;
    this.applySlot();
  }

  applySlot() {
    const s = this.slots[this.index];
    if (!s) return;
    this.spec = s.spec;
    this.ammo = s.ammo;
    this.reserve = s.reserve;
  }

  /** 지금 슬롯에 탄약을 되돌려 놓는다 (전환 전에 호출). */
  stash() {
    const s = this.slots[this.index];
    if (s) { s.ammo = this.ammo; s.reserve = this.reserve; }
  }

  get count() { return this.slots.length; }

  /** 슬롯 전환. 성공하면 true. */
  select(i, t) {
    if (i === this.index || i < 0 || i >= this.slots.length) return false;
    this.stash();
    this.index = i;
    this.applySlot();
    this.reloading = false;          // 전환하면 재장전은 취소된다
    this.nextShot = t + SWAP_SEC;
    return true;
  }

  /** 한 자루짜리(좀비) 용 */
  equip(spec) {
    this.equipAll([spec]);
  }

  get magSize() { return this.spec?.mag ?? 0; }
  get infinite() { return !Number.isFinite(this.spec?.mag); }

  canFire(t) {
    if (!this.spec || this.reloading) return false;
    if (t < this.nextShot) return false;
    return this.ammo > 0;
  }

  /** 발사 확정. 반동에 쓸 탄퍼짐 각을 돌려준다. */
  fire(t) {
    this.nextShot = t + 60 / this.spec.rpm;
    if (!this.infinite) this.ammo--;
    return this.spec.spread;
  }

  startReload(t) {
    if (this.infinite || this.reloading) return false;
    if (this.ammo >= this.magSize) return false;
    if (this.reserve <= 0) return false;   // 보급탄이 없으면 장전할 게 없다
    this.reloading = true;
    this.reloadEnd = t + this.spec.reloadSec;
    return true;
  }

  /** 탄약상자 주우기 — 지금 든 무기의 보급탄을 채운다. */
  addAmmo(n) {
    if (this.infinite) return;
    this.reserve += n;
  }

  /**
   * 특정 무기(id)의 보급탄을 채운다. 탄약상자가 권총/소총으로 나뉘어
   * 있어 "지금 든 무기"가 아니라 "상자 종류에 맞는 무기"에 주워야 한다.
   * 그 무기가 없으면(예: 기관단총 전용 상자) 아무 일도 안 한다.
   * @returns {boolean} 실제로 채웠는지
   */
  addAmmoTo(id, n) {
    const s = this.slots.find((sl) => sl.id === id);
    if (!s || !Number.isFinite(s.spec.mag)) return false;
    s.reserve += n;
    // 지금 그 무기를 들고 있으면 표시도 바로 갱신
    if (this.index === this.slots.indexOf(s)) this.reserve = s.reserve;
    return true;
  }

  update(t) {
    if (this.reloading && t >= this.reloadEnd) {
      this.reloading = false;
      // 보급탄이 부족하면 그만큼만 채운다
      const take = Math.min(this.magSize - this.ammo, this.reserve);
      this.ammo += take;
      this.reserve -= take;
    }
  }

  /** 재장전 진행률 0~1 (HUD 용). */
  reloadProgress(t) {
    if (!this.reloading) return 1;
    return 1 - Math.max(0, (this.reloadEnd - t) / this.spec.reloadSec);
  }
}

/**
 * 근접 무기(주먹) 판정 원뿔의 반각. 레이저처럼 가늘게 쏘는 게 아니라
 * "스윙의 폭" 안에서면 맞는다 — 보이는 주먹 동작과 판정이 일치해야
 * "어떤 각도로 때려야 맞는지" 직관적으로 느껴진다.
 */
export const MELEE_CONE = 0.35;   // 약 20도

/**
 * 조준선에 걸린 적을 찾는다.
 *
 * @param origin  카메라(눈) 위치
 * @param dir     정규화된 시선 방향
 * @param targets [{ id, pos: Vector3, state }]  — 원격 플레이어들
 * @param boxes   맵 충돌 박스 (벽 뒤는 안 맞는다)
 * @param cone    반각(라디안). 0 은 레이저(총), >0 은 원뿔(주먹)
 * @param low     잽 판정 — 타격점을 아래로 내린다 (combat.js hitboxes 참고)
 * @returns { id, dist, head } | null
 */
export function raycastTarget(origin, dir, targets, boxes, range, cone = 0, low = false) {
  const ray = new Ray(origin, dir);
  const sphere = new Sphere();
  const hitPoint = new Vector3();
  const toC = new Vector3();

  let best = null;

  for (const tgt of targets) {
    if (tgt.state === 'dead') continue;

    // 머리를 먼저 본다 — 겹칠 때 헤드샷이 이기도록
    for (const part of partsOf(tgt, low)) {
      sphere.center.copy(part.c);
      sphere.radius = part.r;

      let hit;
      if (ray.intersectSphere(sphere, hitPoint)) {
        hit = hitPoint;
      } else if (cone > 0) {
        // 레이저가 빗나가도 원뿔 안이면 명중. 타격점은 대상 쪽 표면.
        toC.copy(sphere.center).sub(origin);
        const dC = toC.length();
        if (dC < 1e-4) continue;
        const ang = Math.acos(Math.min(1, Math.max(-1, toC.dot(dir) / dC)));
        if (ang > Math.asin(Math.min(1, sphere.radius / dC)) + cone) continue;
        hit = hitPoint.copy(sphere.center).addScaledVector(toC, -sphere.radius / dC);
      } else {
        continue;
      }

      const d = origin.distanceTo(hit);
      if (d > range) continue;
      if (best && d >= best.dist) continue;
      if (lineBlocked(origin, sphere.center, boxes)) continue;

      best = { id: tgt.id, dist: d, head: part.head };
      break;    // 이 대상은 판정 끝
    }
  }

  return best;
}

/**
 * 화살 구간 판정 — 화살이 이번 프레임에 이동한 선분(from→to)이
 * 대상 히트박스를 관통했는지 본다.
 *
 * 화살은 빠르다(최대 130m/s). 위치만 검사하면 한 프레임에
 * 몸을 뚫고 지나가서 "보이는데 안 맞는다" 가 생긴다.
 * @returns { id, point, head, dist } | null
 */
/** 디버그용 — 대상의 지금 히트박스 */
export function debugHitboxes(tgt) { return partsOf(tgt, false); }

export function arrowSegmentHit(from, to, targets, boxes) {
  const dir = new Vector3().subVectors(to, from);
  const len = dir.length();
  if (len < 1e-6) return null;
  dir.divideScalar(len);

  const ray = new Ray(from, dir);
  const sphere = new Sphere();
  const hitPoint = new Vector3();

  let best = null;
  for (const tgt of targets) {
    if (tgt.state === 'dead') continue;
    for (const part of partsOf(tgt, false)) {
      sphere.center.copy(part.c);
      sphere.radius = part.r;
      if (!ray.intersectSphere(sphere, hitPoint)) continue;
      const d = from.distanceTo(hitPoint);
      if (d > len) continue;                       // 이번 구간에 안 닿았다
      if (lineBlocked(from, sphere.center, boxes)) continue;
      if (best && d >= best.dist) continue;
      best = { id: tgt.id, point: hitPoint.clone(), head: part.head, dist: d };
      break;    // 이 대상은 판정 끝
    }
  }
  return best;
}

/** 거리에 따른 감쇠 없이, 헤드샷 배수만 적용한다. */
export function damageFor(spec, head) {
  return spec.dmg * (head ? HEAD_MUL : 1);
}

/**
 * 탄퍼짐을 적용한 발사 방향.
 * 원 안에 균일하게 뿌려야 한쪽으로 쏠리지 않는다.
 */
export function spreadDir(dir, spread, right, up) {
  if (!spread) return dir.clone();
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * spread;
  return dir.clone()
    .addScaledVector(right, Math.cos(a) * r)
    .addScaledVector(up, Math.sin(a) * r)
    .normalize();
}

/**
 * 일으키기 진행 상태. F 를 꾹 누르고 있어야 하고, 떼거나 멀어지면 처음부터.
 */
export class Revive {
  constructor() {
    this.targetId = null;
    this.progress = 0;
  }

  /** @returns 완료된 대상 id, 아니면 null */
  update(dt, holding, candidate, seconds) {
    if (!holding || !candidate) {
      this.targetId = null;
      this.progress = 0;
      return null;
    }
    if (candidate.id !== this.targetId) {
      this.targetId = candidate.id;
      this.progress = 0;
    }
    this.progress += dt / seconds;
    if (this.progress < 1) return null;

    const done = this.targetId;
    this.targetId = null;
    this.progress = 0;
    return done;
  }
}

/** 일으킬 수 있는 가장 가까운 동료. */
export function findReviveTarget(myPos, targets, maxDist = 2.6) {
  let best = null;
  for (const t of targets) {
    if (t.state !== 'downed') continue;
    const d = myPos.distanceTo(t.pos);
    if (d > maxDist) continue;
    if (best && d >= best.dist) continue;
    best = { id: t.id, dist: d };
  }
  return best;
}
