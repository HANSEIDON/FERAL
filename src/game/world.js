// 맵과 충돌.
//
// 버려진 컨테이너 야적장 (shared/map.js) — 밤. 바닥 · 벽 · 하역장은 여기서 실사 타일
// 텍스처를 입힌 박스로 그리고, 컨테이너 · 크레인 · 트레일러 · 소품은 mapArt.js 가 모델로
// 갈아끼운다 (그 전까지는 종류별로 칠한 박스가 대신 서 있다). 겉모습이 무엇이든 충돌은
// 여기 박스 목록이 계속 담당한다 (메시 충돌은 느리고, 게임 느낌은 단순한 박스가 오히려 좋다).

import {
  BoxGeometry, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, FogExp2, Group,
  HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, RepeatWrapping,
  SRGBColorSpace, TextureLoader, Vector3,
} from 'three';
import { WORLD } from '../../shared/config.js';
import { buildBoxes } from '../../shared/map.js';
import { ASSET_BASE } from '../core/assets.js';

// 맵 데이터는 서버와 공유한다. 쓰던 곳이 계속 동작하도록 다시 내보낸다.
export { buildBoxes };

/** 모델(mapArt.js)이 겉모습을 맡는 종류 — 모델이 뜨면 이 종류의 박스는 숨긴다 */
export const MODEL_KINDS = new Set([
  'container', 'crane', 'rail', 'truck', 'rack', 'barrier', 'crate', 'lamp',
  'barrel', 'trash', 'trashRust', 'tyres', 'shutter', 'shutterGraffiti',
]);

export function buildScene(scene) {
  // 밤 — 하늘(배경)과 환경광은 mapArt.js 가 밤하늘 사진으로 바꿔 깐다
  scene.background = new Color(0x080b12);
  scene.fog = new FogExp2(0x0b0f17, 0.02);

  // 달빛 + 하늘/땅 반사광. 가로등(mapArt.js)이 주 조명이고, 이건 어둠 속에서도
  // 실루엣과 길이 보일 만큼만 깐다 — 게임이 안 보이면 안 된다.
  scene.add(new HemisphereLight(0x4a5a80, 0x17140f, 0.75));
  const moon = new DirectionalLight(0xa9bde8, 0.8);
  moon.position.set(-25, 40, 18);
  scene.add(moon);

  // 야적장 아스팔트 + 창고 안 콘크리트 바닥 (창고 벽 x 26 ~ 바깥 벽, z ±16)
  // 바깥 담 너머까지 조금 — 좀비가 담 위에서 내려다볼 때 땅이 끊겨 보이지 않게
  const groundW = WORLD.arenaX + 40, groundD = WORLD.arenaZ + 40;
  const ground = new Mesh(meterPlane(groundW, groundD), tileMaterial('asphalt'));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const slabW = WORLD.arenaX / 2 - 26;
  const slab = new Mesh(meterPlane(slabW, 32), tileMaterial('hangar', { polygonOffset: true, polygonOffsetFactor: -1 }));
  slab.rotation.x = -Math.PI / 2;
  slab.position.set(26 + slabW / 2, 0, 0);
  scene.add(slab);

  // 구조물 — 벽 · 하역장은 텍스처 박스 그대로, 나머지는 모델이 뜰 때까지 칠한 박스
  const boxes = buildBoxes();
  const group = new Group();
  const mats = {};
  const flat = (kind) => (mats[kind] ??= new MeshStandardMaterial(KIND_LOOK[kind] ?? KIND_LOOK.other));
  const corrugated = tileMaterial('corrugated'), concrete = tileMaterial('concrete_wall');
  const dockTop = tileMaterial('dock'), dockStep = tileMaterial('metal_plate'), dockSide = tileMaterial('rust');
  for (const b of boxes) {
    const geo = meterUV(new BoxGeometry(b.w, b.h, b.d));
    let material;
    if (b.kind === 'wall') material = corrugated;
    else if (b.kind === 'perimeter') material = concrete;
    else if (b.kind === 'dock') {
      // 면 순서 +x -x +y -y +z -z — 윗면만 콘크리트(계단은 철판), 옆면은 녹슨 철판
      const top = b.h < 1 ? dockStep : dockTop;
      material = [dockSide, dockSide, top, dockSide, dockSide, dockSide];
    } else material = flat(b.kind);
    const m = new Mesh(geo, material);
    m.position.set(b.x, b.y + b.h / 2, b.z);
    m.userData.kind = b.kind;
    group.add(m);
  }
  scene.add(group);
  scene.add(contactShadows(boxes));

  return { boxes, group };
}

// 모델이 뜨기 전에 잠깐 서 있는 박스 색 (바랜 톤)
const KIND_LOOK = {
  container: { color: 0x6a3a2c, roughness: 0.75, metalness: 0.2 },
  crane: { color: 0xb8931f, roughness: 0.6, metalness: 0.4 },
  truck: { color: 0xb3b0a6, roughness: 0.7, metalness: 0.3 },
  rack: { color: 0x2f4a66, roughness: 0.6, metalness: 0.5 },
  barrier: { color: 0x8d8a82, roughness: 0.95 },
  crate: { color: 0x7a5a36, roughness: 0.9 },
  other: { color: 0x55585e, roughness: 0.85 },
};

// ---------------------------------------------------------------- 타일 텍스처

// 텍스처 한 장이 덮는 실제 크기(m) — tools/build_map.mjs TILES 와 같다
const TILE_M = { asphalt: 3, hangar: 2, concrete_wall: 2, corrugated: 2.7, dock: 5, rust: 2.2, metal_plate: 0.5 };
const TILE_METAL = new Set(['corrugated', 'metal_plate']);
const texLoader = new TextureLoader();
const tileMats = {};

/** Poly Haven 타일 재질 (색 · 법선 · ORM). 지오메트리 UV 가 미터 단위라 1/크기 로 반복한다. */
function tileMaterial(name, extra = {}) {
  const key = name + JSON.stringify(extra);
  if (tileMats[key]) return tileMats[key];
  const load = (k, srgb) => {
    const t = texLoader.load(`${ASSET_BASE}textures/map/${name}_${k}.jpg`);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(1 / TILE_M[name], 1 / TILE_M[name]);
    t.anisotropy = 8;
    if (srgb) t.colorSpace = SRGBColorSpace;
    return t;
  };
  const orm = load('orm');
  const metal = TILE_METAL.has(name);
  return (tileMats[key] = new MeshStandardMaterial({
    map: load('col', true), normalMap: load('nrm'), roughnessMap: orm, roughness: 1,
    // 금속은 밤에 비출 게 없어 새까매진다 — 금속감을 절반 아래로 눌러 바탕색이 보이게
    metalnessMap: metal ? orm : null, metalness: metal ? 0.35 : 0, ...extra,
  }));
}

/** BoxGeometry UV 를 미터 단위로 — 크기가 달라도 무늬 간격이 같다. 옆면은 v 가 위로 선다. */
function meterUV(geo) {
  const { width: w, height: h, depth: d } = geo.parameters;
  const uv = geo.attributes.uv;
  // 면 순서: +x -x +y -y +z -z (면마다 정점 4개)
  const size = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = f * 4; i < f * 4 + 4; i++) uv.setXY(i, uv.getX(i) * size[f][0], uv.getY(i) * size[f][1]);
  }
  return geo;
}
function meterPlane(w, d) {
  const geo = new PlaneGeometry(w, d), uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d);
  return geo;
}

// ---------------------------------------------------------------- 접지 그림자

/**
 * 구조물 밑동의 어두운 테두리 — 그림자 맵 없이 물체를 땅에 붙여 보이게 하는 값싼 방법.
 * 박스마다 발자국(안쪽 진하게) + 바깥으로 옅어지는 테두리를 사각형 9칸으로 만들어
 * 정점 알파로 그린다. 맵 전체가 메시 하나 · 드로우콜 한 번이다.
 */
function contactShadows(boxes) {
  const pos = [], col = [], idx = [];
  const quad = (x0, z0, x1, z1, a00, a10, a11, a01) => {
    const i = pos.length / 3;
    pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
    for (const a of [a00, a10, a11, a01]) col.push(0, 0, 0, a);
    idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
  };
  for (const b of boxes) {
    if ((b.y ?? 0) > 0 || b.h < 0.5 || b.kind === 'shutter' || b.kind === 'shutterGraffiti') continue;
    const A = 0.6, M = 0.35 + 0.15 * Math.min(b.h, 4);    // 높을수록 넓게 퍼진다
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    quad(x0, z0, x1, z1, A, A, A, A);                                   // 발자국
    quad(x0 - M, z0 - M, x0, z0, 0, 0, A, 0); quad(x1, z0 - M, x1 + M, z0, 0, 0, 0, A);   // 네 귀퉁이
    quad(x1, z1, x1 + M, z1 + M, A, 0, 0, 0); quad(x0 - M, z1, x0, z1 + M, 0, A, 0, 0);
    quad(x0, z0 - M, x1, z0, 0, 0, A, A); quad(x0, z1, x1, z1 + M, A, A, 0, 0);           // 네 변
    quad(x0 - M, z0, x0, z1, 0, A, A, 0); quad(x1, z0, x1 + M, z1, A, 0, 0, A);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  const m = new Mesh(geo, new MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  m.position.y = 0.01;
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------- 충돌

/**
 * 플레이어를 원기둥으로 보고 박스들과 밀어낸다.
 * 축별로 따로 밀어내야 벽에 붙어서 걸을 때 덜컥거리지 않는다.
 *
 * stepUp — 발높이에서 이만큼 위까지인 낮은 턱(계단 · 크레인 레일)은 밀어내지 않고
 * 들어오게 둔다. 그래야 다음에 groundHeight 가 그 위로 올려 세운다. 예전엔 이게 없어서
 * 0.3m 계단도 벽처럼 막혀 점프로만 올랐다.
 */
export function resolveCollision(pos, boxes, radius = WORLD.playerRadius, height = 1.8, stepUp = 0) {
  for (const b of boxes) {
    const minX = b.x - b.w / 2 - radius, maxX = b.x + b.w / 2 + radius;
    const minZ = b.z - b.d / 2 - radius, maxZ = b.z + b.d / 2 + radius;
    const top = b.y + b.h;

    // 위에 올라서 있거나 완전히 위를 지나가면 무시
    if (pos.y >= top - 0.05) continue;
    if (top <= pos.y + stepUp) continue;           // 올라설 수 있는 턱
    if (pos.y + height <= b.y) continue;
    if (pos.x <= minX || pos.x >= maxX || pos.z <= minZ || pos.z >= maxZ) continue;

    // 가장 얕게 빠져나갈 수 있는 축으로 민다
    const push = [
      { axis: 'x', d: minX - pos.x },
      { axis: 'x', d: maxX - pos.x },
      { axis: 'z', d: minZ - pos.z },
      { axis: 'z', d: maxZ - pos.z },
    ].sort((p, q) => Math.abs(p.d) - Math.abs(q.d))[0];

    pos[push.axis] += push.d;
  }
  return pos;
}

/**
 * 이 x,z 위치에서 발이 닿는 높이 (바닥 또는 상자 윗면).
 *
 * `maxTop` 보다 높은 면은 무시한다. 이게 없으면 벽에 몸을 붙이는 순간
 * 벽 꼭대기가 "바닥"으로 잡혀서 4m 벽을 순간이동으로 타고 올라간다.
 * 설 수 있는 면 = 지금 발높이 + 걸터오를 수 있는 턱 높이 까지다.
 */
export function groundHeight(x, z, boxes, radius = WORLD.playerRadius, maxTop = Infinity) {
  let h = 0;
  for (const b of boxes) {
    const top = b.y + b.h;
    if (top > maxTop) continue;
    if (x < b.x - b.w / 2 - radius || x > b.x + b.w / 2 + radius) continue;
    if (z < b.z - b.d / 2 - radius || z > b.z + b.d / 2 + radius) continue;
    h = Math.max(h, top);
  }
  return h;
}

/**
 * 레이 vs 박스 — 가장 가까운 명중점과 그 면의 법선을 돌려준다.
 * 탄착군(탄이 박힌 자국)에 쓴다. maxDist 안에 없으면 null.
 */
export function raycastBoxes(origin, dir, boxes, maxDist = 100) {
  let best = null;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];

  for (const b of boxes) {
    const lo = [b.x - b.w / 2, b.y, b.z - b.d / 2];
    const hi = [b.x + b.w / 2, b.y + b.h, b.z + b.d / 2];

    let tmin = 0, tmax = maxDist;
    let face = null;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-8) {
        if (o[i] < lo[i] || o[i] > hi[i]) { face = null; break; }
      } else {
        let t1 = (lo[i] - o[i]) / d[i], t2 = (hi[i] - o[i]) / d[i], sgn = -1;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; sgn = 1; }
        if (t1 > tmin) { tmin = t1; face = { i, sgn }; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { face = null; break; }
      }
    }
    if (!face || tmin <= 0) continue;
    if (!best || tmin < best.dist) {
      const n = new Vector3();
      n.setComponent(face.i, face.sgn);
      best = {
        dist: tmin,
        point: new Vector3(o[0] + d[0] * tmin, o[1] + d[1] * tmin, o[2] + d[2] * tmin),
        normal: n,
      };
    }
  }
  return best;
}

/** 시선이 막혔는지 — 좀비 감각(벽 너머 실루엣)과 명중 판정에 쓴다. */
export function lineBlocked(from, to, boxes) {
  const dir = new Vector3().subVectors(to, from);
  const len = dir.length();
  if (len < 0.001) return false;
  dir.divideScalar(len);

  const step = 0.4;
  const p = new Vector3();
  for (let d = step; d < len; d += step) {
    p.copy(from).addScaledVector(dir, d);
    for (const b of boxes) {
      if (p.y < b.y || p.y > b.y + b.h) continue;
      if (Math.abs(p.x - b.x) > b.w / 2) continue;
      if (Math.abs(p.z - b.z) > b.d / 2) continue;
      return true;
    }
  }
  return false;
}
