/**
 * 页壳三栏宽度常量表（ISS-544 / P5-D1）。
 *
 * 数值逐字照 DSH `ui-layout/src/client/columns.ts:11-31` 的框架级硬约定（见
 * `specs/dsh-design-survey.md:99,254`），本仓此前命中 0 处。抄数值、不抄 boot facade。
 * 本表是共享宽度轴的唯一真相源：page-shell 把它发布成 CSS 自定义属性，六个视图
 * 只消费轴、不自写断点。
 *
 * @module apps/web/src/columns
 */

/** 内容栏最小宽：右栏收缩优先于中栏破此值。 */
export const CENTER_MIN = 400

/** 侧栏最小宽。 */
export const SIDEBAR_MIN = 264
/** 侧栏最大宽。 */
export const SIDEBAR_MAX = 420
/** 侧栏默认宽（展开态）。 */
export const SIDEBAR_DEFAULT = 280
/** 侧栏收起后的轨道宽。 */
export const SIDEBAR_COLLAPSED = 56

/** 抽屉断点：小于此宽侧栏变抽屉。 */
export const DRAWER_BREAKPOINT = 768
/** 自动收起断点：小于此宽侧栏自动收起。 */
export const AUTO_COLLAPSE = 1024

/** 右栏（属性栏）最小宽。 */
export const RIGHT_MIN = 300
/** 右栏首次打开时占内容区的比例。 */
export const RIGHT_INITIAL_RATIO = 0.45
/** 右栏占比上限。 */
export const RIGHT_MAX_RATIO = 0.7

/** 冻结的三栏常量表，供装配层以单一对象发布宽度轴。 */
export const COLUMNS = Object.freeze({
  centerMin: CENTER_MIN,
  sidebarMin: SIDEBAR_MIN,
  sidebarMax: SIDEBAR_MAX,
  sidebarDefault: SIDEBAR_DEFAULT,
  sidebarCollapsed: SIDEBAR_COLLAPSED,
  drawerBreakpoint: DRAWER_BREAKPOINT,
  autoCollapse: AUTO_COLLAPSE,
  rightMin: RIGHT_MIN,
  rightInitialRatio: RIGHT_INITIAL_RATIO,
  rightMaxRatio: RIGHT_MAX_RATIO,
})

/**
 * 右栏宽度解析（右栏收缩优先于中栏破最小宽）。
 *
 * @param contentWidth - 内容区可用宽（侧栏之外）。
 * @param ratio - 期望右栏占比（通常 {@link RIGHT_INITIAL_RATIO}）。
 * @returns 右栏实际宽；空间不足时先按比例收缩，仍不足则退到 0（让中栏保住 {@link CENTER_MIN}）。
 */
export function resolveRightWidth(contentWidth: number, ratio: number): number {
  const wanted = contentWidth * Math.min(Math.max(ratio, 0), RIGHT_MAX_RATIO)
  const clamped = Math.max(wanted, RIGHT_MIN)
  // 中栏要保住最小宽 ⇒ 右栏最多只能占 contentWidth - CENTER_MIN。
  const ceiling = contentWidth - CENTER_MIN
  if (ceiling <= 0) return 0
  return Math.min(clamped, ceiling)
}

/** 侧栏形态：抽屉 / 收起轨道 / 展开。 */
export type ShellSide = "drawer" | "collapsed" | "expanded"

/**
 * 视口宽 → 侧栏形态（照 DSH columns.ts:21-25 的两个断点）。
 * @param viewportWidth - 当前视口宽（px）。
 */
export function resolveShellSide(viewportWidth: number): ShellSide {
  if (viewportWidth < DRAWER_BREAKPOINT) return "drawer"
  if (viewportWidth < AUTO_COLLAPSE) return "collapsed"
  return "expanded"
}

/** 一次解析出的三栏布局（宽度轴 + 侧别 + 属性栏开合）。 */
export interface ShellLayout {
  readonly viewportWidth: number
  readonly side: ShellSide
  readonly sidebarWidth: number
  readonly centerWidth: number
  readonly rightWidth: number
  readonly properties: boolean
  /** 不变量：三栏宽之和恰等于视口宽（无横向溢出）。 */
  readonly overflow: boolean
}

/**
 * 三栏布局解析（ISS-544 审查必修）——右栏收缩纪律的唯一真相源。
 *
 * 顺序：① 断点定侧栏形态；② 侧栏吃掉自身宽；③ 余宽里先给右栏（右栏收缩优先于中栏破
 * CENTER_MIN，交给 {@link resolveRightWidth}）；④ 中栏吃余下的，保底 {@link CENTER_MIN}；
 * ⑤ 三栏之和恰等于视口宽 ⇒ 任何视口下零横向溢出。抽屉态右栏让位（=0）。
 *
 * @param viewportWidth - 当前视口宽（px）。
 * @returns 可直接发布成 CSS 宽度轴的三栏布局。
 */
export function resolveShellLayout(viewportWidth: number): ShellLayout {
  const width = Math.max(0, Math.floor(viewportWidth))
  const side = resolveShellSide(width)
  const sidebarWidth = side === "drawer"
    ? 0
    : side === "collapsed" ? SIDEBAR_COLLAPSED : SIDEBAR_DEFAULT
  const contentWidth = Math.max(0, width - sidebarWidth)
  const rightWidth = side === "drawer" ? 0 : resolveRightWidth(contentWidth, RIGHT_INITIAL_RATIO)
  const centerWidth = Math.max(0, contentWidth - rightWidth)
  return {
    viewportWidth: width,
    side,
    sidebarWidth,
    centerWidth,
    rightWidth,
    properties: rightWidth > 0,
    overflow: sidebarWidth + centerWidth + rightWidth > width,
  }
}
