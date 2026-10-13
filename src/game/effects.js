// 타격감. 총알선 · 총구 섬광 · 피격 표시 · 화면 흔들림.
//
// 전부 지오메트리 재사용으로 돌린다 — 발사할 때마다 객체를 새로 만들면
// 연사 중에 GC 가 튀어서 프레임이 끊긴다.

import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CircleGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, RingGeometry, SphereGeometry, Vector3,
} from 'three';
import { WORLD } from '../../shared/config.js';

const MAX_TRACERS = 24;
const TRACER_LIFE = 0.06;
const UP = new Vector3(0, 1, 0);   // 화살(실린더)의 축 — 비행 방향으로 돌린다
// 원격 화살 시각용 포물선 중력 — main.js 의 ARROW_GRAVITY 와 같은 값으로 맞춰야 한다
const ARC_GRAV = Math.abs(WORLD.gravity) * 0.4;

export class Effects {
  constructor(scene) {
    this.scene = scene;

    // 총알선 — 선분 여러 개를 한 지오메트리에 담아 드로우콜 1회로 그린다
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3));
    this.tracerGeo = g;
    this.tracers = new LineSegments(g, new LineBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.8,
      blending: AdditiveBlending, depthWrite: false,
    }));
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);

    this.pool = [];         // { from, to, until }
    this.shake = 0;
    this.shakeDecay = 7;
  }

  addTracer(from, to) {
    this.pool.push({ from: from.clone(), to: to.clone(), until: performance.now() / 1000 + TRACER_LIFE });
    if (this.pool.length > MAX_TRACERS) this.pool.shift();
  }

  /**
   * 화살 — from 에서 to 로 주어진 속도(m/s)로 날아간다.
   * 장전이 길수록 속도가 빨라 비행시간이 짧아진다.
   * 엔트리를 돌려주므로 중간에 명중하면 killArrow 로 없앨 수 있다.
   */
  /** 화살 그룹 하나를 만든다. 풀 초기화와 폴백에서 함께 쓴다. 축은 +Y, 가운데가 원점. */
  _makeArrow() {
    const g = new Group();
    this._dressArrow(g);
    g.visible = false;
    this.scene.add(g);
    return g;
  }

  /**
   * 날아가는 화살을 모델로 바꾼다 — 사냥꾼이 시위에 건 것과 같은 화살.
   * 모델 받기 전에 만들어 둔 화살(풀 · 비행 중)도 갈아 입힌다.
   * @param model 오늬 = 원점, 촉 = +Z 인 메시 (remotePlayers.getArrowModel)
   */
  setArrowModel(model) {
    this.arrowModel = model;
    for (const g of [...(this.arrowPool ?? []), ...(this.arrows ?? [])]) this._dressArrow(g);
  }

  _dressArrow(g) {
    g.clear();
    if (this.arrowModel) {
      const m = this.arrowModel.clone();
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const len = m.geometry.boundingBox.max.z;
      m.rotation.set(-Math.PI / 2, 0, 0);   // +Z(촉) → +Y
      m.position.set(0, -len / 2, 0);       // 가운데를 원점에
      g.add(m);
      return;
    }
    // 모델이 없으면 원통 + 원뿔
    const shaft = new Mesh(
      new CylinderGeometry(0.014, 0.014, 0.62, 6),
      new MeshBasicMaterial({ color: 0xd8c9a3 }),
    );
    const head = new Mesh(
      new ConeGeometry(0.04, 0.15, 8),
      new MeshBasicMaterial({ color: 0x9aa4b5 }),
    );
    head.position.y = 0.38;
    g.add(shaft, head);
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.driven] true 면 위치·수명을 main.js 의 물리가 직접 조종한다
   *   (내 화살). false 면(기본, 원격 화살) from→to 를 포물선으로 보간해 보인다.
   */
  addArrow(from, to, speed = 100, opts) {
    if (!this.arrows) {
      this.arrows = [];
      this.arrowPool = [];
      for (let i = 0; i < 8; i++) this.arrowPool.push(this._makeArrow());
    }
    let a = this.arrowPool.pop();
    if (!a) a = this.arrows.shift();   // 풀이 비면 가장 오래된 것을 재사용
    if (!a) a = this._makeArrow();    // 둘 다 없으면(풀 누수) 새로 만들어 크래시를 막는다
    const dir = new Vector3().subVectors(to, from);
    const dist = dir.length();
    if (dist > 1e-4) dir.divideScalar(dist);
    a.position.copy(from);
    a.quaternion.setFromUnitVectors(UP, dir);
    a.visible = true;
    if (opts?.driven) {
      a.userData = { driven: true };   // main.js 가 매 프레임 위치·방향을 쓴다
    } else {
      const life = Math.max(0.05, dist / speed);
      // 포물선 정점 높이 — 비행이 길수록(장전이 짧아 느릴수록) 크게 휘어진다
      a.userData = { from: from.clone(), to: to.clone(), t: 0, life, arc: 0.125 * ARC_GRAV * life * life };   // 포물선 정점 = g·T²/8
    }
    this.arrows.push(a);
    return a;
  }

  /** 화살이 명중·사거리 초과로 사라지면 바로 회수한다.
   *  이미 update 루프에서 만료되어 풀로 돌아간 화살을 다시 push 하면
   *  같은 Group 이 풀에 두 번 들어가므로, arrows 에 실제로 있을 때만 회수한다. */
  killArrow(a) {
    if (!a) return;
    const i = this.arrows.indexOf(a);
    if (i >= 0) {
      this.arrows.splice(i, 1);
      this.arrowPool.push(a);
    }
    a.visible = false;
  }

  /** 피격·발사 시 화면을 살짝 흔든다. */
  kick(amount) {
    this.shake = Math.min(0.35, this.shake + amount);
  }

  /**
   * 타격 지점 버스트 — 주먹·탄이 정확히 닿은 위치에 빛이 번진다.
   * "조준점이 실제로 맞는 지점인지"가 한눈에 보이도록.
   * 헤드샷은 더 크고 붉게.
   */
  impact(point, head = false) {
    if (!this.impacts) {
      this.impacts = [];
      this.impactPool = [];
      for (let i = 0; i < 6; i++) {
        const m = new Mesh(
          new SphereGeometry(1, 12, 8),
          new MeshBasicMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending }),
        );
        m.visible = false;
        this.scene.add(m);
        this.impactPool.push(m);
      }
    }
    let m = this.impactPool.pop();
    if (!m) m = this.impacts.shift();   // 풀이 비면 가장 오래된 것을 재사용
    m.material.color.set(head ? 0xff5a4a : 0xffe2a8);
    m.position.copy(point);
    m.scale.setScalar(0.05);
    m.visible = true;
    m.userData = { t: 0, head };
    this.impacts.push(m);
  }

  /**
   * 탄착군 — 벽·상자에 탄이 박힌 자국. 6초 있다가 1초 동안 사라진다.
   * 풀을 재사용해서 연사해도 GC 가 튀지 않는다.
   */
  bulletHole(point, normal) {
    if (!this.holes) {
      this.holes = [];
      this.holePool = [];
      for (let i = 0; i < 48; i++) {
        const m = new Mesh(
          new CircleGeometry(0.028 + Math.random() * 0.02, 10),
          new MeshBasicMaterial({ color: 0x101318, transparent: true, depthWrite: false }),
        );
        m.visible = false;
        this.scene.add(m);
        this.holePool.push(m);
      }
    }
    let m = this.holePool.pop();
    if (!m) m = this.holes.shift();   // 풀이 비면 가장 오래된 자국을 덮쓴다
    // 벽면에서 살짝 띄워야 Z-fighting 으로 깜빡이지 않는다
    m.position.copy(point).addScaledVector(normal, 0.015);
    m.lookAt(point.x + normal.x, point.y + normal.y, point.z + normal.z);
    m.material.opacity = 0.9;
    m.visible = true;
    m.userData.t = 0;
    this.holes.push(m);
  }

  /** 슈퍼점프 착지 — 바닥에 퍼지는 충격파 고리. */
  slam(x, z, radius) {
    if (!this.rings) {
      this.rings = [];
      this.ringPool = [];
    }
    let ring = this.ringPool.pop();
    if (!ring) {
      ring = new Mesh(
        new RingGeometry(0.82, 1, 40),
        new MeshBasicMaterial({
          color: 0xff9a4a, transparent: true, side: DoubleSide,
          depthWrite: false, blending: AdditiveBlending,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      this.scene.add(ring);
    }
    ring.position.set(x, 0.06, z);
    ring.visible = true;
    ring.userData = { t: 0, radius };
    this.rings.push(ring);
    this.spawnDust(x, z);
  }

  /** 슈퍼점프 착지 — 바닥에서 밖으로 튀어오르는 먼지.
   *  메서드 이름을 this.dust 배열과 겹치게 하면(!this.dust) 체크가
   *  메서드 자체를 보고 초기화를 건너뛰므로 spawnDust 로 둔다. */
  spawnDust(x, z) {
    if (!this.dust) {
      this.dust = [];
      this.dustPool = [];
      for (let i = 0; i < 18; i++) {
        const m = new Mesh(
          new SphereGeometry(1, 6, 5),
          new MeshBasicMaterial({ color: 0x9a8a72, transparent: true, depthWrite: false }),
        );
        m.visible = false;
        this.scene.add(m);
        this.dustPool.push(m);
      }
    }
    for (let i = 0; i < 18; i++) {
      const m = this.dustPool.pop() ?? this.dust.shift();
      if (!m) break;
      const a = Math.random() * Math.PI * 2;
      const sp = 2.5 + Math.random() * 4.5;
      m.position.set(x, 0.15, z);
      m.scale.setScalar(0.1 + Math.random() * 0.16);
      m.visible = true;
      m.userData = {
        t: 0,
        life: 0.45 + Math.random() * 0.3,
        vx: Math.cos(a) * sp, vz: Math.sin(a) * sp,
        vy: 1.5 + Math.random() * 3.5,
      };
      this.dust.push(m);
    }
  }

  update(dt, camera) {
    const t = performance.now() / 1000;
    this.pool = this.pool.filter((x) => x.until > t);

    const pos = this.tracerGeo.attributes.position;
    const arr = pos.array;
    arr.fill(0);
    this.pool.forEach((x, i) => {
      const o = i * 6;
      arr[o] = x.from.x; arr[o + 1] = x.from.y; arr[o + 2] = x.from.z;
      arr[o + 3] = x.to.x; arr[o + 4] = x.to.y; arr[o + 5] = x.to.z;
    });
    pos.needsUpdate = true;
    this.tracers.visible = this.pool.length > 0;

    // 화살 — 주어진 속도로 from→to 를 날아가며, 명중하면 killArrow 가 먼저 회수한다
    if (this.arrows?.length) {
      for (let i = this.arrows.length - 1; i >= 0; i--) {
        const a = this.arrows[i];
        if (!a) { this.arrows.splice(i, 1); continue; }
        const u = a.userData;
        if (u.driven) continue;   // 물리(main.js)가 위치를 직접 조종 — 여기서 건드리지 않는다
        u.t += dt / u.life;
        if (u.t >= 1) {
          a.visible = false;
          this.arrowPool.push(a);
          this.arrows.splice(i, 1);
          continue;
        }
        const t = u.t;
        a.position.lerpVectors(u.from, u.to, t);
        a.position.y += u.arc * 4 * t * (1 - t);   // 포물선 — 느린 화살일수록 크게 휘어진다
      }
    }

    // 타격 지점 버스트 — 0.18초에 걸쳐 퍼지며 사라진다
    if (this.impacts?.length) {
      for (let i = this.impacts.length - 1; i >= 0; i--) {
        const m = this.impacts[i];
        if (!m) { this.impacts.splice(i, 1); continue; }   // 깨진 엔트리는 렌더 죽이지 말고 빼라
        const u = m.userData;
        u.t += dt / 0.18;
        if (u.t >= 1) {
          m.visible = false;
          this.impactPool.push(m);
          this.impacts.splice(i, 1);
          continue;
        }
        const s = (u.head ? 0.34 : 0.22) * (0.3 + 0.7 * u.t);
        m.scale.setScalar(s);
        m.material.opacity = 0.9 * (1 - u.t);
      }
    }

    // 탄착군 — 6초 머물고, 마지막 1초에 사라진다
    if (this.holes?.length) {
      for (let i = this.holes.length - 1; i >= 0; i--) {
        const m = this.holes[i];
        m.userData.t += dt;
        if (m.userData.t >= 6) {
          m.visible = false;
          this.holePool.push(m);
          this.holes.splice(i, 1);
          continue;
        }
        if (m.userData.t > 5) m.material.opacity = 0.9 * (1 - (m.userData.t - 5));
      }
    }

    // 먼지 — 밖으로 튀어올랐다가 떨어지며 사라진다
    if (this.dust?.length) {
      for (let i = this.dust.length - 1; i >= 0; i--) {
        const m = this.dust[i];
        if (!m) { this.dust.splice(i, 1); continue; }   // 깨진 엔트리는 렌더 죽이지 말고 빼라
        const u = m.userData;
        u.t += dt / u.life;
        if (u.t >= 1) {
          m.visible = false;
          this.dustPool.push(m);
          this.dust.splice(i, 1);
          continue;
        }
        m.position.x += u.vx * dt;
        m.position.z += u.vz * dt;
        m.position.y = Math.max(0.05, m.position.y + u.vy * dt);
        u.vy -= 9.8 * dt;
        m.material.opacity = 0.75 * (1 - u.t);
      }
    }

    // 충격파 고리 — 0.5초에 걸쳐 퍼지며 사라진다
    if (this.rings?.length) {
      for (let i = this.rings.length - 1; i >= 0; i--) {
        const ring = this.rings[i];
        if (!ring) { this.rings.splice(i, 1); continue; }
        const u = ring.userData;
        u.t += dt / 0.5;
        if (u.t >= 1) {
          ring.visible = false;
          this.ringPool.push(ring);
          this.rings.splice(i, 1);
          continue;
        }
        const s = u.radius * (0.15 + 0.85 * u.t);
        ring.scale.set(s, s, s);
        ring.material.opacity = 0.85 * (1 - u.t);
      }
    }

    // 흔들림은 카메라 회전에 얹는다 (위치를 흔들면 벽을 뚫는다)
    if (this.shake > 0.0005) {
      camera.rotation.x += (Math.random() - 0.5) * this.shake * 0.12;
      camera.rotation.y += (Math.random() - 0.5) * this.shake * 0.12;
      this.shake = Math.max(0, this.shake - this.shakeDecay * this.shake * dt);
    } else {
      this.shake = 0;
    }
  }
}
