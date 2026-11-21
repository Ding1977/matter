/**
 * `@matter/client-ui-model` —— 模型选择器最小座席（ISS-543 / P4-M1，client 第五包收官）。
 *
 * 数据面走 ctx 注入的 stub 模型目录（llm 域真实目录是 P5+ 的事，本单不建后端）；
 * UI 经 client 半导出，由挂载方（测试 / P4 shell）自己装配目录与文案。
 * 不 import 兄弟 UI 包（feature 插件互不 import），host 半空注册照旧。
 *
 * 双面结构照 ui-pm：包根 tsconfig 是 solution（host + client 两半）；host 半是空注册插件
 * 入口，client 半是 contract/panel/apply 三层（panel 含两级面板 list + detail）。
 *
 * @module @matter/client-ui-model
 */

import type { Context } from "@deepseek-ai/cordis"

/** Cordis 插件名。 */
export const name = "client-ui-model"

/**
 * 空注册的插件入口（本单最小形态）：本包 UI 组件经 client 半导出，
 * 由挂载方自己注入 stub 目录与文案；插件本身不建 store、不启服务。
 * @param _ctx - 插件上下文（当前未使用）。
 */
export function apply(_ctx: Context): void {
  // 有意留空：模型目录与文案走 ctx/prop 注入，装配发生在调用侧。
}
