/**
 * storage-json 的边界行为补测（ISS-523 / C-0b）。
 *
 * 三条都是「主流程不经过、但确有行为」的分支：
 *   · writeAtomic 的失败清理（原子写的承诺：失败不留 .tmp 残渣）；
 *   · parseRecord 对外来文档的判定（非对象 JSON 读作不存在）；
 *   · close 与 in-flight open 竞态（关店之后不许再交出可用句柄）。
 * @module @matter/storage-json/tests/coverage-gaps
 */

import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { KvUnitDescriptor } from "@matter/storage"
import { writeAtomic } from "../src/atomic.ts"
import { parseRecord } from "../src/format.ts"
import { JsonStorageBackend } from "../src/index.ts"

const DESCRIPTOR: KvUnitDescriptor = {
  name: "unit_a",
  version: 3,
  tables: ["alpha"],
  hasGlobal: true,
  layout: "per-record",
}

describe("writeAtomic 的失败路径", () => {
  it("目标目录不存在时清理临时文件并重抛原始错误", async () => {
    const root = await mkdtemp(join(tmpdir(), "matter-json-atomic-"))
    const missing = join(root, "no-such-dir", "target.json")
    await expect(writeAtomic(missing, "x")).rejects.toMatchObject({ code: "ENOENT" })
    // 目标目录都没建成，根目录下不该出现任何 .tmp 残渣。
    expect(await readdir(root)).toEqual([])
  })
})

describe("parseRecord 的外来文档判定", () => {
  it("JSON 原语与 null 都读作不存在（不是抛错，也不是空记录）", () => {
    expect(parseRecord("42", [3])).toBeUndefined()
    expect(parseRecord("null", [3])).toBeUndefined()
    expect(parseRecord('"text"', [3])).toBeUndefined()
  })
})

describe("close 与 in-flight open 的竞态", () => {
  it("open 在飞时后端被关：新 unit 被立即关闭，open 拒绝 closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "matter-json-race-"))
    const backend = new JsonStorageBackend(root)
    const opening = backend.kv!.open(DESCRIPTOR)
    // 先挂拒绝处理器，避免 close() 排干期间被当作 unhandled rejection。
    const outcome = opening.then(() => "resolved", (error) => error)
    await backend.close()
    expect(await outcome).toMatchObject({ code: "closed" })
  })
})
