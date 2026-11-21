/**
 * doc 列表（layer 1，domain=list）：只读地展示 DocRow 数组，点击行上报 id。
 *
 * ISS-544 / P5-D1 设计态：加 CSS Module + clsx + data-* 状态，落地状态五组合
 * （选中 + 他行悬停 / 悬停 / 焦点 / 禁用 / 展开+菜单打开）。hover 在 CSS Module 里
 * 一律进 `@media (hover: hover)`。视觉只消费 ui-theme alias token（无 hex）。
 * 渲染契约（data-ui-kb / data-doc-id / button 文本 / onOpen）保持不变，既有测试零改。
 *
 * 本域只 import contract（layer 0）与 locale（顶层非装配文件，官方放行），
 * 不 import 兄弟域 detail —— 跨域装配只许在 apply.ts / index.ts。
 *
 * @module @matter/client-ui-kb/client/list/list
 */

import { createElement } from "react"
import clsx from "clsx"
import type { DocRow } from "../contract/doc.ts"
import type { Messages } from "../locale.ts"
import css from "./list.module.css"

/** 列表密度变体（css[variant]）。 */
export type DocListDensity = "normal" | "compact"

/** doc 列表入参。 */
export interface DocListProps {
  /** 文档行数组。 */
  readonly rows: readonly DocRow[]
  /** 点击某行：把文档 id 上报给拥有方（详情装配）。 */
  readonly onOpen: (id: string) => void
  /** 用户可见文案（从 locale 字典解析）。 */
  readonly messages: Messages
  /** 当前选中行 id（选中态；对应状态五组合的选中语义）。 */
  readonly selectedId?: string | null
  /** 密度变体，默认 normal。 */
  readonly density?: DocListDensity
  /** 禁用行 id 集（禁用态；判不可用）。 */
  readonly disabledIds?: ReadonlySet<string>
  /** 展开行 id（展开 + 菜单打开组合）。 */
  readonly expandedId?: string | null
  /** 菜单打开行 id（展开 + 菜单打开组合）。 */
  readonly menuOpenId?: string | null
  /** owner 附加 className（clsx 后置，支持覆盖）。 */
  readonly className?: string
}

/**
 * 渲染 doc 列表：每行一个 button，标题为空时用字典的 untitled 占位。
 * @param props - 行、打开回调、文案、可选状态。
 * @returns React 元素。
 */
export function DocList(props: DocListProps): React.ReactElement {
  const { rows, onOpen, messages, selectedId, density = "normal", disabledIds, expandedId, menuOpenId, className } = props

  if (rows.length === 0) {
    return createElement("p", { "data-ui-kb": "list-empty", className: css.empty }, messages.emptyHint)
  }

  return createElement(
    "ul",
    { "data-ui-kb": "list", "data-density": density, className: clsx(css.root, css[density], className) },
    ...rows.map((row) => {
      const disabled = disabledIds?.has(row.id) === true
      return createElement(
        "li",
        {
          key: row.id,
          "data-doc-id": row.id,
          "data-selected": String(row.id === selectedId),
          "data-disabled": String(disabled),
          "data-expanded": String(row.id === expandedId),
          "data-menu-open": String(row.id === menuOpenId),
          className: css.row,
        },
        createElement(
          "button",
          {
            type: "button",
            disabled,
            className: css.button,
            onClick: () => onOpen(row.id),
          },
          row.title.length > 0 ? row.title : messages.untitled,
        ),
        createElement("span", { "data-ui-kb": "row-menu", className: css.menu }, messages.rowActionHint),
      )
    }),
  )
}
