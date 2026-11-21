/**
 * ISS-529 · `ViewQuerySpec` / `evaluateViewQuery` 的回归守卫。
 *
 * 全部断言写成「换成错误实现即红」的形态：
 *   §2 是变异样本 3 的常驻形态 —— **只满足部分子句的行必须被排除**
 *   （谓词 AND 改成 OR 它会混进来即红）；§5–§8 钉保输入序与 sort 语义；
 *   §9–§12 钉类型化错误与词表外兜底；§13–§14 钉 limit 管道序与执行器接缝。
 * @module @matter/blocks/tests/view-query
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  evaluateViewQuery, ViewFilterClause, ViewQueryError, ViewQuerySpec, ViewSortKey,
} from "../src/view-query.ts"
import type { ViewFieldCatalog, ViewQueryExecutor, ViewRow } from "../src/view-query.ts"
import { UnhandledBlockTypeError } from "../src/index.ts"

/** 模拟 issue 视图的行：字段集贴近 P4 真实装配（本包只认目录里声明过的名字）。 */
const ROWS: readonly ViewRow[] = [
  { id: "i1", status: "open", priority: "high", done: false, points: 10 },
  { id: "i2", status: "open", priority: "low", done: false, points: 2 },
  { id: "i3", status: "closed", priority: "high", done: true, points: 7 },
  { id: "i4", status: "closed", priority: "low", assignee: null },
]

/** 字段目录：装配方注入（本包不内置）。 */
const FIELDS: ViewFieldCatalog = {
  id: "string", status: "string", priority: "string",
  done: "boolean", points: "number", assignee: "string",
}

const ids = (rows: readonly ViewRow[]): string[] => rows.map((row) => row.id as string)

describe("ISS-529 · ViewQuerySpec（zod）与非法 spec", () => {
  it("§1 合法形态 parse 过；未知键 / limit 0 / 负数 / 非整数 / 非法 dir 全红", () => {
    const ok = ViewQuerySpec.parse({
      filter: [{ field: "status", values: ["open"] }],
      sort: [{ field: "priority", dir: "desc" }],
      limit: 10,
    })
    expect(ok.limit).toBe(10)
    for (const bad of [
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { sort: [{ field: "x", dir: "sideways" }] },
      { filter: [{ field: "x", values: [["nested"]] }] },
      { unknown: true },
    ]) {
      expect(ViewQuerySpec.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    // evaluateViewQuery 对非法 spec 抛 ZodError（zod 承重，不是手写校验）
    expect(() => evaluateViewQuery(ROWS, { limit: 0 }, FIELDS)).toThrow(z.ZodError)
    // 子句 schema 单独也可用（P4 直接复用局部形态）
    expect(ViewFilterClause.safeParse({ field: "f", values: [null, 1, "a", true] }).success).toBe(true)
    expect(ViewSortKey.safeParse({ field: "f", dir: "asc" }).success).toBe(true)
  })
})

describe("ISS-529 · filter：子句间 AND、子句内 OR、保输入序", () => {
  it("§2 AND：只满足部分子句的行必须被排除（AND 改 OR 即红）", () => {
    const out = evaluateViewQuery(
      ROWS,
      { filter: [{ field: "status", values: ["open"] }, { field: "priority", values: ["high"] }] },
      FIELDS,
    )
    // i2 满足第一个子句但 priority=low —— 它混进来就是谓词被改成了 OR
    expect(ids(out)).toEqual(["i1"])
  })

  it("§3 子句内 values OR：任一命中即过", () => {
    const out = evaluateViewQuery(ROWS, { filter: [{ field: "status", values: ["open", "closed"] }] }, FIELDS)
    expect(ids(out)).toEqual(["i1", "i2", "i3", "i4"])
  })

  it("§4 保输入序；缺失字段与 null 同待遇（只被含 null 的 values 接纳）", () => {
    const out = evaluateViewQuery(ROWS, { filter: [{ field: "status", values: ["closed"] }] }, FIELDS)
    expect(ids(out)).toEqual(["i3", "i4"]) // i3 在 i4 前 = 输入序，不是值序
    // assignee：i1–i3 缺字段（视同 null）、i4 显式 null —— 含 null 的子句全收
    const nulls = evaluateViewQuery(ROWS, { filter: [{ field: "assignee", values: [null] }] }, FIELDS)
    expect(ids(nulls)).toEqual(["i1", "i2", "i3", "i4"])
    // values 不含 null ⇒ 缺失/null 一律不匹配
    const strict = evaluateViewQuery(ROWS, { filter: [{ field: "assignee", values: ["linmo"] }] }, FIELDS)
    expect(strict).toEqual([])
  })

  it("§5 空 spec：全量、原序、新数组（元素同引用，不突变入参）", () => {
    const out = evaluateViewQuery(ROWS, {}, FIELDS)
    expect(out).not.toBe(ROWS) // 返回的是拷贝，不是原数组
    expect(out).toEqual([...ROWS])
    expect(out[0]).toBe(ROWS[0]) // 行对象是同引用（浅拷贝）
    const sorted = evaluateViewQuery(ROWS, { sort: [{ field: "id", dir: "desc" }] }, FIELDS)
    expect(ids(sorted)).toEqual(["i4", "i3", "i2", "i1"])
    expect(ids(ROWS)).toEqual(["i1", "i2", "i3", "i4"]) // 入参没被 sort 原地重排
  })
})

describe("ISS-529 · sort：多键、稳定、类型化比较、null 位置语义", () => {
  it("§6 null 排最后（asc）/ 最前（desc）；全 null 的字段保原序", () => {
    // 专用行集：assignee 有值有 null，才有位置区分度（ROWS 的 assignee 全 null）
    const rows: readonly ViewRow[] = [
      { id: "a", assignee: "lin" },
      { id: "b", assignee: null },
      { id: "c", assignee: "iris" },
    ]
    const asc = evaluateViewQuery(rows, { sort: [{ field: "assignee", dir: "asc" }] }, FIELDS)
    expect(ids(asc)).toEqual(["c", "a", "b"]) // iris < lin < null（null 恒最后）
    const desc = evaluateViewQuery(rows, { sort: [{ field: "assignee", dir: "desc" }] }, FIELDS)
    expect(ids(desc)).toEqual(["b", "a", "c"]) // desc = 全序反转 ⇒ null 最前、lin > iris
    // 全 null ⇒ 全平 ⇒ 稳定排序保输入序
    const flat = evaluateViewQuery(ROWS, { sort: [{ field: "assignee", dir: "asc" }] }, FIELDS)
    expect(ids(flat)).toEqual(["i1", "i2", "i3", "i4"])
  })

  it("§7 多键：第一键平则第二键定序；键全平保输入序（稳定排序）", () => {
    // ⚠️ string 字段的 desc 是字典序反转（无业务语义）：priority desc ⇒ "low" 组在前，
    // status asc ⇒ "closed" 在 "open" 前 —— 期望值按此推导，不按 high/low 的语义直觉。
    const out = evaluateViewQuery(ROWS, { sort: [{ field: "priority", dir: "desc" }, { field: "status", dir: "asc" }] }, FIELDS)
    expect(ids(out)).toEqual(["i4", "i2", "i3", "i1"])
    // 键全平：三行同 priority ⇒ 输入序不动
    const flat = evaluateViewQuery(
      [ROWS[0]!, ROWS[2]!, ROWS[1]!],
      { sort: [{ field: "priority", dir: "asc" }] },
      FIELDS,
    )
    expect(ids(flat)).toEqual(["i1", "i3", "i2"])
  })

  it("§8 类型化比较：number 数值序（10 在 2 后）、boolean 双向、string 字典序、同值平局保序", () => {
    expect(ids(evaluateViewQuery(ROWS, { sort: [{ field: "points", dir: "asc" }] }, FIELDS))).toEqual(["i2", "i3", "i1", "i4"])
    // false(i1) < false(i2) 平 ⇒ 保序，true(i3) < null(i4)：null 恒最后
    expect(ids(evaluateViewQuery(ROWS, { sort: [{ field: "done", dir: "asc" }] }, FIELDS))).toEqual(["i1", "i2", "i3", "i4"])
    expect(ids(evaluateViewQuery(ROWS, { sort: [{ field: "id", dir: "asc" }] }, FIELDS))).toEqual(["i1", "i2", "i3", "i4"])
    // boolean 双向：true vs false ⇒ +1（desc 走 -1 之外的另一半），同值平局 ⇒ 0 保序
    const bools: readonly ViewRow[] = [{ id: "t", b: true }, { id: "f", b: false }, { id: "t2", b: true }]
    expect(ids(evaluateViewQuery(bools, { sort: [{ field: "b", dir: "asc" }] }, { b: "boolean" }))).toEqual(["f", "t", "t2"])
    expect(ids(evaluateViewQuery(bools, { sort: [{ field: "b", dir: "desc" }] }, { b: "boolean" }))).toEqual(["t", "t2", "f"])
    // number / string 同值平局 ⇒ 比较返回 0 ⇒ 稳定排序保输入序
    const numTie: readonly ViewRow[] = [{ id: "a", n: 5 }, { id: "b", n: 5 }]
    expect(ids(evaluateViewQuery(numTie, { sort: [{ field: "n", dir: "asc" }] }, { n: "number" }))).toEqual(["a", "b"])
    const strTie: readonly ViewRow[] = [{ id: "a", s: "x" }, { id: "b", s: "x" }]
    expect(ids(evaluateViewQuery(strTie, { sort: [{ field: "s", dir: "desc" }] }, { s: "string" }))).toEqual(["a", "b"])
  })
})

describe("ISS-529 · 类型化错误与词表外兜底", () => {
  it("§9 未知字段 fail fast：filter / sort 引用目录外的键即抛（空行集也抛）", () => {
    for (const spec of [
      { filter: [{ field: "nope", values: ["x"] }] },
      { sort: [{ field: "nope", dir: "asc" }] },
    ]) {
      let caught: unknown
      try {
        evaluateViewQuery([], spec, FIELDS)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ViewQueryError)
      expect((caught as ViewQueryError).code).toBe("VIEW_QUERY_UNKNOWN_FIELD")
      expect((caught as Error).message).toContain('"nope"')
    }
  })

  it("§10 行值类型与目录不符：三档（number/string/boolean）比较时都抛（null 不触发）", () => {
    const cases: readonly [ViewFieldCatalog, readonly ViewRow[]][] = [
      [{ points: "number" }, [{ id: "a", points: "5" }, { id: "b", points: 3 }]],
      [{ name: "string" }, [{ id: "a", name: 1 }, { id: "b", name: "x" }]],
      [{ flag: "boolean" }, [{ id: "a", flag: "yes" }, { id: "b", flag: true }]],
    ]
    for (const [fields, rows] of cases) {
      const field = Object.keys(fields)[0]!
      let caught: unknown
      try {
        evaluateViewQuery(rows, { sort: [{ field, dir: "asc" }] }, fields)
      } catch (error) {
        caught = error
      }
      expect(caught, `field=${field}`).toBeInstanceOf(ViewQueryError)
      expect((caught as ViewQueryError).code, `field=${field}`).toBe("VIEW_QUERY_FIELD_TYPE_MISMATCH")
      expect((caught as Error).message, `field=${field}`).toContain(`"${field}"`)
    }
    // null 行值走排位语义不炸：只有一行非 null，比较对象是 null ⇒ 不进类型检查
    expect(() =>
      evaluateViewQuery([{ x: null }, { x: 1 }], { sort: [{ field: "x", dir: "asc" }] }, { x: "number" }),
    ).not.toThrow()
  })

  it("§11 目录里的词表外类型（如 date）：compareValues 走 assertNever 兜底", () => {
    const bogusCatalog = { x: "date" } as unknown as ViewFieldCatalog
    let caught: unknown
    try {
      evaluateViewQuery([{ x: "a" }, { x: "b" }], { sort: [{ field: "x", dir: "asc" }] }, bogusCatalog)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UnhandledBlockTypeError)
    expect((caught as Error).message).toBe('unhandled BlockType: "date"')
  })

  it("§12 ViewQueryError 可独立构造：instanceof、name、code", () => {
    const error = new ViewQueryError("detail", "VIEW_QUERY_UNKNOWN_FIELD")
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ViewQueryError)
    expect(error.name).toBe("ViewQueryError")
    expect(error.code).toBe("VIEW_QUERY_UNKNOWN_FIELD")
    expect(error.message).toBe("detail")
  })
})

describe("ISS-529 · limit 与执行器接缝", () => {
  it("§13 limit 在 sort 之后截断；不小于行数则全量", () => {
    // priority asc = 字典序："high" 组在前（high < low），截 2 ⇒ high 组两行
    const out = evaluateViewQuery(
      ROWS,
      { sort: [{ field: "priority", dir: "asc" }], limit: 2 },
      FIELDS,
    )
    expect(ids(out)).toEqual(["i1", "i3"])
    expect(evaluateViewQuery(ROWS, { limit: 99 }, FIELDS)).toHaveLength(4)
  })

  it("§14 ViewQueryExecutor 接缝可满足，语义等价 evaluateViewQuery(loadRows(), spec, fields)", () => {
    const executor: ViewQueryExecutor = {
      fields: FIELDS,
      loadRows: () => ROWS,
      execute: (spec) => evaluateViewQuery(ROWS, spec, FIELDS),
    }
    const spec = { filter: [{ field: "status", values: ["open"] }], sort: [{ field: "id", dir: "desc" }] }
    expect(ids(executor.execute(spec))).toEqual(
      ids(evaluateViewQuery(executor.loadRows(), spec, executor.fields)),
    )
    expect(ids(executor.execute(spec))).toEqual(["i2", "i1"])
  })
})
