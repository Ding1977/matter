/**
 * 主题样式的注入钩子 —— `@matter/client-ui-theme` 的 client 半核心（ISS-530 / P3-U1）。
 *
 * 形态照 DSH `packages/client/ui-theme/src/client/styles.ts`（64 行参照）：
 * CSS 经 `?inline` import 成字符串，`ctx.effect()` 建 `<style>` 标签挂 `document.head`，
 * 返回的 disposer 负责摘除 —— 注册即副作用、注销即清理，与仓内
 * 「每个贡献经 ctx.effect()，注册表方法返回 disposer」的约定同构。
 *
 * ## 为什么是函数、不是插件 apply
 *
 * 注入时机由**拥有 DOM 的调用方**决定（P3 里是测试；P4 里是 web shell 的挂载点），
 * 不随包加载自动发生。包的 host 半 apply 是空注册（见 `src/index.ts`），
 * 两侧职责分开：host 半 = 数据与插件形态，client 半 = DOM 注入。
 *
 * ## 幂等性说明（故意不在这里做去重）
 *
 * 重复调用会注入第二个同属性 `<style>` 标签。去重是调用方的装配责任
 * （谁挂载谁保证只装一次），不是本函数的责任 —— 在这里静默去重会把
 * 「装了两次」这个装配错误藏起来。
 *
 * @module @matter/client-ui-theme/client/styles
 */

import type { Context } from "@deepseek-ai/cordis"
import themeCss from "./theme.css?inline"

/** 注入的 `<style>` 标签上的归属属性值（data-plugin），用于定位与排查。 */
export const THEME_STYLE_PLUGIN_ID = "client-ui-theme"

/**
 * 把主题 token 样式表注入当前 document。
 *
 * 立即生效：本函数返回时 `<style data-plugin="client-ui-theme" data-plugin-css="theme">`
 * 已在 `document.head`，内容为两层 token（static + alias）的 CSS 全文。
 *
 * @param ctx - 调用方的 cordis 上下文；effect 随该 fiber 注销时自动摘除样式标签。
 * @returns disposer：调用即摘除已注入的样式标签（也随 ctx 所属 fiber 卸载自动触发）。
 */
export function installThemeStyles(ctx: Context): () => Promise<void> {
  return ctx.effect(() => {
    const style = document.createElement("style")
    style.setAttribute("data-plugin", THEME_STYLE_PLUGIN_ID)
    style.setAttribute("data-plugin-css", "theme")
    style.textContent = themeCss
    document.head.append(style)
    return () => {
      style.remove()
    }
  }, "client-ui-theme: install theme styles")
}
