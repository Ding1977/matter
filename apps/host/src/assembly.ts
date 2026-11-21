/**
 * Host 侧最小装配面（ISS-542 / P4-N2 · N 轨收官）。
 *
 * 把「storage → documents → controller → connection host → gateway host」在同一
 * node 进程装配，并在 Connection 共享的 `/api` FetchHandler 上挂 gateway
 * interceptor（P4-0 问3 §3.4 实证：gateway 必须与 connection 同挂，否则无 HTTP 入口）。
 *
 * 真后端而非内存替身：storage-json 落临时目录、真 journal、真 `openDocuments`、
 * 真 `DocumentController`（走 `ctx.documents`）。唯一的最小化是 Typert/remote-access/
 * credentials 三角色的 shim（见 ./typert-shim），因为 P4 闭环只用 owner + unary。
 *
 * @module apps/host/src/assembly
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { API_PATH, apply as applyConnection, type ConnectionFetchHandler } from "@deepseek-ai/dsh-client-connection"
import TypertGatewayService from "@deepseek-ai/dsh-api-gateway"
import { TYPERT } from "@matter/document-controller/typert"
import { DocumentController } from "@matter/document-controller"
import type { DocRecord } from "@matter/document"
import { openDocuments } from "@matter/document"
import Storage from "@matter/storage"
import * as StorageJson from "@matter/storage-json"
import * as StorageDomain from "@matter/storage-domain"
import { openJournalFacility, type JournalFacility } from "@matter/storage-journal"
import { createTypertShim, hostContributionFrom } from "./typert-shim.ts"

/** 一条装配后可读回的文档种子。 */
export interface SeedDoc {
  readonly record: DocRecord
}

/** 装配完成的 host 现场。 */
export interface HostAssembly {
  /** 已装配全部服务的 cordis host context。 */
  readonly ctx: Context
  /** gateway 与 connection 共享的 `/api` FetchHandler（未认领 endpoint ⇒ 404）。 */
  readonly sharedFetch: ConnectionFetchHandler
  /** gateway host 服务（供断言 `ctx.typertGateway` 存在）。 */
  readonly gateway: TypertGatewayService
  /** 临时存储根目录（真落盘，测试结束 dispose 删除）。 */
  readonly root: string
  /** 关闭 journal + 删除临时目录。 */
  dispose(): Promise<void>
}

/** 装配输入的可见配置。 */
export interface HostAssemblyOptions {
  /** 预置文档记录（走真 `documents.create` 落盘）。 */
  readonly seedDocs?: readonly SeedDoc[]
  /** 自定义临时根目录（默认系统临时目录下新建）。 */
  readonly root?: string
}

/** credentials 最小提供方：BrowserAuth 用 modifyRecord 生成/读回签名密钥记录。 */
function memoryCredentials(): Record<string, unknown> {
  const records = new Map<unknown, unknown>()
  return {
    async readRecord(key: unknown) {
      return records.get(key)
    },
    async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>) {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
    async deleteRecord(key: unknown) {
      records.delete(key)
    },
  } as Record<string, unknown>
}

/**
 * 起一套 host 现场。顺序按依赖：storage hub → json 后端 → storageDomain → journal →
 * documents → credentials/typert/remoteAccess shim → connection host → gateway host → controller。
 *
 * gateway 的 `ctx.inject(['connection'], …)` 在构造时把 interceptor 挂到 connection 的
 * rpc 注册表；connection 的 `createSharedFetchHandler(API_PATH)` 把该 interceptor 接进
 * 唯一 `/api` FetchHandler——两者同挂即此处（P4-0 问3）。
 *
 * @param options - 预置文档与临时根目录。
 * @returns 已装配的 host 现场，测试结束须 `dispose()`。
 */
export async function createHostAssembly(options: HostAssemblyOptions = {}): Promise<HostAssembly> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "matter-host-"))
  const ctx = new Context()

  // ① 真 storage 链（落临时目录，非内存替身）
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, "records") })
  await ctx.plugin(StorageDomain, { backend: "json" })
  const journal: JournalFacility = await openJournalFacility(root)
  ctx.provide("journal", journal)
  const documents = await openDocuments(ctx)
  ctx.provide("documents", documents)

  // ② 种子文档（走真门面 create，进 journal）
  for (const seed of options.seedDocs ?? []) {
    await documents.create(seed.record)
  }

  // ③ 三角色的 P4 最小 shim（owner + unary，不引全套产品化依赖）
  ctx.provide("credentials", memoryCredentials() as never)
  const typert = createTypertShim()
  ctx.provide("typert", typert as never)
  ctx.typert.register(hostContributionFrom(TYPERT))
  ctx.provide("remoteAccess", {
    decide: () => ({ kind: "allow" }),
  } as never)

  // ④ connection host 半（提供 ctx.connection + 共享 /api FetchHandler）
  await applyConnection(ctx, { trustedHosts: [] })

  // ⑤ gateway host 半（构造即经 ctx.inject 挂 connection rpc interceptor）
  const gateway = new TypertGatewayService(ctx, {})

  // ⑥ 业务 service（真 controller，走 ctx.documents）
  new DocumentController(ctx)

  const sharedFetch: ConnectionFetchHandler = ctx.connection.createSharedFetchHandler(API_PATH)

  return {
    ctx,
    sharedFetch,
    gateway,
    root,
    async dispose(): Promise<void> {
      await documents.close()
      journal.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
