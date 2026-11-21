/**
 * BlockNote 真样式注入（ISS-538 / P4-S2 · Q3 css 内容流闭环）。
 *
 * P3 缺口①（U-1 实测）：vitest 默认 `css:false` 把 `.css?inline` 整类 stub 成空串 ⇒
 * 「CSS 内容流」无从断言。本单在 vitest.config 放行 `/@blocknote/` 后，两条 `?inline`
 * 导入拿到**真 CSS 全文**（core ≈30KB / react ≈41KB，含 `.bn-*` 规则），由本模块注入
 * `<style>` 标签——浏览器里真编辑器据此正确渲染，jsdom 里可断言内容非空 + CSSRule 数。
 *
 * 两个 install 各恰一次（沿用 ui-theme 的装配幂等口径，去重在装配点）；返回 disposer
 * 供 smoke / 路由切换清理。
 *
 * @module apps/web/src/editor-css
 */

import coreCss from "@blocknote/core/style.css?inline"
import reactCss from "@blocknote/react/style.css?inline"

/** 两条 CSS 的归属标签（便于断言与排查，不依赖样式表顺序）。 */
export const BN_CORE_STYLE_ID = "blocknote-core"
export const BN_REACT_STYLE_ID = "blocknote-react"

/** `?inline` 拿到的真 CSS 全文（导出供内容流断言复用，不另开真相源）。 */
export const blockNoteCoreCss: string = coreCss
export const blockNoteReactCss: string = reactCss

/**
 * 把 BlockNote core + react 的真 CSS 注入 document.head，各恰一次。
 * @returns disposer（摘除本模块注入的两条 style 标签）。
 */
export function installEditorStyles(): () => void {
  const core = document.createElement("style")
  core.setAttribute("data-plugin", BN_CORE_STYLE_ID)
  core.textContent = coreCss
  const react = document.createElement("style")
  react.setAttribute("data-plugin", BN_REACT_STYLE_ID)
  react.textContent = reactCss
  document.head.append(core, react)
  return () => {
    core.remove()
    react.remove()
  }
}
