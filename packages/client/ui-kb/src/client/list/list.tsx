/**
 * doc 列表（layer 1，domain=list）：只读地展示 DocRow 数组，点击行上报 id。
 *
 * 本域只 import contract（layer 0）与 locale（顶层非装配文件，官方放行），
 * 不 import 兄弟域 detail —— 跨域装配只许在 apply.ts / index.ts。
 *
 * @module @matter/client-ui-kb/client/list/list
 */

import { createElement } from "react"
import type { DocRow } from "../contract/doc.ts"
import type { Messages } from "../locale.ts"

/** doc 列表入参。 */
export interface DocListProps {
  /** 文档行数组。 */
  readonly rows: readonly DocRow[]
  /** 点击某行：把文档 id 上报给拥有方（详情装配）。 */
  readonly onOpen: (id: string) => void
  /** 用户可见文案（从 locale 字典解析）。 */
  readonly messages: Messages
}

/**
 * 渲染 doc 列表：每行一个 button，标题为空时用字典的 untitled 占位。
 * @param props - 行、打开回调、文案。
 * @returns React 元素。
 */
export function DocList(props: DocListProps): React.ReactElement {
  const { rows, onOpen, messages } = props
  return createElement(
    "ul",
    { "data-ui-kb": "list" },
    ...rows.map((row) =>
      createElement(
        "li",
        { key: row.id, "data-doc-id": row.id },
        createElement(
          "button",
          { type: "button", onClick: () => onOpen(row.id) },
          row.title.length > 0 ? row.title : messages.untitled,
        ),
      ),
    ),
  )
}
