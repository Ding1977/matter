#!/bin/bash
# prod-guard.sh — 「确需重启生产服务」的**单一判据口径**（ISS-558）。只读，自己从不 kill。
#
# 为什么存在：3210 是官方 App(19387) Matter 面板的数据源（生产服务）。过去「确需重启请先在
# 会话里声明理由」只是**纯劝告**（脚本不检查、无门禁），别的 agent 会话验证时顺手 kill 掉它，
# 老板界面中断 5-12s —— 与项目原则「守卫要有牙」冲突。本脚本把劝告变成**机械动作**。
#
# 判据（**不依赖 ps**）：`lsof -p <pid>` 列出该进程打开的文件，含 `$HOME/.dsh-matter/` 即判为
#   Matter 生产实例。为什么不用 `ps -E -p` 取 DSH_HOME（旧写法）：agent 沙箱里 `ps` 一律
#   `/bin/ps: Operation not permitted`（`ps -p` / `-o` / `-E` 全被拒，2026-10-01 实测）⇒ 旧判据
#   恒取空值 ⇒ **不带变量也放行**（fail-open，牙不咬）。`lsof` 在同一沙箱可用（实测
#   `lsof -p <3210pid> | grep -c '.dsh-matter'` = 30），且调用方本来就用 lsof 找 listener
#   —— 同一依赖面，不新增依赖。
# ⚠️ **fail-closed**：判据**取不到**（lsof 不存在 / 非零退出 / 输出为空）⇒ **拦**（按生产处理）。
#   宁可让「确需重启」的人多打一个变量，也不让生产实例被静默 kill。
#
# 用法（调用方在**每一条 kill 路径之前**调一次；三个调用方共用本口径，禁止各抄一份）：
#   bash scripts/prod-guard.sh require-kill <pid>
# 退出码：0 = 放行（可以 kill）· 4 = 拦下（不要 kill）· 64 = 用法错
#
# 放行通道（三条，判据短路；**不猜调用者是谁**）：
#   ① FORGE_WATCHDOG_SELFHEAL=1 —— 自愈通道：watchdog 委派重启时**显式导出**（人不要手动设）。
#      watchdog 是 3210 的自愈网，它拉起的重启**不得被牙拦下**，否则 watchdog 形同虚设。
#      ⚠️ ISS-639：**必须同时 pid 匹配**——只放行 watchdog 自己管辖的那一个 pid，即
#      `${PROD_HOME_MATTER}/matter.pid` 的内容；其余 pid 照跑真判据（详见下方站点注释）。
#   ② FORGE_ALLOW_RESTART_PROD=1 —— 人/agent 确需重启生产时的显式确认（人主动设的，不是注入的）。
#   ③ pid 已不存在（`kill -0` 失败）—— 没有可杀的东西，放行（stale pidfile 路径必须能过）。
set -u

PROD_HOME_MATTER="${FORGE_PROD_HOME_MATTER:-$HOME/.dsh-matter}"
# watchdog 管辖的 pid 记录：**与 watchdog-matter.sh:83 读、restart-matter.sh:25 写的是同一个文件**。
WATCHDOG_PIDFILE="$PROD_HOME_MATTER/matter.pid"
CMD="${1:-}"
PID="${2:-}"
UNAVAIL=""

usage() {
  echo "用法：bash scripts/prod-guard.sh require-kill <pid>" >&2
  echo "  退出码：0 = 放行 · 4 = 拦下 · 64 = 用法错" >&2
}

block() {  # $1 = 拦下的具体理由（判据命中 / 判据不可用）
  echo "✗ 拦下：$1"
  echo "  3210 是官方 App(19387) Matter 面板的数据源 —— kill 它 = 老板界面中断 5-12s + App 控制台 502"
  echo "  （账目口径与复算命令见 docs/project-code-rules.md §4.6：启动 43 − watchdog down 32 = 差额 11 次）。"
  echo "  ① 验证改动走隔离实例（生产 3210 全程不动）：bash scripts/dev-instance.sh start <ISS-NNN>"
  echo "     ⚠️ 该脚本当前有已知欠账（老 home 假设 ⇒ PM 层悬空 / 装配树旧拷贝），先读 docs/project-code-rules.md §4.6"
  echo "  ② 确需重启生产服务：显式确认后重跑，带 FORGE_ALLOW_RESTART_PROD=1"
  echo "  ③ 自愈通道：watchdog 委派重启时带 FORGE_WATCHDOG_SELFHEAL=1（只放行它管辖的 pid = ${WATCHDOG_PIDFILE} 的内容；人不要手动设）"
  exit 4
}

[ "$CMD" = "require-kill" ] || { usage; exit 64; }
[ -n "$PID" ] || { echo "✗ 缺 pid 参数" >&2; usage; exit 64; }

# ── 放行通道（短路，判据不必跑）──────────────────────────────────────────────
# ① 自愈通道 —— ISS-639 修了一处**高危 fail-open**：
#   旧写法 `[ "${FORGE_WATCHDOG_SELFHEAL:-0}" = "1" ] && exit 0` 是三条短路里**唯一不看 pid 的**，
#   而该标记会被注入 agent 会话环境（实测：干净 env 下拦 3210 得 exit 4，注入后**放行**）
#   ⇒ 「杀 3210 必须过牙」（AGENTS §4 铁律一）恰好在**最需要它的地方**失效。
#   收窄口径（老板批的「甲」）：SELFHEAL 只放行 watchdog **自己管辖的那一个 pid**。
#   判据 = `$WATCHDOG_PIDFILE` 的内容正好等于本次要杀的 pid —— 与「watchdog 委派重启」的定义
#   对齐：它要重启的是它跟踪的那个进程，不是任意 pid。pidfile 缺失 / 读不到 / 值不等
#   ⇒ **不 exit**，只在 stderr 提醒一句，然后继续往下跑真判据（与判据不可用同样 fail-closed：
#   **宁可误拦**——自愈失败有人看得见；**不可误放**——误放 = 生产被杀且无人知）。
#   老盘 watchdog-web.sh 的 pidfile 是 `$HOME/.dsh/web.pid`（另一个 home），本脚本**不去猜**它：
#   拿不到对应 pidfile ⇒ 不放行 + 提醒。代价可控且方向正确 —— 老盘实例不打开生产 home，真判据
#   本来就放行；而**真打开生产 home 的那个 pid 恰是不该由退役 watchdog 杀的**（两个 watchdog
#   抢同一端口的冲突正是它退役的原因，见 watchdog-web.sh 文件头）。
if [ "${FORGE_WATCHDOG_SELFHEAL:-0}" = "1" ]; then
  wd_pid=""
  # ⚠️ K9c（ISS-640 · 老板批 A）：这行原写法是 `[ -f ... ] && wd_pid="$(tr ... 2>/dev/null || true)"`
  #   —— pidfile 存在却读不出时，连**原因**都不留（`tr` 的报错被吞、`|| true` 又抹掉退出码），
  #   于是「自愈为什么没放行」只能靠猜。改成 if 块并让 stderr 照常外露：**行为不变**
  #   （读不到 ⇒ wd_pid 为空 ⇒ 不放行、继续走下面的真判据，仍 fail-closed），只是不再静音。
  #   `|| wd_pid=""` 保留「读不到不算错」的原意，但不用 `|| true`（那是 E5/K9c 要治的形状）。
  if [ -f "$WATCHDOG_PIDFILE" ]; then
    wd_pid="$(tr -d '[:space:]' < "$WATCHDOG_PIDFILE")" || wd_pid=""
  fi
  if [ -n "$wd_pid" ] && [ "$wd_pid" = "$PID" ]; then
    exit 0
  fi
  printf '⚠️  自愈通道未放行：PID %s 不是 watchdog 管辖的 pid（%s = %s）⇒ 继续走真判据（ISS-639）\n' \
    "$PID" "$WATCHDOG_PIDFILE" "${wd_pid:-读不到/文件不存在}" >&2
fi
[ "${FORGE_ALLOW_RESTART_PROD:-0}" = "1" ] && exit 0
# pid 已不存在 ⇒ 没有可杀的东西。**必须在判据之前**：restart-matter.sh 的 pidfile 常是 stale 的，
# 若对死 pid 判「lsof 输出为空 ⇒ 判据不可用 ⇒ 拦」，重启就永远发不出去。
kill -0 "$PID" 2>/dev/null || exit 0

# ── 判据：lsof -p 打开的文件里是否含生产 home ────────────────────────────────
# 返回 0 = 生产（拦）· 1 = 非生产（放行）· 2 = 判据不可用（拦，fail-closed）
judge() {
  local out
  command -v lsof >/dev/null 2>&1 || { UNAVAIL="lsof 不存在"; return 2; }
  # ⚠️ 非零退出即判「不可用」：lsof 对**存在的进程**实测 rc=0；rc=1 只出现在「pid 不存在或
  #    打不开」——那种情况下输出不可信，按生产处理（fail-closed）。
  out="$(lsof -p "$PID" 2>/dev/null)" || { UNAVAIL="lsof -p 非零退出"; return 2; }
  [ -n "$out" ] || { UNAVAIL="lsof -p 输出为空"; return 2; }
  printf '%s\n' "$out" | grep -qF "$PROD_HOME_MATTER/" && return 0
  return 1
}

judge
case "$?" in
  0) block "PID ${PID} 是 Matter 生产实例（判据：lsof -p 打开的文件含 ${PROD_HOME_MATTER}/）" ;;
  2) block "判据不可用（${UNAVAIL}）⇒ 按生产处理（fail-closed）" ;;
  *) exit 0 ;;
esac
