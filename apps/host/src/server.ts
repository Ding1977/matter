/**
 * node http 上的 /api 监听器（ISS-542 / P4-N2 · "/api 起监听"）。
 *
 * 把 {@link HostAssembly} 的共享 FetchHandler 接到真 socket：
 * - `GET /?token=...` → connection 的根路径握手（换签名 Cookie，303→./）；
 * - `/api/*` → `connection.admit`（Host/Origin + Cookie）→ connection 的 `bridge`
 *   把 node:http 请求转成 WHATWG Request 交给共享 FetchHandler（gateway interceptor）。
 *
 * 与 DSH `client-connection` 的 `apply()` 里 webServer 路由同构——本单是最小 node
 * 载体，不引 dsh-host-webserver 全套，直接用 bridge（connection 的公开 src 子路径）。
 *
 * @module apps/host/src/server
 */

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { bridge } from "@deepseek-ai/dsh-client-connection/src/http-bridge.ts"
import { API_PATH } from "@deepseek-ai/dsh-client-connection"
import type { HostAssembly } from "./assembly.ts"

/** 起好并监听的 host HTTP 服务。 */
export interface HostServer {
  /** `http://127.0.0.1:<port>`（测试据此发真 fetch）。 */
  readonly origin: string
  readonly port: number
  /** 关掉监听（测试 teardown）。 */
  close(): Promise<void>
}

/**
 * 起一个 node http 监听：根路径握手 + /api 共享 FetchHandler。
 *
 * `port` 缺省 0（随机端口）——q5-e2e / http-shell 的既有语义一字不变；
 * dev 入口传固定端口以起成品预览（ISS-905）。
 *
 * @param host - 已装配的 host 现场。
 * @param port - 监听端口，缺省 0 = 系统分配随机端口。
 * @returns 已监听的服务句柄。
 */
export async function createHostServer(host: HostAssembly, port = 0): Promise<HostServer> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://dsh.internal")
    // ① 根路径 token→cookie 握手（真 BrowserAuth）。
    if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
      host.ctx.connection.authorizeIndex(
        { method: req.method, url: req.url ?? "/", headers: req.headers },
        {
          writeHead(status, headers) {
            res.writeHead(status, headers as Record<string, string | string[] | number>)
          },
          end(body) {
            res.end(body)
          },
        },
      )
      return
    }
    // ② /api 通道：信任 + 认证 → bridge 到共享 FetchHandler。
    if (url.pathname === API_PATH || url.pathname.startsWith(`${API_PATH}/`)) {
      const admission = host.ctx.connection.admit({
        method: req.method,
        url: req.url ?? "/",
        headers: req.headers,
      })
      if ("rejection" in admission) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? "unauthorized" : "forbidden")
        return
      }
      void bridge(req, res, host.sharedFetch, admission.peer).catch((error: unknown) => {
        if (!res.writableEnded) {
          res.writeHead(500)
          res.end(error instanceof Error ? error.message : String(error))
        }
      })
      return
    }
    res.writeHead(404)
    res.end("not found")
  })

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    }),
  }
}
