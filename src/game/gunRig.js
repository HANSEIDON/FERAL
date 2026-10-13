// 총수의 총 — 소총 · 권총을 오른손에 쥐고, 권총을 들면 소총은 오른쪽 허리에 늘어뜨려 멘다.
//
// 총 모델(gunner_props.glb, tools/build_props.mjs)은 손잡이 = 원점, 총구 = +Z,
// 위 = +Y 다. 어디에 쥘지는 모델마다 한 번, 동작의 한 자세에서 손 위치를 재서
// 오른손 뼈대 기준 좌표로 구해 둔다 (computeGunMounts).
//
// 다만 손목 각도는 동작마다 조금씩 달라서, 한 자세에서 구한 각도로 고정해 두면
// 다른 동작에서 총이 손목을 따라 돌아가 왼손이 총에서 떨어진다 (달리기에서 9cm).
// 그래서 소총은 매 프레임 "오른손 = 손잡이, 왼손 = 총열 덮개 밑" 이 되게 다시
// 돌린다 (두 손 잡기). 재장전처럼 왼손이 총을 놓는 동안에는 고정 각도로 돌아간다.
//
// 무엇을 손에 들고 있는지는 AvatarAnim.hands 가 정한다 — 교체 동작의 시점에 맞춰
// 'rifle' → null(빈손) → 'pistol' 처럼 바뀐다.

import { AnimationMixer, Matrix4, Quaternion, Vector3 } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const UP = new Vector3(0, 1, 0);
const Y = new Vector3(0, 1, 0);

/**
 * 두 손 잡기를 거는 조건. 손바닥 사이가 이 범위이고, 고정 각도의 총과 두 손 선이
 * 이루는 각이 FULL 이하면 완전히 두 손에 맞추고, OFF 이상이면 고정 각도 그대로다
 * (그 사이는 섞는다 — 왼손이 총을 놓고 잡을 때 툭 튀지 않게).
 */
const TWO_HAND = { minDist: 0.12, maxDist: 0.7, fullDeg: 15, offDeg: 40 };

/**
 * 허리에 멘 소총 — 권총 서 있기 자세에서 잰 골반 · 허벅지 오른쪽 표면 바로 바깥에
 * 총구를 아래로 늘어뜨린다 (모델 좌표: +X 왼쪽, +Y 위, +Z 앞).
 *  gap   몸 표면과 총 옆면 사이 (총 폭 절반 3.7cm 를 더해 손잡이 중심을 놓는다)
 *  drop  손잡이를 골반 뼈대보다 이만큼 아래에
 *  back  손잡이를 골반 뼈대보다 이만큼 뒤에
 *  dir   총구 방향 — 아래로, 살짝 앞으로 (개머리판은 허리 뒤쪽으로 올라간다)
 */
const SLING = { gap: 0.015, halfWidth: 0.037, drop: -0.02, back: 0.03, dir: new Vector3(0, -1, 0.18) };

const findBone = (root, suffix) => {
  let bone = null;
  root.traverse((o) => { if (!bone && o.isBone && o.name.endsWith(suffix)) bone = o; });
  return bone;
};
const worldPos = (o, out = new Vector3()) => { o.updateWorldMatrix(true, false); return out.setFromMatrixPosition(o.matrixWorld); };
/** 손바닥 가운데 — 손목에서 가운뎃손가락 뿌리 쪽으로 */
const PALM = 0.6;
const palm = (root, side) => worldPos(findBone(root, `${side}Hand`)).lerp(worldPos(findBone(root, `${side}HandMiddle1`)), PALM);
/** 주먹 안 — 권총 손잡이를 감싼 가운데 · 약지 · 새끼손가락 첫째 · 둘째 마디의 가운데 (검지는 방아쇠에 있다) */
const FIST = ['RightHandMiddle1', 'RightHandRing1', 'RightHandPinky1', 'RightHandMiddle2', 'RightHandRing2', 'RightHandPinky2'];

/** fwd 를 +Z, up 쪽을 +Y 로 하는 회전 행렬 */
function frame(fwd, up) {
  const z = fwd.clone().normalize();
  const x = new Vector3().crossVectors(up, z).normalize();
  const y = new Vector3().crossVectors(z, x);
  return new Matrix4().makeBasis(x, y, z);
}

/** 총 좌표의 v 방향이 세계의 w 방향이 되게 돌리는 회전 (굴림은 up 쪽을 따른다) */
const alignRotation = (v, w, up) => frame(w, up).multiply(frame(v, Y).transpose());

/** 세계 행렬을 뼈대 기준 위치·회전·배율로 (뼈대에는 Armature 스케일이 걸려 있다) */
function localTo(bone, world) {
  bone.updateWorldMatrix(true, false);
  const m = new Matrix4().copy(bone.matrixWorld).invert().multiply(world);
  const out = { position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3() };
  m.decompose(out.position, out.quaternion, out.scale);
  return out;
}

/** 캐릭터를 한 벌 복제해 clip 의 t 초 자세로 세운다. */
function posed(gltf, clipName, t) {
  const clip = gltf.animations.find((c) => c.name === clipName);
  if (!clip) return null;
  const root = cloneSkinned(gltf.scene);
  const mixer = new AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(Math.min(t, clip.duration));
  root.updateMatrixWorld(true);
  return { root, done: () => { mixer.stopAllAction(); mixer.uncacheRoot(root); } };
}

/**
 * 총을 쥐는 자리 — 모델마다 한 번만 구한다.
 *  rifle      서서 쏘기(aim): 오른손 = 손잡이, 왼손 = 총열 덮개 밑. 다른 동작에서는
 *             GunRig 가 두 손에 맞춰 다시 돌리고, 이건 왼손이 떨어졌을 때 쓴다.
 *  rifleSling 권총 서 있기(p_idle)에서 잰 골반 오른쪽 표면 바로 바깥 (SLING).
 *             Mixamo 의 집어넣기·꺼내기는 등이 아니라 오른쪽 허리에 총구를 아래로
 *             메는 동작이다. 손이 잡던 자리를 그대로 쓰면 몸에서 20cm 넘게 떠 있다.
 *  pistol     권총 서서 쏘기(p_aim): 손잡이 = 오른주먹 안(말아 쥔 손가락들의 가운데),
 *             총구 = 두 손이 뻗은 수평 방향. 손바닥 점에 맞추면 권총이 주먹 위에 얹힌다.
 *             손목이 젖혀진 동작이라 손 생김새로 총구를 정하면 위로 30° 넘게 들린다.
 */
export function computeGunMounts(gltf, props) {
  const handguardY = props.scene.getObjectByName('Rifle')?.userData.handguardY ?? 0.04;
  const out = { handguardY };

  const aim = posed(gltf, 'aim', 0.5);
  if (!aim) return null;
  {
    const rh = palm(aim.root, 'Right'), lh = palm(aim.root, 'Left');
    const w = lh.clone().sub(rh);
    const v = new Vector3(0, handguardY, w.length());   // 총 좌표: 손잡이 → 왼손이 받치는 곳
    out.rifle = localTo(findBone(aim.root, 'RightHand'), alignRotation(v, w, UP).setPosition(rh));
  }
  aim.done();

  const stand = posed(gltf, 'p_idle', 0.5);
  if (stand) {
    const hips = findBone(stand.root, 'Hips');
    const hip = worldPos(hips);
    // 골반 높이에서 몸의 오른쪽(-X) 끝 — 더 아래로 재면 허벅지에 찬 권총집까지 들어가서 총이 떠 보인다
    let right = 0;
    const v = new Vector3();
    stand.root.traverse((m) => {
      if (!m.isSkinnedMesh) return;
      for (let i = 0; i < m.geometry.attributes.position.count; i += 2) {
        m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
        if (v.y > hip.y - 0.1 && v.y < hip.y + 0.05 && Math.abs(v.z - hip.z) < 0.15) right = Math.min(right, v.x - hip.x);
      }
    });
    const grip = hip.clone().add(new Vector3(right - SLING.gap - SLING.halfWidth, -SLING.drop, -SLING.back));
    // 총 위(운반 손잡이)가 뒤를 보게 — 탄창이 앞으로, 옆면이 허벅지에 붙는다
    const rot = frame(SLING.dir, new Vector3(0, 0, -1));
    out.rifleSling = localTo(hips, rot.setPosition(grip));
    stand.done();
  }

  const pAim = posed(gltf, 'p_aim', 0.5);
  if (pAim) {
    const rh = palm(pAim.root, 'Right'), lh = palm(pAim.root, 'Left');
    const fwd = rh.clone().add(lh).multiplyScalar(0.5).sub(worldPos(findBone(pAim.root, 'Neck')));
    fwd.y = 0;
    const fist = FIST.reduce((s, n) => s.add(worldPos(findBone(pAim.root, n))), new Vector3()).divideScalar(FIST.length);
    out.pistol = localTo(findBone(pAim.root, 'RightHand'), frame(fwd, UP).setPosition(fist));
    pAim.done();
  }
  return out;
}

const _m = new Matrix4(), _inv = new Matrix4(), _rot = new Matrix4();
const _p = new Vector3(), _s = new Vector3(), _w = new Vector3(), _v = new Vector3(), _up = new Vector3();
const _lh = new Vector3(), _lm = new Vector3();
const _q = new Quaternion(), _qt = new Quaternion();
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class GunRig {
  /**
   * @param root   캐릭터 복제본 (SkeletonUtils.clone)
   * @param props  gunner_props.glb 의 gltf
   * @param mounts computeGunMounts 결과
   */
  constructor(root, props, mounts) {
    this.hand = findBone(root, 'RightHand');
    this.leftHand = findBone(root, 'LeftHand');
    this.leftKnuckle = findBone(root, 'LeftHandMiddle1');
    this.mounts = mounts;
    const make = (name, parent, mount) => {
      const src = props.scene.getObjectByName(name);
      if (!src || !mount || !parent) return null;
      const o = src.clone();
      o.position.copy(mount.position);
      o.quaternion.copy(mount.quaternion);
      o.scale.copy(mount.scale);
      o.frustumCulled = false;
      o.visible = false;
      parent.add(o);
      return o;
    };
    this.rifle = make('Rifle', this.hand, mounts.rifle);
    this.pistol = make('Pistol', this.hand, mounts.pistol);
    this.rifleSling = make('Rifle', findBone(root, 'Hips'), mounts.rifleSling);
    this.twoHand = 0;   // 지금 두 손 잡기를 얼마나 걸었는지 (0~1, 확인용)
  }

  /** 매 프레임 (AvatarAnim.rigs) — 손에 든 것만 보이고, 소총이 손에 없으면 허리에 멘다. */
  update(dt, anim) {
    // 쓰러지면 총을 내려놓는다 — 누운 몸에 쥐거나 멘 총이 바닥을 뚫고 들어간다
    // 춤추는 동안은 손을 비운다 — 소총은 허리에 멘다
    const held = anim.down ? undefined : (anim.emoting || anim.cpr === 'give') ? null : anim.hands;
    if (this.rifle) this.rifle.visible = held === 'rifle';
    if (this.pistol) this.pistol.visible = held === 'pistol';
    if (this.rifleSling) this.rifleSling.visible = held !== undefined && held !== 'rifle';
    if (this.rifle?.visible) this.holdTwoHanded();
  }

  /** 오른손 = 손잡이를 지킨 채, 왼손이 총열 덮개 밑에 오도록 소총을 돌린다. */
  holdTwoHanded() {
    const r = this.rifle, m = this.mounts.rifle;
    r.position.copy(m.position);
    r.quaternion.copy(m.quaternion);
    r.scale.copy(m.scale);
    r.updateWorldMatrix(true, false);
    r.matrixWorld.decompose(_p, _q, _s);   // 고정 각도일 때의 세계 자세 (손잡이 = 오른손바닥)

    worldPos(this.leftHand, _lh).lerp(worldPos(this.leftKnuckle, _lm), PALM);
    _w.subVectors(_lh, _p);
    const d = _w.length();
    this.twoHand = 0;
    if (d < TWO_HAND.minDist || d > TWO_HAND.maxDist) return;

    _v.set(0, this.mounts.handguardY, d);                 // 총 좌표: 손잡이 → 왼손이 받치는 곳
    const c = _v.clone().normalize().applyQuaternion(_q).dot(_w.clone().divideScalar(d));
    const k = smooth(Math.cos(TWO_HAND.offDeg * Math.PI / 180), Math.cos(TWO_HAND.fullDeg * Math.PI / 180), c);
    if (k <= 0) return;
    this.twoHand = k;

    _up.copy(Y).applyQuaternion(_q);                       // 굴림은 오른손 손목을 따른다
    _qt.setFromRotationMatrix(_rot.copy(alignRotation(_v, _w, _up)));
    _q.slerp(_qt, k);
    _m.compose(_p, _q, _s);
    _inv.copy(this.hand.matrixWorld).invert();
    _m.premultiply(_inv).decompose(r.position, r.quaternion, r.scale);
  }
}
