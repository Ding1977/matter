#!/usr/bin/env node
/**
 * 冻结门禁 verify-freeze（ISS-798 · 阶段 0-2 / S0-5）
 *
 * 口径来源：重构主规划的「旧树冻结只读」与 S0-5（冻结路径 `git diff --numstat`
 * **`added == 0`**，纯注释新增豁免，纯删除放行）。⚠️ 那几份 `refactor-*.md` 计划文档
 * **未被 git 跟踪**（实测 `git ls-files specs/` 不含它们，全历史 0 次提交），只在主 checkout
 * 的磁盘上 —— 所以这里只写文档名、不写路径，且**判据口径以本文件与 `frozen-paths.json`
 * 的自述为准**，不把仓外文档当作可查证的真相源（否则就是悬空指针）。
 * 本脚本是那条口径的机器形态 —— 在这之前它只是纸面约定（实测三处全不存在）。
 *
 * ── 判据（三态，口径同 `scripts/guard-baselines.sh` 的 `check()`：0 绿 / 1 红 / 3 判不了）──
 *
 *   | 场景                                  | 期望 |
 *   |---------------------------------------|------|
 *   | 冻结路径改 1 行逻辑                    | 红   |
 *   | 纯删除（`deleted > 0` 且无新增逻辑行）  | 绿   |
 *   | 纯注释新增（行首 `//` `*` `/*`）        | 绿   |
 *   | 冻结路径新增**未跟踪**文件              | 红   |
 *   | 有已跟踪源码的包目录没进 frozen          | 判不了（3，H1：砍清单即绕过） |
 *   | **本分支新建**的包目录没进 frozen        | 不因此判（base 上没有老代码，见 ISS-865） |
 *   | 基线缺席 / JSON 坏 / 定位不到共同祖先   | 判不了（3） |
 *
 * ── 为什么用 exit 3 表示「判不了」，不是 2 ──
 * 两条退出码约定在本仓并存：`scripts/lib/gate-runtime.ts`（新 `.ts` 门禁）用 **2**；
 * `scripts/guard-baselines.sh`（legacy 格）用 **3**。本格经 `registry.json` 的 `kind:"legacy"`
 * 登记、由 `guard-baselines.sh` 的 `check()` 调度，而 `check()` 与 `run-gates.mjs` 的
 * `VERDICT.check()` 都把 **3** 读成「判不了」、把 **2** 读成「回归」。⇒ 这里必须是 3，
 * 否则「判不了」会被显示成红（ISS-635 的原始形态：红被读成绿 / 判不了被读成红，都是三态撞成两态）。
 *
 * ── 两处**超出 playbook 字面**的口径（明知故犯，已报 Lead）──
 * ① **未跟踪文件也算红**。`git diff` 只看已跟踪文件，`echo x > forge-pm/lib/new.js` 一行就能绕过
 *    整条判据而判绿 —— 那样这道门禁没有牙。`git ls-files --others` 补上这一面。
 * ② **二进制改动算红**。`Binary files differ` 里没有 `+` 行，按字面会被读成「0 行新增 ⇒ 绿」；
 *    冻结路径上的二进制变化无法证明是「纯注释」，按红处理（fail-safe）。
 * 两条都只会让判据更严，不会放宽；如果 Lead 认为应当退回字面口径，删掉对应分支即可。
 *
 * ── 已知盲区（不假装能判）──
 * 「先删代码、再加同义注释」在 `added` 口径下是**绿**的：`const x = 1` 改成 `// const x = 1`
 * 新增 1 行注释、删除 1 行代码，机械上就是「纯注释新增」。注释掉代码与加标注性注释
 * 在文本上没有区别，本判据分不开。要分开得引入 AST 级比对，不在 S0-5 范围内 —— 报出，不自己扩。
 *
 * 用法：
 *   node scripts/gates/verify-freeze.mjs [--check] [--json] [--base <ref>] [--repo <dir>]
 *   node scripts/gates/verify-freeze.mjs --selftest      # 反向验证判据还有没有牙
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const GATE = "verify-freeze"
const REPO_DEFAULT = path.resolve(import.meta.dirname, "../..")
const BASELINE_REL = "scripts/baseline/frozen-paths.json"

/** 三态退出码。数值不是自选：见文件头「为什么用 exit 3」。 */
const EXIT = { green: 0, red: 1, unjudged: 3 }

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const flagValue = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}

function git(repo, args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" }
}

/**
 * base（共同祖先）上某目录下**已跟踪**的文件清单。
 *
 * 只为一件事存在（ISS-865）：判「这个目录是不是本分支新建的」。
 * 空数组 = base 上该目录一个已跟踪文件都没有 ⇒ 目录是本次新建的，里面没有「老代码」，
 * 不该被「不得给老代码新增逻辑行」这条判据约束。
 *
 * ⚠️ 返回 `null` 表示**读不到**（base 解析失败 / git 退出非 0），调用方必须按「非新建」处理：
 * 读不到 ≠ 空。把「我读不到」当成「目录是新的」，等于给一条静默绕过路径
 * （`--base nosuchref` 能让所有目录都变成「新建」⇒ 判据全放行）。
 */
function trackedAtBase(repo, base, dir) {
  if (!base) return null
  const r = git(repo, ["ls-tree", "-r", "--name-only", base, "--", dir])
  if (r.code !== 0) return null
  return r.out.split("\n").filter(Boolean)
}

/**
 * 基线：哪些路径冻结、为什么冻结。
 * `frozen` 进判据（红/绿）；`advisory` **只报不红** —— 见 `frozen-paths.json` 的 `why` 字段。
 *
 * `base` 用于「本分支新建的目录」这一例外的判定（ISS-865）；传 null 时该例外整体失效（严格侧）。
 */
function readBaseline(repo, base) {
  const file = path.join(repo, BASELINE_REL)
  if (!fs.existsSync(file)) return { err: `基线缺席（${BASELINE_REL}）：没有对照物就没有结论` }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (e) {
    return { err: `基线不是合法 JSON（${BASELINE_REL}）：${e.message}` }
  }
  const frozen = Array.isArray(raw?.frozen) ? raw.frozen : null
  if (!frozen) return { err: `基线形状不对（${BASELINE_REL}）：缺 frozen 数组` }
  const prefixes = frozen.map((e) => String(e?.path ?? "").trim()).filter(Boolean)
  if (!prefixes.length) return { err: `基线形状不对（${BASELINE_REL}）：frozen 为空 —— 空分母会让本格恒绿` }
  const advisory = (Array.isArray(raw?.advisory) ? raw.advisory : []).map((e) => String(e?.path ?? "").trim()).filter(Boolean)

  // ── H1：冻结清单自身要有人看着 ────────────────────────────────────────────
  //
  // 审查员实测（2026-11-12）：把 frozen 从 39 组砍到 1 组，然后改 `forge-pm/lib/` ⇒ **EXIT=0**。
  // 即「把基线改小」是一条比改代码更省事的绕过路径，而且完全没有东西看着它 ——
  // `frozen-paths.json` 落在 advisory（只报不红），改它连黄灯都不亮。
  //
  // ⇒ 判据**从磁盘反推应有集合**，与清单双向对账（单向不够：被删掉的那条根本不会被遍历到）：
  //    应有集合 = 各包下 `lib|src|server/` 且有已跟踪文件的目录（与生成口径一致）
  //    ① 清单里有、磁盘上没了  ⇒ 红（幽灵条目）
  //    ② 磁盘上有、清单里漏了  ⇒ 红（**这就是「把清单改小」的形态**）
  // 新增包若带 lib/src，会落进 ② ⇒ 要求同步进清单（这是有意的：冻结范围不该悄悄变窄，
  // 变宽则必须显式）。S5 真正删包时，② 会因为目录消失而不成立，不会挡路。
  //
  // ⚠️ ② 有一个**合法的例外**（ISS-865）：本分支新建的包目录。
  // 判据语义是「不得给**老代码**新增逻辑行」，而新建目录里没有老代码 —— 它整体是本次新增的，
  // `added == 0` 在它身上天然不可能成立，却也不代表「改坏了老代码」。
  // 不加这个例外，任何新包首单必然卡死：不进 frozen ⇒ ② 判不了；进了 frozen ⇒ 新增行判红。
  // 例外收得很窄：只对「base 上 0 个已跟踪文件」的目录生效（见 `trackedAtBase`），
  // 从 frozen 里删掉一个**已有**包仍然落进 ②（H1 反例仍在，`--selftest` ⑮ 钉住）。
  const tracked = (p) => {
    const r = git(repo, ["ls-files", "--", p])
    return r.code === 0 && r.out.trim() ? r.out.split("\n").filter(Boolean) : []
  }
  const ghosts = prefixes.filter((p) => !fs.existsSync(path.join(repo, p)) || tracked(p).length === 0)
  if (ghosts.length) {
    return { err: `冻结清单里的路径对不上磁盘（${BASELINE_REL}）：${ghosts.join("、")} —— 目录不存在或没有已跟踪文件` }
  }

  // ② 反推：包列表取 `package.json` 的 workspaces（与生成时同一口径），子目录固定三类
  let expected = []
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"))
    for (const ws of Array.isArray(pkg?.workspaces) ? pkg.workspaces : []) {
      for (const sub of ["lib/", "src/", "server/"]) {
        const dir = `${ws}/${sub}`
        if (tracked(dir).length) expected.push(dir)
      }
    }
  } catch {
    // 读不到 package.json ⇒ 不判（不因为「我读不到」就判红，那是假红）。
    expected = null
  }
  if (expected) {
    const missing = expected.filter((d) => {
      if (prefixes.includes(d)) return false
      // ISS-865：「本分支新建的目录」不是「老代码」，它不受「added == 0」约束。
      // 判据 = base 上该目录下**一个已跟踪文件都没有** ⇒ 目录是本次新建的。
      // 取不到 base（或 ls-tree 读失败）⇒ 一律按「非新建」处理（fail-safe 取严格侧）。
      const atBase = trackedAtBase(repo, base, d)
      return atBase === null || atBase.length > 0
    })
    if (missing.length) {
      return {
        err:
          `冻结清单比磁盘窄（${BASELINE_REL}）：${missing.length} 个有已跟踪源码的目录没进 frozen —— ` +
          `${missing.slice(0, 5).join("、")}${missing.length > 5 ? " …" : ""}。` +
          `⇒ 「把清单改小」等于给改老代码开绿灯（审查员 H1 实测：39 组砍到 1 组后改 forge-pm/lib/ 判绿）。` +
          `确实要解除冻结，请在同一提交里写明理由，别只删条目`,
      }
    }
  }
  return { prefixes, advisory, frozen }
}

/**
 * 共同祖先。用 merge-base 而不是 `HEAD~1`：PR 上 `HEAD~1` 只看最后一个提交，
 * 一串提交里的中段改动会漏判；merge-base 给出「本分支相对 main 的全部改动」。
 */
function resolveBase(repo, explicit) {
  if (explicit) {
    const r = git(repo, ["rev-parse", "--verify", "--quiet", `${explicit}^{commit}`])
    return r.code === 0 && r.out.trim() ? r.out.trim() : null
  }
  for (const ref of ["origin/main", "main"]) {
    if (git(repo, ["rev-parse", "--verify", "--quiet", ref]).code !== 0) continue
    const mb = git(repo, ["merge-base", "HEAD", ref])
    if (mb.code === 0 && mb.out.trim()) return mb.out.trim()
  }
  return null
}

/**
 * 一行新增代码算不算「注释」。
 *
 * playbook §7 原话是「行首 `//` `*` `/*`」豁免。但 `*` 有两种身份：
 * 块注释续行（真注释）与乘号（真代码）。**判据只认前者，且只认「本次 diff 里看得见
 * `/*` 开头」的块** —— 见下面 `*` 的处置。
 *
 * ⚠️ 这里有两个**实测抓到过**的绕过洞，形状相同：一行「像注释」的文本把后文全部吞掉，
 * `added` 归零 ⇒ 判绿。两处入口都被独立踩到过，别再合并返回：
 *
 *   ① `//` 曾令 inBlock = true ⇒ 其后整份文件当注释放行。
 *      复现：`export const a=1` + `// 说明` + `export const evil=666` ⇒ 曾 EXIT=0（应 1）。
 *      修法：行注释**只吃自己这一行**，不开启块状态。
 *   ② `*` 曾**无条件**令 inBlock = true ⇒ 其后整份文件当注释放行。
 *      复现：`export const a=1` + `* 注释行` + `export const evil=666` + `evil2=667` ⇒ 曾 EXIT=0（应 1）。
 *      修法：`*` 在**看不见 `/*` 的地方一律算代码（红）**，不开启块状态。
 *
 * **为什么不回真实文件里查「这行是否在块注释内」**：
 * 那要自己扫「斜杠星」与「星斜杠」，而字符串字面量 `const s = "斜杠星"` 会开出一个**幻影块**
 * 把后文吞掉 —— 等于用一个更隐蔽的洞换掉现在的洞。`-U0` 只给改动行，看不到块起点，那就不认。
 * fail-safe 取严格侧：**要在旧树加块注释，请把 `/*` 一起加**（写成完整块，见 selftest ④）。
 * 代价是「给既有块注释补一行 `* 续行`」会被判红 —— 明确写在这里，不假装无害。
 */
/** 测试文件的「框架 import 行」—— ISS-505 的判据级窄例外（**只豁免这一种形态**）。
 *
 * ## 为什么需要这一格
 * 「废 bun:test 改 vitest」这个迁移**必然**要改测试文件的 import 行。而本判据原口径是
 * `added == 0`（纯注释才豁免）⇒ 518 个冻结区测试文件的 import 改写全部被判红。
 * 实测：那 518 条红 **100% 是 `.test.*` 的 import 行，非测试文件 0 条** ——
 * 即冲突点精确落在「换跑步器的接线行」上，不是产品逻辑。
 *
 * ## 为什么不放宽整条判据
 * 冻结的意图是「防老代码被改坏」。`import { describe } from "bun:test"` 改成 `"vitest"`
 * **不改变任何测试逻辑** —— 它换的是接线，不是行为。而挡住它的后果更坏：
 * 不迁移 ⇒ 别名永远删不掉 ⇒ 双测试框架永久并存。
 *
 * ## 口径（窄到什么程度）
 * ✅ `import { describe, expect, test } from "vitest"`  → 豁免
 * ✅ `import test from 'node:test'`                      → 豁免（同一族：换跑步器）
 * ✅ `const { describe } = require("vitest")`             → 豁免
 * ❌ `test("新用例", () => { ... })`                      → **不豁免**（新增测试 = 真增量）
 * ❌ 任何业务代码行                                        → **不豁免**
 *
 * ⚠️ 必须整行**以 import/require 开头**且**来源是测试框架**。不做「子串命中」：
 * 行内 `const x = 1; import ...` 不是行首 import ⇒ 不豁免（宁可漏放，不可误放）。
 *
 * 射程：**只对 `.test.*` 文件生效**。产品文件里即便出现 `from "vitest"`（不该有）也不因此豁免。
 *
 * 反向自检（`--selftest` ⑧⑨⑩ 三条钉住）：
 *   往冻结测试文件追加 `import { x } from "vitest"` ⇒ 仍绿
 *   往冻结测试文件追加 `test("probe", () => {})`   ⇒ 转红
 *   往冻结测试文件追加 `const EVIL = 666`          ⇒ 转红
 */
const FRAMEWORK_IMPORT = /^\s*(?:import\b[^;]*?\bfrom\s*|import\s*|(?:const|let|var)\s+[\w{}\s,:]+=\s*require\(\s*)["'](?:bun:test|vitest|node:test)["']/

function isFrameworkImportLine(line, file) {
  if (!/\.test\.(?:[cm]?[jt]sx?)$/.test(file)) return false
  return FRAMEWORK_IMPORT.test(line)
}

function isCommentLine(line, inBlock) {
  const t = line.trimStart()
  if (!t) return { ok: true, inBlock }
  if (inBlock) {
    if (t.includes("*/")) return { ok: true, inBlock: false }
    return { ok: true, inBlock: true }
  }
  if (t.startsWith("//")) return { ok: true, inBlock: false }
  if (t.startsWith("/*")) return { ok: true, inBlock: !t.includes("*/") }
  // 走到这里：`*` 已无豁免（曾在此 `return { ok: true, inBlock: true }`，即洞 ②）。
  return { ok: false, inBlock: false }
}

/** 取某文件相对 base 的新增行（`-U0` 只要改动块，不要上下文）。 */
function addedLinesOf(repo, base, file) {
  const d = git(repo, ["diff", "-U0", base, "--", file])
  if (d.code !== 0) return { err: d.err.trim() || `git diff 退出 ${d.code}` }
  // 二进制没有 + 行 ⇒ 按字面会被读成「0 行新增 ⇒ 绿」。见文件头「超出口径 ②」。
  if (/^Binary files .* differ$/m.test(d.out)) return { binary: true, lines: [] }
  const lines = []
  for (const raw of d.out.split("\n")) {
    if (raw.startsWith("+") && !raw.startsWith("+++")) lines.push(raw.slice(1))
  }
  return { lines }
}

/**
 * 判据本体（纯逻辑 + 注入 git 读数，好让 --selftest 能反证它真会红）。
 * 返回 { verdict: "green"|"red"|"unjudged", findings[] }
 */
function judgeChange(repo, base, prefixes, advisoryPrefixes) {
  const args = ["diff", "--name-status", "--no-renames", base, "--", ...prefixes]
  const ns = git(repo, args)
  if (ns.code !== 0) return { verdict: "unjudged", reason: `git diff 失败：${ns.err.trim() || `exit ${ns.code}`}` }

  const findings = []
  let scanned = 0
  for (const row of ns.out.split("\n")) {
    if (!row.trim()) continue
    const [status, ...rest] = row.split("\t")
    const file = rest.join("\t")
    // 纯删除 ⇒ 绿（playbook：「纯删除 → 绿」）。删除是在减代码，不违背「只读」。
    if (status === "D") {
      findings.push({ file, status, added: 0, kind: "deletion", ok: true })
      continue
    }
    scanned++
    const r = addedLinesOf(repo, base, file)
    if (r.err) return { verdict: "unjudged", reason: `${file}：${r.err}` }
    if (r.binary) {
      findings.push({ file, status, added: -1, kind: "binary", ok: false })
      continue
    }
    let inBlock = false
    const bad = []
    for (const line of r.lines) {
      const c = isCommentLine(line, inBlock)
      inBlock = c.inBlock
      if (c.ok) continue
      // ISS-505：测试文件的框架 import 行 → 不算逻辑行（见 isFrameworkImportLine 的口径）
      if (isFrameworkImportLine(line, file)) continue
      bad.push(line)
    }
    if (r.lines.length === 0) {
      // 状态非 D 但 diff 里一行 `+` 都没有 ⇒ 这个文件只删了行。
      // playbook「纯删除 → 绿」正是这一格：`M` 文件删掉几行、不加，`added == 0`，放行。
      // （`--selftest` 第 ⑤ 条钉住了它 —— 先前这里按「认不出 ⇒ 红」处理，把合法删除判成了红。）
      findings.push({ file, status, added: 0, kind: "deletion", ok: true })
    } else if (bad.length) {
      findings.push({ file, status, added: bad.length, kind: "logic", ok: false, sample: bad[0].slice(0, 80) })
    } else {
      findings.push({ file, status, added: 0, kind: "comment", ok: true })
    }
  }

  // 未跟踪文件：`git diff` 看不见它们，不补这一面等于一行就能绕过。见文件头「超出口径 ①」。
  const un = git(repo, ["ls-files", "--others", "--exclude-standard", "--", ...prefixes])
  if (un.code === 0) {
    for (const f of un.out.split("\n")) {
      if (!f.trim()) continue
      const body = (() => {
        try {
          return fs.readFileSync(path.join(repo, f), "utf8")
        } catch {
          return null
        }
      })()
      // 读不出（二进制 / 无权限）⇒ 按红；读得出就逐行判注释。
      let ok = body !== null
      let sample = ""
      if (body !== null) {
        let inBlock = false
        for (const line of body.split("\n")) {
          const c = isCommentLine(line, inBlock)
          inBlock = c.inBlock
          if (!c.ok) {
            ok = false
            sample = line.trim().slice(0, 80)
            break
          }
        }
      }
      scanned++
      findings.push({ file: f, status: "untracked", added: ok ? 0 : 1, kind: ok ? "comment" : "logic", ok, sample })
    }
  }

  // advisory：只报不红。脚本 / 文档 / 工具链仍在正常演进，冻死它们等于冻死重构本身。
  let advisory = []
  if (advisoryPrefixes.length) {
    const a = git(repo, ["diff", "--name-status", "--no-renames", base, "--", ...advisoryPrefixes])
    if (a.code === 0) advisory = a.out.split("\n").filter(Boolean)
  }

  const reds = findings.filter((f) => !f.ok)
  return { verdict: reds.length ? "red" : "green", findings, advisory, scanned }
}

function report(res, meta) {
  const L = []
  if (res.verdict === "unjudged") {
    L.push(`unjudged（${res.reason}）`)
    L.push(`  本格不判红也不判绿：没有对照物 / 没有共同祖先时，任何结论都是猜。`)
    console.log(L.join("\n"))
    return EXIT.unjudged
  }
  const reds = res.findings.filter((f) => !f.ok)
  if (res.verdict === "red") {
    L.push(`✗ ${GATE}: failed（${reds.length} 条）`)
    L.push(`  冻结路径被改：新增逻辑行 ≠ 0（判据 = git diff numstat added==0，纯注释/纯删除豁免）`)
    for (const f of reds) {
      const why = f.kind === "binary" ? "二进制改动（无法证明是纯注释）" : f.kind === "unreadable" ? "状态非删除却读不出新增行（认不出，按红）" : `新增 ${f.added} 行逻辑`
      L.push(`   · ${f.file}（${f.status}）— ${why}${f.sample ? `：${f.sample}` : ""}`)
    }
    L.push(`  修法：① 撤回这些改动（旧树冻结只读）；② 或改成纯注释；③ 或等新树接管后再删（纯删除是绿的）`)
  } else {
    L.push(`✓ ${GATE}: passed —— 冻结 ${meta.frozenCount} 组路径相对 ${meta.base.slice(0, 8)} 无新增逻辑行`)
    const comments = res.findings.filter((f) => f.kind === "comment" && f.added === 0 && f.status !== "D")
    const dels = res.findings.filter((f) => f.kind === "deletion")
    if (comments.length) L.push(`  豁免：${comments.length} 个文件只有注释新增`)
    // 老板口径（2026-11-12 定）：纯删除判绿，**但必须列出删了什么**。
    // 「放行：6 个文件纯删除」这种只报数字的行，等于把「删了哪 6 个」藏起来 ——
    // 整目录删光和删一行在屏幕上长得一样。放行必须可复核，否则「绿」不可读。
    if (dels.length) {
      L.push(`  放行：${dels.length} 个文件纯删除（必须逐条可见）`)
      for (const f of dels) L.push(`     ${f.status === "D" ? "删除整文件" : "仅删行"} ${f.file}`)
    }
  }
  if (res.advisory?.length) {
    L.push(`  · 只报不红（advisory，${res.advisory.length} 条）：脚本/文档面仍在演进，冻死它们等于冻死重构本身`)
    for (const row of res.advisory.slice(0, 5)) L.push(`     ${row}`)
    if (res.advisory.length > 5) L.push(`     … 另 ${res.advisory.length - 5} 条`)
  }
  console.log(L.join("\n"))
  return res.verdict === "red" ? EXIT.red : EXIT.green
}

// ─────────────────────────────────────────────────────────────────────────────
// --selftest：反向验证判据还有没有牙
//
// 不用「纯函数打桩」而用**真的临时 git 仓库**：打桩只能证明我想的那个式子成立，
// 证明不了 `git diff` 的实际形态被正确解析（`--no-renames`、未跟踪面、二进制面都在 git 侧）。
// 每条用例都是一次完整子进程调用，走的就是生产路径。
// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-freeze-2079-"))
  const sh = (args, cwd = tmp) => spawnSync("git", args, { cwd, encoding: "utf8" })
  const cases = []
  const push = (name, expect, actual, note = "") => cases.push({ name, expect, actual, note, ok: expect === actual })

  try {
    const G = ["-c", "user.email=selftest@local", "-c", "user.name=selftest"]
    sh(["init", "-q"])
    fs.mkdirSync(path.join(tmp, "scripts/baseline"), { recursive: true })
    fs.mkdirSync(path.join(tmp, "forge-pm/lib"), { recursive: true })
    fs.writeFileSync(
      path.join(tmp, BASELINE_REL),
      JSON.stringify({ frozen: [{ path: "forge-pm/lib/", why: "selftest" }], advisory: [{ path: "scripts/", why: "selftest" }] }, null, 2),
    )
    const target = path.join(tmp, "forge-pm/lib/x.js")
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    sh([...G, "add", "-A"])
    sh([...G, "commit", "-qm", "base"])

    const runGate = (base = "HEAD") => {
      const r = spawnSync(process.execPath, [path.join(REPO_DEFAULT, "scripts/gates/verify-freeze.mjs"), "--check", "--base", base, "--repo", tmp], { cwd: tmp, encoding: "utf8" })
      return r.status
    }

    // ① 绿：冻结路径没动
    push("绿 · 冻结路径未改动", EXIT.green, runGate())

    // ② 红：改 1 行逻辑
    fs.writeFileSync(target, "export const a = 1\nexport const b = 999\n")
    push("红 · 改 1 行逻辑", EXIT.red, runGate())

    // ③ 绿：只加注释（行首 //）
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n// 迁移说明：本文件由新树 forge-pm-next 接管\n")
    push("绿 · 行注释新增", EXIT.green, runGate())

    // ④ 绿：只加块注释（`*` 续行）
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n/*\n * 迁移说明：同上\n */\n")
    push("绿 · 块注释新增", EXIT.green, runGate())

    // ⑤ 绿：纯删除（删一行，不加）
    fs.writeFileSync(target, "export const a = 1\n")
    push("绿 · 纯删除", EXIT.green, runGate())

    // ⑥ 红：未跟踪的新文件落进冻结路径（`git diff` 看不见，必须另判）
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    fs.writeFileSync(path.join(tmp, "forge-pm/lib/brand-new.js"), "export const sneaky = 1\n")
    push("红 · 未跟踪新文件", EXIT.red, runGate())
    fs.rmSync(path.join(tmp, "forge-pm/lib/brand-new.js"))

    // ⑦ 红：`*` 开头的行**不开启块状态**。
    //
    // ⚠️ 这条输入必须只有 `*` 一个红源 —— 曾经写成
    //     `export const c = a` + `  * b`（乘法号），那条**自带独立红源**（`export const c` 本身就红），
    //     于是把 `*` 分支改坏后它照样报红 ⇒ 测的是旁边那件事，不是 `*` 分支（审查员 C2 实测：
    //     去掉那行独立红源后 `✗ 期望 exit 1，实得 0`）。
    //     现在输入里除 `*` 行外**没有任何可判红的行**：`a`/`b` 与基线逐字相同，新增行只有 `* 注释行`
    //     与紧跟其后的两行逻辑 —— 若 `*` 被当成块开头，后两行被吞掉、`added==0` ⇒ 绿（就是洞 ②）。
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    sh([...G, "commit", "-qam", "reset-for-7"])
    fs.writeFileSync(target, "export const a = 1\n* 注释行\nexport const evil=666\nevil2=667\n")
    push("红 · `*` 行不吞后文（洞 ②：* 曾无条件进块）", EXIT.red, runGate())

    // ⑦c 绿：**完整**块注释（`/*` 与本行 `*/` 都在本次新增内）仍然豁免 —— 收紧 `*` 不能把
    // 合法块注释一起判红。它与 ④ 的区别：④ 是整块三行都新增，这里只验「`/*` 在场才认」。
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    sh([...G, "commit", "-qam", "reset-for-7c"])
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n/* 迁移说明：新树接管 */\n")
    push("绿 · 完整块注释（`/*` 在场）仍豁免", EXIT.green, runGate())

    // ⑦b 红：行注释**不开启**块状态。
    // 这是实测抓到的真后门：`//` 曾令 inBlock = true ⇒ 其后整份文件被当成注释放行。
    // 同样只留 `//` 一个红源（同 ⑦ 的教训：别让输入自带独立红源，否则测不到本支）。
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    sh([...G, "commit", "-qam", "reset-for-7b"])
    fs.writeFileSync(target, "export const a = 1\n// 说明\nexport const b = 2\nconst sneaky = 1\n")
    push("红 · 行注释不吞后文（洞 ①：// 曾进块）", EXIT.red, runGate())

    // ⑦d 红：**二进制改动**算红（裁决 ② 要求补的 selftest 例）。
    // 按 playbook 字面「added==0 ⇒ 绿」，二进制 diff 里一个 `+` 行都没有 ⇒ 会被读成绿。
    // 无法证明二进制变化是「纯注释」，按红处理（fail-safe）。
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    sh([...G, "commit", "-qam", "reset-for-7d"])
    fs.writeFileSync(target, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]))
    push("红 · 二进制改动", EXIT.red, runGate())
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    sh([...G, "commit", "-qam", "reset-after-7d"])

    // ⑧ 判不了：基线坏掉
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    const goodBaseline = fs.readFileSync(path.join(tmp, BASELINE_REL), "utf8")
    fs.writeFileSync(path.join(tmp, BASELINE_REL), "{ not json")
    push("判不了 · 基线不是合法 JSON", EXIT.unjudged, runGate())

    // ⑨ 判不了：基线缺 frozen（空分母会让本格恒绿）
    fs.writeFileSync(path.join(tmp, BASELINE_REL), JSON.stringify({ advisory: [] }))
    push("判不了 · 基线缺 frozen", EXIT.unjudged, runGate())

    // ⑩ advisory 只报不红：改 scripts/ 下的文件不该红
    fs.writeFileSync(path.join(tmp, BASELINE_REL), goodBaseline)
    fs.mkdirSync(path.join(tmp, "scripts/gates"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "scripts/gates/other.mjs"), "// x\n")
    push("绿 · advisory 面（scripts/）只报不红", EXIT.green, runGate())

    // ⑪ 判不了：base 不存在
    const rBad = spawnSync(process.execPath, [path.join(REPO_DEFAULT, "scripts/gates/verify-freeze.mjs"), "--check", "--base", "no-such-ref", "--repo", tmp], { cwd: tmp, encoding: "utf8" })
    push("判不了 · base 引用不存在", EXIT.unjudged, rBad.status)

    // ⑫ 判不了：**冻结清单被改小**（H1）。
    // 审查员实测：39 组砍到 1 组后改老包 ⇒ EXIT=0。这是比改代码更省事的绕过 ——
    // 清单自己落在 advisory（只报不红），改它连黄灯都不亮。现在靠「磁盘反推」兜住。
    // 玩法：造一个真实存在的 lib 目录，但不写进 frozen ⇒ 清单比磁盘窄 ⇒ 判不了（3）。
    fs.mkdirSync(path.join(tmp, "forge-other/lib"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "forge-other/lib/y.js"), "export const y = 1\n")
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ workspaces: ["forge-pm", "forge-other"] }))
    sh([...G, "add", "-A"])
    sh([...G, "commit", "-qm", "add-forge-other"])
    push("判不了 · 冻结清单比磁盘窄（H1：砍清单即绕过）", EXIT.unjudged, runGate())

    // ⑫b 补回清单后恢复绿：证明 ⑫ 红的是「清单窄」这件事本身，不是目录多了一个
    const narrowed = JSON.parse(fs.readFileSync(path.join(tmp, BASELINE_REL), "utf8"))
    narrowed.frozen.push({ path: "forge-other/lib/", why: "selftest" })
    fs.writeFileSync(path.join(tmp, BASELINE_REL), JSON.stringify(narrowed, null, 2))
    push("绿 · 清单补齐后恢复绿（证明 ⑫ 判的是清单而非目录）", EXIT.green, runGate())

    // ── ISS-505：框架 import 窄例外的三态自检 ──────────────────────────────────
    // 这一组钉的是「豁免到底有多窄」。没有它，谁把 FRAMEWORK_IMPORT 放宽成子串匹配
    // （比如去掉行首 `^` 或去掉 .test.* 射程），判据会静默变成「任何提到 vitest 的行都放行」，
    // 而屏幕上依然是全绿 —— 那正是本仓反复记的那一族「判据被钝化而没人知道」。
    const frozenTest = path.join(tmp, "forge-pm/lib/a.test.js")
    const TS_HEAD = 'import { describe, expect, test } from "vitest"\nexport const a = 1\n'
    fs.writeFileSync(frozenTest, TS_HEAD)
    sh([...G, "add", "-A"])
    sh([...G, "commit", "-qm", "add-frozen-test"])
    push("绿 · 冻结测试文件改框架 import 行（ISS-505 窄例外）", EXIT.green, runGate())

    // 反例①：新增一条 test() —— 那是真增量，必须红
    fs.writeFileSync(frozenTest, TS_HEAD + 'test("probe", () => {})\n')
    push("红 · 冻结测试文件新增 test() 用例（豁免只认 import 行）", EXIT.red, runGate())

    // 反例②：新增业务代码行 —— 同样必须红
    fs.writeFileSync(frozenTest, TS_HEAD + "const EVIL = 666\n")
    push("红 · 冻结测试文件新增业务代码行（豁免不覆盖逻辑）", EXIT.red, runGate())

    // 反例③：产品文件里的同名 import 不享受豁免 —— 证明射程限 .test.*
    const prodFile = path.join(tmp, "forge-pm/lib/prod.js")
    fs.writeFileSync(prodFile, 'export const a = 1\nimport { x } from "vitest"\n')
    push("红 · 产品文件里出现 vitest import 仍判红（射程限 .test.*）", EXIT.red, runGate())

    // ── ISS-865：「本分支新建的包目录」不是老代码，不该被「不得新增逻辑行」约束 ─────
    //
    // 这一组钉的是**例外到底有多窄**。没有它，最省事的「修法」是把 `missing` 判定整个删掉
    // （就是说「清单窄了也放行」）—— 那时 H1 反例复活而屏幕上全绿，正是本仓反复记的
    // 「判据被钝化而没人知道」。三条用例各自钉住一面：
    //   ⑬ 真新建 ⇒ 不再判不了（本单要解决的）
    //   ⑭ 同一提交里改老包 ⇒ 仍红（例外不遮蔽老包的判红）
    //   ⑮ 从 frozen 删掉**已有**包 ⇒ 仍判不了（H1 反例不因例外而失效）
    // ⚠️ 先清掉前面几条用例留下的红源：`prodFile` 是**未跟踪**新文件（未跟踪面一律算红），
    //    `frozenTest` 还停在「新增业务代码行」那份内容上。不清理，下面 ⑬ 会因为**上游用例的残留**
    //    而判红 —— 那测的是上一格，不是新包这一格（同 ⑦ 记过的教训：输入必须只有一个红源）。
    fs.rmSync(prodFile, { force: true })
    fs.writeFileSync(frozenTest, TS_HEAD)
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    sh([...G, "add", "-A"])
    sh([...G, "commit", "-qam", "reset-before-2228"])
    const baseBeforeNewPkg = sh([...G, "rev-parse", "HEAD"]).stdout.trim()

    fs.mkdirSync(path.join(tmp, "forge-new/lib"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "forge-new/lib/z.js"), "export const z = 1\nexport const zz = 2\n")
    const pkgNew = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8"))
    pkgNew.workspaces = [...pkgNew.workspaces, "forge-new"]
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify(pkgNew))
    sh([...G, "add", "-A"])
    sh([...G, "commit", "-qm", "new-package-first-landing"])

    // ⑬ base 上 forge-new/lib 一个已跟踪文件都没有 ⇒ 目录是本次新建的 ⇒ 不进 missing ⇒ 绿。
    //    修前这一格是 **3（判不了）**：新包首单必然卡死（ISS-861 的实测形态）。
    push("绿 · 新包首单（base 上无该目录 ⇒ 不因清单窄判不了）", EXIT.green, runGate(baseBeforeNewPkg))

    // ⑭ 同一个 base 下改老包一行：新包的豁免**不得**遮蔽老的判红。
    //    修法若写成「missing 恒空 + 其它分支跟着松」，这一格会绿 —— 必须红。
    fs.writeFileSync(target, "export const a = 1\nexport const b = 999\n")
    push("红 · 新包同提交里改老包一行（例外不遮蔽老包）", EXIT.red, runGate(baseBeforeNewPkg))
    fs.writeFileSync(target, "export const a = 1\nexport const b = 2\n")
    sh([...G, "commit", "-qam", "reset-after-2228-14"])

    // ⑮ 从 frozen 里删掉一个 **base 上已有跟踪文件** 的包（forge-other/lib）⇒ 仍判不了。
    //    这是「把清单改小」的原始形态（H1）。豁免只对「base 上 0 文件」的目录生效，
    //    所以 forge-other/lib 落不进豁免 ⇒ 照旧判不了。
    const beforeDelEntry = sh([...G, "rev-parse", "HEAD"]).stdout.trim()
    const narrowedAgain = JSON.parse(fs.readFileSync(path.join(tmp, BASELINE_REL), "utf8"))
    narrowedAgain.frozen = narrowedAgain.frozen.filter((e) => e.path !== "forge-other/lib/")
    fs.writeFileSync(path.join(tmp, BASELINE_REL), JSON.stringify(narrowedAgain, null, 2))
    sh([...G, "commit", "-qam", "narrow-frozen-by-deleting-entry"])
    push("判不了 · 从 frozen 删掉已有包（H1 反例不因 ISS-865 例外失效）", EXIT.unjudged, runGate(beforeDelEntry))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  const failed = cases.filter((c) => !c.ok)
  for (const c of cases) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.name} —— 期望 exit ${c.expect}，实得 ${c.actual}`)
  }
  console.log("")
  if (failed.length) {
    console.log(`✗ ${GATE} --selftest: ${failed.length}/${cases.length} 条不符 —— 判据本身坏了`)
    return EXIT.red
  }
  console.log(`✓ ${GATE} --selftest: ${cases.length}/${cases.length} 条通过（绿 / 红 / 判不了 三态均有样本）`)

  // ── 已知存量红（不写死成「应该红」，只做「背景说明 + 收口指针」）─────────────────
  //
  // 为什么要在这里说一句：在真仓上跑 `--check` 会看到一批红。如果跑 `--selftest` 的人
  // 只看到「20/20 全过」、随后跑 `--check` 看到红的，第一反应会是「判据坏了」——
  // 于是去调宽判据，反而把真红放跑。这里把「这些红是什么、归谁收」写在他眼前。
  //
  // ⚠️ 刻意**不**把数字写成断言（`assert(red === 32)`）：
  //    那等于把债固化成特性 —— 数字降下去（有人把某几个文件改回纯注释）反而会判「不符」。
  //    这里只陈述「截至该单收尾时实测到 N 条，收口见某单」，数字变了不红。
  //
  // 当前背景（2026-11-14 实测，`--check` 口径）：
  //   · 总数 518 → 框架 import 窄例外放行后真红 32 条（全 kind=logic，0 条 comment）
  //   · 32 条全部来自 ISS-505（废 bun:test 改 vitest）：断言改写 / Bun.* 换等价物 /
  //     bun:sqlite 双引擎 / 路径锚定 / vi.mock —— 是真改了测试逻辑，不是漏改 import 行
  //   · 收口单：ISS-826（列 notFrozen / 或改「测试文件该不该冻结」的判定口径，由后续定）
  try {
    const r = spawnSync(process.execPath, [path.join(REPO_DEFAULT, "scripts/gates/verify-freeze.mjs"), "--check", "--json"], {
      cwd: REPO_DEFAULT,
      encoding: "utf8",
    })
    const j = JSON.parse(r.stdout || "{}")
    const red = (j.findings ?? []).filter((f) => f && f.ok === false)
    if (red.length) {
      const logic = red.filter((f) => f.kind === "logic").length
      console.log("")
      console.log(`ℹ 提示（不是失败）：真仓当前有 ${red.length} 条**已知存量红**（kind=logic ${logic} 条）。`)
      console.log(`  来源：ISS-505「废 bun:test 改 vitest」—— 断言改写 / Bun.* 换等价物 / bun:sqlite 双引擎 /`)
      console.log(`        vi.mock 等，是**真改了测试逻辑**，不是漏改 import 行（那批已被窄例外放行）。`)
      console.log(`  收口单：ISS-826。本判据没坏；上面 ${cases.length} 条自检才是判它健康与否的依据。`)
    }
  } catch {
    // 读不到真仓（例如在别的 repo 里跑 selftest）就跳过，不影响自检结论
  }
  return EXIT.green
}

// ─────────────────────────────────────────────────────────────────────────────
function main() {
  if (hasFlag("--selftest")) {
    process.exitCode = selftest()
    return
  }
  const repo = path.resolve(flagValue("--repo") ?? REPO_DEFAULT)
  const base = resolveBase(repo, flagValue("--base"))
  const bl = readBaseline(repo, base)
  if (bl.err) {
    if (hasFlag("--json")) console.log(JSON.stringify({ gate: GATE, verdict: "unjudged", reason: bl.err }, null, 2))
    else {
      console.log(`unjudged（${bl.err}）`)
      console.log(`  本格不判红也不判绿 —— 没有冻结清单时，「冻结只读」等于没有判据。`)
    }
    process.exitCode = EXIT.unjudged
    return
  }
  if (!base) {
    const reason = "定位不到共同祖先（origin/main / main 都不存在？）—— 没有对照点就算不出新增行"
    if (hasFlag("--json")) console.log(JSON.stringify({ gate: GATE, verdict: "unjudged", reason }, null, 2))
    else console.log(`unjudged（${reason}）`)
    process.exitCode = EXIT.unjudged
    return
  }
  const res = judgeChange(repo, base, bl.prefixes, bl.advisory)
  if (hasFlag("--json")) {
    console.log(JSON.stringify({ gate: GATE, base, ...res }, null, 2))
    process.exitCode = res.verdict === "unjudged" ? EXIT.unjudged : res.verdict === "red" ? EXIT.red : EXIT.green
    return
  }
  process.exitCode = report(res, { base, frozenCount: bl.prefixes.length })
}

main()
