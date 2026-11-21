/**
 * 检索与边表：两个**派生物**的可重建性。
 *
 * 本文件钉的不是「搜索能搜到」（那太弱），而是**「派生层可以随时丢掉重生」这条不变量**：
 * 每一条都会先 `DROP` / 清空派生物，再从真相源重建，然后逐项比对重建前后的读数。
 * 恒绿的检查没有价值；这些检查删掉 `rebuild()` 的对应步骤就会红。
 *
 * 中文必须用 trigram 那条也在这里钉住：两字查询走 `LIKE`、三字查询走 FTS。
 * 若把 tokenizer 换回默认的 `unicode61`，「调度器」这条必然红（中文子串切不出 token）。
 *
 * @module @matter/storage-journal/tests/search
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openJournalFacility, toMatchQuery } from "../src/index.ts"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** 打开一个临时库并登记清理。 */
async function openTemp(): Promise<Awaited<ReturnType<typeof openJournalFacility>>> {
  const root = await mkdtemp(join(tmpdir(), "matter-journal-search-"))
  const facility = await openJournalFacility(root)
  cleanups.push(() => facility.close())
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return facility
}

/** 灌三条中英混合的事件（够覆盖 FTS 与 LIKE 两条路径）。 */
function seed(facility: Awaited<ReturnType<typeof openJournalFacility>>): void {
  facility.append({
    entity: "issues/2026-11-16-ISS-1.md",
    event: "issue-noted",
    actor: "linmo",
    mdAt: "2026-11-16T12:50:49.694Z",
    body: "PM 调度器与事件流：活动流从只能看变成能用",
  })
  facility.append({
    entity: "issues/2026-11-16-ISS-2.md",
    event: "issue-created",
    actor: "linmo",
    mdAt: "2026-11-16T12:46:52.814Z",
    body: "回忆 doc 里没有那个词",
  })
  facility.append({
    entity: "docs/plan.md",
    event: "doc-imported",
    actor: "iris",
    mdAt: "2026-11-16T13:00:00.000Z",
    body: "storage-journal 的派生物必须能重建",
  })
}

describe("存一条 / 读一条 / 查一条（DOC-512 给 P1 的那句验收）", () => {
  it("append → list → search('调度器') 三条断言全过", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()

    // ① 存一条
    expect(facility.count()).toBe(3)
    // ② 读一条
    expect(facility.list({ entity: "issues/2026-11-16-ISS-1.md" }).rows).toHaveLength(1)
    // ③ 查一条
    const result = facility.search({ query: "调度器" })
    expect(result.mode).toBe("fts")
    expect(result.hits.map((hit) => hit.entity)).toEqual(["issues/2026-11-16-ISS-1.md"])
    // 命中词在正文里 ⇒ 高亮出现在 bodySnippet；标题列是路径末段，不含该词
    expect(result.hits[0]!.bodySnippet).toContain("<b>")
  })
})

describe("trigram tokenizer（中文子串必须命得中）", () => {
  it("三字中文词命得中，且片段里有高亮标记", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()
    const result = facility.search({ query: "调度器" })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.bodySnippet).toContain("<b>调度器</b>")
  })

  it("整串英文也命得中（trigram 对 ASCII 同样有效）", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()
    expect(facility.search({ query: "storage-journal" }).hits.map((hit) => hit.entity)).toEqual(["docs/plan.md"])
  })

  it("**两字中文**走 LIKE 兜底（trigram 切不出词元）—— 这条会红的是 tokenizer", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()
    const result = facility.search({ query: "派单" })
    // 「派单」在两字状态下 FTS5 恒 0 命中，兜底路径必须接手。
    // 语料里本来就没有「派单」，所以这里真正钉的是 mode：mode==='like' 说明走了兜底。
    expect(result.mode).toBe("like")
  })

  it("两字查询能命中标题里的字（LIKE 路径真的在查库）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/派单记录.md", event: "issue-noted", body: "无关正文" })
    facility.rebuild()
    const result = facility.search({ query: "派单" })
    expect(result.mode).toBe("like")
    expect(result.hits.map((hit) => hit.entity)).toEqual(["issues/派单记录.md"])
  })

  it("空查询直接回 empty，不查库", async () => {
    const facility = await openTemp()
    expect(facility.search({ query: "   " })).toEqual({ hits: [], mode: "empty" })
  })

  it("toMatchQuery 把用户输入里的 FTS5 语法字符变成字面量（注入面）", () => {
    expect(toMatchQuery('AND NEAR (')).toBe('"AND" "NEAR" "("')
    expect(toMatchQuery('say "hi"')).toBe('"say" """hi"""')
    expect(toMatchQuery("  ")).toBe("")
    // 真正的判据：含语法字符的查询不许抛（FTS5 语法错会抛，字面量不会）
    expect(() => toMatchQuery('a"b OR c')).not.toThrow()
  })
})

describe("搜索可重建（DROP pm_search 后 rebuild 行数一致）", () => {
  it("resetDerived() 清掉派生物后 rebuild() 回到同一组行", async () => {
    const facility = await openTemp()
    seed(facility)
    const first = facility.rebuild()
    expect(first.indexed).toBe(3)
    const before = facility.search({ query: "调度器" })
    expect(before.hits).toHaveLength(1)

    // ⭐ 真·丢掉派生物（不是 DELETE 行，是 DROP 表）
    const dropped = facility.resetDerived()
    expect(dropped.indexed).toBe(3)
    // 丢掉之后查询必须是空（证明「重建前后一致」不是靠残留）
    expect(facility.search({ query: "调度器" }).hits).toHaveLength(0)

    const second = facility.rebuild()
    expect(second.indexed).toBe(first.indexed)
    const after = facility.search({ query: "调度器" })
    expect(after.hits.map((hit) => hit.seq)).toEqual(before.hits.map((hit) => hit.seq))
  })

  it("真相源在重建过程中一行不丢、seq 不变", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()
    const seqsBefore = facility.list().rows.map((row) => row.seq)
    facility.resetDerived()
    facility.rebuild()
    expect(facility.list().rows.map((row) => row.seq)).toEqual(seqsBefore)
    expect(facility.count()).toBe(3)
  })

  it("reconcile() 在派生物被清空后按真相源补齐（并报出缺了几行）", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()
    facility.resetDerived()
    expect(facility.searchDelta().missing).toEqual([1, 2, 3])
    const reconciled = facility.reconcile()
    expect(reconciled).toMatchObject({ indexed: 3, evicted: 0 })
    expect(facility.searchDelta()).toEqual({ missing: [], orphaned: [] })
  })

  it("**索引多出一行**（孤行）时 reconcile 会删掉它（删边不放过的另一半）", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()
    // 通过真相源路径无法造孤行，故用第二个连接直接往 FTS5 里塞一条
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(facility.databasePath)
    try {
      db.prepare("INSERT INTO pm_search(rowid, entity, title, body, keys) VALUES(?,?,?,?,?)").run(
        9999,
        "ghost.md",
        "幽灵",
        "不该存在",
        "",
      )
    } finally {
      db.close()
    }
    expect(facility.searchDelta().orphaned).toEqual([9999])
    expect(facility.reconcile()).toMatchObject({ indexed: 0, evicted: 1 })
    expect(facility.searchDelta()).toEqual({ missing: [], orphaned: [] })
    expect(facility.search({ query: "幽灵" }).hits).toHaveLength(0)
  })

  it("**rebuild 清掉孤行**（只按 seq 删不够 —— 整表 DELETE 才是「回到真相源」）", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()
    // 造一条真相源里没有的孤行（seq 9999 不会与任何事件冲突）
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(facility.databasePath)
    try {
      db.prepare("INSERT INTO pm_search(rowid, entity, title, body, keys) VALUES(?,?,?,?,?)").run(
        9999, "ghost.md", "幽灵", "不该存在", "",
      )
    } finally {
      db.close()
    }
    expect(facility.stats().indexed).toBe(4)
    // ⭐ 变异实测：把 rebuildSearch 里的整表 DELETE 去掉 ⇒ 孤行留下 ⇒ 这条红。
    //    （只按 seq 删的写法在「无孤行」时与整表 DELETE 等效 —— 这个缺口正是这条测试补的。）
    expect(facility.rebuild().indexed).toBe(3)
    expect(facility.stats().indexed).toBe(3)
    expect(facility.searchDelta().orphaned).toEqual([])
  })

  it("索引与真相源本来就一致时 rebuild 幂等（行数不翻倍）", async () => {
    const facility = await openTemp()
    seed(facility)
    expect(facility.rebuild().indexed).toBe(3)
    expect(facility.rebuild().indexed).toBe(3)
    expect(facility.stats()).toMatchObject({ events: 3, indexed: 3 })
  })
})

describe("派生物无独立版本轴", () => {
  it("resetDerived + rebuild 不改 schemaVersion（派生层版本就是真相源版本）", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()
    const before = facility.identity().schemaVersion
    facility.resetDerived()
    facility.rebuild()
    expect(facility.identity().schemaVersion).toBe(before)
  })

  it("索引的行数等于真相源的条数（seq ↔ rowid 一一对应）", async () => {
    const facility = await openTemp()
    seed(facility)
    facility.rebuild()
    const stats = facility.stats()
    expect(stats.indexed).toBe(stats.events)
  })
})
