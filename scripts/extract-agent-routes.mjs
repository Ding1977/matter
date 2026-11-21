// ISS-570 P2a-2：把 agent 路由从 forge-pm/lib/index.js **机械摘出**，生成 forge-agents/lib/routes.js。
//
// 为什么必须脚本化而不是手抄：单条 handler 最长 163 行，15 条合计约 500 行；手抄漏一个
//   `}` 或改一个变量名，症状是线上某条路由 500，而且并行窗口里 PM 侧那份还是好的——最难查。
//   所以 routes.js 和模块副本一样是**推导产物**：`--check` 重算并比对，改了 PM 侧而这里没跟上
//   当场报差异。唯一允许的改写 = 路由前缀（连注释里的指路文字一起，否则 ⓪b 的残留扫描会假红）。
//
// 用法：
//   node scripts/extract-agent-routes.mjs            打印将要生成什么（不写盘）
//   node scripts/extract-agent-routes.mjs --write    生成 forge-agents/lib/routes.js
//   node scripts/extract-agent-routes.mjs --check    重算并与现有文件比对（不一致 exit 2）
//
// ⚠️ 不摘 steer：PM 侧那条缺 `path`（ISS-569），并行的新前缀里补一条能用的会让两边 diff
//    出现「无法解释的增量」。修复留在 ISS-569。
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const PM_INDEX = join(ROOT, "forge-pm", "lib", "index.js")
const OUT = join(ROOT, "forge-agents", "lib", "routes.js")

/**
 * 本批摘出的路由。准入判据只有一条：**依赖的函数是否已全部在本包内**。
 * 不在名单里的：
 *   `/forge-pm/agents/profile` → 依赖 `ensureAgentProfile`（在 member-registry.js，PM 成员域，留 PM）
 *   `/forge-pm/agent/dispatch` → 写 issue 活动日志（resolveIssueRel/noteRunActivity/writeAgentDelegate），
 *     要等「派单后钩子」在 PM 侧注册，与 P2b 同批
 *   `/forge-pm/agent/steer` → PM 侧根本没生效（ISS-569）
 */
const PATHS = [
  "/forge-pm/agent/runs",
  "/forge-pm/agent/run/cancel",
  "/forge-pm/agent-ask/reply",
  "/forge-pm/agent/run/events",
  "/forge-pm/agents",
  "/forge-pm/agent-commands",
  "/forge-pm/agent-files",
  "/forge-pm/agent/serve/warmup",
  "/forge-pm/agent-models",
]

/**
 * **本包自有**的路由（不是从 PM 摘出来的）：引擎侧会话清单（ISS-622/624）——它查的是
 * CLI 自己家的历史会话（ACP session/list / opencode GET /session），PM 侧从来没有这条。
 * 为什么单列：下面的结构自检要按「清单里的条数 = routes.js 里双前缀循环数」判，
 * 混进 PATHS 会让清单谎报出处；不列进来又会恒报「循环数不符」——
 * 实测该自检**在本次改动前就已经是红的**（16 循环 vs 15 清单，缺的就是这条），
 * 归位后它才真的能当守卫用。
 */
const OWN_PATHS = ["/forge-pm/agent-sessions"]

/** 生成文件的顶层 imports：全部指向本包模块（零 forge-pm import 是 §九 的硬验收）。 */
const IMPORTS = `import { execFile, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { json, parseQuery, readBody } from "./http.js"
import { listRuns, readRun, readRunMeta, RUNS_DIR, subscribe } from "./run-manager.js"
import { activeRuns, cancelRun, concurrencySnapshot, resolveAgentAsk } from "./dispatch.js"
// ISS-652（老板点选 C）：AGS 会话层的 6 条路由（sessions / session/create|prompt|cancel|delete|events）
// 已随「派单 = 开 CLI-provider DSH 会话」整体退役，故上面的 PATHS 与这里的 import 同步删掉。
// ⚠️ 本脚本已进入"窗口关闭"态（不再生成 routes.js，只做结构自检 --check）；
// 删清单的意义正在于此：**自检的口径必须跟着退役走**，否则它会为已删的路由报「少了一条」。
import { AGENTS_DIR, listAgentsWithHealth } from "./agent-registry.js"
import { ensureServe, OC_HOST, ocCommands, ocFindFiles } from "./opencode-http.js"
import { parseCopilotModelSection, runCopilotHelpConfig } from "./copilot-model-list.js"
import { resolveWorkbuddyCatalog } from "./workbuddy-model-list.js"
import { modelListCache, sortEfforts } from "./model-catalog.js"
`

// 迁移期双前缀。为什么要两条而不是"摘 PM 与切前端同批做"：
//   那会把两件事绑成一个不可回滚的大提交（host 所有权 + 前端 89 处 URL + exports）。
//   旧前缀由本包继续服务，PM 摘除与前端切换就各自独立可回滚，P2b 最后一步再删这条别名。
const ROUTE_BASES_COMMENT = `
/** 迁移期双前缀：新前缀是归属，旧前缀是给还没切走的前端兜底（P2b 末段删除）。 */
const ROUTE_BASES = ["/forge-agents", "/forge-pm"]
`

const HEADER = `// ⚠️ **推导产物，别手改**：由 scripts/extract-agent-routes.mjs 从 forge-pm/lib/index.js 机械摘出，
//    唯一改写 = 路由前缀（含注释里的指路文字）。要改逻辑请先改 PM 侧再 \`--write\` 重生成；
//    \`--check\` 会在两边不一致时报差异。ISS-570 P2a-2：并行窗口里新旧前缀同体。
// ⚠️ 只注册 HTTP 路由。模型工具与 UI slot 是全局唯一名，两处同注册会撞名（agent_list ×2），
//    它们必须与 PM 侧删除同批换（P2b）。
// ⚠️ host 侧 .js —— 严禁 TS 类型注解（ISS-190）。
`

const text = readFileSync(PM_INDEX, "utf8")
const lines = text.split("\n")

/**
 * 并行窗口的三种状态（判据 = PM 库里这 15 条 handler 还在不在）。
 * 为什么要把状态做成一等的：`--strip-pm` 跑完后 PM 里就没有原件了，此时逐字节比对
 *   既不可能也不该被误读成「路由丢了」——但**放任它崩**更糟：那等于这份守卫从此没人能跑，
 *   而生成物 routes.js 恰恰是越到后期越需要有人盯的东西（谁都想顺手改一行 handler）。
 *   半摘（1..14 条）则是真事故信号：删除要么整体做要么不做，绝不会剩一半。
 */
const stillInPm = PATHS.filter((p) => lines.some((l) => l.includes(`path: "${p}"`)))
const WINDOW = stillInPm.length === PATHS.length ? "open" : stillInPm.length === 0 ? "closed" : "partial"
if (WINDOW === "partial") {
  console.error(`✗ PM 侧只剩 ${stillInPm.length}/${PATHS.length} 条 agent 路由（半摘状态）`)
  console.error(`  缺：${PATHS.filter((p) => !stillInPm.includes(p)).join(" ")}`)
  console.error("  ⇒ 要么重跑 --strip-pm 前先恢复，要么手工把剩下的删干净；本工具拒绝在半摘状态下比对。")
  process.exit(2)
}

/** 定位 path 行所属的 `ctx.effect(() => ws.register({…}))` 整块（含其上方的紧邻注释行）。 */
function findBlock(path) {
  const at = lines.findIndex((l) => l.includes(`path: "${path}"`))
  if (at === -1) throw new Error(`找不到路由：${path}`)
  let effect = at
  while (effect > 0 && !lines[effect].includes("ctx.effect(")) effect--
  // 上方的紧邻注释也搬（那是 handler 的用法说明），但**括号配平必须从 ctx.effect 那行数起**：
  // 注释里常有不成对的括号（`（ISS-324 修复 2）` 之类），从注释行开始数会让计数器
  // 直接跑到负数、第一行就"配平"，摘出来的块里连 ws.register 都没有（实测踩中）。
  let start = effect
  let c = effect - 1
  while (c >= 0 && /^\s*\/\//.test(lines[c])) { start = c; c-- }
  let depth = 0
  let seen = false
  for (let k = effect; k < lines.length; k++) {
    // 只在**去掉行注释之后**的那份文本上数括号：PM 的注释里有列表符号 `// 2) 订阅新事件`，
    // 那个孤零零的 `)` 会把计数器打成 0，于是块在注释行就被判"配平"、摘出半条路由
    // （实测 /agent/run/events 正是这样断的，靠上面的闭合自检才没溜出去）。
    const code = lines[k].replace(/\/\/[^\n]*/, "")
    for (const ch of code) {
      if (ch === "(") { depth++; seen = true }
      else if (ch === ")") depth--
    }
    if (seen && depth <= 0) {
      const body = lines.slice(start, k + 1).join("\n")
      if (!body.includes("ws.register(")) throw new Error(`${path}：块里没有 ws.register，定位跑偏了`)
      // **自我校验**：摘出来的块必须自身闭合。不闭合就当场报，别让半条路由进 routes.js
      //（症状是 node --check 只说 "Unexpected end of input"，546 行里根本找不到丢在哪）。
      // 校验也用**去注释**的那份：handler 上方常有 `// 1) … // 2) …` 这种列表符号，
      // 拿原文数会平白多出孤立的 `)`（上一版就是这样误判 good block 为未闭合）。
      const plain = body.replace(/\/\/[^\n]*/g, "")
      const bal = (a, b) => (plain.split(a).length - 1) - (plain.split(b).length - 1)
      if (bal("{", "}") !== 0 || bal("(", ")") !== 0) {
        throw new Error(`${path}：第 ${k + 1} 行处块未闭合（花括号 ${bal("{", "}")} / 圆括号 ${bal("(", ")")}）` +
          `\n  末行: ${lines[k].trim()}\n  ⇒ 括号扫描被字符串或注释里的括号骗到了，先修扫描再摘。`)
      }
      return body
    }
  }
  throw new Error(`${path}：括号没配平`)
}

function rewrite(block) {
  return block
    .replace(/\/forge-pm\/agents/g, "/forge-agents/agents")
    .replace(/\/forge-pm\/agent/g, "/forge-agents/agent")
}

const blocks = WINDOW === "open" ? PATHS.map((p) => ({ p, body: rewrite(findBlock(p)) })) : []
function toDualPrefix(body) {
  return body
    .replace(/ctx\.effect\(\(\) =>/g, "for (const base of ROUTE_BASES) ctx.effect(() =>")
    .replace(/path: "\/forge-agents([^"]*)"/g, (_m, rest) => `path: base + ${JSON.stringify(rest)}`)
}

// 窗口关闭后没有原件可抄，也就**不能**再"生成"：此时唯一合法的产物改动方式是
// 显式 `--regen-from-git`（还没做，需要时再说），否则谁都能拿一份手写 routes.js 冒充生成物。
const generated = WINDOW === "open"
  ? `${HEADER}${IMPORTS}\n${ROUTE_BASES_COMMENT}\nexport function registerAgentRoutes(ctx, ws) {\n${blocks.map((b) => toDualPrefix(b.body)).join("\n\n")}\n}\n`
  : null
const summary = `${blocks.length} 条 / ${String(generated || "").split("\n").length} 行`

if (process.argv.includes("--deps")) {
  if (WINDOW !== "open") { console.error("✗ PM 侧原件已摘除，--deps 依赖窗口内的那份源码"); process.exit(2) }
  // 生成前先答一个问题：这些 handler 调到的名字里，哪些既不在块内声明、也不在本包导出里？
  // 抄错 import 列表的症状是运行时 ReferenceError（某条路由 500），所以这份清单就是 import 的依据。
  const { readdirSync } = await import("node:fs")
  const AG_LIB = join(ROOT, "forge-agents", "lib")
  const avail = new Set()
  for (const f of readdirSync(AG_LIB)) {
    if (!f.endsWith(".js") || f.endsWith(".test.js")) continue
    for (const m of readFileSync(join(AG_LIB, f), "utf8").matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)) avail.add(m[1])
  }
  const need = new Map()
  for (const b of blocks) {
    const declared = new Set([...b.body.matchAll(/\b(?:const|let|var|function)\s+(\w+)/g)].map((m) => m[1]))
    for (const m of b.body.matchAll(/(?<![.\w$])([a-zA-Z][A-Za-z0-9_]{2,})\s*\(/g)) {
      const n = m[1]
      if (declared.has(n) || avail.has(n)) continue
      if (/^(if|for|while|switch|catch|return|typeof|function|await|new|else|try|do|void|JSON|Object|Array|Number|String|Promise|Map|Set|Boolean|Math|Error|parseInt|parseFloat|setTimeout|setInterval|clearInterval|clearTimeout|encodeURIComponent|decodeURIComponent|fetch|process|require)$/.test(n)) continue
      const e = need.get(n) || new Set()
      e.add(b.p)
      need.set(n, e)
    }
  }
  console.log("本包没有出处、必须由 import 或随迁提供的标识符：")
  for (const [n, ps] of [...need.entries()].sort()) console.log(`  ${n}  ← ${[...ps].join(" ")}`)
  process.exit(0)
}

/**
 * `--strip-pm`：把 PM 的这 15 条注册块机械删除（P2b 所有权移交；AGS 6 条已于 ISS-652 退役，现余 9 条）。
 * 为什么必须脚本化：手工在 6,259 行里删 584 行，删多一行少一行都是"某条路由悄悄没了"，
 * 而那正是并行窗口花这么多力气要避免的事故形态。删之前先确认每条都能定位，
 * 少一条就整体不动（不做半拉子删除）。
 */
function stripPm() {
  const spans = []
  for (const path of PATHS) {
    const at = lines.findIndex((l) => l.includes(`path: "${path}"`))
    if (at === -1) { console.error(`✗ 找不到 ${path}——PM 侧可能已被删过或改过，先别删`); process.exit(2) }
    let effect = at
    while (effect > 0 && !lines[effect].includes("ctx.effect(")) effect--
    let start = effect
    let c = effect - 1
    while (c >= 0 && /^\s*\/\//.test(lines[c])) { start = c; c-- }
    let depth = 0
    let seen = false
    let end = -1
    for (let k = effect; k < lines.length; k++) {
      for (const ch of lines[k].replace(/\/\/[^\n]*/, "")) {
        if (ch === "(") { depth++; seen = true } else if (ch === ")") depth--
      }
      if (seen && depth <= 0) { end = k; break }
    }
    if (end === -1) { console.error(`✗ ${path} 括号没配平，放弃全部删除`); process.exit(2) }
    spans.push([start, end])
  }
  // 从后往前删，前面的行号才不会失效；尾随空行一起吃掉保持排版
  spans.sort((a, b) => b[0] - a[0])
  let removed = 0
  const out = [...lines]
  for (const [start, end] of spans) {
    let stop = end
    while (stop + 1 < out.length && out[stop + 1].trim() === "") stop++
    out.splice(start, stop - start + 1)
    removed += stop - start + 1
  }
  writeFileSync(PM_INDEX, out.join("\n"))
  console.log(`✓ 已从 forge-pm/lib/index.js 删除 agent 路由块（共 ${removed} 行，文件 ${lines.length} → ${out.length} 行）`)
  console.log("  ⚠️ 旧前缀由 forge-agents 继续服务（ROUTE_BASES），前端切换是独立一步；删完请跑：")
  console.log("    node scripts/extract-agent-routes.mjs --write && node scripts/agent-route-parity.mjs")
}
if (process.argv.includes("--strip-pm")) { stripPm(); process.exit(0) }

/**
 * 窗口关闭后的替代判据：routes.js 的**结构自检**（每条 PATHS 恰好一次循环注册、前缀表没被改单）。
 * 内容等价性这时改由两道更硬的判据兜：注册面单测（routes.test.js 逐条清单 + 前缀配对）
 * 与真机比对（agent-route-parity.mjs 两前缀逐字段等响应）。
 * 本自检盯的是结构可见的那类回归：有人删了一条路由、把 ROUTE_BASES 改成单前缀、
 * 或绕过 PATHS 清单手工加了一条——这三种在源码 diff 里都可能被当成"顺手清理"。
 */
function checkStructure() {
  const cur = readFileSync(OUT, "utf8")
  const problems = []
  const ALL_PATHS = [...PATHS, ...OWN_PATHS]
  const loops = cur.split("for (const base of ROUTE_BASES) ctx.effect(() =>").length - 1
  if (loops !== ALL_PATHS.length) problems.push(`循环注册 ${loops} 处，应为 ${ALL_PATHS.length} 处（摘出 ${PATHS.length} + 自有 ${OWN_PATHS.length}）`)
    const suffixes = [...cur.matchAll(/path:\s+base\s*\+\s*("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]))
  for (const p of ALL_PATHS) {
    const suffix = p.replace(/^\/forge-pm/, "")
    const n = suffixes.filter((x) => x === suffix).length
    if (n !== 1) problems.push(`${p}：routes.js 里 ${n} 次（应为 1 次双前缀循环）`)
  }
  for (const x of suffixes) {
    if (!ALL_PATHS.some((p) => p.replace(/^\/forge-pm/, "") === x)) problems.push(`routes.js 有清单外的路径 ${x}（先加进 PATHS/OWN_PATHS 再重生成）`)
  }
  if (!/const ROUTE_BASES = \["\/forge-agents", "\/forge-pm"\]/.test(cur)) {
    problems.push('ROUTE_BASES 不再是 ["/forge-agents", "/forge-pm"] —— 旧前缀断供了？')
  }
  if (problems.length) {
    console.error(`✗ 窗口已关（PM 侧原件已摘），routes.js 结构自检 ${problems.length} 处不过：`)
    for (const x of problems) console.error(`  · ${x}`)
    console.error("  ⇒ 并行窗口关了就别改这里：改逻辑去 forge-agents/lib/routes.js 并跑 agent-route-parity")
    process.exit(2)
  }
  console.log(`✓ 窗口已关：routes.js 结构自检通过（${PATHS.length} 条 × 双前缀；内容等价由单测 + 真机比对兜）`)
}

if (process.argv.includes("--write")) {
  if (WINDOW !== "open") { console.error("✗ PM 侧原件已摘除，无原件可抄（此时改 routes.js 请直接改并跑 --check + parity）"); process.exit(2) }
  writeFileSync(OUT, generated)
  console.log(`✓ 已生成 forge-agents/lib/routes.js（${summary}）`)
} else if (process.argv.includes("--check")) {
  if (!existsSync(OUT)) { console.error("✗ routes.js 不存在，先 --write"); process.exit(2) }
  if (WINDOW !== "open") { checkStructure(); process.exit(0) }
  const cur = readFileSync(OUT, "utf8")
  if (cur === generated) { console.log(`✓ 路由保真：routes.js == PM 原件 + 前缀改写（${summary}）`); process.exit(0) }
  const a = generated.split("\n")
  const b = cur.split("\n")
  let i = 0
  while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++
  console.error(`✗ 路由与「PM 原件 + 前缀改写」不一致，第 ${i + 1} 行起：`)
  console.error(`  期望: ${String(a[i]).trim()}`)
  console.error(`  实际: ${String(b[i]).trim()}`)
  console.error(`  （PM 侧改了 handler 而这里没重生成？跑 --write）`)
  process.exit(2)
} else if (WINDOW !== "open") {
  console.log(`窗口已关：PM 侧 15 条原件已摘除，本工具转入结构自检模式（--check）`)
} else {
  for (const b of blocks) console.log(`  ${b.p}  →  ${b.body.split("\n").length} 行`)
  console.log(`合计 ${summary}；未摘：/agents/profile（member-registry 留 PM）、/agent/dispatch（需活动日志钩子）、steer（ISS-569）`)
}
