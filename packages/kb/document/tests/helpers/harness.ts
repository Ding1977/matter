/**
 * 文档域测试的装配：真 storage hub + 真 JSON 后端 + 真 journal，落在临时目录。
 *
 * 走真 `@matter/storage-json` 而非内存替身：验收要的是「{props, blocks} 真落盘、
 * 换现场读得回」，内存后端证明不了落盘（E-0 harness 同款口径）。
 * 插件按命名空间整体挂（-storage-json / -storage-domain 无 default export）。
 *
 * @module @matter/document/tests/helpers/harness
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import Storage from "@matter/storage"
import * as StorageJson from "@matter/storage-json"
import * as StorageDomain from "@matter/storage-domain"
import { openJournalFacility, type JournalFacility } from "@matter/storage-journal"
import { DocumentsFacility, openDocuments } from "../../src/index.ts"

/** 一套已装配好的现场。 */
export interface Harness {
  readonly ctx: Context
  readonly journal: JournalFacility
  readonly documents: DocumentsFacility
  readonly root: string
  /** 关掉全部资源，不删目录（「重启」用例复用同一根）。 */
  shutdown(): Promise<void>
  /** shutdown + 删临时目录。 */
  dispose(): Promise<void>
}

/**
 * 起一套现场。
 * @param reuseRoot - 已有根目录（模拟重启）；不给则新建。
 * @returns 已装配的现场。
 */
export async function boot(reuseRoot?: string): Promise<Harness> {
  const root = reuseRoot ?? await mkdtemp(join(tmpdir(), "matter-document-"))
  const ctx = await bootContext(root)
  const journal = ctx.journal
  const documents = await openDocuments(ctx)
  return {
    ctx,
    journal,
    documents,
    root,
    shutdown: async () => {
      await documents.close()
      journal.close()
    },
    dispose: async () => {
      await documents.close()
      journal.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * 只装配上下文与 journal（不打开文档域），给装配/注销类用例用。
 * @param root - 临时根目录（必须已存在）。
 * @returns 装配好的上下文。
 */
export async function bootContext(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, "records") })
  await ctx.plugin(StorageDomain, { backend: "json" })
  const journal = await openJournalFacility(root)
  ctx.provide("journal", journal)
  return ctx
}

/**
 * 与 boot 同，但不打开文档域 —— 给「ctx.documents 何时出现」的用例。
 */
export async function bootBare(): Promise<{ ctx: Context; journal: JournalFacility; root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "matter-document-bare-"))
  const ctx = await bootContext(root)
  return {
    ctx,
    journal: ctx.journal,
    root,
    dispose: async () => {
      ctx.journal.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
