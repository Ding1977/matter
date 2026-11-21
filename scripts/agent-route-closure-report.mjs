// ISS-570 P2a-2 的前置勘察：agent 路由的 handler 体**依赖了哪些 PM 侧标识符**。
//
// ⚠️ **口径已随迁移收口变化**（ISS-576 批次修正，别再照旧标题读）：脚本诞生时扫的是
//    **17 条**待搬路由（handler 约 535 行）；P2b-2 之后这些 handler 都已搬进 forge-agents，
//    PM 侧只剩**刻意自留**的两条 —— `/forge-pm/agent/dispatch` 与 `/forge-pm/agents/profile`
//    （判据见 DOC-256 §7.3：它们要读 issue 里程碑/写委派/读成员档案，属 Matter 编排脸）。
//    所以它现在输出的"未解析标识符"是**正常状态**（那些函数本来就长在 PM 侧），
//    不是"还有待处置的搬漏项"。将来若要搬那两条，这份清单才是要读的东西。
//
// 为什么先要这份报告再动手摘：源在 6,259 行的 index.js 里，handler 合计约 535 行。
// 摘出时每条都要问「它在闭包里调的这个函数归谁」——按 DOC-256 §7.2 的三类处置：
//   ① agent 域自己的 → 随迁（多数在 dispatch/run-manager/agent-session 里，P2a-1 已经搬进包）
//   ② PM 语义（写 issue 活动日志、读 issue 正文）→ 走注册点（线 #2 那条路子）
//   ③ 纯 HTTP plumbing（json/readBody/parseQuery）→ 本包 lib/http.js 已自带
// 没有这份清单就是边摘边猜，猜到一半才发现某条路由拖着一整段 PM 逻辑。
// 用法：node scripts/agent-route-closure-report.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const AG_LIB = join(ROOT, "forge-agents", "lib")

const lines = readFileSync(join(ROOT, "forge-pm", "lib", "index.js"), "utf8").split("\n")

/** 每条 agent 路由 → 它所属的 `ctx.effect(() => ws.register({…}))` 整块文本。 */
function findBlocks() {
  const out = []
  lines.forEach((l, i) => {
    const m = /path: "(\/forge-pm\/agent[^"]*)"/.exec(l)
    if (!m) return
    let start = i
    while (start > 0 && !lines[start].includes("ctx.effect(")) start--
    let depth = 0
    let seen = false
    let end = lines.length - 1
    for (let k = start; k < lines.length; k++) {
      for (const ch of lines[k]) {
        if (ch === "(") { depth++; seen = true }
        else if (ch === ")") depth--
      }
      if (seen && depth <= 0) { end = k; break }
    }
    const prev = lines[start - 1] || ""
    out.push({ path: m[1], line: i + 1, size: end - start + 1, commented: /^\s*\/\//.test(prev), text: lines.slice(start, end + 1).join("\n") })
  })
  return out
}

/** 本包（forge-agents/lib）所有可 import 的导出名。 */
function pkgExports() {
  const set = new Set()
  for (const f of readdirSync(AG_LIB)) {
    if (!f.endsWith(".js") || f.endsWith(".test.js")) continue
    for (const m of readFileSync(join(AG_LIB, f), "utf8").matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)) set.add(m[1])
  }
  return set
}

const BUILTIN = new Set(["json", "read", "join", "map", "filter", "sort", "split", "slice", "push", "parse", "stringify", "warn", "log", "error", "catch", "then", "fetch", "resolve", "reject", "require", "setTimeout", "clearTimeout", "setInterval", "parseInt", "parseFloat", "isNaN", "encodeURIComponent", "decodeURIComponent", "structuredClone", "register", "handler"])
const KEYWORDISH = new Set(["async", "await", "if", "for", "while", "switch", "catch", "return", "typeof", "function", "await", "new", "else", "try", "do", "void", "delete", "in", "of"])

const exportsHere = existsSync(AG_LIB) ? pkgExports() : new Set()
const blocks = findBlocks()
const owners = new Map()

for (const b of blocks) {
  const declared = new Set([...b.text.matchAll(/\b(?:const|let|var|function)\s+(\w+)/g)].map((m) => m[1]))
  for (const m of b.text.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_]{2,})\s*\(/g)) {
    const name = m[1]
    if (declared.has(name) || exportsHere.has(name) || BUILTIN.has(name) || KEYWORDISH.has(name)) continue
    const e = owners.get(name) || { paths: new Set(), n: 0 }
    e.paths.add(b.path)
    e.n++
    owners.set(name, e)
  }
}

console.log(`路由块 ${blocks.length} 条 / handler 合计 ${blocks.reduce((s, b) => s + b.size, 0)} 行`)
console.log(`本包可用导出 ${exportsHere.size} 个\n`)
// ⚠️ 口径已随迁移收口变化（ISS-576 批次修正）：本脚本诞生于 P2a-2，当时扫的是 **17 条**待搬路由；
//    P2b-2 之后这些 handler 都已搬到 forge-agents，PM 侧只剩**刻意自留**的两条
//    （`/forge-pm/agent/dispatch` 与 `/forge-pm/agents/profile`，见 DOC-256 §7.3 的判据）。
//    所以下面这些"未解析标识符"现在是**正常状态** —— 它们本来就长在 PM 侧（写 issue 活动日志、
//    读成员档案），不是"还有待处置的搬漏项"。若将来真要搬这两条，这份清单才是要读的东西。
console.log("PM 自留路由的外部依赖（**正常**：这两条刻意留在 PM，下列依赖本就在 PM 侧）：")
for (const [name, v] of [...owners.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${name}  调用 ${v.n} 次 · 出现在 ${[...v.paths].length} 条路由`)
}
