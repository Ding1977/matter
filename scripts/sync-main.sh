#!/usr/bin/env bash
# sync-main.sh —— 下行同步本地 main（ISS-802 判据③）
#
# ## 为什么需要它
#   合并 PR 时是 **GitHub 那边**写 origin/main，本地 main 只会越来越旧。
#   修前要手敲两条（`git fetch origin` + `git update-ref refs/heads/main refs/remotes/origin/main`），
#   手敲的代价是**顺序与目标都可能错**：有人写成 `git pull`（会顺带动工作区/产生 merge 提交），
#   有人写成 `git reset --hard origin/main`（本地 main 上有未合入提交时直接丢掉，且会动工作区）。
#
# ## 它只做一件事，且只朝一个方向
#   fetch origin → 把 refs/heads/main 指向 refs/remotes/origin/main
#   **绝不产生任何网络推送**：本脚本内不出现任何推送命令（唯一的远端动作是 fetch，只读）。
#   也**绝不动工作区**：只改 ref，不 checkout、不 reset、不碰 index。
#
# ## 拒绝而不是硬覆盖
#   本地 main 若有**未合入**的提交（main 不是 origin/main 的祖先）⇒ 停下并说明。
#   那种状态下 `update-ref` 会把这些提交从 main 上摘掉（只剩 reflog 里能找到），
#   `reset --hard` 更狠。判据宁可拒绝，也不静默覆盖别人的提交。
#   另：main 正被某个工作树签出时也拒绝 —— 改 ref 会让那棵树的文件与 HEAD 静默不一致。
#
# ## 用法
#   bash scripts/sync-main.sh          # 在任意工作树/子目录里跑，操作的是**主库**（common git dir）的 main
#   退出码：0 完成（含"本来就是最新"）/ 1 拒绝（有未合入提交、或 main 被签出）/ 2 判不了（fetch 失败等）
set -uo pipefail

GCD="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -z "$GCD" ]; then
  echo "✗ 不在 git 仓库里（或 git 太旧，不支持 --path-format）—— 本脚本要在本仓的工作树/子目录里跑" >&2
  exit 2
fi
G() { git --git-dir="$GCD" "$@"; }

echo "主库（common git dir）= $GCD"

# ── ① fetch：只读远端，不动任何本地 ref（origin/main 与 refs/heads/main 各归各）──────
echo "▶ git fetch origin"
if ! G fetch origin; then
  echo "✗ fetch 失败（网络/凭据/远端不可达？原因见上一行 git 报错）⇒ 本地 main 一行没动" >&2
  exit 2
fi

if ! G rev-parse --verify -q refs/remotes/origin/main >/dev/null; then
  echo "✗ fetch 之后仍没有 refs/remotes/origin/main —— 远端没有 main 分支？⇒ 本地 main 一行没动" >&2
  exit 2
fi
NEW="$(G rev-parse refs/remotes/origin/main)"

# ── ② 本地 main 不存在：直接建成 origin/main（新克隆/新 bare 主库的形态）─────────────
if ! G rev-parse --verify -q refs/heads/main >/dev/null; then
  G update-ref refs/heads/main "$NEW" || { echo "✗ 建 refs/heads/main 失败（原因见上一行）" >&2; exit 2; }
  echo "本地 main 原本不存在 ⇒ 已建为 origin/main"
  echo "  after  = ${NEW:0:8}  $(G log -1 --format='%s' "$NEW")"
  exit 0
fi

OLD="$(G rev-parse refs/heads/main)"
echo "  before = ${OLD:0:8}  $(G log -1 --format='%s' "$OLD")"
echo "  origin = ${NEW:0:8}  $(G log -1 --format='%s' "$NEW")"

if [ "$OLD" = "$NEW" ]; then
  echo "✓ 本地 main 已与 origin/main 同一个提交，没动"
  exit 0
fi

# ── ③ 拒绝面一：本地 main 有未合入提交（非 origin/main 的祖先）──────────────────────
# 为什么用 is-ancestor 而不是 `rev-list --count`：分叉时两条计数都非 0，计数说不出方向；
#   is-ancestor 直接回答「旧 main 的提交是否都还在 origin/main 里」，那才是「会不会丢东西」。
G merge-base --is-ancestor "$OLD" "$NEW" >/dev/null 2>&1
anc=$?
if [ "$anc" != "0" ]; then
  if [ "$anc" != "1" ]; then
    echo "✗ 判不了祖先关系（merge-base 退出 ${anc}，原因见上一行）⇒ 本地 main 一行没动" >&2
    exit 2
  fi
  cat >&2 <<EOF
✗ 拒绝：本地 main 有 **未合入 origin/main** 的提交，覆盖它会把这些提交从 main 上摘掉
  本地 main  = ${OLD:0:8}
  origin/main = ${NEW:0:8}
  本地独有的提交（$(G rev-list --count "refs/remotes/origin/main..refs/heads/main") 个）：
$(G log --oneline "refs/remotes/origin/main..refs/heads/main" | head -10 | sed 's/^/    /')
  怎么处置（选一条，我不替你选）：
    · 这些提交该走 PR 合进 main：先建分支推上去开 PR，合完（GitHub 写 origin/main）再跑本脚本
        git --git-dir=$GCD branch <分支名> refs/heads/main
        再把那个分支推到远端 —— 用 git 的 push 子命令，**请你亲手跑**：本脚本不代跑它
    · 这些提交是误提交、应当丢弃：确认后手工对齐
        git --git-dir=$GCD update-ref refs/heads/main ${NEW}
    · 本地 main 落后太多想整体重置：同上（本脚本不做，因为它会丢提交，要人确认）
EOF
  exit 1
fi

# ── ④ 拒绝面二：main 正被某个工作树签出 ⇒ 改 ref 会让那棵树静默不一致 ──────────────
# 为什么不是硬警告就算：ref 一动，那棵树的 HEAD 指向的提交变了，而文件没变 ——
#   它看起来"有大量改动"，且下一次提交会把旧内容写成反向改动。这类事故比"没同步"贵得多。
BUSY="$(G worktree list --porcelain 2>/dev/null | awk -v p="refs/heads/main" '
  /^worktree /{wt=$2} /^branch /{if ($2==p) print wt}' || true)"
if [ -n "$BUSY" ]; then
  echo "✗ 拒绝：refs/heads/main 正被这些工作树签出 —— 改 ref 会让它们的文件与 HEAD 静默不一致：" >&2
  printf '    %s\n' $BUSY >&2
  echo "  处置：把那棵树切走（git -C <那棵树> checkout --detach 或切到别的分支），再跑本脚本。" >&2
  echo "  本地 main 一行没动（仍是 ${OLD:0:8}）。" >&2
  exit 1
fi

# ── ⑤ 同步（只改 ref，不碰工作区）───────────────────────────────────────────────────
if ! G update-ref refs/heads/main "$NEW" "$OLD"; then
  echo "✗ update-ref 失败（ref 在 fetch 与本行之间被别的进程改动？原因见上一行）⇒ 本地 main 一行没动" >&2
  exit 2
fi
echo "✓ 本地 main 已同步到 origin/main"
echo "  after  = ${NEW:0:8}  $(G log -1 --format='%s' "$NEW")"
echo "  前进 $(G rev-list --count "${OLD}..${NEW}") 个提交（未推、也不会推：main 只经 PR 合入）"
