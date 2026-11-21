/**
 * 模型详情面板（layer 1，domain=panel 的第二级）：展示选中模型的字段面。
 *
 * ## 形态学来源
 *
 * 详情是 DSH `ModelSelect.tsx:619-654` drilled effort pane 的最小等价物——
 * 选中后进入一个只展示该值的面板，Esc / 返回键退回列表（:274-282 的 back 语义）。
 * 本单是 stub 座席，只展示 provider / name / effort 三字段，不做推理强度切换（那属真实目录 P5+）。
 *
 * 本域只 import contract 与 locale（顶层非装配文件，官方放行）及外部原件座席 Button，
 * 不 import 兄弟域，也不 import 兄弟 UI 包。
 *
 * @module @matter/client-ui-model/client/panel/detail
 */

import { createElement } from "react"
import { Button } from "@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx"
import type { ModelRow } from "../contract/model.ts"
import type { Messages } from "../locale.ts"

/** 详情面板入参。 */
export interface ModelDetailProps {
  /** 选中的模型行（由列表态注入）。 */
  readonly model: ModelRow
  /** 用户可见文案。 */
  readonly messages: Messages
  /** 返回列表的回调。 */
  readonly onBack: () => void
}

/**
 * 渲染模型详情：标题 + 三字段定义列表 + 原件 Button 返回键。
 * @param props - 模型行 / 文案 / 返回回调。
 * @returns React 元素。
 */
export function ModelDetail(props: ModelDetailProps): React.ReactElement {
  const { model, messages, onBack } = props
  return createElement(
    "section",
    { "data-ui-model": "detail", "data-model-id": model.id },
    createElement("h2", null, messages.detailTitle),
    createElement(
      "dl",
      { "data-ui-model": "detail-fields" },
      createElement("dt", null, messages.providerLabel),
      createElement("dd", { "data-field": "provider" }, model.provider),
      createElement("dt", null, messages.nameLabel),
      createElement("dd", { "data-field": "name" }, model.name),
      createElement("dt", null, messages.effortLabel),
      createElement("dd", { "data-field": "effort" }, model.effort),
    ),
    // 返回键用 2305 原件座席 Button（token-styled，零自带 CSS），不逐包自写控件。
    createElement(Button, { variant: "ghost", size: "sm", onClick: onBack }, messages.back),
  )
}
