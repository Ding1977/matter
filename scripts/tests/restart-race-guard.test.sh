#!/usr/bin/env bash
# restart-race-guard.test.sh —— ISS-670 的牙：**手动重启 × watchdog 自愈**竞争守卫
#
# ## 为什么有这个文件
# ISS-670 的修法是「手动重启期间挂标记 ⇒ watchdog 让路」，而这条守卫的三个坏形态**都不会报错**，
# 只会静静地坏（正是本仓 K8b「从没红过的守卫等于没有守卫」要防的形状）：
#   ① 让路判据写了但恒假 ⇒ 竞争原样复现，日志上看不出区别；
#   ② 让路判据恒定真（比如只看「标记存在」不看持有者死活）⇒ 脚本崩了以后真自愈被永久挡住，
#      **3210 白挂到 TTL 结束**。本单实测就踩到这条：手动路径的 restart-matter.sh 会被 3210 的
#      进程树带走，标记注定残留 ⇒ 「只看超时」的实现会把一次真故障放大成三分钟停机；
#   ③ 生产端忘了摘标记 ⇒ 同 ②（本机 bash 3.2.57 实测：SIGTERM/SIGINT **会**跑 EXIT trap，
#      **SIGKILL 不会** ⇒ E2 用 -9 造真实残留，E3 用 -TERM 验「正常收尾摘得干净」）。
# 所以本文件把三个坏形态都做成**可复跑的断言 + 变异验证**（摘掉某一行，对应场景必须转红）。
#
# ## 纪律（工单原话）：不许为了测竞争真的反复重启 3210
# 全部在 `mktemp -d` 里跑，四条隔离：
#   · 两个脚本**复制**到临时目录（watchdog 的路径一律从脚本位置推导，ISS-670 顺带修掉硬编码）；
#   · 探测端口换成临时空闲端口，`FORGE_WATCHDOG_PORT` 指过去 ⇒ 永远 no-listener；
#   · 「重启」落到 `fake-restart.sh` 替身上，它**只记账，绝不起进程、绝不 kill**；
#   · 状态目录 `FORGE_MATTER_HOME` 换成临时目录 ⇒ 不读不写 ~/.dsh-matter。
#   真 3210、真 ~/.dsh-matter、真 launchd watchdog 全程不碰。
#
# ## 用法
#   bash scripts/tests/restart-race-guard.test.sh
#   RACE_SELFTEST_KEEP=1 bash scripts/tests/restart-race-guard.test.sh   # 保留临时目录供排查
# 退出码：0 = 全绿 · 1 = 有红
set -uo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"  # scripts/ （两个被测脚本都在它下面）
PASS=0
FAIL=0
say() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$*"; }
no() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$*"; }

TMP="$(mktemp -d)"
cleanup() {
  pkill -9 -f "$TMP" 2>/dev/null
  [ "${RACE_SELFTEST_KEEP:-}" = "1" ] || rm -rf "$TMP"
}
trap cleanup EXIT

ISO="$TMP/iso"
mkdir -p "$ISO"
cp "$SRC_DIR/watchdog-matter.sh" "$ISO/watchdog-matter.sh"
cp "$SRC_DIR/restart-matter.sh" "$ISO/restart-matter.sh"
: > "$ISO/preload-x25519.mjs"
# 替身：真实 app-proxy.sh 会现探代理（可能走网络），自测不许有外部依赖
cat > "$ISO/app-proxy.sh" <<'SH'
#!/usr/bin/env bash
echo "export FORGE_TEST_NOOP=1"
exit 0
SH
# 替身：真实 prod-guard.sh 会对 pid 跑 lsof 判生产实例；自测的目标都是临时进程，不该被它挡
cat > "$ISO/prod-guard.sh" <<'SH'
#!/usr/bin/env bash
exit 0
SH
CALLS="$TMP/restart-calls.log"
: > "$CALLS"
cat > "$ISO/fake-restart.sh" <<SH
#!/usr/bin/env bash
# 替身：只记账。绝不起进程、绝不 kill —— 自测纪律「不碰 3210」就靠这一行。
printf 'called %s\n' "\$(date +%s)" >> "$CALLS"
exit 0
SH
calls() { wc -l < "$CALLS" | tr -d ' '; }

# 临时空闲端口：watchdog 探它 ⇒ 恒 no-listener
PORT="${RACE_SELFTEST_PORT:-3391}"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  PORT=$((PORT + 1))
done

# 精确替换（锚点未命中就失败 —— 变异打不上等于变异验证没做，必须响）
mut_file() { # $1=src $2=dst $3=from $4=to
  SRC_FILE="$1" DST_FILE="$2" FROM="$3" TO="$4" node -e '
    const fs = require("node:fs")
    const s = fs.readFileSync(process.env.SRC_FILE, "utf8")
    const from = process.env.FROM
    if (!s.includes(from)) { console.error("锚点未命中：" + from.slice(0, 60)); process.exit(3) }
    fs.writeFileSync(process.env.DST_FILE, s.split(from).join(process.env.TO))
  '
}

# 假 HOME：restart-matter.sh 的 MATTER_HOME 写死跟 $HOME 走，故只能换 HOME。
# $2=dead（起不来的引擎，用于验证「失败也摘标记」） / hang（起得来但不就绪，用于制造「中途被杀」）
mk_home() {
  local h="$1" mode="${2:-dead}"
  mkdir -p "$h/.dsh-matter/pm" "$h/dsh-local/node_modules/@deepseek-ai/dsh/lib"
  case "$mode" in
    clutch | hang) printf 'setTimeout(function () {}, 600000)\n' > "$h/dsh-local/node_modules/@deepseek-ai/dsh/lib/bin.js" ;;
    *) printf 'process.exit(1)\n' > "$h/dsh-local/node_modules/@deepseek-ai/dsh/lib/bin.js" ;;
  esac
}

WDN=0
run_wd() { # 起一个 watchdog 跑 $3 秒，返回日志路径（不落 stdout：调用方用 $(...) 只该拿路径）
  local script="$1" home="$2" secs="${3:-1.2}"
  WDN=$((WDN + 1))
  # 日志名要能唯一反推「哪个脚本 × 哪个 HOME」：命令替换在子 shell 里跑，计数器不跨调用
  # persist（踩过：所有场景写同一个 wd-1.log，后跑的覆盖前跑的 ⇒ grep 断言全打在错的日志上）
  local log="$TMP/wd-${WDN}-$(basename "$(dirname "$script")")-$(basename "$home").log"
  # ⚠️ FORGE_MATTER_HOME 指到 `$home/.dsh-matter`：restart-matter.sh 的 MATTER_HOME 是
  #    `$HOME/.dsh-matter`，两个脚本必须看**同一个**目录，否则场景 C 的残留标记对 watchdog 不可见
  #    （踩过：marked 在 $home/.dsh-matter、watchdog 看 $home ⇒ 一律判「没有标记」，六个场景全 heal）。
  FORGE_MATTER_HOME="$home/.dsh-matter" \
    FORGE_WATCHDOG_PORT="$PORT" \
    FORGE_WATCHDOG_INTERVAL=0.1 \
    FORGE_RESTART_SCRIPT="$ISO/fake-restart.sh" \
    FORGE_APP_PROXY="$ISO/app-proxy.sh" \
    bash "$script" > "$log" 2>&1 &
  local p=$!
  # disown 必须在 kill 之前：否则 bash 会在作业被信号杀死时往 stderr 打一行「Terminated」，
  # 读日志的人会把它当成自测失败（不是失败，是本脚本主动收工）。
  disown "$p" 2>/dev/null
  sleep "$secs"
  kill "$p" 2>/dev/null
  printf '%s' "$log"
}

say "ISS-670 竞争守卫自测（隔离端口 $PORT · 临时目录 $TMP）"

# ══ 一、生产端：restart-matter.sh 挂/摘「重启中」标记 ══════════════════════════
say ""
say "一、生产端（restart-matter.sh）"
H1="$TMP/home1"
mk_home "$H1" dead
OUT="$(HOME="$H1" MATTER_PORT="$PORT" bash "$ISO/restart-matter.sh" 2>&1)"
case "$OUT" in
  *"已挂「重启中」标记"*) ok "E1 起盘前就挂上标记并出声" ;;
  *) no "E1 未见「已挂标记」一行：$(printf '%s' "$OUT" | tail -3 | tr '\n' ' ')" ;;
esac
if [ -f "$H1/.dsh-matter/restart.inprogress" ]; then
  no "E1 起盘失败后标记仍残留（watchdog 要等超时才能接管）"
else
  ok "E1 起盘失败（exit 1）也摘标记 —— trap EXIT 覆盖失败出口"
fi

# E2：模拟 2026-10-29 那次实测 —— 手动路径在 kill 完旧进程后**自己被 3210 的进程树带走**。
H2="$TMP/home2"
mk_home "$H2" hang
sleep 300 &
OLD=$!
disown "$OLD" 2>/dev/null
printf '%s\n' "$OLD" > "$H2/.dsh-matter/matter.pid"
HOME="$H2" MATTER_PORT="$PORT" bash "$ISO/restart-matter.sh" > "$TMP/e2.log" 2>&1 &
E2=$!
disown "$E2" 2>/dev/null
for _ in $(seq 1 100); do
  [ -f "$H2/.dsh-matter/restart.inprogress" ] && break
  sleep 0.1
done
if [ -f "$H2/.dsh-matter/restart.inprogress" ]; then
  ok "E2 标记在任何 kill 之前就已落盘（窗口从头到尾有保护）"
else
  no "E2 标记没出现，后面两个场景无输入"
fi
sleep 0.8
kill -9 "$E2" 2>/dev/null
if kill -0 "$OLD" 2>/dev/null; then
  no "E2 旧进程未被杀掉（场景没进入重启窗口，后面的断言失去意义）"
else
  ok "E2 旧进程已被杀（窗口真实存在：旧已死、新未就绪）"
fi
MARK_PID="$(sed -n 's/^pid=//p' "$H2/.dsh-matter/restart.inprogress" 2>/dev/null | head -1 | tr -d '[:space:]')"
if [ "$MARK_PID" = "$E2" ] && ! kill -0 "$E2" 2>/dev/null; then
  ok "E2 脚本被 SIGKILL 后标记残留、且里面的持有 pid 已死（= 验收 2 的真实输入）"
else
  no "E2 残留标记的持有 pid 不对（marker=${MARK_PID:-空} 期望 ${E2}）"
fi

# E3：正常收尾（SIGTERM）⇒ EXIT trap 摘掉标记（残留只应来自 -9 那一支，别把两道闸混成一道）
H4="$TMP/home4"
mk_home "$H4" hang
HOME="$H4" MATTER_PORT="$PORT" bash "$ISO/restart-matter.sh" > "$TMP/e3.log" 2>&1 &
E3=$!
disown "$E3" 2>/dev/null
for _ in $(seq 1 100); do
  [ -f "$H4/.dsh-matter/restart.inprogress" ] && break
  sleep 0.1
done
kill -TERM "$E3" 2>/dev/null
sleep 0.5
if [ -f "$H4/.dsh-matter/restart.inprogress" ]; then
  no "E3 SIGTERM 后标记仍在（EXIT trap 没跑到 —— 那 watchdog 只剩超时兜底）"
else
  ok "E3 SIGTERM 收尾即摘标记（实测：TERM 会跑 EXIT trap，KILL 不会）"
fi

# ══ 二、消费端：watchdog-matter.sh 的让路 / 接管 ═══════════════════════════════
say ""
say "二、消费端（watchdog-matter.sh）"
# A 基线：无标记 + 无监听 ⇒ 必须照常自愈（这一支是真挂时的救命路径，一点不许变）
HA="$TMP/homeA"
mkdir -p "$HA"
B="$(calls)"
LOG="$(run_wd "$ISO/watchdog-matter.sh" "$HA" 1.2)"
A_N="$(calls)"
if [ "$A_N" -gt "$B" ]; then
  ok "A 无标记 + 无监听 ⇒ 照常自愈（验收 3）"
else
  no "A 没自愈 —— 自愈网被误伤（比竞争更严重）"
fi
grep -q "经 restart-matter.sh 拉起" "$LOG" 2>/dev/null \
  && ok "A 自愈那一行照旧出声" || no "A 缺「经 restart-matter.sh 拉起」"

# B 标记在 + 持有进程活着 ⇒ 必须让路（验收 1）
HB="$TMP/homeB"
mkdir -p "$HB/.dsh-matter"
sleep 60 &
HOLDER=$!
disown "$HOLDER" 2>/dev/null
printf 'pid=%s\nat=test\n' "$HOLDER" > "$HB/.dsh-matter/restart.inprogress"
B="$(calls)"
LOG="$(run_wd "$ISO/watchdog-matter.sh" "$HB" 1.2)"
B_N="$(calls)"
if [ "$B_N" -eq "$B" ]; then
  ok "B 标记 + 持有者存活 ⇒ watchdog 不出手（验收 1）"
else
  no "B 仍然拉起了重启（$((B_N - B)) 次）—— 竞争没治住"
fi
grep -q "让路" "$LOG" 2>/dev/null && ok "B 让路有出声（不是静默跳过）" || no "B 让路是静默的"
if [ -d "$HB/.dsh-matter/incidents" ] && [ -n "$(ls -A "$HB/.dsh-matter/incidents" 2>/dev/null)" ]; then
  no "B 仍拍了现场快照 —— 手工重启还会刷 incident 日志"
else
  ok "B 未拍现场快照（incident 不再被正常重启刷）"
fi
kill "$HOLDER" 2>/dev/null

# B2 标记是**别端口**的窗口（MATTER_PORT=3211 那类开发重启）⇒ 不许挡 3210 的自愈
HB2="$TMP/homeB2"
mkdir -p "$HB2/.dsh-matter"
sleep 60 &
HOLDER4=$!
disown "$HOLDER4" 2>/dev/null
printf 'pid=%s\nport=%s\n' "$HOLDER4" "$((PORT + 1000))" > "$HB2/.dsh-matter/restart.inprogress"
B="$(calls)"
LOG="$(run_wd "$ISO/watchdog-matter.sh" "$HB2" 1.2)"
B2_N="$(calls)"
if [ "$B2_N" -gt "$B" ]; then
  ok "B2 标记标的是别端口 ⇒ 不挡 3210 的自愈（一次开发重启不该静默关掉守护）"
else
  no "B2 别端口的标记把 3210 的自愈挡住了"
fi
[ -f "$HB2/.dsh-matter/restart.inprogress" ] \
  && ok "B2 别端口的标记没被搬走（那是别人的证据）" || no "B2 把别端口的标记搬走了"
kill "$HOLDER4" 2>/dev/null

# C 标记残留（持有 pid 已死，用 E2 的真实残留）⇒ 必须立刻接管（验收 2）
B="$(calls)"
LOG="$(run_wd "$ISO/watchdog-matter.sh" "$H2" 1.2)"
C_N="$(calls)"
if [ "$C_N" -gt "$B" ]; then
  ok "C 手工重启中途被杀（标记残留、持有 pid 已死）⇒ watchdog 立刻接管（验收 2）"
else
  no "C 没接管 —— 脚本崩了会把真自愈挡住（最常见的坏实现）"
fi
grep -q "已死" "$LOG" 2>/dev/null && ok "C 判过期的理由说清楚了（持有进程已死）" || no "C 未说明判过期理由"
if [ -f "$H2/.dsh-matter/restart.inprogress" ]; then
  no "C 过期标记没被搬走（下轮还会判一次，日志会刷）"
else
  ok "C 过期标记搬走留证（mv 不 rm，可复核）"
fi

# D 持有者活着但超时 ⇒ 也必须接管（卡死兜底）
HD="$TMP/homeD"
mkdir -p "$HD/.dsh-matter"
sleep 60 &
HOLDER2=$!
disown "$HOLDER2" 2>/dev/null
printf 'pid=%s\n' "$HOLDER2" > "$HD/.dsh-matter/restart.inprogress"
touch -t 202001010000 "$HD/.dsh-matter/restart.inprogress"
B="$(calls)"
LOG="$(run_wd "$ISO/watchdog-matter.sh" "$HD" 1.2)"
D_N="$(calls)"
if [ "$D_N" -gt "$B" ]; then
  ok "D 标记超时（持有者仍活着）⇒ 照常自愈（超时兜底有牙）"
else
  no "D 超时了还挡着自愈 —— 卡死的脚本会把自愈永久挡死"
fi
if ls "$HD/.dsh-matter"/restart.inprogress.stale-* >/dev/null 2>&1; then
  ok "D 过期标记搬走留证"
else
  no "D 过期标记没搬走"
fi
kill "$HOLDER2" 2>/dev/null

# ══ 三、变异验证：摘掉某一行，对应场景必须转红 ═════════════════════════════════
say ""
say "三、变异验证（摘掉判据 ⇒ 对应场景必须转红）"
# M1：摘掉标记检查 ⇒ B 场景必须转红（自愈重新发生）
M1="$TMP/mut1"
mkdir -p "$M1"
if mut_file "$ISO/watchdog-matter.sh" "$M1/watchdog-matter.sh" \
  '  if restart_in_progress; then' '  if false; then  # 变异M1：摘掉标记检查' 2>"$TMP/m1.err"; then
  HM1="$TMP/homeM1"
  mkdir -p "$HM1/.dsh-matter"
  sleep 60 &
  HOLDER3=$!
  disown "$HOLDER3" 2>/dev/null
  printf 'pid=%s\n' "$HOLDER3" > "$HM1/.dsh-matter/restart.inprogress"
  B="$(calls)"
  LOG="$(run_wd "$M1/watchdog-matter.sh" "$HM1" 1.2)"
  M1_N="$(calls)"
  if [ "$M1_N" -gt "$B" ]; then
    ok "M1 摘掉标记检查 ⇒ B 场景转红（守卫确实钉在那一行上，不是恒绿）"
  else
    no "M1 摘掉检查仍不出手 —— 守卫恒绿，等于没牙"
  fi
  kill "$HOLDER3" 2>/dev/null
else
  no "M1 变异没打上（锚点漂了）：$(cat "$TMP/m1.err" 2>/dev/null | head -1)"
fi

# M2：摘掉「持有 pid 存活」判据（只留超时）⇒ C 场景必须转红（不接管）
M2="$TMP/mut2"
mkdir -p "$M2"
if mut_file "$ISO/watchdog-matter.sh" "$M2/watchdog-matter.sh" \
  'if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1 && [ "$age" -le "$RESTART_MARKER_TTL" ]; then' \
  'if [ -n "$pid" ] && [ "$age" -le "$RESTART_MARKER_TTL" ]; then  # 变异M2：摘掉存活判据' 2>"$TMP/m2.err"; then
  HM2="$TMP/homeM2"
  mkdir -p "$HM2/.dsh-matter"
  # 死 pid 的标记：先起一个立刻退出的进程，取其 pid
  sleep 0.01 &
  DEADPID=$!
  wait "$DEADPID" 2>/dev/null
  printf 'pid=%s\n' "$DEADPID" > "$HM2/.dsh-matter/restart.inprogress"
  B="$(calls)"
  LOG="$(run_wd "$M2/watchdog-matter.sh" "$HM2" 1.2)"
  M2_N="$(calls)"
  if [ "$M2_N" -eq "$B" ]; then
    ok "M2 摘掉存活判据 ⇒ C 场景转红（只按超时会白挂满 TTL，这条判据是主判据）"
  else
    no "M2 摘掉存活判据却照样接管 —— 说明这条断言没咬住目标行"
  fi
else
  no "M2 变异没打上（锚点漂了）：$(cat "$TMP/m2.err" 2>/dev/null | head -1)"
fi

# M3：摘掉生产端的 EXIT trap ⇒ E1 场景必须转红（标记残留）
M3="$TMP/mut3"
mkdir -p "$M3"
cp "$ISO/prod-guard.sh" "$ISO/app-proxy.sh" "$ISO/preload-x25519.mjs" "$M3/"
if mut_file "$ISO/restart-matter.sh" "$M3/restart-matter.sh" \
  'trap clear_restart_marker EXIT' ': 变异M3：摘掉 EXIT trap' 2>"$TMP/m3.err"; then
  H3="$TMP/home3"
  mk_home "$H3" dead
  OUT="$(HOME="$H3" MATTER_PORT="$PORT" bash "$M3/restart-matter.sh" 2>&1)"
  if [ -f "$H3/.dsh-matter/restart.inprogress" ]; then
    ok "M3 摘掉 EXIT trap ⇒ 标记残留（E1 转红，说明摘标记那块真有牙）"
  else
    no "M3 摘掉 EXIT trap 后标记仍被清 —— 这条断言没咬住目标行"
  fi
else
  no "M3 变异没打上（锚点漂了）：$(cat "$TMP/m3.err" 2>/dev/null | head -1)"
fi

say ""
if [ "$FAIL" -eq 0 ]; then
  say "✓ 全绿：${PASS} 通过 / 0 失败"
  exit 0
fi
say "✗ 有红：${PASS} 通过 / ${FAIL} 失败"
[ "${RACE_SELFTEST_KEEP:-}" = "1" ] && say "  临时目录保留：$TMP"
exit 1
