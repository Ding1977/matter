#!/usr/bin/env bash
# ISS-734③ / ISS-584 自测：工作树 base 落后判据 + 产物补建判据
# 全部在临时目录里跑，不碰 ~/.dsh、不碰主 checkout。
#
# 为什么必须有（独立审查 B1 抓的 blocker）：
#   两条新守卫**运行时确实有牙**（注入落后树会红），但**没有任何回归保护** ——
#   变异实测：把整个新守卫块删掉，`ws-lease-selftest.sh` 仍 51/0 全绿。
#   本单完成判据②明写要 `--selftest` / fixture 覆盖，这份就是补它。
#   本仓纪律（docs/code.md K8b）：从没红过的守卫等于没有守卫。
#
# 隔离手法：把 ws.sh **复制**到临时目录，旁边放一个"永远绿"的假 guard-baselines.sh。
#   为什么复制而不是 source：ws.sh 底部是 `case "${1:-status}"` 分发，source 会**执行分发**。
#   复制之后 `$(dirname $0)/guard-baselines.sh` 自然指到临时那份，本自测只验**新判据**，
#   不被功能面基线的全量 typecheck 拖慢。
#
# 用法：bash scripts/ws-base-guard-selftest.sh
#       WS_SELFTEST_KEEP=1 bash scripts/ws-base-guard-selftest.sh   # 保留临时目录
set -uo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
WS_ORIG="$SRC_DIR/ws.sh"
PASS=0
FAIL=0

say() { printf '%s\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  ✓ %s\n' "$*"; }
no()  { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$*"; }

TMP="$(mktemp -d)"
cleanup() { [ "${WS_SELFTEST_KEEP:-}" = "1" ] || rm -rf "$TMP"; }
trap cleanup EXIT

ISO="$TMP/iso"
mkdir -p "$ISO"
cp "$WS_ORIG" "$ISO/ws.sh"
# ISS-800：体检入口从 `guard-baselines.sh`（bash）换成 `run-gates.mjs`（node，三态退出）。
# 替身因此要用 node 能跑的 .mjs，并吐出 ws.sh 会去 grep 的那一行小结（`✓ N 绿 / …`）。
cat > "$ISO/run-gates.mjs" <<'JS'
// （自测替身，恒绿）—— 形状对齐真 run-gates 的小结行，否则 ws.sh 的 grep 抓不到会印空。
console.log('✓ 3 绿 / ✗ 0 红 / - 0 跳过   （替身 · fast 档）')
process.exit(0)
JS
WS="$ISO/ws.sh"

REPO="$TMP/repo"; STATE="$TMP/state"
mkdir -p "$REPO" "$STATE"
git -C "$REPO" init -q -b main .
git -C "$REPO" config user.email self@test
git -C "$REPO" config user.name selftest
echo hi > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm "init"

# ⚠️ ISS-586 前置条件（缺它，场景 6/7 一件都跑不到 —— 本自检 2026-10-25 就是这样红的）：
#   `cmd_new` 现在依赖不齐就**当场 exit 1**（有意：依赖不齐的树不该再打「下一步/验证」）。
#   而"依赖齐"的第一条判据是「主 checkout 根 node_modules 存在」⇒ 这个假主库必须造出来。
#   不能是空目录：prepare_worktree_deps 的硬断言④要求工作树根 node_modules **非空**
#   （0 条目即红 —— 空目录正是"镜像没建成"的形态）。故放一个最小条目被镜像进去。
mkdir -p "$REPO/node_modules/.selftest-dep"
echo '{ "name": ".selftest-dep", "version": "0.0.0" }' > "$REPO/node_modules/.selftest-dep/package.json"

run_guard() {
  local cwd="$1"; shift
  ( cd "$cwd" && DSH_FORGE_REPO="$REPO" WS_STATE_DIR="$STATE" \
      bash "$WS" guard "$@" 2>&1 )
}

say "── 场景 1（正向）：落后 > 阈值 ⇒ guard 判红 ──"
git -C "$REPO" worktree add -q -b ISS-908 "$TMP/wt-stale" main >/dev/null 2>&1
( cd "$REPO" && for i in $(seq 1 60); do echo "$i" >> README.md; git add README.md; git commit -qm "c$i"; done )
out="$(run_guard "$TMP/wt-stale")"; rc=$?
if [ "$rc" = "2" ]; then ok "落后树判红（exit=2，真退出码非管道）"
else no "期望 exit=2，实得 exit=$rc"; say "$out"; fi
case "$out" in *"落后 main 60 个提交（> 50）"*) ok "读数精确（60 / 阈值 50）" ;; *) no "读数不对"; say "$out";; esac
case "$out" in *"rebase main"*) ok "给了可执行的处置" ;; *) no "没给处置";; esac

say "── 场景 2（反向）：同步回 main ⇒ 复绿 ──"
( cd "$TMP/wt-stale" && git merge -q --ff-only main >/dev/null 2>&1 )
out="$(run_guard "$TMP/wt-stale")"; rc=$?
if [ "$rc" = "0" ]; then ok "同步后复绿（exit=0）—— 证明判据不是恒红"
else no "期望 exit=0，实得 exit=$rc"; say "$out"; fi

say "── 场景 3（边界）：恰好 = 阈值不判红，「>」而非「>=」──"
git -C "$REPO" worktree add -q --detach "$TMP/wt-edge" "$(git -C "$REPO" rev-parse main~50)" >/dev/null 2>&1
out="$(run_guard "$TMP/wt-edge")"; rc=$?
if [ "$rc" = "0" ]; then ok "恰好 50 ⇒ 不判红"
else no "期望 exit=0，实得 exit=$rc"; say "$out"; fi
git -C "$REPO" worktree remove --force "$TMP/wt-edge" >/dev/null 2>&1
git -C "$REPO" worktree add -q --detach "$TMP/wt-edge" "$(git -C "$REPO" rev-parse main~51)" >/dev/null 2>&1
out="$(run_guard "$TMP/wt-edge")"; rc=$?
if [ "$rc" = "2" ]; then ok "51 ⇒ 判红（边界精确）"
else no "期望 exit=2，实得 exit=$rc"; say "$out"; fi
git -C "$REPO" worktree remove --force "$TMP/wt-edge" >/dev/null 2>&1

say "── 场景 4（fail-closed）：阈值非数字 ⇒ 判红，不许静默报绿 ──"
git -C "$REPO" worktree add -q -b ISS-909 "$TMP/wt-fresh" main >/dev/null 2>&1
out="$( cd "$TMP/wt-fresh" && DSH_FORGE_REPO="$REPO" WS_STATE_DIR="$STATE" \
        WS_BASE_BEHIND_LIMIT=abc bash "$WS" guard 2>&1 )"; rc=$?
if [ "$rc" = "2" ]; then ok "非法阈值判红（exit=2）—— fail-closed 生效"
else no "期望 exit=2，实得 exit=$rc —— 这正是 B3 的静默失效"; say "$out"; fi
case "$out" in *"不是正整数"*) ok "点明了阈值非法" ;; *) no "没点明阈值非法";; esac
out="$(run_guard "$TMP/wt-fresh")"; rc=$?
if [ "$rc" = "0" ]; then ok "同树 + 合法阈值 ⇒ 绿（红确实只因阈值非法）"
else no "期望 exit=0，实得 exit=$rc"; say "$out"; fi
# M3：纯数字但超 shell 整数范围 ⇒ 也必须 fail-closed（第一版只挡"含非数字"，这条会漏）
out="$( cd "$TMP/wt-fresh" && DSH_FORGE_REPO="$REPO" WS_STATE_DIR="$STATE" \
        WS_BASE_BEHIND_LIMIT=99999999999999999999 bash "$WS" guard 2>&1 )"; rc=$?
if [ "$rc" = "2" ]; then ok "超长阈值（20 位）判红 —— 整数溢出不再静默失效"
else no "期望 exit=2，实得 exit=$rc —— 这是 M3 的静默失效"; say "$out"; fi

say "── 场景 5（缓存树排除）：.gate-base 不参与体检 ──"
git -C "$REPO" worktree add -q --detach "$TMP/.gate-base" "$(git -C "$REPO" rev-parse main~60)" >/dev/null 2>&1
out="$(run_guard "$TMP/wt-fresh")"; rc=$?
if [ "$rc" = "0" ]; then ok "缓存树被排除（exit=0）—— 不会每天误报"
else no "期望 exit=0（缓存树不该算），实得 exit=$rc"; say "$out"; fi

say "── 场景 5b（缓存树身份 · 任意名）：GATE_BASE_CACHE 指到别处也不误报 ──"
# 第二遍独立审查 M2：只看 basename 会漏"任意名缓存树"。这里**故意**造一棵非 .gate-base 名的树，
# 但让它的 git admin 条目名是 -gate-base（那才是缓存树的可靠特征）。
# 做法：复用真实 gate-base 的 admin 条目不便，改为直接验「普通 detached 树**不该**被排除」——
# 那是我第一版修法的反面（detached+tip==merge-base 会误排一切 detached 树）。
git -C "$REPO" worktree add -q --detach "$TMP/wt-plain-detached" "$(git -C "$REPO" rev-parse main~60)" >/dev/null 2>&1
out="$(run_guard "$TMP/wt-fresh")"; rc=$?
if [ "$rc" = "2" ]; then ok "普通 detached 落后树**仍被判红**（没被 M2 的排除误伤）"
else no "期望 exit=2（detached 落后树该红），实得 exit=$rc —— M2 排除写宽了"; say "$out"; fi
git -C "$REPO" worktree remove --force "$TMP/wt-plain-detached" >/dev/null 2>&1

say "── 场景 6（产物补建）：声明了 build:* 才补，无脚本不造假 ──"
# ⚠️ 本场景第一版写错了：假包必须**进 workspaces**，否则 ws_names_of 扫不到它
#    （ws_names_of 读工作树 package.json 的 workspaces 数组）。那不是代码缺陷，是我测试没搭对现场。
FAKE="$TMP/ISS-910"
git -C "$REPO" worktree add -q -b ISS-910 "$FAKE" main >/dev/null 2>&1
mkdir -p "$FAKE/forge-fake" "$FAKE/forge-nobuild"
cat > "$FAKE/package.json" <<'JSON'
{ "name": "tmp-root", "private": true, "workspaces": ["forge-fake", "forge-nobuild"] }
JSON
cat > "$FAKE/forge-fake/package.json" <<'JSON'
{ "name": "forge-fake",
  "scripts": { "build:client": "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/client.js','x')\"" } }
JSON
cat > "$FAKE/forge-nobuild/package.json" <<'JSON'
{ "name": "forge-nobuild", "scripts": {} }
JSON
# ⚠️ 本场景依赖本机装有 bun（补建要真跑构建）。无 bun 环境**跳过并说明**，
#    不假红（第二遍独立审查指出：直接接入 CI 会在无 bun 机上必红）。
if ! { [ -x "$HOME/.bun/bin/bun" ] || command -v bun >/dev/null 2>&1; }; then
  say "  ⚠️ 跳过场景 6 的补建断言：本机找不到 bun（需 bun 才能真跑构建）"
else
# PATH 刻意**不含** ~/.bun/bin，复现"宿主 PATH 找不到 bun ⇒ 需自解析"
# ⚠️ 必须传 DSH_FORGE_WT_ROOT：ws.sh 的 path = $WT_ROOT/<单号>，
#   不传就跑去默认的 ~/wt/... 建新树（撞沙箱权限，且补建的不是我们造的那棵）。
( cd "$TMP" && DSH_FORGE_REPO="$REPO" DSH_FORGE_WT_ROOT="$TMP" WS_STATE_DIR="$STATE" \
    PATH="/usr/bin:/bin:/opt/homebrew/bin" bash "$WS" new ISS-910 --reuse >/dev/null 2>&1 ) || true
if [ -f "$FAKE/forge-fake/dist/client.js" ]; then ok "声明 build:client 的包被补建（PATH 无 bun 时自解析成功）"
else no "声明 build:client 的包没被补建（PATH 无 bun 时应自解析到 ~/.bun/bin）"; fi
if [ ! -e "$FAKE/forge-nobuild/dist" ]; then ok "无 build 脚本的包未被造假产物"
else no "给无 build 脚本的包造了产物（不该）"; fi
if [ -f "$FAKE/forge-fake/dist/client.js" ]; then
  m1="$(stat -f %m "$FAKE/forge-fake/dist/client.js" 2>/dev/null || stat -c %Y "$FAKE/forge-fake/dist/client.js")"
  ( cd "$TMP" && DSH_FORGE_REPO="$REPO" DSH_FORGE_WT_ROOT="$TMP" WS_STATE_DIR="$STATE" \
      PATH="/usr/bin:/bin:/opt/homebrew/bin" bash "$WS" new ISS-910 --reuse >/dev/null 2>&1 ) || true
  m2="$(stat -f %m "$FAKE/forge-fake/dist/client.js" 2>/dev/null || stat -c %Y "$FAKE/forge-fake/dist/client.js")"
  if [ "$m1" = "$m2" ]; then ok "幂等：产物已存在时不重建（mtime 未变）"
  else no "不幂等：重复跑重建了产物（mtime ${m1} → ${m2}）"; fi
fi
git -C "$REPO" worktree remove --force "$FAKE" >/dev/null 2>&1
git -C "$REPO" branch -D ISS-910 >/dev/null 2>&1
fi   # ← 无 bun 跳过块的收尾

say "── 场景 7（逃生口）：--skip-build 跳过补建且出声 ──"
FAKE2="$TMP/ISS-911"
git -C "$REPO" worktree add -q -b ISS-911 "$FAKE2" main >/dev/null 2>&1
mkdir -p "$FAKE2/forge-fake"
cat > "$FAKE2/package.json" <<'JSON'
{ "name": "tmp-root", "private": true, "workspaces": ["forge-fake"] }
JSON
cat > "$FAKE2/forge-fake/package.json" <<'JSON'
{ "name": "forge-fake",
  "scripts": { "build:client": "node -e \"require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/client.js','x')\"" } }
JSON
out="$( cd "$TMP" && DSH_FORGE_REPO="$REPO" DSH_FORGE_WT_ROOT="$TMP" WS_STATE_DIR="$STATE" \
        bash "$WS" new ISS-911 --reuse --skip-build 2>&1 )" || true
if [ ! -e "$FAKE2/forge-fake/dist" ]; then ok "--skip-build 逃生口生效（未建产物）"
else no "--skip-build 没生效，仍建了产物"; fi
case "$out" in *"skip-build"*) ok "--skip-build 出声告知后果" ;; *) no "--skip-build 没出声"; say "$out";; esac

say "── 场景 8（ISS-586 红线）：依赖不齐 ⇒ cmd_new exit 1 且不打「下一步 / 验证」──"
# 为什么要补这条：ISS-586 的核心行为就是「红就停在这里」，但原来**没有任何断言看着它** ——
#   本自检自己就因为这条红过（fixture 缺根 node_modules ⇒ 后面两个场景一件都跑不到），
#   而症状看起来像"产物补建坏了"，说明缺守卫的代价是归因错误。
# 做法：另起一个**同源的假主库**，但它没有根 node_modules —— 除了"依赖不齐"这一格，别的前置全齐。
REPO_NONM="$TMP/repo-nonm"
mkdir -p "$REPO_NONM"
git -C "$REPO_NONM" init -q -b main .
git -C "$REPO_NONM" config user.email self@test
git -C "$REPO_NONM" config user.name selftest
echo hi > "$REPO_NONM/README.md"
git -C "$REPO_NONM" add README.md
git -C "$REPO_NONM" commit -qm "init"
out="$( cd "$TMP" && DSH_FORGE_REPO="$REPO_NONM" DSH_FORGE_WT_ROOT="$TMP/nonm-wt" WS_STATE_DIR="$STATE" \
        bash "$WS" new ISS-912 --skip-build 2>&1 )"; rc=$?
if [ "$rc" = "1" ]; then ok "依赖不齐 ⇒ cmd_new exit 1（不是静默成功）"
else no "期望 exit=1，实得 exit=$rc —— ISS-586 的红被放宽了"; say "$out"; fi
# 只判退出码不够：exit 1 之前已经把「下一步 / 验证」打出来的话，读者照样会照着往下跑。
case "$out" in
  *"下一步："*|*"验证改动"*) no "依赖不齐却仍打了「下一步 / 验证」"; say "$out" ;;
  *) ok "依赖不齐 ⇒ 停在这里，不打「下一步 / 验证」" ;;
esac

say ""
say "───────────────────────────────"
say "通过 $PASS 项 · 失败 $FAIL 项"
[ "$FAIL" = "0" ] || exit 1
