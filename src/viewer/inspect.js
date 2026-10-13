import { Box3 } from 'three';

// 로드된 glTF 를 훑어서 "게임에 넣어도 되는 물건인가"를 판정한다.
//
// 폴리곤 수보다 드로우콜과 텍스처 메모리가 먼저 발목을 잡는다.
// ComfyUI 에서 갓 뽑은 메시는 보통 폴리곤 수십만 · 텍스처 4K 라서
// 여기서 빨간불을 보고 감축 단계로 돌려보내게 된다.

/** 게임 에셋 예산. 넘으면 경고를 띄운다. */
export const BUDGET = {
  character: { tris: 20000, drawCalls: 4, texPixels: 2048 * 2048 * 2 },
  prop: { tris: 3000, drawCalls: 2, texPixels: 1024 * 1024 * 2 },
};

const PBR_MAPS = [
  ['map', '베이스컬러'],
  ['normalMap', '노멀'],
  ['roughnessMap', '러프니스'],
  ['metalnessMap', '메탈릭'],
  ['aoMap', 'AO'],
  ['emissiveMap', '이미시브'],
];

export function inspect(gltf, fileBytes = 0) {
  const root = gltf.scene ?? gltf.scenes?.[0];

  let tris = 0;
  let verts = 0;
  let skinned = 0;
  const meshes = [];
  const materials = new Set();
  const textures = new Map();   // uuid -> texture (중복 제거)
  const bones = new Set();
  const compression = new Set();

  root?.traverse((o) => {
    if (o.isBone) bones.add(o);
    if (!o.isMesh && !o.isSkinnedMesh) return;

    const g = o.geometry;
    const idx = g.index ? g.index.count : g.attributes.position?.count ?? 0;
    tris += idx / 3;
    verts += g.attributes.position?.count ?? 0;
    if (o.isSkinnedMesh) skinned++;
    meshes.push(o);

    // 압축 흔적 추적
    if (g.attributes.position?.isInterleavedBufferAttribute) compression.add('meshopt');

    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      materials.add(m);
      for (const [key] of PBR_MAPS) {
        const t = m[key];
        if (t?.isTexture) {
          textures.set(t.uuid, t);
          if (t.mipmaps?.length && t.isCompressedTexture) compression.add('KTX2');
        }
      }
    }
  });

  // 드로우콜 ≈ (메시 × 그 메시의 머티리얼 수). 정확한 값은 아니지만
  // 실제 렌더 비용과 거의 비례한다.
  let drawCalls = 0;
  for (const m of meshes) drawCalls += Array.isArray(m.material) ? m.material.length : 1;

  let texPixels = 0;
  const texList = [];
  for (const t of textures.values()) {
    const w = t.image?.width ?? 0;
    const h = t.image?.height ?? 0;
    texPixels += w * h;
    texList.push({ name: t.name || '(이름없음)', w, h, compressed: !!t.isCompressedTexture });
  }

  // 바운딩 박스 — 스케일이 맞는지 보는 용도. 사람은 1.6~1.9m 여야 한다.
  const size = { x: 0, y: 0, z: 0 };
  if (root) {
    const b = new Box3().setFromObject(root);
    size.x = +(b.max.x - b.min.x).toFixed(3);
    size.y = +(b.max.y - b.min.y).toFixed(3);
    size.z = +(b.max.z - b.min.z).toFixed(3);
  }

  const animations = (gltf.animations ?? []).map((c) => ({
    name: c.name || '(이름없음)',
    duration: +c.duration.toFixed(2),
    tracks: c.tracks.length,
  }));

  return {
    tris: Math.round(tris),
    verts,
    drawCalls,
    meshCount: meshes.length,
    materialCount: materials.size,
    textureCount: textures.size,
    texPixels,
    texVramMB: +((texPixels * 4 * 1.33) / 1024 / 1024).toFixed(1), // RGBA + 밉맵 ≈ 1.33배
    textures: texList,
    animations,
    skinned,
    boneCount: bones.size,
    size,
    fileBytes,
    compression: [...compression],
    maps: pbrCoverage(materials),
  };
}

/** 어떤 PBR 맵이 실제로 들어있는지 — 베이크 단계를 건너뛴 게 있는지 본다. */
function pbrCoverage(materials) {
  const out = {};
  for (const [key, label] of PBR_MAPS) {
    out[label] = [...materials].some((m) => m[key]?.isTexture);
  }
  return out;
}

/** 예산 대비 판정. kind 는 'character' | 'prop'. */
export function verdict(stats, kind = 'character') {
  const b = BUDGET[kind] ?? BUDGET.character;
  const issues = [];

  if (stats.tris > b.tris) {
    issues.push({
      level: 'bad',
      text: `삼각형 ${fmt(stats.tris)}개 — 예산 ${fmt(b.tris)}개 초과. DecimateMesh 로 줄이고 노멀맵을 베이크하세요.`,
    });
  }
  if (stats.drawCalls > b.drawCalls) {
    issues.push({
      level: 'warn',
      text: `드로우콜 ${stats.drawCalls}회 — 머티리얼을 아틀라스로 합치면 줄어듭니다. (권장 ${b.drawCalls}회 이하)`,
    });
  }
  if (stats.texPixels > b.texPixels) {
    issues.push({
      level: 'warn',
      text: `텍스처 총 ${fmt(Math.round(stats.texPixels / 1e6))}MP (VRAM 약 ${stats.texVramMB}MB) — 해상도를 낮추거나 KTX2 로 압축하세요.`,
    });
  }
  if (!stats.compression.includes('KTX2') && stats.textureCount > 0) {
    issues.push({ level: 'info', text: '텍스처가 KTX2 로 압축되지 않았습니다. 배포 전에 압축하면 VRAM 이 크게 줄어듭니다.' });
  }
  if (kind === 'character' && stats.skinned === 0) {
    issues.push({ level: 'warn', text: '스킨드 메시가 없습니다 — 아직 리깅이 안 된 모델입니다.' });
  }
  if (kind === 'character' && (stats.size.y < 1.4 || stats.size.y > 2.2)) {
    issues.push({ level: 'warn', text: `키가 ${stats.size.y}m 입니다. 사람이라면 1.6~1.9m 가 맞습니다 — 스케일을 확인하세요.` });
  }
  if (!stats.maps['노멀']) {
    issues.push({ level: 'info', text: '노멀맵이 없습니다. BakeNormalMapFromMesh 로 고폴리 디테일을 구워넣으면 품질이 크게 올라갑니다.' });
  }

  if (!issues.length) issues.push({ level: 'good', text: '예산 안에 들어옵니다. 그대로 써도 됩니다.' });
  return issues;
}

export function fmt(n) {
  return n.toLocaleString('ko-KR');
}

export function fmtBytes(b) {
  if (!b) return '—';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}
