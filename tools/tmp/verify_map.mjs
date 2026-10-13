// 임시 확인용 — 새 맵(shared/map.js)이 규칙을 지키는지 숫자로 본다.
//   1) 좁은 틈: 바닥에 선 박스끼리(바깥 벽 포함) 0 < 틈 < 1.0m 이면 생존자(지름 0.7)만
//      지나가는 안전지대가 된다 → 경고. 0 이면 붙어 있음(괜찮다).
//   2) 스폰 · 탄약 지점이 박스 속이거나 경계 밖이 아닌지
//   3) 생존자가 오를 수 있는 높은 곳: 점프(1.18m)로 닿는 면에서 다시 닿는 면을 따라간다
//   4) 연습 봇: 좀비 더미가 각 생존자 스폰까지 쫓아가 닿는지 (돌아가기 포함)
import { WORLD, BASE } from '../../shared/config.js';
import {
  buildBoxes, insideBox, SURVIVOR_SPAWNS, ZOMBIE_SPAWN, AMMO_SPOTS, HALF_X, HALF_Z, clampToArena,
} from '../../shared/map.js';
import { Bot, BOT_BEHAVIOR, stepBot } from '../../server/bots.js';
import { PSTATE } from '../../shared/protocol.js';

const boxes = buildBoxes();
let bad = 0;
const warn = (m) => { bad++; console.log('  ✗ ' + m); };
const name = (b) => `${b.kind}(${b.x},${b.z} ${b.w}×${b.d}×${b.h})`;

console.log(`박스 ${boxes.length}개 · 맵 ${WORLD.arenaX}×${WORLD.arenaZ}`);

// ── 1) 좁은 틈 ──
console.log('\n[1] 좁은 틈 (0 < 틈 < 1.0m)');
const floorBoxes = boxes.filter((b) => (b.y ?? 0) < 2.2 && b.h >= 0.5);
const lo = (b) => [b.x - b.w / 2, b.z - b.d / 2];
const hi = (b) => [b.x + b.w / 2, b.z + b.d / 2];
for (let i = 0; i < floorBoxes.length; i++) {
  for (let j = i + 1; j < floorBoxes.length; j++) {
    const a = floorBoxes[i], b = floorBoxes[j];
    const [ax0, az0] = lo(a), [ax1, az1] = hi(a), [bx0, bz0] = lo(b), [bx1, bz1] = hi(b);
    const gx = Math.max(bx0 - ax1, ax0 - bx1);   // >0 이면 x 로 떨어짐
    const gz = Math.max(bz0 - az1, az0 - bz1);
    // 마주 보는 면이 겹쳐야 '틈'이다 (대각선 모서리는 넓게 열린다)
    let gap = null;
    if (gx > 0 && gz < 0) gap = gx;
    else if (gz > 0 && gx < 0) gap = gz;
    else if (gx > 0 && gz > 0) gap = Math.hypot(gx, gz);
    if (gap === null || gap <= 0.001 || gap >= 1.0) continue;
    // 틈 한가운데를 다른 박스(계단 같은)가 메우고 있으면 틈이 아니다
    const mx = gx > 0 ? (Math.max(ax0, bx0) + Math.min(ax1, bx1)) / 2 : (Math.max(ax0, bx0) + Math.min(ax1, bx1)) / 2;
    const mz = (Math.max(az0, bz0) + Math.min(az1, bz1)) / 2;
    const filled = boxes.some((c) => c !== a && c !== b && Math.abs(mx - c.x) <= c.w / 2 && Math.abs(mz - c.z) <= c.d / 2);
    if (!filled) warn(`${gap.toFixed(2)}m  ${name(a)} ↔ ${name(b)}`);
  }
}
// 겹친 박스(바깥 벽 제외)도 본다 — 의도한 붙임(0)은 괜찮지만 파고들면 표시
for (let i = 0; i < floorBoxes.length; i++) for (let j = i + 1; j < floorBoxes.length; j++) {
  const a = floorBoxes[i], b = floorBoxes[j];
  if (a.kind === 'perimeter' || b.kind === 'perimeter') continue;
  const ox = Math.min(hi(a)[0], hi(b)[0]) - Math.max(lo(a)[0], lo(b)[0]);
  const oz = Math.min(hi(a)[1], hi(b)[1]) - Math.max(lo(a)[1], lo(b)[1]);
  if (ox > 0.01 && oz > 0.01) console.log(`  · 겹침 ${ox.toFixed(2)}×${oz.toFixed(2)}  ${name(a)} ↔ ${name(b)}`);
}

// ── 2) 스폰 · 탄약 ──
console.log('\n[2] 스폰 · 탄약 지점');
const pts = [
  ...SURVIVOR_SPAWNS.map((p, i) => ['생존자' + i, p, WORLD.playerRadius]),
  ['좀비', ZOMBIE_SPAWN, BASE.zombie.radius],
  ...AMMO_SPOTS.map((p, i) => ['탄약' + i, p, 0.6]),
];
for (const [n, p, r] of pts) {
  if (Math.abs(p.x) > HALF_X - 1 || Math.abs(p.z) > HALF_Z - 1) warn(`${n} 경계 밖 (${p.x},${p.z})`);
  if (insideBox(p.x, p.z, boxes, r)) warn(`${n} 박스 속 (${p.x},${p.z})`);
}
// 좀비 스폰에서 각 생존자 스폰까지 직선 거리 (참고)
console.log('  좀비→생존자 스폰 직선거리: ' + SURVIVOR_SPAWNS.map((p) => Math.hypot(p.x - ZOMBIE_SPAWN.x, p.z - ZOMBIE_SPAWN.z).toFixed(0)).join(' · '));

// ── 3) 생존자가 오를 수 있는 높은 곳 ──
console.log('\n[3] 생존자 높은 자리 (점프 1.18m · 턱 0.35m)');
const JUMP = (BASE.survivor.jumpSpeed ** 2) / (2 * -WORLD.gravity);
const near = (a, b, r = 0.8) => {   // 두 박스 윗면이 한 걸음(0.8m) 안에 닿는지
  const gx = Math.max(lo(b)[0] - hi(a)[0], lo(a)[0] - hi(b)[0]);
  const gz = Math.max(lo(b)[1] - hi(a)[1], lo(a)[1] - hi(b)[1]);
  return Math.max(gx, gz, 0) <= r;
};
const reach = new Map();   // 박스 → 서 있는 높이
const top = (b) => (b.y ?? 0) + b.h;
for (const b of boxes) if ((b.y ?? 0) === 0 && top(b) <= JUMP) reach.set(b, top(b));
for (let changed = true; changed;) {
  changed = false;
  for (const b of boxes) {
    if (reach.has(b) || (b.y ?? 0) > 0) continue;
    for (const [a, h] of reach) {
      if (near(a, b) && top(b) <= h + JUMP && top(b) > h) { reach.set(b, top(b)); changed = true; break; }
    }
  }
}
const highest = [...reach].filter(([, h]) => h > 0.5).sort((p, q) => q[1] - p[1]);
for (const [b, h] of highest) console.log(`  ${h.toFixed(2)}m  ${name(b)}`);
if (highest.some(([, h]) => h >= 2.0)) warn('생존자가 2m 넘는 곳에 오른다');
console.log(`  (생존자 점프 ${JUMP.toFixed(2)}m — 컨테이너 2.6m · 선반 3.2m · 트레일러 3.6m 는 못 오른다)`);

// ── 4) 좀비 봇 추격 ──
console.log('\n[4] 좀비 더미(hunt) 가 생존자 스폰까지 닿는지 (최대 40초)');
for (const [i, s] of SURVIVOR_SPAWNS.entries()) {
  const bot = new Bot(1, 'zombie', 0, boxes, BOT_BEHAVIOR.HUNT);
  bot.pos = [ZOMBIE_SPAWN.x, 0, ZOMBIE_SPAWN.z];
  const target = { role: 'survivor', state: PSTATE.ALIVE, pos: [s.x, 0, s.z] };
  const dt = 1 / 20;
  let t = 0, hit = null, path = 0;
  let px = bot.pos[0], pz = bot.pos[2];
  for (; t < 40; t += dt) {
    stepBot(bot, [target], boxes, dt, t, 3, 0);
    path += Math.hypot(bot.pos[0] - px, bot.pos[2] - pz);
    px = bot.pos[0]; pz = bot.pos[2];
    if (Math.hypot(bot.pos[0] - s.x, bot.pos[2] - s.z) < 1.6) { hit = t; break; }
  }
  const d = Math.hypot(s.x - ZOMBIE_SPAWN.x, s.z - ZOMBIE_SPAWN.z);
  const msg = `생존자${i} (${s.x},${s.z}) 직선 ${d.toFixed(0)}m`;
  if (hit === null) warn(`${msg} — 못 닿음, 멈춘 곳 (${bot.pos[0].toFixed(1)}, ${bot.pos[2].toFixed(1)})`);
  else console.log(`  ✓ ${msg} — ${hit.toFixed(1)}초 · 이동 ${path.toFixed(0)}m`);
}

// ── 5) 경계 함수 ──
const [cx, cz] = clampToArena(999, -999);
console.log(`\n[5] clampToArena(999,-999) = (${cx}, ${cz})`);

console.log(bad ? `\n문제 ${bad}개` : '\n문제 없음');
