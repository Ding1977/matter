#!/usr/bin/env bash
# pm-backup.sh 守卫测试（ISS-483）
#
# 守住五条契约 —— 每一条都对应一个"看起来在备份、实际没备份"的失败形态：
#   ① 目录不存在 / 不是 git 仓库 → **明确报错**，不静默假装成功
#      （"以为备份了"是备份工具最危险的失败模式）
#   ② 有变更 → 产生一个 commit（且是完整的快照，不是半个）
#   ③ 无变更 → **不产生空 commit**（否则每小时一条噪声提交，真正的变更点会被淹没）
#   ④ 被 .gitignore 排除的过程数据不入库（runs/queue/sessions/… 是运行态，不是资产）
#   ⑤ --status 是只读的（跑完仓库状态一个字节都不变）
#
# 用法：bash scripts/tests/pm-backup.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/pm-backup.sh"
TMP="$(mktemp -d)"
export PM_BACKUP_ROOT="$TMP/pm"
export PM_BACKUP_LOG="$TMP/backup.log"

PASS=0; FAIL=0
trap 'rm -rf "$TMP"' EXIT

ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
no()  { printf '\033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else no "$1（期望 $3，实际 $2）"; fi; }

# 取脚本退出码（测试要断言失败路径，不能让它打断测试进程）
rc() { bash "$SCRIPT" "$@" >/dev/null 2>&1; echo $?; }
commits() { /usr/bin/git -C "$PM_BACKUP_ROOT" rev-list --count HEAD 2>/dev/null || echo 0; }

echo "── pm-backup.sh 守卫测试 ──────────────────────────"

# ① 目录不存在 → 非 0
check "目录不存在时报错退出" "$(rc)" "1"

# ① 不是 git 仓库 → 非 0
mkdir -p "$PM_BACKUP_ROOT"
check "非 git 仓库时报错退出" "$(rc)" "1"
[ -f "$PM_BACKUP_LOG" ] && ok "失败也留下日志（可排查）" || no "失败未写日志"

# 建一个模拟的 Matter 仓库（照搬真实仓库的 .gitignore 分层）
/usr/bin/git -C "$PM_BACKUP_ROOT" init -q
/usr/bin/git -C "$PM_BACKUP_ROOT" config user.email t@t.local
/usr/bin/git -C "$PM_BACKUP_ROOT" config user.name T
cat > "$PM_BACKUP_ROOT/.gitignore" <<'EOF'
.index/
.trash/
runs/
queue/
sessions/
state/
review-incoming/
*.tmp-*
*.lock
EOF
mkdir -p "$PM_BACKUP_ROOT/issues" "$PM_BACKUP_ROOT/runs"
echo "seed" > "$PM_BACKUP_ROOT/issues/seed.md"
/usr/bin/git -C "$PM_BACKUP_ROOT" add -A
/usr/bin/git -C "$PM_BACKUP_ROOT" commit -qm "seed"
BASE="$(commits)"

# ③ 无变更 → 不加 commit
check "无变更时不产生空 commit" "$(rc)" "0"
check "  提交数未变" "$(commits)" "$BASE"

# ② 有变更 → 产生一个 commit
echo "body" >> "$PM_BACKUP_ROOT/issues/seed.md"
check "有变更时正常退出" "$(rc)" "0"
check "  提交数 +1" "$(commits)" "$((BASE+1))"
MSG="$(/usr/bin/git -C "$PM_BACKUP_ROOT" log -1 --format=%s)"
case "$MSG" in
  snapshot:*) ok "  commit message 带 snapshot 前缀" ;;
  *)          no "  commit message 异常：$MSG" ;;
esac

# ④ 过程数据不入库（即使它变了）
echo "run log" > "$PM_BACKUP_ROOT/runs/RUN-001.md"
check "存在未追踪的过程数据时仍正常退出" "$(rc)" "0"
check "  过程数据未触发 commit" "$(commits)" "$((BASE+1))"
if /usr/bin/git -C "$PM_BACKUP_ROOT" ls-files | grep -q "^runs/"; then
  no "  runs/ 被误入库（.gitignore 失效）"
else
  ok "  runs/ 未入库"
fi

# ⑤ --status 只读
BEFORE="$(/usr/bin/git -C "$PM_BACKUP_ROOT" status --porcelain | sort | md5)"
bash "$SCRIPT" --status >/dev/null 2>&1
AFTER="$(/usr/bin/git -C "$PM_BACKUP_ROOT" status --porcelain | sort | md5)"
check "--status 不改变仓库状态" "$AFTER" "$BEFORE"
check "--status 退出码 0" "$(rc --status)" "0"

# 并发锁：手工占锁 → 本轮跳过且不加 commit
mkdir -p "$PM_BACKUP_ROOT/.git/pm-backup.lock"
echo "x" >> "$PM_BACKUP_ROOT/issues/seed.md"
check "持锁时跳过本轮" "$(rc)" "0"
check "  跳过时未加 commit" "$(commits)" "$((BASE+1))"
rmdir "$PM_BACKUP_ROOT/.git/pm-backup.lock"
check "释放锁后恢复工作" "$(rc)" "0"
check "  提交数 +1" "$(commits)" "$((BASE+2))"

echo "───────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m全部通过\033[0m：%d 项\n' "$PASS"; exit 0
else
  printf '\033[31m失败 %d 项\033[0m（通过 %d 项）\n' "$FAIL" "$PASS"; exit 1
fi
