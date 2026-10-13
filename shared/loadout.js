// 역할 · 직업 · 무기 정의와, 이 셋을 합쳐 최종 능력치를 내는 함수.
//
// ─── 직업을 추가하려면 CLASSES 에 한 줄 넣으면 된다 ───
// 서버와 클라이언트가 같은 resolveLoadout() 을 쓰기 때문에,
// 여기만 고치면 양쪽 수치가 저절로 맞는다.

import { BASE } from './config.js';

export const ROLES = {
  zombie: { id: 'zombie', name: '좀비', hasClass: false },
  survivor: { id: 'survivor', name: '생존자', hasClass: true },
};

/**
 * 무기 전환에 걸리는 시간(초). 이 동안은 못 쏜다.
 * 3인칭 몸이 소총을 허리에 메고 권총을 뽑는(또는 그 반대) 동작을 이 시간에 맞춰
 * 튼다 (avatarAnim.js) — 0.35초였을 땐 그 동작을 6배속으로 감아야 했다.
 * 소총 재장전(2.2초)보다는 빨라서 "재장전 대신 권총" 은 여전히 이득이다.
 */
export const SWAP_SEC = 0.9;

export const WEAPONS = {
  fist: {
    name: '주먹', auto: false,
    // 75 은 0.8초에 한 대라 쫓아가며 때리기엔 굼떴다
    dmg: 42, rpm: 140, range: 2.6, mag: Infinity, reloadSec: 0, spread: 0,
  },
  pistol: {
    name: '권총', auto: false,
    dmg: 26, rpm: 300, range: 90, mag: 14, reloadSec: 1.5, spread: 0.010,
  },
  rifle: {
    name: '소총', auto: true,
    dmg: 15, rpm: 620, range: 120, mag: 30, reloadSec: 2.2, spread: 0.016,
  },
  smg: {
    name: '기관단총', auto: true,
    dmg: 11, rpm: 850, range: 60, mag: 35, reloadSec: 1.8, spread: 0.024,
  },
  bow: {
    name: '활', auto: false,
    // 끌어당겼다 놓는 활 — 버튼을 꾹 누르면 장전(이동 느려짐), 떼면 발사.
    // 장전이 길수록 데미지·사거리가 커진다. 탄약은 무한이라 재장전·보급이 없다.
    // 데미지·사거리·속도는 장전량 제곱(c²)으로 스케일된다 — 짧게 당긴 화살은
    // 거의 힘 없이 푹 떨어지는 약한 로브, 풀장전이 진짜 화살이다.
    // 맵(60m) 기준: 최소장전은 발밑 3m 안팎에서 푹 떨어지고, 풀장전이 맵을 가로지른다.
    // 약한 화살은 중력도 더 강하게 작용한다 (main.js, 장전량 비례).
    dmg: 70,          // 풀장전 몸통 데미지 (헤드샷 2배 = 140)
    dmgMin: 8,        // 최소장전 몸통 데미지 — 사실상 스크래치
    range: 120,       // 풀장전 사거리
    rangeMin: 5,      // 최소장전 사거리 — 발밑에서 힘이 풀린다
    chargeMax: 1.4,   // 풀장전까지 걸리는 시간(초)
    chargeSlow: 0.35, // 장전 중 이동속도 배수 — 1.6m/s, 조준 걷기 클립(1.0~1.3m/s)에 맞춘다
    arrowSpeed: 130,  // 풀장전 화살 속도 (m/s) — 빠를수록 반응시간이 줄어든다
    arrowSpeedMin: 5, // 최소장전 화살 속도 — 힘없이 푹 떨어지는 로브
    rpm: 150,         // 발사 간 최소 간격 (0.4초) — 장전 시간이 진짜 리듬을 만든다
    mag: Infinity, reloadSec: 0, spread: 0.004,
  },
};

/**
 * 생존자 직업.
 *
 * 각 항목은 BASE.survivor 에 얹히는 **보정치**다.
 *  - 절대값으로 덮어쓰려면  hp: 120
 *  - 배수로 조정하려면      speedMul: 1.1
 * 둘 다 있으면 절대값을 먼저 적용하고 배수를 곱한다.
 *
 * `default` 는 직업 선택 UI 를 아직 안 붙였을 때 쓰는 기본값이다.
 * 직업을 정식으로 넣을 때 이걸 지우고 아래 셋(또는 원하는 만큼)만 남기면 된다.
 */
export const CLASSES = {
  default: {
    name: '총수', desc: '소총과 권총. 연사로 밀어붙인다.',
    weapons: ['rifle', 'pistol'],       // 1번 주무기, 2번 보조
    model: 'gunner',                     // public/models/gunner.glb — 아래 직업도 따로 없으면 이것
  },

  archer: {
    name: '사냥꾼', desc: '활을 든다. 탄약 걱정이 없고 한 발이 무겁다.',
    weapons: ['bow'],                    // 활만 — 탄약이 무한이라 보조무기 없음
    model: 'hunter',
  },

  // ── 아래는 나중에 열 직업들. 지금은 UI 에 노출되지 않는다 (locked). ──
  soldier: {
    name: '돌격병', desc: '체력이 높고 소총을 든다. 정면에서 버틴다.',
    weapons: ['rifle', 'pistol'], locked: true,
    hp: 120, staminaMax: 90,
  },
  scout: {
    name: '정찰병', desc: '빠르지만 약하다. 미끼 역할.',
    weapons: ['smg', 'pistol'], locked: true,
    hp: 85, speedMul: 1.12, staminaMax: 130, staminaRegen: 18,
  },
  medic: {
    name: '의무병', desc: '동료를 훨씬 빨리 일으킨다.',
    weapons: ['pistol', 'smg'], locked: true,
    hp: 100, reviveSecMul: 0.55,
  },
};

/** UI 에 띄울 수 있는 직업만 추린다. */
export function selectableClasses() {
  return Object.entries(CLASSES)
    .filter(([, c]) => !c.locked)
    .map(([id, c]) => ({ id, name: c.name, desc: c.desc, weapon: c.weapon }));
}

/**
 * 역할 + 직업 + (좀비면) 생존자 수 → 최종 능력치.
 * 서버가 권위 있는 값을 계산할 때도, 클라이언트가 HUD 를 그릴 때도 이걸 쓴다.
 */
export function resolveLoadout(role, classId = 'default', survivorCount = 1) {
  if (role === 'zombie') {
    const z = BASE.zombie;
    return {
      role: 'zombie',
      classId: null,
      className: ROLES.zombie.name,
      weapons: [{ id: 'fist', ...WEAPONS.fist }],
      weapon: { id: 'fist', ...WEAPONS.fist },
      maxHp: z.hpBase + z.hpPerSurvivor * Math.max(0, survivorCount),
      speed: z.speed,
      sprintMul: z.sprintMul ?? 1,
      staminaMax: z.staminaMax ?? 0,
      staminaDrain: z.staminaDrain ?? 22,
      staminaRegen: z.staminaRegen ?? 14,
      jumpSpeed: z.jumpSpeed,
      regen: z.regen,
      abilities: ['lunge', 'rage'],
      // 덩치. 눈높이 · 아바타 크기 · 히트박스가 전부 이 값을 따른다.
      height: z.height,
      radius: z.radius,
      rageSpeedMul: z.rageSpeedMul,
      rageSec: z.rageSec,
      // 슈퍼점프 (스페이스 꾹 → 떼면 도약, 착지 때 광범위 공격)
      chargeMinSec: z.chargeMinSec,
      chargeMaxSec: z.chargeMaxSec,
      chargeSlowMul: z.chargeSlowMul,
      superJumpSpeed: z.superJumpSpeed,
      superJumpForward: z.superJumpForward,
      slamRadius: z.slamRadius,
      slamCooldown: z.slamCooldown,
    };
  }

  const b = BASE.survivor;
  const c = CLASSES[classId] ?? CLASSES.default;

  const hp = (c.hp ?? b.hp) * (c.hpMul ?? 1);
  const speed = (c.speed ?? b.speed) * (c.speedMul ?? 1);
  const staminaMax = (c.staminaMax ?? b.staminaMax) * (c.staminaMaxMul ?? 1);
  const reviveSec = (c.reviveSec ?? b.reviveSec) * (c.reviveSecMul ?? 1);

  // 1번 주무기, 2번 보조. (예전 한 자루 표기도 계속 받아준다)
  const ids = c.weapons ?? [c.weapon ?? 'rifle'];
  const weapons = ids.filter((id) => WEAPONS[id]).map((id) => ({ id, ...WEAPONS[id] }));

  return {
    role: 'survivor',
    classId,
    className: c.name,
    weapons,
    weapon: weapons[0],          // 처음 드는 것
    maxHp: hp,
    speed,
    sprintMul: c.sprintMul ?? b.sprintMul,
    staminaMax,
    staminaDrain: c.staminaDrain ?? b.staminaDrain,
    staminaRegen: c.staminaRegen ?? b.staminaRegen,
    jumpSpeed: c.jumpSpeed ?? b.jumpSpeed,
    downedBleedSec: c.downedBleedSec ?? b.downedBleedSec,
    reviveSec,
    abilities: c.abilities ?? [],
    height: c.height ?? b.height,
    radius: c.radius ?? b.radius,
  };
}

/** 역할 + 직업 → 아바타 모델 이름 (public/models/<이름>.glb). */
export function avatarModel(role, classId) {
  if (role === 'zombie') return 'zombie';
  return CLASSES[classId]?.model ?? CLASSES.default.model;
}

/** 넘어온 직업 id 가 실제로 고를 수 있는 것인지 — 서버에서 검증용. */
export function isSelectableClass(id) {
  const c = CLASSES[id];
  return !!c && !c.locked;
}
