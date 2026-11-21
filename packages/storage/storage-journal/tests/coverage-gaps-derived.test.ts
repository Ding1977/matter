/**
 * 派生物（全文索引 / 边表）的宽容解析与事务回滚补测（ISS-523 / C-0b）。
 *
 * 这些分支决定「一条脏数据能不能拖垮整次重建」以及「中途失败会不会留下半份索引」——
 * 都是静默错的来源，必须有确定性用例。
 * @module @matter/storage-journal/tests/coverage-gaps-derived
 */

import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  openJournalDatabase,
  projectRow,
  rebuildEdges,
  rebuildSearch,
  searchText,
  toMatchQuery,
} from "../src/index.ts"

/** 插一条原始 journal 行，payload_json 允许 NULL / 坏 JSON。 */
function rawRow(db: DatabaseSync, uid: string, payloadJson: string | null, entity = "issues/x"): void {
  db.prepare(
    "INSERT INTO activity_log(entity,event,at,known,payload_json,md_at,uid) VALUES(?,?,?,?,?,?,?)",
  ).run(entity, "created", 1, 1, payloadJson, null, uid)
}

describe("projectRow：宽容投影", () => {
  it("payload 为 null 时按空对象投影；数组里的字符串/数字进 keys，对象不进", () => {
    const empty = projectRow({ seq: 1, entity: "issues/a/b", event: "created", actor: null, known: 1, payload: null })
    expect(empty.title).toBe("b")
    expect(empty.keys).toBe("created")
    const withArray = projectRow({
      seq: 2, entity: "issues/a/b", event: "created", actor: null, known: 1,
      payload: { tags: ["alpha", 42, { nested: "skip" }, true], meta: { nested: "skip" } },
    })
    expect(withArray.keys).toContain("alpha")
    expect(withArray.keys).toContain("42")
    expect(withArray.keys).not.toContain("skip")
    expect(withArray.keys).not.toContain("true")
  })
})

describe("查询串与结果列的缺省形态", () => {
  it("toMatchQuery / searchText 对 null 入参按空串处理", async () => {
    expect(toMatchQuery(null as never)).toBe("")
    const db = await openJournalDatabase(":memory:")
    expect(searchText(db, { query: null as never })).toEqual({ hits: [], mode: "empty" })
    db.close()
  })

  it("索引行的 NULL 片段读回空串，不把 null 漏给调用方", async () => {
    const db = await openJournalDatabase(":memory:")
    db.prepare("INSERT INTO pm_search(rowid, entity, title, body, keys) VALUES(1, ?, NULL, NULL, ?)")
      .run("issues/x", "needle")
    expect(searchText(db, { query: "needle" }).hits[0]).toMatchObject({ titleSnippet: "", bodySnippet: "" })
    expect(searchText(db, { query: "ne" }).hits[0]).toMatchObject({ titleSnippet: "", bodySnippet: "" })
    // 短串 LIKE 路径里的 % / _ 必须按字面量转义，否则会变成通配符。
    expect(searchText(db, { query: "%_" }).mode).toBe("like")
    db.close()
  })
})

describe("重建的事务回滚", () => {
  it("索引表缺失 ⇒ rebuildSearch 抛错且不留半份索引", async () => {
    const db = await openJournalDatabase(":memory:")
    db.exec("DROP TABLE pm_search")
    expect(() => rebuildSearch(db, [{ seq: 1, entity: "issues/x", title: "x", body: "y", keys: "z" }]))
      .toThrow()
    db.close()
  })

  it("边表缺失 ⇒ rebuildEdges 抛错且不留下半张表", async () => {
    const db = await openJournalDatabase(":memory:")
    db.exec("DROP TABLE edges")
    expect(() => rebuildEdges(db)).toThrow()
    db.close()
  })
})

describe("edgesOf：畸形边值不产边，合法项照常", () => {
  it("null / 非数组 / 非字符串项 / 空 dst 或 kind 都被跳过", async () => {
    const db = await openJournalDatabase(":memory:")
    rawRow(db, "u1", JSON.stringify({ parent: null, relations: "not-array" }), "issues/a")
    rawRow(db, "u2", JSON.stringify({ parent: 123 }), "issues/b")
    rawRow(db, "u3", JSON.stringify({
      relations: [123, "", "|nodst", "kind|", "references|ISS-1"],
    }), "issues/c")
    rawRow(db, "u4", null, "issues/d")
    rawRow(db, "u5", "not json", "issues/e")
    const count = rebuildEdges(db)
    // 只有 issues/c 的 references|ISS-1 是合法边。
    expect(count).toBe(1)
    db.close()
  })

  it("同一 seq 的重复边走 prior 分支（去重不只看是否首见）", async () => {
    const db = await openJournalDatabase(":memory:")
    rawRow(db, "u1", JSON.stringify({ relations: ["parent|ISS-9", "parent|ISS-9"] }), "issues/x")
    expect(rebuildEdges(db)).toBe(1)
    db.close()
  })

  it("同一 (src,kind,dst) 两次出现时取较大 seq（去重分支）", async () => {
    const db = await openJournalDatabase(":memory:")
    rawRow(db, "u1", JSON.stringify({ relations: ["parent|ISS-9"] }), "issues/x")
    rawRow(db, "u2", JSON.stringify({ parent: "ISS-9" }), "issues/x")
    expect(rebuildEdges(db)).toBe(1)
    db.close()
  })
})
