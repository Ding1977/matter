#!/usr/bin/env node
/**
 * 一条命令起成品预览（ISS-905）。
 *
 * 并发起两件事：
 *   ① host dev（固定端口，真装配 + 持久种子数据 + token→cookie 握手）；
 *   ② vite dev（5173，/api 代理到 host 并注入握手 cookie）。
 *
 * 零新依赖：只用 node 内置 child_process/fs/path。两个子进程的输出原样透传，
 * 任一退出即收掉另一个——不让「后端挂了前端还在」的半成品状态留着骗人。
 *
 * @module scripts/dev-preview
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** 仓库根 = 本脚本所在 scripts/ 的上一级。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * pnpm 把 cordis 当传递依赖塞进虚拟店，不在根 node_modules 建顶层链接；
 * 而 node ESM 从 apps/host/src 逐级向上找包时看不到虚拟店内部 ⇒ dev 入口起不来。
 * 这里只在本树缺链接时补一个指向虚拟店的链接（node_modules 不入库，纯本机修复）。
 */
function ensureCordisLink() {
  const scope = path.join(ROOT, "node_modules", "@deepseek-ai")
  const link = path.join(scope, "cordis")
  if (existsSync(link)) return
  const store = path.join(ROOT, "node_modules", ".pnpm")
  if (!existsSync(store)) return
  const hit = readdirSync(store).find((name) => name.startsWith("@deepseek-ai+cordis@"))
  if (hit === undefined) return
  mkdirSync(scope, { recursive: true })
  symlinkSync(`../.pnpm/${hit}/node_modules/@deepseek-ai/cordis`, link, "dir")
}
ensureCordisLink()

const PORT = Number(process.env.MATTER_PREVIEW_API_PORT ?? 3212)
const WEB_PORT = Number(process.env.MATTER_PREVIEW_WEB_PORT ?? 5173)
const DATA_DIR = process.env.MATTER_PREVIEW_DATA_DIR ?? path.join(ROOT, "dev-data", "preview")
const SESSION_FILE = path.join(DATA_DIR, "preview-session.json")

/** 清掉上一轮会话，避免 host 没写新 session 时读到旧 cookie。 */
try { unlinkSync(SESSION_FILE) } catch { /* 本就没有 */ }

const baseEnv = {
  ...process.env,
  MATTER_PREVIEW_API_PORT: String(PORT),
  MATTER_PREVIEW_WEB_PORT: String(WEB_PORT),
  MATTER_PREVIEW_DATA_DIR: DATA_DIR,
}

console.log(`[preview] starting host on 127.0.0.1:${String(PORT)} ...`)
const host = spawn(process.execPath, [
  "--no-warnings=ExperimentalWarning",
  "--experimental-loader",
  path.join(ROOT, "scripts", "dev-ts-loader.mjs"),
  path.join(ROOT, "apps", "host", "src", "dev.ts"),
], {
  cwd: ROOT,
  env: baseEnv,
  stdio: ["ignore", "inherit", "inherit"],
})

/** 等 host 写出会话文件（含 cookie）；超时即失败，不静默起一个没有登录态的前端。 */
function waitSession(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (host.exitCode !== null) {
        reject(new Error(`host 提前退出（exit=${String(host.exitCode)}），未写出 ${SESSION_FILE}`))
        return
      }
      if (existsSync(SESSION_FILE)) {
        try {
          resolve(JSON.parse(readFileSync(SESSION_FILE, "utf8")))
        } catch (error) {
          reject(error)
        }
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`等待 host 会话文件超时（${String(timeoutMs)}ms）：${SESSION_FILE}`))
        return
      }
      setTimeout(tick, 200)
    }
    tick()
  })
}

let vite
async function start() {
  const session = await waitSession()
  if (typeof session.cookie !== "string" || session.cookie.length === 0) {
    throw new Error("host 会话文件缺 cookie，拒绝起无登录态前端")
  }
  console.log(`[preview] starting vite on 127.0.0.1:${String(WEB_PORT)} ...`)
  vite = spawn(path.join(ROOT, "node_modules", ".bin", "vite"), ["--config", "apps/web/vite.config.ts"], {
    cwd: ROOT,
    env: { ...baseEnv, MATTER_PREVIEW_COOKIE: session.cookie },
    stdio: "inherit",
  })
  vite.on("exit", (code) => {
    host.kill("SIGTERM")
    process.exit(code ?? 0)
  })
  console.log(`[preview] READY  列表页  http://127.0.0.1:${String(WEB_PORT)}/`)
  console.log(`[preview] READY  /api    http://127.0.0.1:${String(PORT)}/api  （cookie 已注入代理）`)
}

host.on("exit", (code) => {
  if (vite !== undefined && !vite.killed) vite.kill("SIGTERM")
  if (code !== 0 && code !== null) process.exit(code)
})

const shutdown = () => {
  host.kill("SIGTERM")
  if (vite !== undefined && !vite.killed) vite.kill("SIGTERM")
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

start().catch((error) => {
  console.error("[preview] 启动失败：", error)
  shutdown()
  process.exit(1)
})
