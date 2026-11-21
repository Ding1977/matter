/**
 * Storage hub 服务的行为测试：挂载、注册/注销、stale-disposer 守卫、form 挂载。
 *
 * 【为什么文件名是 `.test.ts` 而不是任务书写的 `.spec.ts`】
 * `vitest.config.ts:43` 的 include 是 `packages/*\/*\/tests/**\/*.test.{ts,tsx}` ——
 * **只收 `.test.`**。实测把同名文件留作 `storage.spec.ts` 时：
 *   `vitest run packages/storage` ⇒ `No test files found, exiting with code 1`
 * 即「测试文件存在、一行都没跑、屏幕上只有一行 No test files found」—— 这正是
 * ISS-505 记录的形态（`.mjs` / `scripts/` 被单独漏掉时不报错）。
 * 本单写范围不含 `vitest.config.ts`（那是 ISS-507 的），故改文件名让测试**真跑**，
 * 已在交付说明里把这条偏离与证据一并报给 Lead。
 *
 * @module @matter/storage/tests/storage
 */

import { Context } from "@deepseek-ai/cordis"
import { describe, expect, it } from "vitest"
import Storage, { BackendRegistry, StorageError, UNIT_NAME_RE, storageBackendServiceKey } from "../src/index.ts"
import type { StorageBackend } from "../src/index.ts"

const fakeBackend = (tag = ""): StorageBackend => ({ close: async () => {}, tag }) as StorageBackend

describe("BackendRegistry", () => {
  it("registers, resolves, and disposes names", () => {
    const registry = new BackendRegistry()
    const backend = fakeBackend()
    const dispose = registry.register("json", backend)
    expect(registry.get("json")).toBe(backend)
    expect(registry.names()).toEqual(["json"])
    dispose()
    expect(registry.names()).toEqual([])
    expect(() => registry.get("json")).toThrow(StorageError)
  })

  it("rejects duplicate names", () => {
    const registry = new BackendRegistry()
    registry.register("json", fakeBackend())
    expect(() => registry.register("json", fakeBackend())).toThrow(StorageError)
    try {
      registry.register("json", fakeBackend())
    } catch (error) {
      expect((error as StorageError).code).toBe("duplicate-backend")
    }
  })

  it("ignores a stale disposer: a late disposer must not remove the successor", () => {
    // 这是本单唯一「不看就永远发现不了」的行为：Provider fiber 重挂时旧 disposer 迟到。
    const registry = new BackendRegistry()
    const first = fakeBackend("first")
    const second = fakeBackend("second")
    const staleDispose = registry.register("json", first)
    staleDispose()
    registry.register("json", second)
    staleDispose() // 旧 disposer 第二次执行 —— 不许删掉 second
    expect(registry.get("json")).toBe(second)
  })
})

describe("Storage service", () => {
  it("derives stable lifecycle service keys for named backends", () => {
    expect(storageBackendServiceKey("json")).toBe("storage.backend.json")
    expect(storageBackendServiceKey("tenant-a")).toBe("storage.backend.tenant-a")
  })

  it("mounts on the context and exposes the backend registry", async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    expect(ctx.storage).toBeInstanceOf(Storage)
    expect(ctx.storage.backend).toBeInstanceOf(BackendRegistry)
    expect(ctx.storage.backend.names()).toEqual([])
  })

  it("mounts and unmounts data forms, with the same stale-disposer guard", async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const first = { marker: "first" }
    const second = { marker: "second" }

    const staleMount = ctx.storage.mount("domain" as never, first as never)
    staleMount()
    const unmount = ctx.storage.mount("domain" as never, second as never)
    staleMount() // 旧 disposer 迟到 —— 不许卸掉 second
    expect(ctx.storage.form("domain" as never)).toBe(second)

    // 而「同名再挂一次」是真重复，必须拒绝（上面那次迟到不算挂载）。
    expect(() => ctx.storage.mount("domain" as never, first as never)).toThrow(StorageError)
    unmount()
    expect(() => ctx.storage.form("domain" as never)).toThrow(StorageError)
  })

  it("fails loud with stable codes for an unmounted form", async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    expect(() => ctx.storage.form("domain" as never)).toThrow(StorageError)
    try {
      ctx.storage.form("domain" as never)
    } catch (error) {
      expect((error as StorageError).code).toBe("form-not-mounted")
    }
  })

  it("the domain getter resolves the mounted domain form", async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const facility = { marker: "domain-facility" }
    const unmount = ctx.storage.mount("domain" as never, facility as never)
    // 该 getter 只是 `form("domain")` 的类型化别名：装载后必须给出同一个实例。
    expect(ctx.storage.domain).toBe(facility)
    unmount()
    expect(() => ctx.storage.domain).toThrow(StorageError)
  })
})

describe("UNIT_NAME_RE (契约口径)", () => {
  it("accepts snake_case unit names", () => {
    for (const name of ["pm_issue", "a", "a1_b2"]) expect(UNIT_NAME_RE.test(name)).toBe(true)
  })

  it("rejects hyphens and uppercase — so an entity id cannot be a unit name", () => {
    // 写进 README 的 Known Limitations：实体 id 能当 record key，不能当 unit 名。
    for (const name of ["pm-issue", "ISS-506", "Issue", "_x", "1a"]) {
      expect(UNIT_NAME_RE.test(name)).toBe(false)
    }
  })
})
