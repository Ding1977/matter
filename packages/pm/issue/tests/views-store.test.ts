/**
 * ViewConfigStore 的契约（ISS-535）：三态语义 + 防抖整组写 + 落盘往返。
 *
 * 真 storage-json 后端（single layout）落临时目录，不冒绿/报错不吞用真文件验证。
 * 防抖用真实时间窗口计时（短 debounceMs + 真实 sleep）：窗口内多次变更只写一次整组。
 *
 * @module @matter/issue/tests/views-store
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { Context } from "@deepseek-ai/cordis"
import Storage from "@matter/storage"
import type { KvUnit } from "@matter/storage"
import * as StorageJson from "@matter/storage-json"
import { ViewConfigStore, DEFAULT_DEBOUNCE_MS, minimalView } from "../src/views/index.ts"

/** 一套最小现场：真 storage hub + json 后端。 */
async function boot(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  return { ctx, kv: ctx.storage.backend.get("json").kv! }
}

describe("ViewConfigStore：三态语义", () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "matter-views-store-")) })

  it("文件缺失 = 初始空态，open 不冒绿（不建文件）", async () => {
    const { ctx, kv } = await boot(root)
    const store = await ViewConfigStore.open(kv)
    expect(store.list()).toEqual([])
    await expect(readFile(join(root, "views.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await store.close()
  })

  it("文件损坏 = 报错不吞（ZodError / StorageError 原样抛）", async () => {
    // ① JSON 坏：底层 parse 抛 StorageError
    await writeFile(join(root, "views.json"), "not json {{{", "utf8")
    const { ctx, kv } = await boot(root)
    await expect(ViewConfigStore.open(kv)).rejects.toMatchObject({ code: "malformed-medium" })
    // ② 值不合 schema：Store 的 ViewConfigList.parse 抛 ZodError
    await writeFile(join(root, "views.json"), JSON.stringify({
      unit: { name: "views", version: 1 },
      global: [{ id: "v1", type: "gantt" }], // 非法形态
      tables: {},
    }), "utf8")
    const { kv: kv2 } = await boot(root)
    await expect(ViewConfigStore.open(kv2)).rejects.toBeTruthy()
  })

  it("upsert 同 id 覆盖不新增；close 幂等且关闭后拒绝所有操作", async () => {
    const { kv } = await boot(root)
    const store = await ViewConfigStore.open(kv)
    store.upsert(minimalView("v1", "原名"))
    store.upsert(minimalView("v1", "改名"))
    expect(store.list()).toHaveLength(1)
    expect(store.get("v1")!.name).toBe("改名")
    await store.close()
    await store.close() // 幂等
    expect(() => store.list()).toThrow(/closed/)
    expect(() => store.get("v1")).toThrow(/closed/)
    expect(() => store.upsert(minimalView("v2", "x"))).toThrow(/closed/)
  })

  it("flush 物化整份文档到 views.json", async () => {
    const { ctx, kv } = await boot(root)
    const store = await ViewConfigStore.open(kv)
    store.upsert(minimalView("v1", "全部需求"))
    await store.flush()
    const doc = JSON.parse(await readFile(join(root, "views.json"), "utf8"))
    expect(doc.unit).toEqual({ name: "views", version: 1 })
    expect(doc.global).toEqual([minimalView("v1", "全部需求")])
    await store.close()
  })

  it("同根 reopen 读回整组（持久化闭环）", async () => {
    const root2 = await mkdtemp(join(tmpdir(), "matter-views-persist-"))
    const first = await boot(root2)
    const store = await ViewConfigStore.open(first.kv)
    store.upsert(minimalView("v1", "A"))
    store.upsert({ ...minimalView("v2", "B"), type: "table" })
    await store.flush()
    await store.close()

    const second = await boot(root2)
    const reopened = await ViewConfigStore.open(second.kv)
    expect(reopened.list().map((v) => v.id)).toEqual(["v1", "v2"])
    expect(reopened.get("v2")!.type).toBe("table")
    await reopened.close()
  })
})

describe("ViewConfigStore：防抖整组写", () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "matter-views-debounce-")) })

  /** 等一个真实短防抖窗口过去 + 落盘。 */
  const settle = async (ms: number) => { await new Promise((r) => setTimeout(r, ms + 40)) }

  it("默认防抖 800ms；窗口内多次变更合并成一次整组写", async () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(800)
    const { kv } = await boot(root)
    // 短窗口验证合并语义；默认值本身由断言钉住。
    const store = await ViewConfigStore.open(kv, { debounceMs: 30 })

    store.upsert(minimalView("v1", "A"))
    store.upsert(minimalView("v2", "B"))
    store.upsert(minimalView("v3", "C"))
    expect(store.hasPending).toBe(true)
    expect(store.list()).toHaveLength(3)

    // 窗口未到：不落盘。
    await new Promise((r) => setTimeout(r, 5))
    await expect(readFile(join(root, "views.json"))).rejects.toMatchObject({ code: "ENOENT" })
    // 窗口到：整组一次性可见。
    await settle(30)
    const doc = JSON.parse(await readFile(join(root, "views.json"), "utf8"))
    expect(doc.global.map((v: { id: string }) => v.id)).toEqual(["v1", "v2", "v3"])
    expect(store.hasPending).toBe(false)
    await store.close()
  })

  it("replaceAll / remove 走同一防抖；remove 不存在是 no-op 不排程", async () => {
    const { kv } = await boot(root)
    const store = await ViewConfigStore.open(kv, { debounceMs: 10 })
    store.replaceAll([minimalView("a", "A"), minimalView("b", "B")])
    expect(store.hasPending).toBe(true)
    store.remove("a")
    expect(store.list().map((v) => v.id)).toEqual(["b"])
    await settle(10)
    store.remove("不存在")
    expect(store.hasPending).toBe(false)
    await store.close()
  })

  it("close 冲刷在途写，不丢最后一批变更", async () => {
    const { kv } = await boot(root)
    const store = await ViewConfigStore.open(kv, { debounceMs: 10 })
    store.upsert(minimalView("last", "最后"))
    expect(store.hasPending).toBe(true)
    await store.close() // close 内部 flush
    const doc = JSON.parse(await readFile(join(root, "views.json"), "utf8"))
    expect(doc.global.map((v: { id: string }) => v.id)).toEqual(["last"])
  })

  it("后台写失败时出声（onWriteError 被调用、lastWriteError 记下、随后成功写清空）", async () => {
    const errors: unknown[] = []
    let fail = true
    // 假 unit：第一次 setGlobal 拒绝，之后成功。loadAll 给空态。
    const fake: KvUnit = {
      loadAll: async () => ({ tables: {}, global: null }),
      putRecord: async () => {},
      deleteRecord: async () => {},
      deleteRecords: async () => {},
      setGlobal: async () => { if (fail) { fail = false; throw new Error("disk full") } },
      close: async () => {},
    }
    const store = new ViewConfigStore(fake, 10, (e) => errors.push(e))
    await store.reload()
    store.upsert(minimalView("x", "X"))
    await settle(10)
    expect(errors).toHaveLength(1)
    expect((store.lastWriteError as Error).message).toBe("disk full")

    // 下一次成功写清空 lastWriteError。
    store.upsert(minimalView("y", "Y"))
    await settle(10)
    expect(store.lastWriteError).toBeUndefined()
    expect(errors).toHaveLength(1)
    await store.close()
  })
})
