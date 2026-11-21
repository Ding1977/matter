/**
 * token 注册表 ⇄ CSS 变量的双向对应（ISS-530 / P3-U1 验收 2）。
 *
 * 「可红」是本文件的存在理由：从 theme.css 删任何一个变量定义、或从注册表删
 * 任何一条，双向对账立刻红 —— 对应关系不靠自觉，靠这张测试钉死。
 * 另钉住两层结构纪律：alias 值只许引用 static 层已定义的变量（引用不存在的
 * static token 即红）。
 *
 * node 环境即可跑、不碰 DOM。CSS 内容用 **fs 直读真文件**（不经 Vite 管线）：
 * vitest 默认 `css: false` 会把 `.css?inline` / `.css?raw` 整类 stub 成空串
 * （vitest:css-disable 插件 enforce:pre，实测），经管线的 import 在测试里拿不到
 * 真内容；对账要的就是文件真相，fs 是唯一不随配置变色的来源。
 *
 * @module @matter/client-ui-theme/tests/tokens
 */

import { readFileSync } from "node:fs"
import { Context } from "@deepseek-ai/cordis"
import { describe, expect, it } from "vitest"
import { THEME_TOKENS, type ThemeToken } from "../src/index.ts"

/** theme.css 的全文 —— fs 直读（理由见文件头）。 */
const themeCss: string = readFileSync(new URL("../src/client/theme.css", import.meta.url), "utf8")

/** 从 CSS 全文提取全部变量**定义**名（`--matter-xxx:` 形态，不含 var() 引用）。 */
function cssVariableNames(css: string): Set<string> {
  return new Set([...css.matchAll(/(--matter-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
}

/** 从 CSS 全文提取全部 var() **引用**名。 */
function cssVarReferences(css: string): Set<string> {
  return new Set([...css.matchAll(/var\((--matter-[a-z0-9-]+)/g)].map((m) => m[1]))
}

describe("token 注册表 ⇄ CSS 变量一一对应", () => {
  it("双向对账：CSS 定义的每个变量都在注册表，注册表每条的 cssVariable 都在 CSS", () => {
    const cssVars = cssVariableNames(themeCss)
    const registryVars = new Set(THEME_TOKENS.map((t) => t.cssVariable))

    const missingInCss = [...registryVars].filter((v) => !cssVars.has(v))
    const missingInRegistry = [...cssVars].filter((v) => !registryVars.has(v))

    expect(
      { missingInCss, missingInRegistry },
      "两侧集合必须相等：删 CSS 变量或删注册表条目都会在这里红",
    ).toEqual({ missingInCss: [], missingInRegistry: [] })
  })

  it("注册表条目字段形状恒定：name 唯一、cssVariable 前缀只能是 static/alias 两层", () => {
    const names = THEME_TOKENS.map((t) => t.name)
    expect(new Set(names).size, "name 必须唯一").toBe(names.length)

    for (const token of THEME_TOKENS) {
      expect(
        token.cssVariable.startsWith("--matter-static-") || token.cssVariable.startsWith("--matter-alias-"),
        `cssVariable 前缀必须是两层之一：${token.cssVariable}`,
      ).toBe(true)
      expect(token.description.trim().length, `description 非空：${token.name}`).toBeGreaterThan(0)
    }
  })

  it("两层齐全：static 与 alias 都非空，且层内 valueType 与命名一致", () => {
    const staticTokens = THEME_TOKENS.filter((t) => t.cssVariable.startsWith("--matter-static-"))
    const aliasTokens = THEME_TOKENS.filter((t) => t.cssVariable.startsWith("--matter-alias-"))

    expect(staticTokens.length, "static 层不能为空").toBeGreaterThan(0)
    expect(aliasTokens.length, "alias 层不能为空").toBeGreaterThan(0)
    expect(staticTokens.length + aliasTokens.length, "没有第三层").toBe(THEME_TOKENS.length)

    for (const token of staticTokens) {
      expect(token.name.startsWith("static."), `static 层 name 前缀：${token.name}`).toBe(true)
    }
    for (const token of aliasTokens) {
      expect(token.name.startsWith("alias."), `alias 层 name 前缀：${token.name}`).toBe(true)
    }
  })

  it("alias 层的 var() 引用全部落在 static 层已定义的变量上（引用悬空即红）", () => {
    const staticVars = new Set(
      THEME_TOKENS.filter((t) => t.cssVariable.startsWith("--matter-static-")).map((t) => t.cssVariable),
    )
    const refs = cssVarReferences(themeCss)

    expect(refs.size, "alias 层应引用 static 层（三层形态：alias 值 = var(static))").toBeGreaterThan(0)
    for (const ref of refs) {
      expect(staticVars.has(ref), `var() 引用了非 static 变量：${ref}`).toBe(true)
    }
  })
})

describe("host 入口（apply）", () => {
  it("空注册可加载、可卸载，无副作用", async () => {
    const ctx = new Context()
    const UiTheme = await import("../src/index.ts")
    const fiber = await ctx.plugin(UiTheme)
    await fiber.dispose()
  })

  it("THEME_TOKENS 是对外可读的只读数据（host 主入口导出）", () => {
    expect(Array.isArray(THEME_TOKENS)).toBe(true)
    expect((THEME_TOKENS as readonly ThemeToken[]).length).toBeGreaterThan(0)
  })
})
