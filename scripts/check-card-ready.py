#!/usr/bin/env python3
"""卡片就绪检查（ISS-589 试点手法的固化版，10 步清单的可机械化部分）
用法: python3 check_card_ready.py <pkg> [<pkg> ...]
判据（全绿 = 可进 bundles）：
  C1 声明 dsh.bundle.patch 且文件存在
  C2 license
  C3 files 精确清单，且每条都在盘上存在
  C4 exports 有 ./locale/*
  C5 locale/en.json + zh.json 的 meta.title/description 非空
  C6 peerDependencies 有 @deepseek-ai/dsh（门禁只读它）
  C7 cordis 在 peer 与 dev 两处同串（官方 B14）
  C8 自带 cordis.patch.yml 的 insert 行 name == 包名
  C9 dsh.client 声明齐全（有 client 半的包）
  C10 locale/ 里无占位标题（title != 包名）
"""
import json, os, re, sys

def check(pkg):
    res = []
    f = pkg + '/package.json'
    if not os.path.exists(f):
        return [('C0', False, '目录/清单不存在')]
    d = json.load(open(f))

    b = (d.get('dsh') or {}).get('bundle') or {}
    patch = b.get('patch')
    res.append(('C1', bool(patch) and os.path.exists(os.path.join(pkg, patch or '')),
                f"bundle.patch={patch}"))

    res.append(('C2', bool(d.get('license')), f"license={d.get('license')}"))

    files = d.get('files') or []
    missing = [x for x in files if '*' not in x and not os.path.exists(os.path.join(pkg, x))]
    res.append(('C3', bool(files) and not missing, f"{len(files)} 条" + (f"，缺失 {missing}" if missing else "")))

    ex = d.get('exports') or {}
    res.append(('C4', './locale/*' in ex, f"exports={list(ex.keys())}"))

    # C11: exports 路径合法性（2026-10-04 实测教训）
    #   Node 的 exports 语义要求**相对路径必须 './' 开头** ⇒ 缺前缀报
    #   `Invalid "exports" main target`，该包**整个 import 失败、静默不激活**（引擎只写一行 warning）。
    #   我批量从 main 字段搬值时写成 "lib/index.js"（缺 ./），弄坏了 forge-teammate-model 与 forge-archive。
    #   另一半：types 指向**不存在的文件**同样是坑（给纯 host 包编了 ./src/index.ts）。
    ex_problems = []
    for k, v in ex.items():
        if k == './locale/*':
            continue
        targets = []
        if isinstance(v, str):
            targets = [v]
        elif isinstance(v, dict):
            targets = [x for x in v.values() if isinstance(x, str)]
        for t in targets:
            if '*' in t or t.startswith('./locale'):
                continue
            if not t.startswith('./') and not t.startswith('../'):
                ex_problems.append(f"{k}→{t} 缺 './' 前缀")
            elif not os.path.exists(os.path.join(pkg, t)):
                ex_problems.append(f"{k}→{t} 文件不存在")
    res.append(('C11', not ex_problems, "；".join(ex_problems) if ex_problems else "路径合法"))

    lzh, len_ = pkg+'/locale/zh.json', pkg+'/locale/en.json'
    ok5, why5 = False, '缺文件'
    if os.path.exists(lzh) and os.path.exists(len_):
        try:
            z = json.load(open(lzh))['meta']; e = json.load(open(len_))['meta']
            ok5 = bool(z.get('title') and z.get('description') and e.get('title') and e.get('description'))
            why5 = f"zh={z.get('title')}"
        except Exception as ex2: why5 = f"JSON 错: {ex2}"
    res.append(('C5', ok5, why5))

    # 聚合卡（0 代码、无 src、不 import 官方件）不需要 peer —— 直接豁免 C6/C7
    is_aggregate2 = not os.path.isdir(pkg + '/src')
    peer = d.get('peerDependencies') or {}
    if is_aggregate2:
        res.append(('C6', True, '聚合卡免 peer'))
        res.append(('C7', True, '聚合卡免 peer'))
    else:
        res.append(('C6', any(k == '@deepseek-ai/dsh' or k.startswith('@deepseek-ai/dsh-') for k in peer),
                    f"peer={list(peer.keys())}"))
        dev = d.get('devDependencies') or {}
        cp, cd = peer.get('@deepseek-ai/cordis'), dev.get('@deepseek-ai/cordis')
        res.append(('C7', cp == cd if cp else False, f"peer={cp} dev={cd}"))

    pp = pkg + '/cordis.patch.yml'
    ok8, why8 = False, '无自带 patch'
    if os.path.exists(pp):
        t = open(pp, encoding='utf8').read()
        names = re.findall(r'^\s*name:\s*([a-z0-9@/-]+)', t, re.M)
        # 聚合卡（自身无 src、只声明别人）= 合法形态：forge-widgets 就是这种
        is_aggregate = not os.path.isdir(pkg + '/src')
        ok8 = (pkg in names) or (is_aggregate and len(names) > 0)
        why8 = f"insert names={names}" + ("（聚合卡）" if is_aggregate else "")
    res.append(('C8', ok8, why8))

    cl = (d.get('dsh') or {}).get('client')
    if cl:
        res.append(('C9', cl.get('platform') == 'web', f"platform={cl.get('platform')} inject={cl.get('inject')}"))

    ok10 = True
    if os.path.exists(lzh):
        t = json.load(open(lzh))['meta'].get('title')
        ok10 = t != pkg
    res.append(('C10', ok10, '标题非占位'))


    # C12: host 半 import 了 forge-* ⇒ 装载入口必须是**存在的自包含产物**（ISS-588 P2）
    #   为什么要它：这些跨包 import 在"卡自包含（build-host 内联）"形态下才安全；而判据实现
    #   （code-inventory.mjs:588）把 devDependencies 也算"已声明" ⇒ 光看声明看不出"有没有真的内联"。
    #   本判据把两者绑起来：host 边在 → 入口必须落在产物上（否则引擎 ERR_MODULE_NOT_FOUND）。
    host_forge = []
    libdir = os.path.join(pkg, 'lib')

    def _code_lines(t):
        # 与 scripts/build-host.mjs 的 codeLines() 同口径：去 `//` 注释、跳过块注释行。
        # 为什么 C12 必须复用：注释里会**写** import 例子（实测 `plans-usage.js` 的
        # `// … 经 import("forge-agents/plans-usage") 懒加载消费`），直接扫原文会把一张
        # 正确的卡判红（2026-10-04 二审 F3′ 已注入复现）。
        out = []
        for line in t.split('\n'):
            if line.lstrip().startswith('*'):
                continue
            k = line.find('//')
            out.append(line[:k] if k >= 0 else line)
        return '\n'.join(out)

    for root, _dirs, files in os.walk(libdir):
        for fn in files:
            if not fn.endswith(('.js', '.mjs', '.cjs')) or re.search(r'\.test\.[a-z]+$', fn):
                continue
            try:
                t = _code_lines(open(os.path.join(root, fn), encoding='utf8', errors='ignore').read())
            except Exception:
                continue
            for m in re.finditer(r'(?:from\s*|require\(\s*|import\(\s*|import\s+)["\'](forge-[a-z-]+)', t):
                if m.group(1) != pkg:       # 自引用不是跨包边（与 build-host.mjs 同口径）
                    host_forge.append(m.group(1))
    if host_forge:
        entry = ((d.get('exports') or {}).get('.') or {}).get('default') or d.get('main') or ''
        entry_ok = entry.startswith('./dist/') or entry.startswith('dist/')
        target = os.path.join(pkg, entry.lstrip('./'))
        res.append(('C12', entry_ok and os.path.exists(target),
                    f"host 半 import {sorted(set(host_forge))} ⇒ 入口须为存在的自包含产物，现为 {entry or '（无）'}"
                    + ('' if (entry_ok and os.path.exists(target)) else '（跑 build:host）')))

    # C13: 自有包名若在 npm 上被**第三方占用**，其内部声明不得用裸 semver（ISS-588 审查 F1）
    #   为什么：裸 `0.1.0` 在"名字被占 + 版本恰好存在"时会**静默装到别人的包**（实测 `forge-ui` 在 npm
    #   有 0.1.0）。故这类名一律用 `workspace:*`（仓内解析）或 `link:`/`file:`（显式本地）。
    #   名单与证据：2026-10-04 实测（registry.npmjs.org）—— forge-agents=1.0.1 · forge-browser=1.2.0 ·
    #   forge-design=1.0.14 · forge-ui=0.8.1（**且存在 0.1.0**）。名单变更须连同探测记录一起改。
    NPM_TAKEN = {'forge-agents', 'forge-browser', 'forge-design', 'forge-ui'}
    bare = []
    for sec in ('dependencies', 'devDependencies', 'peerDependencies'):
        for k, v in (d.get(sec) or {}).items():
            if k in NPM_TAKEN and not re.match(r'^(workspace|link|file|portal):', str(v)):
                bare.append(f'{sec}.{k}={v}')
    res.append(('C13', not bare, f"npm 侵占名不得用裸 semver" + (f"：{bare}" if bare else "（全部 workspace:*/link:）")))
    return res

def is_card_candidate(pkg):
    """是不是「卡片候选」= 插件包：声明了 dsh.client 或 dsh.bundle。
    库包（forge-db/design/shell/service-kit/agent-protocol 等）**不在射程** ——
    它们不挂装配、不进插件页，本脚本对它们一律不判（否则会误报几十项）。"""
    f = pkg + '/package.json'
    if not os.path.exists(f):
        return False
    try:
        dsh = json.load(open(f)).get('dsh') or {}
    except Exception:
        return False
    return bool(dsh.get('client') or dsh.get('bundle'))

if __name__ == '__main__':
    pkgs = sys.argv[1:]
    if not pkgs:
        all_p = sorted(os.path.dirname(p) for p in __import__('glob').glob('forge-*/package.json'))
        pkgs = [p for p in all_p if is_card_candidate(p)]
        skipped = [p for p in all_p if p not in pkgs]
        if skipped:
            print(f"（跳过 {len(skipped)} 个非卡片候选：库包/非插件）\n")
    allbad = 0
    for p in pkgs:
        r = check(p)
        bad = [x for x in r if not x[1]]
        allbad += len(bad)
        mark = '✓' if not bad else '✗'
        print(f"{mark} {p}")
        for cid, ok, why in r:
            if not ok: print(f"     ✗ {cid}: {why}")
    print(f"\n合计 {allbad} 项未过")
    sys.exit(1 if allbad else 0)
