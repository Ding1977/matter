/**
 * 装配：`ctx.documents` 什么时候出现、什么时候消失。
 *
 * 「域能打开」与「插件挂上了服务键」是两件事：openDocuments 直接调能开，apply 里
 * 漏掉 `ctx.provide("documents", …)` 也一样能开，但没有任何消费者找得到它。
 * 本节判据就是这一对：inject 三处齐才出现；卸载后先摘键、再关域。
 *
 * @module @matter/document/tests/assembly
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { describe, expect, it, vi } from "vitest"
import Storage from "@matter/storage"
import * as StorageJson from "@matter/storage-json"
import * as StorageDomain from "@matter/storage-domain"
import { openJournalFacility } from "@matter/storage-journal"
import * as DocumentPlugin from "../src/index.ts"
import { DocumentsFacility, openDocuments } from "../src/index.ts"

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "matter-document-assembly-"))
}

const draft = (id: string) => ({
  props: { id, title: "装配", author: "linmo", created: "2026-11-20T00:00:00Z", updated: "2026-11-20T00:00:00Z" },
  blocks: [{ id: "b1", type: "paragraph" as const }],
})

describe("插件装配", () => {
  it("三处依赖齐才激活；缺 journal 时不激活（服务键不出现）", async () => {
    const root = await tempRoot()
    const ctx = new Context()
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root: join(root, "records") })
      await ctx.plugin(StorageDomain, { backend: "json" })
      const fiber = await ctx.plugin(DocumentPlugin)
      expect(ctx.get("documents")).toBeUndefined()

      const journal = await openJournalFacility(root)
      const disposeJournal = ctx.provide("journal", journal)
      await vi.waitFor(() => { expect(ctx.documents).toBeInstanceOf(DocumentsFacility) })

      disposeJournal()
      await vi.waitFor(() => { expect(ctx.get("documents")).toBeUndefined() })
      await fiber.dispose()
      journal.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("卸载后域已关：句柄不可再写，域名可重新打开；审计仍在", async () => {
    const root = await tempRoot()
    const ctx = new Context()
    const journal = await openJournalFacility(root)
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root: join(root, "records") })
      await ctx.plugin(StorageDomain, { backend: "json" })
      ctx.provide("journal", journal)
      const fiber = await ctx.plugin(DocumentPlugin)
      await vi.waitFor(() => { expect(ctx.documents).toBeInstanceOf(DocumentsFacility) })
      const documents = ctx.documents
      await documents.create(draft("DOC-A1"))

      await fiber.dispose()
      await expect(documents.create(draft("DOC-A2"))).rejects.toThrow(/closed/)

      const reopened = await openDocuments(ctx)
      await expect(reopened.get("DOC-A1")).toBeDefined()
      expect(journal.count()).toBe(1)
      await reopened.close()
    } finally {
      journal.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
