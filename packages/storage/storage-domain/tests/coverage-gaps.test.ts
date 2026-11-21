/**
 * storage-domain 的配置校验、坏记录备份跳过与诊断面补测（ISS-523 / C-0b）。
 *
 * 这些分支都是「真有行为但主流程不经过」：加载期配置窄校验、
 * backup-and-skip 的成功路径（另一条「后端不能移动文档」的失败路径已有用例）、
 * 诊断用的 get，以及 apply 带 routes 时的后端服务键收集。
 * @module @matter/storage-domain/tests/coverage-gaps
 */

import { describe, expect, it, vi } from "vitest"
import { Context } from "@deepseek-ai/cordis"
import { z } from "zod"
import Storage, { storageBackendServiceKey } from "@matter/storage"
import type { KvFacet, KvUnit, KvUnitDescriptor } from "@matter/storage"
import { defineDomain, domainTable, DomainFacility, normalizeConfig } from "../src/index.ts"
import { MemoryMediaPool, MemoryStorageBackend } from "./helpers/memory-backend.ts"

const itemSchema = z.object({ label: z.string(), count: z.number().int() })
const spec = defineDomain({
  name: 'demo',
  version: 1,
  tables: { items: domainTable<string, { label: string; count: number }>(itemSchema) },
})
const salvageSpec = defineDomain({
  name: 'salvage',
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { items: domainTable<string, { label: string; count: number }>(itemSchema) },
})

describe("normalizeConfig：加载期窄校验", () => {
  it("非法 backend / routes / 路由值当场抛，合法值归一化", () => {
    expect(() => normalizeConfig({ backend: "" })).toThrow(/config\.backend/)
    expect(() => normalizeConfig({ backend: "json", routes: [] as never })).toThrow(/config\.routes/)
    expect(() => normalizeConfig({ backend: "json", routes: null as never })).toThrow(/config\.routes/)
    expect(() => normalizeConfig({ backend: "json", routes: "x" as never })).toThrow(/config\.routes/)
    expect(() => normalizeConfig({ backend: "json", routes: { a: "" } })).toThrow(/non-empty backend name/)
    expect(normalizeConfig({ backend: "json", routes: { a: "b" } }))
      .toEqual({ backend: "json", routes: { a: "b" } })
  })
})

/** 带 backupRecord 的内存后端：让 backup-and-skip 的成功路径可测。 */
class BackableBackend extends MemoryStorageBackend {
  constructor(pool: MemoryMediaPool) {
    super(pool)
    const baseOpen = this.kv.open.bind(this.kv)
    ;(this as unknown as { kv: KvFacet }).kv = {
      open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
        const unit = await baseOpen(descriptor)
        const wrapped: KvUnit = {
          loadAll: () => unit.loadAll(),
          putRecord: (t, k, v) => unit.putRecord(t, k, v),
          deleteRecord: (t, k) => unit.deleteRecord(t, k),
          deleteRecords: (t, ks) => unit.deleteRecords(t, ks),
          setGlobal: (v) => unit.setGlobal(v),
          close: () => unit.close(),
          backupRecord: async (table: string, key: string) => `backup://${table}/${key}`,
        }
        return wrapped
      },
    }
  }
}

describe("snapshot validation：backup-and-skip 成功路径", () => {
  it("坏记录被移出可读集、记 error 日志，域照常打开且该条缺失", async () => {
    const pool = new MemoryMediaPool()
    {
      const ctx = new Context()
      await ctx.plugin(Storage)
      ctx.storage.backend.register("memory", new BackableBackend(pool))
      const facility = new DomainFacility(ctx, { backend: "memory", routes: {} })
      await (await facility.open(salvageSpec)).table("items").put("bad", { label: "x", count: 2 })
      await facility.closeAll()
    }
    pool.media.get("salvage")!.tables.get("items")!.set("bad", { label: "x", count: "NaN" })

    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register("memory", new BackableBackend(pool))
    const errors: string[] = []
    const facility = new DomainFacility(ctx, { backend: "memory", routes: {} })
    // cordis 的 logger 既是可调用工厂又带 .error/.warn 方法；两形都要留。
    const sink = (m: string) => errors.push(m)
    const fakeLogger = Object.assign((_name?: string) => ({ error: sink, warn: sink }), { error: sink, warn: sink })
    ;(ctx as unknown as { logger: unknown }).logger = fakeLogger
    const domain = await facility.open(salvageSpec)
    expect(domain.table("items").get("bad")).toBeUndefined()
    expect(errors.some((m) => m.includes("moved to 'backup://items/bad'"))).toBe(true)
    await facility.closeAll()
  })
})

describe("DomainFacility 诊断面", () => {
  it("get 按名字返回已打开域；未打开返回 undefined", async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register("memory", new MemoryStorageBackend())
    const facility = new DomainFacility(ctx, { backend: "memory", routes: {} })
    expect(facility.get("demo")).toBeUndefined()
    await facility.open(spec)
    expect(facility.get("demo")).toBeDefined()
    await facility.closeAll()
  })
})

describe("apply：routes 里的后端也进依赖键集合", () => {
  it("带 routes 的插件带着两个后端服务键激活", async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend()
    const other = new MemoryStorageBackend()
    ctx.storage.backend.register("memory", backend)
    ctx.provide(storageBackendServiceKey("memory"), backend)
    ctx.storage.backend.register("other", other)
    ctx.provide(storageBackendServiceKey("other"), other)

    const DomainPlugin = await import("../src/index.ts")
    const fiber = await ctx.plugin(DomainPlugin, { backend: "memory", routes: { special: "other" } })
    await vi.waitFor(() => { expect(ctx.storageDomain).toBeInstanceOf(DomainFacility) })
    await fiber.dispose()
  })
})

describe("ISS-528 · blocks 声明域的盘上脏形态（record 非对象）", () => {
  it("record 被换成字符串 ⇒ invalid-record 指名 props+blocks 形态，cause 带原始错误", async () => {
    const pool = new MemoryMediaPool()
    const blockItem = z.object({ id: z.string(), type: z.literal("paragraph"), text: z.string() })
    const blockList = z.array(blockItem)
    const junkSpec = defineDomain({ name: "doc_junk", version: 1, tables: {
      docs: domainTable<string, { title: string }, z.infer<typeof blockList>>(
        z.object({ title: z.string() }), blockList),
    } })
    // 先走正规路径开域并落一条合法记录，再绕过 schema 直接改介质（模拟「磁盘上早就有坏数据」）。
    {
      const ctx = new Context()
      await ctx.plugin(Storage)
      ctx.storage.backend.register("memory", new MemoryStorageBackend(pool))
      const facility = new DomainFacility(ctx, { backend: "memory", routes: {} })
      await (await facility.open(junkSpec)).table("docs").put("D1", {
        props: { title: "ok" }, blocks: [{ id: "b1", type: "paragraph" as const, text: "ok" }],
      })
      await facility.closeAll()
    }
    pool.media.get("doc_junk")!.tables.get("docs")!.set("D1", "junk")

    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register("memory", new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: "memory", routes: {} })
    await expect(facility.open(junkSpec)).rejects.toMatchObject({
      name: "DomainError",
      code: "invalid-record",
      detail: { table: "docs", key: "D1" },
      cause: { message: "block record must be an object with props and blocks" },
    })
    await facility.closeAll()
  })
})
