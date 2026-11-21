/**
 * view 块的查询渲染接缝（ISS-532 / P3-U2b）——进程内直连 B-1 的 `evaluateViewQuery`。
 *
 * view 块带 `ref`（指向视图配置）与 `kind`（list/table/board）。P3 无 shell、无 views.json，
 * 行源与字段目录由装配方（测试 / U-3）注入；本文件只做「取 spec → 调 B-1 纯函数 → 返回行」
 * 的直连编排，不实现查询引擎（B-1 已有），不认识任何实体域（字段目录由注入方给）。
 *
 * @module @matter/client-ui-blocks/client/mapping/view-query
 */

import { evaluateViewQuery } from "@matter/blocks"
import type { ViewFieldCatalog, ViewRow } from "@matter/blocks"

/** 视图渲染请求：spec 是 B-1 `ViewQuerySpec` 的 raw 值（从视图配置读来，先由 zod 校验）。 */
export interface ViewRenderRequest {
  /** 视图 ref（view 块的 `ref` 字段），仅透传给调用方做日志/追踪，不参与查询。 */
  readonly ref: string
  /** 呈现形态（list/table/board），仅透传，不影响行集。 */
  readonly kind?: "list" | "table" | "board"
  /** B-1 查询 spec（filter/sort/limit）。 */
  readonly spec: unknown
  /** 候选行（进程内直连——U-3 真数据通道或测试的固定行集）。 */
  readonly rows: readonly ViewRow[]
  /** 字段目录（已知字段→比较类型，由装配方注入）。 */
  readonly fields: ViewFieldCatalog
}

/**
 * 进程内直连 B-1 的视图查询：验证 spec、按目录校验字段、跑 filter→sort→limit。
 * @param request - 视图渲染请求（ref/kind 透传、rows/fields/spec 进查询）。
 * @returns 通过查询的行数组（元素为原行引用，不突变入参）。
 * @throws {import("zod").ZodError} spec 形态非法。
 * @throws {import("@matter/blocks").ViewQueryError} 引用未知字段或行值类型与目录不符。
 */
export function runViewQuery(request: ViewRenderRequest): ViewRow[] {
  return evaluateViewQuery(request.rows, request.spec, request.fields)
}
