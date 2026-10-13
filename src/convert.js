// 캐릭터 빌더 — Mixamo FBX + ComfyUI GLB → 게임용 GLB
//
// 파이프라인:
//   1. Mixamo FBX 로드로 스켈레톤 + 메시 + 애니메이션 확보
//   2. ComfyUI GLB 에서 머티리얼(텍스처) 추출 → Mixamo 메시에 이식
//   3. 루트모션 제거 (서버가 위치를 정하는 구조라 제자리 동작만 남긴다)
//   4. 키 스케일 조정
//   5. GLB 내보내기

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ─── 사냥꾼 클립 매핑 (FBX 파일명 소문자 → 게임 클립명) ───
const CLIP_MAP = {
  'standing idle 01':                    'idle',
  'standing idle 03 examine':            'idle_examine',
  'standing run forward':                'run',
  'standing aim overdraw':               'attack',
  'standing aim walk forward':           'aim_walk_fwd',
  'standing aim walk back':              'aim_walk_back',
  'standing aim walk left':              'aim_walk_left',
  'standing aim walk right':             'aim_walk_right',
  'standing death backward 01':          'death',
  'standing jump running to run forward':'jump',
};

// 루트모션을 제거할 클립 (death 는 제외 — 쓰러지는 게 자연스러움)
const IN_PLACE = new Set([
  'idle', 'idle_examine', 'run', 'attack',
  'aim_walk_fwd', 'aim_walk_back', 'aim_walk_left', 'aim_walk_right',
  'jump',
]);

// ─── 상태 ───
let scene, camera, renderer, controls, mixer;
let baseGroup = null;       // Mixamo 캐릭터 (스켈레톤 + 메시)
let clips = [];             // { name, clip, duration, source }
let glbReady = false;
let currentAction = null;
let clock = new THREE.Clock();

// ─── DOM ───
const $ = id => document.getElementById(id);
const canvas = $('view');
const logEl = $('log');
const clipListEl = $('clipList');
const statusEl = $('status');

function log(msg, cls = '') {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = msg;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function flash(msg) {
  statusEl.textContent = msg;
  statusEl.style.display = 'block';
  setTimeout(() => statusEl.style.display = 'none', 2500);
}

// ─── 씬 초기화 ───
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d24);

  const w = canvas.clientWidth, h = canvas.clientHeight;
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
  camera.position.set(2, 1.5, 3);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.9, 0);
  controls.update();

  // 조명
  const amb = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(3, 5, 4);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0x8899ff, 0.3);
  fill.position.set(-2, 1, -3);
  scene.add(fill);

  // 바닥 그리드
  const grid = new THREE.GridHelper(6, 12, 0x333644, 0x252830);
  scene.add(grid);

  window.addEventListener('resize', () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  animate();
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (mixer) mixer.update(dt);
  controls.update();
  renderer.render(scene, camera);
}

// ─── FBX 로드 ───
const fbxLoader = new FBXLoader();

function loadFBXFromArrayBuffer(buf, filename) {
  // Three.js r186: parse() 는 동기적으로 반환 (콜백 없음)
  return fbxLoader.parse(buf, '');
}

async function handleFBXFiles(files) {
  for (const file of files) {
    try {
      flash(`로딩 중: ${file.name}`);
      const buf = await file.arrayBuffer();
      const group = await loadFBXFromArrayBuffer(buf, file.name);

      // 파일명에서 클립명 매핑
      const stem = file.name.replace(/\.fbx$/i, '').toLowerCase().replace(/\s+/g, ' ').trim();
      const clipName = CLIP_MAP[stem];

      if (!clipName) {
        log(`⏭  매핑 없음: "${file.name}" — 건너뜀`, 'warn');
        disposeGroup(group);
        continue;
      }

      // 애니메이션 추출
      if (!group.animations || group.animations.length === 0) {
        log(`⚠  "${file.name}" — 애니메이션 없음`, 'warn');
        disposeGroup(group);
        continue;
      }

      const rawClip = group.animations[0];

      // 첫 FBX = 기준 (스켈레톤 + 메시)
      if (!baseGroup) {
        baseGroup = group;
        scene.add(baseGroup);
        mixer = new THREE.AnimationMixer(baseGroup);
        log(`🦴 기준 캐릭터 로드: ${file.name}`, 'ok');
      } else {
        // 기준이 이미 있으면 이 FBX 는 동작만 쓰고 버린다
        disposeGroup(group);
      }

      // 루트모션 제거
      let clip = rawClip;
      if ($('stripRM').checked && IN_PLACE.has(clipName)) {
        clip = stripRootMotion(rawClip);
        log(`  ✂  ${clipName}: 루트모션 제거`, 'ok');
      }

      // 기존同名 클립 교체
      const existing = clips.findIndex(c => c.name === clipName);
      if (existing >= 0) {
        clips[existing] = { name: clipName, clip, duration: clip.duration, source: file.name };
        log(`  ↺  ${clipName} 교체 (${clip.duration.toFixed(2)}s)`, 'warn');
      } else {
        clips.push({ name: clipName, clip, duration: clip.duration, source: file.name });
        log(`  ✓  ${clipName} 적용 (${clip.duration.toFixed(2)}s)`, 'ok');
      }

      // 기본 이름 부여
      clip.name = clipName;

      renderClipList();
      $('btnExport').disabled = false;

    } catch (e) {
      log(`✗  ${file.name}: ${e.message}`, 'err');
      console.error(e);
    }
  }
  flash('완료');
}

// ─── 루트모션 제거 ───
// Hips 의 위치 트랙에서 "한 방향으로 흐르는" 성분만 고정한다.
// 진동(발걸음 들썩임, 점프 높이)은 남긴다.
function stripRootMotion(clip) {
  const trimmed = [];
  for (const track of clip.tracks) {
    // Hips 의 position 트랙만 처리
    if (!track.name.includes('Hips') || !track.name.endsWith('.position')) {
      trimmed.push(track);
      continue;
    }

    const vals = track.values;
    const stride = track.getValueSize();
    const nFrames = vals.length / stride;
    if (nFrames < 2) { trimmed.push(track); continue; }

    // 각 축별로 드래프트 vs 진동 판정
    const newVals = new Float32Array(vals);
    let modified = false;

    for (let axis = 0; axis < stride; axis++) {
      const first = vals[axis];
      const last = vals[(nFrames - 1) * stride + axis];
      const drift = Math.abs(last - first);

      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < nFrames; i++) {
        const v = vals[i * stride + axis];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const span = mx - mn;
      if (span < 1e-6) continue;

      // 세로축(Z=2, Y=1 in three)은 점프 높이라 남길 수 있다
      // Three.js 는 Y-up 이라 axis 1 이 세로
      if (axis === 1) continue;

      // 흐름이 진동의 50% 를 넘으면 이동 성분
      if (drift > span * 0.5) {
        for (let i = 0; i < nFrames; i++) {
          newVals[i * stride + axis] = first;
        }
        modified = true;
      }
    }

    if (modified) {
      trimmed.push(new THREE.NumberKeyframeTrack(
        track.name, track.times, newVals
      ));
    } else {
      trimmed.push(track);
    }
  }

  return new THREE.AnimationClip(clip.name, clip.duration, trimmed);
}

// ─── GLB 로드 (머티리얼 추출) ───
const gltfLoader = new GLTFLoader();

async function handleGLBFile(file) {
  try {
    flash('GLB 로딩 중…');
    const buf = await file.arrayBuffer();
    const gltf = await new Promise((res, rej) =>
      gltfLoader.parse(buf, '', res, rej)
    );

    // 머티리얼 + 텍스처 확보
    const mesh = gltf.scene.getObjectByName(gltf.scene.children[0]?.name) || gltf.scene.children[0];
    let targetMesh = null;
    gltf.scene.traverse(o => { if (o.isMesh && !targetMesh) targetMesh = o; });

    if (targetMesh && targetMesh.material) {
      // 머티리얼을 클론해서 참조 유지
      const mat = targetMesh.material.clone();
      applyMaterialToBase(mat);
      glbReady = true;
      $('glbBadge').textContent = '적용됨';
      $('glbBadge').className = 'badge';
      log(`🎨 머티리얼 이식: ${mat.name || '(unnamed)'}`, 'ok');
      log(`  텍스처: ${countTextures(mat)}장`, 'ok');
    } else {
      log('⚠  GLB 에서 메시/머티리얼을 찾지 못함', 'warn');
    }

    // 원본 GLB 는 버린다 (머티리얼만 쓴 것)
    gltf.scene.traverse(o => {
      if (o.isMesh) {
        o.geometry?.dispose();
        // 머티리얼은 클론한 것이라 원본은 dispose
        if (o.material !== mat) o.material?.dispose();
      }
    });

  } catch (e) {
    log(`✗  GLB 로드 실패: ${e.message}`, 'err');
    console.error(e);
  }
  flash('완료');
}

function countTextures(mat) {
  let n = 0;
  for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
    if (mat[key]) n++;
  }
  return n;
}

function applyMaterialToBase(mat) {
  if (!baseGroup) {
    log('⚠  기준 캐릭터가 아직 없습니다. 먼저 FBX 를 열어주세요.', 'warn');
    return;
  }
  baseGroup.traverse(o => {
    if (o.isMesh) {
      o.material = mat;
      o.material.needsUpdate = true;
    }
  });
}

// ─── 키 스케일 ───
function applyScale() {
  if (!baseGroup) return;
  const targetH = parseFloat($('targetH').value) || 1.75;

  // 현재 키 측정
  const box = new THREE.Box3().setFromObject(baseGroup);
  const h = box.max.y - box.min.y;
  if (h < 0.01) return;

  const k = targetH / h;
  baseGroup.scale.multiplyScalar(k);
  log(`📏 키 ${h.toFixed(3)}m → ${targetH}m (배율 ${k.toFixed(4)})`, 'ok');
}

// ─── 클립 목록 렌더 ───
function renderClipList() {
  clipListEl.innerHTML = '';
  if (clips.length === 0) {
    clipListEl.innerHTML = '<li style="color:var(--muted)">FBX 파일을 열면 여기에 표시됩니다</li>';
    return;
  }
  for (const c of clips) {
    const li = document.createElement('li');
    li.dataset.name = c.name;
    li.innerHTML = `
      <span class="name">${c.name}</span>
      <span class="dur">${c.duration.toFixed(2)}s</span>
      <button data-act="play" title="재생">▶</button>
      <button data-act="remove" title="제거">✕</button>
    `;
    clipListEl.appendChild(li);
  }
}

// ─── 클립 재생 ───
function playClip(name) {
  if (!mixer) return;
  const entry = clips.find(c => c.name === name);
  if (!entry) return;

  if (currentAction) currentAction.fadeOut(0.15);
  currentAction = mixer.clipAction(entry.clip);
  currentAction.reset().fadeIn(0.15).play();

  // active 하이라이트
  clipListEl.querySelectorAll('li').forEach(li =>
    li.classList.toggle('active', li.dataset.name === name)
  );
}

function stopClip() {
  if (currentAction) {
    currentAction.fadeOut(0.15);
    currentAction = null;
  }
  clipListEl.querySelectorAll('li').forEach(li => li.classList.remove('active'));
}

// ─── GLB 내보내기 ───
async function exportGLB() {
  if (!baseGroup || clips.length === 0) {
    flash('내보낼 것이 없습니다');
    return;
  }

  // 키 스케일 적용
  applyScale();

  flash('GLB 생성 중…');
  log('⏳ GLB 내보내기 시작…');

  try {
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(baseGroup, {
      binary: true,
      animations: clips.map(c => c.clip),
    });

    const blob = new Blob([result], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hunter.glb';
    a.click();
    URL.revokeObjectURL(url);

    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
    log(`✅ 내보내기 완료: hunter.glb (${sizeMB} MB, 클립 ${clips.length}개)`, 'ok');
    flash(`hunter.glb 저장됨 (${sizeMB} MB)`);

  } catch (e) {
    log(`✗  내보내기 실패: ${e.message}`, 'err');
    console.error(e);
    flash('내보내기 실패');
  }
}

// ─── 유틸 ───
function disposeGroup(group) {
  group.traverse(o => {
    if (o.isMesh) {
      o.geometry?.dispose();
      if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
      else o.material?.dispose();
    }
  });
  if (group.parent) group.parent.remove(group);
}

// ─── UI 연결 ───
function setupUI() {
  $('pickGlb').addEventListener('change', e => {
    if (e.target.files[0]) handleGLBFile(e.target.files[0]);
  });

  $('pickFbx').addEventListener('change', e => {
    if (e.target.files.length) handleFBXFiles([...e.target.files]);
    e.target.value = '';   // 같은 파일 다시 선택 가능
  });

  clipListEl.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = btn.closest('li');
    const name = li?.dataset.name;
    if (!name) return;

    if (btn.dataset.act === 'play') {
      playClip(name);
    } else if (btn.dataset.act === 'remove') {
      clips = clips.filter(c => c.name !== name);
      log(`🗑  ${name} 제거`, 'warn');
      renderClipList();
      if (clips.length === 0) $('btnExport').disabled = true;
    }
  });

  $('btnExport').addEventListener('click', exportGLB);

  // 드래그 앤 드롭
  document.body.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.body.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.body.addEventListener('drop', async e => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const files = [...e.dataTransfer.files];
    const fbxs = files.filter(f => f.name.toLowerCase().endsWith('.fbx'));
    const glbs = files.filter(f => f.name.toLowerCase().endsWith('.glb') || f.name.toLowerCase().endsWith('.gltf'));
    if (glbs.length) handleGLBFile(glbs[0]);
    if (fbxs.length) handleFBXFiles(fbxs);
  });
}

// ─── 시작 ───
init();
setupUI();
log('캐릭터 빌더 준비 완료. FBX + GLB 파일을 끌어다 놓으세요.');
