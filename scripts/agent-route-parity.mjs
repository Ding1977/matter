// ISS-570 P2b 闸：双前缀运行时等价性扫描（DOC-256 §7.4 #2/#4）。
//
// 为什么是运行时而不是静态：我先写过一版"扫裸标识符"的静态检查，噪音大到不能当闸
// （属性名、字符串、注释里的编号全被抓进来）。而并行窗口的真问题恰好是运行时形态——
// `AGENTS_DIR is not defined` 就是 3211 上一发 curl 抓出来的。让真 host 当裁判。
//
// 用法：node scripts/agent-route-parity.mjs [baseURL]     默认 http://127.0.0.1:3211
// 退出码：0 全等；2 有差异或有空响应（空响应的"相等"是假绿，单独判失败）。
const BASE = process.argv[2] || "http://127.0.0.1:3211"

/**
 * 每条路由怎么探：
 * - `get`：真打，逐字节比（读类，无副作用）
 * - `guard`：只发 GET 验 405/400 分支（POST 类；真发会派单/改状态/拉进程）
 * - `sse`：限时取流，比 `data:` 帧数（不断开的话会挂住）
 * ⚠️ 带副作用的入口一律不真打：`/agent/dispatch` 还没搬（P2b 后段）、
 *   `serve/warmup` 会拉起 opencode serve、`session/prompt` 会真派一单。
 */
const CASES = [
  { path: "/agent/runs", mode: "get" },
  { path: "/agent/sessions", mode: "get" },
  { path: "/agents", mode: "get" },
  { path: "/agent-models?id=__nope__", mode: "get" },
  { path: "/agent-commands?id=__nope__", mode: "get" },
  { path: "/agent-files?id=__nope__&q=x", mode: "get" },
  { path: "/agent/session/events?id=AGS-001", mode: "sse" },
  { path: "/agent/run/events?id=RUN-001", mode: "sse" },
  { path: "/agent/session/create", mode: "guard" },
  { path: "/agent/session/prompt", mode: "guard" },
  { path: "/agent/session/cancel", mode: "guard" },
  { path: "/agent/session/delete", mode: "guard" },
  { path: "/agent/run/cancel", mode: "guard" },
  { path: "/agent-ask/reply", mode: "guard" },
  { path: "/agent/serve/warmup", mode: "guard" },
]

const OLD_PREFIX = "/forge-pm"
const NEW_PREFIX = "/forge-agents"

async function grab(url, mode) {
  if (mode !== "sse") {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) })
    return `${res.status}|${(await res.text()).trim()}`
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => null)
  if (!res) return "timeout"
  const body = await res.text().catch(() => "")
  const frames = body.split("\n").filter((l) => l.startsWith("data: ")).length
  return `${res.status}|${(res.headers.get("content-type") || "")}|frames=${frames}`
}

let bad = 0
for (const c of CASES) {
  const path = c.path.split("?")[0]
  const oldUrl = `${BASE}${OLD_PREFIX}${c.path}`
  const newUrl = `${BASE}${NEW_PREFIX}${path}${c.path.includes("?") ? c.path.slice(c.path.indexOf("?")) : ""}`
  const [a, b] = [await grab(oldUrl, c.mode), await grab(newUrl, c.mode)]
  const empty = a.endsWith("|") || a === "timeout"
  const same = a === b
  if (!same || empty) {
    bad++
    console.log(`✗ ${path} [${c.mode}]${empty ? " (空响应/超时——相等也算失败)" : ""}`)
    console.log(`    旧: ${a.slice(0, 200)}`)
    console.log(`    新: ${b.slice(0, 200)}`)
  } else {
    console.log(`✓ ${path} [${c.mode}] ${a.length}B 一致`)
  }
}
console.log(bad ? `\n✗ ${bad}/${CASES.length} 条不等价` : `\n✓ ${CASES.length} 条双前缀等价`)
process.exit(bad ? 2 : 0)
