/**
 * 浏览器路由可达判据（ISS-906 / P0 门禁对齐）。
 *
 * 判什么：apps/web 声明的每条路由都必须能从 HTML 入口真到达，且不存在死路由。
 * 本仓入口是「裸 Vite + 手写 pathname 分派」（apps/web/src/main.ts），不用路由库：
 *   · 声明 = 与 location.pathname 比较的路径字面量（=== / startsWith）
 *   · 到达 = 声明所在模块在 HTML <script type=module> 的静态 import 图里
 *   · 死路由 = 该路由分派分支里没有「已导入且目标文件存在」的处理器调用
 *
 * 为什么不照搬 DSH 的 verify-client-route-resolution.ts：那份只管「request target 的
 * app route 必须 document-relative」（fetch/Request/URL 的首参不许写 /api/x），
 * 与本单的「声明路由可达 / 无死路由」不是同一个问题；且它依赖 faceConfigs 的
 * monorepo tsconfig paths 门面，本仓无此结构。⇒ 按本仓入口形态重写，零新依赖，
 * 只依赖 typescript（已在根 devDependencies）。
 *
 * 三态（scripts/lib/gate-runtime.ts）：0 绿 / 1 红 / 2 判不了。
 */
import { existsSync, globSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import ts from "typescript"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-web-route-reachability"
const REPO = resolve(import.meta.dirname, "..", "..")
const WEB = "apps/web"
const HTML = `${WEB}/index.html`
const SRC_GLOB = `${WEB}/src/**/*.{ts,tsx}`

/** 一条路由声明 + 它绑定的处理器。 */
export interface RouteSite {
  path: string
  file: string
  line: number
  column: number
  /** 分派分支里调用的、来自 import 的函数名 + 其目标文件是否真实存在。 */
  handlers: { name: string; resolved: boolean }[]
}

/** 一个模块解析出的路由事实（纯数据，judge 不碰 IO）。 */
export interface RouteModuleFact {
  file: string
  sites: RouteSite[]
  /** 该模块里指向不存在文件的相对 import（分派图断了）。 */
  brokenImports: { line: number; specifier: string }[]
}

export interface RouteReachInput {
  /** HTML 入口 script 解析出的仓库相对路径；无 script 或目标不存在 ⇒ null。 */
  entry: string | null
  /** 从 entry 沿相对 import 可达的模块（仓库相对路径）。 */
  reachable: string[]
  /** 扫描到的、含路由声明的模块事实。 */
  modules: RouteModuleFact[]
  /** apps/web/src 下扫到的源文件总数（0 ⇒ no-corpus）。 */
  sourceCount: number
}

/** 相对 specifier 解析成仓库相对路径；解析不到返回 null。 */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null
  const base = resolve(REPO, dirname(fromFile), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  for (const c of candidates) {
    if (existsSync(c) && /\.(ts|tsx)$/.test(c)) return relative(REPO, c).split("\\").join("/")
  }
  return null
}

/** 一段文本是否在读 location.pathname。 */
function isPathnameRead(text: string): boolean {
  return /\blocation\s*\?\.\s*pathname\b/.test(text) || /\blocation\.pathname\b/.test(text)
}

/** 一个模块里的路由事实抽取（AST，不写盘）。 */
export function extractRouteFacts(file: string, sourceText: string): RouteModuleFact {
  const source = ts.createSourceFile(
    file, sourceText, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  // 1. 从 location.pathname 派生出来的局部变量名（例：const path = location.pathname ?? "/"）
  const pathVars = new Set<string>()
  // 2. import 绑定 → {目标文件是否存在, 是否 type-only}
  const imports = new Map<string, { resolved: boolean; typeOnly: boolean }>()
  // 3. 原始路由声明（path + 位置 + 谓词变量名）
  const raw: { path: string; line: number; column: number; predicateVar?: string }[] = []
  // 4. 所有 if 语句（用于把谓词变量绑到分支处理器）
  const ifs: ts.IfStatement[] = []
  // 5. 断链的相对 import
  const brokenImports: { line: number; specifier: string }[] = []

  const pos = (node: ts.Node) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
    return { line: line + 1, column: character + 1 }
  }
  /** 找包住 node 的最近变量声明名（const isDemo = …）。 */
  const enclosingVarName = (node: ts.Node): string | undefined => {
    let cur: ts.Node | undefined = node
    while (cur && cur !== source) {
      if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text
      cur = cur.parent
    }
    return undefined
  }
  const isPathRead = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return pathVars.has(node.text)
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
      return node.name.text === "pathname" && isPathnameRead(node.getText(source))
    }
    if (ts.isBinaryExpression(node)) return isPathRead(node.left) || isPathRead(node.right)
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return isPathRead(node.expression)
    }
    return false
  }
  const noteRoute = (literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, predicateVar?: string) => {
    if (!literal.text.startsWith("/")) return
    const { line, column } = pos(literal)
    raw.push({ path: literal.text, line, column, predicateVar })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isIdentifier(node.name)
      && isPathnameRead(node.initializer.getText(source))) {
      pathVars.add(node.name.text)
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const target = resolveRelative(file, specifier)
      const typeOnly = node.importClause?.isTypeOnly === true
      if (specifier.startsWith(".") && !/\.(css|scss|less|sass|json|svg|png|jpe?g|gif|webp|woff2?|ttf|eot|txt|html)$/i.test(specifier)) {
        if (target === null || !existsSync(resolve(REPO, target))) {
          brokenImports.push({ line: pos(node.moduleSpecifier).line, specifier })
        }
      }
      const clause = node.importClause
      if (clause) {
        const add = (name: ts.Identifier, only: boolean) => { imports.set(name.text, { resolved: target !== null, typeOnly: typeOnly || only }) }
        if (clause.name) add(clause.name, typeOnly)
        const bindings = clause.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) add(el.name, typeOnly || el.isTypeOnly === true)
        }
      }
    }
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
      const leftRead = isPathRead(node.left)
      const rightRead = isPathRead(node.right)
      if (leftRead || rightRead) {
        const other = leftRead ? node.right : node.left
        if (ts.isStringLiteral(other) || ts.isNoSubstitutionTemplateLiteral(other)) {
          noteRoute(other, enclosingVarName(node))
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "startsWith" && isPathRead(node.expression.expression)) {
      const first = node.arguments[0]
      if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        noteRoute(first, enclosingVarName(node))
      }
    }
    if (ts.isIfStatement(node)) ifs.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)

  // 每个路由声明的处理器：由「条件里出现的谓词变量 / 路径字面量」找到对应 if，
  // 取该 if 的 then/else 分支里调用的 imported 函数名。
  const sites: RouteSite[] = raw.map((r) => ({
    path: r.path, file, line: r.line, column: r.column, handlers: [],
  }))
  const addedHandler = new Set<number>()
  const addHandlers = (siteIndex: number, branch: ts.Node): void => {
    const site = sites[siteIndex]
    if (site === undefined) return
    const collect = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const binding = imports.get(n.expression.text)
        if (binding !== undefined && !binding.typeOnly) {
          const key = siteIndex * 1e6 + site.handlers.length
          if (!addedHandler.has(key)) {
            addedHandler.add(key)
            site.handlers.push({ name: n.expression.text, resolved: binding.resolved })
          }
        }
      }
      ts.forEachChild(n, collect)
    }
    collect(branch)
  }

  for (const statement of ifs) {
    const condText = statement.expression.getText(source)
    const depends: number[] = []
    sites.forEach((site, i) => {
      const r = raw[i]
      if (r === undefined) return
      if ((r.predicateVar !== undefined && new RegExp(`\\b${r.predicateVar}\\b`).test(condText))
        || condText.includes(JSON.stringify(site.path))) {
        depends.push(i)
      }
    })
    if (depends.length === 0) continue
    for (const i of depends) {
      addHandlers(i, statement.thenStatement)
      if (statement.elseStatement !== undefined) addHandlers(i, statement.elseStatement)
    }
    // 兜底路由 `/`（else 分支）：同样必须有可达处理器。
    if (statement.elseStatement !== undefined) {
      const fallback: RouteSite = { path: "/", file, line: pos(statement).line, column: pos(statement).column, handlers: [] }
      const tmpIndex = sites.length
      sites.push(fallback)
      raw.push({ path: "/", line: fallback.line, column: fallback.column })
      const before = fallback.handlers.length
      addHandlers(tmpIndex, statement.elseStatement)
      if (fallback.handlers.length === before) sites.pop() // else 分支没有处理器 ⇒ 不另造一条声明
    }
  }

  return { file, sites, brokenImports }
}

/** 现算：入口解析 + 静态 import 图 + 全 src 路由事实。 */
export function scan(): RouteReachInput {
  const htmlPath = resolve(REPO, HTML)
  let entry: string | null = null
  if (existsSync(htmlPath)) {
    const html = readFileSync(htmlPath, "utf8")
    const m = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i.exec(html)
    if (m?.[1] !== undefined) {
      const src = m[1].replace(/^\//, "")
      const candidate = `${WEB}/${src}`
      if (existsSync(resolve(REPO, candidate))) entry = candidate
    }
  }

  const allFiles = globSync(SRC_GLOB, { cwd: REPO }).sort()
    .map((f) => f.split("\\").join("/"))
    .filter((f) => /\.(ts|tsx)$/.test(f))

  // BFS：从 entry 沿相对 import 走（只用 AST 抽取，不执行代码）。
  const reachable: string[] = []
  const seen = new Set<string>()
  const queue = entry === null ? [] : [entry]
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    reachable.push(file)
    const abs = resolve(REPO, file)
    if (!existsSync(abs)) continue
    const source = ts.createSourceFile(file, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true)
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const target = resolveRelative(file, n.moduleSpecifier.text)
        if (target !== null && !seen.has(target)) queue.push(target)
        // import("./x") 动态边同样算可达
      }
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const first = n.arguments[0]
        if (first !== undefined && ts.isStringLiteral(first)) {
          const target = resolveRelative(file, first.text)
          if (target !== null && !seen.has(target)) queue.push(target)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(source)
  }

  const modules: RouteModuleFact[] = []
  for (const file of allFiles) {
    const abs = resolve(REPO, file)
    const fact = extractRouteFacts(file, readFileSync(abs, "utf8"))
    if (fact.sites.length > 0 || fact.brokenImports.length > 0) modules.push(fact)
  }
  return { entry, reachable, modules, sourceCount: allFiles.length }
}

/** 纯判据：输入事实 → 结论。 */
export function judge(input: RouteReachInput): GateResult {
  if (input.sourceCount === 0) {
    return unjudged(GATE, "no-corpus", "apps/web/src 下扫到 0 个 .ts/.tsx ⇒ 判不了路由可达（空集不是绿）")
  }
  const findings: Finding[] = []
  if (input.entry === null) {
    findings.push({ file: HTML, line: 1, detail: `HTML 入口没有可解析的 <script type="module" src="…">，或目标文件不存在 ⇒ 浏览器无可到达入口` })
  }
  const reachable = new Set(input.reachable)
  if (input.entry !== null && !reachable.has(input.entry)) {
    findings.push({ file: input.entry, detail: `入口模块不在自身静态 import 图里（判据自洽性失败）` })
  }
  for (const mod of input.modules) {
    for (const broken of mod.brokenImports) {
      if (!reachable.has(mod.file)) continue
      findings.push({ file: mod.file, line: broken.line, detail: `相对 import "${broken.specifier}" 的目标文件不存在 ⇒ 分派图断在这里` })
    }
    for (const site of mod.sites) {
      if (!reachable.has(site.file)) {
        findings.push({ file: site.file, line: site.line, detail: `路由 "${site.path}" 声明在 ${site.file}，但该模块不在 HTML 入口的静态 import 图里 ⇒ 死路由（浏览器不可达）` })
        continue
      }
      if (site.handlers.length === 0) {
        findings.push({ file: site.file, line: site.line, detail: `路由 "${site.path}" 的分派分支里没有已导入的处理器调用 ⇒ 死路由（声明了但没有可执行目标）` })
        continue
      }
      if (site.handlers.every((h) => !h.resolved)) {
        findings.push({ file: site.file, line: site.line, detail: `路由 "${site.path}" 的处理器 ${site.handlers.map((h) => h.name).join(", ")} 的 import 目标文件都不存在 ⇒ 死路由` })
      }
    }
  }
  if (findings.length > 0) return { gate: GATE, status: "failed", findings }
  return { gate: GATE, status: "passed", findings: [], detail: `${input.sourceCount} 个源文件 / ${input.reachable.length} 个入口可达模块 / ${input.modules.reduce((n, m) => n + m.sites.length, 0)} 条路由声明均有可达处理器` }
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main: () => judge(scan()) })
    .then((code) => { process.exitCode = code })
    .catch((e: unknown) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
