/**
 * 新树日志出口与错误规范守卫（ISS-889）—— `docs/specs/log-error-convention-next.md` 的机器形态。
 *
 * ## 判什么
 *
 * 只扫 SOURCE_GLOB（新树 workspace 包的 src 源目录，见下方常量），三条禁令型规则，
 * 词表与旧树 `scripts/lint-log-outlet.mjs` 的 G1/G2/G3 一致但**射程严格隔离**：
 *
 * - G1 `console`：`console.log/warn/error/...(...)` 调用。
 * - G2 `bare-throw`：`throw new Error(...)` 等 8 个全局 Error 构造子，以及 `throw Error(...)`。
 * - G3 `direct-logger`：`ctx.logger.<level>(...)` / `this.ctx.logger.<level>(...)`。
 *
 * 不计违例：`ctx.logger("name")` 工厂调用、工厂实例的级别调用（`logger.error(...)`）、
 * 类型化错误类（`DomainError`/`StorageError`/`*Error`）、字符串/模板/注释里的同名文本。
 * tests 目录不在射程（规范问 3）。
 *
 * 检测是语法感知的（TypeScript parser）：用 AST 节点形状判定，不是文本 grep，故字符串、
 * 模板字面量、注释不会误报；`ctx.logger("name")` 的 callee 是 CallExpression 上的属性访问，
 * 与 `ctx.logger.error(...)` 的属性链形状不同，天然区分。
 *
 * ## 三态 fail-closed（退出码 = gate-runtime 口径：0 绿 / 1 红 / 2 判不了）
 *
 * | 观测 | 判定 |
 * |---|---|
 * | 任一 G1/G2/G3 违例 | ⛔ 红（exit 1），finding 带 文件:行 + 源码行 + 怎么改 |
 * | 语料漏掉某个含 TS 的包 src 目录（扫描面被缩小） | ⛔ 红（exit 1）—— 完整性失败不是判不了 |
 * | 语料全绿（本树清债后即此态：0 违例） | ✅ 绿（exit 0） |
 * | 0 源文件 ⇒ no-corpus / 找不到 typescript ⇒ no-binary | ⚠️ 判不了（exit 2，带理由码） |
 *
 * 禁令型判据：不建指纹基线、不加 allowFailure（零容忍），0 违例上线即绿。
 */
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs"
import path, { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "lint-log-outlet-next"
const REPO = resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** 语料 glob：新树两层包 src 下的 TS/TSX（tests 天然不在射程）。 */
export const SOURCE_GLOB = "packages/*/*/src/**/*.{ts,tsx}"

/** typescript 候选路径（与 verify-no-unknown-casts / verify-no-top-level-await 同款）。 */
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

/** G2 里被禁的全局 Error 构造子（本包类型化错误类不在其中，天然放行）。 */
export const BARE_ERROR_CONSTRUCTORS = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "EvalError", "URIError", "AggregateError", "ReferenceError",
])

/** 三种规则标识。 */
export type RuleKind = "console" | "bare-throw" | "direct-logger"

/** 一处违例。 */
export interface LogOutletViolation {
  readonly file: string
  /** 1-based 行号。 */
  readonly line: number
  readonly rule: RuleKind
  /** 命中的源码行（trim）。 */
  readonly text: string
}

/** 每条规则的「怎么改」，判词直接引用，与规范文档逐字对齐。 */
export const HOW_TO_FIX: Record<RuleKind, string> = {
  console: "console.* 在新树 src 禁止。怎么改：用 ctx.logger(\"name\") 工厂取具名实例，再 logger.*(...)。",
  "bare-throw": "裸 throw new Error 禁止。怎么改：抛本包已有的类型化错误类（storage-domain → DomainError(code,msg)、storage/storage-json → StorageError(code,msg)、pm → 对应 *Error），消息文本逐字保留；确无贴合 code 时在同一 diff 给已有 code 联合加语义明确的新成员。",
  "direct-logger": "ctx.logger.<level>() 直调禁止。怎么改：先 const logger = ctx.logger(\"name\") 取具名实例，再 logger.<level>(...)。",
}

/** `console.foo(...)` 调用（callee 是 console 上的属性访问）。 */
export function isConsoleCall(ts: any, node: any): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  return ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && callee.expression.text === "console"
}

/**
 * `throw new Error(...)` / `throw Error(...)`（全局 Error 构造子）。
 * @returns 命中的构造子名，或 null（类型化错误类 / 抛出非 new 表达式都放行）。
 */
export function isBareThrow(ts: any, node: any): string | null {
  if (!ts.isThrowStatement(node)) return null
  const expr = node.expression
  if (expr === undefined) return null
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text
    return BARE_ERROR_CONSTRUCTORS.has(name) ? name : null
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text
    return BARE_ERROR_CONSTRUCTORS.has(name) ? name : null
  }
  return null
}

/**
 * `ctx.logger.<level>(...)` / `this.ctx.logger.<level>(...)` 直调。
 * 形状：callee 是属性访问，其 receiver 是 `*.logger` 属性访问，其基是 `ctx` 标识符或 `this.ctx`。
 * `ctx.logger("name")` 的 callee 是 CallExpression，不满足属性链形状 ⇒ 工厂调用不放行误伤。
 */
export function isDirectLoggerCall(ts: any, node: any): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return false
  const receiver = callee.expression
  if (!ts.isPropertyAccessExpression(receiver) || receiver.name.text !== "logger") return false
  const base = receiver.expression
  if (ts.isIdentifier(base) && base.text === "ctx") return true
  return ts.isPropertyAccessExpression(base)
    && base.name.text === "ctx"
    && base.expression.kind === ts.SyntaxKind.ThisKeyword
}

/** 找单个源文件里的三类违例（AST 感知；ts 由调用方加载，缺它时调用方转 unjudged）。 */
export function findViolations(file: string, sourceText: string, ts: any): LogOutletViolation[] {
  const rel = file.replaceAll("\\", "/")
  // 三个规则都带字面文本，缺任一个都不可能有违例 —— 先粗筛，避免无谓 AST 解析。
  if (!sourceText.includes("logger") && !sourceText.includes("console") && !sourceText.includes("throw")) return []
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(rel, sourceText, ts.ScriptTarget.Latest, true, kind)
  const lines = sourceText.split("\n")
  const violations: LogOutletViolation[] = []
  const record = (node: any, rule: RuleKind): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
    violations.push({ file: rel, line: line + 1, rule, text: (lines[line] ?? "").trim() })
  }
  const visit = (node: any): void => {
    if (isConsoleCall(ts, node)) record(node, "console")
    else if (isBareThrow(ts, node) !== null) record(node, "bare-throw")
    else if (isDirectLoggerCall(ts, node)) record(node, "direct-logger")
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return violations
}

/** 语料完整性：空语料 + 漏掉哪些含 TS 的包 src 目录。 */
export interface CorpusIntegrity {
  readonly empty: boolean
  readonly missing: readonly string[]
}

/** 列出语料（pattern 只由 spec 传另一个值，用来证明「缩小 glob 漏包」会被完整性检查拒绝）。 */
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
  return entries.some(entry => entry.isDirectory()
    ? holdsTypeScript(join(directory, entry.name))
    : /\.tsx?$/u.test(entry.name))
}

/** 只认含 TypeScript 的包 src 目录；tests 目录不进分母（规范问 3）。 */
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

/** 一次仓库扫描检查了什么、发现了什么。 */
export interface ScanResult {
  readonly files: readonly string[]
  readonly integrity: CorpusIntegrity
  readonly violations: readonly LogOutletViolation[]
}

/** 扫包源语料（ts 由调用方加载；缺它 ⇒ 调用方转 unjudged）。 */
export function scanRepository(repositoryRoot: string = REPO, ts: any): ScanResult {
  const files = sourceCorpus(repositoryRoot)
  const integrity = corpusIntegrity(repositoryRoot, files)
  const violations: LogOutletViolation[] = []
  for (const file of files) {
    const text = readFileSync(join(repositoryRoot, file), "utf8")
    violations.push(...findViolations(file, text, ts))
  }
  return { files, integrity, violations }
}

/** judge 的纯输入。ts 不可用 ⇒ scan=null（由 judge 先判 no-binary）。 */
export interface OutletInput {
  readonly hasTs: boolean
  readonly scan: ScanResult | null
}

/** 现场采集：先确认 typescript 可用，再扫一次盘。 */
export function collect(root: string = REPO): OutletInput {
  const ts = loadTs(root)
  return { hasTs: ts !== null, scan: ts === null ? null : scanRepository(root, ts) }
}

/** 违例 finding 的判词：文件:行 + 源码行 + 规则 + 怎么改。 */
function violationFinding(v: LogOutletViolation): Finding {
  return {
    file: v.file,
    line: v.line,
    detail: `${v.rule}：源码行 "${v.text}" —— ${HOW_TO_FIX[v.rule]}`,
  }
}

/** 纯判定：观测 → GateResult。 */
export function judgeOutlet(input: OutletInput): GateResult {
  if (!input.hasTs || input.scan === null) {
    return unjudged(GATE, "no-binary", "找不到 typescript（loadTs 候选路径都不在）⇒ 无法做 AST 解析，判不了（不是绿）")
  }
  const s = input.scan
  if (s.integrity.empty) {
    return unjudged(GATE, "no-corpus", `${SOURCE_GLOB} 语料 0 个文件 —— 分母为 0 不许冒充绿`)
  }
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
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${s.files.length} 个包源文件按 G1 console / G2 裸 throw / G3 ctx.logger 直调三条禁令检查，0 违例。`,
  }
}

async function cli(): Promise<number> {
  const args = process.argv.slice(2)
  const rootArg = args.indexOf("--root")
  const root = rootArg >= 0 && args[rootArg + 1] ? resolve(args[rootArg + 1]) : REPO
  let input: OutletInput
  try {
    input = collect(root)
  } catch (error) {
    console.error(`✗ ${GATE}: 扫盘失败（${(error as Error).message}）⇒ 判不了（不是绿）`)
    return 2
  }
  return runGate({ name: GATE, main: () => judgeOutlet(input) })
}

if (isMain(import.meta.url)) {
  cli()
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      console.error(`✗ ${GATE}: ${(error as Error).message}`)
      process.exitCode = 2
    })
}
