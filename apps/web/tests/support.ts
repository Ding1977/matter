/**
 * 浏览器快照回归的支撑层（段一 · 照 DSH `apps/web/tests/scaffold.ts` 的三态语义）。
 *
 * 三态（`MATTER_SNAPSHOT`，与 DSH 的 `DSH_SNAPSHOT` 同语义）：
 *   replay  默认 —— **只比对**，绝不写基线、绝不读 `.env`；
 *   record  生成/更新基线 —— 唯一允许碰 env 的分支（loadRecordEnv）；
 *   refresh 重放后更新当前期望 —— 先出逐行差异报告，再写回基线，不读 env。
 *
 * 这里与 agent 的「手」（cdp-driver / surface 逻辑）刻意分开：本文件是测试的「眼」，
 * 只读页面、不操作老板正在看的界面。边界写进 docs/memory/browser-snapshots.md。
 *
 * @module apps/web/tests/support
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Browser } from "playwright"

/** 仓库根（本文件在 apps/web/tests/ 下，上三级）。 */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
/** 全局 pnpm 入口 —— dev:preview 的宿主命令（老板指定，不换成局部 pnpm）。 */
const PNPM_CJS = join(homedir(), ".npm-global", "lib", "node_modules", "pnpm", "bin", "pnpm.cjs")
/** 预览双端口，与 scripts/dev-preview.mjs 的默认值一致。 */
export const API_PORT = 3212
export const WEB_PORT = 5173
/**
 * 列表页地址（vite dev，/api 已由 dev-preview 代理并注入 cookie）。
 * ⚠️ 用 localhost 而非 127.0.0.1：本仓 vite 未设 server.host，实测只绑 [::1]:5173，
 * 直接拿 IPv4 字面量探活会 90s 超时（屏幕上却只有 vite 的 READY，静默错）。
 */
export const BASE_URL = `http://localhost:${String(WEB_PORT)}/`
/** 就绪判据：列表里恰好 12 条种子文档（不用固定 sleep）。 */
export const SEED_ROWS = 12

/** 三态。 */
export type SnapshotMode = "replay" | "record" | "refresh"

/**
 * 解析并校验三态。未设/空值 = replay。
 * @returns 生效的模式。
 */
export function snapshotMode(): SnapshotMode {
  const raw = process.env.MATTER_SNAPSHOT
  if (raw === undefined || raw === "" || raw === "replay") return "replay"
  if (raw === "record" || raw === "refresh") return raw
  throw new Error(`MATTER_SNAPSHOT 只能是 replay / record / refresh；收到 ${JSON.stringify(raw)}`)
}

/**
 * 只在 record 分支调用：加载仓库根 `.env`（缺文件不报错，与 DSH 同口径）。
 * ⛔ replay / refresh 两态的整条调用链都不经过本函数 —— 这是「replay 不读 .env」的代码层保证。
 */
export function loadRecordEnv(): void {
  const envPath = join(ROOT, ".env")
  const loader = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile
  if (loader === undefined) return
  try {
    loader.call(process, envPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/** 在某个地址上真 bind 一次，判断端口是否占用。 */
function bindBusy(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE" || error.code === "EACCES")
    })
    server.listen(port, host, () => server.close(() => resolve(false)))
  })
}

/**
 * 端口是否已被占用。双栈都查：vite 实测只绑 IPv6 [::1]，只查 127.0.0.1 会漏判
 * （占用被当成空闲 ⇒ 起第二个 vite 静默 EADDRINUSE 或换端口）。
 */
export async function portInUse(port: number): Promise<boolean> {
  return (await bindBusy(port, "::")) || (await bindBusy(port, "127.0.0.1"))
}

/** 端口冲突时报可读错误 —— 绝不静默换端口。 */
export async function assertPortsFree(): Promise<void> {
  const busy: number[] = []
  for (const port of [API_PORT, WEB_PORT]) {
    if (await portInUse(port)) busy.push(port)
  }
  if (busy.length > 0) {
    throw new Error(
      `预览端口被占用：${busy.join(" / ")}（需要 ${String(API_PORT)} + ${String(WEB_PORT)}）。\n`
      + "本工具不静默换端口 —— 请先停掉占用者（lsof -nP -iTCP:<port> -sTCP:LISTEN）后重跑。",
    )
  }
}

/** 已起的预览进程句柄。 */
export interface PreviewHandle {
  readonly child: ChildProcess
  /** 累积的预览日志（失败时原样贴出，便于归因）。 */
  logs(): string
}

/** HTTP 探活（带超时，不挂死）。 */
async function httpOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 杀进程组：detached 启动后 host/vite 与 pnpm 同组，负 pid 一次收干净。 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    // ESRCH = 进程已经没了；其余（如 EPERM）不能吞，交给调用方看见。
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill(signal) } catch { /* 已退出 */ }
    }
  }
}

/**
 * 起 dev:preview，并等到**真浏览器里列表出现 12 条文档**才算就绪。
 * 失败路径必杀进程，绝不留一个「后端挂了前端还在」的半成品。
 * @param browser - 用于就绪探测的 Playwright browser（复用，不额外起内核）。
 * @returns 预览句柄，交给 stopPreview 收。
 */
export async function startPreview(browser: Browser): Promise<PreviewHandle> {
  if (!existsSync(PNPM_CJS)) throw new Error(`找不到全局 pnpm：${PNPM_CJS}（老板指定用它起 dev:preview）`)
  await assertPortsFree()

  let out = ""
  const child = spawn(process.execPath, [PNPM_CJS, "run", "dev:preview"], {
    cwd: ROOT,
    env: { ...process.env, MATTER_SNAPSHOT: snapshotMode() },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString() })
  child.stderr?.on("data", (chunk: Buffer) => { out += chunk.toString() })

  // 进程被异常终止（测试崩溃 / Ctrl-C）时也要收掉整组 —— 同步 kill， exit 事件里异步没用。
  const onExit = (): void => killGroup(child, "SIGKILL")
  process.once("exit", onExit)

  const fail = async (reason: string): Promise<never> => {
    killGroup(child, "SIGKILL")
    process.removeListener("exit", onExit)
    throw new Error(`${reason}\n---- 预览日志 ----\n${out.slice(-4000)}`)
  }

  try {
    // ① 等 HTTP 起来（条件轮询，不是固定 sleep）
    const deadline = Date.now() + 90_000
    let webUp = false
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return fail(`dev:preview 提前退出（exit=${String(child.exitCode)}）`)
      if (await httpOk(BASE_URL)) { webUp = true; break }
      await delay(250)
    }
    if (!webUp) return fail(`等待预览 HTTP 超时（90s）：${BASE_URL}`)

    // ② 等真浏览器里列表出现 12 条文档（就绪的唯一判据）
    const probe = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    try {
      await probe.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
      await probe.waitForFunction(
        (n) => document.querySelectorAll('[data-ui-kb="list"] li[data-doc-id]').length === n,
        SEED_ROWS,
        { timeout: 90_000 },
      )
    } finally {
      await probe.close()
    }
  } catch (error) {
    killGroup(child, "SIGKILL")
    process.removeListener("exit", onExit)
    if (error instanceof Error && error.message.includes("---- 预览日志 ----")) throw error
    throw new Error(`预览就绪失败：${String(error)}\n---- 预览日志 ----\n${out.slice(-4000)}`)
  }

  return {
    child,
    logs: () => out,
  }
}

/**
 * 停预览：杀整组 + 等退出 + 断言双端口确实释放（含子进程残留检查）。
 * @param handle - startPreview 的句柄；空值直接返回。
 */
export async function stopPreview(handle: PreviewHandle | undefined): Promise<void> {
  if (handle === undefined) return
  const { child } = handle
  killGroup(child, "SIGTERM")
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && child.exitCode === null) await delay(100)
  if (child.exitCode === null) killGroup(child, "SIGKILL")

  for (const port of [API_PORT, WEB_PORT]) {
    const tries = 40
    for (let i = 0; i < tries; i += 1) {
      if (!(await portInUse(port))) break
      if (i === tries - 1) {
        throw new Error(
          `预览已停止但端口 ${String(port)} 仍被占用 —— 可能有残留子进程。\n`
          + `请跑 ps / lsof -nP -iTCP:${String(port)} -sTCP:LISTEN 核实，不许留后台。`,
        )
      }
      await delay(100)
    }
  }
}

/** 开一个指定视口的干净页（每次快照独立页，避免彼此的滚动/选中态串味）。 */
export function openSnapshotPage(browser: Browser, width: number, height = 900) {
  return browser.newPage({ viewport: { width, height } })
}

/** 抓整页 ARIA 树（基线格式 = ariaSnapshot 序列化后的 md，与 DSH 的 ui.expected.md 同形态）。 */
export function captureAria(page: Awaited<ReturnType<Browser["newPage"]>>): Promise<string> {
  return page.locator("body").ariaSnapshot()
}

/** 首个差异（1-based 行号）；无差异返回 null。 */
export interface FirstDiff {
  readonly line: number
  readonly expected: string
  readonly actual: string
}

/**
 * 逐行比对，用于「红的输出点名哪一行变了」。
 * @param expected - 基线文本。
 * @param actual - 当前文本。
 * @returns 首个差异或 null。
 */
export function firstDiff(expected: string, actual: string): FirstDiff | null {
  const e = expected.replace(/\s+$/, "").split("\n")
  const a = actual.replace(/\s+$/, "").split("\n")
  for (let i = 0; i < Math.max(e.length, a.length); i += 1) {
    if (e[i] !== a[i]) {
      return {
        line: i + 1,
        expected: e[i] ?? "<基线在此结束>",
        actual: a[i] ?? "<当前在此结束>",
      }
    }
  }
  return null
}

/** 首个差异附近的小上下文（±2 行），让报错自带可读 diff。 */
export function diffContext(expected: string, actual: string, center: number, radius = 2): string {
  const e = expected.replace(/\s+$/, "").split("\n")
  const a = actual.replace(/\s+$/, "").split("\n")
  const from = Math.max(1, center - radius)
  const to = Math.min(Math.max(e.length, a.length), center + radius)
  const lines: string[] = []
  for (let i = from; i <= to; i += 1) {
    const mark = i === center ? ">" : " "
    lines.push(`${mark} ${String(i).padStart(3)} | 期望: ${e[i - 1] ?? "<无>"}`)
    lines.push(`${mark} ${String(i).padStart(3)} | 实际: ${a[i - 1] ?? "<无>"}`)
  }
  return lines.join("\n")
}

/**
 * 三态落点：replay 只读比对；record/refresh 写回基线（refresh 先出差异报告）。
 * ⚠️ replay 分支里没有任何 writeFile / env 读取调用 —— 这是只读语义的代码层保证。
 *
 * @param goldenPath - 基线绝对路径（apps/web/tests/expected/<场景>/<宽>.expected.md）。
 * @param actual - 当前 ARIA 快照。
 * @param mode - 三态。
 * @param label - 人读标签，必须含「场景 + 视口」（报错点名用）。
 */
export async function compareOrWriteGolden(
  goldenPath: string,
  actual: string,
  mode: SnapshotMode,
  label: string,
): Promise<void> {
  const normalized = `${actual.replace(/\s+$/, "")}\n`

  if (mode === "record" || mode === "refresh") {
    let prior: string | undefined
    try {
      prior = await readFile(goldenPath, "utf8")
    } catch {
      prior = undefined
    }
    if (mode === "refresh") {
      const d = prior === undefined ? null : firstDiff(prior, normalized)
      console.log(`[refresh] ${label}：${d === null ? "无变化" : `更新第 ${String(d.line)} 行（${d.expected} → ${d.actual}）`}`)
    }
    await mkdir(dirname(goldenPath), { recursive: true })
    await writeFile(goldenPath, normalized, "utf8")
    return
  }

  // ↓ replay：全程只读
  let expected: string
  try {
    expected = await readFile(goldenPath, "utf8")
  } catch {
    throw new Error(`[replay] ${label}：基线缺失 ${goldenPath}\n先跑 MATTER_SNAPSHOT=record 生成基线。`)
  }
  if (expected === normalized) return

  const d = firstDiff(expected, normalized)
  const detail = d === null
    ? "（首尾空白差异）"
    : `第 ${String(d.line)} 行：\n  - 期望: ${d.expected}\n  + 实际: ${d.actual}\n\n${diffContext(expected, normalized, d.line)}`
  throw new Error(`[replay] 快照不符 · ${label}\n基线: ${goldenPath}\n${detail}`)
}
