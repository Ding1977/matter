/**
 * `@matter/blocks/src/view-query` —— 视图查询的 spec 与纯函数谓词（P3-B1，ISS-529）。
 *
 * ## 形态照 DSH session-query filters
 *
 * `evaluateViewQuery` 是纯函数谓词：**子句间 AND、子句内 values OR、保输入序**
 * （session-query `filterSessionResults` 同一形态）。filter/sort/limit 三段管道按序执行，
 * 全程不突变入参（sort 在拷贝上排）。
 *
 * ## 字段元数据由调用方注入，本包不认识任何实体域
 *
 * `view` 块的 `ref` 指向一个视图配置（P4 的 views.json），配置里的字段是 issue / document
 * 域的字段名。本包是数据层，**不 import issue/document 域** —— 已知字段目录
 * （`ViewFieldCatalog`：字段名 → 比较类型）由装配方传入。引用未知字段的 spec 在执行时
 * 抛 `ViewQueryError`（配置错误在执行时报错，不静默跳过 —— 仓库惯例「配置错误在加载时报错」）。
 *
 * ## 明确不做（B-0 风险清单）
 *
 * 不装配执行器：`ViewQueryExecutor` 只定义接缝（谁供行、谁带字段目录），实现与装配
 * 归 P4 建 views.json 时；不建 SQLite 查询计划，`evaluateViewQuery` 永远在内存行上跑。
 *
 * @module @matter/blocks/src/view-query
 */

import { z } from "zod"
import { assertNever } from "./index.ts"

/** 视图行：字段名到值的只读记录。字段集与类型由 {@link ViewFieldCatalog} 声明。 */
export type ViewRow = { readonly [field: string]: unknown }

/** 字段的比较类型（决定 sort 语义与行值类型校验）。 */
export type ViewFieldType = "string" | "number" | "boolean"

/** 字段目录：已知字段名 → 比较类型。由装配方注入（本包不内置任何域的字段）。 */
export type ViewFieldCatalog = Record<string, ViewFieldType>

/** 一条 filter 子句：`field` 的值 ∈ `values`（子句内 OR，子句间 AND）。 */
export const ViewFilterClause = z.strictObject({
  field: z.string().min(1),
  values: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
})

/** 一条 sort 键：按 `field` 排，`dir` 定方向；多键按数组序逐键比较。 */
export const ViewSortKey = z.strictObject({
  field: z.string().min(1),
  dir: z.enum(["asc", "desc"]),
})

/**
 * 视图查询 spec（zod）：filter 子句数组 + sort 键数组 + limit。
 * 三段全部 optional —— 空 spec 等于「全量、原序、不截断」。
 */
export const ViewQuerySpec = z.strictObject({
  filter: z.array(ViewFilterClause).optional(),
  sort: z.array(ViewSortKey).optional(),
  limit: z.number().int().min(1).optional(),
})

/** {@link ViewQuerySpec} 的合法值（z.infer）。 */
export type ViewQuery = z.infer<typeof ViewQuerySpec>

/** {@link ViewFilterClause} 的合法值。 */
export type ViewFilter = z.infer<typeof ViewFilterClause>
/** {@link ViewSortKey} 的合法值。 */
export type ViewSort = z.infer<typeof ViewSortKey>

/** ViewQueryError 的机器码（照 DSH session-query 的 `SessionQueryError` 形态）。 */
export type ViewQueryErrorCode =
  | "VIEW_QUERY_UNKNOWN_FIELD"
  | "VIEW_QUERY_FIELD_TYPE_MISMATCH"

/**
 * 视图查询执行错误：引用了字段目录之外的键，或行值与目录声明类型不符。
 * 两种都是**配置/装配错**，在执行时报错，不静默跳过。
 */
export class ViewQueryError extends Error {
  /** 机器码（见 {@link ViewQueryErrorCode}）。 */
  readonly code: ViewQueryErrorCode
  /**
   * @param message - 人类可读详情（带字段名与实际值）。
   * @param code - 机器码。
   */
  constructor(message: string, code: ViewQueryErrorCode) {
    super(message)
    this.name = "ViewQueryError"
    this.code = code
  }
}

/**
 * 视图查询执行器接缝：`fields`（字段目录）与 `loadRows`（行源）由装配方注入，
 * `execute` 的语义等价 `evaluateViewQuery(loadRows(), spec, fields)`。
 * 本包**只定义接缝不装配**——实现归 P4 建 views.json 时（明确不做清单）。
 */
export interface ViewQueryExecutor {
  /** 字段目录：spec 中 filter / sort 引用的字段必须在此。 */
  readonly fields: ViewFieldCatalog
  /** 行源：每次执行取候选行（索引/分页策略由实现决定）。 */
  loadRows(): readonly ViewRow[]
  /** 执行一次查询：校验 spec、按目录校验字段、跑 filter → sort → limit 管道。 */
  execute(spec: unknown): ViewRow[]
}

/**
 * 校验查询引用的全部字段都在目录内（fail fast：进管道前一次校验，
 * 不是逐行碰到才炸）。
 * @param query - 已通过 {@link ViewQuerySpec} 的查询。
 * @param fields - 字段目录。
 * @throws {@link ViewQueryError} `VIEW_QUERY_UNKNOWN_FIELD`：filter 或 sort 引用了目录外的键。
 */
function assertKnownFields(query: ViewQuery, fields: ViewFieldCatalog): void {
  for (const clause of query.filter ?? []) {
    if (!Object.hasOwn(fields, clause.field)) {
      throw new ViewQueryError(
        `filter references unknown field "${clause.field}"`,
        "VIEW_QUERY_UNKNOWN_FIELD",
      )
    }
  }
  for (const key of query.sort ?? []) {
    if (!Object.hasOwn(fields, key.field)) {
      throw new ViewQueryError(
        `sort references unknown field "${key.field}"`,
        "VIEW_QUERY_UNKNOWN_FIELD",
      )
    }
  }
}

/** number 档比较器（类型不符即抛）。 */
function compareNumbers(a: unknown, b: unknown, field: string): number {
  if (typeof a !== "number" || typeof b !== "number") {
    throw mismatch(field, "number", a, b)
  }
  return a === b ? 0 : a < b ? -1 : 1
}

/** string 档比较器（字典序，类型不符即抛）。 */
function compareStrings(a: unknown, b: unknown, field: string): number {
  if (typeof a !== "string" || typeof b !== "string") {
    throw mismatch(field, "string", a, b)
  }
  return a === b ? 0 : a < b ? -1 : 1
}

/** boolean 档比较器（false < true，类型不符即抛）。 */
function compareBooleans(a: unknown, b: unknown, field: string): number {
  if (typeof a !== "boolean" || typeof b !== "boolean") {
    throw mismatch(field, "boolean", a, b)
  }
  return a === b ? 0 : a ? 1 : -1
}

/**
 * 按目录声明类型比较两个非空行值（分发到三档比较器）。null / undefined 不进类型检查
 * （排最后是定义行为）；目录类型是调用方注入的运行期值，词表外类型走得进来，
 * 与 blockGroup 同款兜底 —— 炸，不静默跳过。
 * @param a - 左值（`row[field] ?? null` 后的值）。
 * @param b - 右值。
 * @param field - 字段名（报错定位用）。
 * @param type - 目录声明的比较类型。
 * @returns 负 / 零 / 正（a 在前 / 平 / b 在前）。
 * @throws {@link ViewQueryError} `VIEW_QUERY_FIELD_TYPE_MISMATCH`：行值类型与目录声明不符。
 * @throws {import("./index.ts").UnhandledBlockTypeError} 目录类型在 `ViewFieldType` 词表之外。
 */
function compareValues(a: unknown, b: unknown, field: string, type: ViewFieldType): number {
  // null / undefined 统一视同 null，asc 排最后、desc 反转到最前（与值无关的位置语义）
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1
  if (b === null || b === undefined) return -1
  switch (type) {
    case "number": return compareNumbers(a, b, field)
    case "string": return compareStrings(a, b, field)
    case "boolean": return compareBooleans(a, b, field)
    default: return assertNever(type)
  }
}

/** 组装 `VIEW_QUERY_FIELD_TYPE_MISMATCH` 的详情（带字段名与两个实际值）。 */
function mismatch(field: string, type: ViewFieldType, a: unknown, b: unknown): ViewQueryError {
  return new ViewQueryError(
    `field "${field}" is declared ${type} but rows hold ${typeof a} (${JSON.stringify(a)}) and ${typeof b} (${JSON.stringify(b)})`,
    "VIEW_QUERY_FIELD_TYPE_MISMATCH",
  )
}

/**
 * 执行视图查询的纯函数谓词：**校验 spec（zod）→ 校验字段在目录 → filter（子句间
 * AND、子句内 values OR、保输入序）→ sort（多键、稳定、null 排最后）→ limit**。
 * 全程不突变入参：`rows` 原样、返回新数组（元素是原行对象的引用）。
 *
 * 行读值统一 `row[field] ?? null`：缺失字段与显式 null 同待遇 —— 都只被
 * `values` 含 `null` 的子句接纳（照 session-query 的 `cwd ?? null` 形态）。
 *
 * @param rows - 候选行（输入序即 filter 后的保序基准）。
 * @param spec - 查询描述（unknown：从 views.json 读来的原始值；非法 ⇒ `ZodError`）。
 * @param fields - 字段目录（已知字段名 → 比较类型，由装配方注入）。
 * @returns 通过全部子句、按序排好、截断到 limit 的行数组。
 * @throws {import("zod").ZodError} spec 形态非法。
 * @throws {@link ViewQueryError} 引用未知字段或行值类型与目录不符。
 */
export function evaluateViewQuery(
  rows: readonly ViewRow[],
  spec: unknown,
  fields: ViewFieldCatalog,
): ViewRow[] {
  const query = ViewQuerySpec.parse(spec)
  assertKnownFields(query, fields)

  // filter：每子句一个谓词，子句间 AND（every），保输入序（filter 不换位）
  const predicates = (query.filter ?? []).map((clause) => {
    const field = clause.field
    return (row: ViewRow): boolean => {
      const value = row[field] ?? null
      return clause.values.some((candidate) => candidate === value)
    }
  })
  let out = predicates.length === 0
    ? [...rows]
    : rows.filter((row) => predicates.every((predicate) => predicate(row)))

  // sort：拷贝上稳定排序，多键逐键比较，键全平 ⇒ 保输入序（稳定排序）
  if (query.sort !== undefined && query.sort.length > 0) {
    const sortKeys = query.sort
    out = out.slice().sort((x, y) => {
      for (const key of sortKeys) {
        const compared = compareValues(x[key.field] ?? null, y[key.field] ?? null, key.field, fields[key.field])
        const signed = key.dir === "asc" ? compared : -compared
        if (signed !== 0) return signed
      }
      return 0
    })
  }

  return query.limit === undefined ? out : out.slice(0, query.limit)
}
