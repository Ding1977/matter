#!/usr/bin/env bash
# home 级配置快照（ISS-618 · 2026-10-19）
#
# ── 为什么需要它 ────────────────────────────────────────────────────────────
# `~/.dsh-matter/` 与 `~/.dsh/` 是 DSH 的 **home 级配置**，它们在仓库之外、**不受 git 保护**：
#   · `AGENTS.md`        = 老板偏好（user-global，每轮注入）
#   · `cordis.patch.yml` = 5 个 agent preset 的装配（persona / 技能 / 工具面全在这里）
#
# 2026-10-19 一天之内，这两个文件被改了 11 次（persona 6 次 + 偏好 5 次），
# 每次只能靠 `/tmp` 临时备份兜底 —— `/tmp` 会被系统清，且不可追溯。
# 而 `cordis.patch.yml` 定义了 **5 个 agent 是谁**，重要性不亚于仓库里的代码。
#
# ── 做法：导出快照，不软链 ──────────────────────────────────────────────────
# 不把 home 文件搬进仓库、也不让 home 指向仓库 —— home 的归属是 DSH 的，
# 我们只**单向导出**一份到 `deploy/home/` 并提交。
#   · home 仍是真相源（DSH 读它）
#   · 仓库里的是**快照**（供回溯与 diff）
#   · 两边漂移时，本脚本报告差异，由人决定谁对
#
# ── 用法 ────────────────────────────────────────────────────────────────────
#   bash scripts/sync-home-config.sh            导出快照（无变更不 commit）
#   bash scripts/sync-home-config.sh --status   只报告差异，什么都不写
#   bash scripts/sync-home-config.sh --check    退出码 1 = 有未同步的差异（供门禁用）
#
# ── 设计取舍 ────────────────────────────────────────────────────────────────
# · **无变更不 commit**：同 `pm-backup.sh` —— 否则每次跑都留空提交，log 被噪声淹没。
# · **保留文件名与相对结构**：`deploy/home/AGENTS.md`、`deploy/home/cordis.patch.yml`，
#   不做时间戳命名 —— 要看历史用 `git log -p deploy/home/xxx`。
# · **不含密钥**：只导这两个文件；settings.yaml / .credentials.yaml 一律不导。
# · **两个 home 都导**：3210 = `~/.dsh-matter`（开发）、App = `~/.dsh`（生产）。
#   若两者是软链关系（本仓已建 `~/.dsh/AGENTS.md` → `~/.dsh-matter/AGENTS.md`），
#   内容相同则只存一份，脚本自动去重。

set -uo pipefail

REPO="${HOME}/dsh-forge"
DEST="${REPO}/deploy/home"
MODE="${1:-}"

# 候选 home（按优先级；不存在的跳过）
HOMES=("${HOME}/.dsh-matter" "${HOME}/.dsh")

# 导出白名单 —— 只导这些，别的 home 文件一律不碰
FILES=("AGENTS.md" "cordis.patch.yml")

say() { printf '%s\n' "$*"; }
err() { printf '✗ %s\n' "$*" >&2; }

# ── --status / --check：只报告 ────────────────────────────────────────────────
if [ "$MODE" = "--status" ] || [ "$MODE" = "--check" ]; then
  drift=0
  for home in "${HOMES[@]}"; do
    [ -d "$home" ] || continue
    for f in "${FILES[@]}"; do
      src="${home}/${f}"
      [ -e "$src" ] || continue
      # 去重：软链解析后若与已处理的同内容，跳过
      dst="${DEST}/${f}"
      if [ ! -f "$dst" ]; then
        say "  [缺失] ${src}  → deploy/home/${f} 不存在"
        drift=1
      elif ! cmp -s "$src" "$dst"; then
        say "  [漂移] ${src}  与 deploy/home/${f} 不同"
        drift=1
      else
        say "  [一致] ${src}"
      fi
    done
  done
  if [ "$drift" -eq 0 ]; then
    say "全部已同步。"
    exit 0
  fi
  say ""
  say "有未同步的差异。跑 \`bash scripts/sync-home-config.sh\` 导出快照。"
  [ "$MODE" = "--check" ] && exit 1 || exit 0
fi

# ── 导出 ─────────────────────────────────────────────────────────────────────
mkdir -p "$DEST" || { err "无法创建 ${DEST}"; exit 1; }

copied=0
for home in "${HOMES[@]}"; do
  [ -d "$home" ] || continue
  for f in "${FILES[@]}"; do
    src="${home}/${f}"
    [ -e "$src" ] || continue
    dst="${DEST}/${f}"
    # 内容相同则不覆盖（保留 mtime，减少无意义 diff）
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
      continue
    fi
    cp "$src" "$dst" || { err "复制失败: ${src}"; exit 1; }
    say "  导出 ${src} → deploy/home/${f}"
    copied=$((copied + 1))
  done
done

if [ "$copied" -eq 0 ]; then
  say "无变更，跳过提交。"
  exit 0
fi

# 只提交 deploy/home/ 下的文件
cd "$REPO" || { err "无法进入 ${REPO}"; exit 1; }
git add deploy/home/ 2>/dev/null || { err "git add 失败"; exit 1; }

if git diff --cached --quiet; then
  say "暂存区无实际变更，跳过提交。"
  exit 0
fi

git commit -q -m "chore(home): home 级配置快照（AGENTS.md + cordis.patch.yml）[no-issue]

由 scripts/sync-home-config.sh 自动导出，非手改。
home 仍是真相源（DSH 读它）；deploy/home/ 是快照（供回溯与 diff）。" || { err "git commit 失败"; exit 1; }

say ""
say "✓ 已提交快照（${copied} 个文件有更新）"
git log --oneline -1
