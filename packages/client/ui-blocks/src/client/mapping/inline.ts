/**
 * 富文本内联映射（ISS-531 / P3-U2a）——`OurRich[]` ⇄ BlockNote `InlineContent[]`。
 *
 * 这是 Marks 8 的**实际转换点**：
 *   - 7 个 style mark 走 BN 的 `styles` 字典（key 为 BN style 名，value 为 true 或颜色字符串）；
 *   - link 走 BN 的 `{ type:"link", href, content: StyledText[] }` inline content——link 在 BN
 *     不是 style（U-0 问3 实证），所以 `our mark{type:link,href}` ⇄ BN link inline content 双向转换
 *     在此完成，而不是塞进 styles。
 *
 * 一个 our 片段（text + marks[]）→ 一个 BN StyledText（styles 来自 7 个 style mark）；
 * 若该片段带 link mark，则整体包成 BN link inline content，link 的 `content` 仍是带其余 style 的
 * StyledText。反向读回时，link 的 href 还原成 link mark，其余 styles 还原成我们侧 style mark。
 *
 * 全程用 schema 派生的具体类型 + BN 官方类型守卫判别，无 `any`、无 `as unknown as`。
 *
 * @module @matter/client-ui-blocks/client/mapping/inline
 */

import { isLinkInlineContent, isStyledTextInlineContent } from "@blocknote/core"
import {
  BN_CUSTOM_STYLE_TO_OUR_MARK,
  BN_LINK_INLINE_TYPE,
  BN_STYLE_TO_OUR_MARK,
  CUSTOM_MARK_TO_BN_STYLE,
  SIMPLE_MARK_TO_BN_STYLE,
  VALUED_MARK_TO_BN_STYLE,
  decodeRefMark,
  encodeRefMark,
  isSizeValue,
  type OurMark,
} from "../contract/marks.ts"
import type { OurRich } from "../contract/types.ts"
import type { BnInline, BnStyledText } from "./schema.ts"

/** BN 侧 styles 字典的值类型（boolean style = true，string style = 颜色值）。 */
type BnStyles = Record<string, boolean | string>

/**
 * 把 7 个 style 类的 our mark 写入 BN styles 字典；link mark 不在其中（它走 inline content）。
 * @param marks - 我们侧 mark 列表。
 * @param out - 目标 BN styles 字典（原地写入）。
 * @returns 是否遇到过 link mark（供调用方决定是否包 link inline content）。
 */
function writeStyles(marks: readonly OurMark[], out: BnStyles): boolean {
  let hasLink = false
  for (const m of marks) {
    switch (m.type) {
      case "bold":
      case "italic":
      case "underline":
      case "strikethrough":
      case "code":
        out[SIMPLE_MARK_TO_BN_STYLE[m.type]] = true
        break
      case "color":
      case "bg":
        out[VALUED_MARK_TO_BN_STYLE[m.type]] = m.value
        break
      case "link":
        hasLink = true
        break
      case "highlight":
        out[CUSTOM_MARK_TO_BN_STYLE.highlight] = true
        break
      case "size":
        out[CUSTOM_MARK_TO_BN_STYLE.size] = m.value
        break
      case "math":
        out[CUSTOM_MARK_TO_BN_STYLE.math] = m.tex
        break
      case "ref":
        out[CUSTOM_MARK_TO_BN_STYLE.ref] = encodeRefMark(m)
        break
    }
  }
  return hasLink
}

/**
 * 我们侧一个片段 → BN StyledText。
 * @param rich - 我们侧富文本片段。
 * @returns BN StyledText（styles 只含 7 个 style mark，link 不在此）。
 */
function ourRichToStyledText(rich: OurRich): BnStyledText {
  const styles: BnStyles = {}
  writeStyles(rich.marks, styles)
  return { type: "text", text: rich.text, styles }
}

/**
 * 我们侧片段数组 → BN InlineContent 数组。
 * @param richs - 我们侧富文本片段序列。
 * @returns BN inline content 序列。
 */
export function ourRichToBnInline(richs: readonly OurRich[]): BnInline[] {
  const out: BnInline[] = []
  for (const rich of richs) {
    const link = rich.marks.find((m): m is Extract<OurMark, { type: "link" }> => m.type === "link")
    const styled = ourRichToStyledText(rich)
    if (link !== undefined) {
      out.push({ type: BN_LINK_INLINE_TYPE, href: link.href, content: [styled] })
    } else {
      out.push(styled)
    }
  }
  return out
}

/**
 * 把 BN styles 字典读回为我们侧 style mark（link 不在这里——它由 inline content 的 href 还原）。
 * @param styles - BN styles 字典。
 * @returns 我们侧 mark 列表（只含 7 个 style mark）。
 */
function bnStylesToMarks(styles: BnStyles): OurMark[] {
  const out: OurMark[] = []
  for (const [key, value] of Object.entries(styles)) {
    if (value !== true && typeof value !== "string") continue

    // 四自写 mark（ISS-532 / P3-U2b）：先认自写 style 名，再做值编解码。
    const custom = BN_CUSTOM_STYLE_TO_OUR_MARK[key]
    if (custom !== undefined) {
      const mark = customStyleToMark(custom, value)
      if (mark !== undefined) out.push(mark)
      continue
    }

    const mapped = BN_STYLE_TO_OUR_MARK[key]
    if (mapped === undefined) continue
    if (mapped === "color" || mapped === "bg") {
      if (typeof value === "string") out.push({ type: mapped, value })
    } else {
      out.push({ type: mapped })
    }
  }
  return out
}

/**
 * 单个自写 BN style → 我们侧 mark（从 {@link bnStylesToMarks} 拆出以压低圈复杂度）。
 * @param custom - 自写 mark 名。
 * @param value - BN style 值（true 或字符串）。
 * @returns 我们侧 mark，或 undefined（值形态不匹配时丢弃）。
 */
function customStyleToMark(
  custom: "highlight" | "size" | "math" | "ref",
  value: boolean | string,
): OurMark | undefined {
  switch (custom) {
    case "highlight": return value === true ? { type: "highlight" } : undefined
    case "size": return typeof value === "string" && isSizeValue(value) ? { type: "size", value } : undefined
    case "math": return typeof value === "string" ? { type: "math", tex: value } : undefined
    case "ref": return typeof value === "string" ? decodeRefMark(value) : undefined
  }
}

/**
 * BN inline content 数组 → 我们侧片段数组（link 双向还原）。
 * @param inline - BN inline content 序列。
 * @returns 我们侧富文本片段序列。
 */
export function bnInlineToOurRich(inline: readonly BnInline[]): OurRich[] {
  const out: OurRich[] = []
  for (const item of inline) {
    if (isLinkInlineContent(item)) {
      // link 的 inner content 是 StyledText[]：其 styles → 我们侧 style mark，再补一个 link mark。
      for (const st of item.content) {
        out.push({
          text: st.text,
          marks: [...bnStylesToMarks(st.styles as BnStyles), { type: "link", href: item.href }],
        })
      }
    } else if (isStyledTextInlineContent(item)) {
      out.push({ text: item.text, marks: bnStylesToMarks(item.styles as BnStyles) })
    }
  }
  return out
}
