#!/bin/bash
# 官方桌面端（DeepSeek Harness Desktop）隔离启动器
#
# 为什么要隔离（依据 docs/forge-split-architecture-2026-09-25.md §3.3 / §4.2）：
#   官方桌面端默认走 resolveDshHome() —— 与生产 A 引擎**共用 ~/.dsh**（同一批会话/设置）。
#   而 0.1.7 会把会话日志转写成新格式（v3 → v4，canary 实证），A 仍停在 0.1.5
#   → 共读同一会话根存在「A 读不出被 0.1.7 写过的会话」的不可逆风险。
#   本脚本用独立 DSH_HOME 启动，保证试用期**零接触生产数据**。
#   机制实证：@deepseek-ai/dsh-home-paths/lib/index.js:73-76（DSH_HOME 环境变量优先于默认 ~/.dsh）。
#
# 用法：
#   bash scripts/dsh-desktop.sh start     # 隔离启动（默认）
#   bash scripts/dsh-desktop.sh shared    # 共享 ~/.dsh 启动（老板明确要历史时才用）
#   bash scripts/dsh-desktop.sh status    # 看进程/端口/home
#   bash scripts/dsh-desktop.sh log       # 看启动日志
set -euo pipefail

APP="/Applications/DeepSeek Harness.app"
BIN="$APP/Contents/MacOS/DeepSeek Harness"
MODE="${1:-start}"

isolated_home="${FORGE_DESKTOP_HOME:-$HOME/.dsh-desktop}"
log_path="${FORGE_DESKTOP_LOG:-$HOME/.dsh-desktop-launch.log}"

case "$MODE" in
  status)
    echo "应用     : $APP"
    [ -d "$APP" ] && echo "已安装   : 是（$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null)）" || echo "已安装   : 否"
    echo "进程     : $(pgrep -f 'DeepSeek Harness.app/Contents/MacOS' | tr '\n' ' ' || true)"
    echo "端口19387: $(lsof -nP -iTCP:19387 -sTCP:LISTEN 2>/dev/null | tail -1 || echo '(未监听)')"
    for h in "$isolated_home" "$HOME/.dsh"; do
      [ -d "$h/profiles/desktop" ] && echo "profile  : $h/profiles/desktop（$(ls "$h/profiles/desktop" | wc -l | tr -d ' ') 项，mtime $(stat -f '%Sm' "$h/profiles/desktop")）"
    done
    exit 0
    ;;
  log)
    tail -n "${2:-40}" "$log_path" 2>/dev/null || echo "(无日志 $log_path)"
    exit 0
    ;;
  start)
    if [ ! -x "$BIN" ]; then echo "✗ 未找到官方桌面端：${BIN}（先安装 DMG）"; exit 1; fi
    if pgrep -f 'DeepSeek Harness.app/Contents/MacOS' >/dev/null 2>&1; then
      echo "已有官方桌面端在跑（PID $(pgrep -f 'DeepSeek Harness.app/Contents/MacOS' | tr '\n' ' '))；先退出它再启动。"
      exit 0
    fi
    export DSH_HOME="$isolated_home"
    mkdir -p "$DSH_HOME"
    echo "==> 隔离启动：DSH_HOME=${DSH_HOME}（生产 ~/.dsh 零接触）"
    # 代理：DSH 引擎只认启动环境快照（系统代理无效）——由 scripts/app-proxy.sh 统一解析
    # （探活失败则不带任何代理变量；死代理比没有代理更糟）。⚠️ bash 3.2 + set -u 下空数组展开会报错，用 ${A[@]+...}。
    A=()
    while IFS= read -r line; do A+=("$line"); done < <(bash "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/app-proxy.sh" env-args)
    [ "${#A[@]}" -gt 0 ] && echo "    代理  : $(bash "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/app-proxy.sh" check | head -1)"
    # 优先 `open --env`：进程由 launchd 托管，活得比 agent 会话久（铁律：agent bash 拉起的常驻进程活不过几分钟）。
    # 失败（老系统/权限）再退回直接执行二进制。
    if ! open -a "$APP" --env "DSH_HOME=$DSH_HOME" ${A[@]+"${A[@]}"} 2>"$log_path"; then
      echo "    （open --env 不可用，退回直接执行）"
      nohup "$BIN" >"$log_path" 2>&1 &
    fi
    sleep 5
    echo "    PID: $(pgrep -f 'DeepSeek Harness.app/Contents/MacOS' | tr '\n' ' ' || echo '(还没起来，看 log)')"
    echo "    日志: $log_path"
    echo "    核对: bash scripts/dsh-desktop.sh status"
    exit 0
    ;;
  shared)
    echo "==> ⚠️ 共享 ~/.dsh 启动（会与 A 引擎共用会话根，0.1.7 会写 v4 格式）"
    pgrep -f 'DeepSeek Harness.app/Contents/MacOS' >/dev/null 2>&1 && { echo "已有实例在跑，先退出。"; exit 0; }
    nohup "$BIN" >"$log_path" 2>&1 &
    sleep 3
    echo "    PID: $(pgrep -f 'DeepSeek Harness.app/Contents/MacOS' | tr '\n' ' ')"
    exit 0
    ;;
  *)
    echo "用法: bash scripts/dsh-desktop.sh {start|shared|status|log}"; exit 2;;
esac
