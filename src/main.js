// 게임 진입점. 조각들을 엮고 루프를 돌린다.

import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera,
  PlaneGeometry, PMREMGenerator, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { SEND_HZ, BASE, WORLD } from '../shared/config.js';
import { AMMO_SPOTS, AMMO_PICKUP_RADIUS } from '../shared/map.js';
import { C, S, PHASE, PSTATE } from '../shared/protocol.js';
import { resolveLoadout, avatarModel, WEAPONS } from '../shared/loadout.js';

import { Net } from './core/net.js';
import { Input, MV } from './core/input.js';
import { buildScene, resolveCollision, raycastBoxes, groundHeight } from './game/world.js';
import { dressMap } from './game/mapArt.js';
import { loadEmotes, EMOTE_COUNT } from './game/emotes.js';
import { LocalPlayer } from './game/localPlayer.js';
import { RemotePlayers, preloadAvatars, makeAvatar, getArrowModel } from './game/remotePlayers.js';
import { placeCamera, aimFrom, resetCamera } from './game/thirdPerson.js';
import { initLoaders, loadModel } from './core/assets.js';
import {
  Weapon, Revive, raycastTarget, damageFor, spreadDir, findReviveTarget, MELEE_CONE, HEAD_MUL,
  arrowSegmentHit,
} from './game/combat.js';
import { Effects } from './game/effects.js';
import { Audio } from './game/sound.js';
import { IMPACT_AT, slamRate } from './game/avatarAnim.js';
import { ViewModel, preloadFist } from './game/viewmodel.js';
import { Hud, resetHudCache } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { t } from './ui/i18n.js';

const canvas = document.getElementById('view');

// ---------------------------------------------------------------- 렌더러

// 화면이 까매지면 "왜 까매졌는지"를 화면에 직접 띄운다.
// (콘솔을 못 여는 사용자를 위해 — 검은 화면 + 이 배너만 보면 원인이 보인다)
const diagBanner = document.createElement('div');
Object.assign(diagBanner.style, {
  position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
  zIndex: 9999, maxWidth: '86vw', padding: '10px 16px',
  background: '#7a1f1f', color: '#fff', border: '1px solid #ff8080',
  borderRadius: '8px', fontSize: '13px', lineHeight: 1.6, display: 'none',
  fontFamily: 'ui-sans-serif, "Malgun Gothic", system-ui, sans-serif',
  whiteSpace: 'pre-wrap',
});
document.body.appendChild(diagBanner);
let _diagMsg = '';
function diagShow(msg) {
  _diagMsg = msg;
  diagBanner.textContent = msg;
  diagBanner.style.display = 'block';
}

// [debug] 런타임 에러를 서버로 수집 — 임시 진단 코드. 원인을 찾으면 지운다.
const __dbgPost = (kind, msg) => {
  try {
    fetch('/__debug/capture', {
      method: 'POST',
      body: JSON.stringify({ kind, msg: String(msg).slice(0, 2000), ts: Date.now() }),
    }).catch(() => {});
  } catch { /* ignore */ }
};
window.addEventListener('error', (e) => {
  __dbgPost('error', e.message + ' @ ' + (e.filename ?? '') + ':' + (e.lineno ?? '') + '\n' + (e.error?.stack ?? ''));
});
window.addEventListener('unhandledrejection', (e) => {
  __dbgPost('rejection', e.reason?.stack ?? e.reason);
});

let renderer;
try {
  renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  diagShow('WebGL 을 사용할 수 없습니다.\n브라우저 설정에서 "하드웨어 가속" 을 켜고 다시 시작해 주세요.\n(' + (err?.message ?? err) + ')');
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;

const scene = new Scene();
const camera = new PerspectiveCamera(78, 1, 0.05, 200);
// PBR 머티리얼(좀비 텍스처 등)이 조명 2개만으로 어둡게 꺼지지 않게
// 중립 환경광을 깔아준다. 검수기(inspect.js)와 같은 방식.
// 강도는 낮춰서 어두운 배경·안개 무드가 깨지지 않게 한다.
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
pmrem.dispose();

const { boxes, group: mapGroup } = buildScene(scene);

// ── 탄약상자 ──
// 후보 지점마다 하나씩 만들어 두고, 서버가 스폰한 자리에만 보여준다. 지오메트리는
// 재사용하니까 라운드마다 새로 만들지 않는다.
// 종류(소총/권총)는 스폰마다 정해지므로, 3D 모델(ammo_props.glb)을 받으면 지점마다
// 두 모델을 다 넣어 두고 하나만 켠다 (dressAmmoBox). 받기 전에는 아래 임시 상자를
// 띠 색으로 구분해 쓴다 — 권총(빨강) / 소총(파랑).
const AMMO_BAND_COLOR = { pistol: 0xd64541, rifle: 0x3a6ea5 };

// 탄약상자 크기 배율 — 임시 상자든 glTF 모델이든 그룹 전체를 함께 키워/줄인다.
// 너무 작으면 2~3, 작으면 1.5 정도로 조절하면 된다.
const AMMO_BOX_SCALE = 2;

// 권총 탄약상자 모델 틴트 — 텍스처에 곱해져서 색이 바뀐다. 소총(그린)과 구분되게 빨강 계열.
const AMMO_PISTOL_TINT = 0xff5040;

// 밤 맵에서도 탄약상자가 보이게 바닥에 은은한 빛 고리를 깐다. 광원이 아니라 더하기
// 합성 판 하나라 값이 싸다. 색으로 종류를 미리 알린다 — 소총(푸른빛) / 권총(붉은빛).
const AMMO_GLOW_COLOR = { rifle: 0x6fc8ff, pistol: 0xff6a4a };
const AMMO_GLOW_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
})();

function makeAmmoBoxMesh() {
  const g = new Group();
  // 바닥에 붙이는 얇은 베이스 — "공중에 떠 있다"는 느낌 없애기
  const base = new Mesh(
    new BoxGeometry(0.46, 0.02, 0.36),
    new MeshStandardMaterial({ color: 0x2a2a24, roughness: 0.9 }),
  );
  base.position.y = 0.01;
  const crate = new Mesh(
    new BoxGeometry(0.4, 0.24, 0.3),
    new MeshStandardMaterial({ color: 0x5a6b45, roughness: 0.85 }),
  );
  crate.position.y = 0.14;
  const bandMat = new MeshStandardMaterial({ color: 0xc9a227, roughness: 0.5, metalness: 0.35 });
  const band = new Mesh(new BoxGeometry(0.42, 0.07, 0.32), bandMat);
  band.position.y = 0.14;
  const glow = new Mesh(new PlaneGeometry(0.9, 0.9), new MeshBasicMaterial({
    map: AMMO_GLOW_TEX, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false,
  }));
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.015;
  glow.renderOrder = 2;
  g.add(base, crate, band, glow);
  g.userData.bandMat = bandMat;   // 라운드마다 타입 색으로 다시 칠한다
  g.userData.glowMat = glow.material;
  g.userData.fallback = [base, crate, band];
  return g;
}
const ammoBoxGroup = new Group();
const AMMO_POOL = AMMO_SPOTS.map((s, i) => {
  const m = makeAmmoBoxMesh();
  m.position.set(s.x, 0, s.z);
  // 지점마다 놓인 각도를 다르게 — 모두 같은 방향이면 찍어 붙인 티가 난다.
  // 지점 번호로 정하니 모든 클라이언트에서 같다.
  m.rotation.y = i * 2.4;
  m.scale.setScalar(AMMO_BOX_SCALE);
  m.visible = false;
  ammoBoxGroup.add(m);
  return m;
});
scene.add(ammoBoxGroup);

/** 탄약상자를 종류에 맞게 보인다 — 모델이 있으면 그 종류만 켜고, 없으면 띠 색. */
function dressAmmoBox(mesh, type) {
  mesh.userData.glowMat.color.setHex(AMMO_GLOW_COLOR[type] ?? 0xffd27a);
  const models = mesh.userData.models;
  if (models) {
    for (const [t, o] of Object.entries(models)) o.visible = t === type;
    return;
  }
  mesh.userData.bandMat?.color.setHex(AMMO_BAND_COLOR[type] ?? 0xc9a227);
}

// ── 몸 소리: 발소리 · 점프 · 착지 (나와 남 모두) ──
// 발소리는 걸은 거리로 낸다 — 보폭(m)마다 한 번. 클립의 발 닿는 박자와 거의 맞는다.
// 남의 점프 · 착지는 이동 비트 AIR 가 켜지고 꺼지는 순간에 낸다.
const stepAcc = new Map();
const airPrev = new Map();
const firePrev = new Map();
let myStep = 0, myGround = true;
const stride = (zombie, sp) => (zombie ? (sp > 3.5 ? 1.7 : 1.15) : (sp > 5 ? 1.75 : 1.4));

function bodySounds(dt) {
  if (G.phase !== PHASE.PLAYING) return;
  if (G.state === PSTATE.ALIVE) {
    const zombie = G.role === 'zombie';
    const sp = Math.hypot(me.vel.x, me.vel.z);
    if (me.onGround && sp > 0.6 && (myStep += sp * dt) >= stride(zombie, sp)) { myStep = 0; audio.step(zombie); }
    // 좀비 점프는 슈퍼점프 소리가 따로 있다 — 생존자만 기합 · 착지 소리
    if (!zombie && myGround && !me.onGround && me.vel.y > 2) audio.jump(G.classId === 'archer');
    if (!zombie && me.justLanded) audio.land();
  }
  myGround = me.onGround;

  for (const o of others.positions()) {
    if (o.state !== PSTATE.ALIVE) { airPrev.delete(o.id); continue; }
    const zombie = o.role === 'zombie';
    const air = !!(o.mv & MV.AIR), was = airPrev.get(o.id);
    airPrev.set(o.id, air);
    if (air && was === false) {
      if (zombie) audio.slamJump(o.pos);
      else audio.jump(o.model === 'hunter', o.pos);
    }
    if (!air && was && !zombie) audio.land(o.pos);
    // 남의 좀비 주먹 — 누른 순간 휘두르기 시작, 0.8초 뒤 닿는다 (avatarAnim IMPACT_AT)
    const fire = !!(o.mv & MV.FIRE), wasFire = firePrev.get(o.id);
    firePrev.set(o.id, fire);
    if (zombie && fire && wasFire === false) audio.zombieSwing(0.8, o.pos);
    if (air || o.speed < 0.6) continue;
    const acc = (stepAcc.get(o.id) ?? 0) + o.speed * dt;
    if (acc >= stride(zombie, o.speed)) { stepAcc.set(o.id, 0); audio.step(zombie, o.pos); }
    else stepAcc.set(o.id, acc);
  }
}

/**
 * CPR 짝 짓기 — 살리는 중(이동 비트 USE · 나는 G.reviving)인 생존자마다 가장 가까운 쓰러진
 * 동료를 짝으로 잡아, 둘의 동작을 cpr_give · cpr_get 으로 틀게 한다. 두 동작은 한 장면에서
 * 찍은 짝이라 원점 · 방향을 같게 두면 맞물린다 — 살리는 사람의 몸(보이는 위치만)을 쓰러진
 * 사람 자리로 부드럽게 옮기고, 쓰러진 사람은 CPR 동안 몸 방향을 고정한다.
 * 동작 플래그는 다음 프레임의 동작 갱신에 쓰인다 (한 프레임 늦어도 티 나지 않는다).
 */
function updateCpr(dt) {
  if (G.phase !== PHASE.PLAYING) return;
  const bodies = others.positions().map((o) => ({ ...o, reviving: !!(o.mv & MV.USE) }));
  if (selfAvatar) bodies.push({ id: net.id, pos: me.pos, state: G.state, role: G.role, avatar: selfAvatar, reviving: !!G.reviving });
  const taken = new Set();
  for (const b of bodies) {
    const anim = b.avatar?.userData.anim;
    if (!anim) continue;
    anim.cpr = null;
  }
  for (const g of bodies) {
    const ga = g.avatar?.userData.anim;
    if (!ga) continue;
    let best = null, bd = 2.6;
    if (g.reviving && g.state === PSTATE.ALIVE && g.role === 'survivor') {
      for (const r of bodies) {
        if (r === g || r.state !== PSTATE.DOWNED || taken.has(r.id) || !r.avatar) continue;
        const d = g.pos.distanceTo(r.pos);
        if (d < bd) { bd = d; best = r; }
      }
    }
    // 보이는 몸을 짝 자리로 끌어당긴다 (0.25초) — 끝나면 다시 제자리로
    const u = g.avatar.userData;
    u.cprK = Math.max(0, Math.min(1, (u.cprK ?? 0) + (best ? dt : -dt) * 4));
    if (best) {
      taken.add(best.id);
      ga.cpr = 'give';
      const ra = best.avatar.userData.anim;
      if (ra) ra.cpr = 'get';
      const bu = best.avatar.userData;
      bu.cprYaw ??= best.avatar.rotation.y;
      best.avatar.rotation.y = bu.cprYaw;
      // 살리는 사람이 맞출 방향은 따로 둔다 — cprYaw(쓰러진 사람 방향 고정)는 아래에서 매 프레임 지워진다.
      // 같은 칸을 쓰면 짝이 풀리는 순간 undefined + … = NaN 이 되어 내 몸이 사라진다.
      u.cprAt = best.avatar.position.clone();
      u.cprFace = bu.cprYaw;
      // CPR 받는 동안은 출혈 시계가 멈춘다 (서버도 같은 규칙 — server/index.js beingRevived)
      if (best.id === net.id) { if (G.downedAt) G.downedAt += dt; }
      else if (downTimes.has(best.id)) downTimes.set(best.id, downTimes.get(best.id) + dt);
    }
    if (u.cprK > 0 && u.cprAt) {
      g.avatar.position.lerp(u.cprAt, u.cprK);
      g.avatar.rotation.y = u.cprFace + wrapPi(g.avatar.rotation.y - u.cprFace) * (1 - u.cprK);
    } else if (u.cprK === 0) u.cprAt = null;
  }
  // 짝이 풀린 쓰러진 사람은 방향 고정을 푼다
  for (const b of bodies) if (b.avatar && b.avatar.userData.anim?.cpr !== 'get') b.avatar.userData.cprYaw = undefined;
}
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** 쓰러진 동료가 쓰러진 시각(초, performance.now 기준) — 머리 위 출혈 표식에 쓴다 */
const downTimes = new Map();
const _markPos = new Vector3();

/**
 * 출혈 막대(나) · 광폭화 칸(좀비) · 쓰러진 동료 표식(생존자). 매 프레임.
 * 출혈 시간은 서버가 센다 — 여기는 쓰러진 순간부터 같은 시간을 거꾸로 셀 뿐이다.
 */
function updateStatusHud() {
  const now = performance.now() / 1000;
  const bleedSec = me.loadout?.downedBleedSec ?? net.config?.BASE?.survivor?.downedBleedSec ?? 25;
  hud.setDowned(G.state === PSTATE.DOWNED && G.downedAt ? bleedSec - (now - G.downedAt) : null, bleedSec);

  if (G.role === 'zombie') {
    const z = net.config?.BASE?.zombie ?? {};
    const active = me.raging ? Math.max(0, me.rageUntil - Date.now() / 1000) : 0;
    const cd = Math.max(0, (z.rageCooldown ?? 16) - (now - G.rageAt));
    hud.setRage({ active, cooldown: active > 0 ? 0 : cd, total: active > 0 ? (z.rageSec ?? 7) : (z.rageCooldown ?? 16) });
  }

  // 생존자에게만 — 쓰러진 동료 머리 위 (화면 밖이면 그리지 않는다)
  const marks = [];
  if (G.role === 'survivor' && G.phase === PHASE.PLAYING) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const o of others.positions()) {
      if (o.state !== PSTATE.DOWNED || o.role !== 'survivor') continue;
      _markPos.copy(o.pos).y += 1.0;
      const dist = _markPos.distanceTo(camera.position);
      _markPos.project(camera);
      if (_markPos.z > 1 || Math.abs(_markPos.x) > 1.1 || Math.abs(_markPos.y) > 1.1) continue;
      const since = downTimes.has(o.id) ? now - downTimes.get(o.id) : 0;
      marks.push({ x: (_markPos.x * 0.5 + 0.5) * w, y: (-_markPos.y * 0.5 + 0.5) * h, frac: 1 - since / bleedSec, dist });
    }
  }
  hud.setMarks(marks);
}

/** 이 라운드의 탄약상자 상태. S.ROUND 가 채운다. */
let ammoBoxes = [];

// glTF 로더를 켜고 캐릭터 모델을 미리 받아둔다. 라운드가 시작된 뒤에 받으면
// 첫 몇 초 동안 캡슐이 보인다.
initLoaders(renderer);
loadEmotes();   // 춤 동작 (Ctrl+1 · 2 · 3) — 작아서 미리 받아 둔다

// 맵 겉모습(컨테이너 · 크레인 · 소품 모델과 밤하늘). 받는 동안은 박스가 대신 서 있고,
// 못 받아도 게임은 박스로 계속된다. 충돌은 어느 쪽이든 박스가 맡는다.
dressMap({ scene, renderer, boxes, group: mapGroup })
  .then((s) => console.info('[map] 모델', s))
  .catch((e) => console.warn('[map] 맵 모델을 못 불러와 박스로 둔다', e));

// 모델의 재질에 색 틴트를 입힌다 — 텍스처에 곱해져서 색이 바뀐다.
function tintModelMaterials(root, hex) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m && m.color) m.color.setHex(hex);
  });
}

// 탄약상자 3D 모델 (tools/build_props.mjs) — 받으면 임시 상자를 갈아입힌다. 이미 바닥에
// 떠 있는 상자도 그 자리에서 바뀐다. 못 받으면 임시 상자 그대로 간다.
loadModel('./models/ammo_props.glb').then((gltf) => {
  const src = { rifle: gltf.scene.getObjectByName('AmmoRifle'), pistol: gltf.scene.getObjectByName('AmmoPistol') };
  if (!src.rifle || !src.pistol) return;
  // 권총만 색을 바꿔 소총(그린)과 구분한다. 클론이 재질을 공유하므로 원본에 한 번만.
  tintModelMaterials(src.pistol, AMMO_PISTOL_TINT);
  for (const g of AMMO_POOL) {
    for (const o of g.userData.fallback) o.visible = false;
    g.userData.models = {};
    for (const [type, s] of Object.entries(src)) {
      const o = s.clone();
      o.visible = false;
      g.add(o);
      g.userData.models[type] = o;
    }
  }
  for (const b of ammoBoxes) dressAmmoBox(AMMO_POOL[b.i], b.type);
}).catch((e) => console.warn('[ammo] 탄약상자 모델을 못 받았습니다 — 임시 상자로 갑니다', e));

preloadAvatars('./').then((got) => {
  console.log('[avatar] 준비된 모델:', [...got.keys()].join(', ') || '없음 (전부 캡슐)');
  // 로딩보다 라운드가 먼저 시작됐으면 캡슐이 남아 있다 — 모델로 올린다
  others.refreshAvatars();
  // 날아가는 화살도 사냥꾼이 시위에 건 것과 같은 모델로
  const arrow = getArrowModel();
  if (arrow) fx.setArrowModel(arrow);
  // 1인칭 주먹 모델도 있으면 받아둔다 (없으면 박스로 간다)
  preloadFist().then((got) => {
    if (got) console.log('[avatar] 1인칭 주먹 모델 사용');
    if (G.role) { view.equip(G.role, weapon.spec); setSelfAvatar(G.role, G.classId); }
  });
});

// ---------------------------------------------------------------- 상태

const net = new Net();
const hud = new Hud(net);
const input = new Input(canvas);
const audio = new Audio();
// 시작 화면 · 메인 메뉴 · 대기실(캐릭터 선택) · 일시정지 (src/ui/menu.js)
const menu = new Menu({
  net, input, sound: audio,
  onEndPractice: () => net.send(C.ACTION, { kind: 'endPractice' }),
  onSound: (kind) => audio.ui(kind),
  // 배경 음악은 메뉴 · 대기실에서만 (라운드에 들어가면 줄어들며 꺼진다)
  onScreen: (scr) => {
    if (scr === 'main') audio.ensure();   // 첫 키 입력 — 소리를 열고 효과음을 미리 받아 둔다
    if (scr === 'main' || scr === 'lobby') audio.ambient(false);
    audio.music(scr === 'main' || scr === 'lobby');
  },
});
const me = new LocalPlayer(boxes);
const others = new RemotePlayers(scene);
const weapon = new Weapon();
const revive = new Revive();
const fx = new Effects(scene);
const view = new ViewModel();

// 3인칭에서 보이는 내 몸. 생존자는 직업마다 모델이 다르다 (총수/사냥꾼).
let selfAvatar = null;
function setSelfAvatar(role, classId) {
  if (selfAvatar) { scene.remove(selfAvatar); selfAvatar.userData.anim?.dispose(); selfAvatar = null; }
  if (!role) return;
  selfAvatar = makeAvatar(role, avatarModel(role, classId));
  scene.add(selfAvatar);
}

/**
 * 내 이동 비트. 2번 무기(총수 권총)를 들고 있으면 ALT 도 싣는다 — 남의 화면에서도
 * 같은 총과 동작을 고르고, 바뀌는 순간 교체 동작을 튼다 (avatarAnim.js).
 */
function myBits() {
  return input.moveBits(me.onGround) | (weapon.index === 1 ? MV.ALT : 0) | (G.reviving ? MV.USE : 0);
}

/**
 * 재장전 시작 — 성공하면 내 3인칭 몸에 재장전 모션(상체)을 틀고, 남의 화면에도
 * 보이도록 서버에 알린다. 걸리는 시간은 무기마다 다르다.
 */
function startReload(t) {
  if (!weapon.startReload(t)) return false;
  const sec = weapon.spec.reloadSec;
  selfAvatar?.userData.anim?.reload(sec);
  audio.reload(weapon.spec.id, sec);
  net.send(C.ACTION, { kind: 'reload', sec });
  return true;
}

const G = {
  phase: PHASE.LOBBY,
  role: null,
  hp: 0,
  maxHp: 1,
  state: PSTATE.SPECTATING,
  left: 0,
  hold: 0,
  practice: false,
};

// 관전 중일 때 쓸 자유 시점
let spectatorAngle = 0;

// 순간이동 추적기.
//
// 최근 프레임을 통째로 기록해두고 __g.report() 로 요약을 본다.
// "앞으로 가다 뒤로 튄다" 가 위치 때문인지 시야 때문인지 가르는 게 목적이다.
// 원인을 잡으면 이 블록은 지운다.
const diag = [];
let _lastCam = null;
let _lastPos = null;
let _lastYaw = null;
let _wasCtl = null;

// ---------------------------------------------------------------- 네트워크

net.on('open', () => {
  menu.setConnection(true);
  menu.rejoin();   // 재접속
});
net.on('close', () => menu.setConnection(false));

net.on(S.WELCOME, (m) => {
  menu.renderClasses(m.classes ?? []);

  // [debug] ?autostart=survivor|survivor-archer|zombie 로 연습 라운드를
  // 자동으로 시작한다 — 포인터락을 못 쓰는 자동화 브라우저에서 진단할 때 쓴다.
  const auto = new URLSearchParams(location.search).get('autostart');
  if (auto) menu.autostart(auto);
});

net.on(S.LOBBY, (m) => {
  menu.renderLobby(m);

  // 라운드 중에도 입·퇴장 때문에 이 메시지가 온다. 서버가 로비 단계라고
  // 할 때만 정리하고 메뉴를 띄운다.
  if (m.phase !== PHASE.LOBBY) return;

  const wasInRound = G.phase !== PHASE.LOBBY;
  G.phase = PHASE.LOBBY;
  G.role = null;
  G.practice = false;
  hud.setPractice(false);
  hud.setInRound(false);
  view.hide();
  G.thirdPerson = false;
  setSelfAvatar(null);

  // 연습 끝내기는 'end' 이벤트 없이 바로 로비로 오므로 여기서 메뉴를 띄운다
  if (wasInRound) {
    input.unlock();
    hud.hideResult();
    menu.showLobby();
  }
});

net.on(S.ROUND, (m) => {
  G.phase = m.phase;
  G.role = m.you.role;
  G.classId = m.you.classId;   // 생존자 모델(총수/사냥꾼)을 가른다
  G.state = PSTATE.ALIVE;
  G.practice = !!m.practice;
  hud.setPractice(G.practice);

  me.setLoadout(m.you.loadout);
  audio.roundStart(G.role, G.classId);   // 좀비는 탄생 소리, 생존자는 직업별 시작 곡
  audio.ambient(true);   // 비 · 천둥 · 먼 사이렌
  // 서버가 정해준 스폰 위치(네 귀퉁이 벽 안쪽, 플레이어마다 다른 귀)로 이동 —
  // 클라이언트는 (0,0,0)에서 시작하므로 여기서만 정위치로 옮긴다.
  if (Array.isArray(m.you.spawn) && m.you.spawn.length === 3) {
    me.teleport(m.you.spawn[0], m.you.spawn[1], m.you.spawn[2]);
  }
  weapon.equipAll(m.you.loadout.weapons ?? [m.you.loadout.weapon]);
  G.maxHp = m.you.loadout.maxHp;
  G.hp = G.maxHp;

  // 탄약상자 — 시작 시 비어 있고, 서버가 일정 시간마다 ammoSpawn 이벤트로 스폰시킨다
  ammoBoxes = [];
  AMMO_POOL.forEach((mesh) => { mesh.visible = false; });

  others.setRoles(m.roles);
  hud.setRole(G.role, m.you.loadout, G.classId);
  G.downedAt = 0;
  G.rageAt = -99;
  downTimes.clear();
  resetHudCache();
  hud.setInRound(true);
  // 3인칭 — 좀비·생존자 모두. 내 몸이 보이고, 남이 보는 것과 똑같다.
  G.thirdPerson = true;
  resetCamera();
  setSelfAvatar(G.role, G.classId);
  hud.crossState('');   // 전 라운드 조준 상태 초기화
  // 공격 클립을 타격 시점(IMPACT_AT)에 맞춰 감는다 — 두 손 클립 모두
  // 주먹이 IMPACT_AT 초에 뻗히므로 리듬이 일정하다.
  selfAvatar?.userData.anim?.setAttackRate(IMPACT_AT);
  // 좀비 주먹 쿨다운은 클립이 끝까지 가는 시간으로 잡는다 — 모션이 다
  // 들어가야 다음 대가 들어간다. 타격 시점까지만 잡으면 회복 동작이
  // 잘려 평캔처럼 보인다.
  const fullSec = selfAvatar?.userData.anim?.attackFull || IMPACT_AT;
  if (G.role === 'zombie' && weapon.spec) weapon.spec.rpm = 60 / fullSec;
  view.equip(G.role, weapon.spec);
  if (G.thirdPerson) view.hide(); else view.show();
  hud.hideResult();
  menu.hide();
  hud.toast(t(G.role === 'zombie' ? 'tz.youZombie' : 'tz.youSurvivor'));

  input.lock();

  // [debug] ?autostart=... — 포인터락이 막힌 자동화 브라우저에서 발사 경로를
  // 직접 실행한다. G.debugFP 로 락 없이 제어 블록이 돌고, mouse.left 는 활 장전·
  // 자동 화기 연사를, pressed('fire') 는 단발 무기를 구동한다.
  if (new URLSearchParams(location.search).get('autostart')) {
    G.debugFP = true;
    setTimeout(() => {
      input.mouse.left = true;
      input.pressed.add('fire');
      __dbgPost('autofire', 'fire start');
    }, 2000);
    setTimeout(() => {
      input.mouse.left = false;
      __dbgPost('autofire', 'fire release');
    }, 3200);
  }
});

net.on(S.STATE, (m) => {
  G.phase = m.phase;
  G.left = m.left;
  G.hold = m.hold;

  others.apply(m.players, net.id, m.now);

  // 서버가 정한 내 체력·상태를 그대로 받는다 (여기는 서버가 권위를 갖는다)
  const mine = m.players.find((p) => p.id === net.id);
  if (mine) {
    G.hp = mine.hp;
    G.state = mine.st;
  }
});

net.on(S.EVENT, (m) => {
  switch (m.kind) {
    case 'hit':
      // 내가 맞았으면 화면이 흔들리고, 내가 맞혔으면 조준점이 반응한다
      // 쓰러진 사람이 맞으면 출혈이 4초 빨라진다 (서버 applyHit 과 같다)
      if (m.downed) {
        if (m.id === net.id) G.downedAt -= 4;
        else if (downTimes.has(m.id)) downTimes.set(m.id, downTimes.get(m.id) - 4);
      }
      {
        const at = m.id === net.id ? null : others.positions().find((x) => x.id === m.id)?.pos;
        const targetRole = m.id === net.id ? G.role : others.roles.get(m.id);
        const byZombie = (m.by === net.id ? G.role : others.roles.get(m.by)) === 'zombie';
        if (targetRole === 'zombie') audio.zombieHurt(at);
        else {
          // 좀비 주먹 — 때린 본인은 닿는 순간 로컬에서 이미 냈다
          if (byZombie && m.by !== net.id) audio.punchHit(at);
          audio.survivorHurt(m.id, at);
        }
      }
      if (m.id === net.id) {
        fx.kick(0.22);
        hud.flashDamage();
      } else if (m.by === net.id) {
        hud.hitmark(m.head);
        others.flashHit(m.id);   // 맞은 캐릭터가 하얗게 번쩍인다
      }
      break;
    case 'attack':
      // 좀비 더미(봇)의 스윙 — 서버가 휘두르는 순간 알린다. 사람은 mv 비트(FIRE)
      // 로 스윙이 자동으로 나오지만, 더미는 서버 틱에서만 공격하기 때문에
      // 이 이벤트가 없으면 모션 없이 "공중에서 타격" 이 보였다.
      // 0.8초 뒤(타격 시각)에 데미지가 떨어져 "휘둘러서 맞았다" 로 읽힌다.
      // (attackBusy 가 걸려 있으면 재트리거는 자동으로 무시된다.)
      if (m.id !== net.id && others.isBot(m.id)) {
        others.trigger(m.id, 'attack');
        audio.zombieSwing(0.8, others.positions().find((x) => x.id === m.id)?.pos);
      }
      break;
    case 'fire': {
      // 내가 쏜 총은 이미 로컬에서 그렸다 — 남의 총성만 본다
      if (m.id === net.id) break;
      // 활이면 시위 소리 + 날아가는 화살, 나머지는 총성 + 총알선 — 멀수록 작아진다
      const from = new Vector3(...m.from), to = new Vector3(...m.to);
      if (m.bow) {
        audio.bowRelease(Number(m.c) || 1, from);
        // 장전량이 메시지에 들어 있다 — 풀장전일수록 화살이 빨리 날아간다
        const c = Math.max(0, Math.min(1, Number(m.c) || 0));
        const b = WEAPONS.bow;
        const spd = b.arrowSpeedMin + (b.arrowSpeed - b.arrowSpeedMin) * c * c;   // 로컬과 같은 c² 스케일
        fx.addArrow(from, to, spd);
      } else {
        audio.gunshot(others.altOf(m.id) ? 'pistol' : 'rifle', from);
        fx.addTracer(from, to);
      }
      break;
    }
    case 'down':
      // 출혈 시계 — 내 것은 HUD 막대, 동료 것은 머리 위 표식
      if (m.id === net.id) G.downedAt = performance.now() / 1000;
      else downTimes.set(m.id, performance.now() / 1000);
      audio.downed(m.id === net.id ? null : others.positions().find((x) => x.id === m.id)?.pos);
      hud.toast(t(m.id === net.id ? 'tz.youDown' : 'tz.mateDown'), 'warn');
      break;
    case 'revive':
      downTimes.delete(m.id);
      hud.toast(t(m.id === net.id ? 'tz.youUp' : 'tz.mateUp'), 'good');
      break;
    case 'kill':
      downTimes.delete(m.id);
      if (m.id === net.id) hud.toast(t('tz.youDead'), 'bad');
      {
        const at = m.id === net.id ? null : others.positions().find((x) => x.id === m.id)?.pos;
        if ((m.id === net.id ? G.role : others.roles.get(m.id)) === 'zombie') audio.zombieHurt(at);
        else audio.death(at);
      }
      break;
    case 'slam': {
      const isMine = m.id === net.id;
      // 내 슬램은 착지 순간에 이미 로컬에서 재생했다 — 여기에서 다시 틀면
      // 모션이 끊겨서 처음부터 다시 시작된다. 타인 슬램만 여기서 재생한다.
      if (!isMine) {
        fx.slam(m.at[0], m.at[2], m.radius);
        audio.thump(new Vector3(...m.at));
        fx.kick(0.35);          // 착지 충격은 화면 전체가 흔들려야 "대"가 된다
        // 충전량에 비례해 착지 모션을 빨리 감는다 — 높이 뛴 만큼 묵직하게.
        // 메시지가 도착한 즉시 모션을 틀면 아바타는 아직 공중에 떠 있다
        // (위치 보간 지연) — 착지한 순간에 재생되도록 대기시킨다.
        others.queueSlam(m.id, slamRate(m.charge));
      }
      const mine = m.hits?.find((h) => h.id === net.id);
      if (mine) { fx.kick(0.3); hud.flashDamage(); hud.toast(t('tz.slamHit', { n: mine.dmg }), 'bad'); }
      else if (m.dodged?.includes(net.id)) hud.toast(t('tz.dodged'), 'good');
      else if (isMine && m.hits?.length) hud.toast(t('tz.slamCount', { n: m.hits.length }), 'good');
      break;
    }
    case 'emote':
      // 남의 춤 — 내 것은 누른 순간 로컬에서 틀었다
      if (m.id !== net.id) others.emote(m.id, m.n);
      break;
    case 'reload':
      // 남의 재장전 — 상체만 재장전 모션 (내 것은 누른 순간 로컬에서 틀었다)
      if (m.id !== net.id) {
        others.reload(m.id, m.sec);
        const o = others.positions().find((x) => x.id === m.id);
        if (o) audio.reload(others.altOf(m.id) ? 'pistol' : 'rifle', m.sec, o.pos);
      }
      break;
    case 'rage':
      if (m.id === net.id) {
        // 서버가 확정한 시각까지 이동이 빨라진다 (R 키)
        me.setRage(m.until - net.clockOffset);
        view.trigger('rage');
        G.rageAt = performance.now() / 1000;   // 재사용 대기 표시 (HUD 광폭화 칸)
        audio.rage();
        hud.toast(t('tz.rageMe'), 'warn');
      } else {
        others.setRage(m.id, m.until - net.clockOffset);
        others.trigger(m.id, 'rage');
        audio.rage(others.positions().find((x) => x.id === m.id)?.pos);
        hud.toast(t('tz.rageZombie'), 'bad');
      }
      break;
    case 'end':
      G.phase = PHASE.ENDED;
      G.practice = false;
      hud.setPractice(false);
      hud.showResult(m.winner, m.reason);
      if (m.winner === 'zombie') audio.zombieWin();
      else audio.survivorWin();
      audio.ambient(false);
      input.unlock();
      ammoBoxes = [];
      AMMO_POOL.forEach((mesh) => { mesh.visible = false; });
      setTimeout(() => { hud.hideResult(); menu.showLobby(); hud.setInRound(false); }, 6000);
      break;
    case 'chat':
      hud.toast(`${m.name}: ${m.text}`);
      break;
    case 'ammoSpawn': {
      // 서버가 일정 시간마다 스폰시킨 탄약상자 — 같은 자리가 이미 있으면 무시
      if (ammoBoxes.some((x) => x.i === m.i)) break;
      ammoBoxes.push({ i: m.i, x: m.x, z: m.z, type: m.type ?? 'rifle', taken: false });
      const mesh = AMMO_POOL[m.i];
      if (mesh) {
        dressAmmoBox(mesh, m.type ?? 'rifle');
        mesh.visible = true;
      }
      break;
    }
    case 'pickup': {
      // 내가 주운 것은 로컬에서 이미 처리했다 — 여기서 상자만 제거한다
      const idx = ammoBoxes.findIndex((x) => x.i === m.box);
      if (idx >= 0) {
        AMMO_POOL[ammoBoxes[idx].i].visible = false;
        ammoBoxes.splice(idx, 1);
      }
      break;
    }
  }
});

net.on(S.ERROR, (m) => hud.toast(m.text, 'bad'));

// [debug] ?offline — 서버에 붙지 않고 화면(메뉴 · 대기실)만 본다. 붙으면 대기실에 한 명이 늘어난다
if (!new URLSearchParams(location.search).has('offline')) net.connect();

// ---------------------------------------------------------------- 메뉴

canvas.addEventListener('click', () => {
  if (G.phase === PHASE.PLAYING && G.state !== PSTATE.DEAD) input.lock();
});

input.onLockChange = (locked) => {
  if (!locked && G.phase === PHASE.PLAYING) {
    // Esc 로 일시정지 화면이 뜬다 — 설정(감도)을 게임 중에 맞출 수 있어야 한다
    menu.showPause(G.practice);
  } else if (locked) {
    menu.hide();
  }
};

// ---------------------------------------------------------------- 루프

let last = performance.now() / 1000;
let sendAcc = 0;
let seq = 0;

function frame() {
  const t = performance.now() / 1000;
  const dt = Math.min(0.1, t - last);
  last = t;

  const playing = G.phase === PHASE.PLAYING;
  const controllable = playing && (G.state === PSTATE.ALIVE || G.state === PSTATE.DOWNED);

  // debugFP: 포인터락을 못 쓰는 환경(자동화 브라우저)에서 1인칭을 확인하려고 둔다
  if (controllable && (input.locked || G.debugFP)) {
    const mouse = input.takeMouse();
    me.look(mouse.dx, mouse.dy);

    // 쓰러지면 엎드려 기어서만 움직인다 (localPlayer.crawling) — 동료에게 다가가 일으켜 달라고
    me.crawling = G.state === PSTATE.DOWNED;
    if (me.crawling) me.update(dt, input);
    if (G.state === PSTATE.ALIVE) {
      // 라운드 시작 — 좀비는 묶여 있다. 이동·점프·충전 전부 못 하고
      // 시점만 돌릴 수 있다. (공격은 tryFire 에서 이미 차단)
      const restrained = G.role === 'zombie' && G.hold > 0;
      if (restrained) {
        me.vel.set(0, 0, 0);
        me.charge = 0;
        me.wasHolding = false;
        me.slamPending = false;
      } else {
        // 활을 당기고 있으면 이동이 느려지고 점프도 못 한다 — 풀장전 조준을 하려면
        // 멈춰야 하고, 장전 중에 슈퍼점프로 띄워지면 안 된다
        const bowCharging = (bowDraw || bowPending) && weapon.spec?.id === 'bow';
        // CPR 중엔 무릎 꿇고 있다 — 움직이지도 뛰지도 못한다
        me.slowMul = G.reviving ? 0 : (bowCharging ? (weapon.spec.chargeSlow ?? 0.5) : 1);
        me.noJump = bowCharging || G.reviving;
        me.update(dt, input);

        // 비행 중인 화살을 전진시키고 명중을 판정한다 (화살이 닿아야 데미지)
        updateBowShot(dt);

        // 춤 — Ctrl+1 · 2 · 3. 움직이면 멈춘다 (avatarAnim.emote). 묶인 좀비는 못 춘다
        for (let n = 1; n <= EMOTE_COUNT; n++) {
          if (!input.took(`emote${n}`) || G.state !== PSTATE.ALIVE || (G.role === 'zombie' && G.hold > 0)) continue;
          if (selfAvatar?.userData.anim?.emote(n)) net.send(C.ACTION, { kind: 'emote', n });
        }

        if (G.role === 'zombie') {
          if (input.took('special')) net.send(C.ACTION, { kind: 'rage' });
          // Shift = 달리기(스프린트). 예전엔 여기서 돌진(lunge)도 같이 발동했는데
          // lunge 가 vel.y=3.2 로 공중으로 띄워서 MV.AIR → jump 클립이 한 프레임
          // 번쩍였다. 달리기만 남긴다.

          // 스페이스 꾹 → 떼면 슈퍼점프, 착지하면 광범위 공격
          const L = me.loadout;
          const jump = me.updateCharge(dt, input.has('jump'), L);
          if (jump === 'super') {
            me.superJump(me.lastCharge, L);
            audio.slamJump();
          } else if (jump === 'hop') {
            me.vel.y = L.jumpSpeed;
            me.onGround = false;
          }
          if (me.justLanded && me.slamPending) {
            me.slamPending = false;
            // 충전량까지 보낸다 — 착지 모션 재생 속도를 정하는 데 쓴다
            net.send(C.ACTION, { kind: 'slam', charge: me.lastCharge ?? 0 });
            // 착지하는 바로 그 순간 내려찍기 모션을 재생한다. 서버 왕복을 기다리면
            // "착지"와 "내려찍기"가 따로따로 두 동작처럼 보인다 — 한 동작으로 보이게.
            const rate = slamRate(me.lastCharge ?? 0);
            fx.slam(me.pos.x, me.pos.z, L.slamRadius);
            audio.thump();
            fx.kick(0.35);
            view.trigger('slam', rate);
            selfAvatar?.userData.anim?.trigger('slam', rate);
          }
        } else {
          if (input.took('special') && startReload(t)) hud.toast(t('tz.reload'));
          // 3인칭 몸의 교체 동작(소총을 등에 메고 권총 뽑기)은 이동 비트 ALT 로 avatarAnim 이 튼다
          if (input.took('slot1') && weapon.select(0, t)) view.equipWeapon(weapon.spec);
          if (input.took('slot2') && weapon.select(1, t)) view.equipWeapon(weapon.spec);
        }
      }
    }

    const eye = me.eye();
    if (G.thirdPerson) {
      placeCamera(camera, eye, me.lookEuler(), [mapGroup], dt, boxes);
    } else {
      camera.position.copy(eye);
      camera.rotation.copy(me.lookEuler());
    }
    audio.setListener(camera);
    bodySounds(dt);

    // 반동 — 발사할 때 카메라가 위로·뒤로 밀렸다가 빠르게 돌아온다.
    // me.pitch 에 직접 넣지 않는다: 서버에 보고하는 조준각을 흔들면
    // "마우스 안 댔는데 시점이 돌아갔다" 가 된다. 보이는 것만 흔들고,
    // 다음 발사부터 반동이 쌓인 방향으로 나가게 만드는 게 진짜 반동이다.
    if (camRecoil.pitch > 1e-5 || camRecoil.yaw > 1e-5 || camRecoil.pos > 1e-5) {
      camera.rotation.x += camRecoil.pitch;
      camera.rotation.y += camRecoil.yaw;
      camera.getWorldDirection(_dir);
      camera.position.addScaledVector(_dir, -camRecoil.pos);
      camera.updateMatrixWorld();
    }
    { const rec = Math.exp(-dt * 13); camRecoil.pitch *= rec; camRecoil.yaw *= rec; camRecoil.pos *= rec; }
    bloom *= Math.exp(-dt * 2.0);

    // 3인칭이면 내 몸을 내 위치에 놓고 동작을 돌린다
    if (selfAvatar) {
      selfAvatar.position.copy(me.pos);
      const sp = Math.hypot(me.vel.x, me.vel.z);
      const anim = selfAvatar.userData.anim;
      // 쿨타임 때문에 발사가 밀려 있는 동안(bowPending)도 시위는 당겨져 있다
      const bits = myBits() | (bowPending ? MV.FIRE : 0);

      // 방향 결정: 이동 중이면 이동 방향, 정지/공격/활 조준 중이면 카메라 방향
      const attacking = anim?.attackBusy || anim?.aims(bits);
      let targetYaw;
      if (attacking || sp <= 0.25) {
        targetYaw = me.yaw;
      } else {
        targetYaw = Math.atan2(-me.vel.x, -me.vel.z);
      }

      // 부드러운 회전 보간 (순간 회전 방지)
      let diff = targetYaw - selfAvatar.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      selfAvatar.rotation.y += diff * Math.min(1, dt * 10);

      if (anim) {
        if (G.role === 'zombie' && G.hold > 0) {
          // 묶여 있으면 서 있기 모션만
          anim.updateHold(dt);
        } else {
          anim.update(dt, bits, G.state, sp);
        }
      }
    }

    if (G.state === PSTATE.ALIVE) {
      weapon.update(t);
      if (G.role === 'zombie') updateAimState(eye);
      tryFire(t, eye);
      tryRevive(dt);
      tryPickupAmmo();
    } else if (G.role === 'zombie') {
      // 쓰러지면 조준 상태 표시를 끈다
      hud.crossState('');
      if (aimHint) { aimHint = ''; hud.setHint(''); }
    }
  } else {
    hud.crossState('');
    // 로비 / 관전 — 맵을 천천히 돈다
    // 장전 중이던 활은 취소한다 — 사망·라운드 종료·포인터 해제 후
    // 남은 장전이 나중에 발사되는 걸 막는다. 비행 중이던 화살도 없앤다.
    if (bowDraw || bowPending) { bowDraw = null; bowPending = null; view.setDraw(0); audio.bowCancel(); }
    for (const s of bowShots) fx.killArrow(s.visual);   // 비행 중이던 화살 전부 회수
    bowShots.length = 0;
    spectatorAngle += dt * 0.08;
    if (selfAvatar && playing && G.state === PSTATE.DEAD) selfAvatar.userData.anim?.update(dt, 0, 'dead', 0);
    // 맵이 가로로 길어서(80 × 52) 타원으로 돈다
    camera.position.set(Math.cos(spectatorAngle) * 46, 18, Math.sin(spectatorAngle) * 32);
    camera.lookAt(0, 1, 0);
  }

  // 서버에 위치 보고 (20Hz)
  sendAcc += dt;
  if (controllable && sendAcc >= 1 / SEND_HZ) {
    sendAcc = 0;
    net.send(C.INPUT, {
      seq: ++seq,
      p: [+me.pos.x.toFixed(2), +me.pos.y.toFixed(2), +me.pos.z.toFixed(2)],
      yaw: +me.yaw.toFixed(3),
      pitch: +me.pitch.toFixed(3),
      mv: myBits(),
    });
  }

  others.hold = G.hold;   // 묶임 중엔 좀비 아바타가 묶인 모션을 쓴다
  others.update(dt, net.serverTime());

  // 캐릭터끼리 겹침 방지 — 위치 보간이 끝난 직후에 밀어낸다
  separatePlayers();
  updateCpr(dt);

  // 좀비는 가까운 생존자가 벽 너머로 희미하게 보인다
  if (G.role === 'zombie' && playing) {
    const range = net.config?.BASE?.zombie?.senseRange ?? 18;
    const near = new Set();
    for (const { id, pos, state } of others.positions()) {
      if (state !== PSTATE.DEAD && pos.distanceTo(me.pos) < range) near.add(id);
    }
    others.setSilhouettes(near);
  } else {
    others.setSilhouettes(new Set());
  }

  hud.setVitals(G.hp, G.maxHp, me.stamina, me.loadout?.staminaMax ?? 0);
  hud.setTimer(G.phase, G.left, G.hold);
  hud.setAmmo(weapon, t);
  hud.setFps(dt);
  hud.setSlots(weapon);
  // 좀비는 슈퍼점프 충전, 생존자는 활 장전 — 같은 게이지 바를 쓰지만 라벨은 따로
  hud.setCharge(G.role === 'zombie' ? (me.charge ?? 0)
    : (bowDraw ? bowDraw.charge : (bowPending ? bowPending.c : 0)),
    G.role === 'zombie' ? 'chargeJump' : 'chargeBow');
  updateStatusHud();

  // 손은 카메라 회전을 흔들기 전에 갱신한다 (흔들림까지 같이 먹지 않게)
  const walking = controllable && (input.locked || G.debugFP) && G.state === PSTATE.ALIVE
    && (input.has('fwd') || input.has('back') || input.has('left') || input.has('right'));
  view.update(dt, walking, me.sprinting, me.raging);

  fx.update(dt, camera);   // 흔들림은 카메라 회전을 덮으므로 렌더 직전에

  // ── 순간이동 추적 ──
  {
    const ctl = controllable && (input.locked || G.debugFP);
    if (_lastPos) {
      // 이번 프레임 이동을 "바라보는 방향" 에 투영한다. 음수면 뒤로 간 것.
      const dx = me.pos.x - _lastPos.x;
      const dz = me.pos.z - _lastPos.z;
      const fx2 = -Math.sin(me.yaw);
      const fz2 = -Math.cos(me.yaw);
      diag.push({
        t: +t.toFixed(3), dt: +dt.toFixed(4),
        mv: +Math.hypot(dx, dz).toFixed(4),
        fwd: +(dx * fx2 + dz * fz2).toFixed(4),
        cam: _lastCam ? +camera.position.distanceTo(_lastCam).toFixed(4) : 0,
        dyaw: _lastYaw === null ? 0 : +(me.yaw - _lastYaw).toFixed(4),
        ctl, sw: _wasCtl !== ctl,
      });
      if (diag.length > 900) diag.shift();
    }
    _wasCtl = ctl;
    _lastYaw = me.yaw;
    _lastCam = camera.position.clone();
    _lastPos = me.pos.clone();
  }

  input.endFrame();
  resize();
  renderer.render(scene, camera);
  view.render(renderer, camera.aspect);   // 손은 월드 위에 덧그린다
}

// ---------------------------------------------------------------- 전투

const _dir = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _end = new Vector3();
const _muzzle = new Vector3();
const _hitPoint = new Vector3();
const _arrowDir = new Vector3();   // 화살 구간·방향 판정용 임시 벡터
const _arrowUp = new Vector3(0, 1, 0);   // 화살(실린더) 축 — 속도 방향으로 돌린다

// 화살 포물선 중력 — WORLD.gravity 보다 약하게, 포물선 느낌은 살리되
// 사거리가 너무 죽지 않게. effects.js 의 ARC_GRAV 와 같은 값이다.
const ARROW_GRAVITY = WORLD.gravity * 0.4;

// 반동 상태. 카메라만 흔든다 (조준 보고에는 영향 없음).
//  pitch — 위로 밀리는 각(라디안), yaw — 좌우 흔들림, pos — 뒤로 밀리는 거리
const camRecoil = { pitch: 0, yaw: 0, pos: 0 };

// 탄퍼짐 불림. 연사할수록 흩어지고, 멈추면 천천히 돌아온다.
let bloom = 0;
let lastShotT = -10;

/**
 * 3인칭 — 십자선(카메라 축)이 실제로 맞는 지점까지의 카메라 기준 거리.
 * 십자선에 대상이 있으면 대상, 없으면 벽, 둘 다 없으면 null.
 *
 * aimFrom 이 이 거리에 수렴점을 두면 눈에서 쏜 총알이 십자선 명중점을
 * 정확히 통과해서 근접·원거리를 막고 십자선과 일치한다.
 */
function crosshairDist(targets, range) {
  camera.getWorldDirection(_dir);
  const hit = raycastTarget(camera.position, _dir, targets, boxes, range + 10, 0, false);
  if (hit) return hit.dist;
  const wall = raycastBoxes(camera.position, _dir, boxes, 60);
  if (wall) return wall.dist;
  return null;
}

// ── 활 장전 — 꾹 누르면 당김(이동 감속), 떼면 발사. 장전이 길수록 세게·멀게. ──
const BOW_MIN_CHARGE = 0.15;   // 짧게 탭해도 최소 이 정도 위력
let bowDraw = null;      // { t0, charge } — 당기고 있는 중
let bowPending = null;   // { c, at } — 쿨타임 끝나면 발사할 대기 발사

function tryFire(t, eye) {
  const spec = weapon.spec;
  if (!spec) return;

  // 활은 클릭 발사가 아니라 장전→발사다 — 별도 경로로 돌린다
  if (spec.id === 'bow') { updateBow(t, eye); return; }

  // 자동 화기는 누르고 있으면 연사, 단발은 누른 순간만
  const wants = spec.auto ? input.mouse.left : input.took('fire');
  if (!wants || !weapon.canFire(t)) {
    // 탄창이 비면 딸깍 하고 알아서 재장전
    if (input.took('fire') && !weapon.reloading && weapon.ammo === 0) audio.dryFire();
    if (input.mouse.left && !weapon.reloading && weapon.ammo === 0) startReload(t);
    return;
  }

  // 좀비는 구속 시간 동안 못 때린다
  if (G.role === 'zombie' && G.hold > 0) return;
  // 직전 모션이 아직 끝나지 않으면 다음 펀치 금지 — 끊으면 평캔이 된다
  if (G.role === 'zombie' && selfAvatar?.userData.anim?.attackBusy) return;

  const baseSpread = weapon.fire(t);
  // 이동 페널티 — 달리는 속도가 빠를수록 총이 흔들린다 (정지 사격이 유리)
  // 주먹(좀비)은 넓은 원뿔 판정이라 여기에 얹지 않는다
  const _sp = G.role === 'zombie' ? 0 : Math.hypot(me.vel.x, me.vel.z);
  const moveSpread = _sp * _sp * 0.0005;
  // 첫 발 보너스 — 0.4초 이상 멈췄다가 쏜 첫 발은 연사 퍼짐이 없다
  const gap = t - lastShotT;
  lastShotT = t;
  if (gap > 0.4) bloom = 0;
  const spread = (gap > 0.4 ? 0 : baseSpread + bloom) + moveSpread;

  const targets = others.positions().filter((o) => others.roles.get(o.id) !== G.role);

  // 3인칭은 카메라가 눈보다 뒤·위·옆에 있다. 카메라 방향 그대로 쏘면
  // 총알이 조준점보다 아래·왼쪽으로 어긋나므로, aimFrom 이 "십자선이
  // 실제로 맞는 지점"을 향해 눈에서 쏘게 방향을 보정한다. 그러면 총알이
  // 십자선 명중점을 정확히 통과해서 모든 사거리에서 십자선과 일치한다.
  // 발사 원점은 눈이므로 사거리도 맞다.
  if (G.thirdPerson) aimFrom(camera, eye, _dir, crosshairDist(targets, spec.range));
  else camera.getWorldDirection(_dir);

  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const shotDir = spreadDir(_dir, spread, _right, _up);

  // 주먹은 원뿔 판정 — 레이저처럼 정확히 겨냥해야 맞추는 게 아니라
  // 스윙의 폭 안에서면 맞는다 (총은 cone 0 으로 레이저 그대로)
  const hit = raycastTarget(eye, shotDir, targets, boxes, spec.range,
    G.role === 'zombie' ? MELEE_CONE : 0, false);

  view.kick(G.role === 'zombie' ? 0.55 : (spec.auto ? 0.65 : 1.0));

  if (G.role === 'zombie') {
    // 주먹은 애니메이션이 실제로 뻗는 순간에 맞춰 타격을 넣는다.
    // 누른 순간에 넣으면 상대가 주먹이 나가기 전에 반응한다.
    selfAvatar?.userData.anim?.trigger('attack');
    const windup = selfAvatar?.userData.anim?.attackWindup ?? 0;
    audio.zombieSwing(windup);
    const land = () => {
      fx.kick(0.16);
      if (hit) {
        audio.punchHit();
        // 주먹이 실제로 닿은 위치에 버스트 — 조준점이 맞는 지점인지 바로 보인다
        _hitPoint.copy(eye).addScaledVector(shotDir, hit.dist);
        fx.impact(_hitPoint, hit.head);
        net.send(C.HIT, { target: hit.id, dmg: damageFor(spec, hit.head), head: hit.head });
      }
    };
    if (windup > 0.01) setTimeout(land, windup * 1000);
    else land();
  } else {
    // 활은 총성이 아니라 시위 소리가 난다
    audio.gunshot(spec.id);
    fx.kick(spec.auto ? 0.045 : 0.1);
    // 반동 — 단발(권총)은 크게 한 번, 자동(소총·스MG)는 작게 자주.
    // 쌓여서 천장이 있으니 연사해도 화면이 날아가지 않는다.
    camRecoil.pitch = Math.min(0.08, camRecoil.pitch + (spec.auto ? 0.013 : 0.030));
    camRecoil.yaw += (Math.random() - 0.5) * (spec.auto ? 0.006 : 0.014);
    camRecoil.pos = Math.min(0.10, camRecoil.pos + (spec.auto ? 0.016 : 0.042));
    bloom = Math.min(0.05, bloom + (spec.auto ? 0.006 : 0.012));
    // 총알선은 카메라가 아니라 총구에서 나가야 한다. 카메라 한가운데서
    // 그리면 "아무 데서나 총알이 나오는" 것처럼 보인다.
    const _mz = G.thirdPerson ? eye.clone() : view.muzzleWorld(camera, _muzzle);
    // 탄착군 — 사람을 안 맞히면 탄은 벽에서 멈춘다
    const wall = hit ? null : raycastBoxes(eye, shotDir, boxes, Math.min(spec.range, 60));
    if (wall) fx.bulletHole(wall.point, wall.normal);
    _end.copy(eye).addScaledVector(shotDir, hit ? hit.dist : (wall ? wall.dist : Math.min(spec.range, 60)));
    fx.addTracer(_mz, _end);
    // 다른 사람 화면에도 총알선이 보이도록 서버가 중계하게 한다 —
    // 시작점은 몸이 아니라 총구 위치
    net.send(C.ACTION, { kind: 'fire', from: [_mz.x, _mz.y, _mz.z], to: _end });

    if (hit) {
      _hitPoint.copy(eye).addScaledVector(shotDir, hit.dist);
      fx.impact(_hitPoint, hit.head);
      net.send(C.HIT, { target: hit.id, dmg: damageFor(spec, hit.head), head: hit.head });
    }
  }
}

/**
 * 활 — 마우스를 꾹 누르는 동안 장전이 쌓이고, 떼는 순간 발사한다.
 * 장전량(0~1)이 데미지와 사거리를 결정한다. 쿨타임이 남아 있으면
 * 대기 상태로 두고, 끝나면 저장된 장전량으로 발사한다.
 */
function updateBow(t, eye) {
  const spec = weapon.spec;
  if (input.mouse.left) {
    if (!bowDraw) {
      bowDraw = { t0: t, charge: 0 };
      audio.bowDraw();
      // 새 장전을 시작하면 이전 대기 발사는 취소한다 — 연타 중 쿨타임이 끝나면
      // "방금 쏜 화살"과 "이전 대기 화살"이 한 프레임 사이로 연속 발사되어
      // 클릭 한 번에 화살 두 개가 나가는 버그를 막는다.
      bowPending = null;
    }
    bowDraw.charge = Math.min(1, (t - bowDraw.t0) / spec.chargeMax);
    view.setDraw(bowDraw.charge);
    return;
  }
  if (bowDraw) {
    const c = Math.max(BOW_MIN_CHARGE, bowDraw.charge);
    bowDraw = null;
    if (weapon.canFire(t)) releaseBow(t, eye, c);
    else bowPending = { c, at: weapon.nextShot };
    return;
  }
  if (bowPending) {
    if (t >= bowPending.at) { const c = bowPending.c; bowPending = null; releaseBow(t, eye, c); }
    else view.setDraw(bowPending.c);   // 대기 중에도 당겨진 채로 보인다
  }
}

/**
 * 활 발사 — 장전량 c 가 데미지·사거리·**화살 속도**를 모두 정한다.
 * 화살은 즉각 명중이 아니라 실제로 날아가고, 닿은 순간에 데미지가 적용된다.
 * 풀장전일수록 화살이 빨라서 회피할 시간이 줄어든다.
 */
function releaseBow(t, eye, c) {
  const spec = weapon.spec;
  weapon.fire(t);   // 쿨타임만 (무한탄약 — 감산 없음)
  // 장전량 제곱으로 스케일 — 짧게 당긴 화살은 데미지·사거리·속도가 급격히 죽는다
  const cc = c * c;
  const dmg = spec.dmgMin + (spec.dmg - spec.dmgMin) * cc;
  const range = spec.rangeMin + (spec.range - spec.rangeMin) * cc;
  const speed = spec.arrowSpeedMin + (spec.arrowSpeed - spec.arrowSpeedMin) * cc;
  const _sp = Math.hypot(me.vel.x, me.vel.z);
  const spread = spec.spread + _sp * _sp * 0.0005;   // 이동 페널티

  const targets = others.positions().filter((o) => others.roles.get(o.id) !== G.role);
  // 3인칭 — 십자선이 실제로 맞는 지점을 향해 눈에서 쏘면 화살이 십자선과
  // 일치한다 (근접 사거리에서도). 1인칭이면 카메라 방향 그대로.
  if (G.thirdPerson) aimFrom(camera, eye, _dir, crosshairDist(targets, range));
  else camera.getWorldDirection(_dir);
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const shotDir = spreadDir(_dir, spread, _right, _up);

  // 풀장전일수록 시위 소리가 크게, 반동도 세게
  audio.bowRelease(c);
  fx.kick(0.5 + 0.5 * c);
  // 3인칭 몸의 시위 당기기·놓기는 발사 버튼 상태로 avatarAnim 이 고른다 —
  // 여기서 공격 클립을 따로 틀면 놓은 뒤에도 당긴 자세로 굳는다.
  camRecoil.pitch = Math.min(0.08, camRecoil.pitch + 0.02 + 0.02 * c);
  camRecoil.yaw += (Math.random() - 0.5) * 0.01;
  camRecoil.pos = Math.min(0.10, camRecoil.pos + 0.03 + 0.02 * c);
  view.setDraw(0);

  // 화살은 총구에서 나간다. 초기 속도 벡터를 주고 중력(ARROW_GRAVITY)이
  // 아래로 끌어내리면 포물선을 그린다 — 장전이 짧을수록 느려서 멀리 못 가고,
  // 풀장전일수록 빨라서 멀리·정확하게 간다. 명중은 updateBowShot 이 매 프레임 판정한다.
  // 장전이 짧을수록 다음 발사까지 오래 걸린다 — 약한 화살을 연타 난사하는 걸 막는다.
  // 풀장전 0.4초, 최소장전(0.15) 약 1.1초.
  weapon.nextShot = Math.max(weapon.nextShot, t + 0.4 + (1 - c) * 0.7);

  // 3인칭이면 화살은 눈높이에서 나간다 (1인칭 총구 위치가 아니라)
  const _mz = G.thirdPerson ? eye.clone() : view.muzzleWorld(camera, _muzzle);
  const shot = {
    pos: _mz.clone(),
    vel: shotDir.clone().multiplyScalar(speed),   // 현재 속도 벡터 (중력 반영)
    dmg, range, traveled: 0,
    // 장전이 짧을수록 중력이 강하게 — 약한 화살은 발밑에서 푹 떨어진다
    grav: ARROW_GRAVITY * (1 + (1 - c) * 1.5),
    visual: null,
  };
  // 상대 화면에도 화살이 날아가게 — 장전량을 같이 보내 속도를 동기화한다
  _end.copy(_mz).addScaledVector(shotDir, Math.min(range, 60));
  // 내 화살은 물리(main.js)가 위치를 직접 조종한다
  shot.visual = fx.addArrow(_mz, _end, speed, { driven: true });
  bowShots.push(shot);   // 이전 화살이 아직 날아가고 있어도 여러 발을 동시에 추적한다
  net.send(C.ACTION, { kind: 'fire', from: [_mz.x, _mz.y, _mz.z], to: _end, c });
}

const bowShots = [];   // 비행 중인 화살들 — updateBowShot 이 매 프레임 전진·판정한다

/**
 * 화살 비행 — 포물선(중력) 물리. 장전량에 따라 초기 속도가 다르다(35~130 m/s):
 * 느린 화살은 멀리 못 가고 크게 휘어지며, 빠른 화살은 멀리·가늘게 간다.
 * 대상에 닿은 순간에야 데미지가 적용된다(느린 화살은 회피할 시간이 있다).
 */
function updateBowShot(dt) {
  if (!bowShots.length) return;
  const targets = others.positions().filter((o) => others.roles.get(o.id) !== G.role);

  for (let k = bowShots.length - 1; k >= 0; k--) {
    const s = bowShots[k];
    // 프레임이 길면 잘게 쪼개서 화살이 몸·벽·바닥을 뚫고 지나가는 걸 막는다
    const maxStep = 0.5;   // m — 한 조각당 최대 이동거리
    const n = Math.max(1, Math.min(12, Math.ceil((s.vel.length() * dt) / maxStep)));
    const h = dt / n;
    let dead = false;

    for (let i = 0; i < n && !dead; i++) {
      const from = s.pos.clone();
      s.vel.y += s.grav * h;                        // 중력 (장전량에 따라 세다)
      s.pos.addScaledVector(s.vel, h);
      s.traveled += s.vel.length() * h;

      // 1) 사람 명중 — 구간 판정으로 빠른 화살이 몸을 뚫고 지나가는 걸 막는다
      const hit = arrowSegmentHit(from, s.pos, targets, boxes);
      if (hit) {
        fx.impact(hit.point, hit.head);
        net.send(C.HIT, { target: hit.id, dmg: s.dmg * (hit.head ? HEAD_MUL : 1), head: hit.head });
        dead = true;
        break;
      }
      // 2) 벽 명중 — 이번 구간에 박스가 있으면 탄착군
      const segLen = from.distanceTo(s.pos);
      if (segLen > 1e-6) {
        _arrowDir.subVectors(s.pos, from).divideScalar(segLen);
        const wall = raycastBoxes(from, _arrowDir, boxes, segLen + 0.02);
        if (wall) {
          fx.bulletHole(wall.point, wall.normal);
          dead = true;
          break;
        }
      }
      // 3) 바닥 명중 — 구간에 바닥면(상자 윗면 포함)이 있으면 꽂힌다
      const floor = groundHeight(s.pos.x, s.pos.z, boxes, 0.05, Infinity);
      if (from.y > floor && s.pos.y <= floor) { dead = true; break; }
      // 4) 사거리 초과 — 장전량에 따라 다르다
      if (s.traveled >= s.range) { dead = true; break; }
      // 시각 동기화 — 물리 위치·방향을 그대로 따른다
      if (s.visual) {
        s.visual.position.copy(s.pos);
        if (s.vel.lengthSq() > 1e-6) {
          _arrowDir.copy(s.vel).normalize();
          s.visual.quaternion.setFromUnitVectors(_arrowUp, _arrowDir);
        }
      }
    }
    if (dead) {
      fx.killArrow(s.visual);   // 명중·벽·바닥·사거리 초과 — 전부 여기서 회수
      bowShots.splice(k, 1);
    }
  }
}

let aimHint = '';

/**
 * 좀비용 — "지금 때리면 맞나"를 조준점 색으로 미리 보여준다.
 * 빨간색(hot) = 사거리·각도 모두 OK, 노란색(near) = 보이나 사거리 밖.
 * 안 그러면 언제 맞추는지 때려봐야 알아서 "타격 지점이 애매" 하다.
 */
function updateAimState(eye) {
  const spec = weapon.spec;
  if (!spec) return;
  const targets = others.positions().filter((o) => others.roles.get(o.id) !== G.role);
  // 3인칭 — 발사와 같은 조준 보정을 써야 "십자선 색이 빨라야 맞는다" 가
  // 실제로 맞는다. 십자선 명중점 거리를 수렴점으로 쓴다.
  if (G.thirdPerson) aimFrom(camera, eye, _dir, crosshairDist(targets, spec.range));
  else camera.getWorldDirection(_dir);

  const inRange = raycastTarget(eye, _dir, targets, boxes, spec.range, MELEE_CONE, false);
  const near = !inRange && raycastTarget(eye, _dir, targets, boxes, spec.range * 2.5, MELEE_CONE, false);

  hud.crossState(inRange ? 'hot' : (near ? 'near' : ''));

  const hint = near ? t('hint.closer') : '';
  if (hint !== aimHint) { aimHint = hint; hud.setHint(hint); }
}

/**
 * 캐릭터끼리 겹치지 않게 밀어낸다.
 *
 * 서버는 클라이언트가 보고한 위치를 그대로 믿고(이동 권위 없음) 플레이어
 * 끼리 충돌을 처리하는 곳이 아무데도 없었다 — 그래서 좀비와 생존자가 몸이
 * 겹쳐서 펀치 각도가 애매해지는 버그가 있었다.
 *
 * 매 프레임 "나 + 살아있는 다른 사람들" 을 두 개씩 짝지어, 반경 합보다
 * 가까우면 침투한 만큼을 반씩 양쪽으로 밀어낸다. 나는 내 물리 위치가
 * 실제로 밀려서(다음 프레임 물리에서 이어지고 서버에도 그 위치가 보고
 * 된다) 영구적으로 겹침이 풀리고, 원격 아바타는 렌더 위치가 밀려서
 * 화면에서 겹침이 풀린다. 양쪽 화면이 같은 계산이라 일치한다.
 */
function separatePlayers() {
  if (G.state !== PSTATE.ALIVE) return;   // 쓰러지면 눕혀져서 밀림도 안 받는다

  const bodies = [{ pos: me.pos, radius: me.radius ?? 0.35 }];
  for (const { pos, state, role } of others.positions()) {
    if (state === PSTATE.DEAD || state === PSTATE.DOWNED) continue;
    const b = BASE[role] ?? BASE.survivor;
    bodies.push({ pos, radius: b.radius });
  }

  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const minDist = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= minDist * minDist) continue;          // 겹치지 않음
      if (Math.abs(b.pos.y - a.pos.y) > 1.5) continue; // 위로 점프해서 넘는 중

      const d = Math.sqrt(d2);
      const push = (minDist - d) / 2;
      if (d < 1e-4) { a.pos.x -= push; b.pos.x += push; continue; } // 정확히 같은 자리
      const nx = dx / d, nz = dz / d;
      a.pos.x -= nx * push; a.pos.z -= nz * push;
      b.pos.x += nx * push; b.pos.z += nz * push;
    }
  }

  // 밀려서 벽에 박힐 수 있으니 내 위치는 벽 충돌을 한 번 더 해결한다
  resolveCollision(me.pos, boxes, me.radius ?? 0.35, me.height ?? 1.75);
}

function tryRevive(dt) {
  if (G.role !== 'survivor') { hud.setRevive(0); G.reviving = false; return; }

  const cand = findReviveTarget(me.pos, others.positions());
  const holding = input.has('use');
  const secs = me.loadout?.reviveSec ?? 3.5;

  if (cand && !holding) hud.setHint(t('hint.revive'));
  else if (!cand) hud.setHint('');

  G.reviving = !!(cand && holding);
  const done = revive.update(dt, holding, cand, secs);
  hud.setRevive(cand && holding ? revive.progress : 0);
  if (done !== null) {
    net.send(C.ACTION, { kind: 'revive', target: done });
    hud.setHint('');
  }
}

/** 탄약상자 — 반경 안에 들어가면 자동 주운다. (생존자만) */
function tryPickupAmmo() {
  if (G.role !== 'survivor' || G.phase !== PHASE.PLAYING) return;
  // 활처럼 탄약이 무한이면 탄약상자를 아예 무시한다 (주우면 "해당 탄약 없음" 이 뜬다)
  if (weapon.infinite) return;
  for (const b of ammoBoxes) {
    if (b.taken) continue;
    const d = Math.hypot(me.pos.x - b.x, me.pos.z - b.z);
    if (d > AMMO_PICKUP_RADIUS) continue;

    b.taken = true;
    AMMO_POOL[b.i].visible = false;
    // 상자 종류(권총/소총)에 맞는 무기 탄창 크기만큼 보급탄을 채운다
    const spec = WEAPONS[b.type];
    const n = spec ? spec.mag : weapon.magSize;
    const ok = spec ? weapon.addAmmoTo(b.type, n) : weapon.addAmmo(n);
    net.send(C.ACTION, { kind: 'pickup', box: b.i });
    audio.pickup();
    if (ok) hud.toast(t('tz.ammo', { w: t(`w.${spec.id}`), n }), 'good');
    else hud.toast(t('tz.noAmmo'), 'warn');
    break;   // 한 프레임에 한 개면 충분
  }
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width === w && canvas.height === h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// WebGL 컨텍스트가 끊기면 캔버스가 까매진다 — 자동으로 복구하고, 안 되면 알려준다.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  diagShow('그래픽 컨텍스트가 끊어졌습니다. 자동 복구 중…\n안 되면 Ctrl+Shift+R 으로 새로고침해 주세요.');
});
canvas.addEventListener('webglcontextrestored', () => {
  diagBanner.style.display = 'none';
  _diagMsg = '';
});

// 프레임 루프에서 예외가 나면 루프가 조용히 죽는다 — 죽으면 화면에 남긴다.
let _frameErr = null;
function frameSafe(t) {
  try {
    frame(t);
    if (_frameErr) {
      _frameErr = null;
      // 오류가 났다가 다음 프레임에 정상으로 돌아오면 배너를 걷는다.
      // 예전엔 _diagMsg 가 비어 있지 않아서 배너가 영구히 붙어 있었다 —
      // "빨간 에러가 계속 뜬다" 는 느낌의 원인.
      // (WebGL 컨텍스트 끊김은 _frameErr 없이 diagShow 만으로 띄우므로 여기 영향 없음)
      _diagMsg = '';
      diagBanner.style.display = 'none';
    }
  } catch (err) {
    _frameErr = err;
    diagShow('게임 루프 오류:\n' + (err?.stack ?? err).toString().slice(0, 500));
    __dbgPost('frame', (err?.stack ?? err).toString());   // [debug]
  }
}
renderer.setAnimationLoop(frameSafe);

// 개발 편의: 콘솔에서 상태를 들여다보고 전투를 직접 호출할 수 있게.
// (포인터락이 막힌 환경에서 전투를 검증할 때 쓴다)
Object.assign(globalThis, {
  __g: {
    net, me, others, G, weapon, revive, fx, audio, camera, boxes, input, hud, view, scene,
    get self() { return selfAvatar; },
    setSelfAvatar, frame: frameSafe,   // [debug] 창이 가려져 rAF 가 멈춘 자동화 브라우저에서 프레임을 직접 돌린다
    diag,
    /** 기록을 요약해서 한눈에 보여준다. 콘솔에서 __g.report() 로 호출. */
    report() {
      const d = diag.filter((x) => x.ctl);
      if (!d.length) return '기록 없음 — 움직인 다음 다시 호출하세요';
      const back = d.filter((x) => x.fwd < -0.01);
      const bigDt = d.filter((x) => x.dt > 0.033);
      const camJump = d.filter((x) => x.cam > 0.35);
      const swaps = d.filter((x) => x.sw);
      const worst = [...d].sort((a, b) => a.fwd - b.fwd).slice(0, 5);
      const out = {
        '프레임수': d.length,
        '평균 dt': +(d.reduce((s, x) => s + x.dt, 0) / d.length).toFixed(4),
        '최대 dt': +Math.max(...d.map((x) => x.dt)).toFixed(4),
        '느린 프레임(>33ms)': bigDt.length,
        '뒤로 간 프레임': back.length,
        '가장 크게 뒤로': worst.map((x) => ({ fwd: x.fwd, mv: x.mv, dt: x.dt, dyaw: x.dyaw, cam: x.cam })),
        '카메라 큰 점프(>0.35)': camJump.length,
        '조작 전환 횟수': swaps.length,
        '시점': G.thirdPerson ? '3인칭' : '1인칭',
      };
      console.log(out);
      return out;
    },
    resolveLoadout, raycastTarget, damageFor,
    tryFire: (t = performance.now() / 1000) => tryFire(t, me.eye()),
    aimAt: (x, y, z) => {
      // 목표를 향해 시점을 돌린다
      const dx = x - me.pos.x, dz = z - me.pos.z;
      me.yaw = Math.atan2(-dx, -dz);
      const dy = (y) - (me.pos.y + 1.62);
      me.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      camera.position.copy(me.eye());
      camera.rotation.copy(me.lookEuler());
      camera.updateMatrixWorld(true);
    },
  },
});
