#!/usr/bin/env python3
"""一包一行占用矩阵（P3 迁移前的必查项 · ISS-589 踩坑后固化）

为什么需要它：官方规则「一个包只能被一条活跃 Loader 行引用」（client/modules/src/index.ts:1031），
同包两行**引擎直接报错**。而"哪条行引用了它"有**三个来源**，只查一个必漏：
  ① 已进 bundles 的卡 —— 其 patch 可能带出**别的**包（forge-widgets 就带出了 mermaid+scrollbar）
  ② profile 手写 insert
  ③ 包自身的 bundle patch（若该包已进 bundles）

用法: python3 scripts/check-row-occupancy.py [profile_dir]
默认 dev: ~/.dsh-matter/profiles/web   prod: ~/.dsh/profiles/desktop
"""
import json, os, re, sys, glob

profile = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/.dsh-matter/profiles/web')
pkg_json = os.path.join(profile, 'package.json')
patch_yml = os.path.join(profile, 'cordis.patch.yml')

if not os.path.exists(pkg_json):
    print(f"✗ 读不到 {pkg_json} ⇒ 不判（别当没问题）"); sys.exit(2)

b = json.load(open(pkg_json))
bundles = b.get('dsh', {}).get('profile', {}).get('bundles', [])
own_bundles = [x for x in bundles if not x.startswith('@')]

# ① 各卡带出的包
card_rows = {}
for card in own_bundles:
    # 卡的实际位置：从 profile 的 dependencies 里取 link: 目标，否则按仓内相对路径找
    deps = b.get('dependencies') or {}
    spec = deps.get(card, '')
    if spec.startswith('link:'):
        pp = os.path.join(spec[len('link:'):], 'cordis.patch.yml')
    else:
        pp = os.path.abspath(os.path.join(os.path.dirname(profile), card, 'cordis.patch.yml'))
    if not os.path.exists(pp): continue
    card_rows[card] = re.findall(r'^\s*name:\s*([a-z0-9@/-]+)', open(pp, encoding='utf8').read(), re.M)

# ② profile 手写 insert（**按缩进精确判块** —— 2026-10-04 修：原先用"到下一个 - insert: 为止"
#    的粗判据，会把后续顶层条目（如 60+ 个模型 provider）全算成"同块兄弟"，导致风险被夸大成
#    forge-native "同块 35 个兄弟"（实测它其实是独立单行块）。insert 块的子项 = 缩进 > 0。）
hand = set()
insert_blocks = []  # (起始行, 结束行, [ids])
if os.path.exists(patch_yml):
    raw = open(patch_yml, encoding='utf8').read().split('\n')

    def _indent(l):
        return len(l) - len(l.lstrip()) if l.strip() else -1

    i = 0
    while i < len(raw):
        if raw[i].strip().startswith('#') or not re.match(r'^- insert:', raw[i]):
            i += 1
            continue
        base = _indent(raw[i]); j = i + 1
        while j < len(raw):
            ind = _indent(raw[j])
            if ind != -1 and not raw[j].strip().startswith('#') and ind <= base:
                break
            j += 1
        seg = '\n'.join(raw[i:j])
        ids = re.findall(r'^\s*-?\s*id:\s*([a-z0-9@/.-]+)\s*$', seg, re.M)
        insert_blocks.append((i + 1, j, ids))
        hand |= {x for x in ids if x.startswith('forge-')}
        i = j

occupied = set(own_bundles) | hand
for names in card_rows.values():
    occupied |= set(names)

all_pkgs = {os.path.dirname(p) for p in glob.glob('forge-*/package.json')}
free = sorted(all_pkgs - occupied)

print(f"profile: {profile}")
print(f"\n① 已进 bundles 的卡（{len(own_bundles)} 张）带出的行：")
for c, names in card_rows.items():
    print(f"     {c} → {names}")
print(f"\n② profile 手写 insert：{len(hand)} 个")
print(f"\n③ 已被占用的包（{len(occupied)}）：{sorted(occupied)}")
print(f"\n⇒ 可【纯新增】为卡（未被任何一方占用）：{free}")

# 重复检测
dup = []
for card, names in card_rows.items():
    for n in names:
        if n in hand:
            dup.append(f"{n}: 既在 {card} 的卡里，又在 profile 手写 insert 里")
        if n in own_bundles and n != card:
            dup.append(f"{n}: 既在 {card} 的卡里，又是独立一张卡")
for n in own_bundles:
    if n in hand:
        dup.append(f"{n}: 既是独立卡，又在 profile 手写 insert 里")
print(f"\n⚠️ 同包两行风险：{dup if dup else '无 ✓'}")

# ④ 解析锚点：bundle 必须在 **profile 自己的 node_modules** 里有软链。
#    实测教训（2026-10-04）：共享镜像 profiles/node_modules 里的软链**不算**，
#    引擎只在 profile 目录下解析；缺则报 "cannot resolve profile bundle" 并**静默跳过整张卡**。
own_nm = os.path.join(profile, 'node_modules')
unresolved = [x for x in own_bundles if not os.path.exists(os.path.join(own_nm, x))]
print(f"\n④ 解析锚点（{own_nm}）：")
for x in own_bundles:
    print(f"     {'✓' if os.path.exists(os.path.join(own_nm, x)) else '✗'} {x}")
if unresolved:
    print(f"\n⚠️ 会静默跳过的卡（解析不到）：{unresolved}")
    print(f"   ⇒ 修法： ln -sfn <仓内路径> {own_nm}/<包名>")
sys.exit(1 if (dup or unresolved) else 0)
