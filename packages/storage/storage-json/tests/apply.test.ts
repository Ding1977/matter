/**
 * `apply()` 的接线测试：四件套形状、注册/注销顺序、配置校验。
 *
 * 【为什么注销顺序值得一条测试】反过来的瞬间里，并发写仍能通过注册表拿到
 * **已关闭**的后端 —— 现场表现是「偶发 closed 报错」，不是崩溃。
 * 这类错查起来很贵，而验证它很便宜：记录两个事件的时间戳先后即可。
 *
 * @module @matter/storage-json/tests/apply
 */

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { describe, expect, it } from "vitest"
import Storage from "@matter/storage"
import { apply, Config, inject, JsonStorageBackend, name, normalizeConfig } from "../src/index.ts"

/** 建一个已装好 storage hub 的 ctx。 */
function hubContext(): Context {
  const ctx = new Context()
  ctx.plugin(Storage)
  return ctx
}

describe("插件四件套", () => {
  it("name / inject / Config / apply 都以值导出存在", () => {
    expect(name).toBe("storage-json")
    expect(inject).toEqual(["storage"])
    expect(apply).toBeTypeOf("function")
    // Config 是类型，运行期不存在；这里断言的是**没有** default 导出（见下一条）。
    expect(Config).toBeUndefined()
  })

  it("入口没有 default 导出（Loader 的 unwrapExports 会丢 inject）", async () => {
    const mod = await import("../src/index.ts")
    expect("default" in mod).toBe(false)
  })
})

describe("apply() 接线", () => {
  it("注册 json 后端到 hub，并挂上 lifecycle 服务键", async () => {
    const ctx = hubContext()
    const root = await mkdtemp(join(tmpdir(), "matter-json-apply-"))
    apply(ctx, { root })

    expect(ctx.storage.backend.names()).toEqual(["json"])
    expect(ctx.storage.backend.get("json")).toBeInstanceOf(JsonStorageBackend)
    // 派生服务键：领域层 provider 靠它防「先于注册就激活」。
    expect((ctx as unknown as Record<string, unknown>)["storage"]).toBeDefined()
    await ctx.fiber.dispose()
  })

  it("注销顺序：先摘名字，再关介质", async () => {
    const ctx = hubContext()
    const root = await mkdtemp(join(tmpdir(), "matter-json-order-"))
    apply(ctx, { root })

    // ⚠️ 必须先捕获 registry 对象：`ctx.storage` 这个访问器在 dispose 期间会随
    // service 一起卸载，等到 close 触发时再读它拿到的是 undefined。
    const registry = ctx.storage.backend
    const backend = registry.get("json")
    const events: string[] = []
    // 观察 close 被调用的时刻：那一刻名字**必须已经**摘掉了。
    const originalClose = backend.close.bind(backend)
    backend.close = async () => {
      events.push(`close:names=${registry.names().join(",") || "(none)"}`)
      await originalClose()
    }

    await ctx.fiber.dispose()

    // 只有一条事件，且它观察到「名字已空」—— 若顺序反过来，这里会是 "close:names=json"。
    expect(events).toEqual(["close:names=(none)"])
    expect(registry.names()).toEqual([])
  })
})

describe("配置校验", () => {
  it("root 缺失 / 空串 / 非字符串都在加载时拒绝", () => {
    expect(() => normalizeConfig({} as Config)).toThrow(/config.root must be a non-empty string/)
    expect(() => normalizeConfig({ root: "" })).toThrow(/non-empty string/)
    expect(() => normalizeConfig({ root: 123 as unknown as string })).toThrow(/non-empty string/)
    expect(() => normalizeConfig(undefined as unknown as Config)).toThrow(/non-empty string/)
  })

  it("合法 root 原样通过", () => {
    expect(normalizeConfig({ root: "/tmp/x" })).toEqual({ root: "/tmp/x" })
  })

  it("apply 传入非法配置直接抛（不静默跳过）", () => {
    const ctx = hubContext()
    expect(() => apply(ctx, {} as Config)).toThrow(/config.root/)
  })
})
