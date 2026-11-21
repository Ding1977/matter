#!/usr/bin/env bash
# 工作区隔离与租约（ISS-326）
#
# 解决的事故形态：多个会话/agent 在同一个 checkout 上并发改代码 —— 谁执行一次
# `git checkout <branch>`，别人的未提交改动就从工作区消失（2026-09-10 实测踩中）。
#
# 三层防线：
#   ① 隔离 —— 开发在独立 worktree（`new`），主 checkout 只跑服务与收口合并
#   ② 声明 —— 租约锁（`claim`/`release`），同一时刻一个 owner 改一块地
#   ③ 检测 —— 基线（`baseline save`/`check`），漂移立刻可见，不用等文件没了才发现
#
# 用法：
#   ws.sh status                      当前工作区状态（分支/脏否/锁/基线）
#   ws.sh allocate <ISS-NNN> [--from <ref>]
#                                     **建工单树的唯一入口**（ISS-872）：建树 + 登记 .agents/trees.json
#                                     + 回写单据 worktree 字段。五步任一步失败回滚占位。
#                                     落点随形态：会话树 ⇒ <会话树>/.agents/worktrees/<ISS>（二级）
#                                                 主检出 ⇒ $WT_ROOT/<ISS>（一级，保持现行为）
#                                     base 默认 HEAD（= 会话树当前提交），⛔ 不从 main 建
#                                     并发安全：两个进程同时 allocate 同一单，只有一个建成（登记表 CAS
#                                     + mkdir 占位）；另一个拿到归属退出码 3
#                                     不准备依赖与产物（那是 ISS-871 的账）⇒ 进树后跑 ws.sh deps
#   ws.sh new <ISS-NNN> [--in-repo]   旧入口（deprecated，⛔ 不删）：从 main 建平级树、不写登记表。
#                                     存量 52 棵树与既有脚本仍依赖它；建工单树请改用 allocate
#   ws.sh adopt <ISS-NNN>             认领盘上已有的树（官方 create_worktree 建的，只建不补）：
#                                     校验「已注册 · 分支=单号 · 两级准入」后补依赖镜像 + 构建产物，
#                                     并把该树补登记进 .agents/trees.json（ISS-872：消掉「已认领但未登记」）
#                                     （ISS-870：原「非套娃」改成恰好两级 —— 工单树建在会话树下是
#                                     合规形态，三级及以上才拒；准入依据 .agents/trees.json）
#   ws.sh link <ISS-NNN|main> [pkg..] [--all]
#                                     把插件 symlink 指向该工作树（验证用；⚠️ ISS-558：别为此重启 3210，
#                                     验证走隔离实例 `dev-instance.sh start`，见 cmd_link 末尾提示）
#                                     可只切指定包；缺 dist 的插件会自动跳过（否则白屏）
#                                     ISS-416：`link main` 不带包名时，**跳过指向他人在途租约工作树的包**
#                                     （并发会话互相踩踏的真实事故）；确要强切加 `--all`
#   ws.sh claim <ISS-NNN> [--force]   声明占用（租约 2h 自动过期）。owner 取 ${WS_OWNER}，
#                                     没导出就记「未署名」并被 status 点名 —— 请按 <品牌:单号> 传
#   ws.sh release [ISS-NNN] [--force] 释放租约：只许放自己的（当前目录分支名可推单号），
#                                     动别人的必须 --force；锁读不出时一律拒写（不替你猜）
#   ws.sh baseline save [label]       记录基线
#   ws.sh baseline check [label]      比对基线（漂移退出码 2）
#   ws.sh guard [--fast]              守卫：停 main + 无他人暂存 + 锁读得出（违规退出码 2）；
#                                     软到期/疑似没收尾只出声，不判红（判红会误伤正在干的人）。
#                                     --fast 快档：跳过守卫自检与只报不红档（能判红的格不少），
#                                     日常收工用；合并前跑全量档（不带 --fast）
#   ws.sh doctor                      体检：插件 symlink 悬空 / 被切到工作树 / 3210 是否在听（悬空退出码 2）
#   ws.sh doctor --artifacts          额外打印各包 client 产物新鲜度（人判：构建通常早于提交，不自动判定）
#   可覆盖的环境变量：WS_STATE_DIR（状态目录）· WS_PROFILES_NM（插件挂载家，默认跟随 DSH_HOME）
#                     WS_LOCK_TTL_MIN（租约分钟）· WS_OWNER（署名）· DSH_FORGE_REPO
#   ws.sh rm <ISS-NNN> [--force]      删工作树收口：**只回收指向本工作树的链接**（ISS-416，不再全量切 main）
#                                     → 删工作树 → 删登记行 → 删分支 → 释放本单租约（ISS-873：删树成功后
#                                     同步删 .agents/trees.json 的登记行，树删失败则行不动；树已不在盘上
#                                     但登记行仍在 ⇒ 报出，确认清理加 --force）
#   ws.sh list                        列出工作树

set -euo pipefail

# ── ISS-525：清掉外部注入的 NODE_OPTIONS ─────────────────────────────────────────
# 为什么要在这里做：VS Code 扩展（如腾讯 Coding Copilot）会往**终端环境**注入
# `NODE_OPTIONS=--require=.../node-language-shim.cjs`。扩展升级/卸载后那个文件就没了，
# 于是**任何 `node` 调用直接启动失败**（MODULE_NOT_FOUND in preload）。
# 本脚本大量用 `node -e` 读 package.json / 解析 JSON —— 一旦 node 起不来：
#   `ws_names_of()` 返回空 → 镜像"发现 0 个包" → 工作树依赖残缺，而提示还是「✓ 就绪」（假绿）。
# 外部环境不该能让工具静默产出坏结果，故在此一刀切断。
unset NODE_OPTIONS

REPO="${DSH_FORGE_REPO:-<repo>}"
WT_ROOT="${DSH_FORGE_WT_ROOT:-<wt>}"
# ISS-554：原来这里**写死** `$HOME/.dsh` ⇒ 给 Matter 独立服务（3210 · DSH_HOME=~/.dsh-matter）
#   换插件时"命令报 ✓ 但什么都没发生"（实测：换完重启 3210，新路由仍 404）。
#   现在跟随 `${DSH_HOME}`，并留 `WS_PROFILES_NM` 显式覆盖（自测跑在临时家上，同 WS_STATE_DIR 的理由）。
PROFILES_NM="${WS_PROFILES_NM:-${DSH_HOME:-$HOME/.dsh}/profiles/node_modules}"
# ISS-552 W-3：治理件看的「家」。
#   实测（2026-10-01 06:12）：跑着的 3210 服务 `DSH_HOME=<home>/.dsh-matter`，
#   而本脚本读 `$HOME/.dsh/workspace-lock.json` ⇒ **护栏看的那份 ≠ 服务用的那份**（演练假绿）。
#   本批**不改写入位置**：正在用旧脚本的会话会和新会话各写一家，等于把互踩放大一倍。
#   做两件不增加风险的事：
#     ① 状态目录可用 `WS_STATE_DIR` 显式覆盖 ⇒ 归属校验能被自测跑在临时家上（`scripts/ws-lease-selftest.sh`）；
#     ② 两个家不一致时**出声**（`home_split_note`）——把"看不见的分家"变成"看得见、等窗口切"。
STATE_DIR="${WS_STATE_DIR:-$HOME/.dsh}"
LOCK_FILE="$STATE_DIR/workspace-lock.json"
BASE_FILE="$STATE_DIR/workspace-baseline.json"
LOCK_TTL_MIN="${WS_LOCK_TTL_MIN:-120}"

c_ok()   { printf "\033[32m✓\033[0m %s\n" "$*"; }
c_warn() { printf "\033[33m!\033[0m %s\n" "$*"; }
c_err()  { printf "\033[31m✗\033[0m %s\n" "$*"; }

# 建/换符号链接（ISS-334）。本机**不能直接用 `ln -sfn`**：
#   实测（macOS + TCC 保护目录）：`ln -sfn` 的原子替换靠「先在目标目录建临时名再 rename」，
#   建临时文件那步报 `Operation not permitted` —— **即使目标压根不存在也会失败**（两次实测踩中：
#   cmd_new 的依赖共享、cmd_link 的插件切换）。故统一改为「先 rm -f 再 ln -s」。
#   `rm -f` 只删符号链接本身（不跟随、不动目标内容），对不存在的路径也无副作用。
# ISS-416 加固：删除失败**不许静默**。旧写法 `rm -f "$dst" ... || true` 会掩盖权限/沙箱拒绝，
# 随后 `ln -s` 面对「旧链接仍在」的目标目录会把新链接**写进目标目录内部**
# （实测：agent 会话跑在 workspace-write 沙箱、无权写 ~/.dsh 时，`link main` 在仓库里
#   留下 6 个杂散链接 forge-*/forge-*/，且不报错、不回滚）。故：rm 失败 → 报错；
# 旧链接仍在 → 拒绝写入；建完 → readlink 校验，不符即报错。
# 这个包**需不需要** dist？只有带 client 产物的包才需要（client bundle 是构建物、不入库，
# 切过去没构建就是白屏 —— 这正是 ISS-334 那条防护的来由）。纯 host 插件（只有 lib/index.js 那一类）
# 根本没有 client 可建，用同一条「缺 dist 就跳过」会把它们**静默留在主检出**上：
# 现算实测 forge-agents / forge-messenger / forge-teammate-model 三个都中招（见 scripts/plugin-load-scout.mjs）。
has_client() {
  ls "$1"src/dsh/client-entry.* >/dev/null 2>&1 && return 0
  grep -q '"build:client"' "$1"package.json 2>/dev/null && return 0
  return 1
}

# ── ISS-584：新工作树缺构建产物 ⇒ 三条与改动无关的假红 ─────────────────────────
# 症状（2026-10-07 实测，全新树）：`bun test` 出 3 条 fail ——
#   ① 死链扫描 ×2：`Cannot find package 'forge-agents'`（各包 dist/host.js 是构建物、不入库）
#   ② Tw 寄存器闭合：`forge-tailwind/dist/tailwind.css` 不存在（判据 fail-closed，不静默判绿）
#   补建两份产物后当场 1107 pass / 0 fail ⇒ 是环境假红，不是回归。
# 为什么必须自动补：`ws.sh` 全程没有任何构建调用（只有两句"请手动 build"的提示），
#   而 CI 的 build:client 只覆盖**声明了该脚本的包**（.github/workflows/ci.yml:59）
#   ⇒ `forge-agents`（只有 build:host）连 CI 都不建，任何树都缺；
#     `forge-tailwind`（有 build:client）在 CI 建、在本地新树仍缺（因为新树没人建）。
# 判据用现成事实，不新造：① 包目录里有 dist 缺失；② 该包声明了对应 build 脚本。
# 只补"声明了脚本却没有产物"的包 —— 没有脚本的包本来就不该有 dist（如纯 lib 插件），补它等于造假。
# ── ISS-871：二级形态按形态跳过根级旧树包补建 ──────────────────────────────────
# $2 = --session-tree 表示本树的 $REPO 是会话树（二级形态）。会话树只跑 packages/ 新树，
#   根级 forge-* 旧树包在那里从未构建、也不参与该形态门禁 ⇒ 逐包补建必然全失败
#   （实测现场：22 条 ✗ + 汇总 + `✓ 已认领` + EXIT=0 = 失败淹在成功里）。
# 按 ISS-871 甲档：这里**按形态跳过**，且「跳过必须比通过刺眼」—— 多行 c_warn 把
#   「没建」和「建了」在屏幕上彻底分开；不是静默跳过（⛔ 单内禁令），也不是把失败降级成提示。
# 一级形态不传这个参数 ⇒ 下面逐包补建逻辑逐字不变（真包照建）。
ensure_worktree_artifacts() {
  local wt="$1" p n built=0 failed=0 bun_bin
  [ -d "$wt" ] || return 0
  local session_tree=0
  [ "${2:-}" = "--session-tree" ] && session_tree=1
  if [ "$session_tree" = "1" ]; then
    local old_cnt
    old_cnt="$(ws_names_of "$wt" | wc -l | tr -d ' ')"
    echo
    c_warn "⚠ 跳过旧树包产物补建（二级形态）：${old_cnt:-0} 个根级 forge-* 包不建"
    c_warn "  · 本树外层是会话树 —— 会话树只跑 packages/ 新树；这些旧树包从未在会话树构建，也不参与该形态门禁"
    c_warn "  · 这是**按形态跳过**，不是构建失败，也不是静默忽略；本树 bun test 不会因它们多出假红"
    c_warn "  · 需要旧树包产物请到主检出跑 bun run build:*；一级树（从主检出建）仍照常补建真包"
    return 0
  fi
  # 先解析 bun：找不到就**当场报红并返回非 0**，不逐包失败 28 次刷屏
  # （第一版没有这一步 ⇒ 28 个包全失败、日志各一行 `bun: command not found`，
  #   而外层 `|| c_warn` 把失败收成提示 = 「没建」被读成「建了」）。
  bun_bin="$(resolve_bun || true)"
  if [ -z "$bun_bin" ]; then
    c_err "找不到 bun（PATH 里没有，~/.bun/bin、/opt/homebrew/bin、/usr/local/bin 也没有）"
    c_err "  → 产物补建**全部跳过**；该树的 bun test 会有假红，别当回归。补法：装上 bun 或 export PATH"
    return 1
  fi
  # ⚠️ 只把 bun 的**绝对路径**传下去还不够（第一版就这么写，27 个包仍失败）：
  #   `package.json` 的脚本体本身就是 `bun scripts/build-client.mjs` —— **脚本内部还会再调一次 bun**，
  #   那次走 PATH。宿主/agent 的 PATH 实测不含 `~/.bun/bin` ⇒ 子 shell 报 `bun: command not found`
  #   （exit 127）。这与 `forge-pm/lib/auto-merge-run.js:41` 记录的坑一字不差：
  #   「只解析顶层命令不够，**子 shell 也要能看见 bun**」。
  #   解法同它：把 bun 所在目录**追加**进 PATH（追加而非前置 —— 不遮蔽用户同名工具）。
  local _bun_dir; _bun_dir="$(dirname "$bun_bin")"
  export PATH="${PATH}:${_bun_dir}"
  for n in $(ws_names_of "$wt"); do
    p="$wt/$n"
    [ -d "$p" ] || continue
    # host 半：声明 build:host 且 dist/host.js 缺失
    if grep -q '"build:host"' "$p/package.json" 2>/dev/null && [ ! -f "$p/dist/host.js" ]; then
      if (cd "$p" && "$bun_bin" run build:host >/tmp/ws-artifacts-$n.log 2>&1); then
        c_ok "补建 host 产物：$n/dist/host.js"
        built=$((built + 1))
      else
        c_err "host 产物构建失败：${n}（详情 /tmp/ws-artifacts-${n}.log）—— 该包的守卫会假红"
        failed=$((failed + 1))
      fi
    fi
    # client 半：声明 build:client 且 dist/client.js 缺失
    if grep -q '"build:client"' "$p/package.json" 2>/dev/null && [ ! -f "$p/dist/client.js" ]; then
      if (cd "$p" && "$bun_bin" run build:client >/tmp/ws-artifacts-$n.log 2>&1); then
        c_ok "补建 client 产物：$n/dist/"
        built=$((built + 1))
      else
        c_err "client 产物构建失败：${n}（详情 /tmp/ws-artifacts-${n}.log）—— 该包的守卫会假红"
        failed=$((failed + 1))
      fi
    fi
  done
  [ "$built" = "0" ] && [ "$failed" = "0" ] && echo "   产物齐备（无缺失，不需要补建）"
  if [ "$failed" != "0" ]; then
    c_err "有 $failed 个包补建失败 —— 跑 bun test 前先看上面日志，别把假红当回归"
    return 1
  fi
  return 0
}

link_symlink() {
  local src="$1" dst="$2"
  # ISS-653（K9c）：原先这里 `rm -f "$dst" 2>/dev/null` —— 下一行的报错文案只能写「权限/沙箱？」，
  #   因为 stderr 已被丢进 /dev/null，**失败原因看不见**。这与本文件头部 ISS-416 那条「删除失败不许静默」
  #   自相矛盾（静默的是 OS 给出的理由，而这正是排障唯一线索）。`rm -f` 对不存在的目标不报错，
  #   故去掉重定向不会引入噪声，只在真失败时把系统原文留在终端上。
  if ! rm -f "$dst"; then
    c_err "无法删除旧链接（原因见上一行 rm 的报错）：$dst"
    return 1
  fi
  if [ -L "$dst" ] || [ -e "$dst" ]; then
    c_err "旧链接仍在（rm 未生效），拒绝写入——否则 ln 会把它写进目标目录内部：$dst"
    return 1
  fi
  if ! ln -s "$src" "$dst" 2>/dev/null; then
    c_err "建链接失败：$src -> $dst"
    return 1
  fi
  local got
  got="$(readlink "$dst" 2>/dev/null || true)"
  if [ "$got" != "$src" ]; then
    c_err "链接校验失败：${dst} -> ${got:-<空>}（期望 ${src}）"
    return 1
  fi
}

# ── ISS-416：链接归属与租约护栏 ──────────────────────────────────────────────

# 某个插件链接当前指向（无链接 / 悬空都返回空）
link_target_of() {
  local name="$1"
  [ -L "$PROFILES_NM/$name" ] || return 0
  readlink "$PROFILES_NM/$name" 2>/dev/null || true
}

# 链接指向的工作树属于哪一单（.../wt/dsh-forge/ISS-413/<包名> → ISS-413；非工作树 → 空）
# ── ISS-510：工作树依赖镜像 ─────────────────────────────────────────────────────
# 为什么不能把 node_modules 整目录软链回主 checkout：
#   ① 包级 node_modules 里有 **workspace 链接**（`forge-shell -> ../../forge-shell`）——
#      整目录软链后这些链接**按主 checkout 解析**，工作树里 import workspace 包实际加载
#      主 checkout 的副本 → **改了 forge-shell 也验不出来（假绿）**，比跑不起来更危险；
#   ② 工作树里**新建的包**在主 checkout 根本不存在 → 依赖链接缺失，`tsc: not found` /
#      `Cannot find package 'react'`（bun 不 hoist，依赖装在**包级** node_modules）。
# 镜像 = 真实目录 + 逐条目软链：第三方条目仍指向主 checkout（零拷贝、版本一致），
# workspace 包条目指向**本工作树**的副本。代价只有一层 symlink。
# 读某个目录的 package.json workspaces（**按目录读，不吃缓存**：工作树里可能有主 checkout
# 还不存在的新包 —— 用主 checkout 的清单会让新包永远不被处理，ISS-510 实测踩中）
ws_names_of() {
  /usr/local/bin/node -e '
    const fs=require("fs");
    try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      for(const w of (j.workspaces||[])) console.log(String(w).replace(/\/$/,""));}catch{}' "$1/package.json" 2>/dev/null || true
}
ws_names() { ws_names_of "$REPO"; }

# 该条目是否是"指向仓库内某个 workspace 包"的软链（$1=条目路径 $2=条目名）
is_ws_link() {
  [ -L "$1" ] || return 1
  local rp ep
  rp="$(cd "$(dirname "$1")" && cd "$(readlink "$1")" 2>/dev/null && pwd -P)" || return 1
  # ️ 两侧都要 pwd -P 归一：macOS 的 mktemp 给的是 /var/...，而 pwd -P 解析成 /private/var/...
  #    —— 只归一一边会让"是 workspace 链接"被判成 false（实测：假绿修复静默失效）。
  ep="$(cd "$REPO/$2" 2>/dev/null && pwd -P)" || return 1
  [ "$rp" = "$ep" ]
}

# 路径的**词法**归一（不跟随软链）：折叠重复斜杠、`.` 与 `..`。$1=要归一的路径 $2=相对基准
# 为什么不 `cd`/`pwd -P`：本函数的消费者是**自指软链**判定，而那类路径 `cd` 进去必然
#   ELOOP —— 跟随解析在两处都行不通，只能做纯文本归一。返回恒为绝对路径。
# 只服务 is_self_nm_link（私有能力，不对外）：改用参数展开逐段切，避免 `set -f`/IFS 的全局副作用。
norm_path() {
  local p="$1" rest part out=""
  case "$p" in /*) ;; *) p="$2/$p" ;; esac
  rest="${p#/}"
  while [ -n "$rest" ]; do
    case "$rest" in
      */*) part="${rest%%/*}"; rest="${rest#*/}" ;;
      *)   part="$rest"; rest="" ;;
    esac
    case "$part" in
      ''|.) ;;
      ..) if [ -n "$out" ]; then out="${out%/*}"; fi ;;   # 折到根就停在根
      *)  out="$out/$part" ;;
    esac
  done
  printf '%s\n' "${out:-/}"
}

# 该条目是否是**自指软链**（解析后又回到自己 / 自己所在的目录）——ISS-851
# 判据是「自指」不是「名字叫 node_modules」：真目录、指向别处的链一律返回 1（照旧镜像）。
# 两种退化形态都算自指：① 目标 == 条目本身（真自环，任何读它的 resolver 都 ELOOP）；
#   ② 目标 == 条目所在目录（`node_modules -> .`，等于把外层目录挂进自己名下）。
# 「两边同一空间归一后再比」是必须的：软链目标可能是绝对路径、相对路径、带 `..`，
#   也可能是 `$PWD` 写法（macOS 的 mktemp 给 `/var/…`，物理路径是 `/private/var/…`）。
#   故逻辑路径与物理路径**各比一次**，任一侧相等即算自指 —— 只归一一边会假阴性（同 ISS-695 的坑）。
is_self_nm_link() {
  local p="$1" tgt dir n want
  [ -L "$p" ] || return 1
  tgt="$(readlink "$p" 2>/dev/null || true)"
  [ -n "$tgt" ] || return 1
  n="$(basename "$p")"
  for dir in "$(cd "$(dirname "$p")" 2>/dev/null && pwd -L)" "$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)"; do
    [ -n "$dir" ] || continue
    want="$(norm_path "$tgt" "$dir")"
    if [ "$want" = "$(norm_path "$n" "$dir")" ]; then return 0; fi
    if [ "$want" = "$(norm_path "." "$dir")" ]; then return 0; fi
  done
  return 1
}

# 准备一个 node_modules 目标位：**若是软链只删链接本身**（`rm -f`，不递归 ——
# ① 递归删会触发沙箱的批量删除守卫（实测 647 条目被拦，而 `|| true` 会把它静默吞掉）；
# ② 若先 `rm -rf` 一个指向主 checkout 的链接失效，后续镜像会**写进主 checkout**（写穿事故）。
# 真目录保留即可：镜像是幂等的，workspace 链接由 fix_ws_links 校正。
# ISS-586：建不出来**必须出声并返回非 0** —— 原来失败只留一句 mkdir 原文，交给 `set -e`
#   静默中止；而"目标位建不出来"正是本单「树里没有 node_modules 却报就绪」的形态之一。
reset_nm_dir() {
  [ -L "$1" ] && rm -f "$1"
  mkdir -p "$1" || { c_err "无法建立目录：$1（同名文件占位／权限？原因见上一行）"; return 1; }
}

# ── ISS-504：`.bin` 必须镜像成**工作树内的真目录**，不能是整目录软链 ─────────────
# 原形态（本函数上一版）：
#   [ -e "$dst/.bin" ] || ln -sfn "$e" "$dst/.bin"      # e = $REPO/node_modules/.bin
# 后果不是"少个便利"，是**主 checkout 被写脏**：
#   `bun add X` 在工作树里会往 `node_modules/.bin/` 写条目，而该目录此时是软链
#   ⇒ 写入穿到**主 checkout 的 .bin**。bun 生成的链接是相对解析的，于是主检出里留下
#   「目标只在工作树存在」的**悬空软链**：不报错、不挡 merge、只在调用那一刻失败
#   （症状是「某个工具在主检出莫名 not found」），极难归因。
#   实测受害树：`.wt/ISS-714`、`.wt/ISS-503-vitest` —— 两棵都是 `.bin → 主检出 .bin`。
# 修法：真目录 + 逐条目软链。解析行为与整目录镜像等价（第三方 bin 仍指向主检出，零拷贝），
#   但**写入落在本树** —— 工作树里 `bun add` 只会让本树多一个 bin，主检出一个字节不动。
# 幂等：老形态（软链）就地迁移成真目录；已存在的条目一律保留（`bun add` 写进来的那才是本树真相）。
# $1=主 checkout 的 .bin 目录 $2=工作树的 .bin 目录
mirror_bin_dir() {
  local src="$1" dst="$2" e name failed=0
  [ -d "$src" ] || return 0                     # 源无 .bin（无 bin 声明的仓）→ 不是失败
  if [ -L "$dst" ]; then
    # 只删链接本身（不递归）：目标可能是主检出的真目录，递归删就是删别人的依赖
    rm -f "$dst" || { c_err "无法删除老式 .bin 整目录软链：${dst}（原因见上一行 rm 的报错）"; return 1; }
  fi
  mkdir -p "$dst" || { c_err "无法建立 .bin 真目录：$dst"; return 1; }
  for e in "$src"/* "$src"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    name="$(basename "$e")"
    # 已存在（含 `bun add` 在本树写进来的）→ 不动它。这是"本树优先"，也是幂等的来源
    if [ -e "$dst/$name" ] || [ -L "$dst/$name" ]; then continue; fi
    ln -sfn "$e" "$dst/$name" || { c_err "镜像 .bin 条目失败：${name}（$e → $dst/${name}）"; failed=$((failed + 1)); }
  done
  if [ "$failed" != "0" ]; then
    c_err "镜像 .bin 有 ${failed} 个条目失败（逐条原因见上）"
    return 1
  fi
  return 0
}

# ── ISS-856：`.pnpm` 必须镜像成**工作树内的空真目录**，不能是整目录软链 ────────
# 原形态（`mirror_nm_dir` 的默认 `ln -sfn` 分支）：`<树>/node_modules/.pnpm → 主检出/.pnpm`
# 后果：该树**首次** `corepack pnpm install` 必炸 ——
#   `[ERR_PNPM_INVALID_DEPENDENCY_NAME] Refusing to place a dependency under <树>/node_modules/.pnpm/node_modules
#    with the invalid alias "@matter/storage"`
# 机制（pnpm 11.28.5 源码实测，dist/pnpm.mjs）：
#   `validateWorkspaceParent`(:198630) 与 `prepareWorkspaceParent`(:198658) 各有一条硬判据
#   `if (stat.isSymbolicLink() || !stat.isDirectory()) throw invalidDependencyNameError(...)`，
#   而 pnpm 必须在 `virtualStoreDir`（= `.pnpm`）**内部**建 `node_modules/` 来挂 workspace 包
#   ⇒ **`.pnpm` 只要是软链就必炸，与它指向哪无关。**
#   ⚠️ 别把根因写成"realpath 落到主 checkout ⇒ 自己指自己"：实测把 `.pnpm` 软链到一个
#   **与主 checkout 无关的全新空目录**，install 同样 EXIT=1（同一个错误码、同形错误串）。
# 为什么**不逐条镜像**（不照 `mirror_bin_dir` 的"真目录 + 逐条目软链"）：
#   实测逐条镜像 178 个条目后 install **仍 EXIT=1**，且错误串退化成
#   `... under .pnpm/node_modules with the invalid alias "@matter/storage" (it resolves to .pnpm/node_modules)`
#   —— pnpm 顺着逐条目软链把写入引导进 `.pnpm` 内部，**反而把依赖写进主 checkout**
#   （实测：主 checkout `.pnpm` 深度哈希变化、多出 69 条悬空软链、少 24 个包级 cmd-shim）。
#   ⇒ 甲档收窄为「只建空真目录」。pnpm 自己在里面铺 `.pnpm/node_modules`，内容从全局
#   store 复用（实测 reused 176 / downloaded 0），既不重下依赖，也不会碰主 checkout 一个字节。
# 幂等：老形态（软链）就地迁移成真目录；**已是真目录就一个字节都不动** ——
#   那是该树自己 `pnpm install` 铺出来的（含本树新增的包），删了等于删它的依赖。
# $1=主 checkout 的 .pnpm 路径 $2=工作树的 .pnpm 路径
mirror_pnpm_dir() {
  local src="$1" dst="$2"
  [ -d "$src" ] || return 0                     # 源无 .pnpm（非 pnpm 仓）→ 不是失败
  if [ -L "$dst" ]; then
    # 只删链接本身（不递归）：目标可能是主检出的真目录，递归删就是删别人的依赖
    rm -f "$dst" || { c_err "无法删除老式 .pnpm 整目录软链：${dst}（原因见上一行 rm 的报错）"; return 1; }
  fi
  mkdir -p "$dst" || { c_err "无法建立 .pnpm 真目录：$dst"; return 1; }
  return 0
}

# 主 checkout 的 `.bin` 里有没有**悬空软链**（ISS-504 的判据；机器可判，不靠嘱托）
# 扫根级 + 各包级 `.bin`。悬空 = 是软链且 `test -e` 不成立。
# 输出每行一条 `<相对路径>`；全局变量无副作用，可重复调用。
dangling_bin_list() {
  local b n
  for b in "$REPO/node_modules/.bin" "$REPO"/*/node_modules/.bin; do
    [ -d "$b" ] || continue
    for n in "$b"/* "$b"/.[!.]*; do
      [ -L "$n" ] || continue
      [ -e "$n" ] && continue
      printf '%s\n' "${n#"$REPO"/}"
    done
  done
}

# 把主 checkout 的一个 node_modules 目录镜像到工作树（幂等；已存在的条目不覆盖）
# $1=源 $2=目标 $3=工作树根
# ISS-586：逐条建链的失败原来**完全静默**（`ln -sfn` 无 `||`，失败被 set -e 或循环吞掉），
#   于是"镜像了个空壳"与"镜像成功"在输出上一模一样。现在逐条报错 + 统计后返回非 0。
# ISS-504：`.bin` 单列出去交给 mirror_bin_dir（真目录，见其头注）。
mirror_nm_dir() {
  local src="$1" dst="$2" wt="$3" e name failed=0
  [ -d "$src" ] || { c_err "镜像源不是目录：$src —— 跳过即等于把'没有依赖'读成'镜像好了'"; return 1; }
  mkdir -p "$dst" || { c_err "无法创建镜像目标：$dst"; return 1; }
  for e in "$src"/* "$src"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    name="$(basename "$e")"
    case "$name" in
      .bin) mirror_bin_dir "$e" "$dst/.bin" || failed=$((failed + 1))
            continue ;;
      # ISS-856：`.pnpm` 建**空真目录**（不逐条镜像 —— 逐条镜像实测 install 仍 EXIT=1
      #   且会把依赖写进主 checkout，见 mirror_pnpm_dir 头注）
      .pnpm) mirror_pnpm_dir "$e" "$dst/.pnpm" || failed=$((failed + 1))
            continue ;;
      # ISS-851：**自指**软链不镜像 —— 它无真消费者（任何 resolver 读它都 ELOOP），
      #   镜像它只会把同一个雷复制进每棵新建的工作树，直到某棵树首次跑 `pnpm install`
      #   才炸（ISS-507 实测 EXIT=194）。判据是 `is_self_nm_link`（看指向，不看名字）。
      node_modules)
        if is_self_nm_link "$e"; then
          c_warn "跳过一个自指软链（不镜像）：${e} —— 它是循环，镜像进工作树只会把 ELOOP 复制过去；删它：rm '$e'"
          continue
        fi
        ;;
    esac
    if is_ws_link "$e" "$name"; then
      [ -d "$wt/$name" ] || continue          # 工作树里没有这个包 → 交给 bun install
      [ -e "$dst/$name" ] || { ln -sfn "$wt/$name" "$dst/$name" || { c_err "镜像条目失败：${name}（$wt/$name → $dst/${name}）"; failed=$((failed + 1)); }; }
    else
      [ -e "$dst/$name" ] || { ln -sfn "$e" "$dst/$name" || { c_err "镜像条目失败：${name}（$e → $dst/${name}）"; failed=$((failed + 1)); }; }
    fi
  done
  if [ "$failed" != "0" ]; then
    c_err "镜像 ${src} → ${dst} 有 ${failed} 个条目失败（逐条原因见上）"
    return 1
  fi
  return 0
}

# 把**一条** workspace 软链重指为本工作树里的副本（幂等：已指对就一个字节都不动）
# $1=工作树根 $2=包名 $3=链接路径
# 返回 0 = 已经指对 / 修好了；1 = 修不了（目标包不在本树，或 rm/ln 失败）
# ISS-695：`ln -sfn` 在本机 macOS TCC 下会失败（「先建临时名再 rename」那步被拒，见文件头
#   ISS-334 注记）⇒ 一律「先 rm -f 链接本身，再 ln -s」。
# 幂等的实现方式：先比 `readlink` 字面，再比解析后的**真实路径**——相对写法、经池软链
#   （`.agents/worktrees/…`）写进本树的链接都算已指对，否则每次跑都会重写一遍，
#   「没变」只是看着没变、mtime 一直在动。
retarget_ws_link() {
  local wt="$1" name="$2" link="$3" want
  want="$wt/$name"
  [ -d "$want" ] || return 1
  # 只改**软链**。目标若已是真目录/真文件，`rm -f` 删不动它、`ln` 还会把新链接写进目录内部
  #   （ISS-416 记录过的写穿形态）⇒ 那不是本函数该动的对象，交给人判。
  [ -L "$link" ] || { c_err "拒绝改动非链接：${link}（真目录/真文件，不在 fix_ws_links 的射程内）"; return 1; }
  [ "$(readlink "$link" 2>/dev/null || true)" = "$want" ] && return 0
  if [ "$(cd "$link" 2>/dev/null && pwd -P || true)" = "$(cd "$want" 2>/dev/null && pwd -P || true)" ]; then
    return 0
  fi
  rm -f "$link" || { c_err "删除错链失败：${link}（原因见上一行 rm 的报错）"; return 1; }
  ln -s "$want" "$link" || { c_err "重指失败：$want → $link"; return 1; }
  echo "   修正 workspace 链接：${link#"$wt"/} → 本树 $name"
  return 0
}

# 把镜像里所有 workspace 链接**校正**为指向本工作树（幂等；用于 bun install 之后）
# 覆盖三层（ISS-695 补第 ③ 层——原来只有前两层，跨包依赖会长期指主 checkout）：
#   ① 根级：`<树>/node_modules/<包>`（bun 的 workspace 提升位）
#   ② 自指：`<树>/<包>/node_modules/<同包>`
#   ③ 跨包：`<树>/<包>/node_modules/<别的包>` —— 实测 ISS-690 有 19 条这种错链，
#      后果是「改了本树的 forge-design，下游包仍读主 checkout ⇒ 门禁全绿而改动没进去」（假绿）。
#      根因：`mirror_nm_dir` 只建不修（`[ -e "$dst/$name" ] ||` 目标已在就跳过），
#      而老 fix_ws_links 的覆盖面里根本没有跨包这一层。
fix_ws_links() {
  local wt="$1" name pkg link
  for name in $(ws_names_of "$wt"); do
    [ -d "$wt/$name" ] || continue
    for link in "$wt/node_modules/$name" "$wt/$name/node_modules/$name"; do
      [ -L "$link" ] || continue
      retarget_ws_link "$wt" "$name" "$link" || true
    done
  done
  # ③ 跨包：遍历**每个包**的 node_modules，凡 is_ws_link 判为 workspace 包者一律重指本树。
  #    判据用 is_ws_link（realpath 双向归一）而不是按名字猜：主 checkout 里没有的包（新包）
  #    不会被当成 workspace 链接去改；第三方条目更不会。
  #    ⚠️ 两道「别顺着链接走进主 checkout」的闸（否则 rm/ln 会改到**主检出**的条目）：
  #      ① 包目录本身是软链 ⇒ 跳过；② `<包>/node_modules` 本身是软链（老式整目录镜像）⇒ 跳过，
  #         那种树的正确修法是 `ws.sh deps`（reset_nm_dir 会先把这个链接换回真目录）。
  #      不跳的后果是写穿：glob 穿过软链展开成主 checkout 的条目，rm 掉的是主检出的链接。
  for pkg in "$wt"/*/; do
    if [ -L "${pkg%/}" ]; then continue; fi
    [ -d "${pkg}node_modules" ] || continue
    if [ -L "${pkg%/}/node_modules" ]; then continue; fi
    for link in "${pkg}"node_modules/*; do
      [ -L "$link" ] || continue
      name="$(basename "$link")"
      is_ws_link "$link" "$name" || continue
      retarget_ws_link "$wt" "$name" "$link" || true
    done
  done
}

# 一棵树里「指向主 checkout 的 workspace 包软链」清单（每行 `<相对路径>\t<目标>`；空 = 干净）
# ISS-695：这是 adopt 守卫与人工核验的**同一把尺**（doctor 的逐树检查另有口径，未合并）。
# 判据：`find <树> -maxdepth 4 -path '*/node_modules/*' -type l` 的每条软链，
#   readlink 目标的 basename 属于 package.json.workspaces，且目标路径在 $REPO 之下 ⇒ 错链。
#   实测形态是 `<主 checkout>/<包>/node_modules/<包>`，realpath 会解析成 `<主 checkout>/<包>`，
#   两种写法都落在 $REPO 下，故不比对 realpath。
# 深度口径：根级（<树>/node_modules/x）· 包级（<树>/<包>/node_modules/x）· 作用域内
#   （<树>/<包>/node_modules/@scope/x）。修复侧（fix_ws_links）只覆盖前两层 ——
#   作用域内那一层修不了，出现即红并列出清单交人判，不在这里盲改（全池实测 0 例）。
cross_ws_link_list() {
  local wt="$1" l tgt b names
  names="$(ws_names)"
  while IFS= read -r l; do
    tgt="$(readlink "$l" 2>/dev/null || true)"
    [ -n "$tgt" ] || continue
    case "$tgt" in "$REPO"/*) ;; *) continue ;; esac
    b="$(basename "$tgt")"
    # `$'\n'` 包裹做整词匹配：防 `forge-model` 命中 `forge-model-protocol`
    case $'\n'"$names"$'\n' in *$'\n'"$b"$'\n'*) ;; *) continue ;; esac
    printf '%s\t%s\n' "${l#"$wt"/}" "$tgt"
  done < <(find "$wt" -maxdepth 4 -path '*/node_modules/*' -type l 2>/dev/null)
}

# 建立/修复一个工作树的依赖镜像：根 + 各包；新包缺依赖时跑一次 bun install
# $1=工作树路径
# 返回（ISS-586 三态，调用方按此分档 —— 不许把"判不了"读成"没问题"）：
#   0 = 绿：根与树都在、树根非空、包级镜像数 > 0
#   1 = 红：根 node_modules 缺失 / 树 node_modules 建不出来 / 镜像过程失败 —— **判据成立且不满足**
#   2 = 判不了：新包 bun install 失败（网络/registry/lock）—— 结论不可得，与"红"分开报
prepare_worktree_deps() {
  # ⚠️ `$2` 必须 `local`：本函数在**调用方不传第二参**时（`cmd_new` 的
  #   `prepare_worktree_deps "$path"`）会继承外层位置参数，`set -u` 下直接崩
  #   `$2: unbound variable`。实测（2026-10-07，ISS-584 自测抓到）：
  #   main 版同样崩（存量缺陷，非本单引入）；触发条件是 `$fresh` 非空
  #   （工作树里有主 checkout 不存在的包）—— 恰好是 ISS-584 最需要走通的那条路径。
  local wt="$1" opt="${2:-}" shared=0 fresh="" pkg_failed=0 install_failed=0 nm_cnt=0
  [ -d "$wt" ] || { c_err "工作树不存在：$wt"; return 1; }

  # ── ISS-586 红①：主 checkout 根 node_modules 缺失 ──────────────────────────
  # 原来这一格写成 `[ -d "$REPO/node_modules" ] && mirror_nm_dir …`：源缺失时 `&&` 短路，
  # **一个字节都不打印**，随后照样走到下面报「✓ 就绪」（包级 27 个都成功 ⇒ shared>0）。
  # 现在当场报红并**不再往下做**：没源就没有根依赖，继续跑 28 个包级镜像只会把失败
  # 推到别人的门禁里（症状是 Cannot find module 'forge-service-kit/fs'，极难归因）。
  if [ ! -d "$REPO/node_modules" ]; then
    c_err "依赖镜像**失败**：主 checkout 根 node_modules 不存在 —— $REPO/node_modules"
    c_err "  → workspace 级包只挂在仓库根（解析自当前目录逐级向上）⇒ 工作树里必然 Cannot find module"
    c_err "  → 先修主 checkout：cd $REPO && bun install；再 bash $0 deps ${wt##*/}"
    return 1
  fi
  # 红②：目标位建不出来（reset_nm_dir 现在会自己报原因并返回非 0）
  if ! reset_nm_dir "$wt/node_modules"; then
    c_err "依赖镜像**失败**：工作树根 node_modules 建不出来 —— $wt/node_modules（原因见上）"
    return 1
  fi
  # 红③：镜像过程失败要出声（原来逐条 `ln -sfn` 失败**完全静默**，空壳与成功在输出上同形）
  if ! mirror_nm_dir "$REPO/node_modules" "$wt/node_modules" "$wt"; then
    c_err "依赖镜像**失败**：根镜像未完成（失败条目见上）⇒ 该树的 bun test/typecheck 结果不可信"
    c_err "  → 修好后再跑 bash $0 deps ${wt##*/}"
    return 1
  fi
  local n
  for n in $(ws_names_of "$wt"); do
    [ -d "$wt/$n" ] || continue
    if [ -d "$REPO/$n/node_modules" ]; then
      # ISS-586：包级镜像失败同样算失败 —— 计数只数**真的成了**的（旧版先 ++ 再镜像）
      if reset_nm_dir "$wt/$n/node_modules" && mirror_nm_dir "$REPO/$n/node_modules" "$wt/$n/node_modules" "$wt"; then
        shared=$((shared + 1))
      else
        pkg_failed=$((pkg_failed + 1))
      fi
    elif [ ! -d "$REPO/$n" ]; then
      # ⚠️ 判据必须用**包目录**是否存在，不能用 node_modules —— 主 checkout 里
      #    forge-archive / forge-b-embed / forge-combo-model 有包但**没有自己的 node_modules**
      #    （无依赖），旧判据会把它们误报成"新包"并触发多余的 bun install。
      [ -e "$wt/$n/node_modules" ] || fresh="$fresh $n"
    fi
  done
  if [ -n "$fresh" ]; then
    if [ "$opt" = "--no-install" ]; then
      # 新包只在**工作树根** node_modules 下补链接（ISS-498：workspace 级包挂在仓库根，
      # 解析自当前目录逐级向上，根链接就够）。不跑 install：别的会话的 bun.lock 在途时，
      # install 会重写锁并波及共享依赖树，代价与「一个新包缺链接」不成比例。
      mkdir -p "$wt/node_modules"
      for n in ${fresh# }; do ln -sfn "$wt/$n" "$wt/node_modules/$n"; done
      c_ok "新包仅补根级链接（未 install）：${fresh# } → $wt/node_modules/"
      c_warn "  新包自己的第三方依赖仍缺；bun.lock 收口后补跑一次 bun install 才完整"
    else
      c_warn "工作树里有主 checkout 不存在的包（新包）：${fresh# } → 跑 bun install 取依赖（bun 不 hoist，必须包级安装）"
      ( cd "$wt" && bun install >/dev/null 2>&1 ) || install_failed=1
    fi
  fi
  fix_ws_links "$wt"
  # ── ISS-586 硬断言④：树里**必须真有**根 node_modules，且非空 ────────────────
  # 为什么"存在"这条单独不够：reset_nm_dir 会先把目标位建出来 ⇒ 目录恒在；根镜像
  #   失败时树里就是个**空目录**，而旧判据（只数包级 shared）照样报绿 —— 这正是
  #   ISS-586 的现场形态（`.wt/ISS-585/node_modules: No such file or directory`）。
  if [ ! -d "$wt/node_modules" ]; then
    c_err "依赖镜像**失败**：工作树根 node_modules 不存在 —— $wt/node_modules"
    c_err "  → 修法：bash $0 deps ${wt##*/}"
    return 1
  fi
  nm_cnt="$(ls -A "$wt/node_modules" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${nm_cnt:-0}" -eq 0 ]; then
    c_err "依赖镜像**失败**：工作树根 node_modules 是**空的**（0 条目）—— 根镜像没建成，等于没装依赖"
    c_err "  → 修法：bash $0 deps ${wt##*/}（仍为空则先修主 checkout 的 node_modules）"
    return 1
  fi
  if [ "$pkg_failed" != "0" ]; then
    c_err "依赖镜像**失败**：${pkg_failed} 个包的 node_modules 没镜像成（逐条原因见上）"
    return 1
  fi
  # ISS-525：0 个既有包 = **必定不完整**（本仓有十几个 workspace 包），不能报「✓ 就绪」——
  # 之前 node 起不来时正是走到这里报绿，害人去查别处。
  if [ "$shared" -eq 0 ]; then
    c_warn "依赖镜像**不完整**：0 个既有包被镜像（本仓应有十几个）→ 工作树里 tsc/bun test 会报 Cannot find package"
    c_warn "  排查：① NODE_OPTIONS 是否被外部注入（本脚本已 unset）② 主 checkout 的 package.json workspaces 是否可读"
  elif [ "$install_failed" != "0" ]; then
    # ISS-586 第三态：**判不了** —— 与"判据不成立"（红）分开报，别让人去查代码。
    c_warn "依赖镜像**判不了**（不是绿，也不是判据不成立）：新包 bun install 失败（网络/registry/lock？）"
    c_warn "  已镜像根（$nm_cnt 条目）+ $shared 个既有包；新包（${fresh# }）的第三方依赖可能缺"
    c_warn "  ⇒ 该树的门禁结果不可信；网络好了重跑 bash $0 deps ${wt##*/}"
    return 2
  else
    c_ok "依赖镜像就绪（根 ${nm_cnt} 条目 + $shared 个既有包 → 主 checkout 零拷贝；workspace 链接指向本工作树）"
  fi
}

worktree_iss_of_link() {
  local tgt="$1" rest=""
  case "$tgt" in
    "$WT_ROOT"/*) rest="${tgt#"$WT_ROOT"/}" ;;
    "$REPO"/.wt/*) rest="${tgt#"$REPO"/.wt/}" ;;
    *) return 0 ;;
  esac
  printf '%s\n' "${rest%%/*}"
}

# 该单是否持有**在途**租约（0 = 持有）
lease_held_by() {
  local iss="$1"
  [ -n "$iss" ] || return 1
  [ -f "$LOCK_FILE" ] || return 1
  # 读不出 ⇒ 按在途处理。原来这里靠 `lock_field iss` 比单号，坏 JSON 时取到空串、
  # 与任何单号都不等 ⇒ 护栏对 `link main` 直接失明（第三轮审查实测：两个包被切走且 0 次出声）。
  [ "$(lock_stale_reason)" = "unreadable" ] && return 0
  if lock_expired; then return 1; fi
  [ "$(lock_field iss)" = "$iss" ]
}

# 「这块地是不是你的」——三条证据任一即认：
#   ① 自报的 WS_OWNER 与锁上写的相符；② 当前所在分支名就是这张单；
#   ③ 锁上没有可辨认的持有者（未署名 / 老脚本写的 linmo / 空）——拦住只会把历史锁变成永动机。
# ⚠️ 身份是**自报**的，所以这一格防误敲、不防恶意；要更强的凭据得看进程 cwd 或 worktree lock（另单）。
lease_is_mine() { # $1=单号 ⇒ 0 是你的
  local iss="$1" lowner; lowner="$(lock_field owner)"
  case "$lowner" in ""|未署名|linmo) return 0 ;; esac
  if [ -n "${WS_OWNER:-}" ] && [ "$WS_OWNER" = "$lowner" ]; then return 0; fi
  [ "$(my_iss_from_cwd)" = "$iss" ] && return 0
  return 1
}

# 把「指向 $1 这个工作树」的插件链接**精确**切回主 checkout——只回收自己这一片地，绝不碰别人。
# cmd_rm 用它替代旧的 `cmd_link main`（后者是全量扫射，正是 ISS-416 事故的来源）。
relink_back_from_path() {
  local wt="$1" n=0 link tgt name
  [ -d "$PROFILES_NM" ] || return 0
  for link in "$PROFILES_NM"/forge-*; do
    [ -L "$link" ] || continue
    tgt="$(readlink "$link" 2>/dev/null || true)"
    case "$tgt" in "$wt"|"$wt"/*) ;; *) continue ;; esac
    name="$(basename "$link")"
    link_symlink "$REPO/$name/" "$link"
    n=$((n+1))
  done
  if [ "$n" -gt 0 ]; then
    c_ok "已把 $n 个插件切回主 checkout（原指向 ${wt}）"
  else
    c_warn "没有插件指向 ${wt}（无需回收）"
  fi
}

# 主 checkout 的当前分支
cur_branch() { git -C "$REPO" branch --show-current 2>/dev/null || echo "?"; }

# ── ISS-734③：工作树 base 与 main 的关系（供 guard / doctor 用） ─────────────────
# 为什么需要：`ws.sh new` 已在**建树那一刻**把 base 与 main 的距离打印出来（判据②），
#   但那只说一次话。之后 main 继续往前走，树就悄悄腐烂，**没有任何机制再回头看**。
#   实测代价（2026-10-07）：仓库里 5 条纯工程档分支分别落后 main 323 / 484 / 821 / 831 / 883 个提交；
#   其中 ISS-570（落后 485）引用的 `forge-db` 包已在次日被 ISS-589 归并进 forge-design
#   ⇒ 它**自己的树** build:client 绿，**并进 main** 直接冲突（`git merge-tree` exit 1）。
#   对 M-040 自动闭环尤其致命：门禁跑在**本单工作树**上（auto-merge-run.js:15），
#   而合并执行 `git merge --no-ff <branch>`（merge-iss.sh:250）—— 验的与合的不是同一棵树。
# 本函数只**采集**（读三件事实），阈值判定与输出留给调用方（guard 判红 / doctor 只报）。
# 输出三行：`<祖先|非祖先> <落后数> <树路径>`；取不到时印 `?`（读不到 ≠ 没问题）。
worktree_base_probe() {
  local wt="$1" anc behind
  [ -d "$wt" ] || return 1
  # 祖先关系只作**分辨信息**（不判红 —— 在途分支天然非祖先，见下面 guard 处的说明）：
  #   非祖先 = 树上有 main 没有的提交 = 本单还没合的正常状态，或历史被回退的异常状态，
  #   两者在 guard 这层分不开（要分开得看提交是否都有单号），故只印出来给人看。
  if git -C "$wt" merge-base --is-ancestor HEAD main 2>/dev/null; then anc="祖先"; else anc="非祖先"; fi
  behind="$(git -C "$wt" rev-list --count HEAD..main 2>/dev/null || echo '?')"
  printf '%s %s %s\n' "$anc" "$behind" "$wt"
}

# 列出**所有工作树**（排除主 checkout 与缓存树）各自的 base 关系。每行同上格式。
# 现算不缓存（治理采集层纪律①）：树数会变，写死数字必然在下一轮骗人。
# ⚠️ 必须排除 `.gate-base`（独立审查 B2 抓到，实测确凿）：那是 `gate-base-tree.mjs` 用
#   `worktree add --detach` 建的门禁**缓存树**，**设计上就钉在 merge-base 上**（它的用途
#   正是"取共同祖先那一份代码算门禁现值"）⇒ 它天生落后 main，且 `gate-fast` 只在门禁
#   超额时才重钉（`gate-fast.mjs:232`），全绿时走 `:262 process.exit(0)` 不刷新
#   ⇒ 它会一直陈旧下去，约 10 小时后越过阈值，此后**每次 guard 恒红**。
#   把缓存树当工作树体检 = 每天误报一次、并给出错误处置（rebase 会让 gate-fast 的
#   `headAt(cachePath) === sha` 判据失配，:41）。这正是"护栏变噪音"的成因。
worktree_bases_all() {
  local p
  git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ "$p" = "$REPO" ] && continue
    # 排除门禁缓存树（第二遍独立审查 M2：只看 basename 会漏 `GATE_BASE_CACHE` 指向的任意名）。
    # ⚠️ 判据别用"detached + tip==merge-base"——我第一版这么写，**对任何 detached 落后树都成立**
    #   （detached 树的 merge-base(HEAD,main) 就是它自己的 tip）⇒ 会把所有 detached 树全排除，
    #   自测场景 3 当场抓到（wt-edge 落后 51 该红却被放行）。
    # 可靠特征 = **git admin 条目名**：`gate-base-tree.mjs` 建的树在工作树清单里固定叫 `-gate-base`
    #   （实测 `git rev-parse --git-dir` → `.git/worktrees/-gate-base`），与其 basename 无关。
    case "$(basename "$p")" in .gate-base*) continue ;; esac
    case "$(basename "$(git -C "$p" rev-parse --git-dir 2>/dev/null || echo '')")" in -gate-base*) continue ;; esac
    [ -d "$p" ] || continue
    worktree_base_probe "$p" || true
  done
}

# 解析 `bun` 的绝对路径。为什么必须硬找（与 forge-pm/lib/auto-merge-run.js:58 同因）：
#   agent / 宿主进程的 PATH 实测只有 `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`，
#   而 bun 装在 `~/.bun/bin/bun` ⇒ 裸 `bun run build:*` 全 ENOENT。
#   ⚠️ 本函数 2026-10-07 第一版就栽在这：`--reuse` 复用的树里 28 个包补建**全失败**，
#      日志只有一行 `bun: command not found`，而失败被我的 `|| c_warn` 收成"提示"
#      ⇒ 差点把"没建"读成"建了"。所以这里既解析路径，也把**找不到**如实报出来。
#   优先级：PATH 里真有就用它（`command -v` 语义）；否则查已知位；都没有 ⇒ 返回空串，
#      由调用方报红（不假装跑过）。
resolve_bun() {
  local c
  c="$(command -v bun 2>/dev/null || true)"
  [ -n "$c" ] && { printf '%s\n' "$c"; return 0; }
  for c in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
# 落后阈值：超过它 guard 判红。为什么是 50 而非 0：
#   任何落后 ⇒ 判红最安全，但待审单须先 rebase 再重审，工作量陡增（且 --reuse 的合法场景会被误伤）。
#   50 这个数不是拍的 —— 它是「一天正常开发量」的量级（本仓实测一天 300+ 提交里，
#   与单相关的部分是几十条）；超过一天没同步，撞包级重构的概率已不可忽略
#   （forge-db 那次归并就发生在 **24 小时内**，滞后量 323 ⇒ 本条只挡得住"持续腐烂"，
#    单次快速重构的窗口靠合并前 `merge-tree` 干净度兜底，那是另一格）。
# ⚠️ 口径自纠（独立审查 M1 实测，2026-10-07）：上面"一天"是**估错**了 ——
#   现算近 24h = 119 提交 ⇒ 50 ≈ **10 小时**（半天）。待审单会撞线：
#   实例 ISS-597 停审一天已 behind=41。若嫌严，调 WS_BASE_BEHIND_LIMIT（见下）。
WS_BASE_BEHIND_LIMIT="${WS_BASE_BEHIND_LIMIT:-50}"
# ⚠️ 阈值必须是正整数，否则整条判据**静默失效且报绿**（独立审查 B3 实测：
#   `WS_BASE_BEHIND_LIMIT=abc` ⇒ `[: abc: integer expression expected` 写到 stderr，
#   而 `[` 在 `if` 条件里 `set -e` 兜不住 ⇒ guard 照常 exit 0）。
#   本仓纪律：对外宣称可调的旋钮，取不到值时必须 **fail-closed**，不能默默关闸。
# ⚠️ 只挡「含非数字」**不够**（第二遍独立审查 M3）：`99999999999999999999`（20 位）
#   全是数字 ⇒ 绕过上面那道，而 bash 整数是 64 位 ⇒ `[ -gt ]` 报 `integer expression expected`
#   并把条件当假 ⇒ 整条判据又被静默跳过、照常报绿。**与 B3 同一形状，只是入口换了。**
#   故按**位数**再挡一道：阈值语义是"提交数"，10 位（百亿）已远超任何真实规模。
case "$WS_BASE_BEHIND_LIMIT" in
  ''|*[!0-9]*)
    c_err "WS_BASE_BEHIND_LIMIT 不是正整数：「${WS_BASE_BEHIND_LIMIT}」⇒ 按 fail-closed 处理"
    c_err "  → 不改用默认值继续（那会静默关掉 base 落后判据，把'未判'读成'没问题'）。改成数字再跑。"
    WS_BASE_BEHIND_LIMIT_INVALID=1
    WS_BASE_BEHIND_LIMIT=50 ;;
  *)
    if [ "${#WS_BASE_BEHIND_LIMIT}" -gt 10 ]; then
      c_err "WS_BASE_BEHIND_LIMIT 超出可判范围（${#WS_BASE_BEHIND_LIMIT} 位 > 10 位）：「${WS_BASE_BEHIND_LIMIT}」"
      c_err "  → 位数过大会让 shell 整数溢出 ⇒ 比较恒假 ⇒ 判据静默失效。按 fail-closed 处理。"
      WS_BASE_BEHIND_LIMIT_INVALID=1
      WS_BASE_BEHIND_LIMIT=50
    fi ;;
esac

# **当前目录**所在工作树的单号（ISS-552 W-1 用：释放租约得先知道"我这张地是谁的"）。
# 分支名里带 ISS-NNN 是 ws.sh `new` 的既有约定；主 checkout（main）拿不到 ⇒ 返回空，
# 由调用方决定是"要求显式传单号"还是"不许猜"。
# 归属证据之一「当前目录是哪张单的树」——**在命令开始时算一次**，之后只读这个值。
# 为什么不能用的时候再问：`ws.sh rm` 会把当前所在的工作树删掉，删完再问 git 就答不出来，
# 于是第④步释放租约时判定从「是你的」当场翻成「不是你的」⇒ **树删了、锁还在**
# （2026-10-04 第四轮审查实测 rc=3 的半截态，正是本单要根除的形状）。
# ⚠️ 也不能写成 `MY_ISS_CACHE="$(…)"` 放在函数里：命令替换是子壳，赋值传不出父壳（我第一版就这么废过一次）。
MY_ISS_FROM_CWD="$(git -C "$PWD" branch --show-current 2>/dev/null | grep -oE 'ISS-[0-9]+' | head -1 || true)"
my_iss_from_cwd() { printf '%s' "$MY_ISS_FROM_CWD"; }

# 治理件看的家 vs 环境里的 DSH_HOME 不一致 ⇒ 出声（不静默、也不自作主张改写入位置）。
# 为什么值得单独一条：护栏在 A 家看到"没人占用"，服务在 B 家跑 —— 演练会**假绿**，
# 而假绿的护栏比没有护栏更糟（它让人以为规矩在被执行）。
home_split_note() {
  local svc real
  svc="${DSH_HOME:-}"
  [ -n "$svc" ] || return 0
  real="$(cd "$STATE_DIR" 2>/dev/null && pwd || echo "$STATE_DIR")"
  svc="$(cd "$svc" 2>/dev/null && pwd || echo "$svc")"
  if [ "$svc" = "$real" ]; then return 0; fi
  c_warn "治理件看的家 = ${real}，环境里 DSH_HOME = ${svc} —— 租约与基线两份各算各的（ISS-552 W-3）。"
  c_warn "  切换要挑「没有其他会话在途」的窗口一起做（否则新旧脚本各写一家 = 互踩放大）。见本单 note 的待拍项。"
  return 0
}

# 脏文件（含未跟踪），一行一个
dirty_files() { git -C "$REPO" status --porcelain 2>/dev/null | awk '{print $2}'; }

# 读锁文件里的某字段（无锁则空）
lock_field() {
  [ -f "$LOCK_FILE" ] || return 0
  python3 - "$LOCK_FILE" "$1" <<'PY' 2>/dev/null || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get(sys.argv[2], "") or "")
except Exception:
    pass
PY
}

# 租约判据的唯一出口：打印这把锁"算不算有人占着"，取值之一 ——
#   released           —— 无锁文件 / 空对象 `{}` / 没有单号 ⇒ 不阻塞
#   time               —— 时钟到期（含 expire 缺失或格式坏，按 main 既有语义判可清）⇒ 不阻塞
#   merged:<iss>       —— 干完没收尾的**提示**，但**仍然阻塞**（理由见下）
#   merged+time:<iss>  —— 两条同时成立 ⇒ 提示 + 不阻塞
#   ""                 —— 健康在途 ⇒ 阻塞
#   unreadable         —— 锁文件在但读不出 ⇒ **按在途处理（fail-closed）**
# ⚠️ 刻意不用 pid 判活（2026-10-03 立案时证到）：claim 写的是 `os.getpid()`，那是个毫秒级就消失的
#    一次性进程，agent 会话跑 ws.sh 的 bash 同样在命令结束时就退 ⇒ 拿它判活会把所有租约秒判僵尸。
# ⚠️ 一次读不出绝不能当"已释放"：那样 `release <别人单>` 会走空锁短路，把别人的在途租约抹成 `{}`
#    （护栏从此对他失明，正是 ISS-802 的形态）⇒ unreadable 归到阻塞一侧，接管必须显式 --force。
lock_stale_reason() {
  [ -f "$LOCK_FILE" ] || { echo released; return 0; }
  REPO="$REPO" WT_ROOT_RESOLVED="$WT_ROOT" python3 - "$LOCK_FILE" <<'PY' 2>/dev/null || echo unreadable
import datetime, json, os, re, subprocess, sys
try:
    d = json.load(open(sys.argv[1]))
    if not isinstance(d, dict):
        raise ValueError("锁文件不是对象")
except Exception:
    print("unreadable")
    sys.exit(0)
iss = str(d.get("iss") or "")
if not iss:
    print("released")
    sys.exit(0)
repo = os.environ.get("REPO", "")


def git(*args):
    if not repo:
        return None
    try:
        r = subprocess.run(("git", "-C", repo) + args, capture_output=True, text=True)
    except Exception:
        return None
    return r.stdout if r.returncode == 0 else None


# 「干完没收尾」只是提示，**不参与放行**：停在旧 base 还没动手的分支与已合并的分支在 git 图上同形
# （都是 main 的祖先且 != main tip），谁合一次车就把活人的锁报成僵尸 ⇒ 误报的代价是无声抢地。
# 唯一可用的真凭据 = 本仓收口习惯写出的 `merge(ISS-NNN)`（§4.5）。而且只认括号里那个号：
# 子串匹配会被多单号 subject 与长短号误吃（实测 `merge(ISS-929)` 会命中 ISS-923）。
hint = False
if git("rev-parse", "--verify", "--quiet", "refs/heads/" + iss) is not None:
    subs = git("log", "-400", "--format=%s", "main") or ""
    if any(iss in re.findall(r"(?i)\bmerge\((ISS-\d+)\)", s) for s in subs.splitlines()):
        cwd = str(d.get("cwd") or "")
        if not cwd:
            # 老脚本写的锁没有 cwd 字段。落点约定是 `ws.sh new` 建的 `$WT_ROOT/<单号>`，按约定推一个
            wtroot = os.environ.get("WT_ROOT_RESOLVED", "")
            cwd = (wtroot + "/" + iss) if wtroot else ""
        dirty = None
        if cwd:
            if os.path.isdir(cwd):
                r = subprocess.run(["git", "-C", cwd, "status", "--porcelain"],
                                   capture_output=True, text=True)
                dirty = r.stdout.strip() if r.returncode == 0 else None   # 读不出就不说
            else:
                dirty = ""                      # 树已经收了、锁还挂着 —— 正是要出声的那格
        hint = (dirty == "")

exp = str(d.get("expire") or "")
expired = True                                  # 没有到期时间 = 老锁，按可清处理，不许永挂
if exp:
    try:
        t = datetime.datetime.strptime(exp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
        expired = datetime.datetime.now(datetime.timezone.utc) > t
    except Exception:
        expired = True
if expired:
    print(("merged+time:" + iss) if hint else "time")
else:
    print(("merged:" + iss) if hint else "")
PY
}

# 是否"不构成阻塞"：空锁、时钟到期（含与 merged 同时成立）放行；
# 健康在途、merged 但没到期、以及读不出，都继续阻塞（fail-closed）。
lock_expired() {
  [ -f "$LOCK_FILE" ] || return 0
  case "$(lock_stale_reason)" in
    released|time|merged+time:*) return 0 ;;
    *) return 1 ;;
  esac
}

cmd_status() {
  echo "── 工作区状态 ─────────────────────────────"
  local br n
  br="$(cur_branch)"
  n="$(dirty_files | wc -l | tr -d ' ')"
  echo "主 checkout : $REPO"
  echo "分支        : $br"
  echo "脏文件      : $n 个"
  if [ -f "$LOCK_FILE" ]; then
    local owner iss since exp reason
    owner="$(lock_field owner)"; iss="$(lock_field iss)"
    since="$(lock_field since)"; exp="$(lock_field expire)"
    reason="$(lock_stale_reason)"
    case "$reason" in
      released)
        # 已释放态（cmd_release 写的空对象）或没有锁：显式说"无租约"，别显示一串空字段
        c_ok "无租约（上一份已释放）" ;;
      unreadable)
        c_err "锁文件在但读不出：${LOCK_FILE} ⇒ 按「有人占着」处理（既不放行接管，也不许 release 覆盖）"
        c_err "  → 先看文件是不是被截断/手改过；确认无人再 ws.sh release <单号> --force" ;;
      merged:*)
        c_warn "租约持有：$iss / ${owner}（$since → ${exp}）"
        c_warn "  但这条像是干完没收尾：${iss} 有 merge(${iss}) 提交、工作树已无改动"
        c_warn "  → 确认后就收：ws.sh release ${iss}；工作树也要收：ws.sh rm ${iss}（拿不准就别动，接管仍走 --force）" ;;
      merged+time:*)
        c_warn "租约已软到期且像干完没收尾：$iss / ${owner}（原定 $exp 到期 · 有 merge(${iss}) 提交 · 树已干净）"
        c_warn "  → ws.sh release ${iss}；工作树也要收：ws.sh rm ${iss}" ;;
      time)
        c_warn "租约已软到期：$iss / ${owner}（自 ${since}，原定 $exp 到期）——持有人大概率还在干，不算事故" ;;
      *)
        c_ok "租约持有：$iss / ${owner}（$since → ${exp}）" ;;
    esac
    if [ -n "$iss" ] && { [ -z "$owner" ] || [ "$owner" = "linmo" ] || [ "$owner" = "未署名" ]; }; then
      c_warn "  ⚠️ 这条租约没有可辨认的持有者（owner=${owner:-<空>}）⇒ 护栏答不了「是谁在占」；claim 前导出 WS_OWNER=<品牌:单号>"
    fi
  else
    echo "租约        : 无（未声明占用）"
  fi
  if [ -f "$BASE_FILE" ]; then
    local bh bb bat
    bh="$(python3 -c "import json;print(json.load(open('$BASE_FILE')).get('head',''))" 2>/dev/null || true)"
    bb="$(python3 -c "import json;print(json.load(open('$BASE_FILE')).get('branch',''))" 2>/dev/null || true)"
    bat="$(python3 -c "import json;print(json.load(open('$BASE_FILE')).get('at',''))" 2>/dev/null || true)"
    echo "基线        : $bb@${bh:0:7}（${bat}）"
    if [ "$br" != "$bb" ]; then c_err "基线分支与当前分支不一致——工作区已被切走！"; fi
  else
    echo "基线        : 未记录（建议开工前 ws.sh baseline save）"
  fi
  if [ "$n" -gt 0 ] && [ ! -f "$LOCK_FILE" ]; then
    c_warn "工作区有 $n 个未提交改动，但没有任何租约——别人可能不知道你在改"
  fi
  if [ "$br" != "main" ]; then
    c_err "主 checkout 停在 ${br}（应为 main——主 checkout 只跑服务与收口合并，ISS-294/330）"
  fi
  home_split_note
  # ISS-385：链接指向也是「工作区状态」的一部分——只看租约/基线看不出插件被切到了工作树，
  # 而悬空链接会让 3210 直接起不来（真实事故：删工作树前没切回 main）。
  local links
  links="$(links_report)"
  if [ -n "$links" ]; then
    echo "插件链接    : 非 main 指向"
    printf '%s\n' "$links" | sed 's/^/  · /'
  else
    echo "插件链接    : 全部指向 main"
  fi
}

# 遍历已挂载插件 symlink，输出「指向非 main / 悬空」的清单（供 status / doctor 共用）。
# 输出格式：<name>\t<target>\t<dangling|worktree>
links_report() {
  [ -d "$PROFILES_NM" ] || return 0
  local link name target
  for link in "$PROFILES_NM"/forge-*; do
    [ -L "$link" ] || continue
    name="$(basename "$link")"
    target="$(readlink "$link" 2>/dev/null || true)"
    [ -n "$target" ] || continue
    if [ ! -e "$link" ]; then
      printf '%s\t%s\tdangling\n' "$name" "$target"
    elif [ "$target" != "$REPO/$name" ] && [ "$target" != "$REPO/$name/" ]; then
      printf '%s\t%s\tworktree\n' "$name" "$target"
    fi
  done
}

# ISS-418：写穿入口——工作树里指向**主 checkout** 的 dist 软链。
# 这类链接一旦存在，在那个工作树里跑一次 `build:client` 就会把主 checkout 的产物覆盖成
# 「工作树那份源码」的构建结果（dist 不入库 → git 干净、线上静默回退）。
# 扫描范围要覆盖三种工作树落点：默认 `$WT_ROOT`、`--in-repo` 的 `$REPO/.wt`、以及
# `DSH_FORGE_WT_ROOT` 指到仓内时的 `$REPO/.tmp/wt`（实测 ISS-377 就窝在这里）。
# 输出：<link>\t<target>
write_through_report() {
  local root w f tgt
  for root in "$WT_ROOT" "$REPO/.wt" "$REPO/.tmp/wt"; do
    [ -d "$root" ] || continue
    for w in "$root"/*/; do
      [ -d "$w" ] || continue
      for f in "$w"forge-*/dist/client.js; do
        [ -L "$f" ] || continue
        tgt="$(readlink "$f" 2>/dev/null || true)"
        case "$tgt" in "$REPO"/*) printf '%s\t%s\n' "$f" "$tgt" ;; esac
      done
    done
  done
}

# ── ISS-696（洞1）+ ISS-870：池目录守卫，**两种形态**分判 ─────────────────────
# 机理（软链那一支，ISS-696）：官方 `create_worktree` 取落点走 **realpath**，软链被吃掉
#   ⇒ 树才物理落在仓外 `$WT_ROOT`。软链一旦丢失，官方**不报错**：它会在仓内建真目录
#   `.agents/worktrees/ISS-x`，而 `status` / `wt-scan` / `ai-review.sh` / 约定落点发现
#   **全按 `$WT_ROOT` 扫描** ⇒ 那棵树对护栏隐形（没报错、没提示，护栏突然对一堆树失明）。
#
# ⚠️ ISS-870：**二级形态下这条判据原本是误红**，必须分两形态（实测，2026-11-17）：
#
#   | $REPO 是 | 池的合规形态 | 为什么 |
#   |---|---|---|
#   | **主检出**（`git-dir` == `git-common-dir`） | `.agents/worktrees` 是指向 `$WT_ROOT` 的**软链** | 官方取落点走 realpath，靠软链把树放到仓外 —— 一行不动 |
#   | **会话树**（`git-dir` ≠ `git-common-dir`，本身是别人的工作树） | `.agents/worktrees` 是**真目录 + `.gitignore` 内容为 `*`** | 这是官方 `PREPARE_DIRECTORY` 的产物形状：会话树的池是内层工单树的落点，**它就该在会话树里**（第二级），没有"挪到仓外"这回事。要求它软链到 `$WT_ROOT` 会把一个合法形态判成漂移 |
#
#   为什么要判 `.gitignore` 内容为 `*`：内层树一旦没被忽略，会话树的 `git status` 会把它
#   整个显示成未跟踪 ⇒ 会话树永远"脏" ⇒ `ws.sh rm` / `git worktree remove` 对它的判断失真，
#   且 `status` 的脏否读数在二级形态下失去意义。官方建池时写的正是 `*`（两字节）。
#
# 返回 0 = 合规；非 0 = 不合规，并把**实际形态**写进 POOL_PROBLEM（调用方各自措辞）。
POOL_PROBLEM=""
# `$REPO` 是不是**会话树**（= 一棵工作树，不是主检出）。git 的官方判法：
#   主检出 `--git-dir` 与 `--git-common-dir` 同值（都是 `<repo>/.git`）；
#   工作树 `--git-dir` 是 `<主>/.git/worktrees/<id>`、`--git-common-dir` 仍是 `<主>/.git`。
# ⚠️ 两侧都比 `--path-format=absolute`：相对写法在子目录里调用时会不同，比字符串会误判。
is_session_tree() {
  local gd gc
  gd="$(git -C "$REPO" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
  gc="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [ -n "$gd" ] && [ -n "$gc" ] && [ "$gd" != "$gc" ]
}
pool_link_problem() {
  local pool="$REPO/.agents/worktrees" want got gi
  POOL_PROBLEM=""
  if [ ! -e "$pool" ] && [ ! -L "$pool" ]; then
    POOL_PROBLEM="不存在"
    return 1
  fi

  # ── 形态 B：会话树 ⇒ 真目录 + `.gitignore: *` ───────────────────────────────
  if is_session_tree; then
    if [ -L "$pool" ]; then
      POOL_PROBLEM="会话树的池是软链（指向 $(readlink "$pool")），应为**真目录**（官方 PREPARE_DIRECTORY 的产物形状）"
      return 1
    fi
    if [ ! -d "$pool" ]; then
      POOL_PROBLEM="不是目录"
      return 1
    fi
    gi="$pool/.gitignore"
    if [ ! -f "$gi" ]; then
      POOL_PROBLEM="真目录但缺 .gitignore（内容应为 '*'）—— 内层树会被会话树的 git status 当成未跟踪"
      return 1
    fi
    # 只认「内容为 *」：`*` 后带换行是正常形态（echo 写的），空白一律折掉再比。
    if [ "$(tr -d '[:space:]' <"$gi" 2>/dev/null || true)" != "*" ]; then
      POOL_PROBLEM="真目录但 .gitignore 内容不是 '*'（实际：$(head -c 60 "$gi" 2>/dev/null | tr '\n' ' ')）"
      return 1
    fi
    return 0
  fi

  # ── 形态 A：主检出 ⇒ 必须是指向 $WT_ROOT 的软链（ISS-696，一行不删）────────
  want="$(cd "$WT_ROOT" 2>/dev/null && pwd -P || printf '%s' "${WT_ROOT%/}")"
  if [ ! -L "$pool" ]; then
    POOL_PROBLEM="不是软链，而是$([ -d "$pool" ] && echo '真目录' || echo '普通文件')"
    return 1
  fi
  got="$(cd "$pool" 2>/dev/null && pwd -P || true)"
  if [ "$got" != "$want" ]; then
    POOL_PROBLEM="软链指向 $(readlink "$pool")，归一后 ${got:-<解析不出来：目标缺失>}（期望 ${want}）"
    return 1
  fi
  return 0
}

# 池目录的修法（doctor 与 adopt 共用一份，防两处措辞漂移）。
# ISS-870：两形态各给一条 —— 会话树的正确修法是「建成真目录 + `*`」，不是「删掉改软链」
#   （后者会把内层工单树挪到共享的 $WT_ROOT 下，与「第二级归属会话树」直接矛盾）。
pool_fix_cmd() {
  if is_session_tree; then
    printf 'mkdir -p %s/.agents/worktrees && printf "*\\n" > %s/.agents/worktrees/.gitignore' "$REPO" "$REPO"
  else
    printf 'rm -f %s/.agents/worktrees && ln -s "%s" %s/.agents/worktrees' "$REPO" "$WT_ROOT" "$REPO"
  fi
}


# ISS-385：体检——① 插件 symlink 是否悬空（会直接导致 3210 起不来）
#          ② 是否有插件被切到工作树（切过忘切回的现场）③ 3210 是否在听
#          ④ ISS-418 工作树里有没有指向主 checkout 的 dist 写穿软链。
# 悬空 → exit 2（供收工/定时体检调用）。
cmd_doctor() {
  # ISS-529：`--artifacts` 打印各包 client 产物的时间线（人判；默认不查，避免假警）
  if [ "${1:-}" = "--artifacts" ]; then ARTIFACTS=1; shift; fi
  echo "── 工作区体检 ─────────────────────────────"
  local rc=0 dangling="" moved=""
  while IFS=$'\t' read -r name target kind; do
    [ -n "$name" ] || continue
    if [ "$kind" = "dangling" ]; then
      dangling="$dangling $name"
    else
      moved="$moved $name"
    fi
  done <<EOF
$(links_report)
EOF
  if [ -n "$dangling" ]; then
    c_err "插件 symlink 悬空（3210 会起不来：Cannot find package）：${dangling# }"
    c_err "  修复：bash $0 link main"
    rc=2
  else
    c_ok "插件 symlink 无悬空（$(ls "$PROFILES_NM" 2>/dev/null | grep -c '^forge-' || echo 0) 个已挂载插件）"
  fi
  # ISS-696（洞1）+ ISS-870：池目录漂移 —— 按 $REPO 是主检出还是会话树分两形态：
  #   主检出：① `.agents/worktrees` 不是指向 `$WT_ROOT` 的软链（丢了 / 被换成真目录 / 指错地方）；
  #           ② 它已是**真目录且下面有子目录** —— 洞1 已经发生后的形态：官方树落进了仓内、
  #              而所有按 `$WT_ROOT` 扫描的脚本（status / wt-scan / ai-review.sh）看不见它。
  #   会话树：真目录 + `.gitignore:'*'` 才是合规（内层工单树本来就该落在会话树里）。
  if pool_link_problem; then
    if is_session_tree; then
      c_ok "池目录合规（会话树形态）：.agents/worktrees 是真目录 + .gitignore:'*'"
    else
      c_ok "池目录是软链：.agents/worktrees → $WT_ROOT"
    fi
  else
    c_err "池目录**漂移**：.agents/worktrees ${POOL_PROBLEM}"
    if is_session_tree; then
      c_err "  后果：内层工单树没被 .gitignore 忽略 ⇒ 会话树 status 永久显示未跟踪 ⇒ 删树判断失真"
    else
      c_err "  后果：官方 create_worktree 取落点走 realpath，靠这条软链才落在 ${WT_ROOT}；"
      c_err "        软链不在时官方不报错、自己建真目录 ⇒ 树静默落进仓内，扫描器全盲"
    fi
    c_err "  修复：$(pool_fix_cmd)"
    rc=2
  fi
  # 「仓内真目录 + 下面已有子目录」这一条**只对主检出成立**：会话树的池本来就装内层树，
  # 有子目录是它的正常形态（ISS-870）。不加这个排除，二级形态一上线就恒红。
  if ! is_session_tree && [ -d "$REPO/.agents/worktrees" ] && [ ! -L "$REPO/.agents/worktrees" ]; then
    local _pool_stray
    _pool_stray="$(find "$REPO/.agents/worktrees" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -5)"
    if [ -n "$_pool_stray" ]; then
      c_err "仓内 .agents/worktrees 是真目录且下面已有子目录（官方树可能落到仓内、扫描器看不见）："
      printf '%s\n' "$_pool_stray" | sed 's/^/  · /'
      c_err "  处置：确认这些树是否在 \`git -C $REPO worktree list\` 里，再用 ws.sh adopt/rm 迁移或回收"
      rc=2
    fi
  fi
  # ISS-550（审查轮 R1）：**主检出 HEAD 守卫是否真的装上了**。
  # 为什么必须探：`core.hooksPath` 是**本仓局部配置、不进版本库**（新克隆 / 电脑2 都不会有），
  # 而钩子文件本身在版本库里 ⇒「文件在、闸没装」这种状态**没有任何东西会报**，守卫静默失效
  # （守卫无牙却不报警 = 假绿）。这里把它变成一条看得见的判据。
  # ⚠️ 复核轮 R2：`core.hooksPath` 允许写**绝对路径**（git 合法、钩子照常生效）⇒ 判据要比
  #   **解析后的目录**，不能比字符串，否则把装好的闸报成"没装"（误报比不报还坏）。
  local hp hp_real want_real
  hp="$(git -C "$REPO" config --get core.hooksPath 2>/dev/null || true)"
  hp_real=""; want_real=""
  [ -n "$hp" ] && hp_real="$(cd "$REPO" 2>/dev/null && cd "$hp" 2>/dev/null && pwd -P)" || true
  [ -d "$REPO/scripts/git-hooks" ] && want_real="$(cd "$REPO/scripts/git-hooks" && pwd -P)" || true
  if [ -n "$hp_real" ] && [ "$hp_real" = "$want_real" ] && [ -x "$REPO/scripts/git-hooks/reference-transaction" ]; then
    c_ok "主检出 HEAD 守卫已装（core.hooksPath=$hp · reference-transaction 可执行）"
  else
    c_err "主检出 HEAD 守卫**没装**：core.hooksPath='${hp:-未设置}'（应指向 scripts/git-hooks）"
    c_err "  修复：git -C $REPO config core.hooksPath scripts/git-hooks   # 每条克隆/每台机器各设一次"
    rc=2
  fi
  # ISS-529（2026-09-16 实测踩中）：**产物新鲜度** —— 只在 `doctor --artifacts` 下报，且**不做自动判定**。
  #
  # 为什么默认不查、也不自动判"落后"：`dist/client.js` 是构建物、**不入库**，跨工作树合并后主 checkout
  # 的产物仍是旧的（引擎服务的正是它）→ 症状 = 代码/测试全绿但**页面看不到改动**（本轮真实踩中）。
  # 但"dist mtime vs 最后一次改 src 的提交时间"这个判据会**常报假警**：正常流程是"先构建、再提交"
  # （实测 forge-browser/forge-pm/forge-session-b 等全被误报）。精确判定需要重新构建后比字节，
  # 太贵 —— 故这里只把两个时间摆出来，**由人判**（agent 也读得到）。
  if [ "${ARTIFACTS:-0}" = "1" ]; then
    echo "── client 产物新鲜度（人判：构建通常发生在提交之前，故"dist 早于提交"不一定是落后）──"
    local _pkg _name _dist _ct
    for _pkg in "$REPO"/forge-*/; do
      _name="$(basename "$_pkg")"
      _dist="$_pkg/dist/client.js"
      [ -f "$_dist" ] || continue
      _ct="$(git -C "$REPO" log -1 --format=%ct -- "$_name/src" 2>/dev/null || echo 0)"
      printf "  %-16s dist %s   最后改 src 的提交 %s\n" "$_name" \
        "$(date -r "$(stat -f %m "$_dist")" '+%m-%d %H:%M')" \
        "$([ "${_ct:-0}" -gt 0 ] && date -r "$_ct" '+%m-%d %H:%M' || echo '-')"
    done
    echo "  若刚改过某个包的 client：在主 checkout 跑 cd <包> && bun run build:client，然后刷新页面"
  fi

  if [ -n "$moved" ]; then
    c_warn "以下插件仍指向工作树（验证完记得切回）：${moved# }"
    # ISS-416：标出「在途租约保护」的包——裸 `link main` 会跳过它们（防并发会话互相踩踏）
    local n2 t2 o2
    while IFS=$'\t' read -r n2 t2 _k; do
      [ -n "$n2" ] || continue
      o2="$(worktree_iss_of_link "$t2")"
      if lease_held_by "$o2"; then
        c_warn "  · $n2 → ${o2}（该单持有在途租约：裸 link main 会跳过它，确要强切加 --all）"
      fi
    done <<EOF
$(links_report)
EOF
    c_warn "  切回：bash $0 link main"
  fi
  # 依赖声明了但没装（ISS-512 家族第 3 次：抽包/合并后忘了 bun install → **引擎加载那一刻**才炸
  #   `Cannot find package 'X' imported from <pkg>/lib/…`，watchdog 反复拉起失败）。
  #   这里在体检期就把缺口列出来（只告警，不 exit 2：主 checkout 可能正被别的会话安装）。
  local pkgname dep miss=""
  if [ -d "$REPO" ]; then
    for pkgname in $(ws_names_of "$REPO"); do
      local pj="$REPO/$pkgname/package.json"
      [ -f "$pj" ] || continue
      for dep in $(/usr/local/bin/node -e '
        const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
        for(const k of ["dependencies","devDependencies"])for(const d of Object.keys(j[k]||{})){
          if(!d.startsWith("forge-") && !d.startsWith("@deepseek-ai/dsh") && d!=="@deepseek-ai/dsh-tools") continue;
          console.log(d);} }catch{}' "$pj" 2>/dev/null); do
        [ -e "$REPO/$pkgname/node_modules/$dep" ] || miss="$miss $pkgname/$dep"
      done
    done
  fi
  if [ -n "$miss" ]; then
    c_warn "以下「已声明但未安装」的依赖会让引擎加载失败（Cannot find package）：${miss# }"
    c_warn "  修复：cd $REPO && bun install（缺的是包级 node_modules → bun 不 hoist）"
  fi
  if lsof -tiTCP:3210 -sTCP:LISTEN >/dev/null 2>&1; then
    c_ok "3210 在听"
  else
    c_warn "3210 无监听（看 ~/.dsh-matter/watchdog.log 与 ~/.dsh-matter/matter.log；⚠️ ISS-558：老盘 ~/.dsh/watchdog.log 已停更 09-30、web.log 停 09-30 09:55）"
  fi
  # ISS-418：写穿入口（工作树里指向主 checkout 的 dist 软链）——不告警就会静默污染线上产物
  local wt_links
  wt_links="$(write_through_report)"
  if [ -n "$wt_links" ]; then
    local cnt
    cnt="$(printf '%s\n' "$wt_links" | grep -c . || true)"
    c_err "发现 $cnt 个 dist 写穿软链（工作树里指向主 checkout 的产物）：在此工作树里 build 会覆盖主 checkout 产物！"
    printf '%s\n' "$wt_links" | sed 's/^/  · /'
    c_err "  修复：rm 掉这些软链后改用复制（scripts/dev-instance.sh 已改为 cp，ISS-418）"
    rc=2
  fi
  # ── ISS-504 判据：主 checkout 的 .bin 有没有悬空软链（写入穿的后果）────────────
  # 为什么放在 doctor 而不是只靠 mirror_bin_dir：旧式 `.bin` 整目录软链在**过去**建的树里还在，
  #   而那些树里的 `bun add` 已经发生过 —— 伤害留在主检出上，只有在这里扫得出来。
  # 判据是机器可判的两件事：是软链 ∧ 目标不存在。不是嘱托。
  local dbins dbincnt
  dbins="$(dangling_bin_list)"
  if [ -n "$dbins" ]; then
    dbincnt="$(printf '%s\n' "$dbins" | grep -c . || true)"
    c_err "主 checkout 的 .bin 有 ${dbincnt} 条悬空软链（工作树里 bun add 写穿过来的，ISS-504）："
    printf '%s\n' "$dbins" | head -10 | sed 's/^/  · /'
    [ "${dbincnt:-0}" -gt 10 ] && c_err "  …（还有 $((dbincnt - 10)) 条）"
    c_err "  成因：该工作树的 node_modules/.bin 是指向主检出的**整目录软链**，bun 写入时穿了过来"
    c_err "  处置：① 先确认挂掉的那条 bin 现在没人正用；② rm 掉悬空链接；"
    c_err "        ③ 给肇事工作树补跑 bash $0 deps <ISS-NNN>（新版会把 .bin 迁成真目录）"
    rc=2
  else
    c_ok "主 checkout 的 .bin 无悬空软链"
  fi
  # ISS-498：工作树缺"根 node_modules"软链 → 该树里 forge-ui typecheck **假红**
  #   （TS2307 Cannot find module 'forge-design'；而 bun test 是全绿的，极易误判成代码坏了）。
  # ISS-510：升级为**跨树解析检测** —— 依赖若按主 checkout 解析，改动验不出来（**假绿**），
  #   比假红更危险。老式「整目录软链」的工作树会在这里被点名，并给出迁移命令。
  local root w stale="" cross="" bin_wt=""
  if [ -d "$REPO/node_modules" ]; then
    for root in "$WT_ROOT" "$REPO/.wt" "$REPO/.tmp/wt"; do
      [ -d "$root" ] || continue
      for w in "$root"/*/; do
        [ -d "$w" ] || continue
        local nm="${w}node_modules" n pnm name
        name="$(basename "$w")"
        if [ ! -e "$nm" ] || [ -L "$nm" ] \
           || [ "$(cd "$nm" 2>/dev/null && pwd -P)" = "$REPO/node_modules" ]; then
          stale="$stale $name"
          continue
        fi
        # 包级 node_modules 也要查：老式整目录软链 **按主 checkout 解析** → 假绿
        for n in $(ws_names_of "${w%/}"); do
          [ -d "${w}${n}" ] || continue
          pnm="${w}${n}/node_modules"
          [ -L "$pnm" ] && { stale="$stale $name/$n"; continue; }
        done
        # ── ISS-504：`.bin` 整目录软链 = 写穿通道（该树里 bun add 会写进主检出）──────
        # 判据与 root 级不同：root 的 node_modules 是真目录（依赖镜像），但 `.bin` 若是软链，
        # 写入照样穿到主检出。单独查这一格，因为修复动作也不同（deps 会就地迁成真目录）。
        if [ -L "$nm/.bin" ]; then
          bin_wt="$bin_wt $name"
        fi
        for n in $(ws_names_of "${w%/}"); do
          [ -d "${w}${n}" ] || continue
          [ -e "$nm/$n" ] || continue
          rp="$(cd "$nm" && cd "$n" 2>/dev/null && pwd -P)"
          # 同样两侧归一（见 is_ws_link 的 macOS /var → /private/var 注记）
          [ "$rp" = "$(cd "${w%/}/$n" 2>/dev/null && pwd -P)" ] || cross="$cross $name/$n"
        done
      done
    done
  fi
  if [ -n "$stale" ]; then
    c_warn "以下工作树的依赖是「整目录软链/缺失」（该树里 workspace 包按主 checkout 解析 = **假绿**：改了包也验不出来）"
    c_warn "  树：${stale# }"
    c_warn "  修复：bash $0 deps <ISS-NNN>（改成依赖镜像，workspace 链接指向本工作树）"
  fi
  if [ -n "$cross" ]; then
    c_err "以下 workspace 链接**跨树**（解析到主 checkout，改动不会被验证）：${cross# }"
    c_err "  修复：bash $0 deps <ISS-NNN>"
    rc=2
  fi
  # ISS-504：`.bin` 整目录软链 —— 写穿通道（该树里 bun add 会改主 checkout）
  # ⚠️ 这里**只告警不判红**：全仓 60+ 棵历史树都是这个形态（改动前建的），判红 = doctor 恒红 =
  #   没人再看 doctor（与 gate-fast 头注同口径：长红的门禁等于没有门禁）。
  #   真伤害由上面那条判据（主检出悬空软链 ⇒ rc=2）抓 —— 那里红了才是"已经写穿了"。
  if [ -n "$bin_wt" ]; then
    c_warn "以下工作树的 node_modules/.bin 是**整目录软链**（潜在写穿：该树里 bun add 会写进主 checkout，ISS-504）"
    c_warn "  树：${bin_wt# }"
    c_warn "  → 不判红的理由：这是历史形态、不是已发生的伤害；真伤害见上面「主 checkout 悬空软链」那条"
    # Lead 2026-11-07 补的一条：黄档必须说清「我现在没事，但什么动作会让它变红」——
    #   只说「潜在风险」而不给触发条件，读者无法判断能不能继续在这棵树里干活。
    c_warn "  ⚠️ 现在**还没坏**，但下面任一动作会让它当场变红（判据见上一条）："
    c_warn "     ① 在这棵树里跑 \`bun add <包>\` / \`bun install\` 装新依赖"
    c_warn "        → bun 往 .bin 写条目 ⇒ 穿到主 checkout ⇒ 主检出多一条悬空软链 ⇒ doctor/guard rc=2"
    c_warn "        （悬空 = 目标只在工作树存在；不报错、不挡 merge，只在调用那一刻炸）"
    c_warn "     ② 在这棵树里 \`bun run <脚本>\` 而该脚本的 bin 是本树新装的（同上路径）"
    c_warn "  ✅ 安全动作：只读代码、跑已有依赖的 bun test / tsc —— 不写 .bin 就不会穿"
    c_warn "  🔧 一次修掉：bash $0 deps <ISS-NNN>（就地迁成真目录 + 逐条目软链，之后 bun add 只落本树）"
  fi
  exit "$rc"
}

# ISS-385：删工作树的收口命令——**删之前强制把插件切回 main**（真实事故的根因就是漏了这步：
# 链接指向被删工作树 → 悬空 → 运行中的进程看不出来，下一次重启 3210 直接起不来）。
# ISS-652 补强（2026-09-20 事故）：**销毁前先保全**。
# 事故：批量清理工作树时，带未提交改动的那棵被 `--force` 连改动一起销毁 ——
#   `git worktree remove --force` 之后，**未提交的改动在 git 里没有任何痕迹可挖**
#   （不是 commit、不是 stash、index 也随管理目录一起清掉），实测 ISS-523 那 3 个文件无从找回。
# 所以：只要树上还有未提交内容，动它之前先把「能救的都写到盘上」——补丁 + 未跟踪打包 + 清单。
# 位置在仓库外（`~/.dsh/worktree-salvage/`），避免污染 git 状态；纯文本，人可直接看/`git apply` 回去。
SALVAGE_ROOT="${SALVAGE_ROOT:-$HOME/.dsh/worktree-salvage}"

salvage_worktree() {
  local iss="$1" path="$2"
  local ts dst
  ts="$(date +%Y%m%d-%H%M%S)"
  dst="$SALVAGE_ROOT/$ts-$iss"
  mkdir -p "$dst" || return 1
  {
    echo "worktree : $path"
    echo "branch   : $(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    echo "HEAD     : $(git -C "$path" rev-parse HEAD 2>/dev/null)"
    echo "last     : $(git -C "$path" log -1 --format='%h %cs %s' 2>/dev/null)"
    echo "saved_at : $(date -Iseconds)"
    echo
    echo "--- status --porcelain ---"
    git -C "$path" status --porcelain 2>/dev/null
  } > "$dst/MANIFEST.txt"
  git -C "$path" diff > "$dst/unstaged.patch" 2>/dev/null || true
  git -C "$path" diff --cached > "$dst/staged.patch" 2>/dev/null || true
  local unt
  unt="$(git -C "$path" ls-files --others --exclude-standard 2>/dev/null)"
  if [ -n "$unt" ]; then
    printf '%s\n' "$unt" > "$dst/untracked.list"
    ( cd "$path" && printf '%s\n' "$unt" | tar -czf "$dst/untracked.tar.gz" -T - ) 2>/dev/null || true
  fi
  c_ok "已保全未提交内容 → $dst"
  c_warn "  （未跟踪文件若在 untracked.tar.gz 里，解包即得；改动可用 git apply 回填）"
  return 0
}

# ISS-873：rm 的反方向 —— 常规落点找不到树时，看登记表里有没有它的行。
# 三种形态都不许静默：
#   · 行指向的树仍在盘上（非常规落点，如会话树池里的二级树）⇒ 报出在哪，行不动
#     ——清了行就造出一条「指向活树的谎行」，比陈旧行更坏；
#   · 行指向的树也不在了 ⇒ 陈旧行：报出并提示清理（甲方案原文是「报」，不替人猜），清理加 --force；
#   · 没有行 ⇒ 什么都不说（回到调用方原来的「找不到工作树」）。
# 返回 0 = --force 已把陈旧行清掉（这就是本次 rm 能做的全部事，调用方就此收工 exit 0）；
# 返回 1 = 没清任何东西（该说的话本函数已说完，调用方继续走「找不到工作树」exit 1）。
rm_orphan_row() {
  local iss="$1" force="$2" cas_out cas_rc=0 row_path
  cas_out="$(trees_registry_cas check "$iss" "" "" "" 2>&1)" || cas_rc=$?
  case "$cas_rc" in
    0) return 1 ;;                  # 无行 —— 不是本函数的事
    3) : ;;                         # 有行，往下判
    4) c_err "登记表读不动 ⇒ 查不了残留行（判不了 ≠ 没有）：${cas_out#UNREADABLE }"
       c_err "  → 修好 $(trees_registry_path) 再来 rm"
       return 1 ;;
    *) c_err "登记表检查失败（无法解析输出）：${cas_out:-<空>}"; return 1 ;;
  esac
  row_path="$(printf '%s' "${cas_out#EXISTS }" | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("path",""))
except Exception: print("")' 2>/dev/null || true)"
  if [ -n "$row_path" ] && [ -d "$row_path" ]; then
    c_warn "常规落点没有 ${iss} 的树，但登记行指向 ${row_path}（仍在盘上）—— 树在非常规落点，行不动"
    c_warn "  → 要收那棵树：git -C \"$REPO\" worktree remove --force '${row_path}'，或先 cd 过去确认内容"
    return 1
  fi
  if [ "$force" != "1" ]; then
    c_warn "${iss} 的树已不在盘上，登记表里仍留着它的行${row_path:+（指向 ${row_path}）}—— 收树后没删行的残留"
    c_warn "  → 确认清理登记行：bash $0 rm ${iss} --force"
    return 1
  fi
  local out rc=0
  out="$(trees_registry_cas remove-stale "$iss" "" "" "" 2>&1)" || rc=$?
  case "$rc" in
    0) case "$out" in
         REMOVED*) c_ok "已清理陈旧行：${iss}（树已不在盘上）" ;;
         *)        c_warn "登记行已不在（刚被别的进程清掉）：${iss}" ;;
       esac
       return 0 ;;
    3) c_warn "登记行指向的树又在盘上了（${out#LIVE }）⇒ 行不动 —— 先收那棵树" ;;
    4) c_err "登记表读不动 ⇒ 陈旧行没清成（手工核对 $(trees_registry_path)）：${out#UNREADABLE }" ;;
    # review-2244：同 ②b —— CAS 崩在 0/3/4 之外时不得静默（上游 check 已拦坏表的大部分射程，这里消除窄射程）。
    *) c_err "登记表检查失败（无法解析输出）：${out:-<空>}" ;;
  esac
  return 1
}

cmd_rm() {
  local iss="${1:-}"; shift || true
  local force=0
  for a in "$@"; do if [ "$a" = "--force" ]; then force=1; fi; done
  if [ -z "$iss" ]; then c_err "用法: ws.sh rm <ISS-NNN> [--force]"; exit 1; fi
  # ⚠️ 归属检查必须排在删任何东西**之前**（2026-10-03 自查）：原来只有末尾第④步释放租约，
  #    一旦它被持有者校验拒掉，树和分支**已经删完了**，留下的正是"锁指向已删目录"那种形状
  #    （今天实测：ISS-547 分支已合并、树不在、锁还挂着 —— 就是这么来的）。
  if [ -f "$LOCK_FILE" ]; then
    local rlreason; rlreason="$(lock_stale_reason)"
    if [ "$rlreason" = "unreadable" ]; then
      # 第三轮审查实测：原来这里也用 `lock_field iss` 比单号 —— 坏 JSON 取到空串 ⇒ 判断为假 ⇒
      # 一路删干净并打「✓ 收工完成」，而锁原地不动。读不出时**什么都别删**。
      c_err "不删：锁文件在但读不出（${LOCK_FILE}）⇒ 判断不出这块地是不是你的"
      c_err "  → 注意锁上记的可能是**另一张单**：先 ws.sh status 看清、或把文件修好，再回来 rm"
      home_split_note
      exit 3
    fi
    if [ -f "$LOCK_FILE" ] && [ ! -w "$LOCK_FILE" ] && [ "$(lock_field iss)" = "$iss" ]; then
      # 释放是收口的最后一步。这里不预检，就会出现"树删了、锁写不进"的半截态（第四轮 M-N2 实测）。
      c_err "不删：租约锁写不进去（${LOCK_FILE} 不可写）⇒ 现在删完就一定留半截"
      c_err "  → 先修权限/磁盘（或在能写的机器上收），再来 rm"
      exit 3
    fi
    if [ "$(lock_field iss)" = "$iss" ] && [ "$force" != "1" ] && ! lock_expired && ! lease_is_mine "$iss"; then
      c_err "不删：${iss} 的租约握在「$(lock_field owner)」手里（你自报「${WS_OWNER:-<未署名>}」，当前分支也推不出这张单）"
      c_err "  → 先跟持有者确认；确要收：ws.sh rm ${iss} --force（树、分支、链接、租约一起收，不留半截）"
      home_split_note
      exit 3
    fi
  fi
  local path
  if [ -d "$WT_ROOT/$iss" ]; then path="$WT_ROOT/$iss"
  elif [ -d "$REPO/.wt/$iss" ]; then path="$REPO/.wt/$iss"
  else
    # ISS-873 反方向：常规落点没有树，但登记表里可能还留着它的行（收树后没删行的残留）。
    if rm_orphan_row "$iss" "$force"; then
      exit 0   # --force 已把陈旧行清掉 —— 这就是本次 rm 能做的全部事
    fi
    c_err "找不到工作树：$iss"
    exit 1
  fi

  local dirty
  dirty="$(git -C "$path" status --porcelain 2>/dev/null)"
  # WS_IGNORE_BUILD_ARTIFACTS=1（仅供 cmd_prune 用）：剔除**每次构建都会变**的产物，
  # 否则 prune 判"可删"、rm 判"有改动"，两边矛盾，一个都删不掉（2026-10-19 实测：
  # forge-cad/static/vendor/cad-engine.js 在 30 个工作树里全是脏的，导致 prune 全失败）。
  # 默认**不设**该变量 ⇒ rm 的严格语义不变，人工 rm 仍会因任何改动而拒绝。
  if [ "${WS_IGNORE_BUILD_ARTIFACTS:-0}" = "1" ]; then
    # 不用「无条件放行」那种写法：`set -o pipefail` 下 grep 无匹配返回 1 会掐断脚本，
    # 但把「无匹配」与「grep 自身出错(2)」混为一谈会吞掉真故障。这里显式区分。
    local filtered
    if filtered="$(printf '%s\n' "$dirty" | grep -v 'forge-cad/static/vendor/' | grep -v '^$')"; then
      dirty="$filtered"
    else
      [ $? -le 1 ] && dirty="$filtered" || { c_err "剔除构建产物失败（grep 异常）"; exit 3; }
    fi
  fi
  if [ -n "$dirty" ] && [ "$force" != "1" ]; then
    c_err "工作树有未提交改动：${path}（确认要丢弃加 --force）"
    printf '%s\n' "$dirty" | head -5
    c_warn "若确实不要了：bash $0 rm $iss --force（会先把改动保全到 $SALVAGE_ROOT/，不会静默销毁）"
    exit 3
  fi
  # ISS-652 补强：带改动 + --force ⇒ 先保全再销毁（这次事故就是少了这一步）
  if [ -n "$dirty" ] && [ "$force" = "1" ]; then
    salvage_worktree "$iss" "$path"
  fi

  # ① 先回收「指向本工作树」的链接：这一步是防悬空的关键，失败就直接中止（宁可留着工作树）。
  #    ISS-416：这里**只回收自己这一片**——旧的 `cmd_link main` 是全量扫射，会踩掉别人在途的验证现场。
  if [ -d "$PROFILES_NM" ]; then
    c_warn "先把指向本工作树的插件切回 main（防悬空链接）"
    relink_back_from_path "$path"
  fi
  # ② 删工作树
  #    ⚠️ ISS-873 自测 R2 抓到的旧隐患：原写法 `git … remove --force && c_ok` 里，`&&` 把 git 的
  #    失败当「被测试」吞掉（set -e 对 `A && B` 的左支 A 不触发），脚本继续往下走 —— 树还在盘上，
  #    后面却照常删分支、打「收工完成」exit 0。改成显式 if：删树失败 ⇒ 就地 exit 3，
  #    登记行与分支都不动（原子性：要么都成，要么都不动）。
  if git -C "$REPO" worktree remove "$path" --force; then
    c_ok "已删工作树：$path"
  else
    c_err "删工作树失败：${path} —— 树还在盘上 ⇒ 登记行与分支都不动（不许半截收工），修好后重跑"
    c_err "  → 常见原因：树被 git worktree lock 锁住（先 git -C \"$REPO\" worktree unlock '$path'），或该目录已不是注册的工作树（先 git worktree prune）"
    exit 3
  fi
  # ②b（ISS-873）删树成功 ⇒ 同步删 .agents/trees.json 的登记行（补上「写一半、删一半」的另一半）。
  #   原子性：本步排在删树**成功**之后 —— ② 失败已就地 exit 3，登记行原样不动；
  #   防删错行：CAS 在锁内把该行的 path 与刚删的这棵树归一比对（软链形态的行在树删掉之后
  #             整条 realpath 解不出叶子，故只 resolve dirname），对不上 ⇒ 行保留并出声；
  #   无行 ⇒ 静默（`new` 建的存量平级树本来就不登记，不误报）。
  local reg_out reg_rc=0
  reg_out="$(trees_registry_cas remove "$iss" "$path" "" "" 2>&1)" || reg_rc=$?
  case "$reg_rc" in
    0) case "$reg_out" in
         REMOVED*) c_ok "已删登记行：${iss}（$(trees_registry_path)）" ;;
         *) : ;;   # ABSENT：本来就没登记（`new` 的存量平级树），无事可报
       esac ;;
    3) c_warn "登记行 ${iss} 指向的不是刚删的这棵树（${reg_out#MISMATCH }）⇒ 行保留（防删错行）" ;;
    4) c_warn "登记表读不动 ⇒ 登记行没删成，修好后清残留：bash $0 rm ${iss} --force（树已不在，走反方向清理）"
       c_warn "  读不动原因：${reg_out#UNREADABLE }" ;;
    # review-2244：CAS 崩在 0/3/4 之外（如登记表是「合法 JSON 非对象」，python 在 data.get 上
    # exit 1）时曾在这里被静默吞掉 ⇒ rm 打「收工完成」exit 0、对坏表零提示。判不了 ≠ 没有，必须出声。
    *) c_err "登记表检查失败（无法解析输出）⇒ 登记行没删成：${reg_out:-<空>}"
       c_err "  → 修好 $(trees_registry_path) 后清残留：bash $0 rm ${iss} --force（树已不在，走反方向清理）" ;;
  esac
  # ③ 删分支（未合并会被 git 拒绝——这正是我们想要的保护）
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/$iss"; then
    if git -C "$REPO" branch -d "$iss" >/dev/null 2>&1; then
      c_ok "已删分支 ${iss}（已合并）"
    else
      c_warn "分支 ${iss} 未合并，保留（确认不要了：git branch -D ${iss}）"
      c_warn "  建议先打永久标记再决定：git -C $REPO branch archive/${iss}-$(date +%Y%m%d) ${iss}"
    fi
  fi
  # ④ 若租约属于本单 → 释放
  local rm_fail=0
  if [ -f "$LOCK_FILE" ] && [ "$(lock_field iss)" = "$iss" ]; then
    local force_arg=""
    [ "$force" = "1" ] && force_arg="--force"
    # 放在子壳里跑：cmd_release 内有 exit 1/3 的分支，直调会把 rm 停在半截。
    # `--force` 必须一起传下去 —— 第三轮实测 `rm <别人单> --force` 删完树后被里层拒掉，
    # 留下"锁指向已删目录"的半截态，而外层还打「✓ 收工完成」并 rc=0。
    if ( cmd_release "$iss" $force_arg ); then
      c_ok "已释放本单租约"
    else
      c_err "树收了但租约没释放 ⇒ 补一步：ws.sh release ${iss} --force"
      rm_fail=1
    fi
  fi
  if [ "$rm_fail" = "1" ]; then
    c_err "收工未完成：租约没收干净（树与分支已删，缺最后一步，别让下一步以为干净了）"
    exit 3
  fi
  c_ok "收工完成。验证：bash $0 doctor"
}

# 守卫（ISS-330）：主 checkout 必须①停 main ②无他人暂存 ③无未过期租约。违规退出码 2。
#
# ISS-537 增补 ②：2026-09-17 实测——另一个会话在主 checkout 上改并**暂存**了文件，
# 结果我的 `git merge` 被 git 直接拒绝（"Your local changes would be overwritten"），
# 而发现时机是「merge 报错」= 事后发现。收工/体检这一层要把它变成**事前**发现：
# 主 checkout 出现 staged 文件即视为「有他人在途」，exit 2。
# 豁免：merge/rebase 进行中（我自己正在收口，暂存是过程态）。
cmd_guard() {
  local drift=0
  # --fast 透传给 guard-baselines.sh（快档：跳守卫自检与只报不红档，能判红的格不少）；其余参数不认识就拒 ——
  # 拼错的参数静默吞掉 = 以为跑了快档其实跑了全量（或反之），两种都比报错贵。
  local gb_args=()
  local g_arg
  for g_arg in "$@"; do
    case "$g_arg" in
      --fast) gb_args+=("$g_arg") ;;
      *) c_err "ws.sh guard：未知参数 ${g_arg}（支持：--fast）"; exit 1 ;;
    esac
  done
  local br
  br="$(cur_branch)"
  if [ "$br" != "main" ]; then
    c_err "主 checkout 停在 ${br}（应为 main）——若在途工作另有分支承接，请先 git switch main"
    drift=1
  fi
  if [ -e "$REPO/.git/MERGE_HEAD" ] || [ -d "$REPO/.git/rebase-merge" ] || [ -d "$REPO/.git/rebase-apply" ]; then
    c_warn "检测到 merge/rebase 进行中 —— 跳过「他人暂存」检查（收口过程态）"
  else
    local staged
    staged="$(git -C "$REPO" diff --cached --name-only 2>/dev/null || true)"
    if [ -n "$staged" ]; then
      c_err "主 checkout 有**暂存未提交**的文件（大概率是另一个会话在途）："
      while IFS= read -r f; do [ -n "$f" ] && c_err "      $f"; done <<< "$staged"
      c_err "  → 是别人的改动：git restore --staged <file>（只动索引，不删文件）"
      c_err "  → 是自己的改动：先按单号提交，再收工"
      drift=1
    fi
    # ── ISS-599：其余脏文件（'??' 未跟踪 / ' M' 已改未暂存）**只报不红** ──────────────
    # 为什么判红只到 staged 为止：上面那条的来历是 2026-09-17 事故 ——「会话 B 在主 checkout
    #   `git add` 一份报告 ⇒ 会话 A 的 `git merge` 被 git 拒绝」（docs/memory/
    #   multi-agent-isolation-2026-09-17.md:12）⇒ 症结是 **staged 会挡住 merge**。
    #   而 '??' / ' M' **不挡 merge**，且主 checkout 上常有别人**正当**的在途改动
    #   ⇒ 判红会误伤正在干活的人（护栏变噪音，人就学会无视它）。
    # 但完全不报也是错的：2026-10-07 实测主 checkout 积压 **98 个**这类文件且长期无人发现
    #   （46 '??' + 51 ' M'，跨多个会话）—— 旧判据对「造一个未跟踪文件」的实验**零反应**。
    #   ⇒ 本节把它们**报出来**（计数 + 分档 + 最多 8 条样例 + 处置指引），让堆积可见，
    #     但**不计入 drift**（drift 仍只由上面的 staged 与其它硬判据置位）。
    # 档案：ISS-599（本节的来源）。
    local other_list other_n n_untracked n_modified
    other_list="$(git -C "$REPO" status --porcelain 2>/dev/null | grep -E '^(\?\?| M)' || true)"
    other_n="$(printf '%s' "$other_list" | grep -c . || true)"
    if [ "${other_n:-0}" -gt 0 ]; then
      n_untracked="$(printf '%s\n' "$other_list" | grep -c '^??' || true)"
      n_modified="$(printf '%s\n' "$other_list" | grep -c '^ M' || true)"
      c_warn "主 checkout 另有 ${other_n} 个未提交文件（未跟踪 ${n_untracked} · 已改未暂存 ${n_modified}）—— **不判红**，仅提示："
      # 最多列 8 条（带 `git status --porcelain` 的状态码，便于一眼分流）
      printf '%s\n' "$other_list" | head -8 | while IFS= read -r line; do
        [ -n "$line" ] && c_warn "      ${line}"
      done
      [ "$other_n" -gt 8 ] && c_warn "      …（还有 $((other_n - 8)) 条，见 git status --porcelain）"
      c_warn "  → 处置：该入库的按单号提交；不该入库的加 .gitignore；调试/验证产物删掉。"
      c_warn "  → 为何不判红：这类文件不挡 merge，而主 checkout 常有别人正当的在途改动（判红会误伤）。"
      c_warn "  → 总脏文件数（含已暂存）：$(dirty_files | grep -c .)"
    fi
  fi
  if [ -f "$LOCK_FILE" ]; then
    local lreason
    lreason="$(lock_stale_reason)"
    case "$lreason" in
      unreadable)
        # 判据取不到就是现场坏了 —— 体检必须拦，不能像旧写法那样静默当"没人占"（fail-closed）
        c_err "租约锁读不出：${LOCK_FILE}（文件在但解析失败）⇒ 先看是否被截断，确认无人再 release --force"
        drift=1 ;;
      merged:*)
        # 只出声不判红：真凭据是 merge(<单号>) 提交，但仍可能有人在同一棵干净的树上准备接着干
        c_warn "租约疑似干完没收尾：${lreason#merged:}（有 merge(${lreason#merged:}) 提交且工作树干净）⇒ 确认后 ws.sh release ${lreason#merged:}" ;;
      merged+time:*)
        c_warn "租约已软到期且疑似干完没收尾：${lreason#merged+time:} ⇒ 确认后 ws.sh release ${lreason#merged+time:}" ;;
      released) : ;;
      time)
        c_warn "租约已软到期：$(lock_field iss) / $(lock_field owner)（人可能还在干，不判红）" ;;
      *)
        c_warn "租约在途：$(lock_field iss) / $(lock_field owner)（正常，仅提示）" ;;
    esac
  fi
  # 门禁体检（ISS-587 · ISS-800 改指新系统）：回归算 drift。牙长在这儿是因为体检是收工每次
  # 都跑的，而 merge-iss.sh 在决策 13 之后基本没人走。
  #
  # ⚠️ ISS-800：原来跑 `scripts/guard-baselines.sh`（105 格 shell 聚合器），该文件已随
  # 「门禁三套合一」退役 ⇒ 改指 `scripts/run-gates.mjs`（DSH 门禁系统，三态退出）。
  #
  # **这个 if 原来写成 `[ -f guard-baselines.sh ]`，文件删掉之后恒假 ⇒ 整段静默变空操作，
  # 人会以为「体检跑过了」。那正是今天反复出现的「静默假绿」形态（见 ISS-801）。
  # ⇒ 现在改成：**入口脚本不存在 = 判红（drift=1），绝不静默跳过。**
  local gates_js
  gates_js="$(dirname "$0")/run-gates.mjs"
  if [ ! -f "$gates_js" ]; then
    c_err "门禁体检跑不了：${gates_js} 不存在（入口脚本缺失 ⇒ 什么也没验，不当作通过）"
    drift=1
  else
    # 档位：--fast ⇒ fast 档（秒级，pre-commit 同档）；否则 full 档（全量，含所有 fast 格）。
    # 这两档都由 run-gates 自己定义，不再有「快档跳过哪些格」的本地名条。
    local g_tier="full"
    [ "${#gb_args[@]}" -gt 0 ] && g_tier="fast"
    # ISS-817：收工体检把 46 格逐包格（ci-typecheck-* / ci-test-*）一并跑掉。
    # 为什么挂在**这里**而不是 pre-push 全量：这 46 格约 94s（实测 `--only ci-`，10 并发），
    # 塞进每次 push 就是「慢到没人用」；而收工本来就要跑几分钟，多这一档不改变使用意愿。
    # ⚠️ 仍不是强制 —— `ws.sh guard` 靠人记得跑。真正被强制的是 pre-push 的 --with-ci
    #    （按改动面带**相关的那部分**）。两者一「全」一「勤」，不是替代关系。
    # `--with-ci` 的语义：本档原有格照跑，另把逐包格**全部**并进来（全量，不按改动面收窄 ——
    #    收工体检要的是「今天到底有没有坏」，不该被某一单的 diff 决定跑不跑）。
    # 关掉：WS_GUARD_CI=0 bash scripts/ws.sh guard（出声，不静默）。
    local g_ci_args=()
    if [ "${WS_GUARD_CI:-1}" = "1" ]; then g_ci_args=(--with-ci all); fi
    local g_rc=0
    node "$gates_js" --tier "$g_tier" ${g_ci_args[@]+"${g_ci_args[@]}"} >/tmp/ws-guard-baselines.txt 2>&1 || g_rc=$?
    if [ "$g_rc" -ne 0 ]; then
      # 0=全绿 / 1=有红或有未豁免的判不了 / 2=用法错。三态都要如实说清，含糊的报错会被当成噪声略过。
      case "$g_rc" in
        1) c_err "门禁有红或未豁免的「判不了」，详情 /tmp/ws-guard-baselines.txt（有意改动则刷新基线并在提交里说明）" ;;
        2) c_err "门禁入口用法错（exit 2），详情 /tmp/ws-guard-baselines.txt" ;;
        *) c_err "门禁体检异常退出（exit ${g_rc}），详情 /tmp/ws-guard-baselines.txt" ;;
      esac
      drift=1
    else
      # ⚠️ `|| true` 不是装饰：本脚本是 `set -euo pipefail`，grep 没匹配时返回 1，
      #    在 `local x="$(grep …)"` 里会直接把整个脚本杀掉（实测：绿档下 exit 1、零输出，
      #    看起来像「门禁炸了」，实际只是小结行没抓到）。
      local g_sum
      g_sum="$(grep -E '^[✓✗] .*绿 /' /tmp/ws-guard-baselines.txt | tail -1 || true)"
      c_ok "${g_sum:-门禁全绿} · ${g_tier} 档"
    fi
  fi

  # 装配面守卫（2026-10-17 甲案）：home 级自定义预设（`$DSH_HOME/cordis.patch.yml`，3210 在
  #   `~/.dsh-matter`）必须与官方 `standard` 预设逐行对账。背景：0.2.1 升级时官方删改插件行、
  #   删掉提示词变量 `cwd`，而 `preset-matter` 是照 0.2.0 手抄的 —— 全部门禁绿着，真机每轮
  #   运行失败。判定逻辑在 scripts/preset-parity-check.mjs（`--selftest` 用 fixture 独立验
  #   「该红必须红」）；退出码 3 = 不判（读不到 home patch / 官方预设），只提醒不判红。
  if [ -f "$(dirname "$0")/preset-parity-check.mjs" ]; then
    local prc
    # ⚠️ `set -e` 下 `cmd; prc=$?` 走不到第二行（脚本当场死，**它下面每一格都成了死代码**）——
    #   与下面 wt-scan 那处同一个坑。本单实测（ISS-614）：preset-parity 漂移时 exit 1，
    #   于是 guard 在「预设对账」这一格整段中断 ⇒ 退出码 1（本该是 2）、wt-scan / base 落后 /
    #   落地包门禁**全都没跑**，而输出只剩上面两条红 —— 报得少还看不出少了什么。
    node "$(dirname "$0")/preset-parity-check.mjs" >/tmp/ws-guard-preset.txt 2>&1 && prc=0 || prc=$?
    if [ "$prc" = "0" ]; then
      c_ok "$(grep -E '^✓ ' /tmp/ws-guard-preset.txt | head -1 | sed 's/^✓ //')"
      grep -E '^! ' /tmp/ws-guard-preset.txt | sed 's/^! //' | while IFS= read -r line; do c_warn "$line"; done
    elif [ "$prc" = "3" ]; then
      c_warn "预设对账不判：$(tail -1 /tmp/ws-guard-preset.txt)"
    else
      c_err "自定义预设与官方 standard 漂移（详情 /tmp/ws-guard-preset.txt）："
      grep -E '^ +(·|✗)' /tmp/ws-guard-preset.txt | head -8 | while IFS= read -r line; do c_err "      $line"; done
      drift=1
    fi
  fi

  # ISS-552 W-4：把只读采集层 `wt-scan.mjs` 接进收工体检。**本批只报不红**（单据的建议节奏：
  #   W-1/W-2 直接判红，其余先只报一周）。为什么不现在就红：`git worktree lock` 现量 0 棵、
  #   租约还是全局单槽（W-2 未落），此时判红等于把"别人在用旧机制"也算成违规 —— 那会把人推向绕过护栏。
  #   接进来本身是目的：能力齐全却调用点为 0（现算 scripts/ 与钩子里 0 处）= 只报都没人报。
  local wts
  wts="$(dirname "$0")/wt-scan.mjs"
  if [ -f "$wts" ]; then
    local wsum wtmp werr wrc
    wtmp="$(mktemp)"; werr="$(mktemp)"
    # 以前这里是 `node … 2>/dev/null | python3 …`：采集层一旦崩（本机就是：wt-scan 的孤儿行没有
    # plugins 字段 → TypeError），stderr 被吞、guard 只留下一句"读不到"，根因永远看不见。
    # 读不到 ≠ 没问题，但**把为什么读不到也抹掉**就更是假绿了。
    # `set -e` 下 `cmd; wrc=$?` 根本走不到下一行（脚本直接死，输出 0 字节 —— 第二轮审查实测）。
    node "$wts" --json --no-du >"$wtmp" 2>"$werr" && wrc=0 || wrc=$?
    if [ "$wrc" != "0" ]; then
      c_err "wt-scan 采集失败（exit=${wrc}）：$(head -c 150 "$werr" | tr '\n' ' ')"
      c_err "  → 这格的红归 scripts/wt-scan.mjs 本身；「只报不红」的前提是报得出来，报不出来就是没有读数 ⇒ 判红"
      drift=1
    fi
    wsum="$(python3 - "$wtmp" 2>/dev/null <<'PY' || true
import json, sys
try:
    # 注意：stdin 已经给了这段脚本自己（heredoc），JSON 只能按参数路径读
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("采集失败:" + str(e)[:60]); raise SystemExit(0)
# --json 的形状是 {summary, rows, foreign, main, merges} —— 计数在 summary.counts 里。
# （首版在这里按顶层取值，于是打出 "树 None · 已注册 None" —— None 不是"没有树"，
#   是"我没读到"，那种输出比不输出更坏，所以这里宁可在缺键时明说读不到。）
s = d.get("summary") or {}
c = s.get("counts") or {}
if not c:
    print("读不到 counts（顶层形状变了，请同步这条解析）"); raise SystemExit(0)
own = c.get("byOwnership") or {}
st = c.get("byState") or {}
unknown = sum(v for k, v in own.items() if "unknown" in k or "legacy" in k)
parts = [
    "树 " + str(c.get("trees")),
    "已注册 " + str(c.get("registered")),
    "归属不明 " + str(unknown),
    "git lock " + str(c.get("locked")),
    "有租约 " + str(c.get("withLease")),
    "插件占着 " + str(c.get("pluginOccupied")),
    "可回收 " + str(st.get("可回收", 0)),
    "需人判 " + str(st.get("需人判", 0)),
    "外仓 " + str(c.get("foreign")),
    "salvage " + str(c.get("salvageDirs")),
]
print(" · ".join(parts) + "（采集 %sms）" % s.get("elapsedMs"))
PY
)"
    rm -f "$wtmp" "$werr"
    if [ -n "$wsum" ]; then
      echo "工作树面（只报不红 · 加 --machine 才扫全家）：$wsum"
    else
      c_warn "wt-scan 采集没出结果（读不到 ≠ 没问题，请手跑 node scripts/wt-scan.mjs 看原因）"
    fi
    local lease_now tree_n
    lease_now="$(lock_field iss)"
    # 树的数量现算，不写死：这里是 `git worktree list` 的行数（含主库），09-28 到今天的实测从 16 涨到 24，
    # 任何"17 棵"这种写死的数字都会在下一轮骗人（治理采集层的纪律①：现算不缓存）。
    tree_n="$(git -C "$REPO" worktree list 2>/dev/null | grep -c . || echo '?')"
    if [ -n "$lease_now" ]; then
      echo "  租约面：单槽 = ${lease_now}（$(lock_field owner)）—— 全局只容一单，而同仓现有 ${tree_n} 个检出（W-2 每树租约待切）"
    else
      if [ "$(lock_stale_reason)" = "unreadable" ]; then
        echo "  租约面：锁文件读不出 ⇒ **未判**（上面那条已判红，这里不替你猜成「没人占」）"
      else
        echo "  租约面：当前无在途租约；同仓 ${tree_n} 个检出都靠这一个槽声明（W-2 每树租约待切）"
      fi
    fi
  fi
  home_split_note

  # ── ISS-734③：工作树 base 与 main 的关系（判红）────────────────────────────
  # 判据来源见 worktree_base_probe 头注（ISS-570 落后 485 导致合并冲突的实测）。
  # 为什么长在 guard 里：guard 是**收工/体检每次都会跑**的那道闸，而 `new` 只在建树时说一次话；
  #   main 继续前进后树会悄悄腐烂，需要一个"再回头看"的机制。闭环尤其依赖它 ——
  #   门禁验的是本单工作树，合的是「本单 + 当前 main」，两棵树不同。
  # ⚠️ 「非祖先」**不判红**（我第一版写错、实测抓到）：在途分支天然就是"非祖先"
  #   （它有本单尚未合并的提交）——实测 ISS-601 就是这种正常状态。把在途当异常 =
  #   把每个正在干活的人判红，护栏立刻变噪音。非祖先只在 `new --reuse` 时是**拒绝依据**
  #   （复用在途分支 = 接手别人的活），在体检里只作为**分辨信息**印出来。
  # 真正判红的只有一件事：**落后太多**（main 上这期间的改动不在你的验证面里）。
  # 阈值非法 ⇒ 判红（B3 的 fail-closed 落点；采集那侧只置标记，判红归这里）
  if [ "${WS_BASE_BEHIND_LIMIT_INVALID:-0}" = "1" ]; then
    c_err "WS_BASE_BEHIND_LIMIT 非法 ⇒ base 落后判据**未生效**（见上面的 fail-closed 说明）"
    drift=1
  fi
  local _wb_anc _wb_behind _wb_path _wb_red=0
  while IFS=' ' read -r _wb_anc _wb_behind _wb_path; do
    [ -n "$_wb_path" ] || continue
    case "$_wb_behind" in ''|*[!0-9]*) continue ;; esac   # 取不到就跳过（读不到 ≠ 没问题，但不在这一格判）
    if [ "$_wb_behind" -gt "$WS_BASE_BEHIND_LIMIT" ]; then
      c_err "工作树 base 落后 main ${_wb_behind} 个提交（> ${WS_BASE_BEHIND_LIMIT}）[${_wb_anc}]：${_wb_path}"
      c_err "  → main 上这期间的改动**不在**你的门禁验证面里；越旧的树越容易「自己绿、合进 main 就冲突」。"
      c_err "  → 处置：git -C ${_wb_path} rebase main（或重开一张干净树），然后**重跑门禁**（结果会变）。"
      c_err "  → 阈值可调（WS_BASE_BEHIND_LIMIT）；已知实例：ISS-570 落后 485 ⇒ 合并冲突。"
      _wb_red=1
    fi
  done <<< "$(worktree_bases_all)"
  if [ "$_wb_red" = "1" ]; then drift=1; fi

  # ── 落地包门禁（ISS-614 · 乙→甲案：gate-for 的机器调用点）──────────────────
  # 为什么长在这儿：`scripts/gate-for.sh` 落地时的形态是「文档里多了一条人要记得敲的命令」
  #   （`grep -rn gate-for scripts/ .github/` 只有它自己 + docs 里那段），而病根是**照抄** ——
  #   人照抄 ops-rules 的 `cd forge-pm && bun run test`，抄的人不会自动换成自己改的那个包。
  #   收工必过 guard，所以把尺子挂在这里；不挂在 ci-local 的理由：ci-local 本来就把**全仓**每包
  #   typecheck+test 跑一遍（`for` 全 targets），再挂一条「按包跑同样的脚本」= 零新增判据，
  #   只是长得像接线（接一条不咬的线比没接更糟 —— 它会被当成"已经验过了"）。
  #
  # 口径三件（都是为了不把护栏变成噪音）：
  #   ① **只看本次落地**（`HEAD^1..HEAD`），不看 `git status` —— 主 checkout 常躺着别人的
  #      未跟踪文件（ISS-599 实测积压 98 个），按脏文件推断会把无关包拖进来跑几十秒。
  #   ② 落地没动包（纯 scripts/ docs/ 改动）⇒ 跳过并说清，不跑全仓。
  #   ③ 跑的是**被守卫那棵树**上的 gate-for（`$REPO/scripts/`）：收工验的是 main 的代码，
  #      不是本单工作树的代码（门禁验工作树、合的是 main，两棵树不同 —— 与上面 base 落后那条同理）。
  if [ -f "$REPO/scripts/gate-for.sh" ]; then
    local _gp="" _gd _gflag="" _gd_list=""
    # ⚠️ K9c（ISS-640）：这一格**不许静默**。原写法 `git diff ... 2>/dev/null` 会让 git 失败时
    #    `_gd_list` 为空 ⇒ `_gp` 也为空 ⇒ 下面那句「没动任何包 ⇒ 跳过」把「**读不到**」报成
    #    「**不用管**」= 假绿（与本脚本作者在 gate-for.sh 里删掉同一句 `2>/dev/null` 的口径相反）。
    #    判不了就判红（fail-closed）：git 的原因照常打到 stderr，别吞。
    if ! git -C "$REPO" rev-parse --verify -q "HEAD^1" >/dev/null 2>&1; then
      c_err "落地包门禁：看不出「本次落地」（${REPO} 取不到 HEAD^1）⇒ **判不了**，不当作跳过"
      drift=1
    elif ! _gd_list="$(git -C "$REPO" diff --name-only "HEAD^1" HEAD)"; then
      c_err "落地包门禁：读不到本次落地的改动清单（git diff HEAD^1 HEAD 失败 ⇒ **判不了落地包门禁**，不当作跳过）"
      c_err "  → 上面的 git 报错就是原因；修好 git 后重跑 guard，或手跑 bash ${REPO}/scripts/gate-for.sh"
      drift=1
    else
      for _gd in $(printf '%s\n' "$_gd_list" | cut -d/ -f1 | sort -u); do
        if [ -f "$REPO/$_gd/package.json" ]; then _gp="$_gp $_gd"; fi
      done
      if [ -z "${_gp// /}" ]; then
        echo "落地包门禁：最近一次落地没动任何 workspace 包（scripts/ docs/ 这类改动）⇒ 跳过（不跑全仓）"
      else
        # 零门禁脚本的包（现量：forge-role / forge-widgets）默认判红 —— 那是**没刻度**，不是绿。
        # 确属纯声明包时显式放行：WS_GUARD_GATE_ALLOW_EMPTY=1 bash scripts/ws.sh guard
        if [ "${WS_GUARD_GATE_ALLOW_EMPTY:-0}" = "1" ]; then _gflag="--allow-empty"; fi
        if bash "$REPO/scripts/gate-for.sh" $_gflag $_gp >/tmp/ws-guard-gate-for.txt 2>&1; then
          c_ok "落地包门禁全绿：$_gp"
        else
          c_err "落地包门禁有红：${_gp}（详情 /tmp/ws-guard-gate-for.txt）"
          grep -E '✗|⚠️|跑了 [0-9]+ 个脚本项' /tmp/ws-guard-gate-for.txt | head -8 | while IFS= read -r line; do c_err "      $line"; done
          c_err "  → 这是**按包**的门禁（build:host / build:client / test / typecheck 里该包声明了啥跑啥）"
          c_err "  → 手跑同一把尺子：bash scripts/gate-for.sh$_gp"
          drift=1
        fi
      fi
    fi
  fi

  # ── ISS-504 判据：主 checkout 的 .bin 不许有悬空软链 ──────────────────────────
  # 为什么放进 guard（而不只是 doctor）：guard 是**收工/合并前**必跑的，悬空软链正是
  #   「工作树里 bun add 写穿到主检出」的残留物 —— 它不挡 merge、不报错，只在调用那一刻炸。
  #   只在 doctor 里报，等于把判据放在"想起来才跑"的地方。
  local _dbins _dbincnt
  _dbins="$(dangling_bin_list)"
  if [ -n "$_dbins" ]; then
    _dbincnt="$(printf '%s\n' "$_dbins" | grep -c . || true)"
    c_err "主 checkout 的 .bin 有 ${_dbincnt} 条悬空软链（工作树 bun add 写穿的残留，ISS-504）："
    printf '%s\n' "$_dbins" | head -8 | while IFS= read -r _l; do c_err "      $_l"; done
    c_err "  → 先确认这条 bin 现在没人正用，再 rm 掉；肇事树补跑 bash $0 deps <ISS-NNN>"
    drift=1
  fi

  # main 与远端的关系：只提示，收口 push 由人决定  # main 与远端的关系：只提示，收口 push 由人决定
  local ahead
  ahead="$(git -C "$REPO" rev-list --count origin/main..main 2>/dev/null || echo 0)"
  [ "$ahead" -gt 0 ] && c_warn "main 领先 origin/main $ahead 个提交（待 push）"
  if [ "$drift" = "1" ]; then exit 2; fi
  c_ok "守卫通过：主 checkout 停 main、无他人暂存"
}

cmd_new() {
  local iss="${1:-}"; shift || true
  local in_repo=0 reuse=0 skip_build=0
  for a in "$@"; do
    if [ "$a" = "--in-repo" ]; then in_repo=1; fi
    if [ "$a" = "--reuse" ]; then reuse=1; fi
    if [ "$a" = "--skip-build" ]; then skip_build=1; fi
  done
  if [ -z "$iss" ]; then c_err "用法: ws.sh new <ISS-NNN> [--in-repo] [--reuse] [--skip-build]"; exit 1; fi

  # ── ISS-872：new 降级为旧入口（⛔ 不删 —— 存量 52 棵树与既有脚本依赖它）─────────────
  # 为什么建议改道：new 从 **main** 建平级树、且**不写 .agents/trees.json** ⇒ 建出来的树
  #   在深度判据眼里是"未登记"，而在二级形态下从 main 建还会丢掉会话树已有的改动。
  # allocate 从 HEAD 建在会话树的池里并自动登记，是「建工单树的唯一入口」。
  c_warn "deprecated：ws.sh new 建平级树且不登记；建工单树请改用 ——
         bash $0 allocate ${iss}$( [ "$in_repo" = "1" ] && printf '（注意：allocate 不用 --in-repo，落点由会话树/主检出形态决定）' )"

  local path
  if [ "$in_repo" = "1" ]; then path="$REPO/.wt/$iss"; else path="$WT_ROOT/$iss"; fi

  if [ -d "$path" ]; then
    # ── ISS-802 判据②：目录已存在时**校验它签在哪个分支** ────────────────────────
    # 修前这里只 `c_warn` 一句就往下复用 —— 于是 `ws.sh new ISS-A` 可能静默操作一棵
    #   签在 B 单上的树：你以为在为 A 干活，提交却进了 B 的分支（改错单、合错车）。
    # 判据：实际分支 == 目标单号才放行；不同则拒绝，要复用得显式 --reuse。
    # ⚠️ `|| true`：`set -e` 下 `symbolic-ref` 在 detached(128)/非 git 目录(128) 都返回非 0，
    #   裸写会让整个 cmd_new 被静默杀掉（今天已踩过两次同类）。
    local _cur_branch _cur_rc=0
    _cur_branch="$(git -C "$path" symbolic-ref --short HEAD 2>/dev/null)" || _cur_rc=$?
    if [ "$_cur_rc" != "0" ]; then
      # 两种形态分开说：detached 的树**是** git 仓但没分支；非 git 目录连仓都不是。
      # 判据用 worktree 根而不是 "能不能 rev-parse"：在别的仓内部的普通目录也能 rev-parse 成功。
      local _wt_root_ok=0
      if [ "$(git -C "$path" rev-parse --show-toplevel 2>/dev/null || true)" = "$(cd "$path" && pwd -P)" ]; then _wt_root_ok=1; fi
      if [ "$_wt_root_ok" = "1" ]; then
        c_err "目录存在，且是 git 工作树，但它**没有签在分支上**（detached HEAD）：$path"
      else
        c_err "目录存在，但**不是 git 工作树根**（不是仓库，或只是某个仓库里的普通子目录）：$path"
      fi
      echo "   该目录无法判定「在为哪张单干活」⇒ 拒绝复用（静默复用正是 ISS-802 要堵的洞）"
      echo "   想继续用这个目录：先弄清它是什么（git -C $path status），或换落点/清掉它后重跑"
      exit 2
    fi
    if [ "$_cur_branch" != "$iss" ]; then
      if [ "$reuse" = "1" ]; then
        c_warn "按 --reuse 复用已存在的目录：$path"
        c_warn "  ⚠️ 但它签在 **${_cur_branch}** 上，不是本单的 ${iss} —— 你接下来改的是 ${_cur_branch} 的东西"
        c_warn "  → 确认无误再提交；要换回来：git -C $path checkout ${iss}"
      else
        c_err "工作树已存在，但签在别的分支上：$path"
        echo "   实际分支：$_cur_branch"
        echo "   期望分支：${iss}（ws.sh 的落点约定 = 目录名 == 分支名 == 单号）"
        echo "   → 在为 ${iss} 干活却提交进 ${_cur_branch}，就是**改错单**（最坏：别人的在途工作被你的提交带走）"
        echo "   确认要在这棵树上为 $iss 干活：ws.sh new $iss --reuse"
        echo "   想从 main 重开一棵干净的：先 ws.sh rm ${iss}（或换落点）"
        exit 2
      fi
    else
      c_warn "工作树已存在：${path}（分支 ${iss}，与目标一致）"
    fi
  else
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/$iss"; then
      # ISS-734：同名分支很可能是**上一轮合并后没删干净的旧工作**。直接签出它会静默拿到旧 base，
      #   症状是「脚本找不到 / 度量对照虚报一堆变化」，最坏是在旧内容上开发再合车 —— 把别人已合的东西盖回去。
      #   判据：祖先关系成立才复用（其提交都已在 main），否则拒绝，要复用得显式 --reuse。
      #   这里刻意不吞 stderr：抑制错误输出正是 K9c 管的静默失败（上一版为了安静这么写，被度量抓了一次）
      if [ "$reuse" != 1 ] && ! git -C "$REPO" merge-base --is-ancestor "$iss" main; then
        c_err "分支 $iss 已存在，且不是 main 的祖先（上一轮的在途工作？还是已被回退？）"
        echo "   分支 tip: $(git -C "$REPO" log -1 --format='%h %ad %s' --date=format:'%m-%d %H:%M' "$iss" | cut -c1-88)"
        echo "   确认要复用它：ws.sh new $iss --reuse ；想从 main 重开：先 ws.sh rm ${iss}（连分支一起删）"
        exit 2
      fi
      git -C "$REPO" worktree add "$path" "$iss"
      if [ "$reuse" = 1 ]; then c_warn "按 --reuse 复用了已存在的分支 $iss"; fi
    else
      git -C "$REPO" worktree add "$path" -b "$iss" main
    fi
    c_ok "已建工作树：$path"
    # 不管新建还是复用，都把 base 与 main 的距离摊开 —— "我到底开在哪"必须是看得见的信息
    # ⚠️ 必须读**新工作树**的 HEAD：读 $REPO 会把主库的 main 打印成 base，落后永远显示 0（我第一版就写错了这里）
    echo "   base   = $(git -C "$path" log -1 --format='%h %ad %s' --date=format:'%m-%d %H:%M' HEAD | cut -c1-88)"
    echo "   落后 main：$(git -C "$path" rev-list --count HEAD..main) 个提交（非 0 就先同步，别在旧基线上写）"
  fi

  # 依赖镜像（ISS-510 取代原「整目录软链」）：见 prepare_worktree_deps 头注 ——
  # 整目录软链会让 workspace 链接按主 checkout 解析（假绿），且新建包没有依赖。
  #
  # ⚠️ ISS-498（2026-09-15）：**根 node_modules 必须一起准备**，不能只管各包 ——
  #   workspace 级包只挂在**仓库根**的 node_modules 下，而 TS/Node 解析是自当前目录**逐级向上**；
  #   少了根链接，链就在工作树根断掉（TS2307 'forge-design'），而 `bun test` 反而全绿（假红）。
  #
  # ⚠️ ISS-586：返回码是**三态**（见 prepare_worktree_deps 头注）：
  #   0 绿 · 1 红（判据成立且不满足：根/树缺 node_modules、镜像失败）· 2 判不了（install 失败）。
  #   红就**停在这里**并 exit 1 —— 树已经建出来了，但依赖不齐的树跑任何门禁都是假结论，
  #   继续往下打「下一步 / 验证」只会让人拿它当真（本单现场：浪费了一整轮门禁排查）。
  #   判不了（网络/registry）不停，但绝不能报"就绪"，见下面的 c_warn。
  local dep_rc=0
  prepare_worktree_deps "$path" || dep_rc=$?
  if [ "$dep_rc" = "1" ]; then
    c_err "工作树已建但**依赖不齐** ⇒ 停在这里：${path}"
    c_err "  → 修好后重跑：bash $0 deps ${iss}；这棵树现在的 bun test/typecheck 结果一律不算数"
    exit 1
  fi

  # ── ISS-584：补建构建产物（否则 bun test 有 3 条与改动无关的假红）──────────────
  # 位置说明：必须在 prepare_worktree_deps **之后**（产物依赖 node_modules 就绪），
  #   且在任何"下一步 / 验证"提示**之前**（否则读者先被 3 条假红骗一轮）。
  # 可跳过：`--skip-build`（判据在下面 opt 解析处）—— 给"只想快速开树读代码"的场景留口子。
  # ⚠️ `|| true` 是**有意**的（第二遍独立审查 M1 抓到缺了它）：补建失败时树**已经建好、
  #   依赖已镜像、可以正常干活**，此时让 `cmd_new` 整体 exit 1 会连带吞掉后面那段
  #   「下一步 / dev-instance / restart-matter」引导 —— main 版恒 exit 0 且必打引导，
  #   这是相对 main 的**可用性回归**。失败已由 ensure_worktree_artifacts 自己 c_err 出声，
  #   不需要再用退出码表达一次。（对照：cmd_deps 用 `|| exit 1` 是**有意**中断 ——
  #   deps 的全部意义就是建依赖，它失败则命令没完成。）
  if [ "$skip_build" = "1" ]; then
    c_warn "按 --skip-build 跳过产物补建 —— bun test 会有 3 条假红（forge-agents / forge-tailwind），自行分辨"
  else
    echo
    echo "── 补建构建产物（ISS-584）──"
    ensure_worktree_artifacts "$path" || true
  fi

  echo
  echo "下一步：cd $path"
  # ISS-558：默认动作从「切链 + 重启 3210」改成隔离实例 —— 3210 是 App(19387) Matter 面板的
  # 数据源（~/.dsh/profiles/desktop/cordis.patch.yml:884 `proxyBase: http://127.0.0.1:3210`），
  # kill 它 = 老板界面中断 5-12s + 控制台 502（它是生产服务，不是可随便重启的开发件）。
  echo "验证改动（ISS-558）："
  # ⚠️ 口径与 docs/project-code-rules.md §4.6 对齐（ISS-558 LOW）：§4.6 明说 dev-instance.sh
  # **当前不可用**（四条欠账，修它是独立单）⇒ 这里不能再写成「① 首选」，否则读者照抄一个跑不出
  # 正确结果的实例。改成「① 方向（暂不可用）」+「② 修好前的实际路径 = 带变量的现役入口」。
  echo "  ① 方向（生产 3210 全程不动）—— 隔离实例：bash $REPO/scripts/dev-instance.sh start $iss"
  echo "     ⚠️ **该脚本当前不可用**（四条已知欠账：老 home 假设 ⇒ PM 层悬空 / 装配树旧拷贝），修它是独立单 —— 修好前别照这条执行，判据见 docs/project-code-rules.md §4.6"
  echo "  ② 修好前确需重启 3210 —— 显式确认（完整重启正规入口）：FORGE_ALLOW_RESTART_PROD=1 bash $REPO/scripts/restart-matter.sh"
  echo "     （不带变量会被牙拦下，退出码 4 —— 判据 scripts/prod-guard.sh，见 §4.6）"
  echo "  ⚠️ 不要为了验证重启 3210 —— 它是 App(19387) Matter 面板的数据源，重启 = 老板界面中断 5-12s + 控制台 502"
}

# ISS-510：`ws.sh deps [ISS-NNN]` —— 建立/修复工作树依赖镜像（含把旧式"整目录软链"迁成镜像）
#   老树（本次修复前建的）是整目录软链：workspace 包按主 checkout 解析 → 假绿。
#   对它们跑一次本命令即可迁移；`ws.sh doctor` 会把这些树列出来。
cmd_deps() {
  local iss="${1:-}"
  local path
  if [ -z "$iss" ]; then
    path="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$path" ] || { c_err "用法: ws.sh deps <ISS-NNN>（或在工作树内不带参数运行）"; exit 1; }
  else
    path="$WT_ROOT/$iss"
    [ -d "$path" ] || path="$REPO/.wt/$iss"
    [ -d "$path" ] || { c_err "找不到工作树：$iss"; exit 1; }
  fi
  echo "── 依赖镜像：$path ──"
  # ISS-586：三态照传 —— 0 绿 · 1 红（判据成立且不满足）· 2 判不了（install 失败）。
  #   红用 exit 1（deps 的全部意义就是建依赖，没建成即命令没完成）；
  #   判不了用 exit 2（与红区分：不是"代码/环境坏了"，是"这次得不出结论"）。
  local rc=0
  prepare_worktree_deps "$path" "${2:-}" || rc=$?
  if [ "$rc" = "1" ]; then
    c_err "依赖镜像**失败** ⇒ 该树的 bun test/typecheck 结果一律不算数（见上面的失败项）"
    exit 1
  fi
  if [ "$rc" = "2" ]; then
    c_err "依赖镜像**判不了**（exit 2，与失败区分）：先修网络/锁再重跑，别把这次当绿"
    exit 2
  fi
  echo
  echo "验证解析归属（应指向本工作树）："
  for n in $(ws_names_of "$path"); do
    [ -e "$path/node_modules/$n" ] || continue
    printf '  %-14s → %s\n' "$n" "$(cd "$path/node_modules" && cd "$n" 2>/dev/null && pwd -P)"
  done
}

# ── ISS-693：`ws.sh adopt <ISS-NNN>` —— 认领**盘上已有的树** ────────────────────
# 缺口形态：官方 `create_worktree`（host 侧 `ctx.worktrees.create`）只做
#   `git worktree add` + `reset --hard`，**不装依赖、不补产物**（README.zh.md:88）；
#   而 `ws.sh deps` 只管依赖、**不含产物**（`ensure_worktree_artifacts` 只被 `cmd_new` 调）
#   ⇒ 「官方建完树」与「能派进去真干活」之间原本没有一条命令。本命令就是那条命令。
# 与 `new` 的分工：`new` = 建树 + 补齐；`adopt` = **只补齐，不建树**（树已在）。
# 不做「尽力而为」：定位不到 / 未注册 / 分支不符 / 不符合两级准入，任一不满足即 exit 1。
#   理由：这四条任一为假时，deps 与产物会补到**另一棵树**（甚至另一单的树）上，而输出照样
#   是「✓ 就绪」—— 那正是本仓反复踩的静默错形态；此处宁可拒绝，不许降级继续。
#   ⚠️ ISS-870：第四条原是「套娃 ⇒ 恒拒」。工单树建在会话树下（`<会话树>/.agents/worktrees/ISS-N`）
#     是老板 2026-11-17 定的合规形态 ⇒ 改为「恰好两级准入」：外层在册且 kind=session、本树 kind=issue、
#     parent 对得上才放行；三级及以上恒拒。准入依据本树的 `.agents/trees.json`。

# 该路径是否已在 `git -C "$REPO" worktree list` 注册（0 = 已注册）。
# ⚠️ 双侧必须 realpath 归一：软链池（`.agents/worktrees -> ~/wt/dsh-forge`）让同一棵树有
#   两种写法，而 git 记的是 realpath。纯字符串比较会把每一棵合法树判成「未注册」
#   ⇒ 闸门退化成噪音，人就开始绕过它（比没有闸门更坏）。
worktree_registered() {
  local want p
  want="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ "$(cd "$p" 2>/dev/null && pwd -P || printf '%s' "$p")" = "$want" ] && return 0
  done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
  return 1
}

# 嵌套判定：$1 是否落在**另一棵工作树**内部（0 = 是，并打印那棵外层树的路径）。
# 判据 = 「git 自己的 worktree 注册表里，存在另一棵非主检出树的路径是它的前缀」。
# 为什么不选「路径中含 `/.agents/worktrees/` 或 `/.wt/` 段」这种形状判据：
#   ① 形状判据是黑名单 —— 外层树换个目录名、或池配到别处就漏；漏掉的后果是 deps/产物
#      补进别人的树、门禁结果挂到错的单上（静默错，事后极难归属）；
#   ② 注册表判据对**任何**嵌套形式成立（树里套树、中间隔任意命名目录），只要外层树在册。
#      它的盲区是「外层树未注册」，而 adopt 第一步就要求本树已注册 —— 那种形态进不来。
#
# ⚠️ 排除的是**主检出**，不是 `$REPO`（ISS-870 修的一处真缺陷）。
#   原写法排除 `$REPO`：在主检出形态下恰好等价（主检出 == $REPO）；但**二级形态下 $REPO 是会话树**
#   —— 而会话树正是内层工单树的合法权益外层。按 $REPO 排除会让会话树**永远不被报成外层**
#   ⇒ 二级准入的 ④ 整段空转，任何嵌套都被当成平级放行（实测：工单树的 outer 会是空）。
#   改排除主检出后两个形态同时正确：
#     · $REPO = 主检出 ⇒ 主检出 == 排除项，行为与原版一致（`new --in-repo` 的
#       `.wt/ISS-x` 依然不算嵌套）；
#     · $REPO = 会话树 ⇒ 主检出被排除（会话树里的 in-repo 树不算嵌套），会话树本身仍被报出。
nesting_main_checkout() {
  git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}'
}
worktree_nesting_parent() {
  local target main_real p pr best=""
  target="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
  main_real="$(cd "$(nesting_main_checkout)" 2>/dev/null && pwd -P || true)"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    pr="$(cd "$p" 2>/dev/null && pwd -P || printf '%s' "$p")"
    [ -n "$main_real" ] && [ "$pr" = "$main_real" ] && continue
    [ "$pr" = "$target" ] && continue
    case "$target" in "$pr"/*) ;; *) continue ;; esac
    # 取**最近**的那个祖先（路径最长），不是列表里第一个。
    # 实测（ISS-870 三级探针）：`l1` 在 `git worktree list` 里排在 `l1/.../ISS-9` 之前，
    # 返回第一个匹配就得到 l1 ⇒ 两级准入把「外层」判成隔了一层的树，三级的 near-parent 永远看不见。
    # 路径前缀关系是全序的（同一棵树的祖先按长度唯一排序），故「最长者」= 最近者，无歧义。
    if [ -z "${best:-}" ] || [ "${#pr}" -gt "${#best}" ]; then best="$pr"; fi
  done < <(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
  [ -n "${best:-}" ] && printf '%s\n' "$best" && return 0
  return 1
}

cmd_adopt() {
  local iss="${1:-}"
  if [ -z "$iss" ]; then
    c_err "用法: ws.sh adopt <ISS-NNN>"
    echo "   把盘上已有的工作树（官方 create_worktree 建的那种）补齐成 new 的形态：依赖镜像 + 构建产物"
    exit 1
  fi

  # ① 池目录形态必须合规。排在定位之前：池坏了先报池，否则报出去的是"找不到工作树"，
  #    会把人引向错误的修法。
  #    ISS-696（主检出）：必须是**指向 $WT_ROOT 的软链** —— 官方 create_worktree 取落点走
  #      realpath，软链被吃掉才落在 $WT_ROOT；软链一旦丢失，官方**不报错**、自己在仓内建真目录
  #      ⇒ 后续每棵官方树都落在 `$REPO/.agents/worktrees/`，而 status / wt-scan / ai-review.sh
  #      全按 $WT_ROOT 扫描。
  #    ISS-870（会话树）：必须是**真目录 + `.gitignore:'*'`** —— 内层工单树本来就该落在会话树里。
  #      两形态的分判在 pool_link_problem 里，这里只负责措辞（按形态给对症的修法）。
  if ! pool_link_problem; then
    c_err "池目录不合规 ⇒ 拒绝认领：$REPO/.agents/worktrees ${POOL_PROBLEM}"
    if is_session_tree; then
      c_err "  → 后果：内层工单树没被忽略 ⇒ 会话树 status 永久显示未跟踪 ⇒ 删树与脏否读数全部失真"
    else
      c_err "  → 后果：软链不在时官方 create_worktree 不报错、自己建真目录 ⇒ 树静默落进仓内，"
      c_err "    而 status / wt-scan / ai-review.sh / 约定落点发现全按 $WT_ROOT 扫描 ⇒ 那棵树对护栏隐形"
    fi
    c_err "  → 修法：$(pool_fix_cmd)"
    exit 1
  fi

  # 定位：三处落点，按「一级 → 二级」排。
  # ISS-870：第三处 `$REPO/.agents/worktrees/$iss` 是**二级（会话树）形态**的落点。
  #   实测缺失它时 adopt 在**定位阶段**就 exit 1，根本走不到后面的准入判据：
  #     $ REPO=<会话树> bash scripts/ws.sh adopt ISS-870
  #     ✗ 找不到工作树：ISS-870（找过 ~/wt/dsh-forge/ISS-870 与 <主检出>/.wt/ISS-870）
  #   为什么排在最后：前两处是存量落点，第三处是二级新形态 —— 顺序换了会让
  #   「同一单号在池里与在会话树里都有树」时认领到非预期的那棵（先到先得是**声明**，不是兜底）。
  local path="$WT_ROOT/$iss"
  [ -d "$path" ] || path="$REPO/.wt/$iss"
  [ -d "$path" ] || path="$REPO/.agents/worktrees/$iss"
  if [ ! -d "$path" ]; then
    c_err "找不到工作树：${iss}（找过 $WT_ROOT/$iss · $REPO/.wt/${iss} · $REPO/.agents/worktrees/${iss}）"
    c_err "  → 手工建的目录不会被认领；建树请用官方 create_worktree 或 ws.sh new"
    exit 1
  fi
  echo "── 认领工作树：$path ──"

  # ② 已注册（未注册 = 不是这个仓的工作树，worktree 语义由 git 注册表定义）
  if ! worktree_registered "$path"; then
    c_err "该路径不在 \`git -C $REPO worktree list\` 里（未注册）⇒ 拒绝认领"
    exit 1
  fi

  # ③ 分支名 == 单号（不符则 deps/产物会补到别人的单上）
  local br
  br="$(git -C "$path" branch --show-current 2>/dev/null || true)"
  if [ "$br" != "$iss" ]; then
    c_err "该树当前分支不是 ${iss}（实际：${br:-<detached>}）⇒ 拒绝认领"
    c_err "  → 确认路径没选错：git -C $path branch --show-current"
    exit 1
  fi

  # ④ 两级准入（ISS-870，替换原「拒绝套娃」）
  #
  # 原判据「树里套树 ⇒ 恒拒」在老板 2026-11-17 定的二级工作树形态下**方向错了**：
  # 工单树就该建在会话树里（`<会话树>/.agents/worktrees/ISS-N`）。恒拒会把整个二级链路挡死。
  # 换成**恰好两级准入**：
  #
  #   outer 不存在                ⇒ 一级（平级树），放行
  #   outer 存在                  ⇒ 要求 outer 在本树的登记表里且 kind=session、本树 kind=issue
  #   outer 的 outer 也存在        ⇒ **恒拒**（三级及以上无定义）
  #
  # 为什么存量一级树不受影响：走到 ④ 且 outer 不存在时，本判据一个问题都不问（只放行）。
  #   存量 52 棵平级树全是这一支 —— 本单不要求它们补登记（那是人执行，另批）。
  local outer outer2
  if outer="$(worktree_nesting_parent "$path")"; then
    # 先判三级 —— **按路径判，不按登记表判**（这是本段唯一正确的口径）。
    # 为什么：登记表可以不全（未登记的树正是要拦的对象）。若三级只在登记表里找，
    #   一个「物理三层、登记表只写了两层」的现场会被判成合规 —— 实测踩过：
    #   `ISS-99` 在外层 `ISS-9` 之下，而 `ISS-9` 的登记表里 parent 写 null ⇒ 判定通过。
    # 这里直接问「外层自己还有外层吗」，与 verify-tree-depth 的 depth 算法同口径。
    if outer2="$(worktree_nesting_parent "$outer")"; then
      c_err "**三级及以上无定义** ⇒ 拒绝认领"
      c_err "  内层：$path"
      c_err "  外层：$outer"
      c_err "  外层的外层：$outer2"
      c_err "  → 恰好两级是老板 2026-11-17 定的口径：主检出 → 会话树 → 工单树。再往下没有归属语义，"
      c_err "    deps/产物按哪一层补都会错，rm/prune 也会互相牵连"
      c_err "  → 处置：回到会话树（二级里的外层）再建一次；三级的目录请删掉"
      exit 1
    fi

    # 登记表从**本树**读（二级形态下 `.agents/trees.json` 跟着分支走），读不到就从 $REPO 读。
    local reg=""
    [ -f "$path/.agents/trees.json" ] && reg="$path/.agents/trees.json"
    [ -n "$reg" ] || { [ -f "$REPO/.agents/trees.json" ] && reg="$REPO/.agents/trees.json"; }
    if [ -z "$reg" ]; then
      c_err "该树位于另一棵工作树内部（二级形态），但**找不到登记表** .agents/trees.json ⇒ 拒绝认领"
      c_err "  内层：$path"
      c_err "  外层：$outer"
      c_err "  → 两级准入要求内层树先在登记表登记 kind:\"issue\" + parent 指到外层；"
      c_err "    无登记的随手嵌套正是 ISS-688 那类（deps/产物补到别人树上的静默错）"
      c_err "  → 修法：在 ${reg:-.agents/trees.json} 加一行 { \"${iss}\": { \"kind\": \"issue\", \"path\": \"${path}\", \"parent\": \"${outer}\" } }"
      exit 1
    fi

    # 用 node 读登记表做判定：几层逻辑（本树 kind / 外层 kind / 外层有无外层）在 shell 里
    # 会变成一堆 grep，而 JSON 的形状判断本该由 JSON 解析器做。
    # 输出只看第一行，六种取值：
    #   OK              = 准入通过
    #   NO_ENTRY        = 本树没有登记行
    #   OUTER_NO_ENTRY  = 外层没有登记行（两级准入要求外层也在册）
    #   BAD_KIND        = 本树/外层的 kind 不对
    #   BAD_PARENT      = parent 指不到外层
    #   REG_UNREADABLE  = 登记表读不动（判不了，不当通过）
    #
    # ⚠️ 契约归属：`kind` 的取值（session / issue）、`parent` 的两种写法、`_` 前缀当注释位
    #   这三条**与 scripts/gates/verify-tree-depth.ts 是同一份契约**。两处会漂移，故：
    #     · 改任何一条，必须同时改判据与它的 spec（spec 里每条都有对应断言）；
    #     · 判据是**准入的后盾**（`--tier next` 跑它），这里是**施工前的闸**（认领即拒）。
    #   为什么不抽成共用模块：判据是 ESM `.ts`、这里是嵌在 bash 里的 `node -e`，
    #   共用只能靠再生成一份 —— 那正是本仓反复踩的「同一概念两处表达」。故选**两处 + 一条注明**。
    local verdict
    verdict="$(/usr/local/bin/node -e '
      const fs = require("fs"), path = require("path")
      const [regFile, self, outer] = process.argv.slice(1)
      const rp = (p) => { try { return fs.realpathSync(p) } catch { return String(p).replace(/\/+$/, "") || "/" } }
      const isUnder = (p, q) => p !== q && p.startsWith(q.endsWith("/") ? q : q + "/")
      let reg
      try {
        const raw = JSON.parse(fs.readFileSync(regFile, "utf8"))
        reg = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith("_")))
      } catch (e) { console.log("REG_UNREADABLE " + e.message); process.exit(0) }
      const selfR = rp(self), outerR = rp(outer)
      const entryOf = (p) => {
        for (const [k, v] of Object.entries(reg)) {
          if (!v || typeof v !== "object" || typeof v.path !== "string") continue
          if (rp(v.path) === p) return { key: k, e: v }
        }
        return null
      }
      const selfHit = entryOf(selfR)
      if (!selfHit) { console.log("NO_ENTRY"); process.exit(0) }
      if (selfHit.e.kind !== "issue") { console.log("BAD_KIND self=" + JSON.stringify(selfHit.e.kind)); process.exit(0) }
      const outerHit = entryOf(outerR)
      if (!outerHit) { console.log("OUTER_NO_ENTRY " + outerR); process.exit(0) }
      if (outerHit.e.kind !== "session") { console.log("BAD_KIND outer=" + JSON.stringify(outerHit.e.kind)); process.exit(0) }
      const pRaw = typeof selfHit.e.parent === "string" ? selfHit.e.parent : ""
      const pOk = !!pRaw && (pRaw === outerHit.key || rp(pRaw) === outerR)
      if (!pOk) { console.log("BAD_PARENT " + JSON.stringify(selfHit.e.parent)); process.exit(0) }
      // 三级：外层自己还有外层吗？（登记表里任一行的 path 是外层的祖先）
      const third = Object.entries(reg).find(([k, v]) => {
        if (k === outerHit.key) return false
        if (!v || typeof v.path !== "string") return false
        const q = rp(v.path)
        return isUnder(outerR, q)
      })
      if (third) { console.log("THREE_LEVEL " + third[0] + "=" + third[1].path); process.exit(0) }
      console.log("OK " + selfHit.key)
    ' "$reg" "$path" "$outer" 2>&1 | head -1)"

    case "$verdict" in
      OK*)
        c_ok "两级准入通过：外层 ${outer} 登记为 session · 本树登记为 issue · parent 对得上"
        ;;
      NO_ENTRY)
        c_err "该树位于另一棵工作树内部，但登记表里**没有它的登记行** ⇒ 拒绝认领"
        c_err "  内层：$path"
        c_err "  外层：$outer"
        c_err "  → 两级准入要求内层先在 ${reg} 登记；无登记的嵌套会让 deps/产物补到别人树上"
        c_err "  → 修法：加一行 { \"${iss}\": { \"kind\": \"issue\", \"path\": \"${path}\", \"parent\": \"${outer}\" } }"
        exit 1
        ;;
      OUTER_NO_ENTRY*)
        c_err "外层树没有在登记表里登记为 session ⇒ 拒绝认领（两级准入要求外层也在册）"
        c_err "  内层：$path"
        c_err "  外层：${verdict#OUTER_NO_ENTRY }"
        c_err "  → 修法：给外层加一行 { \"<会话树标识>\": { \"kind\": \"session\", \"path\": \"${outer}\" } }"
        exit 1
        ;;
      BAD_KIND*)
        c_err "登记表的 kind 不对 ⇒ 拒绝认领（${verdict#BAD_KIND }）"
        c_err "  → 两级里**外层必须 session、内层必须 issue**；改登记行，或把这棵树挪到池外"
        exit 1
        ;;
      BAD_PARENT*)
        c_err "登记行的 parent 指不到外层那棵树 ⇒ 拒绝认领（parent=${verdict#BAD_PARENT }）"
        c_err "  内层：$path"
        c_err "  外层：$outer"
        c_err "  → parent 错会让「谁是谁的外层」两张表对不上，事后无法归属"
        exit 1
        ;;
      THREE_LEVEL*)
        # 兜底：路径判定（上面那段）已经拦掉物理三层。这一支只在「登记表里写了第三层、
        # 而盘上那棵树已删」时命中 —— 那时依然拒绝，因为登记表宣称了一条无定义的层级。
        c_err "**三级及以上无定义** ⇒ 拒绝认领（登记表里存在外层的祖先：${verdict#THREE_LEVEL }）"
        c_err "  内层：$path"
        c_err "  外层：$outer"
        exit 1
        ;;
      REG_UNREADABLE*)
        c_err "登记表读不动 ⇒ 拒绝认领（${verdict#REG_UNREADABLE }）"
        c_err "  → 文件：$reg"
        c_err "  → 判不了不许当通过：修好 JSON 再认领"
        exit 1
        ;;
      *)
        c_err "两级准入判定失败（无法解析判定输出：${verdict:-<空>}）⇒ 拒绝认领"
        exit 1
        ;;
    esac
  fi

  c_ok "校验通过：已注册 · 分支 ${iss} · 两级准入"
  # base 与落后提交数：口径同 cmd_new:1389-1391 —— 必须读**本树**的 HEAD。
  #   读 $REPO 会把主检出 main 当成本树的 base，落后恒显示 0（cmd_new 第一版就这么错过）。
  echo "   base   = $(git -C "$path" log -1 --format='%h %ad %s' --date=format:'%m-%d %H:%M' HEAD | cut -c1-88)"
  echo "   落后 main：$(git -C "$path" rev-list --count HEAD..main) 个提交（非 0 就先同步，别在旧基线上写）"
  echo

  # 依赖镜像：三态照传（0 绿 · 1 红 · 2 判不了），处理同 cmd_new:1404-1416 ——
  #   红就停（依赖不齐的树跑任何门禁都是假结论）；判不了用 exit 2 与红区分。
  echo "── 依赖镜像（ISS-510）──"
  local rc=0
  prepare_worktree_deps "$path" || rc=$?
  if [ "$rc" = "1" ]; then
    c_err "工作树已在盘上但**依赖不齐** ⇒ 停在这里：${path}"
    c_err "  → 这棵树现在的 bun test/typecheck 结果一律不算数；修好后重跑：bash $0 adopt ${iss}"
    exit 1
  fi
  if [ "$rc" = "2" ]; then
    c_err "依赖镜像**判不了**（exit 2，与失败区分）：该树门禁结果不可信"
    c_err "  → 网络/registry/lock 好了重跑：bash $0 adopt ${iss}"
    exit 2
  fi

  echo
  echo "── 补建构建产物（ISS-584）──"
  # ISS-871（甲档）：二级形态（$REPO 是会话树）下，根级 forge-* 旧树包从未构建、也不参与
  #   该形态门禁 ⇒ 补建必然全失败，而 22 条 ✗ 会同屏淹没在 `✓ 已认领` + EXIT=0 里。
  #   传 --session-tree 让补建环节**按形态跳过并显眼说明原因**，不再制造假失败。
  #   一级形态不传：逐包补建逻辑逐字不变（真包照建）。
  # `|| true` 沿用原口径：走到这里树已在、依赖已镜像、可以干活，补建/跳过结果不该让 adopt 失败；
  #   失败已由 ensure_worktree_artifacts 自己 c_err 出声，不必再用退出码表达一次。
  if is_session_tree; then
    ensure_worktree_artifacts "$path" --session-tree || true
  else
    ensure_worktree_artifacts "$path" || true
  fi

  # ⑤ 跨包 workspace 链接守卫（ISS-695 洞2）：认领完成后**再数一遍**，不为 0 就不许报绿。
  #    顺序不能反：先跑 ④ 那轮修复（在 prepare_worktree_deps → fix_ws_links 里），再统计；
  #    修过仍剩说明是修复覆盖不到的形态（如作用域嵌套的链接），此时报红并把样例交人。
  #    为什么必须红而不是"提示一下"：这种错链让「改了本树的包、下游仍读主 checkout」，
  #    **门禁全绿而改动没进去**，事后无法从日志里看出任何异常。
  local bad bad_cnt
  bad="$(cross_ws_link_list "$path")"
  bad_cnt="$(printf '%s\n' "$bad" | grep -c . || true)"
  if [ "${bad_cnt:-0}" != "0" ]; then
    c_err "认领**失败**：本树仍有 ${bad_cnt} 条 workspace 链接指向主 checkout —— ${path}"
    printf '%s\n' "$bad" | head -3 | awk -F'\t' '{printf "  · %s → %s\n", $1, $2}'
    if [ "$bad_cnt" -gt 3 ]; then
      echo "  · …（共 ${bad_cnt} 条，只列前 3 条）"
    fi
    c_err "  → 后果：改了本树的包，下游包仍读主 checkout ⇒ **门禁全绿而改动没进去**（假绿）"
    c_err "  → 处置：这些不是 fix_ws_links 能修的形态（目标包不在本树 / 作用域嵌套），逐条人工重指："
    c_err "          ls -l 看目标，再 rm -f <链接> && ln -s \"$path/<包名>\" <链接>"
    exit 1
  fi
  c_ok "跨包 workspace 链接无错指（0 条指向主 checkout）"

  echo
  c_ok "已认领：${path}（形态等价于 ws.sh new 建出来的树）"
  echo "下一步：cd $path"

  # ⑤ 补登记（ISS-872）：认领完把「已认领但未登记」这个状态消掉。
  #    登记表是 depth 判据（verify-tree-depth）的输入语料；不登记 ⇒ 内层树一律判红。
  #    非致命：树与依赖都已就绪，登记失败只影响判据读数，故打红但不把 adopt 判成失败
  #    （用户此刻能干活；修法是补一行，输出里已给出）。
  local adap_parent="" adap_rc=0 adap_tmp
  adap_tmp="$(mktemp)"
  adap_parent="$(worktree_nesting_parent "$path" || true)"
  trees_registry_cas add "$iss" "$path" "$iss" "${adap_parent:-}" >"$adap_tmp" 2>&1 || adap_rc=$?
  case "$adap_rc" in
    0) c_ok "已登记：$(sed -n 's/^WROTE //p' "$adap_tmp" | head -1)" ;;
    3) c_warn "登记表里已有本树的行（未改动）：$(sed -n 's/^EXISTS //p' "$adap_tmp" | head -1)" ;;
    *) c_err "登记失败（exit ${adap_rc}）⇒ 深度判据仍会把本树判红"
       c_err "  → 详见：$(head -2 "$adap_tmp" | tr '\n' ' ')" ;;
  esac
  rm -f "$adap_tmp"
}

# ══════════════════════════════════════════════════════════════════════════════
# ISS-872（W-1）：登记表 CAS + `allocate` 单门
#
# 为什么要有 allocate：W-0（ISS-870）打通了「认识二级树」，但**建树仍靠手工** ——
#   W-0 现场自己敲了三条 git 命令才建出 ISS-870 那棵树，且建完不登记 ⇒ W-0 的深度判据
#   立刻判它红（本单开工时实测到的就是这样一条：本树 depth=1 但登记表里没有它的行）。
#   allocate 把这件事变成一条命令：**会登记、会回写单据、失败会回滚**。
#
# 与 new / adopt 的分工（不要互相替代）：
#   allocate = 建树 + 登记 + 回写（**建树唯一入口**）
#   new      = 旧入口，保留（存量 52 棵树与既有脚本依赖它），只加一行 deprecation
#   adopt    = 树已在盘上时补齐（依赖镜像 + 产物）并补登记
#
# ⛔ 本段**不碰** prepare_worktree_deps / ensure_worktree_artifacts（那是 ISS-871 的账）
#   ⇒ allocate 建出来的树没有依赖与产物，收尾会打印明确的下一步。
# ⛔ 不加 `git worktree lock`（老板 2026-11-17 定：官方 archive.ts 的 unused() 已有 cwd 检测）。

# 登记表落点：跟仓走（<仓>/.agents/trees.json），不是 ~/.dsh —— 树是仓的属性，不是 home 的属性。
trees_registry_path() { printf '%s\n' "$REPO/.agents/trees.json"; }

# 登记表的 CAS 锁。
# ⚠️ **不能拿登记表自身当锁文件**：它靠 rename 落地，而 rename 换 inode —— 持锁方锁住的是
#   旧 inode，后来者打开新文件立刻拿到锁，互斥形同虚设（这类"锁对了名字、锁错了 inode"的
#   写法不会报错，只在并发下丢数据）。故用**永不 rename 的独立文件**。
# 放在池目录里是刻意的：池已被 .gitignore 覆盖（会话树形态 `*`／主检出形态在仓外 $WT_ROOT）
#   ⇒ 锁文件不会让任何树变脏；换个位置就得再往仓里加一条 ignore 规则。
trees_lock_path() { printf '%s\n' "$REPO/.agents/worktrees/.trees-cas.lock"; }

# 登记表 CAS。用法：trees_registry_cas <check|add|remove|remove-stale> <ISS> <path> <branch> <parent|"">
#   check        ⇒ 已有登记行则打印归属并 exit 3（不写）；无行 exit 0（ABSENT）
#   add          ⇒ 无行则写；已有行**且其 path 仍在盘上** ⇒ exit 3（调用方回滚）；登记行指向已删树 ⇒ 覆盖并出声
#   remove       ⇒ 行在且其 path 与 <path> 是同一棵树（归一比对）⇒ 删行（ISS-873，cmd_rm ②b）；
#                  对不上 ⇒ exit 3（防删错行）；无行 ⇒ no-op exit 0（ABSENT，`new` 的存量平级树）
#   remove-stale ⇒ 行在且其 path 已不在盘上 ⇒ 删行（rm 反方向，--force 清残留行）；
#                  行指向的树仍活着 ⇒ exit 3（LIVE，行不动 —— 它不是残留）
# 退出码：0 写入/检查通过 · 3 已存在或对不上（CAS 失败，不写）· 4 登记表在但读不动（判不了，不当通过）
# 写什么字段：**只有 kind / path / branch / parent 四个**，与 `.agents/trees.json` 的 `_readme`
#   逐条对齐（"没有当前消费者的字段不预建：log / owner / state / createdAt 等"）。
#   ⛔ 不要图省事往这里加 owner/createdAt：登记表是**准入约定**，不是树的名册；
#     加一个没人读的字段只会在下次谁改它时静默腐坏。归属（谁/何时）从**文件系统与 git** 现算。
# 实现要点（三条缺一条并发下就会丢行，反例见本单正文「无锁实现两进程都报 OK」）：
#   ① 读改写全程持 flock(LOCK_EX)；
#   ② 落盘 = 临时文件 + os.replace（POSIX 原子替换）⇒ 读者永远看到完整 JSON；
#   ③ 原子性判据是"行在不在"，不是"文件改没改" —— 两进程各写各的临时文件再依次 rename，
#      后 rename 的会把先 rename 的整份内容盖掉，正是①要防的那件事。
trees_registry_cas() {
  local mode="$1" iss="$2" path="$3" branch="$4" parent="$5"
  mkdir -p "$REPO/.agents/worktrees" 2>/dev/null || true
  python3 - "$(trees_registry_path)" "$(trees_lock_path)" "$mode" "$iss" "$path" "$branch" "$parent" <<'PY'
import fcntl, json, os, sys

reg, lock, mode, iss, path, branch, parent = sys.argv[1:8]
if mode not in ("check", "add", "remove", "remove-stale"):
    # 不认识的模式不许往下掉：掉进 add 分支 = 拿着调用方给的参数**写一行**进登记表（静默损坏）。
    print("UNKNOWN-MODE %s（合法：check | add | remove | remove-stale）" % mode); sys.exit(4)
try:
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o644)
except OSError as e:
    print("UNREADABLE 锁文件建不出来（%s）：%s" % (lock, e)); sys.exit(4)
fcntl.flock(fd, fcntl.LOCK_EX)   # ① 阻塞取锁：同一时刻只有一个进程在读改写

def fail(msg, code):
    fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)
    print(msg); sys.exit(code)

try:
    with open(reg, encoding="utf-8") as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
except Exception as e:
    fail("UNREADABLE %s：%s" % (reg, e), 4)     # 判不了 ≠ 通过（不许静默当空表覆盖掉）

row = data.get(iss)
live = isinstance(row, dict) and isinstance(row.get("path"), str) and os.path.isdir(row["path"])

if mode == "check":
    if isinstance(row, dict):
        fail("EXISTS " + json.dumps(row, ensure_ascii=False), 3)
    fail("ABSENT", 0)

# 归一但容忍叶子不存在：rm 删树之后整条 realpath 解不出（叶子没了），而软链形态的登记行
# （$REPO/.agents/worktrees/<ISS>）必须仍能与真实落点对上 ⇒ 只 resolve dirname。
def norm(p):
    p = (p or "").rstrip("/")
    return os.path.realpath(os.path.dirname(p)) + "/" + os.path.basename(p)

# 落盘 = 临时文件 + os.replace（POSIX 原子替换，同目录保证同一文件系统）⇒ 读者永远看到完整 JSON。
def save(d):
    tmp = "%s.tmp-%d" % (reg, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, reg)
    except Exception as e:
        try: os.unlink(tmp)
        except OSError: pass
        fail("UNREADABLE 写盘失败：%s" % e, 4)

# remove（cmd_rm ②b，ISS-873）：删树成功后删登记行 —— 行的 path 必须与刚删的那棵树
#   归一后对得上才删（防删错行）；对不上 ⇒ exit 3，行原地不动。
if mode == "remove":
    if not isinstance(row, dict):
        fail("ABSENT", 0)
    if not path or norm(row.get("path")) != norm(path):
        fail("MISMATCH " + json.dumps(row, ensure_ascii=False), 3)
    del data[iss]
    save(data)
    fail("REMOVED %s" % iss, 0)

# remove-stale（rm 反方向）：树已不在盘上时的残留行清理 —— 行指向的目录必须真不在了才删；
#   两步之间它又活了（有人重建）⇒ exit 3，行不动。
if mode == "remove-stale":
    if not isinstance(row, dict):
        fail("ABSENT", 0)
    if live:
        fail("LIVE " + json.dumps(row, ensure_ascii=False), 3)
    del data[iss]
    save(data)
    fail("REMOVED-STALE %s" % iss, 0)

# add：已有**活**行 ⇒ CAS 失败（活 = 它指的目录还在盘上；指向已删树的行是残留，该覆盖）
if live:
    fail("EXISTS " + json.dumps(row, ensure_ascii=False), 3)
stale = isinstance(row, dict)
data[iss] = {
    "kind": "issue",
    "path": path,
    "branch": branch,
    "parent": (parent or None),
}
save(data)

fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)
print("WROTE %s%s" % (iss, " · 覆盖了指向已删树的旧登记行" if stale else ""))
PY
}

# 归属信息（"谁/何时"）**现算**，不进登记表。
# 何时 = 该工作树 admin 目录的创建时间（.git/worktrees/<id>，git 在 worktree add 时创建）；
# 谁   = 分支 tip 的提交者（本单刚建，通常就是 base 的作者 —— 故这一项只作线索，不作归属证据）。
tree_attribution() {
  local path="$1" iss="$2" admin ctime who
  admin="$(git -C "$path" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
  ctime=""
  if [ -n "$admin" ] && [ -d "$admin" ]; then
    ctime="$(stat -f '%SB' -t '%Y-%m-%d %H:%M:%S' "$admin" 2>/dev/null \
          || stat -c '%w' "$admin" 2>/dev/null || true)"
  fi
  who="$(git -C "$REPO" log -1 --format='%an' "$iss" 2>/dev/null || true)"
  printf '路径 %s\n    何时 %s（工作树 admin 目录创建时间）%s\n' \
    "$path" "${ctime:-<取不到>}" "$( [ -n "$who" ] && printf '\n    分支 tip 提交者 %s（建树时 = base 作者，仅作线索）' "$who" )"
}

# allocate 的回滚：占位目录 + 半截 git 注册 + 只为本单新建的分支，一起退掉。
# ⚠️ 为什么必须回滚占位目录：留着空目录 ⇒ 下一次 allocate 走到 mkdir 判 EEXIST ⇒
#   「有人抢先」⇒ 这单从此建不出树，而屏幕上只说"已存在"。这正是 #5 验收要堵的形态。
# ⚠️ 为什么必须 `worktree prune`：`git worktree add` 失败时可能在 .git/worktrees/ 留下
#   admin 目录，不 prune 会让同名分支/路径的二次 add 报 "already registered"。
alloc_rollback() {
  local path="${1:-}" iss="${2:-}" branch_by_us="${3:-0}"
  # ⛔ rm -rf 前的绝对路径守卫：只允许删本单在池里的落点，别的一律不动。
  #   写成白名单而不是黑名单：路径拼错一格就要删错目录，代价不可逆。
  if [ -z "$path" ]; then return 0; fi
  case "$path" in
    "$REPO"/.agents/worktrees/?*|"$WT_ROOT"/?*) ;;
    *) c_err "拒绝回滚：落点不在池内（${path}）—— 这不是本命令建的目录"; return 1 ;;
  esac
  if [ -e "$path" ]; then
    if worktree_registered "$path"; then
      git -C "$REPO" worktree remove --force "$path" >/dev/null 2>&1 || true
    fi
    rm -rf "$path" 2>/dev/null || true
    [ -e "$path" ] && { c_err "回滚未完成：${path} 仍在盘上（权限/占用）⇒ 手工删掉再重跑"; return 1; }
    c_warn "已回滚占位与半截树：${path}"
  fi
  if [ "$branch_by_us" = "1" ] && git -C "$REPO" show-ref --verify --quiet "refs/heads/$iss"; then
    git -C "$REPO" branch -D "$iss" >/dev/null 2>&1 || true
  fi
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
  return 0
}

# 回写 Matter 单据的 worktree 字段（第 ⑤ 步的一半）。
# ⚠️ **best-effort，且失败必须出声**：建树与登记（真相源）已经成立，把整条命令判失败
#   只会让人重跑一次 allocate —— 那正好撞上"树已存在"。但**不许静默成功**：
#   单据的 worktree 字段是派单链路读的（issue-dispatch-protocol），漂移了要能看见。
# 环境变量：MATTER_BASE（默认 127.0.0.1:3210）· FORGE_PM_AGENT_TOKEN（写闸凭证）·
#           WS_ALLOC_NO_MATTER=1 显式跳过（离线/自测用）
alloc_writeback_matter() {
  local iss="$1" path="$2" base="${MATTER_BASE:-http://127.0.0.1:3210}" rel=""
  [ "${WS_ALLOC_NO_MATTER:-0}" = "1" ] && { c_warn "按 WS_ALLOC_NO_MATTER=1 跳过 Matter 回写（单据 worktree 字段未更新）"; return 0; }
  # /forge-pm/field 只吃 rel 路径（短号回 {"error":"invalid id"}）⇒ 先从活动流把 rel 捞出来
  rel="$(curl -s --max-time 6 "$base/forge-pm/logs?id=$iss&kind=activity" 2>/dev/null \
    | python3 -c 'import json,sys
try: items=json.load(sys.stdin).get("items") or []
except Exception: items=[]
print(next((i.get("for","") for i in items if str(i.get("for","")).startswith("issues/")), ""))' 2>/dev/null || true)"
  if [ -z "$rel" ]; then
    c_warn "Matter 回写跳过：查不到单据 rel 路径（服务未起 / 单号不存在）—— 单据 worktree 字段未更新"
    c_warn "  → 树与登记都已成立，不受影响；补写：matter_issue{action:update, id:$iss, worktree:\"$path\"}"
    return 0
  fi
  local body out
  body="$(python3 -c 'import json,sys; print(json.dumps({"id":sys.argv[1],"field":"worktree","value":sys.argv[2]}, ensure_ascii=False))' "$rel" "$path")"
  # 凭证头用**数组**拼，不写成 `${VAR:+-H "…： $VAR"}`：后者靠"引号在展开里"这个微妙规则才
  # 恰好正确，而同一个写法在别的上下文（如被当成一个词再切）就会静默漏掉头 ⇒ 请求变成匿名写
  # ⇒ 服务端 403，而屏幕上只说"回写失败"。数组没有这层歧义。
  local hdr=()
  [ -n "${FORGE_PM_AGENT_TOKEN:-}" ] && hdr=(-H "X-Matter-Agent-Token: ${FORGE_PM_AGENT_TOKEN}")
  # ⚠️ ISS-874：`${arr[@]+"${arr[@]}"}` 不是啰嗦，是**bash 3.2 的空数组安全展开**。
  #   裸写 `"${hdr[@]}"` 在 bash 3.2 + `set -u` 下展开**空数组**会报
  #   `hdr[@]: unbound variable` 并以非 0 退出（bash 4.4+ 才修这个行为）。
  #   macOS 自带 bash 3.2.57 ⇒ 没有 FORGE_PM_AGENT_TOKEN 的机器（含 CI）100% 触发。
  #   后果不是"回写失败"那么轻：树已建、登记已写，命令却整条 EXIT=1
  #   ⇒ 调用方以为建树失败 ⇒ 重跑撞 EXIT=3（已登记），或 set -e 在树已建成的状态下中止
  #   后续步骤（如 ws.sh deps），留下"有树无依赖"的半成品。
  #   同仓先例：本文件 :1579 的 `${g_ci_args[@]+"${g_ci_args[@]}"}` 就是这个写法。
  out="$(curl -s --max-time 6 -X POST "$base/forge-pm/field" -H 'content-type: application/json' \
    ${hdr[@]+"${hdr[@]}"} -d "$body" 2>/dev/null || true)"
  case "$out" in
    *'"ok":true'*) c_ok "已回写单据 worktree 字段：${iss}" ;;
    *noop*)        c_ok "单据 worktree 字段已是该值（无需改）：${iss}" ;;
    *) c_warn "Matter 回写**失败**（树与登记已成立，不影响本单）：$(printf '%s' "${out:-<无响应>}" | head -c 200)"
       c_warn "  → 补写：matter_issue{action:update, id:$iss, worktree:\"$path\"}" ;;
  esac
}

# 建工单树的唯一入口（ISS-872）。
#
# 五步（任一步失败必须回滚占位）：
#   ① 解析落点（复用 W-0 的 is_session_tree 双形态）
#   ② 登记表 CAS（已有活行 ⇒ 打印归属退出）
#   ③ mkdir 占位（原子互斥：没抢到的那个立刻退出，不是排队后再撞）
#   ④ 建树（池 + .gitignore 校验 → worktree add --no-checkout → 在新树里 reset --hard）
#   ⑤ 写账 + 回写单据（登记表 CAS 落盘；Matter worktree 字段 best-effort）
#
# base 默认 HEAD（= 会话树当前提交），与官方 create() 的 `request.from ?? 'HEAD'` 同口径。
# ⛔ **不要从 main 建**：会话树可能领先 main，从 main 建会丢掉会话树里已有的改动。
cmd_allocate() {
  local iss="${1:-}"; shift || true
  local base="HEAD"
  while [ $# -gt 0 ]; do
    case "$1" in
      --from) base="${2:-}"; [ -n "$base" ] || { c_err "--from 缺值"; exit 1; }; shift 2 ;;
      *) c_err "allocate 不认识参数：$1（用法：ws.sh allocate <ISS-NNN> [--from <ref>]）"; exit 1 ;;
    esac
  done
  if [ -z "$iss" ]; then
    c_err "用法: ws.sh allocate <ISS-NNN> [--from <ref>]"
    echo "   建工单树的唯一入口：建树 + 登记 .agents/trees.json + 回写单据 worktree 字段"
    exit 1
  fi
  case "$iss" in
    ISS-*) ;;
    *) c_err "单号形态不对：${iss}（应形如 ISS-872 —— 目录名 == 分支名 == 单号是 ws.sh 的落点约定）"; exit 1 ;;
  esac

  # ── ① 解析落点 ──────────────────────────────────────────────────────────────
  # 二级形态（$REPO 本身是别人的工作树）：工单树落在**会话树的池里**（老板 2026-11-17 定的
  #   恰好两级：主检出 → 会话树 → 工单树）。一级形态（$REPO 是主检出）：保持现行为，落 $WT_ROOT。
  local path
  if is_session_tree; then
    path="$REPO/.agents/worktrees/$iss"
    echo "── allocate ${iss} ──（二级形态：会话树 ${REPO}）"
  else
    path="$WT_ROOT/$iss"
    echo "── allocate ${iss} ──（一级形态：主检出 ${REPO} · 落点 ${WT_ROOT}）"
  fi
  echo "   落点   = $path"

  # ── ①b 池必须合规（落点就在池里，CAS 锁也在池里）─────────────────────────────
  # 会话树：真目录 + .gitignore:'*'（官方 PREPARE_DIRECTORY 的产物形状）；
  # 主检出：指向 $WT_ROOT 的软链（官方取落点走 realpath，靠它把树放到仓外）。
  # 池**不存在**时会话树当场建（本命令就是"建树的唯一入口"，让它要求人先手工建池
  #   等于把手工步骤留在原地）；**形态不符**一律拒绝，不擅自改别人的池。
  if ! pool_link_problem; then
    if [ "$POOL_PROBLEM" = "不存在" ] && is_session_tree; then
      mkdir -p "$REPO/.agents/worktrees" && printf '*\n' >"$REPO/.agents/worktrees/.gitignore"
      c_ok "已建池（会话树形态）：.agents/worktrees + .gitignore:'*'"
      pool_link_problem || { c_err "池建完仍不合规：${POOL_PROBLEM}"; exit 1; }
    else
      c_err "池目录不合规 ⇒ 拒绝建树：$REPO/.agents/worktrees ${POOL_PROBLEM}"
      c_err "  → 修法：$(pool_fix_cmd)"
      exit 1
    fi
  fi

  # base 必须是可解析的提交（写错 ref 时 git 的报错会被后面的 reset 扩大成半截现场）
  if ! git -C "$REPO" rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
    c_err "base 解析不出来：${base}（在 $REPO 里不是提交）"
    c_err "  → 默认取会话树 HEAD；要指定别的基线用 --from <ref>"
    exit 1
  fi
  local base_sha; base_sha="$(git -C "$REPO" rev-parse --short "${base}^{commit}")"

  # ── ② 登记表 CAS（读一遍，先给"已有人建过"一个明确归属）──────────────────────
  # 归属（谁/何时/哪条会话）**现算**、不进登记表 —— 登记表只落判据要用的四个字段。
  local cas_out cas_rc=0
  cas_out="$(trees_registry_cas check "$iss" "$path" "$iss" "" 2>&1)" || cas_rc=$?
  case "$cas_rc" in
    0) : ;;
    3) local row_path
       row_path="$(printf '%s' "${cas_out#EXISTS }" | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("path",""))
except Exception: print("")' 2>/dev/null || true)"
       c_err "本单已有工作树登记 ⇒ 不再建第二棵：${iss}"
       if [ -n "$row_path" ] && [ -d "$row_path" ]; then
         tree_attribution "$row_path" "$iss" | sed 's/^/    /'
         c_err "  → 要在那棵树里干活：cd $row_path"
       else
         c_warn "  登记行指向的树${row_path:+（${row_path}）}**已不在盘上** —— 这是收树后没删行的残留"
         c_err "  → 本命令会清掉残留行再建；直接重跑：bash $0 allocate ${iss}"
       fi
       exit 3 ;;
    4) c_err "登记表读不动 ⇒ 拒绝建树（判不了不许当通过）：${cas_out#UNREADABLE }"
       c_err "  → 修好 $(trees_registry_path) 的 JSON 再来"
       exit 1 ;;
    *) c_err "登记表检查失败（无法解析输出）：${cas_out:-<空>}"; exit 1 ;;
  esac

  # ── ③ mkdir 占位（原子互斥）──────────────────────────────────────────────────
  # 为什么是 mkdir 而不是先写登记表：**并发下两个进程都会通过 ② 的读**，
  #   唯一能保证"只有一个建成"的是文件系统给的原子操作。mkdir（不带 -p）的 EEXIST
  #   就是"没抢到"，语义与官方 directory.ts:11-22 同。
  #   登记表的 CAS 在 ⑤ 再落一次，两边都成立才认为这棵树是"这条命令建的"。
  if [ -e "$path" ]; then
    c_err "落点已存在，没抢到：${path}"
    if [ -d "$path" ] && [ -z "$(ls -A "$path" 2>/dev/null)" ]; then
      c_err "  → 它是个**空目录**（上一次失败留下的占位？）⇒ 先删掉再重跑：rmdir '$path'"
    else
      c_err "  → 先看清它是什么：git -C '$path' status ／ ls -a '$path'"
      c_err "  → 确实没用就 ws.sh rm ${iss} 或手工清掉"
    fi
    exit 3
  fi
  if ! mkdir "$path" 2>/dev/null; then
    c_err "没抢到占位：${path}（另一个进程刚建了它）"
    exit 3
  fi
  c_ok "已占位：$path"

  # ── ④ 建树 ──────────────────────────────────────────────────────────────────
  # ⚠️ 顺序与参数两条都是实测踩出来的：
  #   ① `--no-checkout` + 随后**在新树里** `reset --hard`：`worktree add` 直接 checkout 时
  #      会把 index 与工作区一起铺开，但 base 之外的脏状态不受控；两步法是对官方 create 的模仿。
  #   ② reset **必须在新树里跑**（`git -C "$path" reset`）。若按 `--work-tree <会话树>` 的写法跑，
  #      被 reset 的是**会话树**、新树仍是空的（实测：新树里只有 .git，没有任何文件）——
  #      而两条命令的退出码都是 0 ⇒ 静默建出一棵空树。
  if ! git -C "$REPO" worktree add --no-checkout -b "$iss" -- "$path" "$base" >/tmp/ws-alloc-add.$$ 2>&1; then
    c_err "worktree add 失败："
    sed -n '1,6p' /tmp/ws-alloc-add.$$ | sed 's/^/    /'
    rm -f /tmp/ws-alloc-add.$$
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/$iss"; then
      c_err "  → 分支 ${iss} 已存在（上一轮的残留？）⇒ 先看它是什么：git -C '$REPO' log -1 --oneline $iss"
      c_err "  → 确认要重开：git -C '$REPO' branch -D ${iss} 后重跑（本命令不替你删分支）"
    fi
    alloc_rollback "$path" "$iss" 0
    exit 1
  fi
  rm -f /tmp/ws-alloc-add.$$
  if ! git -C "$path" reset --hard --no-recurse-submodules "$base" >/tmp/ws-alloc-reset.$$ 2>&1; then
    c_err "reset --hard 失败（新树里）："
    sed -n '1,6p' /tmp/ws-alloc-reset.$$ | sed 's/^/    /'
    rm -f /tmp/ws-alloc-reset.$$
    alloc_rollback "$path" "$iss" 1
    exit 1
  fi
  rm -f /tmp/ws-alloc-reset.$$
  local n_files
  n_files="$(ls -A "$path" 2>/dev/null | grep -vc '^\.git$' || true)"
  if [ "${n_files:-0}" -eq 0 ]; then
    # 空树 = 建了但没用，且后续所有命令都会"成功"地跑在空目录上（最坏的静默错）
    c_err "建出来的树是**空的**（除 .git 外无任何文件）⇒ 判失败并回滚"
    c_err "  → 这通常意味着 reset 跑错了树（见本函数 ④ 的注释）"
    alloc_rollback "$path" "$iss" 1
    exit 1
  fi
  c_ok "已建树：${path}（${n_files} 个顶层条目 · 分支 ${iss} · base ${base_sha}）"

  # ── ⑤ 写账 + 回写 ───────────────────────────────────────────────────────────
  # parent 只在一级/二级形态下取值：会话树形态记外层会话树；主检出形态记空（level-0 平级树，
  #   与存量 52 棵同口径 —— 判据把主检出排除在父节点之外，写空才是对的）。
  local outer_key=""
  if is_session_tree; then outer_key="$REPO"; fi
  local reg_out reg_rc=0
  reg_out="$(trees_registry_cas add "$iss" "$path" "$iss" "$outer_key" 2>&1)" || reg_rc=$?
  if [ "$reg_rc" != "0" ]; then
    c_err "登记失败（exit ${reg_rc}）⇒ 回滚已建好的树（不许留一棵没登记的树）："
    c_err "  ${reg_out}"
    alloc_rollback "$path" "$iss" 1
    exit 1
  fi
  c_ok "已登记：${reg_out#WROTE }"

  echo "   落后 main：$(git -C "$path" rev-list --count HEAD..main 2>/dev/null || echo '?') 个提交（非 0 就先同步，别在旧基线上写）"
  alloc_writeback_matter "$iss" "$path"

  echo
  echo "下一步：cd $path"
  echo "  依赖与产物**未**准备（allocate 只建树与登记）⇒ 进树后先跑：bash $REPO/scripts/ws.sh deps ${iss}"
}

cmd_link() {
  local target="${1:-}"; shift || true
  if [ -z "$target" ]; then c_err "用法: ws.sh link <ISS-NNN|main> [pkg..] [--all]"; exit 1; fi
  # ISS-416：`--all` 从参数里摘出来（其余才是包名白名单）
  local force_all=0 pkgs="" a
  for a in "$@"; do
    if [ "$a" = "--all" ]; then force_all=1; else pkgs="$pkgs $a"; fi
  done
  local path
  if [ "$target" = "main" ]; then
    path="$REPO"
  elif [ -d "$WT_ROOT/$target" ]; then
    path="$WT_ROOT/$target"
  elif [ -d "$REPO/.wt/$target" ]; then
    path="$REPO/.wt/$target"
  else
    c_err "找不到工作树：$target"; exit 1
  fi
  if [ ! -d "$PROFILES_NM" ]; then c_err "插件挂载目录不存在：$PROFILES_NM"; exit 1; fi
  local n=0 linked="" skipped="" skipped_lease="" write_bad="" only="${pkgs# }"
  for pkg in "$path"/forge-*/; do
    [ -d "$pkg" ] || continue
    local name
    name="$(basename "$pkg")"
    # 只切已挂载的插件（挂载名单是 profile 的契约，不擅自新增）
    [ -L "$PROFILES_NM/$name" ] || continue
    # ① 显式白名单（`ws.sh link <ISS> forge-pm` 只切指名的那几个；不指定 = 全切）
    if [ -n "$only" ]; then
      case " $only " in *" $name "*) ;; *) continue ;; esac
    fi
    # ② 缺 dist 的工作树包一律跳过（ISS-334）：client bundle 是构建产物、不入库，
    #    工作树里通常只有刚构建过的那个插件有 dist —— 切过去只会让工作台白屏。
    #    判据刻意只看「工作树有没有 dist」，不掺「主 checkout 有没有」——后者会让
    #    本来就不带 dist 的纯 host 插件（archive / b-bridge / combo-model / role）漏切过去，
    #    造成「N 个已切 ＋ M 个被跳过」的自相矛盾输出。
    if [ "$path" != "$REPO" ] && [ ! -d "$pkg/dist" ] && has_client "$pkg"; then
      skipped="$skipped $name"
      continue
    fi
    # ③ ISS-416：**切回 main** 时不得踩别人在途的验证现场。
    #    真实事故：会话A 收工跑裸 `link main`，把会话B 刚切到工作树的包一起切回主
    #    checkout → 会话B 三轮真机验证跑的全是旧代码，表现为「我的修改像被回退了」。
    #    规则：目标包的链接指向的工作树若正被一张**在途租约**保护 → 裸调用（无包名）跳过并警告；
    #    显式点名（有包名）视为有意覆盖 → 放行但大声警告。`--all` 一律强切。
    local t other
    t="$(link_target_of "$name")"
    other="$(worktree_iss_of_link "$t")"
    if [ -n "$other" ] && lease_held_by "$other"; then
      if [ "$force_all" != "1" ] && [ -z "$only" ]; then
        skipped_lease="$skipped_lease $name($other)"
        continue
      fi
      c_warn "覆盖：$name 正指向 ${other} 的在途验证现场（该单持有租约）"
    fi
    if ! link_symlink "$pkg" "$PROFILES_NM/$name"; then
      # 本脚本开了 `set -e`：以前 link_symlink 返 1 会**当场掐断整条命令**，下面的对账与
      # 「跳过了哪些包」的说明一个字都不会打印 —— 现场只剩一行报错 + 半套已切的链接。
      # 现在先把失败记下来，等循环收尾一起报（失败形状要说清是"哪一个、为什么"）。
      write_bad="$write_bad $name(写失败)"
      continue
    fi
    linked="$linked $name"
    n=$((n+1))
  done
  # ④ ISS-554：**写完必须对账**。这条命令历史上报"✓ 已切 N 个"而目标进程读的是另一个家 ⇒
  #    "失败伪装成成功"是比失败更贵的东西（验证者会以为验的是新代码）。
  local bad="$write_bad"
  for name in $linked; do
    local got got_norm want_root want_plain
    got="$(readlink "$PROFILES_NM/$name" 2>/dev/null || true)"
    # ⚠️ 比较前**必须去掉尾部斜杠**：`for pkg in "$path"/forge-*/` 的 glob 自带尾斜杠，
    #    `ln -s` 又把参数原样写进链接内容 ⇒ 实指形如 `…/forge-pm/`，而期望值是 `…/forge-pm`。
    #    本机两条真实链接就是两种形状（`~/.dsh-matter/.../forge-pm` 无斜杠、`forge-ui/` 有斜杠），
    #    拿字面串硬比会让"该绿的也红"——永远响的守卫等于没有守卫（ISS-554 自查时发现）。
    got_norm="${got%/}"
    # ⚠️ `$name` 是 `basename "$pkg"`，**本身已带 `forge-` 前缀**（上面写链接时用的就是 `$PROFILES_NM/$name`）。
    #    这里再拼一次 `forge-` 会得到 `forge-forge-pm` ⇒ 每次都判红（自测场景 9 抓出来的，
    #    离线手写的小对照反而放过它——期望值是我照印象拼的，不是从真相源取的）。
    want_root="$(cd "$path" 2>/dev/null && pwd)/$name"
    want_plain="${path%/}/$name"
    case "$got_norm" in
      "$want_root"|"$want_plain") ;;
      *) bad="$bad $name(实指:${got:-无})" ;;
    esac
  done
  if [ -n "$bad" ]; then
    c_err "symlink 对账失败（报成功也没用）：$bad"
    c_err "  写入的家 = ${PROFILES_NM}；服务读的可能是另一个 ⇒ 设 DSH_HOME 或用 WS_PROFILES_NM 显式指过去"
    exit 1
  fi
  # ⑤ ISS-554 同形：**指名的包没被切，也不许打印"已把 0 个插件…"**。
  #    历史上 `ws.sh link <ISS> forge-xyz` 在 forge-xyz 没挂进这个家时静默走完循环，输出
  #    "已把 0 个插件 symlink 指向 …" 并 exit 0 —— 调用方（含派单脚本）读到 0 就是成功。
  local not_done="" q
  for q in $only; do
    case " $linked $skipped " in *" $q "*) continue ;; esac
    not_done="$not_done $q"
  done
  if [ -n "$not_done" ]; then
    c_err "指名的插件一个都没切过去：${not_done# }"
    c_err "  原因只可能是这两种：该插件不在这棵树（${path}）里，或没挂进这个家（$PROFILES_NM 下没有同名 symlink）"
    c_err "  挂载名单是 profile 的契约，本命令不擅自新增 ⇒ 要让服务读它，先在 cordis.patch.yml 挂上再切"
    exit 1
  fi
  if [ "$n" -gt 0 ]; then
    c_ok "已把 $n 个插件 symlink 指向 ${path}（家：$PROFILES_NM · 逐个 readlink 已对账）"
  elif [ -n "$skipped_lease" ]; then
    # 第四轮 L-1142：一个都没切、却打成功行 —— 调用方读 rc=0 会以为换码生效了（正是"命令跑成功但没换码"）
    c_err "一个插件都没切（$n=0）：候选全被在途租约护栏跳过 ⇒ 这次 link 等于没发生"
  else
    c_ok "已把 0 个插件 symlink 指向 ${path}（该树上没有已挂载的插件包 · 家：${PROFILES_NM}）"
  fi
  if [ -z "${DSH_HOME:-}" ] && [ -d "$HOME/.dsh-matter/profiles/node_modules" ] && [ "$PROFILES_NM" = "$HOME/.dsh/profiles/node_modules" ]; then
    c_warn "没设 DSH_HOME，这次写的是 ~/.dsh 那家；而本机存在 ~/.dsh-matter（3210 常读的那家）⇒ 若目标是 3210，请带 DSH_HOME 重跑"
  fi
  if [ -n "$skipped_lease" ]; then
    if [ "$(lock_stale_reason)" = "unreadable" ]; then
      # 别说"他人在途租约"——那是不实的原因。真实情况是锁读不出、无从确认，按在途保护。
      c_warn "（下面这些包没被切走，是因为锁文件读不出：${LOCK_FILE} ⇒ 无法确认是否有人在用，一律按在途保护）"
    fi
    c_warn "以下插件指向**他人在途租约**的工作树 → 已跳过（避免踩掉别人的验证现场）："
    c_warn "  ${skipped_lease# }"
    c_warn "  确认对方已收工再切：等租约过期（ws.sh status 看到期时间）或确要强切加 --all"
  fi
  if [ -n "$skipped" ]; then
    c_warn "以下插件在工作树里缺 dist（client bundle 未构建）→ 已保留主 checkout 指向："
    c_warn "  ${skipped# }"
    c_warn "如需一并切过去，先构建：cd <工作树>/<插件> && bun run build:client"
  fi
  if [ "$n" = "0" ] && [ -n "$skipped_lease" ]; then
    c_err "  → 等对方收工（ws.sh status 看到期时间），或确要强切加 --all"
    exit 3
  fi
  # ISS-558：不再默认引导重启 3210（它是 App 19387 的数据源）。默认动作 = 隔离实例。
  c_warn "不要为了验证重启 3210 —— 它是 App(19387) Matter 面板的数据源，重启 = 老板界面中断 5-12s + 控制台 502"
  c_warn "① 方向（生产 3210 不动）—— 隔离实例：bash $REPO/scripts/dev-instance.sh start <ISS-NNN>"
  c_warn "   ⚠️ **该脚本当前不可用**（四条欠账：老 home 假设 ⇒ PM 层悬空 / 装配树旧拷贝），修好前别照这条执行，见 §4.6"
  c_warn "② 修好前确需重启 3210 —— 显式确认：FORGE_ALLOW_RESTART_PROD=1 bash $REPO/scripts/restart-matter.sh"
  c_warn "   （不带变量会被牙拦下，退出码 4 —— 判据 scripts/prod-guard.sh）"
}

cmd_claim() {
  local iss="${1:-}"; shift || true
  local force=0
  for a in "$@"; do if [ "$a" = "--force" ]; then force=1; fi; done
  if [ -z "$iss" ]; then c_err "用法: ws.sh claim <ISS-NNN> [--force]"; exit 1; fi

  if [ -f "$LOCK_FILE" ] && ! lock_expired; then
    local owner lreason_claim
    lreason_claim="$(lock_stale_reason)"
    owner="$(lock_field owner)"
    if [ "$force" != "1" ]; then
      if [ "$(lock_stale_reason)" = "unreadable" ]; then
        c_err "已被占用：锁文件读不出（${LOCK_FILE}）⇒ 按有人占着处理；确无人请加 --force"
      else
        c_err "已被占用：$(lock_field iss) / ${owner}（要强夺加 --force）"
      fi
      exit 3
    fi
    if [ "$lreason_claim" = "unreadable" ]; then
      c_warn "强制接管一把读不出的锁：无法说明原持有者，请在提交或 note 里写明为什么"
    else
      c_warn "强制接管（原持有者：${owner}）"
    fi
  fi

  local expire
  expire="$(python3 -c "
import datetime
print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=$LOCK_TTL_MIN)).strftime('%Y-%m-%dT%H:%M:%SZ'))
")"
  mkdir -p "$STATE_DIR"
  WS_STATE_DIR_RESOLVED="$STATE_DIR" python3 - "$LOCK_FILE" "$iss" "$expire" "$(cur_branch)" <<'PY'
import datetime, json, os, sys
path, iss, expire, branch = sys.argv[1:5]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
# ISS-552：多带三个**只增不改语义**的字段。旧脚本按 key 取值，多出来的键直接被忽略 ⇒
# 兼容；而它们正是"每树租约"（W-2）落地时要读的东西：在哪个目录声明的、看的哪个家、谁自报的 owner。
json.dump({"iss": iss, "owner": os.environ.get("WS_OWNER") or "未署名", "branch": branch,
           "since": now, "expire": expire, "pid": os.getpid(),
           "cwd": os.environ.get("PWD") or os.getcwd(), "stateDir": os.environ.get("WS_STATE_DIR_RESOLVED") or "",
           "ttlMin": int(os.environ.get("WS_LOCK_TTL_MIN") or 120)},
          open(path, "w"), ensure_ascii=False, indent=2)
PY
  c_ok "已占用：${iss}（至 ${expire}）"
  if [ -z "${WS_OWNER:-}" ]; then
    c_warn "  owner 记为「未署名」——护栏答不了「是谁在占」。下次 claim 前导出 WS_OWNER=<品牌:单号>（如 qoder:ISS-583）"
  fi
  home_split_note
}

cmd_release() {
  # ── ISS-552 W-1（= 旧账 ISS-802）：释放必须**校归属** ──────────────────────────
  # 改之前的行为：`cmd_release` 无条件写 `{}` —— 任何会话敲一下（或跑 `ws.sh rm <别的单>`）
  # 就把别人的在途租约抹掉。症状不是"报错"而是**别人继续以为自己占着那块地**：
  # 护栏（link main / rm 的回收）从此对他失效，正是本单要根除的互踩形态。
  # 现在：只许释放"自己这张地"的租约；要动别人的必须显式 --force，且强制路径会大声说原持有者。
  local target="" force=0 a
  for a in "$@"; do
    case "$a" in
      --force) force=1 ;;
      ISS-*)   target="$a" ;;
      *) c_err "release 不认识参数：${a}（用法：ws.sh release [ISS-NNN] [--force]）"; exit 1 ;;
    esac
  done
  [ -n "$target" ] || target="$(my_iss_from_cwd)"
  if [ ! -f "$LOCK_FILE" ]; then c_warn "当前没有租约（锁文件不在 ${LOCK_FILE}）"; home_split_note; return 0; fi
  local holder owner since exp lreason
  holder="$(lock_field iss)"; owner="$(lock_field owner)"; since="$(lock_field since)"; exp="$(lock_field expire)"
  lreason="$(lock_stale_reason)"
  if [ "$lreason" = "unreadable" ]; then
    # 读不出 ≠ 没人在：默认拒写。旧写法把空 holder 一律当"已释放"，于是 python3 坏一下、
    # 或锁文件被截断，就能把别人正在用的租约抹成 `{}`（护栏对他失明）。
    if [ "$force" != "1" ]; then
      c_err "拒绝释放：锁文件在但读不出 ${LOCK_FILE}"
      c_err "  → 先看是不是被截断/手改；确无人占用再加 --force（这一支必须真能用，否则话术是死循环）"
      home_split_note
      exit 1
    fi
    c_warn "强制覆盖一把读不出的锁：无法说明原持有者，请在提交或 note 里写明为什么"
    printf '{}\n' > "$LOCK_FILE" && c_ok "已按 --force 清账：${LOCK_FILE}"
    home_split_note
    return 0
  fi
  if [ "$lreason" = "released" ]; then
    printf '{}\n' > "$LOCK_FILE" && c_ok "租约已是「已释放」态，重写一遍确认"
    return 0
  fi
  if [ -z "$target" ] && [ "$force" != "1" ]; then
    c_err "锁上是在途租约 ${holder}（${owner}，${since} → ${exp}），而当前目录分支名里没有单号 —— 不替你猜要释放谁的。"
    c_err "  是自己的：ws.sh release ${holder}"
    c_err "  不是自己的：什么都别做（去问持有者），确要接管用 claim ${holder} --force"
    home_split_note
    exit 1
  fi
  if [ "$holder" != "$target" ] && ! lock_expired && [ "$force" != "1" ]; then
    c_err "这不是你的租约：锁上是 ${holder}（${owner}，${since} → ${exp}），你要释放的是 ${target}"
    c_err "  释放别人的租约 = 别人继续以为自己占着地，而护栏已经对他失明（ISS-802 / ISS-552 W-1）"
    c_err "  先跟持有者确认；确要接管：ws.sh claim ${target} --force（或 release ${target} --force 并说明理由）"
    home_split_note
    exit 3
  fi
  # 单号对得上 ≠ 是你这块地。`status` 会把 `ws.sh release <单号>` 原样打在屏幕上给人敲，
  # 于是**任何人**照着敲都能把别人未到期的活租约抹成 `{}`（2026-10-03 第二轮审查实测 exit=0）。
  # 所以再比一次持有者：两边都署了名且不同 ⇒ 必须 --force；锁上没署名（linmo/未署名）没法怪人，
  # 但自己没导出 WS_OWNER 时也大声提醒 —— 护栏答不了「是谁」这件事本身就是这条判据的来由。
  if [ "$holder" = "$target" ] && ! lock_expired && [ "$force" != "1" ] && ! lease_is_mine "$target"; then
    c_err "持有者不是你来：${target} 锁上写的是「${owner}」，你自报「${WS_OWNER:-<未署名>}」，当前分支也推不出这张单"
    c_err "  → 是你的：带上 WS_OWNER=${owner} 再来（或就在那棵工作树里跑）；不是：什么都别动（确要接管加 --force 并说明理由）"
    home_split_note
    exit 3
  fi
  if [ "$holder" != "$target" ]; then
    c_warn "强制释放他人租约：${holder}（原持有者 ${owner}，自 ${since}）—— 请在提交或 note 里说明为什么"
  elif lock_expired; then
    c_warn "租约已过期（原定 ${exp}），代为清账"
  fi
  # 独占租约的释放：**不用 `rm -f`** —— agent 沙箱的「批量删除守卫」会拦截对锁文件的删除
  # （实测 `[safe-delete] count=500 threshold=500`），被拦后租约**永久残留** →
  # `lease_held_by` 一直为真 → `link main` **永久跳过该包**（ISS-416 护栏从保护变成阻塞）。
  # 改为写入「已释放」态：`lock_stale_reason` 对它返回 `released`（既不是"有人占"也不是"读不出"），
  # 于是 `lock_expired` 判可接管、`lease_held_by` 返回 false，而 claim 不会把它当成阻塞。
  # 下次 `claim` 会整份覆盖，残留的空对象无害。
  printf '{}\n' > "$LOCK_FILE" && c_ok "已释放租约：${holder}"
}

cmd_baseline() {
  local sub="${1:-save}" label="${2:-default}"
  if [ "$sub" = "save" ]; then
    local head
    head="$(git -C "$REPO" rev-parse HEAD)"
    mkdir -p "$STATE_DIR"
    REPO="$REPO" python3 - "$BASE_FILE" "$label" "$head" "$(cur_branch)" <<'PY'
import datetime, json, os, subprocess, sys
path, label, head, branch = sys.argv[1:5]
repo = os.environ.get("REPO", "<repo>")
out = subprocess.run(["git", "-C", repo, "status", "--porcelain"], capture_output=True, text=True).stdout
dirty = [d for d in out.strip().split("\n") if d.strip()]
json.dump({"label": label, "head": head, "branch": branch,
           "at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "dirty": dirty},
          open(path, "w"), ensure_ascii=False, indent=2)
print(f"  分支 {branch}@{head[:7]}，脏文件 {len(dirty)} 个")
PY
    c_ok "基线已记录（${label}）"
    return
  fi

  if [ ! -f "$BASE_FILE" ]; then c_warn "没有基线可比（先 ws.sh baseline save）"; exit 0; fi
  local bh bb ch cb drift=0
  bh="$(python3 -c "import json;print(json.load(open('$BASE_FILE')).get('head',''))" 2>/dev/null || true)"
  bb="$(python3 -c "import json;print(json.load(open('$BASE_FILE')).get('branch',''))" 2>/dev/null || true)"
  ch="$(git -C "$REPO" rev-parse HEAD)"
  cb="$(cur_branch)"
  if [ "$bh" != "$ch" ]; then c_err "HEAD 漂移：基线 ${bh:0:7} → 现在 ${ch:0:7}"; drift=1; fi
  if [ "$bb" != "$cb" ]; then c_err "分支漂移：基线 $bb → 现在 ${cb}（工作区被切走）"; drift=1; fi

  REPO="$REPO" python3 - "$BASE_FILE" <<'PY' || rc=$?
import json, os, subprocess, sys
base = json.load(open(sys.argv[1]))
repo = os.environ.get("REPO", "<repo>")
out = subprocess.run(["git", "-C", repo, "status", "--porcelain"], capture_output=True, text=True).stdout
now = set(d for d in out.strip().split("\n") if d.strip())
was = set(base.get("dirty", []))
gone = was - now
added = now - was
for g in sorted(gone):
    print(f"  ! 基线里的改动不见了: {g}")
for a in sorted(added):
    print(f"  + 基线之后新增的改动: {a}")
sys.exit(2 if (gone or added) else 0)
PY
  rc="${rc:-0}"
  if [ "$drift" = "1" ]; then exit 2; fi
  if [ "$rc" = "2" ]; then c_warn "工作区相对基线有变化（未必是事故，请确认是否你自己改的）"; exit 2; fi
  c_ok "工作区与基线一致（无漂移）"
}

# ── prune：清理已收口的工作树（2026-10-19 · 老板批「用 prune + 合并后自动调」）
#
# 解决的事故形态：工作树只建不删。实测 2026-10-19：31 个工作树 / 52 个分支，
# 其中 28 个已收口但没人回头 rm。根因不是谁不负责，是**收尾没有触发点** ——
# 建单有 `ws.sh new`、开发有 `claim`、合并有 git merge，但"合并完该 rm"全靠人记得。
#
# 判据（三条**同时**成立才删，任一不满足就保留并说明原因）：
#   ① 分支已收口：main 的历史里有 `merge(<iss>)` —— 只认括号里那个号，
#      子串匹配会被多单号 subject 与长短号误吃（同 lock_stale_reason 的教训）
#   ② 工作树无未提交的**真**改动：脏文件剔除构建产物后为空
#      （`forge-cad/static/vendor/**` 每次构建都变，它的脏不构成"有活没干完"）
#   ③ 分支已并入 main（`git branch --merged` 复核）—— 与 cmd_rm 内建的
#      "未合并会被 git 拒绝" 形成双保险，这里只是提前给出名单
#
# 安全边界：本命令**默认 dry-run**，只打印名单；带 `--apply` 才真删，
# 且真删走 cmd_rm（它自带归属检查、租约释放、未合并拒删）。
# 不碰主 checkout；不碰 `.gate-base`；不碰 detached HEAD。
cmd_prune() {
  local apply=0
  for a in "$@"; do [ "$a" = "--apply" ] && apply=1; done
  # K9c：不吞 git 的失败 —— 「读不到 ≠ 没有」。main 读不出是严重状态（可能不是 git 仓/分支名变了），
  # 静默成空串会让本节打一句「没有 merge 提交」然后什么都不做，把故障伪装成正常空态。
  local merges
  if ! merges="$(git -C "$REPO" log -2000 --format=%s main | grep -oE 'merge\(ISS-[0-9]+\)' | sed 's/merge(\(ISS-[0-9]*\))/\1/' | sort -u)"; then
    c_err "读不出 main 的历史（git log 失败）⇒ 无法判断哪些分支已收口，什么都不删"
    c_err "  → 先确认当前目录是 git 仓、main 存在：git -C \"$REPO\" log -1 main"
    return 2
  fi
  [ -z "$merges" ] && { c_warn "main 上没有任何 merge(ISS-NNN) 提交 ⇒ 无法判断收口，什么都不删"; return 0; }

  local total=0 del=0 keep=0
  while IFS= read -r line; do
    local path; path="$(echo "$line" | awk '{print $1}')"
    [ "$path" = "$REPO" ] && continue                      # 主 checkout 永不删
    case "$path" in */.gate-base*) continue ;; esac        # 基线树不删
    local br; br="$(echo "$line" | sed -n 's/.*\[\([^]]*\)\].*/\1/p')"
    case "$br" in ISS-*) ;; *) continue ;; esac            # detached / 非单分支不碰
    total=$((total + 1))

    # ① 已收口？
    if ! printf '%s\n' "$merges" | grep -qx "$br"; then
      keep=$((keep + 1)); printf '  保留 %-12s —— 分支未收口（main 无 merge(%s)）\n' "$br" "$br"; continue
    fi
    # ② 无真改动？（剔除构建产物）
    # K9c：`git status` 读不出时**不当作「干净」** —— 那会删掉还有活的工作树。
    # 这里先用 if 判退出码，失败走「保留 + 报警」分支。
    local dirty
    # K9c：分两步判，不混用 ——
    #   步骤 1 拿 `git status` 自己的退出码：非 0 = 读不出（工作树坏了/不是 git 目录），
    #         **绝不能当作"干净"**，否则会删掉还有活的工作树。
    #   步骤 2 再过滤构建产物：grep 无匹配返回 1 是正常态（说明干净），不是故障。
    local st_out dirty
    if ! st_out="$(git -C "$path" status --porcelain)"; then
      keep=$((keep + 1)); printf '  保留 %-12s —— git status 读不出（不当作干净）\n' "$br"; continue
    fi
    dirty="$(printf '%s\n' "$st_out" | grep -v 'forge-cad/static/vendor/' | grep -v '^$')" || dirty=""
    if [ -n "$dirty" ]; then
      keep=$((keep + 1)); printf '  保留 %-12s —— 有未提交改动（%s 处）\n' "$br" "$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')"; continue
    fi
    # ③ 已并入 main？
    # `git branch --merged` 给**已检出到某工作树**的分支加 `+ ` 前缀（不是 `* `）——
    # 2026-10-19 实测：漏剥 `+` 会让所有在架分支都判成"未并入"，prune 一个都删不掉。
    # K9c：分支列表读不出 ⇒ 报警保留，不当作「未并入」（虽然同样不删，但要让故障可见）
    local merged_list
    if ! merged_list="$(git -C "$REPO" branch --merged main)"; then
      keep=$((keep + 1)); printf '  保留 %-12s —— git branch --merged 读不出\n' "$br"; continue
    fi
    if ! printf '%s\n' "$merged_list" | sed 's/^[+*] //; s/^ *//' | grep -qx "$br"; then
      keep=$((keep + 1)); printf '  保留 %-12s —— 分支未并入 main\n' "$br"; continue
    fi

    if [ "$apply" = "1" ]; then
      # 计数按**实际结果**记，不按"进入尝试"记 —— 2026-10-19 实测过一次：
      # 18 个全部 rm 失败，汇总却报"删 18"，差一点把假的清理结果当成做完了。
      # 只丢 stdout：stderr 留着，失败时人能看到 rm 到底卡在哪一步（K9c：别把错误信息也一起吞了）
      if ( cd "$REPO" && WS_IGNORE_BUILD_ARTIFACTS=1 bash scripts/ws.sh rm "$br" >/dev/null ); then
        del=$((del + 1)); c_ok "已删 $br"
      else
        keep=$((keep + 1)); c_warn "删除失败，保留 ${br}（手动看：bash scripts/ws.sh rm ${br}）"
      fi
    else
      del=$((del + 1)); printf '  可删 %-12s —— 已收口 + 无真改动 + 已并入\n' "$br"
    fi
  done < <(git -C "$REPO" worktree list)

  echo
  if [ "$apply" = "1" ]; then
    c_ok "清理完成：删 ${del} / 留 ${keep}（候选 ${total}）"
  else
    c_warn "dry-run：可删 ${del} / 保留 ${keep}（候选 ${total}）—— 加 --apply 才真删"
  fi
}

cmd_list() { git -C "$REPO" worktree list; }

case "${1:-status}" in
  status)   shift; cmd_status "$@" ;;
  allocate) shift; cmd_allocate "$@" ;;
  new)      shift; cmd_new "$@" ;;
  adopt)    shift; cmd_adopt "$@" ;;
  link)     shift; cmd_link "$@" ;;
  claim)    shift; cmd_claim "$@" ;;
  deps)     shift; cmd_deps "$@" ;;
  release)  shift; cmd_release "$@" ;;
  baseline) shift; cmd_baseline "$@" ;;
  guard)    shift; cmd_guard "$@" ;;
  doctor)   shift; cmd_doctor "$@" ;;
  rm)       shift; cmd_rm "$@" ;;
  list)     shift; cmd_list "$@" ;;
  prune)    shift; cmd_prune "$@" ;;
  # 帮助 = 文件头用法段（第 2 行到 `set -euo pipefail` 之前）。
  # ⚠️ 别写死行号：本段每次加命令都会变长，写死 '2,32p' 会在加命令时**静默截掉新条目**
  #   （ISS-872 加 allocate 时实测：第 32 行正好切在 adopt 的注释中间）。
  *) sed -n "2,$(( $(grep -n '^set -euo pipefail' "$0" | head -1 | cut -d: -f1) - 2 ))p" "$0" ;;
esac
