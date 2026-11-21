/**
 * 桥接层 ↔ 官方原件 token 契约 parity（ISS-931 复审追加，Lead 拍板必做）。
 *
 * 判据逻辑在零依赖的 `bridge-parity.check.mjs`（可用 `node ... --check` 以 selftest
 * 形态跑，退出码 0/1）；本文件只是同一逻辑的 vitest 包装，分三组断言便于定位。
 *
 * 防复发背景：官方把部分 token 定义成 `var(...)` 转发，桥接若写死数值就是「伪装的裸值」
 * ——切断转发链，官方调档时不跟着动。2026-11-21 designer 复审实测到
 * `--dsl-search-radius`（官方 var(--dsw-radius-lg)=16px，桥接 4px）与
 * `--dsl-search-line-height`（官方 22px，桥接 8px）两条漂移。
 *
 * 运行：`bun test --isolate packages/client/ui-theme/tests/bridge-parity.test.ts`
 *
 * @module @matter/client-ui-theme/tests/bridge-parity
 */

import { describe, expect, it } from "vitest"
import { checkParity } from "./bridge-parity.check.mjs"

const result = checkParity()

describe("官方 var() 转发项：桥接侧也必须 var()（伪装裸值判据）", () => {
  it("官方全部 var() 契约在桥接侧仍是 var()，且桥接侧有定义（零数值手抄、零删项假绿）", () => {
    expect(result.counts.varForward, "fixture 应含官方实扫的 var() 契约").toBeGreaterThan(0)
    expect(result.varForward, "这些项把官方 var() 转发写死成数值或从桥接侧缺失").toEqual([])
  })

  it("点名回归：--dsl-search-radius 解析 16px（不是 4px）", () => {
    // 钉死解析值，防止「写成另一个 var 但解析错档」。
    expect(result.resolved["--dsl-search-radius"]).toBe("16px")
  })
})

describe("--dsw-static-* 调色板：桥接值 === 官方包值（禁手抄）", () => {
  it("桥接侧所有官方调色板项逐条等值", () => {
    expect(result.counts.staticOverlap, "桥接侧应消费官方调色板（否则本判据空转）").toBeGreaterThan(0)
    expect(result.staticPalette, "这些调色板值与官方包不一致（手抄漂移）").toEqual([])
  })
})

describe("designer 点名的字面量漂移", () => {
  it("--dsl-search-line-height 解析到官方 22px（曾手抄成 8px）", () => {
    expect(result.counts.flagged).toBeGreaterThan(0)
    expect(result.flaggedLiteral, "点名字面量项解析值与官方不一致").toEqual([])
    expect(result.resolved["--dsl-search-line-height"]).toBe("22px")
  })
})

describe("六档圆角 parity（reviewer mutation 洞）", () => {
  it("六档解析值 = 官方 4/8/12/16/20/28，两两不同，且违规零条", () => {
    expect(result.counts.radius).toBe(6)
    expect(result.radius, "圆角档漂移或重档").toEqual([])
    expect(result.resolvedRadii).toEqual(["4px", "8px", "12px", "16px", "20px", "28px"])
    expect(new Set(result.resolvedRadii).size).toBe(6)
  })
})
