/**
 * ui-kb 的共享契约（layer 0）：doc 行类型 + 编辑器正文渲染位的 slot 声明。
 *
 * ## 跨包纪律（DOC-512 §4.5 / U-0 问2）
 *
 * 「UI crosses packages through slots」——ui-kb 消费 ui-blocks 的编辑器正文渲染位
 * **只经 slot key + 渲染签名**，零 import ui-blocks（连 import type 都不用）：
 * ui-blocks 拥有 `blocks.editor.surface` 的 SlotMap 声明与渲染位占用，
 * 本文件只声明「消费方看到的 key 与调用形状」，不重复 owner 声明（重复声明 =
 * 两个 owner，注册期会冲突）。
 *
 * ## 为什么正文块是最小展示面而不是 OurBlock
 *
 * DocRecord.blocks 是 @matter/blocks 的 28 类型判别联合（重依赖）。详情只渲染
 * 「正文文本」，故契约收敛为 `{ id, type, text }`——装配方（测试 / P4 shell）
 * 把真实 blocks 投影成此形状。ui-kb 不认识块引擎类型，只认 slot 交下来的渲染面。
 *
 * @module @matter/client-ui-kb/client/contract/doc
 */

import type { ReactNode } from "react"

/** 一条文档行（列表展示，不携带 blocks）。 */
export interface DocRow {
  /** 文档 id。 */
  readonly id: string
  /** 文档标题。 */
  readonly title: string
}

/** 正文块的最小展示形态（装配方从 DocRecord.blocks 投影而来）。 */
export interface BodyBlock {
  /** 块 id（渲染 key）。 */
  readonly id: string
  /** 块类型（写进 data 属性，便于断言与样式）。 */
  readonly type: string
  /** 块的纯文本（渲染进 DOM 的正文）。 */
  readonly text: string
}

/** 一条文档详情（标题 + 正文块）。 */
export interface DocDetailRow {
  /** 文档 id。 */
  readonly id: string
  /** 文档标题。 */
  readonly title: string
  /** 正文块数组。 */
  readonly blocks: readonly BodyBlock[]
}

/**
 * 编辑器正文渲染位的 slot key。
 * 逐字等于 ui-blocks 拥有的 `blocks.editor.surface`（domain=blocks / entry=editor /
 * hole=surface）—— 这是跨包唯一的连接点，不是 import。
 */
export const EDITOR_SURFACE_SLOT = "blocks.editor.surface" as const

/** `blocks.editor.surface` 的 owner prop（与 ui-blocks SlotMap 声明同形）。 */
export interface EditorSurfaceOwner {
  /** 编辑器实例标识；注册在 slot 上的组件据此取到真实正文。 */
  readonly editorRef: string
}

/**
 * 正文渲染位调用签名（消费方视角）。
 * 装配方把 renderer 绑定 cordis 的 `ctx.slots.renderSlot`，ui-kb detail 只管调用。
 */
export type SurfaceRenderer = (slot: typeof EDITOR_SURFACE_SLOT, owner: EditorSurfaceOwner) => ReactNode
