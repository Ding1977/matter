/**
 * W12 雏形判据（ISS-531 / P3-U2a）：client 包用户可见文案必须走 locale 字典、禁硬编码。
 *
 * ## 判什么（雏形口径，有意收窄）
 *
 * 扫 packages/client/<pkg>/src 下的 ts/tsx 源文件里含**中文字符**的字符串字面量（CJK 统一表意文字
 * 区段）——中文产品里这就是「用户可见文案」的可机判代理。一个中文字面量合规当且仅当它是：
 *   ① 显式经 locale 字典取用：包在字典参数位调用 `t(...)` / `tr(...)` / `translate(...)` /
 *      `i18n.t(...)` / `locale.t(...)`，且中文字面量不是**直接**作为可渲染文本出现；或
 *   ② 经豁免登记（带 ticket）：ui-theme 的 21 条 token `description`（是文档元数据，不渲染到 UI），
 *      按 tickets 登记豁免，不扩红（需求段 5 原话）。
 * 其余裸中文字面量 = 违例（finding，带 文件:行 + 文本片段）。
 *
 * ## 为什么是「雏形」
 *
 * 这是 W12 的第一版判据，口径刻意保守：只判 CJK 字面量这一个可机判信号，不试图解析 JSX 文本、
 * 模板拼接、props 传递（那些是 W12 完整版的范畴）。保守的代价是漏判英文硬编码文案；但
 * 「能判红」是硬标准——本判据对裸中文文案必红（见 spec 的必然失败向量），不是恒绿摆设。
 *
 * ## 三态（gate-runtime 唯一口径）
 *
 *   0 = passed（扫到 ≥1 个 client 源文件，0 条未豁免违例）
 *   1 = failed（有未豁免的中文字面量）
 *   2 = unjudged（packages/client/ 不存在 / 0 源文件 no-corpus / 找不到 typescript no-binary）
 *
 * @module gates/verify-client-ui-i18n
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-client-ui-i18n"
const require = createRequire(import.meta.url)

/** CJK 统一表意文字（含扩展 A 与兼容表意文字）——中文文案的最小代理集。 */
export const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/

/** locale 字典取用函数名（白名单；出现在调用callee位置时其字符串参数不算裸文案）。 */
export const LOCALE_CALL_NAMES: ReadonlySet<string> = new Set(["t", "tr", "translate", "formatMessage"])

/**
 * 一条豁免登记：文件（仓库相对）+ 中文字面量原文 + ticket。
 * ui-theme 的 21 条 token description 是文档元数据（THEME_TOKENS 的 description 字段），
 * 不渲染到 UI，按 ISS-530 登记；ticket 非占位符（对齐 verify-exemption-register 口径）。
 */
export interface I18nExemption {
  /** 仓库相对文件路径。 */
  readonly file: string
  /** 豁免的中文字面量原文（逐字匹配）。 */
  readonly text: string
  /** 关联工单号（带号，非占位）。 */
  readonly ticket: string
}

/** 存量豁免（不扩红；新增中文文案必须走字典或新登记带票）。 */
export const EXEMPTIONS: readonly I18nExemption[] = [
  { file: "packages/client/ui-theme/src/tokens.ts", text: "纯白：页面表面与强调色上的文字底。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "近黑（非纯黑）：最强档正文文字，比 #000 柔和不刺眼。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "浅灰：分隔线与卡片描边的原子色。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "中灰：次要文字与图标的原子色。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "极浅灰：抬升表面（卡片、浮层）的原子底色。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "强调蓝的极浅档：选中与悬停的淡彩底。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "强调蓝主档：主操作、链接与焦点态的原子色。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "危险红主档：破坏性操作与错误态的原子色。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "小圆角：按钮、输入框等控件的原子圆角。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "中圆角：卡片、编辑器外框等面板的原子圆角。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "页面/画布底色：最大面积的背景。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "抬升表面：卡片、浮层、工具条相对 surface 抬一层的底色。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "选中底：列表选中项、文本选区与悬停的淡彩底。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "主文字：正文与标题的颜色。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "次要文字：占位符、说明文字、禁用态标签。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "弱边框：分隔线、卡片描边、输入框描边。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "强调色：主操作按钮、链接、焦点环。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "强调色上的文字：accent 填充之上保持可读的前景色。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "危险色：破坏性操作、校验错误、删除确认。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "控件圆角：按钮与输入框的圆角。", ticket: "ISS-530" },
  { file: "packages/client/ui-theme/src/tokens.ts", text: "面板圆角：卡片与编辑器外框的圆角。", ticket: "ISS-530" },
]

/** 一条中文文案命中（供 finding 与 spec 断言）。 */
export interface CjkFinding {
  /** 仓库相对路径。 */
  readonly file: string
  /** 1-based 行号。 */
  readonly line: number
  /** 中文字面量原文。 */
  readonly text: string
}

/** 扫描输入（纯函数，spec 可直接喂）。 */
export interface I18nInput {
  /** 每个 client 源文件：仓库相对路径 → 正文。 */
  readonly files: ReadonlyMap<string, string>
  /** 是否已加载 typescript（缺它判 no-binary）。 */
  readonly hasTs: boolean
}

/** typescript 候选路径（与 verify-export-jsdoc 同款）。 */
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

/**
 * 从单个源文件的 AST 里抽出「裸中文字面量」——即不在 locale 字典调用参数位的中文字面量。
 * @param ts - typescript 模块。
 * @param rel - 仓库相对路径。
 * @param source - 文件正文。
 * @returns 该文件未走字典的中文字面量命中数组。
 */
export function scanFile(ts: any, rel: string, source: string): CjkFinding[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true)
  const findings: CjkFinding[] = []
  const isLocaleArg = (node: any): boolean => {
    const parent = node.parent
    if (!parent || !ts.isCallExpression(parent)) return false
    const callee = parent.expression
    // t("...") / tr(...) / translate(...) / i18n.t(...) / locale.t(...)
    if (ts.isIdentifier(callee) && LOCALE_CALL_NAMES.has(callee.text)) return true
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name) && LOCALE_CALL_NAMES.has(callee.name.text)) return true
    return false
  }
  const visit = (node: any): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && CJK_RE.test(node.text)) {
      if (!isLocaleArg(node)) {
        const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf, false))
        findings.push({ file: rel, line: pos.line + 1, text: node.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

/**
 * 纯函数判定：扫到的裸中文字面量里，扣掉豁免登记后还有没有违例。
 * @param input - 扫描输入（文件表 + typescript 是否可用）。
 * @param ts - typescript 模块（hasTs=true 时必给；spec 传桩）。
 * @param exemptions - 豁免登记（默认用存量 EXEMPTIONS）。
 * @returns GateResult。
 */
export function judgeClientI18n(input: I18nInput, ts: any, exemptions: readonly I18nExemption[] = EXEMPTIONS): GateResult {
  if (!input.hasTs) return unjudged(GATE, "no-binary", "找不到 typescript ⇒ 无法 AST 解析，判不了（不是绿）")
  if (input.files.size === 0) return unjudged(GATE, "no-corpus", "packages/client/<pkg>/src 一个源文件都没扫到 —— 判不了，不当绿")

  const exemptKeys = new Set(exemptions.map((e) => `${e.file}\u0000${e.text}`))
  const violations: CjkFinding[] = []
  let scanned = 0
  for (const [rel, source] of input.files) {
    scanned++
    for (const f of scanFile(ts, rel, source)) {
      if (!exemptKeys.has(`${f.file}\u0000${f.text}`)) violations.push(f)
    }
  }
  if (violations.length) {
    return {
      gate: GATE,
      status: "failed",
      findings: violations.map((v) => ({ file: v.file, line: v.line, detail: `硬编码中文文案（未走 locale 字典、未登记豁免）：${JSON.stringify(v.text)}` })),
    }
  }
  return {
    gate: GATE,
    status: "passed",
    detail: `${scanned} 个 client 源文件：裸中文字面量 0（豁免 ${exemptions.length} 条存量）`,
  }
}

/** 现场采集：扫 packages/client/<pkg>/src 的 .ts/.tsx。 */
const SOURCE_RE = /\.(?:ts|tsx)$/
const SKIP = new Set(["node_modules", "lib", "dist", "tests"])

/**
 * 递归列出 packages/client/<pkg>/src 下的源文件（仓库相对路径 → 正文）。
 * @param root - 仓库根。
 * @returns 源文件表。
 */
export function collectSources(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const base = path.join(root, "packages", "client")
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
        else if (e.isFile() && SOURCE_RE.test(e.name)) {
          out.set(path.relative(REPO, abs), fs.readFileSync(abs, "utf8"))
        }
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
      return judgeClientI18n({ files: collectSources(REPO), hasTs: ts !== null }, ts)
    },
  })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
