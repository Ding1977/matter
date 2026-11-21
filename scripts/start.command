#!/bin/bash
# OpenForge (DSH) 启动器：自动起 dsh web（若未运行）+ Electron 壳。
# 双击桌面快捷方式或在终端执行本脚本均可。

set -euo pipefail

PROJECT_DIR="<repo>"
DSH_DIR="<dsh>"
PORT="${1:-3210}"
URL="http://127.0.0.1:${PORT}"

log() { printf '\033[1;36m[openforge]\033[0m %s\n' "$*"; }

# dsh web 是否已就绪（响应里带 __DSH_BOOT__ 才算真 DSH，避免误判别的服务）
is_up() { curl -sf "$URL" 2>/dev/null | grep -q "__DSH_BOOT__"; }

# 定位 electron 真实二进制（.bin/electron 是 stub，必须认 dist 里的 Electron）
find_electron() {
  for cand in \
    "$PROJECT_DIR/electron-shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
    "<home>/opencode/OpenForge/packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" \
    "<home>/opencode/OpenForge/node_modules/.bun/electron@42.3.3+759ce506b1ed1a42/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"; do
    if [ -x "$cand" ]; then printf '%s' "$cand"; return 0; fi
  done
  return 1
}

ELECTRON="$(find_electron)" || { log "❌ 找不到 electron 二进制（先 cd $PROJECT_DIR/electron-shell && bun install）"; exit 1; }
log "electron = $ELECTRON"

# 起 dsh web（已运行则复用）
if is_up; then
  log "dsh web 已在 $URL 运行，复用"
else
  log "启动 dsh web @ $URL ..."
  ( cd "$DSH_DIR" && exec node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port "$PORT" ) &
  for _ in $(seq 1 30); do
    is_up && break
    sleep 1
  done
  if ! is_up; then
    log "❌ dsh web 启动失败，请手动执行：cd $DSH_DIR && node node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port $PORT"
    exit 1
  fi
  log "dsh web 就绪"
fi

log "启动 Electron 壳 ..."
exec "$ELECTRON" "$PROJECT_DIR/electron-shell"
