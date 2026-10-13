// 내가 조종하는 플레이어. 이동·점프·시점은 내 브라우저가 계산하고
// 결과 위치만 서버에 보고한다 (서버는 체력과 승패만 판정한다).
//
// 능력치는 전부 loadout 에서 읽는다 — 직업이 바뀌면 속도·체력이 저절로 따라온다.

import { Euler, Vector3 } from 'three';
import { WORLD } from '../../shared/config.js';
import { groundHeight, resolveCollision } from './world.js';
import { clampToArena } from '../../shared/map.js';

const HALF_PI = Math.PI / 2 - 0.01;

/** 그냥 걸어서 올라설 수 있는 턱 높이. 이보다 높으면 점프해야 한다. */
const STEP_HEIGHT = 0.35;
/** 쓰러진 생존자가 기어가는 속도 (m/s). 걷기(4.5)의 1/8 — 도망은 못 치고 동료 쪽으로 붙을 만큼 */
export const CRAWL_SPEED = 0.55;

/** 물리 한 조각의 최대 길이. 프레임이 길어도 이 단위로 쪼개서 돈다. */
const MAX_STEP = 1 / 60;
const MAX_SUBSTEPS = 8;

export class LocalPlayer {
  constructor(boxes) {
    this.boxes = boxes;
    this.pos = new Vector3(0, 0, 0);
    this.vel = new Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;
    this.stamina = 100;
    this.slowMul = 1;         // 활 장전처럼 외부에서 걸리는 이동 감속 배수
    this.noJump = false;      // 활 장전 중처럼 외부에서 점프를 잠그는 플래그
    this.sprinting = false;
    this.exhausted = false;    // 스테미나 0 → 30% 회복할 때까지 스프린트 불가

    /** 서버가 배정해준 능력치. 라운드가 시작되면 채워진다. */
    this.loadout = null;
  }

  setLoadout(l) {
    this.loadout = l;
    this.stamina = l.staminaMax ?? 0;
    // 덩치가 역할마다 다르다. 눈은 키의 92% 쯤에 둔다.
    this.height = l.height ?? 1.75;
    this.radius = l.radius ?? WORLD.playerRadius;
    this.eyeHeight = this.height * 0.92;
    this.rageUntil = 0;
    this.charge = 0;
    this.slamPending = false;
    this.usesCharge = l.role === 'zombie';   // 스페이스가 충전인가
  }

  /** R 광폭화 — 서버가 확정해준 시각까지 빨라진다. */
  setRage(until) { this.rageUntil = until; }
  get raging() { return this.rageUntil > Date.now() / 1000; }

  teleport(x, y, z) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
  }

  /**
   * 슈퍼점프 충전 상태를 갱신한다 (좀비 전용).
   * 스페이스를 땅에서 꾹 누르고 있으면 차오르고, 떼면 그 비율만큼 뛴다.
   *
   * @returns {'super'|'hop'|null}  떼는 순간의 결과. 누르고 있는 동안은 null.
   */
  updateCharge(dt, holding, z) {
    if (!this.usesCharge) { this.charge = 0; return null; }

    if (holding) {
      if (this.onGround) this.charge = Math.min(1, this.charge + dt / z.chargeMaxSec);
      this.wasHolding = true;
      return null;
    }

    if (!this.wasHolding) return null;      // 애초에 안 눌렀다
    this.wasHolding = false;

    const c = this.charge;
    this.charge = 0;
    if (!this.onGround) return null;        // 공중에서 뗐으면 아무 일 없음

    // 살짝 눌렀다 뗀 건 그냥 제자리 점프
    if (c < z.chargeMinSec / z.chargeMaxSec) return 'hop';
    this.lastCharge = c;
    return 'super';
  }

  /** 모은 만큼 위로·앞으로 튀어오른다. */
  superJump(c, z) {
    const dir = this.forward();
    this.vel.y = z.superJumpSpeed * (0.55 + 0.45 * c);
    this.vel.x += dir.x * z.superJumpForward * c;
    this.vel.z += dir.z * z.superJumpForward * c;
    this.onGround = false;
    this.slamPending = true;      // 착지하면 광범위 공격
  }

  /** 좀비 돌진 — 바라보는 방향으로 순간 가속. */
  lunge(speed) {
    const dir = this.forward();
    this.vel.x = dir.x * speed;
    this.vel.z = dir.z * speed;
    if (this.onGround) this.vel.y = 3.2;
  }

  forward() {
    return new Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  lookEuler() {
    return new Euler(this.pitch, this.yaw, 0, 'YXZ');
  }

  look(dx, dy) {
    this.yaw -= dx;
    this.pitch = Math.max(-HALF_PI, Math.min(HALF_PI, this.pitch - dy));
  }

  /**
   * 프레임이 길어져도 한 번에 훌쩍 뛰지 않게 잘게 쪼개서 돌린다.
   *
   * 프레임이 100ms 걸리면 6.5m/s 로 0.65m 를 한 번에 이동한다 — 그게
   * 화면에서 순간이동으로 보인다. 벽을 뚫고 지나갈 위험도 같이 커진다.
   * 쪼개면 이동이 이어져 보이고 충돌도 제대로 걸린다.
   */
  update(dt, input) {
    const n = Math.min(MAX_SUBSTEPS, Math.ceil(dt / MAX_STEP));
    if (n <= 1) { this.step(dt, input); return; }

    const h = dt / n;
    const held = { has: (a) => input.has(a), took: () => false };
    let landed = false;
    for (let i = 0; i < n; i++) {
      // 점프처럼 "이번 프레임에 눌렸다" 는 입력은 첫 조각에서만 먹는다
      this.step(h, i === 0 ? input : held);
      if (this.justLanded) landed = true;   // 중간 조각에서 착지했어도 남긴다
    }
    this.justLanded = landed;
  }

  step(dt, input) {
    const L = this.loadout;
    if (!L) return;

    // ── 이동 입력을 월드 방향으로 ──
    let ix = 0, iz = 0;
    if (input.has('fwd')) iz -= 1;
    if (input.has('back')) iz += 1;
    if (input.has('left')) ix -= 1;
    if (input.has('right')) ix += 1;

    const len = Math.hypot(ix, iz);
    if (len > 0) { ix /= len; iz /= len; }

    // 입력(ix=오른쪽, iz=뒤)을 yaw 로 돌려 월드 방향으로 바꾼다.
    //   앞  = (-sin, 0, -cos)   ← forward() 와 같아야 한다
    //   오른= ( cos, 0, -sin)
    //   월드 = 앞*(-iz) + 오른*ix
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = ix * cos + iz * sin;
    const wz = iz * cos - ix * sin;

    // ── 질주와 스태미나 ──
    const wantSprint = !this.crawling && input.has('sprint') && len > 0 && L.staminaMax > 0;
    this.sprinting = wantSprint && !this.exhausted && this.stamina > 0;

    // 광폭화 중에는 질주해도 스태미나가 줄지 않는다 (탈진해 있어도 바로 뛴다)
    if (this.raging && wantSprint) { this.sprinting = true; this.exhausted = false; }
    if (this.sprinting && this.raging) {
      // 그대로 — 광폭화 동안은 스태미나를 쓰지 않는다
    } else if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - L.staminaDrain * dt);
      if (this.stamina <= 0) this.exhausted = true;   // 바닥 → 탈진
    } else if (L.staminaMax > 0) {
      this.stamina = Math.min(L.staminaMax, this.stamina + L.staminaRegen * dt);
      if (this.exhausted && this.stamina >= L.staminaMax * 0.3) this.exhausted = false;
    }

    let speed = L.speed * (this.sprinting ? L.sprintMul : 1);
    // 쓰러지면 엎드려 기어서만 움직인다 — 동료 쪽으로 조금씩 (질주 · 점프 없음)
    if (this.crawling) speed = CRAWL_SPEED;
    if (this.raging) speed *= L.rageSpeedMul ?? 1;                 // R 광폭화
    // 슈퍼점프를 모으는 동안은 굼뜨다 — 쓸지 말지 고민하게 만든다
    if ((this.charge ?? 0) > 0 && this.onGround) speed *= L.chargeSlowMul ?? 1;
    // 활을 당기고 있으면 느리게 — 풀장전 조준을 하려면 멈춰야 한다
    speed *= this.slowMul ?? 1;

    // ── 지면에서는 즉시 반응, 공중에서는 관성 ──
    const target = new Vector3(wx * speed, 0, wz * speed);
    if (this.onGround) {
      this.vel.x = target.x;
      this.vel.z = target.z;
    } else {
      // 공중에서는 관성을 지키고 방향만 조금 튼다.
      // 목표 속도로 보간해버리면 슈퍼점프·돌진의 탄력이 공중에서 죽는다.
      const accel = speed * 1.8 * dt;
      this.vel.x += wx * accel;
      this.vel.z += wz * accel;
      const drag = Math.max(0, 1 - 0.3 * dt);
      this.vel.x *= drag;
      this.vel.z *= drag;
    }

    // 좀비는 스페이스가 슈퍼점프 충전이라 여기서 뛰지 않는다 (updateCharge 가 맡는다)
    // 활을 장전 중이면(noJump) 점프도 못 한다 — 띄워져서 조준이 깨지는 걸 막는다
    if (!this.usesCharge && !this.noJump && !this.crawling && input.took('jump') && this.onGround) {
      this.vel.y = L.jumpSpeed;
      this.onGround = false;
    }

    this.vel.y += WORLD.gravity * dt;

    // ── 적분 + 충돌 ──
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    resolveCollision(this.pos, this.boxes, this.radius, this.height, STEP_HEIGHT);

    const prevY = this.pos.y;
    this.pos.y += this.vel.y * dt;

    // 발높이 + 턱높이 이하의 면에만 올라선다. 그 위는 점프해서 넘어야 한다.
    const floor = groundHeight(this.pos.x, this.pos.z, this.boxes,
                               this.radius, prevY + STEP_HEIGHT);
    const wasAir = !this.onGround;
    this.justLanded = false;
    if (this.pos.y <= floor) {
      this.pos.y = floor;
      this.vel.y = 0;
      this.onGround = true;
      if (wasAir) this.justLanded = true;     // 착지 충격 판정용
    } else {
      this.onGround = false;
    }


    // 맵 밖으로 나가지 않게 — 생존자는 바깥 담 1m 안쪽까지. 좀비는 담 한가운데까지라
    // 슈퍼점프로 바깥 담(4m) 위에 올라서서 걸어 다닐 수 있다 (밖으로 떨어지지는 않는다).
    [this.pos.x, this.pos.z] = clampToArena(this.pos.x, this.pos.z, this.usesCharge ? 0 : 1);
  }

  /** 카메라(눈) 위치 */
  eye() {
    return new Vector3(this.pos.x, this.pos.y + (this.eyeHeight ?? WORLD.eyeHeight), this.pos.z);
  }
}
