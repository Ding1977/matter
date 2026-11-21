/**
 * 成品预览的 host dev 入口（ISS-905 · D2 前置承载层）。
 *
 * 复用 {@link createHostAssembly} 的**真装配**（storage-json + journal + openDocuments +
 * DocumentController + connection /api + gateway），唯一改变是 storage 落**持久目录**
 * 而非 mkdtemp：改动能留存，刷新后仍回显。端口固定，供 vite proxy 指向。
 *
 * 不调 `assembly.dispose()`：它会 `rm(root, {recursive:true})`，dev 下等于删用户数据。
 *
 * 启动时用 launch token 在根路径换一枚签名 cookie，cookie 的 authority 按 **vite 端口**
 * 签署（Host 头显式置为 127.0.0.1:<webPort>），并写入会话文件供 vite proxy 注入——
 * 这样浏览器只需打开一个 5173 地址，/api 经同源代理即被 admit 接受（Origin/Host/cookie 三者同构）。
 *
 * @module apps/host/src/dev
 */

import { get as httpGet } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHostAssembly } from "./assembly.ts"
import { createHostServer } from "./server.ts"
import {
  PREVIEW_DATA_DIR,
  PREVIEW_HOST_PORT,
  PREVIEW_WEB_PORT,
  seedPreviewDocuments,
  type SeedResult,
} from "./seed.ts"

/** 仓库根（node strip-types 下 import.meta.url 是真路径）。 */
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..")

const DATA_DIR = process.env.MATTER_PREVIEW_DATA_DIR ?? join(REPO_ROOT, PREVIEW_DATA_DIR)
const PORT = PREVIEW_HOST_PORT
const WEB_PORT = PREVIEW_WEB_PORT
const SESSION_FILE = join(DATA_DIR, "preview-session.json")

/** 会话文件形态（dev-preview 编排器读取 cookie 注入 vite proxy）。 */
interface PreviewSession {
  readonly cookie: string
  readonly hostPort: number
  readonly webPort: number
  readonly dataDir: string
  readonly seed: SeedResult
}

/** 在根路径用 launch token 换签名 cookie；Host 头钉到 vite 端口，使 cookie authority 与浏览器同源。 */
function exchangeCookie(tokenUrl: string, hostHeader: string): Promise<string> {
  return new Promise((resolveCookie, reject) => {
    const request = httpGet(tokenUrl, { headers: { host: hostHeader } }, (response) => {
      const cookie = (response.headers["set-cookie"] ?? [])[0]?.split(";", 1)[0] ?? ""
      response.resume()
      if (cookie.length === 0 || !cookie.includes("=")) {
        reject(new Error(`token→cookie 握手未拿到 set-cookie（status=${String(response.statusCode)}）`))
        return
      }
      resolveCookie(cookie)
    })
    request.on("error", reject)
  })
}

/** 起成品预览 host；永不主动删除持久目录。 */
async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true })

  const host = await createHostAssembly({ root: DATA_DIR })
  const seed = await seedPreviewDocuments(host.ctx.documents)

  const server = await createHostServer(host, PORT)
  const tokenUrl = host.ctx.connection.authenticatedUrl(server.origin)
  // 浏览器可能用 127.0.0.1 或 localhost 打开预览；cookie 名按 authority 派生，
  // 故两种 authority 各换一枚并一起注入代理，保证两种 Host 都能过 admit。
  const authorities = [`127.0.0.1:${String(WEB_PORT)}`, `localhost:${String(WEB_PORT)}`]
  const cookies = await Promise.all(authorities.map((authority) => exchangeCookie(tokenUrl, authority)))
  const cookie = [...new Set(cookies)].join("; ")

  const session: PreviewSession = { cookie, hostPort: PORT, webPort: WEB_PORT, dataDir: DATA_DIR, seed }
  await writeFile(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, "utf8")

  console.log(`[preview] host   ${server.origin}   /api 真装配已就绪`)
  console.log(`[preview] web    http://127.0.0.1:${String(WEB_PORT)}   （dev:preview 同时启动 vite）`)
  console.log(`[preview] data   ${DATA_DIR}`)
  console.log(`[preview] seed   ${String(seed.added)} added / ${String(seed.skipped)} skipped / ${String(seed.total)} total`)

  let closing = false
  const shutdown = (): void => {
    if (closing) return
    closing = true
    void server.close().then(() => process.exit(0), () => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((error: unknown) => {
  console.error("[preview] host 启动失败：", error)
  process.exit(1)
})
