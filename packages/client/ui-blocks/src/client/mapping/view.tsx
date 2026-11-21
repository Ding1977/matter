/**
 * Headless 展示面（ISS-531 / P3-U2a）：基于 `BlockNoteViewRaw` 的无默认 UI 编辑器视图。
 *
 * 施工图 headless 定案的展示面一半：BlockNoteViewRaw 是 @blocknote/react 导出的**无包装**入口，
 * 它本身不渲染 DefaultUI（formattingToolbar / linkToolbar / slashMenu / sideMenu / filePanel /
 * tableHandles / emojiPicker / comments 等默认 UI 全不在树上），因此比
 * `<BlockNoteView ...七开关全关>` 的 headless 形态更硬——后者是「有默认 UI 再逐个关」，
 * 将来 BlockNote 加一个开关忘了关就静默泄漏 chrome；Raw 是「根本没有默认 UI」。
 *
 * 本单只提供「它能从 editor 构造出 ReactElement」的契约；**不渲染、不做视觉断言**（P3 无视觉面，
 * vitest css:false 把 BN 的 style.css stub 成空串，真机渲染属 U-2b）。
 *
 * ## 为什么是工厂函数而不是 `export const HeadlessBlockNoteView = BlockNoteViewRaw`
 *
 * 直接再导出那个泛型组件常量会让 TS 6.0.3 在 *.d.ts emit 时因 symbol-chain 递归栈溢出
 * （实测 RangeError）；工厂函数只暴露 `ReactElement` 这一浅返回类型，BN 的深层泛型留在函数体内，
 * emit 稳定。功能等价：内部调用的仍是同一个 BlockNoteViewRaw。
 *
 * @module @matter/client-ui-blocks/client/mapping/view
 */

import { createElement } from "react"
import { BlockNoteViewRaw } from "@blocknote/react"
import type { ReactElement } from "react"
import type { BnEditor } from "./schema.ts"

/** Headless 视图参数（`editable` 默认 true）。 */
export interface HeadlessViewOptions {
  /** 已由 bootHeadlessEditor 构造的编辑器实例。 */
  readonly editor: BnEditor
  /** 是否可编辑（透传 BlockNoteViewRaw）。 */
  readonly editable?: boolean
  /** 容器 className（透传 BlockNoteViewRaw）。 */
  readonly className?: string
}

/**
 * 用无默认 UI 的 BlockNoteViewRaw 构造编辑器视图元素。
 * 不注入任何 toolbar / menu / panel；children 自定义 UI 由上层挂载方在 P4 自行扩展。
 * @param options - 编辑器实例与可选透传参数。
 * @returns BlockNoteViewRaw 渲染出的 ReactElement（未挂载到 DOM）。
 */
export function createHeadlessView(options: HeadlessViewOptions): ReactElement {
  // BlockNoteViewRaw 的泛型约束是宽 schema（Record<string, BlockConfig>），与本包为稳定 d.ts
  // emit 而固定的具名 Default*Schema 结构不同构（TS2769 / TS2352，实测）。编辑器实例在运行时
  // 就是它接受的形态；这一处显式 any 是渲染边界无法收窄的点（不用 as unknown as，不绕过 strict
  // 对映射主逻辑的检查），代价仅限本函数。
  const props: any = {
    editor: options.editor,
    editable: options.editable ?? true,
    className: options.className,
  }
  return createElement(BlockNoteViewRaw, props)
}
