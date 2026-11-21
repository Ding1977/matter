/**
 * 插件入口导出判据（ISS-838 / W0-GATE-G2）—— 照抄 DSH `scripts/verify-plugin-entry-exports.ts` 的**第一刀**。
 *
 * ## 判什么（一句话）
 *
 * **函数插件（入口有值导出 `apply`）旁边不许有 `default` 导出。** 无条件、无例外、不看 default 是什么。
 *
 * ## 为什么（事故驱动，不是理论）
 *
 * DSH postmortem `0001-acp-default-export-drops-inject.md`：ACP server 在真编辑器连上的瞬间崩，
 * **178 个绿单测 + 100% 行覆盖率**，产品完全不能用。根因是入口多了一行 `export default apply`。
 *
 * Loader `unwrapExports`（官方 `vendor/loader/src/index.ts:41`，postmortem `:43` 引用）：
 *
 * ```js
 * exports = exports.default ?? exports        // ← 优先 .default
 * ```
 *
 * 有 default 时 Loader 拿到的是**裸 `apply` 函数**，而 `inject` / `name` / `Config` 住在
 * **兄弟命名导出**上 —— 解包到 `.default` 等于把整个命名空间扔掉，fiber 用空 `inject` 建起来，
 * apply 第一行 `ctx.agents` 就抛 `cannot get property "agents" without inject`。
 *
 * 事故的形态决定了判据的形态：`export default apply` 这一行**在任何测试里都看不出问题**
 * （测试手工 `ctx.plugin({name, inject, apply})` 挂载，从不走 Loader），所以它必须是**静态判据**。
 *
 * ## 三类入口形态（逐条照抄官方 `verify-plugin-entry-exports.ts:7-14`，只留第一刀）
 *
 * | 形态 | 判据 |
 * |---|---|
 * | **有 `apply`**（函数插件） | **有 `default` 即红**（无条件、无例外，default 是不是 class 都不看） |
 * | **无 `apply`，default 是 class**（服务插件） | `name` / `inject` / `Config` 视为**值导出** ⇒ 红 |
 * | **无 `apply`，default 不是 class**（库） | 不检查 |
 *
 * **不查**：抽象 default class（capability seam，provider 要 extend，官方 `:15-16` 同一处置）。
 *
 * ## ⚠️ 三处与官方的差异（逐条交代，不把简化说成等价）
 *
 * ### ① **口径收窄到「default」**（有意，且**漏判在屏幕上可见**）
 *
 * 官方全文不是只判 default：函数插件入口除 `name`/`inject`/`Config`/`apply` 外**任何值导出**都红
 * （另加 Service / Error 子类豁免 + `scripts/plugin-entry-existing-exports.ts` 的 grandfather 白名单）。
 *
 * 本版**只判 default**。实测官方语料 373 个入口：181 个函数插件入口，其中 **30 个**带额外值导出
 * （`ACP_APP_STARTUP_SERVICE` / `DEFAULT_MAX_RESULT_BYTES` / `recordFeedback` …），官方靠白名单 grand 住。
 * 我们新树还没这些，**现在照抄宽口径只会搬一张空表 + 一堆走不到的分支**（同 G1 第 9 条的理由）。
 *
 * ⛔ **但漏判不许静默**：绿的时候 `detail` 会数出「另有 X 个函数插件入口带 apply 之外的值导出」，
 * 每次跑都在屏幕上。判据不判它们，读者仍看得见它们 —— 这是「记下洞」与「假装没洞」的差别。
 *
 * ### ② **纯 AST，不上 Program / TypeChecker**
 *
 * 官方用 `TypeScriptProject` + `checker.getTypeOfSymbol(...).getConstructSignatures()` 判
 * 「default 是不是 Loader 构造得出的 class」。那需要每个包都能被 tsconfig 聚合编译 —— 新树现在
 * `packages/` 下**一个包都没有**，`tsconfig.host.json` 编空气。搬过来等于搬一条永远走不到的路。
 *
 * 本版按**语法**判：`export default class ...` / `export default X`（X 本文件声明的 class）⇒ class；
 * 箭头函数 / 函数表达式 / `export default function` ⇒ 不是 class；**判不出的（import 来的类、
 * mixin 调用结果、找不到本地声明）⇒ fail-closed 当服务插件处理**，finding 里点明「判不出」。
 * 实测官方语料 115 个 default 全落在可判档（86 class + 15 abstract + 14 inline class，
 * **0 个 imported / unresolved**）⇒ 这条 fail-closed 的代价今天为零。
 *
 * ### ③ **`export *` / `export { default } from` 会跟进，不当作看不见**
 *
 * 官方靠 checker 展开。纯 AST 若「不展开」，下一个人写 `export * from './impl.ts'`（impl 里有
 * `export function apply`）⇒ 函数插件形态被漏判 ⇒ **假绿**，而那正是本判据存在的理由。
 * 所以本版递归跟进**相对 specifier**（带环检测、深度上限 8）。代价实测为零：官方 19 个含
 * `export *` 的入口里，带出 `apply` / `name` / `inject` / `Config` 的是 **0 个**。
 * **裸包 specifier**（`export * from 'foo'`）判不了 ⇒ 红并说明（实测官方 0 例）。
 *
 * ## 退出码（`scripts/lib/gate-runtime.ts` 口径）
 *
 * | 码 | 含义 |
 * |---|---|
 * | 0 | 绿：入口全部合本判据 |
 * | 1 | 红：有违规（或「判不出」按红处理，见 ② ） |
 * | 2 | **判不了**，不当绿：`packages/*\/*\/src/index.ts` 0 个（`no-corpus`）· 扫到入口但**0 个函数插件**
 *     （本判据的核心射程一个样本都没有 ⇒ 什么都没判）· 找不到 typescript（`no-binary`） |
 *
 * ⚠️ 「有入口但 0 个函数插件」判 unjudged 而不是绿，是官方 `scanFailures` 那条
 * 「a corpus without a function plugin」的同一意图 —— **语料里没有被判的对象 ≠ 判过了**。
 *
 * ## 已知不判（写在这里免得下一个人以为是漏了）
 *
 * · `export =`（TS 的 CJS 导出）：不是 default，Loader 也不走这条路；且 ESM 包出现它该由 G1 抓。
 * · 同一入口里 `apply` 的**类型**（是函数还是箭头）—— 本判据只问「有没有」，不问形状。
 * · 入口之外的模块（`src/impl.ts` 等）：本判据只判入口。**但** `export *` 带出的名字算入口的
 *   （见差异 ③）—— 那条不是射程外，是入口的一部分。
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult, type Finding } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-plugin-entry-exports"

/** 语料：官方 `ENTRY_GLOB`（`verify-plugin-entry-exports.ts:45`）逐字相同。 */
export const ENTRY_GLOB = "packages/*/*/src/index.ts"

/** Loader 从模块命名空间读的四个值（官方 `:54` `LOADER_FIELDS`）。 */
export const LOADER_FIELDS: readonly string[] = ["name", "inject", "Config", "apply"]

/** 服务插件入口上「值导出即红」的三个（`apply` 属于函数插件那一类，不在此列）。 */
export const SERVICE_FIELDS: readonly string[] = ["name", "inject", "Config"]

/** `export *` / `export { default } from` 跟进的深度上限。环由 `seen` 截断，这个是防链式长龙。 */
const MAX_HOP = 8

/** 一个模块的源码（仓库相对路径 + 正文）。 */
export interface ModuleSource {
  file: string
  text: string
}

/** 判据输入：语料 + 一个「读别的模块」的口子。spec 用内存 map，main 用 fs。 */
export interface EntryExportsInput {
  /** 语料：`packages/<group>/<pkg>/src/index.ts` */
  entries: readonly ModuleSource[]
  /** 读一个模块（跟进 `export *` 用）；null = 不存在 / 读不到 */
  readModule: (file: string) => ModuleSource | null
}

/** default 导出是什么。前四个是「判出来了」，`unresolved` 是「判不出」（fail-closed，见文件头 ②）。 */
export type DefaultKind = "none" | "class" | "abstract-class" | "not-class" | "unresolved"

/** 一个本地声明是本文件的什么值 —— 只用于把 `export default X` 回溯到 X 的声明。 */
type DeclKind = "class" | "abstract-class" | "function" | "value" | "unknown"

/** 一个模块的运行时导出面。 */
interface ModuleFacts {
  /** 运行时**值**导出的名字（不含 default；类型导出不算，`export *` 带出的合并进来） */
  values: Set<string>
  /** 每个值导出在本文件/来源文件里的声明种类，供 `export default X` 回溯 */
  decl: Map<string, DeclKind>
  defaultKind: DefaultKind
  /** default 出现在第几行（1-based）；无 default 为 null */
  defaultLine: number | null
  /** default 的形态描述（进 finding，让人知道要删哪一行） */
  defaultShape: string
  /** 跟在跟进过程中遇到「判不了」的原因（裸包 specifier / 环 / 超深）；空 = 没遇到 */
  blindSpots: string[]
}

/** 一个入口的判定结论（spec 直接断言这些，不必解析 finding 文案）。 */
export interface EntryVerdict {
  file: string
  form: "function" | "service" | "library"
  /** 本判据要报的违规行（空数组 = 这个入口合规） */
  findings: Finding[]
  /** 函数插件入口上 `apply`/`name`/`inject`/`Config` **之外**的值导出 —— 官方全文口径会报，本版不报（见文件头 ①） */
  notJudgedValues: string[]
}

/* ───────────────────────────── 语法小工具 ───────────────────────────── */

type Ts = any

function mods(ts: Ts, node: unknown): any[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []
}

function hasMod(ts: Ts, node: unknown, kind: number): boolean {
  return mods(ts, node).some((m: { kind: number }) => m.kind === kind)
}

const isExport = (ts: Ts, n: unknown): boolean => hasMod(ts, n, ts.SyntaxKind.ExportKeyword)
const isDefault = (ts: Ts, n: unknown): boolean => hasMod(ts, n, ts.SyntaxKind.DefaultKeyword)
const isAbstract = (ts: Ts, n: unknown): boolean => hasMod(ts, n, ts.SyntaxKind.AbstractKeyword)
const isDeclare = (ts: Ts, n: unknown): boolean => hasMod(ts, n, ts.SyntaxKind.DeclareKeyword)

function lineOf(ts: Ts, node: unknown, sf: unknown): number {
  return (sf as any).getLineAndCharacterOfPosition((node as any).getStart(sf)).line + 1
}

/** 解构绑定里的名字（官方 `:175-178` 同一实现）。 */
function bindingNames(ts: Ts, name: unknown): string[] {
  if (ts.isIdentifier(name)) return [(name as any).text]
  const elements: any[] = (name as any).elements ?? []
  return elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(ts, e.name)))
}

/* ───────────────────────────── 单模块导出面 ───────────────────────────── */

const emptyFacts = (): ModuleFacts => ({
  values: new Set(),
  decl: new Map(),
  defaultKind: "none",
  defaultLine: null,
  defaultShape: "",
  blindSpots: [],
})

/** 本文件里 `name` 是什么种类 —— 只查顶层声明，够把 `export default X` 回溯一格。 */
function localDecl(ts: Ts, sf: any, name: string): DeclKind {
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st) && st.name?.text === name) return isAbstract(ts, st) ? "abstract-class" : "class"
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return "function"
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name || !d.initializer) continue
        if (ts.isClassExpression(d.initializer)) return isAbstract(ts, d.initializer) ? "abstract-class" : "class"
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) return "function"
        return "value"
      }
    }
  }
  return "unknown"
}

/** `export default <expr>` 里的 expr 是什么种类。判不出 ⇒ `unknown`（fail-closed，见文件头 ②）。 */
function classifyDefaultExpr(ts: Ts, expr: any, sf: any): { kind: DefaultKind; shape: string } {
  if (ts.isClassExpression(expr)) {
    return isAbstract(ts, expr) ? { kind: "abstract-class", shape: "class 表达式（abstract）" } : { kind: "class", shape: "class 表达式" }
  }
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return { kind: "not-class", shape: "函数表达式" }
  if (ts.isIdentifier(expr)) {
    const decl = localDecl(ts, sf, expr.text)
    if (decl === "class") return { kind: "class", shape: `本地 class ${expr.text}` }
    if (decl === "abstract-class") return { kind: "abstract-class", shape: `本地 abstract class ${expr.text}` }
    if (decl === "function") return { kind: "not-class", shape: `本地函数 ${expr.text}` }
    // import 来的 / 找不到本地声明 ⇒ 判不出。按服务插件处理（fail-closed）。
    return { kind: "unresolved", shape: `标识符 ${expr.text}（本地无声明，多半是 import 来的 —— 纯 AST 判不出它是不是 class）` }
  }
  if (ts.isCallExpression(expr)) return { kind: "unresolved", shape: "调用表达式（mixin 结果）—— 纯 AST 判不出" }
  return { kind: "unresolved", shape: ts.SyntaxKind[expr.kind] ?? "未知表达式" }
}

/** 相对 specifier 的三种候选（`./x.ts` / `./x` / `./x/index.ts`），与 TS 的解析顺序一致。 */
function candidateSpecs(spec: string): string[] {
  return [spec, `${spec}.ts`, `${spec}/index.ts`]
}

function toRepoRel(fromFile: string, spec: string): string {
  const dir = path.posix.dirname(fromFile)
  return path.posix.normalize(path.posix.join(dir, spec))
}

/**
 * 一个模块的运行时导出面。
 *
 * `export *` 与 `export { default } from` 会**递归跟进相对 specifier**（文件头差异 ③）；
 * 链长由 `MAX_HOP` 截断 —— 截断处记进 `blindSpots`，不静默当「什么都没有」。
 *
 * ⚠️ `path` 是**当前这条链上的祖先**，不是「全局访问过的文件」：
 * 用全局集合会把**菱形引用**（a→b、a→c、b→d、c→d）误判成环 —— 实测在官方语料上
 * `llm/llm` 就因此假红了一次（`retry-policy.ts` 被两个分支共用）。环的定义是「回到祖先」。
 */
export function moduleFacts(ts: Ts, mod: ModuleSource, input: EntryExportsInput, path: ReadonlySet<string> = new Set()): ModuleFacts {
  const facts = emptyFacts()
  if (path.has(mod.file)) {
    facts.blindSpots.push(`${mod.file}：export * 跟进回到链上已访问的文件（成环），此处导出面判不了`)
    return facts
  }
  if (path.size >= MAX_HOP) {
    facts.blindSpots.push(`${mod.file}：export * 链超过 ${MAX_HOP} 跳，此处导出面判不了`)
    return facts
  }
  const here = new Set(path).add(mod.file)
  const sf = ts.createSourceFile(mod.file, mod.text, ts.ScriptTarget.Latest, true)
  /** 星号导出延后展开：ESM 语义下它不覆盖本文件自己的名字（官方 `:278-288` 同一顺序）。 */
  const stars: any[] = []

  const follow = (spec: string): ModuleFacts | null => {
    for (const cand of candidateSpecs(spec)) {
      const rel = toRepoRel(mod.file, cand)
      const target = input.readModule(rel)
      if (target) return moduleFacts(ts, target, input, here)
    }
    return null
  }

  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      // `export type * from` / `export type { X }`：类型面，emit 不出东西 ⇒ 一个名字都不算值。
      if (st.isTypeOnly) continue
      const clause = st.exportClause
      const spec: string | undefined = st.moduleSpecifier?.text
      if (clause === undefined) {
        // `export * from "x"` —— default 不会被带出（ESM 语义），其余值全带出。
        if (spec === undefined) continue
        stars.push({ spec, line: lineOf(ts, st, sf) })
        continue
      }
      if (ts.isNamespaceExport(clause)) {
        facts.values.add(clause.name.text)
        facts.decl.set(clause.name.text, "value")
        continue
      }
      for (const el of clause.elements) {
        if (el.isTypeOnly) continue
        const exported: string = el.name.text
        const original: string = (el.propertyName ?? el.name).text
        if (exported !== "default") {
          facts.values.add(exported)
          facts.decl.set(exported, spec === undefined ? localDecl(ts, sf, original) : "unknown")
          continue
        }
        // `export { default } from "./x.ts"` 或 `export { X as default } from "./x.ts"`。
        facts.defaultLine = lineOf(ts, st, sf)
        if (spec === undefined) {
          const decl = localDecl(ts, sf, original)
          facts.defaultKind = decl === "class" ? "class" : decl === "abstract-class" ? "abstract-class" : decl === "function" ? "not-class" : "unresolved"
          facts.defaultShape = `export { ${original} as default }（本地 ${decl}）`
        } else {
          const target = follow(spec)
          facts.defaultKind = target?.defaultKind === "none" ? "unresolved" : target?.defaultKind ?? "unresolved"
          facts.defaultShape = `export { ${original} as default } from "${spec}"`
          if (target) facts.blindSpots.push(...target.blindSpots)
        }
      }
      continue
    }
    if (ts.isExportAssignment(st)) {
      if (st.isExportEquals) continue // `export =`：不是 default（见文件头「已知不判」）
      const { kind, shape } = classifyDefaultExpr(ts, st.expression, sf)
      facts.defaultKind = kind
      facts.defaultLine = lineOf(ts, st, sf)
      facts.defaultShape = shape
      continue
    }
    // 带 `declare` 的导出 emit 不出运行时值（官方 `:259` 同一个排除）。
    if (!isExport(ts, st) || isDeclare(ts, st)) continue
    if (ts.isFunctionDeclaration(st)) {
      if (isDefault(ts, st)) {
        facts.defaultKind = "not-class"
        facts.defaultLine = lineOf(ts, st, sf)
        facts.defaultShape = "函数声明（export default function）"
      } else if (st.name) {
        facts.values.add(st.name.text)
        facts.decl.set(st.name.text, "function")
      }
    } else if (ts.isClassDeclaration(st)) {
      if (isDefault(ts, st)) {
        facts.defaultKind = isAbstract(ts, st) ? "abstract-class" : "class"
        facts.defaultLine = lineOf(ts, st, sf)
        facts.defaultShape = isAbstract(ts, st) ? "abstract class 声明" : "class 声明"
      } else if (st.name) {
        facts.values.add(st.name.text)
        facts.decl.set(st.name.text, isAbstract(ts, st) ? "abstract-class" : "class")
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        for (const name of bindingNames(ts, d.name)) {
          facts.values.add(name)
          const init: any = d.initializer
          facts.decl.set(
            name,
            init && ts.isClassExpression(init) ? "class" : init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? "function" : "value",
          )
        }
      }
    } else if (ts.isEnumDeclaration(st)) {
      facts.values.add(st.name.text)
      facts.decl.set(st.name.text, "value")
    } else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) {
      // `export namespace X` 若含值就有运行时导出；纯类型的 namespace emit 不出东西，但纯 AST 分不出 ⇒ 算值（保守）
      facts.values.add(st.name.text)
      facts.decl.set(st.name.text, "value")
    }
    // interface / type alias：类型面，不 emit ⇒ 不算值导出。这是 `export type Config` 不被假红的原因。
  }

  for (const star of stars) {
    if (!star.spec.startsWith(".")) {
      facts.blindSpots.push(`${mod.file}:${star.line}：export * from "${star.spec}"（裸包 specifier，纯 AST 跟不进去 —— 那里若带出 apply，本判据看不见）`)
      continue
    }
    const target = follow(star.spec)
    if (target === null) {
      facts.blindSpots.push(`${mod.file}:${star.line}：export * from "${star.spec}" 的目标读不到 —— 导出面判不了`)
      continue
    }
    facts.blindSpots.push(...target.blindSpots)
    for (const name of target.values) {
      if (name === "default" || facts.values.has(name)) continue // 本文件自己的名字优先
      facts.values.add(name)
      facts.decl.set(name, target.decl.get(name) ?? "unknown")
    }
  }
  return facts
}

/* ───────────────────────────── 判定（纯函数） ───────────────────────────── */

/**
 * 判一个入口。`ts` 为 null ⇒ unjudged(no-binary)（调用方拿不到编译器）。
 *
 * 返回的 `EntryVerdict.form` 是**判据自己的分类**，spec 直接断言它 —— 不看 finding 文案。
 */
export function judgeEntry(ts: Ts, mod: ModuleSource, input: EntryExportsInput): EntryVerdict {
  const facts = moduleFacts(ts, mod, input)
  const findings: Finding[] = []
  const push = (line: number | null, detail: string) => findings.push({ file: mod.file, line: line ?? undefined, detail })

  if (facts.values.has("apply")) {
    // 形态一：函数插件。default **无条件**红 —— 不看它是不是 class（官方 `:349` 同一处置：
    // 「The Loader loads a default export instead of a function plugin's namespace,
    //   so the class allowance never covers it」）。
    if (facts.defaultKind !== "none") {
      push(
        facts.defaultLine,
        `函数插件入口旁边有 default 导出（${facts.defaultShape}）—— Cordis Loader 的 unwrapExports 先取 ` +
          `\`exports.default ?? exports\`，会把整个命名空间丢掉，name/inject/Config 全部失效。` +
          `postmortem 0001 就是这个：178 个绿测试 + 100% 覆盖率，产品完全用不了。删掉这一处就够了。`,
      )
    }
    const notJudged = [...facts.values].filter((v) => !LOADER_FIELDS.includes(v)).sort()
    const verdict: EntryVerdict = { file: mod.file, form: "function", findings, notJudgedValues: notJudged }
    addBlindSpotFindings(facts, mod, push)
    return verdict
  }

  if (facts.defaultKind === "class" || facts.defaultKind === "unresolved") {
    // 形态二：服务插件。Loader 从 **default class 上**读 name/inject/Config；
    // 模块命名空间上那份它根本不看 ⇒ 写在那里等于没写。
    for (const field of SERVICE_FIELDS) {
      if (!facts.values.has(field)) continue
      const why =
        facts.defaultKind === "unresolved"
          ? `default 是什么判不出（${facts.defaultShape}），按服务插件处理（fail-closed）`
          : `default 是 class（${facts.defaultShape}）`
      push(
        facts.defaultLine,
        `服务插件入口把 ${field} 当**值导出** —— ${why}，Loader 只从 default class 上读 ${field}，` +
          `命名空间上这份不会被读，改它等于没改。改成 \`export type ${field}\` 或删掉。`,
      )
    }
    const verdict: EntryVerdict = { file: mod.file, form: "service", findings, notJudgedValues: [] }
    addBlindSpotFindings(facts, mod, push)
    return verdict
  }

  // 形态三：库（无 apply、default 不是 class、或抽象 default class 的 capability seam）—— 不检查。
  const verdict: EntryVerdict = { file: mod.file, form: "library", findings, notJudgedValues: [] }
  addBlindSpotFindings(facts, mod, push)
  return verdict
}

/** 「跟进时看不清的地方」按红处理 —— 看不清不等于没问题（同仓 `verify-plugin-shape` 的「读不到 ⇒ 红」）。 */
function addBlindSpotFindings(facts: ModuleFacts, mod: ModuleSource, push: (line: number | null, detail: string) => void): void {
  for (const spot of new Set(facts.blindSpots)) push(null, `导出面判不了：${spot}`)
  void mod
}

/**
 * 语料级判定（纯函数）。`ts` 为 null ⇒ unjudged(no-binary)。
 *
 * ⚠️ **两级「什么都没判」都判 unjudged，不当绿**：
 *   ① `0 个入口` ⇒ 扫描面本身是空（glob 坏了 / 新树还没有包）。
 *   ② `有入口，但函数插件与服务插件都是 0`（全部判成库）⇒ 插件形态分类器死了，或语料里根本没有插件。
 *      两种情况下本判据的核心射程**一个样本都没判到**，而屏幕上会显示 ✓ —— 那正是要防的假绿形态。
 *
 * ⚠️ **与官方的一处有意偏离**（官方 `scanFailures` 要求函数插件与服务插件**各自** ≥1，缺哪个都红）：
 * 我们不这么判。新树刚起步时很可能只有一种形态（例如第一批包全是函数插件），
 * 「缺另一种形态就红」会让判据在合法状态下永久红/不可判，红多了就会被关掉。
 * 代价：另一种形态的**分类器**若坏了不会被这一条抓住 —— 但那个数写在绿的 detail 里
 * （「函数插件 N / 服务插件 M / 库 K」），坏成 0 时屏幕上看得到，且上面 ② 会兜住「两种都 0」。
 */
export function judgeEntryExports(input: EntryExportsInput, ts: unknown): GateResult {
  if (ts === null || ts === undefined) {
    return unjudged(GATE, "no-binary", `找不到 typescript 编译器（候选见 loadTs）⇒ 扫不出导出面，判不了（不是绿）`)
  }
  if (input.entries.length === 0) {
    return unjudged(GATE, "no-corpus", `${ENTRY_GLOB} 一个都没扫到（0 个入口）—— 判不了，不当绿`)
  }
  const verdicts = input.entries.map((mod) => judgeEntry(ts as Ts, mod, input))
  const findings = verdicts.flatMap((v) => v.findings)
  const fnCount = verdicts.filter((v) => v.form === "function").length
  const svcCount = verdicts.filter((v) => v.form === "service").length
  const libCount = verdicts.filter((v) => v.form === "library").length

  if (fnCount === 0 && svcCount === 0) {
    return unjudged(
      GATE,
      "no-corpus",
      `扫到 ${input.entries.length} 个入口，但函数插件与服务插件**都是 0**（全部判成库）⇒ ` +
        `本判据的核心射程一个样本都没判到（插件形态分类器可能坏了），不当绿`,
    )
  }
  if (findings.length) return { gate: GATE, status: "failed", findings }

  // ⚠️ 漏判必须可见（文件头差异 ①）：官方全文口径会报的那批值导出，这里数出来报数。
  const notJudged = verdicts.reduce((n, v) => n + v.notJudgedValues.length, 0)
  const leak =
    notJudged === 0
      ? "函数插件入口没有 apply/name/inject/Config 之外的值导出"
      : `⚠️ 另有 ${notJudged} 个函数插件入口上的值导出（apply/name/inject/Config 之外）**本判据不判** —— 官方全文口径会报，G2 第二刀未做`
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${input.entries.length} 个入口（函数插件 ${fnCount} / 服务插件 ${svcCount} / 库 ${libCount}）合本判据；${leak}`,
  }
}

/* ───────────────────────────── 装配（IO） ───────────────────────────── */

const TS_CANDS = [
  "forge-ui/node_modules/typescript/lib/typescript.js",
  "forge-pm/node_modules/typescript/lib/typescript.js",
  "node_modules/typescript/lib/typescript.js",
]

/**
 * 加载 typescript（**工具**，不是被扫对象）。候选表与 `gen-layer-graph.ts:587-590` / G7 一致。
 * 找不到 ⇒ null（调用方判 unjudged，**不许降级成正则** —— 正则会把注释里的 default 当真）。
 */
export function loadTs(root: string = REPO): unknown | null {
  for (const base of [root, REPO]) {
    let req: NodeRequire
    try {
      req = createRequire(path.join(base, "package.json"))
    } catch {
      continue
    }
    for (const c of TS_CANDS) {
      const abs = path.join(base, c)
      if (!fs.existsSync(abs)) continue
      try {
        return req(abs) // 传绝对路径：`forge-ui/node_modules/...` 当模块名会被当成 scope 包
      } catch {
        /* 换下一个候选 */
      }
    }
    try {
      return req("typescript")
    } catch {
      /* 换下一个 base */
    }
  }
  return null
}

/** 扫 `packages/<group>/<pkg>/src/index.ts`。返回空数组 = 一个入口都没有（由 judge 判 unjudged）。 */
export function scanEntries(root: string = REPO): EntryExportsInput {
  const entries: ModuleSource[] = []
  const base = path.join(root, "packages")
  const dirs = (dir: string): string[] =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
          .map((e) => e.name)
          .sort()
      : []
  for (const group of dirs(base)) {
    for (const pkg of dirs(path.join(base, group))) {
      const rel = `packages/${group}/${pkg}/src/index.ts`
      const abs = path.join(root, rel)
      if (!fs.existsSync(abs)) continue
      try {
        entries.push({ file: rel, text: fs.readFileSync(abs, "utf8") })
      } catch {
        // 读不到 ⇒ 当成 0 字节入口会让它「无 apply 无 default ⇒ 库 ⇒ 绿」。宁可整格 unjudged。
        return { entries: [], readModule: () => null }
      }
    }
  }
  return {
    entries,
    readModule: (file: string) => {
      const abs = path.join(root, file)
      try {
        return fs.existsSync(abs) ? { file, text: fs.readFileSync(abs, "utf8") } : null
      } catch {
        return null
      }
    },
  }
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-plugin-shape.ts:226 的注释）。
  // `--root`：只给自检/变异测试指一棵构造树用（生产恒为仓库根）。
  const rootArg = process.argv.indexOf("--root")
  const root = rootArg > 0 && process.argv[rootArg + 1] ? path.resolve(process.argv[rootArg + 1]) : REPO
  runGate({ name: GATE, main: () => judgeEntryExports(scanEntries(root), loadTs(root)) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
