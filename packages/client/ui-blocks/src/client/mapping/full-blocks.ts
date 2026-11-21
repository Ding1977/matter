/**
 * 第一批 14 种块的完整映射（ISS-532 / P3-U2b）——`OurBlock` ⇄ 完整 BN schema 的块。
 *
 * A 档 9 复用 U-2a 的 `ourBlockToBn` / `bnBlocksToOur`（名差/粒度差/props 裁剪不重复实现）；
 * B 档 5 在本文件按 type 字符串显式映射：
 *   - issueRef / docRef / mermaid / view 是 content:"none" 的自定义块，props 直传；
 *   - toggle 是 BN 内置 `toggleListItem`——title 走 inline content（BN 无 title prop），
 *     children 递归映射（E-3a `{title,children}` ⇄ BN `{content,children}`）。
 *
 * ## 类型处理
 *
 * 完整 schema 为满足 d.ts emit 稳定性被断言成具名 `NamedSchema`（15 默认块形状），自定义
 * type 不在其编译期词表里。本文件用一层窄的 `BnLoose*` 结构描述 BN 数据面，只在
 * `bootFullEditor` 的 create/document 两处边界各断言一次（运行期 14 块、编译期具名 schema，
 * 与 U-2a 同一口径；不是 as unknown as，不绕过 strict 对映射主逻辑的检查）。
 *
 * @module @matter/client-ui-blocks/client/mapping/full-blocks
 */

import { BlockNoteEditor } from "@blocknote/core"
import type { OurABlock, OurBlock, OurRich } from "../contract/types.ts"
import { plainRich } from "../contract/types.ts"
import { bnBlocksToOur, ourBlockToBn } from "./blocks.ts"
import { bnInlineToOurRich, ourRichToBnInline } from "./inline.ts"
import type { BnEditor } from "./schema.ts"
import { fullBlockNoteSchema } from "./schema.ts"

/** BN 数据面块的窄结构（编译期 schema 词表外的自定义 type 用宽 type:string 承载）。 */
interface BnLooseBlock {
  readonly id: string
  readonly type: string
  readonly props?: Record<string, unknown>
  readonly content?: unknown
  readonly children?: readonly BnLooseBlock[]
}

/** 我们侧 B 档 5 种的 type 集合（读回时与普通块分组）。 */
const BN_B_TYPES: ReadonlySet<string> = new Set(["issueRef", "docRef", "mermaid", "toggleListItem", "view"])

/** 从 BN props 读字符串。 */
function propStr(props: Record<string, unknown>, key: string): string | undefined {
  return typeof props[key] === "string" ? (props[key] as string) : undefined
}

/** 从 BN props 读布尔。 */
function propBool(props: Record<string, unknown>, key: string): boolean | undefined {
  return typeof props[key] === "boolean" ? (props[key] as boolean) : undefined
}

/** BN inline content（或 plain string）→ 我们侧富文本数组。 */
function bnContentToRich(content: unknown): OurRich[] {
  if (typeof content === "string") return [{ text: content, marks: [] }]
  if (Array.isArray(content)) return bnInlineToOurRich(content as never)
  return []
}

/** 一段富文本的纯文本拼接（toggle title 由 inline content 还原为 title:string）。 */
function richText(rich: readonly OurRich[]): string {
  return rich.map((r) => r.text).join("")
}

/**
 * 我们侧一块 → BN 待插入块数组（B 档列表类按语义展开，当前 B 档均为 1 块）。
 * A 档委托 U-2a 的 `ourBlockToBn`；B 档在本函数分支。
 * @param block - 我们侧块（A 档 9 或 B 档 5）。
 * @returns BN 待插入块数组（顺序即文档顺序）。
 */
export function ourBlockToBnFull(block: OurBlock): BnLooseBlock[] {
  if (!isBBlock(block)) return ourBlockToBn(block) as BnLooseBlock[]
  const id = block.id
  switch (block.type) {
    case "issueRef":
    case "docRef":
      return [{
        id,
        type: block.type,
        props: { ref: block.ref, preview: block.preview ?? false },
      }]
    case "mermaid":
      return [{ id, type: "mermaid", props: { code: block.code, caption: block.caption ?? "" } }]
    case "view":
      return [{ id, type: "view", props: { ref: block.ref, kind: block.kind ?? "list" } }]
    case "toggle":
      return [{
        id,
        type: "toggleListItem",
        content: ourRichToBnInline([plainRich(block.title)]),
        children: block.children?.map(ourBlockToBnFull).flat() ?? [],
      }]
  }
}

/**
 * 类型守卫：是否 B 档 5 种（把 OurBlock 收窄到 OurBBlock）。
 * @param block - 待判块。
 * @returns 是 B 档时收窄。
 */
function isBBlock(block: OurBlock): block is Extract<OurBlock, { type: "issueRef" | "docRef" | "mermaid" | "toggle" | "view" }> {
  return block.type === "issueRef" || block.type === "docRef" || block.type === "mermaid" || block.type === "toggle" || block.type === "view"
}

/**
 * 读回单个 B 档 BN 块为我们侧块；非 B 档返回 undefined。
 * @param block - BN 块。
 * @returns 我们侧 B 档块，或 undefined。
 */
function bnBBlockToOur(block: BnLooseBlock): OurBlock | undefined {
  const props = block.props ?? {}
  switch (block.type) {
    case "issueRef":
    case "docRef":
      return readRefBlock(block.id, block.type, props)
    case "mermaid": {
      const code = propStr(props, "code") ?? ""
      const caption = propStr(props, "caption")
      return caption === undefined ? { id: block.id, type: "mermaid", code } : { id: block.id, type: "mermaid", code, caption }
    }
    case "view": {
      const ref = propStr(props, "ref") ?? ""
      const kind = propStr(props, "kind")
      return isViewKind(kind)
        ? { id: block.id, type: "view", ref, kind }
        : { id: block.id, type: "view", ref }
    }
    case "toggleListItem": {
      const title = richText(bnContentToRich(block.content))
      const children = block.children === undefined ? undefined : bnBlocksToOurFull(block.children)
      return children === undefined
        ? { id: block.id, type: "toggle", title }
        : { id: block.id, type: "toggle", title, children }
    }
    default:
      return undefined
  }
}

/** 读 issueRef/docRef 的 ref + preview（从 bnBBlockToOur 拆出以压低圈复杂度）。 */
function readRefBlock(
  id: string,
  type: "issueRef" | "docRef",
  props: Record<string, unknown>,
): OurBlock {
  const ref = propStr(props, "ref") ?? ""
  const preview = propBool(props, "preview")
  return preview === undefined ? { id, type, ref } : { id, type, ref, preview }
}

/** view.kind 是否合法词表（list/table/board）。 */
function isViewKind(kind: string | undefined): kind is "list" | "table" | "board" {
  return kind === "list" || kind === "table" || kind === "board"
}

/**
 * BN 块数组 → 我们侧 14 种块数组。连续 A 档块委托 U-2a `bnBlocksToOur`（保留列表折叠），
 * B 档块逐个读回；toggle children 递归。
 * @param blocks - BN 块序列。
 * @returns 我们侧块序列。
 */
export function bnBlocksToOurFull(blocks: readonly BnLooseBlock[]): OurBlock[] {
  const out: OurBlock[] = []
  let aRun: BnLooseBlock[] = []
  const flush = () => {
    if (aRun.length === 0) return
    out.push(...bnBlocksToOur(aRun as never))
    aRun = []
  }
  for (const block of blocks) {
    if (BN_B_TYPES.has(block.type)) {
      flush()
      const one = bnBBlockToOur(block)
      if (one !== undefined) out.push(one)
    } else {
      aRun.push(block)
    }
  }
  flush()
  return out
}

/**
 * 用完整 14 块 schema boot 一个 headless 编辑器（不 mount、无 UI chrome）。
 * create/document 两处各一次边界断言：运行期 14 块，编译期具名 schema（理由见文件头）。
 * @param blocks - 我们侧 14 种块序列。
 * @returns 未挂载的 BlockNote 编辑器实例。
 */
export function bootFullEditor(blocks: readonly OurBlock[]): BnEditor {
  const initialContent = blocks.flatMap(ourBlockToBnFull)
  return BlockNoteEditor.create({ schema: fullBlockNoteSchema, initialContent: initialContent as never })
}

/**
 * 一次完整的 14 块往返：our → BN full schema → headless editor → BN → our。
 * @param blocks - 输入我们侧块序列。
 * @returns 经 BlockNote 文档模型往返后的我们侧块序列。
 */
export function roundTripFullBlocks(blocks: readonly OurBlock[]): OurBlock[] {
  const editor = bootFullEditor(blocks)
  return bnBlocksToOurFull(editor.document as never)
}

/**
 * 便于测试/调用方判 A 档（再导出 U-2a 的守卫语义，不新增真相源）。
 * @param block - 待判块。
 * @returns 是 A 档时收窄到 OurABlock。
 */
export function isOurA(block: OurBlock): block is OurABlock {
  return !isBBlock(block)
}
