# GLB -> FBX 변환 (Mixamo 업로드용).
#
# Mixamo 오토리거는 GLB 를 안 받는다. FBX / OBJ / ZIP 만 받는다.
#
# 쓰는 법 (Blender 를 창 없이 돌린다):
#   blender --background --python tools/glb_to_fbx.py -- <입력.glb> [출력.fbx] [키(m)]
#
# 키를 주면 그 높이에 맞춰 스케일한다. Pixal3D 출력은 단위 큐브에 정규화돼서
# 나오므로 (0.8m 쯤) 그대로 올리면 Mixamo 가 비율을 이상하게 잡는다.

import sys
import os
import bpy


def argv_after_dashes():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def main():
    args = argv_after_dashes()
    if not args:
        print('사용법: blender -b --python glb_to_fbx.py -- <입력.glb> [출력.fbx] [키(m)]')
        sys.exit(1)

    src = os.path.abspath(args[0])
    dst = os.path.abspath(args[1]) if len(args) > 1 else os.path.splitext(src)[0] + '.fbx'
    target_h = float(args[2]) if len(args) > 2 else 0.0

    clear_scene()
    bpy.ops.import_scene.gltf(filepath=src)

    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        print('메시를 찾지 못했습니다')
        sys.exit(1)

    # 전체 바운딩박스
    lo = [float('inf')] * 3
    hi = [float('-inf')] * 3
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ __import__('mathutils').Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    size = [hi[i] - lo[i] for i in range(3)]
    # Blender 는 Z 가 위다. glTF(Y-up) 를 가져오면 가져오기 단계에서 축이
    # 바뀌므로, 키는 Y 가 아니라 Z 에서 읽어야 한다.
    UP = 2
    print(f'원본 크기: X {size[0]:.3f} · Y {size[1]:.3f} · Z(키) {size[UP]:.3f} m')

    for o in bpy.context.scene.objects:
        o.select_set(True)

    if target_h > 0 and size[UP] > 1e-6:
        k = target_h / size[UP]
        print(f'스케일 {k:.4f} 배 -> 키 {target_h} m')
        bpy.ops.transform.resize(value=(k, k, k))
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        # 발바닥을 원점에 맞춘다 (게임이 바닥 기준으로 위치를 잡는다)
        bpy.ops.transform.translate(value=(0, 0, -lo[UP] * k))
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    bpy.ops.export_scene.fbx(
        filepath=dst,
        use_selection=False,
        # Mixamo 는 Y-up 을 기대한다
        axis_forward='-Z', axis_up='Y',
        apply_unit_scale=True, global_scale=1.0,
        path_mode='COPY', embed_textures=True,
        mesh_smooth_type='FACE',
        add_leaf_bones=False,
    )
    print(f'저장: {dst}')


main()
