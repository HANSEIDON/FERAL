// 모델 검수기.
//
// ComfyUI 에서 뽑은 GLB 를 화면에 끌어다 놓으면 게임에 쓸 수 있는 물건인지
// 바로 알려준다. 앞으로 에셋 하나 만들 때마다 여기를 거치게 된다.

import {
  AnimationMixer, AxesHelper, Box3, Clock, Color, DirectionalLight,
  EquirectangularReflectionMapping, GridHelper, Group, HemisphereLight, LoopRepeat,
  Mesh, MeshStandardMaterial, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace,
  Vector3, WebGLRenderer, CapsuleGeometry, MeshBasicMaterial, EdgesGeometry, LineSegments,
  LineBasicMaterial, ACESFilmicToneMapping,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { initLoaders, parseModel, loadModel } from './core/assets.js';
import { inspect, verdict, fmt, fmtBytes } from './viewer/inspect.js';

const el = (id) => document.getElementById(id);
const canvas = el('view');

// ---------------------------------------------------------------- 렌더러

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new Scene();
scene.background = new Color(0x15171c);

// 중립 스튜디오 환경광. PBR 머티리얼이 제대로 보이려면 환경맵이 있어야 한다
// (없으면 메탈릭 표면이 새까맣게 나온다).
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new HemisphereLight(0xdfe7ff, 0x35302a, 1.2));
const sun = new DirectionalLight(0xffffff, 2.0);
sun.position.set(3, 6, 4);
scene.add(sun);

const camera = new PerspectiveCamera(45, 1, 0.01, 200);
camera.position.set(2.2, 1.6, 2.8);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 0.9, 0);

// ---------------------------------------------------------------- 기준자

// 1m 격자 + 1.7m 사람 실루엣. 스케일이 틀렸는지는 숫자보다 이게 빨리 보인다.
const grid = new GridHelper(20, 20, 0x4a5163, 0x2a2f3a);
scene.add(grid);
scene.add(new AxesHelper(0.5));

const human = new LineSegments(
  new EdgesGeometry(new CapsuleGeometry(0.28, 1.14, 4, 12)),
  new LineBasicMaterial({ color: 0x3d7dff, transparent: true, opacity: 0.55 }),
);
human.position.set(0.9, 0.85, 0);   // 1.7m 키
human.name = '__ref_human';
scene.add(human);

// ---------------------------------------------------------------- 상태

let current = null;      // 현재 올라간 모델 Group
let mixer = null;
let action = null;
const clock = new Clock();

initLoaders(renderer);

// ---------------------------------------------------------------- 로딩

async function showGLTF(gltf, name, bytes) {
  if (current) {
    scene.remove(current);
    disposeTree(current);
  }
  mixer = null;
  action = null;

  current = gltf.scene ?? gltf.scenes[0];
  scene.add(current);

  // 카메라를 모델 크기에 맞춘다
  const box = new Box3().setFromObject(current);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) || 1;
  controls.target.copy(center);
  camera.position.copy(center).add(new Vector3(radius * 1.1, radius * 0.6, radius * 1.5));
  camera.near = radius / 200;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.update();

  // 애니메이션
  const clips = gltf.animations ?? [];
  const sel = el('clips');
  sel.innerHTML = '';
  if (clips.length) {
    mixer = new AnimationMixer(current);
    clips.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = `${c.name || '(이름없음)'} — ${c.duration.toFixed(2)}s`;
      sel.appendChild(o);
    });
    sel.disabled = false;
    playClip(clips, 0);
    sel.onchange = () => playClip(clips, +sel.value);
  } else {
    sel.innerHTML = '<option>애니메이션 없음</option>';
    sel.disabled = true;
  }

  report(inspect(gltf, bytes), name);
}

function playClip(clips, i) {
  if (!mixer) return;
  action?.stop();
  action = mixer.clipAction(clips[i]);
  action.setLoop(LoopRepeat, Infinity).reset().play();
}

function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.geometry?.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      for (const k of Object.keys(m)) if (m[k]?.isTexture) m[k].dispose();
      m.dispose();
    }
  });
}

// ---------------------------------------------------------------- 리포트

function report(s, name) {
  el('empty').style.display = 'none';
  el('report').style.display = 'block';
  el('filename').textContent = name;

  const kind = el('kind').value;
  const rows = [
    ['삼각형', fmt(s.tris), s.tris > (kind === 'prop' ? 3000 : 20000)],
    ['정점', fmt(s.verts), false],
    ['드로우콜', `${s.drawCalls}회 (메시 ${s.meshCount} · 머티리얼 ${s.materialCount})`, s.drawCalls > (kind === 'prop' ? 2 : 4)],
    ['텍스처', s.textureCount ? `${s.textureCount}장 · VRAM 약 ${s.texVramMB}MB` : '없음', s.texVramMB > 40],
    ['크기', `${s.size.x} × ${s.size.y} × ${s.size.z} m`, false],
    ['스켈레톤', s.skinned ? `본 ${s.boneCount}개 · 스킨드 메시 ${s.skinned}개` : '없음 (리깅 안 됨)', !s.skinned && kind === 'character'],
    ['애니메이션', s.animations.length ? `${s.animations.length}개` : '없음', false],
    ['압축', s.compression.length ? s.compression.join(', ') : '없음 (원본)', false],
    ['파일 크기', fmtBytes(s.fileBytes), s.fileBytes > 15 * 1024 * 1024],
  ];

  el('stats').innerHTML = rows
    .map(([k, v, warn]) => `<tr><th>${k}</th><td class="${warn ? 'warn' : ''}">${v}</td></tr>`)
    .join('');

  el('maps').innerHTML = Object.entries(s.maps)
    .map(([k, has]) => `<span class="chip ${has ? 'on' : 'off'}">${k}</span>`)
    .join('');

  el('issues').innerHTML = verdict(s, kind)
    .map((i) => `<li class="${i.level}">${i.text}</li>`)
    .join('');

  el('texlist').innerHTML = s.textures.length
    ? s.textures.map((t) => `<li>${t.w}×${t.h}${t.compressed ? ' <em>KTX2</em>' : ''} — ${t.name}</li>`).join('')
    : '<li class="muted">텍스처 없음</li>';

  lastStats = s;
  lastName = name;
}

let lastStats = null;
let lastName = '';
el('kind').onchange = () => { if (lastStats) report(lastStats, lastName); };
el('wire').onchange = (e) => {
  current?.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m) m.wireframe = e.target.checked;
    }
  });
};
el('refToggle').onchange = (e) => { human.visible = e.target.checked; grid.visible = e.target.checked; };

// ---------------------------------------------------------------- 드래그&드롭

const drop = document.body;
['dragenter', 'dragover'].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('dragging'); }));

drop.addEventListener('drop', async (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  await openFile(file);
});

el('picker').onchange = async (e) => {
  const f = e.target.files?.[0];
  if (f) await openFile(f);
};

async function openFile(file) {
  if (!/\.(glb|gltf)$/i.test(file.name)) {
    alert('GLB 또는 glTF 파일만 됩니다.\n(FBX 는 ComfyUI SaveGLB 로 GLB 를 뽑으세요)');
    return;
  }
  setStatus(`${file.name} 읽는 중…`);
  try {
    const buf = await file.arrayBuffer();
    const gltf = await parseModel(buf, '');
    await showGLTF(gltf, file.name, file.size);
    setStatus('');
  } catch (err) {
    setStatus('');
    console.error(err);
    alert(`로드 실패: ${err.message}`);
  }
}

function setStatus(t) {
  el('status').textContent = t;
  el('status').style.display = t ? 'block' : 'none';
}

// URL 로도 열 수 있다:  ?model=models/zombie.glb
const q = new URLSearchParams(location.search).get('model');
if (q) {
  setStatus(`${q} 받는 중…`);
  let bytes = 0;
  loadModel(q, (e) => {
    if (e.total) bytes = e.total;
    setStatus(`${q} 받는 중… ${Math.round((e.loaded / (e.total || e.loaded)) * 100)}%`);
  })
    .then((g) => showGLTF(g, q, bytes))
    .catch((e) => alert(`로드 실패: ${e.message}`))
    .finally(() => setStatus(''));
}

// ---------------------------------------------------------------- 루프

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width === w && canvas.height === h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

renderer.setAnimationLoop(() => {
  resize();
  const dt = clock.getDelta();
  if (mixer && el('play').checked) mixer.update(dt);
  controls.update();
  renderer.render(scene, camera);
});
