/**
 * Q5 端到端闭环（ISS-542 / P4-N2 · N 轨收官判据）。
 *
 * 双 context 真 fetch 通道：host context 装配真 storage/documents/controller/gateway/
 * connection；client context 装 connection client 半 + gateway client 半 + $mount 投影。
 * 中间 transport 是**真** `Request → host.sharedFetch.fetch → connection bridge →
 * gateway interceptor → DocumentController → ctx.documents → RPC Response`，绝非 mock。
 *
 * 信任流走真路径：启动 token → `authorizeIndex` 换签名 Cookie → 每次 RPC 经 `admit`
 * （Host/Origin loopback 校验 + Cookie 验签）→ 失败 403/401。
 *
 * @module apps/host/tests/q5-e2e
 */

import { Context } from "@deepseek-ai/cordis"
import { API_PATH } from "@deepseek-ai/dsh-client-connection"
import { createRemoteDocumentsPort } from "@matter/client-ui-kb/client"
import type { DocRecord } from "@matter/document"
import { describe, expect, it } from "vitest"
import { createHostAssembly, type HostAssembly } from "../src/assembly.ts"
import { installRemoteClient, type RemoteClient } from "../../web/src/remote-client.ts"

/** 一条种子文档：标题/正文带唯一标记，断言回显确属 host 落盘数据。 */
const SEED_MARK = "Q5-真链回显-2317"
const seed: DocRecord = {
  props: {
    id: "DOC-Q5-2317",
    title: SEED_MARK,
    author: "iss-2317",
    created: "2026-11-21T00:00:00+08:00",
    updated: "2026-11-21T00:00:00+08:00",
  },
  blocks: [{ id: "q5-b1", type: "paragraph", rich: [{ text: "q5-block-text", marks: [] }] }],
}

/** 握手：用 host 进程 token 在根路径换签名 Cookie（真 BrowserAuth 路径）。 */
function browserCookie(host: HostAssembly): string {
  const target = new URL(host.ctx.connection.authenticatedUrl("http://127.0.0.1/"))
  let setCookie: string | undefined
  host.ctx.connection.authorizeIndex(
    {
      method: "GET",
      url: `${target.pathname}${target.search}`,
      headers: { host: target.host },
    },
    {
      writeHead(_status, headers) {
        setCookie = headers?.["set-cookie"]
      },
      end() {},
    },
  )
  if (setCookie === undefined) throw new Error("token→cookie 握手未拿到 set-cookie")
  return setCookie.split(";", 1)[0]!
}

/** 把 client RPC fetch 指到 host 共享 /api FetchHandler，全程真 Request/Response。 */
async function wireClient(host: HostAssembly, cookie: string): Promise<RemoteClient> {
  return installRemoteClient({
    apiBase: API_PATH,
    fetch: async (input, init) => {
      const url = new URL(String(input), "http://127.0.0.1/")
      const headers = new Headers(init.headers)
      headers.set("host", url.host)
      headers.set("cookie", cookie)
      const request = new Request(url, { ...init, headers })
      const admission = host.ctx.connection.admit(request)
      if ("rejection" in admission) {
        return new Response("rejected", { status: admission.rejection })
      }
      return host.sharedFetch.fetch(request, admission.peer)
    },
    // 测试内无 WebSocket 载体：拒绝升级，unary HTTP 不等待 socket（DSH authenticated-node 同款口径）。
    createWebSocket: () => { throw new Error("no websocket in this fixture") },
  })
}

describe("Q5 · browser → /api → gateway → controller → ctx.documents → 回显", () => {
  it("双 context 真 fetch 闭环：list/get 回显 host 真落盘文档，非 stub", async () => {
    const host = await createHostAssembly({ seedDocs: [{ record: seed }] })
    try {
      // 装配实证：gateway 与 connection 同挂共享 FetchHandler。
      expect(host.ctx.connection).toBeDefined()
      // Cordis Service 在 Context 上是 fiber 绑定视图，不做身份相等断言；存在性 + 真 RPC 往返才是判据。
      expect(host.ctx.typertGateway).toBeDefined()
      expect(host.gateway).toBeDefined()
      expect(host.ctx.document).toBeDefined()

      const cookie = browserCookie(host)
      expect(cookie).toContain("=")

      const client = await wireClient(host, cookie)
      try {
        // 真链上 ctx.remote.document 已 $mount（生成投影的 document namespace）。
        expect(client.ctx.remote.document).toBeDefined()
        const port = createRemoteDocumentsPort(client.ctx)

        // ① list 真往返：host 侧种子标题回显（不是 shell STUB_DOCS）。
        const rows = await port.list()
        expect(rows.map((row) => row.id)).toContain(seed.props.id)
        expect(rows.find((row) => row.id === seed.props.id)?.title).toBe(SEED_MARK)

        // ② get 真往返：正文 block 回显。
        const doc = await port.get(seed.props.id)
        expect(doc?.id).toBe(seed.props.id)
        expect(doc?.title).toBe(SEED_MARK)
        expect(doc?.blocks.some((block) => block.text.includes("q5-block-text"))).toBe(true)

        // ③ 前缀过滤也过真链（DocListRequest 参数编解码经生成 codec）。
        const filtered = await port.list({ prefix: "DOC-Q5" })
        expect(filtered.map((row) => row.id)).toEqual([seed.props.id])
        const none = await port.list({ prefix: "NO-SUCH-PREFIX" })
        expect(none).toEqual([])
      } finally {
        await client.dispose()
      }
    } finally {
      await host.dispose()
    }
  })

  it("信任流负例：无 Cookie 的 RPC 请求被 admit 拒 401，跨站 Host 被拒 403", async () => {
    const host = await createHostAssembly({ seedDocs: [{ record: seed }] })
    try {
      const noCookie = new Request("http://127.0.0.1/api/document/list", {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: "n", method: "document/list", payload: {} }),
      })
      expect(host.ctx.connection.admit(noCookie)).toEqual({ rejection: 401 })

      const crossSite = new Request("http://evil.example/api/document/list", {
        method: "POST",
        headers: { host: "evil.example", cookie: browserCookie(host) },
      })
      expect(host.ctx.connection.admit(crossSite)).toEqual({ rejection: 403 })
    } finally {
      await host.dispose()
    }
  })

  it("gateway 未认领 endpoint 返回 404（共享 FetchHandler 的 404 语义）", async () => {
    const host = await createHostAssembly()
    try {
      const cookie = browserCookie(host)
      const request = new Request("http://127.0.0.1/api/unclaimed/nope", {
        method: "POST",
        headers: { host: "127.0.0.1", cookie },
        body: "{}",
      })
      const admission = host.ctx.connection.admit(request)
      expect("rejection" in admission).toBe(false)
      if ("rejection" in admission) return
      const response = await host.sharedFetch.fetch(request, admission.peer)
      expect(response.status).toBe(404)
    } finally {
      await host.dispose()
    }
  })
})
