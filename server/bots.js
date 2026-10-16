// 연습용 더미.
//
// 혼자 테스트할 때 상대 역할로 세워두는 허수아비다. 소켓이 없다는 점만
// 빼면 서버 입장에서 플레이어와 똑같이 취급된다 — 맞고, 쓰러지고,
// 스냅샷에 실려 나간다.
//
// 진짜 AI 가 아니다. 쫓아오거나 도망치기만 한다. 속도 · 사거리 감각을
// 몸으로 확인하는 게 목적이다.

import { clearSpawn, slide, clampToArena } from '../shared/map.js';
import { navDirection } from './nav.js';
import { PSTATE, MV } from '../shared/protocol.js';
import { resolveLoadout } from '../shared/loadout.js';

export const BOT_BEHAVIOR = {
  STILL: 'still',    // 가만히 서 있는 과녁
  CHASE: 'chase',    // 가장 가까운 상대를 쫓는다
  FLEE: 'flee',      // 가장 가까운 상대에게서 도망친다
  HUNT: 'hunt',      // 공격적 — 풀스프린트 + 슈퍼점프를 섞어 쫓는다
};

export class Bot {
  constructor(id, role, index, boxes, behavior = BOT_BEHAVIOR.STILL) {
    this.id = id;
    this.ws = null;              // 소켓 없음 — 이걸로 사람과 구분한다
    this.isBot = true;
    this.name = `더미${index + 1}`;
    this.classId = 'default';
    this.ready = true;
    this.behavior = behavior;

    this.role = role;
    this.loadout = resolveLoadout(role, 'default', 1);
    this.maxHp = role === 'zombie' ? 300 : 100;   // 연습용이라 얇게
    this.hp = this.maxHp;
    this.state = PSTATE.ALIVE;

    const a = (index / 4) * Math.PI * 2 + 0.6;
    const r = 12;
    const [x, z] = clearSpawn(Math.cos(a) * r, Math.sin(a) * r, boxes);
    this.home = [x, z];
    this.pos = [x, 0, z];
    this.yaw = 0;
    this.pitch = 0;
    this.mv = 0;
    this.seq = 0;

    this.downedAt = 0;
    this.respawnAt = 0;
    this.pendingHit = null;   // 휘두른 뒤(0.8초) 데미지가 떨어지는 대기 상태
    this.lungeAt = -99;
    this.rageAt = -99;
    this.rageUntil = 0;
    this.vy = 0;          // 슈퍼점프 수직 속도
    this.jumpAt = -99;    // 마지막 점프 시각 (쿨다운)
    this.detourSide = 0;  // 막혀서 돌아가는 중이면 ±1 (어느 쪽으로 도는지)
    this.detourUntil = 0;
  }

  send() {}                      // 소켓이 없으므로 아무것도 안 한다

  snapshot() {
    return {
      id: this.id, p: this.pos.map((v) => +v.toFixed(2)),
      y: +this.yaw.toFixed(3), pi: 0,
      // mhp(최대 체력)가 빠지면 클라이언트 체력바가 0으로 보이며
      // "때려도 아무 반응이 없다" 로 보였다 — 플레이어 스냅샷과 맞춰준다.
      pt: +(Date.now() / 1000).toFixed(3),   // 더미는 서버 틱에서 움직인다 — 지금이 잰 시각
      mv: this.mv, hp: Math.round(this.hp), mhp: this.maxHp, st: this.state,
    };
  }

  lobbyInfo() {
    return { id: this.id, name: this.name, classId: this.classId, ready: true, bot: true };
  }

  respawn(boxes) {
    const [x, z] = clearSpawn(this.home[0], this.home[1], boxes);
    this.pos = [x, 0, z];
    this.hp = this.maxHp;
    this.state = PSTATE.ALIVE;
    this.downedAt = 0;
    this.respawnAt = 0;
  }
}

/**
 * 더미 한 틱. 사람 플레이어 목록을 받아 쫓거나 도망치거나 공격적으로 사냥한다.
 * 공격은 하지 않는다 — 맞아보고 싶으면 사람 둘이 붙는 게 낫다.
 *
 * @param hold  남은 묶임 시간(초). 좀비 더미는 이 동안 움직이지 못한다.
 */
export function stepBot(bot, humans, boxes, dt, t, respawnSec, hold = 0) {
  if (bot.state === PSTATE.DEAD || bot.state === PSTATE.DOWNED) {
    if (!bot.respawnAt) bot.respawnAt = t + respawnSec;
    if (t >= bot.respawnAt) bot.respawn(boxes);
    return;
  }

  // 라운드 시작 — 좀비 더미는 묶여 있다
  if (hold > 0 && bot.role === 'zombie') { bot.mv = 0; return; }

  // 슈퍼점프 중이라면 중력을 적용한다
  if (bot.pos[1] > 0 || bot.vy !== 0) {
    bot.vy -= 24 * dt;
    bot.pos[1] += bot.vy * dt;
    if (bot.pos[1] <= 0) { bot.pos[1] = 0; bot.vy = 0; }
  }

  if (bot.behavior === BOT_BEHAVIOR.STILL) { bot.mv = 0; return; }

  // 가장 가까운 상대 역할
  let near = null;
  let bestD = Infinity;
  for (const h of humans) {
    if (h.role === bot.role) continue;
    if (h.state !== PSTATE.ALIVE) continue;
    const d = Math.hypot(h.pos[0] - bot.pos[0], h.pos[2] - bot.pos[2]);
    if (d < bestD) { bestD = d; near = h; }
  }
  if (!near) return;

  let dx = near.pos[0] - bot.pos[0];
  let dz = near.pos[2] - bot.pos[2];
  const len = Math.hypot(dx, dz) || 1;
  dx /= len; dz /= len;

  if (bot.behavior === BOT_BEHAVIOR.FLEE) { dx = -dx; dz = -dz; }
  else {
    if (bot.behavior !== BOT_BEHAVIOR.HUNT && bestD < 1.4) return;  // 붙었으면 더 밀지 않는다
    // 쫓을 때는 컨테이너를 돌아가는 길을 찾는다 (server/nav.js)
    const dir = navDirection(bot, near.pos[0], near.pos[2], boxes, t);
    if (dir) [dx, dz] = dir;
  }

  // hunt — 풀스프린트. 나머지는 사람보다 살짝 느리게
  const speed = bot.behavior === BOT_BEHAVIOR.HUNT
    ? bot.loadout.speed
    : bot.loadout.speed * 0.85;

  // hunt — 중거리에서 슈퍼점프를 섞는다 (5초에 한 번)
  if (bot.behavior === BOT_BEHAVIOR.HUNT && bot.pos[1] === 0
      && bestD > 4 && bestD < 22 && t - bot.jumpAt > 5) {
    bot.vy = bot.loadout.superJumpSpeed ?? 10;
    bot.jumpAt = t;
  }

  const [cx, cz, mx, mz] = steer(bot, dx, dz, speed * dt, boxes, t);
  [bot.pos[0], bot.pos[2]] = clampToArena(cx, cz);
  bot.yaw = Math.atan2(-mx, -mz);
  bot.mv = (bot.pos[1] > 0 ? MV.AIR : 0) | MV.FWD;
}

// 막혔을 때 돌아가기 — 쫓을 때는 길찾기(nav.js)가 길을 정하고, 이건 그 길에서도
// 다른 더미 · 모서리에 걸리거나 도망칠 때(길찾기 없음) 쓴다. 가려던 거리의 절반도 못 가면 한쪽을 정해
// (목표 쪽으로 더 나아가는 쪽) 1.2초 동안 그쪽으로 꺾어서 벽을 따라 돈다.
// 연습용 더미가 구석에 박혀 서 있지만 않으면 된다.
const DETOUR_ANGLES = [0.6, 1.1, 1.6, 2.1, 2.6];

function tryMove(bot, dx, dz, step, boxes) {
  const [x, z] = slide(bot.pos[0], bot.pos[2], bot.pos[0] + dx * step, bot.pos[2] + dz * step, boxes);
  return { x, z, moved: Math.hypot(x - bot.pos[0], z - bot.pos[2]) };
}

function rotate(dx, dz, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [dx * c - dz * s, dx * s + dz * c];
}

function steer(bot, dx, dz, step, boxes, t) {
  const direct = tryMove(bot, dx, dz, step, boxes);
  if (t >= bot.detourUntil) bot.detourSide = 0;
  if (!bot.detourSide && direct.moved > step * 0.5) return [direct.x, direct.z, dx, dz];

  if (!bot.detourSide) {
    // 양쪽을 다 꺾어보고 목표 방향으로 더 나아가는 쪽을 고른다
    let best = -Infinity;
    for (const side of [1, -1]) {
      for (const a of DETOUR_ANGLES) {
        const [rx, rz] = rotate(dx, dz, a * side);
        const m = tryMove(bot, rx, rz, step, boxes);
        if (m.moved < step * 0.6) continue;
        const gain = (m.x - bot.pos[0]) * dx + (m.z - bot.pos[2]) * dz;
        if (gain > best) { best = gain; bot.detourSide = side; }
        break;
      }
    }
    if (!bot.detourSide) bot.detourSide = Math.random() < 0.5 ? 1 : -1;
    bot.detourUntil = t + 1.2;
  }
  // 정한 쪽으로, 목표에서 덜 꺾이는 각도부터
  for (const a of [0, ...DETOUR_ANGLES]) {
    const [rx, rz] = rotate(dx, dz, a * bot.detourSide);
    const m = tryMove(bot, rx, rz, step, boxes);
    if (m.moved > step * 0.6) return [m.x, m.z, rx, rz];
  }
  return [direct.x, direct.z, dx, dz];
}
