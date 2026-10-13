# Mixamo 에서 받은 FBX 들을 훑어서 무엇이 들었는지 찍는다.
#
#   blender -b --python tools/inspect_fbx.py -- <폴더>
#
# 스킨(메시+아마추어)이 있는 파일이 기준이 되고, 나머지는 동작만 가져온다.

import sys
import os
import glob
import bpy


def args_after():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def inspect(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        bpy.ops.import_scene.fbx(filepath=path)
    except Exception as e:                      # noqa: BLE001 - 어떤 파일이든 넘어가야 한다
        return {'error': str(e)[:60]}

    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    bones = len(arms[0].data.bones) if arms else 0

    clips = []
    for a in bpy.data.actions:
        fs, fe = a.frame_range
        clips.append((a.name, round((fe - fs) / 30.0, 2)))

    return {
        'meshes': len(meshes), 'tris': tris,
        'bones': bones, 'clips': clips,
    }


def main():
    a = args_after()
    root = a[0] if a else '.'
    files = sorted(glob.glob(os.path.join(root, '**', '*.fbx'), recursive=True))
    print(f'\n@@@ {len(files)} 개 파일\n')
    for f in files:
        r = inspect(f)
        rel = os.path.relpath(f, root)
        if 'error' in r:
            print(f'@@@ {rel} | 오류 {r["error"]}')
            continue
        names = ', '.join(n for n, _ in r['clips']) or '없음'
        dur = sum(d for _, d in r['clips'])
        print(f'@@@ {rel} | 메시 {r["meshes"]} · {r["tris"]} tris | 본 {r["bones"]} '
              f'| 클립 {len(r["clips"])} ({dur:.1f}s) : {names}')


main()
