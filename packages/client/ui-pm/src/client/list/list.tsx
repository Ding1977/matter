/**
 * issue list 行式视图（layer 1，domain=list）：按 ViewConfig 渲染注入的 issue rows。
 *
 * ## 骨架真接线（ISS-540）与两形态补完（ISS-541）
 *
 * 装配方从 `@matter/issue` 的 ViewConfigStore 读出 ViewConfig，连同 issue rows 经 prop 注入。
 * 本形态按配置完整渲染行面：视图名作标题、type/group/filter 落成 data 属性、
 * 首条 sort 规则决定行序，首条 group 规则决定分组头，行密度落 data-density。
 * 排序/分组纯函数与 table 态共用 contract（域间不互 import）。
 *
 * 本域只 import contract 与 locale（顶层非装配文件，官方放行）及外部原件座席 Button，
 * 不 import 兄弟域 detail/table，也不 import ui-kb / ui-blocks 等兄弟 UI 包。
 *
 * @module @matter/client-ui-pm/client/list/list
 */

import { createElement } from "react"
import { Button } from "@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx"
import type { ViewConfig } from "@matter/issue"
import {
  firstField, groupRows, orderRows, type Density, type IssueRow,
} from "../contract/issue.ts"
import type { Messages } from "../locale.ts"

/** issue 列表入参。 */
export interface IssueListProps {
  /** 装配方注入的 issue 行。 */
  readonly rows: readonly IssueRow[]
  /** 从 ViewConfigStore 读出的视图配置。 */
  readonly view: ViewConfig
  /** 用户可见文案（从 locale 字典解析）。 */
  readonly messages: Messages
  /** 行密度；缺省 normal。可由此驱动视觉疏密（落 data-density）。 */
  readonly density?: Density
}

/** re-export 排序纯函数，保持 apply.ts 既有出口不变。 */
export { orderRows } from "../contract/issue.ts"

/** 把 sort 首则渲染成指示元素；无规则返回 undefined（不渲染指示）。 */
function sortIndicator(view: ViewConfig): React.ReactElement | undefined {
  const rule = view.sort.at(0)
  if (rule === undefined) return undefined
  return createElement("span", {
    "data-ui-pm": "sort-indicator",
    "data-sort-field": rule.field,
    "data-sort-dir": rule.dir,
  }, `${rule.field} ${rule.dir === "asc" ? "↑" : "↓"}`)
}

/**
 * 渲染 issue 列表行式视图：视图名作标题、排序/分组指示、分组头、行按配置排序渲染。
 * @param props - 行、视图配置、文案、可选行密度。
 * @returns React 元素。
 */
export function IssueList(props: IssueListProps): React.ReactElement {
  const { rows, view, messages } = props
  const density = props.density ?? "normal"
  const ordered = orderRows(rows, view)
  const groups = groupRows(ordered, view)
  const grouped = firstField(view.group) !== ""
  const indicator = sortIndicator(view)

  return createElement(
    "section",
    {
      "data-ui-pm": "list",
      "data-view-type": view.type,
      "data-group-by": firstField(view.group),
      "data-filter-count": view.filter.conditions.length,
      "data-density": density,
    },
    createElement(
      "header",
      { "data-ui-pm": "list-header" },
      createElement("h2", null, view.name),
      indicator,
    ),
    ordered.length === 0
      ? createElement("p", { "data-ui-pm": "empty" }, messages.emptyHint)
      : createElement(
        "ul",
        null,
        ...groups.flatMap((group) => [
          ...(grouped
            ? [createElement(
              "li",
              {
                key: `group:${group.key}`,
                "data-ui-pm": "group-header",
                "data-group-key": group.key,
              },
              group.key === "" ? messages.untitled : group.key,
            )]
            : []),
          ...group.rows.map((row) =>
            createElement(
              "li",
              { key: row.id, "data-issue-id": row.id },
              // 行操作用 2305 座席的原件 Button（token-styled, 零自带 CSS），不逐包自写控件。
              createElement(
                Button,
                { variant: "ghost", size: "sm" },
                row.title.length > 0 ? row.title : messages.untitled,
              ),
            ),
          ),
        ]),
      ),
  )
}
