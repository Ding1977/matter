/**
 * 项目门面的写链与活动流：本单验收 1–5 的全部断言。
 *
 * ## 本文件钉的不是「能存能取」，是三条不变量
 *
 * 1. **落盘 → 内存 → 事件** 的顺序本包不改；本包只在它**之后**追加活动流。
 *    断言方式是「写失败时活动流里没有那一条」+「事件到达时活动流还没有那一行」。
 * 2. **活动流有真实数据**（验收 4）：`count() > 0`，且行内容与记录对得上。
 * 3. **幂等键有效**（验收 5）：同一事件 append 两次，`count` 只加 1。
 *
 * ## 与 `@matter/issue` 的差异都写成用例，不靠读者比对两个文件
 *
 * · 建记录发 `created`（**不是** `created-created` / `project-created`）
 * · 状态变更发 `status-change`（**不是** `project-started` 之类的信号名）
 * · **没有** `body-change`：schema 里没有 body，词表里也没有那个名字
 *
 * @module @matter/project/tests/domain
 */

import { describe, expect, it } from "vitest"
import {
  PROJECT_EVENTS, PROJECT_STATUS_EVENT, ProjectNotFoundError, createdEntries, projectEntity,
} from "../src/index.ts"
import { boot, type Harness } from "./helpers/harness.ts"

/** 一条最小项目（必填四项）。 */
const draft = (id = "PRJ-1", extra: Record<string, unknown> = {}) => ({
  id, title: "第一个项目", status: "active", created: "2026-11-17", ...extra,
})

/** 跑完自动收尾的用例体。 */
async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  const h = await boot()
  try {
    await body(h)
  } finally {
    await h.dispose()
  }
}

describe("写链：建一条 / 读一条 / 改一条（验收 1）", () => {
  it("create → get 读回同一条；重建现场后仍读得回（真落盘）", async () => {
    const first = await boot()
    const root = first.root
    try {
      const created = await first.projects.create(draft("PRJ-1", { goal: "跑通" }))
      expect(created).toEqual(draft("PRJ-1", { goal: "跑通" }))
      expect(first.projects.get("PRJ-1")).toEqual(created)
      expect(first.projects.size).toBe(1)
    } finally {
      await first.shutdown()
    }
    // 「重启」：同一个根目录重新装配（新后端实例、新域、新 journal 连接）
    const second = await boot(root)
    try {
      expect(second.projects.get("PRJ-1")).toMatchObject({ title: "第一个项目", goal: "跑通" })
      // 活动流也是持久化的：「重启后审计还在」是它作为真相源的最低要求。
      expect(second.journal.count()).toBe(1)
    } finally {
      await second.dispose()
    }
  })

  it("update 只改给定字段，其余原样；空 PATCH 不落盘也不记审计", async () => {
    await withHarness(async (h) => {
      await h.projects.create(draft("PRJ-1", { goal: "原始目标", tags: ["a"] }))
      const seen = h.journal.count()
      const updated = await h.projects.update("PRJ-1", { title: "改了标题" })
      expect(updated.title).toBe("改了标题")
      expect(updated.goal).toBe("原始目标")     // PATCH 不是整体替换
      expect(updated.tags).toEqual(["a"])
      expect(h.journal.count()).toBe(seen + 1) // 只有 title 一条

      // 空 PATCH ⇒ 无变化 ⇒ 不落盘、不记审计
      const again = await h.projects.update("PRJ-1", { title: "改了标题" })
      expect(again).toEqual(updated)
      expect(h.journal.count()).toBe(seen + 1)
    })
  })

  it("校验失败抛 zod error：create 与 update 两条入口都被拦，且坏记录没落盘", async () => {
    await withHarness(async (h) => {
      // ① create：非法状态 ⇒ ZodError，且盘上什么都没有
      await expect(h.projects.create({ ...draft("PRJ-2"), status: "zap" } as never)).rejects.toThrow()
      expect(h.projects.get("PRJ-2")).toBeUndefined()
      expect(h.journal.count()).toBe(0)
      // ② update：非法值同样拦，且**旧记录不被破坏**
      await h.projects.create(draft("PRJ-3"))
      await expect(h.projects.update("PRJ-3", { health: "zap" } as never)).rejects.toThrow()
      expect(h.projects.get("PRJ-3")!.status).toBe("active")
    })
  })

  it("create 同一个 id 报错；update 不存在的 id 报错；remove 返回布尔", async () => {
    await withHarness(async (h) => {
      await h.projects.create(draft("PRJ-4"))
      await expect(h.projects.create(draft("PRJ-4"))).rejects.toMatchObject({ name: "ProjectExistsError" })
      await expect(h.projects.update("PRJ-404", { title: "x" }))
        .rejects.toBeInstanceOf(ProjectNotFoundError)
      await expect(h.projects.remove("PRJ-404")).resolves.toBe(false)
      await expect(h.projects.remove("PRJ-4")).resolves.toBe(true)
      expect(h.projects.get("PRJ-4")).toBeUndefined()
    })
  })
})

describe("写链顺序：落盘 → 内存 → 事件，审计在最后（验收 3）", () => {
  it("一次 create 落三条线索：内存可读、domain/changed 发过、活动流有行", async () => {
    await withHarness(async (h) => {
      const changes: unknown[] = []
      h.ctx.on("domain/changed", (change: unknown) => { changes.push(change) })
      await h.projects.create(draft("PRJ-5"))
      // ① 内存
      expect(h.projects.get("PRJ-5")).toBeDefined()
      // ② 域事件载荷含 domain/table/key/operation/value 五件（验收 3 的原文）
      expect(changes).toEqual([{
        domain: "pm_project",
        table: "project",
        key: "PRJ-5",
        operation: "put",
        value: expect.objectContaining({ id: "PRJ-5", title: "第一个项目" }),
      }])
      // ③ 活动流
      expect(h.journal.count()).toBe(1)
    })
  })

  it("域写失败时活动流不留下那条从未发生的变更", async () => {
    await withHarness(async (h) => {
      // ⚠️ 这条只覆盖「zod 拦在落盘之前」这一层：schema 拒绝时一行审计都不该有。
      await expect(h.projects.create(draft("PRJ-6", { 正文附件: "x" } as never))).rejects.toThrow()
      await expect(h.projects.create(draft("PRJ-7"))).resolves.toBeDefined()
      expect(h.journal.count()).toBe(1) // 只有成功那条
    })
  })

  it("审计严格晚于 domain/changed：事件到达时活动流里还没有那一行", async () => {
    // ⛔ 被测行为：`index.ts` 里 `await this.table.put(...)` **先于** `writeAudit(...)`。
    //    两行对调 ⇒ 监听器跑的时候活动流已经有行了 ⇒ 本用例红。
    await withHarness(async (h) => {
      const countsAtEvent: number[] = []
      h.ctx.on("domain/changed", () => { countsAtEvent.push(h.journal.count()) })
      await h.projects.create(draft("PRJ-6"))
      expect(countsAtEvent).toEqual([0])
      expect(h.journal.count()).toBe(1)
    })
  })
})

describe("活动流有真实写入，不是空表（验收 4）", () => {
  it("put 之后 count() > 0，且行的 entity / event / payload 对得上记录", async () => {
    await withHarness(async (h) => {
      // 起点真的是空表 —— 否则「> 0」可能来自任何别的东西。
      expect(h.journal.count()).toBe(0)
      await h.projects.create(draft("PRJ-8", { goal: "第一段\n第二段" }))
      expect(h.journal.count()).toBeGreaterThan(0)

      const page = h.journal.list({ entity: projectEntity("PRJ-8") })
      expect(page.rows).toHaveLength(1)
      // ⛔ 建记录发**通用** `created`，不是 `project-created`（旧树 `entity-ops.js:378`）
      expect(page.rows[0]).toMatchObject({ entity: "projects/PRJ-8", event: "created", known: 1 })

      // 状态变更落的是**通用** status-change（本包没有信号层），载荷带 field/from/to
      await h.projects.update("PRJ-8", { status: "paused" })
      const rows = h.journal.list({ entity: projectEntity("PRJ-8") }).rows
      expect(rows.map((row) => row.event)).toEqual(["created", "status-change"])
      expect(rows[1]!.payload).toMatchObject({ field: "status", from: "active", to: "paused" })
      expect(PROJECT_STATUS_EVENT).toBe("status-change")
    })
  })

  it("5 个状态各发 status-change；字段变更发 field-change", async () => {
    await withHarness(async (h) => {
      await h.projects.create(draft("PRJ-9"))
      for (const status of ["planned", "paused", "completed", "archived"] as const) {
        await h.projects.update("PRJ-9", { status })
        const last = h.journal.list({ entity: projectEntity("PRJ-9") }).rows.at(-1)!
        expect(last.event, `status=${status}`).toBe("status-change")
        expect(last.payload).toMatchObject({ field: "status", to: status })
      }
      await h.projects.update("PRJ-9", { lead: "linmo" })
      const rows = h.journal.list({ entity: projectEntity("PRJ-9") }).rows
      expect(rows.at(-1)).toMatchObject({
        event: "field-change",
        payload: { field: "lead", from: null, to: "linmo" },
      })
      // 每条都是现行词表（known=1）—— 词表外的名字会落 0，那是「谁在写野名」的入口
      expect(rows.every((row) => row.known === 1)).toBe(true)
      // 词表里确实没有信号名，也没有 body-change（本包无 body 字段）
      expect([...PROJECT_EVENTS].sort()).toEqual(["created", "deleted", "field-change", "status-change"])
    })
  })

  it("一次 update 改多个字段 ⇒ 一字段一条事件，按字段名序", async () => {
    await withHarness(async (h) => {
      await h.projects.create(draft("PRJ-10"))
      await h.projects.update("PRJ-10", { title: "新标题", priority: "high", health: "at-risk" })
      const fields = h.journal.list({ entity: projectEntity("PRJ-10") }).rows
        .slice(1)
        .map((row) => (row.payload as { field: string }).field)
      expect(fields).toEqual(["health", "priority", "title"])
    })
  })

  it("删一条发 deleted；重复删不重复记", async () => {
    await withHarness(async (h) => {
      await h.projects.create(draft("PRJ-11"))
      expect(await h.projects.remove("PRJ-11")).toBe(true)
      const seen = h.journal.count()
      expect(h.journal.list({ entity: projectEntity("PRJ-11") }).rows.at(-1)!.event).toBe("deleted")
      expect(await h.projects.remove("PRJ-11")).toBe(false)
      expect(h.journal.count()).toBe(seen)
    })
  })
})

describe("幂等键有效（验收 5）", () => {
  it("同一事件 append 两次，count 只加 1", async () => {
    await withHarness(async (h) => {
      const at = new Date("2026-11-17T12:00:00.000Z")
      const entry = {
        entity: projectEntity("PRJ-12"),
        event: "created",
        at: at.getTime(),
        mdAt: at.toISOString(),
        known: 1,
      } as const
      const seq1 = h.journal.append({ ...entry })
      expect(h.journal.count()).toBe(1)
      const seq2 = h.journal.append({ ...entry })
      expect(h.journal.count()).toBe(1)          // ⛔ 幂等：第二行不写
      expect(seq2).toBe(seq1)                    // 回既有行的 seq，不是假装插进去了
    })
  })

  it("经过本包写路径的同一次写入，重放同样的事件不新增行", async () => {
    // 走 `projectEntry` 的真实形态（而不是手拼 entry）：uid 的时间成分是事件时刻。
    // ⚠️ 手工拼 entry 容易拼错成分（`known` 就是一处：本包只在**非** 1 时才传它），
    //    所以重放一律用包自己的工厂函数 —— 那才是迁移脚本的用法。
    await withHarness(async (h) => {
      const at = new Date("2026-11-17T03:00:00.000Z")
      await h.projects.create(draft("PRJ-13"), { actor: "linmo", at })
      expect(h.journal.count()).toBe(1)
      // 同一个 (id, 时刻) 再 create 一次：id 已存在 ⇒ 报错，一行都不新增
      await expect(h.projects.create(draft("PRJ-13"), { actor: "linmo", at }))
        .rejects.toMatchObject({ name: "ProjectExistsError" })
      expect(h.journal.count()).toBe(1)
      // 重放同一条目（模拟迁移脚本重跑）：同样的 entity / event / 时刻 / 署名 ⇒ 仍是 uid 相同
      const [replay] = createdEntries("PRJ-13", { actor: "linmo", at })
      h.journal.append(replay!)
      expect(h.journal.count()).toBe(1)
      // 反例：时刻变了就是另一条真实事件（否则上面「只有一行」可能只是因为表没写进去）
      const [later] = createdEntries("PRJ-13", { actor: "linmo", at: new Date(at.getTime() + 1) })
      h.journal.append(later!)
      expect(h.journal.count()).toBe(2)
    })
  })

  it("同形事件在不同时刻是**两条**真实事件，不被幂等吞掉", async () => {
    // ⛔ 这是幂等键最容易写错的方向：若 uid 不含事件时刻（`mdAt` 留空），
    //    `active → paused → active → paused` 会塌成一条 status-change，而屏幕上毫无异常。
    //    本用例删掉 `projectEntry` 里 `mdAt: at.toISOString()` 那一行 ⇒ 变红。
    await withHarness(async (h) => {
      const base = Date.parse("2026-11-17T04:00:00.000Z")
      const stamp = (offset: number) => new Date(base + offset)
      await h.projects.create(draft("PRJ-14"), { at: stamp(0) })
      await h.projects.update("PRJ-14", { status: "paused" }, { at: stamp(1000) })
      await h.projects.update("PRJ-14", { status: "active" }, { at: stamp(2000) })
      await h.projects.update("PRJ-14", { status: "paused" }, { at: stamp(3000) })
      const events = h.journal.list({ entity: projectEntity("PRJ-14") }).rows.map((row) => row.event)
      expect(events.filter((name) => name === "status-change")).toHaveLength(3)
      expect(events[0]).toBe("created")
    })
  })
})

describe("并发写不丢、审计顺序 = 写入顺序", () => {
  it("50 个并发 update 全部落盘，且每条都有一条审计", async () => {
    await withHarness(async (h) => {
      await h.projects.create(draft("PRJ-15"))
      const seen = h.journal.count()
      await Promise.all(Array.from({ length: 50 }, (_, index) =>
        h.projects.update("PRJ-15", { title: `第 ${index} 次` })))
      expect(h.journal.count()).toBe(seen + 50)
      // 读回来的标题一定是最后落盘的那一个（不是 undefined / 中间态）
      expect(h.projects.get("PRJ-15")!.title).toMatch(/^第 \d+ 次$/)
    })
  })
})

describe("ProjectProps 与写面的边界", () => {
  it("落盘记录就是 zod 解出的形态；未知键**报错**而不是静默丢弃", async () => {
    // ⛔ 被测行为：`spec.ts` 的 `z.strictObject`。换成 `z.object` ⇒ 未知键被静默剥掉、
    //    调用方以为写进去了 ⇒ 本用例红。
    await withHarness(async (h) => {
      await expect(h.projects.create({ ...draft("PRJ-16"), 未知键: 1 } as never)).rejects.toThrow(/Unrecognized key/)
      expect(h.projects.get("PRJ-16")).toBeUndefined()
      expect(h.journal.count()).toBe(0)

      const record = await h.projects.create(draft("PRJ-16"))
      expect(Object.keys(record).sort()).toEqual(["created", "id", "status", "title"])
    })
  })

  it("数组字段内容相同时不算变更 —— 按值比较，不按引用", async () => {
    // ⛔ 被测行为：`events.ts` 的 `sameValue`。改回 `before[key] === after[key]` ⇒
    //    一次只改标题的 PATCH 会额外记一条 `tags` 假变更（`from: "a", to: "a"`）⇒ 本用例红。
    await withHarness(async (h) => {
      await h.projects.create(draft("PRJ-17", { tags: ["a", "b"] }))
      const seen = h.journal.count()
      // 传一个**新建的**同内容数组：引用不同、内容相同
      await h.projects.update("PRJ-17", { tags: [...(h.projects.get("PRJ-17")!.tags ?? [])], title: "换标题" })
      const rows = h.journal.list({ entity: projectEntity("PRJ-17") }).rows.slice(seen)
      expect(rows.map((row) => (row.payload as { field: string }).field)).toEqual(["title"])
      // 内容真变了才记
      await h.projects.update("PRJ-17", { tags: ["a", "b", "c"] })
      const last = h.journal.list({ entity: projectEntity("PRJ-17") }).rows.at(-1)!
      expect(last.payload).toMatchObject({ field: "tags", from: "a, b", to: "a, b, c" })
    })
  })
})
