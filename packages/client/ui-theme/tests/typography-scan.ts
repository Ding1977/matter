/**
 * 静态判据 S1（裸标题禁用）+ S2（字号/字重只用档位）的扫描核心（ISS-907 / DOC-533 段三）。
 *
 * 形态照 DSH `packages/client/ui-theme/tests/stylesheet-scan.ts`：合法集从真值源**动态读**，
 * 扫描只报事实、判定交给 vitest spec / gate 薄包装。刻意不写死字号档——从 theme.css 的
 * `--matter-alias-font-size-*` 定义解析；字重档同理从 `expected/font-weight-tiers.json` 读。
 *
 * S1 走 **TypeScript AST**（不是正则）：注释、字符串、JSX 文本里的 `<h2>` 不会被误伤；
 * 同时认 JSX `<h2 …>` 与本仓实际形态 `createElement("h2", props, …)`（含 `React.createElement`）。
 *
 * 射程 = apps/web/src 全树 + packages/client 各包的 src 树；源码 `.ts/.tsx` 判 S1，`.css` 判 S2。
 * S2 只判 `font-size` / `font-weight` **属性**（不判 `--*` 自定义属性定义）——token 定义页
 * theme.css / dsw-bridge.css 里的 `--…font-size: 14px` 是合法真值源，不是违规。
 *
 * @module @matter/client-ui-theme/tests/typography-scan
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/** 扫描根：本文件在 packages/client/ui-theme/tests/，向上四级到仓库根。 */
const REPO = fileURLToPath(new URL("../../../../", import.meta.url))
const THEME_CSS = join(REPO, "packages/client/ui-theme/src/client/theme.css")
const WEIGHT_TIERS = join(REPO, "packages/client/ui-theme/tests/expected/font-weight-tiers.json")

/** 合法集：字号档（CSS 变量全名）+ 字重档（数值）。 */
export interface TypographyConfig {
  readonly fontSizes: ReadonlySet<string>
  readonly weights: ReadonlySet<number>
}

/** 一次扫描的事实：finding key = `相对路径:行号`，value = 违规代码（h2 / font-size:14px …）。 */
export interface ScanFindings {
  readonly s1: Readonly<Record<string, string>>
  readonly s2: Readonly<Record<string, string>>
}

/**
 * 从 theme.css 解析 `--matter-alias-font-size-*` 定义名（真值源，不写死档位）。
 * @param css - theme.css 全文。
 * @returns 字号档 CSS 变量全名集合。
 */
export function fontSizeTiers(css: string): Set<string> {
  return new Set([...css.matchAll(/(--matter-alias-font-size-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
}

/**
 * 从 expected json 解析字重档（DSH 设计体系：400/500/600，无 700）。
 * @param json - font-weight-tiers.json 全文。
 * @returns 合法字重数值集合。
 */
export function weightTiers(json: string): Set<number> {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== "object" || parsed === null || !("tiers" in parsed)) {
    throw new Error("font-weight-tiers.json 缺 tiers 字段")
  }
  const tiers = (parsed as { tiers: unknown }).tiers
  if (!Array.isArray(tiers) || tiers.some((n) => typeof n !== "number")) {
    throw new Error("font-weight-tiers.json 的 tiers 必须是数字数组")
  }
  return new Set(tiers as number[])
}

/**
 * 读真值源，得到合法集。
 * @returns 字号档 / 字重档集合。
 */
export function readConfig(): TypographyConfig {
  return {
    fontSizes: fontSizeTiers(readFileSync(THEME_CSS, "utf8")),
    weights: weightTiers(readFileSync(WEIGHT_TIERS, "utf8")),
  }
}

/** 一条 CSS 声明：属性、值、在原文中的起始偏移（用于算行号）。 */
interface Declaration {
  property: string
  value: string
  offset: number
}

/**
 * 扁平化 CSS 为声明列表（注释保留换行、不保留字符；大括号不嵌套，本仓样式表均无嵌套）。
 * @param css - 样式表全文。
 * @returns 属性/值/偏移三元组列表。
 */
function declarations(css: string): Declaration[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  const out: Declaration[] = []
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = rule[2] ?? ""
    const bodyStart = (rule.index ?? 0) + (rule[1]?.length ?? 0) + 1
    let cursor = 0
    for (const part of body.split(";")) {
      const colon = part.indexOf(":")
      if (colon > 0) {
        out.push({
          property: part.slice(0, colon).trim(),
          value: part.slice(colon + 1).trim(),
          offset: bodyStart + cursor,
        })
      }
      cursor += part.length + 1
    }
  }
  return out
}

/**
 * 去掉 var(...) 调用后的剩余文本（含 fallback 的 var 整段去掉）——裸数字判定用。
 * @param value - 声明值。
 * @returns 去掉 var 调用的值。
 */
function withoutVars(value: string): string {
  return value.replace(/var\([^)]*\)/g, " ")
}

/**
 * 判一条 `font-size` 声明是否违规：必须引用已定义字号档，且不得夹带裸数字。
 * @param value - 声明值。
 * @param cfg - 合法集。
 * @returns 违规 true / 合规 false。
 */
export function badFontSize(value: string, cfg: TypographyConfig): boolean {
  const refs = [...value.matchAll(/var\(\s*(--matter-alias-font-size-[a-z0-9-]+)/g)].map((m) => m[1])
  const usesTier = refs.some((r) => r !== undefined && cfg.fontSizes.has(r))
  return !usesTier || /\d/.test(withoutVars(value))
}

/**
 * 判一条 `font-weight` 声明是否违规：必须是已定义数值档，且不得夹带裸数字/关键词。
 * @param value - 声明值。
 * @param cfg - 合法集。
 * @returns 违规 true / 合规 false。
 */
export function badFontWeight(value: string, cfg: TypographyConfig): boolean {
  const refs = [...value.matchAll(/var\(\s*(--matter-alias-font-weight-[a-z0-9-]+)/g)].map((m) => m[1])
  if (refs.length > 0) return false // 未来若加字重 token，写 var 即合规（档由定义方管）
  const bare = value.trim()
  if (/^[0-9]+$/.test(bare)) return !cfg.weights.has(Number(bare))
  return true // normal/bold/bolder/lighter/裸 px 等关键词一律红
}

/**
 * 扫一份 CSS 的 S2 违规。
 * @param css - 样式表全文。
 * @param rel - 仓库相对路径（finding key 用）。
 * @param cfg - 合法集。
 * @returns key→code 映射。
 */
export function cssFindings(css: string, rel: string, cfg: TypographyConfig): Record<string, string> {
  const out: Record<string, string> = {}
  for (const d of declarations(css)) {
    if (d.property !== "font-size" && d.property !== "font-weight") continue
    const bad = d.property === "font-size" ? badFontSize(d.value, cfg) : badFontWeight(d.value, cfg)
    if (!bad) continue
    const line = css.slice(0, d.offset).split("\n").length
    out[`${rel}:${line}`] = `${d.property}:${d.value}`
  }
  return out
}

/** JSX 属性里有没有可用的 className（spread 无法静态判定，保守视为有，避免误报）。 */
function jsxHasClassName(attrs: ts.JsxAttributes): boolean {
  return attrs.properties.some((p) => {
    if (ts.isJsxSpreadAttribute(p)) return true
    return ts.isJsxAttribute(p) && p.name.getText() === "className" && p.initializer !== undefined
  })
}

/** createElement 第二个参数里有没有可用的 className（非对象字面量保守视为有）。 */
function createHasClassName(props: ts.Expression | undefined): boolean {
  if (props === undefined) return false
  if (props.kind === ts.SyntaxKind.NullKeyword || props.kind === ts.SyntaxKind.UndefinedKeyword) return false
  if (!ts.isObjectLiteralExpression(props)) return true
  return props.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) return true
    if (!ts.isPropertyAssignment(p) || p.name.getText() !== "className") return false
    return p.initializer.kind !== ts.SyntaxKind.NullKeyword
  })
}

const HEADING = /^h[1-6]$/i

/**
 * 扫一份 TS/TSX 的 S1 违规（AST 级：注释/字符串不误伤）。
 * @param source - 源码全文。
 * @param rel - 仓库相对路径，必须带 .ts/.tsx 后缀（决定解析為 JSX）。
 * @returns key→code 映射（code = 小写标签名）。
 */
export function headingFindings(source: string, rel: string): Record<string, string> {
  const kind = rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind)
  const out: Record<string, string> = {}
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const report = (n: ts.Node, tag: string): void => {
    out[`${rel}:${lineOf(n)}`] = tag.toLowerCase()
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf)
      if (HEADING.test(tag) && !jsxHasClassName(node.attributes)) report(node, tag)
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isCreate =
        (ts.isIdentifier(callee) && callee.text === "createElement") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "createElement")
      const first = node.arguments[0]
      if (isCreate && first !== undefined && ts.isStringLiteral(first) && HEADING.test(first.text)) {
        if (!createHasClassName(node.arguments[1])) report(node, first.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** 递归列目录下指定后缀的文件（跳过 node_modules / dist / 点目录）。 */
function walk(dir: string, exts: readonly string[]): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue
      found.push(...walk(full, exts))
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      found.push(full)
    }
  }
  return found
}

/** 本判据的扫描射程根目录。 */
export function scanRoots(): string[] {
  const roots = [join(REPO, "apps/web/src")]
  const clientDir = join(REPO, "packages/client")
  for (const entry of readdirSync(clientDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const src = join(clientDir, entry.name, "src")
    if (existsSync(src)) roots.push(src)
  }
  return roots
}

/**
 * 全仓扫（apps/web/src + 各 client 包的 src）。
 * @param cfg - 合法集；缺省现场读真值源。
 * @returns S1 / S2 违规映射。
 */
export function scanRepo(cfg: TypographyConfig = readConfig()): ScanFindings {
  const s1: Record<string, string> = {}
  const s2: Record<string, string> = {}
  for (const root of scanRoots()) {
    for (const file of walk(root, [".ts", ".tsx"])) {
      const rel = file.slice(REPO.length).split("\\").join("/")
      Object.assign(s1, headingFindings(readFileSync(file, "utf8"), rel))
    }
    for (const file of walk(root, [".css"])) {
      const rel = file.slice(REPO.length).split("\\").join("/")
      Object.assign(s2, cssFindings(readFileSync(file, "utf8"), rel, cfg))
    }
  }
  return { s1, s2 }
}
