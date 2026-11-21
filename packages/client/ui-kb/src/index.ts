/**
 * `@matter/client-ui-kb` —— 知识库最小页（ISS-533 / P3-U3，client 组第三包）。
 *
 * W7 落点：ui-blocks 的第一个真实消费者。doc 列表 + 详情渲染正文；
 * 详情经 slot（`blocks.editor.surface`）拿编辑器渲染位，零 import ui-blocks。
 *
 * 双面结构照 ui-theme：包根 tsconfig 是 solution（host + client 两半）。
 * host 半是空注册插件入口；client 半是 contract/list/detail/apply 三层。
 * P3 数据通道是测试内进程直连（vitest boot cordis），不铺 connection/gateway。
 *
 * @module @matter/client-ui-kb
 */

import type { Context } from "@deepseek-ai/cordis"

/** Cordis 插件名。 */
export const name = "client-ui-kb"

/**
 * 空注册的插件入口（P3 最小形态）：本包 UI 组件经 client 半导出，
 * 由挂载方（测试 / P4 shell）自己装配 ctx.slots 与 controller。
 * @param _ctx - 插件上下文（当前未使用）。
 */
export function apply(_ctx: Context): void {
  // 有意留空：P3 无 shell，装配发生在调用侧。
}
