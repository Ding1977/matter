#!/bin/bash
# ISS-668 守卫测试：`restart-matter.sh` 必须在 kill 之前落一份在飞清单。
#
# ## 这条守卫要挡的三类假绿（每类都对应工单的一条验收项）
#   ① **整步没接**（本单的病因）：脚本里一个 inflight 字样都没有 ⇒ 手动重启永不落清单
#      ⇒ `inflight.json` 停在几小时前（工单实测：10:40 落，14:14 差 3.5 小时）⇒ ISS-667 自动恢复没输入。
#   ② **接了但在 kill 之后**：进程已死时才落，tier 全是 interrupted —— 看似"能恢复"，
#      实际上这时 `lsof` 那层存活证据已经没了，落出来的现场与"重启前的现场"不是一回事。
#      故判据是**行号顺序**：落清单那段 < 第一条真 kill。
#   ③ **失败会阻断重启 或 静默失败**：清单是锦上添花，重启是主目的 ⇒ 失败必须**继续重启**，
#      且**必须出声**（静默 = 回到"重启无痕"）。
#
# ## 怎么跑（全程不碰真盘、不杀真进程）
# `HOME` 指向 mktemp 沙箱；`kill` 用导出函数遮蔽内置（只记日志、从不发信号）；
# `lsof` / `curl` / `node` / `sleep` 全走 PATH 桩 ⇒ 判据里的 `$HOME/.dsh-matter` 绝不指向真实 home。
# ⚠️ 桩 `node` 不能一律 `exit 0`（那么"清单落了吗"就无法验证）：它只在参数里出现
#    `inflight-cli.mjs` 时**真的**跑该 CLI（指向沙箱 home），其余调用照旧空跑。
#
# 跑法：bash scripts/tests/restart-inflight.test.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d -t restartinflight)"
trap 'rm -rf "$SB"' EXIT

export HOME="$SB/home"
mkdir -p "$HOME/.dsh-matter/pm" "$HOME/.dsh-matter/forge-messenger" "$SB/bin" "$SB/lsofout" "$HOME/dsh-local/node_modules/@deepseek-ai/dsh/lib"
: > "$HOME/dsh-local/node_modules/@deepseek-ai/dsh/lib/bin.js"
KILL_LOG="$SB/kill.log"; : > "$KILL_LOG"; export KILL_LOG
# 真 node（桩 shell 里要转调它跑 CLI）
REAL_NODE="$(command -v node 2>/dev/null || echo /usr/local/bin/node)"

pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
no() { echo "  ✗ $1"; fail=$((fail + 1)); }

# ── 桩 ①：kill（遮蔽内置；只记录，从不发信号）────────────────────────────────
# ⚠️ 记录「kill 那一刻清单在不在」——这是**行为层**的顺序判据（源码行号顺序见 ②）：
#    源码顺序能被"挪一行注释"骗过，而"kill 发生时盘上有没有那份清单"骗不过。
ORDER_LOG="$SB/order.log"; : > "$ORDER_LOG"; export ORDER_LOG
export INFLIGHT_JSON_FOR_STUB="$HOME/.dsh-matter/forge-messenger/inflight.json"
kill() {
  printf 'kill %s\n' "$*" >> "${KILL_LOG:?}"
  if [ "${1:-}" = "-0" ]; then
    [ -n "${FAKE_DEAD_PID:-}" ] && [ "${2:-}" = "${FAKE_DEAD_PID:-}" ] && return 1
    return 0
  fi
  # 真信号：记下此刻清单在不在（第一条真 kill 的这条记录就是判据）
  if [ -f "${INFLIGHT_JSON_FOR_STUB:-/nonexistent}" ]; then
    printf 'inflight-present\n' >> "${ORDER_LOG:?}"
  else
    printf 'inflight-absent\n' >> "${ORDER_LOG:?}"
  fi
  : > "${KILL_LOG%/*}/gone_$1"
  return 0
}
export -f kill

# ── 桩 ②：node —— 只有「跑 inflight-cli.mjs」这一种调用要真跑，其余空跑 ──────
cat > "$SB/bin/node" <<STUB
#!/bin/bash
case "\$*" in
  *inflight-cli.mjs*)
    # 失败注入：FAKE_INFLIGHT_RC=3 时模拟「算出来但落盘失败」（CLI 的退出码口径）
    if [ -n "\${FAKE_INFLIGHT_RC:-}" ]; then
      echo "清单生成失败：模拟写盘失败" >&2
      exit "\$FAKE_INFLIGHT_RC"
    fi
    exec "$REAL_NODE" "\$@"
    ;;
esac
exit 0
STUB
chmod +x "$SB/bin/node"
# lsof（listener 由 $FAKE_LISTENER_PID 注入；-p 形态给空清单）
cat > "$SB/bin/lsof" <<'STUB'
#!/bin/bash
case "$*" in *-tiTCP:*) printf '%s\n' "${FAKE_LISTENER_PID:-}"; exit 0 ;; esac
exit 0
STUB
chmod +x "$SB/bin/lsof"
printf '#!/bin/bash\necho 000\n' > "$SB/bin/curl"
printf '#!/bin/bash\nexit 0\n' > "$SB/bin/sleep"
chmod +x "$SB/bin/curl" "$SB/bin/sleep"
STUB_PATH="$SB/bin:$PATH"

# 沙箱里造一条「引擎正持有它、且轮未收尾」的会话日志（判据与真盘同形）
SID="session-1668-aaaa"
SDIR="$HOME/.dsh-matter/sessions/proj/$SID"
mkdir -p "$SDIR"; : > "$SDIR/session.lock"
NOW_MS="$("$REAL_NODE" -e 'process.stdout.write(String(Date.now()))')"
printf '%s\n' \
  "{\"type\":\"session\",\"id\":\"$SID\",\"cwd\":\"/tmp\",\"agentPreset\":\"builder\"}" \
  "{\"type\":\"turn/start\",\"data\":{\"turn\":3},\"time\":$NOW_MS}" \
  "{\"type\":\"step/start\",\"data\":{\"turn\":3,\"step\":7},\"time\":$NOW_MS}" \
  > "$SDIR/session.v4.jsonl"
INFLIGHT_JSON="$HOME/.dsh-matter/forge-messenger/inflight.json"

echo "── ① 源码级：restart-matter.sh 里真的有「落清单」那一步（删掉它 ⇒ 这里红）──"
if grep -qE 'inflight-cli\.mjs' "$REPO/scripts/restart-matter.sh"; then
  ok "调了 inflight-cli.mjs"
else
  no "restart-matter.sh 里没有 inflight-cli.mjs —— 手动重启仍然不落清单（本单的病因回来了）"
fi

echo "── ② 源码级：落清单那段必须在**第一条真 kill 之前**（kill 后落 = 现场已失真）──"
# ⚠️ 坑：`require_kill_ok` 与注释里都有 "kill" 字样，都不是动作
#    ⇒ 先滤掉注释行与 require-kill 行，再取第一条真 kill 的行号（口径照 prod-guard.test.sh ⑨）。
il="$(grep -n 'inflight-cli\.mjs' "$REPO/scripts/restart-matter.sh" | head -1 | cut -d: -f1)"
kl="$(grep -nE '(^|[^_a-zA-Z-])kill[[:space:]]+"?\$|xargs[^|]*[[:space:]]kill|kill[[:space:]]+-(9|15|TERM|KILL)' "$REPO/scripts/restart-matter.sh" \
      | grep -v 'require-kill' | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1)"
if [ -n "$il" ] && [ -n "$kl" ] && [ "$il" -lt "$kl" ]; then
  ok "落清单(:${il}) 在第一条真 kill(:${kl}) 之前"
else
  no "顺序不对（落清单=${il:-无} / 第一条真 kill=${kl:-无}）—— 清单记的不是重启前的现场"
fi

echo "── ③ 行为级：跑一次重启 ⇒ 清单真的落了，且是「重启前那一刻」的 mtime ──"
rm -f "$INFLIGHT_JSON"
: > "$ORDER_LOG"
BEFORE_MS="$("$REAL_NODE" -e 'process.stdout.write(String(Date.now()))')"
echo 4242 > "$HOME/.dsh-matter/matter.pid"
PATH="$STUB_PATH" FAKE_LISTENER_PID=4242 MATTER_PORT=3299 FORGE_ALLOW_RESTART_PROD=1 \
  bash "$REPO/scripts/restart-matter.sh" > "$SB/run1" 2>&1
if [ -f "$INFLIGHT_JSON" ]; then
  ok "清单已落盘（此前不存在）"
  MTIME_S="$(stat -f %m "$INFLIGHT_JSON" 2>/dev/null || echo 0)"
  [ "$MTIME_S" -ge "$((BEFORE_MS / 1000 - 2))" ] \
    && ok "mtime 是重启前那一刻（now-$(( (BEFORE_MS/1000) - MTIME_S ))s 内）" \
    || no "mtime 不是重启前那一刻（清单 mtime=${MTIME_S}，重启发起=${BEFORE_MS}）"
  # 清单要真的记下了那条会话（不是空表）
  grep -q "$SID" "$INFLIGHT_JSON" && ok "清单里记下了正在跑的会话（$SID）" \
    || no "清单是空的 —— 落了文件但没记现场"
  # 行为层顺序判据：第一条真 kill 发生时，清单**已经**在盘上
  first_order="$(head -1 "$ORDER_LOG" 2>/dev/null)"
  [ "$first_order" = "inflight-present" ] \
    && ok "第一条 kill 发生前清单已在盘上（行为层，骗不过）" \
    || no "第一条 kill 时清单还不在（${first_order:-无记录}）—— 落清单被挪到 kill 之后了"
else
  no "跑完重启后没有 inflight.json —— 落清单那步没生效"
fi

echo "── ④ 行为级：落清单失败 ⇒ **不阻断重启**（走到 kill）且**出声** ──"
# 判据：kill 日志里有 4242（说明重启继续了）+ stdout 里有告警 + 退出码不是被清单拖死的
: > "$KILL_LOG"
rm -f "$INFLIGHT_JSON"
PATH="$STUB_PATH" FAKE_LISTENER_PID=4242 MATTER_PORT=3299 FORGE_ALLOW_RESTART_PROD=1 FAKE_INFLIGHT_RC=3 \
  bash "$REPO/scripts/restart-matter.sh" > "$SB/run2" 2>&1
rc2=$?
grep -q '^kill 4242' "$KILL_LOG" && ok "清单失败后**仍然** kill 了旧进程（重启没被阻断）" \
  || no "清单失败把重启也拖死了（kill 日志里没有 4242）"
grep -qE '⚠️.*清单' "$SB/run2" && ok "失败**出声**了（stdout 有告警）" \
  || no "清单失败静默（stdout 里没有告警）—— 等于回到「重启无痕」"
grep -q '模拟写盘失败' "$SB/run2" && ok "告警带上了 CLI 的原因（不是一句空话）" \
  || no "告警没带原因，排障时无从下手"
[ "$rc2" -ne 3 ] && ok "退出码没被清单的 rc=3 污染（rc=${rc2}）" \
  || no "退出码直接抄了清单的 rc=3 —— 把「清单失败」误报成「重启失败」"

echo "── ⑤ 行为级：清单成功时也要出声（成功路径同样不许静默）──"
grep -q '✓ 重启前在飞清单已落盘' "$SB/run1" && ok "成功路径报了「已落盘」+ 数字" \
  || no "成功路径没出声（不知道这份清单是谁落的）"

echo "── 结果：${pass} 通过 / ${fail} 失败 ──"
[ "${fail}" -eq 0 ] || exit 1
