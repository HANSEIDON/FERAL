// 맵의 충돌 박스. 서버와 클라이언트가 같이 읽는다.
//
// 클라이언트는 이걸로 벽을 그리고 충돌을 풀고, 서버는 스폰 지점이 벽 속인지
// 검증한다. 한쪽만 고치면 "보이는 벽"과 "막히는 벽"이 어긋나므로 공유한다.
//
// ── 버려진 컨테이너 야적장 (80 × 52m) ──
//
//   서쪽  컨테이너 골목  좁은 길(4m) · 갈림길 · 2단 적재로 시야가 짧다
//   가운데 크레인 광장   크레인 다리와 엇갈린 컨테이너로 긴 사선을 끊는다
//   동쪽  하역장 · 창고  생존자가 오를 수 있는 높은 곳은 하역장(1.1m) 하나뿐
//
// 좀비에게 유리하게:
//   - 컨테이너 지붕(2.6m)은 생존자가 점프(최대 1.2m)로 못 오르고, 좀비는
//     슈퍼점프(최대 5.4m)로 올라 지붕을 타고 다니다 내려찍는다. 컨테이너 옆에
//     디딤판이 될 낮은 상자를 일부러 두지 않았다.
//   - 생존자 높은 자리(하역장)는 위가 훤히 트여 있고 사방에서 오를 수 있다.
//   - 창고 벽(4.5m)은 좀비 슈퍼점프로 넘는다. 생존자는 문으로만 드나든다.
//   - 좀비는 한가운데(크레인 아래)서 시작해 어느 구역이든 금방 닿는다.
//   - 탄약은 골목 안 · 광장 한복판 · 창고 안처럼 위험한 곳에만 놓인다.
//   - 생존자만 비집고 들어가는 좁은 틈(좀비 지름 0.92m 보다 좁은 틈)을 만들지
//     않는다 — 그런 틈은 생존자만의 안전지대가 된다 (tools/tmp/verify_map.mjs).

import { WORLD } from './config.js';

/** 경계 — 바깥 벽 안쪽 면까지의 거리 (중심 기준) */
export const HALF_X = WORLD.arenaX / 2;

/** 야적장 소품 크기 [가로 x, 높이, 세로 z] (m) — tools/tmp/yard_build.html 이 yard_props.glb 를 구우며 잰 값 */
export const YARD_SIZE = {
  tank: [2.74, 5.69, 6.22], forklift: [1.18, 2.12, 3.71], pipe: [1.5, 1.13, 1.51], pipes: [1.6, 1.14, 2.82],
  reel: [1.58, 1.27, 1.58], pipeStack: [2.23, 2.18, 3.16], planks: [1.84, 0.59, 3.37], cement: [1.86, 0.76, 2.5],
};
/** 투광등 탑 자리 */
export const FLOOD_TOWERS = [[-13, -11.2], [8, 10]];
export const HALF_Z = WORLD.arenaZ / 2;

/** 컨테이너 — 40ft 12m · 20ft 6m, 폭 2.5m, 한 단 2.6m */
const CONT_W = 2.5;
const CONT_H = 2.6;

/**
 * {kind, x, y, z, w, h, d} — 바닥 높이 y 에서 h 만큼 올라간다 (대부분 y = 0).
 * kind 는 겉모습용이다 (world.js 가 종류별로 칠한다 — 나중에 실사 모델로 갈아끼울 단위).
 */
export function buildBoxes() {
  const b = [];
  const put = (kind, x, z, w, h, d, y = 0) => b.push({ kind, x, y, z, w, h, d });
  // 벽에 붙는 소품 — rot 은 앞면이 보는 방향 (0 = +Z, π = -Z, π/2 = +X, -π/2 = -X). 겉모습에만 쓴다
  const wallProp = (kind, x, z, w, h, d, rot, y = 0) => b.push({ kind, x, y, z, w, h, d, rot });
  // X 방향으로 누운 컨테이너 (x0~x1), Z 방향 컨테이너 (z0~z1). tiers = 쌓은 단 수
  const contX = (x0, x1, z, tiers = 1) => put('container', (x0 + x1) / 2, z, x1 - x0, CONT_H * tiers, CONT_W);
  // 야적장 소품 — 크기는 YARD_SIZE (모델에서 잰 값). alongX 면 긴 쪽(모델 Z)을 X 로 눕힌다
  const yard = (kind, x, z, alongX = false, y = 0) => {
    const [w, h, l] = YARD_SIZE[kind];
    put(kind, x, z, alongX ? l : w, h, alongX ? w : l, y);
  };
  const contZ = (x, z0, z1, tiers = 1) => put('container', x, (z0 + z1) / 2, CONT_W, CONT_H * tiers, z1 - z0);
  const W = HALF_X - 0.5, N = HALF_Z - 0.5;   // 바깥 벽 안쪽 면

  // ── 서쪽: 컨테이너 골목 (x -39.5 ~ -15) ──
  // 줄 간격 6.5~7m → 골목 폭 4~4.5m. 줄마다 끊긴 자리(3m)를 엇갈려 둬서
  // 남북으로 빠지는 샛길이 여럿이다. 벽에 붙은 줄은 그쪽 끝이 막다른 골목이다.
  contX(-W, -27.5, -20, 2); contX(-24.5, -18.5, -20);
  contX(-36.5, -30.5, -13.5);
  // 자재 야적장 — 높이가 들쭉날쭉한 낮은 엄폐물 (파이프 더미 2.2m · 콘크리트 관 1.1m · 케이블 릴 1.3m · 시멘트 0.8m)
  yard('pipeStack', -25.4, -13.5, true); yard('pipes', -21.6, -13.5, true);
  yard('reel', -18.8, -14.1); yard('cement', -16.6, -12.9);
  contX(-W, -27.5, -7); contX(-24.5, -18.5, -7, 2);
  // 가운데 줄은 컨테이너 대신 화학 탱크 둘 (5.7m — 좀비만 오른다)
  yard('tank', -31.6, 0, true); yard('tank', -25.2, 0, true);
  contX(-W, -33.5, 7); contX(-30.5, -18.5, 7);
  contX(-36.5, -24.5, 13.5, 2);
  yard('forklift', -19.2, 13.5, true);          // 컨테이너 하나 대신 지게차 — 골목이 그만큼 트인다
  contX(-W, -33.5, 20);
  yard('forklift', -27.5, 20, true); yard('cement', -23.4, 20.2, true); yard('planks', -20, 19.8, true);

  // ── 가운데: 크레인 광장 (x -15 ~ 15) ──
  // 부두 크레인 "Sokol" (CRANE.scale 배, 높이 약 21m). 팔은 -X 로 뻗어 철판을 옮긴다 (mapArt.js 가 동작 ·
  // 움직이는 발판을 맡는다 — 철판은 0.6m ↔ 1.75m 로 오르내리며 x -14 ↔ -6.5 를 오간다).
  // 충돌은 사람 · 좀비가 닿는 데까지만 — 바퀴 대차 넷(0.9m), 다리 기둥, 다리 위 둥근 갑판(3.9m, 슈퍼점프로 오른다),
  // 그 위 회전 기둥. 팔은 12m 위라 아무도 못 닿는다. 수치는 tools/tmp/crane_view.html 로 모델에서 잰 값
  for (const [fx, fz] of [[3.15, 2.81], [3.15, -2.97], [-2.65, 2.81], [-2.65, -2.97]]) {   // 모델을 180° 돌려 놓았다
    put('crane', fx, fz, 2.12, 0.9, 0.5);
    put('crane', fx * 0.8, fz * 0.8, 0.5, 3.5, 0.5, 0.9);
  }
  put('crane', 0.25, -0.08, 5.2, 0.45, 5.2, 3.45);    // 다리 위 갑판
  put('crane', 0.25, -0.08, 2.2, 8, 2.2, 3.9);        // 회전 기둥 · 운전실 밑
  contX(-10, -6, 3.75);                               // 철판이 높이 올라왔을 때 옮겨 타는 컨테이너
  // 엇갈린 컨테이너 — 하역장에서 광장 너머 골목까지 한눈에 보이지 않게
  contX(-8, 4, 16);
  // 광장 남쪽 — 컨테이너 대신 자재 더미 (한 줄로 막지 않고 사이로 지나간다)
  yard('pipe', -0.6, -16); yard('pipes', 2.6, -16.4, true); yard('reel', 6, -15.6); yard('pipeStack', 9.3, -16, true);
  // 투광등 탑 (8m) — 광장 양쪽. 불빛은 mapArt.js
  for (const [x, z] of FLOOD_TOWERS) { put('flood', x, z, 0.9, 0.4, 0.9); put('flood', x, z, 0.3, 8, 0.3, 0.4); }
  contZ(-12.5, -10, -4);
  contZ(12.5, 3, 9, 2);          // 크레인 대차(9, 2.6)와 1.9m
  contZ(15, -6, 0);              // 하역장 한복판에서 광장이 훤히 보이지 않게 (좀비는 뛰어오른다)
  contX(6, 12, N - CONT_W / 2, 2);       // 북쪽 벽에 붙여 쌓음 (벽과 틈이 없게)
  // 낮은 엄폐물 — 콘크리트 방호벽(1.1m, 두 토막)과 나무 상자 더미(0.92m, 두 단). 뛰어넘을 수 있다
  put('barrier', -3, -5, 3.14, 1.1, 0.45);
  put('barrier', 4, 4.5, 3.14, 1.1, 0.45);
  put('barrier', 11, -10, 0.45, 1.1, 3.14);    // 크레인 레일(x 8.5~9.5)을 비켜서
  put('barrier', -6, 9, 0.45, 1.1, 3.14);
  put('crate', 6, -8, 2.32, 0.92, 1.06);        // 상자(1.16 × 0.53 × 0.46) 2 × 2 × 2
  put('crate', -7, 12.5, 1.16, 0.92, 1.06);     //                           1 × 2 × 2

  // ── 동쪽: 하역장 · 창고 (x 15 ~ 39.5) ──
  // 창고 — 지붕 없는 벽(4.5m). 서쪽 벽에 문 둘(3m · 6m), 북·남 벽에 문 하나씩
  const WH = 4.5, T = 0.6, WX = 26;
  put('wall', WX, -13.5, T, WH, 5);          // 서쪽 벽 z -16 ~ -11
  put('wall', WX, -5, T, WH, 6);             //          z -8 ~ -2
  put('wall', WX, 10, T, WH, 12);            //          z 4 ~ 16
  put('wall', 28, 16, 4, WH, T);             // 북쪽 벽 x 26 ~ 30 (문 30 ~ 33)
  put('wall', (33 + W) / 2, 16, W - 33, WH, T);
  put('wall', 30, -16, 8, WH, T);            // 남쪽 벽 x 26 ~ 34 (문 34 ~ 37)
  put('wall', (37 + W) / 2, -16, W - 37, WH, T);
  // 선반(3.2m) — 통로 3.3~3.9m. 생존자는 못 오르고 좀비는 뛰어오른다
  put('rack', 30.5, -8.5, 1.2, 3.2, 9);
  put('rack', 30.5, 7.5, 1.2, 3.2, 11);
  put('rack', 35, -8, 1.2, 3.2, 10);
  put('rack', 35, 8, 1.2, 3.2, 10);
  // 하역장 — 창고 서쪽 벽 앞 높은 단(1.1m, 점프로 오른다). 북쪽 끝은 계단
  put('dock', 23.35, 0, 4.7, 1.1, 22);
  put('dock', 23.35, 11.3, 4.7, 0.85, 0.6);
  put('dock', 23.35, 11.9, 4.7, 0.6, 0.6);
  put('dock', 23.35, 12.5, 4.7, 0.3, 0.6);
  yard('cement', 22.6, -6, false, 1.1);         // 하역장 위 시멘트 팔레트
  // 세워 둔 트레일러(11.6m) — 하역장에서 북쪽·남쪽 길이 바로 보이지 않게
  put('truck', 17.5, 13, 2.56, 3.6, 11.6);
  put('truck', 18, -15, 2.56, 3.6, 11.6);
  // 바깥 길 — 벽에 붙여 쌓은 컨테이너 (틈이 없게)
  contX(27.5, W, N - CONT_W / 2);
  contX(27.5, W, -N + CONT_W / 2);

  // ── 소품 — 벽 · 컨테이너에 딱 붙여 둔다 (좁은 틈이 생기지 않게) ──
  // 가로등(3.9m): 바깥 벽을 따라 여섯. 밤 맵의 주 조명이다 (mapArt.js 가 불빛을 단다)
  const LAMP = 0.4;
  for (const x of [-20, 16]) put('lamp', x, N - LAMP / 2, LAMP, 3.9, LAMP);
  for (const x of [-20, 12]) put('lamp', x, -N + LAMP / 2, LAMP, 3.9, LAMP);
  for (const z of [-13.5, 13.5]) put('lamp', -W + LAMP / 2, z, LAMP, 3.9, LAMP);
  // 드럼통(0.95m) · 쓰레기통(0.91m) · 타이어 더미(0.48m) — 올라서도 컨테이너(2.6m)엔 못 닿는다
  const BAR = 0.65, TR = [0.78, 0.91, 0.56], TY = 0.64;
  put('barrel', -20, -12.25 + BAR / 2, BAR, 0.95, BAR);          // 골목 컨테이너 북쪽 면
  put('barrel', -18.5 + BAR / 2, 7, BAR, 0.95, BAR);             // 컨테이너 동쪽 끝
  put('barrel', W - BAR / 2, -3, BAR, 0.95, BAR);                // 창고 안 동쪽 벽
  put('barrel', W - BAR / 2, 2, BAR, 0.95, BAR);
  put('trash', -33.5, N - TR[2] / 2, TR[0], TR[1], TR[2]);       // 북서쪽 벽
  put('trashRust', 4 + TR[0] / 2, 16, TR[0], TR[1], TR[2]);       // 광장 북쪽 컨테이너 끝
  put('trash', 23, -11 - TR[2] / 2, TR[0], TR[1], TR[2]);        // 하역장 남쪽 면
  put('trashRust', 22, -N + TR[2] / 2, TR[0], TR[1], TR[2]);      // 남쪽 벽
  put('tyres', -W + TY / 2, 3, TY, 0.48, TY);                     // 서쪽 벽
  put('tyres', 11.3, -16, TY, 0.48, TY);                          // 광장 남쪽 파이프 더미 끝
  put('tyres', W - TY / 2, 15.7 - TY / 2, TY, 0.48, TY);          // 창고 북동 구석
  // 닫힌 셔터 문(2.7 × 2.4m, 두께 0.3) — 벽에 붙은 채 열리지 않는다. 하역장 문은 단 위(1.1m)에 있다
  const SH = 0.3;
  wallProp('shutter', 28, 16 + T / 2 + SH / 2, 2.7, 2.4, SH, 0);              // 창고 북쪽 벽 바깥
  wallProp('shutter', WX - T / 2 - SH / 2, 8, SH, 2.4, 2.7, -Math.PI / 2, 1.1); // 하역장 위 창고 문
  wallProp('shutterGraffiti', WX - T / 2 - SH / 2, -13.5, SH, 2.4, 2.7, -Math.PI / 2);

  // ── 바깥 테두리: 2단 컨테이너 줄 (5.2m) ──
  // 안쪽 면은 예전 담과 같은 자리(±HALF - 0.5)라 벽에 붙은 소품은 그대로다. 좀비는 슈퍼점프로 올라서서
  // 위를 걸어 다닌다 (clampToArena 0 — 컨테이너 위 안쪽 절반까지). 겉모습은 mapArt.js 가 컨테이너로 채운다.
  const PH = CONT_H * 2, PO = 0.5 - CONT_W / 2;   // 높이 · 중심을 담 선에서 바깥으로 민 양
  const row = (alongX, at, from, to, n) => {
    const len = (to - from) / n;
    for (let i = 0; i < n; i++) {
      const c = from + len * (i + 0.5);
      if (alongX) put('perimeter', c, at, len, PH, CONT_W); else put('perimeter', at, c, CONT_W, PH, len);
    }
  };
  const OX = HALF_X - PO, OZ = HALF_Z - PO;
  row(true, OZ, -OX - CONT_W / 2, OX + CONT_W / 2, 7);
  row(true, -OZ, -OX - CONT_W / 2, OX + CONT_W / 2, 7);
  // 동쪽은 창고 뒷벽(z ±16)이라 컨테이너가 아니라 철판 벽 — 보안등이 여기 달린다
  row(false, OX, -OZ + CONT_W / 2, -16, 1);
  put('perimeterWall', OX, 0, CONT_W, PH, 32);
  row(false, OX, 16, OZ - CONT_W / 2, 1);
  row(false, -OX, -OZ + CONT_W / 2, OZ - CONT_W / 2, 4);

  return b;
}

/**
 * 생존자 스폰 자리 — 맵 곳곳에 흩어 놓는다 (한 사람 한 자리).
 * 모여서 시작하면 바로 진을 치니, 일부는 좀비가 강한 골목 안에서 시작한다.
 * 순서는 인접한 번호끼리 서로 먼 곳이 되게 엇갈려 둔다.
 */
export const SURVIVOR_SPAWNS = [
  { x: 35, z: 20 }, { x: -37.5, z: -23 }, { x: 35, z: -20 }, { x: -37.5, z: 23 },
  { x: 20, z: 22.5 }, { x: -22, z: -24 }, { x: 8, z: -22.5 }, { x: -8, z: 23 },
];

/** 좀비 스폰 — 크레인 아래 한가운데. 어느 구역이든 금방 닿는다. */
export const ZOMBIE_SPAWN = { x: 0, z: 0 };

/**
 * 벽에 단 보안등 — 충돌 없는 장식 (머리 위 3.6m 이상). y 는 다는 높이, rot 은 비추는 방향
 * (wallProp 과 같다). light 가 켜진 것만 진짜 불빛을 단다 — 불빛은 화면 전체를 무겁게 한다.
 */
export const SECURITY_LIGHTS = [
  { x: 25.7, y: 3.9, z: -5, rot: -Math.PI / 2, light: true },    // 창고 서쪽 벽 바깥 — 하역장을 비춘다
  { x: 25.7, y: 3.9, z: 13, rot: -Math.PI / 2 },
  { x: 39.5, y: 3.6, z: -8, rot: -Math.PI / 2, light: true },     // 창고 안 동쪽 벽
  { x: 39.5, y: 3.6, z: 8, rot: -Math.PI / 2, light: true },
  { x: 36, y: 3.6, z: 15.7, rot: Math.PI },                       // 창고 안 북쪽 · 남쪽 벽
  { x: 38.3, y: 3.6, z: -15.7, rot: 0 },                          // 남쪽 벽 (문 x 34~37 을 피해서)
];

/**
 * 탄약상자 후보 지점 — 서버가 이 중에서 골라 하나씩 스폰한다.
 * 좀비에게 유리하게 위험한 곳에만 둔다: 골목 안 넷, 광장 한복판 둘, 창고 안 둘,
 * 바깥 길 둘. (상수 목록이라 서버·클라이언트가 같은 데이터를 쓴다)
 */
export const AMMO_SPOTS = [
  { x: -30, z: -16.75 }, { x: -26, z: -3.5 }, { x: -28, z: 10.25 }, { x: -36, z: 3.5 },
  { x: 0, z: -9.5 }, { x: -4, z: 11 },
  { x: 32.75, z: -8 }, { x: 37.5, z: 8 },
  { x: 20, z: -22 }, { x: -10, z: -22 },
];

/** 동시에 바닥에 있을 수 있는 탄약상자 최대 수 */
export const AMMO_BOX_COUNT = 6;

/** 탄약상자가 일정 시간마다 하나씩 추가 스폰되는 간격(초) */
export const AMMO_SPAWN_INTERVAL = 10;

/** 이 거리 안에 들어가면 자동 주우기 */
export const AMMO_PICKUP_RADIUS = 1.4;

/** 머리 위 구조물로 치는 바닥 높이 — 이보다 높이 떠 있으면 밑으로 지나간다 (좀비 키 2.15m) */
const OVERHEAD = 2.2;

/** 이 x,z 가 어떤 박스 안인가 (플레이어 반경 포함). */
export function insideBox(x, z, boxes, radius = WORLD.playerRadius) {
  for (const b of boxes) {
    if (b.h < 0.5) continue;                 // 밟고 올라서는 낮은 판은 통과로 친다
    if ((b.y ?? 0) >= OVERHEAD) continue;    // 머리 위에 뜬 것 (지금 맵엔 없다)
    if (Math.abs(x - b.x) > b.w / 2 + radius) continue;
    if (Math.abs(z - b.z) > b.d / 2 + radius) continue;
    return b;
  }
  return null;
}

/**
 * 바닥 평면에서만 보는 간단한 충돌. 서버의 더미 이동에 쓴다.
 * (클라이언트는 점프·높이가 있어서 world.js 의 3D 판을 쓴다)
 *
 * 막히면 축 하나를 포기하고 벽을 따라 미끄러진다.
 */
export function slide(fromX, fromZ, toX, toZ, boxes, radius = WORLD.playerRadius) {
  if (!insideBox(toX, toZ, boxes, radius)) return [toX, toZ];
  if (!insideBox(toX, fromZ, boxes, radius)) return [toX, fromZ];
  if (!insideBox(fromX, toZ, boxes, radius)) return [fromX, toZ];
  return [fromX, fromZ];
}

/** 경계 안으로 — margin 만큼 바깥 벽에서 떨어뜨린다 */
export function clampToArena(x, z, margin = 1) {
  const ax = HALF_X - margin, az = HALF_Z - margin;
  return [Math.max(-ax, Math.min(ax, x)), Math.max(-az, Math.min(az, z))];
}

/**
 * 벽 속에 박힌 스폰 지점을 가장 가까운 빈 자리로 밀어낸다.
 * 맵을 고치다가 스폰이 벽에 겹쳐도 플레이어가 갇히지 않게 하는 안전장치다.
 */
export function clearSpawn(x, z, boxes, radius = WORLD.playerRadius) {
  if (!insideBox(x, z, boxes, radius)) return [x, z];

  for (let r = 1.5; r <= 24; r += 1.5) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const nx = x + Math.cos(a) * r;
      const nz = z + Math.sin(a) * r;
      if (Math.abs(nx) > HALF_X - 2 || Math.abs(nz) > HALF_Z - 2) continue;
      if (!insideBox(nx, nz, boxes, radius)) return [nx, nz];
    }
  }
  return [x, z];   // 못 찾으면 원래 자리 (맵이 꽉 찬 경우)
}
