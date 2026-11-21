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
  /** 页壳侧栏标题（ISS-544）。 */
  readonly sidebarTitle: string
  /** 页壳属性栏标题（ISS-544）。 */
  readonly propertiesTitle: string
  /** 属性栏未选中文档时的空提示（ISS-544）。 */
  readonly propertiesEmptyHint: string
  /** 属性栏「编号」字段名（ISS-544）。 */
  readonly propertiesIdLabel: string
  /** 属性栏「标题」字段名（ISS-544）。 */
  readonly propertiesTitleLabel: string
  /** 列表行展开时的操作提示（ISS-544，状态五组合的展开态）。 */
  readonly rowActionHint: string
  /** 列表取数失败的错误态文案（ISS-931 必修3，区别于「暂无文档」）。 */
  readonly listErrorHint: string
  /** 错误态的重试动作文案（ISS-931 必修3）。 */
  readonly listRetryAction: string
  /** 480 抽屉开合按钮的无障碍名（ISS-931 必修2）。 */
  readonly navToggleLabel: string
  /** 480 抽屉遮罩关闭按钮的无障碍名（ISS-931 必修2）。 */
  readonly navCloseLabel: string
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
    sidebarTitle: t("文档导航"),
    propertiesTitle: t("属性"),
    propertiesEmptyHint: t("选中文档后显示属性"),
    propertiesIdLabel: t("编号"),
    propertiesTitleLabel: t("标题"),
    rowActionHint: t("操作"),
    listErrorHint: t("加载失败，请检查网络或服务后重试"),
    listRetryAction: t("重试"),
    navToggleLabel: t("打开文档导航"),
    navCloseLabel: t("关闭文档导航"),
  }
}
