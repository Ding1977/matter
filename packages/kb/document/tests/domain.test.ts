/**
 * 文档门的写链、blocks 平级落盘与活动流：本单验收的核心断言。
 *
 * 钉住的不变量：
 *   ① {props, blocks} 平级落盘、换现场读回一致；坏 block 在 durable 边界报 invalid-record；
 *   ② 写链顺序 = 落盘 → 内存 → domain/changed → 审计（审计严格晚于域事件）；
 *   ③ 活动流有真实数据：created / field-change / status-change / body-change / deleted；
 *   ④ 幂等键有效：重放同一事件不新增行。
 *
 * @module @matter/document/tests/domain
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DocumentNotFoundError, createdEntries, documentEntity } from "../src/index.ts"
import { boot, bootContext, type Harness } from "./helpers/harness.ts"

/** 一条最小合法文档记录（props 5 必填 + 一段正文块）。 */
const draft = (id = "DOC-1", extra: Record<string, unknown> = {}, blocks: unknown[] = [{ id: "b1", type: "paragraph", rich: [{ text: "正文" }] }]) => ({
  props: {
    id, title: "第一份", author: "linmo",
    created: "2026-11-20T00:00:00Z", updated: "2026-11-20T00:00:00Z",
    ...extra,
  },
  blocks,
})

async function withHarness(body: (h: Harness) => Promise<void>): Promise<void> {
  const h = await boot()
  try {
    await body(h)
  } finally {
    await h.dispose()
  }
}

describe("写链：create → get，平级落盘与重启读回（验收 1）", () => {
  it("create → get 读回同一条；重建现场仍读得回（真落盘 {props, blocks}）", async () => {
    const first = await boot()
    const root = first.root
    try {
      const created = await first.documents.create(draft("DOC-1"))
      expect(created).toEqual(draft("DOC-1"))
      expect(first.documents.get("DOC-1")).toEqual(created)
      expect(first.documents.size).toBe(1)
      // 物理落盘：一条记录一个文档，props 与 blocks 是 record 的平级两字段。
      const file = join(root, "records", "kb_document", "document", "DOC-1.json")
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        version: 1,
        record: draft("DOC-1"),
      })
    } finally {
      await first.shutdown()
    }
    const second = await boot(root)
    try {
      expect(second.documents.get("DOC-1")).toMatchObject({
        props: { title: "第一份" },
        blocks: [{ id: "b1", type: "paragraph" }],
      })
      expect(second.journal.count()).toBe(1) // 审计也持久化
    } finally {
      await second.shutdown()
    }
  })

  it("update 只改给定顶层槽：换 props 不动 blocks，换 blocks 不动 props；空 PATCH 不落盘不记审计", async () => {
    await withHarness(async (h) => {
      await h.documents.create(draft("DOC-2"))
      const seen = h.journal.count()
      const nextProps = { ...draft("DOC-2").props, title: "改了标题" }
      const u1 = await h.documents.update("DOC-2", { props: nextProps })
      expect(u1.props.title).toBe("改了标题")
      expect(u1.blocks).toEqual(draft("DOC-2").blocks)
      expect(h.journal.count()).toBe(seen + 1)

      const newBlocks = [{ id: "b9", type: "heading", level: 2, rich: [{ text: "新章节" }] }]
      const u2 = await h.documents.update("DOC-2", { blocks: newBlocks })
      expect(u2.props.title).toBe("改了标题")
      expect(u2.blocks).toEqual(newBlocks)
      expect(h.journal.count()).toBe(seen + 2)

      const again = await h.documents.update("DOC-2", { blocks: newBlocks })
      expect(again).toEqual(u2)
      expect(h.journal.count()).toBe(seen + 2) // 空写：不落盘、不记审计
    })
  })

  it("校验失败抛 zod error（create / update 两条入口），坏记录不落盘", async () => {
    await withHarness(async (h) => {
      await expect(h.documents.create({ ...draft("DOC-3"), props: { ...draft("DOC-3").props, status: "zap" } } as never)).rejects.toThrow()
      expect(h.documents.get("DOC-3")).toBeUndefined()
      expect(h.journal.count()).toBe(0)
      await h.documents.create(draft("DOC-4"))
      await expect(h.documents.update("DOC-4", { blocks: [{ id: "x", type: "paragraph", children: [] }] } as never)).rejects.toThrow()
      expect(h.documents.get("DOC-4")!.blocks).toEqual(draft("DOC-4").blocks)
    })
  })

  it("create 同 id 报错；update / remove 不存在报错或返回 false", async () => {
    await withHarness(async (h) => {
      await h.documents.create(draft("DOC-5"))
      await expect(h.documents.create(draft("DOC-5"))).rejects.toMatchObject({ name: "DocumentExistsError" })
      await expect(h.documents.update("DOC-404", { props: draft("DOC-404").props }))
        .rejects.toBeInstanceOf(DocumentNotFoundError)
      await expect(h.documents.remove("DOC-404")).resolves.toBe(false)
      await expect(h.documents.remove("DOC-5")).resolves.toBe(true)
      expect(h.documents.get("DOC-5")).toBeUndefined()
    })
  })

  it("全量 25 字段的记录 create 可过；落盘保留全部字段", async () => {
    await withHarness(async (h) => {
      const full = draft("DOC-25", {
        activity: "会话", cardKind: "session-distill", deleted: false, kind: "document",
        log_size: "2.2M", mediaType: "md", model: "hy4", outcome: "完成", project: "PRJ-1",
        refs: ["AGENTS.md"], relations: ["references|issues/x.md"], session: "s1",
        session_kind: "main", source: "/tmp/x.md", source_session: "s0", status: "done",
        tags: ["topic/x"], type: "document", verdict: "可 purge", workspace: "/repo",
      })
      const created = await h.documents.create(full)
      expect(Object.keys(created.props)).toHaveLength(25)
      expect(h.documents.get("DOC-25")).toEqual(created)
    })
  })
})

describe("blocksSchema 在 durable 边界生效：坏 block 校验红（验收 2）", () => {
  it("磁盘上早就有坏 block ⇒ 重新打开整域 invalid-record，detail 带 table/key", async () => {
    const first = await boot()
    const root = first.root
    try {
      await first.documents.create(draft("DOC-BAD"))
    } finally {
      await first.shutdown()
    }
    const file = join(root, "records", "kb_document", "document", "DOC-BAD.json")
    const onDisk = JSON.parse(await readFile(file, "utf8"))
    // 叶子块塞 children ⇒ V5 红；绕过写面直接改盘（模拟存量坏数据）。
    onDisk.record.blocks = [{ id: "b1", type: "paragraph", children: [] }]
    await writeFile(file, JSON.stringify(onDisk), "utf8")

    const ctx = await bootContext(root)
    try {
      await expect(ctx.storageDomain.open((await import("../src/index.ts")).DocumentDomain))
        .rejects.toMatchObject({ code: "invalid-record", detail: { table: "document", key: "DOC-BAD" } })
    } finally {
      ctx.journal.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("写链顺序与活动流（验收 3–4）", () => {
  it("一次 create 留三线索：内存可读、domain/changed 发过、活动流有行（审计在其后）", async () => {
    await withHarness(async (h) => {
      const changes: unknown[] = []
      const countsAtEvent: number[] = []
      h.ctx.on("domain/changed", (change: unknown) => {
        changes.push(change)
        countsAtEvent.push(h.journal.count())
      })
      await h.documents.create(draft("DOC-6"))
      expect(h.documents.get("DOC-6")).toBeDefined()
      expect(changes).toEqual([{
        domain: "kb_document", table: "document", key: "DOC-6", operation: "put",
        value: draft("DOC-6"),
      }])
      expect(countsAtEvent).toEqual([0]) // 监听器跑时审计还没有行
      expect(h.journal.count()).toBe(1)
    })
  })

  it("各字段变更落对事件名：title → field-change，status → status-change，blocks → body-change，删 → deleted", async () => {
    await withHarness(async (h) => {
      await h.documents.create(draft("DOC-7", { status: "draft" }))
      const rows = () => h.journal.list({ entity: documentEntity("DOC-7") }).rows
      expect(rows()[0]).toMatchObject({ event: "created", known: 1 })

      await h.documents.update("DOC-7", { props: { ...draft("DOC-7", { status: "draft" }).props, title: "新标题" } })
      expect(rows().at(-1)).toMatchObject({ event: "field-change", payload: { field: "title", from: "第一份", to: "新标题" } })

      await h.documents.update("DOC-7", { props: { ...draft("DOC-7", { status: "in_progress" }).props, title: "新标题" } })
      expect(rows().at(-1)).toMatchObject({ event: "status-change", payload: { field: "status", from: "draft", to: "in_progress" } })

      await h.documents.update("DOC-7", { blocks: [{ id: "b1", type: "paragraph", rich: [{ text: "完全不同的正文" }] }] })
      const bodyRow = rows().at(-1)!
      expect(bodyRow.event).toBe("body-change")
      expect(bodyRow.payload).toMatchObject({ field: "blocks", blockDelta: 0 })
      expect(JSON.stringify(bodyRow.payload)).not.toContain("完全不同的正文") // 只记指纹不记正文

      await h.documents.remove("DOC-7")
      expect(rows().at(-1)).toMatchObject({ event: "deleted" })
    })
  })

  it("一次 update 改多个 props 字段 ⇒ 一字段一条事件，按字段名序；数组按值比较", async () => {
    await withHarness(async (h) => {
      const base = draft("DOC-8", { tags: ["a", "b"] })
      await h.documents.create(base)
      const seen = h.journal.count()
      await h.documents.update("DOC-8", {
        props: { ...base.props, tags: ["a", "b"], title: "换标题", verdict: "可读" },
      })
      const fields = h.journal.list({ entity: documentEntity("DOC-8") }).rows.slice(seen)
        .map((r) => (r.payload as { field: string }).field)
      expect(fields).toEqual(["title", "verdict"]) // tags 内容相同不算变更
    })
  })
})

describe("幂等键有效（验收 5）", () => {
  it("同一事件重放不新增行；真实不同时刻的同类事件是两条", async () => {
    await withHarness(async (h) => {
      const at = new Date("2026-11-20T03:00:00.000Z")
      await h.documents.create(draft("DOC-9"), { actor: "linmo", at })
      expect(h.journal.count()).toBe(1)
      const [replay] = createdEntries("DOC-9", { actor: "linmo", at })
      h.journal.append(replay!)
      expect(h.journal.count()).toBe(1)
      const [later] = createdEntries("DOC-9", { actor: "linmo", at: new Date(at.getTime() + 1) })
      h.journal.append(later!)
      expect(h.journal.count()).toBe(2)
    })
  })
})

describe("真落盘目录口径（反例形态可复核）", () => {
  it("落盘文件位于 kb_document/document/ 下、文件名即 id（不是裸 props）", async () => {
    const root = await mkdtemp(join(tmpdir(), "matter-doc-layout-"))
    const h = await boot(root)
    try {
      await h.documents.create(draft("DOC-LAYOUT"))
      const file = join(root, "records", "kb_document", "document", "DOC-LAYOUT.json")
      const raw = JSON.parse(await readFile(file, "utf8"))
      expect(raw).toHaveProperty("record.props")
      expect(raw).toHaveProperty("record.blocks")
      expect(raw).not.toHaveProperty("record.title") // 若变成裸 props，这条红
    } finally {
      await h.dispose()
    }
  })
})
