/**
 * 静态判据 S3（圆角越档）+ S4（颜色只用 alias）+ S6（阴影描边不配对）的扫描核心
 * （ISS-932 / DOC-533 段五 + 段四）。
 *
 * 形态移植自 DSH `packages/client/ui-theme/tests/`
 *   · radius-styles.client.spec.ts  → unscaledRadii（S3）
 *   · color-tokens.client.spec.ts   → colorViolations（S4）
 *   · elevation-styles.client.spec.ts 的 neutralBordersBesideElevation（S6）
 * 载体按本仓重写：合法集从 theme.css 动态读（不写死六档），walker 射程 = apps/web/src +
 * packages/client 各包的 src（沿用 ISS-907 typography-scan 的 scanRoots），前缀 --matter-*。
 *
 * 扫描只报事实、判定交给 vitest spec / gate 薄包装。刻意不写死圆角/facing 档位。
 * S3 射程只判 border-radius 系列属性（跳过 --* 自定义属性定义）——theme.css 的
 * `--matter-static-radius-*: 4px` 是合法真值源，不是组件越档。
 * S4 不判 box-shadow / mask / alpha-0（DSH 豁免：几何与不绘制的墨色）。
 * S6 只判「elevation 阴影 + 中性 alias border 同规则」这一对，不移植 DSH 同文件里
 *   的 hairline 宽度判据（不属本单）。
 *
 * @module @matter/client-ui-theme/tests/style-contracts-scan
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/** 扫描根：本文件在 packages/client/ui-theme/tests/，向上四级到仓库根。 */
const REPO = fileURLToPath(new URL("../../../../", import.meta.url))
const THEME_CSS = join(REPO, "packages/client/ui-theme/src/client/theme.css")

/**
 * 合法集：圆角 alias 名（从 theme.css 动态读，六档不写死）。
 * S4（颜色字面量）与 S6（阴影/描边配对）照 DSH 用字面 pattern 判定，不额外动态读集合。
 */
export interface StyleConfig {
  readonly radiusAliases: ReadonlySet<string>
}

/** 一次扫描的事实：每条 finding 的 key = `相对路径:行号`，value = 违规代码片段。 */
export interface StyleFindings {
  readonly s3: Readonly<Record<string, string>>
  readonly s4: Readonly<Record<string, string>>
  readonly s6: Readonly<Record<string, string>>
}

/**
 * 从 theme.css 解析一类 `--matter-alias-<prefix>-*` 定义名（真值源，不写死档位）。
 * @param css - theme.css 全文。
 * @param prefix - alias 子类前缀，如 `radius` / `elevation` / `border`。
 * @returns CSS 变量全名集合。
 */
export function aliasNames(css: string, prefix: string): Set<string> {
  const re = new RegExp(`(--matter-alias-${prefix}-[a-z0-9-]+)\\s*:`, "g")
  return new Set([...css.matchAll(re)].map((m) => m[1]).filter((n): n is string => n !== undefined))
}

/**
 * 读真值源，得到圆角合法集。
 * @returns 圆角 alias 名集合。
 */
export function readConfig(): StyleConfig {
  return { radiusAliases: aliasNames(readFileSync(THEME_CSS, "utf8"), "radius") }
}

/** 一条 CSS 声明：属性、值、原文起始偏移（用于算行号）。 */
interface Declaration {
  property: string
  value: string
  offset: number
}

/** 一条扁平 CSS 规则：选择器 + 声明（按源码顺序）。 */
interface Rule {
  selectors: string[]
  declarations: Declaration[]
}

/**
 * 扁平化 CSS 为规则列表（注释保留换行、不保留字符；大括号不嵌套，本仓样式表均无嵌套）。
 * @param css - 样式表全文。
 * @returns 规则列表，按源码顺序。
 */
function parseRules(css: string): Rule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  const rules: Rule[] = []
  for (const raw of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = raw[2] ?? ""
    const bodyStart = (raw.index ?? 0) + (raw[1]?.length ?? 0) + 1
    const declarations: Declaration[] = []
    let cursor = 0
    for (const part of body.split(";")) {
      const colon = part.indexOf(":")
      if (colon > 0) {
        declarations.push({
          property: part.slice(0, colon).trim(),
          value: part.slice(colon + 1).trim(),
          offset: bodyStart + cursor,
        })
      }
      cursor += part.length + 1
    }
    rules.push({ selectors: (raw[1] ?? "").split(",").map((s) => s.trim()), declarations })
  }
  return rules
}

/** 文件里第 offset 字符所在的行号（1-based）。 */
function lineAt(css: string, offset: number): number {
  return css.slice(0, offset).split("\n").length
}

/** 声明值里 var() 引用的自定义属性名。 */
function varRefs(value: string): string[] {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] ?? "")
}

/**
 * S3：一条 border-radius 声明是否越档 / 引错 token。
 *   · 有限 px 且 4 < n < 99 ⇒ 越档红（4px 小细节豁免、50%/999px 全圆豁免）
 *   · 引用 `--matter-alias-radius-*` 但不在合法集 ⇒ 拼错 token 红
 *   · 其它值（var 到别的 token / 百分比 / 0）⇒ 合规
 * @param property - CSS 属性名。
 * @param value - 声明值。
 * @param cfg - 合法集。
 * @returns 违规 true / 合规 false。
 */
export function badRadius(property: string, value: string, cfg: StyleConfig): boolean {
  if (!/^border(?:-[\w-]+)?-radius$/.test(property)) return false
  const px = [...value.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)].map((m) => Number(m[1]))
  if (px.some((n) => n > 4 && n < 99)) return true
  return varRefs(value).some((name) => name.startsWith("--matter-alias-radius-") && !cfg.radiusAliases.has(name))
}

/** DSH color-tokens：hex / 颜色函数 / white|black 字面量。 */
const LITERAL_COLOR = new RegExp([
  String.raw`#[0-9a-f]{3,8}\b`,
  String.raw`\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|light-dark)\([^)]*\)`,
  String.raw`(?<![\w-])(white|black)(?![\w-])`,
].join("|"), "gi")

/** alpha=0 的字面量：画不出颜色，豁免。 */
function transparentLiteral(literal: string): boolean {
  return /\/\s*0(\.0*)?%?\s*\)$|^(rgba|hsla)\(([^,]*,){3}\s*0(\.0*)?%?\s*\)$/i.test(literal)
}

/** box-shadow / mask 是几何墨色，不是主题表面/文字色。 */
const EXEMPT_PROPERTIES = /^(-webkit-)?mask(-image)?$|^box-shadow$/

/**
 * S4：一条声明是否用了 static 色板 / 字面色。
 * @param property - CSS 属性名。
 * @param value - 声明值。
 * @returns 违规 true / 合规 false。
 */
export function badColor(property: string, value: string): boolean {
  if (EXEMPT_PROPERTIES.test(property)) return false
  if (value.includes("--matter-static-color-")) return true
  return [...value.matchAll(LITERAL_COLOR)].some(([literal = ""]) => !transparentLiteral(literal))
}

/** box-shadow 是否引用 elevation 阴影 alias。 */
const ELEVATED_SHADOW = /var\(\s*--matter-alias-elevation-/

/** 照 DSH：任意 border* 属性（不含 border-radius）都算描边。 */
function isBorderProperty(property: string): boolean {
  return property.startsWith("border") && !property.startsWith("border-radius")
}

/**
 * S6：一条规则是否把 elevation 阴影与中性 alias border 配在同处（双描边）。
 * 照 DSH elevation spec 用字面前缀 pattern（不做动态合法集），state 色板 border 不在前缀内、天然豁免。
 * @param rule - CSS 规则。
 * @returns 违规 true / 合规 false。
 */
export function pairedShadowBorder(rule: Rule): boolean {
  const elevated = rule.declarations.some((d) => d.property === "box-shadow" && ELEVATED_SHADOW.test(d.value))
  if (!elevated) return false
  return rule.declarations.some((d) => {
    if (!isBorderProperty(d.property) || d.value === "0" || d.value === "none") return false
    return varRefs(d.value).some((name) => name.startsWith("--matter-alias-border-"))
  })
}

/** theme 自有源（theme.css 真值源 + dsw-bridge.css 桥接层）不进 feature 扫描射程。 */
function isThemeOwner(rel: string): boolean {
  return rel.startsWith("packages/client/ui-theme/src/")
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
 * 扫一份 CSS 的 S3/S4/S6 违规（供自测直接喂文本）。
 * @param css - 样式表全文。
 * @param rel - 仓库相对路径（finding key 用）。
 * @param cfg - 合法集。
 */
export function cssFindings(css: string, rel: string, cfg: StyleConfig): {
  s3: Record<string, string>
  s4: Record<string, string>
  s6: Record<string, string>
} {
  const s3: Record<string, string> = {}
  const s4: Record<string, string> = {}
  const s6: Record<string, string> = {}
  for (const rule of parseRules(css)) {
    for (const d of rule.declarations) {
      const at = `${rel}:${lineAt(css, d.offset)}`
      if (badRadius(d.property, d.value, cfg)) s3[at] = `${d.property}:${d.value}`
      if (badColor(d.property, d.value)) s4[at] = `${d.property}:${d.value}`
    }
    if (pairedShadowBorder(rule)) {
      const first = rule.declarations[0]
      const at = `${rel}:${first === undefined ? 1 : lineAt(css, first.offset)}`
      s6[at] = rule.selectors.join(", ")
    }
  }
  return { s3, s4, s6 }
}

/** 扫一份脚本的 S4 违规：static 色板引用（DSH color-tokens 的 script 面）。 */
export function scriptFindings(source: string, rel: string): Record<string, string> {
  const out: Record<string, string> = {}
  source.split("\n").forEach((line, i) => {
    if (line.includes("--matter-static-color-")) out[`${rel}:${i + 1}`] = "--matter-static-color-*"
  })
  return out
}

/**
 * 全仓扫：apps/web/src + 各 client 包 src（排除 ui-theme 自有源）。
 * @param cfg - 合法集；缺省现场读真值源。
 * @returns S3/S4/S6 违规映射。
 */
export function scanRepo(cfg: StyleConfig = readConfig()): StyleFindings {
  const s3: Record<string, string> = {}
  const s4: Record<string, string> = {}
  const s6: Record<string, string> = {}
  for (const root of scanRoots()) {
    for (const file of walk(root, [".css", ".ts", ".tsx"])) {
      const rel = file.slice(REPO.length).split("\\").join("/")
      if (isThemeOwner(rel)) continue
      const source = readFileSync(file, "utf8")
      if (file.endsWith(".css")) {
        const f = cssFindings(source, rel, cfg)
        Object.assign(s3, f.s3)
        Object.assign(s4, f.s4)
        Object.assign(s6, f.s6)
      } else {
        Object.assign(s4, scriptFindings(source, rel))
      }
    }
  }
  return { s3, s4, s6 }
}
