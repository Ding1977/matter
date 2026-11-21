// @vitest-environment jsdom
/**
 * Q3 · P3 缺口① css 内容流闭环（ISS-538 / P4-S2 验收 A3）。
 *
 * P3 缺口①（U-1 实测）：vitest 默认 `css:false` 把 `.css?inline` 整类 stub 成空串 ——
 * 「CSS 内容流」无从断言。本单 vitest.config 放行 `/@blocknote/`，两条 `?inline` 拿到真 CSS。
 *
 * 断言升级（对照 P3 的「内容对账靠 fs 读真文件」间接法）：
 *   ① `?inline` 导出长度 > 0 且含 `.bn-` 标记（真 CSS，非空串）；
 *   ② 注入后 document.styleSheets 的 CSSRule 数 > 0（浏览器可解析的真样式）；
 *   ③ style 标签 textContent 与 `?inline` 导出逐字相等（装配不加工、不截断）。
 *
 * @module apps/web/tests/content-flow
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  BN_CORE_STYLE_ID,
  BN_REACT_STYLE_ID,
  blockNoteCoreCss,
  blockNoteReactCss,
  installEditorStyles,
} from "../src/editor-css.ts"

/** 每个用例后清 head，避免跨用例残留 style / styleSheets 读数。 */
afterEach(() => {
  document.head.innerHTML = ""
})

describe("Q3 · BlockNote CSS 内容流（P3 缺口①销账）", () => {
  it("?inline 拿到真 CSS：core/react 非空串且含 .bn- 标记", () => {
    // 升级前（css:false stub）：length === 0、不含 .bn- —— 本断言会红。
    expect(blockNoteCoreCss.length).toBeGreaterThan(1000)
    expect(blockNoteReactCss.length).toBeGreaterThan(1000)
    expect(blockNoteCoreCss).toContain(".bn-")
    expect(blockNoteCoreCss).toContain(".bn-block")
    expect(blockNoteReactCss).toContain(".bn-")
  })

  it("installEditorStyles 注入两条归属明确的 style，内容与 ?inline 逐字相等", () => {
    const dispose = installEditorStyles()
    const core = document.head.querySelector(`style[data-plugin='${BN_CORE_STYLE_ID}']`)
    const react = document.head.querySelector(`style[data-plugin='${BN_REACT_STYLE_ID}']`)
    expect(core).not.toBeNull()
    expect(react).not.toBeNull()
    expect(core?.textContent).toBe(blockNoteCoreCss)
    expect(react?.textContent).toBe(blockNoteReactCss)
    dispose()
  })

  it("注入后 CSSRule 数 > 0（内容流是浏览器可解析的真样式）", () => {
    const dispose = installEditorStyles()
    const core = document.head.querySelector(`style[data-plugin='${BN_CORE_STYLE_ID}']`) as HTMLStyleElement
    const react = document.head.querySelector(`style[data-plugin='${BN_REACT_STYLE_ID}']`) as HTMLStyleElement
    const coreRules = core.sheet?.cssRules?.length ?? 0
    const reactRules = react.sheet?.cssRules?.length ?? 0
    expect(coreRules).toBeGreaterThan(0)
    expect(reactRules).toBeGreaterThan(0)
    dispose()
  })

  it("disposer 摘除两条 style", () => {
    const dispose = installEditorStyles()
    expect(document.head.querySelector(`style[data-plugin='${BN_CORE_STYLE_ID}']`)).not.toBeNull()
    dispose()
    expect(document.head.querySelector(`style[data-plugin='${BN_CORE_STYLE_ID}']`)).toBeNull()
    expect(document.head.querySelector(`style[data-plugin='${BN_REACT_STYLE_ID}']`)).toBeNull()
  })
})
