/**
 * issue 详情留位骨架（layer 1，domain=detail）：本单只占位，不做详情内容。
 *
 * ISS-540 是「列表骨架真接线」单——详情域只保留一个可被装配的最小入口，
 * 正文渲染与 slot 接线推迟到后续视图单。结构照 ui-kb detail 的 shape，
 * 但不引入 slot 依赖（本单无可用详情数据）。
 *
 * @module @matter/client-ui-pm/client/detail/detail
 */

import { createElement } from "react"
import type { ReactElement } from "react"
import type { Messages } from "../locale.ts"

/** issue 详情入参。 */
export interface IssueDetailProps {
  /** 要展示的 issue id。 */
  readonly issueId: string
  /** 用户可见文案（locale 字典）。 */
  readonly messages: Messages
}

/**
 * 详情留位：渲染标题与该 issue 的 id 锚点，不加载正文。
 * @param props - issueId / 文案。
 * @returns React 元素。
 */
export function IssueDetail(props: IssueDetailProps): ReactElement {
  const { issueId, messages } = props
  return createElement(
    "section",
    { "data-ui-pm": "detail", "data-issue-id": issueId },
    createElement("h2", null, messages.detailTitle),
  )
}
