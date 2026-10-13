// 게임 밸런스 수치. 서버와 클라이언트가 이 파일 하나를 같이 읽는다.
//
// 값을 고치면 서버만 다시 켜면 된다 — 클라이언트는 접속할 때 서버가 보내주는
// 설정을 받아 쓰기 때문에, 친구들이 새로고침만 해도 똑같이 적용된다.

export const TICK_HZ = 20;          // 서버 브로드캐스트 주기
export const SEND_HZ = 20;          // 클라이언트 입력 보고 주기

export const ROUND = {
  lengthSec: 150,                   // 라운드 길이
  zombieHoldSec: 5,                 // 시작 직후 좀비가 묶여 있는 시간
  minPlayers: 2,                    // 라운드를 시작할 수 있는 최소 인원
  intermissionSec: 8,               // 라운드 사이 쉬는 시간
};

export const WORLD = {
  arenaX: 80,                       // 맵 가로 (m) — 서쪽 골목 · 가운데 광장 · 동쪽 창고 (shared/map.js)
  arenaZ: 52,                       // 맵 세로 (m)
  gravity: -22,
  eyeHeight: 1.62,                  // 1인칭 카메라 높이
  playerRadius: 0.35,
  spawnRing: 22,                    // 생존자 스폰 반경
};

// 역할 공통 기본값. 직업은 이 위에 얹히는 보정치다.
//
// 이동 속도는 애니메이션 클립의 "제 속도"(avatarAnim.js PROFILE)에 묶여 있다.
// 클립보다 훨씬 빨리 움직이면 다리를 그만큼 빨리 감아야 해서 우스꽝스러워진다
// (좀비 6.5m/s 질주 = 달리기 클립 2.1배속). 클립 1.3~1.6배속 안에 들도록 잡았다.
//   사냥꾼 달리기 클립 3.1m/s · 좀비 걷기 1.5m/s · 좀비 달리기 3.0m/s
// 추격 관계는 그대로 둔다:
//   생존자 걷기 4.5  <  좀비 질주 4.8      걸어서는 못 도망친다
//   좀비 광폭 질주 6.96 >  생존자 질주 6.3  광폭화(7초)는 따돌릴 수 없다 — 숨거나 막아야 한다
export const BASE = {
  survivor: {
    hp: 100,
    height: 1.75,           // 키 (눈높이·아바타·히트박스의 기준)
    radius: 0.35,
    speed: 4.5,                     // 걷기 (달리기 클립 1.45배속)
    sprintMul: 1.4,                 // 전력질주 배수 — 6.3 (좀비 질주보다 빠르고, 광폭 질주보다는 느리다)
    staminaMax: 100,
    staminaDrain: 22,               // 초당
    staminaRegen: 14,
    jumpSpeed: 7.2,
    downedBleedSec: 25,             // 쓰러진 뒤 방치하면 죽는 시간
    reviveSec: 3.5,
  },
  zombie: {
    hpBase: 300,
    height: 2.15,           // 생존자보다 확실히 크다
    radius: 0.46,
    hpPerSurvivor: 130,             // 생존자 1명당 추가 체력
    speed: 2.0,                     // 걷기 (걷기 클립 1.3배속)
    sprintMul: 2.4,                 // 달리기 (2.0 × 2.4 = 4.8, 달리기 클립 1.6배속)
    staminaMax: 100,
    staminaDrain: 22,
    staminaRegen: 14,
    regen: 6,                       // 초당 자연 회복
    jumpSpeed: 7.2,
    lungeSpeed: 16,                 // 돌진 순간 속도
    lungeCostHp: 35,
    lungeCooldown: 3.0,
    // 슈퍼점프 — 스페이스를 꾹 눌러 모았다가 떼면 뛴다. 착지 때 광범위 공격.
    chargeMinSec: 0.25,             // 이보다 짧게 떼면 그냥 점프
    chargeMaxSec: 1.1,              // 꽉 모으는 데 걸리는 시간
    chargeSlowMul: 0.35,            // 모으는 동안은 느려진다 (쓸지 말지 고민되게)
    superJumpSpeed: 15.5,           // 꽉 모았을 때 수직 속도
    superJumpForward: 9.0,          // 바라보는 쪽으로 밀어주는 양
    slamRadius: 6.5,                // 착지 충격 반경
    slamDmg: 55,                    // 중심 데미지 (가장자리로 갈수록 준다)
    slamMinMul: 0.35,               // 가장자리 최소 배수
    slamCooldown: 6.0,

    // 광폭화(R) — 7초 동안 빨라지고, 질주에 스태미나를 안 쓰고, 빠르게 회복한다
    rageSec: 7,
    rageSpeedMul: 1.45,             // 질주 6.96 — 생존자 전력질주(6.3)보다 빠르다. 7초 안에 붙잡는다
    rageRegen: 60,
    rageCooldown: 16,
    senseRange: 18,                 // 이 거리 안의 생존자는 벽 너머로 실루엣이 보인다
  },
};

export const NET = {
  maxPlayers: 8,
  nameMaxLen: 12,
  // 클라이언트가 보고한 명중을 서버가 검증할 때 쓰는 상한.
  // 친구끼리 하는 게임이라 이 정도만 본다.
  maxHitRange: 120,
  maxDmgPerHit: 150,    // 활 헤드샷(70×2=140)이 상한에 걸리지 않게
};
