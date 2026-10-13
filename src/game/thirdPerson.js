// 3인칭 카메라.
//
// 좀비·생존자 모두 3인칭으로 본다. 덩치와 슈퍼점프·착지 충격이 몸 전체로
// 드러나야 하고, 이미 만들어둔 전신 애니메이션 12개가 그래야 쓰인다.
//
// 조준은 화면 한가운데(조준점)가 기준이다. 카메라가 눈보다 뒤·위·옆에
// 있으므로, 카메라 방향 그대로 쏘면 총알이 조준점보다 아래·왼쪽으로
// 어긋난다. 그래서 "십자선이 실제로 맞는 지점"(대상·벽)을 잡고, 실제
// 공격은 플레이어 눈에서 그 점을 향해 나가게 한다. 그러면 총알이 그
// 지점을 정확히 통과해서 모든 사거리에서 십자선과 일치한다. 발사
// 원점은 눈이므로 사거리도 맞다.

import { Raycaster, Vector3 } from 'three';

import { groundHeight } from './world.js';

/** 어깨 뒤 어디에 둘지. 오른쪽으로 살짝 빼야 조준점이 몸에 안 가린다. */
export const TP = {
  dist: 3.2,          // 뒤로 떨어진 거리
  height: 1.05,       // 어깨 위 높이 (발 기준이 아니라 눈 기준에서 더한다)
  side: 0.55,         // 오른쪽으로
  // 최소 거리를 너무 낮게 잡으면 당기는 폭이 커서 그 자체가 순간이동이 된다.
  // 카메라가 기둥(2.6m)·낮은 벽(1.4m)보다 높이 있어 가릴 일이 드물기도 하다.
  // 모서리를 잠깐 스치는 건 감수하고 폭을 줄이는 쪽이 낫다.
  minDist: 1.9,       // 벽에 끼었을 때 최소 거리
  aimRange: 30,       // 대상·벽이 없는 빈 하늘을 쏠 때의 수렴점 거리. 대상이
                      // 있으면 십자선이 맞는 지점의 거리를 써서 이 값은 거의 안 쓴다.
  easeIn: 12,         // 벽에 끼어 당겨질 때 (빠르게, 그래도 부드럽게)
  easeOut: 10,        // 벽에서 벗어나 원래 거리로 돌아올 때
                      // (너무 느리면 뒤로 끌려가는 느낌이 오래 간다)
  probe: 0.35,        // 벽 감지 여유 — 모서리에서 깜빡이지 않게 두껍게 본다
  // 고개 각도를 얼마나 따라갈지. 1 이면 시선대로 크게 휘둘려 멀미가 난다.
  pitchInfluence: 0.45,
  pitchMax: 0.85,     // 위아래 최대 (라디안)
  floorMargin: 0.45,  // 바닥에서 최소 이만큼 띄운다
};

/** 지금 카메라 거리. 매 프레임 튀지 않게 이어서 쓴다. */
let _dist = null;

const _dir = new Vector3();
const _right = new Vector3();
const _want = new Vector3();
const _origin = new Vector3();
const _hit = new Vector3();
const _ray = new Raycaster();

/**
 * 카메라를 플레이어 뒤에 놓는다. 벽이 끼면 앞으로 당겨서 뚫고 들어가지
 * 않게 한다.
 *
 * @param camera  월드 카메라
 * @param eye     플레이어 눈 위치
 * @param euler   플레이어 시선 (pitch, yaw)
 * @param solids  벽으로 칠 Object3D 배열 (맵 그룹)
 * @param dt      프레임 시간 — 거리 복귀를 부드럽게 하는 데 쓴다
 */
export function placeCamera(camera, eye, euler, solids, dt, boxes) {
  // 보는 방향은 시선 그대로 둔다 — 조준이 시선과 어긋나면 안 된다.
  camera.rotation.copy(euler);
  camera.updateMatrixWorld(true);
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);

  // 위치를 잡을 때는 고개 각도를 줄여서 쓴다.
  //
  // 시선 그대로 3.2m 반경을 돌리면 위아래로 훑기만 해도 카메라가 6m 넘게
  // 휘둘리고, 위를 보면 아예 지면 아래(-0.12m)까지 내려가 바닥을 뚫고 본다.
  // 그게 순간이동처럼 보인다.
  const p = clamp(euler.x * TP.pitchInfluence, -TP.pitchMax, TP.pitchMax);
  const cp = Math.cos(p);

  _want.set(
    eye.x + Math.sin(euler.y) * TP.dist * cp,
    eye.y + TP.height - Math.sin(p) * TP.dist,
    eye.z + Math.cos(euler.y) * TP.dist * cp,
  ).addScaledVector(_right, TP.side);

  // 그 사이에 벽이 있으면 앞으로 당긴다.
  //
  // 레이는 눈이 아니라 카메라 높이 근처에서 쏜다. 눈높이(1.98m)에서 쏘면
  // 2.6m 기둥을 스칠 때마다 걸려서, 실제로는 기둥 위(3.03m)에 있는 카메라를
  // 괜히 당겼다가 되돌린다 — 그게 "카메라가 못 따라와서 끌려가는" 느낌이다.
  _origin.copy(eye);
  _origin.y += TP.height * 0.85;

  const back = _want.clone().sub(_origin);
  const len = back.length();
  let target = len;

  if (len > 0.001 && solids?.length) {
    back.divideScalar(len);
    _ray.set(_origin, back);
    _ray.far = len;
    const hits = _ray.intersectObjects(solids, true);
    if (hits.length) target = Math.max(TP.minDist, hits[0].distance - TP.probe);
  }

  // 레이캐스트 결과를 그대로 쓰면 카메라가 순간이동한다.
  //
  // 당길 때도 부드러워야 한다. 처음엔 "끼면 즉시 당김" 으로 했는데,
  // 기둥 옆을 스치며 달리면 매번 3.6 -> 0.9 로 확 당겼다가 되돌아가서
  // 앞뒤로 튕기는 것처럼 보였다. 당기는 쪽을 훨씬 빠르게 하되(벽을
  // 뚫기 전에 들어와야 한다) 한 프레임에 꽂지는 않는다.
  const step = Math.min(1, (dt ?? 0.016) * (target < _dist ? TP.easeIn : TP.easeOut));
  if (_dist === null) _dist = target;
  else _dist += (target - _dist) * step;

  camera.position.copy(_origin).addScaledVector(back, _dist);

  // 바닥 아래로는 절대 내려가지 않는다. 상자 위를 지날 때도 그 위로 올린다.
  if (boxes) {
    const floor = groundHeight(camera.position.x, camera.position.z, boxes, 0.2);
    camera.position.y = Math.max(camera.position.y, floor + TP.floorMargin);
  }
}

/** 라운드가 바뀌면 거리 기억을 지운다 (엉뚱한 데서 시작하지 않게). */
export function resetCamera() { _dist = null; }

/**
 * 조준 방향 — 십자선(카메라 축)과 일치하게 눈에서 나가는 방향으로 바꾼다.
 *
 * 카메라가 눈보다 뒤·위·옆에 있으므로 카메라 방향 그대로 쏘면 총알이
 * 조준점보다 아래·왼쪽으로 어긋난다. 그래서 카메라 축 위의 점(조준점)
 * 을 잡고, 눈에서 그 점을 향해 쏘면 총알이 조준점을 정확히 통과한다.
 *
 * 조준점은 "십자선이 실제로 맞는 지점"의 거리(aimDist)에 두어야 근접
 * 사거리에서도 어긋나지 않는다. 수렴점이 먼 곳에 고정되면 근접 대상은
 * 여전히 1m 넘게 아래·왼쪽으로 빗나간다. aimDist 가 없으면 빈 하늘
 * 사격을 위해 TP.aimRange 로 대체한다.
 *
 * @param aimDist  카메라에서 조준점까지의 거리 (십자선 명중점)
 */
export function aimFrom(camera, eye, out = new Vector3(), aimDist = null) {
  camera.getWorldDirection(_dir);
  const d = aimDist > 0 ? aimDist : TP.aimRange;
  // 조준점 — 카메라 축 위에서 d 만큼 앞의 점
  _hit.copy(camera.position).addScaledVector(_dir, d);
  return out.copy(_hit).sub(eye).normalize();
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
