/**
 * client 面装配点（layer 2，ISS-543）：汇总 contract/panel/locale 的公开面。
 * 唯一装配是 ModelSelect——把 ctx 注入的目录与文案交给两级面板；其余只再导出。
 * 装配点是 verify-client-domain-graph 唯一允许跨域的地方。
 *
 * @module @matter/client-ui-model/client/apply
 */

import { createElement } from "react"
import type { ReactElement } from "react"
import { ModelPanel } from "./panel/panel.tsx"
import type { ModelPanelProps } from "./panel/panel.tsx"

export type { ModelRow, ProviderGroup, ModelDirectory } from "./contract/model.ts"
export {
  stubDirectory, matchesQuery, filterGroups, visibleModels, moveHighlight,
} from "./contract/model.ts"

export { ModelDetail } from "./panel/detail.tsx"
export type { ModelDetailProps } from "./panel/detail.tsx"

export { ModelPanel, onPanelKeyDown } from "./panel/panel.tsx"
export type { ModelPanelProps, NavActions, Pane } from "./panel/panel.tsx"

export { resolveMessages, identityTranslator } from "./locale.ts"
export type { Messages, Translator } from "./locale.ts"

/**
 * ModelSelect：装配方入口——把注入的 stub 目录 + 文案交给两级面板。
 * 数据面在调用侧注入（ctx/prop），本函数不建 store、不 import llm 域。
 * @param props - 目录 / 文案。
 * @returns React 元素。
 */
export function ModelSelect(props: ModelPanelProps): ReactElement {
  return createElement(ModelPanel, props)
}
