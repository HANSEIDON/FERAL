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
  EquirectangularReflectionMapping, InstancedMesh, Matrix4, PMREMGenerator, PointLight,
  Quaternion, SpotLight, SRGBColorSpace, TextureLoader, Vector3,
} from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { ASSET_BASE, loadModel } from '../core/assets.js';
import { SECURITY_LIGHTS } from '../../shared/map.js';
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

  boxes.forEach((b, i) => {
    const rnd = random(i);
    switch (b.kind) {
      case 'container': placeContainers(placer, b, i); break;
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
  placer.add('Crane', 0, 0, 0, 0);

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
  new TextureLoader().loadAsync(`${ASSET_BASE}textures/map/night_sky.jpg`).then((tex) => {
    tex.mapping = EquirectangularReflectionMapping;
    tex.colorSpace = SRGBColorSpace;
    scene.background = tex;
    scene.backgroundIntensity = LIGHT.sky;
  }).catch((e) => console.warn('[mapArt] 밤하늘 배경 실패', e));
}
