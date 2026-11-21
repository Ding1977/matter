#!/usr/bin/env node
/* forge-pm 全量套件「跑门的那个模式，且两遍与绝对锚都对得上」守卫（ISS-660 复核后重写）
 *
 * 一句话：用**门实际跑的命令**（`bun run test`）跑两遍，两遍都 0 fail / 0 error、逐项数值相同，
 * 并且**每个测试文件都必须出现在结果里**。
 *
 * ── ⛔ ISS-833：本判据的**设计前提已失效，当前恒为「判不了」（exit 3）**
 * 下面所有「`bun run test` = `bun test --isolate`」的说法都是**历史**（ISS-505 之前的事实）。
 * ISS-505 起 forge-pm 的 test 脚本换成了 `vitest run --root .. "forge-pm"`，而本脚本的
 * `parseSummary()` 只认 bun 的汇总格式 ⇒ 四个数值字段全读不到、169 个文件被误报成「没出现」。
 * ⇒ 现在由文件下半部的入口守卫按包脚本内容直接退 3（判不了），**不跑那两遍**。
 * ⇒ **本文件下半部（解析器 + 两遍 + 绝对锚）当前一行都不执行**，留着是因为它对「test = bun test
 *    的包」仍然正确；要复用请连同 `parseSummary()` 一起搬，别只搬一半。
 * 台账：`scripts/baseline/unjudged-ledger.json` 的 `check-pm-suite-twice`（`designed` · 票 ISS-833）。
 * 为什么不再往前修：forge-pm 是绞杀对象（旧树 `forge-<包>/lib|src` 在 `frozen-paths.json` 冻结只读），
 * 老板 2026-11-14 裁决「不纠缠旧代码」。要做同口径判据请投给新树。
 *
 * ── 为什么要这条闸（背景留档，口径已按复核收窄）
 * 本单修的是 `forge-pm/lib/routes-register-probe.test.js`（与 `member-list-contract.test.js`）里
 * 「stub 宿主收下 effect 却丢掉卸载函数」的泄漏：
 *   · **env 泄漏（最可能是主因）**：`FORGE_PM_ROOT` 被永久改成临时根 ⇒ 同进程后续文件按错根解库 ⇒
 *     相邻文件断言红（只说"最可能"：**没做过「只留 env、去掉定时器」的对照**，与下面定时器那条同等待遇）；
 *   · **定时器泄漏（真实，但归因未证）**：apply 的 `setTimeout(tick, 3000)` 会打到已关闭的库并抛
 *     `RangeError: Cannot use a closed database`；但「抛出 ⇒ 运行器跨文件崩 ⇒ 下一个文件的测试整批消失」
 *     **未获证实**（复核的 4 个合成变体 + 真实三文件套件在 bun 下都是 0 error / 测试一条不少）。
 * ⇒ 本闸**不替那次归因背书**：它只判三件机器事实 —— 命令与门同源、两遍一致、一条测试都不许凭空消失。
 *
 * ── 为什么必须跑「门的命令」（复核抓到的第一个错）
 * 上一版跑的是 `bun test`（**无 --isolate**），而包脚本与 CI 都是 `bun test --isolate`。
 * 官方语义：`--isolate` 下「一个文件泄漏的 handle 不影响另一个文件」⇒ 跨文件污染**在门实际跑的
 * 模式下结构上不该发生**；拿另一种模式去验门，等于验了个门根本不会遇到的病。
 * 本版直接跑包脚本（`bun run test`），与门实际跑的那条命令同源。
 * ⚠️ ISS-833 更正：原句写「与 ci.yml 那一步逐字同源」——**ci.yml 里没有跑测试的 step**。
 *    2026-11-13 起远程只跑 `secret-scan`，门禁全交本地（pre-commit / pre-push → run-gates）。
 *    真正同源的是 registry 的 `ci-test-pm` 格（`bun run test`，见 scripts/gates/registry.json）。
 *
 * ── 为什么要「绝对锚」（复核抓到的第二个错）
 * 只做两遍互比，「稳定地少跑」抓不到：某文件的测试永不注册、或有人删掉一个文件，两遍一致 ⇒ 假绿。
 * 故加三条绝对判据（每遍单独判）：
 *   ① 扫包内测试文件（排除 node_modules / dist / 备份），**每个都必须以 `<相对路径>:` 的形式出现在结果里**；
 *   ② `Ran N tests across M files` 的 M 必须等于扫到的文件数；
 *   ③ 文件数不得低于 MIN_FILES（只许增不许减：减少 = 有文件不再被跑，或被人删了）。
 *
 * ── 上游格式耦合（换 bun 大版本要来看的两处，别当成本脚本的 bug）
 *   · 逐文件表头匹配（`\n<相对路径>:\n`）与 `tests ≥ files` 都依赖 `bun test` 的汇总/表头格式；
 *     升级 bun 后它们要跟着调。
 *     ⚠️ ISS-833：入口守卫只挡「test 脚本已不是 bun test」这一种；**同是 bun test 但格式变了**它挡不住，
 *        会退回「四个字段全 ?」的假红。改格式时请连同 `parseSummary()` 一起改。
 *   · `discoverTestFiles()` 只认 `.test.{ts,tsx,js,mjs,cjs}`。**将来出现 `*.spec.ts`，这里与上面的
 *     表头判据要同步** —— 否则"扫到的文件数"会少算，`Ran ... across M files` 的相等判据就会误红。
 *
 * ── 判据（缺一条就红）
 *   ① 两遍退出码都是 0；② 两遍 `0 fail`、`0 error`（error 行缺省即 0）；
 *   ③ 两遍 pass / tests / files / expects 逐项相同；④ 上面三条绝对锚成立。
 * ⚠️ 只比**数值**不比时间：耗时天然抖动，拿它当判据就是给自己造假红。
 *
 * ── 用法
 *   node scripts/check-pm-suite-twice.mjs            # 判据（CI / ci-local 用）
 *   node scripts/check-pm-suite-twice.mjs --verbose  # 额外打印两遍汇总行
 *   FULL=1 node scripts/check-pm-suite-twice.mjs     # 失败时把两遍完整输出也打出来（排障用）
 * 退出码：0 = 通过；2 = 不一致 / 有红 / 绝对锚不成立；3 = 跑不起来（bun 不在 PATH / 包不存在）
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { bunBin } from "./lib/bun-bin.mjs"

const ROOT = path.resolve(import.meta.dirname, "..")
const PKG = path.join(ROOT, "forge-pm")
const ARGV = process.argv.slice(2)
const VERBOSE = ARGV.includes("--verbose")
const FULL = process.env.FULL === "1"
/* ISS-816：bun 只查一次，查的判据是「能不能真跑」（见 lib/bun-bin.mjs）。
 * 旧写法直接 `spawnSync("bun", ...)` 靠 PATH，本机把 bun 装在 `~/.bun/bin` 时就起不来 ——
 * 那是「这台机器没跑成」，不是「套件不一致」，故下面按 exit 3（判不了）退，不冒充红。 */
const BUN = bunBin()
/* 命中绝对路径时还得把它的目录补进 PATH：跑的是**包脚本** `test: "bun test --isolate"`，
 * 那串命令由 bash 执行，里面的裸 `bun` 会**再按 PATH 找一次** ⇒ 实测 exit 127
 * （`$ bun run test` / `/bin/bash: bun: command not found`）。只给 spawnSync 绝对路径不够。 */
const BUN_ENV = BUN && BUN !== "bun" ? { ...process.env, PATH: `${path.dirname(BUN)}${path.delimiter}${process.env.PATH ?? ""}` } : process.env

/* 绝对锚（只许增不许减）：新增测试文件不用动 MIN_FILES；**删文件必须显式解释并改这个数**。
 * 为什么需要绝对锚：只做两遍互比抓不到「稳定地少跑」（某文件的测试永不注册 / 有人删了文件，两遍一致就绿）。 */
const MIN_FILES = 142
/* 条数绝对锚：`MIN_FILES` 与逐文件表头都挡不住「文件还在、测试却整体不注册」那种形态 ——
 * 复核实测：把某文件所有 test 包进 `if (false)` 后，bun **照样**打印 `<相对路径>:` 表头，且
 * `Ran N tests across M files` 的 M 不变 ⇒ 前三条锚全过、守卫仍是绿。条数掉多少都算红。 */
const MIN_PASS = 1801

if (!fs.existsSync(path.join(PKG, "package.json"))) {
  console.error(`✗ 找不到 ${path.relative(ROOT, PKG)}/package.json —— 守卫无从判起（fail-closed）`)
  process.exit(3)
}

/* ── ISS-833：运行器换了 ⇒ 本判据判不了，如实退 3（不冒充红，也不冒充绿）
 *
 * 本脚本的解析器（`parseSummary`）只认 `bun test` 的汇总格式：`N pass` / `Ran N tests across M files` /
 * `N expect() calls` / 逐文件 `\n<路径>:\n` 表头。ISS-505 起 forge-pm 的 `test` 脚本是
 * `vitest run --root .. "forge-pm"` ⇒ 上面每一条都匹配不上，四个数值字段全 `?`，
 * 而「逐文件表头」判据会把 **全部** 169 个文件报成「没出现在结果里」。
 * 屏幕上是「套件坏了」，实际是**解析器不认识新格式** —— 那不是红，是判不了。
 *
 * 为什么在**跑之前**判，而不是跑完看 a.pass === null：
 *   两遍要烧 ~180s。跑完才知道「我一个字段都没读出来」，等于花三分钟换来一句「判不了」。
 *   而「门跑的到底还是不是 bun test」是**跑之前就能确定性回答**的问题（读包脚本即可）。
 *
 * ⚠️ 口径：exit 3 = 判不了（见 lib/run-gates-verdict.mjs 的 livecheck：0 绿 / 3 判不了 / ≥2 红）。
 *   **绝不能用 exit 0**（那是「假装判过了」），也**不能用 exit 2**（那是「套件真不一致」）。
 *   台账见 scripts/baseline/unjudged-ledger.json 的 check-pm-suite-twice 条（unjudgedKind: designed）。
 *
 * ⚠️ 已知边界：若将来仍是 `bun test` 而**汇总格式**变了（升 bun 大版本），这里判不出来，
 *   会退回「四个字段全 ?」的假红。那时要看本文件头注的「上游格式耦合」两条。
 *   没在这里一并兜住，是因为「跑完再判一次 null」会成为第二套并行路径，而它跑起来才可能命中 ——
 *   老板 2026-11-14 裁决「不要过度设计」，故只保留确定性最高的那一道。 */
const TEST_SCRIPT = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).scripts?.test ?? ""
  } catch {
    return ""
  }
})()
if (!/^\s*bun\s+test\b/.test(TEST_SCRIPT)) {
  console.error("! 判不了：本判据解析 `bun test` 的汇总格式，而 forge-pm 的 test 脚本已经不是它")
  console.error(`  实际 test = ${JSON.stringify(TEST_SCRIPT) || "（无 test 脚本）"}`)
  console.error("  基线 = f(运行器版本)；旧树（forge-pm）是绞杀对象，不在此投力。见 ISS-833")
  process.exit(3)
}

/** 扫包内测试文件（相对 forge-pm 的路径）。排除 node_modules / dist / 编辑器备份 —— 与 bun 的发现口径对齐。 */
function discoverTestFiles() {
  const out = []
  const SKIP_DIR = new Set(["node_modules", "dist", "out", ".git", ".wt", "assets"])
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(p)
      } else if (/\.test\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !/~\d{3,}$/.test(e.name)) {
        out.push(path.relative(PKG, p))
      }
    }
  }
  walk(PKG)
  return out.sort()
}

/** 解析 bun test 汇总。`error` 行只在有错时出现 ⇒ 缺省当 0；`files?` 认单复数（单文件包会给 "1 file"）。 */
function parseSummary(out) {
  const grab = (re) => {
    const m = re.exec(out)
    return m ? m[1] : null
  }
  return {
    pass: grab(/^\s*(\d+) pass$/m),
    fail: grab(/^\s*(\d+) fail$/m),
    errors: grab(/^\s*(\d+) errors?$/m) ?? "0",
    tests: grab(/^Ran (\d+) tests across/m),
    files: grab(/^Ran \d+ tests across (\d+) files?\b/m),
    expects: grab(/^\s*(\d+) expect\(\) calls/m),
  }
}

/** 跑**门的那条命令**：包脚本 `bun run test`（与 registry 的 `ci-test-pm` 格同源）。
 *  ISS-833：这里原本写「⇒ `bun test --isolate`，与 ci.yml 逐字同源」，两句都已过期 ——
 *  test 脚本随 ISS-505 换成 vitest，ci.yml 自 2026-11-13 起不跑测试。见文件头注。 */
function runOnce(tag) {
  const t0 = Date.now()
  const r = spawnSync(BUN, ["run", "test"], { cwd: PKG, encoding: "utf8", maxBuffer: 1 << 28, env: BUN_ENV })
  const out = `${r.stdout || ""}${r.stderr || ""}`
  const code = r.status ?? 1
  const ms = Date.now() - t0
  if (r.error) return { tag, code, out, ms, error: String(r.error.message || r.error) }
  return { tag, code, out, ms, ...parseSummary(out) }
}

const files = discoverTestFiles()
if (files.length === 0) {
  console.error("✗ 一个测试文件都没扫到 —— 守卫在空转（fail-closed）")
  process.exit(3)
}
/* ISS-816：bun 缺席就**当场**退 3（判不了），不进两遍循环。
 * 以前是带着一个不存在的命令跑两遍、攒出 169 条「文件没出现在结果里」，再 exit 2 ——
 * 屏幕上一片像「套件坏了」的红字，实际是「这台机器没装 bun」。判据的射程被误报掩盖了。 */
if (!BUN) {
  console.error("✗ bun 起不来（PATH 与 ~/.bun/bin/bun 都跑不出 --version）—— 本机没跑成 = 判不了，不是不一致")
  process.exit(3)
}
const a = runOnce("第 1 遍")
const b = runOnce("第 2 遍")

const fmt = (r) =>
  `pass=${r.pass ?? "?"} fail=${r.fail ?? "?"} errors=${r.errors ?? "?"} tests=${r.tests ?? "?"} files=${r.files ?? "?"} expect=${r.expects ?? "?"} exit=${r.code} ${Math.round(r.ms / 100) / 10}s`

if (VERBOSE) for (const r of [a, b]) console.log(`  ${r.tag}：${fmt(r)}`)

/** 某个文件的测试是否真的出现在结果里（bun 打印 `<相对路径>:` 表头）。 */
const appears = (out, rel) => out.includes(`\n${rel}:\n`)

const problems = []
if (a.error || b.error) problems.push(`bun 起不来：${a.error || b.error}`)
for (const r of [a, b]) {
  if (r.code !== 0) problems.push(`${r.tag}退出码 ${r.code}（必须 0）`)
  if (r.fail !== "0") problems.push(`${r.tag} fail=${r.fail ?? "读不到"}`)
  if (r.errors !== "0") problems.push(`${r.tag} errors=${r.errors}`)
  /* 绝对锚 ①②③：每遍都单独判 —— 「稳定地少跑」也要红。 */
  const missing = files.filter((rel) => !appears(r.out, rel))
  if (missing.length) {
    problems.push(
      `${r.tag} 有 ${missing.length} 个文件的测试没出现在结果里：${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}`,
    )
  }
  if (r.files !== null && Number(r.files) !== files.length) {
    problems.push(`${r.tag} 文件数 ${r.files} ≠ 扫到的测试文件数 ${files.length}（有文件没被跑 / 结果里多出文件）`)
  }
  if (r.files !== null && Number(r.files) < MIN_FILES) {
    problems.push(`${r.tag} 只跑了 ${r.files} 个文件 < 绝对锚 ${MIN_FILES}（有文件不再被跑，或被人删了 —— 别顺手调低这个数）`)
  }
  if (r.tests !== null && r.files !== null && Number(r.tests) < Number(r.files)) {
    problems.push(`${r.tag} tests(${r.tests}) < files(${r.files})：有文件一条测试都没跑`)
  }
  if (r.pass !== null && Number(r.pass) < MIN_PASS) {
    problems.push(
      `${r.tag} 只跑了 ${r.pass} 条 < 绝对锚 ${MIN_PASS}（一个测试都没注册的文件照样会打表头 —— 条数掉了就是有测试消失）`,
    )
  }
}
for (const k of ["pass", "fail", "errors", "tests", "files", "expects"]) {
  if (a[k] !== b[k]) problems.push(`两遍 ${k} 不同：${a[k]} vs ${b[k]}（顺序决定红绿 ⇒ 还有跨文件状态在起作用）`)
}

if (problems.length === 0) {
  console.log(
    `✓ forge-pm 全量（门的命令 bun run test = --isolate）连跑两次：${a.pass} pass / 0 fail / 0 error · ` +
      `${a.tests} tests across ${a.files} files · 每个测试文件都在结果里 · 条数 ≥ 锚 ${MIN_PASS} / 文件数 ≥ 锚 ${MIN_FILES} · 两遍逐项相同`,
  )
  process.exit(0)
}

console.error(`✗ forge-pm 全量不一致 / 有红（第 1 遍 ${a.pass ?? "?"} pass · 第 2 遍 ${b.pass ?? "?"} pass）`)
console.error("   第 1 遍：" + fmt(a))
console.error("   第 2 遍：" + fmt(b))
for (const p of problems) console.error(`   · ${p}`)
/* 给排障留指针（不改判据）：这两条是「泄漏类」病的招牌症状。 */
for (const [r, name] of [[a, "第 1 遍"], [b, "第 2 遍"]]) {
  const hits = r.out
    .split("\n")
    .filter((l) => /Cannot use a closed database|Cannot call describe\(\) after the test run/.test(l))
    .slice(0, 4)
  for (const h of hits) console.error(`   ${name} 症状：${h.trim().slice(0, 160)}`)
}
if (FULL) for (const r of [a, b]) console.error(`\n──── ${r.tag} 完整输出 ────\n${r.out}`)
console.error("   修法：把泄漏的跨文件状态清掉（定时器要卸载、env 要还原、全局要摘净）；别拿「再跑一次就绿」当修好。")
process.exit(2)
