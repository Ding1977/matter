/**
 * ui-pm 共享契约（layer 0）：issue 行类型 + ViewConfig 消费接口 + 字段读取/两态共用纯函数。
 *
 * ## 跨包纪律（ISS-540）
 *
 * ViewConfig 来自 `@matter/issue`（ViewConfigStore 持久化单元），本包真消费、不另造 store；
 * issue rows 由装配方经 prop 注入；不 import 兄弟 UI 包（feature 插件互不 import）。
 *
 * ## 字段读取为何是 switch
 *
 * `sort.field` / `group.field` 引用 @matter/issue 已声明字段；只展示最小行面
 *（id/title/status/priority），未知字段回落空串不伪造值——每条路径都有测试。
 *
 * ## 两形态共用数据层（ISS-541）
 * orderRows / groupRows / deriveColumns / withType / shapeOf 供 list 与 table 共用，
 * 域间不互 import，装配点 apply.ts 才跨域装配。
 * @module @matter/client-ui-pm/client/contract/issue
 */
import type { ViewConfig } from "@matter/issue"
// 原地再导出（无 from，依赖目录只记上面一处）：让装配方从 contract 一处拿到 ViewConfig 类型。
export type { ViewConfig }

/** 一条 issue 行（列表展示的最小形态，装配方从 @matter/issue 的记录投影而来）。 */
export interface IssueRow {
  /** 工单 id。 */
  readonly id: string
  /** 工单标题。 */
  readonly title: string
  /** 工单状态（已声明字段，可被排序/分组引用）。 */
  readonly status: string
  /** 工单优先级（已声明字段，可被排序/分组引用）。 */
  readonly priority: string
}

/** issue 可展示字段（列集/单元格的派生来源，与 {@link IssueRow} 字段面一致）。 */
export const ISSUE_FIELDS = ["id", "title", "status", "priority"] as const

/** 一个可展示字段名（ISSUE_FIELDS 的元素类型）。 */
export type IssueField = (typeof ISSUE_FIELDS)[number]

/** 行密度（list 行的疏密形态，落 `data-density`；不进 ViewConfig 第一批 6 字段）。 */
export type Density = "normal" | "compact"

/** 列表骨架消费的视图面：一份 ViewConfig + 注入的 issue rows。 */
export interface IssueListModel {
  /** 从 ViewConfigStore 读出的视图配置（真消费，不造并行 store）。 */
  readonly view: ViewConfig
  /** 装配方注入的 issue 行。 */
  readonly rows: readonly IssueRow[]
}

/**
 * 读取一行的某字段值（排序/分组用）。未知字段回落空串。
 * @param row - 一行 issue。
 * @param field - 字段名（来自 ViewConfig 的 sort/group.field）。
 * @returns 该字段的展示值；未知字段返回空串。
 */
export function rowField(row: IssueRow, field: string): string {
  switch (field) {
    case "id": return row.id
    case "title": return row.title
    case "status": return row.status
    case "priority": return row.priority
    default: return ""
  }
}

/**
 * 取规则数组第一条的字段名（排序首则 / 分组首则）；空数组回落空串。
 * @param rules - 引用字段的规则数组（sort / group）。
 * @returns 首条规则的 field；无规则返回空串。
 */
export function firstField(rules: readonly { readonly field: string }[]): string {
  return rules.length > 0 ? rules[0].field : ""
}

/**
 * 按 ViewConfig 首条排序规则给行排序；无规则保持注入顺序（返回新数组，不改入参）。
 * list 与 table 共用——同一数据源在两态下排序口径一致。
 * @param rows - 注入的 issue 行。
 * @param view - 视图配置。
 * @returns 按配置排好的新数组。
 */
export function orderRows(rows: readonly IssueRow[], view: ViewConfig): IssueRow[] {
  const rule = view.sort.at(0)
  if (rule === undefined) return [...rows]
  const sign = rule.dir === "asc" ? 1 : -1
  const field = rule.field
  return [...rows].sort((a, b) => sign * rowField(a, field).localeCompare(rowField(b, field)))
}

/** 一个分组：分组键值与该组内的行（按注入顺序）。 */
export interface IssueGroup {
  /** 分组字段的展示值；无分组规则或字段未知时为空串。 */
  readonly key: string
  /** 该组内的行。 */
  readonly rows: readonly IssueRow[]
}

/**
 * 按 ViewConfig 首条分组规则给行分组。
 * 无分组规则时返回一个 key 为空串、含全部行的单组（调用方据此不渲染分组头）。
 * @param rows - 注入的 issue 行（通常已 {@link orderRows} 排好）。
 * @param view - 视图配置。
 * @returns 分组数组（分组键按首次出现顺序）。
 */
export function groupRows(rows: readonly IssueRow[], view: ViewConfig): IssueGroup[] {
  const field = firstField(view.group)
  if (field === "") return [{ key: "", rows: [...rows] }]
  const buckets = new Map<string, IssueRow[]>()
  for (const row of rows) {
    const key = rowField(row, field)
    const bucket = buckets.get(key)
    if (bucket !== undefined) bucket.push(row)
    else buckets.set(key, [row])
  }
  return [...buckets].map(([key, group]) => ({ key, rows: group }))
}

/**
 * 从 issue 字段 meta 派生 table 列集。当前展示全部已声明字段，顺序即 {@link ISSUE_FIELDS}。
 * 列显隐字段不在 ViewConfig 第一批 6 字段内，待有当前消费者再加（简洁原则）。
 * @param _view - 视图配置（预留给未来按配置裁剪列；当前列集与配置无关）。
 * @returns 有序的可展示字段数组（新数组，调用方可安全持有）。
 */
export function deriveColumns(_view: ViewConfig): readonly IssueField[] {
  return [...ISSUE_FIELDS]
}

/**
 * 形态切换动作：产出 type 已换成目标形态的新 ViewConfig（不改入参）。
 * 装配方把它交给 ViewConfigStore.upsert 即完成「切换写回」，其余字段原样保留。
 * @param view - 当前视图配置。
 * @param type - 目标形态（VIEW_TYPES 之一）。
 * @returns type 已变更的新配置对象。
 */
export function withType(view: ViewConfig, type: ViewConfig["type"]): ViewConfig {
  return { ...view, type }
}

/** 视图形态的渲染分类：只有行式与列式两态（其余 VIEW_TYPES 暂归列式占位）。 */
export type ViewShape = "list" | "table"

/**
 * 把 ViewConfig.type 映射到渲染形态：list 走行式，其余走列式。
 * 纯判定——装配点据此装配具体组件，测试据此断言两态切换。
 * @param view - 视图配置。
 * @returns 渲染形态分类。
 */
export function shapeOf(view: ViewConfig): ViewShape {
  return view.type === "list" ? "list" : "table"
}
