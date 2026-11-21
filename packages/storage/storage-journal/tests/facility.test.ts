/**
 * ISS-524 搬入的审计门面共享内核（`facility.ts`）的契约用例。
 *
 * `AuditFacility` 的行为级测试在 pm 侧（`pm/issue|project/tests/domain.test.ts`，
 * 走真实 cordis + sqlite）。本文件守**内核契约本身**：串行写链上的 CRUD 骨架、
 * parse/主键/错误工厂/事件工厂的注入点、空写不落盘、审计失败降级、关闭语义。
 * 域对象与 journal 用结构型内存 fake（`AuditDomainLike` / `AuditAppendLike`），
 * 不装配 cordis —— 这正是「回调注入、不依赖域形态」的机制层卖点。
 * @module storage-journal/tests/facility
 */

import { describe, expect, it } from "vitest"
import type { AuditAppendLike, AuditDomainLike, AuditFacilitySpec, AuditTableLike } from "../src/index.ts"
import { AuditFacility } from "../src/index.ts"

/** 测试记录形态：字符串 id + 可变字段。 */
interface Item {
  id: string
  title: string
  count: number
}

/** 内存表：记 put 次数，让「空写不落盘」可断言。 */
class FakeTable implements AuditTableLike<string, Item> {
  readonly map = new Map<string, Item>()
  putCount = 0

  get(id: string): Item | undefined { return this.map.get(id) }
  async put(id: string, value: Item): Promise<void> { this.putCount += 1; this.map.set(id, value) }
  async delete(id: string): Promise<boolean> { return this.map.delete(id) }
  *entries(): IterableIterator<[string, Item]> { yield* this.map.entries() }
  get size(): number { return this.map.size }
}

/** 内存域：close 记次，让关闭语义可断言。 */
class FakeDomain implements AuditDomainLike {
  readonly tables = new Map<string, FakeTable>()
  closeCount = 0

  table(name: string): AuditTableLike<string, unknown> {
    let table = this.tables.get(name)
    if (table === undefined) { table = new FakeTable(); this.tables.set(name, table) }
    return table as unknown as AuditTableLike<string, unknown>
  }

  async close(): Promise<void> { this.closeCount += 1 }
}

/** 内存 journal：可按需注入失败。 */
class FakeJournal implements AuditAppendLike {
  readonly entries: unknown[] = []
  fail = false

  append(entry: unknown): number { if (this.fail) throw new Error("journal down"); this.entries.push(entry); return this.entries.length }
}

/** PATCH 形态（update 的第三参）。 */
type ItemPatch = Partial<Item>
/** 写上下文（署名人与时刻）。 */
type ItemContext = { actor?: string; at?: Date }

/** 域侧差异点的最小实现：parse 抛原错、notFound/exists 各带 id 文本。 */
function makeSpec(): AuditFacilitySpec<string, Item, ItemContext> {
  return {
    tableName: "items",
    closedMessage: "item facility 'demo' is closed",
    parse: (value: unknown) => {
      const record = value as ItemPatch
      if (typeof record.id !== "string" || record.id.length === 0) throw new Error("id required")
      if (typeof record.title !== "string") throw new Error("title required")
      if (typeof record.count !== "number") throw new Error("count required")
      return record as Item
    },
    keyOf: (record: Item) => record.id,
    idOf: (record: Item) => record.id,
    notFound: (id: string) => new Error(`item not found: ${id}`),
    exists: (id: string) => new Error(`item already exists: ${id}`),
    created: (id: string, context) => [{ entity: `items/${id}`, event: "created", actor: context.actor ?? null }],
    deleted: (id: string, context) => [{ entity: `items/${id}`, event: "deleted", actor: context.actor ?? null }],
    diff: (id, previous, next, context) => previous === undefined
      ? []
      : [{ entity: `items/${id}`, event: "field-change", field: "title", from: previous.title, to: next.title, actor: context.actor ?? null }],
  }
}

/** 一个就绪的 facility 三元组（域 / journal / 门面）。 */
function makeFixture() {
  const domain = new FakeDomain()
  const journal = new FakeJournal()
  const warns: string[] = []
  const facility = new AuditFacility<string, Item, ItemPatch, ItemContext>(
    domain, journal, (m) => warns.push(m), makeSpec(),
  )
  // 预建 tableName 指向的表：facility 的 table getter 是懒取，测试要先有一张可断言的。
  const table = domain.table("items") as unknown as FakeTable
  return { domain, journal, warns, facility, table }
}

const item = (id: string, title = "first"): Item => ({ id, title, count: 1 })

describe("AuditFacility · 读面直通表", () => {
  it("get / entries / size 走 tableName 指向的那张表", () => {
    const { facility, table } = makeFixture()
    expect(facility.size).toBe(0)
    expect([...facility.entries()]).toEqual([])
    table.map.set("a", item("a"))
    expect(facility.get("a")).toMatchObject({ id: "a", title: "first" })
    expect(facility.get("missing")).toBeUndefined()
    expect(facility.size).toBe(1)
    expect([...facility.entries()]).toHaveLength(1)
  })
})

describe("AuditFacility · create", () => {
  it("成功：parse 规范化后落盘，created 审计带 actor；context 缺省也走（署名缺席记 null）", async () => {
    const { facility, journal } = makeFixture()
    const created = await facility.create(item("A1"), { actor: "linmo" })
    expect(created).toMatchObject({ id: "A1", title: "first", count: 1 })
    expect(journal.entries).toEqual([
      { entity: "items/A1", event: "created", actor: "linmo" },
    ])
    // context 缺省（default-arg 分支）：不传也落，审计署名记 null。
    await facility.create(item("A2"))
    expect(journal.entries).toHaveLength(2)
    expect(journal.entries[1]).toMatchObject({ entity: "items/A2", event: "created", actor: null })
  })

  it("parse 失败原样抛：不落盘、无审计", async () => {
    const { facility, journal, table } = makeFixture()
    await expect(facility.create({ id: "", title: "x", count: 1 })).rejects.toThrow("id required")
    expect(table.putCount).toBe(0)
    expect(journal.entries).toEqual([])
  })

  it("id 已占用 ⇒ exists 错误，原记录不被覆盖（「两次建」与「一次」在审计里不同形）", async () => {
    const { facility, table } = makeFixture()
    await facility.create(item("A1", "original"))
    await expect(facility.create(item("A1", "sneaky"))).rejects.toThrow("item already exists: A1")
    expect(facility.get("A1")!.title).toBe("original")
    expect(table.putCount).toBe(1)
  })
})

describe("AuditFacility · update", () => {
  it("字段真变 ⇒ 落盘 + diff 审计；context 缺省可走", async () => {
    const { facility, journal, table } = makeFixture()
    await facility.create(item("U1", "old"), { actor: "linmo" })
    const next = await facility.update("U1", { title: "new" } as ItemPatch, { actor: "iris" })
    expect(next.title).toBe("new")
    expect(table.putCount).toBe(2)
    expect(journal.entries).toEqual([
      { entity: "items/U1", event: "created", actor: "linmo" },
      { entity: "items/U1", event: "field-change", field: "title", from: "old", to: "new", actor: "iris" },
    ])
    // context 缺省（default-arg 分支）。
    await facility.update("U1", { title: "newer" } as ItemPatch)
    expect(journal.entries[2]).toMatchObject({ actor: null, from: "new", to: "newer" })
  })

  it("解出的记录与上一版完全相同 ⇒ 不落盘、不记审计（返回上一版）", async () => {
    const { facility, journal, table } = makeFixture()
    await facility.create(item("U2", "same"), { actor: "linmo" })
    const putBefore = table.putCount
    const auditBefore = journal.entries.length
    const out = await facility.update("U2", { title: "same" } as ItemPatch, { actor: "linmo" })
    expect(out.title).toBe("same")
    expect(table.putCount).toBe(putBefore)
    expect(journal.entries).toHaveLength(auditBefore)
  })

  it("不存在 ⇒ notFound 错误", async () => {
    const { facility, journal, table } = makeFixture()
    await expect(facility.update("ghost", { title: "x" } as ItemPatch)).rejects.toThrow("item not found: ghost")
    expect(table.putCount).toBe(0)
    expect(journal.entries).toEqual([])
  })
})

describe("AuditFacility · remove", () => {
  it("存在 ⇒ 删掉、deleted 审计；不存在 ⇒ false 且无审计；context 缺省可走", async () => {
    const { facility, journal } = makeFixture()
    await facility.create(item("R1"), { actor: "linmo" })
    expect(await facility.remove("R1", { actor: "linmo" })).toBe(true)
    expect(journal.entries).toEqual([
      { entity: "items/R1", event: "created", actor: "linmo" },
      { entity: "items/R1", event: "deleted", actor: "linmo" },
    ])
    const auditBefore = journal.entries.length
    expect(await facility.remove("R1")).toBe(false)
    expect(journal.entries).toHaveLength(auditBefore)
    // 存在 + context 缺省（default-arg 分支）：deleted 审计记 null。
    await facility.create(item("R2"))
    expect(await facility.remove("R2")).toBe(true)
    expect(journal.entries.at(-1)).toMatchObject({ event: "deleted", actor: null })
  })
})

describe("AuditFacility · 关闭与审计降级", () => {
  it("close：标记写链并关域；之后写操作拒绝 closedMessage", async () => {
    const { facility, domain } = makeFixture()
    await facility.create(item("C1"))
    await facility.close()
    expect(domain.closeCount).toBe(1)
    await expect(facility.create(item("C2"))).rejects.toThrow("item facility 'demo' is closed")
    await expect(facility.update("C1", { title: "x" } as ItemPatch)).rejects.toThrow("item facility 'demo' is closed")
    await expect(facility.remove("C1")).rejects.toThrow("item facility 'demo' is closed")
  })

  it("journal.append 抛错 ⇒ 只 warn 不撤销落盘（记录是主，审计是伴生）", async () => {
    const { facility, journal, warns } = makeFixture()
    journal.fail = true
    await facility.create(item("W1"), { actor: "linmo" })
    expect(facility.get("W1")).toMatchObject({ id: "W1" })
    expect(warns).toEqual(["audit append failed (items/W1 created): journal down"])
  })
})

describe("AuditFacility · 串行写链（机制层不变量）", () => {
  it("并发 50 个 update 交错不丢：审计恰 50 条且串成一条链、to 值无一重复", async () => {
    const { facility, journal } = makeFixture()
    await facility.create(item("P0", "seed"))
    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      facility.update("P0", { title: `t${index}` } as ItemPatch, { actor: `a${index}` })))
    const changes = journal.entries.filter((e): e is { event: string; from: unknown; to: unknown } =>
      (e as { event: unknown }).event === "field-change")
    expect(changes).toHaveLength(50)
    // 串行链：每条 from 是上一条的 to（B 基于过期旧值时这条即红），首条从 seed 出发。
    const chain = changes.map((e) => [String(e.from), String(e.to)] as const)
    expect(chain[0]![0]).toBe("seed")
    for (let i = 1; i < chain.length; i++) expect(chain[i]![0], `entry ${i}`).toBe(chain[i - 1]![1])
    // 50 个补丁全部生效：to 值恰好覆盖 50 个不同标题，无一丢失、无一重复。
    expect(new Set(chain.map(([, to]) => to))).toHaveLength(50)
    // 落盘只留最后一个 to。
    expect(facility.get("P0")!.title).toBe(chain.at(-1)![1])
  })
})
