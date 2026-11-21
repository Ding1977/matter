/**
 * W12 雏形判据（ISS-533 / P3-U3）：@Remote 导出面/契约形态可机判。
 *
 * ## 判什么（雏形口径，有意收窄但能判红）
 *
 * 扫 `packages/api/* /src/**`（api 组 host Service）里 `extends TypertRemoteService` 的类。
 * 每个 controller 校验四件事：
 *   ① `super(ctx, <string literal>)` —— service key 必须是非空字面量（wire namespace 的来源）；
 *   ② ≥1 个 `@Remote` 方法 —— 空壳 controller 不算导出面；
 *   ③ 装饰器形态合法 —— `@Remote` / `@Remote("name")` / `@Remote({ name: "..." })`，
 *      其它实参（变量、数字、模板拼接）判违例；
 *   ④ 双向导出面锁 —— 实际端点 ⊆ 契约表 且 契约表 ⊆ 实际端点，端点名不重复。
 *      反向那半是牙：删掉单个契约端点（如 update）也必须红，否则判据名不副实。
 * 契约表 `EXPECTED_SURFACE` 按 service key 声明；**未登记的 controller 不判端点白名单**
 * （只判 ①②③ + 重复名）——否则包一多，新增合法 controller 会让本判据自己变假
 * （「过期断言比没有断言更坏」）。新 controller 想受白名单约束，就在表里加一行。
 *
 * ## 三态（gate-runtime 唯一口径）
 *
 *   0 = passed（扫到 ≥1 个 controller，0 违例）
 *   1 = failed（有违例，finding 带 文件:行:详情）
 *   2 = unjudged（packages/api/ 不存在 / 0 个 controller = no-corpus / 找不到 typescript = no-binary）
 *
 * @module gates/verify-remote-surface
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-remote-surface"
const require = createRequire(import.meta.url)

/** 每个受契约约束的 service key → 允许的 @Remote 端点名集合（新增 controller 在此登记）。 */
export const EXPECTED_SURFACE: Readonly<Record<string, readonly string[]>> = {
  // ISS-533：api 组首包 document-controller，super(ctx, 'document') + 三方法。
  document: ["list", "get", "update"],
}

/** controller 扫描结果（纯函数可喂 spec）。 */
export interface ControllerScan {
  /** 仓库相对路径。 */
  readonly file: string
  /** service key（super 第一参字面量；取不到为 null）。 */
  readonly serviceKey: string | null
  /** 端点名数组（@Remote 显式 name 或方法名）。 */
  readonly endpoints: readonly string[]
  /** 违例（行号 + 详情）。 */
  readonly violations: readonly Finding[]
}

/** typescript 候选路径（与 verify-client-ui-i18n 同款）。 */
const TS_PATHS = ["forge-ui/node_modules/typescript/lib/typescript.js", "forge-pm/node_modules/typescript/lib/typescript.js", "node_modules/typescript/lib/typescript.js"]

/** 加载 typescript；取不到返回 null。 */
export function loadTs(): any | null {
  for (const rel of TS_PATHS) {
    try {
      return require(path.join(REPO, rel))
    } catch {
      // 下一个候选
    }
  }
  return null
}

/** 取节点起始行（1-based）。 */
function lineOf(ts: any, sf: any, node: any): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf, false)).line + 1
}

/** 判断一个装饰器是不是 @Remote，并抽端点名；返回 null 表示不是 @Remote。 */
function remoteEndpoint(ts: any, decorator: any): { name: string | null; malformed: boolean } | null {
  const expr = decorator.expression
  // 裸 @Remote（方法名即端点名）
  if (ts.isIdentifier(expr) && expr.text === "Remote") return { name: null, malformed: false }
  if (!ts.isCallExpression(expr)) return null
  const callee = expr.expression
  if (!(ts.isIdentifier(callee) && callee.text === "Remote")) return null
  const arg = expr.arguments[0]
  if (arg === undefined) return { name: null, malformed: false }
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return { name: arg.text, malformed: false }
  if (ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === "name") {
        if (ts.isStringLiteral(prop.initializer)) return { name: prop.initializer.text, malformed: false }
      }
    }
    return { name: null, malformed: true } // options 里没有合法 string name
  }
  return { name: null, malformed: true }
}

/**
 * 扫一个源文件，抽出 controller 形态（纯函数，不碰 IO）。
 * @param ts - typescript 模块。
 * @param rel - 仓库相对路径。
 * @param source - 文件正文。
 * @returns 该文件的 controller 扫描结果（无 controller 时 endpoints 空）。
 */
export function scanFile(ts: any, rel: string, source: string): ControllerScan[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true)
  const out: ControllerScan[] = []
  const visit = (node: any): void => {
    if (ts.isClassDeclaration(node)) {
      const extendsTypert = node.heritageClauses?.some((h: any) =>
        h.token === ts.SyntaxKind.ExtendsKeyword &&
        h.types?.some((t: any) => t.expression && ts.isIdentifier(t.expression) && t.expression.text === "TypertRemoteService"),
      ) ?? false
      if (extendsTypert) out.push(scanController(ts, sf, rel, node))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** 扫一个类：super key + @Remote 端点 + 违例。 */
function scanController(ts: any, sf: any, rel: string, cls: any): ControllerScan {
  const violations: Finding[] = []
  let serviceKey: string | null = null

  // ① super(ctx, <string literal>)
  let foundSuper = false
  const ctor = cls.members.find((m: any) => ts.isConstructorDeclaration(m))
  if (ctor?.body !== undefined) {
    const walk = (node: any): void => {
      if (ts.isCallExpression(node) && node.expression && ts.isSuperKeyword(node.expression)) {
        foundSuper = true
        // TypertRemoteService 构造签名 = (ctx, serviceKey, options?)，key 是第二参。
        const key = node.arguments[1]
        if (key === undefined || !(ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) || key.text.length === 0) {
          violations.push({ file: rel, line: lineOf(ts, sf, node), detail: "super(ctx, '<key>') 的 service key（第二参）必须是非空字符串字面量" })
        } else {
          serviceKey = key.text
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(ctor.body)
  }
  if (!foundSuper) {
    violations.push({ file: rel, line: lineOf(ts, sf, cls), detail: "extends TypertRemoteService 的构造函数必须调用 super(ctx, '<key>')" })
  }

  // ②③ @Remote 装饰器形态 + 端点名
  const endpoints: string[] = []
  const methodNames = new Set<string>()
  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member)) continue
    const decorators = typeof ts.getDecorators === "function" && ts.canHaveDecorators?.(member)
      ? ts.getDecorators(member) ?? []
      : (member.decorators ?? [])
    for (const dec of decorators) {
      const parsed = remoteEndpoint(ts, dec)
      if (parsed === null) continue
      if (parsed.malformed) {
        violations.push({ file: rel, line: lineOf(ts, sf, dec), detail: "@Remote 实参必须是端点名字符串或含 string name 的 options 对象" })
        continue
      }
      const name = parsed.name ?? (ts.isIdentifier(member.name) ? member.name.text : null)
      if (name === null || name.length === 0) {
        violations.push({ file: rel, line: lineOf(ts, sf, member), detail: "@Remote 方法名无法解析为端点名" })
        continue
      }
      if (methodNames.has(name)) {
        violations.push({ file: rel, line: lineOf(ts, sf, member), detail: `端点名重复：${name}` })
      }
      methodNames.add(name)
      endpoints.push(name)
    }
  }
  if (endpoints.length === 0 && violations.length === 0) {
    violations.push({ file: rel, line: lineOf(ts, sf, cls), detail: "controller 没有任何 @Remote 方法（空导出面）" })
  }

  // ④ 双向导出面锁（仅对已登记契约的 service key；opt-in，新包不套白名单）
  //    正向：实际端点 ⊆ 契约白名单；反向：契约白名单 ⊆ 实际端点。
  //    缺一个就红 —— 否则删掉单个 @Remote 方法（如 update）仍绿，判据名不副实。
  //    契约表是显式声明的 API 面，端点变更逼人同步契约表，正是变更该有的自觉动作。
  if (serviceKey !== null && EXPECTED_SURFACE[serviceKey] !== undefined) {
    const allowed = new Set(EXPECTED_SURFACE[serviceKey]!)
    const actual = new Set(endpoints)
    for (const ep of endpoints) {
      if (!allowed.has(ep)) {
        violations.push({ file: rel, line: lineOf(ts, sf, cls), detail: `端点 ${ep} 不在 service '${serviceKey}' 的契约白名单 [${[...allowed].join(", ")}]` })
      }
    }
    for (const required of allowed) {
      if (!actual.has(required)) {
        violations.push({ file: rel, line: lineOf(ts, sf, cls), detail: `契约端点缺失：${required} —— controller 端点变更须同步 verify-remote-surface 契约表` })
      }
    }
  }

  return { file: rel, serviceKey, endpoints, violations }
}

/**
 * 纯函数判定：controller 扫描结果 → GateResult。
 * @param input - 扫描输入（文件表 + typescript 可用性）。
 * @param ts - typescript 模块（hasTs=true 时必给）。
 * @returns GateResult。
 */
export function judgeRemoteSurface(input: { files: ReadonlyMap<string, string>; hasTs: boolean }, ts: any): GateResult {
  if (!input.hasTs) return unjudged(GATE, "no-binary", "找不到 typescript ⇒ 无法 AST 解析，判不了（不是绿）")
  let controllers = 0
  const violations: Finding[] = []
  for (const [rel, source] of input.files) {
    for (const scan of scanFile(ts, rel, source)) {
      controllers++
      violations.push(...scan.violations)
    }
  }
  if (controllers === 0) return unjudged(GATE, "no-corpus", "packages/api/<pkg>/src 下 0 个 extends TypertRemoteService 的 controller —— 判不了，不当绿")
  if (violations.length) return { gate: GATE, status: "failed", findings: violations }
  return { gate: GATE, status: "passed", findings: [], detail: `${controllers} 个 @Remote controller，导出面与契约形态 0 违例` }
}

/** 现场采集：扫 packages/api/<pkg>/src 的 .ts。 */
const SOURCE_RE = /\.ts$/
const SKIP = new Set(["node_modules", "lib", "dist", "tests"])

/**
 * @param root - 仓库根。
 * @returns 仓库相对路径 → 正文。
 */
export function collectSources(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const base = path.join(root, "packages", "api")
  if (!fs.existsSync(base)) return out
  for (const pkg of fs.readdirSync(base, { withFileTypes: true })) {
    if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue
    const srcDir = path.join(base, pkg.name, "src")
    if (!fs.existsSync(srcDir)) continue
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".") || SKIP.has(e.name)) continue
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) walk(abs)
        else if (e.isFile() && SOURCE_RE.test(e.name)) out.set(path.relative(REPO, abs), fs.readFileSync(abs, "utf8"))
      }
    }
    walk(srcDir)
  }
  return out
}

if (isMain(import.meta.url)) {
  runGate({
    name: GATE,
    main: () => {
      const ts = loadTs()
      return judgeRemoteSurface({ files: collectSources(REPO), hasTs: ts !== null }, ts)
    },
  })
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
