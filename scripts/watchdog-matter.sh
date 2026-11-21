#!/bin/bash
# watchdog-matter.sh: Matter 独立服务 watchdog（ISS-968 阶段 1）—— 探活 3210，挂了经 restart-matter.sh 拉起。
# launchd KeepAlive 常驻本脚本（com.openforge.watchdog-matter.plist）。
# 逐条照抄 watchdog-web.sh 的实战修复：--noproxy 直连 / 任意 3 位状态码即活 / 6s×2 连续失败才动手 /
# 锁自愈（文件内含 pid、持活不搬）/ 日志原地截断轮转（ISS-544 同款）/ 脚本自更新重载（ISS-636 同款）。
# 2026-10-02 性能体检（甲案）新增：① 日志带日期 ② 首次探测失败落「事故现场快照」到 incidents/
#   ③ 「刚自愈过又失败」这一支不再静默（他处重启 vs 反复崩，原先在日志上无法区分）。
set -u

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# 探活一律 `--noproxy '*'` 直连（见 probe()），所以 watchdog 自身**不惧**代理 env；
# 但它 spawn 的 restart-matter.sh → node 引擎**必须**拿到**健康**代理：
#   DSH 引擎只认启动环境快照（dsh/lib/profile-boot → installProxyFromEnvironment），
#   系统代理对它无效。旧写法是一刀切 unset，代价是 3210 **永远直连** —— commandcode/openrouter
#   100% 挂、opencode.ai 撞 DNS 阵发污染（2026-10-03 排障）。现改为**每次自愈前现探**（见下方
#   spawn 处），无健康代理才清空：死代理比没有代理更糟（08-28 事故）。
# ⚠️ 探不放在这里做：watchdog 是常驻进程，启动时探到的活代理可能几小时后就死了。
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy 2>/dev/null || true

# ── 路径 / 隔离口（ISS-670）──────────────────────────────────────────────────
# 三个路径一律**从本脚本位置推导**，不硬编码主 checkout：硬编码在 worktree 里演练时会去拉主
# checkout 的旧脚本（ISS-665 同款坑：那时 watchdog 因此调错清单 CLI）。launchd 跑的就是主
# checkout 那一份（plist 里写死 ProgramArguments）⇒ 推导结果与旧硬编码**逐字一致**，生产行为不变。
# ⚠️ 下面这些 FORGE_* 覆盖口只为**不碰 3210 的隔离自测**（scripts/tests/restart-race-guard.test.sh
#    把探测端口/重启脚本/代理脚本/状态目录全换成临时替身）。默认值 = 生产值，别在真机上设它们。
_WD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
RESTART="${FORGE_RESTART_SCRIPT:-$_WD_DIR/restart-matter.sh}"
APP_PROXY="${FORGE_APP_PROXY:-$_WD_DIR/app-proxy.sh}"
MAT_HOME="${FORGE_MATTER_HOME:-$HOME/.dsh-matter}"
PROBE_PORT="${FORGE_WATCHDOG_PORT:-3210}"
PROBE_URL="http://127.0.0.1:${PROBE_PORT}"
PROBE_INTERVAL="${FORGE_WATCHDOG_INTERVAL:-5}"
# 重启标记（ISS-670）：TTL = 手动重启窗口的正常上限（kill 2s + 就绪最多 40s）的三倍余量。
# 超时只是**兜底**：主判据是「持有 pid 还活着吗」（见 restart_in_progress 头注）。
RESTART_MARKER_TTL="${FORGE_RESTART_MARKER_TTL:-180}"
RESTART_MARKER="$MAT_HOME/restart.inprogress"

# ── ISS-665 第三件：自愈必须**出声**（自愈前后各写一条账）──────────────────────────
# 修前：watchdog 只在 `watchdog-restart.log` 里留一行，**没有任何人会看到** ⇒「重启静默发生」。
# 老板 2026-10-29：「重启前就应该先通知你，你来统筹，减少重启的次数」。
#
# 两条账落到哪（判据是"Lead 能收到"，不是"写进 log 了"）：
#   ① **盘上账本** `<MAT_HOME>/forge-messenger/selfheal.jsonl`（append-only，一条一行）——
#      这是**重启后** Lead 与第四件恢复逻辑唯一的读口（3210 挂时 HTTP 不通，只能读盘）；
#   ② **在飞清单** `<MAT_HOME>/forge-messenger/inflight.{json,md}` —— 自愈前那一刻的现场，
#      由 `forge-messenger/lib/inflight-cli.mjs` 纯盘上算出（它**不依赖 3210 存活**，这正是它存在的理由）。
#   ③ 若 3210 起来后能被读到，`/forge-messenger/restart` 的通知通道才是"主动推给 Lead"那一条；
#      但**自愈前 3210 是挂的，推不出去** —— 故不能把它当唯一通道（那等于在最需要时静默）。
#
# 开关（老板要求「必须有一键关掉的开关」；本件先给账本与清单，恢复开关在第四件）：
#   FORGE_SELFHEAL_NOTICE=0  关掉自愈账本（排障/压测时用；关掉会打一行 warn 明示已关）
SELFHEAL_LEDGER="$MAT_HOME/forge-messenger/selfheal.jsonl"
# ⚠️ CLI 路径**从本脚本位置推导**（脚本在 <repo>/scripts/ 下），不硬编码主 checkout：
#    硬编码会在 worktree 里指到主 checkout 的旧代码上（ISS-665 实测：worktree 里跑时该文件不存在，
#    清单静默跳过）；而且主 checkout 与本脚本必须是同一份代码，推导出来的才对得上。
SELFHEAL_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"
INFLIGHT_CLI="$SELFHEAL_REPO/forge-messenger/lib/inflight-cli.mjs"
SELFHEAL_NOTICE="${FORGE_SELFHEAL_NOTICE:-1}"

# 日志时间戳统一带日期（2026-10-02 性能体检）：本文件原先只打 HH:MM:SS，跨天/跨轮次无法回溯
# ——体检时 watchdog.log 里 41 条 `down (no-listener)` 一条都定位不到日期，等于没有记录。
ts() { date '+%Y-%m-%d %H:%M:%S'; }

probe() {
  lsof -tiTCP:"$PROBE_PORT" -sTCP:LISTEN >/dev/null 2>&1 || { PROBE_WHY="no-listener"; return 1; }
  local code
  code=$(curl -s --noproxy '*' --max-time 6 -o /dev/null -w '%{http_code}' "$PROBE_URL" 2>/dev/null)
  if printf '%s' "$code" | grep -qE '^[0-9]{3}$'; then
    PROBE_WHY="ok(http=$code)"
    return 0
  fi
  PROBE_WHY="no-http-response"
  return 1
}

# 锁自愈：mtime>120s 且持有者进程已死才搬走留证（正常持锁毫秒级；ISS-104/129 同款）
sweep_stale_locks() {
  local f pid age
  find "$MAT_HOME" -maxdepth 1 -name '*.lock.stale-*' -mtime +1 -delete 2>/dev/null || true
  # ISS-670：判过期的重启标记也走同一档扫地（它们是 mv 留证得来的，不清会无界堆积）。
  # 只删 1 天前的：最近几份要留着当「为什么判它过期」的复核材料。
  find "$MAT_HOME" -maxdepth 1 -name 'restart.inprogress.stale-*' -mtime +1 -delete 2>/dev/null || true
  for f in "$MAT_HOME"/*.lock; do
    [ -f "$f" ] || continue
    age=$(( $(date +%s) - $(stat -f %m "$f" 2>/dev/null || echo 0) ))
    [ "$age" -lt 120 ] && continue
    pid=$(tr -d '[:space:]' < "$f" 2>/dev/null)
    if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then
      continue # 持有者存活：可能是慢写，不搬
    fi
    mv "$f" "$f.stale-$(date +%Y%m%d-%H%M%S)" 2>/dev/null
    echo "[watchdog $(ts)] swept stale lock: ${f##*/} (age ${age}s)"
  done
}

# 日志卫生（ISS-544 原地截断：tail 保尾 → cat 同 inode 写回，不换 inode）
LOG_MAX_BYTES="${FORGE_LOG_MAX_BYTES:-5242880}"
LOG_KEEP_BYTES="${FORGE_LOG_KEEP_BYTES:-2097152}"
rotate_inplace() {
  local f="$1" keep="$2"
  [ -f "$f" ] || return 0
  [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ] || return 0
  tail -c "$keep" "$f" > "$f.rot" 2>/dev/null || return 0
  cat "$f.rot" > "$f" 2>/dev/null && rm -f "$f.rot" 2>/dev/null
  echo "[watchdog $(ts)] 日志轮转：${f##*/} 截到 ≤$(( keep / 1024 ))KB"
}

# ── 事故现场快照（2026-10-02 性能体检 · 甲案）────────────────────────────────
# 为什么加：原先 probe 失败只留一行 `down (no-listener)`，**没有死者身份、没有死前日志**。
# 体检实证：2026-10-02 19:04 那次，matter.log 里死者（旧 PID 66166）最后一行是普通业务日志、
# 死前零报错、系统日志里也没有 OOM/jetsam 记录 ⇒ 无法判定是「被 kill（他处重启）」还是「自己退出」。
# 现在：首次探测失败即落一份现场，并写好可复制的 `log show` 回溯命令；只留最近 20 份。
INCIDENT_DIR="$MAT_HOME/incidents"
INCIDENT_KEEP=20

capture_incident() {
  local why="$1" d oldpid alive boots
  d="$(date '+%Y%m%d-%H%M%S')"
  mkdir -p "$INCIDENT_DIR" 2>/dev/null || return 0
  oldpid=""
  [ -f "$MAT_HOME/matter.pid" ] && oldpid="$(tr -d '[:space:]' < "$MAT_HOME/matter.pid" 2>/dev/null)"
  # ⚠️ 输出纪律（2026-10-02 实测，别退回去）：
  #   本机 /bin/bash 是 **3.2.57**。在**任何 UTF-8 locale** 下，`echo "…中文…$var…"` 里
  #   **未加花括号**的 `$var` 会被吞掉若干字节（含紧邻的中文字节）⇒ 落盘成**非法 UTF-8**。
  #   实测：`echo "…（进程 $alive）"` 坏；`echo "…（进程 ${alive}）"` 好；`printf '…%s…' "$alive"` 好。
  #   生产 launchd 环境无 LANG（=C locale）时不触发，所以现网 matter.log/watchdog.log 一直是合法的；
  #   但**手动跑**（Terminal / agent 环境常带 LANG）就会踩。⇒ 含中文又含变量的行一律走 printf %s。
  alive="unknown"
  if [ -n "$oldpid" ]; then
    # 判活用 ps 而非 kill -0：kill -0 对**非本用户**进程返回 EPERM ⇒ 会把活着的误判成已死
    # （2026-10-02 实测：PID 1 被判 dead）。ps -p 对任何用户进程都准。
    if ps -p "$oldpid" >/dev/null 2>&1; then alive="alive"; else alive="dead"; fi
  fi
  boots="$(grep -c 'dsh web: http' "$MAT_HOME/matter.log" 2>/dev/null || true)"
  {
    printf '=== watchdog incident %s ===\n' "$(ts)"
    printf 'probe       : %s\n' "$why"
    printf 'pidfile     : %s = %s（进程 %s）\n' "$MAT_HOME/matter.pid" "${oldpid:-none}" "$alive"
    [ -n "$oldpid" ] && ps -o pid=,ppid=,etime=,rss=,comm= -p "$oldpid" 2>/dev/null
    printf 'listener    : %s\n' "$(lsof -tiTCP:"$PROBE_PORT" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ')"
    printf '启动块计数  : %s（matter.log 里 dsh web 横幅数；与 watchdog 拉起次数之差 = 他处重启）\n' "${boots:-?}"
    echo "--- matter.log 末尾 60 行（死者遗言）---"
    tail -60 "$MAT_HOME/matter.log" 2>/dev/null
    echo "--- matter.log 致命标记（有输出⇒更像真崩；空⇒更像被 kill/静默退出）---"
    grep -nE 'FATAL|Uncaught|UnhandledPromise|heap out of memory|Segmentation' "$MAT_HOME/matter.log" 2>/dev/null | tail -5
    echo "--- watchdog-restart.log 末尾 6 行 ---"
    tail -6 "$MAT_HOME/watchdog-restart.log" 2>/dev/null
    if [ -n "$oldpid" ]; then
      printf -- '--- 回溯命令（查死者进程的退出原因）---\n'
      printf "log show --start '%s' --predicate 'processID == %s' --style compact\n" "$(date -v-2M '+%Y-%m-%d %H:%M:%S')" "$oldpid"
    fi
  } > "$INCIDENT_DIR/incident-$d.log" 2>&1
  ls -t "$INCIDENT_DIR"/incident-*.log 2>/dev/null | tail -n +$((INCIDENT_KEEP + 1)) | while read -r f; do rm -f "$f"; done
  printf '[watchdog %s] 现场快照 incidents/incident-%s.log（死者 PID %s·%s）\n' "$(ts)" "$d" "${oldpid:-none}" "$alive"
}

# ── ISS-665 第三件：自愈账本（前后各一条）────────────────────────────────────
# ⚠️ 本机 /bin/bash 是 3.2.57：含中文又含变量的行一律走 printf %s（见 capture_incident 头注的实测）。
# JSON 转义：账本要能被 node 直接 JSON.parse，随手拼引号会产出坏行 ⇒ 统一走 json_escape。
json_escape() {
  # 反斜杠 → \ ；引号 → \" ；换行/制表 → 空格（一行一条账，不许断行）
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\t' '  '
}

# 写一条自愈账。$1=kind(before|after|skip) 其余为 KEY=VALUE 形式的补充字段。
write_selfheal_ledger() {
  local kind="$1"; shift
  [ "$SELFHEAL_NOTICE" = "0" ] && { echo "[watchdog $(ts)] ⚠️ 自愈账本已关闭（FORGE_SELFHEAL_NOTICE=0）——本条 $kind 未记账"; return 0; }
  mkdir -p "$(dirname "$SELFHEAL_LEDGER")" 2>/dev/null || { echo "[watchdog $(ts)] ⚠️ 账本目录建不出来：$SELFHEAL_LEDGER"; return 0; }
  local line
  line=$(printf '{"at":"%s","kind":"%s","pid":%s' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(json_escape "$kind")" "$$")
  local kv
  for kv in "$@"; do
    line="$line,\"$(json_escape "${kv%%=*}")\":\"$(json_escape "${kv#*=}")\""
  done
  line="$line}"
  printf '%s\n' "$line" >> "$SELFHEAL_LEDGER" 2>/dev/null || echo "[watchdog $(ts)] ⚠️ 账本写失败：$SELFHEAL_LEDGER"
}

# 自愈前落一份在飞清单（**纯盘上算**：此刻 3210 是挂的，取不到进程内面）。
# 失败不阻断自愈（自愈本身是救命的），但**必须出声**——静默失败等于回到"重启无痕"。
snapshot_inflight_before_heal() {
  local why="$1"
  command -v node >/dev/null 2>&1 || { echo "[watchdog $(ts)] ⚠️ 无 node，跳过在飞清单（自愈前现场未能落盘）" >&2; printf '? ? ? ?'; return 0; }
  [ -f "$INFLIGHT_CLI" ] || { echo "[watchdog $(ts)] ⚠️ 找不到 ${INFLIGHT_CLI}，跳过在飞清单" >&2; printf '? ? ? ?'; return 0; }
  local out
  out=$(node "$INFLIGHT_CLI" --home "$MAT_HOME" 2>&1)
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    # 从清单 json 里读三个数（不重算：清单自己算过，读它的结论才对得上）
    local counts
    counts=$(node -e '
      const fs=require("node:fs");
      try{
        const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
        const c=j.counts||{};
        process.stdout.write(["inflight","interrupted","warm","orphanInProgress"].map(k=>String(c[k]??"?")).join(" "));
      }catch(e){ process.stdout.write("? ? ? ?") }
    ' "$MAT_HOME/forge-messenger/inflight.json" 2>/dev/null)
    # ⚠️ 日志一律去 stderr：stdout 是**返回值**（调用方用 $(...) 只该拿到四个数），
    #    混进日志就会把 "inflight" 记成 "[watchdog"（实测踩过，账本里出现了半个时间戳）。
    printf '[watchdog %s] 自愈前在飞清单已落盘（inflight/interrupted/warm/孤儿 = %s）\n' "$(ts)" "${counts:-?}" >&2
    printf '%s' "$counts"
    return 0
  fi
  printf '[watchdog %s] ⚠️ 自愈前在飞清单生成失败（rc=%s）：%s\n' "$(ts)" "$rc" "$(printf '%s' "$out" | tail -3 | tr '\n' ' ')" >&2
  printf '? ? ? ?'
}

# ── ISS-670：人工重启窗口内**让路**（标记由 restart-matter.sh 挂/摘）────────────
# 病因：手动重启只做「kill 旧 → 起新」；本 watchdog 每 5s 探一次，必然撞上「旧已死、新未就绪」
#   那几秒 ⇒ 拍快照 + 再拉一次 restart-matter.sh ⇒ 一次重启两份启动请求。两边全程互不通知。
#
# 判据三分解（每一条都对应一次实测或一个必然坏形态）：
#   ① 标记不存在 ⇒ 照常探测（真挂的自愈路径**一点没变** —— 验收 3）
#   ② 标记在 + 持有 pid 存活 + age ≤ TTL ⇒ **让路**：不拍快照、不拉重启（验收 1）
#   ③ 标记在但「持有 pid 已死」或「age > TTL」⇒ **判过期**：搬走留证 + 照常探测（验收 2）
# ③ 的两个子判据**不是冗余**：
#   · 持有 pid 已死是**主判据**。2026-10-29 16:41 实测：手动路径的 restart-matter.sh 在 kill
#     3210 之后**自己被 3210 的进程树带走**（restart-confirm.log 停在「在飞清单已落盘」，
#     没有「就绪」也没有「启动失败」）⇒ 标记靠 EXIT trap 清不掉就是残留。
#     本机 bash 3.2.57 实测：TERM/INT **会**跑 EXIT trap，**SIGKILL 不会** ⇒ 残留只在后者（或
#     trap 里 rm 也被拦）时出现。只按超时判会怎样：3210 白挂满 180s，把「一次真故障」放大成
#     「三分钟停机」——这是本单最容易写出的坏实现。
#   · mtime 超时是**兜底**：持有进程还活着但卡死（挂在牙/隧道/pid 复用上）时不许永久挡自愈。
# 让路期间 PROBE_FAILS 清零：窗口结束后要重新攒两次失败才动手，别让窗口内的失败计数在窗口
#   结束时立刻触发一次多余自愈。
MARKER_WHY=""
MARKER_SKIP_NOTED=0

retire_restart_marker() {
  local dest="$RESTART_MARKER.stale-$(date +%Y%m%d-%H%M%S)"
  if mv "$RESTART_MARKER" "$dest" 2>/dev/null; then
    # 搬走留证不 rm（与 sweep_stale_locks 同口径：过期判据本身要能被复核）
    printf '[watchdog %s] 重启标记判过期（%s）⇒ 已搬走留证 %s，本轮照常探测\n' \
      "$(ts)" "$MARKER_WHY" "${dest##*/}"
  else
    # 搬不走也**不许**继续挡自愈：自愈是救命的那一条，宁可多一次重启，不可长时间无监听。
    printf '[watchdog %s] ⚠️ 重启标记判过期（%s）但搬不走：%s ⇒ 本轮照常探测（下轮重试）\n' \
      "$(ts)" "$MARKER_WHY" "$RESTART_MARKER"
  fi
}

restart_in_progress() {  # 0 = 有人在重启，本轮让路；1 = 照常探测
  local age pid mport
  [ -f "$RESTART_MARKER" ] || return 1
  # 标记里的 port 是**给谁看的**：restart-matter.sh 支持 MATTER_PORT 覆盖，别端口的重启
  # （3211 隔离实例）不该让 3210 的自愈网跟着停 —— 否则一次开发重启就能静默关掉最长 TTL 的守护。
  # 字段缺失（旧格式/手写标记）按「不指定 = 与本端无关的判据不成立」处理：照旧生效。
  mport="$(sed -n 's/^port=//p' "$RESTART_MARKER" 2>/dev/null | head -1 | tr -d '[:space:]')"
  if [ -n "$mport" ] && [ "$mport" != "$PROBE_PORT" ]; then
    return 1  # 不是本端口的窗口：不挡，也不搬（那是别人的证据）
  fi
  age=$(( $(date +%s) - $(stat -f %m "$RESTART_MARKER" 2>/dev/null || echo 0) ))
  pid="$(sed -n 's/^pid=//p' "$RESTART_MARKER" 2>/dev/null | head -1 | tr -d '[:space:]')"
  # 判活用 ps 而非 kill -0：kill -0 对非同用户进程返回 EPERM ⇒ 会把活着的误判成已死
  # （2026-10-02 实测，capture_incident 同一颗教训）。
  if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1 && [ "$age" -le "$RESTART_MARKER_TTL" ]; then
    MARKER_WHY="持有进程 ${pid} 存活 · age ${age}s"
    return 0
  fi
  if [ -z "$pid" ]; then
    MARKER_WHY="读不到持有 pid（标记损坏/为空）"
  elif ! ps -p "$pid" >/dev/null 2>&1; then
    MARKER_WHY="持有进程 ${pid} 已死（restart-matter.sh 中途被杀 ⇒ 标记残留）"
  else
    MARKER_WHY="持有进程 ${pid} 仍存活但 age ${age}s 超过 TTL ${RESTART_MARKER_TTL}s（疑似卡死）"
  fi
  retire_restart_marker
  return 1
}

# ── ISS-636（照抄 watchdog-web.sh）：脚本自更新检测 ──────────────────────────
# bash 对 while 循环体是进入前一次性解析，本进程设计上永不退出 → 脚本改了不重载
# 就永远跑旧代码（web 版实测陈旧 3 天，新修复从未生效）。每轮比对 mtime；变化则
# 先语法自检，通过才 exec 自身；写坏了就暂不重载、继续用旧代码守护（修好再动即重试）。
SELF_PATH="${BASH_SOURCE[0]:-$0}"
SELF_MTIME="$(stat -f %m "$SELF_PATH" 2>/dev/null || echo 0)"

echo "[watchdog $(ts)] started (probe $PROBE_URL every ${PROBE_INTERVAL}s)"
PROBE_FAILS=0
LAST_RESTART=0
HK_TICK=0
while :; do
  _m="$(stat -f %m "$SELF_PATH" 2>/dev/null || echo 0)"
  if [ "$_m" != "0" ] && [ "$_m" != "$SELF_MTIME" ]; then
    if bash -n "$SELF_PATH" 2>/dev/null; then
      echo "[watchdog $(ts)] 脚本已更新（mtime ${SELF_MTIME} → ${_m}）→ 语法自检通过，重载自身"
      exec /bin/bash "$SELF_PATH" "$@"
    else
      echo "[watchdog $(ts)] ⚠️ 脚本已更新但语法自检未通过 → 暂不重载（继续用旧代码守护）；修好后再次改动即重试"
      SELF_MTIME="$_m"
    fi
  fi
  # ── ISS-670：人工重启窗口内让路（判据见 restart_in_progress 头注）──
  # ⚠️ 这里 `continue` 会跳过本轮末尾的 HK_TICK/清理 —— 可接受（窗口 ≤ TTL，日志轮转/锁清扫晚
  #    几十秒无副作用），换来的是**不碰 probe/自愈那一大段**（把整段包进 if/else 只会让 diff 变噪声）。
  if restart_in_progress; then
    if [ "$MARKER_SKIP_NOTED" != "1" ]; then
      # 一个窗口只打一条：5s 一轮打一条会把 watchdog.log 刷满（是会被当成故障的噪声源）
      printf '[watchdog %s] 检测到人工重启标记 ⇒ 本轮让路（不拍快照、不拉重启）：%s\n' "$(ts)" "$MARKER_WHY"
      MARKER_SKIP_NOTED=1
    fi
    PROBE_FAILS=0
    sleep "$PROBE_INTERVAL"
    continue
  fi
  MARKER_SKIP_NOTED=0
  if probe; then
    PROBE_FAILS=0
  else
    PROBE_FAILS=$((PROBE_FAILS + 1))
    [ "$PROBE_FAILS" -eq 1 ] && capture_incident "$PROBE_WHY"
    if [ "$PROBE_FAILS" -ge 2 ]; then
      now=$(date +%s)
      if [ $((now - LAST_RESTART)) -gt 60 ]; then
        echo "[watchdog $(ts)] down ($PROBE_WHY)，经 restart-matter.sh 拉起"
        # ── ISS-665 第三件：**自愈前先出声**（修前这一支全程静默，老板不知道服务被打断过）──
        # 顺序是硬的：先落现场（在飞清单）→ 再写"我要自愈了"账 → 才动手。
        # 反过来的话，重启一旦卡住/崩在半路，"自愈前有什么在飞"就永远查不到了。
        # ⚠️ 别用 `set --` 拆这串：本脚本后面还有 `exec /bin/bash "$SELF_PATH" "$@"`（自更新重载），
        #    一旦踩掉位置参数，重载就会丢参数（这种错只在"改了脚本又自愈"时发作，最难查）。
        heal_counts="$(snapshot_inflight_before_heal "$PROBE_WHY")"
        in_flight=$(printf '%s' "$heal_counts" | cut -d' ' -f1); [ -n "$in_flight" ] || in_flight="?"
        interrupted=$(printf '%s' "$heal_counts" | cut -d' ' -f2); [ -n "$interrupted" ] || interrupted="?"
        warm_n=$(printf '%s' "$heal_counts" | cut -d' ' -f3); [ -n "$warm_n" ] || warm_n="?"
        orphans=$(printf '%s' "$heal_counts" | cut -d' ' -f4); [ -n "$orphans" ] || orphans="?"
        printf '[watchdog %s] → 自愈开始（原因 %s · 在飞 %s 项 · 断在半路 %s 项 · 活着闲着 %s 项 · 声称在飞但无活会话 %s 张）\n' \
          "$(ts)" "$PROBE_WHY" "$in_flight" "$interrupted" "$warm_n" "$orphans"
        HEAL_START=$(date +%s)
        write_selfheal_ledger before \
          "why=$PROBE_WHY" \
          "inflight=$in_flight" \
          "interrupted=$interrupted" \
          "warm=$warm_n" \
          "orphan_in_progress=$orphans" \
          "inflight_file=$MAT_HOME/forge-messenger/inflight.md"
        # ISS-558：**显式自愈通道** —— restart-matter.sh 的 kill 路径装了牙（scripts/prod-guard.sh），
        # 而本 watchdog 是 3210 的自愈网，被牙拦下就形同虚设。故委派时显式导出这个标记；
        # 牙认标记放行（不用「猜调用者是谁」的脆弱判据，标记只在这里出现）。
        # 2026-10-03：自愈前**现探**代理并注入 —— 3210 的引擎也要走代理（commandcode/openrouter 直连恒挂、
        # opencode.ai 撞 DNS 污染）。探不到健康代理时 export 为空操作/显式清空，行为等价旧版。
        eval "$(bash "$APP_PROXY" export)"
        FORGE_WATCHDOG_SELFHEAL=1 bash "$RESTART" >> "$MAT_HOME/watchdog-restart.log" 2>&1
        LAST_RESTART="$now"
        # ── ISS-665 第三件：**自愈后也写一条**（耗时 + 到底回来没有，不靠"我调了重启脚本"来自证）──
        # 判据是**再探一次**：`restart-matter.sh` 退 0 只说明它跑完了，不说明 3210 活过来
        # （脚本可能被牙拦、引擎可能起不来）。两者分开报，才不会把"没救活"记成"救活了"。
        HEAL_COST=$(( $(date +%s) - HEAL_START ))
        if probe; then
          heal_state="ok"
          printf '[watchdog %s] ← 自愈完成：耗时 %s 秒，探测通过（%s）\n' "$(ts)" "$HEAL_COST" "$PROBE_WHY"
        else
          heal_state="failed"
          printf '[watchdog %s] ← 自愈结束但**探测仍失败**：耗时 %s 秒（%s）——不假装救活\n' "$(ts)" "$HEAL_COST" "$PROBE_WHY"
        fi
        write_selfheal_ledger after \
          "result=$heal_state" \
          "seconds=$HEAL_COST" \
          "probe=$PROBE_WHY" \
          "inflight=$in_flight"
        PROBE_FAILS=0
      else
        # 2026-10-02 体检：这一支原先**完全静默** —— 刚自愈过又探测失败时既不重启也不记录，
        # 于是「他处正在重启 3210（正常运维/别的会话）」与「反复崩」在日志上长得一模一样。
        echo "[watchdog $(ts)] down ($PROBE_WHY)，但 $(( now - LAST_RESTART ))s 前刚自愈过 → 跳过重启（疑似他处正在重启 3210，非崩溃）"
      fi
      PROBE_FAILS=0
    fi
  fi
  HK_TICK=$((HK_TICK + 1))
  if [ $((HK_TICK % 60)) -eq 0 ]; then
    sweep_stale_locks
    rotate_inplace "$MAT_HOME/matter.log" "$LOG_KEEP_BYTES"
    rotate_inplace "$MAT_HOME/watchdog-restart.log" "$LOG_KEEP_BYTES"
  fi
  sleep "$PROBE_INTERVAL"
done
