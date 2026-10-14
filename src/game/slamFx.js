// 슈퍼점프 착지 이펙트 — 바닥을 따라 퍼지는 흙먼지 · 튀어 오르는 파편 · 그을린 자국.
// 텍스처는 Kenney Particle Pack (CC0) — public/textures/fx.
//
// 스프라이트는 조명을 안 받으므로 밤 맵에 맞게 색을 어둡게 눌러 둔다.

import {
  DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Sprite, SpriteMaterial, TextureLoader,
} from 'three';
import { ASSET_BASE } from '../core/assets.js';

const SMOKE = ['smoke1', 'smoke2', 'smoke3'];
const DIRT = ['dirt1', 'dirt2'];
const MAX_DECALS = 4;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

const loader = new TextureLoader();
const textures = new Map();
function tex(name) {
  if (!textures.has(name)) {
    const t = loader.load(`${ASSET_BASE}textures/fx/${name}.png`);
    t.colorSpace = SRGBColorSpace;
    textures.set(name, t);
  }
  return textures.get(name);
}

export class SlamFx {
  constructor(scene) {
    this.scene = scene;
    this.parts = [];
    this.decals = [];
    this.decalGeo = new PlaneGeometry(1, 1);
  }

  /** 착지 지점 (x, y, z) 와 충격 반경 */
  spawn(x, y, z, radius) {
    // 바닥을 따라 밖으로 밀려나는 흙먼지 — 처음엔 빠르고 점점 느려지며 커진다
    const ring = 16;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2 + rand(-0.15, 0.15);
      const sp = rand(0.9, 1.3) * radius * 1.1;
      this.add(pick(SMOKE), x, y + 0.3, z, {
        vx: Math.cos(a) * sp, vy: rand(0.2, 0.8), vz: Math.sin(a) * sp,
        drag: 3.2, grav: 0, s0: rand(0.9, 1.4), s1: rand(2.6, 3.6),
        life: rand(1.3, 1.9), alpha: 0.72, color: 0x9a8f80,
      });
    }
    // 가운데서 솟는 먼지 기둥
    for (let i = 0; i < 5; i++) {
      this.add(pick(SMOKE), x + rand(-0.6, 0.6), y + 0.5, z + rand(-0.6, 0.6), {
        vx: rand(-0.5, 0.5), vy: rand(2.5, 4.5), vz: rand(-0.5, 0.5),
        drag: 1.6, grav: 0, s0: 1.2, s1: rand(3.2, 4.2),
        life: rand(1.6, 2.2), alpha: 0.6, color: 0x8a8072,
      });
    }
    // 튀어 오르는 흙 · 돌 파편
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, sp = rand(2, 6);
      this.add(pick(DIRT), x, y + 0.2, z, {
        vx: Math.cos(a) * sp, vy: rand(4, 8.5), vz: Math.sin(a) * sp,
        drag: 0.4, grav: 18, floor: y + 0.08, s0: rand(0.35, 0.6), s1: rand(0.3, 0.5),
        life: rand(0.8, 1.2), alpha: 0.95, color: 0x6a5c50,
      });
    }
    // 찰나의 섬광 (충격 순간)
    this.add('scorch', x, y + 0.4, z, {
      vx: 0, vy: 0, vz: 0, drag: 0, grav: 0, s0: radius * 0.5, s1: radius * 0.9,
      life: 0.18, alpha: 0.5, color: 0xffb27a, additive: true,
    });
    this.decal(x, y, z, radius);
  }

  add(name, x, y, z, o) {
    const m = new SpriteMaterial({
      map: tex(name), color: o.color, transparent: true, depthWrite: false,
      rotation: Math.random() * Math.PI * 2, opacity: o.alpha,
      blending: o.additive ? 2 : 1,   // AdditiveBlending : NormalBlending
    });
    const s = new Sprite(m);
    s.position.set(x, y, z);
    s.scale.setScalar(o.s0);
    s.userData = { ...o, t: 0, spin: rand(-0.6, 0.6) };
    this.scene.add(s);
    this.parts.push(s);
  }

  /** 바닥에 남는 그을린 자국 — 몇 초 있다가 옅어진다 */
  decal(x, y, z, radius) {
    while (this.decals.length >= MAX_DECALS) this.drop(this.decals.shift());
    const m = new Mesh(this.decalGeo, new MeshBasicMaterial({
      map: tex('scorch'), color: 0x000000, transparent: true, opacity: 0.7, depthWrite: false,
      side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(x, y + 0.03, z);
    m.scale.setScalar(radius * 1.1);
    m.userData.t = 0;
    this.scene.add(m);
    this.decals.push(m);
  }

  drop(o) {
    this.scene.remove(o);
    o.material.dispose();
  }

  update(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const s = this.parts[i], u = s.userData;
      u.t += dt / u.life;
      if (u.t >= 1) { this.drop(s); this.parts.splice(i, 1); continue; }
      const k = Math.exp(-u.drag * dt);
      u.vx *= k; u.vz *= k; u.vy = u.vy * k - u.grav * dt;
      s.position.x += u.vx * dt; s.position.y += u.vy * dt; s.position.z += u.vz * dt;
      if (u.floor !== undefined && s.position.y < u.floor) { s.position.y = u.floor; u.vy = 0; u.vx *= 0.5; u.vz *= 0.5; }
      s.scale.setScalar(u.s0 + (u.s1 - u.s0) * (1 - (1 - u.t) ** 2));
      s.material.rotation += u.spin * dt;
      // 처음 10% 는 피어오르고, 나머지 동안 사라진다
      s.material.opacity = u.alpha * (u.t < 0.1 ? u.t / 0.1 : 1 - (u.t - 0.1) / 0.9);
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.userData.t += dt;
      const fade = Math.min(1, Math.max(0, (d.userData.t - 4) / 2.5));   // 4초 뒤부터 2.5초에 걸쳐
      d.material.opacity = 0.7 * (1 - fade);
      if (fade >= 1) { this.drop(d); this.decals.splice(i, 1); }
    }
  }
}
