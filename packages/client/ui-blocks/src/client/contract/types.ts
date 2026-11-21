/**
 * 我们侧块的富文本表示（ISS-531 / P3-U2a）——契约层。
 *
 * @matter/blocks 的 `Rich = { text, marks?: string[] }` 是 P2 骨架：marks 只是一维字符串，
 * 没有承载 color 的值与 link 的 href。P3 把它细化为结构化 {@link OurMark}（见 marks.ts），
 * 细化只发生在 client 映射层（@matter/blocks 写范围不在本单）。
 *
 * {@link OurRich} 是我们侧一个文本片段：`text` + 结构化 `marks`。一个块的内容 =
 * `OurRich[]`（多个片段），对应 BlockNote 的 `InlineContent[]`（styled text / link 交错）。
 *
 * @module @matter/client-ui-blocks/client/contract/types
 */

import type { OurMark } from "./marks.ts"
import { markToSkeletonString } from "./marks.ts"

/** 我们侧一个富文本片段：文本 + 结构化 mark 列表。 */
export interface OurRich {
  /** 片段文本。 */
  readonly text: string
  /** 该片段承载的 mark（0..N 个）。 */
  readonly marks: readonly OurMark[]
}

/**
 * A 档 9 种我们侧块的结构化记录（P3 mark 细化后的形态）。
 *
 * 与 @matter/blocks 的 A_BASIC_TYPES 同型，但 `rich`/`items` 的 mark 从 P2 骨架的 `string[]`
 * 细化为 {@link OurRich}（结构化 mark，能无损承载 color 的值与 link 的 href）——细化只发生在本
 * client 映射层。传给 @matter/blocks zod 校验时经 {@link toBlockSkeleton} 降级回骨架字符串。
 */
export type OurABlock =
  | { readonly id: string; readonly type: "paragraph"; readonly rich: readonly OurRich[] }
  | { readonly id: string; readonly type: "heading"; readonly rich: readonly OurRich[]; readonly level: number }
  | { readonly id: string; readonly type: "bulletList"; readonly items: readonly OurRich[] }
  | { readonly id: string; readonly type: "orderedList"; readonly items: readonly OurRich[]; readonly start?: number }
  | { readonly id: string; readonly type: "todo"; readonly rich: readonly OurRich[]; readonly checked: boolean }
  | { readonly id: string; readonly type: "quote"; readonly rich: readonly OurRich[] }
  | { readonly id: string; readonly type: "divider" }
  | { readonly id: string; readonly type: "code"; readonly code: string; readonly language?: string }
  | { readonly id: string; readonly type: "image"; readonly url: string; readonly caption?: string }

/**
 * B 档第一批 5 种我们侧块（ISS-532 / P3-U2b），与 @matter/blocks 的 B_BUSINESS_TYPES 子集同型。
 * - issueRef / docRef：引用块，`ref` 指向目标；`preview` 是否渲染静态预览卡；
 * - mermaid：图表源码块，`code` 是图描述（图表引擎不入本单）；
 * - toggle：E-3a 容器，`title` + 递归 `children`（嵌套写入走 zod 校验）；
 * - view：视图块，`ref` 指向视图配置，`kind` 是呈现形态（list/table/board）。
 */
export type OurBBlock =
  | { readonly id: string; readonly type: "issueRef"; readonly ref: string; readonly preview?: boolean }
  | { readonly id: string; readonly type: "docRef"; readonly ref: string; readonly preview?: boolean }
  | { readonly id: string; readonly type: "mermaid"; readonly code: string; readonly caption?: string }
  | { readonly id: string; readonly type: "toggle"; readonly title: string; readonly children?: readonly OurBlock[] }
  | { readonly id: string; readonly type: "view"; readonly ref: string; readonly kind?: "list" | "table" | "board" }

/** 第一批 14 种我们侧块 = A 档 9 + B 档 5（本单 W6 全量往返的入参类型）。 */
export type OurBlock = OurABlock | OurBBlock

/**
 * 结构化 {@link OurRich} → @matter/blocks P2 骨架 `Rich`（marks 降级为字符串）。
 * @param rich - 我们侧富文本片段。
 * @returns 骨架兼容的 `{ text, marks }` 对象。
 */
function richToSkeleton(rich: OurRich): { text: string; marks: string[] } {
  return { text: rich.text, marks: rich.marks.map(markToSkeletonString) }
}

/**
 * 结构化 {@link OurBlock} → @matter/blocks `Block` zod 可解析的骨架对象。
 * 只用于运行时 schema 校验（验收负例：非法 props 被 zod 拒且点名字段），不用于 BN 映射。
 * toggle 的 children 递归降级——容器嵌套校验（叶子塞 children / title 非 string）在 zod 侧发生。
 * @param block - 我们侧块（A 档 9 或 B 档 5）。
 * @returns 骨架形态对象（结构合法时可由 @matter/blocks 的 `Block.parse` 解析）。
 */
export function toBlockSkeleton(block: OurBlock): Record<string, unknown> {
  if (isBBlock(block)) return bBlockToSkeleton(block)
  switch (block.type) {
    case "paragraph":
    case "quote":
      return { id: block.id, type: block.type, rich: block.rich.map(richToSkeleton) }
    case "heading":
      return { id: block.id, type: block.type, rich: block.rich.map(richToSkeleton), level: block.level }
    case "bulletList":
      return { id: block.id, type: block.type, items: block.items.map(richToSkeleton) }
    case "orderedList":
      return block.start === undefined
        ? { id: block.id, type: block.type, items: block.items.map(richToSkeleton) }
        : { id: block.id, type: block.type, items: block.items.map(richToSkeleton), start: block.start }
    case "todo":
      return { id: block.id, type: block.type, rich: block.rich.map(richToSkeleton), checked: block.checked }
    case "divider":
      return { id: block.id, type: block.type }
    case "code":
      return block.language === undefined
        ? { id: block.id, type: block.type, code: block.code }
        : { id: block.id, type: block.type, code: block.code, language: block.language }
    case "image":
      return block.caption === undefined
        ? { id: block.id, type: block.type, url: block.url }
        : { id: block.id, type: block.type, url: block.url, caption: block.caption }
  }
}

/** 类型守卫：B 档 5 种（收窄到 OurBBlock）。 */
function isBBlock(block: OurBlock): block is OurBBlock {
  return block.type === "issueRef" || block.type === "docRef" || block.type === "mermaid" || block.type === "toggle" || block.type === "view"
}

/**
 * B 档块 → 骨架（从 {@link toBlockSkeleton} 拆出以压低圈复杂度）。
 * @param block - B 档块。
 * @returns 骨架对象（toggle children 递归降级）。
 */
function bBlockToSkeleton(block: OurBBlock): Record<string, unknown> {
  switch (block.type) {
    case "issueRef":
    case "docRef":
      return block.preview === undefined
        ? { id: block.id, type: block.type, ref: block.ref }
        : { id: block.id, type: block.type, ref: block.ref, preview: block.preview }
    case "mermaid":
      return block.caption === undefined
        ? { id: block.id, type: block.type, code: block.code }
        : { id: block.id, type: block.type, code: block.code, caption: block.caption }
    case "view":
      return block.kind === undefined
        ? { id: block.id, type: block.type, ref: block.ref }
        : { id: block.id, type: block.type, ref: block.ref, kind: block.kind }
    case "toggle":
      return block.children === undefined
        ? { id: block.id, type: block.type, title: block.title }
        : { id: block.id, type: block.type, title: block.title, children: block.children.map(toBlockSkeleton) }
  }
}

/**
 * 便捷构造：纯文本片段（无 mark）。
 * @param text - 片段文本。
 * @returns 无 mark 的 OurRich。
 */
export function plainRich(text: string): OurRich {
  return { text, marks: [] }
}

/**
 * 便捷构造：带单一 mark 的片段。
 * @param text - 片段文本。
 * @param mark - 该片段的唯一 mark。
 * @returns 带一个 mark 的 OurRich。
 */
export function markedRich(text: string, mark: OurMark): OurRich {
  return { text, marks: [mark] }
}
