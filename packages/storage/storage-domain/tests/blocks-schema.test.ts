/**
 * ISS-525：`blocksSchema` 槽的永久回归守卫。
 *
 * 这是所有域共用的地基。本文件守两件事，且都写成「换成错误实现即红」的形态：
 *   ① blocks 声明域的平级落盘 / 读回 / schema 校验（§1–§2）；
 *   ② 不传 blocksSchema 时（E-0/E-1 形态）类型推导与运行时形状逐字不变（§3–§5）。
 *
 * 落盘形态依据 DOC-512 §2.1（{props, blocks} 平级）与 §2.5（per-record）；
 * 先核结论：`KvUnit` 的 value 是不透明 JSON，故复合 value `{props, blocks}`
 * 由 domain 层组装后交现有 per-record 路径，盘上即 `{version, record:{props,blocks}}`，
 * storage-json 源码零改动。
 * @module @matter/storage-domain/tests/blocks-schema
 */

import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Context } from "@deepseek-ai/cordis"
import Storage from "@matter/storage"
import { JsonStorageBackend } from "@matter/storage-json"
import { defineDomain, descriptorOf, domainTable, DomainFacility } from "../src/index.ts"
import type { TableValueOf } from "../src/index.ts"
import { MemoryMediaPool, MemoryStorageBackend } from "./helpers/memory-backend.ts"

const props = z.object({ title: z.string() })
const block = z.object({ id: z.string(), type: z.literal("paragraph"), text: z.string() })
const blocks = z.array(block)

describe("ISS-525 · blocksSchema 平级落盘与读回", () => {
  it("§1 平级落盘：声明 blocksSchema 的域写记录 ⇒ 盘上 {version, record:{props,blocks}}、读回一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "iss2283-pr-"))
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(root)
    ctx.storage.backend.register("json", backend)
    const facility = new DomainFacility(ctx, { backend: "json" })
    const spec = defineDomain({ name: "doc_domain", version: 1, tables: {
      docs: domainTable<string, z.infer<typeof props>, z.infer<typeof blocks>>(props, blocks),
    } })
    const value = { props: { title: "hello" }, blocks: [{ id: "b1", type: "paragraph" as const, text: "body" }] }
    {
      const domain = await facility.open(spec)
      await domain.table("docs").put("DOC-1", value)
      await domain.close()
    }
    // 物理落盘：一条记录一个文档，props 与 blocks 是 record 的平级两字段。
    const dir = join(root, "doc_domain", "docs")
    expect(await readdir(dir)).toEqual(["DOC-1.json"])
    expect(JSON.parse(await readFile(join(dir, "DOC-1.json"), "utf8"))).toEqual({
      version: 1,
      record: { props: { title: "hello" }, blocks: [{ id: "b1", type: "paragraph", text: "body" }] },
    })
    // 重开读回一致。
    {
      const domain = await facility.open(spec)
      expect(domain.table("docs").get("DOC-1")).toEqual(value)
      await domain.close()
    }
    await facility.closeAll()
  })

  it("§2 schema 生效：blocks 坏值重开 ⇒ invalid-record、detail 带 table/key", async () => {
    const pool = new MemoryMediaPool()
    const spec = defineDomain({ name: "doc_bad", version: 1, tables: {
      docs: domainTable<string, z.infer<typeof props>, z.infer<typeof blocks>>(props, blocks),
    } })
    {
      const ctx = new Context()
      await ctx.plugin(Storage)
      ctx.storage.backend.register("mem", new MemoryStorageBackend(pool))
      const facility = new DomainFacility(ctx, { backend: "mem" })
      const domain = await facility.open(spec)
      await domain.table("docs").put("D1", { props: { title: "ok" }, blocks: [{ id: "b1", type: "paragraph", text: "ok" }] })
      await facility.closeAll()
    }
    // 绕过 schema 直接把坏 blocks 塞进介质（模拟「磁盘上早就有坏数据」）。
    pool.media.get("doc_bad")!.tables.get("docs")!.set("D1", {
      props: { title: "ok" }, blocks: [{ id: "b1", type: "image", url: "x" }],
    })
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register("mem", new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: "mem" })
    await expect(facility.open(spec)).rejects.toMatchObject({
      name: "DomainError",
      code: "invalid-record",
      detail: { table: "docs", key: "D1" },
    })
    await facility.closeAll()
  })
})

describe("ISS-525 · 不传 blocksSchema 时 E-0/E-1 逐字不变", () => {
  it("§3 运行时形状：domainTable(schema) 恰为 {valueSchema}，无 blocksSchema 多余键", () => {
    const oneArg = domainTable<string, z.infer<typeof props>>(props)
    expect(Object.keys(oneArg)).toEqual(["valueSchema"])
    expect(oneArg).not.toHaveProperty("blocksSchema")
    // 传第二参数时才出现 blocksSchema 键（对照物：删掉该分支本断言即失去对照）。
    const twoArg = domainTable<string, z.infer<typeof props>, z.infer<typeof blocks>>(props, blocks)
    expect(Object.keys(twoArg).sort()).toEqual(["blocksSchema", "valueSchema"])
  })

  it("§4 TableValueOf 类型派生：无 blocks → V（E-0/E-1 形态）；有 blocks → {props,blocks}", () => {
    const spec = defineDomain({ name: "typed", version: 1, tables: {
      p: domainTable<string, z.infer<typeof props>>(props),
      b: domainTable<string, z.infer<typeof props>, z.infer<typeof blocks>>(props, blocks),
    } })
    type PV = TableValueOf<typeof spec, "p">
    type BV = TableValueOf<typeof spec, "b">
    // 编译期派生：props-only 表的值就是裸 props（E-0/E-1 的 IssueProps/ProjectProps 形态）。
    const pv: PV = { title: "x" }
    // blocks 表的值是平级 {props, blocks}。
    const bv: BV = { props: { title: "x" }, blocks: [{ id: "b1", type: "paragraph", text: "hi" }] }
    expect(pv).toEqual({ title: "x" })
    expect(bv.blocks).toHaveLength(1)
    // descriptor 不携带 blocks 概念（@matter/storage 契约零改）。
    const d = descriptorOf(spec)
    expect(d).not.toHaveProperty("blocksSchema")
    expect(d.tables).toEqual(["p", "b"])
  })

  it("§5 E-0/E-1 零回归：不传 blocksSchema 的 domainTable 落盘读数与原来一致（props-only、无 blocks 包装）", async () => {
    const pool = new MemoryMediaPool()
    const spec = defineDomain({ name: "prop_only", version: 1, tables: {
      items: domainTable<string, z.infer<typeof props>>(props),
    } })
    const rec = { title: "zero-regression" }
    {
      const ctx = new Context()
      await ctx.plugin(Storage)
      ctx.storage.backend.register("mem", new MemoryStorageBackend(pool))
      const facility = new DomainFacility(ctx, { backend: "mem" })
      await (await facility.open(spec)).table("items").put("k", rec)
      await facility.closeAll()
    }
    // 介质里就是裸 props，没有 {props, blocks} 包装 —— 落盘读数逐字不变。
    expect(pool.media.get("prop_only")!.tables.get("items")!.get("k")).toEqual(rec)
    // 重开读回一致；坏 props 仍按原路径报 invalid-record（detail 不变）。
    {
      const ctx = new Context()
      await ctx.plugin(Storage)
      ctx.storage.backend.register("mem", new MemoryStorageBackend(pool))
      const facility = new DomainFacility(ctx, { backend: "mem" })
      expect((await facility.open(spec)).table("items").get("k")).toEqual(rec)
      await facility.closeAll()
    }
    pool.media.get("prop_only")!.tables.get("items")!.set("k", { title: 42 })
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register("mem", new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: "mem" })
    await expect(facility.open(spec)).rejects.toMatchObject({
      code: "invalid-record", detail: { table: "items", key: "k" },
    })
    await facility.closeAll()
  })
})
