# Mixamo FBX 묶음 -> 게임용 GLB 하나.
#
#   blender -b --python tools/build_character.py -- <mixamo폴더> <원본.glb> <출력.glb> [키(m)]
#
# 하는 일:
#   1. 스킨이 있는 FBX 를 기준으로 삼는다 (메시 + 아마추어)
#   2. 나머지 FBX 에서 동작만 뽑아 게임에서 쓸 이름으로 바꿔 붙인다
#   3. 원본 GLB 의 머티리얼을 가져와 입힌다 (Mixamo 는 텍스처를 흘린다)
#   4. 루트 모션을 제거해 제자리 동작으로 만든다
#   5. 키를 맞추고 GLB 로 내보낸다
#
# 루트 모션: Mixamo 를 "In Place" 로 받지 않으면 이동 클립에 전진이 들어 있다.
# 서버가 위치를 정하는 구조라 그대로 두면 캐릭터가 제 위치에서 미끄러진다.
# 그래서 축마다 "한 방향으로 쭉 흐르는" 성분만 골라 고정한다 (점프의 위아래
# 움직임 같은 진동 성분은 남긴다).

import sys
import os
import glob
import bpy
import mathutils

# 파일 이름 -> 게임에서 쓸 클립 이름. 여기 없는 파일은 건너뛴다.
CLIP_MAP = {
    'mutant breathing idle': 'idle',
    'mutant idle': 'idle_long',
    'mutant walking': 'walk',
    'mutant run': 'run',
    'mutant punch': 'attack',
    'mutant swiping': 'attack2',
    'mutant jump attack': 'slam',
    'mutant jumping': 'jump',
    'mutant jumping (2)': 'jump_short',
    'mutant dying': 'death',
    'mutant roaring': 'rage',
    'mutant flexing muscles': 'taunt',
}

# 제자리로 만들 클립.
# 위치는 서버가 정하고 클라이언트가 그 자리에 캐릭터를 놓는다. 동작에까지
# 전진이 들어 있으면 이중으로 움직여서 미끄러져 보인다.
# death 만 예외 — 쓰러지면서 몸이 넘어가는 게 자연스럽다.
IN_PLACE = {
    'idle', 'idle_long', 'walk', 'run', 'attack', 'attack2', 'rage', 'taunt',
    'slam', 'jump', 'jump_short',
}


def args_after():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def strip_root_motion(action, keep_vertical=True):
    """한 방향으로 흐르는 성분만 고정한다. 진동(발걸음 들썩임)은 남긴다."""
    removed = []
    for fc in action.fcurves:
        if not fc.data_path.endswith('.location'):
            continue
        if 'Hips' not in fc.data_path:
            continue
        kps = fc.keyframe_points
        if len(kps) < 2:
            continue

        vals = [k.co[1] for k in kps]
        drift = abs(vals[-1] - vals[0])
        span = max(vals) - min(vals)
        # 흐름이 진동의 절반을 넘으면 이동 성분으로 본다
        if span < 1e-6 or drift < span * 0.5:
            continue
        # 세로축(보통 인덱스 2, Blender Z)은 점프 높이라 남길 수 있다
        if keep_vertical and fc.array_index == 2:
            continue

        base = vals[0]
        for k in kps:
            k.co[1] = base
            k.handle_left[1] = base
            k.handle_right[1] = base
        fc.update()
        removed.append(fc.array_index)
    return removed


def main():
    a = args_after()
    if len(a) < 3:
        print('사용법: ... -- <mixamo폴더> <원본.glb> <출력.glb> [키]')
        sys.exit(1)
    src_dir, orig_glb, out_glb = os.path.abspath(a[0]), os.path.abspath(a[1]), os.path.abspath(a[2])
    target_h = float(a[3]) if len(a) > 3 else 2.15

    files = sorted(glob.glob(os.path.join(src_dir, '**', '*.fbx'), recursive=True))

    # ── 1. 스킨이 있는 파일 찾기 ──
    base_file = None
    for f in files:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=f)
        has_mesh = any(o.type == 'MESH' for o in bpy.context.scene.objects)
        has_arm = any(o.type == 'ARMATURE' for o in bpy.context.scene.objects)
        if has_mesh and has_arm:
            base_file = f
            break
    if not base_file:
        print('스킨이 있는 FBX 를 찾지 못했습니다 (메시+아마추어)')
        sys.exit(1)
    print(f'@@ 기준 파일: {os.path.relpath(base_file, src_dir)}')

    # ── 2. 기준을 새로 불러오고 동작을 하나씩 얹는다 ──
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=base_file)
    arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
    mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH')

    # 기준 파일이 들고 온 빈 동작은 버린다
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)

    added = []
    for f in files:
        if f == base_file:
            continue
        stem = os.path.splitext(os.path.basename(f))[0].lower()
        name = CLIP_MAP.get(stem)
        if not name:
            print(f'@@ 건너뜀: {stem}')
            continue

        before = set(bpy.data.actions)
        bpy.ops.import_scene.fbx(filepath=f)
        new_acts = [x for x in bpy.data.actions if x not in before]
        if not new_acts:
            print(f'@@ 동작 없음: {stem}')
            continue

        act = new_acts[0]
        act.name = name
        act.use_fake_user = True          # 쓰는 데가 없어도 내보내기까지 살려둔다
        if name in IN_PLACE:
            axes = strip_root_motion(act)
            if axes:
                print(f'@@   {name}: 루트 모션 제거 (축 {axes})')

        # 방금 딸려 들어온 아마추어·메시는 치운다 (동작만 쓴다)
        for o in list(bpy.context.scene.objects):
            if o is arm or o is mesh:
                continue
            bpy.data.objects.remove(o, do_unlink=True)

        fs, fe = act.frame_range
        added.append((name, round((fe - fs) / 30.0, 2)))

    # ── 3. 원본 GLB 의 머티리얼을 가져다 입힌다 ──
    before_objs = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=orig_glb)
    src_mesh = next((o for o in bpy.context.scene.objects
                     if o not in before_objs and o.type == 'MESH'), None)
    if src_mesh and src_mesh.data.materials:
        mat = src_mesh.data.materials[0]
        mesh.data.materials.clear()
        mesh.data.materials.append(mat)
        print(f'@@ 머티리얼 이식: {mat.name}')
    for o in list(bpy.context.scene.objects):
        if o not in before_objs:
            bpy.data.objects.remove(o, do_unlink=True)

    # ── 4. 키 맞추기 (아마추어를 키우면 메시가 따라온다) ──
    bpy.context.view_layer.objects.active = arm
    lo = float('inf')
    hi = float('-inf')
    for c in mesh.bound_box:
        w = mesh.matrix_world @ mathutils.Vector(c)
        lo = min(lo, w[2])
        hi = max(hi, w[2])
    h = hi - lo
    if h > 1e-6:
        k = target_h / h
        # 덮어쓰면 안 된다. Mixamo FBX 는 센티미터라 임포터가 아마추어에
        # 0.01 스케일을 걸어두는데, 대입하면 그게 날아가 100배로 커진다.
        arm.scale = tuple(s * k for s in arm.scale)
        bpy.context.view_layer.update()
        print(f'@@ 키 {h:.3f} m -> {target_h} m  (배율 {k:.4f}, 최종 스케일 {arm.scale[0]:.5f})')

        # 정말 맞았는지 다시 재서 확인한다
        lo2 = float('inf')
        hi2 = float('-inf')
        for c in mesh.bound_box:
            w = mesh.matrix_world @ mathutils.Vector(c)
            lo2 = min(lo2, w[2])
            hi2 = max(hi2, w[2])
        print(f'@@ 검증: 최종 키 {hi2 - lo2:.3f} m')

    # ── 5. 내보내기 ──
    for o in bpy.context.scene.objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=out_glb,
        export_format='GLB',
        export_animations=True,
        export_animation_mode='ACTIONS',   # 동작 하나당 glTF 애니메이션 하나
        export_skins=True,
        export_yup=True,
        export_apply=False,                # 아마추어를 망가뜨리면 안 된다
        export_texture_dir='',
    )
    print(f'@@ 저장: {out_glb}')
    print(f'@@ 클립 {len(added)}개: ' + ', '.join(f'{n}({d}s)' for n, d in added))


main()
