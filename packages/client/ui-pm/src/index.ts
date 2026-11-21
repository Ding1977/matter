/**
 * `@matter/client-ui-pm` —— issue 列表骨架（ISS-540 / P4-V2，client 第四包）。
 *
 * 列表骨架消费 `@matter/issue` 的 ViewConfigStore：装配方从 Store 读出 ViewConfig，
 * 连同 issue rows 经 prop 注入 client 半的 `IssueList`。本包不造并行 store，
 * 不 import 兄弟 UI 包（ui-kb / ui-blocks）——跨包 UI 走 prop / slot 注入。
 *
 * 双面结构照 ui-kb：包根 tsconfig 是 solution（host + client 两半）；host 半是空注册插件
 * 入口，client 半是 contract/list/detail/apply 三层。
 *
 * @module @matter/client-ui-pm
 */

import type { Context } from "@deepseek-ai/cordis"

/** Cordis 插件名。 */
export const name = "client-ui-pm"

/**
 * 空注册的插件入口（P4 骨架最小形态）：本包 UI 组件经 client 半导出，
 * 由挂载方（测试 / P4 shell）自己装配 props 与 ViewConfigStore。
 * @param _ctx - 插件上下文（当前未使用）。
 */
export function apply(_ctx: Context): void {
  // 有意留空：视图配置与 issue rows 走 prop 注入，装配发生在调用侧。
}
