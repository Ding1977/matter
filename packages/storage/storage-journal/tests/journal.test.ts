/**
 * 活动流：真相源的四个不变量。
 *
 * 本文件钉的四条，每一条都对应一种「不报错的坏」：
 * 1. **幂等**：同一条事件追加两次只有一行。坏了的表现是表里慢慢长重复行 —— 没有异常、没有日志。
 * 2. **uid 逐字照抄旧树**：黄金向量取自 `forge-pm/lib/pm-store.js` 的 `activityUid` **实际输出**
 *    （用 `node -e "import('./forge-pm/lib/pm-store.js').then(m => m.activityUid({…}))"` 现算）。
 *    这就是「迁移脚本重复跑不出第二行」的唯一保证；算法漂了 = 新旧数据认不出彼此。
 * 3. **追加型**：`seq` 单调，读侧靠它做游标。没有 UPDATE/DELETE 路径。
 * 4. **`user_version` 一行不碰**：那是 `storage-sqlite` 的版本轴（它只认 0/1），
 *    本包用 `application_id` 分流。碰它会**静默**撞车。
 *
 * @module @matter/storage-journal/tests/journal
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import {
  activityUid,
  appendJournal,
  countJournal,
  headJournal,
  JOURNAL_APPLICATION_ID,
  JournalError,
  listJournal,
  openJournalDatabase,
  openJournalFacility,
  readIdentity,
  stablePayload,
} from "../src/index.ts"

/** 建一个临时库目录，返回 `{ root, dispose }`。 */
async function tempRoot(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "matter-journal-"))
  return { root, dispose: () => rm(root, { recursive: true, force: true }) }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** 打开一个临时库并登记清理。 */
async function openTemp(): Promise<{ root: string; facility: Awaited<ReturnType<typeof openJournalFacility>> }> {
  const { root, dispose } = await tempRoot()
  const facility = await openJournalFacility(root)
  cleanups.push(() => facility.close())
  cleanups.push(dispose)
  return { root, facility }
}

describe("activityUid（逐字照抄旧树 pm-store.js:333-350）", () => {
  // 黄金向量的实际输出，由旧树模块现算，不是手抄。
  // 复算：node -e "import('./forge-pm/lib/pm-store.js').then(m => console.log(m.activityUid({…})))"
  const golden: Array<[string, Parameters<typeof activityUid>[0], string]> = [
    [
      "带 mdAt 与 body",
      { entity: "issues/x.md", event: "agent-note", actor: "linmo", at: 1_700_000_000_000, mdAt: "2026-11-16T12:46:52.814Z", body: "调度器与事件流" },
      "49e59413c9dcb7ee33892aecf0d667323fcd6c8e",
    ],
    [
      "field-change 的 from/to",
      { entity: "issues/x.md", event: "status-change", actor: null, at: 1, from: "todo", to: "done" },
      "70759bb9cf46f8fe6646c7d1a94a71dd2dc0a156",
    ],
    ["无附加键", { entity: "a", event: "b" }, "ab60cad025c20326ef61709ea9da432a0d6495b1"],
    ["键序不影响 uid（排序后序列化）", { entity: "a", event: "b", mdAt: null, z: 1, a: 2 }, "cbd9f9ac413980cc8363b42be7dfb1d39c93eb45"],
  ]

  for (const [label, entry, expected] of golden) {
    it(`黄金向量：${label}`, () => {
      expect(activityUid(entry)).toBe(expected)
    })
  }

  it("actor 与 at 不进 uid（同一条 md 事件被两套通道推导仍是同一条）", () => {
    const base = { entity: "issues/x.md", event: "agent-note", mdAt: "2026-11-16T12:46:52.814Z", body: "同一句" }
    expect(activityUid({ ...base, actor: "linmo", at: 1 })).toBe(activityUid({ ...base, actor: "iris", at: 999 }))
  })

  it("mdAt 缺席与空串等价（旧树的 `?? \"\"`）", () => {
    expect(activityUid({ entity: "a", event: "b" })).toBe(activityUid({ entity: "a", event: "b", mdAt: "" }))
    expect(activityUid({ entity: "a", event: "b", mdAt: null })).toBe(activityUid({ entity: "a", event: "b" }))
  })

  it("stablePayload 只留附加键，且按 key 排序", () => {
    expect(stablePayload({ entity: "a", event: "b", actor: "c", at: 1, uid: "u", mdAt: "m" })).toBeNull()
    expect(stablePayload({ entity: "a", event: "b", z: 1, a: 2 })).toBe('{"a":2,"z":1}')
    // undefined 的键丢掉；false / 0 / 空串保留（它们是值，不是缺席）
    expect(stablePayload({ entity: "a", event: "b", skip: undefined, no: false, zero: 0, empty: "" }))
      .toBe('{"empty":"","no":false,"zero":0}')
  })
})

describe("append / list / count（真相源）", () => {
  it("存一条、读一条，seq 与头部游标对得上", async () => {
    const { facility } = await openTemp()
    const seq = facility.append({ entity: "issues/x.md", event: "issue-created", actor: "linmo", mdAt: "2026-11-16T12:46:52.814Z" })
    expect(seq).toBe(1)
    const page = facility.list()
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]).toMatchObject({ seq: 1, entity: "issues/x.md", event: "issue-created", actor: "linmo" })
    expect(facility.head()).toBe(1)
    expect(facility.count()).toBe(1)
  })

  it("幂等：同一条 append 跑两次，表里 1 行，两次返回同一个 seq", async () => {
    const { facility } = await openTemp()
    const entry = {
      entity: "issues/x.md",
      event: "agent-note",
      actor: "linmo",
      mdAt: "2026-11-16T12:50:49.694Z",
      body: "调度器与事件流",
    }
    const first = facility.append(entry)
    // ⚠️ at 故意不同：若算法把 `at` 算进 uid，这里就会长出第二行
    const second = facility.append({ ...entry, at: Date.now() + 1000 })
    expect(second).toBe(first)
    expect(facility.count()).toBe(1)
  })

  it("不同实体/事件/正文各是各自的行（幂等不是把不同事件合并）", async () => {
    const { facility } = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created" })
    facility.append({ entity: "issues/b.md", event: "issue-created" })
    facility.append({ entity: "issues/a.md", event: "issue-noted", body: "一" })
    facility.append({ entity: "issues/a.md", event: "issue-noted", body: "二" })
    expect(facility.count()).toBe(4)
  })

  it("seq 单调：后续事件 seq 严格大于前面（游标读的前提）", async () => {
    const { facility } = await openTemp()
    const seqs = ["a", "b", "c"].map((entity) => facility.append({ entity, event: "e" }))
    expect(seqs).toEqual([1, 2, 3])
    expect(facility.list({ since: 2 }).rows.map((row) => row.seq)).toEqual([3])
    expect(facility.list({ since: 2 }).truncated).toBe(false)
  })

})

describe("游标读与分页", () => {
  it("游标读按 entity 过滤，next 是本页最后一条的 seq", async () => {
    const { facility } = await openTemp()
    // ⚠️ 三条必须彼此不同（同 entity+event+payload 的两次 append 是**同一条事件**，
    //    会被 uid 幂等吃掉 —— 这本身是幂等测试的断言，不是这里的疏漏）。
    facility.append({ entity: "issues/a.md", event: "issue-created" })
    facility.append({ entity: "issues/b.md", event: "issue-created" })
    facility.append({ entity: "issues/a.md", event: "issue-noted", body: "第二条" })
    const page = facility.list({ entity: "issues/a.md" })
    expect(page.rows.map((row) => row.seq)).toEqual([1, 3])
    expect(page.next).toBe(3)
  })

  it("limit 截断时 truncated 为 true（分页判据必须能红）", async () => {
    const { facility } = await openTemp()
    for (let i = 0; i < 5; i++) facility.append({ entity: `issues/${i}.md`, event: "e" })
    expect(facility.list({ limit: 2 }).truncated).toBe(true)
    expect(facility.list({ limit: 2 }).rows).toHaveLength(2)
  })

  it("includeUnknown:false 只留 known=1（未知事件默认照读）", async () => {
    const { facility } = await openTemp()
    facility.append({ entity: "a", event: "进行中" })
    facility.append({ entity: "b", event: "怪事件", known: 0 })
    expect(facility.list().rows).toHaveLength(2)
    expect(facility.list({ includeUnknown: false }).rows.map((row) => row.entity)).toEqual(["a"])
  })

  it("payload 往返：附加键进 payload，核心列不进", async () => {
    const { facility } = await openTemp()
    facility.append({ entity: "issues/x.md", event: "field-change", field: "status", from: "todo", to: "in_review" })
    const row = facility.list().rows[0]!
    expect(row.payload).toEqual({ field: "status", from: "todo", to: "in_review" })
    expect(row.payload).not.toHaveProperty("entity")
    expect(row.payload).not.toHaveProperty("event")
    expect(row.payload).not.toHaveProperty("actor")
  })

  it("缺 entity / event 抛 malformed-event（不写半行）", async () => {
    const { facility } = await openTemp()
    expect(() => facility.append({ entity: "", event: "e" })).toThrow(JournalError)
    expect(() => facility.append({ entity: "a", event: "" })).toThrow(JournalError)
    try {
      facility.append({ entity: "", event: "e" })
    } catch (error) {
      expect((error as JournalError).code).toBe("malformed-event")
    }
    expect(facility.count()).toBe(0)
  })

  it("坏 payload 在 list 路径上**抛**，不当成 null（旧树纪律 1：读失败 ≠ 没有）", async () => {
    const { facility } = await openTemp()
    facility.append({ entity: "issues/x.md", event: "e", body: "正常" })
    // 直接写一条 payload 坏掉的行（业务路径写不出这种数据，只有外部介入才会）
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(facility.databasePath)
    try {
      db.prepare("INSERT INTO activity_log(entity, event, at, known, payload_json, md_at, uid) VALUES(?,?,?,?,?,?,?)")
        .run("issues/y.md", "e", Date.now(), 1, "{not json", null, "deadbeef")
    } finally {
      db.close()
    }
    // ⭐ 变异实测：把 toJournalRow 的 catch 改成 `payload = null` ⇒ 这条红。
    expect(() => facility.list()).toThrow(/unparseable payload_json/)
    try {
      facility.list()
    } catch (error) {
      expect((error as { code?: string }).code).toBe("io")
    }
  })

  it("close 之后读写抛 closed（不返回空集合 —— 那是「读成功但没有」）", async () => {
    const { root, dispose } = await tempRoot()
    const facility = await openJournalFacility(root)
    facility.close()
    expect(() => facility.append({ entity: "a", event: "e" })).toThrow(/closed/)
    expect(() => facility.list()).toThrow(/closed/)
    expect(() => facility.search({ query: "调度器" })).toThrow(/closed/)
    // 幂等：重复 close 不抛
    expect(() => facility.close()).not.toThrow()
    await dispose()
  })
})

describe("版本轴：application_id 分流，user_version 一行不碰", () => {
  it("新库认领后 application_id 是本包的、user_version 仍是 0", async () => {
    const { facility } = await openTemp()
    const identity = facility.identity()
    expect(identity.applicationId).toBe(JOURNAL_APPLICATION_ID)
    // ⭐ 这条是本单硬约束 ② 的机器形态：storage-sqlite 的门禁只认 0/1，
    //    本包永不写 user_version ⇒ 它读到的永远是 0（「未初始化」），不会撞到任何合法值。
    expect(identity.tables).toContain("activity_log")
  })

  it("**真的**没写过 user_version：直接问 PRAGMA", async () => {
    const { facility } = await openTemp()
    // 走公开入口拿不到 db 句柄（故意的），故用第二个连接看同一个文件
    const db = new DatabaseSync(facility.databasePath)
    try {
      const { user_version: userVersion } = db.prepare("PRAGMA user_version").get() as { user_version: number }
      expect(userVersion).toBe(0)
    } finally {
      db.close()
    }
  })

  it("别人的库（application_id 不同）⇒ foreign-database 拒开，且不写它一字", async () => {
    const { root, dispose } = await tempRoot()
    const foreignPath = join(root, "journal.db")
    const foreign = new DatabaseSync(foreignPath)
    // 0x44534853 = DSH storage-sqlite 的同类声明值（撞号会把「这是谁的库」答错）
    foreign.exec("PRAGMA application_id = 1146185811")
    foreign.exec("CREATE TABLE theirs (x TEXT) STRICT")
    foreign.exec("INSERT INTO theirs VALUES ('kept')")
    foreign.close()
    await expect(openJournalFacility(root)).rejects.toThrow(/belongs to another application/)
    await expect(openJournalFacility(root)).rejects.toMatchObject({ code: "foreign-database" })
    // 拒开之后那个库必须原样：表还在、application_id 没被认领
    const after = new DatabaseSync(foreignPath)
    try {
      expect((after.prepare("PRAGMA application_id").get() as { application_id: number }).application_id).toBe(1146185811)
      expect(after.prepare("SELECT COUNT(*) AS c FROM theirs").get()).toEqual({ c: 1 })
    } finally {
      after.close()
    }
    await dispose()
  })

  it("有表但没 application_id ⇒ 也拒开（不认领别人的数据）", async () => {
    const { root, dispose } = await tempRoot()
    const path = join(root, "journal.db")
    const foreign = new DatabaseSync(path)
    foreign.exec("CREATE TABLE mysterious (x TEXT) STRICT")
    foreign.close()
    await expect(openJournalFacility(root)).rejects.toThrow(/no application_id/)
    await dispose()
  })

  it("**已存在 user_version=1 的库照常打开**（本包不看那一轴）", async () => {
    const { root, dispose } = await tempRoot()
    const path = join(root, "journal.db")
    // 造一个「storage-sqlite 已经盖过 user_version=1、但 application_id 还是本包的」库，
    // 等价于「同一介质被两个包碰过」的最坏形态 —— journal 必须无感。
    const first = await openJournalFacility(root)
    first.close()
    const stamper = new DatabaseSync(path)
    stamper.exec("PRAGMA user_version = 1")
    stamper.close()
    const second = await openJournalFacility(root)
    try {
      second.append({ entity: "issues/x.md", event: "e" })
      expect(second.count()).toBe(1)
      expect(second.identity().applicationId).toBe(JOURNAL_APPLICATION_ID)
    } finally {
      second.close()
    }
    await dispose()
  })

  it("打开两次同一个库：第二次不重灌、数据仍在", async () => {
    const { root, dispose } = await tempRoot()
    const first = await openJournalFacility(root)
    first.append({ entity: "issues/x.md", event: "e" })
    first.close()
    const second = await openJournalFacility(root)
    try {
      expect(second.count()).toBe(1)
      expect(second.identity().schemaVersion).toBe(1)
    } finally {
      second.close()
    }
    await dispose()
  })
})

describe("裸函数入口（不经 facility）", () => {
  it("appendJournal / listJournal / countJournal / headJournal 对同一个 db 可用", async () => {
    const db = await openJournalDatabase(":memory:")
    try {
      expect(countJournal(db)).toBe(0)
      expect(headJournal(db)).toBe(0)
      expect(appendJournal(db, { entity: "issues/x.md", event: "e" })).toBe(1)
      expect(countJournal(db)).toBe(1)
      expect(headJournal(db)).toBe(1)
      expect(listJournal(db).rows.map((row) => row.entity)).toEqual(["issues/x.md"])
    } finally {
      db.close()
    }
  })

  it("readIdentity 对裸句柄可用（诊断路径不许炸）", async () => {
    const db = await openJournalDatabase(":memory:")
    try {
      expect(readIdentity(db)).toMatchObject({ applicationId: JOURNAL_APPLICATION_ID, schemaVersion: 1 })
    } finally {
      db.close()
    }
  })
})
