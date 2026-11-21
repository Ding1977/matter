/**
 * issue table 列式视图（layer 1，domain=table）：按 ViewConfig 渲染列头 + 单元格。
 *
 * ## 两形态分工（ISS-541）
 *
 * list 是行式（标题按钮 + 分组头），table 是列式（每 issue 一行、每声明字段一列）。
 * 两态共用 contract 的 orderRows / deriveColumns / rowField（同一数据源、同一排序口径），
 * 域间不互 import——本域只 import contract、locale（顶层非装配文件，官方放行）与外部原件座席。
 *
 * ## 列集派生
 *
 * 列集来自 {@link deriveColumns}（issue 字段 meta），不用 ViewConfig 的 columns 字段
 * （不在第一批 6 字段内）。列头文案走 locale 字典，无裸中文。
 *
 * @module @matter/client-ui-pm/client/table/table
 */

import { createElement } from "react"
import type { ViewConfig } from "@matter/issue"
import {
  deriveColumns, orderRows, rowField, type IssueField, type IssueRow,
} from "../contract/issue.ts"
import type { Messages } from "../locale.ts"

/** issue table 入参（与 IssueListProps 同形，装配点一处切换两态）。 */
export interface IssueTableProps {
  /** 装配方注入的 issue 行。 */
  readonly rows: readonly IssueRow[]
  /** 从 ViewConfigStore 读出的视图配置。 */
  readonly view: ViewConfig
  /** 用户可见文案（从 locale 字典解析）。 */
  readonly messages: Messages
}

/** 渲染一个单元格：字段值，空标题回落 untitled 占位。 */
function cell(row: IssueRow, field: IssueField, messages: Messages): string {
  const value = rowField(row, field)
  return field === "title" && value.length === 0 ? messages.untitled : value
}

/**
 * 渲染 issue table 列式视图：列头行 + 每行每字段一个单元格，列集由字段 meta 派生。
 * 排序列的 th 带 data-sort-field / data-sort-dir；空数据渲染 emptyHint。
 * @param props - 行、视图配置、文案。
 * @returns React 元素。
 */
export function IssueTable(props: IssueTableProps): React.ReactElement {
  const { rows, view, messages } = props
  const columns = deriveColumns(view)
  const ordered = orderRows(rows, view)
  const sort = view.sort.at(0)

  return createElement(
    "section",
    {
      "data-ui-pm": "table",
      "data-view-type": view.type,
      "data-column-count": columns.length,
    },
    createElement("h2", null, view.name),
    ordered.length === 0
      ? createElement("p", { "data-ui-pm": "empty" }, messages.emptyHint)
      : createElement(
        "table",
        null,
        createElement(
          "thead",
          null,
          createElement(
            "tr",
            null,
            ...columns.map((field) => createElement(
              "th",
              {
                key: field,
                "data-column": field,
                ...(sort !== undefined && sort.field === field
                  ? { "data-sort-field": sort.field, "data-sort-dir": sort.dir }
                  : {}),
              },
              messages.columns[field],
            )),
          ),
        ),
        createElement(
          "tbody",
          null,
          ...ordered.map((row) => createElement(
            "tr",
            { key: row.id, "data-issue-id": row.id },
            ...columns.map((field) => createElement(
              "td",
              { key: field, "data-column": field },
              cell(row, field, messages),
            )),
          )),
        ),
      ),
  )
}
