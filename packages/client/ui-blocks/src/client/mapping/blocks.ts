/**
 * A 档块映射（ISS-531 / P3-U2a）——`OurABlock` ⇄ BN 块，含 props 映射/裁剪与粒度归一。
 *
 * 三件事在此完成（DOC-512 §5.2「写一层 props 映射」）：
 *   ① **名映射**：type 经 OUR_TO_BN_TYPE / BN_TO_OUR_TYPE 显式转换（bulletList→bulletListItem 等）；
 *   ② **props 映射/裁剪**：我们侧字段 → BN props（level/checked/language/url/caption/start），
 *      读回时只取我们认识的字段、裁掉 BN defaultProps（backgroundColor/textColor/textAlignment/
 *      isToggleable/showPreview 等）——这些不属于我们的记录，不往回带；
 *   ③ **粒度归一**：我们一块 bulletList/orderedList 携带 N 个 items → BN 展开为 N 个连续列表项块，
 *      读回时把连续同型列表项折叠回一块（start 落在首项）。
 *
 * Rich 结构差由 `mapping/inline.ts` 处理；本文件只编排块级字段。
 *
 * @module @matter/client-ui-blocks/client/mapping/blocks
 */

import type { OurABlock, OurRich } from "../contract/types.ts"
import { bnInlineToOurRich, ourRichToBnInline } from "./inline.ts"
import type { BnBlock, BnInline, BnPartialBlock } from "./schema.ts"

/**
 * 我们侧一块 → BN 待插入块数组（列表类返回 N 块，其余返回 1 块）。
 * 每个分支写死 BN type 字面量——用查表返回的联合类型会让 discriminated union 无法收窄（实测 TS2322）。
 * @param block - 我们侧 A 档块。
 * @returns BN PartialBlock 数组（顺序即文档顺序）。
 */
export function ourBlockToBn(block: OurABlock): BnPartialBlock[] {
  switch (block.type) {
    case "paragraph":
      return [{ id: block.id, type: "paragraph", content: ourRichToBnInline(block.rich) }]
    case "heading":
      return [{ id: block.id, type: "heading", props: { level: block.level }, content: ourRichToBnInline(block.rich) }]
    case "todo":
      return [{ id: block.id, type: "checkListItem", props: { checked: block.checked }, content: ourRichToBnInline(block.rich) }]
    case "quote":
      return [{ id: block.id, type: "quote", content: ourRichToBnInline(block.rich) }]
    case "divider":
      return [{ id: block.id, type: "divider" }]
    case "code":
      return [{ id: block.id, type: "codeBlock", props: { language: block.language ?? "text" }, content: block.code }]
    case "image":
      return [{ id: block.id, type: "image", props: { url: block.url, caption: block.caption ?? "" } }]
    case "bulletList":
      return block.items.map((item, i) => ({ id: i === 0 ? block.id : `${block.id}-li${i}`, type: "bulletListItem", content: ourRichToBnInline([item]) }))
    case "orderedList":
      return block.items.map((item, i) => ({
        id: i === 0 ? block.id : `${block.id}-li${i}`,
        type: "numberedListItem",
        props: i === 0 && block.start !== undefined ? { start: block.start } : {},
        content: ourRichToBnInline([item]),
      }))
  }
}

/**
 * BN 块内 inline content → 我们侧富文本数组；codeBlock 的 plain content（字符串）走单片段。
 * @param block - BN 块。
 * @returns 我们侧富文本片段数组。
 */
function bnContentToRich(block: BnBlock): OurRich[] {
  // BN 在读回时把 plain content（codeBlock）也规范化成 StyledText[]；完整 BnBlock 的 content
  // 没有 string 变体，直接 typeof 会收窄到 never，故先经 unknown 再判（兼容未来的 string 变体）。
  const content: unknown = block.content
  if (typeof content === "string") return [{ text: content, marks: [] }]
  if (Array.isArray(content)) return bnInlineToOurRich(content as BnInline[])
  return []
}

/** 从 BN props 里读字符串字段。 */
function propStr(props: Record<string, unknown>, key: string): string | undefined {
  return typeof props[key] === "string" ? (props[key] as string) : undefined
}

/** 从 BN props 里读数字字段。 */
function propNum(props: Record<string, unknown>, key: string): number | undefined {
  return typeof props[key] === "number" ? (props[key] as number) : undefined
}

/** 从 BN props 里读布尔字段。 */
function propBool(props: Record<string, unknown>, key: string): boolean | undefined {
  return typeof props[key] === "boolean" ? (props[key] as boolean) : undefined
}

/** 拼一段富文本数组的纯文本（codeBlock 的 plain content 读回形态）。 */
function richText(rich: readonly OurRich[]): string {
  return rich.map((r) => r.text).join("")
}

/**
 * 读回单个 BN 块（非列表）为我们侧 A 档块；type 不在 A 档则返回 undefined。
 * @param block - BN 块。
 * @returns 我们侧 A 档块，或 undefined（列表类/非 A 档由调用方另行处理）。
 */
function bnSingleToOur(block: BnBlock): OurABlock | undefined {
  const props = block.props as Record<string, unknown>
  const rich = bnContentToRich(block)
  switch (block.type) {
    case "paragraph":
    case "quote":
      return { id: block.id, type: block.type, rich }
    case "heading":
      return { id: block.id, type: "heading", rich, level: propNum(props, "level") ?? 1 }
    case "checkListItem":
      return { id: block.id, type: "todo", rich, checked: propBool(props, "checked") ?? false }
    case "codeBlock": {
      const language = propStr(props, "language")
      return language === undefined
        ? { id: block.id, type: "code", code: richText(rich) }
        : { id: block.id, type: "code", code: richText(rich), language }
    }
    case "image": {
      const url = propStr(props, "url") ?? ""
      const caption = propStr(props, "caption")
      return caption === undefined
        ? { id: block.id, type: "image", url }
        : { id: block.id, type: "image", url, caption }
    }
    case "divider":
      return { id: block.id, type: "divider" }
    case "bulletListItem":
    case "numberedListItem":
      return undefined // 折叠逻辑在 foldList
  }
}

/**
 * 折叠一段连续同型 BN 列表项为我们侧一块列表（粒度归一）。
 * @param blocks - 完整 BN 块序列。
 * @param start - 折叠起点下标。
 * @param kind - 列表项 type（bulletListItem / numberedListItem）。
 * @returns 我们侧列表块与其后第一个非列表项的下标。
 */
function foldList(blocks: readonly BnBlock[], start: number, kind: "bulletListItem" | "numberedListItem"): { block: OurABlock; next: number } {
  const items: OurRich[] = []
  let listStart: number | undefined
  let j = start
  while (j < blocks.length && blocks[j].type === kind) {
    const rich = bnContentToRich(blocks[j])
    items.push(rich.length === 1 ? rich[0] : { text: richText(rich), marks: rich.flatMap((r) => r.marks) })
    if (kind === "numberedListItem" && j === start) {
      listStart = propNum((blocks[j].props as Record<string, unknown>), "start")
    }
    j++
  }
  const id = blocks[start].id
  if (kind === "bulletListItem") return { block: { id, type: "bulletList", items }, next: j }
  const ordered: OurABlock = listStart === undefined
    ? { id, type: "orderedList", items }
    : { id, type: "orderedList", items, start: listStart }
  return { block: ordered, next: j }
}

/**
 * BN 块数组 → 我们侧 A 档块数组（连续同型列表项折叠回一块，裁掉 BN 默认 props）。
 * @param blocks - BN 块序列（通常来自 headless 编辑器的 editor.document）。
 * @returns 我们侧 A 档块序列。
 */
export function bnBlocksToOur(blocks: readonly BnBlock[]): OurABlock[] {
  const out: OurABlock[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type === "bulletListItem" || block.type === "numberedListItem") {
      const folded = foldList(blocks, i, block.type)
      out.push(folded.block)
      i = folded.next - 1
      continue
    }
    const one = bnSingleToOur(block)
    if (one !== undefined) out.push(one)
  }
  return out
}
