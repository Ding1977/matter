/**
 * Headless 编辑器 boot 与块往返（ISS-531 / P3-U2a）。
 *
 * 施工图定案的 headless 形态（数据面）：用 `BlockNoteEditor.create({ schema, initialContent })`
 * 直接 boot，**不 mount、不建 view**——编辑器文档模型在纯 JS 下可用（jsdom 或 node 均可），
 * round-trip 只读写 `editor.document`，不需要 ProseMirror DOM。展示面（BlockNoteViewRaw）在
 * `src/client/mapping/view.tsx`，本文件不引用它、不 import React。
 *
 * 往返链：our blocks → ourBlockToBn（BN PartialBlock[]）→ initialContent boot → 读 editor.document
 * （BN Block[]）→ bnBlocksToOur → our blocks，逐字段断言在 spec 里。
 *
 * @module @matter/client-ui-blocks/client/mapping/editor
 */

import { BlockNoteEditor } from "@blocknote/core"
import type { OurABlock } from "../contract/types.ts"
import { bnBlocksToOur, ourBlockToBn } from "./blocks.ts"
import { blockNoteSchema } from "./schema.ts"
import type { BnEditor, BnPartialBlock } from "./schema.ts"

/**
 * 用我们侧块 boot 一个 headless BlockNote 编辑器（不 mount、无 UI chrome）。
 * @param blocks - 我们侧 A 档块序列（会被映射成 BN initialContent）。
 * @returns 未挂载的 BlockNote 编辑器实例（document 可读写）。
 */
export function bootHeadlessEditor(blocks: readonly OurABlock[]): BnEditor {
  const initialContent: BnPartialBlock[] = blocks.flatMap(ourBlockToBn)
  return BlockNoteEditor.create({ schema: blockNoteSchema, initialContent })
}

/**
 * 一次完整的块往返：our → BN → headless editor → BN → our。
 * @param blocks - 输入我们侧块序列。
 * @returns 经 BlockNote 文档模型往返后的我们侧块序列。
 */
export function roundTripBlocks(blocks: readonly OurABlock[]): OurABlock[] {
  const editor = bootHeadlessEditor(blocks)
  return bnBlocksToOur(editor.document)
}
