/**
 * 工单门的写链与活动流：本单验收 1–5 的全部断言。
 *
 * ## 本文件钉的不是「能存能取」，是三条**不变量**
 *
 * 1. **落盘 → 内存 → 事件** 的顺序（`@matter/storage-domain` 的契约）本包不改；
 *    本包只在它**之后**追加活动流。断言方式是「写失败时活动流里没有那一条」。
 * 2. **活动流有真实数据**（验收 4）：`count() > 0`，且行内容与记录对得上。
 * 3. **幂等键有效**（验收 5）：同一事件 append 两次，`count` 只加 1。
 *    这条在旧树是迁移脚本的安全网；在新树它是「重放一条审计不会造出重复行」。
 *
 * @module @matter/issue/tests/domain
 */

import { describe, expect, it } from "vitest"
import { issueId } from "@matter/storage"
import { ISSUE_STATUS_EVENT, IssueNotFoundError, IssueProps, createdEntries, issueEntity } from "../src/index.ts"
import { boot, type Harness } from "./helpers/harness.ts"

/** 一条最小工单（必填四项）。 */
const draft = (id = "ISS-1", extra: Record<string, unknown> = {}) => ({
  id, title: "第一张", status: "todo", kind: "feature", created: "2026-11-17", ...extra,
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
      const created = await first.issues.create(draft("ISS-1", { body: "## 正文" }))
      expect(created).toEqual(draft("ISS-1", { body: "## 正文" }))
      expect(first.issues.get(issueId("ISS-1"))).toEqual(created)
      expect(first.issues.size).toBe(1)
    } finally {
      await first.shutdown()
    }
    // 「重启」：同一个根目录重新装配（新后端实例、新域、新 journal 连接）
    const second = await boot(root)
    try {
      expect(second.issues.get(issueId("ISS-1"))).toMatchObject({ title: "第一张", body: "## 正文" })
      // 活动流也是持久化的：「重启后审计还在」是它作为真相源的最低要求。
      expect(second.journal.count()).toBe(1)
    } finally {
      await second.dispose()
    }
  })

  it("update 只改给定字段，其余原样；空 PATCH 不落盘也不记审计", async () => {
    await withHarness(async (h) => {
      await h.issues.create(draft("ISS-1", { body: "正文", tags: ["a"] }))
      const seen = h.journal.count()
      const updated = await h.issues.update(issueId("ISS-1"), { title: "改了标题" })
      expect(updated.title).toBe("改了标题")
      expect(updated.body).toBe("正文")           // PATCH 不是整体替换
      expect(updated.tags).toEqual(["a"])
      expect(h.journal.count()).toBe(seen + 1)     // 只有 title 一条

      // 空 PATCH ⇒ 无变化 ⇒ 不落盘、不记审计
      const again = await h.issues.update(issueId("ISS-1"), { title: "改了标题" })
      expect(again).toEqual(updated)
      expect(h.journal.count()).toBe(seen + 1)
    })
  })

  it("校验失败抛 zod error：create 与 update 两条入口都被拦，且坏记录没落盘", async () => {
    await withHarness(async (h) => {
      // ① create：非法状态 ⇒ ZodError，且盘上什么都没有
      await expect(h.issues.create({ ...draft("ISS-2"), status: "zap" } as never)).rejects.toThrow()
      expect(h.issues.get(issueId("ISS-2"))).toBeUndefined()
      expect(h.journal.count()).toBe(0)
      // ② update：非法值同样拦，且**旧记录不被破坏**
      await h.issues.create(draft("ISS-3"))
      await expect(h.issues.update(issueId("ISS-3"), { status: "zap" } as never)).rejects.toThrow()
      expect(h.issues.get(issueId("ISS-3"))!.status).toBe("todo")
    })
  })

  it("create 同一个 id 报错；update / remove 不存在的 id 报错或返回 false", async () => {
    await withHarness(async (h) => {
      await h.issues.create(draft("ISS-4"))
      await expect(h.issues.create(draft("ISS-4"))).rejects.toMatchObject({ name: "IssueExistsError" })
      await expect(h.issues.update(issueId("ISS-404"), { title: "x" }))
        .rejects.toBeInstanceOf(IssueNotFoundError)
      await expect(h.issues.remove(issueId("ISS-404"))).resolves.toBe(false)
      await expect(h.issues.remove(issueId("ISS-4"))).resolves.toBe(true)
      expect(h.issues.get(issueId("ISS-4"))).toBeUndefined()
    })
  })
})

describe("写链顺序：落盘 → 内存 → 事件，审计在最后（验收 3）", () => {
  it("一次 create 落三条线索：内存可读、domain/changed 发过、活动流有行", async () => {
    await withHarness(async (h) => {
      const changes: unknown[] = []
      h.ctx.on("domain/changed", (change: unknown) => { changes.push(change) })
      await h.issues.create(draft("ISS-5"))
      // ① 内存
      expect(h.issues.get(issueId("ISS-5"))).toBeDefined()
      // ② 域事件载荷含 domain/table/key/operation/value 五件（验收 3 的原文）
      expect(changes).toEqual([{
        domain: "pm_issue",
        table: "issue",
        key: "ISS-5",
        operation: "put",
        value: expect.objectContaining({ id: "ISS-5", title: "第一张" }),
      }])
      // ③ 活动流
      expect(h.journal.count()).toBe(1)
    })
  })

  it("域写失败时活动流不留下那条从未发生的变更", async () => {
    await withHarness(async (h) => {
      // ⚠️ 这条只覆盖「zod 拦在落盘之前」这一层：schema 拒绝时一行审计都不该有。
      // 「落盘失败但审计已写」那一层由下面那条**顺序**用例覆盖 —— 用 zod 造不出
      // 「通过校验但被后端拒」的记录（`ISSUE_ID_RE` 保证 key 一定路径安全）。
      await expect(h.issues.create(draft("ISS-6", { 正文附件: "x" } as never))).rejects.toThrow()
      await expect(h.issues.create(draft("ISS-7"))).resolves.toBeDefined()
      expect(h.journal.count()).toBe(1) // 只有成功那条
    })
  })

  it("审计严格晚于 domain/changed：事件到达时活动流里还没有那一行", async () => {
    // ⛔ 被测行为：`index.ts` 里 `await this.table.put(...)` **先于** `writeAudit(...)`。
    //    两行对调 ⇒ 监听器跑的时候活动流已经有行了 ⇒ 本用例红。
    //    这是「落盘 → 内存 → 事件 → 审计」四步顺序的**唯一可观测点**：
    //    `domain/changed` 是域层在内存提交后发的，审计只能排在它之后。
    await withHarness(async (h) => {
      const countsAtEvent: number[] = []
      h.ctx.on("domain/changed", () => { countsAtEvent.push(h.journal.count()) })
      await h.issues.create(draft("ISS-6"))
      // 监听器跑的时候：内存已可读、事件已发出、活动流**还是空的**
      expect(countsAtEvent).toEqual([0])
      // 而写完之后活动流里有了
      expect(h.journal.count()).toBe(1)
    })
  })
})

describe("活动流有真实写入，不是空表（验收 4）", () => {
  it("put 之后 count() > 0，且行的 entity / event / payload 对得上记录", async () => {
    await withHarness(async (h) => {
      // 起点真的是空表 —— 否则「> 0」可能来自任何别的东西。
      expect(h.journal.count()).toBe(0)
      await h.issues.create(draft("ISS-8", { body: "第一段\n第二段" }))
      expect(h.journal.count()).toBeGreaterThan(0)

      const page = h.journal.list({ entity: issueEntity("ISS-8") })
      expect(page.rows).toHaveLength(1)
      expect(page.rows[0]).toMatchObject({ entity: "issues/ISS-8", event: "issue-created", known: 1 })

      // 状态变更落的是**信号名**，载荷带 field/from/to
      await h.issues.update(issueId("ISS-8"), { status: "in_review" })
      const rows = h.journal.list({ entity: issueEntity("ISS-8") }).rows
      expect(rows.map((row) => row.event)).toEqual(["issue-created", "issue-delivered"])
      expect(rows[1]!.payload).toMatchObject({ field: "status", from: "todo", to: "in_review" })

      // 正文变更只记指纹，不记正文
      await h.issues.update(issueId("ISS-8"), { body: "第一段" })
      const bodyRow = h.journal.list({ entity: issueEntity("ISS-8") }).rows.at(-1)!
      expect(bodyRow.event).toBe("body-change")
      expect(bodyRow.payload).toMatchObject({ field: "body", fromLines: 2, toLines: 1, lineDelta: -1 })
      expect(JSON.stringify(bodyRow.payload)).not.toContain("第一段")
    })
  })

  it("7 个状态各发各的信号名；字段变更发 field-change", async () => {
    await withHarness(async (h) => {
      await h.issues.create(draft("ISS-9"))
      for (const [status, event] of Object.entries(ISSUE_STATUS_EVENT)) {
        if (status === "todo") continue // 建单时已经是 todo，改回去是变更 → 也发事件，下面单独覆盖
        await h.issues.update(issueId("ISS-9"), { status: status as never })
        const last = h.journal.list({ entity: issueEntity("ISS-9") }).rows.at(-1)!
        expect(last.event, `status=${status}`).toBe(event)
      }
      await h.issues.update(issueId("ISS-9"), { assignee: "builder-e0" })
      const rows = h.journal.list({ entity: issueEntity("ISS-9") }).rows
      expect(rows.at(-1)).toMatchObject({
        event: "field-change",
        payload: { field: "assignee", from: null, to: "builder-e0" },
      })
      // 每条都是现行词表（known=1）—— 词表外的名字会落 0，那是「谁在写野名」的入口
      expect(rows.every((row) => row.known === 1)).toBe(true)
    })
  })

  it("一次 update 改多个字段 ⇒ 一字段一条事件，按字段名序", async () => {
    await withHarness(async (h) => {
      await h.issues.create(draft("ISS-10"))
      await h.issues.update(issueId("ISS-10"), { title: "新标题", priority: "high", assignee: "x" })
      const fields = h.journal.list({ entity: issueEntity("ISS-10") }).rows
        .slice(1)
        .map((row) => (row.payload as { field: string }).field)
      expect(fields).toEqual(["assignee", "priority", "title"])
    })
  })

  it("删一条发 deleted；重复删不重复记", async () => {
    await withHarness(async (h) => {
      await h.issues.create(draft("ISS-11"))
      expect(await h.issues.remove(issueId("ISS-11"))).toBe(true)
      const seen = h.journal.count()
      expect(h.journal.list({ entity: issueEntity("ISS-11") }).rows.at(-1)!.event).toBe("deleted")
      expect(await h.issues.remove(issueId("ISS-11"))).toBe(false)
      expect(h.journal.count()).toBe(seen)
    })
  })
})

describe("幂等键有效（验收 5）", () => {
  it("同一事件 append 两次，count 只加 1", async () => {
    await withHarness(async (h) => {
      const at = new Date("2026-11-17T12:00:00.000Z")
      const entry = {
        entity: issueEntity("ISS-12"),
        event: "issue-noted",
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
    // 这条走 `issueEntry` 的真实形态（而不是手拼 entry）：uid 的时间成分是事件时刻，
    // 所以「同一条目重放」与「同一时刻的同一事件」都必须只留一行。
    // ⚠️ 手工拼 entry 容易拼错成分（`known` 就是一处：本包只在**非** 1 时才传它，
    //    见 events.ts 的注释），所以重放一律用包自己的工厂函数 —— 那才是迁移脚本的用法。
    await withHarness(async (h) => {
      const at = new Date("2026-11-17T03:00:00.000Z")
      await h.issues.create(draft("ISS-13"), { actor: "linmo", at })
      expect(h.journal.count()).toBe(1)
      // 同一个 (id, 时刻) 再 create 一次：id 已存在 ⇒ 报错，一行都不新增
      await expect(h.issues.create(draft("ISS-13"), { actor: "linmo", at }))
        .rejects.toMatchObject({ name: "IssueExistsError" })
      expect(h.journal.count()).toBe(1)
      // 重放同一条目（模拟迁移脚本重跑）：同样的 entity / event / 时刻 / 署名 ⇒ 仍是 uid 相同
      const [replay] = createdEntries("ISS-13", { actor: "linmo", at })
      h.journal.append(replay!)
      expect(h.journal.count()).toBe(1)
      // 反例：时刻变了就是另一条真实事件（否则上面「只有一行」可能只是因为表没写进去）
      const [later] = createdEntries("ISS-13", { actor: "linmo", at: new Date(at.getTime() + 1) })
      h.journal.append(later!)
      expect(h.journal.count()).toBe(2)
    })
  })

  it("同形事件在不同时刻是**两条**真实事件，不被幂等吞掉", async () => {
    // ⛔ 这是幂等键最容易写错的方向：若 uid 不含事件时刻（`mdAt` 留空），
    //    `todo → in_review → todo → in_review` 会塌成一条 delivered，而屏幕上毫无异常。
    //    本用例删掉 `issueEntry` 里 `mdAt: at.toISOString()` 那一行 ⇒ 变红。
    await withHarness(async (h) => {
      const base = Date.parse("2026-11-17T04:00:00.000Z")
      const stamp = (offset: number) => new Date(base + offset)
      await h.issues.create(draft("ISS-14"), { at: stamp(0) })
      await h.issues.update(issueId("ISS-14"), { status: "in_review" }, { at: stamp(1000) })
      await h.issues.update(issueId("ISS-14"), { status: "todo" }, { at: stamp(2000) })
      await h.issues.update(issueId("ISS-14"), { status: "in_review" }, { at: stamp(3000) })
      const events = h.journal.list({ entity: issueEntity("ISS-14") }).rows.map((row) => row.event)
      expect(events.filter((name) => name === "issue-delivered")).toHaveLength(2)
      expect(events).toEqual([
        "issue-created", "issue-delivered", "issue-queued", "issue-delivered",
      ])
    })
  })
})

describe("并发写不丢、审计顺序 = 写入顺序", () => {
  it("50 个并发 update 全部落盘，且每条都有一条审计", async () => {
    await withHarness(async (h) => {
      await h.issues.create(draft("ISS-15"))
      const seen = h.journal.count()
      await Promise.all(Array.from({ length: 50 }, (_, index) =>
        h.issues.update(issueId("ISS-15"), { title: `第 ${index} 次` })))
      expect(h.journal.count()).toBe(seen + 50)
      // 读回来的标题一定是最后落盘的那一个（不是 undefined / 中间态）
      expect(h.issues.get(issueId("ISS-15"))!.title).toMatch(/^第 \d+ 次$/)
    })
  })
})

describe("IssueProps 与写面的边界", () => {
  it("落盘记录就是 zod 解出的形态；未知键**报错**而不是静默丢弃", async () => {
    // ⛔ 被测行为：`spec.ts` 的 `z.strictObject`。换成 `z.object` ⇒ 未知键被静默剥掉、
    //    调用方以为写进去了 ⇒ 本用例红。这条比「剥掉」重要：一个拼错的字段名
    //    在 `z.object` 下既不改任何东西、也不报任何错。
    await withHarness(async (h) => {
      await expect(h.issues.create({ ...draft("ISS-16"), 未知键: 1 } as never)).rejects.toThrow(/Unrecognized key/)
      expect(h.issues.get(issueId("ISS-16"))).toBeUndefined()
      expect(h.journal.count()).toBe(0)

      const record = await h.issues.create(draft("ISS-16"))
      expect(Object.keys(record).sort()).toEqual(["created", "id", "kind", "status", "title"])
      expect(IssueProps.parse(record)).toEqual(record)
    })
  })

  it("数组字段内容相同时不算变更 —— 按值比较，不按引用", async () => {
    // ⛔ 被测行为：`events.ts` 的 `sameValue`。改回 `before[key] === after[key]` ⇒
    //    一次只改标题的 PATCH 会额外记一条 `tags` 假变更（`from: "a", to: "a"`）⇒ 本用例红。
    await withHarness(async (h) => {
      await h.issues.create(draft("ISS-17", { tags: ["a", "b"] }))
      const seen = h.journal.count()
      // 传一个**新建的**同内容数组：引用不同、内容相同
      await h.issues.update(issueId("ISS-17"), { tags: [...(h.issues.get(issueId("ISS-17"))!.tags ?? [])], title: "换标题" })
      const rows = h.journal.list({ entity: issueEntity("ISS-17") }).rows.slice(seen)
      expect(rows.map((row) => (row.payload as { field: string }).field)).toEqual(["title"])
      // 内容真变了才记
      await h.issues.update(issueId("ISS-17"), { tags: ["a", "b", "c"] })
      const last = h.journal.list({ entity: issueEntity("ISS-17") }).rows.at(-1)!
      expect(last.payload).toMatchObject({ field: "tags", from: "a, b", to: "a, b, c" })
    })
  })
})
