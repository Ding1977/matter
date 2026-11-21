#!/usr/bin/env bash
# 把 forge-trae-direct 挂进 DSH 引擎（**App 19387 + 3210 两盘**）—— ISS-594。
#
# ⚠️ 2026-10-06 修正（老板问「怎么 App 有、3210 却没有」）：
#   本脚本原先**硬编码只覆盖 App**（全脚本 0 处提到 3210）⇒ 两引擎能力面不一致
#   （`forge-qoder-direct` 两边都有、`forge-trae-direct` 只有 App）。
#   脚本名字却叫"挂载本插件"，读的人会以为它管两盘 —— 那是**误导性代码**。现已两盘化。
#
# 为什么两个 home 必须**分别**挂：`~/.dsh`（App）与 `~/.dsh-matter`（3210）各有自己的
#   profile 与 `profiles/node_modules` 镜像，共用会互抢（AGENTS.md §5「装配按 home 分家」）。
#
# ⚠️ 生效口径（AGENTS.md §4.2 / §4.6 · 2026-10-06 老板明令修正）：
#   · **新增插件条目 + 软链 = 存盘 1-2s 热生效，不必重启**（3210 实测成立：
#     进程未重启，日志即出现「已注册 provider」）
#   · 确需重启时**按对象分家**：**App ⛔ 不用分离式**（会掐断宿主里跑的会话）
#       osascript -e 'tell application "DeepSeek Harness" to quit' && open -a "/Applications/DeepSeek Harness.app"
#     **3210 才用分离式**：bash scripts/restart-web-detached.sh（watchdog 5-12s 拉起）
#
# 用法：
#   bash scripts/mount-trae-direct.sh                      # 两盘都挂（默认）
#   bash scripts/mount-trae-direct.sh --target app         # 只挂 App
#   bash scripts/mount-trae-direct.sh --target dev         # 只挂 3210
#   bash scripts/mount-trae-direct.sh --check              # 只看现状（逐盘报）
#   bash scripts/mount-trae-direct.sh --rollback           # 还原（逐盘）
set -euo pipefail

REPO="<repo>"
PKG="$REPO/forge-trae-direct"
PKG_NAME="forge-trae-direct"

HOME_APP="$HOME/.dsh";        PROF_APP="desktop"
HOME_DEV="$HOME/.dsh-matter"; PROF_DEV="web"

TARGET="both"
for ((i = 1; i <= $#; i++)); do
  if [ "${!i}" = "--target" ]; then j=$((i + 1)); TARGET="${!j:-both}"; fi
done
case "$TARGET" in app|dev|both) ;; *) echo "✗ --target 只能是 app / dev / both"; exit 2 ;; esac

say() { printf '%s\n' "$*"; }
# 输出 "标签|home|profile"；用 | 分隔是因为 mac 自带 bash 3.2 没有 mapfile
targets() {
  if [ "$TARGET" = "app" ] || [ "$TARGET" = "both" ]; then echo "App|$HOME_APP|$PROF_APP"; fi
  if [ "$TARGET" = "dev" ] || [ "$TARGET" = "both" ]; then echo "3210|$HOME_DEV|$PROF_DEV"; fi
}

precheck() {
  local bad=0
  [ -d "$PKG" ] || { say "✗ 包不在主 checkout：${PKG}（先把 ISS-594 合并进 main）"; bad=1; }
  [ -f "$PKG/lib/index.js" ] || { say "✗ 包结构不对：缺 lib/index.js"; bad=1; }
  if [ -f "$PKG/lib/index.js" ]; then
    node --input-type=module -e "import('$PKG/lib/index.js').then(()=>0).catch(e=>{console.error(e.message);process.exit(1)})" \
      >/dev/null 2>&1 || { say "✗ 包 import 失败（挂上去会让引擎报错）"; bad=1; }
  fi
  while IFS='|' read -r label home prof; do
    [ -n "$label" ] || continue
    [ -f "$home/profiles/$prof/package.json" ] || { say "✗ ${label}：找不到 $home/profiles/$prof/package.json"; bad=1; }
    [ -d "$home/profiles/node_modules" ] || { say "✗ ${label}：找不到共享镜像 $home/profiles/node_modules"; bad=1; }
  done < <(targets)
  return $bad
}

show_one() {
  local label="$1" home="$2" prof="$3"
  say "── [$label] $home/profiles/$prof ──"
  say "  ① 共享镜像链：$(readlink "$home/profiles/node_modules/$PKG_NAME" 2>/dev/null || echo '（无）')"
  say "  ② 私有层链  ：$(readlink "$home/profiles/$prof/node_modules/$PKG_NAME" 2>/dev/null || echo '（无）')"
  python3 - "$home/profiles/$prof/package.json" "$PKG_NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
d = json.load(open(path))
b = d.get('dsh', {}).get('profile', {}).get('bundles', [])
dep = d.get('dependencies', {})
print(f"  ③ bundles 含 {name}：{name in b}")
print(f"  ④ deps 含 {name}   ：{name in dep}")
print(f"     （对照）forge-qoder-direct: bundles={'forge-qoder-direct' in b} deps={'forge-qoder-direct' in dep}")
PY
}
show() { while IFS='|' read -r l h p; do [ -n "$l" ] || continue; show_one "$l" "$h" "$p"; say ""; done < <(targets); }

mount_one() {
  local label="$1" home="$2" prof="$3"
  local prof_dir="$home/profiles/$prof" backup_dir="$home/.iss1268-backup"
  mkdir -p "$backup_dir"
  cp -p "$prof_dir/package.json" "$backup_dir/package.json.bak-$(date +%Y%m%d-%H%M%S)"
  say "[$label] ✓ 已备份 → $backup_dir"
  ln -sfn "$PKG" "$home/profiles/node_modules/$PKG_NAME"
  say "[$label] ✓ ① 共享镜像链"
  ln -sfn "$PKG" "$prof_dir/node_modules/$PKG_NAME"
  say "[$label] ✓ ② 私有层链"
  # ⚠️ 幂等插入：重复 insert ⇒ 引擎报 `duplicate loader entry id`（验证 home 上踩过）
  python3 - "$prof_dir/package.json" "$PKG" "$PKG_NAME" <<'PY'
import json, sys
path, pkg, name = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
prof = d.setdefault('dsh', {}).setdefault('profile', {})
b = prof.setdefault('bundles', [])
added = []
if name not in b:
    b.append(name); added.append('bundles')
deps = d.setdefault('dependencies', {})
if name not in deps:
    deps[name] = f'link:{pkg}'; added.append('dependencies')
json.dump(d, open(path, 'w'), indent=2, ensure_ascii=False)
open(path, 'a').write('\n')
print(f"✓ ③ profile 已声明（新增：{added or '无，已存在'}）")
PY
  say ""
}

rollback_one() {
  local label="$1" home="$2" prof="$3"
  local prof_dir="$home/profiles/$prof" backup_dir="$home/.iss1268-backup"
  local latest
  latest="$(ls -t "$backup_dir"/package.json.bak-* 2>/dev/null | head -1 || true)"
  if [ -z "$latest" ]; then say "[$label] ✗ 没有备份可还原"; return 0; fi
  cp -p "$latest" "$prof_dir/package.json"
  say "[$label] ✓ profile 已还原 ← $latest"
  rm -f "$home/profiles/node_modules/$PKG_NAME" "$prof_dir/node_modules/$PKG_NAME"
  say "[$label] ✓ 两条软链已删"
}

next_step() {
  say "── 生效与验证 ──"
  say "新增插件条目 + 软链 = 存盘 1-2s **热生效，不必重启**（§4.6；3210 实测成立）。"
  say "验证（引擎自己说 = K1e）：grep forge-trae-direct ~/.dsh-matter/matter.log | tail -1"
  say "真机自动验证（带积分熔断）：cd forge-trae-direct && bun run verify:live"
  say "确需重启时按对象分家："
  if [ "$TARGET" = "app" ] || [ "$TARGET" = "both" ]; then
    say "  [App] ⛔ 不用分离式：osascript -e 'tell application \"DeepSeek Harness\" to quit' && open -a \"/Applications/DeepSeek Harness.app\""
  fi
  if [ "$TARGET" = "dev" ] || [ "$TARGET" = "both" ]; then
    say "  [3210] 分离式：bash scripts/restart-web-detached.sh（watchdog 5-12s 拉起）"
  fi
}

case "${1:-}" in
  --check)    show ;;
  --rollback) while IFS='|' read -r l h p; do [ -n "$l" ] || continue; rollback_one "$l" "$h" "$p"; done < <(targets); next_step ;;
  *)
    precheck || { say ""; say "⛔ 前置自检未过 —— 不进入挂载（避免留下半吊子状态）"; exit 1; }
    while IFS='|' read -r l h p; do [ -n "$l" ] || continue; mount_one "$l" "$h" "$p"; done < <(targets)
    say "── 挂载完成（目标：${TARGET}）──"
    next_step
    ;;
esac
