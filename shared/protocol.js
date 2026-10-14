// 클라이언트 ↔ 서버 메시지 종류.
//
// 권위 분담:
//   - 이동과 조준은 각자 브라우저가 계산해서 서버에 "보고"한다 (C.INPUT).
//   - 체력 · 쓰러짐 · 승패는 서버만 정한다. 클라이언트는 통보받는다.
//   - 명중은 쏜 사람 브라우저가 판정해서 보고하고(C.HIT), 서버는 사거리와
//     데미지 상한만 확인한다. 친구끼리 하는 게임이라 이 정도로 충분하다.

/** 클라이언트 → 서버 */
export const C = {
  JOIN: 'join',       // { name }
  PICK: 'pick',       // { classId }          로비에서 직업 선택
  READY: 'ready',     // { ready }
  START: 'start',     // {}                   아무나 누를 수 있다 → 수락 확인(전원 수락하면 시작)
  ACCEPT: 'accept',   // { ok }               수락 확인에 답한다
  INPUT: 'input',     // { seq, p:[x,y,z], yaw, pitch, mv }  20Hz
  HIT: 'hit',         // { target, dmg, head }
  ACTION: 'action',   // { kind }             lunge | rage | fire | reload | revive…
  CHAT: 'chat',       // { text }
};

/** 서버 → 클라이언트 */
export const S = {
  WELCOME: 'welcome', // { id, config, classes }
  LOBBY: 'lobby',     // { players[], canStart }
  ROUND: 'round',     // { phase, startAt, endAt, you:{role,classId,loadout} }
  STATE: 'state',     // { now, players[] }   20Hz
  EVENT: 'event',     // { kind, ... }        hit | down | revive | kill | end
  ERROR: 'error',     // { text }
};

/** 라운드 진행 단계 */
export const PHASE = {
  LOBBY: 'lobby',           // 인원 모으는 중
  COUNTDOWN: 'countdown',   // 역할 배정됨, 곧 시작
  PLAYING: 'playing',
  ENDED: 'ended',           // 결과 표시 중
};

/**
 * 이동 비트 — 1바이트에 실어 클라이언트↔서버를 오간다.
 * 애니메이션 판단(클라이언트)과 슬램 회피 판정(서버)이 같이 쓴다.
 */
export const MV = {
  FWD: 1, BACK: 2, LEFT: 4, RIGHT: 8, SPRINT: 16, AIR: 32, FIRE: 64,
  ALT: 128,   // 2번 무기(총수 권총)를 들고 있다 — 남의 화면에서도 같은 총·동작을 고른다
  USE: 256,   // 쓰러진 동료를 살리는 중 (F 누르는 중) — 남의 화면에서도 CPR 동작을 튼다
};

/** 플레이어 상태 */
export const PSTATE = {
  ALIVE: 'alive',
  DOWNED: 'downed',         // 생존자만 — 동료가 일으킬 수 있다
  DEAD: 'dead',
  SPECTATING: 'spectating', // 라운드 중에 들어온 사람
};

// `t` 는 메시지 종류 전용이다. data 에 같은 이름이 있어도 종류가 이기도록
// 스프레드 뒤에 놓는다 (예전에 STATE 가 타임스탬프를 t 로 보내서 종류를
// 통째로 덮어쓴 적이 있다 — 시각은 `now` 를 쓴다).
export function encode(type, data = {}) {
  return JSON.stringify({ ...data, t: type });
}

export function decode(raw) {
  try {
    const m = JSON.parse(raw);
    return m && typeof m.t === 'string' ? m : null;
  } catch {
    return null;
  }
}
