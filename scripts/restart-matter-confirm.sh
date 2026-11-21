#!/bin/bash
# restart-matter-confirm.sh —— 重启 3210 前弹窗确认（老板 2026-10-08 指令：ISS-605）
#
# 行为：macOS 桌面弹窗 → 点「确认重启」或 30 秒无操作 → 重启；点「取消」→ 中止。
#
# ## ISS-928 补记：为什么这里要**分离式**执行
# 原实现是 `exec restart-matter.sh`（前台）。但 **agent 会话本身跑在 3210 进程里**
#   （`$PPID` == 3210 监听 PID，实测），前台 kill 会在宿主退出那一刻**掐断工具结果回传**
#   （`interrupted after recorded`，2026-09-28 与 2026-10-08 各实测一次）。
# ⇒ 两条既有约束在此撞车：
#     · AGENTS.md §4.2：agent 在进程内 ⇒ 必须分离式（原 `restart-web-detached.sh` 的解）
#     · ISS-605（本条）：重启 3210 ⇒ 必须弹窗确认
#   本脚本把**弹窗**留在前台（它必须与老板交互），把**重启动作**调度到分离子进程
#   —— 两条约束同时满足，agent 回传不断。
#
# 退出码沿用既有口径：
#   0=已调度 · 1=老板取消 · 2=弹窗失败（TCC）· 4=牙拦下 · 5=调度未生效且补刀失败
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# ★ 日志默认落**仓库工作区内**（scripts/，运行产物已 gitignore）：agent 沙箱（workspace-write）
#   只许写仓库内路径，默认写 ~/.dsh-matter 时 `>> "$LOG"` 的重定向在打开阶段即被
#   Operation not permitted 挡死 —— 重定向失败会让**整段后台命令不执行**，分离调度
#   静默死亡（比报错更坏）。需要原位时用 `DSH_MATTER_RESTART_CONFIRM_LOG=` 覆盖。
LOG="${DSH_MATTER_RESTART_CONFIRM_LOG:-$HERE/restart-confirm.log}"
mkdir -p "$(dirname "$LOG")"

RESP=$(osascript <<'OSA'
display dialog "⚠️ 即将重启 3210（开发环境）
界面将中断 5-12 秒，团队状态自动恢复

无操作 30 秒后自动执行重启" buttons {"取消", "确认重启"} default button "确认重启" giving up after 30 with icon caution
OSA
) || { echo "❌ 弹窗失败（TCC 权限？）——为防误操作，不重启。请改用 sudo 授权或手动确认。" >&2; exit 2; }

case "$RESP" in
  *"button returned:取消"*)
    echo "老板点了取消，不重启。"; exit 1 ;;
  *)
    # 「确认重启」或 30 秒超时（gave up:true）都执行
    echo "弹窗确认（或 30s 超时），调度重启…"
    ;;
esac

OLD_PID="$(lsof -tiTCP:3210 -sTCP:LISTEN 2>/dev/null | head -1 || true)"

# ── ① 先把重启动作**分离调度**：子进程做完整重启（restart-matter.sh 自己 nohup 起新进程）──
#   为什么整段都分离、而不是只分离 kill：restart-matter.sh 会 `sleep 2` 等旧进程退干净再起新，
#   那几秒仍在本 shell 里；只分离 kill 的话，主 shell 接下来照样会因为父进程死了而中断回传。
{
  echo "[$(date '+%m-%d %H:%M:%S')] confirm → 分离执行 restart-matter.sh（旧 PID=${OLD_PID:-无}）"
  FORGE_ALLOW_RESTART_PROD=1 bash "$HERE/restart-matter.sh" "$@"
  rc=$?
  echo "[$(date '+%m-%d %H:%M:%S')] restart-matter.sh 结束（exit=${rc}）"
} >> "$LOG" 2>&1 &
disown 2>/dev/null || true

# ── ② 校验分离调度**真的生效**（ISS-551 的教训：分离子进程可能被环境清理，
#      打印"已调度"却什么都没发生 —— 静默假成功比报错更坏）──
sleep 2
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  # 旧进程还在：要么是分离没生效，要么是它正在优雅退出（restart-matter.sh 里有 sleep）
  sleep 3
fi
NEW_PID="$(lsof -tiTCP:3210 -sTCP:LISTEN 2>/dev/null | head -1 || true)"

if [ -n "$OLD_PID" ] && [ -n "$NEW_PID" ] && [ "$OLD_PID" = "$NEW_PID" ]; then
  echo "✗ 旧进程 ${OLD_PID} 仍在（分离调度未生效）—— 重启**未完成**。"
  echo "  日志：$LOG"
  echo "  手动补：FORGE_ALLOW_RESTART_PROD=1 bash $HERE/restart-matter.sh"
  exit 5
fi

echo "✓ 已调度重启（旧 PID ${OLD_PID:-无}${NEW_PID:+；新 PID $NEW_PID}）"
echo "  日志：$LOG"
echo "  验证（**另起一次调用**，勿在本命令里等待）：curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3210/'"
