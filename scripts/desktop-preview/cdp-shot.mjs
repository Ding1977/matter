// CDP 截图器（ISS-854 验证用）—— Chrome headless + DevTools 协议，**零第三方依赖**。
//
// 为什么用 `--remote-debugging-pipe` 而不是 WebSocket：实测 Node 24 自带的 WebSocket（undici）
//   在收到 Chrome 153 的第二条响应时抛 TypeError 并 1006 断连（`Browser.getVersion` 能过、
//   `Page.enable` 就炸）。管道传输是 NUL 分隔的 JSON，绕开整个 WS 栈，稳。
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const URL_ = arg("url")
const OUT = arg("out", "out/shot.png")
const PRE = arg("pre", "")
const WAIT = Number(arg("wait-ms", "10000"))
const POST = Number(arg("post-ms", "800"))
const WIDTH = Number(arg("width", "1440"))
const HEIGHT = Number(arg("height", "900"))
const SCALE = Number(arg("scale", "2"))
const PROFILE_DIR = arg("user-data-dir", "out/chrome-profile")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (!URL_) {
  console.error("缺少 --url")
  process.exit(2)
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    // ⚠️ 必须 --no-sandbox：DSH 自己的沙箱（seatbelt）下，Chrome 的**嵌套沙箱初始化会失败**
    //    （`sandbox initialization failed: Operation not permitted` → GPU 进程 exit_code=6 →
    //    `GPU process isn't usable. Goodbye.` → renderer 不响应，Page.enable 永远不返回）。
    //    这不是"绕过安全"，是把 Chrome 放进一个已受限的沙箱时需要它的自沙箱让位。
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    `--crash-dumps-dir=${PROFILE_DIR}/crash`,
    `--user-data-dir=${PROFILE_DIR}`,
    "--remote-debugging-pipe",
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ],
  // fd 3 = 我们写（Chrome 读），fd 4 = Chrome 写（我们读）
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
)
let chromeStderr = ""
chrome.stderr.on("data", (d) => (chromeStderr += String(d)))

// ── 管道传输：NUL 分隔 JSON ──────────────────────────────────────────────────────
const writeBuf = chrome.stdio[3]
const readBuf = chrome.stdio[4]
let rx = ""
let nextId = 1
const pending = new Map()
const events = []

readBuf.on("data", (chunk) => {
  rx += chunk.toString("utf8")
  let idx
  while ((idx = rx.indexOf("\0")) >= 0) {
    const raw = rx.slice(0, idx)
    rx = rx.slice(idx + 1)
    if (!raw.trim()) continue
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      continue
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message}`))
      else resolve(msg.result ?? {})
    } else {
      events.push(msg)
    }
  }
})

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    writeBuf.write(JSON.stringify(payload) + "\0")
  })
}

function eventText() {
  const lines = []
  for (const ev of events) {
    if (ev.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(ev.params?.type)) {
      lines.push(`[console.${ev.params.type}] ${(ev.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ")}`)
    }
    if (ev.method === "Log.entryAdded" && ["error", "warning"].includes(ev.params?.entry?.level)) {
      lines.push(`[log.${ev.params.entry.level}] ${ev.params.entry.text}`)
    }
  }
  return lines
}

const NO_ANIM = `(() => { const s=document.createElement('style'); s.textContent='*{transition:none!important;animation:none!important}'; document.head.appendChild(s); return 'ok' })()`

try {
  const version = await send("Browser.getVersion")
  console.log(`Chrome ${version.product}`)

  const { targetInfos } = await send("Target.getTargets")
  const page = targetInfos.find((t) => t.type === "page")
  if (!page) throw new Error("没有 page target：" + JSON.stringify(targetInfos.map((t) => t.type)))
  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true })
  console.log(`attached ${page.targetId}`)

  await send("Page.enable", {}, sessionId)
  await send("Runtime.enable", {}, sessionId)
  await send("Log.enable", {}, sessionId).catch(() => {})
  // `--cookie name=value`：给目标站点先种一个 cookie 再导航。
  // 用途（ISS-854 实测）：官方桌面端（19387）要 `dsh-auth-*` 才放行 —— 它不认 `?token=`，
  // 于是「用冷缓存的浏览器看 App 里的真实渲染」这条路必须靠种 cookie 走通。
  const COOKIE = arg("cookie", "")
  if (COOKIE) {
    const at = COOKIE.indexOf("=")
    const name = COOKIE.slice(0, at)
    const value = COOKIE.slice(at + 1)
    await send("Network.enable", {}, sessionId)
    const r = await send(
      "Network.setCookie",
      { name, value, domain: "127.0.0.1", path: "/", url: URL_.split("?")[0] },
      sessionId,
    )
    console.log(`cookie ${name} 已种：${JSON.stringify(r)}`)
  }
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false },
    sessionId,
  )
  // 主题：DSH 的 token 跟着 prefers-color-scheme 走（profile patch 里 ui-theme.preference=system），
  // 故按老板当前主题各拍一份用这个开关。
  const SCHEME = arg("color-scheme", "")
  if (SCHEME) {
    await send(
      "Emulation.setEmulatedMedia",
      { features: [{ name: "prefers-color-scheme", value: SCHEME }] },
      sessionId,
    )
  }

  await send("Page.navigate", { url: URL_ }, sessionId)
  await sleep(WAIT)

  const ready = await send(
    "Runtime.evaluate",
    { expression: "document.readyState + ' | ' + document.title + ' | ' + location.pathname", returnByValue: true },
    sessionId,
  )
  console.log("页面状态：", ready.result?.value)
  await send("Runtime.evaluate", { expression: NO_ANIM, awaitPromise: true, returnByValue: true }, sessionId).catch(() => {})

  if (PRE) {
    const code = readFileSync(PRE, "utf8")
    const r = await send("Runtime.evaluate", { expression: code, awaitPromise: true, returnByValue: true }, sessionId)
    console.log("pre 结果：", JSON.stringify(r.result?.value ?? r.result?.description ?? null))
    await sleep(POST)
  }

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId)
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, Buffer.from(shot.data, "base64"))
  console.log(`saved ${OUT}`)

  const lines = eventText()
  if (lines.length) console.log("页面报错/告警：\n" + lines.slice(-20).join("\n"))
} catch (err) {
  console.error("失败：", err && err.message)
  if (chromeStderr) console.error("chrome stderr 尾部：\n" + chromeStderr.slice(-600))
  process.exitCode = 1
} finally {
  if (!has("keep-open")) chrome.kill("SIGTERM")
}
