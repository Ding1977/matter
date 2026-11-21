/**
 * client 面装配点（layer 2，ISS-540 / 2316）：汇总 contract/list/table/detail 的公开面。
 * 唯一跨域装配是 IssueView——按 shapeOf(view) 分发行式/列式，其余只再导出。
 * 装配点是 verify-client-domain-graph 唯一允许跨域的地方。
 *
 * ## 两态切换（ISS-541）
 * type 变更驱动形态切换、不改配置；写回由装配方用 withType + ViewConfigStore.upsert 完成。
 *
 * @module @matter/client-ui-pm/client/apply
 */

export type { ViewConfig } from "@matter/issue"
import type { ViewConfig } from "./contract/issue.ts"
import { createElement } from "react"
import type { ReactElement } from "react"
import { IssueList } from "./list/list.tsx"
import type { IssueListProps } from "./list/list.tsx"
import { IssueTable } from "./table/table.tsx"
import type { IssueTableProps } from "./table/table.tsx"
import {
  shapeOf, type Density, type IssueField, type IssueGroup, type IssueRow, type ViewShape,
} from "./contract/issue.ts"
import type { Messages } from "./locale.ts"

export type {
  IssueRow, IssueListModel, IssueField, Density, IssueGroup, ViewShape,
} from "./contract/issue.ts"
export {
  rowField, firstField, orderRows, groupRows, deriveColumns, withType, shapeOf,
  ISSUE_FIELDS,
} from "./contract/issue.ts"

export { IssueList } from "./list/list.tsx"
export type { IssueListProps } from "./list/list.tsx"

export { IssueTable } from "./table/table.tsx"
export type { IssueTableProps } from "./table/table.tsx"

/** IssueView 入参（两态同形）。 */
export interface IssueViewProps {
  /** 装配方注入的 issue 行。 */
  readonly rows: readonly IssueRow[]
  /** 从 ViewConfigStore 读出的视图配置。 */
  readonly view: ViewConfig
  /** 用户可见文案（从 locale 字典解析）。 */
  readonly messages: Messages
  /** 行密度（list 态生效；table 态忽略）。 */
  readonly density?: Density
}

/**
 * 按 ViewConfig.type 装配两态：list → 行式，其余 → 列式。
 * 同一 rows + view 注入，type 变更即驱动 DOM 两态切换。
 * @param props - 行 / 视图配置 / 文案 / 可选行密度。
 * @returns React 元素。
 */
export function IssueView(props: IssueViewProps): ReactElement {
  const shared: IssueListProps = {
    rows: props.rows,
    view: props.view,
    messages: props.messages,
    density: props.density,
  }
  return shapeOf(props.view) === "list"
    ? createElement(IssueList, shared)
    : createElement(IssueTable, shared as IssueTableProps)
}

export { IssueDetail } from "./detail/detail.tsx"
export type { IssueDetailProps } from "./detail/detail.tsx"

export { resolveMessages, identityTranslator } from "./locale.ts"
export type { Messages, Translator } from "./locale.ts"
