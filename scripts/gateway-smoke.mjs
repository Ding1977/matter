#!/usr/bin/env node
/**
 * 网关冒烟检查（ISS-397 · DOC-220 的 T7 验收补）
 *
 * 一条命令判定「网关 + 流式」是否健康，把三件容易被后人改坏的隐式前提变成可复验断言：
 *   ① 鉴权：无 key 必须 401（防"吊销最后一把 → 回落放行"那类退化）
 *   ② 清单口径：id 全为命名空间形式、name 为「供应商/模型」、不含镜像自身的自我引用条目
 *   ③ 流式：**无 content-encoding**（未被压缩/缓冲）、chunked、多块逐块到达
 *   ④ 严格 SSE 解析（只按空行派发事件、流结束时未闭合事件按规范丢弃 = DSH 的消费方式）
 *      能收到含 finish_reason 的事件与 [DONE]  —— 这一条曾因转发吞空行而整链失败（ISS-394）
 *
 * 为什么值得固化成脚本：DSH 的 gzip 中间件 filter 目前结构化排除了 text/event-stream
 * （packages/host/webserver/src/index.ts:96），webserver 的 compression 默认也是 none ——
 * 但这两条都是**默认值/实现细节**，一旦有人为省流量开 gzip 或换 server 实现，
 * 流式会被静默缓冲（症状是"卡住不动/首字极慢"），极难排查。跑一下这个脚本即可判定。
 *
 * 用法：
 *   node scripts/gateway-smoke.mjs                      # 默认 3210 + 自动挑模型
 *   node scripts/gateway-smoke.mjs --port 3211          # 隔离验证实例
 *   node scripts/gateway-smoke.mjs --model <网关模型 id> # 指定模型（默认优先 *flash）
 *   node scripts/gateway-smoke.mjs --quiet              # 只输出结论
 *
 * key 来源：环境变量 FORGE_GATEWAY_KEY，否则读 $DSH_HOME/.forge-gateway-keys.json 的
 * 第一把**未吊销** key（脚本不打印 key 本身）。
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const argv = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PORT = argOf("--port", process.env.DSH_PORT || "3210")
const QUIET = argv.includes("--quiet")
const BASE = `http://127.0.0.1:${PORT}`
const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh")

const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  if (!QUIET) console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`)
}

const readKey = () => {
  if (process.env.FORGE_GATEWAY_KEY) return process.env.FORGE_GATEWAY_KEY.trim()
  try {
    const store = JSON.parse(readFileSync(join(DSH_HOME, ".forge-gateway-keys.json"), "utf8"))
    const live = (store.keys || []).filter((k) => !k.revokedAt)
    return live.length ? live[0].key : null
  } catch {
    return null
  }
}

/** 严格 SSE 解析：只有空行才把累积的 data 行派发成一个事件（DSH 的消费方式） */
const strictSse = (text) => {
  const events = []
  let dataLines = []
  let droppedPending = false
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line === "") {
      if (dataLines.length) events.push(dataLines.join("\n"))
      dataLines = []
      continue
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
  }
  if (dataLines.length) droppedPending = true
  return { events, droppedPending }
}

const key = readKey()

// ① 鉴权语义：无 key → 401
{
  const r = await fetch(`${BASE}/forge-plans/v1/models`)
  check("无 key 读清单被拒（401）", r.status === 401, `HTTP ${r.status}`)
}

if (!key) {
  check("找到可用虚拟 key", false, `未找到：请签发 POST /forge-plans/gateway/keys 或设 FORGE_GATEWAY_KEY`)
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过`)
  process.exit(1)
}
const auth = { Authorization: `Bearer ${key}` }

// ② 清单口径
let models = []
{
  const r = await fetch(`${BASE}/forge-plans/v1/models`, { headers: auth })
  const j = await r.json().catch(() => ({}))
  models = j.data || []
  check("带 key 读清单 200", r.status === 200, `HTTP ${r.status}，${models.length} 条`)
  const badNs = models.filter((m) => !String(m.id).includes("/") || typeof m.provider !== "string")
  check("id 全为命名空间形式且带 provider 字段", badNs.length === 0, badNs.length ? `${badNs.length} 条违规` : `${models.length}/${models.length}`)
  const badName = models.filter((m) => !String(m.name || "").includes("/"))
  check(
    "name 为「供应商/模型」口径",
    models.length > 0 && badName.length === 0,
    badName.length ? `${badName.length} 条缺供应商前缀，例：${JSON.stringify(badName[0].name)}` : "全部带前缀",
  )
  const self = models.filter((m) => String(m.id).startsWith("forge-gateway/"))
  check("不含镜像自身的自我引用条目", self.length === 0, self.length ? `${self.length} 条` : "0 条")
}

// 选模型：优先 *flash（便宜快），否则取清单第一条
const preferred = argOf("--model", null)
const model =
  preferred ||
  models.find((m) => /flash/i.test(m.id))?.id ||
  models[0]?.id
check("选中一个可测模型", Boolean(model), model || "(清单为空)")

if (model) {
  // ③ 非流式
  {
    const r = await fetch(`${BASE}/forge-plans/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "只回两个字：收到" }], stream: false, max_tokens: 16 }),
    })
    const ok = r.status === 200
    check("非流式 chat 200", ok, `HTTP ${r.status}${ok ? "" : " " + (await r.text()).slice(0, 80)}`)
  }

  // ④+⑤ 流式：未压缩 + 逐块到达 + 严格解析有 finish_reason
  {
    const t0 = Date.now()
    const r = await fetch(`${BASE}/forge-plans/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        // 主动索要压缩：若将来有人把 compression 打开且中间件不再排除 SSE，这里会立刻暴露
        "Accept-Encoding": "gzip, deflate, br",
        ...auth,
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "从1数到20" }], stream: true }),
    })
    const enc = r.headers.get("content-encoding")
    check("流式响应未被压缩（无 content-encoding）", !enc, enc ? `content-encoding: ${enc} ← SSE 会被缓冲！` : "无")
    check("流式响应为 chunked（长度未知、可增量推送）", (r.headers.get("transfer-encoding") || "").includes("chunked"), r.headers.get("transfer-encoding") || "(无)")

    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let text = ""
    let chunks = 0
    let first = null
    let last = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks++
      const now = Date.now() - t0
      if (first === null) first = now
      last = now
      text += dec.decode(value, { stream: true })
    }
    check("多块到达", chunks >= 3, `${chunks} 块`)
    check(
      "逐块到达（首块与末块有间隔，非整体缓冲）",
      first !== null && last !== null && last - first > 100,
      `首块 ${first}ms / 末块 ${last}ms / 间隔 ${first === null ? "-" : last - first}ms`,
    )

    const { events, droppedPending } = strictSse(text)
    let fin = null
    let doneSeen = false
    for (const e of events) {
      if (e.trim() === "[DONE]") {
        doneSeen = true
        continue
      }
      let j = null
      try {
        j = JSON.parse(e)
      } catch {
        continue
      }
      const ch = j.choices && j.choices[0]
      if (ch && ch.finish_reason) fin = ch.finish_reason
    }
    check("严格 SSE 解析能收到 finish_reason", Boolean(fin), fin ? `"${fin}"` : "缺失（转发吞空行会致此，见 ISS-394）")
    check("严格 SSE 解析能收到 [DONE]", doneSeen, doneSeen ? "✓" : "缺失")
    check("流结束时没有未闭合事件被丢弃", !droppedPending, droppedPending ? "有 ← 事件分隔符可能被吞" : "无")
  }
}

const failed = results.filter((r) => !r.ok)
if (QUIET) for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok || !r.detail ? "" : " — " + r.detail}`)
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? "，失败：" + failed.map((f) => f.name).join("；") : ""}`)
process.exit(failed.length ? 1 : 0)
