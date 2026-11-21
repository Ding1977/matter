/**
 * ui-model 的用户可见文案（layer 0，走类型化字典）。
 *
 * ## i18n 判据（verify-client-ui-i18n 在档）
 *
 * 本仓 client 包的中文字面量必须出现在 `t(...)` 字典调用的参数位；
 * 这里全部中文都经 `t` 取用，新文案同样不豁免。
 * 产品可见文本只在此文件出现一次，组件消费 {@link Messages} 的字段，不硬编码。
 *
 * @module @matter/client-ui-model/client/locale
 */

/** 一条翻译函数：给定源语言文案，返回当前语言文案（骨架恒等，后续接真实 locale）。 */
export type Translator = (source: string) => string

/**
 * 骨架默认翻译：恒等（源语言即中文产品文案）。
 * @param source - 源语言文案。
 * @returns 原文（恒等）。
 */
export const identityTranslator: Translator = (source) => source

/** ui-model 全部用户可见文案（类型化字典的形状）。 */
export interface Messages {
  /** 选择器标题。 */
  readonly title: string
  /** 搜索框占位 / aria 标签。 */
  readonly searchPlaceholder: string
  /** 无匹配模型提示。 */
  readonly empty: string
  /** 详情面板标题。 */
  readonly detailTitle: string
  /** 从详情返回列表的按钮文案。 */
  readonly back: string
  /** 详情字段：供应商。 */
  readonly providerLabel: string
  /** 详情字段：模型名称。 */
  readonly nameLabel: string
  /** 详情字段：推理强度。 */
  readonly effortLabel: string
}

/**
 * 构造一组文案。`t` 是字典取用点——所有中文字面量都在它的参数位，
 * verify-client-ui-i18n 判为合规（不是裸文案）。
 * @param t - 翻译函数（骨架传恒等；后续接 locale 字典）。
 * @returns 当前语言的文案集。
 */
export function resolveMessages(t: Translator = identityTranslator): Messages {
  return {
    title: t("选择模型"),
    searchPlaceholder: t("搜索模型"),
    empty: t("没有匹配的模型"),
    detailTitle: t("模型详情"),
    back: t("返回列表"),
    providerLabel: t("供应商"),
    nameLabel: t("模型名称"),
    effortLabel: t("推理强度"),
  }
}
