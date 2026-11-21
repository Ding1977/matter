/**
 * 模块级 await 守卫（ISS-883）—— 移植 DSH `scripts/verify-no-top-level-await.ts`（267 行）。
 *
 * ## 判什么
 *
 * 任何可 import 的包源模块在**模块作用域** await 都会让模块求值异步化：所有 importer 的求值
 * 都要等它；rejection 冒成模块求值失败，而不是模块自己能处理的错误；且它无法降级成
 * client/worker bundle 加载的同步 CJS wrapper。tsc / oxlint 都不报 —— 这是「能不能加载」的
 * 真实质量属性。包代码把异步工作放进函数里调用（如显式 main()）并在起点处理失败。
 *
 * 可执行文件不 import，故按**声明**排除（不按文件名猜）：以 `#!` 开头的文件，以及包 manifest
 * `bin` 字段命名的 build 输出对应的源文件。本树当前无 shebang / bin，保留排除以防未来误伤。
 *
 * 发现是语法感知的：TypeScript parser 找 await 表达式 / for await 循环 / await using 声明中
 * 最近的函数体就是模块本身的那些；包括嵌在顶层 block / if / for / class 计算成员里的。字符串、
 * 模板字面量、注释里的 await 不是代码，parser 天然不报。
 *
 * ## 三态 fail-closed（退出码 = gate-runtime 口径：0 绿 / 1 红 / 2 判不了）
 *
 * | 观测 | 判定 |
 * |---|---|
 * | 顶层 await 违例（三种形态任一） | ⛔ 红（exit 1），finding 带 文件:行 + 源码行 + 怎么改 |
 * | 语料漏掉某个含 TS 的包 src 目录（扫描面被缩小） | ⛔ 红（exit 1）—— 完整性失败不是判不了 |
 * | 语料全绿（本树即此态：28 .ts / 0 顶层 await） | ✅ 绿（exit 0） |
 * | 0 源文件 ⇒ no-corpus / 找不到 typescript ⇒ no-binary | ⚠️ 判不了（exit 2，带理由码） |
 *
 * ## 与 DSH 原样的两处有意差异（不把简化说成等价）
 *
 * ① **删掉「语料至少一个 .tsx」断言**：DSH `sourceCorpus()` 强制语料含 .tsx（它产品有
 *    client/UI），本树 28 .ts / 0 .tsx，照抄会抛 "corpus holds no .tsx file" ⇒ 上线即假红。
 *    保留其余两条完整性检查（语料非空 + 不漏任何含 TS 的包 src 目录），防扫描面缩小假绿。
 * ② **语料问题不裸抛**：DSH 在语料空/缺 TSX/漏包时用 `throw`；本实现转成判据三态输出
 *    （0 文件 = unjudged no-corpus；漏包 = failed），不裸抛、不冒充绿。
 */
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs"
import path, { join, posix, resolve } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-no-top-level-await"
const REPO = resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** 语料 glob：每个 workspace 包 `src/` 下的 TS/TSX 文件。 */
export const SOURCE_GLOB = "packages/*/*/src/**/*.{ts,tsx}"

/** typescript 候选路径（与 verify-no-unknown-casts / verify-export-jsdoc 同款）。 */
export const TS_CANDIDATES = [
  "forge-ui/node_modules/typescript/lib/typescript.js",
  "forge-pm/node_modules/typescript/lib/typescript.js",
  "node_modules/typescript/lib/typescript.js",
]

/** 加载 typescript（工具，不是被扫对象）；取不到返回 null，由 judge 转 unjudged(no-binary)。 */
export function loadTs(root: string = REPO): any | null {
  for (const base of [root, REPO]) {
    let req: NodeRequire
    try {
      req = createRequire(join(base, "package.json"))
    } catch {
      continue
    }
    for (const candidate of TS_CANDIDATES) {
      const abs = join(base, candidate)
      if (!existsSync(abs)) continue
      try {
        return req(abs)
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

/** 为什么一个语料文件不参与检查。 */
export type ExcludedEntry = "shebang" | "bin"

/**
 * 包 manifest 的 `bin` 字段指向的源文件。
 * @param packageDirectory - 仓库相对 POSIX 包目录。
 * @param bin - manifest 的 bin 字段：路径、name→path 映射，或缺失。
 * @returns 每个 `lib/<path>.js` 目标对应的仓库相对候选源（.ts 与 .tsx）。
 */
export function binSources(packageDirectory: string, bin: unknown): string[] {
  const targets = typeof bin === "string"
    ? [bin]
    : typeof bin === "object" && bin !== null ? Object.values(bin).filter(value => typeof value === "string") : []
  return targets.flatMap((target) => {
    const match = /^lib\/(.+)\.js$/u.exec(posix.normalize(target))
    if (match === null) return []
    return ["ts", "tsx"].map(extension => `${packageDirectory}/src/${match[1] as string}.${extension}`)
  })
}

/** 读每个拥有语料文件的包的 `bin` 命名源。 */
function binSourcesOfCorpus(repositoryRoot: string, corpus: readonly string[]): Set<string> {
  const sources = new Set<string>()
  for (const directory of new Set(corpus.map(file => file.split("/").slice(0, 3).join("/")))) {
    const manifest = join(repositoryRoot, directory, "package.json")
    let bin: unknown
    try {
      bin = (JSON.parse(readFileSync(manifest, "utf8")) as { bin?: unknown }).bin
    } catch {
      continue
    }
    for (const source of binSources(directory, bin)) sources.add(source)
  }
  return sources
}

/**
 * 把一个语料文件归类为「按声明排除的可执行文件」。
 * @returns 排除理由，或 undefined（可 import 的模块）。
 */
export function excludedEntry(file: string, sourceText: string, bins: ReadonlySet<string>): ExcludedEntry | undefined {
  if (sourceText.startsWith("#!")) return "shebang"
  if (bins.has(file)) return "bin"
  return undefined
}

/** 一处模块作用域 await。 */
export interface TopLevelAwaitViolation {
  /** 仓库相对 POSIX 路径。 */
  readonly file: string
  /** 1-based 行号。 */
  readonly line: number
  /** 哪种 await 形态。 */
  readonly what: "await expression" | "for await loop" | "await using declaration"
  /** 命中的源码行（trim）。 */
  readonly text: string
}

/** 节点是否开启新的函数体（其下的 await 属于该函数而非模块）。 */
function startsFunctionScope(ts: any, node: any): boolean {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isClassStaticBlockDeclaration(node)
}

/** child 是否位于 scope 里「函数被调用时执行」的那部分（函数体或参数）。 */
function runsInsideScope(ts: any, scope: any, child: any): boolean {
  if (ts.isClassStaticBlockDeclaration(scope)) return true
  return child === scope.body || (scope.parameters ?? []).some((parameter: any) => parameter === child)
}

/** 节点是否在模块作用域求值（没有任何 enclosing 函数体包含它）。 */
function atModuleScope(ts: any, node: any): boolean {
  let child = node
  for (let parent = node.parent; !ts.isSourceFile(parent); child = parent, parent = parent.parent) {
    if (startsFunctionScope(ts, parent) && runsInsideScope(ts, parent, child)) return false
  }
  return true
}

/**
 * 找单个源文件里的所有模块作用域 await（逐字照抄 DSH 的三种形态与函数边界判定）。
 * @param file - 仓库相对路径（决定 scriptKind 与报告）。
 * @param sourceText - 文件内容。
 * @param ts - 已加载的 typescript 模块（缺它时由调用方转 unjudged，不走到这里）。
 */
export function findTopLevelAwaits(file: string, sourceText: string, ts: any): TopLevelAwaitViolation[] {
  const rel = file.replaceAll("\\", "/")
  // 三种 await 形态都拼出 await 关键字，没有它的文件无需解析。
  if (!sourceText.includes("await")) return []
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(rel, sourceText, ts.ScriptTarget.Latest, true, kind)
  const lines = sourceText.split("\n")
  const violations: TopLevelAwaitViolation[] = []
  const record = (node: any, what: TopLevelAwaitViolation["what"]): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
    violations.push({ file: rel, line: line + 1, what, text: (lines[line] ?? "").trim() })
  }
  const visit = (node: any): void => {
    if (ts.isAwaitExpression(node) && atModuleScope(ts, node)) record(node, "await expression")
    else if (ts.isForOfStatement(node) && node.awaitModifier !== undefined && atModuleScope(ts, node)) {
      record(node, "for await loop")
    } else if (ts.isVariableDeclarationList(node)
      && (node.flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing && atModuleScope(ts, node)) {
      record(node, "await using declaration")
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return violations
}

/** 语料完整性：空语料 + 漏掉哪些含 TS 的包 src 目录。 */
export interface CorpusIntegrity {
  /** 语料 0 文件（⇒ no-corpus）。 */
  readonly empty: boolean
  /** 含 TS 但语料没覆盖到的包 src 目录（仓库相对 POSIX 路径；⇒ 完整性红）。 */
  readonly missing: readonly string[]
}

/**
 * 列出语料并证明它覆盖每个含 TypeScript 的包 src 目录（**不**要求含 .tsx —— 本树 0 tsx）。
 * pattern 只由 spec 传另一个值，用来证明「缩小 glob 漏包」会被完整性检查拒绝。
 */
export function sourceCorpus(repositoryRoot: string = REPO, pattern: string = SOURCE_GLOB): string[] {
  return globSync(pattern, { cwd: repositoryRoot })
    .map(file => file.replaceAll("\\", "/"))
    .sort()
}

/** 目录树下是否有 .ts/.tsx（不依赖判据 glob —— 否则缩小 glob 时两边一起瞎）。 */
function holdsTypeScript(directory: string): boolean {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    // 没有 src/ 的包对语料无贡献。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  return entries.some(entry => entry.isDirectory()
    ? holdsTypeScript(join(directory, entry.name))
    : /\.tsx?$/u.test(entry.name))
}

/** 对给定语料做完整性检查（不抛；结果交 judge 判红/判不了）。 */
export function corpusIntegrity(repositoryRoot: string, files: readonly string[]): CorpusIntegrity {
  const covered = new Set(files.map(file => file.split("/").slice(0, 3).join("/")))
  const missing: string[] = []
  for (const group of readdirSync(join(repositoryRoot, "packages"), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(repositoryRoot, "packages", group.name), { withFileTypes: true })) {
      const directory = `packages/${group.name}/${pkg.name}`
      if (!pkg.isDirectory() || covered.has(directory)) continue
      if (holdsTypeScript(join(repositoryRoot, directory, "src"))) missing.push(`${directory}/src`)
    }
  }
  return { empty: files.length === 0, missing }
}

/** 一次仓库扫描检查了什么、排除了什么、发现了什么。 */
export interface ScanResult {
  readonly files: readonly string[]
  readonly integrity: CorpusIntegrity
  /** 作为可 import 模块检查的语料文件数。 */
  readonly checked: number
  /** 按声明排除的可执行文件，含理由。 */
  readonly excluded: ReadonlyArray<{ readonly file: string; readonly reason: ExcludedEntry }>
  /** 可 import 文件里的模块作用域 await。 */
  readonly violations: readonly TopLevelAwaitViolation[]
}

/** 扫包源语料，按声明排除可执行文件；ts 由调用方加载（缺它 ⇒ 调用方转 unjudged）。 */
export function scanRepository(repositoryRoot: string = REPO, ts: any): ScanResult {
  const files = sourceCorpus(repositoryRoot)
  const integrity = corpusIntegrity(repositoryRoot, files)
  const bins = binSourcesOfCorpus(repositoryRoot, files)
  const excluded: Array<{ file: string; reason: ExcludedEntry }> = []
  const violations: TopLevelAwaitViolation[] = []
  for (const file of files) {
    const text = readFileSync(join(repositoryRoot, file), "utf8")
    const reason = excludedEntry(file, text, bins)
    if (reason === undefined) violations.push(...findTopLevelAwaits(file, text, ts))
    else excluded.push({ file, reason })
  }
  return { files, integrity, checked: files.length - excluded.length, excluded, violations }
}

/** judge 的纯输入。ts 不可用 ⇒ scan=null（由 judge 先判 no-binary）。 */
export interface AwaitInput {
  readonly hasTs: boolean
  readonly scan: ScanResult | null
}

/** 现场采集：先确认 typescript 可用，再扫一次盘。 */
export function collect(root: string = REPO): AwaitInput {
  const ts = loadTs(root)
  return { hasTs: ts !== null, scan: ts === null ? null : scanRepository(root, ts) }
}

/** 违例 finding 的判词：文件:行 + 源码行 + 怎么改。 */
function violationFinding(v: TopLevelAwaitViolation): Finding {
  return {
    file: v.file,
    line: v.line,
    detail: `${v.what}：源码行 "${v.text}" —— 模块级 await 让模块求值异步化。怎么改：把异步工作移进模块调用的函数（如显式 main()），在起点处理该 promise 的失败。`,
  }
}

/** 纯判定：观测 → GateResult。 */
export function judgeAwaits(input: AwaitInput): GateResult {
  if (!input.hasTs || input.scan === null) {
    return unjudged(GATE, "no-binary", "找不到 typescript（loadTs 候选路径都不在）⇒ 无法做 AST 解析，判不了（不是绿）")
  }
  const s = input.scan
  if (s.integrity.empty) {
    return unjudged(GATE, "no-corpus", `${SOURCE_GLOB} 语料 0 个文件 —— 分母为 0 不许冒充绿`)
  }
  // 语料问题转成判红（DSH 原样在这里 throw；本实现不裸抛，也不静默降级）。
  if (s.integrity.missing.length > 0) {
    const findings: Finding[] = s.integrity.missing.map(directory => ({
      file: directory,
      detail: `语料漏掉含 TypeScript 的包 src 目录 ${directory} —— 扫描面被缩小，完整性失败判红（不是判不了）。不要放宽 glob 到恒绿；让该目录的源文件进入 ${SOURCE_GLOB} 的扫描面。`,
    }))
    return { gate: GATE, status: "failed", findings }
  }
  if (s.violations.length > 0) {
    return { gate: GATE, status: "failed", findings: s.violations.map(violationFinding) }
  }
  const exclusions = s.excluded.map(entry => `${entry.file} (${entry.reason})`).join(", ")
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${s.checked} 个包源文件无模块作用域 await；${s.excluded.length} 个可执行文件按声明排除：${exclusions || "none"}。`,
  }
}

async function cli(): Promise<number> {
  const args = process.argv.slice(2)
  const rootArg = args.indexOf("--root")
  const root = rootArg >= 0 && args[rootArg + 1] ? resolve(args[rootArg + 1]) : REPO
  let input: AwaitInput
  try {
    input = collect(root)
  } catch (error) {
    console.error(`✗ ${GATE}: 扫盘失败（${(error as Error).message}）⇒ 判不了（不是绿）`)
    return 2
  }
  return runGate({ name: GATE, main: () => judgeAwaits(input) })
}

if (isMain(import.meta.url)) {
  cli()
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      console.error(`✗ ${GATE}: ${(error as Error).message}`)
      process.exitCode = 2
    })
}
