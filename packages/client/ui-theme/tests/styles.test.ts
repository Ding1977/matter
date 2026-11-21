// @vitest-environment jsdom
/**
 * `installThemeStyles` 的注入与清理契约（ISS-530 / P3-U1 验收 1）。
 *
 * 首行 pragma 照 DSH client 测试栈形态：shared config 保持 node 环境，
 * 需要 DOM 的 spec 逐文件声明 jsdom —— 零全局配置改动。
 *
 * 断言的就是验收原文：document.head 出现注入的 style 标签、disposer 后消失。
 * 内容侧断言「textContent 与 `?inline` import 逐字相等」（源码契约：把管线给的
 * CSS 原样注入）—— 不在这里断言具体变量名：vitest 默认 `css: false` 会把
 * `.css?inline` 整类 stub 成空串（vitest:css-disable 插件，enforce:pre，实测
 * `?raw` 同样被拦），**内容对账**因此放在 tests/tokens.test.ts 用 fs 读真文件做；
 * 待 vitest 侧为 packages/client 开 css 处理后（另开单，见 README Known Limitations），
 * 此处断言自动获得内容强度。
 *
 * @module @matter/client-ui-theme/tests/styles
 */

import { Context } from "@deepseek-ai/cordis"
import { afterEach, describe, expect, it } from "vitest"
import themeCss from "../src/client/theme.css?inline"
import { installThemeStyles, THEME_STYLE_PLUGIN_ID } from "../src/client/index.ts"

/** cordis fiber 与残留样式标签都各测各收，不留跨用例状态。 */
afterEach(async () => {
  for (const style of document.head.querySelectorAll(`style[data-plugin="${THEME_STYLE_PLUGIN_ID}"]`)) {
    style.remove()
  }
})

describe("installThemeStyles", () => {
  it("注入后 document.head 出现归属明确的 style 标签，内容与 ?inline import 逐字相等", () => {
    const ctx = new Context()
    installThemeStyles(ctx)

    const style = document.head.querySelector(`style[data-plugin="${THEME_STYLE_PLUGIN_ID}"]`)
    expect(style, "style 标签应出现在 document.head").not.toBeNull()
    expect(style?.getAttribute("data-plugin-css")).toBe("theme")
    // 源码契约：注入的就是 ?inline import 拿到的全文，不加工、不截断。
    expect(style?.textContent).toBe(themeCss)
  })

  it("disposer 调用后 style 标签消失", async () => {
    const ctx = new Context()
    const dispose = installThemeStyles(ctx)
    expect(document.head.querySelector(`style[data-plugin="${THEME_STYLE_PLUGIN_ID}"]`)).not.toBeNull()

    await dispose()

    expect(
      document.head.querySelector(`style[data-plugin="${THEME_STYLE_PLUGIN_ID}"]`),
      "disposer 后标签应已摘除",
    ).toBeNull()
  })

  it("随所属 fiber 卸载自动摘除（ctx.effect 的注册即副作用契约）", async () => {
    const ctx = new Context()
    // effect 挂在插件 fiber 的 ctx 上（真实装配形态：装样式的是插件，不是根上下文）。
    const fiber = await ctx.plugin({
      apply: (self: Context) => {
        installThemeStyles(self)
      },
    })
    expect(document.head.querySelector(`style[data-plugin="${THEME_STYLE_PLUGIN_ID}"]`)).not.toBeNull()

    await fiber.dispose()

    expect(
      document.head.querySelector(`style[data-plugin="${THEME_STYLE_PLUGIN_ID}"]`),
      "fiber 卸载应带走 effect 注册的样式标签",
    ).toBeNull()
  })
})
