# 좀비 3D 에셋 — 프롬프트와 ComfyUI 설정

## 먼저: 모델은 **하나만** 만드세요

초록 → 빨강은 모델을 두 개 만들 일이 아닙니다. **초록 하나 만들고 광폭화 때
머티리얼 색만 바꿉니다.** 게임 쪽에서 1줄이면 되고, 전환도 부드럽게 됩니다.

그래서 텍스처를 뽑을 때 **조명과 채도를 눌러서** 만들어야 합니다.
초록 조명이 텍스처에 구워져 있으면 빨강으로 틴트할 때 흙탕물색이 됩니다.

---

## 필요한 것

| 항목 | 값 | 이유 |
|---|---|---|
| 키 | **2.15 m** | `shared/config.js` 의 `BASE.zombie.height` |
| 반경 | **0.46 m** | 충돌·히트박스와 같은 값 |
| 원점 | 발밑 중앙 | 위치가 바닥 기준 |
| 방향 | +Y 위, **−Z 앞** | glTF 규약 |
| 포즈 | **A-포즈** | 오토리깅이 요구 |
| 폴리곤 | 15~20k tris | 캐릭터 예산 |
| 텍스처 | 2K | 〃 |

### 애니메이션 (리깅 후)

| 클립 | 설명 |
|---|---|
| `idle` | 두 발, 구부정하게 서서 들썩임 |
| `run_quad` | **네 발로 질주** — 손이 땅에 닿는다 |
| `attack` | **두 발로 서서** 양손 번갈아 크게 훅 |
| `jump_charge` | 웅크리고 힘 모으기 (스페이스 꾹) |
| `jump_air` | 공중 자세 |
| `slam` | 착지 광범위 공격 |
| `death` | 쓰러짐 |

> 네 발 질주와 두 발 공격을 **한 휴머노이드 릭**으로 다 합니다. 윈스턴이
> 정확히 이 구조입니다. 별도 사족보행 릭이 필요 없습니다.
> Mixamo 에서 고릴라 계열 이동 클립을 쓰면 맞아떨어집니다.

---

## ComfyUI — 어떤 모델을 고르나

### 1단계 · 이미지 만들기 (텍스트 → 이미지)

```
Load Diffusion Model   →  qwen_image_2512_fp8_e4m3fn.safetensors
CLIP Loader            →  qwen_2.5_vl_7b_fp8_scaled.safetensors   (type: qwen_image)
VAE Loader             →  qwen_image_vae.safetensors
해상도                  →  1024 × 1536 (세로로 길게 — 전신이 들어가야 한다)
```

### 2단계 · 멀티뷰 만들기 (선택, 품질 크게 올라감)

```
Load Diffusion Model   →  qwen_image_edit_2511_int8_convrot.safetensors
LoRA                   →  Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16
CLIP / VAE             →  위와 동일
```
1단계 정면 이미지를 넣고 "turn to side view / back view" 로 3장 더 뽑습니다.

### 3단계 · 3D 생성

```
diffusion_models  →  pixal3d_int8_convrot.safetensors
vae               →  trellis_2_shape_vae_bf16 + trellis_2_texture_vae_bf16
clip_vision       →  dino_v3_L_naf_fp32.safetensors
geometry          →  moge_2_vitl_normal_fp16.safetensors
배경제거          →  birefnet.safetensors
```

### 4단계 · 게임용 정리 (전부 코어 노드)

```
FillHoles → WeldVertices → DecimateMesh(15~20k) → RemeshMesh
→ UnwrapMesh → BakeNormalMapFromMesh → BakeAmbientOcclusion → SaveGLB
```
`DecimateMesh` 전의 **고폴리 원본을 남겨두세요.** 노멀맵 베이크의 소스입니다.

---

## 프롬프트

### 공통 접미사 (끝에 붙이세요)

```
full body, head to toe fully inside frame, centered, plain flat neutral grey background,
even diffuse studio lighting, no cast shadows, no rim light, no colored light,
low saturation, no depth of field, sharp focus, flat orthographic-style front view,
stylized low-poly game character, bold readable silhouette
```

`no colored light` · `low saturation` 가 중요합니다. 빨강 틴트를 먹이려면
텍스처가 색에 치우쳐 있으면 안 됩니다.

### 네거티브

```
multiple characters, cropped, cut off, out of frame, text, watermark, logo,
dramatic lighting, hard shadows, strong ambient occlusion, colored rim light,
blurry, bokeh, busy background, weapon, props, arms touching torso, closed stance
```

### 본 프롬프트 — 좀비 (A-포즈)

```
A-pose zombie brute standing upright, arms extended straight out horizontally away
from the torso with a clear gap between each arm and the body, legs shoulder-width
apart and clearly separated, very long powerful arms reaching near the knees,
heavy broad shoulders, hunched thick neck, mottled grey-green decayed skin,
torn ragged trousers only, bare muscular torso with exposed ribs on one side,
sunken dark eye sockets, slack jaw, oversized knuckled hands,
tall and hulking 2.1 meter build
```

**왜 이렇게 쓰는지:**
- `arms extended ... clear gap` / `legs clearly separated` → 없으면 팔이 몸에
  붙어서 **오토리깅이 실패**합니다. 제일 중요한 부분입니다
- `very long powerful arms reaching near the knees` → 네 발 질주가 자연스러우려면
  팔이 길어야 합니다
- `oversized knuckled hands` → 1인칭에서 주먹이 크게 보여야 합니다
- `mottled grey-green` → 회녹색. 순수 초록보다 틴트가 잘 먹습니다
- `torn ragged trousers only` → 옷이 복잡하면 저폴리에서 뭉개집니다

### 멀티뷰용 (2단계 Edit 모델에 넣을 지시문)

```
측면  same character, exact same pose, rotated to a strict left side view
후면  same character, exact same pose, rotated to a straight back view
45°   same character, exact same pose, rotated 45 degrees to the right
```

---

## 뽑고 나서

`http://localhost:5173/inspect.html` 에 GLB 를 끌어다 놓으면 폴리곤 · 드로우콜 ·
텍스처 VRAM · **키(2.15m 여야 함)** · 스켈레톤 · 애니메이션 클립을 검사합니다.
캐릭터 예산으로 놓고 빨간불이 없으면 넣으면 됩니다.
