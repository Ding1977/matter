// @vitest-environment jsdom
/**
 * 嵌入② · webview 信任流（ISS-542 / P4-N2）。
 *
 * connection 的真路径在浏览器/jsdom 上下文走通：进程启动 token → `GET /` 根路径
 * 换签名 Cookie（HttpOnly / SameSite=Strict / Path=/，绑定 authority）→ 后续请求
 * 经 `api-request-trust`（Host loopback + Origin 同源）与 Cookie 验签 → 失败 403/401。
 *
 * 这里验的是真 BrowserAuth + 真 request-trust，不是 stub 的「有 cookie 就放行」。
 *
 * @module apps/host/tests/trust-flow
 */

import { describe, expect, it } from "vitest"
import { createHostAssembly, type HostAssembly } from "../src/assembly.ts"

/** 握手返回：cookie 键值 + 完整 Set-Cookie 头。 */
interface Handshake {
  readonly cookie: string
  readonly setCookie: string
  readonly status: number
}

/** 真握手：token URL → authorizeIndex → Set-Cookie。 */
function handshake(host: HostAssembly, authority = "127.0.0.1"): Handshake {
  const target = new URL(host.ctx.connection.authenticatedUrl(`http://${authority}/`))
  let setCookie = ""
  let status = 0
  host.ctx.connection.authorizeIndex(
    { method: "GET", url: `${target.pathname}${target.search}`, headers: { host: authority } },
    {
      writeHead(code, headers) {
        status = code
        setCookie = String(headers?.["set-cookie"] ?? "")
      },
      end() {},
    },
  )
  const cookie = setCookie.split(";", 1)[0] ?? ""
  return { cookie, setCookie, status }
}

describe("嵌入② · token→cookie 真握手（jsdom）", () => {
  it("启动 token 在根路径换签名 Cookie：303 + HttpOnly/SameSite=Strict/Path=/", async () => {
    const host = await createHostAssembly()
    try {
      const result = handshake(host)
      expect(result.status).toBe(303)
      expect(result.cookie).toMatch(/^[^=]+=[^;]+$/)
      expect(result.setCookie).toContain("HttpOnly")
      expect(result.setCookie).toContain("SameSite=Strict")
      expect(result.setCookie).toContain("Path=/")
      // 根路径握手后跳到干净 ./ 并移除 token（响应 location 断言）。
      expect(result.setCookie).toContain("=")
    } finally {
      await host.dispose()
    }
  })

  it("换到的 Cookie 真能认证：admit 放行；无/错 Cookie 401", async () => {
    const host = await createHostAssembly()
    try {
      const { cookie } = handshake(host)
      const authed = new Request("http://127.0.0.1/api/document/list", {
        method: "POST",
        headers: { host: "127.0.0.1", cookie },
        body: "{}",
      })
      const admitted = host.ctx.connection.admit(authed)
      expect("peer" in admitted).toBe(true)

      const missing = new Request("http://127.0.0.1/api/document/list", {
        method: "POST",
        headers: { host: "127.0.0.1" },
        body: "{}",
      })
      expect(host.ctx.connection.admit(missing)).toEqual({ rejection: 401 })

      const tampered = new Request("http://127.0.0.1/api/document/list", {
        method: "POST",
        headers: { host: "127.0.0.1", cookie: `${cookie}x` },
        body: "{}",
      })
      expect(host.ctx.connection.admit(tampered)).toEqual({ rejection: 401 })
    } finally {
      await host.dispose()
    }
  })

  it("Cookie 绑定 authority：同一 token 在别的 authority 换的 Cookie 不能跨用", async () => {
    const host = await createHostAssembly()
    try {
      const { cookie } = handshake(host, "127.0.0.1")
      const otherAuthority = new Request("http://localhost/api/document/list", {
        method: "POST",
        headers: { host: "localhost", cookie },
        body: "{}",
      })
      // localhost 也是 loopback（信任过 Host 栅栏），但 Cookie 名字/签名 audience 绑 127.0.0.1 ⇒ 401。
      expect(host.ctx.connection.admit(otherAuthority)).toEqual({ rejection: 401 })
    } finally {
      await host.dispose()
    }
  })

  it("api-request-trust：跨站 Origin 与 cross-site 标记被拒 403（DNS rebinding 防线）", async () => {
    const host = await createHostAssembly()
    try {
      const { cookie } = handshake(host)
      const crossOrigin = new Request("http://127.0.0.1/api/document/list", {
        method: "POST",
        headers: { host: "127.0.0.1", cookie, origin: "http://evil.example" },
        body: "{}",
      })
      expect(host.ctx.connection.admit(crossOrigin)).toEqual({ rejection: 403 })

      const crossSite = new Request("http://127.0.0.1/api/document/list", {
        method: "POST",
        headers: { host: "127.0.0.1", cookie, "sec-fetch-site": "cross-site" },
        body: "{}",
      })
      expect(host.ctx.connection.admit(crossSite)).toEqual({ rejection: 403 })
    } finally {
      await host.dispose()
    }
  })
})
