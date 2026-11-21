#!/usr/bin/env bash
# Matter 真相源自动快照（ISS-483）
#
# ── 为什么需要它 ────────────────────────────────────────────────────────────
# `~/.dsh-matter/pm` 是 Matter 的**唯一真相源**（md + YAML frontmatter）。2026-09-15 持久化
#   ⚠️ 2026-10-01 甲案：路径从 `~/.dsh/pm` 迁到 `~/.dsh-matter/pm`（3210 的独立 home），
#      与 `restart-matter.sh` 的 `FORGE_PM_ROOT` 对齐；旧目录已改名 `pm.moved-*` 待观察后删。
# 体检实测：写入链路很扎实（唯一写入口 / tmp+rename 原子写 / safeJoin 路径闸门 /
# 派生索引签名校验，1,834 个 md 零损坏），**但零自动备份** —— scripts/ 里没有备份
# 脚本、launchd 里没有定时任务，仅有的两份 `pm-backup-*` 是重构时手工建的，唯一兜底
# 是 Time Machine。
#
# 核心资产只有 5.5 MB / 1,623 文件（过程数据 runs/queue/... 已在 .gitignore 排除），
# 用 git 管理毫无压力，一次解决四件事：备份、历史回溯、误删恢复、双电脑同步。
#
# ── 用法 ────────────────────────────────────────────────────────────────────
#   bash scripts/pm-backup.sh              正常快照（无变更则跳过，不留空 commit）
#   bash scripts/pm-backup.sh --status     只报告状态，什么都不写
#   PM_BACKUP_PUSH=1 bash scripts/pm-backup.sh    快照后推送远端（双电脑同步）
#
# 由 launchd 每小时调起（com.openforge.pm-backup.plist）；手工跑同样安全。
#
# ── 设计取舍 ────────────────────────────────────────────────────────────────
# · **无变更不 commit**：否则每小时一个空提交，git log 会被噪声淹没，真正的变更点
#   反而找不到。
# · **push 失败不阻断**：离线 / 远端未建时，本地历史照样要留下（本地备份是主目标，
#   同步是附加项），故 push 失败只记日志、不改变退出码。
# · **不 gc 全量**：只调 `git gc --auto`（git 自己判断阈值，绝大多数时候是 no-op）。
#   每天强跑一次 `git gc` 会在大仓库上白烧 CPU，而本仓库只有几 MB。

set -euo pipefail

PM_ROOT="${PM_BACKUP_ROOT:-$HOME/.dsh-matter/pm}"
LOG="${PM_BACKUP_LOG:-$HOME/.dsh/pm-backup.log}"
GIT=/usr/bin/git
PUSH="${PM_BACKUP_PUSH:-0}"
MODE="${1:-}"
LOG_MAX_LINES=2000

ts() { date +%Y-%m-%dT%H:%M:%S%z; }

log_line() {
  printf '%s  %s\n' "$(ts)" "$*" >> "$LOG" 2>/dev/null || true
  # 日志自截断：只保留最近 LOG_MAX_LINES 行（避免又长成一个需要体检的文件）
  if [ -f "$LOG" ]; then
    local n
    n=$(wc -l < "$LOG" 2>/dev/null || echo 0)
    if [ "$n" -gt "$LOG_MAX_LINES" ]; then
      tail -n "$LOG_MAX_LINES" "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG" 2>/dev/null || true
    fi
  fi
}

die() { log_line "✗ $*"; echo "✗ $*" >&2; exit 1; }

# ── 前置检查 ────────────────────────────────────────────────────────────────
[ -d "$PM_ROOT" ] || die "Matter 数据目录不存在：$PM_ROOT"
[ -d "$PM_ROOT/.git" ] || die "$PM_ROOT 不是 git 仓库（先跑一次性初始化：git init + 首提交）"
command -v "$GIT" >/dev/null 2>&1 || die "找不到 git：$GIT"

cd "$PM_ROOT"

# ── --status：只报告，不写任何东西 ─────────────────────────────────────────
if [ "$MODE" = "--status" ]; then
  echo "仓库     : $PM_ROOT"
  echo "分支     : $($GIT rev-parse --abbrev-ref HEAD)"
  echo "最新提交 : $($GIT log -1 --format='%h %ad %s' --date=format:'%Y-%m-%d %H:%M')"
  echo "提交总数 : $($GIT rev-list --count HEAD)"
  echo "未提交   : $($GIT status --porcelain | wc -l | tr -d ' ') 个文件"
  # ⚠️ 不能用 `git remote -v | head -1 || echo '（未配置）'`：无远端时 git 返回
  #    **空输出但退出码 0**，`||` 分支根本不触发，结果是印出一个空行（实测踩中）。
  remote_line="$($GIT remote -v | head -1)"
  echo "远端     : ${remote_line:-（未配置）}"
  echo "仓库体积 : $(du -sh .git 2>/dev/null | cut -f1)"
  echo "日志     : $LOG"
  exit 0
fi

# ── 并发保护 ────────────────────────────────────────────────────────────────
# launchd 每小时一次、单次通常 <1s，但手工触发可能与定时任务重叠。用目录锁 +
# 陈旧判断（>1h 视为上次崩溃的残留），避免两个 git 进程抢 index.lock。
LOCK="$PM_ROOT/.git/pm-backup.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  lock_age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$lock_age" -gt 3600 ]; then
    rmdir "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || { log_line "· 锁竞争，跳过本轮"; exit 0; }
  else
    log_line "· 上一轮快照仍在运行（${lock_age}s），跳过本轮"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# ── 快照 ────────────────────────────────────────────────────────────────────
$GIT add -A

if $GIT diff --cached --quiet; then
  log_line "· 无变更，跳过"
  exit 0
fi

# 变更摘要：一行短统计 + 按域分布（让人一眼看出这轮动了什么）
SHORTSTAT="$($GIT diff --cached --shortstat | sed 's/^ *//')"
BY_TOP="$($GIT diff --cached --name-only | awk -F/ '{print $1}' | sort | uniq -c | sort -rn | awk '{printf "%s(%s) ", $2, $1}' | sed 's/ $//')"
CHANGED="$($GIT diff --cached --name-only | wc -l | tr -d ' ')"

$GIT commit -q -F - <<EOF
snapshot: $(ts)

$SHORTSTAT
域: $BY_TOP
EOF

SHA="$($GIT rev-parse --short HEAD)"

# ── 可选推送（双电脑同步）────────────────────────────────────────────────────
PUSH_NOTE=""
if [ "$PUSH" = "1" ]; then
  if $GIT remote get-url origin >/dev/null 2>&1; then
    if $GIT push -q origin HEAD 2>>"$LOG"; then
      PUSH_NOTE=" → 已推送"
    else
      PUSH_NOTE=" ⚠ push 失败（离线？凭据？）"
    fi
  else
    PUSH_NOTE=" ⚠ 未配置 origin，跳过推送"
  fi
fi

log_line "✓ $SHA — $CHANGED 文件变更 [$BY_TOP]$PUSH_NOTE"

# git 自己判断是否需要整理（绝大多数时候 no-op）
$GIT gc --auto --quiet 2>/dev/null || true
