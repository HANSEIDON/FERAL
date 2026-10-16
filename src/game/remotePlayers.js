// 다른 플레이어들.
//
// 서버 상태는 20Hz 로 띄엄띄엄 오는데 화면은 60~144Hz 로 그린다.
// 받은 위치로 곧장 순간이동시키면 뚝뚝 끊겨 보이므로, 두 스냅샷 사이를
// 보간해서 한 틱(50ms) 늦게 따라가게 한다.
//
// 좀비 · 생존자(총수/사냥꾼) 모두 GLB 모델이다. 모델이 준비되기 전이거나 로딩에
// 실패해도 캡슐로 떨어져서 게임은 계속 돌아간다.

import {
  BoxGeometry, CapsuleGeometry, Color, Group, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, SkinnedMesh, Vector3,
} from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import { BASE, TICK_HZ } from '../../shared/config.js';
import { avatarModel } from '../../shared/loadout.js';
import { PSTATE } from '../../shared/protocol.js';
import { MV } from '../core/input.js';
import { loadModel } from '../core/assets.js';
import { AvatarAnim, IMPACT_AT } from './avatarAnim.js';
import { BowRig, computeBowMount } from './bowRig.js';
import { GunRig, computeGunMounts } from './gunRig.js';

// 보간 지연 (초). 서버 틱 간격(50ms)과 같게 둔다.
//
// 반 틱(25ms)으로 두면 스냅샷이 도착하는 순간마다 점프가 생긴다:
// 도착 직전엔 렌더 시점이 창 [i-2 → i-1]의 끝(k=1)에 붙어 p(i-1)에 정지해
// 있고, 새 스냅샷이 오면 창이 [i-1 → i]로 바뀌어 k=0.5 가 되어 위치가
// p(i-1) 과 p(i) 의 중간으로 — 즉 이동 방향과 반대(뒤로)로 0.5칸 튄다.
// 이게 "좀비가 앞으로 가다 뒤로 순간이동" 버그의 정체였다.
//
// 지연 = 틱 간격(50ms) 이면 도착 직전 k=1 → p(i-1), 도착 직후 k=0 → p(i-1)
// 으로 위치가 완전히 연속이다. 스냅샷 도착이 조금 늦거나 빠려도 양쪽이
// 같은 점(p(i-1))으로 클램프되므로 점프가 일어날 수 없다.
const DELAY = 1 / TICK_HZ;

// 좀비는 광폭화 때 붉게 물든다. 모델을 두 벌 만들 일이 아니라 색만 바꾸면
// 되는 것이고, 모델을 갈아끼워도 이 코드는 그대로 쓴다.
const WHITE = new Color(0xffffff);      // 모델은 텍스처를 그대로 살린다
const ZOMBIE_RAGE = new Color(0x8f1d14);
// 색(color)은 텍스처에 곱해지므로 근육 명암이 살아남는다. 발광(emissive)은
// 텍스처와 무관하게 빛을 더해서, 조금만 올려도 평면 빨강이 된다.
// 그래서 색으로 진하게 물들이고 발광은 눈에 겨우 띌 만큼만 준다.
const RAGE_TINT_MAX = 0.85;
const RAGE_GLOW = 0.03;

const MAT = {
  zombie: new MeshStandardMaterial({ color: 0x76a33a, roughness: 0.85 }),
  survivor: new MeshStandardMaterial({ color: 0x6f7d92, roughness: 0.8 }),
  downed: new MeshStandardMaterial({ color: 0xa05050, roughness: 0.9 }),
};

// ---------------------------------------------------------------- 모델

/**
 * 모델별 GLB. 어떤 모델을 쓸지는 역할 + 직업이 정한다 (shared/loadout.js 의
 * avatarModel — 생존자 총수는 gunner, 사냥꾼은 hunter). 없으면 캡슐로 떨어진다.
 */
const MODEL_URL = {
  zombie: 'models/zombie.glb',
  hunter: 'models/hunter.glb',
  gunner: 'models/gunner.glb',
};
const models = new Map();       // 모델 이름 -> gltf

/**
 * 손에 드는 소품 (tools/build_props.mjs) — 모델 이름별. 없으면 맨손으로 간다.
 *  hunter  활 · 화살
 *  gunner  소총 · 권총
 */
const PROPS_URL = { hunter: 'models/hunter_props.glb', gunner: 'models/gunner_props.glb' };
const props = new Map();        // 모델 이름 -> gltf
const mounts = new Map();       // 모델 이름 -> 쥐는 자리 (모델당 한 번 구한다)

/** 소품을 손에 붙인다 — 사냥꾼은 활, 총수는 소총 · 권총. */
const RIGS = {
  hunter: { mount: (gltf) => computeBowMount(gltf), make: (root, p, m) => new BowRig(root, p, m) },
  gunner: { mount: (gltf, p) => computeGunMounts(gltf, p), make: (root, p, m) => new GunRig(root, p, m) },
};

/**
 * 모델이 제자리에서 어느 쪽을 보고 서 있는지 보정한다.
 * 게임 규약은 -Z 가 앞인데(localPlayer.forward 와 같다) Mixamo 캐릭터는
 * +Z 를 보고 서 있어서 그대로 두면 뒷걸음질치는 것처럼 보인다.
 */
const MODEL_YAW = { zombie: Math.PI, hunter: Math.PI, gunner: Math.PI };

/**
 * 캐릭터 모델을 미리 받아둔다. 라운드가 시작되고 나서 받으면 첫 몇 초 동안
 * 캡슐이 보인다.
 */
export async function preloadAvatars(base = './') {
  // 소품을 먼저 — 모델이 먼저 오면 그 사이 만들어진 캐릭터가 맨손으로 굳는다 (합쳐 2MB 라 금방이다)
  await Promise.all(Object.entries(PROPS_URL).map(async ([name, url]) => {
    try {
      props.set(name, await loadModel(base + url));
    } catch (e) {
      console.warn(`[avatar] ${name} 소품을 못 받았습니다 — 맨손으로 갑니다`, e);
    }
  }));
  await Promise.all(Object.entries(MODEL_URL).map(async ([name, url]) => {
    try {
      models.set(name, await loadModel(base + url));
    } catch (e) {
      console.warn(`[avatar] ${name} 모델을 못 받았습니다 — 캡슐로 대체합니다`, e);
    }
  }));
  return models;
}

export function hasModel(name) { return models.has(name); }

/** 1인칭 손도 같은 모델을 쓴다 (viewmodel.js). */
export function getModel(name) { return models.get(name) ?? null; }

/** 날아가는 화살도 손에 든 것과 같은 모델을 쓴다 (effects.js). 오늬 = 원점, 촉 = +Z. */
export function getArrowModel() { return props.get('hunter')?.scene.getObjectByName('Arrow') ?? null; }

function makeCapsule(role) {
  const g = new Group();
  const b = BASE[role] ?? BASE.survivor;
  const cylLen = Math.max(0.1, b.height - 2 * b.radius);

  const body = new Mesh(new CapsuleGeometry(b.radius, cylLen, 4, 12),
                        (MAT[role] ?? MAT.survivor).clone());
  body.position.y = b.height / 2;
  g.add(body);

  // 어느 쪽을 보는지 알 수 있게 머리에 코를 하나 붙여둔다
  const nose = new Mesh(
    new BoxGeometry(b.radius * 0.3, b.radius * 0.3, b.radius * 0.65),
    new MeshBasicMaterial({ color: 0xffffff }),
  );
  nose.position.set(0, b.height * 0.86, -b.radius * 0.95);
  g.add(nose);

  g.userData.tint = [body.material];
  g.userData.base = role === 'zombie' ? MAT.zombie.color : MAT.survivor.color;
  return g;
}

/** GLB 를 한 구 복제한다. 스킨드 메시는 SkeletonUtils 로 떠야 스키닝이 산다. */
function makeModel(name) {
  const gltf = models.get(name);
  if (!gltf) return null;

  const g = new Group();
  const root = cloneSkinned(gltf.scene);

  // 머티리얼은 개체마다 복제한다 — 공유하면 하나만 물들여도 전부 빨개진다
  const tint = [];
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.material = Array.isArray(o.material)
      ? o.material.map((m) => m.clone())
      : o.material.clone();
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) tint.push(m);
    // 스킨드 메시는 바운딩이 원래 자세 기준이라, 팔을 뻗으면 통째로 사라진다
    o.frustumCulled = false;
  });

  // 바깥 Group 의 rotation.y 는 서버 yaw 가 쓰므로, 모델 자체의 방향 보정은
  // 안쪽 root 에 건다.
  root.rotation.y = MODEL_YAW[name] ?? 0;

  g.add(root);
  g.userData.tint = tint;
  g.userData.base = WHITE;
  const anim = new AvatarAnim(root, gltf.animations ?? [], name);
  anim.setAttackRate(IMPACT_AT);   // 원격 펀치도 타격 시점에 맞춰 재생
  g.userData.anim = anim;

  // 소품을 손에 쥔다 (사냥꾼 활 · 총수 총). 위에서 색을 입히는 머티리얼을 모은 뒤에
  // 붙인다 — 쓰러졌을 때 몸만 붉어지고 소품까지 물들지 않게.
  const rig = RIGS[name], p = props.get(name);
  if (rig && p) {
    if (!mounts.has(name)) mounts.set(name, rig.mount(gltf, p));
    const m = mounts.get(name);
    if (m) anim.rigs.push(rig.make(root, p, m));
  }
  return g;
}

/**
 * @param role  'zombie' | 'survivor' — 캡슐 · 실루엣 크기
 * @param model 모델 이름 (avatarModel). 없으면 그 역할의 기본 모델
 */
export function makeAvatar(role, model = avatarModel(role)) {
  const g = makeModel(model) ?? makeCapsule(role);
  const b = BASE[role] ?? BASE.survivor;

  // 벽 너머로 비치는 실루엣 (좀비 감각 / 아군 표시).
  // 모델이 있으면 몸 모양 그대로 — 같은 뼈대에 묶은 사본 메시라 동작을 따라 움직인다.
  // (예전엔 캡슐이라 좀비 화면에 생존자마다 원통이 떠 보였다)
  if (g.userData.anim) {
    const tint = new Set(g.userData.tint);
    // 벽 · 컨테이너 뒤에 가려졌을 때만 켠다 (main.js 시야 검사) — 바로 보이는 생존자는 평소 모습 그대로
    const mat = new MeshBasicMaterial({ color: 0xff8a70, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false });
    const parts = [];
    g.traverse((o) => {
      if (!o.isSkinnedMesh || ![].concat(o.material).some((m) => tint.has(m))) return;   // 몸만 (총 · 활 제외)
      const c = new SkinnedMesh(o.geometry, mat);
      c.bind(o.skeleton, o.bindMatrix);
      c.position.copy(o.position); c.quaternion.copy(o.quaternion); c.scale.copy(o.scale);
      c.frustumCulled = false;
      c.renderOrder = 998;
      c.visible = false;
      parts.push([o.parent, c]);
    });
    for (const [p, c] of parts) p.add(c);
    if (parts.length) {
      let on = false;
      g.userData.sil = {
        get visible() { return on; },
        set visible(v) { on = v; for (const [, c] of parts) c.visible = v; },
      };
      return g;
    }
  }
  const sil = new Mesh(
    new CapsuleGeometry(b.radius * 1.06, Math.max(0.1, b.height - 2 * b.radius), 4, 10),
    new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthTest: false }),
  );
  sil.position.y = b.height / 2;
  sil.renderOrder = 998;
  sil.visible = false;
  g.add(sil);
  g.userData.sil = sil;

  return g;
}

// ---------------------------------------------------------------- 관리

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<number, object>} */
    this.list = new Map();
    this.roles = new Map();     // id -> 'zombie' | 'survivor'
    this.models = new Map();    // id -> 모델 이름 (역할 + 직업 — 총수/사냥꾼이 다르다)
    this.bots = new Set();      // 더미(봇) id — mv 비트로 스윙을 못 해서 hit 이벤트로 모션을 준다
    this.hold = 0;             // 남은 묶임 시간 — 좀비 아바타가 묶인 모션을 쓴다
  }

  isBot(id) { return this.bots.has(id); }

  setRoles(pairs) {
    const changed = [];
    this.bots.clear();
    for (const { id, role, bot, classId } of pairs ?? []) {
      const model = avatarModel(role, classId);
      if (this.roles.get(id) !== role || this.models.get(id) !== model) changed.push(id);
      this.roles.set(id, role);
      this.models.set(id, model);
      if (bot) this.bots.add(id);
    }
    // 역할·직업이 바뀌면 모델 자체가 다르므로 아바타를 새로 만든다
    for (const id of changed) {
      const e = this.list.get(id);
      if (!e) continue;
      this.disposeAvatar(e.avatar);
      e.avatar = makeAvatar(this.roles.get(id), this.models.get(id));
      this.scene.add(e.avatar);
      e.rage = 0;
      e.rageUntil = 0;
    }
  }

  disposeAvatar(avatar) {
    this.scene.remove(avatar);
    avatar.userData.anim?.dispose();
  }

  /**
   * 모델 로딩이 끝난 뒤 캡슐로 만들어진 아바타를 모델로 올린다.
   * 모델이 11MB 라 라운드가 먼저 시작되면 캡슐로 굳어버린다.
   */
  refreshAvatars() {
    for (const [id, e] of this.list) {
      const role = this.roles.get(id), model = this.models.get(id);
      if (e.avatar.userData.anim || !hasModel(model)) continue;
      this.disposeAvatar(e.avatar);
      e.avatar = makeAvatar(role, model);
      this.scene.add(e.avatar);
      e.rage = 0;
    }
  }

  /** 서버 스냅샷 반영 */
  apply(snapshots, myId, serverTime) {
    const seen = new Set();

    for (const s of snapshots) {
      if (s.id === myId) continue;
      seen.add(s.id);

      let e = this.list.get(s.id);
      if (!e) {
        const role = this.roles.get(s.id) ?? 'survivor';
        const avatar = makeAvatar(role, this.models.get(s.id) ?? avatarModel(role));
        this.scene.add(avatar);
        e = {
          avatar,
          from: { p: new Vector3(...s.p), y: s.y, t: serverTime },
          to: { p: new Vector3(...s.p), y: s.y, t: serverTime },
          state: s.st, pitch: s.pi, mv: s.mv,
          rage: 0, rageUntil: 0,
        };
        this.list.set(s.id, e);
      }

      e.from = { p: e.to.p.clone(), y: e.to.y, t: e.to.t };
      e.to = { p: new Vector3(...s.p), y: s.y, t: serverTime };
      e.state = s.st;
      e.pitch = s.pi;
      e.mv = s.mv;
    }

    // 나간 사람 정리
    for (const [id, e] of this.list) {
      if (seen.has(id)) continue;
      this.disposeAvatar(e.avatar);
      this.list.delete(id);
    }
  }

  /** 매 프레임 — 위치 보간 + 애니메이션 + 색 */
  update(dt, renderTime) {
    const t = renderTime - DELAY;

    for (const [id, e] of this.list) {
      const span = e.to.t - e.from.t;
      const k = span > 0.0001 ? Math.max(0, Math.min(1, (t - e.from.t) / span)) : 1;

      e.avatar.position.lerpVectors(e.from.p, e.to.p, k);
      // 죽은 몸은 Dying 끝 자세로 누워 있다 (avatarAnim) — 모델이 없으면(캡슐) 감춘다
      e.avatar.visible = e.state !== PSTATE.DEAD || !!e.avatar.userData.anim;

      // 두 스냅샷 사이 거리로 실제 이동 속도를 낸다.
      // 이동 비트로는 속도를 알 수 없고, 좀비는 질주 비트가 아예 안 켜진다.
      if (span > 0.0001) {
        const dx = e.to.p.x - e.from.p.x, dz = e.to.p.z - e.from.p.z;
        const s = Math.hypot(dx, dz) / span;
        e.speed = (e.speed ?? 0) + (s - (e.speed ?? 0)) * Math.min(1, dt * 12);
        if (s > 0.25) e.moveYaw = Math.atan2(-dx, -dz);
      }

      const anim = e.avatar.userData.anim;

      // 몸 방향 — 내 3인칭 몸(main.js)과 같은 규칙. 달릴 땐 이동 방향을 보고,
      // 서 있거나 공격·활 조준 중이면 시선 방향을 본다. 시선만 따라가면
      // 옆·뒤로 움직일 때 앞으로 달리는 클립이 옆으로 미끄러져 보인다.
      const lookYaw = lerpAngle(e.from.y, e.to.y, k);
      if (!anim) {
        e.avatar.rotation.y = lookYaw;
      } else {
        const faceLook = (e.speed ?? 0) <= 0.25 || anim.attackBusy || anim.aims(e.mv | 0)
          || e.moveYaw === undefined;
        const want = faceLook ? lookYaw : e.moveYaw;
        // 막 만들어진 아바타는 0도에서 빙 돌아오지 않게 바로 맞춘다
        const turn = e.avatar.userData.faced ? Math.min(1, dt * 10) : 1;
        e.avatar.rotation.y += wrapAngle(want - e.avatar.rotation.y) * turn;
        e.avatar.userData.faced = true;
      }

      // 슬램(슈퍼점프 착지) — 보간된 위치가 실제로 착지한 순간에 재생한다.
      // 서버 메시지가 도착한 즉시 틀면 아바타는 아직 공중에 떠 있다(보간 지연
      // + 스냅샷 간격) — "공중에서 내려찍기" 로 보여 좀비 본인의 화면과
      // 다르게 보인다. t >= e.to.t 이면 보간이 착지 스냅샷까지 다 따라온 시점.
      if (e.pendingSlam != null) {
        if ((e.mv & MV.AIR) || e.state !== PSTATE.ALIVE) {
          e.pendingSlam = null;        // 새 점프가 시작됐거나 상태가 바뀌면 취소
        } else if (t >= e.to.t - 1e-4 && anim) {
          anim.trigger('slam', e.pendingSlam);
          e.pendingSlam = null;
        }
      }

      // 사람 좀비의 주먹 — 클릭(FIRE)이 켜지는 순간 스윙을 튼다. 예전엔 더미(봇)만 'attack' 이벤트로
      // 스윙이 나오고 사람 좀비는 아무것도 안 걸려 있어서, 다른 사람 화면에선 주먹질이 안 보였다.
      const fire = !!(e.mv & MV.FIRE);
      if (anim && fire && !e.prevFire && this.roles.get(id) === 'zombie' && !this.bots.has(id) && this.hold <= 0) anim.trigger('attack');
      e.prevFire = fire;

      if (anim) {
        // 묶여 있는 동안(라운드 시작) — 좀비는 서 있기 모션만
        if (this.hold > 0 && this.roles.get(id) === 'zombie') {
          anim.updateHold(dt);
        } else {
          anim.update(dt, e.mv | 0, e.state, e.speed ?? 0);
        }
      } else {
        // 캡슐 대체본은 애니메이션이 없으니 쓰러지면 눕히기만 한다
        e.avatar.rotation.x = e.state === PSTATE.DOWNED ? -Math.PI / 2.2 : 0;
      }

      this.tint(e, this.roles.get(id), renderTime, dt);
    }
  }

  /** 광폭화 · 쓰러짐 색. 모델이든 캡슐이든 같은 방식으로 먹인다. */
  tint(e, role, now, dt) {
    const mats = e.avatar.userData.tint ?? [];
    if (!mats.length) return;
    const base = e.avatar.userData.base ?? WHITE;

    if (e.state === PSTATE.DOWNED) {
      for (const m of mats) {
        m.color.copy(MAT.downed.color);
        if (m.emissive) m.emissive.setRGB(0, 0, 0);
      }
    } else if (role === 'zombie') {
      const want = (e.rageUntil ?? 0) > now ? 1 : 0;
      e.rage = (e.rage ?? 0) + (want - (e.rage ?? 0)) * Math.min(1, dt * 6);
      for (const m of mats) {
        m.color.lerpColors(base, ZOMBIE_RAGE, e.rage * RAGE_TINT_MAX);
        if (m.emissive) m.emissive.setRGB(e.rage * RAGE_GLOW, 0, 0);
      }
    } else {
      for (const m of mats) {
        m.color.copy(base);
        if (m.emissive) m.emissive.setRGB(0, 0, 0);
      }
    }

    // 피격 플래시 — 어떤 상태(광폭화·쓰러짐) 위에든 하얗게 번쩍였다가 꺼진다
    if ((e.flash ?? 0) > 0.001) {
      for (const m of mats) if (m.emissive) m.emissive.lerp(WHITE, Math.min(1, e.flash) * 0.8);
      e.flash = Math.max(0, e.flash - dt * 7);
    }
  }

  /** 피격 플래시 — 맞은 캐릭터를 순간 하얗게 번쩍인다. */
  flashHit(id) {
    const e = this.list.get(id);
    if (e) e.flash = 1;
  }

  /** 좀비의 광폭화 표시. 서버가 알려준 종료 시각까지 붉게 물든다. */
  setRage(id, until) {
    const e = this.list.get(id);
    if (e) e.rageUntil = until;
  }

  /** 한 번짜리 동작을 재생시킨다 (착지 충격 · 포효). rate — 재생 속도 배수. */
  trigger(id, clip, rate) {
    this.list.get(id)?.avatar.userData.anim?.trigger(clip, rate);
  }

  /** 재장전 모션 (상체만). sec — 재장전에 걸리는 시간. */
  /** 남이 춤을 시작했다 (서버 이벤트) */
  emote(id, n) {
    this.list.get(id)?.avatar.userData.anim?.emote(n);
  }

  /** 지금 2번 무기(권총)를 들었는지 — 이동 비트 ALT */
  altOf(id) { return !!((this.list.get(id)?.mv ?? 0) & MV.ALT); }

  reload(id, sec) {
    this.list.get(id)?.avatar.userData.anim?.reload(sec);
  }

  /**
   * 슬램 착지 모션을 대기시킨다 (즉시 재생하지 않음).
   * 보간된 위치가 실제로 착지한 순간에 update() 가 재생한다 —
   * 메시지가 도착한 즉시 틀면 아바타가 아직 공중에 떠 있다.
   */
  queueSlam(id, rate) {
    const e = this.list.get(id);
    if (e) e.pendingSlam = rate;
  }

  /** 좀비 감각 등 — 특정 id 들의 실루엣을 켠다. */
  setSilhouettes(ids) {
    for (const [id, e] of this.list) {
      e.avatar.userData.sil.visible = ids.has(id);
    }
  }

  clear() {
    for (const e of this.list.values()) {
      this.disposeAvatar(e.avatar);
    }
    this.list.clear();
  }

  positions() {
    return [...this.list.entries()].map(([id, e]) =>
      ({ id, pos: e.avatar.position, state: e.state, role: this.roles.get(id), avatar: e.avatar,
         mv: e.mv | 0, speed: e.speed ?? 0, model: this.models.get(id) }));
  }
}

function lerpAngle(a, b, k) {
  return a + wrapAngle(b - a) * k;
}

/** 각도 차이를 -π..π 로 — 짧은 쪽으로 돌게. */
function wrapAngle(d) {
  d = ((d + Math.PI) % (Math.PI * 2)) - Math.PI;
  return d < -Math.PI ? d + Math.PI * 2 : d;
}
