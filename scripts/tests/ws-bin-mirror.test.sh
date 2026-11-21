#!/bin/bash
# ISS-504 守卫测试：工作树 `.bin` 不许是**整目录软链**（写穿通道），必须是真目录 + 逐条目软链
#
# ## 被测的伤害形态
#   老版 `mirror_nm_dir` 把主 checkout 的 `.bin` 镜像成一条软链：
#       .wt/ISS-X/node_modules/.bin -> $REPO/node_modules/.bin
#   于是工作树里 `bun add X` 写进去的条目**落在主 checkout 的 .bin 里**。bun 生成的是
#   相对解析的链接，于是主检出留下「目标只在工作树存在」的**悬空软链**：
#   不报错、不挡 merge，只在调用那一刻炸。实测受害：`.wt/ISS-714`、`.wt/ISS-503-vitest`。
#
# ## 断言的是什么（六件，都是机器可判）
#   ① A1 老形态会被迁成真目录（软链必须消失）
#   ② A2 迁完之后，工作树里的写**不落到主 checkout**（反向对照的正面）
#   ③ A3 第三方 bin 仍可解析（迁真目录不许把镜像语义弄坏）
#   ④ A4 / A4b `dangling_bin_list` 干净态报空、悬空态点得出（守卫那把尺——没有它，"判红"是空话）
#   ⑤ A5 幂等（重复跑不重写、不覆盖本树自带的 bin）
#
# ## 跑法与接线（ISS-504 · Lead 2026-11-07 裁定）
#   bash scripts/tests/ws-bin-mirror.test.sh          # 手动跑
#   bash scripts/tests/ws-bin-mirror.test.sh selftest # 门禁跑（guard-baselines.sh 的 selfcheck 档）
#   ⚠️ **参数 `selftest` 是被接受并忽略的**：`guard-baselines.sh` 的 selfcheck 约定传一个参数，
#     本脚本无参数差异（跑的是同一套断言），故显式吃掉它而不是让它变成位置参数里的脏东西。
#   接线位置：scripts/guard-baselines.sh 的 selfcheck 档（快档会跳过 —— 蓄意：
#     它是「守卫的守卫」，与 ws-lease-selftest / ws-base-guard-selftest 同一档）。
#   ⚠️ 曾落进「写了但永远不跑」的桶：`verify-test-wiring.mjs` 的射程只到 `scripts/*.test.mjs`，
#     7 个 `.test.sh` 它只报「射程外」不计入。本脚本现在由 guard-baselines 真跑，不在那个桶里。
set -uo pipefail
[ "${1:-}" = "selftest" ] && shift   # guard-baselines 的 selfcheck 约定；本脚本无参数差异

WS_SRC="$(cd "$(dirname "$0")/.." && pwd)/ws.sh"
# ⚠️ mktemp 不用 `-t <名字>`（ISS-899 CI 首跑返工）：那是 BSD 形态，GNU coreutils
#   （ubuntu runner）对「-t + 模板无 X」报 `too few X's in template` 直接失败 ⇒ LIB/TMP
#   全空 ⇒ source 空库（mirror_bin_dir 未定义 ⇒ A1 exit 127）+ R="/repo" 相对路径
#   （mkdir 被拒 ⇒ 沙箱全塌 ⇒ A2 主 checkout [] / A3 丢）。显式模板 + 结尾 X 两方言
#   都合法（GNU 要求 ≥3 个 X 且结尾；BSD 同支持）。
LIB="$(mktemp "${TMPDIR:-/tmp}/wsbinlib.XXXXXX")"
# 只取「函数与变量定义」部分（到**命令分发那一行**为止），避免 source 时执行子命令。
# ⚠️ 截断点必须锚定 `case "${1:-status}"` —— 文件里还有别的顶格 `case "$VAR" in`，
#   用 `/^case "\$/` 去锚会在那里就停，函数定义被截掉一半（邻文件真实踩过，见 ISS-694）。
# ⚠️ 锚定用 index()==1（纯字符串前缀比较），不用正则字面量：`\{` 在 BWK awk 当字面，
#   CI 的 mawk 对未知转义的行为无法本地验证——与其赌方言，不如消灭方言面（ISS-899）。
#   `== 1` 等价 `^` 行首锚，语义与原正则严格一致。
awk 'index($0, "case \"${1:-status}\" in") == 1 { exit } { print }' "$WS_SRC" > "$LIB"
# shellcheck disable=SC1090
source "$LIB"
set +e  # 被测函数故意返回非零

TMP="$(mktemp -d "${TMPDIR:-/tmp}/wsbin.XXXXXX")"
trap 'rm -rf "$TMP" "$LIB"' EXIT
pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
no() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "── ISS-504 ws.sh .bin 镜像：写穿通道已封 ──"

# ── 沙箱：主 checkout（有 .bin + 一个第三方 bin）+ 一棵老形态工作树 ──────────────
R="$TMP/repo"
mkdir -p "$R/node_modules/.bin" "$R/node_modules/react" "$R/pkg-a"
printf 'console.log(1)\n' > "$R/node_modules/react/cli.js"
ln -s ../react/cli.js "$R/node_modules/.bin/reactcli"
printf '{"workspaces":["pkg-a"]}\n' > "$R/package.json"
printf '{"name":"react"}\n' > "$R/node_modules/react/package.json"
WT="$R/.wt/ISS-926"
mkdir -p "$WT/node_modules" "$WT/node_modules/oxlint-local/bin"
printf '#!/bin/sh\n' > "$WT/node_modules/oxlint-local/bin/oxlint"
chmod +x "$WT/node_modules/oxlint-local/bin/oxlint"
# 老形态 = 修复前 `ws.sh new` 建出来的样子
ln -sfn "$R/node_modules/.bin" "$WT/node_modules/.bin"

REPO="$R"

# ── A1：老形态 → 迁成真目录 ────────────────────────────────────────────────────
mirror_bin_dir "$R/node_modules/.bin" "$WT/node_modules/.bin"
rc=$?
if [ "$rc" = "0" ] && [ -d "$WT/node_modules/.bin" ] && [ ! -L "$WT/node_modules/.bin" ]; then
  ok "A1 老式整目录软链被迁成真目录"
else
  no "A1 迁移失败（exit=${rc}，still_symlink=$([ -L "$WT/node_modules/.bin" ] && echo yes || echo no)）"
fi

# ── A2：工作树里的写不落到主 checkout（本单核心断言）────────────────────────────
before="$(ls "$R/node_modules/.bin" | sort | tr '\n' ' ')"
# 等价于「工作树里 bun add 了一个本树才有的 bin」
ln -sfn ../oxlint-local/bin/oxlint "$WT/node_modules/.bin/wt-only-tool"
after="$(ls "$R/node_modules/.bin" | sort | tr '\n' ' ')"
if [ "$before" = "$after" ] && [ -e "$WT/node_modules/.bin/wt-only-tool" ]; then
  ok "A2 工作树新增 bin 只落在本树，主 checkout 未变（[$after]）"
else
  no "A2 写穿仍存在：主 checkout 从 [$before] 变成 [$after]"
fi
# 顺带断言第三方 bin 仍可用（迁成真目录不能把解析弄坏）
if [ -e "$WT/node_modules/.bin/reactcli" ]; then
  ok "A3 第三方 bin 仍可解析（镜像语义未变）"
else
  no "A3 第三方 bin 丢了 —— 迁真目录把解析弄坏了"
fi

# ── A4：dangling_bin_list 能点出悬空软链（守卫那把尺）───────────────────────────
if [ -z "$(dangling_bin_list)" ]; then
  ok "A4 干净态下 dangling_bin_list 报空"
else
  no "A4 干净态下误报：$(dangling_bin_list | tr '\n' ' ')"
fi
# 人造一条：指向工作树才有的东西（= bun add 写穿后主检出剩下的残骸）
ln -sfn ../nonexistent-SHOULD-NOT-EXIST "$R/node_modules/.bin/deadtool"
if dangling_bin_list | grep -q 'deadtool'; then
  ok "A4b 悬空软链被点出（exit 判据由 doctor/guard 转成红）"
else
  no "A4b 悬空软链没被点出 —— 守卫无牙"
fi
rm -f "$R/node_modules/.bin/deadtool"

# ── A5：幂等（重复跑不重写、不报错）─────────────────────────────────────────────
mirror_bin_dir "$R/node_modules/.bin" "$WT/node_modules/.bin"; rc1=$?
mirror_bin_dir "$R/node_modules/.bin" "$WT/node_modules/.bin"; rc2=$?
if [ "$rc1" = "0" ] && [ "$rc2" = "0" ] && [ -e "$WT/node_modules/.bin/wt-only-tool" ]; then
  ok "A5 幂等：重复迁移 exit 0，且本树自带的 bin 不被覆盖"
else
  no "A5 非幂等或覆盖了本树自带的 bin（exit ${rc1}/${rc2}）"
fi

echo
if [ "$fail" = "0" ]; then
  echo "✓ 全部通过（$pass 例）"
  exit 0
fi
echo "✗ 失败 $fail 例 / 通过 $pass 例"
exit 1
