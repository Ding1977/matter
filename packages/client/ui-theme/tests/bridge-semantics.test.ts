/**
 * dsw-bridge 语义映射实证（ISS-544 / P5-D1 验收 4）。
 *
 * 钉死两件事，均为「可红」判据：
 *  1. 69 条 `--dsw-alias-*` 全部写成 `var(--matter-alias-*)`，无字面 hex（语义映射）；
 *  2. 改一处 matter-alias 的指向 → dsw 消费面解析色同步变（单点生效）——
 *     用纯函数解析 static→alias→dsw 的 var 链，对比改前/改后的解析值。
 *
 * 读真文件（fs，不经 Vite 管线）：vitest css:false 会把 css 内容 stub 成空串，
 * 对账要的是文件真相 —— 与 tokens.test.ts / dsw-bridge.test.ts 同款口径。
 *
 * @module @matter/client-ui-theme/tests/bridge-semantics
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/** theme.css 全文（static + alias 两层定义）。 */
const themeCss = readFileSync(new URL("../src/client/theme.css", import.meta.url), "utf8")
/** dsw-bridge.css 全文（桥接层定义）。 */
const bridgeCss = readFileSync(new URL("../src/client/dsw-bridge.css", import.meta.url), "utf8")

/** 从 CSS 全文抽变量定义：`--x: value;` → Map<name, value>。 */
function definitions(css: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  return out
}

const themeDefs = definitions(themeCss)
const bridgeDefs = definitions(bridgeCss)

/** 把 `var(--x)` 链解析成终结字面值（防止环，深度上限 16）。 */
function resolve(name: string, defs: Map<string, string>, depth = 0): string | undefined {
  if (depth > 16) return undefined
  const value = defs.get(name)
  if (value === undefined) return undefined
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(value)
  return m === null ? value : resolve(m[1], defs, depth + 1)
}

/** 合并两层定义（dsw 引用 matter，两层合看才能解析到终结值）。 */
const allDefs = new Map([...themeDefs, ...bridgeDefs])

describe("dsw-alias 语义映射（无字面 hex）", () => {
  it("全部 69 条 --dsw-alias-* 写成 var(--matter-alias-*)，无 hex 字面量", () => {
    const aliasDefs = [...bridgeDefs.entries()].filter(([name]) => name.startsWith("--dsw-alias-"))
    expect(aliasDefs.length, "桥接层应有 69 条 --dsw-alias-*").toBeGreaterThanOrEqual(69)
    const hexAliases = aliasDefs.filter(([, value]) => /^#[0-9a-fA-F]{3,8}$/.test(value))
    expect(hexAliases.map(([n]) => n), "这些 dsw-alias 仍是字面 hex").toEqual([])
    const nonMatter = aliasDefs.filter(([, value]) => !/^var\(--matter-alias-/.test(value))
    expect(nonMatter.map(([n]) => n), "这些 dsw-alias 未挂 matter-alias 语义层").toEqual([])
  })
})

describe("改色单点生效（改一处 matter-alias，dsw 消费面同步变色）", () => {
  it("label-primary 经 text-primary → static black；改 static black 即改 dsw 解析色", () => {
    // ISS-931 必修5：主文字必须是近黑正文色，不是 accent 蓝。
    // 链：--dsw-alias-label-primary → var(--matter-alias-text-primary) → var(--matter-static-color-black) → #1a1c20
    expect(bridgeDefs.get("--dsw-alias-label-primary")).toBe("var(--matter-alias-text-primary)")
    expect(themeDefs.get("--matter-alias-text-primary")).toBe("var(--matter-static-color-black)")
    const before = resolve("--dsw-alias-label-primary", allDefs)
    expect(before?.toLowerCase()).toBe("#1a1c20")
    expect(before?.toLowerCase()).not.toBe("#3d6df2")

    // 改一处 static（单点）：把 black 指向新原子色，alias 与 dsw 均不改。
    const changedDefs = new Map(allDefs)
    changedDefs.set("--matter-static-color-black", "#123456")
    const after = resolve("--dsw-alias-label-primary", changedDefs)
    expect(after?.toLowerCase()).toBe("#123456")
    expect(after).not.toBe(before)
  })

  it("ISS-931 必修4：--dsw-radius-* 六档解析成 4/8/12/16/20/28，不再是清一色 4px", () => {
    const expected: Record<string, string> = {
      "--dsw-radius-xs": "4px",
      "--dsw-radius-sm": "8px",
      "--dsw-radius-md": "12px",
      "--dsw-radius-lg": "16px",
      "--dsw-radius-xl": "20px",
      "--dsw-radius-panel": "28px",
    }
    for (const [name, px] of Object.entries(expected)) {
      expect(/^var\(--matter-alias-radius-/.test(bridgeDefs.get(name) ?? ""), `${name} 必须挂 matter alias 而非裸值`).toBe(true)
      expect(resolve(name, allDefs), `${name} 解析值`).toBe(px)
    }
    const values = Object.values(expected)
    expect(new Set(values).size, "六档必须是六个不同的梯度值").toBe(6)
  })

  it("ISS-931 待爆弹：warn 挂 warn / idle 挂弱化主文字 / 遮罩不模糊 / 界面字体非等宽", () => {
    // warn 族挂 warn 语义（琥珀），不再挂 danger 红。
    expect(bridgeDefs.get("--dsw-alias-state-warn-primary")).toBe("var(--matter-alias-warn)")
    expect(bridgeDefs.get("--dsw-alias-state-warn-label")).toBe("var(--matter-alias-warn)")
    expect(bridgeDefs.get("--dsw-alias-state-warn-tertiary")).toBe("var(--matter-alias-warn)")
    expect(resolve("--dsw-alias-state-warn-primary", allDefs)?.toLowerCase()).not.toBe(
      resolve("--matter-alias-danger", allDefs)?.toLowerCase(),
    )
    // idle 挂弱化主文字，不再挂 accent 蓝。
    expect(bridgeDefs.get("--dsw-alias-state-idle-primary")).toBe("var(--matter-alias-text-muted)")
    // 遮罩不模糊。
    expect(bridgeDefs.get("--dsw-mask-blur")).toBe("none")
    expect(bridgeDefs.get("--dsw-menu-backdrop-filter")).toBe("none")
    // 界面字体族走 Matter static，不写具体族名。
    expect(bridgeDefs.get("--dsw-font-family")).toBe("var(--matter-static-font-family-ui)")
    expect(resolve("--dsw-font-family", allDefs)).toContain("system-ui")
    // secondary 落 13px 档。
    expect(bridgeDefs.get("--dsh-content-font-size-secondary")).toBe("var(--matter-alias-font-size-secondary)")
    expect(resolve("--dsh-content-font-size-secondary", allDefs)).toBe("13px")
  })

  it("elevation / focus-ring / overlay-top 消费面均挂 matter alias", () => {
    expect(bridgeDefs.get("--dsw-elevation-panel")).toBe("var(--matter-alias-elevation-panel)")
    expect(bridgeDefs.get("--dsw-focus-ring-color")).toBe("var(--matter-alias-focus-ring-color)")
    expect(bridgeDefs.get("--dsw-focus-ring-width")).toBe("var(--matter-alias-focus-ring-width)")
    expect(bridgeDefs.get("--dsh-frame-overlay-top")).toBe("var(--matter-alias-overlay-top)")
    // 三者都能解析到终结值（无悬空 var）。
    for (const name of ["--dsw-elevation-panel", "--dsw-focus-ring-color", "--dsw-focus-ring-width", "--dsh-frame-overlay-top"]) {
      expect(resolve(name, allDefs), `${name} 解析到终结值`).toBeDefined()
    }
  })
})
