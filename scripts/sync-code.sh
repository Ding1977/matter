#!/bin/bash
# 双电脑代码同步脚本（Ding1977/dsh-forge）
# 用法: ./scripts/sync-code.sh pull   <- 开工前运行，拉取最新代码
#       ./scripts/sync-code.sh push   <- 干完活运行，推送**已有提交**
#
# ISS-400 修法：push **不再** `git add -A` + 自动提交。两个原因：
#   ① 本仓 commit-msg 钩子（scripts/git-hooks/commit-msg，core.hooksPath 指向它）要求提交
#      带 ISS 单号，脚本生成的 `sync: <日期>` 必被拒；旧版用 `|| true` 吞掉失败，
#      结果「✅ 已推送到 GitHub」是假的，还留下满索引暂存文件（25 个实测）。
#   ② `git add -A` 会把**别人在途的未跟踪文件**（其他会话的 specs/docs/临时探针）一起暂存，
#      下一次无关提交会顺手带走它们 → 交付归属不可追溯（ISS-282 审计结论同源）。
#   提交必须由开发者按单号显式完成（决策 13：自审后 merge）；本脚本只负责推**已提交**的历史。

ACTION="${1:-}"
case "$ACTION" in
  pull)
    git pull origin main
    echo ""
    echo "✅ 已拉取最新代码"
    ;;
  push)
    DIRTY="$(git status --porcelain)"
    if [ -n "$DIRTY" ]; then
      echo "⚠ 工作区有未提交改动（脚本不会替你提交，也不该提交）："
      printf '%s\n' "$DIRTY" | head -20
      echo ""
    fi
    if ! git push origin main; then
      echo ""
      echo "✗ 推送失败（看上面的 git 输出）"
      exit 1
    fi
    echo ""
    if [ -n "$DIRTY" ]; then
      echo "⚠ 已推送**已有提交**，但上面这些改动没被同步——请按单号提交后再跑一次 push"
      exit 1
    fi
    echo "✅ 已推送到 GitHub（工作区干净）"
    ;;
  *)
    echo "用法: ./scripts/sync-code.sh pull | push"
    echo "  pull  开工前运行（从 GitHub 拉取代码）"
    echo "  push  干完活运行（推送已有提交；不替你提交未提交改动）"
    exit 1
    ;;
esac
