/**
 * 导出 JSDoc 契约守卫（ISS-881）—— 移植 DSH `scripts/verify-export-jsdoc.ts` + `jsdoc.ts`，
 * 外层套 ISS-879 `verify-no-unknown-casts` 的**纯指纹基线形态**（不加 allowFailure）。
 *
 * ## 判什么
 *
 * `packages/<组>/<包>/src` 下每个导出的声明必须有描述 prose；函数式导出还须有
 * 每个参数的 `@param` 与非 void 返回的 `@returns`。存量欠债按「文件 + 符号 + 违规类型」
 * 身份指纹登记，按**身份**退役而非数量棘轮。
 *
 * ## 口径（对齐 2259，一个机制做到存量不阻塞 + 新增必红 + 按身份退役）
 *
 * | 观测 | 判定 |
 * |---|---|
 * | 新文件 / 新身份指纹（基线无记录或计数用尽） | ⛔ 红 |
 * | 存量指纹出现次数 ≤ 基线计数 | ✅ 绿 |
 * | 基线有、实际没有（指纹消失） | ✅ 绿 + 提示可 `--prune`（不红） |
 *
 * `--prune`：确认无新增后把当前实测写回基线（退役已消失的条目）。
 *
 * ## 指纹算法
 *
 * SHA-256(`${file}\0${symbol}\0${kind}`) —— 身份 = 文件相对路径 + 符号名 + 违规类型；
 * 同一身份多处出现按计数登记（如同一函数缺两个 @param）。改注释/空白不改判词，
 * 补掉某处 tag 则该身份计数下降直至消失 ⇒ prune 退役。
 *
 * ## 与 DSH 参考的两处有意差异（不把简化说成等价）
 *
 * ① **盲区修复**：DSH 的 `restrictedPublicNames()` 只认 `lib/types/*.d.ts` 可达公开名，
 *    非入口源的新导出看不见。本判据照抄 2259 `scanCasts` —— `git ls-files --cached
 *    --others --exclude-standard` + AST 全量扫 `packages/*\/*\/src`，不依赖 build 产物反推。
 * ② 指纹消失从 DSH 的「无包装 ⇒ 直接抛错」改成「提示 prune、仍绿」，与 2259 同口径。
 *
 * ## 退出码（`scripts/lib/gate-runtime.ts` 口径）
 *
 * 0 绿 / 1 红（新导出缺 tag）/ 2 判不了：基线缺席或读不动（no-baseline）、0 个源文件
 * （no-corpus）、找不到 typescript（no-binary）。删基线 ≠ 绿（exit 2）。
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-export-jsdoc"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const BASELINE_REL = "scripts/baseline/export-jsdoc.baseline.json"
const BASELINE = path.join(REPO, BASELINE_REL)

/** typescript 候选路径（与 verify-no-unknown-casts / lint-rule-fingerprint 同款）。 */
export const TS_CANDIDATES = [
  "forge-ui/node_modules/typescript/lib/typescript.js",
  "forge-pm/node_modules/typescript/lib/typescript.js",
  "node_modules/typescript/lib/typescript.js",
]

/** 加载 typescript（工具，不是被扫对象）；取不到返回 null，由 judge 转 unjudged。 */
export function loadTs(root: string = REPO): any | null {
  for (const base of [root, REPO]) {
    let req: NodeRequire
    try {
      req = createRequire(path.join(base, "package.json"))
    } catch {
      continue
    }
    for (const c of TS_CANDIDATES) {
      const abs = path.join(base, c)
      if (!fs.existsSync(abs)) continue
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

/* ─────────────────────────────────────────────────────────────────────────────
 * jsdoc.ts 四函数（移植自 DSH scripts/jsdoc.ts，纯函数、零适配）
 * ───────────────────────────────────────────────────────────────────────────── */

/** 仓库相对 `file:line` 指针。 */
export function pointer(ts: any, rel: string, sf: any, node: any): string {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return `${rel}:${line + 1}`
}

/** 节点前紧邻的 `/** … *\/` JSDoc block；无则 ''。 */
export function rawJsDoc(ts: any, text: string, node: any): string {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  const jsdoc = ranges.filter((r: any) => text.slice(r.pos, r.pos + 3) === "/**").at(-1)
  return jsdoc ? text.slice(jsdoc.pos, jsdoc.end) : ""
}

export type Mode = "emit" | "waterfall" | "parallel" | "serial" | "bail"

/** 把 JSDoc 正文拆成描述 prose + 可选 @mode；prose 到第一个 block tag 止。 */
export function parseJsDoc(raw: string): { doc: string; mode: Mode | null; hasMode: boolean } {
  const inner = raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").replace(/\s+$/, ""))
  let mode: Mode | null = null
  let hasMode = false
  let inTags = false
  const blocks: string[] = []
  let para: string[] = []
  const list: string[] = []
  let item: string[] = []
  const join = (parts: string[]): string => parts.join(" ").replace(/\s+/g, " ").trim()
  const flushItem = (): void => {
    if (item.length) list.push(join(item))
    item = []
  }
  const flushList = (): void => {
    flushItem()
    if (list.length) blocks.push(list.join("\n"))
    list.length = 0
  }
  const flushPara = (): void => {
    flushList()
    if (para.length) blocks.push(join(para))
    para = []
  }
  for (const line of inner) {
    const tagLine = line.trimStart()
    const m = /^@mode\s+(emit|waterfall|parallel|serial|bail)\s*$/.exec(tagLine)
    if (m) {
      mode = m[1] as Mode
      hasMode = true
      flushPara()
      inTags = true
      continue
    }
    if (/^@mode\b/.test(tagLine)) {
      hasMode = true
      flushPara()
      inTags = true
      continue
    }
    if (tagLine.startsWith("@")) {
      flushPara()
      inTags = true
      continue
    }
    if (inTags) continue
    if (line.trim() === "") {
      flushPara()
      continue
    }
    if (/^-\s+/.test(line)) {
      flushItem()
      if (para.length) {
        blocks.push(join(para))
        para = []
      }
      item.push(line)
      continue
    }
    if (item.length) {
      item.push(line)
      continue
    }
    para.push(line)
  }
  flushPara()
  const doc = blocks.join("\n\n").replace(/\{@link\s+([^}]+)\}/g, "$1").trim()
  return { doc, mode, hasMode }
}

/** 解析 @param / @returns（含续行）；@returns 必须是独立 block tag。 */
export function parseTags(raw: string): { params: Map<string, string>; returns: string | null } {
  const inner = raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*?\s?/, "").replace(/\s+$/, ""))
  const params = new Map<string, string>()
  let returns: string | null = null
  let sink: ((text: string) => void) | null = null
  for (const line of inner) {
    const param = /^@param\s+(\[?[\w$]+\]?)\s*(?:[-—–]\s*)?(.*)$/.exec(line)
    if (param) {
      const name = (param[1] ?? "").replace(/^\[|\]$/g, "")
      let acc = param[2] ?? ""
      params.set(name, acc)
      sink = (t) => {
        acc = acc ? `${acc} ${t}` : t
        params.set(name, acc)
      }
      continue
    }
    const ret = /^@returns?(?:\s+[-—–]?\s*(.*))?$/.exec(line)
    if (ret) {
      let acc = ret[1] ?? ""
      returns = acc
      sink = (t) => {
        acc = acc ? `${acc} ${t}` : t
        returns = acc
      }
      continue
    }
    if (line.startsWith("@") || line.trim() === "") {
      sink = null
      continue
    }
    sink?.(line.trim())
  }
  return { params, returns }
}

/** 每个非豁免参数须有非空 @param；binding pattern 与陈旧 tag 都拒绝。 */
export function checkParams(
  ts: any,
  where: string,
  apiKind: string,
  parameters: readonly any[],
  tags: Map<string, string>,
  sf: any,
  isExempt: (p: any) => boolean,
  violations: string[],
): void {
  for (const p of parameters) {
    if (!ts.isIdentifier(p.name)) {
      violations.push(`${where}: parameter '${p.name.getText(sf)}' is a binding pattern; the ${apiKind} API needs simple identifier parameters so @param can name them.`)
      continue
    }
    if (isExempt(p)) continue
    const desc = tags.get(p.name.text)
    if (desc === undefined) violations.push(`${where} is missing @param ${p.name.text}.`)
    else if (!desc.trim()) violations.push(`${where}: @param ${p.name.text} has an empty description.`)
  }
  for (const tag of tags.keys()) {
    if (!parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === tag)) {
      violations.push(`${where}: @param ${tag} does not match any parameter (stale tag?).`)
    }
  }
}

/** 非 void 返回须有非空 @returns；返回类型必须显式标注。 */
export function checkReturns(
  ts: any,
  where: string,
  typeNode: any,
  returns: string | null,
  sf: any,
  violations: string[],
): void {
  if (typeNode === undefined) {
    violations.push(`${where} has no return type annotation; annotate it explicitly so the gate can classify the result.`)
    return
  }
  const rt = typeNode.getText(sf).replace(/\s+/g, " ")
  if (/^(void|Promise<void>)$/.test(rt)) return
  if (returns === null) violations.push(`${where} is missing @returns (return type: ${rt}).`)
  else if (!returns.trim()) violations.push(`${where}: @returns has an empty description.`)
}

/* ─────────────────────────────────────────────────────────────────────────────
 * AST 扫描（移植 DSH verify-export-jsdoc.ts，保留全部豁免）
 * ───────────────────────────────────────────────────────────────────────────── */

/** 插件协议槽：导出类静态成员与顶层导出各自豁免，文档留在声明契约处。 */
const PROTOCOL_STATICS = new Set(["Config", "inject", "name", "reusable"])
const PROTOCOL_EXPORTS = new Set(["Config", "inject", "name", "reusable", "apply"])

/** 单文件遍历状态。 */
interface Walk {
  rel: string
  sf: any
  text: string
  checker: any
  violations: string[]
  ts: any
}

const isExported = (ts: any, stmt: any): boolean =>
  ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt)?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)

const isNonPublic = (ts: any, member: any): boolean =>
  ((ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)?.some(
    (m: any) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
  ) ?? false)
  || ("name" in member && ts.isPrivateIdentifier(member.name))

const isStatic = (ts: any, member: any): boolean =>
  (ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)?.some((m: any) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false

const thisReceiver = (ts: any, p: any): boolean => ts.isIdentifier(p.name) && p.name.text === "this"

/** 剥掉定义不了自身 API 的包装表达式（括号/as/satisfies/非空断言/尖括号断言）。 */
function unwrapExpression(ts: any, e: any): any {
  let inner = e
  while (
    ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isSatisfiesExpression(inner)
    || ts.isNonNullExpression(inner) || ts.isTypeAssertionExpression(inner)
  ) inner = inner.expression
  return inner
}

/** 内联 callable 标注分类；混合 callable 字面量 fail-closed。 */
function callableAnnotation(ts: any, type: any): any | "refuse" | null {
  if (ts.isFunctionTypeNode(type)) return type
  if (!ts.isTypeLiteralNode(type)) return null
  const signatures = type.members.filter((m: any) => ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m))
  if (signatures.length === 0) return null
  if (signatures.length === 1 && type.members.length === 1 && signatures[0] !== undefined && ts.isCallSignatureDeclaration(signatures[0])) {
    return signatures[0]
  }
  return "refuse"
}

/** 在类 heritage 里找继承文档；public override of protected base 不算继承。 */
function heritageExemption(
  ts: any,
  cls: any,
  name: string,
  staticSide: boolean,
  checker: any,
): { baseParams: Set<string> | null; baseVoidReturn: boolean | null } | null {
  const isProtected = (d: any): boolean =>
    (ts.canHaveModifiers(d) ? ts.getModifiers(d) : undefined)?.some((m: any) => m.kind === ts.SyntaxKind.ProtectedKeyword) ?? false
  for (const clause of cls.heritageClauses ?? []) {
    for (const t of clause.types) {
      const type = staticSide ? checker.getTypeAtLocation(t.expression) : checker.getTypeAtLocation(t)
      const prop = type.getProperty(name)
      if (prop === undefined) continue
      const decls = prop.declarations ?? []
      if (decls.length > 0 && decls.every(isProtected)) continue
      let baseParams: Set<string> | null = null
      let baseVoidReturn: boolean | null = null
      for (const d of decls) {
        let params: readonly any[] | undefined
        let returnType: any
        if (ts.isMethodDeclaration(d) || ts.isMethodSignature(d)) {
          params = d.parameters
          returnType = d.type
        } else if ((ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && d.type !== undefined && ts.isFunctionTypeNode(d.type)) {
          params = d.type.parameters
          returnType = d.type.type
        } else continue
        baseParams ??= new Set()
        for (const p of params) if (ts.isIdentifier(p.name)) baseParams.add(p.name.text.replace(/^_+/, ""))
        if (returnType !== undefined) {
          const voidish = /^(void|Promise<void>)$/.test(returnType.getText(d.getSourceFile()).replace(/\s+/g, " "))
          baseVoidReturn = (baseVoidReturn ?? true) && voidish
        }
      }
      return { baseParams, baseVoidReturn }
    }
  }
  return null
}

/** 方法 INFERRED 返回是否 void-like（唯一让 checker 分类的场合）。 */
function inferredReturnIsVoidish(ts: any, m: any, checker: any): boolean {
  const sig = checker.getSignatureFromDeclaration(m)
  if (sig === undefined) return true
  const returned = checker.getReturnTypeOfSignature(sig)
  const awaited = checker.getAwaitedType(returned) ?? returned
  return (awaited.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0
}

/** 描述 prose 存在性。 */
function checkDescribed(ts: any, where: string, raw: string, w: Walk): void {
  if (!raw) w.violations.push(`${where} has no JSDoc.`)
  else if (!parseJsDoc(raw).doc) w.violations.push(`${where} has no description prose above its block tags.`)
}

/** 函数完整契约：描述 + @param + 非 void @returns。 */
function checkFunctionLike(
  ts: any,
  where: string,
  raw: string,
  parameters: readonly any[],
  returnType: any,
  returnsWaived: boolean,
  w: Walk,
): void {
  if (!raw) {
    w.violations.push(`${where} has no JSDoc.`)
    return
  }
  if (!parseJsDoc(raw).doc) w.violations.push(`${where} has no description prose above its block tags.`)
  const { params, returns } = parseTags(raw)
  checkParams(ts, where, "exported", parameters, params, w.sf, (p) => thisReceiver(ts, p), w.violations)
  if (!returnsWaived) checkReturns(ts, where, returnType, returns, w.sf, w.violations)
}

/** 检查一个导出 class：类级 prose + 每个 public 方法契约 + public 属性/访问器 prose。 */
function checkClass(ts: any, cls: any, name: string, w: Walk): void {
  checkDescribed(ts, `exported class '${name}' (${pointer(ts, w.rel, w.sf, cls)})`, rawJsDoc(ts, w.text, cls), w)
  const overloadSigs = new Set<string>()
  const documentedGetters = new Set<string>()
  for (const m of cls.members) {
    if ("name" in m && ts.isComputedPropertyName(m.name)) continue
    if (ts.isMethodDeclaration(m) && !m.body) overloadSigs.add(m.name.getText(w.sf))
    if (ts.isGetAccessorDeclaration(m)) documentedGetters.add(m.name.getText(w.sf))
  }
  for (const m of cls.members) {
    if (isNonPublic(ts, m) || ts.isConstructorDeclaration(m)) continue
    if (!("name" in m) || ts.isComputedPropertyName(m.name)) continue
    const mname = m.name.getText(w.sf)
    if (isStatic(ts, m) && PROTOCOL_STATICS.has(mname)) continue
    const exemption = heritageExemption(ts, cls, mname, isStatic(ts, m), w.checker)
    if (ts.isMethodDeclaration(m)) {
      if (m.body && overloadSigs.has(mname)) continue
      const where = `exported class method '${name}.${mname}' (${pointer(ts, w.rel, w.sf, m)})`
      if (exemption !== null) {
        const raw = rawJsDoc(ts, w.text, m)
        const base = exemption.baseParams
        const inBase = (p: any): boolean =>
          base !== null && ts.isIdentifier(p.name) && base.has(p.name.text.replace(/^_+/, ""))
        if (base !== null && m.parameters.some((p: any) => !thisReceiver(ts, p) && !inBase(p))) {
          checkParams(ts, where, "exported", m.parameters, parseTags(raw).params, w.sf,
            (p) => thisReceiver(ts, p) || inBase(p), w.violations)
        }
        if (exemption.baseVoidReturn === true) {
          if (m.type !== undefined) {
            checkReturns(ts, where, m.type, parseTags(raw).returns, w.sf, w.violations)
          } else if (!inferredReturnIsVoidish(ts, m, w.checker)) {
            w.violations.push(`${where} returns a non-void result its heritage declaration does not document; annotate the return type and add @returns.`)
          }
        }
        continue
      }
      checkFunctionLike(ts, where, rawJsDoc(ts, w.text, m), m.parameters, m.type, false, w)
    } else if (exemption !== null) {
      continue
    } else if (ts.isGetAccessorDeclaration(m) || ts.isPropertyDeclaration(m)) {
      const kind = ts.isPropertyDeclaration(m) ? "property" : "accessor"
      checkDescribed(ts, `exported class ${kind} '${name}.${mname}' (${pointer(ts, w.rel, w.sf, m)})`, rawJsDoc(ts, w.text, m), w)
    } else if (ts.isSetAccessorDeclaration(m) && !documentedGetters.has(mname)) {
      checkDescribed(ts, `exported class accessor '${name}.${mname}' (${pointer(ts, w.rel, w.sf, m)})`, rawJsDoc(ts, w.text, m), w)
    }
  }
}

/** 检查一条导出声明。 */
function checkDecl(
  ts: any,
  stmt: any,
  prefix: string,
  overloadSigs: Set<string>,
  byName: Map<string, any[]>,
  ambient: boolean,
  w: Walk,
  only: ReadonlySet<string> | null = null,
): void {
  const at = (n: any): string => ` (${pointer(ts, w.rel, w.sf, n)})`
  if (ts.isFunctionDeclaration(stmt)) {
    const name = stmt.name?.text ?? "default"
    if (prefix === "" && PROTOCOL_EXPORTS.has(name)) return
    if (stmt.body && overloadSigs.has(name)) return
    checkFunctionLike(ts, `exported function '${prefix}${name}'${at(stmt)}`, rawJsDoc(ts, w.text, stmt),
      stmt.parameters, stmt.type, false, w)
    return
  }
  if (ts.isClassDeclaration(stmt)) {
    checkClass(ts, stmt, `${prefix}${stmt.name?.text ?? "default"}`, w)
    return
  }
  if (ts.isInterfaceDeclaration(stmt)) {
    checkDescribed(ts, `exported interface '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(ts, w.text, stmt), w)
    return
  }
  if (ts.isTypeAliasDeclaration(stmt)) {
    checkDescribed(ts, `exported type '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(ts, w.text, stmt), w)
    return
  }
  if (ts.isEnumDeclaration(stmt)) {
    checkDescribed(ts, `exported enum '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(ts, w.text, stmt), w)
    return
  }
  if (ts.isVariableStatement(stmt)) {
    const raw = rawJsDoc(ts, w.text, stmt)
    for (const d of stmt.declarationList.declarations) {
      const name = ts.isIdentifier(d.name) ? d.name.text : d.name.getText(w.sf)
      if (only !== null && !only.has(name)) continue
      if (prefix === "" && PROTOCOL_EXPORTS.has(name)) continue
      const where = `exported const '${prefix}${name}'${at(d)}`
      const annotation = d.type !== undefined ? callableAnnotation(ts, d.type) : null
      const init = d.initializer !== undefined ? unwrapExpression(ts, d.initializer) : undefined
      if (annotation === "refuse") {
        w.violations.push(`${where}: its callable type literal is not gate-classifiable; extract a named type and document it there.`)
      } else if (annotation !== null) {
        checkFunctionLike(ts, where, raw, annotation.parameters, annotation.type, false, w)
      } else if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        checkFunctionLike(ts, where, raw, init.parameters, init.type, init.type === undefined && d.type !== undefined, w)
      } else {
        checkDescribed(ts, where, raw, w)
      }
    }
    return
  }
  if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
    const siblings = (byName.get(stmt.name.text) ?? []).filter((s: any) => s !== stmt)
    const merged = siblings.some((s: any) => parseJsDoc(rawJsDoc(ts, w.text, s)).doc !== "")
    if (!merged) checkDescribed(ts, `exported namespace '${prefix}${stmt.name.text}'${at(stmt)}`, rawJsDoc(ts, w.text, stmt), w)
    let body = stmt.body
    let nsPrefix = `${prefix}${stmt.name.text}.`
    while (body !== undefined && ts.isModuleDeclaration(body)) {
      nsPrefix += `${body.name.getText(w.sf)}.`
      body = body.body
    }
    const declared = ambient
      || ((ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined)?.some((m: any) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false)
    if (body !== undefined && ts.isModuleBlock(body)) checkScope(ts, body.statements, nsPrefix, w, declared)
    return
  }
  if (ts.isImportEqualsDeclaration(stmt)) {
    const where = `exported alias '${prefix}${stmt.name.text}'${at(stmt)}`
    const sym = w.checker.getSymbolAtLocation(stmt.name)
    const target = sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0 ? w.checker.getAliasedSymbol(sym) : sym
    const RICH_TARGETS = ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule
    const rich = target === undefined
      || (target.flags & RICH_TARGETS) !== 0
      || w.checker.getTypeOfSymbol(target).getCallSignatures().length > 0
    if (rich) {
      w.violations.push(`${where} aliases a callable, class, or namespace target whose signature/member contract the alias cannot carry; export the declaration directly instead.`)
      return
    }
    checkDescribed(ts, where, rawJsDoc(ts, w.text, stmt), w)
    return
  }
  w.violations.push(`exported statement${at(stmt)} uses an export form verify-export-jsdoc does not handle; extend the gate.`)
}

/** 遍历一个词法作用域，解析 `export { … }` 到本地声明。 */
function checkScope(
  ts: any,
  statements: readonly any[],
  prefix: string,
  w: Walk,
  ambient: boolean,
): void {
  const byName = new Map<string, any[]>()
  const overloadSigs = new Set<string>()
  const add = (name: string, stmt: any): void => {
    byName.set(name, [...(byName.get(name) ?? []), stmt])
  }
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.name) add(stmt.name.text, stmt)
      if (!stmt.body && stmt.name) overloadSigs.add(stmt.name.text)
    } else if (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)
      || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      if (stmt.name) add(stmt.name.text, stmt)
    } else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
      add(stmt.name.text, stmt)
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) add(d.name.text, stmt)
      }
    }
  }
  const requested = new Map<any, Set<string> | null>()
  const request = (stmt: any, name: string | null): void => {
    const prior = requested.get(stmt)
    if (name === null || prior === null) {
      requested.set(stmt, null)
      return
    }
    requested.set(stmt, prior === undefined ? new Set([name]) : prior.add(name))
  }
  for (const stmt of statements) {
    if (ts.isModuleDeclaration(stmt)
      && (ts.isStringLiteral(stmt.name) || (stmt.flags & ts.NodeFlags.GlobalAugmentation) !== 0)) {
      continue // declare module '…' / declare global augmentation：不是本包的导出
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier) continue // re-export：定义模块自己会被扫
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text
          for (const decl of byName.get(local) ?? []) request(decl, local)
        }
      }
      continue
    }
    if (ts.isExportAssignment(stmt)) {
      if (stmt.isExportEquals) {
        w.violations.push(`export-equals assignment (${pointer(ts, w.rel, w.sf, stmt)}) is not a gate-supported export form; use ESM named exports.`)
        continue
      }
      const where = `default export (${pointer(ts, w.rel, w.sf, stmt)})`
      const expr = unwrapExpression(ts, stmt.expression)
      if (ts.isIdentifier(expr)) {
        for (const decl of byName.get(expr.text) ?? []) request(decl, expr.text)
      } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
        checkFunctionLike(ts, where, rawJsDoc(ts, w.text, stmt), expr.parameters, expr.type, false, w)
      } else {
        checkDescribed(ts, where, rawJsDoc(ts, w.text, stmt), w)
      }
      continue
    }
    if (isExported(ts, stmt) || (ambient && !ts.isImportDeclaration(stmt))) {
      request(stmt, null) // 盲区修复：不做 restrictedPublicNames 限制，全量 src 导出都查
    }
  }
  for (const stmt of statements) {
    const only = requested.get(stmt)
    if (only !== undefined) checkDecl(ts, stmt, prefix, overloadSigs, byName, ambient, w, only)
  }
}

/** 编译器选项。 */
function loadCompilerOptions(ts: any, scanRoot: string): any {
  const cfgPath = path.resolve(scanRoot, "tsconfig.base.json")
  if (!fs.existsSync(cfgPath)) return { skipLibCheck: true, noLib: true, types: [] }
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile.bind(ts.sys)) as { config?: unknown }
  const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, scanRoot)
  return {
    ...parsed.options,
    noEmit: true,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    incremental: false,
  }
}

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/u
const SRC_PATH = /^packages\/[^/]+\/[^/]+\/src\/.+/u

/** 违规类型（身份指纹第三个分量）。 */
export type ViolationKind = "missing-param" | "missing-returns" | "no-doc" | "other"

/** 一条结构化违规。 */
export interface JsdocViolation {
  file: string
  line: number
  symbol: string
  kind: ViolationKind
  /** DSH 原始判词（供 finding detail 使用）。 */
  message: string
}

/** 把 DSH 的字符串判词归一成结构化违规。 */
function normalizeViolation(line: string): JsdocViolation {
  const m = /^(.+?)\s+\(([^()]+?):(\d+)\)\s+(.+)$/.exec(line)
  const label = m?.[1] ?? line
  const file = m?.[2] ?? ""
  const parsedLine = Number(m?.[3] ?? 0)
  const msg = m?.[4] ?? line
  const sym = /'([^']+)'/.exec(label)?.[1] ?? label
  let kind: ViolationKind
  if (/@param/.test(msg)) kind = "missing-param"
  else if (/@returns|return type|non-void result/.test(msg)) kind = "missing-returns"
  else if (/no JSDoc|description prose/.test(msg)) kind = "no-doc"
  else kind = "other"
  return { file, line: parsedLine, symbol: sym, kind, message: line }
}

/**
 * 全量扫盘：`git ls-files`（含未跟踪新文件，抓「新文件⇒红」）→ 只留 packages/*\/*\/src
 * 源码 → AST。`filesOverride` 供 spec 在临时语料上直接喂文件列表（绕过 git 仓库约束）。
 */
export function scanViolations(
  root: string,
  ts: any,
  filesOverride?: readonly string[],
): { violations: JsdocViolation[]; fileCount: number } {
  let files: string[]
  if (filesOverride) {
    files = [...new Set(filesOverride.map((f) => f.replaceAll("\\", "/")))].sort()
  } else {
    let out: string
    try {
      out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      })
    } catch (e) {
      throw new Error(`git ls-files 失败（${(e as Error).message}）`)
    }
    files = [...new Set(out.split("\0").filter(Boolean).map((f) => f.replaceAll("\\", "/")))].sort()
  }
  files = files.filter((f) => SRC_PATH.test(f) && SOURCE_EXT.test(f) && !f.endsWith(".d.ts"))
  const rels = files
  const program = ts.createProgram(rels.map((rel: string) => path.join(root, rel)), loadCompilerOptions(ts, root))
  const checker = program.getTypeChecker()
  const strings: string[] = []
  let fileCount = 0
  for (const rel of rels) {
    const abs = path.join(root, rel)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(abs)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) throw new Error(`源软链不支持：${rel}`)
    if (!stat.isFile()) continue
    const sf = program.getSourceFile(abs)
    if (!sf) continue
    fileCount++
    checkScope(ts, sf.statements, "", { rel, sf, text: sf.text, checker, violations: strings, ts },
      sf.isDeclarationFile && !ts.isExternalModule(sf))
  }
  return { violations: strings.map(normalizeViolation), fileCount }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 指纹基线 + 判定（照搬 2259 形态）
 * ───────────────────────────────────────────────────────────────────────────── */

/** 身份指纹：文件 + 符号 + 违规类型。 */
export function fingerprint(v: Pick<JsdocViolation, "file" | "symbol" | "kind">): string {
  return createHash("sha256").update(`${v.file}\0${v.symbol}\0${v.kind}`).digest("hex")
}

/** `文件 → 身份指纹 → 计数`。 */
export type JsdocBaseline = Record<string, Record<string, number>>

/** judge 的纯输入。 */
export interface JsdocInput {
  violations: JsdocViolation[]
  baseline: JsdocBaseline | null
  fileCount: number
  hasTs: boolean
}

/** `文件 → 身份指纹 → 计数`，稳定排序。 */
export function countViolations(violations: readonly JsdocViolation[]): JsdocBaseline {
  const out: JsdocBaseline = {}
  for (const v of violations) {
    const fp = fingerprint(v)
    const counts = (out[v.file] ??= {})
    counts[fp] = (counts[fp] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, counts]) => [file, Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))]),
  )
}

/** 基线结构体检：非法即返回 false（fail-closed，不拿空表当「全都没有记录」）。 */
function validBaseline(value: unknown): value is JsdocBaseline {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  for (const [file, counts] of Object.entries(value)) {
    if (!SRC_PATH.test(file) || file.startsWith("/") || file.includes("\\") || file.split("/").includes("..")) return false
    if (typeof counts !== "object" || counts === null || Array.isArray(counts) || Object.keys(counts).length === 0) return false
    for (const [fp, n] of Object.entries(counts)) {
      if (!/^[a-f0-9]{64}$/u.test(fp) || typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) return false
    }
  }
  return true
}

/** 读基线；缺席/读不动/结构非法 ⇒ null。 */
export function readBaseline(root: string = REPO): JsdocBaseline | null {
  const file = path.join(root, BASELINE_REL)
  if (!fs.existsSync(file)) return null
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    return validBaseline(value) ? value : null
  } catch {
    return null
  }
}

/** 判词 detail：文件:行 + 符号名 + 期望/实际 + 怎么改。 */
function describeFinding(v: JsdocViolation): string {
  const fp = fingerprint(v).slice(0, 12)
  let expect: string
  let fix: string
  if (v.kind === "missing-param") {
    const name = /is missing @param ([^.]+)\./.exec(v.message)?.[1] ?? "?"
    expect = `期望 @param，实际缺 @param ${name}`
    fix = `补 @param ${name} <描述>（独立 block tag）`
  } else if (v.kind === "missing-returns") {
    expect = "期望 @returns，实际缺"
    fix = "把 @returns 独立成一行 block tag（不要写在描述行内），非 void 返回必须标注类型"
  } else if (v.kind === "no-doc") {
    expect = "期望描述 prose，实际缺"
    fix = "在导出声明上方补 /** 描述 */（描述写在 block tag 之前）"
  } else {
    expect = "期望可分类的契约，实际不合规"
    fix = "按判词补齐 JSDoc 或提取命名类型后标注"
  }
  return `符号 '${v.symbol}'（身份 ${fp}）：${expect}；${v.message.replace(/^.*?\(\S+:\d+\)\s*/, "")} 怎么改：${fix}`
}

/** 纯判定：观测 + 基线 → GateResult。 */
export function judgeExportJsdoc(input: JsdocInput): GateResult {
  if (!input.hasTs) return unjudged(GATE, "no-binary", "找不到 typescript ⇒ AST 扫不了，判不了（不是绿）")
  if (input.fileCount === 0) return unjudged(GATE, "no-corpus", "packages/*/*/src 下 0 个源码文件 —— 分母为 0 不许冒充绿")
  if (input.baseline === null) return unjudged(GATE, "no-baseline", `基线缺席或读不动：${BASELINE_REL}（删基线不能让判据变绿）`)

  const remaining: JsdocBaseline = structuredClone(input.baseline)
  const added: JsdocViolation[] = []
  for (const v of input.violations) {
    const counts = remaining[v.file]
    const fp = fingerprint(v)
    const allowance = counts?.[fp] ?? 0
    if (counts !== undefined && allowance > 0) counts[fp] = allowance - 1
    else added.push(v)
  }

  const findings: Finding[] = added.map((v) => ({
    file: v.file,
    line: v.line,
    detail: describeFinding(v),
  }))

  const stale = Object.entries(remaining).flatMap(([file, counts]) =>
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([fp, n]) => `${file}（${fp.slice(0, 12)}，余 ${n}）`),
  )
  if (findings.length) {
    return { gate: GATE, status: "failed", findings }
  }
  const detail = stale.length
    ? `存量 ${input.violations.length} 条违规已登记；${stale.length} 个身份指纹已消失，可运行 --prune 退役：${stale.slice(0, 6).join("、")}`
    : `存量 ${input.violations.length} 条违规已登记，无新增。`
  return { gate: GATE, status: "passed", findings: [], detail }
}

/** `--prune`：确认无新增后把当前实测写回基线。返回写入的文件条目数。 */
export function pruneBaseline(root: string = REPO): number {
  const baseline = readBaseline(root)
  if (baseline === null) throw new Error(`基线读不动，拒绝 prune：${BASELINE_REL}`)
  const ts = loadTs(root)
  if (!ts) throw new Error("找不到 typescript，拒绝 prune")
  const { violations, fileCount } = scanViolations(root, ts)
  if (fileCount === 0) throw new Error("0 个源码文件，拒绝 prune（空集不许写空基线）")
  const judge = judgeExportJsdoc({ violations, baseline, fileCount, hasTs: true })
  if (judge.status === "failed") {
    throw new Error(`有新增违规，拒绝 prune：\n${(judge.findings ?? []).map((f) => `  ${f.file}:${f.line} ${f.detail}`).join("\n")}`)
  }
  const next = countViolations(violations)
  fs.mkdirSync(path.dirname(path.join(root, BASELINE_REL)), { recursive: true })
  fs.writeFileSync(path.join(root, BASELINE_REL), `${JSON.stringify(next, null, 2)}\n`)
  return Object.keys(next).length
}

async function cli(): Promise<number> {
  const args = process.argv.slice(2)
  const rootArg = args.indexOf("--root")
  const root = rootArg >= 0 && args[rootArg + 1] ? path.resolve(args[rootArg + 1]) : REPO

  if (args.includes("--prune")) {
    try {
      const n = pruneBaseline(root)
      console.log(`✓ ${GATE}: 已 prune，基线剩 ${n} 个文件条目。`)
      return 0
    } catch (e) {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      return 2
    }
  }

  const ts = loadTs(root)
  let input: JsdocInput
  try {
    const { violations, fileCount } = scanViolations(root, ts)
    input = { violations, baseline: readBaseline(root), fileCount, hasTs: ts !== null }
  } catch (e) {
    console.error(`✗ ${GATE}: 扫盘失败（${(e as Error).message}）⇒ 判不了（不是绿）`)
    return 2
  }
  return runGate({ name: GATE, main: () => judgeExportJsdoc(input) })
}

if (isMain(import.meta.url)) {
  cli()
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
