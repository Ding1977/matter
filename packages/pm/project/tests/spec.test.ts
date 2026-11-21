/**
 * `ProjectProps` 与 `ProjectDomain` 的契约。
 *
 * 本文件判三件事，每件都写成「换成正例以外的实现就红」的形态：
 *
 * 1. **schema 真的在拦** —— 不是「字段名对了」，是非法值必须抛 `ZodError`，
 *    且 `issues[].path` 要指到坏掉的那个字段。
 * 2. **`defineDomain` 的四类加载期自检真的跑过** —— `ProjectDomain` 是模块加载期产出的常量，
 *    它存在本身就证明那四条全过了。
 * 3. **派生字段真的不在 schema 里**（本单的设计判断①）：`milestones` / `phases` 传进来
 *    必须被 `strictObject` 拒。这条是「有一天有人顺手把派生视图塞回 schema」的哨兵 ——
 *    那会锁死 P9 迁移（存量 `phases` 是字符串数组，见 `spec.ts` 头注）。
 *
 * @module @matter/project/tests/spec
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  PROJECT_HEALTHS, PROJECT_PRIORITIES, PROJECT_STATUSES, PROJECT_TABLE,
  ProjectDomain, ProjectPatch, ProjectProps,
} from "../src/index.ts"

/** 一条合法的项目（只给必填三项）。 */
const minimal = () => ({ id: "PRJ-1", title: "示例项目", status: "active", created: "2026-11-17" })

/** 10 个核心字段全填。 */
const full = () => ({
  ...minimal(),
  priority: "high",
  health: "on-track",
  lead: "linmo",
  startDate: "2026-11-01",
  targetDate: "2026-12-31",
  goal: "把这条域跑通",
  tags: ["area/重构", "topic/数据"],
})

describe("ProjectProps：10 个核心字段 + created（11 个）", () => {
  it("最小合法记录只填 4 个必填项，可选字段缺省就是没有", () => {
    const parsed = ProjectProps.parse(minimal())
    // ⛔ 断言「键不存在」而不是「值为 undefined」：可选字段被默认值材料化时
    //    `key in record` 会变 true，而 PATCH 语义会因此把别的字段写空。
    for (const optional of ["priority", "health", "lead", "startDate", "targetDate", "goal", "tags"]) {
      expect(parsed).not.toHaveProperty(optional)
    }
    expect(Object.keys(parsed).sort()).toEqual(["created", "id", "status", "title"])
  })

  it("11 个字段全部可读出且类型对", () => {
    const record = full()
    const parsed = ProjectProps.parse(record)
    expect(parsed).toEqual(record)
    // 10 个核心字段（任务书）+ `created`（旧树通用 immutable 字段，实测 25/26 有值，PATCH 面靠它 omit）
    expect(Object.keys(ProjectProps.shape)).toHaveLength(11)
    expect(PROJECT_TABLE).toBe("project")
    expect(ProjectDomain.name).toBe("pm_project")
    expect(ProjectDomain.version).toBe(1)
    expect(Object.keys(ProjectDomain.tables)).toEqual([PROJECT_TABLE])
  })

  it("校验失败报 zod error，且 path 指到坏字段", () => {
    // ⛔ 被测行为：`spec.ts` 的 `z.strictObject(...)`。换成 `z.object` 则第 ③ 条断言变红
    //    （未知键会被静默丢弃 —— 一个拼错的字段名从此不报错也不生效）。
    const bad = ProjectProps.safeParse({ ...minimal(), status: "zap" })
    expect(bad.success).toBe(false)
    if (bad.success) return
    expect(bad.error).toBeInstanceOf(z.ZodError)
    // ① 状态不在词表里 ⇒ 指到 status
    expect(bad.error.issues[0]!.path).toEqual(["status"])
    // ② id 不合形状 ⇒ 指到 id（`PRJ-` / `prj-1` / 空串 / ISS 号都拒）
    for (const id of ["PRJ", "prj-1", "PRJ-", "", "ISS-1"]) {
      const r = ProjectProps.safeParse({ ...minimal(), id })
      expect(r.success, `id=${JSON.stringify(id)} 不该通过`).toBe(false)
    }
    // ③ 未知键 ⇒ 报 unrecognized_keys（不是静默丢弃）
    const unknown = ProjectProps.safeParse({ ...minimal(), 拼错的字段: 1 })
    expect(unknown.success).toBe(false)
    if (unknown.success) return
    expect(unknown.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true)
  })

  it("三张词表与旧树逐字一致；空标题 / 非法日期被拒", () => {
    expect([...PROJECT_STATUSES]).toEqual(["planned", "active", "paused", "completed", "archived"])
    expect([...PROJECT_HEALTHS]).toEqual(["on-track", "at-risk", "off-track"])
    expect([...PROJECT_PRIORITIES]).toEqual(["urgent", "high", "medium", "low", "none"])
    expect(ProjectProps.safeParse({ ...minimal(), title: "" }).success).toBe(false)
    expect(ProjectProps.safeParse({ ...minimal(), targetDate: "2026-13-01" }).success).toBe(false)
    expect(ProjectProps.safeParse({ ...minimal(), created: "17/11/2026" }).success).toBe(false)
    expect(ProjectProps.safeParse({ ...minimal(), health: "healthy" }).success).toBe(false)
  })
})

describe("派生视图不进 schema（设计判断①的哨兵）", () => {
  it("milestones / phases 传进来被拒 —— 它们是读侧归一，不是存储字段", () => {
    // ⛔ 被测行为：`spec.ts` 的字段清单里**故意没有**这两个。
    //    把它们加回 schema ⇒ 本用例变红。为什么不该加回，见 spec.ts 头注①：
    //    存量 `phases` 是**字符串数组**（`$DSH_HOME/pm/projects/2026-10-25-PRJ-023…md` 实测），
    //    归一成 `{id,name}` 后再进 schema，那批存量就过不了校验 ⇒ 整域 open 拒绝。
    expect(ProjectProps.safeParse({ ...minimal(), milestones: [{ id: "ms-1", name: "节点" }] }).success).toBe(false)
    expect(ProjectProps.safeParse({ ...minimal(), phases: ["一期"] }).success).toBe(false)
    // 反例的另一半：它们不是「字段存在但值为空」，是**键不存在**
    expect("milestones" in ProjectProps.shape).toBe(false)
    expect("phases" in ProjectProps.shape).toBe(false)
  })
})

describe("字段元数据（.meta()）", () => {
  it("每个字段都带 writable / widget / indexable 三件元数据", () => {
    // ⛔ 被测行为：`spec.ts` 里每个 `z.*().meta({...})` 且 `.meta()` 在链**最后**。
    //    写成 `.meta({…}).optional()` ⇒ `meta()` 在上层读回 undefined ⇒ 这条红。
    const shape = ProjectProps.shape as Record<string, z.ZodType>
    const fields = Object.keys(shape)
    expect(fields).toHaveLength(11)
    for (const field of fields) {
      const meta = shape[field]!.meta() as Record<string, unknown> | undefined
      expect(meta, `${field} 缺 .meta()`).toBeDefined()
      expect(meta!.writable, `${field}.writable`).toBeDefined()
      expect(meta!.widget, `${field}.widget`).toBeDefined()
      expect(meta!.indexable, `${field}.indexable`).toBeDefined()
    }
    // 不可变字段的档位是 `immutable`（PATCH 面靠 `ProjectPatch` 移除它们，两处口径一致）
    expect((shape.id!.meta() as { writable: string }).writable).toBe("immutable")
    expect((shape.created!.meta() as { writable: string }).writable).toBe("immutable")
    // `goal` 是 system 写档（旧树 `domain.js:462`）
    expect((shape.goal!.meta() as { writable: string }).writable).toBe("system")
    // `health` 可筛选（旧树列表页按它分组/排序），status 不可
    expect((shape.health!.meta() as { indexable: boolean }).indexable).toBe(true)
    expect((shape.status!.meta() as { indexable: boolean }).indexable).toBe(false)
  })

  it("z.toJSONSchema 保留 meta —— 前端拿字段描述不需要第二处真相", () => {
    // ⛔ 这条是「将来出前端字段描述时会不会炸」的哨兵。含 `.transform()` 的 schema 会抛。
    const json = z.toJSONSchema(ProjectProps) as {
      properties: Record<string, Record<string, unknown>>
    }
    expect(json.properties.id!.writable).toBe("immutable")
    expect(json.properties.title!.widget).toBe("text")
    expect(json.properties.lead!.widget).toBe("person")
    expect(json.properties.tags!.widget).toBe("tags")
    expect(json.properties.health!.widget).toBe("select")
    expect(json.properties.status!.enum).toEqual([...PROJECT_STATUSES])
    expect(json.properties.health!.enum).toEqual([...PROJECT_HEALTHS])
    // 往返也保留（同一个 schema 连算两次得到同样的 meta）
    expect(JSON.stringify(z.toJSONSchema(ProjectProps))).toBe(JSON.stringify(json))
  })
})

describe("ProjectPatch：PATCH 面", () => {
  it("只给一个字段即可；不可变字段传进来要报错（不是静默忽略）", () => {
    expect(ProjectPatch.parse({ title: "新标题" })).toEqual({ title: "新标题" })
    // id / created 已从 PATCH 面移除 ⇒ strict 报表未识别键。
    // ⛔ 若把 `omit` 删掉而只靠 `partial`，这两条会变成「静默接受、静默丢弃」，断言红。
    expect(ProjectPatch.safeParse({ id: "PRJ-2" }).success).toBe(false)
    expect(ProjectPatch.safeParse({ created: "2026-01-01" }).success).toBe(false)
    expect(ProjectPatch.safeParse({ 拼错的字段: 1 }).success).toBe(false)
  })

  it("空 PATCH 合法（= 不改），非法值仍然被拦", () => {
    expect(ProjectPatch.parse({})).toEqual({})
    expect(ProjectPatch.safeParse({ status: "zap" }).success).toBe(false)
    expect(ProjectPatch.safeParse({ title: "" }).success).toBe(false)
  })
})
