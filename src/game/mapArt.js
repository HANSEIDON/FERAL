// 맵 모델 · 밤하늘 — 충돌 박스(shared/map.js) 자리에 받은 모델을 놓는다.
//
// tools/build_map.mjs 가 모델을 게임 좌표와 박스 크기로 구워 두었으므로 여기서는 자리 ·
// 방향 · 변종만 고른다. 같은 모델은 InstancedMesh 하나로 그린다 — 컨테이너 40여 개가
// 드로우콜 네 번이다. 모델이 뜨면 그 종류의 대역 박스(world.js)는 숨긴다. 충돌과
// 3인칭 카메라 레이는 계속 박스를 쓴다 (숨긴 메시도 레이에는 걸린다).
//
// 불빛: 가로등 여섯 · 보안등 둘만 진짜 광원이다. 광원 하나하나가 화면의 모든 픽셀
// 계산에 더해지니 늘릴 때는 아껴서.

import {
  AnimationMixer, Box3, BoxGeometry, CylinderGeometry, Group, PlaneGeometry, BufferAttribute, BufferGeometry, CanvasTexture, LineBasicMaterial, LineSegments,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, EquirectangularReflectionMapping, InstancedMesh, Matrix4, PMREMGenerator, PointLight,
  Quaternion, SpotLight, SRGBColorSpace, Vector3,
} from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { ASSET_BASE, loadModel } from '../core/assets.js';
import { FLOOD_TOWERS, HALF_X, HALF_Z, SECURITY_LIGHTS, YARD_SIZE } from '../../shared/map.js';
import { MODEL_KINDS } from './world.js';

// 모델 원래 크기 (build_map.mjs 가 구운 값)
const CONTAINER = { w: 2.5, h: 2.6, len: 6 };
const TRAILER = { w: 2.56, h: 3.6, len: 11.63 };
const RACK = { w: 1.2, h: 3.2, len: 3 };
const BARRIER = { len: 1.56, h: 1.11, d: 0.44 };
const CRATE = { w: 0.53, h: 0.46, len: 1.16 };
const RUST_CHANCE = 0.15;          // 녹슨 컨테이너(다른 모델)가 섞이는 비율

// 밝기 — 밤이지만 게임이 보여야 한다
const LIGHT = {
  env: 0.42,                        // 밤하늘 환경광 (금속 반사 · 그늘 채움)
  sky: 0.12,                        // 배경 하늘 밝기 (사진은 노출을 올려 구웠다 — 별이 보이게)
  lamp: { color: 0xffb46e, intensity: 55, distance: 22 },
  security: { color: 0xfff0da, intensity: 170, distance: 26, angle: 0.75 },
  glow: 3.5,                        // 전구 · 유리 자체 발광 세기
};

/**
 * 맵 겉모습을 입힌다. 실패해도 게임은 대역 박스로 계속된다.
 * @param {{ scene, renderer, group }} ctx  group = world.js buildScene 의 박스 그룹
 */
export async function dressMap({ scene, renderer, boxes, group }) {
  loadSky(scene, renderer);
  const gltf = await loadModel(`${ASSET_BASE}models/map_props.glb`);
  const placer = new Placer(gltf.scene);
  const yardGltf = await loadModel(`${ASSET_BASE}models/yard_props.glb`).catch((e) => { console.warn('[mapArt] 야적장 소품 실패', e); return null; });
  const yard = yardGltf ? new Placer(yardGltf.scene) : null;

  boxes.forEach((b, i) => {
    const rnd = random(i);
    switch (b.kind) {
      case 'container': case 'perimeter': placeContainers(placer, b, i); break;
      case 'tank': case 'forklift': case 'pipe': case 'pipes': case 'reel': case 'pipeStack': case 'planks': case 'cement': {
        if (!yard) break;
        const [w, h, len] = YARD_SIZE[b.kind];
        placeAlong(yard, YARD_MODEL[b.kind], b, { w, h, len }, rnd() < 0.5);
        break;
      }
      case 'truck': placeAlong(placer, 'Trailer', b, TRAILER, rnd() < 0.5); break;
      case 'rack': placeRack(placer, b, i); break;
      case 'barrier': placeBarrier(placer, b, rnd); break;
      case 'crate': placeCrates(placer, b, rnd); break;
      case 'barrel': placer.add('Barrel', b.x, 0, b.z, rnd() * Math.PI * 2); break;
      case 'tyres': placer.add('TyreStack', b.x, 0, b.z, rnd() * Math.PI * 2); break;
      case 'trash': case 'trashRust':
        placer.add(b.kind === 'trash' ? 'TrashCan' : 'TrashCanRust', b.x, 0, b.z, (b.w < b.d ? Math.PI / 2 : 0) + (rnd() < 0.5 ? Math.PI : 0));
        break;
      case 'shutter': case 'shutterGraffiti': {
        // 박스 가운데에서 두께 절반만큼 벽 쪽으로 — 모델은 뒷면이 원점이다
        const t = Math.min(b.w, b.d) / 2;
        placer.add(b.kind === 'shutter' ? 'Shutter' : 'ShutterGraffiti', b.x - Math.sin(b.rot) * t, b.y, b.z - Math.cos(b.rot) * t, b.rot);
        break;
      }
      case 'lamp': {
        placer.add('Lamp', b.x, 0, b.z, 0);
        const bulb = placer.extras('Lamp').light;
        const l = new PointLight(LIGHT.lamp.color, LIGHT.lamp.intensity, LIGHT.lamp.distance, 2);
        l.position.set(b.x + bulb[0], bulb[1], b.z + bulb[2]);
        scene.add(l);
        break;
      }
      default: break;
    }
  });
  placeBackdrop(placer);
  scene.add(edgeRailing());
  loadCranes(scene, boxes);

  for (const s of SECURITY_LIGHTS) {
    placer.add('SecurityLight', s.x, s.y, s.z, s.rot);
    if (!s.light) continue;
    const bulb = placer.extras('SecurityLight').light;
    const fwd = new Vector3(Math.sin(s.rot), 0, Math.cos(s.rot));
    const at = new Vector3(s.x, s.y, s.z).add(new Vector3(bulb[0], bulb[1], bulb[2]).applyAxisAngle(new Vector3(0, 1, 0), s.rot));
    const l = new SpotLight(LIGHT.security.color, LIGHT.security.intensity, LIGHT.security.distance, LIGHT.security.angle, 0.6, 2);
    l.position.copy(at);
    l.target.position.copy(at).addScaledVector(fwd, 7).setY(0);
    scene.add(l, l.target);
  }

  // 전구 · 유리는 스스로 빛난다
  gltf.scene.traverse((o) => {
    if (o.isMesh && /Glow/.test(o.material.name)) o.material.emissiveIntensity = LIGHT.glow;
  });

  for (const m of placer.build()) scene.add(m);
  if (yard) {
    for (const m of yard.build()) scene.add(m);
    floodTowers(scene, yardGltf.scene);
  }
  scene.add(laneMarkings());
  for (const c of group.children) if (MODEL_KINDS.has(c.userData.kind)) c.visible = false;
  return placer.stats();
}

// ---------------------------------------------------------------- 배치

/** 모델 이름별로 놓을 자리(행렬)를 모았다가 InstancedMesh 로 만든다. */
class Placer {
  constructor(root) { this.root = root; this.spots = new Map(); }

  extras(name) { return this.root.getObjectByName(name)?.userData ?? {}; }

  /** 바닥 가운데 (x, y, z), Y 축 회전 yaw, 축별 배율 (모델 기준 x · y · z) */
  add(name, x, y, z, yaw, sx = 1, sy = 1, sz = 1) {
    const m = new Matrix4().compose(
      new Vector3(x, y, z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw), new Vector3(sx, sy, sz));
    if (!this.spots.has(name)) this.spots.set(name, []);
    this.spots.get(name).push(m);
  }

  build() {
    const out = [];
    for (const [name, mats] of this.spots) {
      const node = this.root.getObjectByName(name);
      if (!node) { console.warn('[mapArt] 모델 없음:', name); continue; }
      node.updateMatrixWorld(true);
      const meshes = [];
      node.traverse((o) => { if (o.isMesh) meshes.push(o); });
      for (const src of meshes) {
        // 노드 안 메시의 상대 변환(멀티 재질 노드는 자식 메시)을 자리 행렬 뒤에 곱한다
        const local = new Matrix4().copy(node.matrixWorld).invert().multiply(src.matrixWorld);
        const im = new InstancedMesh(src.geometry, src.material, mats.length);
        mats.forEach((m, i) => im.setMatrixAt(i, new Matrix4().multiplyMatrices(m, local)));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.name = `${name}:${src.material.name}`;
        out.push(im);
      }
    }
    this._built = out;
    return out;
  }

  stats() {
    let tris = 0;
    for (const m of this._built) tris += (m.geometry.index.count / 3) * m.count;
    return { drawCalls: this._built.length, tris: Math.round(tris), models: this.spots.size };
  }
}

/** 박스의 긴 쪽 — 모델은 긴 쪽이 Z 라서, 박스가 X 로 길면 90° 돌린다. */
function axis(b) {
  const alongX = b.w > b.d;
  return { alongX, len: alongX ? b.w : b.d, across: alongX ? b.d : b.w, yaw: alongX ? Math.PI / 2 : 0 };
}

/** 박스 하나를 모델 하나로 채운다 (긴 쪽 = 모델 Z). */
function placeAlong(placer, name, b, size, flip) {
  const a = axis(b);
  placer.add(name, b.x, b.y, b.z, a.yaw + (flip ? Math.PI : 0), a.across / size.w, b.h / size.h, a.len / size.len);
}

/** 컨테이너 — 단마다 따로, 12m 칸은 20ft 둘을 이어서. 색 · 문 방향은 칸마다 섞는다. */
function placeContainers(placer, b, i) {
  const a = axis(b);
  const tiers = Math.max(1, Math.round(b.h / CONTAINER.h)), th = b.h / tiers;
  const halves = a.len > CONTAINER.len * 1.5 ? 2 : 1, unit = a.len / halves;
  const gap = halves > 1 ? 0.05 : 0;
  for (let k = 0; k < tiers; k++) {
    for (let h = 0; h < halves; h++) {
      const rnd = random(i * 31 + k * 7 + h);
      const off = (h - (halves - 1) / 2) * unit;
      const name = rnd() < RUST_CHANCE ? 'ContainerRust' : `Container${1 + Math.floor(rnd() * 3)}`;
      placer.add(name, b.x + (a.alongX ? off : 0), b.y + th * k, b.z + (a.alongX ? 0 : off),
        a.yaw + (rnd() < 0.5 ? Math.PI : 0), a.across / CONTAINER.w, th / CONTAINER.h, (unit - gap) / CONTAINER.len);
    }
  }
}

/** 선반 — 3m 칸을 이어 붙인다. 짐 배치 둘(A · B)을 번갈아. */
function placeRack(placer, b, i) {
  const a = axis(b);
  const n = Math.max(1, Math.round(a.len / RACK.len)), unit = a.len / n;
  for (let k = 0; k < n; k++) {
    const off = (k - (n - 1) / 2) * unit;
    placer.add((i + k) % 2 ? 'RackB' : 'RackA', b.x + (a.alongX ? off : 0), b.y, b.z + (a.alongX ? 0 : off),
      a.yaw + (random(i * 13 + k)() < 0.5 ? Math.PI : 0), a.across / RACK.w, b.h / RACK.h, unit / RACK.len);
  }
}

/** 방호벽 — 박스 하나에 두 토막. 모델은 긴 쪽이 X. */
function placeBarrier(placer, b, rnd) {
  const a = axis(b);
  const piece = a.len / 2;
  for (const s of [-0.5, 0.5]) {
    const off = s * piece;
    placer.add('Barrier', b.x + (a.alongX ? off : 0), b.y, b.z + (a.alongX ? 0 : off),
      (a.alongX ? 0 : Math.PI / 2) + (rnd() < 0.5 ? Math.PI : 0), (piece - 0.02) / BARRIER.len, b.h / BARRIER.h, a.across / BARRIER.d);
  }
}

/** 나무 상자 더미 — 상자를 박스 크기에 맞춰 쌓는다 (긴 쪽끼리 맞춘다). */
function placeCrates(placer, b, rnd) {
  const a = axis(b);
  const nl = Math.max(1, Math.round(a.len / CRATE.len)), na = Math.max(1, Math.round(a.across / CRATE.w));
  const ny = Math.max(1, Math.round(b.h / CRATE.h));
  const ul = a.len / nl, ua = a.across / na, uy = b.h / ny;
  for (let y = 0; y < ny; y++) for (let l = 0; l < nl; l++) for (let c = 0; c < na; c++) {
    const ol = (l - (nl - 1) / 2) * ul, oc = (c - (na - 1) / 2) * ua;
    const jitter = (rnd() - 0.5) * 0.06;        // 살짝 비뚤게 — 기계로 찍어낸 것처럼 보이지 않게
    placer.add('Crate', b.x + (a.alongX ? ol : oc), b.y + y * uy, b.z + (a.alongX ? oc : ol),
      a.yaw + jitter + (rnd() < 0.5 ? Math.PI : 0), ua / CRATE.w * 0.98, uy / CRATE.h, ul / CRATE.len * 0.98);
  }
}

/** 박스 번호로 정해지는 난수 — 접속한 사람마다 같은 맵이 보이게 */
function random(seed) {
  let s = (seed * 2654435761 + 1013904223) >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- 크레인

// 가운데 부두 크레인 "Sokol" — 원본(42m)의 절반. 바닥에 깔렸던 판을 빼서 발이 1.19m 떠 있던 만큼 내린다.
// 동작(팔 오르내림 · 짐 옮기기, 26.7초)은 서버 시계에 맞춰 돌린다 — 모두의 화면에서 같은 자세다.
export const CRANE = { scale: 0.5, footY: 1.19 };
let craneMixer = null;

// 움직이는 발판 — 갈고리에 매달린 짐(빔)을 2 × 3m 철판으로 바꿔 탈 수 있게 한다.
// 충돌 박스(boxes 배열에 끼워 넣는다)를 매 프레임 짐 위치로 옮기고, 위에 선 사람은 main.js 가 같이 옮긴다.
const LOAD = { w: 2, h: 0.25, d: 3, drop: 0.8 };   // drop — 빔 바닥보다 이만큼 아래 (낮을 때 0.6m, 높을 때 1.75m)
export const craneLoad = { box: null, delta: new Vector3(), ready: false };
let loadNode = null, plate = null, cables = null;
const _box = new Box3(), _prev = new Vector3(), _c = new Vector3();

function loadCranes(scene, boxes) {
  loadModel(`${ASSET_BASE}models/crane_sokol.glb`).then((g) => {
    const root = g.scene;
    root.rotation.y = Math.PI;   // 팔이 -X (서쪽 광장) 로 — shared/map.js 충돌과 맞춘다
    root.scale.setScalar(CRANE.scale);
    root.position.y = -CRANE.footY * CRANE.scale;
    root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
    scene.add(root);
    const clip = g.animations[0];
    if (clip) { craneMixer = new AnimationMixer(root); craneMixer.clipAction(clip).play(); craneMixer.duration = clip.duration; }
    loadNode = root.getObjectByName('Decor_anim_1_Decor_0');
    if (loadNode) {
      loadNode.visible = false;
      const steel = new MeshStandardMaterial({ color: 0x5a4a3c, roughness: 0.55, metalness: 0.7 });
      plate = new Mesh(new BoxGeometry(LOAD.w, LOAD.h, LOAD.d), steel);
      const rib = new Mesh(new BoxGeometry(0.18, 0.18, LOAD.d * 0.95), steel);   // 들보 두 줄
      for (const x of [-0.6, 0.6]) { const r = rib.clone(); r.position.set(x, LOAD.h / 2 + 0.09, 0); plate.add(r); }
      cables = new LineSegments(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(24), 3)),
        new LineBasicMaterial({ color: 0x1a1a1a }));
      cables.frustumCulled = false;
      scene.add(plate, cables);
      craneLoad.box = { kind: 'craneLoad', x: 0, y: -10, z: 0, w: LOAD.w, h: LOAD.h, d: LOAD.d };
      boxes.push(craneLoad.box);
    }
  }).catch((e) => console.warn('[mapArt] 크레인 실패', e));
  // 바깥 배경 — 타워 크레인 둘 (철골이라 멀리서도 항구 느낌이 난다)
  loadModel(`${ASSET_BASE}models/crane_tower.glb`).then((g) => {
    // 안개에 묻히면 아예 안 보인다 — 안개를 끄고 어둡게 눌러 하늘 앞 실루엣으로
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.material.fog = false;
      o.material.color.multiplyScalar(0.28);
      o.material.envMapIntensity = 0.15;
    });
    const top = new Box3().setFromObject(g.scene).max.y;
    for (const [x, z, yaw, s] of [[-HALF_X - 13.5, -HALF_Z - 13.5, 0.6, 0.9], [HALF_X + 13.5, HALF_Z + 13.5, 2.4, 1]]) {   // 배경 줄 사이 빈 골목 (안개에 안 묻히게 가깝게)
      const c = g.scene.clone();
      c.position.set(x, 0, z);
      c.rotation.y = yaw;
      c.scale.setScalar(s);
      // 꼭대기 항공 장애등 (빨강)
      const red = new Mesh(new SphereGeometry(0.35, 8, 6), new MeshBasicMaterial({ color: 0xff2a1a, fog: false }));
      red.position.set(0, top + 0.4, 0);
      c.add(red);
      scene.add(c);
    }
  }).catch((e) => console.warn('[mapArt] 타워 크레인 실패', e));
}

/** 매 프레임 — 크레인 동작을 서버 시각에 맞추고, 철판 발판을 짐 자리로 옮긴다 */
export function updateMapArt(serverTime) {
  if (!craneMixer) return;
  craneMixer.setTime(((serverTime % craneMixer.duration) + craneMixer.duration) % craneMixer.duration);
  if (!loadNode) return;
  loadNode.updateWorldMatrix(true, false);
  _box.setFromObject(loadNode, true);
  _box.getCenter(_c);
  const b = craneLoad.box;
  _prev.set(b.x, b.y, b.z);
  b.x = _c.x; b.z = _c.z; b.y = _box.min.y - LOAD.drop - LOAD.h;
  craneLoad.delta.set(b.x - _prev.x, b.y - _prev.y, b.z - _prev.z);
  if (!craneLoad.ready || craneLoad.delta.lengthSq() > 4) craneLoad.delta.set(0, 0, 0);   // 처음 · 순간이동(되감기)은 옮기지 않는다
  craneLoad.ready = true;
  plate.position.set(b.x, b.y + LOAD.h / 2, b.z);
  // 갈고리(빔 위 가운데)에서 철판 네 귀퉁이로 줄
  const p = cables.geometry.attributes.position, top = _box.max.y;
  let i = 0;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    p.setXYZ(i++, _c.x, top, _c.z);
    p.setXYZ(i++, b.x + sx * LOAD.w * 0.45, b.y + LOAD.h, b.z + sz * LOAD.d * 0.45);
  }
  p.needsUpdate = true;
}

// ---------------------------------------------------------------- 야적장 소품

const YARD_MODEL = {
  tank: 'Tank', forklift: 'Forklift', pipe: 'Pipe', pipes: 'Pipes', reel: 'Reel',
  pipeStack: 'PipeStack', planks: 'Planks', cement: 'CementPallet',
};

/** 투광등 탑 — 8m 철 기둥 위 가로대에 투광등 둘. 광장 가운데를 향해 비춘다 (진짜 불빛 하나씩) */
function floodTowers(scene, root) {
  const head = root.getObjectByName('FloodHead');
  const steel = new MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.6, metalness: 0.7 });
  for (const [x, z] of FLOOD_TOWERS) {
    const g = new Group();
    g.position.set(x, 0, z);
    g.rotation.y = Math.atan2(-x, -z);   // +Z 가 광장 가운데로
    const pole = new Mesh(new CylinderGeometry(0.12, 0.16, 8, 8), steel);
    pole.position.y = 4.2;
    const base = new Mesh(new BoxGeometry(0.9, 0.4, 0.9), new MeshStandardMaterial({ color: 0x6b6862, roughness: 0.9 }));
    base.position.y = 0.2;
    const bar = new Mesh(new BoxGeometry(1.8, 0.1, 0.1), steel);
    bar.position.y = 8.1;
    g.add(pole, base, bar);
    if (head) {
      for (const sx of [-0.7, 0.7]) {
        const h = head.clone();
        h.position.set(sx, 7.6, 0.1);
        h.scale.setScalar(0.9);
        g.add(h);
      }
    }
    const glow = new Mesh(new BoxGeometry(1.5, 0.25, 0.05), new MeshBasicMaterial({ color: 0xfff1d6 }));
    glow.position.set(0, 8.3, 0.28);
    g.add(glow);
    scene.add(g);
    const l = new SpotLight(0xffe2b8, 260, 34, 0.62, 0.5, 2);
    l.position.set(x, 8.2, z);
    l.target.position.set(x * 0.25, 0, z * 0.25);
    scene.add(l, l.target);
  }
}

/**
 * 바닥 도색 — 컨테이너 터미널처럼 노란 실선 · 흰 점선 · 구역 번호 · 크레인 밑 빗금.
 * 맵 전체를 덮는 캔버스 한 장 (1px = 2.5cm). 창고 안(콘크리트 바닥)은 비운다.
 */
function laneMarkings() {
  const PX = 25, W = Math.round(HALF_X * 2 * PX), H = Math.round(HALF_Z * 2 * PX);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const X = (x) => (x + HALF_X) * PX, Z = (z) => (z + HALF_Z) * PX;
  const YEL = 'rgba(214,170,40,0.75)', WHT = 'rgba(225,225,215,0.6)';
  const line = (x0, z0, x1, z1, color, w = 0.15, dash = null) => {
    g.strokeStyle = color; g.lineWidth = w * PX; g.setLineDash(dash ? dash.map((d) => d * PX) : []);
    g.beginPath(); g.moveTo(X(x0), Z(z0)); g.lineTo(X(x1), Z(z1)); g.stroke();
  };
  // 서쪽 골목 — 골목마다 흰 점선 가운데 줄
  for (const z of [-16.75, -10.25, -3.5, 3.5, 10.25, 16.75, 23.2]) line(-38.5, z, -15.5, z, WHT, 0.12, [1.6, 1.2]);
  // 광장 테두리 — 노란 실선 두 줄 (골목 · 하역장과 경계)
  for (const x of [-14.6, 14.2]) { line(x, -25, x, 25, YEL, 0.14); line(x + 0.35, -25, x + 0.35, 25, YEL, 0.14); }
  // 크레인 둘레 위험 구역 — 노란 사각형 + 빗금
  g.save();
  g.beginPath(); g.rect(X(-5.2), Z(-4.8), 10.4 * PX, 9.6 * PX); g.clip();
  for (let k = -20; k < 20; k += 1.2) line(-5.2 + k, -4.8, -5.2 + k + 9.6, 4.8, 'rgba(214,170,40,0.32)', 0.25);
  g.restore();
  g.setLineDash([]); g.strokeStyle = YEL; g.lineWidth = 0.18 * PX; g.strokeRect(X(-5.2), Z(-4.8), 10.4 * PX, 9.6 * PX);
  // 철판 지나가는 길 — 흰 점선 테두리
  g.strokeStyle = WHT; g.lineWidth = 0.12 * PX; g.setLineDash([0.8 * PX, 0.6 * PX]); g.strokeRect(X(-16), Z(-1.8), 10 * PX, 3.6 * PX);
  // 하역장 앞 — 트럭 대는 칸 (흰 선)
  for (const z of [-9, -3, 3, 9]) line(15.2, z, 20.6, z, WHT, 0.14);
  // 구역 번호 (골목 입구 바닥)
  g.setLineDash([]); g.fillStyle = 'rgba(214,170,40,0.55)'; g.font = `bold ${1.4 * PX}px Oswald, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  [['A1', -16.75], ['A2', -10.25], ['A3', -3.5], ['A4', 3.5], ['A5', 10.25], ['A6', 16.75]].forEach(([t, z]) => {
    g.save(); g.translate(X(-16.6), Z(z)); g.rotate(-Math.PI / 2); g.fillText(t, 0, 0); g.restore();
  });
  // 닳은 느낌 — 군데군데 지운다
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.5})`;
    g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 14, 2 + Math.random() * 6);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const m = new Mesh(new PlaneGeometry(HALF_X * 2, HALF_Z * 2), new MeshStandardMaterial({
    map: tex, transparent: true, depthWrite: false, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2,
  }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.012;
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------- 테두리 난간

/**
 * 테두리 컨테이너 위, 좀비가 더 못 나가는 선(clampToArena 0 = ±HALF)에 노란 안전 난간.
 * 맵 끝이 어디인지 한눈에 보이게 한다. 충돌은 없다 (어차피 그 선에서 막힌다).
 */
function edgeRailing() {
  const g = new Group();
  const mat = new MeshStandardMaterial({ color: 0xc79a1e, roughness: 0.55, metalness: 0.35 });
  const Y = 5.2, H = 1.05, X = HALF_X + 0.55, Z = HALF_Z + 0.55;   // 좀비 몸(반경 0.46) 바로 바깥
  const post = new BoxGeometry(0.08, H, 0.08);
  const sides = [[-X, -Z, X, -Z], [-X, Z, X, Z], [-X, -Z, -X, Z], [X, -Z, X, Z]];
  let n = 0;
  for (const [x0, z0, x1, z1] of sides) n += Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2) + 1;
  const posts = new InstancedMesh(post, mat, n);
  const m = new Matrix4();
  let i = 0;
  for (const [x0, z0, x1, z1] of sides) {
    const len = Math.hypot(x1 - x0, z1 - z0), k = Math.ceil(len / 2);
    for (let j = 0; j <= k; j++) posts.setMatrixAt(i++, m.makeTranslation(x0 + ((x1 - x0) * j) / k, Y + H / 2, z0 + ((z1 - z0) * j) / k));
    for (const h of [H, H * 0.5]) {
      const rail = new Mesh(new BoxGeometry(x1 === x0 ? 0.06 : len, 0.06, x1 === x0 ? len : 0.06), mat);
      rail.position.set((x0 + x1) / 2, Y + h, (z0 + z1) / 2);
      g.add(rail);
    }
  }
  g.add(posts);
  return g;
}

// ---------------------------------------------------------------- 바깥 야적장

/**
 * 테두리 너머 — 줄지어 쌓인 컨테이너 더미 (충돌 없음, 겉모습만). 좀비가 테두리 위에 올라서도
 * 숲 · 빈 바닥이 아니라 계속 이어지는 야적장이 보인다. 안개가 먼 줄을 덮는다.
 */
function placeBackdrop(placer) {
  const rnd = random(4242);
  const ring = (gap, depth) => {
    // 북 · 남 줄 (X 로 긴 컨테이너), 동 · 서 줄 (Z 로 긴 컨테이너)
    for (const sz of [-1, 1]) {
      for (let x = -HALF_X - depth; x < HALF_X + depth; x += 12.6) {
        if (rnd() < 0.18) continue;   // 빈 칸 — 줄이 끊겨 보이게
        const tiers = 1 + Math.floor(rnd() * 4);
        placeContainers(placer, { x: x + 6, y: 0, z: sz * (HALF_Z + gap), w: 12.2, h: 2.6 * tiers, d: 2.5 }, 900 + Math.floor(rnd() * 1e4));
      }
    }
    for (const sx of [-1, 1]) {
      for (let z = -HALF_Z - depth + 3; z < HALF_Z + depth - 3; z += 12.6) {
        if (rnd() < 0.18) continue;
        const tiers = 1 + Math.floor(rnd() * 4);
        placeContainers(placer, { x: sx * (HALF_X + gap), y: 0, z: z + 6, w: 2.5, h: 2.6 * tiers, d: 12.2 }, 900 + Math.floor(rnd() * 1e4));
      }
    }
  };
  // 테두리 바로 뒤는 비워 둔다 (빈 도로) — 붙어 있으면 좀비 눈에 걸어갈 수 있는 맵처럼 보인다
  ring(15, 16);
  ring(18, 19);
  ring(25, 27);
  ring(31, 33);
}

// ---------------------------------------------------------------- 밤하늘

function loadSky(scene, renderer) {
  new EXRLoader().loadAsync(`${ASSET_BASE}textures/map/night_env.exr`).then((tex) => {
    const pmrem = new PMREMGenerator(renderer);
    tex.mapping = EquirectangularReflectionMapping;
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    scene.environmentIntensity = LIGHT.env;
    tex.dispose();
    pmrem.dispose();
  }).catch((e) => console.warn('[mapArt] 밤하늘 조명 실패', e));
  // 배경은 사진(숲이 비쳤다) 대신 그라데이션 — 위는 검푸르고, 지평선은 항구 나트륨 불빛이 번져 탁한 주황
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#03050a');
  grad.addColorStop(0.35, '#080c16');
  grad.addColorStop(0.47, '#1d1c1f');
  grad.addColorStop(0.5, '#2e2720');
  grad.addColorStop(0.53, '#14120f');
  grad.addColorStop(1, '#07070a');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const sky = new CanvasTexture(c);
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  scene.background = sky;
  scene.backgroundIntensity = 1;
}
