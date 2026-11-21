/**
 * storage-journal 的配置校验、写入异常与 schema 收敛补测（ISS-523 / C-0b）。
 *
 * 覆盖主流程不经过但确有行为的分支：加载期配置窄校验、写被静默吞掉、
 * 空游标读、actor 缺席、目录/文件类 IO 故障、旧 schema 版本升级、
 * 索引投影对坏 payload 的宽容。
 * @module @matter/storage-journal/tests/coverage-gaps
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Context } from "@deepseek-ai/cordis"
import { describe, expect, it, vi } from "vitest"
import {
  JOURNAL_SCHEMA_VERSION,
  JournalFacility,
  appendJournal,
  listJournal,
  normalizeConfig,
  openJournalDatabase,
  openJournalFacility,
  readIdentity,
  apply as journalApply,
} from "../src/index.ts"

async function tempRoot(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "matter-journal-cov-"))
  return { root, dispose: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

describe("normalizeConfig：加载期窄校验", () => {
  it("root 缺失/空、journalMode 非法当场抛；合法值归一化", () => {
    expect(() => normalizeConfig({} as never)).toThrow(/config\.root/)
    expect(() => normalizeConfig({ root: "" })).toThrow(/config\.root/)
    expect(() => normalizeConfig({ root: "/tmp/x", journalMode: "bogus" as never })).toThrow(/config\.journalMode/)
    expect(normalizeConfig({ root: "/tmp/x" })).toEqual({ root: "/tmp/x", journalMode: undefined })
  })
})

describe("openJournalFacility / apply", () => {
  it(":memory: 路径也走同一入口", async () => {
    const facility = await openJournalFacility(":memory:")
    expect(facility.databasePath).toBe(":memory:")
    facility.close()
  })

  it("插件挂载后 ctx.journal 可用，注销时关库", async () => {
    const { root, dispose } = await tempRoot()
    try {
      const ctx = new Context()
      const JournalPlugin = await import("../src/index.ts")
      const fiber = await ctx.plugin(JournalPlugin, { root })
      await vi.waitFor(() => { expect(ctx.journal).toBeInstanceOf(JournalFacility) })
      const facility = ctx.journal
      await fiber.dispose()
      // 注销后服务键被摘掉，但持有的 facility 必须已关库（读它抛 closed）。
      expect(() => facility.count()).toThrow(/closed/)
    } finally {
      await dispose()
    }
  })
})

describe("append / list 的异常与缺省形态", () => {
  it("写入被触发器吞掉（没有行）时抛 io，不返回假 seq", async () => {
    const db = await openJournalDatabase(":memory:")
    db.exec("CREATE TRIGGER swallow BEFORE INSERT ON activity_log BEGIN SELECT RAISE(IGNORE); END")
    expect(() => appendJournal(db, { entity: "issues/x", event: "created", at: 1 }))
      .toThrow(/produced no row/)
    db.close()
  })

  it("空表游标读：next 就是 since，不是凭空造一个 seq", async () => {
    const db = await openJournalDatabase(":memory:")
    expect(listJournal(db, { since: 42 })).toMatchObject({ rows: [], next: 42, truncated: false })
    db.close()
  })

  it("未署名的事件读回 actor: null，uid 缺席也读回 null", async () => {
    const db = await openJournalDatabase(":memory:")
    appendJournal(db, { entity: "issues/x", event: "created", at: 1 })
    expect(listJournal(db).rows[0]!.actor).toBeNull()
    db.prepare(
      "INSERT INTO activity_log(entity,event,at,known,payload_json,md_at,uid) VALUES(?,?,?,?,?,?,?)",
    ).run("issues/y", "created", 2, 1, null, null, null)
    expect(listJournal(db).rows.find((r) => r.entity === "issues/y")!.uid).toBeNull()
    db.close()
  })
})

describe("schema 收敛的失败与升级分支", () => {
  it("目标目录不可写：open(wx) 抛 EACCES（非 EEXIST）原样上报", async () => {
    const { root, dispose } = await tempRoot()
    try {
      await chmod(root, 0o500)
      await expect(openJournalDatabase(join(root, "journal.db"))).rejects.toMatchObject({ code: "EACCES" })
    } finally {
      await chmod(root, 0o700)
      await dispose()
    }
  })

  it("库目录的父级是文件：mkdir 失败包成 io 错误", async () => {
    const { root, dispose } = await tempRoot()
    try {
      await writeFile(join(root, "blocker"), "x", "utf8")
      await expect(openJournalDatabase(join(root, "blocker", "sub", "journal.db")))
        .rejects.toThrow(/cannot create directory/)
    } finally {
      await dispose()
    }
  })

  it("旧 journal_meta 版本 ⇒ 重建派生层并把版本写回当前值", async () => {
    const { root, dispose } = await tempRoot()
    const path = join(root, "journal.db")
    try {
      const created = await openJournalDatabase(path)
      created.close()
      const raw = new DatabaseSync(path)
      raw.exec("UPDATE journal_meta SET version = 0 WHERE singleton = 1")
      raw.close()
      const reopened = await openJournalDatabase(path)
      expect(readIdentity(reopened).schemaVersion).toBe(JOURNAL_SCHEMA_VERSION)
      reopened.close()
    } finally {
      await dispose()
    }
  })

  it("journal_meta 无版本行 ⇒ schemaVersion 记 0", async () => {
    const db = await openJournalDatabase(":memory:")
    db.exec("DELETE FROM journal_meta")
    expect(readIdentity(db).schemaVersion).toBe(0)
    db.close()
  })
})

describe("索引投影对坏 payload 的宽容", () => {
  it("payload_json 为 NULL 或非 JSON 时仍可重建，不拖垮整库", async () => {
    const db = await openJournalDatabase(":memory:")
    const insert = db.prepare(
      "INSERT INTO activity_log(entity,event,at,known,payload_json,md_at,uid) VALUES(?,?,?,?,?,?,?)",
    )
    insert.run("issues/a", "created", 1, 1, null, null, "u-null")
    insert.run("issues/b", "created", 2, 1, "not json", null, "u-bad")
    const facility = new JournalFacility(db, ":memory:")
    expect(() => facility.rebuild()).not.toThrow()
    facility.close()
  })
})
