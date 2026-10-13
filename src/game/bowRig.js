// 사냥꾼의 활 — 왼손에 쥐고, 시위는 코드로 그려 당길 때 오른손을 따라오게 한다.
//
// 활 모델(hunter_props.glb, tools/build_props.mjs)은 시위를 떼어낸 몸통뿐이다.
// 모델에 박힌 시위는 움직이지 않아서, 당겨도 활만 들고 허공을 당기는 것처럼 보인다.
// 대신 시위 양끝(노드 extras)과 오른손 손가락을 잇는 가는 원통 두 개를 매 프레임
// 다시 놓는다. 당기는 동안에는 화살도 시위에 걸어 보여준다.
//
// 활 좌표: 손잡이 = 원점, 활대 = +Y, 쏘는 쪽 = +Z (단위 m).
// 화살 좌표: 오늬 = 원점, 촉 = +Z.

import {
  AnimationMixer, CylinderGeometry, Matrix4, Mesh, MeshStandardMaterial, Quaternion, Vector3,
} from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const STRING_RADIUS = 0.0022;
/** 당기기·놓기를 따라가는 빠르기(1/초). 놓을 때는 시위가 튕겨 나가므로 즉시. */
const DRAW_FOLLOW = 14;

const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

const findBone = (root, suffix) => {
  let bone = null;
  root.traverse((o) => { if (!bone && o.isBone && o.name.endsWith(suffix)) bone = o; });
  return bone;
};
const worldPos = (o, out = new Vector3()) => out.setFromMatrixPosition(o.matrixWorld);

/** 시위를 거는 손가락 — 검지·중지 둘째 마디 사이 */
const NOCK_FINGERS = ['RightHandIndex2', 'RightHandMiddle2'];

/**
 * 화살을 얹는 자리 (활 좌표). 손잡이 한가운데를 겨누면 화살이 활대를 뚫고
 * 지나간다 — 오른손잡이는 손잡이 왼쪽(+X), 주먹 바로 위에 화살을 얹는다.
 */
const ARROW_REST = new Vector3(0.022, 0.035, 0);

/**
 * 활을 쥐는 자리 — 모델마다 한 번만 구한다.
 *
 * 조준(aim) 클립의 풀장전 자세에서: 손잡이 = 왼손 주먹 안, 쏘는 방향 = 시위를 건
 * 오른손 → 왼손 주먹, 활대 = 그 방향에 수직인 세계 위쪽. 이 자세를 왼손 뼈대 기준
 * 좌표로 바꿔 두면 어떤 동작에서도 손을 따라간다 (Longbow 팩 동작은 전부 활을 쥔 채
 * 만들어졌다). 뼈대에는 Armature 스케일이 걸려 있어서, 그걸 되돌리는 배율도 같이 담긴다.
 */
export function computeBowMount(gltf) {
  const clip = gltf.animations.find((c) => c.name === 'aim');
  if (!clip) return null;
  const root = cloneSkinned(gltf.scene);
  const mixer = new AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(clip.duration * 0.95);
  root.updateMatrixWorld(true);

  const hand = findBone(root, 'LeftHand');
  const knuckle = findBone(root, 'LeftHandMiddle1');
  const fingers = NOCK_FINGERS.map((n) => findBone(root, n));
  if (!hand || !knuckle || fingers.includes(null)) return null;

  const grip = worldPos(hand).lerp(worldPos(knuckle), 0.7);   // 주먹 가운데
  const nock = fingers.reduce((s, f) => s.add(worldPos(f)), new Vector3()).divideScalar(fingers.length);
  const fwd = grip.clone().sub(nock).normalize();
  const up = Y.clone().addScaledVector(fwd, -fwd.dot(Y)).normalize();
  const side = new Vector3().crossVectors(up, fwd);
  const bowWorld = new Matrix4().makeBasis(side, up, fwd).setPosition(grip);

  const local = new Matrix4().copy(hand.matrixWorld).invert().multiply(bowWorld);
  const mount = { position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3() };
  local.decompose(mount.position, mount.quaternion, mount.scale);
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  return mount;
}

export class BowRig {
  /**
   * @param root  캐릭터 복제본 (SkeletonUtils.clone)
   * @param props hunter_props.glb 의 gltf
   * @param mount computeBowMount 결과
   */
  constructor(root, props, mount) {
    this.hand = findBone(root, 'LeftHand');
    this.fingers = NOCK_FINGERS.map((n) => findBone(root, n));

    const bowSrc = props.scene.getObjectByName('Bow');
    const arrowSrc = props.scene.getObjectByName('Arrow');
    this.bow = bowSrc.clone();
    this.bow.position.copy(mount.position);
    this.bow.quaternion.copy(mount.quaternion);
    this.bow.scale.copy(mount.scale);
    this.hand.add(this.bow);

    this.top = new Vector3().fromArray(bowSrc.userData.stringTop);
    this.bottom = new Vector3().fromArray(bowSrc.userData.stringBottom);
    this.rest = this.top.clone().add(this.bottom).multiplyScalar(0.5);

    // 시위 — 높이 1, 아래 끝이 원점인 원통을 늘려서 두 점을 잇는다
    const geo = new CylinderGeometry(STRING_RADIUS, STRING_RADIUS, 1, 5, 1, true);
    geo.translate(0, 0.5, 0);
    const mat = new MeshStandardMaterial({ color: 0xcdbb94, roughness: 0.9 });
    this.upper = new Mesh(geo, mat);
    this.lower = new Mesh(geo, mat);
    this.arrow = arrowSrc.clone();
    this.arrow.visible = false;
    this.bow.add(this.upper, this.lower, this.arrow);
    for (const o of [this.bow, this.upper, this.lower, this.arrow]) o.frustumCulled = false;

    this.draw = 0;
    this._inv = new Matrix4();
    this._nock = new Vector3();
    this._v = new Vector3();
    this.place(this.rest);
  }

  /**
   * 매 프레임 — 동작이 뼈대를 움직인 뒤에 부른다 (AvatarAnim.rigs).
   * anim.drawing 지금 시위를 당기는 동작인지
   * anim.down    쓰러졌는지 — 누운 손에 쥔 활은 바닥을 뚫고 들어가서 내려놓는다
   */
  update(dt, anim) {
    const drawing = anim.drawing;
    this.bow.visible = !anim.down && !anim.emoting && anim.cpr !== 'give';   // 춤 · CPR 땐 활을 감춘다
    // 당길 땐 손을 따라 서서히, 놓으면 시위가 튕겨 제자리로 (화살은 날아갔다)
    this.draw = drawing ? this.draw + (1 - this.draw) * Math.min(1, dt * DRAW_FOLLOW) : 0;
    if (this.draw < 0.001) {
      if (this.arrow.visible) { this.arrow.visible = false; this.place(this.rest); }
      return;
    }
    this.bow.updateWorldMatrix(true, false);
    const nock = this._nock.set(0, 0, 0);
    for (const f of this.fingers) {
      f.updateWorldMatrix(true, false);
      nock.add(worldPos(f, this._v));
    }
    nock.divideScalar(this.fingers.length).applyMatrix4(this._inv.copy(this.bow.matrixWorld).invert());
    nock.lerpVectors(this.rest, nock, this.draw);
    this.place(nock);

    // 화살 — 시위에 걸어 손잡이 옆 화살 자리를 지나게 한다
    this.arrow.visible = this.draw > 0.6;
    if (this.arrow.visible) {
      this.arrow.position.copy(nock);
      this.arrow.quaternion.setFromUnitVectors(Z, this._v.subVectors(ARROW_REST, nock).normalize());
    }
  }

  place(nock) {
    segment(this.upper, nock, this.top);
    segment(this.lower, nock, this.bottom);
  }
}

const _d = new Vector3();
function segment(mesh, a, b) {
  _d.subVectors(b, a);
  const len = _d.length();
  mesh.position.copy(a);
  mesh.quaternion.setFromUnitVectors(Y, _d.divideScalar(len || 1));
  mesh.scale.set(1, len, 1);
}
