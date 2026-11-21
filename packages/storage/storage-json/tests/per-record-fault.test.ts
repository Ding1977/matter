/**
 * 批量删除的「双重 IO 故障」路径补测（ISS-523 / C-0b）。
 *
 * 正常单测只能触发「暂存失败 + 还原成功」；`unknown-state` 只在**第二次故障**
 * （还原也失败）时出现，真机上极罕见但一旦发生必须隔离整个 unit。本文件用
 * `vi.mock` 注入可控的 fs 故障，让这条防御分支确定性可测 —— 而不是用 v8 ignore 跳过。
 * @module @matter/storage-json/tests/per-record-fault
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { KvUnitDescriptor } from "@matter/storage"
import { JsonStorageBackend } from "../src/index.ts"

/** 故障注入开关；`vi.hoisted` 让 mock 工厂在 import 提升后仍能拿到同一个对象。 */
const ctl = vi.hoisted(() => ({ renames: 0, failRenameAt: -1, failDirOpen: false }))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      ctl.renames++
      if (ctl.renames === ctl.failRenameAt) {
        throw Object.assign(new Error("injected rename failure"), { code: "EIO" })
      }
      return actual.rename(from, to)
    },
    open: async (path: string, flags: string, mode?: number) => {
      // 只拦对 unit 目录的只读 open（fsyncDirectory），不碰 writeAtomic 的 `wx` 临时文件。
      if (ctl.failDirOpen && flags === "r" && String(path).includes("unit_a")) {
        throw Object.assign(new Error("injected directory open failure"), { code: "EIO" })
      }
      return actual.open(path, flags, mode)
    },
  }
})

const DESCRIPTOR: KvUnitDescriptor = {
  name: "unit_a",
  version: 3,
  tables: ["alpha"],
  hasGlobal: true,
  layout: "per-record",
}

describe("批量删的双重 IO 故障（C-0b 补测）", () => {
  it("fsync 失败且还原也失败 ⇒ unit 置 unknown-state，之后所有操作拒绝但 close 仍可用", async () => {
    const root = await mkdtemp(join(tmpdir(), "matter-json-fault-"))
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv!.open(DESCRIPTOR)
    await unit.putRecord("alpha", "good", { n: 1 })

    // 上面 setup 的 rename 不计入：从 0 开始数。
    ctl.renames = 0
    ctl.failDirOpen = true
    // 第 1 次 rename（暂存 good.json → .deleting）成功；
    // 第 2 次 rename（还原 .deleting → good.json）失败 ⇒ restoreFailures 非空。
    ctl.failRenameAt = 2

    await expect(unit.deleteRecords("alpha", ["good"])).rejects.toMatchObject({ code: "unknown-state" })
    await expect(unit.loadAll()).rejects.toMatchObject({ code: "unknown-state" })
    await expect(backend.close()).resolves.toBeUndefined()
  })
})
