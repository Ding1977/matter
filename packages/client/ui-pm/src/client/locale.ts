/**
 * ui-pm 的用户可见文案（layer 0，走类型化字典）。
 *
 * ## i18n 判据（verify-client-ui-i18n 在档）
 *
 * 本仓 client 包的中文字面量必须出现在 `t(...)` 字典调用的参数位；
 * 这里全部中文都经 `t` 取用，新文案同样不豁免。
 * 产品可见文本只在此文件出现一次，组件消费 {@link Messages} 的字段，不硬编码。
 *
 * @module @matter/client-ui-pm/client/locale
 */

/** 一条翻译函数：给定源语言文案，返回当前语言文案（骨架恒等，后续接真实 locale）。 */
export type Translator = (source: string) => string

/**
 * 骨架默认翻译：恒等（源语言即中文产品文案）。
 * @param source - 源语言文案。
 * @returns 原文（恒等）。
 */
export const identityTranslator: Translator = (source) => source

/** ui-pm 全部用户可见文案（类型化字典的形状）。 */
export interface Messages {
  /** 列表标题前缀。 */
  readonly listTitle: string
  /** 详情标题。 */
  readonly detailTitle: string
  /** 空列表提示。 */
  readonly emptyHint: string
  /** 无标题行的占位。 */
  readonly untitled: string
  /** table 列头文案（按 IssueField 键索引）。 */
  readonly columns: Readonly<Record<"id" | "title" | "status" | "priority", string>>
}

/**
 * 构造一组文案。`t` 是字典取用点——所有中文字面量都在它的参数位，
 * verify-client-ui-i18n 判为合规（不是裸文案）。
 * @param t - 翻译函数（骨架传恒等；后续接 locale 字典）。
 * @returns 当前语言的文案集。
 */
export function resolveMessages(t: Translator = identityTranslator): Messages {
  return {
    listTitle: t("事项列表"),
    detailTitle: t("事项详情"),
    emptyHint: t("暂无事项"),
    untitled: t("无标题"),
    columns: {
      id: t("编号"),
      title: t("标题"),
      status: t("状态"),
      priority: t("优先级"),
    },
  }
}
