#!/bin/bash
# ISS-416 守卫测试：ws.sh 的链接安全 —— 断言「不许把链接写进目标目录内部」「不许误伤别人的链接」
# 「不许踩别人在途验证」。
#
# 跑法：bash scripts/tests/ws-link-guard.test.sh   （无外部依赖，全程在 mktemp 沙箱里操作）
set -uo pipefail

WS_SRC="$(cd "$(dirname "$0")/.." && pwd)/ws.sh"
LIB="$(mktemp -t wslib)"
# 只取「函数与变量定义」部分（到 case 分发为止），避免 source 时执行子命令
awk '/^case "\$/ {exit} {print}' "$WS_SRC" > "$LIB"
# shellcheck disable=SC1090
source "$LIB"
set +e  # 被测函数故意返回非零

TMP="$(mktemp -d -t wsguard)"
pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass+1)); }
no() { echo "  ✗ $1"; fail=$((fail+1)); }

echo "── ISS-416 ws.sh 链接安全守卫 ──"

# ① link_symlink：dst 已是**真实目录** → 必须失败，且不得在目录内部留下任何东西
#    （旧实现 `rm -f ... || true` + `ln -s` 会把新链接写进这个目录内部——实测踩中过）
mkdir -p "$TMP/realdir"
if link_symlink "$TMP/src" "$TMP/realdir" >/dev/null 2>&1; then
  no "目录型 dst 竟被当作成功"
else
  ok "目录型 dst 被拒绝（不再写穿）"
fi
if [ -z "$(ls -A "$TMP/realdir")" ]; then ok "目标目录内部没有被写入"; else no "写穿了：$(ls -A "$TMP/realdir")"; fi

# ② link_symlink：正常路径建成 + readlink 校验
if link_symlink "$TMP/src" "$TMP/link1" >/dev/null 2>&1 && [ "$(readlink "$TMP/link1")" = "$TMP/src" ]; then
  ok "正常建链 + readlink 校验通过"
else
  no "正常建链失败"
fi

# ③ relink_back_from_path：只回收「指向该工作树」的链接，别人的链接一个都不许动
TMP_REPO="$TMP/repo"; TMP_PNM="$TMP/pnm"; TMP_WT="$TMP/wt"
mkdir -p "$TMP_REPO" "$TMP_PNM" "$TMP_WT/ISS-900/forge-aa" "$TMP_WT/ISS-901/forge-bb"
REPO="$TMP_REPO"; PROFILES_NM="$TMP_PNM"; WT_ROOT="$TMP_WT"
ln -s "$TMP_WT/ISS-900/forge-aa/" "$TMP_PNM/forge-aa"
ln -s "$TMP_WT/ISS-901/forge-bb/" "$TMP_PNM/forge-bb"
relink_back_from_path "$TMP_WT/ISS-900" >/dev/null 2>&1
if [ "$(readlink "$TMP_PNM/forge-aa")" = "$TMP_REPO/forge-aa/" ]; then
  ok "指向目标工作树的链接被精确回收"
else
  no "未回收：$(readlink "$TMP_PNM/forge-aa")"
fi
if [ "$(readlink "$TMP_PNM/forge-bb")" = "$TMP_WT/ISS-901/forge-bb/" ]; then
  ok "别人的链接原样未动（不误伤）"
else
  no "误伤了别人：$(readlink "$TMP_PNM/forge-bb")"
fi

# ④ 租约护栏判定：路径→单号解析 + 在途/过期租约
LOCK_FILE="$TMP/lock.json"
iss="$(worktree_iss_of_link "$TMP_WT/ISS-900/forge-aa")"
if [ "$iss" = "ISS-900" ]; then ok "从链接路径解析出单号（${iss}）"; else no "单号解析错：$iss"; fi
if [ "$(worktree_iss_of_link "$TMP_REPO/forge-aa/")" = "" ]; then ok "主 checkout 链接不被误判为工作树"; else no "主 checkout 被误判"; fi
printf '{"iss":"ISS-900","expire":"2999-01-01T00:00:00Z"}' > "$LOCK_FILE"
if lease_held_by ISS-900 && ! lease_held_by ISS-901; then
  ok "在途租约保护本人、不误伤他人"
else
  no "租约判定错（本人在途/他人在途）"
fi
printf '{"iss":"ISS-900","expire":"2000-01-01T00:00:00Z"}' > "$LOCK_FILE"
if ! lease_held_by ISS-900; then ok "过期租约不再保护（可被安全切回）"; else no "过期租约仍被判为在途"; fi

# ═ ISS-510：依赖镜像守卫 ══════════════════════════════════════════════════════
# 断言三件事：① workspace 链接必须被改指**本工作树**（否则"改了包也验不出来"= 假绿）；
#             ② 第三方条目仍指主 checkout（零拷贝共享）；③ 删目标位时**只删链接本身**。
echo "── ISS-510 依赖镜像守卫 ──"

# ⑤ is_ws_link：只认"指向仓库内同名包"的链接
T510="$TMP/iss510"; mkdir -p "$T510/src" "$T510/wt/forge-shell" "$REPO/forge-shell"
ln -sfn "$REPO/forge-shell" "$T510/src/forge-shell"
mkdir -p "$T510/src/leftpad-3p"
if is_ws_link "$T510/src/forge-shell" "forge-shell"; then ok "workspace 链接被识别"; else no "workspace 链接漏判（会导致改指失败=假绿）"; fi
if ! is_ws_link "$T510/src/leftpad-3p" "leftpad-3p"; then ok "第三方目录不被误判为 workspace 链接"; else no "第三方被误判"; fi

# ⑥ mirror_nm_dir：workspace → 工作树；第三方 → 主 checkout
mirror_nm_dir "$T510/src" "$T510/wt/node_modules" "$T510/wt" >/dev/null 2>&1
norm() { (cd "$1" 2>/dev/null && pwd -P); }
got="$(norm "$T510/wt/node_modules/forge-shell")"
if [ "$got" = "$(norm "$T510/wt/forge-shell")" ]; then ok "workspace 条目改指本工作树（假绿已修）"; else no "workspace 条目仍指别处：$got"; fi
got3="$(norm "$T510/wt/node_modules/leftpad-3p")"
if [ "$got3" = "$(norm "$T510/src/leftpad-3p")" ]; then ok "第三方条目仍指主 checkout（零拷贝共享）"; else no "第三方条目未被共享：$got3"; fi

# ⑦ fix_ws_links：把被写坏的链接拉回本工作树
#    （它按**该工作树的** package.json workspaces 迭代 —— 缺清单就等于没跑，所以这里要放一份）
printf '{"workspaces":["forge-shell"]}\n' > "$T510/wt/package.json"
ln -sfn "$REPO/forge-shell" "$T510/wt/node_modules/forge-shell"
fix_ws_links "$T510/wt" >/dev/null 2>&1
got2="$(norm "$T510/wt/node_modules/forge-shell")"
if [ "$got2" = "$(norm "$T510/wt/forge-shell")" ]; then ok "fix_ws_links 能把跨树链接拉回本工作树"; else no "fix_ws_links 未生效：$got2"; fi

# ⑧ reset_nm_dir：软链只删链接本身，绝不递归（递归会被沙箱批量删除守卫拦下，
#    失败被 `|| true` 吞掉后镜像会**写穿进主 checkout**）
mkdir -p "$T510/keepme"; ln -sfn "$T510/keepme" "$T510/wt/linkpos"
reset_nm_dir "$T510/wt/linkpos" >/dev/null 2>&1
if [ -d "$T510/keepme" ] && [ ! -L "$T510/wt/linkpos" ] && [ -d "$T510/wt/linkpos" ]; then
  ok "reset_nm_dir 只删链接、目标目录完好、就位为真目录"
else
  no "reset_nm_dir 行为不对（目标被删或仍是链接）"
fi

# ⑨ ws_names_of：按**目录**读 workspaces（用主 checkout 的清单会让工作树里的新包永远不被处理）
mkdir -p "$T510/probe"; printf '{"workspaces":["forge-aaa","forge-bbb"]}\n' > "$T510/probe/package.json"
if [ "$(ws_names_of "$T510/probe" | tr '\n' ',')" = "forge-aaa,forge-bbb," ]; then
  ok "ws_names_of 读的是指定目录的 workspaces"
else
  no "ws_names_of 未按目录读取"
fi

rm -rf "$TMP" "$LIB"
echo "── ${pass} passed, ${fail} failed ──"
[ "$fail" = "0" ] || exit 1
