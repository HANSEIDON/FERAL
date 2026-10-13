// 1인칭 손에 든 것. 카메라에 붙어 따라다닌다.
//
// 지금은 박스로 만든 임시 모델이다. 나중에 GLB 가 준비되면 build() 안만
// 갈아끼우면 된다 — 바깥에서는 muzzleWorld() 와 kick() 만 쓴다.
//
// 총구 위치가 중요하다. 총알선이 카메라 한가운데서 나가면 "아무 데서나
// 총알이 나오는" 것처럼 보인다. 실제 총구에서 나가야 눈이 납득한다.

import {
  BoxGeometry, DirectionalLight, Group, HemisphereLight, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, PerspectiveCamera, Scene, Vector3,
} from 'three';

import { loadModel } from '../core/assets.js';

const _v = new Vector3();

/**
 * 1인칭 주먹 모델. 있으면 박스 대신 쓴다.
 *
 * 스켈레톤도 애니메이션도 필요 없다 — 휘두르는 동작은 updateSwing() 이
 * 코드로 만들기 때문에, 주먹 덩어리 하나만 있으면 된다.
 * 만들 때 규약: 손목이 원점, 주먹이 -Z 를 향하고, 길이 30cm 안팎.
 */
let fistModel = null;

/**
 * 1인칭 주먹 크기. 2.15m 짜리 덩치의 손이라 사람 손보다 훨씬 커야
 * 화면에서 납득이 된다. 박스든 GLB 든 이 값 하나로 같이 커진다.
 */
const FIST_SCALE = 1.45;
/** 좌우로 벌어진 정도. 크게 키우면 같이 벌려야 가운데가 안 막힌다. */
const FIST_SPREAD = 0.34;

export async function preloadFist(url = './models/fist.glb') {
  try {
    const gltf = await loadModel(url);
    fistModel = gltf.scene;
    fistModel.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    return true;
  } catch {
    return false;      // 없으면 박스로 간다 — 흔한 경우라 경고하지 않는다
  }
}

export class ViewModel {
  constructor() {
    // 손은 월드와 따로 그린다. 이유가 둘 있다.
    //  1) 월드 FOV(78) 로 40cm 앞의 총을 그리면 화면을 다 잡아먹는다.
    //     좁은 FOV 로 따로 그려야 크기가 납득된다.
    //  2) 같은 씬에 두면 벽에 붙었을 때 총이 벽을 뚫고 나간다.
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(55, 1, 0.01, 10);

    this.scene.add(new HemisphereLight(0xc9d6f0, 0x2a2822, 1.5));
    const key = new DirectionalLight(0xfff0d8, 2.2);
    key.position.set(0.6, 1, 0.4);
    this.scene.add(key);

    this.root = new Group();
    this.scene.add(this.root);

    this.muzzle = new Group();
    this.parts = new Group();
    this.root.add(this.parts, this.muzzle);

    this.flash = new Mesh(
      new BoxGeometry(0.06, 0.06, 0.06),
      new MeshBasicMaterial({ color: 0xffd9a0 }),
    );
    this.flash.visible = false;
    this.muzzle.add(this.flash);

    this.recoil = 0;      // 0~1
    this.bob = 0;         // 걸을 때 흔들림 위상
    this.role = null;
    this.isBow = false;   // 활은 총구 섬광 대신 시위 소리로만 발사
    this.draw = 0;        // 활 장전량 0~1 — 꾹 누를수록 시위·화살이 당겨진다
    this.drawTarget = 0;  // 목표 장전량, update() 에서 부드럽게 따라간다
    this.bowArrow = null;
    this.bowString = null;

    this.base = new Vector3(0.22, -0.20, -0.42);   // 화면 오른쪽 아래
  }

  /** 역할이 정해지면 손에 든 것을 바꾼다. */
  equip(role, weaponSpec = null) {
    this.role = role;
    this.parts.clear();
    this.fists = null;
    this.swing = 0;

    // 1인칭은 3인칭 모델을 쓰지 않는다.
    //
    // 원격 아바타의 GLB 를 그대로 써보려 했지만 안 된다. Mixamo 클립은
    // 3인칭용이라 팔이 몸통 옆·아래로 움직이는데, 머리에 달린 카메라의
    // 55도 시야에는 그게 안 들어온다 — 때리는 중에도 화면이 비어 있었다.
    // 몸을 앞으로 당기면 이번엔 거대한 어깨가 시야를 덮는다.
    // FPS 가 1인칭 팔을 따로 만드는 이유다.
    //
    // 대신 휘두르는 동작을 코드로 만들고(updateSwing), 모양만 갈아끼운다.
    // public/models/fist.glb 를 넣으면 박스 대신 그게 쓰인다.
    if (role === 'zombie') this.buildFists();
    else this.buildWeapon(weaponSpec?.id ?? 'rifle');
  }

  /** 1/2 키로 무기를 바꿨을 때 — 손에 든 모양만 갈아끼운다. */
  equipWeapon(spec) {
    if (this.role === 'zombie') return;
    this.parts.clear();
    this.buildWeapon(spec?.id ?? 'rifle');
    this.recoil = 0.5;                 // 바꿔 드는 동작처럼 보이게
  }

  /** 무기 id 로 모양을 골라 만든다. 활이면 활, 나머지는 총. */
  buildWeapon(id) {
    this.isBow = id === 'bow';
    this.draw = this.drawTarget = 0;
    this.bowArrow = this.bowString = null;
    if (this.isBow) { this.buildBow(); return; }
    this.buildGun(id);
  }

  /** 활 장전량 설정 (0~1). update() 에서 부드럽게 당겨진다. */
  setDraw(c) { this.drawTarget = Math.max(0, Math.min(1, c)); }

  /** 총 모양. 주무기는 길고, 권총은 짧고 화면을 덜 가린다. */
  buildGun(id = 'rifle') {
    const body = new MeshStandardMaterial({ color: 0x3b424f, roughness: 0.6, metalness: 0.4 });
    const grip = new MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.85 });
    const wood = new MeshStandardMaterial({ color: 0x7a5636, roughness: 0.8 });

    const put = (geo, mat, x, y, z) => {
      const m = new Mesh(geo, mat);
      m.position.set(x, y, z);
      this.parts.add(m);
      return m;
    };

    if (id === 'pistol') {
      put(new BoxGeometry(0.048, 0.085, 0.24), body, 0, 0, -0.06);      // 슬라이드
      put(new BoxGeometry(0.044, 0.15, 0.09), grip, 0, -0.115, 0.055);  // 손잡이
      put(new BoxGeometry(0.026, 0.024, 0.05), body, 0, 0.058, -0.15);  // 가늠쇠

      this.muzzle.position.set(0, 0.005, -0.19);
      this.base.set(0.20, -0.20, -0.46);
      return;
    }

    // rifle / smg — 같은 형태에 길이만 다르다
    const len = id === 'smg' ? 0.40 : 0.54;
    put(new BoxGeometry(0.055, 0.075, len), body, 0, 0, -len * 0.33);   // 총열/기관부
    put(new BoxGeometry(0.045, 0.14, 0.12), grip, 0, -0.095, 0.07);     // 손잡이
    put(new BoxGeometry(0.038, 0.12, 0.07), grip, 0, -0.085, -0.07);    // 탄창
    put(new BoxGeometry(0.03, 0.028, 0.10), body, 0, 0.053, -len * 0.74); // 가늠쇠
    put(new BoxGeometry(0.09, 0.055, 0.14), wood, 0.03, -0.065, 0.16);  // 개머리판

    // 총구는 총열 끝에 맞춘다. 여기서 총알선이 나간다.
    this.muzzle.position.set(0, 0.005, -(len * 0.33 + len / 2 + 0.01));
    // 눈앞 34cm 에 두면 개머리판이 화면을 다 가린다. 60cm 뒤로 물린다.
    this.base.set(0.24, -0.22, -0.62);
  }

  /**
   * 활 모양. 세로로 세운 활몸 + 활시위 + 손잡이, 앞으로 뻗은 화살.
   * 총과 달리 총구 섬광이 없다 — 발사 반동만 보이고 화살촉 끝에서
   * 화살선이 나간다.
   */
  buildBow() {
    const wood = new MeshStandardMaterial({ color: 0x8a5a34, roughness: 0.72, metalness: 0.05 });
    const dark = new MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.8 });
    const string = new MeshBasicMaterial({ color: 0xd8d8cf });
    const shaft = new MeshStandardMaterial({ color: 0xb0a98f, roughness: 0.6 });
    const head = new MeshStandardMaterial({ color: 0x5b626e, roughness: 0.35, metalness: 0.7 });

    const put = (geo, mat, x, y, z) => {
      const m = new Mesh(geo, mat);
      m.position.set(x, y, z);
      this.parts.add(m);
      return m;
    };

    // 활몸 — 세로로 세운 얇은 막대 (곡선은 직선으로 근사)
    put(new BoxGeometry(0.03, 0.54, 0.032), wood, 0, 0, -0.10);
    // 활 끝(위·아래) — 살짝 두껍게
    put(new BoxGeometry(0.04, 0.05, 0.04), dark, 0, 0.27, -0.10);
    put(new BoxGeometry(0.04, 0.05, 0.04), dark, 0, -0.27, -0.10);
    // 활시위 — 활몸 뒤(몸 쪽)를 잇는 가느다란 줄. 장전 시 몸 쪽으로 당겨진다
    this.bowString = put(new BoxGeometry(0.004, 0.54, 0.004), string, 0, 0, -0.072);
    // 손잡이 — 활몸 중앙, 손이 잡는 자리
    put(new BoxGeometry(0.05, 0.15, 0.055), dark, 0, 0, -0.088);

    // 화살 — 앞으로 뻗은 가느다란 막대 + 화살촉 + 깃.
    // 그룹으로 묶어 장전할 때 통째로 몸 쪽으로 당긴다.
    const arrow = new Group();
    const putArrow = (geo, mat, z) => {
      const m = new Mesh(geo, mat);
      m.position.set(0, 0, z);
      arrow.add(m);
    };
    putArrow(new BoxGeometry(0.012, 0.012, 0.66), shaft, -0.44);
    putArrow(new BoxGeometry(0.022, 0.022, 0.07), head, -0.78);
    // 깃(화살 끝) — 시위 쪽에 살짝
    putArrow(new BoxGeometry(0.05, 0.05, 0.02), shaft, -0.13);
    this.parts.add(arrow);
    this.bowArrow = arrow;

    // 화살은 화살촉 끝에서 나간다.
    this.muzzle.position.set(0, 0, -0.80);
    // 활은 총보다 화면을 덜 가리도록 오른쪽 아래에 둔다.
    this.base.set(0.24, -0.20, -0.58);
  }

  /**
   * 양 주먹. 휘두르는 동작은 updateSwing() 이 코드로 만든다 — 애니메이션
   * 클립이 아니다. 그래서 **정적인 주먹 GLB 하나만 있으면** 박스를 대체할
   * 수 있고, 스켈레톤도 클립도 필요 없다.
   *
   * public/models/fist.glb 가 있으면 그걸 쓰고, 없으면 박스로 간다.
   * 모델은 손목이 원점, 주먹이 -Z 를 향하게 만들면 된다.
   */
  buildFists() {
    const skin = new MeshStandardMaterial({ color: 0x74a03a, roughness: 0.9 });
    const dark = new MeshStandardMaterial({ color: 0x52702a, roughness: 0.95 });

    // 윈스턴처럼 큼직한 양팔. 휘두를 때 번갈아 나간다.
    const S = FIST_SCALE;
    this.fists = [];
    for (const s of [-1, 1]) {
      const f = new Group();
      f.userData.side = s;
      f.userData.home = { x: s * FIST_SPREAD, y: -0.06, z: -0.06, rz: s * 0.18 };
      f.position.set(s * FIST_SPREAD, -0.06, -0.06);
      f.rotation.z = s * 0.18;

      if (fistModel) {
        const m = fistModel.clone(true);
        m.scale.set(S * s, S, S);       // 왼손은 X 를 뒤집어 거울상으로
        f.add(m);
      } else {
        const hand = new Mesh(new BoxGeometry(0.20 * S, 0.19 * S, 0.23 * S), skin);
        const knuckle = new Mesh(new BoxGeometry(0.21 * S, 0.07 * S, 0.09 * S), dark);
        knuckle.position.set(0, 0.085 * S, -0.10 * S);
        const arm = new Mesh(new BoxGeometry(0.14 * S, 0.14 * S, 0.30 * S), dark);
        arm.position.z = 0.22 * S;
        f.add(hand, knuckle, arm);
      }

      this.parts.add(f);
      this.fists.push(f);
    }
    this.swingSide = 1;      // 다음에 휘두를 팔
    this.swing = 0;          // 0~1 진행도

    this.muzzle.position.set(0, -0.06, -0.24);
    // 팔이 뒤로 뻗어 있어 총보다 더 물려야 한다. 눈앞 13cm 까지 오면
    // 화면 절반이 팔로 덮인다.
    this.base.set(0, -0.30, -0.82);
  }

  /** 발사 반동. 좀비는 반동 대신 한쪽 팔을 크게 휘두른다. */
  kick(amount = 1) {
    if (this.role === 'zombie') {
      this.swingSide = -this.swingSide;    // 좌우 번갈아
      this.swing = 1;
      return;
    }
    this.recoil = Math.min(1, this.recoil + amount);
    // 활은 총구 섬광이 없다 — 화살이 나가는 시위 소리만 들린다
    if (!this.isBow) {
      this.flash.visible = true;
      this.flashUntil = performance.now() / 1000 + 0.035;
    }
  }

  /**
   * 총구 끝의 **월드** 좌표. 손은 따로 그리므로, 손 씬에서의 좌표를
   * 실제 카메라 기준으로 옮겨야 총알선이 맞는 자리에서 나간다.
   */
  muzzleWorld(worldCamera, out = _v) {
    this.muzzle.getWorldPosition(out);        // 손 씬 좌표 = 카메라 로컬 좌표
    return out.applyMatrix4(worldCamera.matrixWorld);
  }

  hide() { this.root.visible = false; }
  show() { this.root.visible = true; }

  /** 월드를 그린 뒤 그 위에 덧그린다. */
  render(renderer, aspect) {
    if (!this.root.visible) return;
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    renderer.autoClear = false;
    renderer.clearDepth();                    // 월드보다 항상 앞에 그린다
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }

  update(dt, moving, sprinting, raging = false) {
    const t = performance.now() / 1000;

    if (this.flash.visible && t > this.flashUntil) this.flash.visible = false;

    // 걸을 때 위아래로 살짝 흔든다. 속도감이 확 산다.
    if (moving) this.bob += dt * (sprinting ? 13 : 8.5);
    const amp = moving ? (sprinting ? 0.016 : 0.009) : 0;
    const bx = Math.cos(this.bob) * amp;
    const by = Math.abs(Math.sin(this.bob)) * amp;

    // 반동은 뒤로 밀렸다가 제자리로
    this.recoil = Math.max(0, this.recoil - dt * 7);
    const rz = this.recoil * 0.08;
    const rx = this.recoil * 0.18;

    this.root.position.set(this.base.x + bx, this.base.y - by, this.base.z + rz);
    this.root.rotation.set(rx, 0, 0);

    // 활 장전 — 시위와 화살이 당긴 만큼 몸 쪽으로 당겨진다
    if (this.bowArrow) {
      this.draw += (this.drawTarget - this.draw) * Math.min(1, dt * 18);
      if (this.draw < 0.001 && this.drawTarget === 0) this.draw = 0;
      const pull = this.draw * 0.16;
      this.bowArrow.position.z = pull;
      this.bowString.position.z = -0.072 + pull;
    }

    if (this.fists) this.updateSwing(dt, raging);
  }

  /**
   * 광폭화·착지충격을 1인칭에서도 느끼게 — 양팔을 크게 한 번 휘두른다.
   * rate — 착지충격은 충전량에 비례해 휘두르기를 빨리 감는다.
   */
  trigger(clip, rate = 1) {
    if (!this.fists) return;
    if (clip === 'slam' || clip === 'rage') {
      this.swing = 1;
      this.swingSide = -this.swingSide;
      this.swingRate = rate;
    }
  }

  /**
   * 주먹 휘두르기. 한쪽 팔이 바깥에서 안쪽으로 크게 돌아 들어온다.
   * 광폭화 중에는 더 빠르게 감긴다.
   */
  updateSwing(dt, raging) {
    const rate = (raging ? 6.5 : 4.2) * (this.swingRate ?? 1);
    this.swing = Math.max(0, this.swing - dt * rate);

    for (const f of this.fists) {
      const h = f.userData.home;
      const active = f.userData.side === this.swingSide;
      // 1 에서 0 으로 줄어드는 값을 0→1→0 의 호로 바꾼다
      const k = active ? Math.sin((1 - this.swing) * Math.PI) : 0;

      f.position.set(
        h.x - f.userData.side * k * (FIST_SPREAD + 0.04),  // 바깥에서 가운데로
        h.y + k * 0.08,                     // 살짝 들었다가 (조준점을 다 가리지 않게)
        h.z - k * 0.52,                     // 앞으로 내지른다
      );
      f.rotation.set(-k * 1.1, f.userData.side * k * 0.7, h.rz - f.userData.side * k * 0.9);
    }
  }
}
