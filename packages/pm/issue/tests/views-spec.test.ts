/**
 * ViewConfig schema 的契约（ISS-535）。
 *
 * 每件都写成「换成正例以外的实现就红」的形态：
 *   1. 非法形态（type 不在六值）被 zod 拒且 path 点名 type；
 *   2. 非法字段（filter/sort/group.field 不是 issue 已声明字段）被拒且点名 field；
 *   3. strictObject 拒未知键（拼错的字段不静默丢弃）；
 *   4. `.meta()` 与 `z.toJSONSchema()` 保留字段元数据（前端不再维护第二处真相）。
 *
 * ## 变异牙（删一条校验 ⇒ 必红）
 *   · 把 `type: z.enum(VIEW_TYPES)` 换成 `z.string()` ⇒ 用例「非法形态」红；
 *   · 把 `ViewField` 的 refine 删掉 ⇒ 用例「非法字段」红；
 *   · 把 `z.strictObject` 换成 `z.object` ⇒ 用例「未知键」红；
 *   · 删掉任一 `.meta()` ⇒ 用例「字段元数据」红。
 *
 * @module @matter/issue/tests/views-spec
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  FILTER_LOGICS, FILTER_OPS, SORT_DIRS, VIEW_TYPES,
  FilterGroup, GroupRule, SortRule, ViewConfig, ViewConfigList, ViewField,
  minimalView,
} from "../src/views/index.ts"

describe("ViewConfig：第一批 6 字段", () => {
  it("最小视图配置只填六字段，类型都对", () => {
    const view = minimalView("v1", "全部需求")
    expect(ViewConfig.parse(view)).toEqual(view)
    expect(Object.keys(view).sort()).toEqual(["filter", "group", "id", "name", "sort", "type"])
  })

  it("六个字段全部可读出；词表与旧树/DOC-512 逐字一致", () => {
    const full = {
      id: "v2",
      name: "我的看板",
      type: "board",
      filter: { logic: "and", conditions: [{ field: "status", op: "eq", value: "todo" }] },
      sort: [{ field: "priority", dir: "asc" as const }],
      group: [{ field: "status" }],
    }
    expect(ViewConfig.parse(full)).toEqual(full)
    expect([...VIEW_TYPES]).toEqual(["list", "table", "board", "timeline", "card", "calendar"])
    expect([...FILTER_LOGICS]).toEqual(["and", "or"])
    expect([...SORT_DIRS]).toEqual(["asc", "desc"])
    expect(FILTER_OPS).toContain("eq")
  })

  it("必然失败：非法形态被拒且 path 点名 type", () => {
    const bad = ViewConfig.safeParse({ ...minimalView("v3", "x"), type: "gantt" })
    expect(bad.success).toBe(false)
    if (bad.success) return
    expect(bad.error).toBeInstanceOf(z.ZodError)
    expect(bad.error.issues[0]!.path).toEqual(["type"])
  })

  it("必然失败：非法字段被拒且 path 点名 field（filter/sort/group 三处）", () => {
    const base = minimalView("v4", "x")
    const cases = [
      { ...base, filter: { logic: "and", conditions: [{ field: "不存在的字段", op: "eq" }] } },
      { ...base, sort: [{ field: "bogus", dir: "asc" }] },
      { ...base, group: [{ field: "bogus" }] },
    ]
    for (const bad of cases) {
      const r = ViewConfig.safeParse(bad)
      expect(r.success, JSON.stringify(bad)).toBe(false)
      if (r.success) continue
      // 断言 path 链里出现 'field'（可能嵌在数组/conditions 下）。
      expect(r.error.issues.some((i) => i.path.includes("field"))).toBe(true)
    }
  })

  it("必然失败：strictObject 拒未知键（拼错的字段不静默丢弃）", () => {
    const bad = ViewConfig.safeParse({ ...minimalView("v5", "x"), 拼错的字段: 1 })
    expect(bad.success).toBe(false)
    if (bad.success) return
    expect(bad.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true)
  })

  it("必然失败：子结构也是 strictObject（filter 里的未知键被拒）", () => {
    const bad = FilterGroup.safeParse({ logic: "and", conditions: [], bogus: true })
    expect(bad.success).toBe(false)
    expect(SortRule.safeParse({ field: "status", dir: "up" }).success).toBe(false)
    expect(GroupRule.safeParse({ field: "status", bogus: 1 }).success).toBe(false)
  })

  it("ViewField 只认 issue 已声明字段（id/title/status 过，bogus 不过）", () => {
    for (const ok of ["id", "title", "status", "priority", "body"]) {
      expect(ViewField.safeParse(ok).success, ok).toBe(true)
    }
    expect(ViewField.safeParse("bogus").success).toBe(false)
  })

  it("ViewConfigList 整单元校验：空数组合法，含非法项拒绝", () => {
    expect(ViewConfigList.parse([])).toEqual([])
    expect(ViewConfigList.safeParse([minimalView("v6", "x")]).success).toBe(true)
    expect(ViewConfigList.safeParse([{ ...minimalView("v7", "x"), type: "gantt" }]).success).toBe(false)
  })
})

describe("字段元数据（.meta()）", () => {
  it("六个字段都带 widget + indexable 元数据", () => {
    const shape = ViewConfig.shape as Record<string, z.ZodType>
    expect(Object.keys(shape)).toHaveLength(6)
    for (const field of Object.keys(shape)) {
      const meta = shape[field]!.meta() as Record<string, unknown> | undefined
      expect(meta, `${field} 缺 .meta()`).toBeDefined()
      expect(meta!.widget, `${field}.widget`).toBeDefined()
      expect(meta!.indexable, `${field}.indexable`).toBeDefined()
    }
  })

  it("z.toJSONSchema 保留 meta —— 前端不必维护第二份字段描述", () => {
    const json = z.toJSONSchema(ViewConfig) as { properties: Record<string, Record<string, unknown>> }
    expect(json.properties.id!.widget).toBe("text")
    expect(json.properties.type!.enum).toEqual([...VIEW_TYPES])
    expect(JSON.stringify(z.toJSONSchema(ViewConfig))).toBe(JSON.stringify(json))
  })
})
