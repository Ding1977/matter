#!/usr/bin/env bash
# gate-for.sh —— 按**改动的包**跑门禁（ISS-614）
#
# ## 为什么要有它
# `docs/project-ops-rules.md` §3 的开发命令只教一种写法：`cd forge-pm && bun run test && bun run typecheck`。
# 于是改动落在别的包（forge-agents / forge-model / forge-ui …）时，人照抄那段命令 ⇒ 跑的是 forge-pm 的门禁，
# **改动那个包一行没验，却拿到一个绿**。这不是「忘了跑」，是**跑了一个量错对象的尺子** —— 假绿里最隐蔽的一种。
#
# ## 用法
#   bash scripts/gate-for.sh                 # 从工作区改动自动推断涉及的包
#   bash scripts/gate-for.sh forge-agents    # 显式指定（可多个）
#   bash scripts/gate-for.sh --all           # 全部 workspace 包（慢，用于大改动）
#   bash scripts/gate-for.sh --allow-empty   # 显式放行「该包零门禁脚本」（见下）
#
# 每个包按 `package.json` 里**确实声明了的**脚本跑：test / typecheck（缺哪个跳哪个，并明说跳过）。
#
# ## 零脚本 ⇒ 红（ISS-614 审查抓出的第二种假绿）
# `forge-role` / `forge-widgets` 有 lib 代码，但 build:host / build:client / test / typecheck **四者全缺**。
# 旧版于是打「跑了 0 个脚本项」+「✓ 全绿」并 **exit 0** —— 尺子从「量错对象」退化成「没刻度」，
# 是同一类假绿里更难发现的一种（量错至少还有个读数，没刻度连读数都没有）。
# 现在：某包一个脚本都没跑 ⇒ 报出来并计入失败（exit 1）。确属「这包本来就没有可跑门禁」时，
# 显式传 `--allow-empty` 放行（会打印提醒，不静默 —— 静默放行等于把假绿藏起来）。
#
# 退出码：0 = 全绿；1 = 有包红 / 有包零门禁脚本；2 = 推断不出包（改动不在任何包内）
#
# ## ⚠️ 退出码本身是对的，但**管道会把它吃掉**（2026-11-04 实测）
#
# 同一天有两人在这个脚本上得出过错误结论，两次都不是脚本的问题：
#   ① 有人跑 `bash scripts/gate-for.sh forge-trader | tail -3; echo $?` → 拿到 0
#      那是 **tail 的**退出码。真红时直接跑本脚本会**正确返回 1** —— 已用
#      「故意让 test 退出 1」实测确认：直跑 exit 1、`| tail` 后 exit 0。
#   ② 有人跑 `npx tsc ...; echo $?` → 1，那是 npx 自己的依赖解析失败
#      （`npm error EOVERRIDE`），不是 tsc 说类型有错。
#
# ⇒ 判红绿**取真退出码**，别接管道：
#     bash scripts/gate-for.sh forge-trader >/tmp/gate.log 2>&1; echo "退出码: $?"
#     grep -q '✗' /tmp/gate.log && echo "有红"
# ⇒ 同理 `cmd | head` 也吃退出码（且 head 提前关闭管道会让 cmd 收到 SIGPIPE）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null || { echo "✗ 找不到 bun（PATH 里没有 ~/.bun/bin）"; exit 1; }

# ── 1. 确定要跑哪些包 ──────────────────────────────────────────────
# 先把 `--allow-empty` 摘出来（它不是包名）：混进包名只会多打一行「跳过 --allow-empty（没有 package.json）」，
# 而放行开关**静默不生效** —— 那正是本单要治的那种"看着跑了、其实没跑"。
ALLOW_EMPTY=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--allow-empty" ]; then ALLOW_EMPTY=1; else ARGS+=("$a"); fi
done

if [ "${ARGS[0]:-}" = "--all" ]; then
  PKGS=$(node -e "const p=require('./package.json');console.log((p.workspaces||[]).join(' '))")
else
  if [ "${#ARGS[@]}" -gt 0 ]; then
    PKGS="${ARGS[*]}"
  else
    # 改动文件 → 顶层目录 → 只留含 package.json 的
    # K9c（ISS-622）：不静默 —— git 失败时让它把原因打到 stderr，别用 2>/dev/null 吞掉。
    #   `set -u` 已开、`set -e` 未开 ⇒ 失败时 stdout 为空，脚本自然走「推断不出包」那条路并给显式用法。
    CHANGED="$( { git status --porcelain | awk '{print $NF}'; git diff --name-only HEAD; } | sort -u )"
    PKGS=""
    for f in $CHANGED; do
      top="${f%%/*}"
      [ -f "$top/package.json" ] && PKGS="$PKGS $top"
    done
    PKGS="$(echo $PKGS | tr ' ' '\n' | sort -u | tr '\n' ' ')"
  fi
fi

if [ -z "${PKGS// /}" ]; then
  echo "✗ 推断不出改动涉及的包（工作区干净？或改动全在 scripts/ docs/ 这类非包目录）"
  echo "  显式指定：bash scripts/gate-for.sh <pkg> [pkg...]   或   --all"
  exit 2
fi

echo "── gate-for：按包跑门禁（ISS-614）──"
echo "   目标包：$PKGS"
echo

# ── 2. 逐包跑它**确实声明了的**脚本 ────────────────────────────────
FAILED=""
EMPTY=""
RAN=0
for pkg in $PKGS; do
  [ -f "$pkg/package.json" ] || { echo "! 跳过 ${pkg}（没有 package.json）"; continue; }
  # K9c（ISS-622）：只吞 stdout，**不吞 stderr** —— package.json 读不动时要看得见原因。
  has() { node -e "const s=require('./$pkg/package.json').scripts||{};process.exit(s['$1']?0:1)" >/dev/null; }

  echo "── $pkg ──"
  PKG_RAN=0
  # build 必须先于 test（ops-rules §3：forge-pm 有读 dist 产物的守卫，先 test 会读到旧产物 ⇒ 静默绿）
  for script in build:host build:client test typecheck; do
    if has "$script"; then
      printf '  %-14s ' "$script"
      if (cd "$pkg" && bun run "$script" >/tmp/gate-for-$pkg.log 2>&1); then
        echo "✓"
      else
        echo "✗（详见 /tmp/gate-for-$pkg.log）"
        tail -6 /tmp/gate-for-$pkg.log | sed 's/^/      /'
        FAILED="$FAILED $pkg:$script"
      fi
      RAN=$((RAN+1)); PKG_RAN=$((PKG_RAN+1))
    else
      printf '  %-14s -（该包没声明，跳过）\n' "$script"
    fi
  done
  # 零脚本 = 没刻度。四者全缺时**必须**出声，且默认不是绿（ISS-614 审查实测：
  # `gate-for.sh forge-role` 旧版 → 「跑了 0 个脚本项」+「✓ 全绿」+ exit 0）。
  if [ "$PKG_RAN" -eq 0 ]; then
    if [ "$ALLOW_EMPTY" = "1" ]; then
      echo "  ⚠️ $pkg 没有任何可跑的门禁脚本（build:host / build:client / test / typecheck 全缺）"
      echo "     --allow-empty 已显式放行：**这一包本次是没刻度的绿**，别把它算成「验过了」"
      EMPTY="$EMPTY $pkg"
    else
      echo "  ✗ $pkg 没有任何可跑的门禁脚本（build:host / build:client / test / typecheck 全缺）"
      echo "     ⇒ 「没跑」不是「跑绿」：给它补 test/typecheck 脚本，或确属纯声明包时显式传 --allow-empty"
      EMPTY="$EMPTY $pkg"
      FAILED="$FAILED $pkg:no-gate-script"
    fi
  fi
  echo
done

echo "── 汇总 ──"
echo "   跑了 $RAN 个脚本项"
if [ -n "$EMPTY" ]; then
  echo "   零门禁脚本的包：$EMPTY"
fi
if [ -n "$FAILED" ]; then
  echo "✗ 有红：$FAILED"
  exit 1
fi
echo "✓ 全绿（注意：这是**这些包**的绿，不是全仓的绿）"
