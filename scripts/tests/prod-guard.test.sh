#!/bin/bash
# ISS-558 守卫测试：`scripts/prod-guard.sh`（杀 3210 的牙）+ 三个调用方的接线。
#
# 为什么需要（审查 HIGH-2）：牙的判据原先是 `ps -E -p <pid>` 取 `DSH_HOME`，而 **agent 沙箱里
# `ps` 一律 `Operation not permitted`**（实测 `ps -p` / `-o` / `-E` 全被拒）⇒ 判据恒取空值 ⇒
# **不带变量也放行**（fail-open，牙不咬）。而 `scripts/tests/` 对 `FORGE_ALLOW_RESTART_PROD`
# **零覆盖** —— 一个没人验过的门禁等于没有门禁。本文件就是它的回归网。
#
# 覆盖（五组判据 + 三个调用方）：
#   ① 判据命中生产 home 且无变量      ⇒ exit 4，**且一次 kill 都没有**
#   ② 带 FORGE_ALLOW_RESTART_PROD=1   ⇒ 放行（调用方真的走到 kill 那一步）
#   ③ 判据不可用（lsof 不存在 / 非零退出 / 空输出）⇒ **拦**（fail-closed）
#   ④ 带 FORGE_WATCHDOG_SELFHEAL=1（自愈通道，不带 ②）⇒ **只放行 watchdog 管辖的 pid**（ISS-639）
#   ⑤ pid 已不存在 ⇒ 放行（stale pidfile 必须能过，否则重启永远发不出去）
#   ⑥ 源码级：三条 kill 路径都接了牙，且牙在第一条真 kill **之前**
#   ⑩ 源码级：SELFHEAL 不许退回「带标记就无条件 exit 0」（ISS-639 的 fail-open 回归网）
#
# ⚠️⚠️ **全程不 kill 任何真实进程**（尤其不碰 3210 / 19387）：把 `kill` 用 bash 导出函数
# **遮蔽内置**（只记录到 $KILL_LOG，从不发信号；`kill -0` 也走桩），`lsof` / `launchctl` /
# `curl` / `node` / `sleep` 全部用 PATH 桩，pid 与 lsof 输出全部可注入。跑在 mktemp 沙箱里，
# 连 `$HOME` 都指向沙箱 ⇒ 判据里的 `$HOME/.dsh-matter` 绝不指向真实 home。
#
# 跑法：bash scripts/tests/prod-guard.test.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$REPO/scripts/prod-guard.sh"
SB="$(mktemp -d -t prodguard)"
trap 'rm -rf "$SB"' EXIT

export HOME="$SB/home"
mkdir -p "$HOME/.dsh-matter/pm" "$SB/bin" "$SB/lsofout" "$HOME/.dsh"
KILL_LOG="$SB/kill.log"; : > "$KILL_LOG"; export KILL_LOG
PROD_FILE="$HOME/.dsh-matter/pm/issue.md"   # 判据里要匹配的绝对前缀，就来自这个沙箱 home

pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
no() { echo "  ✗ $1"; fail=$((fail + 1)); }

# ── 桩 ①：kill（**遮蔽内置**，这是「绝不真杀」的保证）─────────────────────────
#   `kill -0 <pid>`：默认「活着」；pid == $FAKE_DEAD_PID 时返回 1（模拟进程已不存在）。
#   其余形态（真信号）：**只追加一行日志**，从不发信号。
kill() {
  printf 'kill %s\n' "$*" >> "${KILL_LOG:?}"
  if [ "${1:-}" = "-0" ]; then
    if [ -n "${FAKE_DEAD_PID:-}" ] && [ "${2:-}" = "${FAKE_DEAD_PID:-}" ]; then return 1; fi
    return 0
  fi
  # 真实信号：桩里「杀完即消失」—— 落一个标记，让 lsof 桩不再报告该 listener。
  # 不这么做会凭空造出「进程已 kill、端口仍有 listener」的状态，把 restart-matter.sh 的
  # stray 分支（pidfile 已删、listener 换/留着）当真事跑，测出的是桩的假象而非真行为。
  : > "${KILL_LOG%/*}/gone_$1"
  return 0
}
export -f kill

# ── 桩 ②：lsof（pid → 打开的文件列表可注入；也负责「判据不可用」的三种形态）──
cat > "$SB/bin/lsof" <<'STUB'
#!/bin/bash
# 找 listener：打印 $FAKE_LISTENER_PID（该 pid 已被桩 kill 过 ⇒ 已不在，打印空）
case "$*" in *-tiTCP:*)
  if [ -n "${FAKE_LISTENER_PID:-}" ] && [ -f "${KILL_LOG%/*}/gone_${FAKE_LISTENER_PID}" ]; then exit 0; fi
  printf '%s\n' "${FAKE_LISTENER_PID:-}"; exit 0 ;;
esac
if [ "${1:-}" = "-p" ]; then
  case "${FAKE_LSOF_MODE:-ok}" in
    fail)  exit 1 ;;            # 非零退出 ⇒ 判据不可用
    empty) exit 0 ;;            # 输出为空 ⇒ 判据不可用
  esac
  f="${FAKE_LSOF_DIR:-}/$2.txt" # ok：该 pid 的打开文件清单从文件读
  [ -f "${f}" ] || exit 1
  cat "${f}"; exit 0
fi
exit 0
STUB
chmod +x "$SB/bin/lsof"
# launchctl（watchdog 探活要「在跑」）/ curl（就绪探测拿不到 3 位码）/ node / sleep（免等）
printf '#!/bin/bash\necho "%s"\nexit 0\n' "${FORGE_WATCHDOG_LABEL:-com.openforge.watchdog-matter}" > "$SB/bin/launchctl"
printf '#!/bin/bash\necho 000\n' > "$SB/bin/curl"
printf '#!/bin/bash\nexit 0\n' > "$SB/bin/node"
printf '#!/bin/bash\nexit 0\n' > "$SB/bin/sleep"
chmod +x "$SB/bin/launchctl" "$SB/bin/curl" "$SB/bin/node" "$SB/bin/sleep"
STUB_PATH="$SB/bin:$PATH"

# 判据用的两份 lsof 输出：命中生产 / 不是生产
printf '%s\n' "$PROD_FILE" "/usr/lib/libz.1.dylib" > "$SB/lsofout/4242.txt"
printf '%s\n' "/usr/lib/libz.1.dylib" "/Users/someone/other/project/a.md" > "$SB/lsofout/4243.txt"

run_guard() { # run_guard <pid> [额外环境由调用方 export]；结果在 ${grc} / ${gout}
  gout="$(bash "$GUARD" require-kill "$1" 2>&1)"; grc=$?
}
unset FORGE_ALLOW_RESTART_PROD FORGE_WATCHDOG_SELFHEAL FORGE_PROD_HOME_MATTER
export PATH="$STUB_PATH" FAKE_LSOF_MODE=ok FAKE_LSOF_DIR="$SB/lsofout"

echo "── ① 判据命中生产 home 且无变量 ⇒ 拦（exit 4）──"
run_guard 4242
[ "${grc}" -eq 4 ] && ok "exit 4（拦下）" || no "该拦没拦（rc=${grc}）"
printf '%s' "${gout}" | grep -q "Matter 生产实例" && ok "提示语点明「生产实例」" || no "提示语没说清是生产实例"
printf '%s' "${gout}" | grep -q "FORGE_ALLOW_RESTART_PROD=1" && ok "提示语给出放行办法" || no "提示语没给放行办法"
printf '%s' "${gout}" | grep -q "dev-instance.sh" && ok "提示语给出隔离实例（验证不碰生产）" || no "提示语没给隔离实例"

echo "── ② 带 FORGE_ALLOW_RESTART_PROD=1 ⇒ 放行（exit 0）──"
export FORGE_ALLOW_RESTART_PROD=1
run_guard 4242
[ "${grc}" -eq 0 ] && ok "exit 0（放行）" || no "带了变量还被拦（rc=${grc}）"
unset FORGE_ALLOW_RESTART_PROD

echo "── ③ 判据不可用 ⇒ 拦（fail-closed，三条形态）──"
FAKE_LSOF_MODE=fail run_guard 4242
[ "${grc}" -eq 4 ] && ok "lsof 非零退出 ⇒ exit 4" || no "lsof 失败却放行（rc=${grc}）"
FAKE_LSOF_MODE=empty run_guard 4242
[ "${grc}" -eq 4 ] && ok "lsof 输出为空 ⇒ exit 4" || no "lsof 空输出却放行（rc=${grc}）"
FAKE_LSOF_MODE=ok
gout="$(PATH=/nonexistent /bin/bash "$GUARD" require-kill 4242 2>&1)"; grc=$?
[ "${grc}" -eq 4 ] && ok "lsof 不存在 ⇒ exit 4" || no "lsof 不存在却放行（rc=${grc}）"
printf '%s' "${gout}" | grep -q "判据不可用" && ok "提示语点明「判据不可用 ⇒ 按生产处理」" || no "提示语没说判据不可用"

echo "── ④ 自愈通道 FORGE_WATCHDOG_SELFHEAL=1 ⇒ 只放行「watchdog 管辖的那个 pid」（ISS-639）──"
# 旧行为（ISS-639 的 fail-open）：带标记就无条件 exit 0 —— 标记被注入 agent 会话环境后，
# **任何 pid** 都能杀，连 3210 也能。现口径：标记 **+ pid == $HOME/.dsh-matter/matter.pid** 才放行。
export FORGE_WATCHDOG_SELFHEAL=1
echo 4242 > "$HOME/.dsh-matter/matter.pid"
run_guard 4242
[ "${grc}" -eq 0 ] && ok "pid == pidfile 内容 ⇒ exit 0（watchdog 自愈不被拦）" || no "自愈通道没放行（rc=${grc}）"
echo 4243 > "$HOME/.dsh-matter/matter.pid"
run_guard 4242
[ "${grc}" -eq 4 ] && ok "pid ≠ pidfile 内容（4242 是生产）⇒ exit 4（**核心证据：标记不再放行任意 pid**）" \
  || no "标记 + 不等 pid 仍被放行（rc=${grc}）—— fail-open 没修掉"
printf '%s' "${gout}" | grep -q "不是 watchdog 管辖的 pid" && ok "stderr 给出不放行的提醒" || no "没有提醒（静默降级）"
rm -f "$HOME/.dsh-matter/matter.pid"
run_guard 4242
[ "${grc}" -eq 4 ] && ok "pidfile 不存在 ⇒ 不放行（拿不到对应 pidfile 就 fail-closed）" || no "无 pidfile 仍放行（rc=${grc}）"
echo 4242 > "$HOME/.dsh-matter/matter.pid"
export FORGE_ALLOW_RESTART_PROD=1
run_guard 4242
[ "${grc}" -eq 0 ] && ok "人的显式确认通道不受影响（FORGE_ALLOW_RESTART_PROD=1 对生产 pid 仍放行）" || no "显式确认通道被误伤（rc=${grc}）"
unset FORGE_ALLOW_RESTART_PROD
unset FORGE_WATCHDOG_SELFHEAL

echo "── ⑤ pid 已不存在 ⇒ 放行（stale pidfile 路径必须能过）──"
export FAKE_DEAD_PID=4242
run_guard 4242
[ "${grc}" -eq 0 ] && ok "exit 0（没有可杀的东西）" || no "死 pid 被拦（rc=${grc}）"
unset FAKE_DEAD_PID

echo "── ⑥ 非生产进程 ⇒ 放行（不误伤老盘实例/别的进程）──"
run_guard 4243
[ "${grc}" -eq 0 ] && ok "exit 0（lsof 输出不含生产 home）" || no "非生产被误拦（rc=${grc}）"

echo "── ⑦ 调用方接线：三条 kill 路径都必须先过牙，且拦下时**一次 kill 都没有**──"
: > "$KILL_LOG"
PATH="$STUB_PATH" FAKE_LISTENER_PID=4242 bash "$REPO/scripts/restart-web-detached.sh" > "$SB/o1" 2>&1
rc=$?
[ "${rc}" -eq 4 ] && ok "restart-web-detached.sh 被拦（exit 4）" || no "restart-web-detached.sh 没被拦（rc=${rc}）"
grep -q '^kill 4242' "$KILL_LOG" && no "被拦却仍然 kill 了 4242" || ok "被拦时**一次 kill 都没有**"

# restart-matter.sh 需要的最小现场（全在沙箱 HOME 里；MATTER_PORT 指高位空闲端口，双保险）
mkdir -p "$HOME/dsh-local/node_modules/@deepseek-ai/dsh/lib"
: > "$HOME/dsh-local/node_modules/@deepseek-ai/dsh/lib/bin.js"
echo 4242 > "$HOME/.dsh-matter/matter.pid"

: > "$KILL_LOG"
PATH="$STUB_PATH" FAKE_LISTENER_PID=4242 MATTER_PORT=3299 bash "$REPO/scripts/restart-matter.sh" > "$SB/o2" 2>&1
rc=$?
[ "${rc}" -eq 4 ] && ok "restart-matter.sh 被拦（exit 4，此前它**无牙**）" || no "restart-matter.sh 没被拦（rc=${rc}）"
grep -q '^kill 4242' "$KILL_LOG" && no "被拦却仍然 kill 了 4242" || ok "被拦时**一次 kill 都没有**"

: > "$KILL_LOG"
PATH="$STUB_PATH" FAKE_LISTENER_PID=4242 bash "$REPO/scripts/restart-web.sh" > "$SB/o3" 2>&1
rc=$?
[ "${rc}" -eq 4 ] && ok "restart-web.sh 被拦（exit 4，此前它**无牙**）" || no "restart-web.sh 没被拦（rc=${rc}）"
grep -q '^kill 4242' "$KILL_LOG" && no "被拦却仍然 kill 了 4242" || ok "被拦时**一次 kill 都没有**"

echo "── ⑧ 自愈通道端到端：带 FORGE_WATCHDOG_SELFHEAL=1 ⇒ restart-matter.sh 越过牙走到 kill──"
: > "$KILL_LOG"
echo 4242 > "$HOME/.dsh-matter/matter.pid"
PATH="$STUB_PATH" FAKE_LISTENER_PID=4242 MATTER_PORT=3299 FORGE_WATCHDOG_SELFHEAL=1 \
  bash "$REPO/scripts/restart-matter.sh" > "$SB/o4" 2>&1
rc=$?
[ "${rc}" -ne 4 ] && ok "自愈委派未被牙拦下（rc=${rc} ≠ 4）" || no "自愈委派被牙拦下（rc=4）—— watchdog 形同虚设"
grep -q '^kill 4242' "$KILL_LOG" && ok "确实走到了 kill 那一步（桩记录，未发信号）" || no "没走到 kill 那一步"

echo "── ⑨ 源码级：牙在第一条真 kill 之前 + watchdog 真的导出自愈标记──"
for f in restart-matter.sh restart-web.sh restart-web-detached.sh; do
  # ⚠️ 两个坑都要避开：① `require-kill` 自己含 "kill" 字样；② 注释/echo 里的 "kill" 是文字不是动作
  #    ⇒ 先滤掉 require-kill 行与注释行，再取第一条真 kill。
  gl="$(grep -n 'require-kill' "$REPO/scripts/${f}" | head -1 | cut -d: -f1)"
  kl="$(grep -nE '(^|[^_a-zA-Z-])kill[[:space:]]+"?\$|xargs[^|]*[[:space:]]kill|kill[[:space:]]+-(9|15|TERM|KILL)' "$REPO/scripts/${f}" \
        | grep -v 'require-kill' | grep -vE '^[0-9]+:[[:space:]]*#' | head -1 | cut -d: -f1)"
  if [ -n "${gl}" ] && [ -n "${kl}" ] && [ "${gl}" -lt "${kl}" ]; then
    ok "${f}：牙(:${gl}) 在第一条真 kill(:${kl}) 之前"
  else
    no "${f}：接线顺序不对（牙=${gl:-无} / kill=${kl:-无}）"
  fi
done
grep -q 'FORGE_WATCHDOG_SELFHEAL=1 bash "\$RESTART"' "$REPO/scripts/watchdog-matter.sh" \
  && ok "watchdog-matter.sh 委派 restart-matter.sh 时导出 FORGE_WATCHDOG_SELFHEAL=1" \
  || no "watchdog-matter.sh 没导出自愈标记 —— 自愈会被牙拦死"
# 判据只有一份：三个调用方都不许自己抄 `ps -E` 那套
if grep -nE '^[[:space:]]*[^#]*ps[[:space:]]+-E' "$REPO/scripts/restart-web-detached.sh" "$REPO/scripts/restart-matter.sh" "$REPO/scripts/restart-web.sh" >/dev/null 2>&1; then
  no "仍有脚本自带 ps -E 判据（判据没收敛到 prod-guard.sh 一份）"
else
  ok "判据只有一份（三个调用方都不含 ps -E）"
fi

echo "── ⑩ 源码级：SELFHEAL 不许退回「带标记就无条件 exit 0」（ISS-639 回归网）──"
# 这一条防的是「以后有人为了省事把 pid 校验删回去」——旧写法就是一句 `] && exit 0`。
if grep -nE 'FORGE_WATCHDOG_SELFHEAL[^#]*\]\][[:space:]]*&&[[:space:]]*exit[[:space:]]+0' "$GUARD"; then
  no "牙里仍有「SELFHEAL 短路 exit 0」（不看 pid ⇒ 任意 pid 放行，fail-open 回来了）"
else
  ok "没有「SELFHEAL ⇒ 无条件 exit 0」的短路"
fi
grep -q 'WATCHDOG_PIDFILE="$PROD_HOME_MATTER/matter.pid"' "$GUARD" \
  && ok "自愈通道按 matter.pid 收窄（与 watchdog-matter.sh 读的是同一个文件）" \
  || no "自愈通道没接 pidfile —— 收窄口径丢了"
# ISS-639 第二半：泄漏点。`env` **继承**当前环境 ⇒ watchdog 导出的 SELFHEAL 会漏进生产进程自身，
# 再被它 spawn 的每个 agent bash 继承（实测就是本单的病：「标记怎么跑到 agent 会话里的」）。
# 起盘行必须 `-u` 掉它（实测量法：沙箱起盘后子进程 env 里该变量 0 条）。
grep -qE '^env -u FORGE_WATCHDOG_SELFHEAL' "$REPO/scripts/restart-matter.sh" \
  && ok "restart-matter.sh 起盘行 -u 掉 SELFHEAL（标记不进生产进程环境）" \
  || no "restart-matter.sh 起盘没 -u SELFHEAL —— 标记会漏进生产进程、被 agent 会话继承"

echo "── 结果：${pass} 通过 / ${fail} 失败 ──"
[ "${fail}" -eq 0 ] || exit 1
