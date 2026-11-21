/**
 * 页壳三件套（ISS-544 / P5-D1；ISS-544 审查必修：宽度行为真接线）：
 * 常驻骨架 + renderSlot 注入 + 共享宽度轴。
 *
 * 照 DSH `ui-conversation` skeleton 形态学（`specs/dsh-design-survey.md:84-108`）：
 *   · 根是常驻骨架，三种槽（sidebar / content / properties）由 `renderSlot` 按 key 注入；
 *   · 相位/侧别/属性栏开合走 data-*（`data-side` / `data-properties`）；
 *   · 三栏宽度轴由 columns.ts 的 {@link resolveShellLayout} 现算后发布成 CSS 自定义属性。
 *
 * 审查必修（截图 09）：旧版内联写死 `--page-shell-sidebar-w:280px` 覆盖了 collapsed 的
 * CSS 类规则（56 恒无效），右栏固定 300、中栏先破底。本版以**单一布局解析**为准：
 * 宽度、侧别、属性栏开合全部由 `resolveShellLayout(width)` 派生，内联发布现算值，
 * CSS 只消费轴、不再用类规则覆写宽度 ⇒ collapsed 真落 56、右栏收缩先于中栏破 400。
 *
 * @module apps/web/src/page-shell
 */

import { createElement } from "react"
import type { CSSProperties, FC, ReactNode } from "react"
import clsx from "clsx"
import { resolveShellLayout, type ShellSide } from "./columns.ts"
import css from "./page-shell.module.css"

/** 页壳可注入的三个具名槽。 */
export type ShellSlot = "shell.sidebar" | "shell.content" | "shell.properties"

export type { ShellSide }

/** renderSlot 的上下文：把宽度轴与当前相位透给槽的占用方。 */
export interface ShellSlotContext {
  /** 侧栏当前形态（含 drawer）。 */
  readonly side: ShellSide
  /** 属性栏是否打开。 */
  readonly properties: boolean
}

/** 页壳入参。 */
export interface PageShellProps {
  /** 按 key 注入槽内容；返回 null/省略表示该槽空。 */
  readonly renderSlot: (slot: ShellSlot, ctx: ShellSlotContext) => ReactNode
  /**
   * 视口宽（px）。真机由 window.innerWidth 注入；测试显式传入以断言窄宽行为。
   * 省略时按 1440（桌面默认）解析。
   */
  readonly width?: number
  /** 覆盖解析出的侧别（一般不需要；保留给装配层强制态）。 */
  readonly side?: ShellSide
  /** 覆盖解析出的属性栏开合（一般不需要）。 */
  readonly properties?: boolean
  /** 调用方附加 className（clsx 后置，支持覆盖）。 */
  readonly className?: string
}

/** 默认视口宽（无真实测量时的桌面基准）。 */
export const DEFAULT_SHELL_WIDTH = 1440

/**
 * 常驻三栏骨架：宽度/侧别/开合全部由 resolveShellLayout 现算并发布成 CSS 轴。
 * @param props - renderSlot / width / side / properties / className。
 * @returns ReactElement。
 */
export const PageShell: FC<PageShellProps> = (props) => {
  const layout = resolveShellLayout(props.width ?? DEFAULT_SHELL_WIDTH)
  const side: ShellSide = props.side ?? layout.side
  const properties = props.properties ?? layout.properties
  const ctx: ShellSlotContext = { side, properties }
  const slot = (name: ShellSlot): ReactNode => props.renderSlot(name, ctx)

  // 内联发布现算宽度轴——这是宽度的唯一来源，CSS 侧不再用类规则覆写（审查必修）。
  const axis = {
    "--page-shell-sidebar-w": `${layout.sidebarWidth}px`,
    "--page-shell-center-w": `${layout.centerWidth}px`,
    "--page-shell-center-min": `${400}px`,
    "--page-shell-props-w": `${layout.rightWidth}px`,
  } as CSSProperties

  return createElement(
    "div",
    {
      "data-shell": "page",
      "data-side": side,
      "data-properties": properties ? "on" : "off",
      "data-viewport-w": layout.viewportWidth,
      className: clsx(css.root, props.className),
      style: axis,
    },
    createElement("aside", { "data-shell-slot": "sidebar", className: css.sidebar }, slot("shell.sidebar")),
    createElement("main", { "data-shell-slot": "content", className: css.content }, slot("shell.content")),
    createElement("aside", { "data-shell-slot": "properties", className: css.properties }, slot("shell.properties")),
  )
}
