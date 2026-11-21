#!/usr/bin/env bash
# ISS-675 变异实测脚本 —— 每条变异都必须让**指定那条守卫**变红。
#
# 用法（在 worktree 根目录）：bash scripts/iss1729-mutations.sh
# 脚本自备份自还原；跑完 `git status --porcelain` 必须干净。
#
# 为什么要有这个脚本（Lead 2026-10-31 的教训）：
#   「变异红了」≠「守卫有牙」——也可能是别的守卫兜住了（打空靶）。
#   所以每条变异都打印**红在哪几条测试上**，并断言其中必须包含预期的那条。
#
# 本脚本自己也被证伪过一次：最初的 B4 变异只红了 2 条，
# 而 `observe-render.test.js` 里那条真正叫「禁用词守卫」的用例**照样全绿**——
# 因为它的样本带 3 个 items，根本不走空表分支。这正是空靶。
set -uo pipefail
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="forge-messenger/lib"
# ⚠️ 还原范围必须覆盖**每一个会被变异的文件**。
# 漏一个 ⇒ 上一条变异残留到下一条，后面的"结果"全是脏的（本脚本踩过：M1/H1 残留
# 导致 B1 无输出、收尾基线 654/6 而不是 660/0）。
FILES=("$LIB/inflight.js" "$LIB/observe/process-state.js" "$LIB/restart-resume.js"
       "$LIB/observe/observe-render.js" "$LIB/observe/observe-render.test.js"
       "$LIB/observe/lock-note.js")
BAK=$(mktemp -d)
for f in "${FILES[@]}"; do mkdir -p "$BAK/$(dirname "$f")"; cp "$f" "$BAK/$f"; done
restore() { for f in "${FILES[@]}"; do cp "$BAK/$f" "$f"; done; }
trap 'restore; rm -rf "$BAK"' EXIT

# 跑一次测试，把 pass/fail 计数与红的测试名一起抓出来（只跑一遍）
OUT=""
run() {
  # --isolate：一个文件泄漏的 handle 不影响另一个文件。本脚本要跑 40+ 遍测试，
  # 而无 isolate 在本机实测 759s/遍（进程收尾卡在 ulock_wait 空转），全脚本要 ~8h；
  # 带 --isolate 5.8s/遍、结果同为 718 pass / 0 fail。ISS-678 之前 A-4 一直没跑通就是这个。
  OUT=$(bun test forge-messenger --isolate 2>&1)
  PASS=$(printf '%s\n' "$OUT" | grep -E "^ *[0-9]+ pass$" | tr -dc '0-9')
  FAILN=$(printf '%s\n' "$OUT" | grep -E "^ *[0-9]+ fail$" | tr -dc '0-9')
}

# ⚠️ 这里**不能**写成 `echo "基线：$(run; echo ...)"`：`$(...)` 是子 shell，
#    run() 赋的 $PASS/$FAILN 随子 shell 退出丢弃，下面读它们就是 unbound variable
#    （set -u 当场崩，ISS-678）。所以先在本 shell 调 run，再读计数。
run
BASE_PASS=$PASS
BASE_FAIL=$FAILN
echo "基线：$BASE_PASS pass / $BASE_FAIL fail"

# run_case <名字> <预期红的测试名片段> <变异函数>
run_case() {
  local name="$1" expect="$2" mut="$3"
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "变异：$name"
  "$mut" || { echo "!! 变异注入失败（锚点没找到）—— 代码变了，脚本需更新，不许静默跳过"; restore; return 1; }
  run
  local red
  red=$(printf '%s\n' "$OUT" | grep -E "^\(fail\)" | sed -E 's/ \[[0-9.]+ms\]//' | sort -u)
  echo "结果：$PASS pass / $FAILN fail"
  echo "红的测试："
  printf '%s\n' "$red" | sed 's/^/  /'
  if printf '%s\n' "$red" | grep -qF "$expect"; then
    echo "✅ 打中真边：命中预期守卫「${expect}」"
  else
    echo "❌ 空靶：预期守卫「${expect}」没红 —— 这条变异没打中它"
  fi
  restore
  # 每条变异后自检：还原后必须回到基线，否则后面的测量全脏
  local after_check
  after_check=$(run; echo "$FAILN")
  if [ "$after_check" != "0" ]; then
    echo "!! 还原后仍有 $after_check 条失败 —— 变异未干净还原，中止（不继续测脏数据）"
    git status --porcelain
    exit 1
  fi
}

m_b4() {
  python3 - <<'PY'
p='forge-messenger/lib/inflight.js'
s=open(p).read()
old='lines.push("**当前没有执行中的会话** —— 此刻重启不会打断任何执行（这是结论，不是空表）。")'
new='lines.push("**当前没有任何在飞会话** —— 此刻重启不会打断任何执行（这是结论，不是空表）。")'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
PY
}
run_case "B4 空表段落塞「在飞」" "空表三条分支，正文一律不许出现口语词" m_b4

m_b1() {
  python3 - <<'PY'
p='forge-messenger/lib/inflight.js'
s=open(p).read()
old='''        : lockProbe.ok
          ? { ok: true, sids: lockHeldByMe ? new Set([sid]) : new Set() }'''
new='''        : lockProbe.ok
          ? { ok: true, sids: new Set() }'''
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
PY
}
run_case "B1 锁探测成功被压成 null（探成未持锁 ⇒ 没探成）" "锁探测" m_b1

m_b2() {
  python3 - <<'PY'
p='forge-messenger/lib/inflight.js'
s=open(p).read()
old=': (registryPresent ? "direct" : ((lockProbe !== null && lockProbe.ok) || diskReadable) ? "indirect" : "none"),'
new=': (registryPresent ? "direct" : "none"), // 变异 M-B2'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
PY
}
run_case "B2 evidenceLevel 只看注册表（忽略盘/锁）" "盘读成了 ⇒ indirect" m_b2

m_b3() {
  python3 - <<'PY'
p='forge-messenger/lib/inflight.js'
s=open(p).read()
# ⚠️ 锚点是 `reconcileCounts` 里的单循环 —— **活跃的那一处**。
#    `buildInflight` 里还有一处长得一样的计数，但它的结果被 `reconcileCounts`
#    整块重建覆盖（`const counts = reconcileCounts(base, ...)`），打那里变异不会红。
#    第一版就打在死的那一处，实测 671 pass / 0 fail 却报「空靶」—— 空靶救了这一次。
old='    if (isUnknown(i)) { tiers.unknown++; counted++; continue }'
new='    if (isUnknown(i)) { tiers.unknown++; counted++ } // 变异 M-B3：删掉 continue ⇒ unknown 继续往下并进三档'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
PY
}
run_case "B3 unknown 并回三档（删 continue，账不平）" "不变式：unknown 不许被并进任何一档" m_b3

m_b5() {
  python3 - <<'PY'
p='forge-messenger/lib/restart-resume.js'
s=open(p).read()
start=s.index('  const isUnknown = (i) => i?.processState?.reachability === "unknown"')
end=s.index('  const next = { ...out.snapshot, items: merged, counts }', start)
new='''  const tierOf = (i) => String(i?.tier || "") // 变异 M-B5
  const counts = { ...(out.snapshot?.counts || {}), total: merged.length,
    interrupted: merged.filter((i) => tierOf(i) === "interrupted").length }
'''
open(p,'w').write(s[:start]+new+s[end:])
PY
}
run_case "B5 合并后只重算 interrupted" "B5 合并后账要平" m_b5

m_sid() {
  python3 - <<'PY'
p='forge-messenger/lib/observe/process-state.js'
s=open(p).read()
old='  const state = { sessionId: String(input.sessionId ?? ""), reachability, ownership, evidence, evidenceSources, lockVerdict, observedAt, basis, notes }'
new='  const state = { reachability, ownership, evidence, evidenceSources, lockVerdict, observedAt, basis, notes } // 变异 M-SID'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
PY
}
run_case "M-SID deriveProcessState 丢 sessionId" "按 id 查得到自己" m_sid

# ④ 三轮 critical：notes 在 build 之后补（原因进不了 md / 盘）
m_c1() {
  python3 - <<'INNER'
p='forge-messenger/lib/inflight.js'
s=open(p).read()
old='    notes: [...(Array.isArray(input.notes) ? input.notes : []), ...scan.notes],'
new='    notes: scan.notes, // 变异 C1：丢掉调用方 notes'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
INNER
}
run_case "C1 丢掉调用方 notes（锁失败原因到不了 md/盘）" "原因必须进 md、进落盘 JSON" m_c1

# ⑤ 三轮 high：豁免回到整行宽正则
m_h1() {
  python3 - <<'INNER'
p='forge-messenger/lib/observe/observe-render.test.js'
s=open(p).read()
old='''function maskLegacy(line) {
  let out = line
  for (const { re } of LEGACY_SPOTS) out = out.replace(re, "\\u0000")
  return out
}'''
new='''function maskLegacy(line) {
  return /^- .*$/.test(line) ? "\\u0000" : line // 变异 H1：整行豁免（后门）
}'''
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
INNER
}
run_case "H1 豁免回到整行（后门重新打开）" "豁免只作用于「词 + 位置」" m_h1

# ⑥ 三轮 medium：服务口 unknown 并回三档
m_m1() {
  python3 - <<'INNER'
p='forge-messenger/lib/observe/observe-render.js'
s=open(p).read()
old='''    if (processState.reachability === "unknown") counts.unknown++
    else counts[tier]++'''
new='''    if (processState.reachability === "unknown") counts.unknown++
    counts[tier]++ // 变异 M1：并档（三轮 medium 原样复现）'''
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
INNER
}
run_case "M1 服务口 unknown 并回三档（账不平）" "24 格穷举" m_m1

# ⑦ 三轮 medium：lockProbe.reason 收了不用
m_m2() {
  python3 - <<'INNER'
p='forge-messenger/lib/inflight.js'
s=open(p).read()
old='        : { ok: false, reason: lockProbe.reason },'
new='        : null, // 变异 M2：reason 丢掉（收了不用）'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
INNER
}
run_case "M2 lockProbe.reason 收了不用（永远报「未给原因」）" "lockProbe.reason 一路传到判据 notes" m_m2

m_n4() {
  python3 - <<'INNER'
p='forge-messenger/lib/observe/process-state.js'
s=open(p).read()
old='const REACHABILITY = Object.freeze(["reachable", "unreachable", "host-down", "unknown"])'
new='const REACHABILITY = Object.freeze(["reachable", "unreachable", "host-down", "unknown", "half-dead"]) // 变异 N4'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
INNER
}
run_case "N4 给 REACHABILITY 加第 5 个值" "字段取值表：实现口径 vs 手写期望" m_n4
# ─── N1（四轮审查）：降级原因必须到达五个落点 ──────────────────────────────
# 审查实测：`extraNotes()` 在 `build()` 返回之后才 push ⇒ md 与落盘文件早已生成，
# 原因只活在这一次响应里。两种形态都要能红：
#   N1a 干脆不交给装配层（原因连响应体都到不了）
#   N1b 搬回旧写法（build 之后补 —— 响应体有、md 与盘没有，这就是审查抓到的真实形态）
n1a() {
  python3 -c "
p='forge-messenger/lib/observe/observe-route.js'
s=open(p).read()
old='        notes: degradeNotes,'
assert old in s, '锚点没找到'
open(p,'w').write(s.replace(old,'        // 变异 N1a：不交给装配层',1))
"
}
FILES+=("$LIB/observe/observe-route.js")
mkdir -p "$BAK/$(dirname "$LIB/observe/observe-route.js")"
cp "$LIB/observe/observe-route.js" "$BAK/$LIB/observe/observe-route.js"
run_case "N1a 降级原因不交给装配层" "降级原因必须到达五个落点" n1a

n1b() {
  python3 -c "
p='forge-messenger/lib/observe/observe-route.js'
s=open(p).read()
old='        notes: degradeNotes,'
assert old in s, '锚点1没找到'
s=s.replace(old,'        // 变异 N1b：不交给装配层',1)
marker='        // ⚠️ 这里**不再**往 '
i=s.index(marker)
j=s.index('\n', s.index('不需要在这里补。', i))
old2=s[i:j+1]
new2='''        const extra = typeof opts.extraNotes === \"function\" ? opts.extraNotes() : []
        if (Array.isArray(extra) && extra.length) {
          out.snapshot.judge.notes = out.snapshot.judge.notes || []
          for (const n of extra) out.snapshot.judge.notes.push(n)
        }
'''
open(p,'w').write(s.replace(old2,new2,1))
"
}
run_case "N1b 搬回旧写法（build 之后补 notes）" "降级原因必须到达五个落点" n1b

# ─── N2（四轮审查）：reconcileCounts 的排除必须有守卫 ──────────────────────
# 审查实测：去掉 `&& !isUnknown(i)` 后 **660 条测试全绿**，账不平照样落盘。
n2() {
  python3 -c "
p='forge-messenger/lib/inflight.js'
s=open(p).read()
old='    if (isUnknown(i)) { tiers.unknown++; counted++; continue }'
assert old in s, '锚点没找到'
s=s.replace(old,'    if (false && isUnknown(i)) { tiers.unknown++; counted++; continue }',1)
old2='    unknown: tiers.unknown,'
assert old2 in s, '锚点2没找到'
s=s.replace(old2,'    unknown: items.filter(isUnknown).length,',1)
open(p,'w').write(s)
"
}
run_case "N2 unknown 不独立判（并回三档，账不平）" "不变式" n2


echo ""
echo "════════════════════════════════════════════════════════════"
run
# ─── 清单对账器本身也要有牙 ───────────────────────────────────────────────
# Lead 抓到的病：上一版对账器从不打开清单文件，却输出「全部打勾都有证据」。
# 这里把「对账器失效」做成变异，要求它必须红 —— 否则对账器回 0 就是假的安心。


# ══════════════════════════════════════════════════════════════════════════
# 五轮审查 B：锁探测三态 —— 判据 B-1 ~ B-4 的原始边
# ══════════════════════════════════════════════════════════════════════════
m_b5_optimistic() {
  python3 - <<'PY'
p='forge-messenger/lib/inflight.js'
s=open(p).read()
old='        : { notProbed: true, reason: "调用方未提供锁探测结果（违约：lockProbe / lockHeld 都没给）" }'
new='        : { ok: true, sids: heldSet }'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
PY
}
run_case "B5a 缺省改回 {ok:true}（乐观默认＝本轮修掉的写法）" "B-1 没探 ≠ 探成" m_b5_optimistic

m_b5_pessimistic() {
  python3 - <<'PY'
p='forge-messenger/lib/inflight.js'
s=open(p).read()
old='        : { notProbed: true, reason: "调用方未提供锁探测结果（违约：lockProbe / lockHeld 都没给）" }'
new='        : { ok: false, reason: "悲观缺省" }'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,new,1))
PY
}
run_case "B5b 缺省改成 {ok:false}（悲观默认，证明没用它糊弄）" "B-2 没探必须出声" m_b5_pessimistic

m_b5_text() {
  python3 - <<'PY'
# ⚠️ ISS-676：锁降级文案已收进 `observe/lock-note.js`（唯一源）。
#    变异必须**两个文件都动**，否则只红一半、测出来的还是别的东西：
#      ① 唯一源里那句（等价于改四个落点的措辞）
#      ② process-state 的「注册表缺席」三分支里点名 not-probed 的那一句
#    两条都拿掉，md 里才真的不再出现「没做探测」这个事实 —— 那正是 B-2 要抓的。
p1='forge-messenger/lib/observe/lock-note.js'
s1=open(p1).read()
a='return `本次未做会话锁探测${why ? `（${why}）` : ""} —— 可达判据缺一环，锁一侧不下任何结论`'
assert a in s1, "锚点甲没找到（唯一源变了，脚本需更新）"
open(p1,'w').write(s1.replace(a,'return "占位甲"',1))

p2='forge-messenger/lib/observe/process-state.js'
s2=open(p2).read()
b='"注册表缺席且本次未做会话锁探测 —— 可寻址性判据不全，记作状态未知（不当不可达处理）"'
assert b in s2, "锚点乙没找到（三分支文案变了，脚本需更新）"
open(p2,'w').write(s2.replace(b,'"注册表缺席（占位乙）"',1))
PY
}
run_case "B5c 删掉「没探」那句文案" "B-2 没探必须出声" m_b5_text


HIT=0
MISS=0
CL_MD="$ROOT/scripts/iss1729-checklist.md"
CL_JSON="$ROOT/scripts/iss1729-verify-checklist.mjs"
CL_BAK=/tmp/cl-$$
cp "$CL_MD" "$CL_BAK.md"; cp "$CL_JSON" "$CL_BAK.mjs"
CL_TEST="$ROOT/forge-messenger/lib/inflight.test.js"
cp "$CL_TEST" "$CL_BAK.test.js"
# 还原失败必须出声（K9c：不许静默吞错 —— 还原不掉就是脏数据，比不还原更坏）
restore_cl() {
  cp "$CL_BAK.md" "$CL_MD" || echo "!! 清单还原失败（${CL_MD}）—— 工作树现在是脏的，检查后再继续"
  cp "$CL_BAK.mjs" "$CL_JSON" || echo "!! 对账器还原失败（${CL_JSON}）—— 工作树现在是脏的，检查后再继续"
  cp "$CL_BAK.test.js" "$CL_TEST" || echo "!! 测试文件还原失败（${CL_TEST}）—— 工作树现在是脏的，检查后再继续"
}
trap restore_cl EXIT
# ══════════════════════════════════════════════════════════════════════════
# 五轮审查 C：对账器有牙 —— 判据 C-1 ~ C-4
# 这三条看的是**对账器退出码**，不是 bun test 的红绿。
# ══════════════════════════════════════════════════════════════════════════
run_recon_case() {
  local name="$1" expect="$2" fn="$3"
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "变异：$name"
  "$fn" || { echo "!! 变异注入失败（锚点没找到）—— 代码变了，脚本需更新，不许静默跳过"; restore_cl; return 1; }
  local out code
  out=$(cd "$ROOT" && bun scripts/iss1729-verify-checklist.mjs 2>&1); code=$?
  echo "对账器退出码：$code"
  echo "红的行："
  printf '%s\n' "$out" | grep -E "❌" | head -4 | sed 's/^/  /'
  if [ "$code" -ne 0 ] && printf '%s\n' "$out" | grep -qF "$expect"; then
    echo "✅ 打中真边：对账器 exit ${code}，且命中「${expect}」"
    HIT=$((HIT+1))
  else
    echo "❌ 空靶：预期「${expect}」没让对账器红（exit=${code}）"
    MISS=$((MISS+1))
  fi
  restore_cl
  # ⚠️ 每条变异后自检：还原后对账器必须回到 exit 0。
  #    少了这一步，C1 那条会留下「断言被掏空」的 inflight.test.js，
  #    后面所有测量都在脏树上跑 —— 本轮真的发生过一次（对账器红着交出去）。
  local back
  back=$(cd "$ROOT" && bun scripts/iss1729-verify-checklist.mjs >/dev/null 2>&1; echo $?)
  if [ "$back" != "0" ]; then
    echo "!! 还原后对账器仍 exit $back —— 变异未干净还原，中止（不继续测脏数据）"
    git status --porcelain
    exit 1
  fi
}

c_hollow() {
  python3 - <<'PY'
import re
p='forge-messenger/lib/inflight.test.js'
s=open(p).read()
name='unknown 单列计数，**不并入**任何一档（三档和 + unknown = total）'
i=s.index('test("'+name+'"')
j=s.index('\n  })', i)
body=s[i:j]
# 把每条 expect(...)...(...) 整体换成常量比常量 —— 正是"掏空"的形态
# （正则放在这里而不是 shell 里，避免 heredoc 吞反斜杠）
hollow, n = re.subn(r'expect\([^()]*\)\s*\.\s*\w+\([^()]*\)', 'expect(1).toBe(1)', body)
assert n > 0, "没有 expect 被替换，变异无效"
open(p,'w').write(s[:i]+hollow+s[j:])
print("替换", n, "条 expect")
PY
}
run_recon_case "C1 断言被掏空成 expect(1).toBe(1)" "断言不可信" c_hollow

c_rename() {
  python3 - <<'PY'
p='forge-messenger/lib/inflight.test.js'
s=open(p).read()
old='test("unknown 单列计数，**不并入**任何一档（三档和 + unknown = total）"'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,'test("SKIP-unknown 单列计数，**不并入**任何一档（三档和 + unknown = total）"',1))
PY
}
run_recon_case "C2 被引测试改名成 SKIP-" "测试名里找不到精确的" c_rename

c_delrow() {
  python3 - <<'PY'
p='scripts/iss1729-checklist.md'
L=open(p).read().split(chr(10))
out=[l for l in L if not l.startswith('| 7.3 |')]
assert len(out)==len(L)-1, "7.3 行没找到"
open(p,'w').write(chr(10).join(out))
PY
}
run_recon_case "C3 删掉清单 7.3 行" "清单少了" c_delrow


run_cl_case() {
  local name="$1" expect="$2" fn="$3"
  echo ""
  echo "变异：$name"
  cp "$CL_BAK.md" "$CL_MD"; cp "$CL_BAK.mjs" "$CL_JSON"
  "$fn"
  local out code
  out=$(bun "$CL_JSON" 2>&1); code=$?
  echo "结果：退出码 $code"
  if [ "$code" -ne 0 ] && echo "$out" | grep -q "$expect"; then
    echo "✅ 打中真边：命中预期「${expect}」"
    HIT=$((HIT+1))
  else
    echo "❌ 空靶：退出码 ${code}，但没命中「${expect}」"
    echo "$out" | grep "❌" | head -4
    MISS=$((MISS+1))
  fi
  cp "$CL_BAK.md" "$CL_MD"; cp "$CL_BAK.mjs" "$CL_JSON"
}

# CL1：清单里把一条 ✅ 改成 ❌（Lead 原样复现的那一发）
cl1() {
  python3 - <<'INNER'
p='scripts/iss1729-checklist.md'
s=open(p).read()
old='| 1.4 | `observeItems`（服务口） | `observe-render.js:136-146` | ✅ 已修（三轮）'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,'| 1.4 | `observeItems`（服务口） | `observe-render.js:136-146` | ❌ 尚未修',1))
INNER
}
run_cl_case "CL1 清单某条 ✅→❌（对账器必须报脱节）" "还有 1 条 ❌" cl1

# CL2：删掉一条的证据标记（「我说我验了」必须被打回）
cl2() {
  python3 - <<'INNER'
import re
p='scripts/iss1729-checklist.md'
s=open(p).read()
old=' [[t:lockProbe.reason 一路传到判据 notes（收了就必须用）]]'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,'',1))
INNER
}
run_cl_case "CL2 删掉一条证据标记（无证据的勾必须打回）" "没有证据标记" cl2

# CL3：对账器不读清单（退回上一版的病）
cl3() {
  python3 - <<'INNER'
p='scripts/iss1729-verify-checklist.mjs'
s=open(p).read()
old='const md = readFileSync(CHECKLIST, "utf8")'
assert old in s, "锚点没找到"
open(p,'w').write(s.replace(old,'const md = "" // 变异 CL3：不读清单（上一版的病）',1))
INNER
}
run_cl_case "CL3 对账器不读清单（只剩代码断言，却宣称清单干净）" "解析到清单条目 0 条" cl3

cp "$CL_BAK.md" "$CL_MD"; cp "$CL_BAK.mjs" "$CL_JSON"
trap - EXIT

echo ""
echo "清单对账器：$HIT 条打中 / $MISS 条空靶"

# ⚠️ 必须在这里重跑一次测试再印收尾基线。
#    $PASS/$FAILN 只在 run() 内赋值，而最后一次 run() 发生在 CL1/CL2/CL3 之前 ——
#    那三条 CL 变异只改清单与对账器、**不跑 bun test**。若省掉这一发，
#    印出来的是最后一次变异态的数字，不是收尾态（ISS-678 就是这处）。
echo ""
echo "收尾重测（还原后再跑一遍，不复用变异态的数字）"
run
CLOSE_PASS=$PASS
CLOSE_FAIL=$FAILN
echo "收尾基线：$CLOSE_PASS pass / $CLOSE_FAIL fail"

# 自检：收尾基线与开头基线不一致 ⇒ 还原不干净。ISS-675 本轮已两次栽在这上面，
# 判据落进脚本，不靠人记得。
if [ "$CLOSE_PASS$CLOSE_FAIL" != "$BASE_PASS$BASE_FAIL" ]; then
  echo "!! 收尾基线与初始基线不一致：初始 $BASE_PASS/${BASE_FAIL}，收尾 $CLOSE_PASS/$CLOSE_FAIL"
  echo "!! ⇒ 还原不干净，本脚本的测量结果全部作废"
  git status --porcelain
  exit 1
fi
echo "✅ 收尾基线与初始基线一致（$BASE_PASS/${BASE_FAIL}）⇒ 还原干净"

echo "git status（必须为空）："
git status --porcelain
