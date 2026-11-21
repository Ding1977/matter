#!/usr/bin/env bash
# restart-matter.sh: Matter 独立服务重启（ISS-968 （ISS-968 阶段 3 落位）—— 端口 3210 · DSH_HOME=~/.dsh-matter。
# 配方照 restart-web.sh（杀旧→起新→验证）+ dev-instance.sh（隔离 HOME 起盘 · ISS-675 就绪判据）。
#
# 写权语义：FORGE_PM_ROOT=~/.dsh-matter/pm ⇒ 本进程是 Matter 数据的唯一写者（DOC-341 架构锁点）。
#   阶段 1 = 快照并联（主盘 ~/.dsh/pm 仍由官方 App 写，本实例只读使用）；
#   阶段 2 切端后本进程成为唯一真相源写者。
# 引擎根共用 ~/dsh-local（0.2.0-rc.2）；db 跟 PM_ROOT 走（pm-store.js:124 dirname(PM_ROOT)/forge-pm.db）。
#
# ── ISS-558：kill 路径上的牙 ────────────────────────────────────────────────
# 本脚本是**完整重启（杀旧→起新→自检）的正规入口**，而它原先**无牙**（审查 MEDIUM-1：直接 kill
# 生产 3210 的脚本有 3 个，只有 restart-web-detached.sh 一处装了牙）。现两个 kill 站点都先过
# scripts/prod-guard.sh 的**同一判据**（lsof -p 查 $HOME/.dsh-matter/，不依赖 ps，fail-closed）。
#   退出码：0 = 正常 · 1 = 起盘/就绪失败 · 4 = **牙拦下**（生产实例且未带放行变量）
#   自愈通道：watchdog-matter.sh 委派时显式导出 FORGE_WATCHDOG_SELFHEAL=1 ⇒ 牙放行
#             （watchdog 是 3210 的自愈网，被牙拦下就形同虚设）。
set -u

PORT="${MATTER_PORT:-3210}"
MATTER_HOME="$HOME/.dsh-matter"
PM_ROOT="$MATTER_HOME/pm"
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/local/bin/node)"
DSH_BIN="$HOME/dsh-local/node_modules/@deepseek-ai/dsh/lib/bin.js"
LOG="$MATTER_HOME/matter.log"
PIDFILE="$MATTER_HOME/matter.pid"

[ -f "$DSH_BIN" ] || { echo "✗ 引擎根缺失：$DSH_BIN"; exit 1; }
[ -d "$PM_ROOT" ] || { echo "✗ 数据根缺失：${PM_ROOT}（先做快照迁移）"; exit 1; }

# ── ISS-670：挂「重启中」标记 ⇒ watchdog 在本窗口内让路 ────────────────────────
# 病因（2026-10-29 16:41 实测）：手动重启与 watchdog 自愈是两个**互不通知**的入口。
#   手动那边 kill 掉旧进程后，watchdog 的 5s 探测必然在「旧进程已死、新进程未就绪」这一段
#   看到 no-listener ⇒ 拍现场快照 + 再拉一次 ⇒ 一次重启出现**两份启动请求**、两条自愈账。
#   实测最坏形态：3210 的进程树把**手动路径自己的 restart-matter.sh** 一起带走
#   （restart-confirm.log 停在「在飞清单已落盘」，既无「就绪」也无「启动失败」，连
#   `restart-matter.sh 结束` 那行都没写）⇒ 于是两个 restart-matter.sh 并发跑，靠 pidfile /
#   端口 listener / 1b 同类扫描互相杀。AGENTS §4 的「同 profile 无写锁，并发写必坏会话日志」
#   就长在这条缝里。
# 修什么：只补**反方向**这一半。正向早就有（watchdog 委派时导出 FORGE_WATCHDOG_SELFHEAL ⇒ 牙放行），
#   反方向原先没有任何东西告诉 watchdog「人在重启，你别动」。
# 边界（**判据不在本文件**）：标记的挂/摘在本脚本；判「要不要让路、什么时候判过期」在
#   watchdog-matter.sh 的 `restart_in_progress()` —— 裁定只有那一处，本脚本不重复实现。
# ⚠️ 标记必须有三道失效闸，否则脚本崩了会把真自愈永久挡住：
#   ① 本进程退出即摘（`trap … EXIT`，覆盖 exit 0/1/4 全部出口）；
#   ② watchdog 侧「持有 pid 已死 ⇒ 判过期」。为什么单个 ① 不够：**SIGKILL 不跑 EXIT trap**
#      （本机 bash 3.2.57 实测：TERM/INT 会跑、KILL 不会）；手动路径被 3210 的进程树带走时
#      用的是哪一种，不由我们决定。只靠超时兜 ⇒ 那种残留会让 3210 白挂满 180s（一次真故障
#      被放大成三分钟停机）；
#   ③ watchdog 侧 mtime 超时（默认 180s，`FORGE_RESTART_MARKER_TTL` 可覆盖）。
# ⚠️ **只摘自己挂的**（比对文件里的 pid）：两个手动重启并发时，先退出的那个不许抹掉后者的标记
#   —— 否则后者窗口中途失去保护，竞争原样复现。
RESTART_MARKER="$MATTER_HOME/restart.inprogress"
RESTART_MARKER_TTL_NOTE="${FORGE_RESTART_MARKER_TTL:-180}"

marker_owned_by_me() {
  [ -f "$RESTART_MARKER" ] || return 1
  [ "$(sed -n 's/^pid=//p' "$RESTART_MARKER" 2>/dev/null | head -1 | tr -d '[:space:]')" = "$$" ]
}

clear_restart_marker() {
  marker_owned_by_me || return 0
  rm -f "$RESTART_MARKER" 2>/dev/null && return 0
  # 摘不掉必须出声：标记留着 ⇒ watchdog 要等超时或等本进程死才接管（可观测的降级，不是静默）
  printf '⚠️ 重启标记清不掉：%s（权限/沙箱）—— watchdog 会等它超时 %ss 或本进程退出后接管\n' \
    "$RESTART_MARKER" "$RESTART_MARKER_TTL_NOTE"
}
trap clear_restart_marker EXIT

# 挂在**任何 kill 之前**：本脚本从这一步起就可能让 3210 无监听，窗口全程要有人看着。
mkdir -p "$MATTER_HOME" 2>/dev/null
if printf 'pid=%s\nat=%s\nport=%s\nby=restart-matter.sh\n' \
  "$$" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$PORT" > "$RESTART_MARKER" 2>/dev/null; then
  printf '✓ 已挂「重启中」标记，watchdog 本轮让路：%s（pid %s · 超时 %ss）\n' \
    "$RESTART_MARKER" "$$" "$RESTART_MARKER_TTL_NOTE"
else
  # 写不进去不许挡住重启（受限环境仍要能重启），但必须出声：此时竞争保护不生效，是**已知降级**。
  printf '⚠️ 重启标记写不进去：%s（权限/沙箱）—— 重启照常，但 watchdog 可能在窗口内插手（ISS-670 的竞争会复现）\n' \
    "$RESTART_MARKER"
fi

# 牙：kill 任何进程之前先问 scripts/prod-guard.sh（**判据只有那一份**，本脚本不抄）。
GUARD="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/prod-guard.sh"
require_kill_ok() {  # $1 = pid；牙拦下 ⇒ 整脚本 exit 4（不 kill）
  [ -n "$1" ] || return 0
  bash "$GUARD" require-kill "$1" || exit 4
}

# 0. Agent Teams 运行时补丁（ISS-634）：补丁打在 node_modules 里，重装/升级即丢。
#    每次重启前幂等重放一次（已应用则秒过）；失败只告警不阻塞 —— 补丁不该挡住重启。
PATCHER="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/patches/team-tools.mjs"
if [ -f "$PATCHER" ]; then
  # 审查 ISS-634 · M1：原先写成 `node ... | tail -2 || echo` —— 管道后 $? 是 tail 的，
  #   `||` 分支是死码，锚点失配/断言失败都不会出现任何告警。故先取输出与退出码，再判。
  patch_out="$("$NODE_BIN" "$PATCHER" 2>&1)"
  patch_rc=$?
  printf '%s\n' "$patch_out" | tail -2
  if [ "$patch_rc" -ne 0 ]; then
    echo "⚠️ 团队补丁应用失败（rc=${patch_rc}）：功能降级 —— 无 remove_teammate / teammate 不能带预设 / 名册 removed 显示异常"
  fi
fi

# 0a. Inspector 状态帧预算补丁（ISS-686）：补丁同样打在 node_modules 里，重装/升级即丢。
#     不改这条：一个 DevTools 面板少刷一帧 ⇒ 微任务里抛未捕获异常 ⇒ installFailLoud
#     的 uncaughtException ⇒ proc.exit(1) ⇒ **整个 3210 退出，所有会话一起死**
#     （2026-11-03 一天两次，老板以为丢了活）。
#     纪律同上：**先取输出与退出码再判**（`| tail || echo` 是死码，$? 是 tail 的）；
#     **失败只告警不阻塞重启** —— 补丁不该挡住重启，旧码只是回到会崩的状态。
INSPECTOR_PATCHER="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/patches/inspector-frame-budget.mjs"
if [ -f "$INSPECTOR_PATCHER" ]; then
  inspector_out="$("$NODE_BIN" "$INSPECTOR_PATCHER" 2>&1)"
  inspector_rc=$?
  printf '%s\n' "$inspector_out" | tail -2
  if [ "$inspector_rc" -ne 0 ]; then
    echo "⚠️ Inspector 预算补丁应用失败（rc=${inspector_rc}）：风险面恢复 —— Cordis 树剪到顶格时 setState 会抛未捕获异常，可能带走整个 3210"
  fi
fi

# 0b. **重启前落一份在飞清单**（ISS-668）。必须在本步之后的所有 kill 之前 —— 见下面「为什么在 kill 前」。
#
# ## 为什么要在 kill 前（本步的存在理由）
# ISS-667 的自动恢复只读 `inflight.json`：读不到就直接返回 ⇒ 自动恢复完全不跑。
# 而原先**只有 watchdog 自愈**会落这份清单（`watchdog-matter.sh` 的 `snapshot_inflight_before_heal`），
# 手动重启路径一个 inflight 字样都没有。实测症状（2026-10-29）：清单 mtime 停在 10:40，而当时 14:14
# —— 差了 3.5 小时，里面写的「第X轮第Y步」早已不是现场。
#
# ## 为什么必须是「kill 前」而不是「kill 后」
# 清单的两层证据（`inflight.js` 的 L1/L2）在进程死后会变：L1 存活靠 `lsof` 看引擎持有 `session.lock`，
# 进程一死这层证据就没了。**实测对照**（同一条日志、同一个判据，只差进程死活）：
#   进程活着时落 ⇒ tier=`inflight`（存活+轮未结束）⇒ `planResume` 判 `not-interrupted` ⇒ **可续 0 项**
#   进程死后落 ⇒ tier=`interrupted` ⇒ **可续 1 项**
# ⇒ 断在半路这件事，只有「进程已经没了」才成立。所以重启用**两份**清单：
#   本步（kill 前）= 现场快照（谁在跑、第几步）——给人看，给对账用；
#   起盘后（`restart-resume.js` 的 `snapshotBeforeResume`）= 恢复输入（进程已死 ⇒ tier 才落到 interrupted）。
# 两份各司其职，别把其中一份删掉"合一"（合一后必有一端失真）。
#
# ## 三条要求（工单原话）
#   ① 不依赖 3210 存活 —— `inflight-cli.mjs` 纯盘上算，正是它存在的理由（见其文件头）；
#   ② 失败**不许阻断重启** —— 清单是锦上添花，重启是主目的；
#   ③ 但必须**出声** —— 静默失败等于回到「重启无痕」。
#
# ⚠️ CLI 路径**从本脚本位置推导**（照 watchdog-matter.sh:44 的写法），不硬编码主 checkout：
#    硬编码会在 worktree 里指到主 checkout 的旧代码（ISS-665 实测该文件不存在、清单静默跳过）。
RESTART_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"
INFLIGHT_CLI="$RESTART_REPO/forge-messenger/lib/inflight-cli.mjs"
if [ ! -f "$INFLIGHT_CLI" ]; then
  echo "⚠️ 找不到在飞清单 CLI：${INFLIGHT_CLI} —— 重启照常，但重启后自动恢复（ISS-667）读不到新鲜现场"
else
  # ⚠️ 输出与退出码要**分开取**（照第 0 步 ISS-634 M1 的教训：管道后 `$?` 是 tail 的，`||` 分支成死码）。
  #    退出码口径见 inflight-cli.mjs 文件头：0=已落盘 · 3=算出来但落盘失败（**不许当成功**）· 2=参数错。
  inflight_out="$("$NODE_BIN" "$INFLIGHT_CLI" --home "$MATTER_HOME" 2>&1)"
  inflight_rc=$?
  if [ "$inflight_rc" -eq 0 ]; then
    # 报一行数字（与 watchdog 同一取数面：从 json 里读，不重算 —— 重算会得出第二份结论）
    inflight_counts="$("$NODE_BIN" -e '
      const fs = require("node:fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const c = j.counts || {};
        process.stdout.write(["inflight", "interrupted", "warm"].map((k) => String(c[k] ?? "?")).join("/"));
      } catch { process.stdout.write("?/?/?") }
    ' "${MATTER_HOME}/forge-messenger/inflight.json" 2>/dev/null)"
    echo "✓ 重启前在飞清单已落盘（inflight/interrupted/warm = ${inflight_counts:-?/?/?}）：${MATTER_HOME}/forge-messenger/inflight.md"
  else
    echo "⚠️ 重启前在飞清单生成失败（rc=${inflight_rc}）—— 重启继续，但重启后自动恢复的「做到哪一步」会缺输入："
    printf '%s\n' "$inflight_out" | tail -3 | sed 's/^/    /'
  fi
fi

# 1. 杀旧（pidfile 优先，端口占用者兜底）
if [ -f "$PIDFILE" ]; then
  oldpid="$(cat "$PIDFILE")"
  if kill -0 "$oldpid" 2>/dev/null; then
    require_kill_ok "$oldpid"
    kill "$oldpid" 2>/dev/null || true
    sleep 2
    kill -0 "$oldpid" 2>/dev/null && kill -9 "$oldpid" 2>/dev/null || true
  fi
  # 清不掉旧 pidfile 不算致命（下面还有「端口占用者兜底」），但必须**出声** ——
  # 静默失败会让下一个人以为 pidfile 已经清过（ISS-655 实测：沙箱下这行被拦，只留一行 stderr）。
  rm -f "$PIDFILE" || echo "⚠️ 旧 pidfile 清不掉：${PIDFILE}（权限/沙箱）—— 继续按端口兜底"
fi
stray="$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$stray" ]; then
  require_kill_ok "$stray"
  kill "$stray" 2>/dev/null || true
  sleep 2
  lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && kill -9 "$stray" 2>/dev/null || true
fi

# 1b. 同类残留兜底扫描（ISS-662）—— 判据从「端口没人占」改成「**所有**同签名实例都退干净」。
#
# ## 为什么 1 还不够（本段的全部理由）
# 第 1 步只认两种身份：`① pidfile 记的` 与 `② 占着 $PORT 监听的`。
# 实测有一个僵尸**两条都不匹配**（ISS-662 现场）：
#     PID 65678 · 09:17 启动 · **不监听** 8100（新实例占着）· 也不在 pidfile 里
# ⇒ 第 1 步扫不到它 ⇒ 它一直活着，握着 2 条通达信 7709 连接 + 2 条 CLOSE_WAIT 泄漏。
# 两个实例抢同一个连接池，这才是"tdx 偶发连不上"的来源之一。
#
# 旧判据「端口没人占了 = 重启成功」在**旧进程已不监听**时必然漏 ——
# 这是「守卫射程不够」的又一实例：判据覆盖的现象 ≠ 要防的现象。
#
# ## 为什么用 ps 而不是 pgrep（实测，别改回去）
# `pgrep` **会排除调用者自身的祖先链**。本脚本的两个真实调用方里：
#   · watchdog（launchd 子进程）⇒ 3210 不是祖先 ⇒ pgrep 能看到
#   · **agent 会话内** ⇒ 3210 恰恰是祖先 ⇒ **pgrep 看不到 3210**（实测：
#     `pgrep -f 'bin.js'` 返回空，而 `ps -eo pid,command | grep bin.js` 能列出 27846）
# 用 pgrep 会得到一条"在 agent 里永远扫不到"的空判据 —— 那比没有更坏（假绿）。
# `ps -eo` 无此限制，故本段一律用 ps。
#
# ## 签名怎么定（不能宽到误杀）
# 只认"**同时**含 `--port $PORT` 且是引擎本体"的进程：
#   ① `bin.js ... --port <PORT>`  —— 3210 的真实签名（实测 27846）
#   ② `app.py --port <PORT>`      —— 行情服务若与 3210 共用本脚本时的签名
# 刻意**不**用 `node --port 3210` 这种宽模式：会误伤任何带该参数的调试进程。
_SIG_BIN="bin\.js.*--port[[:space:]]+${PORT}([[:space:]]|$)"
_SIG_APP="app\.py[[:space:]]+--port[[:space:]]+${PORT}([[:space:]]|$)"

# 收集同类实例（排除自身与父链，ps 输出里 pid 是第 1 列）
_self="$$"
_pids="$(
  ps -eo pid=,command= 2>/dev/null \
    | grep -E "$_SIG_BIN|$_SIG_APP" \
    | grep -v '[[:space:]]grep[[:space:]]' \
    | awk '{print $1}' \
    | grep -vx "$_self" \
    || true
)"
# 排除本 shell 的祖先链（若本脚本正是由 3210 派生的 —— agent 会话场景）。
# ⚠️ 实测两条坑：
#   ① 用进程替换 `<(printf ...)` 喂 grep 在本脚本的 `set -u` 下**静默失效**
#      （实测：祖先 27846 明明在链里却没被排除，扫描会去杀当前引擎自己）⇒ 改临时文件。
#   ② 祖先串不能直接 `printf '%s\n' $_anc` 后依赖 word-splitting 的副作用，
#      必须先落文件再 `grep -vxF -f`，判据才可复算。
_anc=""
_p="$PPID"
while [ -n "${_p:-}" ] && [ "$_p" != "0" ] && [ "$_p" != "1" ]; do
  _anc="$_anc $_p"
  _p="$(ps -o ppid= -p "$_p" 2>/dev/null | tr -d ' ')"
done
if [ -n "$_anc" ]; then
  _ancfile="$(mktemp 2>/dev/null || echo "/tmp/restart-matter-anc.$$")"
  if printf '%s\n' $_anc | sed '/^$/d' > "$_ancfile" 2>/dev/null; then
    _filtered="$(printf '%s\n' "$_pids" | grep -vxF -f "$_ancfile" 2>/dev/null || true)"
    _pids="$_filtered"
  fi
  rm -f "$_ancfile" 2>/dev/null || true
fi

# 正在监听 $PORT 的那个不算"残留" —— 它是第 1 步②的目标。
# 若它此刻还在（例如第 1 步因牙/权限没杀掉），下面的"未退出"提示会点名它，
# 而不是把它混进"僵尸"一类：两种现象处置不同（前者是重启不彻底，后者是孤儿泄漏）。
_listener="$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | head -1 || true)"

_n=0
for _pid in $_pids; do
  [ -n "$_pid" ] || continue
  # 已死的跳过（ps 与 kill 之间可能有时间差）
  kill -0 "$_pid" 2>/dev/null || continue
  _n=$((_n + 1))
  _cmd="$(ps -o command= -p "$_pid" 2>/dev/null | cut -c1-90)"
  if [ -n "$_listener" ] && [ "$_pid" = "$_listener" ]; then
    echo "⚠️ 同类实例 PID ${_pid} 仍占着 ${PORT}（第 1 步②未清干净，非孤儿）：${_cmd}"
  else
    echo "⚠️ 发现同类残留实例 PID ${_pid}（不监听 ${PORT}、也不在 pidfile）：${_cmd}"
  fi
  # 过牙：与上面两处 kill 用**同一判据**（prod-guard.sh），不另造。牙拦下 ⇒ 整脚本 exit 4。
  require_kill_ok "$_pid"
  kill "$_pid" 2>/dev/null || true
done

# 出声：扫到几个、处置后还剩几个（静默会让下一个人以为这里从没东西）
if [ "$_n" -gt 0 ]; then
  sleep 1
  _left=0
  for _pid in $_pids; do
    [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null && _left=$((_left + 1))
  done
  # TERM 不走的（多半卡在网络 IO）升级 KILL —— 与上面两处同档
  if [ "$_left" -gt 0 ]; then
    for _pid in $_pids; do
      [ -n "$_pid" ] || continue
      kill -0 "$_pid" 2>/dev/null || continue
      require_kill_ok "$_pid"
      kill -9 "$_pid" 2>/dev/null || true
    done
    sleep 1
    _left=0
    for _pid in $_pids; do
      [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null && _left=$((_left + 1))
    done
  fi
  echo "ℹ️ 同类残留扫描：扫到 ${_n} 个，处置后仍在 ${_left} 个"
  [ "$_left" -gt 0 ] && echo "⚠️ 仍有 ${_left} 个同类实例未退出（可能是权限/僵尸 D 状态），请人工确认"
else
  echo "ℹ️ 同类残留扫描：未发现残留实例（pidfile 与端口两路均已覆盖）"
fi

# 2. 孤儿锁清理：重启时刻进程已死，凡 .lock 必为孤儿（照 restart-web 2b 口径，mv 留证不 rm）
for f in "$MATTER_HOME"/*.lock; do
  [ -f "$f" ] || continue
  mv "$f" "$f.stale-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
done

# 2b. 代理：DSH 引擎**只认启动环境快照**（dsh/lib/profile-boot → installProxyFromEnvironment），
#     macOS 系统代理对它无效。手动跑本脚本时也要拿到健康代理（watchdog 路径已在自愈前现探过）。
#     探不到健康代理时 app-proxy.sh 会**清空**全部代理变量（死代理比没有代理更糟，08-28 事故）。
#     走代理：仅余 openrouter.ai 等未列入直连名单的境外域名；
#     直连：境内全量 provider + 三个**易被误记成走代理**的境外 provider ——
#       opencode.ai / amr-link.open-design.ai / api.commandcode.ai（ISS-645 起全部改为直连）。
#     ⚠️ **完整名单以 `scripts/app-proxy.sh` 的 `DIRECT_EXEMPT` 为唯一真相源，此处不手抄**
#       （手抄必腐坏：ISS-645 于 2026-10-23 把这些改直连后，本处曾残留过期口径把人指错方向）。
#       要查某域名到底走哪条：`bash scripts/app-proxy.sh check`（该输出已改为按 DIRECT_EXEMPT 现算）。
eval "$(bash "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/app-proxy.sh" export)"

# 2c. ✅ **已撤除（ISS-663 —— 老板 2026-10-27 批「A：撤掉」）**：本段原有的一行
#     `export ... --no-network-family-autoselection` **已删除**，现走 Node 默认行为。以下为留档。
#
#     ▸ 原来为什么加（ISS-630，2026-10-18 现场定位）：本机 en1 有 IPv6 地址（2409:8a04:…）但
#       **公网 IPv6 无出口**（`nc -6 … 443` 不可达），而 Node≥20 的 `autoSelectFamily` 默认 true
#       ⇒ 解析到 AAAA 时先试 IPv6，卡在 `SYN_SENT` 直到超时（lsof 实测抓到该状态），再回落 IPv4
#       —— 落在请求超时窗口里即成「经网关调 commandcode 间歇 502 `上游请求失败: fetch failed`（≈10.5s）」。
#       当时对照：默认 12 次 → 11 成功 + 1 次 `UND_ERR_CONNECT_TIMEOUT@10571ms`；关掉后 12/12。
#
#     ▸ 为什么撤（2026-10-27 复核：ISS-630 留下的两条撤除判据**双双确认成立** ——
#       即原本促使我们关掉它的那两个条件都已消失）：
#       ① `dns.lookup(…,{all:true})` → 全返回 IPv4，无 IPv6 优先 ⇒ 已不会抢在 IPv4 前试 AAAA；
#       ② `nc -6 <公网> 443` → `EHOSTUNREACH`，en1 只剩 `fe80::` 本地地址 ⇒ 本机无公网 IPv6 出口。
#       （口径提醒：这两条是「满足则可撤」的准入判据，不是「不满足才撤」。⟂ 别读反。）
#       更要紧的是「关着」的**副作用代价更大**：关掉 = Node 不再做多地址回落（happy-eyeballs），
#       DNS 返回多个 A 记录时只试**第一个**、失败不换下一个。Cloudflare 前置的 provider（amr-link /
#       opencode.ai / commandcode）都返回 2~4 个 A，其中部分地址在本机网络下成片丢包（TCP 握手拿不到
#       SYN-ACK）；DNS 是 30s TTL 轮询，坏地址约一半时间窗排在首位 ⇒ 撞上就吃满 10.5s
#       `UND_ERR_CONNECT_TIMEOUT`。
#       2026-10-27 实测（冷连接逐轮，先查 DNS 首位再发请求，amr-link.open-design.ai）：
#       关着（= 本行生效时）3/10 通，7 次失败全是 `UND_ERR_CONNECT_TIMEOUT@1050xms`，
#       且失败与「DNS 首位是坏 IP」**100% 对应**；开着（Node 默认）10/10 通，
#       其中 9 轮首位是坏 IP，全被回落救回。
#
#     ▸ 撤的代价 / 怎么观察：Node 恢复默认后 `autoSelectFamily=true`，一旦本机 IPv6 真有了出口，
#       AAAA 会重新排在前面，ISS-630 的 `SYN_SENT` 症状理论上会复发（快照：2026-10-27 本机无公网 IPv6）。
#       观察方式（ISS-664 换过：旧口 `nc -6` 在本机**已无判别力**，见下「注脚」）：
#         再遇到 `UND_ERR_CONNECT_TIMEOUT@1050xms` 时，先判「是不是多地址回落没救回来」：
#         ① 看这个 host 解析出几个地址、首位是哪个：
#              node -e 'require("dns").lookup("<host>",{all:true},(e,a)=>console.log(a))'
#            ⇒ 多个 A 记录=回落本可生效；若仍超时，说明**所有**地址都不通（或回落被关掉了，
#              先确认 `ps eww -p <pid> | grep -o no-network-family-autoselection` 无输出）。
#         ② 同 host 冷连接多跑几次（成功即回落生效）：失败**不再是** DNS 首位坏地址的锅 ——
#            那正是 2c 撤掉 flag 后由 happy-eyeballs 兜住的场景（实测开=10/10 通）。
#         ③ 若①②都正常仍超时 ⇒ 去查 2d 段（ClientHello 首包被隧道丢）或代理侧，**别在本段耗**。
#         注脚（降级）：`nc -6 <公网> 443` 在本机无公网 IPv6 时**恒为 `EHOSTUNREACH`**（ISS-663 撤
#           flag 后的稳态）⇒ 它只能排除「AAAA 优先」这一种可能，**不再作为主判据**，别拿它下结论。
#
#     ▸ 反向条件（两条**同时**成立才加回来）：① 公网 IPv6 可达（`nc -6 <公网> 443` 退 0）；
#       ② 确实观测到 AAAA 优先导致的 `SYN_SENT`／超时。
#       ▸ 怎么加回来（**别手工加 `#`**：留档行有两层注释前缀，去掉一层仍是注释 ⇒ 静默空操作。
#         2026-10-27 审查实测踩过这个坑：按「去掉行首 # 」操作后 `bash -n` 通过、重启成功、
#         但 `ps eww` 里没有 flag —— 最坏形态是以为恢复了防护、实际没有）。
#         用下面这条 `sed` 一步到位（幂等：重复跑不会叠加），跑完再 `git diff` 确认：
#           sed -i '' 's|^# UNCOMMENT-ISS-663: ||' scripts/restart-matter.sh
#         它把 **2d 段里**那条 `# UNCOMMENT-ISS-663: export ...` 的标记前缀摘掉，使该行成为
#         `unset NODE_OPTIONS` **之后**的生效 export（留档行刻意放在 unset 之后：放前面会被 unset 抹掉）。
#
#     ⚠️ **ISS-644 补注（2026-10-23）**：上面那次「关掉后 12/12」**样本量不足以排除另一层病因**。
#        同一个错误码（`UND_ERR_CONNECT_TIMEOUT@1050x~1057xms`）现在已定位出**第二个、独立的**成因
#        （TLS ClientHello 过大，见下面 2d 段）。两层都要留：关 IPv6 自动选择治的是「解析到 AAAA 卡 SYN_SENT」，
#        2d 治的是「ClientHello 首包被隧道丢」。撤本条前请重跑 2d 段记录的配对实验，别只看 12/12。

# 2d. ⛔ **把 TLS 密钥交换组降回 X25519（ISS-644，老板 2026-10-23 批「方案 A」）** —— 别删。
#     症状（老板报，2026-10-23 当时口径）：**当时这三家都走代理** —— opencode / commandcode / amr
#       连接不稳定、总是超时。⚠️ 现已不同（见下「现状」），但**本条修复照样必需，别据此删行**。
#     现状（ISS-645 之后）：opencode / amr-link / commandcode 已全部改为**直连**，而**本行仍然保留** ——
#       因为 2d 治的是「TLS ClientHello 首包被 CONNECT 隧道丢」这个**机制**，与具体哪家 provider 无关：
#       · 走代理的域名 ⇒ 经隧道 ⇒ 首包过大就中招（**当前最典型的是 `openrouter.ai`，它仍走代理**）；
#       · 已直连的三家 ⇒ 不经隧道 ⇒ 理论上不吃这个 MTU 问题，但**本修复对它们无害**（多一层保险）。
#       ⇒ 结论：不能因为「某家改直连了」就撤本行；判据永远是「还有没有**经 CONNECT 隧道**的
#         大首包流量」—— 只要有域名走代理，本修复就得留着（某家改直连 ≠ 义务清零）。
#     根因：Node 24.13 默认 X25519MLKEM768（后量子混合组）把 TLS ClientHello 从 354B 撑到 **1588B**，
#       超单包 MTU ⇒ 经本地代理（ClashX）的 CONNECT 隧道时首包约 10~17% 概率被丢 ⇒ 等十几秒后超时。
#     ⚠️ **不是代理的毛病**（三层反证）：① 失败窗口 ClashX `[warning]`=0；② 裸 CONNECT 隧道从 2ms/从不失败；
#       ③ 抽掉本问题后经**同一个 ClashX** 跑 314/314 全绿。也**不是 curl 兜底的问题**：curl 的 ClientHello
#       只有 301B 所以它天然不中招 —— 跟 `curlFirst` 无关，两路都中招。
#     证据（**2026-10-23 的实测快照，数字原样保留，不是现在的测量** —— 交替配对，避免时段波动）：
#       现状 6/120 失败 · 本行 0/120 失败 · ClientHello 1588B→354B
#       三家实端点各 25 次（当时三家均走代理）：opencode 22/25→25/25 · amr 22/25→25/25 · commandcode 19/25→25/25
#       ⚠️ 读这组数字请注意：它们证明的是「preload 有效」这个机制，**不依赖 provider 是否走代理**
#         （同一机制同样作用于今天仍走代理的 openrouter.ai）。provider 归属变更见 ISS-645。
#     作用域 = 本进程（不影响系统其它程序 / 不影响 curl 行为）。
#     代价：失去 MLKEM 后量子防护（当前无实际威胁）。
#     ⚠️ 反向条件：Node/上游修好大 ClientHello 的隧道丢包问题后可撤本行（届时重跑配对实验再撤）。
#     ⚠️ 回退：删掉本段的 `--import .../preload-x25519.mjs` 再重启即可（脚本原样保留不删）。
#     ⚠️ 生效方式：**下次重启**（TLS 默认值在模块加载时固定）。
#     ⚠️ 路径用 `$(dirname "${BASH_SOURCE[0]}")` 展开（本脚本无 `$HERE` 变量，勿照抄 confirm 脚本的写法）。
PRELOAD_X25519="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/preload-x25519.mjs"
[ -f "$PRELOAD_X25519" ] || { echo "✗ preload 缺失：${PRELOAD_X25519}（ISS-644 的 TLS 修复，勿静默跳过）"; exit 1; }

# ── ISS-663：清掉外部注入的 NODE_OPTIONS（**撤除能否生效全靠这一刀**）─────────────
# 为什么必须 unset：下面那行是**拼接**（`${NODE_OPTIONS:+$NODE_OPTIONS }`），意思是「继承的照留、再追加」。
#   而本脚本常由 **agent bash / restart-matter-confirm.sh** 发起，这些进程是**现役 3210 的子进程**
#   （实测：agent bash 的 `$PPID` = 生产 pid），`environ` 里就带着上一代 3210 的
#   `NODE_OPTIONS=--no-network-family-autoselection --import …/preload-x25519.mjs`。
#   不切断继承，拼接会把它原样带回新进程 ⇒ **ISS-663 的撤除在重启路径上等于没删**，
#   注释宣称「现走 Node 默认行为」而实际仍关着 happy-eyeballs（最坏形态：断言与事实相反，门禁全绿）。
#   附带一并修掉：每次重启都新拼一段 `--import …/preload-x25519.mjs`，无界叠加。
# 有没有合法场景需要保留外部注入？**没有，且这是刻意取舍**：本脚本产出的是生产进程参数，
#   必须由本文件唯一定义 —— 外部环境不该能决定它的 node 参数。将来若真要加参数，
#   **显式写进本脚本**（带上单号与理由），不靠继承。这也是 `scripts/ws.sh` 里那句
#   `unset NODE_OPTIONS` 的同款纪律（ISS-525：VS Code 扩展注入 `--require`，扩展一升级 node 全挂，
#   故「一刀切断」；定位方式：`grep -n '^unset NODE_OPTIONS' scripts/ws.sh`）。
# 边界：只 unset NODE_OPTIONS，**不动** DSH_HOME / FORGE_PM_ROOT 等其它变量 ——
#   下面「3. 起盘」段 `env -u FORGE_WATCHDOG_SELFHEAL NAME=VALUE …` 那串传法有 bash 3.2 的坑，
#   超出本单范围（引那行请按内容搜，别记行号：注释增删会让行号漂）。
unset NODE_OPTIONS

# ⚠️ ISS-663 反向条件成立时（见 2c 段，两条同时满足才恢复）：在**这一行之后**恢复关闭开关 ——
#   必须放 unset 之后，放前面会被上面那句 unset 抹掉。用 2c 段给的 sed 一键恢复（别手工加 `#`）：
# UNCOMMENT-ISS-663: export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-network-family-autoselection"

# 2d 段在本行之后追加自己的 `--import`：unset 后拼接退化为单段，最终值 = 唯一一条 `--import`。
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import $PRELOAD_X25519"

# 3. 起盘。⚠️ 变量必须经 `env` 传（bash 3.2 赋值前缀在展开前被识别的坑，dev-instance ISS-675 实测）。
#    --use-env-proxy（Node≥24 让 fetch 认代理，restart-web 同款必带）。
#
# ISS-612（2026-10-20 老板批「开 strict」）：标签写入切**严格档** —— 不合规格式直接拒，
#   不再「保留 + 告警」。此前 `tag-format.js` 的注释写着「M4 起默认」，代码却是 `env === "1"`
#   ⇒ 文档说默认开、实际默认关，裸标签因此每天照进库（本单的病因）。
#   ⚠️ 生效方式：**下次重启**（`process.env` 在进程启动时固定，改脚本不会热加载到已在跑的进程）。
#   ⚠️ 作用域只有本进程（3210）。App(19387) 不走本脚本，不受影响。
#   ⚠️ 回退：删掉这个变量再重启即可（`tag-format.js` 的 warn 档行为一直保留、未删）。
#
# ISS-639（2026-10-22）：**`env -u FORGE_WATCHDOG_SELFHEAL` 是在堵泄漏点，不是多余防御 —— 别删。**
#   病因：`env` **继承**当前环境。watchdog 自愈时父进程（restart-matter.sh）**带着** watchdog 导出的
#   `FORGE_WATCHDOG_SELFHEAL=1`（见 watchdog-matter.sh 委派行），它原本会原样漏进**生产进程自身**的
#   `process.env`；而生产进程会 spawn agent 的 bash ⇒ **每个 agent 会话都继承这个放行标记**，
#   等于让 `scripts/prod-guard.sh` 的自愈通道（判据之前的短路）在 agent 会话里**常开**。
#   实测（本单）：agent bash 的 `$PPID` = 生产 pid，`env` 里确有 `FORGE_WATCHDOG_SELFHEAL=1`。
#   修法边界：只在这里 `-u` 掉一个标记 —— ① 不影响上面两条 kill 路径读它（那时变量还在本脚本
#   自己的环境里，自愈通道照常工作）；② 不动 DSH_HOME 等其它变量的 `env` 传法（bash 3.2 的坑，
#   见本段开头）。⚠️ `env` 的选项必须写在所有 `NAME=VALUE` **之前**。
env -u FORGE_WATCHDOG_SELFHEAL \
  DSH_HOME="$MATTER_HOME" FORGE_PM_ROOT="$PM_ROOT" FORGE_PM_TAG_STRICT=1 NODE_OPTIONS="$NODE_OPTIONS" \
  nohup "$NODE_BIN" --use-env-proxy "$DSH_BIN" --profile web --port "$PORT" --no-open \
  >> "$LOG" 2>&1 &
pid=$!
# pidfile 写失败必须**出声**（ISS-655）：本脚本可能在受限环境（agent 沙箱 / 只读家）里跑，
# 而 pidfile 是 watchdog 判「进程死活」的唯一依据（`watchdog-matter.sh` 读它填 incident 报告）。
# 原实现直接 `echo > "$PIDFILE"`：写失败时 stderr 只有一行 `Operation not permitted`，
# 脚本照常往下跑、照样打印「✓ 就绪」—— 于是 pidfile 停在上一个 PID 而**没人知道**。
# 本次实测（2026-10-25）：沙箱禁写 ~/.dsh-matter ⇒ rm 与写入都被拦，pidfile 停留在旧值 87387，
# 靠巧合与真实新 PID 相同才没出事。服务本身起得起来，所以**不能因为写不了就中止重启**
# （那会让受限环境下彻底无法重启）⇒ 只告警 + 给出补救命令。
if ! printf '%s\n' "$pid" > "$PIDFILE"; then
  echo "⚠️ pidfile 写入失败：${PIDFILE}（权限/沙箱）—— 服务已起（PID ${pid}），但 watchdog 将读到旧值。"
  echo "   补救（真实终端）：printf '%s\\n' ${pid} > ${PIDFILE}"
fi
disown 2>/dev/null || true

# 4. 就绪等待（最多 40s）：进程存活 + HTTP 状态码 ≠ 000 双条件（ISS-675 假绿修复）。
for i in $(seq 1 40); do
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "✗ 启动失败（PID $pid 已退出），日志尾："
    tail -15 "$LOG" 2>/dev/null | sed 's/^/    /'
    rm -f "$PIDFILE"   # 启动失败时清 pidfile：清不掉也不改「exit 1」这个结论（rm 的报错照常显示）
    exit 1
  fi
  code="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)" || code=000
  if [ "$code" != "000" ] && printf '%s' "$code" | grep -qE '^[0-9]{3}$'; then
    echo "✓ Matter 服务就绪: http://127.0.0.1:$PORT/（PID $pid · http=${code}）"
    tok="$(grep -oE "http://127\.0\.0\.1:$PORT/\?token=[A-Za-z0-9_-]+" "$LOG" 2>/dev/null | tail -1 || true)"
    [ -n "$tok" ] && echo "  带 token 入口: $tok"
    exit 0
  fi
done
echo "✗ 40s 未就绪（进程 $pid 仍在但端口无响应），看日志：tail -30 $LOG"
exit 1
