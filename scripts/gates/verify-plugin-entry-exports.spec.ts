/**
 * `verify-plugin-entry-exports` 的 spec（ISS-838 / W0-GATE-G2）。
 *
 * 载体：本仓口径 —— **`export function run()` + `--selftest`**，不是 `describe/it`
 * （`scripts/gates/README.md` 与 `gate-runtime.ts:104-126`：`--selftest` 动态 import 同名 spec 并调 `run()`）。
 *
 * ## 覆盖什么
 *
 * ① 三类形态的**正反例**：函数插件 + default ⇒ 红 / 无 default ⇒ 绿 / 服务插件 ⇒ 绿 / 服务插件 + name ⇒ 红
 * ② default 的四种写法都要抓（标识符 / class 声明 / class 表达式 / `export { X as default }`）
 * ③ 注释与字符串里的 `export default` 不算（这是用 AST 而不是正则的理由）
 * ④ `export *` 与 `export { default } from` 的跟进语义（不跟进就能靠「拆到 impl.ts」绕过判据）
 * ⑤ 类型导出不算值导出（`export type Config` 不许假红 —— 官方语料 98 个入口写的是 type）
 * ⑥ 抽象 default class = capability seam，不查（照抄官方 `:15-16`）
 * ⑦ 0 入口 / 0 函数插件 / 无编译器 ⇒ **unjudged（不是绿）**
 * ⑧ 真扫盘 fixture：`scanEntries` + `loadTs` 走与门禁**同一条路**
 * ⑨ **变异**：同一棵 fixture 造坏 ⇒ 红，恢复 ⇒ 绿（判据有牙的可执行记录）
 * ⑩ `export *` 成环 / 目标读不到 ⇒ 红并说明（看不清 ≠ 没问题）
 *
 * ⛔ 反例必须点名**哪个入口、红在哪一行**，不许只断 `status === "failed"` ——
 *    「只有一个错」与「全都错」长得一样时，断 failed 等于什么也没断（同 G1 spec 的口径）。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  judgeEntry,
  judgeEntryExports,
  loadTs,
  moduleFacts,
  scanEntries,
  type EntryExportsInput,
  type ModuleSource,
} from "./verify-plugin-entry-exports.ts"

let fails = 0
/** 断言条数**实测累加**，不在结尾手写拆解。 */
let total = 0
const ok = (name: string, cond: boolean, extra = "") => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` —— 实际：${extra}`}`)
  if (!cond) fails++
}

const ts = loadTs()

const at = "packages/group/pkg/src/index.ts"

/** 内存语料：键是仓库相对路径，值是正文；`readModule` 只认这张表（与 main 的 fs 版同形）。 */
function corpus(files: Record<string, string>): EntryExportsInput {
  const map: ModuleSource[] = Object.entries(files).map(([file, text]) => ({ file, text }))
  return {
    entries: map.filter((m) => m.file.endsWith("/src/index.ts")),
    readModule: (file) => map.find((m) => m.file === file) ?? null,
  }
}

const judge = (files: Record<string, string>) => judgeEntryExports(corpus(files), ts)
/** 单入口判绿/红，外加**形态**（形态来自 `judgeEntry` 本体，不另写一份分类逻辑）。 */
const one = (text: string, extra: Record<string, string> = {}) => {
  const files = { [at]: text, ...extra }
  const input = corpus(files)
  const entry = input.entries.find((m) => m.file === at)!
  return { result: judgeEntryExports(input, ts), verdict: judgeEntry(ts, entry, input) }
}
/** findings 里有一条**同时**命中这些子串（既不过严到改一个字就红，也不过松到只断 failed）。 */
const hasFinding = (r: { findings?: { detail: string }[] }, ...needles: string[]): boolean =>
  (r.findings ?? []).some((f) => needles.every((n) => f.detail.includes(n)))

export function run(): boolean {
  fails = 0
  total = 0
  console.log("verify-plugin-entry-exports.spec")

  if (ts === null) {
    // 没有编译器 ⇒ 本判据**什么都判不了**。不许假装通过（同 gate-runtime 的「缺输入 ≠ 0」）。
    ok("缺 typescript ⇒ 本 spec 无法执行（不是通过）", false, "loadTs() 返回 null")
    console.log("✗ 缺 typescript，spec 无法执行")
    return false
  }

  /* ── ① 函数插件形态（事故原样）──────────────────────────────────── */

  {
    // postmortem 0001 :32-36 逐字复刻
    const crash = [
      `export const name = 'acp'`,
      `export const inject = ['agents', 'sessions', 'sessionPersistence']`,
      `export interface Config { x: number }`,
      `export function apply(ctx: unknown): void {}`,
      `export default apply`,
    ].join("\n")
    const { result, verdict } = one(crash)
    ok("反例①：函数插件 + export default apply ⇒ 红", result.status === "failed", result.status)
    ok("反例①：形态判成 function", verdict.form === "function", verdict.form)
    ok("反例①：finding 点名 Loader 的 unwrapExports 与「丢掉命名空间」", hasFinding(result, "unwrapExports", "命名空间"))
    ok("反例①：finding 带行号 5（default 那一行）", (result.findings ?? []).some((f) => f.line === 5), JSON.stringify(result.findings))
    ok("反例①：finding 指到入口文件", (result.findings ?? []).every((f) => f.file === at))
    ok("反例①：finding 提了事故（178 个绿测试），读者知道为什么不能破例", hasFinding(result, "178"))
  }

  {
    // 正例：函数插件的正确形态（name/inject/Config/apply，无 default）
    const good = [
      `export const name = 'thing'`,
      `export const inject = ['a']`,
      `export interface Config { n: number }`,
      `export function apply(ctx: unknown): void {}`,
    ].join("\n")
    const { result, verdict } = one(good)
    ok("正例①：函数插件无 default ⇒ 绿", result.status === "passed", result.status)
    ok("正例①：形态判成 function", verdict.form === "function", verdict.form)
    ok("正例①：绿的理由数出「函数插件 1」", (result.detail ?? "").includes("函数插件 1"), result.detail)
  }

  /* ── ② 服务插件形态 ─────────────────────────────────────────────── */

  {
    const svc = [`export interface Config { n: number }`, `export default class Widget extends Object {}`].join("\n")
    const { result, verdict } = one(svc)
    ok("正例②：服务插件（default class + export interface Config）⇒ 绿", result.status === "passed", result.status)
    ok("正例②：形态判成 service", verdict.form === "service", verdict.form)
  }

  {
    const svcBad = [`export interface Config { n: number }`, `export const name = 'nope'`, `export default class Widget extends Object {}`].join("\n")
    const { result, verdict } = one(svcBad)
    ok("反例②：服务插件 + export const name ⇒ 红", result.status === "failed", result.status)
    ok("反例②：finding 点名 name 与「只从 default class 上读」", hasFinding(result, "name", "default class"))
    ok("反例②：finding 带行号（default 在第 3 行）", (result.findings ?? []).some((f) => f.line === 3), JSON.stringify(result.findings))
    ok("反例②：形态仍是 service（没被误判成函数插件）", verdict.form === "service", verdict.form)
  }

  {
    // inject / Config 各报一条（三个字段都要有牙）
    for (const field of ["inject", "Config"]) {
      const { result } = one([`export const ${field} = ['x'] as const`, `export default class W {}`].join("\n"))
      ok(`反例②'：服务插件 + export const ${field} ⇒ 红且点名 ${field}`, result.status === "failed" && hasFinding(result, field), result.status)
    }
  }

  {
    // 反例②''：匿名 default class 也算服务插件（官方语料 14 个是这种形态）
    const { result, verdict } = one([`export const name = 'x'`, `export default class {}`].join("\n"))
    ok("反例②'':匿名 default class + name ⇒ 红", result.status === "failed" && verdict.form === "service", `${result.status}/${verdict.form}`)
  }

  {
    // fail-closed：import 来的 default 判不出是不是 class ⇒ 当服务插件处理，并**说明判不出**
    const { result, verdict } = one([`import Svc from "./svc.ts"`, `export const name = 'x'`, `export default Svc`].join("\n"), {
      "packages/group/pkg/src/svc.ts": `export default class Svc {}`,
    })
    ok("fail-closed：default 是 import 来的标识符 ⇒ 当服务插件处理（红）", result.status === "failed" && verdict.form === "service", `${result.status}/${verdict.form}`)
    ok("fail-closed：finding 明说「判不出」而不是假装确定", hasFinding(result, "判不出"))
  }

  /* ── ③ 库形态（不检查）────────────────────────────────────────────── */

  {
    const { result, verdict } = one([`export const helper = 1`, `export interface Shape { a: number }`].join("\n"))
    ok("正例③：库入口（无 apply 无 default）⇒ 该入口 0 findings", verdict.findings.length === 0, String(verdict.findings.length))
    ok("正例③：形态判成 library", verdict.form === "library", verdict.form)
    // ⚠️ 但**只有一个库入口的语料**整格是 unjudged：核心射程零样本，判了等于没判（见文件头「两级」②）。
    ok("正例③：库入口独处时整格 unjudged（不是绿）—— 核心射程零样本", result.status === "unjudged", result.status)
  }
  {
    // 与库入口同在的语料里，库入口不许把函数插件的结论搞乱：绿且数出「库 1」
    const { result } = one([`export const helper = 1`].join("\n"), {
      "packages/group/pkg2/src/index.ts": `export function apply(): void {}`,
    })
    ok("正例③'':库入口 + 函数插件同在 ⇒ 绿且数出「库 1」", result.status === "passed" && (result.detail ?? "").includes("库 1"), `${result.status} ${result.detail ?? ""}`)
  }
  {
    const { result } = one([`export const helper = 1`, `export default function util(): void {}`].join("\n"), {
      "packages/group/pkg2/src/index.ts": `export function apply(): void {}`,
    })
    ok("正例③'：库入口 default 是函数（无 apply）⇒ 不报", result.status === "passed" && !hasFinding(result, "default"), result.status)
  }

  /* ── ④ 抽象 default class = capability seam，不查（官方 :15-16）────── */

  {
    const seam = [`export abstract class Provider { abstract read(): string }`, `export default Provider`].join("\n")
    const { verdict } = one(seam)
    ok("正例④：抽象 default class ⇒ 判成 library、0 findings（provider 要 extend）", verdict.form === "library" && verdict.findings.length === 0, verdict.form)
    // 已知缺口，写进 spec 作为可执行记录：seam 上写 `export const name` 同样不报（官方也不查）。
    const { verdict: v2 } = one([`export abstract class Provider {}`, `export const name = 'x'`, `export default Provider`].join("\n"))
    ok("已知缺口记录：抽象 seam + export const name ⇒ 不报（官方同样不查）", v2.form === "library")
  }

  /* ── ⑤ default 的四种写法都要抓 ─────────────────────────────────── */

  for (const [label, tail] of [
    ["export default 标识符", `export function helper(): void {}\nexport function apply(): void {}\nexport default helper`],
    ["export default class 声明", `export function apply(): void {}\nexport default class Z {}`],
    ["export default class 表达式", `export function apply(): void {}\nexport default class {}`],
    ["export { apply as default }", `export function apply(): void {}\nexport { apply as default }`],
  ] as const) {
    const { result } = one([`export const name = 'x'`, tail].join("\n"))
    ok(`反例⑤：函数插件 + ${label} ⇒ 红`, result.status === "failed", result.status)
  }

  {
    // 同一条语义的另一面：default 就算是 class，函数插件旁边也不许有（官方 :349）
    const { result } = one([`export function apply(): void {}`, `export default class Svc {}`].join("\n"))
    ok("反例⑤'：函数插件 + default 是**合法 class** ⇒ 仍红（无条件、无例外）", result.status === "failed" && hasFinding(result, "函数插件入口旁边有 default"))
  }

  /* ── ⑥ 注释 / 字符串里的 default 不算（AST 而非正则）──────────────── */

  {
    const commented = [
      `// export default apply`,
      `/* export default apply */`,
      `const note = "export default apply"`,
      `export function apply(): void {}`,
      `export const name = 'x'`,
      `void note`,
    ].join("\n")
    ok("干扰：注释与字符串里的 export default ⇒ 不报（这是不用正则的原因）", one(commented).result.status === "passed")
  }

  /* ── ⑦ export * / export { default } from 的跟进语义 ──────────────── */

  {
    // (a) export * 带出 apply ⇒ 形态必须是 function（否则「拆到 impl.ts」就绕过判据）
    const files = {
      [at]: `export * from "./impl.ts"`,
      "packages/group/pkg/src/impl.ts": `export const name = 'x'\nexport function apply(): void {}`,
    }
    const input = corpus(files)
    const v = judgeEntry(ts, input.entries.find((m) => m.file === at)!, input)
    ok("跟进⑦a：apply 经 export * 带出 ⇒ 形态判成 function（不跟进的实现这里会是 library）", v.form === "function", v.form)
    ok("跟进⑦a：无 default ⇒ 绿", judge(files).status === "passed")
  }
  {
    // (b) ESM 语义：export * **不**带 default ⇒ impl 里有 default 也不进入口面（这条钉住不误报）
    const files = {
      [at]: `export * from "./impl.ts"`,
      "packages/group/pkg/src/impl.ts": `export function apply(): void {}\nexport default class Impl {}`,
    }
    const input = corpus(files)
    const facts = moduleFacts(ts, input.entries.find((m) => m.file === at)!, input)
    ok("跟进⑦b：export * 不携带 default（ESM 语义）⇒ defaultKind = none", facts.defaultKind === "none", facts.defaultKind)
    ok("跟进⑦b：但 apply 进来了（values 里有）", facts.values.has("apply"))
  }
  {
    // (c) `export { default } from "./svc.ts"` ⇒ default 确实进了入口面 ⇒ 红
    const files = {
      [at]: [`export function apply(): void {}`, `export { default } from "./svc.ts"`].join("\n"),
      "packages/group/pkg/src/svc.ts": `export default class Svc {}`,
    }
    ok("跟进⑦c：export { default } from ⇒ 入口面有 default ⇒ 红", judge(files).status === "failed")
  }
  {
    // (d) 裸包 specifier 跟不进去 ⇒ 不许静默当「什么都没有」
    const { result } = one([`export * from "some-pkg"`, `export function apply(): void {}`].join("\n"))
    ok("跟进⑦d：export * from 裸包 ⇒ 红并说明「跟不进去」", result.status === "failed" && hasFinding(result, "裸包 specifier"), result.status)
  }
  {
    // (e) 相对 specifier 读不到目标 ⇒ 同样红（看不清 ≠ 没问题）
    const { result } = one([`export * from "./missing.ts"`, `export function apply(): void {}`].join("\n"))
    ok("跟进⑦e：export * 目标读不到 ⇒ 红并说明", result.status === "failed" && hasFinding(result, "读不到"), result.status)
  }
  {
    // (f) 成环 ⇒ 截断处留痕
    const files = {
      [at]: `export * from "./a.ts"\nexport function apply(): void {}`,
      "packages/group/pkg/src/a.ts": `export * from "./b.ts"`,
      "packages/group/pkg/src/b.ts": `export * from "./a.ts"`,
    }
    const r = judge(files)
    ok("跟进⑦f：export * 成环 ⇒ 红并说明「成环」", r.status === "failed" && hasFinding(r, "成环"), r.status)
  }
  {
    // (g) **菱形引用不是环**（回归）：a→b、a→c、b→d、c→d。用全局访问集合会把它误判成环，
    //     实测在官方语料上 llm/llm 就因此假红过一次（retry-policy.ts 被两个分支共用）。
    const files = {
      [at]: `export * from "./b.ts"\nexport * from "./c.ts"\nexport function apply(): void {}`,
      "packages/group/pkg/src/b.ts": `export * from "./d.ts"`,
      "packages/group/pkg/src/c.ts": `export * from "./d.ts"`,
      "packages/group/pkg/src/d.ts": `export const shared = 1`,
    }
    const r = judge(files)
    ok("跟进⑦g：菱形引用（两分支共用 d）⇒ 不报成环（回归：全局集合会假红）", r.status === "passed", `${r.status} ${(r.findings ?? []).map((f) => f.detail).join("|")}`)
  }
  {
    // (h) MAX_HOP 截断也要留痕（链太长看不清 ⇒ 不许当没问题）
    const chain: Record<string, string> = { [at]: `export * from "./l1.ts"\nexport function apply(): void {}` }
    for (let i = 1; i <= 10; i++) chain[`packages/group/pkg/src/l${i}.ts`] = `export * from "./l${i + 1}.ts"`
    chain["packages/group/pkg/src/l11.ts"] = `export const deep = 1`
    const r = judge(chain)
    ok("跟进⑦h：export * 链超过 8 跳 ⇒ 红并说明「超过 8 跳」", r.status === "failed" && hasFinding(r, "超过 8 跳"), r.status)
  }

  /* ── ⑧ 类型导出不算值导出（不许假红）──────────────────────────────── */

  {
    const typed = [`export interface Config { n: number }`, `export type Options = { a: 1 }`, `export function apply(): void {}`].join("\n")
    ok("干扰⑧：export interface / export type ⇒ 不算值导出，不报", one(typed).result.status === "passed")
  }
  {
    const files = {
      [at]: [`export type { Thing } from "./types.ts"`, `export type * from "./types.ts"`, `export function apply(): void {}`].join("\n"),
      "packages/group/pkg/src/types.ts": `export interface Thing { a: 1 }\nexport interface name { b: 2 }`,
    }
    ok("干扰⑧'：export type { } / export type * ⇒ 一律不算值导出", judge(files).status === "passed")
  }
  {
    // `export declare const` emit 不出运行时值
    const { result } = one([`export declare const name: string`, `export function apply(): void {}`].join("\n"))
    ok("干扰⑧'':export declare const ⇒ 不算值导出（declare 不 emit）", result.status === "passed", result.status)
  }

  /* ── ⑨ 防扫空三态：0 入口 / 0 函数插件 / 无编译器，三者都不是绿 ────── */

  {
    const r = judgeEntryExports({ entries: [], readModule: () => null }, ts)
    ok("防扫空①：0 个入口 ⇒ unjudged（不是绿）", r.status === "unjudged", r.status)
    ok("防扫空①：理由码 no-corpus", r.reason === "no-corpus")
    ok("防扫空①：detail 说明「0 个入口」", (r.detail ?? "").includes("0 个入口"), r.detail)
  }
  {
    // 全部判成库 ⇒ 核心射程零样本 ⇒ 不许绿（这条是「插件形态分类器死了」的兜底）
    const r = judge({ [at]: `export const helper = 1`, "packages/group/pkg2/src/index.ts": `export interface Shape { a: number }` })
    ok("防扫空②：有入口但函数插件与服务插件都是 0 ⇒ unjudged（核心射程零样本）", r.status === "unjudged", r.status)
    ok("防扫空②：理由码 no-corpus", r.reason === "no-corpus")
    ok("防扫空②：detail 说明「都是 0」并数出入口数", (r.detail ?? "").includes("都是 0") && (r.detail ?? "").includes("2 个入口"), r.detail)
  }
  {
    // 与官方的有意偏离：只有一种形态时**不**红（官方要求两种各 ≥1）。这条钉住偏离本身。
    const r = judge({ [at]: `export default class OnlyService {}` })
    ok("防扫空②'：只有服务插件、没有函数插件 ⇒ 绿（有意偏离官方「两种各 ≥1」）", r.status === "passed", r.status)
    ok("防扫空②'：绿的理由里数出「函数插件 0 / 服务插件 1」—— 缺口在屏幕上可见", (r.detail ?? "").includes("函数插件 0") && (r.detail ?? "").includes("服务插件 1"), r.detail)
  }
  {
    const r = judgeEntryExports(corpus({ [at]: `export function apply(): void {}` }), null)
    ok("防扫空③：找不到 typescript ⇒ unjudged(no-binary)", r.status === "unjudged" && r.reason === "no-binary", String(r.reason))
  }

  /* ── ⑩ 聚合 ─────────────────────────────────────────────────────── */

  {
    const r = judge({
      "packages/a/ok/src/index.ts": `export function apply(): void {}`,
      "packages/a/bad/src/index.ts": `export function apply(): void {}\nexport default class B {}`,
      "packages/b/bad2/src/index.ts": `export const name = 'x'\nexport default class C {}`,
    })
    ok("聚合：两坏一好 ⇒ failed 且恰 2 条 finding", r.status === "failed" && (r.findings ?? []).length === 2, String((r.findings ?? []).length))
    const files = new Set((r.findings ?? []).map((f) => f.file))
    ok("聚合：两条分别指到两个坏入口，好入口不在里面", files.size === 2 && !files.has("packages/a/ok/src/index.ts"), [...files].join(","))
  }

  /* ── ⑪ 漏判可见：函数插件上的额外值导出，绿也要数出来（文件头差异 ①）── */

  {
    const text = [`export function apply(): void {}`, `export const DEFAULT_TIMEOUT = 30`, `export class Helper {}`].join("\n")
    const { result, verdict } = one(text)
    ok("漏判可见：额外值导出不影响判绿（本版口径只判 default）", result.status === "passed", result.status)
    ok(
      "漏判可见：detail 数出「另有 2 个…本判据不判」",
      (result.detail ?? "").includes("另有 2 个") && (result.detail ?? "").includes("本判据不判"),
      result.detail,
    )
    ok("漏判可见：notJudgedValues 逐名列出（DEFAULT_TIMEOUT,Helper）", verdict.notJudgedValues.join(",") === "DEFAULT_TIMEOUT,Helper", verdict.notJudgedValues.join(","))
    ok("漏判可见：干净的函数插件 detail 明说「没有…之外的值导出」", (one(`export function apply(): void {}`).result.detail ?? "").includes("没有 apply/name/inject/Config 之外"))
  }

  /* ── ⑫ 真扫盘 fixture + 变异（与门禁同一条路）─────────────────────── */

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eex-scan-"))
    try {
      const write = (rel: string, text: string) => {
        const abs = path.join(tmp, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, text)
      }
      write("packages/util/kernel/src/index.ts", `export function apply(): void {}\nexport const name = 'kernel'`)
      write("packages/util/other/src/index.ts", `export default class Other {}`)
      write("packages/util/nomentry/src/other.ts", `export const x = 1`) // 没有 index.ts ⇒ 不进语料
      write("node_modules/junk/src/index.ts", `export default 1`) // 不许扫
      write(".hidden/pkg/src/index.ts", `export default 1`) // 不许扫

      const input = scanEntries(tmp)
      ok("真扫盘：只认 packages/<g>/<p>/src/index.ts（2 个）", input.entries.length === 2, String(input.entries.length))
      ok("真扫盘：跳过 node_modules 与点目录", !input.entries.some((m) => m.file.includes("node_modules") || m.file.includes(".hidden")))
      const clean = judgeEntryExports(input, loadTs(tmp))
      ok("真扫盘：全合规 ⇒ 绿", clean.status === "passed", `${clean.status} ${clean.detail ?? ""}`)
      ok("真扫盘：函数插件 1 / 服务插件 1 / 库 0 都数对了", (clean.detail ?? "").includes("函数插件 1 / 服务插件 1"), clean.detail)

      // 变异：造坏 ⇒ 红；恢复 ⇒ 绿
      const entryAbs = path.join(tmp, "packages/util/kernel/src/index.ts")
      const original = fs.readFileSync(entryAbs, "utf8")
      fs.writeFileSync(entryAbs, `${original}\nexport default apply\n`)
      const bad = judgeEntryExports(scanEntries(tmp), loadTs(tmp))
      ok("变异：入口加一行 export default apply ⇒ 红", bad.status === "failed", bad.status)
      ok(
        "变异：红的那条指到 kernel 入口第 3 行",
        (bad.findings ?? []).some((f) => f.file === "packages/util/kernel/src/index.ts" && f.line === 3),
        JSON.stringify(bad.findings),
      )
      fs.writeFileSync(entryAbs, original)
      const restored = judgeEntryExports(scanEntries(tmp), loadTs(tmp))
      ok("变异：恢复后 ⇒ 绿（红的来源只可能是那一行）", restored.status === "passed", restored.status)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立`
      : `✓ spec 全过（${total} 条断言：三类形态正反例 / default 四种写法 / 注释干扰 / export * 跟进六例 / 类型导出 / 防扫空三态 / 聚合 / 漏判可见 / 真扫盘 / 变异）`,
  )
  return fails === 0
}
