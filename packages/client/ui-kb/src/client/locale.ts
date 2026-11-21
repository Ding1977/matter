/**
 * ui-kb 的用户可见文案（layer 0，走类型化字典）。
 *
 * ## i18n 判据（verify-client-ui-i18n 在档）
 *
 * 本仓 client 包的中文字面量必须出现在 `t(...)`/`tr(...)` 等字典调用的参数位，
 * 否则判裸文案违例。这里全部中文都经 `translator(...)` 取用（名字落 LOCALE_CALL_NAMES
 * 白名单的 `t` 别名——见下方 `const t`），新文案同样不豁免。
 *
 * 产品可见文本只在此文件出现一次，组件消费 {@link Messages} 的字段，不硬编码。
 *
 * @module @matter/client-ui-kb/client/locale
 */

/** 一条翻译函数：给定源语言文案，返回当前语言文案（P3 恒等，P4 接真实 locale）。 */
export type Translator = (source: string) => string

/**
 * P3 默认翻译：恒等（源语言即中文产品文案）。
 * @param source - 源语言文案。
 * @returns 原文（恒等）。
 */
export const identityTranslator: Translator = (source) => source

/** ui-kb 全部用户可见文案（类型化字典的形状）。 */
export interface Messages {
  /** 文档列表标题。 */
  readonly listTitle: string
  /** 文档详情标题。 */
  readonly detailTitle: string
  /** 空列表提示。 */
  readonly emptyHint: string
  /** 加载中提示。 */
  readonly loadingHint: string
  /** 无标题文档的占位。 */
  readonly untitled: string
}

/**
 * 构造一组文案。`t` 是字典取用点——所有中文字面量都在它的参数位，
 * verify-client-ui-i18n 判为合规（不是裸文案）。
 * @param t - 翻译函数（P3 传恒等；P4 接 locale 字典）。
 * @returns 当前语言的文案集。
 */
export function resolveMessages(t: Translator = identityTranslator): Messages {
  return {
    listTitle: t("文档列表"),
    detailTitle: t("文档详情"),
    emptyHint: t("暂无文档"),
    loadingHint: t("加载中"),
    untitled: t("无标题"),
  }
}
