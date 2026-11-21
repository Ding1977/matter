/**
 * 已知冲突的**锁定测试**（ISS-510）—— 不是「绕过」，是「钉住」。
 *
 * ## 这份文件要解决什么
 *
 * `../../storage/tests/contract.ts` 的 `runKvBackendContract` 里有 3 条用例断言的是
 * `single` 布局语义，与本包实现的 `per-record` 契约**按设计相反**：
 *
 * | 套件位置 | 套件断言 | `backend.ts` 对 per-record 的规定 |
 * |---|---|---|
 * | `contract.ts:60,67` | 不安全 key `weird key / with:stuff` 能存能取 | `:107-109` 不安全 key **写前拒绝** |
 * | `contract.ts:107-114` | `open({version:2/4})` **reject** `version-mismatch` | `:40-43` per-record **读作不存在** |
 *
 * ## 为什么本文件断言「与套件相反」的行为
 *
 * 因为**套件错了，不是实现错了**。证据是对照实验（同一实现、同一套件、唯一变量 `layout`）：
 *
 * ```
 * DSH 参考实现 @deepseek-ai/dsh-storage-json@0.2.2-rc.3
 *   DESCRIPTOR 不带 layout（single）  ⇒ 12/12 绿
 *   DESCRIPTOR 带 layout per-record   ⇒ 3 红 / 9 绿
 * ```
 *
 * 唯一变量是 layout，实现一个字没改 —— 红的成因只能是套件口径。
 *
 * ## 这份文件的作用（长期保留，不是过渡物）
 *
 * 1. **防止有人「修」实现去迎合套件**：如果哪天有人为了让套件变绿而让 per-record
 *    接受不安全 key（`../evil` 就能写到根目录外）或让 open 抛 version-mismatch，
 *    本文件会红。**本文件长期保留** —— 它不是等套件修好就该删的过渡物，是一道安全闸。
 * 2. **钉住与套件口径相反的语义**：套件自 ISS-512 乙档（`bfa6e58a`，已交付）起
 *    只断言两布局**共同**的子句，差异语义归各自 Provider 的 spec。本文件断言的是
 *    **套件不收的那一类**，两者不互相替代 —— ⚠️ **不要**把它换成 `runKvBackendContract`。
 *
 * 变异实测（`reviewer-2203` 变异 1，本机复跑确认）：短路 `per-record-unit.ts` 的
 * `assertSafeKey` ⇒ 本文件「冲突 1/3」与 `per-record.test.ts` 两条非法 key 用例
 * **三处同时红**。防护是双层的：删掉本文件，那道闸少一层。
 *
 * `packages/storage/storage/` 属 P0-5 已合并产物，不在本单写范围。
 *
 * @module @matter/storage-json/tests/contract-conflict
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { KvUnitDescriptor } from "@matter/storage"
import { JsonStorageBackend } from "../src/index.ts"

const DESCRIPTOR: KvUnitDescriptor = {
  name: "contract_unit",
  version: 3,
  tables: ["alpha", "beta"],
  hasGlobal: true,
  layout: "per-record",
}

/** 建临时根 + 已打开的 unit。 */
async function fresh() {
  const root = await mkdtemp(join(tmpdir(), "matter-json-conflict-"))
  const backend = new JsonStorageBackend(root)
  return { root, backend, unit: await backend.kv!.open(DESCRIPTOR) }
}

describe("已知冲突：套件断言 single 语义的 3 条", () => {
  it("冲突 1/3：不安全 key 被拒绝 —— 套件 :60 期望能存能取", async () => {
    const { backend, unit } = await fresh()
    // 与本实现契约一致（backend.ts:107-109），与套件相反。
    await expect(unit.putRecord("beta", "weird key / with:stuff", { ok: true })).rejects.toThrow(/not path-safe/)
    await backend.close()
  })

  it("冲突 2/3：open(version=2) 不抛 —— 套件 :114 期望 reject version-mismatch", async () => {
    const { root, backend, unit } = await fresh()
    await unit.putRecord("alpha", "k", { v: 1 })
    await backend.close()

    // 与 backend.ts:40-43 一致（per-record 把不接受的文档读作不存在），与套件相反。
    const reopened = new JsonStorageBackend(root)
    const opened = await reopened.kv!.open({ ...DESCRIPTOR, version: 2 })
    // open 本身不抛；旧戳记录的**内容**读作不存在（这是 per-record 的丢弃语义）。
    expect((await opened.loadAll()).tables["alpha"]).toEqual({})
    await reopened.close()
  })

  it("冲突 3/3：open(version=4) 不抛，且原版本仍读得到 —— 套件 :119 期望原版本仍持有数据", async () => {
    const { root, backend, unit } = await fresh()
    await unit.putRecord("alpha", "k", { v: 1 })
    await backend.close()

    const next = new JsonStorageBackend(root)
    await next.kv!.open({ ...DESCRIPTOR, version: 4 }) // 不抛
    await next.close()

    // 原版本仍能读到数据 —— 这一半与套件 :119 一致，说明并无数据损坏。
    const back = new JsonStorageBackend(root)
    expect((await (await back.kv!.open(DESCRIPTOR)).loadAll()).tables["alpha"]).toEqual({ k: { v: 1 } })
    await back.close()
  })
})
