#!/usr/bin/env bash
# ISS-552 W-1 / W-3 自测：租约归属校验 + 分家出声（可重复跑，全部在临时目录里，不碰 ~/.dsh）
# 覆盖面已扩到：ISS-553（主检出未跟踪顶层目录）· ISS-554（插件 symlink 写完对账 + 家跟随 DSH_HOME）
#
# 为什么要一份自测而不是"手工试一遍"：这条判据的失败形态是**静默的**——
# 释放了别人的租约不会报错，只会让护栏对那个人失明。没牙的守卫等于装饰（老板点名过两次）。
#
# 用法：bash scripts/ws-lease-selftest.sh          # 跑全部
#       WS_SELFTEST_KEEP=1 bash scripts/ws-lease-selftest.sh   # 保留临时目录（排障用）
#
# 形状照 `guard-baselines.sh`：能在 `DSH_FORGE_REPO` 指向的临时仓库里独立验「该红必须红」，
# 逻辑长在 ws.sh 里就测不到这条路径（ISS-587 的同一课）。
set -uo pipefail

WS_SRC="$(cd "$(dirname "$0")/.." && pwd)/scripts/ws.sh"
PASS=0
FAIL=0

say() { printf '%s\n' "$*"; }
ok()  { PASS=$((PASS+1)); printf '  ✓ %s\n' "$*"; }
no()  { FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$*"; }

TMP="$(mktemp -d)"
cleanup() { [ "${WS_SELFTEST_KEEP:-}" = "1" ] || rm -rf "$TMP"; }
trap cleanup EXIT

# ── 临时仓库（主 checkout）+ 一棵带单号分支的工作树 + 独立状态目录 ──
REPO="$TMP/repo"
STATE="$TMP/state"
mkdir -p "$REPO" "$STATE"
git -C "$REPO" init -q -b main .
git -C "$REPO" config user.email self@test
git -C "$REPO" config user.name selftest
echo hi > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm "init"
git -C "$REPO" worktree add -q -b ISS-760 "$TMP/wt2001" main
git -C "$REPO" worktree add -q -b ISS-761 "$TMP/wt2002" main

run_ws() { # 在指定 cwd 下跑 ws.sh 的子命令（状态目录与仓库都指到临时那份，绝不碰 ~/.dsh）
  local cwd="$1"; shift
  ( cd "$cwd" && DSH_FORGE_REPO="$REPO" WS_STATE_DIR="$STATE" bash "$WS_SRC" "$@" )
}

say "── 场景 1：在途租约属于 A，B 来释放必须被拒 ──"
run_ws "$TMP/wt2001" claim ISS-760 >/dev/null 2>&1
out="$(run_ws "$TMP/wt2002" release ISS-761 2>&1)"; rc=$?
holder="$(python3 -c "import json;print(json.load(open('$STATE/workspace-lock.json')).get('iss',''))")"
if [ "$rc" = "3" ] && [ "$holder" = "ISS-760" ]; then ok "B 释放被拒（exit=3），锁上仍是 ISS-760"
else no "期望 exit=3 且 holder 不变，实得 exit=$rc holder=$holder"; say "$out"; fi
case "$out" in *"这不是你的租约"*) ok "拒的话术点名了持有者" ;; *) no "话术没说明是谁的租约";; esac

say "── 场景 2：A 自己释放应当成功 ──"
out="$(run_ws "$TMP/wt2001" release ISS-760 2>&1)"; rc=$?
holder="$(python3 -c "import json;print(json.load(open('$STATE/workspace-lock.json')).get('iss',''))")"
if [ "$rc" = "0" ] && [ -z "$holder" ]; then ok "A 释放成功（锁回到已释放态）"
else no "期望 exit=0 且 holder 空，实得 exit=$rc holder=$holder"; say "$out"; fi

say "── 场景 3：租约已过期 ⇒ 谁都能清账（但要说清是代为清账）──"
python3 -c "
import json, datetime
exp = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'iss':'ISS-760','owner':'A','since':'2026-01-01T00:00:00Z','expire':exp}, open('$STATE/workspace-lock.json','w'))
"
out="$(run_ws "$TMP/wt2002" release ISS-760 2>&1)"; rc=$?
if [ "$rc" = "0" ]; then ok "过期租约可被清账（exit=0）"
else no "过期租约释放被误拒（exit=${rc}）"; say "$out"; fi

say "── 场景 4：在主 checkout（分支名没单号）裸 release ⇒ 不许猜，必须报错 ──"
run_ws "$TMP/wt2001" claim ISS-760 >/dev/null 2>&1
out="$(cd "$REPO" && DSH_FORGE_REPO="$REPO" WS_STATE_DIR="$STATE" bash "$WS_SRC" release 2>&1)"; rc=$?
holder="$(python3 -c "import json;print(json.load(open('$STATE/workspace-lock.json')).get('iss',''))")"
if [ "$rc" = "1" ] && [ "$holder" = "ISS-760" ]; then ok "无单号时拒绝并保留在途租约"
else no "期望 exit=1 且租约仍在，实得 exit=$rc holder=$holder"; say "$out"; fi

say "── 场景 5：--force 是明确通道（大声说原持有者，而不是静默换锁）──"
out="$(run_ws "$TMP/wt2002" release ISS-761 --force 2>&1)"; rc=$?
holder="$(python3 -c "import json;print(json.load(open('$STATE/workspace-lock.json')).get('iss',''))")"
if [ "$rc" = "0" ] && [ -z "$holder" ] && [[ "$out" == *"强制释放他人租约"* ]]; then ok "强制路径可用且出声"
else no "强制路径行为异常（exit=$rc holder=${holder}）"; say "$out"; fi

say "── 场景 6：claim 记下的新字段（cwd / stateDir）—— 每树租约（W-2）要读的就是它们 ──"
run_ws "$TMP/wt2001" claim ISS-760 >/dev/null 2>&1
python3 - "$STATE/workspace-lock.json" "$TMP" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
ok = d.get("iss") == "ISS-760" and sys.argv[2] in (d.get("cwd") or "") and (d.get("stateDir") or "")
print("FIELDS_OK" if ok else "FIELDS_BAD " + json.dumps(d, ensure_ascii=False))
PY
if [ $? -eq 0 ]; then ok "claim 写出 cwd/stateDir（旧脚本按 key 取值，多出来的键被忽略 = 兼容）"
else no "claim 没写全归属字段"; fi

say "── 场景 7：家不一致时出声（DSH_HOME 指向另一家）──"
mkdir -p "$TMP/other-home"
out="$(DSH_HOME="$TMP/other-home" run_ws "$TMP/wt2001" status 2>&1)"
if [[ "$out" == *"治理件看的家"* && "$out" == *"DSH_HOME"* ]]; then ok "分家会被报出来（不静默、也不擅自改写入位置）"
else no "没报分家"; say "$out"; fi
out2="$(DSH_HOME="$STATE" run_ws "$TMP/wt2001" status 2>&1)"
if [[ "$out2" == *"治理件看的家"* ]]; then no "两家一致时仍报分家（假红）"
else ok "两家一致时不报（反向对照：防「永远响」的守卫）"; fi

say "── 场景 8：主检出未跟踪顶层目录（ISS-553 判据层）──"
# 判据住在 `wt-scan-lib.mjs`（纯函数）——住在 wt-scan.mjs 里没法测：import 它会把整轮采集跑一遍
# 并把报告打进 stdout，断言就被污染了（本次实测踩过，故拆出 lib）。
# JS 一律用**单引号**包给 node，数据走环境变量，避免 bash 与 JS 两套引号互相咬。
SCAN="$(cd "$(dirname "$0")/.." && pwd)/scripts/wt-scan-lib.mjs"
runfn() { # $1 = porcelain 原文（含真实换行）
  # ⚠️ 动态 import 的说明符**不能**直接写 `process.env.SCAN`（那是 bare specifier ⇒ ERR_MODULE_NOT_FOUND），
  #    必须过 `pathToFileURL(...).href`。这条坑实测踩过一次，留注释免得又被"改成静态路径"绕过去。
  SCAN="$SCAN" PORC="$1" node --input-type=module -e '
import { pathToFileURL } from "node:url";
const m = await import(pathToFileURL(process.env.SCAN).href);
console.log(m.untrackedDirsFromPorcelain(process.env.PORC).map((r) => r.name).join(","));
' 2>&1
}
# ① 口径三条：顶层目录进、嵌套目录/未跟踪文件/点开头目录都不进
u=$(runfn "$(printf '?? forge-widgets/\n?? scripts/foo.mjs\n?? a/b/\n?? .cache/\n?? plugins/')")
if [ "$u" = "forge-widgets,plugins" ]; then ok "只数顶层未跟踪目录（嵌套/文件/.开头都不进）"
else no "口径不对：[$u]"; fi
# ② 阳性对照：真 git 的 porcelain 形状必须真是「目录带斜杠、文件不带」，否则 ① 是在自证想象中的输入
mkdir -p "$TMP/repo8/newpkg" && echo x > "$TMP/repo8/newpkg/keep.txt" && echo y > "$TMP/repo8/loose.txt"
(cd "$TMP/repo8" && git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m seed 2>/dev/null)
real=$(cd "$TMP/repo8" && git status --porcelain)
if [[ "$real" == *"?? newpkg/"* && "$real" == *"?? loose.txt"* ]]; then ok "真实 porcelain 形状与判据假设一致"
else no "porcelain 形状不是预期：[$real]"; fi
u2=$(runfn "$real")
if [ "$u2" = "newpkg" ]; then ok "真 git 输出喂进判据层 ⇒ 只报目录、文件被排除"
else no "判据层在真输入上不对：[$u2]"; fi
# ③ 反向对照：干净仓库报 0（防「永远响」）
rm -rf "$TMP/repo8/newpkg" "$TMP/repo8/loose.txt"
u3=$(runfn "$(cd "$TMP/repo8" && git status --porcelain)")
if [ -z "$u3" ]; then ok "干净仓库不报（反向对照）"
else no "干净仓库不该有输出：[$u3]"; fi
# ④ 已知盲区要固化成断言：**空目录不会出现在 porcelain 里** ⇒ 这一格看不见"没文件的空壳新包"
#    （判据写"等于空"而不是"不含 emptypkg"——后者在 node 报错时也成立，会把坏掉读成通过）
mkdir -p "$TMP/repo8/emptypkg"
u4=$(runfn "$(cd "$TMP/repo8" && git status --porcelain)")
if [ -z "$u4" ]; then ok "空目录不入报（git 本就不记空目录 ⇒ 这是这一格的已知盲区，写死免得下次误判成守卫漏了）"
else no "空目录竟然被报出来了，或判据层坏了：[$u4]"; fi
say "── 场景 9：插件 symlink 写完必须对账 + 家跟随服务（ISS-554）──"
# 病根：`PROFILES_NM` 曾写死 `$HOME/.dsh`，而 3210 跑在 `DSH_HOME=~/.dsh-matter` ⇒
# `ws.sh link` 打印「✓ 已把 1 个插件 symlink 指向…」，服务读的仍是旧代码。
# 这一格钉两件事：① 写入位置跟随 DSH_HOME；② 写完逐条 readlink 对账，不符即 exit 1。
# 全程只碰临时家，**绝不写 ~/.dsh / ~/.dsh-matter**（末尾有反向断言兜这条）。
DFLT_BEFORE="$(readlink "$HOME/.dsh/profiles/node_modules/forge-pm" 2>/dev/null || true)"
MAT_BEFORE="$(readlink "$HOME/.dsh-matter/profiles/node_modules/forge-pm" 2>/dev/null || true)"
NM9="$TMP/home9/profiles/node_modules"
mkdir -p "$NM9" "$REPO/forge-pm" "$TMP/wt2001/forge-pm/dist"
ln -s "$REPO/forge-pm/" "$NM9/forge-pm"          # 假家里"已挂载"的那一个（挂载名单是 profile 的契约）
run_nm() { WS_PROFILES_NM="$NM9" DSH_FORGE_WT_ROOT="$TMP" run_ws "$TMP/wt2001" "$@"; }
out="$(run_nm link wt2001 forge-pm 2>&1)"; rc=$?
tgt="$(readlink "$NM9/forge-pm" 2>/dev/null || true)"
# ① 该绿必须绿：链接内容带尾斜杠（glob 的固有形状），对账**不许**因此报红
if [ "$rc" = "0" ] && [ "${tgt%/}" = "$TMP/wt2001/forge-pm" ] && [[ "$out" == *"已对账"* ]]; then
  ok "切到工作树成功并出声对账（尾斜杠不算违例：[$tgt]）"
else no "① 期望 exit=0 且链接指向工作树，实得 exit=$rc 链接=[$tgt]"; say "$out"; fi
# ② 该红必须红：挂载目录被权限挡住 ⇒ 写不进去，此时**不许**打印"已切"，且要点名是哪个包
chmod 555 "$NM9"
out2="$(run_nm link main forge-pm 2>&1)"; rc2=$?
tgt2="$(readlink "$NM9/forge-pm" 2>/dev/null || true)"
chmod 755 "$NM9"
if [ "$rc2" != "0" ] && [[ "$out2" == *"对账失败"* ]] && [[ "$out2" == *"forge-pm(写失败)"* ]] && [[ "$out2" != *"已把 1 个插件"* ]] && [ "${tgt2%/}" = "$TMP/wt2001/forge-pm" ]; then
  ok "写不进家的时候不报成功（exit=${rc2}，点名 forge-pm(写失败)，链接原样保留）"
else no "② 期望非 0 + 「对账失败」+ 点名包 + 不出现成功行，实得 exit=$rc2 链接=[$tgt2]"; say "$out2"; fi
# ②b 反向对照：权限恢复后同一命令必须过（防「修好了还在响」）
out2b="$(run_nm link main forge-pm 2>&1)"; rc2b=$?
tgt2b="$(readlink "$NM9/forge-pm" 2>/dev/null || true)"
if [ "$rc2b" = "0" ] && [ "${tgt2b%/}" = "$REPO/forge-pm" ]; then
  ok "阻塞解除后同一命令切回 main 并绿（反向对照）"
else no "②b 期望 exit=0 且指回主检出，实得 exit=$rc2b 链接=[$tgt2b]"; say "$out2b"; fi
# ②c `set -euo pipefail` 下 link_symlink 返 1 会当场掐断整条命令 ⇒ 收尾的对账根本走不到。
#     这一格钉"失败要汇总后再红"：两个包同时写不进 ⇒ 两条都要点名，而不是只报第一个就退。
ln -s "$REPO/forge-ui/" "$NM9/forge-ui" 2>/dev/null || true
mkdir -p "$REPO/forge-ui" "$TMP/wt2001/forge-ui/dist"
chmod 555 "$NM9"
out2c="$(run_nm link wt2001 forge-pm forge-ui 2>&1)"; rc2c=$?
chmod 755 "$NM9"
if [ "$rc2c" != "0" ] && [[ "$out2c" == *"forge-pm(写失败)"* ]] && [[ "$out2c" == *"forge-ui(写失败)"* ]]; then
  ok "多个包同时写不进 ⇒ 逐条点名（不是「第一个失败就退、剩下不说」）"
else no "②c 期望两条都点名，实得 exit=$rc2c"; say "$out2c"; fi
# ③ 病根本身：只给 DSH_HOME（不给 WS_PROFILES_NM）⇒ 必须写进那一家
NM10="$TMP/home10/profiles/node_modules"
mkdir -p "$NM10" && ln -s "$REPO/forge-pm/" "$NM10/forge-pm"
out3="$(DSH_HOME="$TMP/home10" DSH_FORGE_WT_ROOT="$TMP" run_ws "$TMP/wt2001" link wt2001 forge-pm 2>&1)"; rc3=$?
tgt3="$(readlink "$NM10/forge-pm" 2>/dev/null || true)"
if [ "$rc3" = "0" ] && [ "${tgt3%/}" = "$TMP/wt2001/forge-pm" ] && [[ "$out3" == *"$NM10"* ]]; then
  ok "PROFILES_NM 跟随 DSH_HOME（写进的就是那一家，成功行还把它打出来）"
else no "③ DSH_HOME 没被听：exit=$rc3 链接=[$tgt3]"; say "$out3"; fi
# ⑤ 同形的另一半：指名的包**没挂进这个家** ⇒ 旧输出是「已把 0 个插件…」+ exit 0（失败伪装成成功）
NM11="$TMP/home11/profiles/node_modules"
mkdir -p "$NM11"          # 一家"什么都没挂"的目录
out5="$(WS_PROFILES_NM="$NM11" DSH_FORGE_WT_ROOT="$TMP" run_ws "$TMP/wt2001" link wt2001 forge-pm 2>&1)"; rc5=$?
if [ "$rc5" != "0" ] && [[ "$out5" == *"一个都没切过去"* ]] && [[ "$out5" != *"已把 0 个插件"* ]]; then
  ok "点名了却没挂载 ⇒ 报错并 exit 非 0（不再打印「已把 0 个插件…」）"
else no "⑤ 期望非 0 + 「一个都没切过去」，实得 exit=$rc5"; say "$out5"; fi
# ④ 反向对照：三跑之后，本机真实的两个家都没被这个自测动过
DFLT_AFTER="$(readlink "$HOME/.dsh/profiles/node_modules/forge-pm" 2>/dev/null || true)"
MAT_AFTER="$(readlink "$HOME/.dsh-matter/profiles/node_modules/forge-pm" 2>/dev/null || true)"
if [ "$DFLT_BEFORE" = "$DFLT_AFTER" ] && [ "$MAT_BEFORE" = "$MAT_AFTER" ]; then
  ok "自测没碰真实挂载（~/.dsh 与 ~/.dsh-matter 原样）"
else no "⚠️ 自测改到了真实挂载：[$DFLT_BEFORE]→[$DFLT_AFTER] / [$MAT_BEFORE]→[$MAT_AFTER]"; fi
say "───────────────────────────────"
say "── 场景 10：纯 host 插件不许被「缺 dist」静默跳过（ISS-551 真机窗口的前置）──"
# 病根：那条白屏防护（ISS-334）不看这个包到底有没有 client，一律「缺 dist 就跳」。
# 现算实测：forge-agents / forge-messenger / forge-teammate-model 都挂成软链、都在 insert 名单里，
# 但都是纯 host 插件（没有 client-entry、永远不会有 dist）⇒ ws.sh link 报「已把 1 个插件…」而
# 实际只换了 forge-pm —— 窗口跑完、三步没验到，这是最贵的一种"成功"。
NM10="$TMP/home16/profiles/node_modules"
mkdir -p "$NM10" "$REPO/forge-hostonly" "$TMP/wt2001/forge-hostonly" "$REPO/forge-client" "$TMP/wt2001/forge-client/src/dsh"
printf '{"name":"forge-hostonly"}\n' > "$REPO/forge-hostonly/package.json"
printf '{"name":"forge-client","scripts":{"build:client":"echo x"}}\n' > "$REPO/forge-client/package.json"
printf '// client 入口\n' > "$TMP/wt2001/forge-client/src/dsh/client-entry.tsx"
ln -s "$REPO/forge-hostonly/" "$NM10/forge-hostonly"
ln -s "$REPO/forge-client/" "$NM10/forge-client"
out10="$(WS_PROFILES_NM="$NM10" DSH_FORGE_WT_ROOT="$TMP" run_ws "$TMP/wt2001" link wt2001 forge-hostonly forge-client 2>&1)"; rc10=$?
t10h="$(readlink "$NM10/forge-hostonly" 2>/dev/null || true)"
t10c="$(readlink "$NM10/forge-client" 2>/dev/null || true)"
if [ "$rc10" = "0" ] && [ "${t10h%/}" = "$TMP/wt2001/forge-hostonly" ]; then
  ok "① 纯 host 插件（无 client、无 dist）现在切得动（[${t10h}]）"
else no "① 期望 exit=0 且 host-only 包指向工作树，实得 exit=${rc10} 链接=[${t10h}]"; say "$out10"; fi
if [ "${t10c%/}" = "$REPO/forge-client" ]; then
  ok "② 反向对照：带 client 而缺 dist 的包照旧跳过（白屏防护没被这次修改削弱）"
else no "② 期望 forge-client 仍指主检出（被跳过），实得 链接=[${t10c}]"; say "$out10"; fi
out10b="$(WS_PROFILES_NM="$NM10" DSH_FORGE_WT_ROOT="$TMP" run_ws "$TMP/wt2001" link wt2001 forge-nosuch 2>&1)"; rc10b=$?
if [ "$rc10b" != "0" ] && [[ "$out10b" == *"forge-nosuch"* ]]; then
  ok "③ 反向对照：指名但没挂载的包仍报错并点名（既有行为没回归）"
else no "③ 期望非 0 并点名 forge-nosuch，实得 exit=${rc10b}"; say "$out10b"; fi
ln -sfn "$REPO/forge-hostonly/" "$NM10/forge-hostonly" 2>/dev/null || true
ln -sfn "$REPO/forge-client/" "$NM10/forge-client" 2>/dev/null || true

say "── 场景 11：分支已并入 main 的租约 ⇒ 出声提示，但**不夺权**（误伤比缺牙贵）──"
git -C "$REPO" worktree add -q -b ISS-762 "$TMP/wt2003" main
echo more > "$TMP/wt2003/extra.txt"
git -C "$TMP/wt2003" add extra.txt && git -C "$TMP/wt2003" commit -qm "ISS-762 的工作"
git -C "$REPO" merge -q --no-ff -m "merge(ISS-762)" ISS-762
FUT="$(python3 -c "import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=60)).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
python3 -c "
import json
json.dump({'iss':'ISS-762','owner':'A','since':'2026-01-01T00:00:00Z','expire':'$FUT','cwd':'$TMP/wt2003'}, open('$STATE/workspace-lock.json','w'))
"
out="$(run_ws "$TMP/wt2002" status 2>&1)"
case "$out" in *"干完没收尾"*) ok "① 该出声：时钟没到也提示收口（release / rm 两条命令都给了）" ;;
                 *) no "① 期望 status 提示干完没收尾"; say "$out";; esac
out="$(run_ws "$TMP/wt2002" claim ISS-761 2>&1)"; rc=$?
if [ "$rc" = "3" ]; then ok "② 不夺权：这条锁没让别人绕过 --force 就接管（分支图分不开它与旧 base，误判=无声抢地）"
else no "② 期望 claim 被拒 exit=3，实得 exit=${rc}"; say "$out"; fi
out="$(unset WS_OWNER; run_ws "$TMP/wt2002" claim ISS-761 --force 2>&1)"; rc=$?
if [ "$rc" = "0" ]; then ok "③ --force 仍是唯一明确通道（大声说原持有者）"
else no "③ 期望强制接管成功，实得 exit=${rc}"; say "$out"; fi

say "── 场景 12：反向对照 —— 没合并过的锁不许被误报，未署名必须被点名 ──"
out="$(run_ws "$TMP/wt2001" status 2>&1)"
case "$out" in *"干完没收尾"*) no "① 反向对照失败：一条从未合并的在途租约被误报成没收尾";;
                     *) ok "① 反向对照：停在 main 上、没合并过的健康租约不误报";; esac
case "$out" in *"未署名"*) ok "② 没导出 WS_OWNER 的 claim 被点名（护栏答不了「是谁在占」）";;
                  *) no "② 未署名没出声"; say "$out";; esac
printf '{}\n' > "$STATE/workspace-lock.json"
out="$(run_ws "$TMP/wt2001" claim ISS-760 2>&1)"; rc=$?
if [ "$rc" = "0" ]; then ok "③ 已释放态（空对象 {}）不挡下一个 claim（这条抓的是把空锁当有人在途的回归）"
else no "③ 期望 claim 成功，实得 exit=${rc}"; say "$out"; fi

say "── 场景 13：判据的三种退化形状（审查抓到的回归，逐条钉住）──"
# (a) merged + 时钟已过 ⇒ 必须放行（曾经的 critical：merged 打印后 sys.exit 把 time 判据一起吃掉，
#     于是这条租约永不过期，他人 claim 永久 exit 3、link main 永久跳过却报成功）
python3 -c "
import json, datetime
past = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'iss':'ISS-762','owner':'A','since':'2026-01-01T00:00:00Z','expire':past,'cwd':'$TMP/wt2003'}, open('$STATE/workspace-lock.json','w'))
"
out="$(run_ws "$TMP/wt2002" claim ISS-761 2>&1)"; rc=$?
if [ "$rc" = "0" ]; then ok "(a) merged 且已到期 ⇒ 放行（提示保留，但不再吞掉时钟判据）"
else no "(a) 期望 claim 放行，实得 exit=${rc}：merged 又把时钟判据吃了"; say "$out"; fi
# (b) 没有 expire 字段 ⇒ 按 main 既有语义判可清，不许永挂
python3 -c "
import json
json.dump({'iss':'ISS-926','owner':'A'}, open('$STATE/workspace-lock.json','w'))
"
out="$(run_ws "$TMP/wt2002" claim ISS-761 2>&1)"; rc=$?
if [ "$rc" = "0" ]; then ok "(b) 缺 expire 的老锁判可清（不永挂后来人）"
else no "(b) 期望放行，实得 exit=${rc}"; say "$out"; fi
# (c) 锁文件读不出 ⇒ fail-closed：既不放行 claim，也不许 release 把别人的租约抹成 {}
printf '{ this is not json\n' > "$STATE/workspace-lock.json"
out="$(run_ws "$TMP/wt2002" claim ISS-761 2>&1)"; rc=$?
if [ "$rc" = "3" ]; then ok "(c1) 读不出按「有人占着」处理（fail-closed，接管要显式 --force）"
else no "(c1) 期望 exit=3，实得 exit=${rc}：读失败被判成了没人在"; say "$out"; fi
out="$(run_ws "$TMP/wt2002" release ISS-761 2>&1)"; rc=$?
if [ "$rc" != "0" ] && grep -q 'this is not json' "$STATE/workspace-lock.json"; then
  ok "(c2) 读不出时拒绝释放，锁文件原样未动（旧写法会把它抹成 {}，护栏对真人失明）"
else no "(c2) 期望拒写并保留原文件，实得 exit=${rc}"; say "$out"; fi

say "── 场景 14：插件链接「写成功却指错」必须被点名（变异审查指出这格无覆盖）──"
# 复现 ISS-416 的真实形状：挂载位不是软链而是**真目录** ⇒ `ln -s` 会把链接建到目录**内部**，
# 表面成功、实际没切过去。旧自测只测过"写不进去"（chmod 555），这一支一直是绿的 = 没牙。
NM14="$TMP/home14/profiles/node_modules"
mkdir -p "$NM14/forge-check" "$REPO/forge-check" "$TMP/wt2001/forge-check"
ln -sfn "$REPO/forge-check/" "$NM14/forge-check/forge-check" 2>/dev/null || true   # 目录内部那条杂散链接
out="$(WS_PROFILES_NM="$NM14" DSH_FORGE_WT_ROOT="$TMP" run_ws "$TMP/wt2001" link wt2001 forge-check 2>&1)"; rc=$?
if [ "$rc" != "0" ] && [[ "$out" == *"forge-check"* ]]; then
  ok "① 该红：目标位是真目录（不是软链）时拒切并点名的确是这一格（exit=${rc}）"
else no "① 期望非 0 并点名 forge-check，实得 exit=${rc}"; say "$out"; fi
# 反向对照：把它换成正常的软链，同一命令必须成功 —— 证明上一格不是因为"包名不存在"而红
rm -rf "$NM14/forge-check"; ln -s "$REPO/forge-check/" "$NM14/forge-check"
out="$(WS_PROFILES_NM="$NM14" DSH_FORGE_WT_ROOT="$TMP" run_ws "$TMP/wt2001" link wt2001 forge-check 2>&1)"; rc=$?
tgt="$(readlink "$NM14/forge-check" 2>/dev/null || echo '')"
if [ "$rc" = "0" ] && [[ "$tgt" == *"wt2001/forge-check"* ]]; then ok "② 反向对照：正常挂载点切得动且确实指向本工作树"
else no "② 期望成功并指向 wt2001，实得 exit=${rc} 实指=${tgt:-<无>}"; say "$out"; fi
rm -rf "$NM14" "$REPO/forge-check" "$TMP/wt2001/forge-check"

say "── 场景 15：单号对得上但持有者不是你 ⇒ 必须拒（第二轮审查实测旧写法 exit=0 抹掉别人活租约）──"
python3 -c "
import json, datetime
fut = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=60)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'iss':'ISS-915','owner':'A品牌:ISS-915','since':'2026-01-01T00:00:00Z','expire':fut,'cwd':'$TMP/wt2001'}, open('$STATE/workspace-lock.json','w'))
"
before="$(shasum "$STATE/workspace-lock.json" | cut -c1-12)"
out="$(WS_OWNER='B品牌:ISS-916' run_ws "$TMP/wt2002" release ISS-915 2>&1)"; rc=$?
after="$(shasum "$STATE/workspace-lock.json" | cut -c1-12)"
if [ "$rc" = "3" ] && [ "$before" = "$after" ]; then ok "① 该拦：B 照着 status 打出的命令释放 A 的未到期租约被拒，锁文件一字未改"
else no "① 期望 exit=3 且锁不变，实得 exit=${rc} 锁=$( [ "$before" = "$after" ] && echo 未变 || echo 被抹了 )"; say "$out"; fi
out="$(run_ws "$TMP/wt2002" release ISS-915 2>&1)"; rc=$?
if [ "$rc" = "3" ]; then ok "② 没自报 WS_OWNER 也算不上持有者 ⇒ 照样拦（护栏不该因为你不署名就放行）"
else no "② 期望 exit=3，实得 exit=${rc}"; say "$out"; fi
out="$(WS_OWNER='A品牌:ISS-915' run_ws "$TMP/wt2002" release ISS-915 2>&1)"; rc=$?
if [ "$rc" = "0" ]; then ok "③ 反向对照：持有者对上就能释放（没把通道堵死）"
else no "③ 期望成功，实得 exit=${rc}"; say "$out"; fi

say "── 场景 16：合并凭据只认括号里的号（子串匹配曾把邻居家的锁误报）──"
git -C "$REPO" worktree add -q -b ISS-929 "$TMP/wt90061" main
echo z > "$TMP/wt90061/z.txt"
git -C "$TMP/wt90061" add z.txt && git -C "$TMP/wt90061" commit -qm "ISS-929 的工作"
git -C "$REPO" merge -q --no-ff -m "merge(ISS-929): 说明里顺带提到 ISS-923，但没合它" ISS-929
git -C "$REPO" branch ISS-923 "$(git -C "$REPO" rev-list --max-parents=0 HEAD | head -1)"   # 从未合并的短号分支（挂在根提交）
python3 -c "
import json, datetime
fut = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=60)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'iss':'ISS-923','owner':'A','since':'2026-01-01T00:00:00Z','expire':fut,'cwd':'$TMP/does-not-exist'}, open('$STATE/workspace-lock.json','w'))
"
out="$(run_ws "$TMP/wt2002" status 2>&1)"
case "$out" in *"干完没收尾"*) no "① 假阳性：merge(ISS-929) 的说明提到 ISS-923 就把它报成已合并";;
                     *) ok "① 短号不被长号的合并提交误命中（只取括号内那个号做等值）";; esac
python3 -c "
import json, datetime
fut = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=60)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'iss':'ISS-929','owner':'A','since':'2026-01-01T00:00:00Z','expire':fut,'cwd':'$TMP/does-not-exist'}, open('$STATE/workspace-lock.json','w'))
"
out="$(run_ws "$TMP/wt2002" status 2>&1)"
case "$out" in *"干完没收尾"*) ok "② 反向对照：真有 merge(ISS-929) 提交的那条照样出声";;
                     *) no "② 该出声没出声"; say "$out";; esac

say "── 场景 17：采集层崩了 guard 必须出声，不能整段静默死掉（set -e 实测咬过这一格）──"
mkdir -p "$TMP/brk"
cp "$WS_SRC" "$TMP/brk/ws.sh"
printf '#!/usr/bin/env bash\necho boom-from-collector >&2\nexit 1\n' > "$TMP/brk/wt-scan.mjs"
chmod +x "$TMP/brk/wt-scan.mjs"
out="$(HOME="$TMP/fakehome" DSH_FORGE_REPO="$REPO" WS_STATE_DIR="$STATE" bash "$TMP/brk/ws.sh" guard 2>&1)"; rc=$?
if [ "$rc" = "2" ] && [[ "$out" == *"boom-from-collector"* ]]; then
  ok "① 采集层崩溃被如实报出并**判红**（exit=2）——「只报不红」的前提是报得出来，没读数不能算通过"
else no "① 期望 exit=2 且报出根因，实得 exit=${rc} 输出字节=${#out}"; say "$(printf '%s' "$out" | head -3)"; fi

say "── 场景 18：「ws.sh rm」的归属检查必须排在删之前（否则树删了、锁还在）──"
git -C "$REPO" worktree add -q -b ISS-763 "$TMP/ISS-763" main
python3 -c "
import json, datetime
fut = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=60)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'iss':'ISS-763','owner':'A品牌:ISS-763','since':'2026-01-01T00:00:00Z','expire':fut,'cwd':'$TMP/ISS-763'}, open('$STATE/workspace-lock.json','w'))
"
lock_before="$(shasum "$STATE/workspace-lock.json" | cut -c1-12)"
out="$(WS_OWNER='B品牌:ISS-764' DSH_FORGE_WT_ROOT="$TMP" run_ws "$REPO" rm ISS-763 2>&1)"; rc=$?
if [ "$rc" = "3" ] && [ -d "$TMP/ISS-763" ] \
   && [ "$(shasum "$STATE/workspace-lock.json" | cut -c1-12)" = "$lock_before" ]; then
  ok "① 该拦且什么都没删：树还在、锁一字未改（旧顺序是先删树再释放，拒掉就留下指向已删目录的锁）"
else no "① 期望 exit=3 且树与锁都不动，实得 exit=${rc} 树=$([ -d "$TMP/ISS-763" ] && echo 在 || echo 没了)"; say "$out"; fi
out="$(WS_OWNER='A品牌:ISS-763' DSH_FORGE_WT_ROOT="$TMP" run_ws "$REPO" rm ISS-763 2>&1)"; rc=$?
holder="$(python3 -c "import json;print(json.load(open('$STATE/workspace-lock.json')).get('iss',''))" 2>/dev/null || echo '?')"
if [ "$rc" = "0" ] && [ ! -d "$TMP/ISS-763" ] && [ -z "$holder" ]; then
  ok "② 反向对照：持有者对上时一路收干净（树没了、锁也释放了，不留半截）"
else no "② 期望收干净，实得 exit=${rc} 树=$([ -d "$TMP/ISS-763" ] && echo 还在 || echo 没了) 锁=${holder:-<空>}"; say "$out"; fi

say "── 场景 19：「rm --force」必须一次收干净；锁读不出时 rm 什么都别删 ──"
# 第三轮审查的变异 M3 证明这两格原来无牙：把 --force 漏传给里层 release，
# 删完树后被拒、锁留着，外层却打「✓ 收工完成」rc=0 —— 正是 ISS-547 的形状。
git -C "$REPO" worktree add -q -b ISS-765 "$TMP/ISS-765" main
python3 -c "
import json, datetime
fut = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=60)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'iss':'ISS-765','owner':'A品牌:ISS-765','since':'2026-01-01T00:00:00Z','expire':fut,'cwd':'$TMP/ISS-765'}, open('$STATE/workspace-lock.json','w'))
"
out="$(WS_OWNER='B品牌:ISS-926' DSH_FORGE_WT_ROOT="$TMP" run_ws "$REPO" rm ISS-765 --force 2>&1)"; rc=$?
h19="$(python3 -c "import json;print(json.load(open('$STATE/workspace-lock.json')).get('iss',''))" 2>/dev/null || echo '?')"
if [ "$rc" = "0" ] && [ ! -d "$TMP/ISS-765" ] && [ -z "$h19" ]; then
  ok "① --force 一次收干净：树没了、锁也清了、rc=0（不留「锁指向已删目录」的半截）"
else no "① 期望收干净，实得 exit=${rc} 树=$([ -d "$TMP/ISS-765" ] && echo 还在 || echo 没了) 锁=${h19:-<空>}"; say "$out"; fi
# 锁读不出 ⇒ rm 必须停手（实测旧写法一路删净并打「✓ 收工完成」）
git -C "$REPO" worktree add -q -b ISS-766 "$TMP/ISS-766" main
printf '{ this is not json\n' > "$STATE/workspace-lock.json"
out="$(WS_OWNER='C品牌:ISS-766' DSH_FORGE_WT_ROOT="$TMP" run_ws "$REPO" rm ISS-766 2>&1)"; rc=$?
if [ "$rc" != "0" ] && [ -d "$TMP/ISS-766" ] && [[ "$out" == *"读不出"* ]]; then
  ok "② 锁读不出时 rm 直接停手：树没删、话说清了（旧写法用单号比对比，坏 JSON 等于「没人占」）"
else no "② 期望非 0、树不动并报出读不出，实得 exit=${rc} 树=$([ -d "$TMP/ISS-766" ] && echo 在 || echo 没了)"; say "$out"; fi
git -C "$REPO" worktree remove --force "$TMP/ISS-766" 2>/dev/null || rm -rf "$TMP/ISS-766"

say "── 场景 20：锁读不出时 link main 不许静默切走别人树上的包（round-1 指出、round-3 复现）──"
NM20="$TMP/home20/profiles/node_modules"
mkdir -p "$NM20" "$REPO/forge-pm"
ln -sfn "$TMP/wt2001/forge-pm/" "$NM20/forge-pm"          # 正指在别人的工作树上
printf '{ this is not json\n' > "$STATE/workspace-lock.json"
out="$(WS_PROFILES_NM="$NM20" DSH_FORGE_WT_ROOT="$TMP" run_ws "$REPO" link main 2>&1)"; rc=$?
tgt20="$(readlink "$NM20/forge-pm" 2>/dev/null || echo '<无>')"
if [ "$rc" != "0" ] && [[ "$out" == *"读不出"* ]] && [[ "$tgt20" == *"wt2001/forge-pm"* ]]; then
  ok "① 该拦：读不出按在途保护，裸 link main 跳过、出声、且**不再报成功**（rc=${rc}，链接原样留在别人树上）"
else no "① 期望非 0 + 出声 + 不切走，实得 exit=${rc} 实指=${tgt20}"; say "$out"; fi
out="$(WS_PROFILES_NM="$NM20" DSH_FORGE_WT_ROOT="$TMP" run_ws "$REPO" link main --all 2>&1)"; rc=$?
tgt20b="$(readlink "$NM20/forge-pm" 2>/dev/null || echo '<无>')"
if [ "$rc" = "0" ] && [[ "$tgt20b" == *"$REPO/forge-pm"* ]]; then ok "② 反向对照：--all 仍是明确强道口（没把出口堵死）"
else no "② 期望 --all 切回主检出，实得 exit=${rc} 实指=${tgt20b}"; say "$out"; fi
ln -sfn "$REPO/forge-pm/" "$NM20/forge-pm" 2>/dev/null || true
say "── 场景 21：在自己那棵树里 rm 自己的单 ⇒ 不许出现「树没了锁还在」（第四轮 C-N1）──"
# 形状：锁上 owner 可辨认、未到期，调用者**没导出 WS_OWNER**，但 cwd 就是那张单的树
# ⇒ 入口靠证据②（分支名）放行；删完树之后第④步不能重算一次判定然后翻脸。
git -C "$REPO" worktree add -q -b ISS-767 "$TMP/ISS-767" main
python3 -c "
import json, datetime
fut = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=60)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'iss':'ISS-767','owner':'A品牌:ISS-767','since':'2026-01-01T00:00:00Z','expire':fut,'cwd':'$TMP/ISS-767'}, open('$STATE/workspace-lock.json','w'))
"
out="$(unset WS_OWNER; DSH_FORGE_WT_ROOT="$TMP" run_ws "$TMP/ISS-767" rm ISS-767 2>&1)"; rc=$?
h21="$(python3 -c "import json;print(json.load(open('$STATE/workspace-lock.json')).get('iss',''))" 2>/dev/null || echo '?')"
if [ "$rc" = "0" ] && [ ! -d "$TMP/ISS-767" ] && [ -z "$h21" ]; then
  ok "① 一次收干净：树没了、锁也清了、rc=0（证据②在删树后不许翻脸 —— 靠 my_iss_from_cwd 的命令内缓存）"
else no "① 期望收干净，实得 exit=${rc} 树=$([ -d "$TMP/ISS-767" ] && echo 还在 || echo 没了) 锁=${h21:-<空>}"; say "$out"; fi

say "── 场景 22：锁写不进时 rm 必须提前停手（删完才发现写不进 = 半截）──"
git -C "$REPO" worktree add -q -b ISS-768 "$TMP/ISS-768" main
python3 -c "
import json, datetime
fut = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=60)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump({'iss':'ISS-768','owner':'未署名','since':'2026-01-01T00:00:00Z','expire':fut,'cwd':'$TMP/ISS-768'}, open('$STATE/workspace-lock.json','w'))
"
chmod 444 "$STATE/workspace-lock.json"
out="$(WS_OWNER='未署名' DSH_FORGE_WT_ROOT="$TMP" run_ws "$REPO" rm ISS-768 2>&1)"; rc=$?
if [ "$rc" != "0" ] && [ -d "$TMP/ISS-768" ] && [[ "$out" == *"写不进去"* ]]; then
  ok "① 该拦且什么都没删：锁不可写时提前停手（旧形状是删完树才卡在释放上）"
else no "① 期望非 0、树不动、说清写不进，实得 exit=${rc} 树=$([ -d "$TMP/ISS-768" ] && echo 在 || echo 没了)"; say "$out"; fi
chmod 644 "$STATE/workspace-lock.json"
out="$(WS_OWNER='未署名' DSH_FORGE_WT_ROOT="$TMP" run_ws "$REPO" rm ISS-768 2>&1)"; rc=$?
if [ "$rc" = "0" ] && [ ! -d "$TMP/ISS-768" ]; then ok "② 反向对照：权限修好后同一条命令一路收干净"
else no "② 期望成功，实得 exit=${rc}"; say "$out"; fi

say "自测结果：通过 $PASS 项 · 失败 $FAIL 项"
[ "$FAIL" = "0" ] || exit 2
