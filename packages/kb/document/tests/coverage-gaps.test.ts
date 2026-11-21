/**
 * @matter/document 的事件换算与审计降级分支补测。
 *
 * 覆盖「写面拦得住、但事件换算层仍要诚实处理」的防御面：
 * 外来事件名、非数组 blocks、previous 缺失、审计追加失败的 warn、块数组引用比较。
 *
 * @module @matter/document/tests/coverage-gaps
 */

import { describe, expect, it } from "vitest"
import type { DocRecord } from "../src/index.ts"
import {
  DOCUMENT_EVENTS, blocksFingerprint, diffEntries, logValue, sameValue,
  documentEntry, documentEntity, openDocuments,
} from "../src/index.ts"
import { bootBare } from "./helpers/harness.ts"

const draft = (id = "DOC-1", extra: Record<string, unknown> = {}): DocRecord => ({
  props: {
    id, title: "第一份", author: "linmo",
    created: "2026-11-20T00:00:00Z", updated: "2026-11-20T00:00:00Z", ...extra,
  },
  blocks: [{ id: "b1", type: "paragraph" }],
})

describe("事件换算的防御面", () => {
  it("表外事件名落 known:0；现行词表不写 known", () => {
    expect(documentEntry("DOC-1", "unknown-event", {})).toMatchObject({ known: 0 })
    expect(documentEntry("DOC-1", "created", {})).not.toHaveProperty("known")
    expect([...DOCUMENT_EVENTS].sort()).toEqual(["body-change", "created", "deleted", "field-change", "status-change"])
  })

  it("blocksFingerprint 非数组按空数组算；相同内容哈希相同", () => {
    expect(blocksFingerprint(undefined)).toMatchObject({ blocks: 0 })
    expect(blocksFingerprint("oops")).toMatchObject({ blocks: 0 })
    const a = blocksFingerprint([{ id: "b1", type: "paragraph" }])
    const b = blocksFingerprint([{ id: "b1", type: "paragraph" }])
    expect(a.hash).toBe(b.hash)
    expect(blocksFingerprint([]).hash).not.toBe(a.hash)
    expect(documentEntity("DOC-7")).toBe("documents/DOC-7")
  })

  it("previous 缺失 ⇒ created 单条；sameValue 对 null 与对象不等", () => {
    expect(diffEntries("DOC-1", undefined, draft())).toBeDefined()
    const entries = diffEntries("DOC-1", undefined, draft())
    expect(entries).toHaveLength(1)
    expect(entries[0]!.event).toBe("created")
    expect(sameValue(null, { a: 1 })).toBe(false)
    expect(sameValue({ a: 1 }, null)).toBe(false)
  })

  it("props 无变化且 blocks 引用不同但内容相同 ⇒ 不记事件（按值比较）", () => {
    const prev = draft("DOC-2")
    const next: DocRecord = { ...prev, blocks: [{ id: "b1", type: "paragraph" }] }
    expect(diffEntries("DOC-2", prev, next)).toEqual([])
  })

  it("表外状态值走 field-change，不冒充 status-change", () => {
    const prev = draft("DOC-3", { status: "draft" })
    const next = draft("DOC-3", { status: "zap" })
    const entries = diffEntries("DOC-3", prev, next)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.event).toBe("field-change")
  })

  it("logValue 长对象截断到 LOG_VALUE_MAX", () => {
    expect(logValue({ a: 1 })).toBe('{"a":1}')
    expect(logValue({ blob: "x".repeat(300) }).length).toBe(201)
  })
})

describe("门面：entries 与审计降级", () => {
  it("journal.append 抛 Error 与非 Error 都只 warn 不中断写入", async () => {
    const bare = await bootBare()
    const warns: string[] = []
    ;(bare.ctx as unknown as { logger: unknown }).logger = () => ({ warn: (m: string) => warns.push(m) })
    let thrown: unknown = new Error("audit down")
    const journal = bare.journal as unknown as { append: (e: unknown) => void }
    journal.append = () => { throw thrown }

    const documents = await openDocuments(bare.ctx)
    await documents.create(draft("DOC-90"))
    thrown = "plain string failure"
    await documents.create(draft("DOC-91"))

    expect([...documents.entries()]).toHaveLength(2)
    expect(warns).toHaveLength(2)
    expect(warns[0]).toContain("audit down")
    expect(warns[1]).toContain("plain string failure")
    await documents.close()
    await bare.dispose()
  })
})

describe("ISS-528 · props 字段增删与脏 previous 的防御面", () => {
  it("字段删除（新值缺席）⇒ to 记 null；字段新增（旧值缺席）⇒ from 记 null", () => {
    const had = draft("DOC-40", { status: "draft" })
    const dropped: DocRecord = { ...had, props: { ...had.props, status: undefined } }
    const dropEntries = diffEntries("DOC-40", had, dropped)
    expect(dropEntries).toHaveLength(1)
    // 新值缺席不冒充状态信号：undefined 不在词表 ⇒ field-change，且 to 记 null 不记 "undefined"。
    expect(dropEntries[0]).toMatchObject({ event: "field-change", field: "status", from: "draft", to: null })

    const added = draft("DOC-41", { status: "in_progress" })
    const addEntries = diffEntries("DOC-41", draft("DOC-41"), added)
    expect(addEntries).toHaveLength(1)
    // 旧值缺席、新值在词表内 ⇒ 正常 status-change，from 记 null。
    expect(addEntries[0]).toMatchObject({ event: "status-change", field: "status", from: null, to: "in_progress" })
  })

  it("脏 previous（props 丢失）⇒ props 维度安静、body 维度照常，不炸不掺噪声", () => {
    const dirty = { ...draft("DOC-42"), props: undefined } as unknown as DocRecord
    // blocks 相同：整个 diff 安静为空（created 兜底回调吞掉 props 路径）。
    expect(diffEntries("DOC-42", dirty, draft("DOC-42"))).toEqual([])
    // blocks 变了：body-change 照常出，props 侧一条不多。
    const edited: DocRecord = { ...draft("DOC-42"), blocks: [{ id: "b2", type: "paragraph" }] }
    const entries = diffEntries("DOC-42", dirty, edited)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ event: "body-change", field: "blocks" })
  })
})
