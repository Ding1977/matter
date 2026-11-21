/**
 * `IssueProps` 与 `IssueDomain` 的契约。
 *
 * 本节判两件事，每件都写成「换成正例以外的实现就红」的形态：
 *
 * 1. **schema 真的在拦** —— 不是「字段名对了」，是非法值必须抛 `ZodError`，
 *    且 `issues[].path` 要指到坏掉的那个字段（否则调用方只能人读消息猜）。
 * 2. **`defineDomain` 的四类加载期自检真的跑过** —— `IssueDomain` 是模块加载期
 *    产出的常量，它存在本身就证明那四条全过了；`StorageDomainError` 的反例见
 *    `storage-domain` 的用例，本文件不重复判它，只判「本品实例真的过得了」。
 *
 * @module @matter/issue/tests/spec
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  ISSUE_KINDS, ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TABLE,
  IssueDomain, IssuePatch, IssueProps,
} from "../src/index.ts"

/** 一条合法的工单（只给必填四项）。 */
const minimal = () => ({ id: "ISS-1", title: "示例", status: "todo", kind: "feature", created: "2026-11-17" })

describe("IssueProps：12 个核心字段", () => {
  it("最小合法记录只填 5 个必填项，可选字段缺省就是没有", () => {
    const parsed = IssueProps.parse(minimal())
    // ⛔ 断言「键不存在」而不是「值为 undefined」：可选字段被默认值材料化时
    //    `key in record` 会变 true，而 PATCH 语义会因此把别的字段写空。
    for (const optional of ["priority", "assignee", "due", "project", "parent", "tags", "body"]) {
      expect(parsed).not.toHaveProperty(optional)
    }
    expect(Object.keys(parsed).sort()).toEqual(["created", "id", "kind", "status", "title"])
  })

  it("12 个核心字段全部可读出且类型对", () => {
    const full = {
      ...minimal(),
      priority: "urgent",
      assignee: "builder-e0",
      due: "2026-11-20",
      project: "PRJ-1",
      parent: "ISS-517",
      tags: ["type/feature", "area/重构"],
      body: "## 正文\n第二行",
    }
    const parsed = IssueProps.parse(full)
    expect(parsed).toEqual(full)
    expect(ISSUE_TABLE).toBe("issue")
    expect(IssueDomain.name).toBe("pm_issue")
    expect(IssueDomain.version).toBe(1)
    expect(Object.keys(IssueDomain.tables)).toEqual([ISSUE_TABLE])
  })

  it("校验失败报 zod error，且 path 指到坏字段", () => {
    // ⛔ 被测行为：`spec.ts` 的 `z.strictObject(...)`。换成 `z.object` 则第 ③ 条断言变红
    //    （未知键会被静默丢弃 —— 一个拼错的字段名从此不报错也不生效）。
    const bad = IssueProps.safeParse({ ...minimal(), status: "zap" })
    expect(bad.success).toBe(false)
    if (bad.success) return
    expect(bad.error).toBeInstanceOf(z.ZodError)
    // ① 状态不在词表里 ⇒ 指到 status
    expect(bad.error.issues[0]!.path).toEqual(["status"])
    // ② id 不合形状 ⇒ 指到 id（`ISSUE-1` / `iss-1` / 空串都拒）
    for (const id of ["ISS", "iss-1", "ISS-", ""]) {
      const r = IssueProps.safeParse({ ...minimal(), id })
      expect(r.success, `id=${JSON.stringify(id)} 不该通过`).toBe(false)
    }
    // ③ 未知键 ⇒ 报 unrecognized_keys（不是静默丢弃）
    const unknown = IssueProps.safeParse({ ...minimal(), 拼错的字段: 1 })
    expect(unknown.success).toBe(false)
    if (unknown.success) return
    expect(unknown.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true)
  })

  it("三个词表与旧树逐字一致；空标题 / 非法日期被拒", () => {
    expect([...ISSUE_STATUSES]).toEqual([
      "backlog", "todo", "in_progress", "in_review", "done", "canceled", "duplicate",
    ])
    expect([...ISSUE_PRIORITIES]).toEqual(["urgent", "high", "medium", "low", "none"])
    expect([...ISSUE_KINDS]).toEqual(["feature", "bug", "question"])
    expect(IssueProps.safeParse({ ...minimal(), title: "" }).success).toBe(false)
    expect(IssueProps.safeParse({ ...minimal(), due: "2026-13-01" }).success).toBe(false)
    expect(IssueProps.safeParse({ ...minimal(), created: "17/11/2026" }).success).toBe(false)
  })
})

describe("字段元数据（.meta()）", () => {
  it("每个字段都带 writable / widget / indexable 三件元数据", () => {
    // ⛔ 被测行为：`spec.ts` 里每个 `z.*().meta({...})`。删掉任一处 ⇒ 这条红。
    const shape = IssueProps.shape as Record<string, z.ZodType>
    const fields = Object.keys(shape)
    expect(fields).toHaveLength(12)
    for (const field of fields) {
      const meta = shape[field]!.meta() as Record<string, unknown> | undefined
      expect(meta, `${field} 缺 .meta()`).toBeDefined()
      expect(meta!.writable, `${field}.writable`).toBeDefined()
      expect(meta!.widget, `${field}.widget`).toBeDefined()
      expect(meta!.indexable, `${field}.indexable`).toBeDefined()
    }
    // 不可变字段的档位是 `immutable`（PATCH 面靠 `IssuePatch` 移除它们，两处口径一致）
    expect((shape.id!.meta() as { writable: string }).writable).toBe("immutable")
    expect((shape.created!.meta() as { writable: string }).writable).toBe("immutable")
    expect((shape.kind!.meta() as { writable: string }).writable).toBe("system")
  })

  it("z.toJSONSchema 保留 meta —— 前端拿字段描述不需要第二处真相", () => {
    // ⛔ 这条是「将来出前端字段描述时会不会炸」的哨兵。zod 实测：`toJSONSchema()` 在
    //    默认 io 下**保留** meta，但含 `.transform()` 的 schema 会抛。故本 schema
    //    一个 `.transform()` 都没有（brand 走 `meta.branded`，见 spec.ts 头注）。
    const json = z.toJSONSchema(IssueProps) as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(json.properties.id!.writable).toBe("immutable")
    expect(json.properties.title!.widget).toBe("text")
    expect(json.properties.status!.enum).toEqual([...ISSUE_STATUSES])
    // 往返也保留（同一个 schema 连算两次得到同样的 meta）
    expect(JSON.stringify(z.toJSONSchema(IssueProps))).toBe(JSON.stringify(json))
  })
})

describe("IssuePatch：PATCH 面", () => {
  it("只给一个字段即可；不可变字段传进来要报错（不是静默忽略）", () => {
    expect(IssuePatch.parse({ title: "新标题" })).toEqual({ title: "新标题" })
    // id / created 已从 PATCH 面移除 ⇒ strict 报表未识别键。
    // ⛔ 若把 `omit` 删掉而只靠 `partial`，这两条会变成「静默接受、静默丢弃」，断言红。
    expect(IssuePatch.safeParse({ id: "ISS-2" }).success).toBe(false)
    expect(IssuePatch.safeParse({ created: "2026-01-01" }).success).toBe(false)
    expect(IssuePatch.safeParse({ 拼错的字段: 1 }).success).toBe(false)
  })

  it("空 PATCH 合法（= 不改），非法值仍然被拦", () => {
    expect(IssuePatch.parse({})).toEqual({})
    expect(IssuePatch.safeParse({ status: "zap" }).success).toBe(false)
    expect(IssuePatch.safeParse({ title: "" }).success).toBe(false)
  })
})
