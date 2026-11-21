/**
 * 视图配置（ViewConfig）的 zod schema —— P4 V 轨数据半。
 *
 * ## 字段集：旧树基线按现状裁剪（老板 2026-11-21 裁决：旧树仅末位参考）
 *
 * 第一批 6 字段：`id` / `name` / `type` / `filter` / `sort` / `group`。
 * 旧树 `forge-design/src/view-types.ts:92` 的 `tableId` / `columns` / `options`
 * 第一批不进 —— 前者单一消费者归属隐含，后两者等形态渲染落地、有当前消费者再加
 * （`AGENTS.md` 判据：没有当前消费者的字段不建）。
 *
 * ## 过滤/排序/分组的 `field` 从哪来
 *
 * 不另列字段名表（两份真相迟早对不上）。`filter/sort/group.field` 引用
 * `@matter/issue` 已声明的字段面 —— 从 `IssueProps.shape` 派生，正是 spec.ts 里
 * 带 `.meta({…})` 的那些键。加字段只需改 spec.ts 一处，这里自动跟上。
 *
 * ## 为什么 strictObject 与 `.meta()`
 *
 * strictObject：拼错的字段名必须报出来，不能静默丢弃（与 IssueProps 同口径）。
 * `.meta()`：字段描述的家在 schema 本身，`z.toJSONSchema()` 会保留，前端不必维护第二处。
 *
 * @module @matter/issue/src/views/spec
 */

import { z } from "zod"
import { IssueProps } from "../spec.ts"

/** 视图形态六值（旧树 ViewType 逐字，DOC-512 六形态）。 */
export const VIEW_TYPES = ["list", "table", "board", "timeline", "card", "calendar"] as const

/** 过滤操作符词表（第一批：等值/不等/包含/比较/集合/isSet）。 */
export const FILTER_OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "in", "nin", "isSet", "notSet"] as const

/** 排序方向词表。 */
export const SORT_DIRS = ["asc", "desc"] as const

/** 过滤逻辑连接词。 */
export const FILTER_LOGICS = ["and", "or"] as const

/**
 * issue 已声明字段面（= `IssueProps.shape` 的键），过滤/排序/分组的 `field` 只能取这里的值。
 * 从 schema 派生而非手写，保证 `.meta()` 字段面与可引用字段面永远是同一份。
 */
const ISSUE_FIELD_NAMES: ReadonlySet<string> = new Set(Object.keys(IssueProps.shape))

/**
 * 一个可引用字段名。非法值报出「必须是 issue 已声明字段」，path 指到坏掉的 `field`。
 * ⛔ 换掉这个 refine（例如退成 `z.string()`）⇒ spec 用例「非法字段被拒且点名」必红。
 */
export const ViewField = z.string().refine((value) => ISSUE_FIELD_NAMES.has(value), {
  message: `field 必须是 @matter/issue 已声明的字段（${[...ISSUE_FIELD_NAMES].join(", ")}）`,
})

/** 一条过滤条件：字段 + 操作符 + 可选值（isSet/notSet 不需要值）。 */
export const FilterCondition = z.strictObject({
  field: ViewField.meta({ widget: "field-ref" }),
  op: z.enum(FILTER_OPS).meta({ widget: "select" }),
  value: z.unknown().optional().meta({ widget: "value" }),
})

/** 一组过滤条件：连接词 + 条件数组。 */
export const FilterGroup = z.strictObject({
  logic: z.enum(FILTER_LOGICS).meta({ widget: "select" }),
  conditions: z.array(FilterCondition).meta({ widget: "filter" }),
})

/** 一条排序规则。 */
export const SortRule = z.strictObject({
  field: ViewField.meta({ widget: "field-ref" }),
  dir: z.enum(SORT_DIRS).meta({ widget: "select" }),
})

/** 一条分组规则。 */
export const GroupRule = z.strictObject({
  field: ViewField.meta({ widget: "field-ref" }),
})

/**
 * 一份视图配置（持久化单元）。第一批 6 字段。
 * ⛔ `strictObject` 换成 `z.object` ⇒ 未知键被静默丢弃，spec 用例必红。
 */
export const ViewConfig = z.strictObject({
  id: z.string().min(1).meta({ widget: "text", indexable: true }),
  name: z.string().min(1).meta({ widget: "text", indexable: true }),
  type: z.enum(VIEW_TYPES).meta({ widget: "select", indexable: false }),
  filter: FilterGroup.meta({ widget: "filter", indexable: false }),
  sort: z.array(SortRule).meta({ widget: "sort", indexable: false }),
  group: z.array(GroupRule).meta({ widget: "group", indexable: false }),
})

/** 一份视图配置（schema 推断类型）。 */
export type ViewConfig = z.infer<typeof ViewConfig>

/** views.json 的整单元值：视图配置数组（存 single layout 的 global 槽）。 */
export const ViewConfigList = z.array(ViewConfig)

/** views.json 的整单元值类型。 */
export type ViewConfigList = z.infer<typeof ViewConfigList>

/**
 * 构造一份合法的最小视图配置（list 形态、无过滤/排序/分组）。
 * @param id - 视图 id。
 * @param name - 视图名。
 * @returns 校验通过的视图配置。
 */
export function minimalView(id: string, name: string): ViewConfig {
  return {
    id,
    name,
    type: "list",
    filter: { logic: "and", conditions: [] },
    sort: [],
    group: [],
  }
}
