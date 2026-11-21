/**
 * S3/S4/S6 静态判据自测（ISS-932）——先用正反例证明会红，再全仓扫对账例外清单。
 *
 * 形态照 DSH radius-styles / color-tokens / elevation-styles 三份 spec 与 ISS-907
 * typography.test.ts：合法集动态读真值源（不写死），每条带必然失败反向对照，
 * 全仓扫与 expected json 用 toEqual 精确相等（多一条少一条行号漂移都红）。
 *
 * @module @matter/client-ui-theme/tests/style-contracts.test
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  aliasNames,
  badColor,
  badRadius,
  cssFindings,
  readConfig,
  scanRepo,
  scriptFindings,
  type StyleConfig,
} from "./style-contracts-scan.ts"

const EXCEPTIONS = new URL("./expected/style-exceptions.json", import.meta.url)
const THEME_CSS = new URL("../src/client/theme.css", import.meta.url)

/** 自测用合法集（真值源现场读）。 */
const cfg: StyleConfig = readConfig()

describe("S3 圆角越档 / 拼错 token", () => {
  it("越档或拼错 token 红，全圆与小细节绿", () => {
    expect(badRadius("border-radius", "14px", cfg)).toBe(true)
    expect(badRadius("border-top-left-radius", "18px", cfg)).toBe(true)
    expect(badRadius("border-radius", "var(--matter-alias-radius-missing)", cfg)).toBe(true)
    expect(badRadius("border-radius", "var(--matter-alias-radius-lg)", cfg)).toBe(false)
    expect(badRadius("border-radius", "50%", cfg)).toBe(false)
    expect(badRadius("border-radius", "999px", cfg)).toBe(false)
    expect(badRadius("border-radius", "2px", cfg)).toBe(false)
    expect(badRadius("border-radius", "4px", cfg)).toBe(false) // 小细节豁免 = S3 判不了「六档全塌 4px」的边界
    expect(badRadius("color", "14px", cfg)).toBe(false) // 非 border-radius 属性不误伤
    expect(badRadius("--local-radius", "14px", cfg)).toBe(false) // 自定义属性定义不误伤
  })

  it("合法集从 theme.css 动态读，删一档即缩小（不写死）", () => {
    const css = readFileSync(THEME_CSS, "utf8")
    const all = aliasNames(css, "radius")
    expect(all.size).toBeGreaterThanOrEqual(6)
    const dropped = aliasNames(css.replace("--matter-alias-radius-lg:", "--matter-alias-radius-REMOVED:"), "radius")
    expect(dropped.has("--matter-alias-radius-lg")).toBe(false)
    expect(dropped.size).toBe(all.size - 1)
    expect(badRadius("border-radius", "var(--matter-alias-radius-lg)", { ...cfg, radiusAliases: dropped })).toBe(true)
  })
})

describe("S4 颜色只用 alias", () => {
  it("hex / 颜色函数 / white|black / static 色板红，alias / 阴影 / mask / alpha-0 绿", () => {
    expect(badColor("color", "var(--matter-static-color-blue-60)")).toBe(true)
    expect(badColor("background", "#fff")).toBe(true)
    expect(badColor("border-color", "rgb(255 255 255 / 0.55)")).toBe(true)
    expect(badColor("color", "white")).toBe(true)
    expect(badColor("color", "oklch(70% 0.1 250)")).toBe(true)
    expect(badColor("color", "var(--matter-alias-text-primary)")).toBe(false)
    expect(badColor("box-shadow", "0 2px 6px rgba(0, 0, 0, 0.12)")).toBe(false)
    expect(badColor("mask-image", "linear-gradient(#000, transparent)")).toBe(false)
    expect(badColor("border-color", "rgba(0, 0, 0, 0)")).toBe(false) // alpha-0
    expect(scriptFindings("const c = 'var(--matter-static-color-blue-60)'", "a.ts")["a.ts:1"]).toBe("--matter-static-color-*")
    expect(scriptFindings("const c = 'var(--matter-alias-accent)'", "a.ts")).toEqual({})
  })
})

describe("S6 阴影描边不配对", () => {
  it("elevation 阴影 + 中性 alias border 同规则红，其它绿", () => {
    const paired = cssFindings(".a { box-shadow: var(--matter-alias-elevation-panel); border: 0.5px solid var(--matter-alias-border-subtle); }", "a.css", cfg)
    expect(Object.keys(paired.s6)).toHaveLength(1)
    const zero = cssFindings(".a { box-shadow: var(--matter-alias-elevation-panel); border: 0; }", "a.css", cfg)
    expect(zero.s6).toEqual({})
    const noShadow = cssFindings(".a { border: 0.5px solid var(--matter-alias-border-subtle); }", "a.css", cfg)
    expect(noShadow.s6).toEqual({})
    // 照 DSH：前缀 pattern 判定；state 色板 border 不在中性前缀内，豁免
    const stateBorder = cssFindings(".a { box-shadow: var(--matter-alias-elevation-panel); border: 1px solid var(--matter-alias-danger); }", "a.css", cfg)
    expect(stateBorder.s6).toEqual({})
    // 前缀命中即红（含拼错的 border alias，DSH 同款保守判定）
    const typoBorder = cssFindings(".a { box-shadow: var(--matter-alias-elevation-panel); border: 0.5px solid var(--matter-alias-border-typo); }", "a.css", cfg)
    expect(Object.keys(typoBorder.s6)).toHaveLength(1)
  })
})

describe("全仓扫 · 例外精确相等", () => {
  it("扫描事实与 expected/style-exceptions.json 精确相等（多一条少一条都红）", () => {
    const expected = JSON.parse(readFileSync(EXCEPTIONS, "utf8")) as Record<"s3" | "s4" | "s6", Record<string, { code: string; reason: string }>>
    const actual = scanRepo(cfg)
    expect(actual.s3).toEqual(Object.fromEntries(Object.entries(expected.s3).map(([k, v]) => [k, v.code])))
    expect(actual.s4).toEqual(Object.fromEntries(Object.entries(expected.s4).map(([k, v]) => [k, v.code])))
    expect(actual.s6).toEqual(Object.fromEntries(Object.entries(expected.s6).map(([k, v]) => [k, v.code])))
  })
})
