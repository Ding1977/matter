// @vitest-environment jsdom
/**
 * 页壳窄宽行为（ISS-544 审查必修：右栏收缩纪律 + collapsed 落 56）。
 *
 * 审查实测（截图 09）指出两处假绿：
 *   ① `resolveRightWidth` 全仓 0 调用，CSS 无宽度断点 ⇒ 1440→980 右栏恒 300、中栏先破 400、
 *      900px 右栏被裁；「右栏收缩优先于中栏破最小宽」没接上。
 *   ② 内联 `--page-shell-sidebar-w:280px` 覆盖 `[data-side=collapsed]` 的 56 ⇒ collapsed 恒无效。
 *
 * 本测试是判红证据：修复前 resolveShellLayout/宽驱动组件不存在 ⇒ 红；修复后断言数值行为 ⇒ 绿。
 *
 * @module apps/web/tests/shell-width
 */

import { render } from "@testing-library/react"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import {
  AUTO_COLLAPSE,
  CENTER_MIN,
  DRAWER_BREAKPOINT,
  SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT,
  resolveShellLayout,
  resolveShellSide,
} from "../src/columns.ts"
import { PageShell } from "../src/page-shell.tsx"

/** 三栏和恰等于视口宽（无横向溢出）。 */
const noOverflow = (l: ReturnType<typeof resolveShellLayout>): number =>
  l.sidebarWidth + l.centerWidth + l.rightWidth

describe("resolveShellLayout · 窄宽数值行为（右栏收缩优先于中栏破 400）", () => {
  it("1440：展开侧栏 280，右栏按比例，中栏 >= 400，无溢出", () => {
    const l = resolveShellLayout(1440)
    expect(l.side).toBe("expanded")
    expect(l.sidebarWidth).toBe(SIDEBAR_DEFAULT)
    expect(l.centerWidth).toBeGreaterThanOrEqual(CENTER_MIN)
    expect(l.rightWidth).toBeGreaterThan(0)
    expect(noOverflow(l)).toBe(1440)
    expect(l.overflow).toBe(false)
  })

  it("980：自动收起侧栏=56，三栏和=980，中栏 >= 400，右栏收缩（旧版此处溢出）", () => {
    const l = resolveShellLayout(980)
    expect(l.side).toBe("collapsed")
    expect(l.sidebarWidth).toBe(SIDEBAR_COLLAPSED)
    expect(l.centerWidth).toBeGreaterThanOrEqual(CENTER_MIN)
    expect(noOverflow(l)).toBe(980)
    expect(l.overflow).toBe(false)
  })

  it("900：右栏进一步收缩，中栏仍守 400，三栏和=900（旧版右栏固定 300 在此被裁）", () => {
    const l = resolveShellLayout(900)
    expect(l.side).toBe("collapsed")
    expect(l.centerWidth).toBeGreaterThanOrEqual(CENTER_MIN)
    expect(noOverflow(l)).toBe(900)
    expect(l.overflow).toBe(false)
  })

  it("768：右栏优先收缩到 ceiling，中栏恰守 400（不是中栏先破）", () => {
    const l = resolveShellLayout(768)
    expect(l.side).toBe("collapsed")
    expect(l.centerWidth).toBe(CENTER_MIN)
    expect(l.rightWidth).toBeLessThan(325) // wanted=0.45*712=320.4 → ceiling=712-400=312
    expect(noOverflow(l)).toBe(768)
  })

  it("760（<抽屉断点768）：走抽屉收起，右栏与侧栏让位，中栏吃满", () => {
    const l = resolveShellLayout(DRAWER_BREAKPOINT - 8)
    expect(l.side).toBe("drawer")
    expect(l.rightWidth).toBe(0)
    expect(l.properties).toBe(false)
    expect(l.centerWidth).toBe(DRAWER_BREAKPOINT - 8)
    expect(l.overflow).toBe(false)
  })

  it("断点语义：AUTO_COLLAPSE 以下 collapsed、DRAWER 以下 drawer，以上 expanded", () => {
    expect(resolveShellSide(AUTO_COLLAPSE)).toBe("expanded")
    expect(resolveShellSide(AUTO_COLLAPSE - 1)).toBe("collapsed")
    expect(resolveShellSide(DRAWER_BREAKPOINT)).toBe("collapsed")
    expect(resolveShellSide(DRAWER_BREAKPOINT - 1)).toBe("drawer")
  })
})

describe("PageShell · 宽驱动内联轴（collapsed 真落 56，不再被内联默认覆盖）", () => {
  it("width=900 → data-side=collapsed，内联侧栏宽 56px，右栏非固定 300px", () => {
    const view = render(createElement(PageShell, { width: 900, renderSlot: () => null }))
    const root = view.container.querySelector('[data-shell="page"]') as HTMLElement
    expect(root.getAttribute("data-side")).toBe("collapsed")
    expect(root.getAttribute("data-properties")).toBe("on")
    expect(root.style.getPropertyValue("--page-shell-sidebar-w")).toBe("56px")
    expect(root.style.getPropertyValue("--page-shell-props-w")).not.toBe("300px")
  })

  it("width=1440 → data-side=expanded，内联侧栏宽 280px", () => {
    const view = render(createElement(PageShell, { width: 1440, renderSlot: () => null }))
    const root = view.container.querySelector('[data-shell="page"]') as HTMLElement
    expect(root.getAttribute("data-side")).toBe("expanded")
    expect(root.style.getPropertyValue("--page-shell-sidebar-w")).toBe("280px")
  })

  it("width=760 → 抽屉：data-properties=off，右栏 0px", () => {
    const view = render(createElement(PageShell, { width: 760, renderSlot: () => null }))
    const root = view.container.querySelector('[data-shell="page"]') as HTMLElement
    expect(root.getAttribute("data-properties")).toBe("off")
    expect(root.style.getPropertyValue("--page-shell-props-w")).toBe("0px")
  })
})
