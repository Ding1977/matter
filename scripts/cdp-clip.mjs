#!/usr/bin/env node
// clip 截图：截取指定逻辑坐标区域（用于验证浮层真实渲染像素）
// 用法: node scripts/cdp-clip.mjs <x> <y> <w> <h> <outfile>
const [x, y, w, h, out] = process.argv.slice(2)
const targets = await fetch("http://127.0.0.1:9223/json").then((r) => r.json())
const page = targets.find((t) => t.type === "page" && t.url.includes("127.0.0.1:3210"))
if (!page) { console.error("no page target"); process.exit(1) }
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
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })

const shot = await send("Page.captureScreenshot", {
  format: "png",
  clip: { x: Number(x), y: Number(y), width: Number(w), height: Number(h), scale: 1 },
  captureBeyondViewport: false,
})
const { writeFileSync } = await import("node:fs")
writeFileSync(out, Buffer.from(shot.result.data, "base64"))
console.log("✓ clip shot →", out)
process.exit(0)
