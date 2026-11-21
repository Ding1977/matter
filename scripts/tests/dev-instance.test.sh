#!/bin/bash
# ISS-675 回归网：dev-instance.sh 的「启动失败必须出声」与「env 真能传进去」。
#
# 为什么需要（两个都是实测踩到的 shell 细节坑，且都**静默**）：
#   ① 赋值前缀 bug：`${VAR:+"$VAR"}` 展开出来的 `KEY=VAL` 不被 bash 当赋值，而被当**命令名**
#      ⇒ 报 `KEY=VAL: No such file or directory`，nohup 从未启动；而就绪判定又因为
#   ② `code="$(curl … -w '%{http_code}' || echo 000)"` 拿到 `000000`（curl 的 -w 无换行输出
#      被 echo 接上）≠ `"000"` ⇒ **什么都没监听也报「已就绪」（假绿，退出码 0）**。
#
# 跑法：bash scripts/tests/dev-instance.test.sh
# 全程在 mktemp 沙箱里：临时 DSH_HOME_PROD / DSH_HOME_VERIFY / 工作树根 / 高位端口，
# 不碰真实 ~/.dsh-verify、不占 3211、不起真引擎（用假 NODE_BIN）。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO/scripts/dev-instance.sh"

SANDBOX="$(mktemp -d -t devinst)"
PROD="$SANDBOX/prod"; VERIFY="$SANDBOX/verify"; WT="$SANDBOX/wt"; PORT=3299
mkdir -p "$PROD/profiles/node_modules" "$PROD/pm" "$WT/ISS-TEST"
trap 'rm -rf "$SANDBOX"' EXIT

pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
no() { echo "  ✗ $1"; fail=$((fail + 1)); }

# 与脚本同款的沙箱环境
# ⚠️ 用 `export` 而不是「赋值前缀 + 展开」：`${VAR:+KEY=VAL} bash …` 里那个前缀来自展开，
#    bash **不认它是赋值**、会当成命令名执行 —— 这正是被测脚本踩过的坑（ISS-675），
#    测试自己不能再踩一遍（本文件初版就踩了，三个用例因此假失败）。
run() { # run <node-bin> [WITH_AGENTS_ROOT]
  local nodebin="$1" with="${2:-}"
  export DSH_HOME_PROD="$PROD" DSH_HOME_VERIFY="$VERIFY" DSH_VERIFY_PORT="$PORT"
  export DSH_FORGE_REPO="$REPO" DSH_FORGE_WT_ROOT="$WT" NODE_BIN="$nodebin"
  # 清掉环境里可能已有的 FORGE_AGENTS_ROOT：agent 会话里引擎会导出它，
  # 不清的话「默认不给」这条断言永远失败（分不清是脚本设的还是环境带进来的）。
  unset FORGE_AGENTS_ROOT
  if [ -n "$with" ]; then export WITH_AGENTS_ROOT="$with"; else unset WITH_AGENTS_ROOT; fi
  bash "$SCRIPT" start ISS-TEST 2>&1
}

echo "── ISS-675 dev-instance.sh 启动正确性 ──"

# ① 启动失败（NODE_BIN 不存在）→ 必须非零退出、必须出声，且**绝不能说「已就绪」**
out="$(run /nonexistent/node)"
rc=$?
if [ "$rc" -ne 0 ]; then ok "启动失败时退出码非 0（rc=$rc）"; else no "启动失败却返回 0（假绿）"; fi
if printf '%s' "$out" | grep -q "已就绪"; then no "启动失败仍打印「已就绪」（假绿）"; else ok "启动失败不打印「已就绪」"; fi
if printf '%s' "$out" | grep -q "启动失败"; then ok "启动失败有明确报错"; else no "启动失败无明确报错"; fi
if printf '%s' "$out" | grep -q "No such file"; then ok "报错附日志尾巴（含真实原因）"; else no "报错没带日志尾巴"; fi

# ② env 真能传进去：假 node 把 FORGE_* 打出来就退（不需要真引擎）
FAKE="$SANDBOX/fakenode"
printf '#!/bin/bash\nenv | grep -E "^FORGE_" | sort\n' > "$FAKE"; chmod +x "$FAKE"

run "$FAKE" 1 >/dev/null 2>&1
if grep -q "^FORGE_AGENTS_ROOT=$VERIFY/agent-runs$" "$VERIFY/dev-instance.log" 2>/dev/null; then
  ok "WITH_AGENTS_ROOT=1 时 FORGE_AGENTS_ROOT 真到了子进程"
else
  no "FORGE_AGENTS_ROOT 没传进去（赋值前缀 bug 回归）"
fi
if grep -q "^FORGE_PM_ROOT=$VERIFY/pm$" "$VERIFY/dev-instance.log" 2>/dev/null; then
  ok "FORGE_PM_ROOT 也在（基本 env 未被打断）"
else
  no "FORGE_PM_ROOT 缺失"
fi

rm -f "$VERIFY/dev-instance.log"
run "$FAKE" >/dev/null 2>&1
if grep -q "^FORGE_AGENTS_ROOT=" "$VERIFY/dev-instance.log" 2>/dev/null; then
  no "未开 WITH_AGENTS_ROOT 却设了 FORGE_AGENTS_ROOT（默认不该给）"
else
  ok "默认不给 FORGE_AGENTS_ROOT（ISS-570 P2a 口径）"
fi

# ③ 源码级牙：就绪判定里的 `||` 必须在命令替换**外面**（否则 code 会拼成 000000）
if grep -qE 'code="\$\(curl[^)]*\)" \|\| code=000' "$SCRIPT"; then
  ok "就绪判定用安全形态（\`|| code=000\` 在命令替换外）"
else
  no "就绪判定的 curl 取值形态不对（假绿风险）"
fi

echo "── 结果：$pass 通过 / $fail 失败 ──"
[ "$fail" -eq 0 ] || exit 1
