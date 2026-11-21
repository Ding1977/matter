/**
 * DSH 原件 token 桥接层的注入钩子（ISS-534 / P4-0）。
 *
 * 与 `styles.ts`（U-1 的 21 个 --matter-* token）分离：本钩子注入
 * `dsw-bridge.css` —— 原件库 lib 下全部 .css 实扫 164 个 var 名的 Matter 侧定义
 * （桥接形态「甲」：直接定义 --dsw-* 命名，原件零改动即工作）。
 *
 * 为什么不并入 installThemeStyles：U-1 的 theme.css/tokens.ts 被
 * tests/tokens.test.ts 双向钉死（一一对应 + alias 只引用 static）；桥接是加法，
 * 独立文件 + 独立钩子让那套约束与既有消费者一字不改地保持绿。两个钩子各注入
 * 一个 `<style>`，挂载方按需都装（P4 的 web shell 会同时装两者）。
 *
 * 幂等性同 `styles.ts`：故意不在这里去重 —— 装两次是装配错误，去重会藏住它。
 *
 * @module @matter/client-ui-theme/client/dsw-bridge
 */

import type { Context } from "@deepseek-ai/cordis"
import dswBridgeCss from "./dsw-bridge.css?inline"

/** 桥接样式标签的 data-plugin-css 归属值，与 theme 的 "theme" 区分。 */
export const DSW_BRIDGE_CSS_ID = "dsw-bridge"

/**
 * 把 DSH 原件 token 桥接层注入当前 document。
 *
 * 立即生效：返回时 `<style data-plugin="client-ui-theme" data-plugin-css="dsw-bridge">`
 * 已在 `document.head`，内容为 `dsw-bridge.css` 全文（164 个 --dsw-* / --dsh-* 等定义）。
 *
 * @param ctx - 调用方 cordis 上下文；effect 随 fiber 注销自动摘除样式标签。
 * @returns disposer：调用即摘除已注入的样式标签。
 */
export function installDswBridgeStyles(ctx: Context): () => Promise<void> {
  return ctx.effect(() => {
    const style = document.createElement("style")
    style.setAttribute("data-plugin", "client-ui-theme")
    style.setAttribute("data-plugin-css", DSW_BRIDGE_CSS_ID)
    style.textContent = dswBridgeCss
    document.head.append(style)
    return () => {
      style.remove()
    }
  }, "client-ui-theme: install dsw bridge styles")
}
