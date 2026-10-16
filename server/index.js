// 게임 서버.
//
// 개발 중에는 이 서버가 WebSocket 만 맡고, 화면은 Vite(5173)가 띄운다.
// 배포하면 dist/ 정적 파일까지 같이 서빙해서 포트 하나로 끝난다.

import { createServer } from 'node:http';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { TICK_HZ, ROUND, NET } from '../shared/config.js';
import { C, S, PHASE, PSTATE, MV, encode, decode } from '../shared/protocol.js';
import { resolveLoadout, isSelectableClass, selectableClasses } from '../shared/loadout.js';
import { buildBoxes, clearSpawn, SURVIVOR_SPAWNS, ZOMBIE_SPAWN, AMMO_SPOTS, AMMO_BOX_COUNT, AMMO_SPAWN_INTERVAL, AMMO_PICKUP_RADIUS } from '../shared/map.js';
import { Bot, BOT_BEHAVIOR, stepBot } from './bots.js';
import * as CFG from '../shared/config.js';

const BOXES = buildBoxes();

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 3000;

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// ---------------------------------------------------------------- 상태

let nextId = 1;
/** @type {Map<number, Player>} */
const players = new Map();
/** 연습 모드에서만 채워진다. @type {Map<number, Bot>} */
const bots = new Map();

const CHECK_SEC = 12;   // 수락 확인 제한 시간

const game = {
  phase: PHASE.LOBBY,
  check: null,       // 수락 확인 중이면 { until, ids:Set, accepted:Set } — 롤처럼 전원 수락해야 시작
  startAt: 0,        // playing 진입 시각 (좀비 구속 해제)
  endAt: 0,
  lastZombieId: null, // 연속으로 좀비가 걸리지 않게
  result: null,
  practice: false,    // 연습 모드 — 승패로 라운드가 끊기지 않는다
  ammoBoxes: [],      // 현재 바닥에 있는 탄약상자 [{i, x, z, type}] — 주우면 제거된다
  ammoNextSpawnAt: 0, // 다음 탄약상자 스폰 시각 (초)
};

/** 수락 확인 진행 상황을 모두에게 */
function sendCheck() {
  const c = game.check;
  broadcast(S.EVENT, { kind: 'check', left: Math.max(0, c.until - now()), total: CHECK_SEC,
    ids: [...c.ids], accepted: [...c.accepted] });
}

/** 수락 확인 취소 — reason: declined | timeout | left */
function cancelCheck(reason, who) {
  if (!game.check) return;
  game.check = null;
  broadcast(S.EVENT, { kind: 'check', cancel: true, reason, name: who?.name ?? '' });
  log(`수락 확인 취소 (${reason}${who ? ' · ' + who.name : ''})`);
  sendLobby();
}

/** 대기실에 들어온 사람만 (첫 화면에 머문 접속 · 봇 스캐너 제외) */
function joinedPlayers() {
  return [...players.values()].filter((p) => p.joined);
}

/** 사람 + 더미. 명중 판정과 스냅샷은 둘을 구분하지 않는다. */
function everyone() {
  return [...players.values(), ...bots.values()];
}
function findEntity(id) {
  return players.get(id) ?? bots.get(id);
}

function now() { return Date.now() / 1000; }

class Player {
  constructor(id, ws, ip) {
    this.id = id;
    this.ws = ws;
    this.ip = ip;
    this.name = `P${id}`;
    this.joined = false;   // 이름을 넣고 대기실에 들어왔는가 — 첫 화면만 열어 둔 접속은 판에 끼우지 않는다
    this.classId = 'default';
    this.ready = false;

    this.role = null;
    this.loadout = null;
    this.state = PSTATE.SPECTATING;
    this.hp = 0;
    this.maxHp = 0;

    this.pos = [0, 0, 0];
    this.yaw = 0;
    this.pitch = 0;
    this.mv = 0;           // 이동 플래그 비트 (애니메이션용)
    this.mvPulse = 0;      // 방송 사이에 한 번이라도 켜졌던 짧은 비트 (주먹 FIRE · 점프 AIR) — 아래 설명
    this.seq = 0;

    this.downedAt = 0;
    this.lungeAt = -99;
    this.rageAt = -99;
    this.rageUntil = 0;

    this.lastSeen = now();   // 하트비트용
  }

  send(type, data) {
    if (this.ws.readyState === 1) this.ws.send(encode(type, data));
  }

  /** 다른 사람에게 보여줄 최소 정보 */
  snapshot() {
    return {
      id: this.id, p: this.pos.map((v) => +v.toFixed(2)),
      y: +this.yaw.toFixed(3), pi: +this.pitch.toFixed(3),
      mv: this.mv | this.mvPulse, hp: Math.round(this.hp), mhp: this.maxHp, st: this.state,
    };
  }

  lobbyInfo() {
    return { id: this.id, name: this.name, classId: this.classId, ready: this.ready };
  }
}

function broadcast(type, data) {
  const msg = encode(type, data);
  for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
}

// ---------------------------------------------------------------- 라운드

function survivors() {
  return everyone().filter((p) => p.role === 'survivor' && p.state !== PSTATE.SPECTATING);
}
function theZombie() {
  return everyone().find((p) => p.role === 'zombie');
}

function sendLobby() {
  broadcast(S.LOBBY, {
    // 라운드 중에도 입·퇴장 때문에 이 메시지가 나간다. 클라이언트가 메뉴를
    // 띄울지 판단하려면 지금 서버가 어느 단계인지 알아야 한다.
    phase: game.phase,
    players: joinedPlayers().map((p) => p.lobbyInfo()),
    // 누가 연습 중이어도 게임 시작은 된다 — 수락 확인이 연습하는 사람에게도 뜨고, 전원 수락하면 연습을 끝내고 시작한다
    canStart: joinedPlayers().length >= ROUND.minPlayers && !game.check && (game.phase === PHASE.LOBBY || (game.phase === PHASE.PLAYING && game.practice)),
    practiceBy: game.phase === PHASE.PLAYING && game.practice ? joinedPlayers().filter((q) => q.role).map((q) => q.name).join(', ') : '',
    // 연습은 혼자서도 된다
    canPractice: joinedPlayers().length >= 1 && game.phase === PHASE.LOBBY && !game.check,
  });
}

/**
 * 라운드 시작.
 *
 * @param opts.practice  연습 모드 — 혼자서도 시작되고, 승패로 끊기지 않는다
 * @param opts.role      연습 모드에서 내가 맡을 역할
 * @param opts.classId   연습 모드 생존자 직업 (default=총수, archer=사냥꾼)
 * @param opts.dummies   세워둘 더미 수
 * @param opts.behavior  더미 행동 (still | chase | flee)
 * @param opts.starter   연습 모드를 요청한 플레이어
 */
function startRound(opts = {}) {
  bots.clear();

  const practice = !!opts.practice;
  // 연습은 누른 사람 혼자 — 대기실에 있던 다른 사람은 끌려 들어가지 않는다
  const list = practice ? [opts.starter ?? joinedPlayers()[0]].filter(Boolean) : joinedPlayers();
  if (!practice && list.length < ROUND.minPlayers) return;
  if (!list.length) return;

  let zombie;
  if (practice) {
    // 역할을 직접 고른다. 좀비를 골랐으면 사람이 좀비, 아니면 더미가 좀비.
    const me = opts.starter ?? list[0];
    zombie = opts.role === 'zombie' ? me : null;
  } else {
    // 직전 좀비는 빼고 뽑는다. 다 같은 사람이면 어쩔 수 없이 포함.
    let pool = list.filter((p) => p.id !== game.lastZombieId);
    if (!pool.length) pool = list;
    zombie = pool[Math.floor(Math.random() * pool.length)];
    game.lastZombieId = zombie.id;
  }

  // 연습 모드: 내 반대 역할로 더미를 세운다
  if (practice) {
    const myRole = opts.role === 'zombie' ? 'zombie' : 'survivor';
    const dummyRole = myRole === 'zombie' ? 'survivor' : 'zombie';
    const n = Math.max(0, Math.min(6, opts.dummies ?? 2));
    // 생존자 더미는 공격적/쫓아옴 불가 — 플레이어(좀비)한테 달려오면 안 되니까
    const allowed = dummyRole === 'zombie'
      ? Object.values(BOT_BEHAVIOR)
      : [BOT_BEHAVIOR.STILL, BOT_BEHAVIOR.FLEE];
    const behavior = allowed.includes(opts.behavior)
      ? opts.behavior
      : (dummyRole === 'zombie' ? BOT_BEHAVIOR.HUNT : BOT_BEHAVIOR.STILL);
    // 배치: 좀비로 연습하면 플레이어는 크레인 아래 중앙, 생존자 더미는 생존자
    // 스폰 자리(SURVIVOR_SPAWNS)에 선다. 생존자로 연습하면 플레이어는 생존자 스폰,
    // 좀비 더미는 중앙을 가로지르는 줄(z=0 — 크레인 다리 z=±6 사이라 비어 있다)에 선다.
    for (let i = 0; i < n; i++) {
      const b = new Bot(nextId++, dummyRole, i, BOXES, behavior);
      let hx, hz;
      if (dummyRole === 'survivor') {
        // 좀비 연습 — 생존자 더미는 생존자 스폰 자리(플레이어는 중앙)
        const s = SURVIVOR_SPAWNS[i % SURVIVOR_SPAWNS.length];
        hx = s.x;
        hz = s.z;
      } else {
        // 생존자 연습 — 좀비 더미는 중앙을 가로지르는 라인
        hx = (i - (n - 1) / 2) * 2.5;
        hz = 0;
      }
      const [cx, cz] = clearSpawn(hx, hz, BOXES);
      b.home = [cx, cz];
      b.pos = [cx, 0, cz];
      bots.set(b.id, b);
    }
    if (dummyRole === 'zombie' && bots.size) zombie = [...bots.values()][0];
  }

  const survCount = Math.max(1, everyone().length - 1);

  // 연습 모드: 메뉴에서 고른 직업(총수/사냥꾼)을 시작하는 플레이어에 적용한다.
  // 로비 직업 선택과 같은 필드(p.classId)라서 이후 로비 표시도 일치한다.
  if (practice && opts.role !== 'zombie' && isSelectableClass(opts.classId)) {
    (opts.starter ?? list[0]).classId = opts.classId;
  }

  list.forEach((p, i) => {
    p.role = practice
      ? (opts.role === 'zombie' ? 'zombie' : 'survivor')
      : (p === zombie ? 'zombie' : 'survivor');
    p.loadout = resolveLoadout(p.role, p.classId, survCount);
    p.maxHp = p.loadout.maxHp;
    p.hp = p.maxHp;
    p.state = PSTATE.ALIVE;
    p.downedAt = 0;
    p.lungeAt = -99;
    p.rageAt = -99;
    p.rageUntil = 0;
    // 좀비는 크레인 아래 중앙, 생존자는 맵 곳곳의 스폰 자리 (연습 · 정식 같다)
    p.pos = spawnPoint(p.role, i, list.length);
  });

  const t = now();
  game.phase = PHASE.PLAYING;
  game.practice = practice;
  // 연습 모드도 좀비 5초 묶임(정식 라운드와 같게)으로 시작하고, 시간 제한은 길게
  game.startAt = t + ROUND.zombieHoldSec;
  game.endAt = t + (practice ? ROUND.lengthSec * 8 : ROUND.zombieHoldSec + ROUND.lengthSec);
  game.result = null;

  // 탄약상자 — 시작 시 비어 있고, tick 이 일정 시간마다 하나씩 스폰시킨다
  game.ammoBoxes = [];
  game.ammoNextSpawnAt = t + AMMO_SPAWN_INTERVAL;

  // 직업까지 보내야 남의 화면에서 총수/사냥꾼 모델이 갈린다
  const roles = everyone().map((q) => ({ id: q.id, role: q.role, bot: !!q.isBot, classId: q.classId }));

  for (const p of players.values()) {
    if (!list.includes(p)) continue;   // 판에 안 낀 사람(첫 화면 · 대기실에서 기다리는 사람)은 대기실에 남는다
    p.send(S.ROUND, {
      phase: game.phase, practice,
      startAt: game.startAt, endAt: game.endAt, serverNow: t,
      you: { role: p.role, classId: p.classId, loadout: p.loadout, spawn: p.pos },
      roles,
    });
  }

  if (practice) {
    log(`연습 모드 — ${list[0].name} = ${list[0].role}, 더미 ${bots.size}기 (${opts.behavior ?? 'still'})`);
  } else {
    log(`라운드 시작 — 좀비: ${zombie.name} (생존자 ${survCount}명)`);
  }
}

/**
 * 스폰 자리 — 좀비는 크레인 아래 한가운데, 생존자는 맵 곳곳에 한 사람 한 자리
 * (shared/map.js 의 SURVIVOR_SPAWNS). 목록은 인접한 번호끼리 서로 멀게 엇갈려 있다.
 * 좀비가 여럿이면 가운데에 겹치지 않게 조금씩 비켜 선다.
 */
function spawnPoint(role, i) {
  const s = role === 'zombie'
    ? { x: ZOMBIE_SPAWN.x + (i % 3 - 1) * 1.5, z: ZOMBIE_SPAWN.z }
    : SURVIVOR_SPAWNS[i % SURVIVOR_SPAWNS.length];
  // 맵을 고치다가 스폰이 벽에 겹쳐도 갇히지 않게 밀어낸다
  const [cx, cz] = clearSpawn(s.x, s.z, BOXES);
  return [cx, 0, cz];
}

/**
 * 탄약상자 하나를 빈 후보 지점에 스폰한다.
 * 이미 최대 수(AMMO_BOX_COUNT)가 바닥에 있으면 스킵한다.
 * 권총/소총 타입을 랜덤으로 정해 클라이언트가 색상과 주워갈 무기로 쓴다.
 */
function spawnAmmoBox() {
  if (game.ammoBoxes.length >= AMMO_BOX_COUNT) return;
  const used = new Set(game.ammoBoxes.map((b) => b.i));
  const free = AMMO_SPOTS.map((_, i) => i).filter((i) => !used.has(i));
  if (!free.length) return;
  const i = free[Math.floor(Math.random() * free.length)];
  const s = AMMO_SPOTS[i];
  const box = { i, x: s.x, z: s.z, type: Math.random() < 0.5 ? 'pistol' : 'rifle' };
  game.ammoBoxes.push(box);
  broadcast(S.EVENT, { kind: 'ammoSpawn', i: box.i, x: box.x, z: box.z, type: box.type });
  log(`탄약상자 스폰 — ${box.type} (지점 ${i})`);
}

function endRound(winner, reason) {
  game.ammoBoxes = [];   // 라운드 종료 — 바닥의 탄약상자 전부 치운다
  game.ammoNextSpawnAt = 0;
  game.phase = PHASE.ENDED;
  game.result = { winner, reason };
  game.endAt = now() + ROUND.intermissionSec;
  broadcast(S.EVENT, { kind: 'end', winner, reason });
  log(`라운드 종료 — ${winner} 승 (${reason})`);
}

function toLobby() {
  game.phase = PHASE.LOBBY;
  game.practice = false;
  game.ammoBoxes = [];
  game.ammoNextSpawnAt = 0;
  bots.clear();
  for (const p of players.values()) {
    p.role = null;
    p.loadout = null;
    p.state = PSTATE.SPECTATING;
    p.ready = false;
  }
  sendLobby();
}

// ---------------------------------------------------------------- 틱

function beingRevived(p) {
  for (const q of survivors()) {
    if (q === p || q.state !== PSTATE.ALIVE || !(q.mv & MV.USE)) continue;
    const dx = q.pos[0] - p.pos[0], dz = q.pos[2] - p.pos[2];
    if (dx * dx + dz * dz < 2.6 * 2.6) return true;
  }
  return false;
}

function tick(dt) {
  const t = now();

  if (game.phase === PHASE.ENDED) {
    if (t >= game.endAt) toLobby();
    return;
  }
  if (game.check && t >= game.check.until) cancelCheck('timeout');
  if (game.phase !== PHASE.PLAYING) return;

  const z = theZombie();

  // 좀비 자연 회복
  if (z && z.state === PSTATE.ALIVE) {
    const regen = t < z.rageUntil ? CFG.BASE.zombie.rageRegen : z.loadout.regen;
    z.hp = Math.min(z.maxHp, z.hp + regen * dt);
  }

  // 탄약상자 — 일정 시간마다 빈 자리에 하나씩 스폰 (연습 모드 포함)
  if (t >= game.ammoNextSpawnAt) {
    game.ammoNextSpawnAt = t + AMMO_SPAWN_INTERVAL;
    spawnAmmoBox();
  }

  // 쓰러진 생존자 출혈 (더미는 알아서 되살아나므로 제외)
  for (const p of survivors()) {
    if (p.isBot || p.state !== PSTATE.DOWNED) continue;
    // CPR 을 받는 동안은 출혈이 멈춘다 (F 를 누르고 옆에 있는 생존자가 있으면)
    if (beingRevived(p)) { p.downedAt += dt; continue; }
    const bled = t - p.downedAt;
    if (bled >= p.loadout.downedBleedSec) {
      p.state = PSTATE.DEAD;
      p.hp = 0;
      broadcast(S.EVENT, { kind: 'kill', id: p.id, by: 'bleed' });
    }
  }

  // 더미 이동 · 리스폰
  if (bots.size) {
    const humans = [...players.values()].filter((p) => p.state !== PSTATE.SPECTATING);
    for (const b of bots.values()) stepBot(b, humans, BOXES, dt, t, 3, Math.max(0, game.startAt - t));
  }

  // 좀비 더미의 공격 — 쫓거나 사냥하는(chase/hunt) 더미만 붙으면 때린다.
  // still 은 과녁이라 안 친다. 사람 좀비처럼 **먼저 휘두르고(attack 이벤트) 0.8초 뒤**
  // 데미지가 떨어진다 — 예전엔 거리만 닿으면 모션 없이 즉시 데미지가 들어가서
  // "펀치도 전에 맞는다" 로 보였다. 0.8초는 클라이언트 타격 시각(IMPACT_AT)과 같다.
  if (bots.size && t >= game.startAt) {
    for (const b of bots.values()) {
      if (b.role !== 'zombie' || b.state !== PSTATE.ALIVE) continue;
      if (b.behavior !== BOT_BEHAVIOR.CHASE && b.behavior !== BOT_BEHAVIOR.HUNT) continue;
      if (b.pos[1] > 0) continue;                       // 공중(슈퍼점프)에선 안 친다

      // 휘두른 스윙이 아직 날아가고 있다면 그 타이밍에 데미지를 적용한다
      if (b.pendingHit) {
        if (t >= b.pendingHit.at) {
          applyHit(b, { target: b.pendingHit.target, dmg: b.pendingHit.dmg, head: false });
          b.pendingHit = null;
          b.lastAttackAt = t;
        }
        continue;
      }
      if (t - (b.lastAttackAt ?? -99) < 0.8) continue;  // 사람 좀비 주먹과 같은 간격
      let victim = null, bestD = Infinity;
      for (const h of players.values()) {
        if (h.role === 'zombie') continue;
        if (h.state !== PSTATE.ALIVE && h.state !== PSTATE.DOWNED) continue;
        const d = Math.hypot(h.pos[0] - b.pos[0], h.pos[2] - b.pos[2]);
        if (d <= b.loadout.weapon.range && d < bestD) { bestD = d; victim = h; }
      }
      if (!victim) continue;
      // 스윙을 먼저 알리고, 0.8초(타격 시각) 뒤에 데미지를 적용한다
      b.pendingHit = { target: victim.id, dmg: b.loadout.weapon.dmg, at: t + 0.8 };
      broadcast(S.EVENT, { kind: 'attack', id: b.id });
    }
  }

  // 연습 모드는 승패로 끊지 않는다 — 계속 돌아다니며 감을 잡는 게 목적이다
  if (game.practice) {
    if (t >= game.endAt) return endRound('survivor', '연습 시간 종료');
    return;
  }

  // 승패
  const alive = survivors().filter((p) => p.state === PSTATE.ALIVE || p.state === PSTATE.DOWNED);
  if (!alive.length) return endRound('zombie', '생존자 전멸');
  if (z && z.state === PSTATE.DEAD) return endRound('survivor', '좀비 처치');
  if (t >= game.endAt) return endRound('survivor', '시간 초과');
}

function broadcastState() {
  const t = now();
  const snap = {
    now: +t.toFixed(3),
    phase: game.phase,
    left: game.phase === PHASE.PLAYING ? Math.max(0, +(game.endAt - t).toFixed(1)) : 0,
    hold: game.phase === PHASE.PLAYING ? Math.max(0, +(game.startAt - t).toFixed(1)) : 0,
    players: everyone()
      .filter((p) => p.state !== PSTATE.SPECTATING)
      .map((p) => p.snapshot()),
  };
  broadcast(S.STATE, snap);
  for (const p of players.values()) p.mvPulse = 0;
}

setInterval(() => {
  try {
    tick(1 / TICK_HZ);
    broadcastState();
  } catch (e) {
    console.error('tick error:', e);   // 한 틱이 터져도 서버는 계속 돈다
  }
}, 1000 / TICK_HZ);

// 하트비트.
//
// TCP 연결이 조용히 죽으면 close 이벤트가 안 온다. 그대로 두면 유령
// 플레이어가 슬롯을 차지하고, 심하면 좀비로 뽑혀서 라운드가 멈춘다.
// (실제로 새로고침을 반복하다 유령이 하나 남은 적이 있다)
const PING_SEC = 5;
const TIMEOUT_SEC = 20;

setInterval(() => {
  const t = now();
  for (const p of [...players.values()]) {
    if (t - p.lastSeen > TIMEOUT_SEC) {
      log(`${p.name} 응답 없음 — 연결을 끊습니다`);
      try { p.ws.terminate(); } catch { /* 이미 죽은 소켓 */ }
      continue;
    }
    try { p.ws.ping(); } catch { /* 다음 주기에 정리된다 */ }
  }
}, PING_SEC * 1000);

// ---------------------------------------------------------------- 메시지

function onMessage(p, m) {
  switch (m.t) {
    case C.JOIN: {
      if (!p.joined && joinedPlayers().length >= NET.maxPlayers) {
        p.send(S.ERROR, { text: '서버가 가득 찼습니다.' });
        break;
      }
      p.name = String(m.name ?? '').trim().slice(0, NET.nameMaxLen) || `P${p.id}`;
      p.joined = true;
      log(`${p.name} 입장 (${p.ip}) — 대기실 ${joinedPlayers().length}명`);
      sendLobby();
      break;
    }

    case C.PICK: {
      // 직업 선택. 라운드 중에는 못 바꾼다.
      if (game.phase !== PHASE.LOBBY) return p.send(S.ERROR, { text: '라운드 중에는 직업을 바꿀 수 없습니다.' });
      if (!isSelectableClass(m.classId)) return p.send(S.ERROR, { text: '없는 직업입니다.' });
      p.classId = m.classId;
      sendLobby();
      break;
    }

    case C.READY: {
      p.ready = !!m.ready;
      sendLobby();
      break;
    }

    case C.START: {
      if (game.check || !p.joined) return;
      const practicing = game.phase === PHASE.PLAYING && game.practice;
      if (game.phase !== PHASE.LOBBY && !(practicing && !m.practice)) return;
      if (m.practice) {
        startRound({
          practice: true, starter: p,
          role: m.role === 'zombie' ? 'zombie' : 'survivor',
          classId: m.classId,   // 연습 메뉴에서 고른 직업 (총수/사냥꾼)
          dummies: m.dummies, behavior: m.behavior,
        });
      } else {
        // 바로 시작하지 않고 대기실 전원에게 수락을 묻는다. 누른 사람은 수락한 걸로 친다
        const list = joinedPlayers();
        if (list.length < ROUND.minPlayers) return;
        game.check = { until: now() + CHECK_SEC, ids: new Set(list.map((q) => q.id)), accepted: new Set([p.id]) };
        log(`수락 확인 시작 — ${p.name} · ${list.length}명`);
        sendCheck();
        sendLobby();
      }
      break;
    }

    case C.ACCEPT: {
      const c = game.check;
      if (!c || !c.ids.has(p.id)) return;
      if (!m.ok) { cancelCheck('declined', p); return; }
      c.accepted.add(p.id);
      if (c.accepted.size < c.ids.size) { sendCheck(); return; }
      game.check = null;
      broadcast(S.EVENT, { kind: 'check', done: true });
      if (game.phase === PHASE.PLAYING && game.practice) { log('연습을 끝내고 게임 시작'); toLobby(); }
      startRound();
      break;
    }

    case C.INPUT: {
      if (p.state === PSTATE.SPECTATING || p.state === PSTATE.DEAD) return;
      if (!Array.isArray(m.p) || m.p.length !== 3) return;
      if (typeof m.seq === 'number' && m.seq <= p.seq) return;   // 늦게 도착한 건 버린다
      p.seq = m.seq ?? p.seq + 1;
      p.pos = m.p.map(Number);
      p.yaw = Number(m.yaw) || 0;
      p.pitch = Number(m.pitch) || 0;
      p.mv = m.mv | 0;
      // 입력(20Hz)과 방송(20Hz)은 박자가 안 맞는다. 인터넷에선 입력 둘이 방송 사이에 몰려 오기도 해서,
      // 0.1초짜리 클릭(FIRE)이나 짧은 점프(AIR)가 다음 입력에 덮여 남의 화면에 아예 안 보였다.
      // 방송 전까지 한 번이라도 켜진 건 모아서 보낸다 (방송 뒤에 비운다)
      p.mvPulse |= p.mv & (MV.FIRE | MV.AIR);
      break;
    }

    case C.HIT: {
      if (game.phase !== PHASE.PLAYING) return;
      if (now() < game.startAt && p.role === 'zombie') return;  // 구속 시간
      if (p.role === 'zombie') {
        // 주먹은 모션 길이(0.8초)보다 빠르게 들어오면 무시한다 —
        // 클라이언트가 모션을 끊어서 연타할 수 없도록 서버도 막는다.
        if (now() - (p.punchAt ?? -99) < 0.8) return;
        p.punchAt = now();
      }
      applyHit(p, m);
      break;
    }

    case C.ACTION: {
      handleAction(p, m);
      break;
    }

    case C.CHAT: {
      const text = String(m.text ?? '').slice(0, 120);
      if (text) broadcast(S.EVENT, { kind: 'chat', id: p.id, name: p.name, text });
      break;
    }
  }
}

function applyHit(shooter, m) {
  const target = findEntity(m.target | 0);
  if (!target || target === shooter) return;
  if (target.state === PSTATE.DEAD || target.state === PSTATE.SPECTATING) return;
  if (shooter.role === target.role) return;       // 같은 편은 안 맞는다
  if (target.role === 'zombie' && now() < game.startAt) return; // 묶여 있을 때 무적

  // 서버는 사거리와 데미지 상한만 본다.
  const d = dist(shooter.pos, target.pos);
  if (d > Math.min(NET.maxHitRange, shooter.loadout.weapon.range + 3)) return;
  const dmg = Math.min(Number(m.dmg) || 0, NET.maxDmgPerHit);
  if (dmg <= 0) return;

  if (target.state === PSTATE.DOWNED) {
    // 쓰러진 사람을 때리면 출혈이 빨라진다 — 즉사는 아니다.
    target.downedAt -= 4;
    broadcast(S.EVENT, { kind: 'hit', id: target.id, by: shooter.id, downed: true });
    return;
  }

  target.hp -= dmg;
  broadcast(S.EVENT, { kind: 'hit', id: target.id, by: shooter.id, head: !!m.head, dmg });

  if (target.hp > 0) return;

  if (target.role === 'survivor') {
    // 생존자는 바로 죽지 않고 쓰러진다.
    target.hp = 0;
    target.state = PSTATE.DOWNED;
    target.downedAt = now();
    broadcast(S.EVENT, { kind: 'down', id: target.id, by: shooter.id });
  } else {
    target.hp = 0;
    target.state = PSTATE.DEAD;
    broadcast(S.EVENT, { kind: 'kill', id: target.id, by: shooter.id });
  }
}

function handleAction(p, m) {
  // 연습 끝내기는 쓰러져 있어도 돼야 한다
  if (m.kind === 'endPractice') {
    if (game.practice) { log(`${p.name} 연습 종료`); toLobby(); }
    return;
  }

  if (game.phase !== PHASE.PLAYING || p.state !== PSTATE.ALIVE) return;
  const t = now();

  switch (m.kind) {
    case 'fire': {
      // 총성 · 총알선. 생존자만 쏠 수 있고, 총구는 내 위치에서 100m 안에
      // 있어야 한다. 12/s 제한으로 스팸을 막는다.
      if (p.role !== 'survivor') return;
      if (t - (p.fireAt ?? -99) < 1 / 12) return;
      p.fireAt = t;
      const f = Array.isArray(m.from) ? m.from : [];
      const o = Array.isArray(m.to) ? m.to : [];
      if (f.length !== 3 || o.length !== 3) return;
      if (![...f, ...o].every(Number.isFinite)) return;
      if (dist(p.pos, f) > 100 || dist(f, o) > 100) return;
      broadcast(S.EVENT, {
        kind: 'fire', id: p.id,
        // 활이면 클라이언트가 총성이 아니라 시위 소리를 내도록
        bow: p.loadout?.weapon?.id === 'bow',
        // 활 장전량 — 상대 화면에서 화살이 같은 속도로 날아가도록
        c: Math.max(0, Math.min(1, Number(m.c) || 0)),
        from: f.map((v) => +v.toFixed(2)),
        to: o.map((v) => +v.toFixed(2)),
      });
      break;
    }
    case 'emote': {
      // 춤 — 다른 사람 화면에서도 추게 그대로 알린다. 살아 있을 때만
      const n = Math.round(Number(m.n));
      if (p.state !== PSTATE.ALIVE || !(n >= 1 && n <= 3)) return;
      broadcast(S.EVENT, { kind: 'emote', id: p.id, n });
      break;
    }

    case 'reload': {
      // 재장전 모션만 중계한다 (탄약은 각자 클라이언트가 센다). 걸리는 시간을
      // 같이 보내야 상대 화면에서도 모션이 재장전이 끝나는 순간에 끝난다.
      if (p.role !== 'survivor') return;
      if (t - (p.reloadAt ?? -99) < 0.5) return;
      p.reloadAt = t;
      broadcast(S.EVENT, { kind: 'reload', id: p.id, sec: Math.max(0.3, Math.min(5, Number(m.sec) || 2)) });
      break;
    }
    case 'pickup': {
      // 탄약상자 주우기. 생존자만, 상자 반경 안에 있어야 한다.
      if (p.role !== 'survivor') return;
      const bi = Number(m.box);
      if (!Number.isInteger(bi)) return;
      const idx = game.ammoBoxes.findIndex((b) => b.i === bi);
      if (idx < 0) return;
      const box = game.ammoBoxes[idx];
      if (dist(p.pos, [box.x, 0, box.z]) > AMMO_PICKUP_RADIUS) return;
      game.ammoBoxes.splice(idx, 1);
      broadcast(S.EVENT, { kind: 'pickup', box: box.i, id: p.id });
      break;
    }
    case 'lunge': {
      if (p.role !== 'zombie') return;
      if (t - p.lungeAt < CFG.BASE.zombie.lungeCooldown) return;
      if (p.hp <= CFG.BASE.zombie.lungeCostHp) return;
      p.lungeAt = t;
      p.hp -= CFG.BASE.zombie.lungeCostHp;
      broadcast(S.EVENT, { kind: 'lunge', id: p.id });
      break;
    }
    case 'rage': {
      if (p.role !== 'zombie') return;
      if (t - p.rageAt < CFG.BASE.zombie.rageCooldown) return;
      p.rageAt = t;
      p.rageUntil = t + CFG.BASE.zombie.rageSec;
      broadcast(S.EVENT, { kind: 'rage', id: p.id, until: p.rageUntil });
      break;
    }
    case 'slam': {
      // 슈퍼점프 착지 충격. 반경 안의 생존자 전부에게, 거리에 따라 깎아서.
      if (p.role !== 'zombie') return;
      const Z = CFG.BASE.zombie;
      if (t - (p.slamAt ?? -99) < Z.slamCooldown) return;
      p.slamAt = t;

      // 착지 모션 재생 속도는 순수 클라이언트 표현. 충전량(0..1)만
      // 검증해서 그대로 전달한다.
      const charge = Math.max(0, Math.min(1, +m.charge || 0));

      const hits = [];
      const dodged = [];   // 착지 순간 공중이던 생존자 — 점프로 회피 성공
      for (const s of survivors()) {
        if (s.state !== PSTATE.ALIVE) continue;
        // 반경은 수평으로 잰다 — 3D 거리면 컨테이너 · 트럭 위의 생존자가 높이만큼 반경 밖으로 빠졌다.
        // 위아래로는 SLAM_REACH_Y 안이면 맞는다 (2단 컨테이너 위 · 아래 모두)
        const d = Math.hypot(p.pos[0] - s.pos[0], p.pos[2] - s.pos[2]);
        if (d > Z.slamRadius || Math.abs(p.pos[1] - s.pos[1]) > SLAM_REACH_Y) continue;

        if (s.mv & MV.AIR) { dodged.push(s.id); continue; }

        // 중심은 온전히, 가장자리는 slamMinMul 까지 줄어든다
        const k = 1 - (d / Z.slamRadius) * (1 - Z.slamMinMul);
        const dmg = Z.slamDmg * k;
        s.hp -= dmg;
        hits.push({ id: s.id, dmg: Math.round(dmg) });

        if (s.hp <= 0) {
          s.hp = 0;
          s.state = PSTATE.DOWNED;
          s.downedAt = t;
          broadcast(S.EVENT, { kind: 'down', id: s.id, by: p.id });
        }
      }
      // 반경을 모두에게 알려 바닥 충격파를, 충전량은 착지 모션 속도로,
      // 회피 성공자는 그 화면에 "회피 성공" 이 뜨게
      broadcast(S.EVENT, {
        kind: 'slam', id: p.id, at: p.pos.map((v) => +v.toFixed(2)),
        radius: Z.slamRadius, hits, charge, dodged,
      });
      break;
    }

    case 'revive': {
      // 일으키기 완료 보고. 거리만 확인한다.
      if (p.role !== 'survivor') return;
      const target = findEntity(m.target | 0);
      if (!target || target.state !== PSTATE.DOWNED) return;
      if (dist(p.pos, target.pos) > 3) return;
      target.state = PSTATE.ALIVE;
      target.hp = target.maxHp * 0.5;
      broadcast(S.EVENT, { kind: 'revive', id: target.id, by: p.id });
      break;
    }
  }
}

const SLAM_REACH_Y = 6;   // 슈퍼점프 착지 충격이 닿는 위아래 높이 (m)

function dist(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------- HTTP + WS

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const httpServer = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';

  // [debug] 클라이언트 런타임 에러 수집 — 임시 진단 코드. 원인을 찾으면 지운다.
  // 공개 서버(NODE_ENV=production)에선 끈다 — 아무나 디스크를 채울 수 있다
  if (path === '/__debug/capture' && req.method === 'POST' && process.env.NODE_ENV !== 'production') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      appendFile(join(ROOT, 'debug-capture.log'), body + '\n').catch(() => {});
      res.writeHead(204).end();
    });
    return;
  }

  const full = join(DIST, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  if (full !== DIST && !full.startsWith(DIST + sep)) { res.writeHead(403).end(); return; }

  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    const ext = extname(full).toLowerCase();

    // 해시가 박힌 빌드 산출물은 영구 캐시, 나머지는 매번 확인.
    // (프로토타입의 `no-store` 때문에 접속할 때마다 에셋을 전부 다시 받던 문제)
    const immutable = full.includes('assets') && /-[A-Za-z0-9_]{8,}\./.test(full);

    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(await readFile(full));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

// 메시지 하나는 많아야 수백 바이트 — 기본값(100MB)이면 큰 메시지 몇 개로 서버 메모리(1GB)를 채울 수 있다
const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024 });
const MSG_PER_SEC = 150;   // 정상 클라이언트는 위치 20Hz + 행동 몇 개. 이걸 넘기면 폭주(공격)로 보고 끊는다

wss.on('connection', (ws, req) => {
  // 첫 화면만 열어 둔 접속도 자리를 잡으므로 넉넉하게. 판에 끼는 인원은 JOIN 에서 maxPlayers 로 막는다
  if (players.size >= NET.maxPlayers * 3) {
    ws.send(encode(S.ERROR, { text: '서버가 가득 찼습니다.' }));
    ws.close();
    return;
  }

  // Caddy(같은 서버) 뒤에 있으면 진짜 주소는 X-Forwarded-For 에 온다. 바깥에서 온 이 헤더는 믿지 않는다
  const remote = req.socket.remoteAddress ?? '?';
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = fwd && /^(::ffff:)?127.0.0.1$|^::1$/.test(remote) ? fwd : remote;
  const p = new Player(nextId++, ws, ip);
  players.set(p.id, p);
  log(`접속 P${p.id} (${ip}) — 연결 ${players.size}개`);

  p.send(S.WELCOME, {
    id: p.id,
    config: { TICK_HZ, ROUND, WORLD: CFG.WORLD, BASE: CFG.BASE, NET },
    classes: selectableClasses(),
  });
  sendLobby();

  ws.on('pong', () => { p.lastSeen = now(); });

  let msgSec = 0, msgCount = 0;
  ws.on('message', (raw) => {
    p.lastSeen = now();
    const sec = Math.floor(p.lastSeen);
    if (sec !== msgSec) { msgSec = sec; msgCount = 0; }
    if (++msgCount > MSG_PER_SEC) { ws.terminate(); return; }
    const m = decode(raw.toString());
    if (m) { try { onMessage(p, m); } catch (e) { console.error('msg error:', e); } }
  });

  ws.on('close', () => {
    players.delete(p.id);
    if (game.check?.ids.has(p.id)) cancelCheck('left', p);
    log(`${p.name} 퇴장 (${p.ip}) — 대기실 ${joinedPlayers().length}명`);

    if (game.phase !== PHASE.PLAYING) { sendLobby(); return; }

    if (game.practice) {
      // 연습하던 사람이 나가면 정리한다 (대기실에서 기다리던 사람은 그대로)
      if (!joinedPlayers().some((q) => q.role)) toLobby();
      else sendLobby();
    } else if (p.role === 'zombie') {
      endRound('survivor', '좀비가 나감');
    } else if (joinedPlayers().length < ROUND.minPlayers) {
      endRound('survivor', '인원 부족');
    } else {
      sendLobby();
    }
  });

  ws.on('error', () => {});
});

httpServer.listen(PORT, '0.0.0.0', () => {
  log(`게임 서버 :${PORT}  (ws://…/ws)`);
  log(`정적 파일: ${DIST}  — 개발 중에는 Vite(5173)를 쓰세요`);
});
