// ISS-675 清单对账器 —— 检查「清单说 ✅ 的，代码确实做到了」。
//
// ⚠️ 上一版的问题（Lead 用变异抓出）：全文从不打开清单文件，只跑 9 条代码断言，
//    却输出「清单未脱节：全部打勾都有可复跑证据」。**「全部」是它声称的，不是它验过的。**
//    30 个勾、9 条证据，剩下 21 个勾是「我说我验了」，而脚本替那 21 条一起打了包票。
//    失败路径退化成「看起来成功」的信号 —— 与 `requestLockSet()` 回空集同一个病。
//
// 现在它做四件事：
//   ① 解析 `scripts/iss1729-checklist.md`，抓出所有标 ✅ 的行及其证据标记
//   ② 每条 ✅ 必须有 `[[t:测试名]]` / `[[c:命令]]` / `[[m:人工理由]]` 之一，缺了就红
//   ③ 逐个执行证据：`t:` 在**真实测试名**里查；`c:` 真跑命令看输出；`m:` 要求写清核了什么
//   ④ **反向**：证据必须归属到清单条目，游离证据也红
//
// 用法（worktree 根目录）：bun scripts/iss1729-verify-checklist.mjs
// 判据：退出码 0 = 清单与代码/测试**逐条对上了**；非 0 = 脱节，红在哪条给了行号。

import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CHECKLIST = join(ROOT, "scripts/iss1729-checklist.md")
const CWD = join(ROOT, "forge-messenger")

let red = 0
const say = (ok, msg) => { console.log(`${ok ? "✅" : "❌"} ${msg}`); if (!ok) red++ }

// ── ① 解析清单 ────────────────────────────────────────────────────────────
const md = readFileSync(CHECKLIST, "utf8")
// 清单里有两类表格：1.x/2.x/3.x 是四列（含「位置」），4.x/5.x/6.x 是三列。
// 只认四列会**静默漏掉一半条目** —— 漏掉的条目永远不会被判红，正是本脚本要防的病。
// 故按「首列是编号、末列是状态」抓，中间列数不限。
const rows = []
for (const [i, line] of md.split("\n").entries()) {
  if (!line.startsWith("| ") || !line.endsWith(" |")) continue
  const cells = line.slice(1, -1).split(" | ").map((c) => c.trim())
  if (cells.length < 3) continue
  if (!/^\d+\.\d+$/.test(cells[0])) continue
  rows.push({ rowNo: i + 1, id: cells[0], state: cells[cells.length - 1] })
}

const checked = rows.filter((r) => r.state.includes("✅"))
const unchecked = rows.filter((r) => r.state.includes("❌"))

say(rows.length > 0, `解析到清单条目 ${rows.length} 条（✅ ${checked.length} / ❌ ${unchecked.length}）`)

// ── ①·5 期望行集：**删行必须红**（五轮审查 C-3）────────────────────────────
// 只做「剩下的都对上就算过」是不够的：删掉一整行，剩下的每一行照样对得上，
// 脚本会心满意足地回 0。那等于「证据减少」这个动作本身无守卫。
//
// 期望行集写死在旁边（`iss1729-checklist.expected.json`），由清单维护规则要求同步。
// 少了行 ⇒ 红；多了行 ⇒ 也红（新增条目必须显式登记，否则下一个人不知道它被纳入对账）。
const EXPECTED = JSON.parse(readFileSync(join(ROOT, "scripts/iss1729-checklist.expected.json"), "utf8"))
const gotIds = rows.map((r) => r.id).sort()
const wantIds = [...EXPECTED.ids].sort()
const missingIds = wantIds.filter((id) => !gotIds.includes(id))
const extraIds = gotIds.filter((id) => !wantIds.includes(id))
say(missingIds.length === 0, missingIds.length === 0
  ? `清单行集完整（期望 ${wantIds.length} 行，无缺失）`
  : `清单少了 ${missingIds.length} 行：${missingIds.join(", ")} —— 删行等于删证据，必须显式改期望集并说明`)
say(extraIds.length === 0, extraIds.length === 0
  ? "没有未登记的清单行"
  : `清单多出 ${extraIds.length} 行未登记：${extraIds.join(", ")} —— 新增条目要同步 expected.json`)
say(unchecked.length === 0, unchecked.length === 0
  ? "清单里没有 ❌ 未完成项"
  : `清单里还有 ${unchecked.length} 条 ❌：${unchecked.map((r) => r.id).join(", ")}`)

// ── ② 每条 ✅ 必须带证据标记 ─────────────────────────────────────────────
// ⚠️ `g` + `matchAll`：一行里可能挂多个标记（一个勾既靠测试又靠命令时）。
//    不带 `g` 只取第一个，多出来的标记会被静默忽略 —— 而「静默忽略」正是本单的病。
const EVIDENCE_RE = /\[\[(t|c|m):(.+?)\]\]/g
const marksIn = (state) => [...state.matchAll(EVIDENCE_RE)].map((m) => ({ kind: m[1], value: m[2].trim() }))
const MISSING = checked.filter((r) => marksIn(r.state).length === 0)
say(MISSING.length === 0, MISSING.length === 0
  ? `每条 ✅ 都带证据标记（${checked.length} 条）`
  : `${MISSING.length} 条 ✅ 没有证据标记（等于「我说我验了」）：${MISSING.map((r) => `${r.id}@第${r.rowNo}行`).join(", ")}`)

// ── ③ 逐个执行证据 ───────────────────────────────────────────────────────
// 真跑一次全量测试，拿**真实测试名**。证据靠比对真实名字，不靠「我记得有这条」。
let testNames = null
let failedNames = null
function getTestNames() {
  if (testNames) return testNames
  const out = execSync("bun test 2>&1", { cwd: CWD, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  testNames = new Set()
  failedNames = new Set()
  for (const line of out.split("\n")) {
    // ⚠️ 只认 `(pass)`。把 `(fail)` 也算成证据的话，**一条正在失败的测试也能充当合格证据** ——
    // 清单会对着一片红光说「全部打勾都有可复跑证据」。这是本脚本自己犯过的第二个假绿。
    const m = line.match(/^\((pass|fail)\) (.+?)(?: \[[\d.]+ms\])?$/)
    if (m) (m[1] === "pass" ? testNames.add(m[2].trim()) : failedNames.add(m[2].trim()))
  }
  return testNames
}

// ── ③·0 测试源码：查「断言被掏空」（五轮审查 C-1）────────────────────────
// 名字对得上 ≠ 断言站得住。审查实测：把 N1 那个 describe 里 10 条 `expect` 全换成
// `expect(1).toBe(1)`，测试照报 14 pass，对账器照回 0 —— **它证明名字对得上，不证明断言成立**。
//
// 可判定口径（Lead 给的）：被 `t:` 引用的测试，若其 `expect` 的实参**全部是字面量常量**
// （`expect(1)` / `expect(true)` / `expect("x")`），判红。真测常量相等的用例几乎没有，
// 误报极低，而「掏空」这个形态正好被抓住。
const SRC_FILES = []
function getSources() {
  if (SRC_FILES.length) return SRC_FILES
  const out = execSync("git ls-files 'forge-messenger/**/*.test.js'", { cwd: ROOT, encoding: "utf8" })
  for (const rel of out.split("\n").filter(Boolean)) {
    SRC_FILES.push({ rel, text: readFileSync(join(ROOT, rel), "utf8") })
  }
  return SRC_FILES
}
/** 一条测试名 ⇒ 它在源码里的函数体（尽力而为：从名字回溯到最近的 `test(`/`it(`）。 */
function bodyOfTestName(name) {
  // 测试名在 bun 里是 `describe > it` 拼接；源文件里只有 it 那一部分
  const leaf = name.split(" > ").pop().trim()
  for (const f of getSources()) {
    const i = f.text.indexOf(`"${leaf}"`)
    const j2 = i >= 0 ? i : f.text.indexOf(`'${leaf}'`)
    if (j2 < 0) continue
    const k = f.text.indexOf("=>", j2)
    if (k < 0) continue
    // 取到匹配的 `})` 为止（够用：不追求完整 AST）
    const end = f.text.indexOf("\n  })", k)
    return { rel: f.rel, body: f.text.slice(k, end < 0 ? k + 4000 : end) }
  }
  return null
}
const LITERAL = /^\(?\s*(?:-?\d+(?:\.\d+)?|true|false|null|undefined|"[^"]*"|'[^']*'|`[^`$]*`)\s*\)?$/
/** 这个测试体里的 expect 是不是"全部字面量比字面量"（= 掏空）。 */
function isHollowed(body) {
  const calls = [...body.matchAll(/expect\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*\.\s*(?:not\s*\.\s*)?(\w+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)]
  if (calls.length === 0) return { hollow: true, why: "这条测试里一个 expect 都没有" }
  const allLiteral = calls.every((m) => LITERAL.test(m[1].trim()) && LITERAL.test(m[3].trim()))
  return allLiteral
    ? { hollow: true, why: `全部 ${calls.length} 条 expect 都是字面量比字面量（断言被掏空的形态）` }
    : { hollow: false, calls: calls.length }
}

const results = []
for (const r of checked) {
  for (const mk of marksIn(r.state)) {
  const { kind, value } = mk
  if (kind === "t") {
    const names = getTestNames()
    // ⚠️ 精确匹配（整条测试名相等），不再用子串。
    //    子串匹配下「改个名、describe 里仍含关键词」照样算命中 —— 审查实测 V2/V3 都漏网。
    const hits = [...names].filter((n) => n === value || n.endsWith(`> ${value}`))
    const failedHits = [...failedNames].filter((n) => n === value || n.endsWith(`> ${value}`))
    if (hits.length > 0) {
      // 名字对上了，再验断言站不站得住
      const hollow = hits.map((n) => ({ n, ...isHollowed((bodyOfTestName(n) || {}).body || "") }))
      const bad = hollow.filter((h) => h.hollow)
      results.push({
        ok: bad.length === 0, id: r.id, kind,
        detail: bad.length === 0
          ? `测试精确命中「${value}」（${hits.length} 条通过，断言非空壳）${failedHits.length ? `；另有 ${failedHits.length} 条同名失败不算证据` : ""}`
          : `「${value}」名字对上了但断言不可信：${bad.map((b) => b.why).join("；")}`,
      })
    } else {
      results.push({
        ok: false, id: r.id, kind,
        detail: failedHits.length > 0
          ? `「${value}」有测试但**全部失败** —— 失败的测试不是证据`
          : `测试名里找不到精确的「${value}」（改名/删掉/加前缀都会到这里）`,
      })
    }
  } else if (kind === "c") {
    let ok = false, detail = ""
    try {
      const out = execSync(value, { cwd: ROOT, encoding: "utf8", stdio: "pipe" }).trim()
      ok = out !== "" && out !== "0"
      detail = `命令回 ${JSON.stringify(out)}`
    } catch (e) {
      detail = `命令失败（退出码 ${e.status}）`
    }
    results.push({ ok, id: r.id, kind, detail })
  } else {
    // m: 人工证据 —— 不假装机器验过，但要写清核了什么。空话打回。
    const ok = value.length >= 12
    results.push({
      ok, id: r.id, kind,
      detail: ok ? `人工证据（未自动化）：${value}` : `人工证据太短，写不清核了什么：${JSON.stringify(value)}`,
    })
  }
  }
}

for (const e of results) say(e.ok, `${e.id} ${e.kind === "m" ? "⚠️ " : ""}${e.detail}`)

// ── ④ 反向：证据不许游离于清单之外 ───────────────────────────────────────
// ⚠️ 只数**表格行里**的证据标记。全文数会把文档里的示例（`[[t:测试名片段]]` 这种说明文字）
//    也算成游离证据 —— 本脚本改规则说明时自己踩过：加了 6 个示例，立刻报「6 条游离」。
//    说明文字不是证据，不该进账。
const evidenceInRows = checked.map((r) => (r.state.match(/\[\[(t|c|m):/g) || []).length).reduce((a, b) => a + b, 0)
const strayEvidence = evidenceInRows - results.length
say(strayEvidence === 0, strayEvidence === 0
  ? "无游离证据（每条证据都归属到一个清单条目）"
  : `${strayEvidence} 条证据没有归属的清单条目`)

// ── 汇总 ─────────────────────────────────────────────────────────────────
const byKind = { t: 0, c: 0, m: 0 }
for (const e of results) byKind[e.kind]++

console.log("")
console.log(`清单 ${checked.length} 个 ✅ —— 机器证据 ${byKind.t + byKind.c} 条（测试 ${byKind.t} / 命令 ${byKind.c}）· 人工证据 ${byKind.m} 条`)
if (byKind.m > 0) console.log(`⚠️ 人工证据 ${byKind.m} 条无法机器复跑，已逐条列出核了什么 —— 不假装验过。`)
console.log(red === 0
  ? `\n清单与实现逐条对上：${checked.length} 个勾，${results.length} 条证据，0 条游离。`
  : `\n❌ ${red} 处对不上 —— 清单脱节了（见上方 ❌ 行）。`)
process.exit(red === 0 ? 0 : 1)
