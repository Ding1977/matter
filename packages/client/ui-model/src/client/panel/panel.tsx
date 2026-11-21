/**
 * 模型选择器两级面板（layer 1，domain=panel）：列表级（搜索 + provider 分组 + ↑↓/Enter）
 * 与详情级（选中模型字段）在同一组件内切换，装配点 apply.ts 才对外装配。
 *
 * ## 形态学来源（DSH 优先，Linear 仅导航参考）
 *
 * - 两级面板结构 + 根级键盘处理：DSH `ModelSelect.tsx:3-13`、`:274-282`（Escape 先 back 再 close）。
 * - 搜索框 >4 条出搜索：`ModelSelect.tsx:115`（`choices.length > 4`）——本单 stub 6 条恒出搜索。
 * - ↑↓ 循环高亮 + Enter 接受：`ModelSelect.tsx:284-300`（`(active + direction + length) % length`；
 *   Enter 落在高亮项）。
 * - 焦点纪律：焦点留搜索框、列表用 `aria-activedescendant`——Linear 档案 §6 K4/K6 仅导航参考。
 * - provider 分组：`ModelSelect.tsx:570-611`（MenuGroup 按 provider 分组渲染）。
 *
 * 搜索/分组/高亮纯函数在 contract/（本域可读，官方放行域→顶层非装配文件）。
 *
 * @module @matter/client-ui-model/client/panel/panel
 */

import { createElement, useState, type KeyboardEvent } from "react"
import type { ModelDirectory, ModelRow, ProviderGroup } from "../contract/model.ts"
import { filterGroups, moveHighlight, visibleModels } from "../contract/model.ts"
import type { Messages } from "../locale.ts"
import { ModelDetail } from "./detail.tsx"

/** 面板当前级别（两级：列表 / 详情）。 */
export type Pane = "list" | "detail"

/** 面板入参：ctx 注入的 stub 目录 + 用户可见文案。 */
export interface ModelPanelProps {
  /** ctx/prop 注入的模型目录（本单 stub）。 */
  readonly directory: ModelDirectory
  /** 用户可见文案（从 locale 字典解析）。 */
  readonly messages: Messages
}

/** 键盘导航的动作面——把按键分发与状态更新解耦，便于纯函数断言。 */
export interface NavActions {
  /** 移动高亮（↑ = -1 / ↓ = +1）。 */
  readonly move: (step: number) => void
  /** 接受当前高亮项（进详情）。 */
  readonly accept: () => void
  /** 退回列表。 */
  readonly back: () => void
}

/**
 * 根级键盘分发（DSH `onRootKeyDown` ModelSelect.tsx:274-339 + Linear §6 K4/K6）：
 * ↑↓ 移高亮、Enter 进详情、Escape 退回列表；非导航键不消费（不 preventDefault）。
 * 挂在根 section 上，故详情级（搜索框已卸载）仍能收 Escape。
 * @param event - 根 section 的 keydown 事件。
 * @param actions - 导航动作面。
 */
export function onPanelKeyDown(event: KeyboardEvent<HTMLElement>, actions: NavActions): void {
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault()
      actions.move(1)
      return
    case "ArrowUp":
      event.preventDefault()
      actions.move(-1)
      return
    case "Enter":
      event.preventDefault()
      actions.accept()
      return
    case "Escape":
      event.preventDefault()
      actions.back()
      return
    default:
      return
  }
}

/** 内部视图状态：用判别联合表达两级，避免「detail 但无 model」的不可达分支。 */
type View = { readonly kind: "list" } | { readonly kind: "detail"; readonly model: ModelRow }

/**
 * 渲染两级面板：列表级过滤分组 + 搜索框 + ↑↓/Enter 导航；详情级展示选中模型。
 * @param props - 目录 / 文案。
 * @returns React 元素。
 */
export function ModelPanel(props: ModelPanelProps): React.ReactElement {
  const { directory, messages } = props
  const [query, setQuery] = useState("")
  const [highlight, setHighlight] = useState(0)
  const [view, setView] = useState<View>({ kind: "list" })

  const groups: readonly ProviderGroup[] = filterGroups(directory, query)
  const rows = visibleModels(groups)
  const activeIndex = rows.length > 0 ? Math.min(highlight, rows.length - 1) : -1
  const active = activeIndex >= 0 ? rows[activeIndex] : undefined

  const move = (step: number): void => { setHighlight((h) => moveHighlight(h, step, rows.length)) }
  const accept = (): void => {
    if (active !== undefined) setView({ kind: "detail", model: active })
  }
  const back = (): void => { setView({ kind: "list" }) }
  const choose = (model: ModelRow): void => { setView({ kind: "detail", model }) }
  const actions: NavActions = { move, accept, back }

  const content = view.kind === "detail"
    ? createElement(ModelDetail, { model: view.model, messages, onBack: back })
    : createElement(
      "div",
      null,
      createElement("h2", null, messages.title),
      createElement("input", {
        type: "text",
        role: "searchbox",
        "data-ui-model": "search",
        "aria-label": messages.searchPlaceholder,
        "aria-activedescendant": active === undefined ? undefined : `model-${activeIndex}`,
        value: query,
        onChange: (event) => {
          setQuery(event.target.value)
          setHighlight(0)
        },
      }),
      rows.length === 0
        ? createElement("p", { "data-ui-model": "empty" }, messages.empty)
        : createElement(
          "ul",
          { role: "listbox", "data-ui-model": "groups" },
          ...groups.flatMap((group) => [
            createElement(
              "li",
              {
                key: `group:${group.id}`,
                role: "presentation",
                "data-ui-model": "group",
                "data-provider": group.id,
              },
              group.name,
            ),
            ...group.models.map((model) => {
              const index = rows.findIndex((row) => row.id === model.id)
              const isActive = index === activeIndex
              return createElement(
                "li",
                {
                  key: model.id,
                  id: `model-${index}`,
                  role: "option",
                  "data-ui-model": "option",
                  "data-model-id": model.id,
                  "aria-selected": isActive ? "true" : "false",
                  "data-highlighted": isActive ? "" : undefined,
                  onClick: () => choose(model),
                },
                model.name,
              )
            }),
          ]),
        ),
    )

  return createElement(
    "section",
    {
      "data-ui-model": "panel",
      "data-pane": view.kind,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => onPanelKeyDown(event, actions),
    },
    content,
  )
}
