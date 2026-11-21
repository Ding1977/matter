/**
 * `single` 布局的契约（ISS-535 补回）：整单元单文档 `<root>/<name>.json`。
 *
 * 三态语义（views.json 的验收口径）在这里由底层保证：
 *   · 文件缺失 ⇒ 空 unit（global=null，不建文件、不冒绿）；
 *   · 文件损坏 ⇒ parse 出声拒绝（malformed-medium / version-mismatch）；
 *   · 文件完好 ⇒ 读出整份状态。
 * 另钉「整组写」：deleteRecords 改多条只发一次（内存权威 + 单次原子发布）。
 *
 * @module @matter/storage-json/tests/single-layout
 */

import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { KvUnitDescriptor } from "@matter/storage"
import { parse, serialize } from "../src/format.ts"
import { JsonStorageBackend } from "../src/index.ts"

const SINGLE: KvUnitDescriptor = {
  name: "views",
  version: 1,
  tables: [],
  hasGlobal: true,
  layout: "single",
}

/** 建临时根 + single backend。 */
async function fresh() {
  const root = await mkdtemp(join(tmpdir(), "matter-json-single-"))
  return { root, backend: new JsonStorageBackend(root) }
}

describe("single layout：三态语义", () => {
  it("文件缺失 = 初始空态，open 不抛、不建文件、global 为 null", async () => {
    const { root, backend } = await fresh()
    const unit = await backend.kv!.open(SINGLE)
    const snap = await unit.loadAll()
    expect(snap.global).toBeNull()
    // 不冒绿：open 只读不写，文件不该被创建。
    await expect(readFile(join(root, "views.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await backend.close()
  })

  it("首次 setGlobal 才物化整份文档，格式是 {unit, global, tables}", async () => {
    const { root, backend } = await fresh()
    const unit = await backend.kv!.open(SINGLE)
    await unit.setGlobal([{ id: "v1", type: "list" }])
    const text = await readFile(join(root, "views.json"), "utf8")
    expect(JSON.parse(text)).toEqual({
      unit: { name: "views", version: 1 },
      global: [{ id: "v1", type: "list" }],
      tables: {},
    })
    await backend.close()
  })

  it("损坏文件 = 出声拒绝（malformed-medium），不吞成空态", async () => {
    const { root, backend } = await fresh()
    await writeFile(join(root, "views.json"), "not json {{{", "utf8")
    await expect(backend.kv!.open(SINGLE)).rejects.toMatchObject({ code: "malformed-medium" })
    await backend.close()
  })

  it("无法读取（路径是目录，非 ENOENT）= 原样抛，不吞成空态", async () => {
    const { root, backend } = await fresh()
    await mkdir(join(root, "views.json")) // 路径是目录 ⇒ readFile 抛 EISDIR，不是 ENOENT
    await expect(backend.kv!.open(SINGLE)).rejects.toMatchObject({ code: "EISDIR" })
    await backend.close()
  })

  it("声明了表但文档里缺席 = 空表（不拒绝）", () => {
    const text = JSON.stringify({ unit: { name: "views", version: 1 }, global: null, tables: {} })
    const state = parse(text, { ...SINGLE, tables: ["alpha"] })
    expect(state.tables.get("alpha")).toEqual(new Map())
  })

  it("外来 unit 头（名字不符）= malformed-medium", async () => {
    const { root, backend } = await fresh()
    await writeFile(join(root, "views.json"), JSON.stringify({ unit: { name: "other", version: 1 }, global: null, tables: {} }), "utf8")
    await expect(backend.kv!.open(SINGLE)).rejects.toMatchObject({ code: "malformed-medium" })
    await backend.close()
  })

  it("版本不符 = version-mismatch（整单元拒绝，与 per-record 丢弃相反）", async () => {
    const { root, backend } = await fresh()
    await writeFile(join(root, "views.json"), JSON.stringify({ unit: { name: "views", version: 99 }, global: null, tables: {} }), "utf8")
    await expect(backend.kv!.open(SINGLE)).rejects.toMatchObject({ code: "version-mismatch" })
    await backend.close()
  })

  it("compatibleVersions 接受旧戳并读取", async () => {
    const { root, backend } = await fresh()
    await writeFile(join(root, "views.json"), JSON.stringify({ unit: { name: "views", version: 0 }, global: "old", tables: {} }), "utf8")
    const unit = await backend.kv!.open({ ...SINGLE, compatibleVersions: [0] })
    expect((await unit.loadAll()).global).toBe("old")
    await backend.close()
  })

  it("tables 是数组也拒绝（不可当空表映射读，否则下次发布抹数据）", async () => {
    const { root, backend } = await fresh()
    await writeFile(join(root, "views.json"), JSON.stringify({ unit: { name: "views", version: 1 }, global: null, tables: [] }), "utf8")
    await expect(backend.kv!.open(SINGLE)).rejects.toMatchObject({ code: "malformed-medium" })
    await backend.close()
  })
})

describe("single layout：整组写与记录语义", () => {
  it("putRecord / deleteRecords 改整份，同根 reopen 读回", async () => {
    const { root, backend } = await fresh()
    const unit = await backend.kv!.open(SINGLE)
    await unit.setGlobal([{ id: "v1" }])
    await backend.close()

    const reopened = new JsonStorageBackend(root)
    const u2 = await reopened.kv!.open(SINGLE)
    expect((await u2.loadAll()).global).toEqual([{ id: "v1" }])
    await reopened.close()
  })

  it("setGlobal 只整份替换 global，不动 tables 的声明", async () => {
    const d = { ...SINGLE, tables: ["alpha"] }
    const { backend } = await fresh()
    const unit = await backend.kv!.open(d)
    await unit.putRecord("alpha", "k", { v: 1 })
    await unit.setGlobal("whole")
    const snap = await unit.loadAll()
    expect(snap.global).toBe("whole")
    expect(snap.tables["alpha"]).toEqual({ k: { v: 1 } })
    await backend.close()
  })

  it("setGlobal 在未声明 hasGlobal 的 unit 上报 invalid-descriptor", async () => {
    const { backend } = await fresh()
    const unit = await backend.kv!.open({ ...SINGLE, hasGlobal: false })
    await expect(unit.setGlobal("x")).rejects.toMatchObject({ code: "invalid-descriptor" })
    await backend.close()
  })

  it("未声明的表 put 报 invalid-descriptor；close 后所有操作报 closed（幂等）", async () => {
    const { backend } = await fresh()
    const unit = await backend.kv!.open(SINGLE)
    await expect(unit.putRecord("nope", "k", 1)).rejects.toMatchObject({ code: "invalid-descriptor" })
    await unit.close()
    await unit.close() // 幂等
    await expect(unit.loadAll()).rejects.toMatchObject({ code: "closed" })
  })

  it("putRecord 整份发布：upsert 覆盖同 key；deleteRecord/deleteRecords 批量只发一次", async () => {
    const d: KvUnitDescriptor = { ...SINGLE, tables: ["view"] }
    const { root, backend } = await fresh()
    const unit = await backend.kv!.open(d)
    await unit.putRecord("view", "v1", { type: "list" })
    await unit.putRecord("view", "v1", { type: "table" }) // 覆盖
    await unit.putRecord("view", "v2", { type: "board" })
    expect((await unit.loadAll()).tables["view"]).toEqual({ v1: { type: "table" }, v2: { type: "board" } })
    await unit.deleteRecord("view", "v1")
    expect((await unit.loadAll()).tables["view"]).toEqual({ v2: { type: "board" } })
    await unit.deleteRecords("view", ["v2", "不存在"]) // 批量 + 幂等
    expect((await unit.loadAll()).tables["view"]).toEqual({})
    // 空批量 no-op，不推进（读回仍为空）。
    await unit.deleteRecords("view", [])
    expect((await unit.loadAll()).tables["view"]).toEqual({})
    // 整份文件里 tables 也在。
    const doc = JSON.parse(await readFile(join(root, "views.json"), "utf8"))
    expect(doc.tables.view).toEqual({})
    await backend.close()
  })

  it("发布失败一律回滚内存：put / setGlobal / deleteRecords 的失败不留残影", async () => {
    const d: KvUnitDescriptor = { ...SINGLE, tables: ["view"] }
    const { root, backend } = await fresh()
    const unit = await backend.kv!.open(d)
    await unit.putRecord("view", "keep", { v: 1 })
    await unit.setGlobal("g0")
    // 把根目录改名：unit 已持有内存状态，但下一次整份发布的目标父目录消失 ⇒ writeAtomic ENOENT。
    await rename(root, `${root}-moved`)
    try {
      const before = await unit.loadAll()
      await expect(unit.putRecord("view", "new", { v: 2 })).rejects.toMatchObject({ code: "ENOENT" }) // 新 key 回滚
      await expect(unit.putRecord("view", "keep", { v: 99 })).rejects.toMatchObject({ code: "ENOENT" }) // 覆盖已有 key 回滚
      await expect(unit.setGlobal("g1")).rejects.toMatchObject({ code: "ENOENT" })
      await expect(unit.deleteRecords("view", ["keep"])).rejects.toMatchObject({ code: "ENOENT" })
      const after = await unit.loadAll()
      // 三条失败写全部回滚 ⇒ 内存状态与失败前一致。
      expect(after).toEqual(before)
    } finally {
      await backend.close()
      await rename(`${root}-moved`, root)
    }
  })
})

describe("format：serialize / parse 往返", () => {
  it("serialize → parse 保真（含 global 与表记录）", () => {
    const state = parse(serialize("views", {
      version: 1,
      global: [{ id: "v1" }],
      tables: new Map([["alpha", new Map([["k", { v: 1 }]])]]),
    }), { ...SINGLE, tables: ["alpha"] })
    expect(state.global).toEqual([{ id: "v1" }])
    expect(state.tables.get("alpha")?.get("k")).toEqual({ v: 1 })
  })

  it("非对象 JSON / 非 JSON 原语都报 malformed-medium", () => {
    expect(() => parse("42", SINGLE)).toThrow()
    expect(() => parse("null", SINGLE)).toThrow()
  })

  it("表值是数组报 malformed-medium", () => {
    const text = JSON.stringify({ unit: { name: "views", version: 1 }, global: null, tables: { alpha: [] } })
    expect(() => parse(text, { ...SINGLE, tables: ["alpha"] })).toThrow()
  })
})
