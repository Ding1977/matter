#!/bin/bash
# ISS-872 单门 allocate 的守卫测试：建树的唯一入口**会登记**、**并发只成一棵**、**失败会回滚**
#
# ## 被测的三条硬要求（汽油单正文的三条，缺一条就等于没做）
#   ① **并发安全**：两个进程同时 allocate 同一单，绝不能两棵都建成。
#      ⚠️ 二次单线程跑**不等于**并发安全 —— 本脚本起真后台进程并发跑，不是串行跑两次。
#   ② **CAS 失败回滚占位**：mkdir 占位了但后续失败，不许留空目录。
#      留空目录的后果不是报错，而是**这单从此建不出树**（下次 mkdir 判 EEXIST ⇒「有人抢先」）。
#   ③ **同号二次被拒**：已有活登记行 ⇒ 非 0 退出 + 打印归属，不再建第二棵。
#
# ## 反例（**逐条真跑过变异**，不是照抄推理）
#   A4 去掉 mkdir 占位  ⇒ 红（"成功 1 个 / 树 0 棵 / 登记行 2 条"）
#   A5 去掉 rm -rf 回滚 ⇒ 红（"目录仍在=yes"）
#   A4c 去掉 flock     ⇒ 红（"落盘 1 行（期望 2）"）
#
#   ⚠️ **一条反直觉的实测**：去掉 flock 时 **A4 仍然是绿的**。
#      原因：A4 测的是"不许两棵都建成"，而这条由 **mkdir 占位**独立守住，与登记表的锁无关。
#      登记表自己的失守形态是**丢行**（后 rename 覆盖前 rename 的整份内容），不加锁时
#      "两个进程都报 OK、盘上只剩一行" —— 这个形态只有 A4c 抓得到。
#      ⇒ 两者测的是**不同机制**，缺一不可：A4 守"树不许两棵"，A4c 守"登记表不许丢行"。
#
# ## 跑法与接线
#   bash scripts/tests/ws-allocate.test.sh          # 手动跑
#   bash scripts/tests/ws-allocate.test.sh selftest # 门禁跑（传参被接受并忽略，与 ws-bin-mirror 同约定）
#
# ⚠️ 沙箱是**真 git 仓**（allocate 的动作就是 git worktree add），但完全在 mktemp -d 里，
#   不碰真仓、不碰真树的注册表 —— 这也是为什么断言全在临时仓里自证，不去读 $HOME。
set -uo pipefail
[ "${1:-}" = "selftest" ] && shift

WS_SRC="$(cd "$(dirname "$0")/.." && pwd)/ws.sh"
LIB="$(mktemp -t wsalloclib)"
# 只取「函数与变量定义」部分（到命令分发那一行为止），避免 source 时执行子命令。
# ⚠️ 截断点必须锚定 `case "${1:-status}"` —— 文件里还有别的顶格 `case "$VAR" in`，
#   用 `/^case "\$/` 去锚会在那里就停，函数定义被截掉一半（ISS-694 邻文件真实踩过）。
awk '/^case "\$\{1:-status\}" in$/ {exit} {print}' "$WS_SRC" > "$LIB"
# shellcheck disable=SC1090
source "$LIB"
set +e  # 被测函数故意返回非零

TMP="$(mktemp -d -t wsalloc)"
trap 'rm -rf "$TMP" "$LIB"' EXIT
pass=0; fail=0
ok() { echo "  ✓ $1"; pass=$((pass + 1)); }
no() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "── ISS-872 ws.sh allocate：登记 / 并发 / 回滚 ──"

# ── 沙箱：真 git 仓 + 一棵"会话树"（它自己是主检出的工作树）= 二级形态 ────────────
g() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }
ROOT="$TMP/root"; mkdir -p "$ROOT/repo"
g "$ROOT/repo" init -q -b main
printf 'x\n' > "$ROOT/repo/a.txt"; mkdir -p "$ROOT/repo/sub"; printf 's\n' > "$ROOT/repo/sub/s.txt"
g "$ROOT/repo" add -A; g "$ROOT/repo" commit -qm base
SESS="$ROOT/sess"
g "$ROOT/repo" worktree add -q --detach "$SESS" HEAD
mkdir -p "$SESS/.agents/worktrees" && printf '*\n' > "$SESS/.agents/worktrees/.gitignore"
printf '{}\n' > "$SESS/.agents/trees.json"

# 被测命令的统一入口。
# ⚠️ 必须用 **DSH_FORGE_REPO / DSH_FORGE_WT_ROOT**，不是 REPO / WT_ROOT ——
#   ws.sh 开头就 `REPO="${DSH_FORGE_REPO:-…}"` 重新赋值，传 REPO= 会被**静默丢弃**，
#   命令会照着默认落点跑到**真仓**去（本脚本第一版就这么错过一次：在 <repo>
#   下建出 5 棵 ISS-900x 的树与分支，靠事后 worktree list 才发现）。
#   故下面的 run() 除了传变量，**还在调用前断言沙箱生效**（见 assert_sandbox）。
export DSH_FORGE_REPO="$SESS"
export DSH_FORGE_WT_ROOT="$ROOT/wtroot"
export WS_ALLOC_NO_MATTER=1
export WS_STATE_DIR="$TMP/state"
run() { bash "$WS_SRC" "$@" 2>&1; }
# 自锁：任何一次 run 之后，真仓的 worktree list 里都不许出现本测试的单号。
# 它防的正是"变量名写错 ⇒ 悄悄跑在真仓"这类**不会报错**的失败。
assert_sandbox() {
  if git -C <repo> worktree list 2>/dev/null | grep -qE "ISS-90[0-9][0-9]"; then
    echo "  ✗✗ 沙箱失守：单号出现在真仓的 worktree list 里 —— 立即停手，别继续跑"
    echo "      清理：git -C <repo> worktree remove --force <path> && git -C … branch -D <号>"
    exit 2
  fi
}

# ══ A1：会话树下建树（基线行为）══════════════════════════════════════════════════
out="$(run allocate ISS-918)"; rc=$?
assert_sandbox
tree="$SESS/.agents/worktrees/ISS-918"
if [ "$rc" = "0" ] && [ -d "$tree" ] && [ "$(git -C "$tree" branch --show-current)" = "ISS-918" ]; then
  ok "A1 EXIT=0 · 树在会话树的池里 · 分支 ISS-918"
else
  no "A1 建树失败（exit=${rc}）：$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
fi
# 树里必须有内容（空树 = 建了但没用，且后续所有命令都会"成功"地跑在空目录上）
n=$(ls -A "$tree" 2>/dev/null | grep -vc '^\.git$')
[ "${n:-0}" -ge 1 ] && ok "A1b 新树非空（${n} 个顶层条目）" || no "A1b 建出一棵空树"

# ══ A2：登记表真写（且只写四个字段）════════════════════════════════════════════
python3 - "$SESS/.agents/trees.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
row = d.get("ISS-918") or {}
keys = sorted(k for k in row)
expected = ["branch", "kind", "parent", "path"]
sys.exit(0 if keys == expected and row.get("kind") == "issue" and row.get("parent") else 1)
PY
[ $? -eq 0 ] && ok "A2 登记行存在，字段恰为 kind/path/branch/parent，kind=issue 且 parent 非空" \
             || no "A2 登记行缺失或字段不符：$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("ISS-918"))' "$SESS/.agents/trees.json" 2>&1)"

# ══ A3：同号二次被拒（不是串行跑两次 == 并发安全，但这一条也得成立）══════════════
out="$(run allocate ISS-918)"; rc=$?
assert_sandbox
n_tree=$(g "$SESS" worktree list | grep -c "/ISS-918 " || true)
if [ "$rc" != "0" ] && [ "$n_tree" = "1" ] && printf '%s' "$out" | grep -q "已有工作树登记"; then
  ok "A3 二次 EXIT=${rc}（非 0）· 仍是 1 棵树 · 打印了归属"
else
  no "A3 二次未被拒（exit=${rc} · 树数=${n_tree}）"
fi

# ══ A4：**真并发** —— 两个后台进程同时 allocate 同一单 ══════════════════════════
# 这是本脚本的核心断言。串行跑两次**测不到**这件事（A3 已经串行跑过了）。
(cd "$TMP" && bash "$WS_SRC" allocate ISS-919 >"$TMP/c1.log" 2>&1; echo $? >"$TMP/c1.rc") &
(cd "$TMP" && bash "$WS_SRC" allocate ISS-919 >"$TMP/c2.log" 2>&1; echo $? >"$TMP/c2.rc") &
wait
r1="$(cat "$TMP/c1.rc" 2>/dev/null)"; r2="$(cat "$TMP/c2.rc" 2>/dev/null)"
n_ok=0; for r in "$r1" "$r2"; do [ "$r" = "0" ] && n_ok=$((n_ok+1)); done
n_tree=$(g "$SESS" worktree list | grep -c "/ISS-919 " || true)
n_row=$(grep -c '"ISS-919"' "$SESS/.agents/trees.json" || true)
if [ "$n_ok" = "1" ] && [ "$n_tree" = "1" ] && [ "${n_row:-0}" -ge 1 ]; then
  ok "A4 真并发：恰好 1 个成功（EXIT=${r1}/${r2}）· 恰好 1 棵树 · 登记行在"
else
  no "A4 并发失守：成功 ${n_ok} 个（EXIT=${r1}/${r2}）· 树 ${n_tree} 棵 · 登记行 ${n_row} 条（**两棵都建成 = 本单要堵的形态**）"
fi
# 失败方必须是"拿到归属退出"，不是"崩了"
loser=""; [ "$r1" != "0" ] && loser="$TMP/c1.log"; [ "$r2" != "0" ] && loser="$TMP/c2.log"
if [ -n "$loser" ] && grep -qE "没抢到|已有工作树登记" "$loser"; then
  ok "A4b 落败方是有话说的（没抢到占位 / 已有登记），不是静默崩"
else
  no "A4b 落败方输出里既没说没抢到、也没说已登记：$(tail -2 "$loser" 2>/dev/null | tr '\n' ' ')"
fi

# ══ A4c：登记表 CAS 自身能判红（**隔离出 mkdir 之外的那半**）══════════════════
# 为什么要单独测：A4 的是"不许两棵都建成"，而那条**由 mkdir 占位独立守住** ——
#   实测把 flock 去掉，A4 照样绿（说明 A4 测不到登记表的并发保护）。
#   登记表自己的失守形态是**丢行**：两个进程各写各的临时文件再依次 rename，
#   后 rename 的会把先 rename 的**整份内容**盖掉。这一支必须单独钉住，否则
#   "原子写"只是注释里的一句话。
# 做法：直接并发调 trees_registry_cas add 两个**不同单号**（绕开 mkdir），
#   两者都必须成功、且**两行都在**。丢了任何一行 ⇒ 红。
R2="$TMP/reg2.json"; printf '{}\n' > "$R2"
( trees_registry_path() { printf '%s' "$R2"; }; trees_lock_path() { printf '%s' "$TMP/reg2.lock"; }
  trees_registry_cas add ISS-924 /p/9101 ISS-924 "" >"$TMP/cas1.log" 2>&1; echo $? >"$TMP/cas1.rc" ) &
( trees_registry_path() { printf '%s' "$R2"; }; trees_lock_path() { printf '%s' "$TMP/reg2.lock"; }
  trees_registry_cas add ISS-925 /p/9102 ISS-925 "" >"$TMP/cas2.log" 2>&1; echo $? >"$TMP/cas2.rc" ) &
wait
r1="$(cat "$TMP/cas1.rc" 2>/dev/null)"; r2="$(cat "$TMP/cas2.rc" 2>/dev/null)"
n_rows="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len([k for k in d if not k.startswith("_")]))' "$R2" 2>/dev/null || echo 0)"
if [ "$r1" = "0" ] && [ "$r2" = "0" ] && [ "$n_rows" = "2" ]; then
  ok "A4c 登记表 CAS：两个不同单号并发写，两行都在（${n_rows} 行）"
else
  no "A4c 登记表**丢行**：退出码 ${r1}/${r2}、落盘 ${n_rows} 行（期望 2）—— 原子写没生效"
fi

# ══ A5：CAS 失败必须回滚占位（不许留空目录）════════════════════════════════════
# 造"④ 建树失败"的场景：同名分支已存在 ⇒ worktree add 会在 mkdir 之后失败。
g "$SESS" branch ISS-920 HEAD >/dev/null 2>&1
out="$(run allocate ISS-920)"; rc=$?
assert_sandbox
if [ "$rc" != "0" ] && [ ! -e "$SESS/.agents/worktrees/ISS-920" ]; then
  ok "A5 建树失败 EXIT=${rc} → 占位已回滚（无空目录残留）"
else
  no "A5 回滚失守（exit=${rc}，目录仍在=$([ -e "$SESS/.agents/worktrees/ISS-920" ] && echo yes || echo no)）"
fi
# 未被本命令创建的分支必须留着（回滚不许顺手删别人的东西）
g "$SESS" show-ref --verify --quiet refs/heads/ISS-920 \
  && ok "A5b 回滚没动「本就有的」分支 ISS-920" \
  || no "A5b 回滚把本命令**没有**创建的分支也删了"

# ══ A6：登记表读不动 ⇒ 拒绝建树（判不了不许当通过）══════════════════════════════
cp "$SESS/.agents/trees.json" "$TMP/reg-good.json"
printf '{ 这不是 JSON' > "$SESS/.agents/trees.json"
out="$(run allocate ISS-921)"; rc=$?
assert_sandbox
if [ "$rc" != "0" ] && [ ! -e "$SESS/.agents/worktrees/ISS-921" ]; then
  ok "A6 登记表坏 JSON ⇒ EXIT=${rc}，未建树（判不了 ≠ 通过）"
else
  no "A6 登记表读不动却继续建了树（exit=${rc}）"
fi
cp "$TMP/reg-good.json" "$SESS/.agents/trees.json"

# ══ A7：落点已存在 ⇒ 拒绝，且**不删**那个目录（那是别人的）════════════════════
mkdir -p "$SESS/.agents/worktrees/ISS-922"
out="$(run allocate ISS-922)"; rc=$?
assert_sandbox
if [ "$rc" != "0" ] && [ -d "$SESS/.agents/worktrees/ISS-922" ]; then
  ok "A7 落点已存在 ⇒ EXIT=${rc}，且不删他人占位"
else
  no "A7 落点冲突处理不对（exit=${rc}，目录在=$([ -d "$SESS/.agents/worktrees/ISS-922" ] && echo yes || echo no)）"
fi
rmdir "$SESS/.agents/worktrees/ISS-922"

# ══ A8：**不跳过 Matter 回写**且**无 token** ⇒ 不许因空数组展开炸掉（ISS-874）════
# 为什么必须单列：A1~A7 全程 `WS_ALLOC_NO_MATTER=1`，回写那一段**一次都没被执行过** ——
#   于是 `${hdr[@]}` 在 bash 3.2 + set -u 下展开空数组报 `unbound variable` 这件事，
#   11 例自检全绿也发现不了（实测：真人建树时 curl 根本没跑，屏幕只说"回写失败"）。
#
# ⚠️ 本用例第一版是**空转的**（变异测试抓到）：它用真 `ISS-923` 跑，
#   服务端查不到该单 ⇒ `rel` 为空 ⇒ 在 `if [ -z "$rel" ]` 就 return 了，**根本没走到 curl 那行**。
#   ⇒ 必须用一个**本地桩服务**把 `rel` 喂出来，把执行点逼到 curl 展开处。
#   桩：MATTER_BASE 指向 127.0.0.1:PORT，/forge-pm/logs 回一条带 `for: issues/...` 的 JSON。
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
python3 - "$PORT" <<'PYSTUB' &
import json, sys
from http.server import HTTPServer, BaseHTTPRequestHandler
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"items": [{"for": "issues/fake.md"}]}).encode()
        self.send_response(200); self.send_header("content-type","application/json")
        self.send_header("content-length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PYSTUB
STUB_PID=$!
sleep 1

out="$(WS_ALLOC_NO_MATTER=0 MATTER_BASE="http://127.0.0.1:$PORT" env -u FORGE_PM_AGENT_TOKEN \
       bash "$WS_SRC" allocate ISS-923 2>&1)"; rc=$?
assert_sandbox
kill "$STUB_PID" >/dev/null 2>&1 || true

if printf '%s' "$out" | grep -q "unbound variable"; then
  no "A8 无 token 时回写段展开空数组炸了（bash 3.2 \"\${hdr[@]}\"）：$(printf '%s' "$out" | grep 'unbound variable' | head -1)"
elif printf '%s' "$out" | grep -q "Matter 回写"; then
  # 「回写失败」= curl 真跑了并拿到桩的响应；这条才算把执行点逼到了展开处
  ok "A8 无 token · 真走到 curl 且未炸（exit=${rc}）· 桩喂了 rel ⇒ 回写请求真发出去了"
else
  no "A8 回写段没被走到（无「Matter 回写」输出）—— 判据空转，不能算过"
fi
git -C "$SESS" worktree remove --force "$SESS/.agents/worktrees/ISS-923" >/dev/null 2>&1 || true
git -C "$SESS" branch -D ISS-923 >/dev/null 2>&1 || true

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ ws-allocate 自检通过（${pass} 例）"
  exit 0
fi
echo "✗ ws-allocate 自检失败：${pass} 通过 / ${fail} 失败"
echo "  判据见本脚本头注「反例」—— 每条断言都配了「删掉被测逻辑就必红」的形态"
exit 1
