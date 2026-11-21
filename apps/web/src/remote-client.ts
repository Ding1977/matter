/**
 * 浏览器 client 半装配（ISS-542 / P4-N2 · shell 切真链）。
 *
 * 建 cordis client context 上的 `ctx.connection`（connection client 半，真 HTTP POST）
 * 与 `ctx.remote`（gateway client 半），再 `$mount` 2314 生成的 `TYPERT_REMOTE` 投影。
 * 之后 ui-kb 的 documents-port 经 `ctx.remote.document.*` 取数——transport 切换不动 UI。
 *
 * 本模块不含任何 node 专有 import：host 测试与浏览器壳共用同一份装配（真 fetch，
 * 非 mock）——测试把 `fetch` 指向 host 的共享 `/api` FetchHandler，浏览器用全局 fetch。
 *
 * @module apps/web/src/remote-client
 */

import { Context } from "@deepseek-ai/cordis"
import { installConnection, type RpcFetch } from "@deepseek-ai/dsh-client-connection/client"
// ISS-544 审查必修二：`API_PATH` 不在 `.../client` 的出口（node/browser 变体皆无），
// 只在包根 lib/index.js（含 node: 专有 import，浏览器不安全）。从包声明的 `./src/*`
// 子路径直取单一真相源 src/api-path.ts（纯常量、无依赖）——dev/vitest/build 均可解析。
import { API_PATH } from "@deepseek-ai/dsh-client-connection/src/api-path.ts"
import { apply as applyGatewayClient } from "@deepseek-ai/dsh-api-gateway/client"
import { TYPERT_REMOTE } from "@matter/document-controller/remote"
import { createTypertShim } from "../../host/src/typert-shim.ts"

/** 一个已装好 `ctx.remote` 的 client context。 */
export interface RemoteClient {
  readonly ctx: Context
  /** 卸载：释放 client fiber（connection/gateway 的 disposer 随之运行）。 */
  dispose(): Promise<void>
}

/** 浏览器 fetch 的通道解析：把 RPC 相对 route 钉到 apiBase 的 origin 根。 */
export function browserFetch(apiBase: string): RpcFetch {
  // channel = API_PATH (`/api`)，route = `api/<endpoint>`（去掉前导 /）；
  // apiBase 末尾没有 /api 时按 origin 根解析，有 /api 时剥掉它，避免 `api/api/...`。
  const mountRoot = apiBase.replace(/\/?api$/, "")
  return (input, init) => {
    const route = String(input)
    const target = new URL(route, new URL(`${mountRoot}/`, globalThis.location?.href ?? "http://localhost/"))
    return globalThis.fetch(target, init)
  }
}

/**
 * 在 client context 上装配 connection + gateway + document remote 投影。
 *
 * @param options - `fetch` 真传输（浏览器用 {@link browserFetch}，测试指 host 共享 handler）、
 *   `apiBase` 仅用于文档化通道，`interactions` 默认 none（不订阅转发事件，unary 不等 socket）。
 * @returns 可 dispose 的 client 现场。
 */
export async function installRemoteClient(options: {
  readonly fetch: RpcFetch
  readonly apiBase?: string
  readonly interactions?: "none" | "answer"
  /** 测试内拒绝 WebSocket 升级（不阻塞 unary）；浏览器不传，用默认 WebSocket。 */
  readonly createWebSocket?: () => never
}): Promise<RemoteClient> {
  const ctx = new Context()

  // typert client 半：只需 remotes.register + contexts.getClient（$mount 用）
  ctx.provide("typert", createTypertShim() as never)

  installConnection(ctx, {
    interactions: options.interactions ?? "none",
    transport: {
      fetch: options.fetch,
      ...options.createWebSocket === undefined ? {} : { createWebSocket: options.createWebSocket },
    },
  })

  applyGatewayClient(ctx)
  await ctx.remote.$mount(TYPERT_REMOTE)

  return {
    ctx,
    async dispose(): Promise<void> {
      await ctx.fiber.dispose()
    },
  }
}

/** 单一路径常量：host/client 共用（P4-0 问3 §3.5）。 */
export { API_PATH }
