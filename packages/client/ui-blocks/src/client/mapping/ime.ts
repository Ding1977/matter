/**
 * IME 组合期守卫（ISS-532 / P3-U2b）——DSH 三层口径的可测实现。
 *
 * DSH 证据（U-0 问5）：
 *   ① `ui-primitives/InlineEditor.tsx`：`isComposing || keyCode===229` 时 Enter 不做提交；
 *   ② `keyboard-composition.ts`：`composing || ended || isComposing || keyCode===229`，ended 在
 *      compositionend 后保持到下一次 keyup（Safari 迟到 closing keydown）；
 *   ③ `ui-conversation/keymap.ts`：compositionend 后再守 10ms（DSH 实测 Safari 窗口）。
 *
 * 三条口径：组合期不提交/不换段 · isComposing 之外兜 keyCode 229 · compositionend 后兜底窗口。
 *
 * ## 与 ProseMirror 的分工
 *
 * ProseMirror 原生感知 composition（`EditorView.composing` 状态位 + transaction 的 "composition"
 * 元数据，U-0 补齐记录#6 官方 ref 实证）。本模块守的是**我方 UI 的 Enter/提交路径**——引擎已
 * 防止组合期文本被误当命令，但上层若另有 Enter 提交钩子（如工具栏快捷键），仍须自己过这三关。
 * 三条都做成纯函数 / 显式状态机，jsdom 可测；真机 IME（macOS 拼音）本单无面可测，单列 unjudged。
 *
 * @module @matter/client-ui-blocks/client/mapping/ime
 */

/** 一个键盘事件里守卫关心的字段（DOM KeyboardEvent 与 jsdom 模拟的共同子集）。 */
export interface KeyLikeEvent {
  readonly isComposing?: boolean
  readonly key?: string
  readonly keyCode?: number
}

/** 组合状态机：包住 DSH 的 composing / ended / 兜底窗口三层。 */
export interface CompositionGuardState {
  /** compositionstart 之后、compositionend 之前为 true。 */
  readonly composing: boolean
  /** compositionend 之后、兜底窗口/下一次 keyup 释放之前为 true。 */
  readonly ended: boolean
  /** compositionend 的时间戳（ms）；ended 为 false 时忽略。 */
  readonly endedAt: number
}

/** 初始组合状态（无组合在进行）。 */
export const INITIAL_COMPOSITION_STATE: CompositionGuardState = {
  composing: false,
  ended: false,
  endedAt: 0,
}

/** compositionend 后的兜底窗口长度（ms）——DSH keymap.ts 实测的 10ms Safari 窗口。 */
export const COMPOSITION_END_WINDOW_MS = 10

/**
 * 兜底窗口的时钟接缝：测试注入假时钟，生产用 Date.now。
 * 不从外部改全局 Date，避免污染同进程其它测试。
 */
export interface CompositionClock {
  now(): number
}

/** 默认真实时钟。 */
export const systemClock: CompositionClock = { now: () => Date.now() }

/**
 * 判一个键盘事件是否处于 IME 组合期（DSH 口径①②）：isComposing 或 keyCode 229。
 * 不依赖事件类型——调用方在 compositionstart/end 之外也用它兜 Safari 迟到的 closing keydown。
 * @param event - 键盘事件（DOM 或模拟）。
 * @returns 处于组合期时 true。
 */
export function isCompositionKey(event: KeyLikeEvent): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/**
 * 组合状态机归 compositionstart：开始组合，清掉上一轮 ended。
 * @returns 新的状态。
 */
export function onCompositionStart(): CompositionGuardState {
  return { composing: true, ended: false, endedAt: 0 }
}

/**
 * 组合状态机归 compositionend：结束组合，开启兜底窗口（时钟注入）。
 * @param clock - 时钟（测试注入假时钟）。
 * @returns 新的状态。
 */
export function onCompositionEnd(clock: CompositionClock = systemClock): CompositionGuardState {
  return { composing: false, ended: true, endedAt: clock.now() }
}

/**
 * 组合状态机归 keyup：释放 DSH 的 ended（Safari 迟到的 closing keydown 之后的 keyup 才释放）。
 * @returns 新的状态。
 */
export function onKeyup(): CompositionGuardState {
  return INITIAL_COMPOSITION_STATE
}

/**
 * 组合期综合判定（DSH 三条口径合一）：
 *   状态机层（composing || ended 且兜底窗口未过）或事件层（isComposing || keyCode 229）。
 * @param state - 当前组合状态。
 * @param event - 键盘事件。
 * @param clock - 时钟（判 ended 兜底窗口是否过期）。
 * @returns 组合期 true——我方 Enter/提交路径应直接 return，不提交、不换段。
 */
export function isComposingEvent(
  state: CompositionGuardState,
  event: KeyLikeEvent,
  clock: CompositionClock = systemClock,
): boolean {
  if (state.composing) return true
  if (state.ended && clock.now() - state.endedAt < COMPOSITION_END_WINDOW_MS) return true
  return isCompositionKey(event)
}

/**
 * 我方 Enter/提交路径的守门谓词：组合期的 Enter（含 Shift+Enter）一律不提交、不换段。
 * 只有 key==="Enter" 且不在组合期才返回 true（放行）。
 * @param state - 组合状态。
 * @param event - 键盘事件。
 * @param clock - 时钟。
 * @returns 该 Enter 是否应被我方提交路径处理。
 */
export function shouldSubmitOnEnter(
  state: CompositionGuardState,
  event: KeyLikeEvent,
  clock: CompositionClock = systemClock,
): boolean {
  return event.key === "Enter" && !isComposingEvent(state, event, clock)
}

/**
 * 从 ProseMirror transaction 读 composition 元数据（U-0 补齐记录#6：`tr.getMeta("composition")`
 * 是标识本次 composed DOM input 的 ID）。本函数是通用的 meta 读取器——传入实现了 getMeta 的
 * transaction 形状即可，避免本包直接依赖 prosemirror-state 的类型面。
 * @param tr - 带 getMeta 的 transaction（ProseMirror Transaction 的最小形状）。
 * @returns composition ID（存在时），否则 undefined。
 */
export function compositionMeta(tr: { getMeta(key: string): unknown }): string | number | undefined {
  const meta = tr.getMeta("composition")
  return typeof meta === "string" || typeof meta === "number" ? meta : undefined
}
