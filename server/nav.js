// 연습 더미의 길찾기.
//
// 컨테이너 골목은 막다른 곳이 많아서, 목표 쪽으로 곧장 밀기만 하면 컨테이너
// 뒤에 숨은 생존자를 앞에 두고 벽에 붙어 멈춘다. 맵을 0.5m 칸으로 나눠
// 목표 칸에서 거리를 퍼뜨리고(다익스트라), 더미는 거리가 줄어드는 쪽 칸을
// 몇 개 앞까지 따라가 그쪽으로 걷는다.
//
// 칸 크기 0.5m · 맵 80×52 → 16,640칸. 목표가 다른 칸으로 옮겼을 때만
// 0.3초에 한 번 다시 계산한다 (1~2ms).

import { WORLD } from '../shared/config.js';
import { insideBox, HALF_X, HALF_Z } from '../shared/map.js';

const CELL = 0.5;
const MARGIN = 0.1;          // 벽에 너무 바짝 붙는 길은 피한다 (slide 와 같은 반지름 + 여유)
const REPATH_SEC = 0.3;
const LOOKAHEAD = 10;        // 따라갈 칸 수 (5m) — 그 안에서 곧장 보이는 가장 먼 칸으로 간다

const grids = new WeakMap(); // boxes 배열 → 칸 정보

function gridFor(boxes) {
  let g = grids.get(boxes);
  if (g) return g;
  const nx = Math.ceil((HALF_X * 2) / CELL);
  const nz = Math.ceil((HALF_Z * 2) / CELL);
  const free = new Uint8Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = -HALF_X + (ix + 0.5) * CELL;
      const z = -HALF_Z + (iz + 0.5) * CELL;
      free[iz * nx + ix] = insideBox(x, z, boxes, WORLD.playerRadius + MARGIN) ? 0 : 1;
    }
  }
  g = { nx, nz, free };
  grids.set(boxes, g);
  return g;
}

const cellOf = (g, x, z) => {
  const ix = Math.min(g.nx - 1, Math.max(0, Math.floor((x + HALF_X) / CELL)));
  const iz = Math.min(g.nz - 1, Math.max(0, Math.floor((z + HALF_Z) / CELL)));
  return iz * g.nx + ix;
};
const centerOf = (g, c) => [-HALF_X + ((c % g.nx) + 0.5) * CELL, -HALF_Z + (Math.floor(c / g.nx) + 0.5) * CELL];

// 8방향 (대각선은 양옆 칸이 둘 다 비어야 — 모서리를 파고들지 않게)
const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/** 가장 가까운 빈 칸 (벽에 밀려 붙어 있으면 내 칸이 막힌 칸일 수 있다) */
function nearestFree(g, c) {
  if (g.free[c]) return c;
  const cx = c % g.nx, cz = Math.floor(c / g.nx);
  for (let r = 1; r < 6; r++) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= g.nx || z >= g.nz) continue;
      if (g.free[z * g.nx + x]) return z * g.nx + x;
    }
  }
  return -1;
}

/** 목표 칸에서 모든 칸까지의 거리 (못 가는 칸은 Infinity) */
function distanceField(g, goal) {
  const dist = new Float64Array(g.nx * g.nz).fill(Infinity);
  if (goal < 0) return dist;
  // 이진 힙 (칸 번호 · 거리)
  const heap = [];
  const push = (c, d) => {
    heap.push([c, d]);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][1] <= heap[i][1]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][1] < heap[m][1]) m = l;
        if (r < heap.length && heap[r][1] < heap[m][1]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  dist[goal] = 0;
  push(goal, 0);
  while (heap.length) {
    const [c, d] = pop();
    if (d > dist[c]) continue;
    const cx = c % g.nx, cz = Math.floor(c / g.nx);
    for (const [dx, dz, w] of DIRS) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= g.nx || z >= g.nz) continue;
      const n = z * g.nx + x;
      if (!g.free[n]) continue;
      if (dx && dz && (!g.free[cz * g.nx + x] || !g.free[z * g.nx + cx])) continue;
      if (d + w < dist[n]) { dist[n] = d + w; push(n, d + w); }
    }
  }
  return dist;
}

/** 두 점 사이가 빈 칸으로만 이어지는지 (0.25m 마다 확인) */
function clearLine(g, ax, az, bx, bz) {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.ceil(len / (CELL / 2));
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    if (!g.free[cellOf(g, ax + (bx - ax) * k, az + (bz - az) * k)]) return false;
  }
  return true;
}

/**
 * 더미가 목표(tx, tz)로 가려면 지금 어느 쪽으로 걸어야 하는지 — 단위 벡터 [dx, dz].
 * 길이 없으면 null (호출한 쪽이 곧장 가는 방향으로 대신한다).
 */
export function navDirection(bot, tx, tz, boxes, t) {
  const g = gridFor(boxes);
  const [bx, bz] = [bot.pos[0], bot.pos[2]];

  // 곧장 보이면 그대로 간다
  if (clearLine(g, bx, bz, tx, tz)) {
    const l = Math.hypot(tx - bx, tz - bz) || 1;
    return [(tx - bx) / l, (tz - bz) / l];
  }

  const goal = nearestFree(g, cellOf(g, tx, tz));
  const nav = bot.nav;
  if (!nav || (nav.goal !== goal && t - nav.at > REPATH_SEC)) {
    bot.nav = { goal, at: t, dist: distanceField(g, goal) };
  }
  const { dist } = bot.nav;

  let c = nearestFree(g, cellOf(g, bx, bz));
  if (c < 0 || dist[c] === Infinity) return null;

  // 거리가 가장 많이 줄어드는 칸을 LOOKAHEAD 개 따라가며, 곧장 보이는 가장 먼 칸을 고른다
  let aim = centerOf(g, c);
  for (let k = 0; k < LOOKAHEAD && dist[c] > 0; k++) {
    const cx = c % g.nx, cz = Math.floor(c / g.nx);
    let best = c;
    for (const [dx, dz] of DIRS) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= g.nx || z >= g.nz) continue;
      if (dx && dz && (!g.free[cz * g.nx + x] || !g.free[z * g.nx + cx])) continue;  // 모서리 파고들기 금지
      const n = z * g.nx + x;
      if (dist[n] < dist[best]) best = n;
    }
    if (best === c) break;
    c = best;
    const p = centerOf(g, c);
    // 바로 옆 칸은 무조건 따라간다 — 내 칸 한가운데로 되돌아가며 제자리걸음하지 않게
    if (k > 0 && !clearLine(g, bx, bz, p[0], p[1])) break;
    aim = p;
  }
  const l = Math.hypot(aim[0] - bx, aim[1] - bz);
  if (l < 1e-3) return null;
  return [(aim[0] - bx) / l, (aim[1] - bz) / l];
}
