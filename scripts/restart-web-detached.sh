#!/bin/bash
# 分离式重启 dsh web（agent 安全版 v2）：
#   agent 会话本身就跑在 3210 进程里——前台执行 restart-web.sh 会在 kill 宿主瞬间
#   掐断工具结果回传（两次"interrupted, outcome unknown"的根因）。
#   本脚本把动作调度到分离子进程并**立即返回**。
#
# 职责刻意最小化：分离子进程只做 kill；新进程由 launchd watchdog 拉起
# （agent bash 环境会清理自己 spawn 的常驻进程——铁律 4，所以不在这里 nohup 启动）。
# 前提：watchdog 已由 launchd 托管（com.openforge.watchdog-matter.plist，5-12s 自动恢复；ISS-968 收敛后唯一 watchdog）。
#
# 用法：bash scripts/restart-web-detached.sh
# 验证（10s 后另起调用，勿在同一条命令里等待）：
#   lsof -tiTCP:3210 -sTCP:LISTEN        # 与旧 PID 对比
#   curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3210/
#
# 退出码（ISS-558 起分开 —— 原先「牙拦下」与「补刀失败」同为 4，分不清是哪种）：
#   0 = 已调度 / 3210 无进程      3 = watchdog 不在跑（拒绝调度）
#   4 = **牙拦下**（生产实例且未带 FORGE_ALLOW_RESTART_PROD=1；判据见 scripts/prod-guard.sh）
#   5 = 补刀失败（信号发了但进程仍存活 —— 权限不足或受保护）
# 牙的**单一判据口径**在 scripts/prod-guard.sh（不依赖 ps、fail-closed），本脚本只是调用方之一。

LOG=<repo>/.tmp/restart-detach.log
mkdir -p "$(dirname "$LOG")"
OLD_PID=$(lsof -tiTCP:3210 -sTCP:LISTEN 2>/dev/null || true)

# ── ISS-537：kill 之前先确认「有人接手」─────────────────────────────────────
# 本脚本只做 kill，新进程靠 launchd watchdog（5-12s）。watchdog 若不在跑，
# 这次「排程重启」就是一次**排程宕机** —— 2026-09-17 实测宕机约 2 分钟（ISS-535）。
# ISS-968 收敛（2026-09-30）：watchdog-web 退役，watchdog-matter 为唯一（探 3210、经 restart-matter.sh 拉起）。
WATCHDOG_LABEL="${FORGE_WATCHDOG_LABEL:-com.openforge.watchdog-matter}"

# ⚠️⚠️ 自检必须**两种检法**（2026-09-17 第二次踩到 · ISS-551）：
#   `launchctl list` 在 agent 会话 / 非图形上下文里**可能恒返回空**（0 行）——
#   此时 watchdog 明明 `state = running`（用 `launchctl print gui/<uid>/<label>` 可见），
#   但老写法把它读成"不在跑" → 本脚本**拒绝调度**（exit 3），重启永远发不出去。
#   判据：只要 print 里能看到 `state = running` 就算在跑；两种检法任一为真即可。
watchdog_up() {
  launchctl list 2>/dev/null | grep -q "$WATCHDOG_LABEL" && return 0
  launchctl print "gui/$(id -u)/$WATCHDOG_LABEL" 2>/dev/null | grep -q "state = running" && return 0
  return 1
}

if ! watchdog_up; then
  echo "✗ watchdog（${WATCHDOG_LABEL}）不在跑 —— 现在 kill 没人拉起，拒绝调度。"
  echo "  二选一："
  echo "    ① 先恢复自愈网：launchctl load ~/Library/LaunchAgents/${WATCHDOG_LABEL}.plist"
  echo "    ② 或改用完整重启：bash scripts/restart-matter.sh（它自己会起新进程并自检插件）"
  exit 3
fi

if [ -z "$OLD_PID" ]; then
  echo "3210 无进程在跑。若 watchdog 在运行会自动拉起；否则手动执行 restart-matter.sh"
  exit 0
fi

# ── ISS-558：3210 是 App(19387) 的 Matter **生产**数据源，顺手 kill 它 = 老板界面中断 ──
#   为什么加这道牙：规范里「确需重启请先在会话里声明理由」是**纯劝告**（脚本不检查、无门禁），
#   与项目原则「守卫要有牙」冲突（ISS-558 审查 M6）。这里把它变成**机械动作**。
#   ⚠️ 判据**只有一份**：scripts/prod-guard.sh（lsof -p 查打开的文件里有没有 $HOME/.dsh-matter/，
#   **不依赖 ps**，且判据取不到时 **fail-closed 拦下**）。本脚本、restart-matter.sh、restart-web.sh
#   三处 kill 路径共用它 —— 禁止在这里再抄一份判据（旧版就是抄了一份 `ps -E` 版，沙箱里恒取空值
#   ⇒ 不带变量也放行，牙不咬；2026-10-01 审查 HIGH-2 实测）。
GUARD="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/prod-guard.sh"
if ! bash "$GUARD" require-kill "$OLD_PID"; then
  exit 4   # 牙拦下（判据命中生产 / 判据不可用，两种都由 prod-guard.sh 出声说明）
fi

# ── ① 先按老路数分离调度（防"脚本自身就跑在被 kill 的进程里"那种情形掐断回传）──
{
  echo "[$(date '+%m-%d %H:%M:%S')] kill ${OLD_PID}（分离调度）"
  kill "$OLD_PID"
} >> "$LOG" 2>&1 &
disown 2>/dev/null || true

# ── ② ⚠️⚠️ 但分离子进程**可能从未执行** —— 必须校验，绝不允许"假成功"──────────────
# 2026-09-17 实测（第二次踩）：agent bash 会清理自己 spawn 的进程组 →
#   脚本打印"✓ 已调度"、`$LOG` 里**没有那条记录**、3210 的 PID 原封不动。
#   这类"说成功但什么都没做"最坏：人以为重启过了，接着按新行为排查 → 全错。
# 故：等 1s 校验进程是否真的消失；没消失就**本进程直接补一刀**；再不行就报错退出（exit 4）。
#   （实测直接 kill 不会掐断 agent 回传 —— 仅当脚本自身跑在被 kill 的进程里才会，
#    这正是 ① 先分离的原因；两者叠加后既安全又不会假报成功。）
sleep 1
if kill -0 "$OLD_PID" 2>/dev/null; then
  echo "  · 分离调度未生效（子进程被环境清理）→ 由本进程直接终止"
  echo "[$(date '+%m-%d %H:%M:%S')] kill ${OLD_PID}（前台补刀 · 分离未生效）" >> "$LOG"
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "✗ ${OLD_PID} 收到信号后仍存活（权限不足或受保护）—— 重启**未完成**，请查 ~/.dsh-matter/matter.log"
    exit 5   # 与「牙拦下(4)」分开：这条是**补刀失败**，不是门禁拒绝
  fi
  echo "✓ 已终止 ${OLD_PID}（分离未生效 → 已补刀）；watchdog 将在 5-12s 内拉起新进程"
else
  echo "✓ 已调度 kill ${OLD_PID}（分离执行）；watchdog 将在 5-12s 内拉起新进程"
fi

NEW_PID=$(lsof -tiTCP:3210 -sTCP:LISTEN 2>/dev/null || true)
echo "  3210 当前 PID：${NEW_PID:-（旧进程已退，等 watchdog 拉起）}"
echo "  验证（另起调用，勿在本命令里等待）：curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3210/'"
