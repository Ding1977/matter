/**
 * `@matter/client-ui-theme` —— Matter 前端的设计 token 底座（ISS-530 / P3-U1）。
 *
 * 新树第一个 client（前端）包。三件东西：
 *
 * | 件 | 在哪 | 谁消费 |
 * |---|---|---|
 * | 两层 token CSS（static 原子 + alias 语义） | `src/client/theme.css` | 组件样式 `var(--matter-alias-*)` |
 * | 注入钩子 `installThemeStyles` | `src/client/styles.ts` | 拥有 DOM 的挂载方（P3：测试；P4：web shell） |
 * | 类型化 token 注册表 `THEME_TOKENS` | `src/tokens.ts` | 文档 / 校验工具 / 后续主题设置面 |
 *
 * ## 双面结构与 DSH 同构、与既有 9 包不同
 *
 * 包根 `tsconfig.json` 是 solution 文件（files 空 + 两个 references）：
 * `tsconfig.host.json`（extends `tsconfig.base.emit.json`，node 环境，编 `src/index.ts`）
 * 与 `tsconfig.client.json`（extends `tsconfig.base.client.emit.json`，DOM lib + jsx，
 * 只编 `src/client/**`，独立 tsbuildinfo）。两侧产物都落 `lib/types/`；
 * host 入口由 tsdown 打成 `lib/index.js`（与既有包同管线），client 半留 tsc emit
 * 给 Vite/vitest 消费（P3 无 web shell，无 clientBundle 打包面）。
 *
 * ## host 半的 apply 是空注册（P3 最小形态）
 *
 * 单正文：P3 无 shell ⇒ 注入插件先以「导出 CSS + host 半注册」最小形态落地。
 * host 半不注册任何服务、不碰 DOM —— 它存在是让包以 cordis 插件形态可加载，
 * 真正的注入时机由调用方拿 `installThemeStyles` 自己决定。
 *
 * @module @matter/client-ui-theme
 */

import type { Context } from "@deepseek-ai/cordis"

export { THEME_TOKENS } from "./tokens.ts"
export type { ThemeToken, TokenValueType } from "./tokens.ts"

/**
 * 空注册的插件入口（P3 最小形态）。
 *
 * 加载本包不产生副作用：不注册服务键、不注入样式。token 注册表经主入口导出，
 * 样式注入由调用方经 `@matter/client-ui-theme/client` 的 `installThemeStyles` 显式触发。
 *
 * @param ctx - 插件上下文（当前未使用；U 线后续接 Config / 主题服务时在此展开）。
 * @returns 无。
 */
export function apply(_ctx: Context): void {
  // 有意留空：见模块注释「host 半的 apply 是空注册」。
}
