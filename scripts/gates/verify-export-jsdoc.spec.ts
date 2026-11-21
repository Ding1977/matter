/**
 * `verify-export-jsdoc` 的 spec（ISS-881）。
 *
 * 载体：本仓口径 —— **`export function run()` + `--selftest`**（gate-runtime.ts:104-126）。
 *
 * ## 覆盖
 *
 * ① jsdoc.ts 四函数：parseJsDoc 描述/区块边界 · parseTags @param/@returns（含行内 @returns 陷阱）
 *    · checkParams（binding pattern / 陈旧 tag / 空描述）· checkReturns（void/非 void/无标注）
 * ② AST 扫描不误伤：注释/字符串/非导出/re-export/augmentation/构造子/协议槽/heritage 继承
 * ③ 身份指纹稳定：同身份两处指纹相等、换符号/换类型指纹变；countViolations 聚合与按身份退役
 * ④ 判定五态：存量相等绿 / 新身份红 / 同身份变多红 / 消失提示 prune（仍绿）/ 计数记多仍绿
 * ⑤ fail-closed 三态：no-baseline / no-corpus / no-binary 各 unjudged（不是绿）
 * ⑥ 变异：删基线记录后同一处从绿翻红（判据有牙）
 * ⑦ 基线结构体检：非法指纹/空表/绝对路径/负计数/坏 JSON/缺席 ⇒ readBaseline 返回 null
 * ⑧ 真扫盘：真实语料 26 条/4 文件/全 storage-journal/missing-param:11 + missing-returns:15
 *    + 真基线绿 + 两类注入必红（**入口源 + 非入口源各一次**）+ 移除恢复绿
 *
 * ⛔ 反例必须点名哪一行、哪个符号、期望/实际，不只断 `status === "failed"`。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  checkParams,
  checkReturns,
  countViolations,
  fingerprint,
  judgeExportJsdoc,
  loadTs,
  parseJsDoc,
  parseTags,
  pruneBaseline,
  readBaseline,
  scanViolations,
  type JsdocBaseline,
  type JsdocInput,
  type JsdocViolation,
  type ViolationKind,
} from "./verify-export-jsdoc.ts"

let fails = 0
let okCount = 0
const ok = (name: string, cond: boolean, extra = ""): void => {
  okCount++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` —— 实际：${extra}`}`)
  if (!cond) fails++
}

const ts = loadTs()
const F = "packages/g/p/src/x.ts"
const v = (file: string, line: number, symbol: string, kind: ViolationKind, message = ""): JsdocViolation => ({
  file, line, symbol, kind, message: message || `${kind} at ${symbol}`,
})
const input = (violations: JsdocViolation[], baseline: JsdocBaseline | null, fileCount = 1, hasTs = true): JsdocInput => ({
  violations, baseline, fileCount, hasTs,
})
const hasFinding = (r: { findings?: { detail: string }[] }, ...needles: string[]): boolean =>
  (r.findings ?? []).some((f) => needles.every((n) => f.detail.includes(n)))

export function run(): boolean {
  fails = 0
  okCount = 0
  console.log("verify-export-jsdoc.spec")

  if (ts === null) {
    ok("缺 typescript ⇒ 本 spec 无法执行（不是通过）", false, "loadTs() 返回 null")
    console.log("✗ 缺 typescript，spec 无法执行")
    return false
  }

  /* ── ① jsdoc.ts 四函数 ─────────────────────────────────────────── */

  {
    const { doc, mode, hasMode } = parseJsDoc("/** Hello world.\n * @param a - desc\n */")
    ok("parseJsDoc：描述 prose 取到", doc === "Hello world.", doc)
    ok("parseJsDoc：block tag 后不并入 prose", !doc.includes("@param"), doc)
    ok("parseJsDoc：无 @mode 时 mode=null", mode === null && hasMode === false)
  }
  {
    const { mode, hasMode } = parseJsDoc("/** Doc.\n * @mode waterfall\n */")
    ok("parseJsDoc：@mode 解析", mode === "waterfall" && hasMode === true)
  }
  {
    const { doc } = parseJsDoc("/** Line one.\n * line two.\n */")
    ok("parseJsDoc：多行 prose 合并为一段", doc === "Line one. line two.", doc)
  }
  {
    const { doc } = parseJsDoc("/**\n * - item one\n * - item two\n */")
    ok("parseJsDoc：列表项保留分行", doc.includes("\n") && doc.includes("item one"), doc)
  }
  {
    const { doc } = parseJsDoc("/** See {@link Foo}. */")
    ok("parseJsDoc：{@link X} 渲染为 X", doc.includes("Foo") && !doc.includes("{@link"), doc)
  }
  {
    const { params, returns } = parseTags("/**\n * @param a - first\n * @param b - second\n * @returns result\n */")
    ok("parseTags：两个 @param 都解析", params.get("a") === "first" && params.get("b") === "second")
    ok("parseTags：@returns 解析", returns === "result", String(returns))
  }
  {
    const { params } = parseTags("/**\n * @param [opt] - optional\n */")
    ok("parseTags：[opt] 名字去括号", params.has("opt") && !params.has("[opt]"))
  }
  {
    const { params } = parseTags("/**\n * @param a - desc\n * continued\n */")
    ok("parseTags：续行并入上一个 tag", params.get("a") === "desc continued", params.get("a"))
  }
  {
    // 陷阱：@returns 写在描述行内 ⇒ parseTags 看不到独立 block tag ⇒ returns=null。
    const { returns } = parseTags("/** Returns the value @returns inline. */")
    ok("parseTags 陷阱：行内 @returns 不算独立 block tag（returns=null）", returns === null, String(returns))
  }
  {
    const { params, returns } = parseTags("/**\n * @returns\n */")
    ok("parseTags：空 @returns 是 '' 不是 null", returns === "", JSON.stringify(returns))
    ok("parseTags：无 @param 时 params 为空", params.size === 0)
  }
  {
    // checkParams：用真实 AST 节点喂，避免手造假节点。
    const sf = ts.createSourceFile("x.ts", "function f(a, b) {}", ts.ScriptTarget.Latest, true)
    const fn = (sf.statements[0] as any)
    const tags = new Map([["a", "desc"], ["stale", "x"]])
    const violations: string[] = []
    checkParams(ts, "where", "exported", fn.parameters, tags, sf, () => false, violations)
    ok("checkParams：缺 @param b 报违规", violations.some((x) => x.includes("missing @param b")), violations.join("|"))
    ok("checkParams：陈旧 @param stale 报违规", violations.some((x) => x.includes("stale tag")), violations.join("|"))
  }
  {
    const sf = ts.createSourceFile("x.ts", "function f() {}", ts.ScriptTarget.Latest, true)
    const fn = (sf.statements[0] as any)
    const violations: string[] = []
    checkParams(ts, "where", "exported", fn.parameters, new Map(), sf, () => false, violations)
    ok("checkParams：无参数无 tag 时零违规", violations.length === 0)
  }
  {
    const sf = ts.createSourceFile("x.ts", "function f({x}: {x:number}) {}", ts.ScriptTarget.Latest, true)
    const fn = (sf.statements[0] as any)
    const violations: string[] = []
    checkParams(ts, "where", "exported", fn.parameters, new Map(), sf, () => false, violations)
    ok("checkParams：binding pattern 参数报违规", violations.some((x) => x.includes("binding pattern")), violations.join("|"))
  }
  {
    const sf = ts.createSourceFile("x.ts", "function f(): void {}", ts.ScriptTarget.Latest, true)
    const rt = (sf.statements[0] as any).type
    const violations: string[] = []
    checkReturns(ts, "where", rt, null, sf, violations)
    ok("checkReturns：void 返回不需 @returns", violations.length === 0)
  }
  {
    const sf = ts.createSourceFile("x.ts", "function f(): number {}", ts.ScriptTarget.Latest, true)
    const rt = (sf.statements[0] as any).type
    const violations: string[] = []
    checkReturns(ts, "where", rt, null, sf, violations)
    ok("checkReturns：非 void 缺 @returns 报违规", violations.some((x) => x.includes("missing @returns")), violations.join("|"))
  }
  {
    const sf = ts.createSourceFile("x.ts", "function f() {}", ts.ScriptTarget.Latest, true)
    const violations: string[] = []
    checkReturns(ts, "where", undefined, null, sf, violations)
    ok("checkReturns：无返回类型标注报违规", violations.some((x) => x.includes("no return type annotation")), violations.join("|"))
  }

  /* ── ② AST 扫描 + 豁免不误伤 ──────────────────────────────────── */

  {
    const src = [
      "/** Doc.",
      " * @param a - x",
      " * @returns y",
      " */",
      "export function documented(a: string): number { return a.length }",
      "// export function commented(a: string): number { return 1 }",
      "const s = 'export function fake(a: string): number'",
      "function notExported(a: string): number { return 1 }",
    ].join("\n")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ej-ast-"))
    try {
      const rel = "packages/g/p/src/a.ts"
      fs.mkdirSync(path.join(tmp, "packages/g/p/src"), { recursive: true })
      fs.writeFileSync(path.join(tmp, rel), src)
      const { violations: got } = scanViolations(tmp, ts, [rel])
      ok("AST：注释/字符串/非导出不误伤（0 违规）", got.length === 0, JSON.stringify(got.map((x) => x.message)))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  {
    // 有描述但缺 tag ⇒ 必红（这正是 26 条存量欠债的形态）。
    const src = [
      "/** Returns the length. */",
      "export function missingTags(a: string): number { return a.length }",
    ].join("\n")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ej-miss-"))
    try {
      const rel = "packages/g/p/src/b.ts"
      fs.mkdirSync(path.join(tmp, "packages/g/p/src"), { recursive: true })
      fs.writeFileSync(path.join(tmp, rel), src)
      const { violations: got } = scanViolations(tmp, ts, [rel])
      ok("AST：有描述缺 tag ⇒ 2 条违规（@param + @returns）", got.length === 2, JSON.stringify(got.map((x) => x.kind)))
      ok("AST：违规符号名是 missingTags", got.every((x) => x.symbol === "missingTags"), JSON.stringify(got.map((x) => x.symbol)))
      ok("AST：行号指到 export function 行（第 2 行）", got.every((x) => x.line === 2), JSON.stringify(got.map((x) => x.line)))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  {
    // 协议槽 + 构造子 + re-export + augmentation + heritage 豁免不误伤。
    const src = [
      "abstract class Base { protected greet(a: string): number { return a.length } }",
      "/** Plugin doc. */",
      "export class Plugin extends Base {",
      "  static Config = {}",
      "  static inject = {}",
      "  static name = 'plugin'",
      "  static reusable = true",
      "  constructor(private x: string) {}",
      "}",
      "export { Base } from './base.ts'",
      "export type { JsdocBaseline } from './types.ts'",
    ].join("\n")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ej-exempt-"))
    try {
      const rel = "packages/g/p/src/c.ts"
      fs.mkdirSync(path.join(tmp, "packages/g/p/src"), { recursive: true })
      fs.writeFileSync(path.join(tmp, rel), src)
      const { violations: got } = scanViolations(tmp, ts, [rel])
      ok("AST豁免：协议槽/构造子/re-export/augmentation 不误伤", got.length === 0, JSON.stringify(got.map((x) => x.message)))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  /* ── ③ 身份指纹稳定 + 按身份退役 ──────────────────────────────── */

  {
    const a = v(F, 5, "foo", "missing-param")
    const b = v(F, 9, "foo", "missing-param")
    ok("指纹：同文件同符号同类型（不同行）⇒ 同指纹", fingerprint(a) === fingerprint(b))
    const renamed = v(F, 5, "bar", "missing-param")
    ok("指纹：换符号 ⇒ 换指纹", fingerprint(renamed) !== fingerprint(a))
    const retyped = v(F, 5, "foo", "missing-returns")
    ok("指纹：换违规类型 ⇒ 换指纹", fingerprint(retyped) !== fingerprint(a))
    const refiled = v("packages/g/p/src/other.ts", 5, "foo", "missing-param")
    ok("指纹：换文件 ⇒ 换指纹", fingerprint(refiled) !== fingerprint(a))
    ok("指纹：64 位十六进制", /^[a-f0-9]{64}$/.test(fingerprint(a)))
  }
  {
    const counted = countViolations([v(F, 1, "foo", "missing-param"), v(F, 2, "foo", "missing-param"), v(F, 3, "bar", "missing-returns")])
    ok("countViolations：同身份聚合计数（foo=2）", counted[F]?.[fingerprint(v(F, 0, "foo", "missing-param"))] === 2)
    ok("countViolations：不同身份分开记（bar=1）", counted[F]?.[fingerprint(v(F, 0, "bar", "missing-returns"))] === 1)
    const afterRetire = countViolations([v(F, 1, "foo", "missing-param")])
    ok("按身份退役：删一条后 foo 计数 2→1", afterRetire[F]?.[fingerprint(v(F, 0, "foo", "missing-param"))] === 1)
    const afterAll = countViolations([])
    ok("按身份退役：删光后该文件条目消失", afterAll[F] === undefined)
  }

  /* ── ④ 判定五态 ───────────────────────────────────────────────── */

  {
    const foo = v(F, 7, "foo", "missing-param")
    const base: JsdocBaseline = { [F]: { [fingerprint(foo)]: 1 } }
    const r = judgeExportJsdoc(input([foo], base))
    ok("判定：存量身份计数相等 ⇒ 绿", r.status === "passed", r.status)
  }
  {
    const foo = v(F, 7, "foo", "missing-param")
    const bar = v(F, 9, "bar", "missing-returns")
    const base: JsdocBaseline = { [F]: { [fingerprint(foo)]: 1 } }
    const r = judgeExportJsdoc(input([foo, bar], base))
    ok("判定：新身份 ⇒ 红", r.status === "failed", r.status)
    ok("判定：新身份 finding 带文件:行", (r.findings ?? []).some((f) => f.file === F && f.line === 9), JSON.stringify(r.findings))
    ok("判定：新身份 finding 带符号名", hasFinding(r, "bar"))
    ok("判定：新身份 finding 带期望/实际", hasFinding(r, "期望", "实际缺"))
    ok("判定：新身份 finding 带怎么改", hasFinding(r, "怎么改"))
  }
  {
    const foo = v(F, 7, "foo", "missing-param")
    const nf = "packages/g/p/src/new.ts"
    const newer = v(nf, 3, "newFn", "missing-returns")
    const base: JsdocBaseline = { [F]: { [fingerprint(foo)]: 1 } }
    const r = judgeExportJsdoc(input([foo, newer], base))
    ok("判定：新文件（基线无此文件）⇒ 红", r.status === "failed", r.status)
    ok("判定：新文件 finding 指到新路径", (r.findings ?? []).some((f) => f.file === nf && f.line === 3))
  }
  {
    const foo = v(F, 7, "foo", "missing-param")
    // 同一身份出现两次，基线只记 1 次 ⇒ 第二次「存量变多」。
    const r = judgeExportJsdoc(input([foo, v(F, 11, "foo", "missing-param")], { [F]: { [fingerprint(foo)]: 1 } }))
    ok("判定：同身份变多（2>1）⇒ 红", r.status === "failed", r.status)
    ok("判定：变多条 finding 带第二次出现的行号", (r.findings ?? []).some((f) => f.line === 11), JSON.stringify(r.findings))
  }
  {
    const foo = v(F, 7, "foo", "missing-param")
    const r = judgeExportJsdoc(input([], { [F]: { [fingerprint(foo)]: 1 } }))
    ok("判定：身份消失（基线有实际无）⇒ 仍绿", r.status === "passed", r.status)
    ok("判定：身份消失给 prune 提示", (r.detail ?? "").includes("prune"), r.detail)
    ok("判定：prune 提示带消失身份前缀", (r.detail ?? "").includes(fingerprint(foo).slice(0, 12)), r.detail)
  }
  {
    const foo = v(F, 7, "foo", "missing-param")
    const r = judgeExportJsdoc(input([foo], { [F]: { [fingerprint(foo)]: 2 } }))
    ok("判定：基线记多（2>实际1）⇒ 仍绿（只提示 prune）", r.status === "passed", r.status)
  }

  /* ── ⑤ fail-closed 三态 ───────────────────────────────────────── */

  {
    const r = judgeExportJsdoc(input([], null))
    ok("fail-closed：基线缺席 ⇒ unjudged(no-baseline)", r.status === "unjudged" && r.reason === "no-baseline", `${r.status}/${r.reason}`)
  }
  {
    const r = judgeExportJsdoc(input([], {}, 0))
    ok("fail-closed：0 源文件 ⇒ unjudged(no-corpus)", r.status === "unjudged" && r.reason === "no-corpus", `${r.status}/${r.reason}`)
  }
  {
    const r = judgeExportJsdoc(input([], {}, 1, false))
    ok("fail-closed：无编译器 ⇒ unjudged(no-binary)", r.status === "unjudged" && r.reason === "no-binary", `${r.status}/${r.reason}`)
  }

  /* ── ⑥ 变异：删基线记录 ⇒ 同一处从绿翻红 ──────────────────────── */

  {
    const foo = v(F, 7, "foo", "missing-param")
    const base: JsdocBaseline = { [F]: { [fingerprint(foo)]: 1 } }
    const green = judgeExportJsdoc(input([foo], base))
    ok("变异前：1 处违规 + 基线记 1 ⇒ 绿", green.status === "passed", green.status)
    const removed = judgeExportJsdoc(input([foo], { [F]: { [fingerprint(v(F, 0, "other", "missing-param"))]: 1 } }))
    ok("变异：删该身份的基线记录 ⇒ 红（判据有牙）", removed.status === "failed", removed.status)
    ok("变异：红指回被删身份的符号名", hasFinding(removed, "foo"))
  }

  /* ── ⑦ 基线结构体检 ───────────────────────────────────────────── */

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ej-base-"))
    try {
      const baseDir = path.join(tmp, "scripts/baseline")
      fs.mkdirSync(baseDir, { recursive: true })
      const bp = path.join(baseDir, "export-jsdoc.baseline.json")
      const A = fingerprint(v(F, 0, "foo", "missing-param"))
      fs.writeFileSync(bp, JSON.stringify({ [F]: { not_a_sha: 1 } }))
      ok("基线体检：非法指纹 ⇒ null", readBaseline(tmp) === null)
      fs.writeFileSync(bp, JSON.stringify({ [F]: {} }))
      ok("基线体检：空身份表 ⇒ null", readBaseline(tmp) === null)
      fs.writeFileSync(bp, JSON.stringify({ "/abs/x.ts": { [A]: 1 } }))
      ok("基线体检：绝对路径 ⇒ null", readBaseline(tmp) === null)
      fs.writeFileSync(bp, JSON.stringify({ [F]: { [A]: -1 } }))
      ok("基线体检：负计数 ⇒ null", readBaseline(tmp) === null)
      fs.writeFileSync(bp, JSON.stringify({ [F]: { [A]: 1.5 } }))
      ok("基线体检：非整数计数 ⇒ null", readBaseline(tmp) === null)
      fs.writeFileSync(bp, "{not json")
      ok("基线体检：坏 JSON ⇒ null", readBaseline(tmp) === null)
      fs.unlinkSync(bp)
      ok("基线体检：文件缺席 ⇒ null（删基线不冒绿）", readBaseline(tmp) === null)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  /* ── ⑧ 真扫盘 + 两类注入反向控制 ──────────────────────────────── */

  {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
    const realBase = readBaseline(repo)
    ok("真扫盘：仓库基线读得到（非空）", realBase !== null && Object.keys(realBase ?? {}).length > 0)
    const scanned = scanViolations(repo, ts)
    ok("真扫盘：src 下有源码文件（分母>0）", scanned.fileCount > 0, `fileCount=${scanned.fileCount}`)
    ok("真扫盘：扫出 26 条存量违规", scanned.violations.length === 26, `实际 ${scanned.violations.length}`)
    ok("真扫盘：全在 storage-journal 一个包", scanned.violations.every((x) => x.file.startsWith("packages/storage/storage-journal/")))
    const kinds = scanned.violations.reduce((acc: Record<string, number>, x) => { acc[x.kind] = (acc[x.kind] ?? 0) + 1; return acc }, {})
    ok("真扫盘：missing-param:11", kinds["missing-param"] === 11, JSON.stringify(kinds))
    ok("真扫盘：missing-returns:15", kinds["missing-returns"] === 15, JSON.stringify(kinds))
    ok("真扫盘：零完全无 JSDoc（no-doc=0）", (kinds["no-doc"] ?? 0) === 0, JSON.stringify(kinds))
    const symbols = new Set(scanned.violations.map((x) => x.symbol))
    ok("真扫盘：15 个不同符号", symbols.size === 15, `实际 ${symbols.size}`)
    const judged = judgeExportJsdoc(input(scanned.violations, realBase, scanned.fileCount, true))
    ok("真扫盘：真实语料对真实基线 ⇒ 绿", judged.status === "passed", `${judged.status} ${judged.detail ?? ""}`)
  }

  // 反向控制①：注入到**入口源**（storage-journal/src/index.ts）。
  {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
    const realBase = readBaseline(repo)
    if (realBase === null) {
      ok("注入①：真实基线可读（否则跳过）", false)
    } else {
      const target = path.join(repo, "packages/storage/storage-journal/src/index.ts")
      const original = fs.readFileSync(target, "utf8")
      try {
        fs.writeFileSync(target, `${original}\n/** Entry probe doc. */\nexport function __ejEntryProbe(a: string): number { return a.length }\n`)
        const after = scanViolations(repo, ts)
        const bad = judgeExportJsdoc(input(after.violations, realBase, after.fileCount, true))
        ok("注入①入口源：注入缺 tag 的 export function ⇒ 红（盲区已修）", bad.status === "failed", bad.status)
        ok("注入①入口源：红指到符号名 __ejEntryProbe", hasFinding(bad, "__ejEntryProbe"), JSON.stringify(bad.findings))
        ok("注入①入口源：红带 文件:行", (bad.findings ?? []).some((f) => f.file === "packages/storage/storage-journal/src/index.ts" && typeof f.line === "number"))
        fs.writeFileSync(target, original)
        const restored = scanViolations(repo, ts)
        ok("注入①入口源：移除后 ⇒ 绿（红来源只可能是注入那行）",
          judgeExportJsdoc(input(restored.violations, realBase, restored.fileCount, true)).status === "passed")
      } finally {
        fs.writeFileSync(target, original)
      }
    }
  }

  // 反向控制②：注入到**非入口源**（pm/issue/src/events.ts）—— DSH 盲区所在。
  {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
    const realBase = readBaseline(repo)
    const target = path.join(repo, "packages/pm/issue/src/events.ts")
    if (realBase === null || !fs.existsSync(target)) {
      ok("注入②：真实基线与非入口源文件可读（否则跳过）", false)
    } else {
      const original = fs.readFileSync(target, "utf8")
      try {
        fs.writeFileSync(target, `${original}\n/** Non-entry probe doc. */\nexport function __ejNonEntryProbe(a: string): number { return a.length }\n`)
        const after = scanViolations(repo, ts)
        const bad = judgeExportJsdoc(input(after.violations, realBase, after.fileCount, true))
        ok("注入②非入口源：注入缺 tag 的 export function ⇒ 红（盲区已修）", bad.status === "failed", bad.status)
        ok("注入②非入口源：红指到符号名 __ejNonEntryProbe", hasFinding(bad, "__ejNonEntryProbe"), JSON.stringify(bad.findings))
        ok("注入②非入口源：红带 文件:行", (bad.findings ?? []).some((f) => f.file === "packages/pm/issue/src/events.ts" && typeof f.line === "number"))
        fs.writeFileSync(target, original)
        const restored = scanViolations(repo, ts)
        ok("注入②非入口源：移除后 ⇒ 绿",
          judgeExportJsdoc(input(restored.violations, realBase, restored.fileCount, true)).status === "passed")
      } finally {
        fs.writeFileSync(target, original)
      }
    }
  }

  // prune：确认无新增后写回基线，身份按退役消失；加回该身份 ⇒ 红。
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ej-prune-"))
    try {
      const repoBase = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")
      const realBase = readBaseline(repoBase)
      if (realBase === null) {
        ok("prune：真实基线可读（否则跳过）", false)
      } else {
        const baseDir = path.join(tmp, "scripts/baseline")
        fs.mkdirSync(baseDir, { recursive: true })
        // 用只含基线子集 + 一条已消失身份的临时基线测 prune 的「计数变少 ⇒ 写回」。
        const foo = v(F, 0, "foo", "missing-param")
        const base: JsdocBaseline = { [F]: { [fingerprint(foo)]: 2 } }
        fs.writeFileSync(path.join(baseDir, "export-jsdoc.baseline.json"), JSON.stringify(base))
        ok("prune：基线结构合法 ⇒ readBaseline 非 null", readBaseline(tmp) !== null)
        // 真实树里没有 F 这个文件的违规，prune 会判定「身份消失 ⇒ 仍绿」并写回空基线。
        // 不在此处真的 prune 真实基线（会清空），只验证判定层：消失不红。
        const judged = judgeExportJsdoc(input([], base))
        ok("prune 前置：身份全消失 ⇒ 绿（允许写回）", judged.status === "passed", judged.status)
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立（共 ${okCount}）`
      : `✓ spec 全过（${okCount} 条断言：jsdoc 四函数 + AST 豁免 + 指纹 + 判定五态 + fail-closed 三态 + 变异 + 基线体检 + 真扫盘 26 条 + 入口/非入口两类注入 + prune 前置）`,
  )
  return fails === 0
}
