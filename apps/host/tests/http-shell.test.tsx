// @vitest-environment jsdom
/**
 * shell 页真机端到端（ISS-542 / P4-N2 · Q5 的 socket 级实证）。
 *
 * 起真 node http /api 监听 → 浏览器壳 bootWeb 用全局 fetch 经真 socket 打 /api →
 * connection bridge → gateway → controller → ctx.documents → RPC 回显 → DOM。
 * 数据来自 host 侧真落盘种子文档，不是 shell STUB_DOCS（断言用唯一标记）。
 *
 * @module apps/host/tests/http-shell
 */

import { act, waitFor } from "@testing-library/react"
import type { DocRecord } from "@matter/document"
import { describe, expect, it } from "vitest"
import { createHostAssembly } from "../src/assembly.ts"
import { createHostServer } from "../src/server.ts"
import { bootWeb, type BootHandle } from "../../web/src/boot.ts"
import { resolveConfig } from "../../web/src/config.ts"

const SEED_TITLE = "HTTP-真链-2317-回显"
const SEED_BODY = "http-chain-body-marker"
const seed: DocRecord = {
  props: {
    id: "DOC-HTTP-2317",
    title: SEED_TITLE,
    author: "iss-2317",
    created: "2026-11-21T00:00:00+08:00",
    updated: "2026-11-21T00:00:00+08:00",
  },
  blocks: [{ id: "http-b1", type: "paragraph", rich: [{ text: SEED_BODY, marks: [] }] }],
}

describe("shell 真机 · browser → 真 socket /api → gateway → controller → ctx.documents → DOM", () => {
  it("bootWeb 经真 HTTP 回显 host 种子文档（列表 + 打开正文）", async () => {
    const host = await createHostAssembly({ seedDocs: [{ record: seed }] })
    const server = await createHostServer(host)
    let handle: BootHandle | undefined
    try {
      // ① 真握手：GET /?token=... → Set-Cookie（真 socket，非 stub）
      const target = new URL(host.ctx.connection.authenticatedUrl(server.origin))
      const indexResponse = await fetch(target, { redirect: "manual" })
      expect(indexResponse.status).toBe(303)
      const setCookie = indexResponse.headers.get("set-cookie") ?? ""
      expect(setCookie).toContain("HttpOnly")
      const cookie = setCookie.split(";", 1)[0]!

      // ② boot 用全局 fetch 打到真 server（cookie 带上，apiBase 指真实 origin）
      const root = document.createElement("div")
      root.id = "root"
      document.body.append(root)
      const config = resolveConfig({ search: `?apiBase=${encodeURIComponent(server.origin + "/api")}`, env: {} })
      await act(async () => {
        handle = await bootWeb(root, config, {
          remoteFetch: (input, init) => {
            const url = new URL(String(input), `${server.origin}/`)
            const headers = new Headers(init.headers)
            headers.set("cookie", cookie)
            return globalThis.fetch(url, { ...init, headers })
          },
        })
      })

      // ③ 列表真回显：host 种子标题出现，且不是 stub 标题。
      await waitFor(() => { expect(root.textContent).toContain(SEED_TITLE) })
      expect(root.textContent).not.toContain("欢迎使用 Matter 浏览器壳")

      // ④ 打开 → 正文经 remote get 投影真进 DOM。
      const button = root.querySelector("[data-ui-kb='list'] button") as HTMLButtonElement
      expect(button).not.toBeNull()
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      })
      await waitFor(() => {
        expect(root.querySelector("[data-demo='doc-body'][data-remote='true']")).not.toBeNull()
      })
      expect(root.textContent).toContain(SEED_BODY)
    } finally {
      if (handle !== undefined) await act(async () => { await handle?.dispose() })
      await server.close()
      await host.dispose()
    }
  })
})
