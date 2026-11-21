/**
 * `@matter/client-ui-theme` 的 client 半入口（ISS-530 / P3-U1）。
 *
 * 经 `./client` 子路径导出（package.json exports）：注入钩子 `installThemeStyles`
 * 与其归属常量，以及 DSH 原件 token 桥接钩子 `installDswBridgeStyles`（ISS-534 / P4-0）。
 * token 注册表在 host 半（`.` 主入口导出）—— 纯数据无 DOM 依赖，
 * 两侧分工见 `src/index.ts` 的模块注释。
 *
 * @module @matter/client-ui-theme/client
 */

export { installThemeStyles, THEME_STYLE_PLUGIN_ID } from "./styles.ts"
export { installDswBridgeStyles, DSW_BRIDGE_CSS_ID } from "./dsw-bridge.ts"
