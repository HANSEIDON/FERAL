// glTF 로딩 파이프라인.
//
// Draco(지오메트리) · KTX2/Basis(텍스처) · meshopt 세 가지 압축을 전부 물려둔다.
// 압축을 안 쓴 GLB 도 그대로 로드되므로, ComfyUI 에서 갓 뽑은 원본이든
// 최적화를 끝낸 배포본이든 같은 코드로 읽힌다.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// 나중에 에셋만 CDN / GitHub Pages 로 옮길 때 이 값만 바꾸면 된다.
// (.env 의 VITE_ASSET_BASE 로 덮어쓸 수 있다)
export const ASSET_BASE = import.meta.env.VITE_ASSET_BASE ?? './';

let loader = null;
const cache = new Map();

/**
 * 로더를 초기화한다. KTX2 는 GPU 가 어떤 텍스처 압축 포맷을 지원하는지
 * 알아야 해서 renderer 가 필요하다 — 렌더러를 만든 뒤에 한 번 호출한다.
 */
export function initLoaders(renderer) {
  if (loader) return loader;

  // three 0.186 부터 두 로더가 `new URL(..., import.meta.url)` 로 디코더 기본
  // 경로를 들고 있다. Vite 가 이걸 해석해서 해시 붙은 에셋으로 뽑아주므로
  // 디코더를 따로 복사하거나 setDecoderPath() 를 부를 필요가 없다.
  // (CDN 으로 빼고 싶을 때만 setDecoderPath / setTranscoderPath 를 쓴다)
  const draco = new DRACOLoader();
  draco.setDecoderConfig({ type: 'wasm' });   // JS 폴백보다 몇 배 빠르다

  const ktx2 = new KTX2Loader().detectSupport(renderer);

  loader = new GLTFLoader()
    .setDRACOLoader(draco)
    .setKTX2Loader(ktx2)
    .setMeshoptDecoder(MeshoptDecoder);

  return loader;
}

/**
 * GLB/glTF 를 불러온다. 같은 URL 은 한 번만 네트워크를 탄다.
 * @returns {Promise<import('three/addons/loaders/GLTFLoader.js').GLTF>}
 */
export function loadModel(url, onProgress) {
  if (!loader) throw new Error('initLoaders(renderer) 를 먼저 호출하세요.');
  if (cache.has(url)) return cache.get(url);

  const p = loader.loadAsync(url, onProgress).catch((err) => {
    cache.delete(url);              // 실패한 건 캐시에 남기지 않는다
    throw err;
  });
  cache.set(url, p);
  return p;
}

/** ArrayBuffer 를 직접 파싱한다 (드래그&드롭으로 받은 파일용). */
export function parseModel(arrayBuffer, path = '') {
  if (!loader) throw new Error('initLoaders(renderer) 를 먼저 호출하세요.');
  return new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, path, resolve, reject);
  });
}

export function clearCache() {
  cache.clear();
}
