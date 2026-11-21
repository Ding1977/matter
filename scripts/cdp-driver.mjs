#!/usr/bin/env node
// cdp-driver —— DSH 页面自动化统一驱动（bash 直连 CDP，trusted input）
//
// 取代 browser/panel 工具的 agent 验证通道。能力：
//   eval <expr>                      页面内执行 JS，返回值打印
//   click <x> <y>                    真实点击（trusted mouse 事件）
//   drag <x1> <y1> <x2> <y2>         真实拖拽（分步移动，dnd-kit 兼容）
//   type <text>                      键盘输入（insertText）
//   key <Enter|Tab|Escape|...>       按键
//   screenshot [outfile]             截图（PNG base64 落盘）
//   surface list | open <id> | activate <instanceId> [sessionId] | close <instanceId> [sessionId]
//   （⚠️ 官方 tabId 每会话自增 ⇒ id 重复时必须给 sessionId，否则桥抛消歧错）
//   session show | lock <sessionId> | unlock
//
// 内置协议：
//   - 每次变更操作自动亮霓虹（setAgentNeon true）→ 结束/异常自动熄灭（用户可见 agent 在操作）
//   - --session <id>：启动即 lockSession，之后所有 surface 变更操作校验激活会话（防跨会话误伤）
//   - --port <9223>、--url <127.0.0.1:3210> 可调
//
// 用法示例：
//   node scripts/cdp-driver.mjs surface open forge.pm.linear
//   node scripts/cdp-driver.mjs eval "document.title"
//   node scripts/cdp-driver.mjs --session sess_xxx click 713 142

const args = process.argv.slice(2)
let port = "9223"
let urlMatch = "127.0.0.1:3210"
let sessionLock = null
const rest = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = args[++i]
  else if (args[i] === "--url") urlMatch = args[++i]
  else if (args[i] === "--session") sessionLock = args[++i]
  else rest.push(args[i])
}
const cmd = rest[0]

/** 进入时的原锁（退出还原用；见"为什么"注释）。 */
let prevLock = null
/** `evalRaw` 就绪标志（`die` 可能被连接阶段调用，那时它还在 TDZ ⇒ 不许碰）。 */
let evalReady = false
let lockRestored = false
/** **我们**是否真的立过锁（区别于 CLI 是否给了 `--session`：`session lock X` 子路径是用户显式立锁，与我们无关）。 */
let lockedByUs = false
const restoreLock = async () => {
  if (lockRestored) return
  lockRestored = true
  // ⚠️ 判据必须是"没记过 prevLock **且我们没立过锁**"（第六遍审查 R2-c）：用 `sessionLock` 判会让
  //    `--session X session lock Y` 这种"用户显式立锁"被自己 undo（实测锁被清掉）。
  if (!prevLock && !lockedByUs) return
  try {
    if (prevLock) await evalRaw(`window.__forgePanel.lockSession(${JSON.stringify(prevLock)})`)
    else await evalRaw("window.__forgePanel.unlockSession()")
  } catch {
    /* 还原失败不阻塞（但会打印） */
    console.error("[guard] 还原原锁失败（页面可能已刷新）")
  }
}
/** `die` 在"先还原再退出"分支里的哨兵（throw 以打断调用方，避免它继续往下跑并最终以 exit 0 收场）。 */
class DriverDie extends Error {}
const die = (msg) => {
  console.error("✗ " + msg)
  // 尽力还原原锁（第四遍审查 R2）：立过锁之后任何退出路径都不许留锁 —— 留锁会把 panel 工具的
  // 变更动作全砖死。连接阶段（evalRaw 未就绪）没有锁，直接退。
  if (evalReady && sessionLock && !lockRestored) {
    void restoreLock().finally(() => process.exit(1))
    throw new DriverDie(msg) // 打断调用方（否则它会继续执行、最后以 exit 0 收场 —— 退出码说谎，第六遍审查低项）
  }
  process.exit(1)
}

// ── 连接 ──
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null)
if (!targets) die(`CDP 端口 ${port} 不可达（Electron 壳未开？）`)
const page = targets.find((t) => t.type === "page" && t.url.includes(urlMatch))
if (!page) die(`未找到匹配 ${urlMatch} 的 page target。现有：${targets.filter((t) => t.type === "page").map((t) => t.url.slice(0, 50)).join(" | ")}`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++msgId
  pending.set(mid, resolve)
  ws.send(JSON.stringify({ id: mid, method, params }))
})
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("WS error")) })

const evalRaw = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (r.result.exceptionDetails) {
    throw new Error("页面执行异常: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || "").slice(0, 200))
  }
  return r.result.result?.value
}
evalReady = true

// ── 会话守卫 + 霓虹协议 ──
const bridgeReady = await evalRaw(`!!window.__forgePanel`)
if (!bridgeReady) die("window.__forgePanel 桥不存在（forge-ui 未构建/页面过旧），请 build:client + 刷新页面")

if (cmd === "session") {
  const sub = rest[1]
  if (sub === "show" || !sub) {
    console.log(JSON.stringify({ activeSession: await evalRaw("window.__forgePanel.activeSession()"), lock: await evalRaw("window.__forgePanel.sessionLock()") }))
  } else if (sub === "lock") {
    const sid = rest[2]
    if (!sid) die("用法: session lock <sessionId>")
    try {
      await evalRaw(`window.__forgePanel.lockSession(${JSON.stringify(sid)})`)
      console.log("✓ 已锁定会话:", sid)
    } catch (e) { die(e.message) }
  } else if (sub === "unlock") {
    await evalRaw("window.__forgePanel.unlockSession()")
    console.log("✓ 已解锁")
  } else die("未知 session 子命令: " + sub)
  // ⚠️ 还原必须在 ws.close() **之前**（第五遍审查 R2：close 之后 send() 的 promise 永不落地 ⇒
  //    "unsettled top-level await"，还原根本没跑）。
  // ⚠️ 本子路径是**用户显式立/解锁**：此前没记 prevLock 且我们没立过锁 ⇒ restoreLock 应当**早退**（别把用户的锁 undo）。
  await restoreLock()
  ws.close()
  process.exit(0)
}

if (sessionLock) {
  // ⚠️ 先记原锁（第四遍审查 R2）：此前立锁后**从不还原** ⇒ 每次带 --session 的验收都在页面里留一把
  //    跨会话死锁（lock≠在屏会话），把 panel 工具的**所有变更动作**砖死，而解锁入口当时还不可达。
  try {
    prevLock = await evalRaw("window.__forgePanel.sessionLock()")
  } catch { /* 读不到就当无锁 */ }
  try {
    await evalRaw(`window.__forgePanel.lockSession(${JSON.stringify(sessionLock)})`)
    lockedByUs = true
    console.error(`[guard] 会话锁: ${sessionLock}（退出时还原为 ${prevLock ?? "无锁"}）`)
  } catch (e) { die("会话守卫失败: " + e.message) }
}

const neonOn = async () => { await evalRaw("window.__forgePanel.setAgentNeon(true)") }
const neonOff = async () => { try { await evalRaw("window.__forgePanel.setAgentNeon(false)") } catch {} }

/** 输入类操作的会话守卫：锁定后激活会话变化（用户切走）→ 拒绝，防误伤别的会话界面。 */
const guardSession = async () => {
  if (!sessionLock) return
  const active = await evalRaw("window.__forgePanel.activeSession()")
  if (active !== sessionLock) {
    die(`会话守卫拦截：当前激活会话 "${active}" ≠ 锁定会话 "${sessionLock}"（你切走了会话；重新锁定请 session lock ${active}）`)
  }
}

// ── 输入原语 ──
const click = async (x, y) => {
  await guardSession()
  await neonOn()
  try {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  } finally { await neonOff() }
}

const drag = async (x1, y1, x2, y2, steps = 10) => {
  await guardSession()
  await neonOn()
  try {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, buttons: 1 })
      await new Promise((r) => setTimeout(r, 30))
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 })
  } finally { await neonOff() }
}

// ── 命令分发 ──
try {
  switch (cmd) {
    case "eval": {
      const expr = rest.slice(1).join(" ")
      if (!expr) die("用法: eval '<js expression>'")
      const v = await evalRaw(expr)
      console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2))
      break
    }
    case "click": {
      const [x, y] = [Number(rest[1]), Number(rest[2])]
      if (Number.isNaN(x) || Number.isNaN(y)) die("用法: click <x> <y>")
      await click(x, y)
      console.log(`✓ clicked (${x}, ${y})`)
      break
    }
    case "drag": {
      const [x1, y1, x2, y2] = rest.slice(1, 5).map(Number)
      if ([x1, y1, x2, y2].some(Number.isNaN)) die("用法: drag <x1> <y1> <x2> <y2>")
      await drag(x1, y1, x2, y2)
      console.log(`✓ dragged (${x1},${y1}) → (${x2},${y2})`)
      break
    }
    case "type": {
      const text = rest.slice(1).join(" ")
      if (!text) die("用法: type <text>")
      await guardSession()
      await neonOn()
      try { await send("Input.insertText", { text }) } finally { await neonOff() }
      console.log(`✓ typed "${text}"`)
      break
    }
    case "key": {
      const key = rest[1]
      if (!key) die("用法: key <Enter|Tab|Escape|ArrowDown|...>")
      await guardSession()
      await neonOn()
      try {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: 0 })
        await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: 0 })
      } finally { await neonOff() }
      console.log(`✓ key ${key}`)
      break
    }
    case "screenshot": {
      const out = rest[1] || `cdp-shot-${Date.now()}.png`
      await neonOn()
      try {
        const shot = await send("Page.captureScreenshot", { format: "png" })
        const data = shot.result?.data
        if (!data) die("截图失败: " + JSON.stringify(shot).slice(0, 120))
        const { writeFileSync } = await import("node:fs")
        writeFileSync(out, Buffer.from(data, "base64"))
      } finally { await neonOff() }
      console.log("✓ screenshot →", out)
      break
    }
    case "surface": {
      const sub = rest[1]
      if (sub === "list" || !sub) {
        console.log(JSON.stringify(await evalRaw("window.__forgePanel.listTabs()"), null, 2))
      } else if (sub === "open") {
        const sid = rest[2]
        if (!sid) die("用法: surface open <surfaceId>")
        await neonOn()
        let r
        try { r = await evalRaw(`window.__forgePanel.open(${JSON.stringify(sid)})`) }
        finally { await neonOff() }
        console.log(`✓ surface ${sid} → instance=${r.instanceId} ${r.created ? "(新建)" : "(激活)"}`)
      } else if (sub === "activate") {
        const iid = rest[2]
        const sid = rest[3] // 可选：官方 tabId 每会话自增，id 重复时必须给
        if (!iid) die("用法: surface activate <instanceId> [sessionId]")
        await neonOn()
        try {
          const call = sid ? `${JSON.stringify(iid)}, ${JSON.stringify(sid)}` : JSON.stringify(iid)
          const ok = await evalRaw(`window.__forgePanel.activate(${call})`)
          console.log(ok ? `✓ activated ${iid}` : `✗ 未找到 ${iid}`)
        } finally { await neonOff() }
      } else if (sub === "close") {
        const iid = rest[2]
        const sid = rest[3] // 可选：同上
        if (!iid) die("用法: surface close <instanceId> [sessionId]")
        await neonOn()
        try {
          const call = sid ? `${JSON.stringify(iid)}, ${JSON.stringify(sid)}` : JSON.stringify(iid)
          const ok = await evalRaw(`window.__forgePanel.close(${call})`)
          console.log(ok ? `✓ closed ${iid}` : `✗ 未找到 ${iid}`)
        } finally { await neonOff() }
      } else die("未知 surface 子命令: " + sub)
      break
    }
    default:
      die(`未知命令: ${cmd}\n可用: eval | click | drag | type | key | screenshot | surface(list/open/activate/close) | session(show/lock/unlock)\n选项: --port 9223 | --url 127.0.0.1:3210 | --session <sessionId>`)
  }
} catch (e) {
  await neonOff().catch(() => {})
  if (e instanceof DriverDie) process.exit(1) // 已排好"还原后退出" ⇒ 这里只需静默收场（去掉栈噪声）
  die(e.message)
}

// ⚠️ 还原**必须在 ws.close() 之前**（第五遍审查 R2 实机复现：close 之后 send() 的 promise 永不落地，
//    症状是 "unsettled top-level await" + 锁残留）。此前这里原本就有一句 ws.close() 在还原之前。
await restoreLock()
ws.close()
process.exit(0)
