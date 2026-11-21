/**
 * `lint-log-outlet-next` 的 spec（ISS-889）。
 *
 * 载体：本仓口径 —— **`export function run()` + `--selftest`**（gate-runtime.ts:104-126），
 * 非 bun describe/it。`bun test --isolate` 本仓跑 0 pass/0 fail，权威执行是 `--selftest`。
 *
 * ## 覆盖
 *
 * ① G1 console 注入必红（文件:行 + 源码行 + 怎么改）/ 移除⇒绿
 * ② G2 裸 throw（new Error / Error() / TypeError）必红；类型化错误类不误伤；移除⇒绿
 * ③ G3 ctx.logger 直调（ctx. / this.ctx.）必红；工厂调用 + 工厂实例级别调用不误伤；移除⇒绿
 * ④ 字符串 / 模板 / 注释里的同名文本不误报
 * ⑤ tests 目录不入射程（同一违例放 tests/ 不报、搬进 src/ 报）
 * ⑥ 语料完整性（缩小 glob 漏包 ⇒ failed）
 * ⑦ 三态 fail-closed（0 文件 no-corpus / 无 typescript no-binary / 漏包判红）
 * ⑧ 真树反向控制（语料非空 + typescript 可加载 + 清债后 0 违例）
 *
 * ⛔ 反例必须点名哪一行、哪段源码、期望/实际，不只断 status === "failed"。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  BARE_ERROR_CONSTRUCTORS,
  HOW_TO_FIX,
  SOURCE_GLOB,
  collect,
  corpusIntegrity,
  findViolations,
  isBareThrow,
  isConsoleCall,
  isDirectLoggerCall,
  judgeOutlet,
  loadTs,
  scanRepository,
  sourceCorpus,
  type OutletInput,
  type ScanResult,
} from "./lint-log-outlet-next.ts"
import type { GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")

let fails = 0
let okCount = 0
const ok = (name: string, cond: boolean, extra = ""): void => {
  okCount++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` —— 实际：${extra}`}`)
  if (!cond) fails++
}

interface PkgSpec {
  group: string
  pkg: string
  /** src 相对路径 → 文件内容。 */
  files?: Record<string, string>
  /** tests 相对路径 → 文件内容（验证射程隔离）。 */
  tests?: Record<string, string>
}

interface Fixture {
  root: string
  src: (group: string, pkg: string, rel: string) => string
}

/** 造 packages/<group>/<pkg>/{src,tests}/<rel> 形态的临时仓根。 */
function makeFixture(pkgs: readonly PkgSpec[]): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "log-outlet-next-fixture-"))
  fs.mkdirSync(path.join(root, "packages"), { recursive: true })
  for (const spec of pkgs) {
    const dir = path.join(root, "packages", spec.group, spec.pkg)
    fs.mkdirSync(path.join(dir, "src"), { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"),
      JSON.stringify({ name: `@fixture/${spec.pkg}`, type: "module" }, null, 2) + "\n")
    for (const [rel, text] of Object.entries(spec.files ?? {})) {
      const target = path.join(dir, "src", rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
    }
    for (const [rel, text] of Object.entries(spec.tests ?? {})) {
      const target = path.join(dir, "tests", rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
    }
  }
  return {
    root,
    src: (group, pkg, rel) => path.join(root, "packages", group, pkg, "src", rel),
  }
}

function rmFixture(f: Fixture): void {
  fs.rmSync(f.root, { recursive: true, force: true })
}

const hasFinding = (r: GateResult, ...needles: string[]): boolean =>
  (r.findings ?? []).some((f) => needles.every((n) => (f.detail ?? "").includes(n) || (f.file ?? "").includes(n)))

/** 把 fixture 的 scan 包成 judge 输入（ts 已加载）。 */
function inputOf(f: Fixture, ts: any): OutletInput {
  return { hasTs: true, scan: scanRepository(f.root, ts) }
}

export function run(): boolean {
  fails = 0
  okCount = 0
  console.log("lint-log-outlet-next.spec")

  const ts = loadTs(REPO)
  ok("typescript 可加载（不降级成正则）", ts !== null)
  if (ts === null) {
    console.log("✗ 无 typescript，后续 AST 用例无法运行")
    return false
  }

  /* ── ⓪ 常量与纯函数单测 ─────────────────────────────────────── */

  {
    ok("SOURCE_GLOB 严格锁在两层包 src", SOURCE_GLOB === "packages/*/*/src/**/*.{ts,tsx}", SOURCE_GLOB)
    ok("G2 禁 8 个全局 Error 构造子", BARE_ERROR_CONSTRUCTORS.size === 8 && BARE_ERROR_CONSTRUCTORS.has("Error") && BARE_ERROR_CONSTRUCTORS.has("AggregateError"))
    ok("HOW_TO_FIX 三条都给「怎么改」", (["console", "bare-throw", "direct-logger"] as const).every(k => HOW_TO_FIX[k].includes("怎么改")))
  }

  {
    const f = (text: string) => ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const first = (text: string) => {
      const s = f(text)
      let n: any
      s.forEachChild((x: any) => { n ??= x })
      // 表达式语句要下降到 expression（isConsoleCall / isDirectLoggerCall 吃 CallExpression）；
      // ThrowStatement 原样返回（isBareThrow 吃 ThrowStatement）。
      return n !== undefined && ts.isExpressionStatement(n) ? n.expression : n
    }
    ok("isConsoleCall：console.log(...) 命中", isConsoleCall(ts, first('console.log("x")')))
    ok("isConsoleCall：obj.console.log(...) 不误伤", !isConsoleCall(ts, first('obj.console.log("x")')))
    ok("isConsoleCall：console.log 取值（非调用）不误伤", !isConsoleCall(ts, first('const f = console.log')))
    ok("isBareThrow：new Error 命中", isBareThrow(ts, first('throw new Error("x")')) === "Error")
    ok("isBareThrow：new TypeError 命中", isBareThrow(ts, first('throw new TypeError("x")')) === "TypeError")
    ok("isBareThrow：throw Error(...) 命中", isBareThrow(ts, first('throw Error("x")')) === "Error")
    ok("isBareThrow：new DomainError 不误伤", isBareThrow(ts, first('throw new DomainError("code","x")')) === null)
    ok("isBareThrow：throw this.failure 不误伤", isBareThrow(ts, first('throw this.failure')) === null)
    ok("isDirectLoggerCall：ctx.logger.error(...) 命中", isDirectLoggerCall(ts, first('ctx.logger.error("x")')))
    ok("isDirectLoggerCall：this.ctx.logger.warn(...) 命中", isDirectLoggerCall(ts, first('this.ctx.logger.warn("x")')))
    ok("isDirectLoggerCall：ctx.logger(\"name\") 工厂不误伤", !isDirectLoggerCall(ts, first('ctx.logger("name")')))
    ok("isDirectLoggerCall：logger.error(...) 工厂实例调用不误伤", !isDirectLoggerCall(ts, first('logger.error("x")')))
    ok("isDirectLoggerCall：ctx.other.error(...) 不误伤", !isDirectLoggerCall(ts, first('ctx.other.error("x")')))
  }

  /* ── ① G1 console 注入必红，带 文件:行 + 源码行 + 怎么改；移除⇒绿 ── */

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "bad.ts": 'const a = 1\nconsole.log("hit")\n' } }])
    try {
      const src = f.src("g", "p", "bad.ts")
      const r = judgeOutlet(inputOf(f, ts))
      ok("G1：判红", r.status === "failed", r.status)
      ok("G1：finding 带文件", (r.findings ?? []).some(x => (x.file ?? "").includes("bad.ts")), JSON.stringify(r.findings))
      ok("G1：finding 带行号 2", (r.findings ?? []).some(x => x.line === 2), JSON.stringify(r.findings?.map(x => x.line)))
      ok("G1：判词点名规则与源码行", hasFinding(r, "console", 'console.log("hit")'), JSON.stringify(r.findings))
      ok("G1：判词带怎么改（工厂 logger）", hasFinding(r, "怎么改", 'ctx.logger("name")'), JSON.stringify(r.findings))
      // 移除违例行 ⇒ 绿
      fs.writeFileSync(src, 'const a = 1\nconst b = 2\n')
      const green = judgeOutlet(inputOf(f, ts))
      ok("G1：移除违例⇒绿", green.status === "passed", `${green.status}/${green.reason ?? ""}`)
    } finally {
      rmFixture(f)
    }
  }

  /* ── ② G2 裸 throw 必红；类型化错误类不误伤；移除⇒绿 ── */

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "bad.ts": 'const a = 1\nthrow new Error("boom")\n' } }])
    try {
      const src = f.src("g", "p", "bad.ts")
      const r = judgeOutlet(inputOf(f, ts))
      ok("G2-new Error：判红", r.status === "failed", r.status)
      ok("G2：finding 带行号 2", (r.findings ?? []).some(x => x.line === 2), JSON.stringify(r.findings?.map(x => x.line)))
      ok("G2：判词带怎么改（抛类型化错误）", hasFinding(r, "怎么改", "DomainError", "StorageError"), JSON.stringify(r.findings))
      fs.writeFileSync(src, 'const a = 1\nconst b = 2\n')
      ok("G2：移除违例⇒绿", judgeOutlet(inputOf(f, ts)).status === "passed")
    } finally {
      rmFixture(f)
    }
  }

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "bad.ts": 'throw Error("boom")\n' } }])
    try {
      ok("G2-throw Error(...)（无 new）：判红", judgeOutlet(inputOf(f, ts)).status === "failed")
    } finally {
      rmFixture(f)
    }
  }

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "ok.ts": 'throw new DomainError("invalid-spec","bad spec")\nthrow new StorageError("closed","closed")\n' } }])
    try {
      ok("G2：类型化错误类不误伤⇒绿", judgeOutlet(inputOf(f, ts)).status === "passed")
    } finally {
      rmFixture(f)
    }
  }

  /* ── ③ G3 ctx.logger 直调必红；工厂/工厂实例不误伤；移除⇒绿 ── */

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "bad.ts": 'const a = 1\nctx.logger.error("hit")\n' } }])
    try {
      const src = f.src("g", "p", "bad.ts")
      const r = judgeOutlet(inputOf(f, ts))
      ok("G3：判红", r.status === "failed", r.status)
      ok("G3：finding 带行号 2", (r.findings ?? []).some(x => x.line === 2), JSON.stringify(r.findings?.map(x => x.line)))
      ok("G3：判词带怎么改（工厂）", hasFinding(r, "怎么改", 'ctx.logger("name")'), JSON.stringify(r.findings))
      fs.writeFileSync(src, 'const a = 1\nconst b = 2\n')
      ok("G3：移除违例⇒绿", judgeOutlet(inputOf(f, ts)).status === "passed")
    } finally {
      rmFixture(f)
    }
  }

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "bad.ts": 'class X { m() { this.ctx.logger.warn("hit") } }\n' } }])
    try {
      const r = judgeOutlet(inputOf(f, ts))
      ok("G3-this.ctx.logger：判红", r.status === "failed", r.status)
      ok("G3-this.ctx.logger：finding 命中该行", (r.findings ?? []).some(x => x.line === 1), JSON.stringify(r.findings))
    } finally {
      rmFixture(f)
    }
  }

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "ok.ts": 'const logger = ctx.logger("g/p")\nlogger.error("via factory")\n' } }])
    try {
      ok("G3：工厂调用 + 工厂实例级别调用不误伤⇒绿", judgeOutlet(inputOf(f, ts)).status === "passed")
    } finally {
      rmFixture(f)
    }
  }

  /* ── ④ 字符串 / 模板 / 注释里的同名文本不误报 ── */

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "text.ts": 'const a = "console.log(\\"x\\")"\nconst b = `throw new Error("x")`\n// ctx.logger.error("x")\nconst c = 1\n' } }])
    try {
      const r = judgeOutlet(inputOf(f, ts))
      ok("字符串/模板/注释：0 违例", r.status === "passed", `${r.status}/${JSON.stringify(r.findings)}`)
      ok("字符串/模板/注释：findViolations 也 0", findViolations("x.ts", fs.readFileSync(f.src("g", "p", "text.ts"), "utf8"), ts).length === 0)
    } finally {
      rmFixture(f)
    }
  }

  /* ── ⑤ tests 目录不入射程（同一违例放 tests/ 不报、搬进 src/ 报） ── */

  {
    const f = makeFixture([{
      group: "g", pkg: "p",
      files: { "ok.ts": "const a = 1\n" },
      tests: { "bad.test.ts": 'throw new Error("assertion helper")\nconsole.log("debug")\n' },
    }])
    try {
      ok("射程：tests/ 下的裸 throw + console 不报", judgeOutlet(inputOf(f, ts)).status === "passed")
      // 搬到 src ⇒ 报
      fs.writeFileSync(f.src("g", "p", "moved.ts"), 'throw new Error("assertion helper")\n')
      const r = judgeOutlet(inputOf(f, ts))
      ok("射程：同一违例搬进 src/ ⇒ 红", r.status === "failed", r.status)
      ok("射程：判词点名搬进来的文件", hasFinding(r, "moved.ts"), JSON.stringify(r.findings))
    } finally {
      rmFixture(f)
    }
  }

  /* ── ⑥ 语料完整性：缩小 glob 漏包 ⇒ failed ── */

  {
    const f = makeFixture([
      { group: "g", pkg: "p0", files: { "index.ts": "const a = 1\n" } },
      { group: "g", pkg: "p1", files: { "index.ts": "const b = 2\n" } },
    ])
    try {
      const narrowed = sourceCorpus(f.root, "packages/g/p0/src/**/*.ts")
      ok("漏包实验：缩小 glob 只扫到 p0", narrowed.length === 1 && narrowed[0]!.includes("p0"), JSON.stringify(narrowed))
      const integrity = corpusIntegrity(f.root, narrowed)
      ok("漏包实验：完整性点名 p1/src", integrity.missing.some(m => m.includes("p1")), JSON.stringify(integrity.missing))
      const scan: ScanResult = { files: narrowed, integrity, violations: [] }
      const r = judgeOutlet({ hasTs: true, scan })
      ok("漏包实验：判红（完整性失败，不是判不了）", r.status === "failed", `${r.status}/${r.reason ?? ""}`)
      ok("漏包实验：判词点名漏掉的目录与「不要放宽 glob」", hasFinding(r, "p1/src", "完整性失败", "不要放宽 glob"), JSON.stringify(r.findings))
    } finally {
      rmFixture(f)
    }
  }

  /* ── ⑦ 三态 fail-closed ─────────────────────────────────────── */

  {
    const f = makeFixture([]) // 0 源文件
    try {
      const files = sourceCorpus(f.root)
      ok("no-corpus：语料 0 文件", files.length === 0, JSON.stringify(files))
      const integrity = corpusIntegrity(f.root, files)
      ok("no-corpus：integrity.empty=true", integrity.empty === true)
      const scan: ScanResult = { files, integrity, violations: [] }
      const r = judgeOutlet({ hasTs: true, scan })
      ok("no-corpus：判不了", r.status === "unjudged", r.status)
      ok("no-corpus：理由码 no-corpus", r.reason === "no-corpus", String(r.reason))
      ok("no-corpus：判词说分母为 0 不冒绿", (r.detail ?? "").includes("分母为 0"), r.detail ?? "")
    } finally {
      rmFixture(f)
    }
  }

  {
    const r = judgeOutlet({ hasTs: false, scan: null })
    ok("no-binary：判不了", r.status === "unjudged", r.status)
    ok("no-binary：理由码 no-binary", r.reason === "no-binary", String(r.reason))
    ok("no-binary：判词点名无法 AST 解析", (r.detail ?? "").includes("无法做 AST 解析"), r.detail ?? "")
    ok("no-binary：真树 collect 的 hasTs 为真（本用例只验 judge 三态）", collect(REPO).hasTs === true)
  }

  /* ── ⑧ 真树反向控制 ─────────────────────────────────────────── */

  {
    const files = sourceCorpus(REPO)
    ok("真树：SOURCE_GLOB 语料非空", files.length > 0, String(files.length))
    const real = collect(REPO)
    ok("真树：可 typescript 解析", real.hasTs && real.scan !== null)
    ok("真树：完整性无漏包", real.scan !== null && real.scan.integrity.missing.length === 0,
      real.scan ? JSON.stringify(real.scan.integrity.missing) : "no-scan")
    ok("真树：清债后 0 违例（--check 绿）", real.scan !== null && real.scan.violations.length === 0,
      real.scan ? JSON.stringify(real.scan.violations) : "no-scan")
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立（共 ${okCount}）`
      : `✓ spec 全过（${okCount} 条断言：三规则注入红/移除绿 + 反向控制 + tests 隔离 + 语料完整性 + 三态 fail-closed + 真树 0 违例）`,
  )
  return fails === 0
}
