// ISS-583 / DOC-258 PM v2 基准测量：开工前快照「代码规模 + 功能清单」，交付时 --check 出对照报告。
//
// 为什么要有这份东西：PM v2 是一次跨四线的大改（数据库 / 事件 / 调度 / 组件 + 改名）。大改最容易
// 出的事故不是写不出来，而是**改着改着某个功能不见了**、或者没人说得清「比开工前多了什么少了什么」。
// 所以开工前把可机器复算的事实固化成基线，交付时跑同一条命令出 diff，不靠记忆也不靠人嘴。
//
// 判据分两档（这是本脚本与普通 diff 的区别，也是它有用的原因）：
//   · **功能面契约段**（`CONTRACT_PATHS` 在册的那五条：插件清单 / 路由 / agent 工具 / MCP 工具 / surface）
//     ——**删项 = 回归**，`--check` 退出码 2；增项只报不红。
//     理由：功能面是「不可静默缩水的契约」，而新增是本次工作的目的本身，不该报警。
//   · 其余一切（行数 / 用例数 / 遗迹数 / 数据条数 / 每包明细 / 未在册的清单）——**只报差值不判红**。
//     理由：改名会让行数下降、DB 化会让行数上升，任何固定阈值都是假红制造机；裁判假红的代价比
//     没裁判更大（同 ISS-570 基线口径）。
//
// ⚠️ ISS-650（2026-10-24）：这两档以前是**隐式**的 ——「数组就判红、数字就只报」。后果实测：
//   `.plugins`（包盘点）与 `.code.perPlugin.*`（每包明细）同属「代码盘点」，一个判红一个只报；
//   而任何**将来新增的**清单字段都会自动获得「判红」权力，假红会随字段长回来。
//   现在改成**显式白名单**：只有 `CONTRACT_PATHS` 里有名的路径能判红，其余默认只报。
//   反向验证见 `--selftest`：删一条真实 route ⇒ 必红；只改一个计数 / 删一条未在册清单 ⇒ 只报不红。
//
// ── 地板：分母为 0 时**不许报绿**（ISS-650 批2 审查 · medium → 补成地板）──────────
// 症状（2026-10-25 实测）：旧版把数据根硬绑成 `~/.dsh/pm`，而真根在 `~/.dsh-matter/pm`
//   （3210 进程 env：`DSH_HOME=<home>/.dsh-matter`、`FORGE_PM_ROOT=…/.dsh-matter/pm`）。
//   在 agent bash 里跑（`DSH_HOME=~/.dsh`、无 `FORGE_PM_ROOT`），`.data.pmBytes 41,638,373 → 0`、
//   `drafts 20→0`、`agentRuns 374→0` —— 全落「只报不红」，终判仍是 `✓ 功能清单无缺失` exit 0。
//   ⇒「数据根换家」这类事故从此**无声**。
// 地板三件：
//   ① 根解析认 `FORGE_PM_ROOT`（优先）> `DSH_HOME`+`/pm` > `~/.dsh/pm`；
//   ② **任一分母为 0** ⇒ 该项记「不判（根可能已迁移）」并**让终判不报绿**（exit 3，见 verdictOf）；
//      分母 = `.data.*` 下的规模数字（字节数 / 条数）。反过来：**别处的 0 不算** ——
//      `naming.*`（残留清单、改名线目标就是归零）从 5 掉到 0 仍是好事，不许因此不判。
//   ③ `--write` 在分母为 0 时**拒绝落基线** —— 假基线就是从这里生出来的（旧基线是真根量的，
//      所以"基线 > 0 而现值 0"能被看见；一旦把空根量进基线，以后就再也看不见了）。
// 口径：不判 ≠ 红。红要指得出是谁的回归；根找错不是代码回归，但**绝不能绿** ——
//   「看不见」与「没少东西」是两件事（ISS-570 / ISS-751 两次学费）。
//
// 口径三条（写死在此，免得两侧各算一套）：
//   · 扫描根 = 本脚本的上上级，**绝不写死主 checkout**（工作树里跑必须扫工作树）。
//   · 产物目录（dist/out/node_modules/.wt/.tmp/.bun-tmp）与点开头目录一律不计。
//   · 测试文件不计入「实现行数」，单独计「用例数」；断言型文件混进行数里会让重构永远难看。
//
// 用法：
//   node scripts/pm-v2-baseline.mjs --write            生成/刷新基线（开工前跑一次并提交）
//   node scripts/pm-v2-baseline.mjs --check            重算 + 对照；有功能回归 exit 2、判不了（分母 0）exit 3
//   node scripts/pm-v2-baseline.mjs --report           只打印对照报告，不改退出码
//   node scripts/pm-v2-baseline.mjs --dump             打印当前一次测量（不读写基线）
//
// ⚠️ 本文件是 host 侧 `.mjs` —— 严禁 TS 类型注解（Bun/node 直跑）。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import { parseRegistrations } from "./migration-baseline.mjs"

export const REPO = process.env.DSH_FORGE_REPO || dirname(dirname(fileURLToPath(import.meta.url)))
const BASELINE_FILE = join(REPO, "scripts", "baseline", "pm-v2-baseline.json")
/**
 * DSH home：`DSH_HOME` > **`FORGE_PM_ROOT` 的父目录** > `~/.dsh`。
 *
 * ⚠️ ISS-785：过去只认 `DSH_HOME`，而 `run-gates` 只注入 `FORGE_PM_ROOT`、**不注入 `DSH_HOME`**
 *   ⇒ 门禁里跑时 `pm` 根是对的（`~/.dsh-matter/pm`），`forge-agents` 根却回落到 `~/.dsh`
 *   ⇒ `.data.agentRuns` 分母为 0 ⇒ 整格 exit 3「判不了」。同一次运行里两个根来自两个家，就是本项的病根。
 *   兄弟目录必须从同一个家推：pm 根就在 dsh home 下，`dirname` 就是它。
 * ⚠️ 必须**在动态 import 运行时模块之前**算好，并把结果写回 `process.env.DSH_HOME` ——
 *   下面 `forge-agents/lib/domain.js` 的 `AGENTS_ROOT` 自己也是读 `process.env.DSH_HOME` 的，
 *   不改 env 的话它仍会算到 `~/.dsh`（量错家比不量更糟，见文件头 §地板）。
 */
const DSH_HOME = process.env.DSH_HOME
  || (process.env.FORGE_PM_ROOT ? dirname(resolve(process.env.FORGE_PM_ROOT)) : null)
  || join(homedir(), ".dsh")
if (!process.env.DSH_HOME) process.env.DSH_HOME = DSH_HOME

/**
 * 数据根：`FORGE_PM_ROOT`（3210 进程 env 就有）> `DSH_HOME`+`/pm` > `~/.dsh/pm`。
 * ⚠️ 旧版硬绑 `~/.dsh/pm`（ISS-650 批2 审查）：真根在 `~/.dsh-matter/pm`，在 agent bash 里跑
 *   `.data` 整段归零而终判照样绿。根找错的后果见文件头 §地板。
 */
const PM_ROOT = process.env.FORGE_PM_ROOT || join(DSH_HOME, "pm")
// ⚠️ 这里过去硬编码成 `~/.dsh/agent-runs`，而**运行时的默认是 `FORGE_AGENTS_ROOT || PM_ROOT`**
// （forge-agents/lib/domain.js:18）。两份不是同一个根时，基线数的就是没在用的那份 ——
// 基准一旦量错地方，后面所有「交付对照」都跟着错，而且错得很像真的。
// 现在改成动态 import 运行时的同一个常量；导不到时显式标 fallback，绝不静默用旧默认值。
const AGENT_ROOT_FALLBACK = join(DSH_HOME, "forge-agents")
let agentsRootFromRuntime = null
let agentsRootSource = "pending"
try {
  const mod = await import(join(REPO, "forge-agents", "lib", "domain.js"))
  agentsRootFromRuntime = mod.AGENTS_ROOT
  agentsRootSource = "runtime"
} catch {
  agentsRootSource = "fallback"
}
const AGENTS_ROOT = process.env.FORGE_AGENTS_ROOT || agentsRootFromRuntime || AGENT_ROOT_FALLBACK
const AGENT_COPY_ROOT = join(DSH_HOME, "agent-runs")
// ⚠️ `DSH_HOME` 已在本文件上方（PM_ROOT 之前）定义并写回 `process.env` —— 旧版这里有第二份
//   `process.env.DSH_HOME || ~/.dsh`，与 PM_ROOT/AGENTS_ROOT 各算一套家（ISS-785 的同一病根），已删。

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".wt", ".tmp", ".bun-tmp", ".dsh"])
const TEST_RE = /\.(test|spec)\.[jt]sx?$/
const IMPL_JS_RE = /\.(js|mjs)$/
const IMPL_TS_RE = /\.(ts|tsx)$/

/**
 * 第三方/生成产物：**不计入实现行数**，但单独记 `excludedVendored`（剔了多少要看得见，
 * 静默剔除 = 下一个读基线的人无从判断分母）。理由：一次 `forge-trand/preview/standalone.js`
 * 就能贡献 27,139 行，把「PM v2 改了多少」这个信号彻底淹掉——基线的职责是可比，不是求大。
 */
const VENDORED_RE = /(\/static\/|\/vendor\/|\/preview\/|\.min\.js$|Worker\.js$)/

/** 插件根 = 仓库一级目录里带 package.json 的那些（比硬编码清单抗腐蚀：新增包自动进册）。 */
function listPlugins() {
  return readdirSync(REPO)
    .filter((n) => !n.startsWith(".") && n !== "node_modules")
    .map((n) => join(REPO, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && existsSync(join(p, "package.json"))
      } catch {
        return false
      }
    })
    .map((p) => p.split(sep).pop())
    .sort()
}

function walk(dir, out = []) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (st.isFile()) out.push(full)
  }
  return out
}

const rel = (file) => relative(REPO, file).split(sep).join("/")
const linesOf = (text) => (text === "" ? 0 : text.split("\n").length)
const countAll = (text, re) => (text.match(re) || []).length

/** 用例数：`it(` / `it.only(` / `test(` / `it.each(` 都算一个用例声明点（静态口径，不跑测试）。 */
const CASE_RE = /\b(?:it|test)(?:\.(?:only|skip|each|todo|failing|concurrent))?\s*\(/g

function measureCode(plugins) {
  const perPlugin = {}
  const hotspots = {}
  let tot = { jsLoc: 0, tsLoc: 0, jsFiles: 0, tsFiles: 0, testFiles: 0, testCases: 0 }
  const vendored = { files: 0, loc: 0 }

  for (const p of plugins) {
    const files = walk(join(REPO, p))
    let jsLoc = 0
    let tsLoc = 0
    let jsFiles = 0
    let tsFiles = 0
    let testFiles = 0
    let testCases = 0
    for (const f of files) {
      const base = f.split(sep).pop()
      const r = rel(f)
      if (TEST_RE.test(base)) {
        testFiles++
        try {
          testCases += countAll(readFileSync(f, "utf8"), CASE_RE)
        } catch {}
        continue
      }
      let text
      try {
        text = readFileSync(f, "utf8")
      } catch {
        continue
      }
      const n = linesOf(text)
      if (VENDORED_RE.test(r)) {
        if (IMPL_JS_RE.test(base) || IMPL_TS_RE.test(base)) {
          vendored.files++
          vendored.loc += n
        }
        continue
      }
      if (IMPL_JS_RE.test(base)) {
        jsLoc += n
        jsFiles++
      } else if (IMPL_TS_RE.test(base)) {
        tsLoc += n
        tsFiles++
      } else {
        continue
      }
      if (n >= 800) hotspots[rel(f)] = n
    }
    perPlugin[p] = { jsLoc, tsLoc, jsFiles, tsFiles, testFiles, testCases }
    tot = {
      jsLoc: tot.jsLoc + jsLoc,
      tsLoc: tot.tsLoc + tsLoc,
      jsFiles: tot.jsFiles + jsFiles,
      tsFiles: tot.tsFiles + tsFiles,
      testFiles: tot.testFiles + testFiles,
      testCases: tot.testCases + testCases,
    }
  }
  return { perPlugin, totals: tot, bigFiles: hotspots, excludedVendored: vendored }
}

/** 功能面 ①：HTTP 路由。复用 ISS-570 的注册扫描器，保证双前缀展开口径与那份守卫一致。 */
function measureRoutes(plugins) {
  const regs = []
  for (const p of plugins) {
    for (const f of walk(join(REPO, p))) {
      if (!IMPL_JS_RE.test(f)) continue
      if (!/(^|\/)(lib|src|dsh|mcp)\//.test("/" + rel(f))) continue
      let text
      try {
        text = readFileSync(f, "utf8")
      } catch {
        continue
      }
      if (!text.includes("ws.register")) continue
      try {
        regs.push(...parseRegistrations(f, text))
      } catch {}
    }
  }
  const paths = [...new Set(regs.filter((r) => r.path).map((r) => r.path))].sort()
  const byPrefix = {}
  for (const p of paths) {
    const seg = p.split("/").filter(Boolean)[0] || "(root)"
    byPrefix[seg] = (byPrefix[seg] || 0) + 1
  }
  return { total: paths.length, byPrefix, paths, missingPath: regs.filter((r) => !r.path).length }
}

/** 功能面 ②：agent 工具名与 MCP 工具名（对外契约，改名/搬包都不该弄丢它们）。 */
function measureTools(plugins) {
  const agentTools = new Set()
  const mcpTools = new Set()
  for (const p of plugins) {
    for (const f of walk(join(REPO, p))) {
      if (!IMPL_JS_RE.test(f) && !/\.mjs$/.test(f)) continue
      let text
      try {
        text = readFileSync(f, "utf8")
      } catch {
        continue
      }
      for (const m of text.matchAll(/\bname\s*:\s*"(agent_[a-z0-9_]+)"/g)) agentTools.add(m[1])
      for (const m of text.matchAll(/\bname\s*:\s*"(matter_[a-z0-9_]+)"/g)) mcpTools.add(m[1])
    }
  }
  return { agentTools: [...agentTools].sort(), mcpTools: [...mcpTools].sort() }
}

/** 功能面 ③：surface id（三栏网格的挂载点，改名线要动它，所以必须在册）。 */
function measureSurfaces(plugins) {
  const ids = new Set()
  for (const p of plugins) {
    for (const f of walk(join(REPO, p))) {
      const base = f.split(sep).pop()
      if (!IMPL_TS_RE.test(base) || TEST_RE.test(base)) continue
      if (base !== "client-entry.tsx" && base !== "register-features.ts") continue
      let text
      try {
        text = readFileSync(f, "utf8")
      } catch {
        continue
      }
      for (const m of text.matchAll(/["'](forge\.[a-z0-9._-]+)["']/g)) ids.add(m[1])
    }
  }
  return [...ids].sort()
}

function countMdEntries(dir) {
  let entries = 0
  let activity = 0
  let comments = 0
  let bytes = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue
      const full = join(dir, name)
      try {
        bytes += statSync(full).size
      } catch {}
      if (name.endsWith("-activity.md")) activity++
      else if (name.endsWith("-comments.md")) comments++
      else entries++
    }
  } catch {}
  return { entries, activity, comments, bytes }
}

function dirBytes(dir) {
  let bytes = 0
  for (const f of walk(dir)) {
    try {
      bytes += statSync(f).size
    } catch {}
  }
  return bytes
}

/** 数据规模：改造会读写真实数据，条数是「跑没跑对」的间接证据，也防止误删夹具。 */
function measureData() {
  const pm = {}
  for (const domain of ["issues", "projects", "reviews", "initiatives", "documents", "memos", "drafts", "tasks", "teams"]) {
    const d = join(PM_ROOT, domain)
    if (existsSync(d)) pm[domain] = countMdEntries(d)
  }
  const queueDir = join(PM_ROOT, "queue")
  // ⚠ 换根未收口（ISS-607 实测：A 进程有 FORGE_AGENTS_ROOT、B 与部分写入方仍回落 PM 根），
  //   所以这两个字段是**参考值**而不是单一真相 —— 取哪个根取决于跑本脚本的进程自己的 env。
  const runsDir = join(AGENTS_ROOT, "runs")
  const pmFiles = existsSync(PM_ROOT) ? readdirSync(PM_ROOT).filter((n) => /\.(json|ya?ml)$/.test(n)).sort() : []
  const dbs = {}
  try {
    for (const n of readdirSync(DSH_HOME)) {
      if (!/\.(db|sqlite)$/.test(n)) continue
      try {
        dbs[n] = statSync(join(DSH_HOME, n)).size
      } catch {}
    }
  } catch {}
  return {
    pm,
    // 数据根不在 = 这台机器（CI runner / 新机）没装 PM，**不判**；判成「缺失 N 项」就是把看不见说成丢了东西（ISS-751 的 CI 收尾）
    pmSidecarFiles: existsSync(PM_ROOT) ? pmFiles : null,
    pmBytes: dirBytes(PM_ROOT),
    agentRuns: existsSync(runsDir) ? readdirSync(runsDir).filter((n) => n.endsWith(".md")).length : 0,
    // 字段名要说实话：以前它量的是整个 AGENTS_ROOT（切换未生效时 = 整个 pm 目录），
    // 名字却叫 runsBytes，读数会骗人。现在只量 runs 目录，整根的体积另开一个字段。
    agentRunsBytes: existsSync(runsDir) ? dirBytes(runsDir) : 0,
    agentsRootBytes: dirBytes(AGENTS_ROOT),
    // 存储归属切换是否真的生效，看这三项而不是看目录存不存在（副本早就存在了）：
    // agentsRootSource=runtime 且 agentsRootIsPmRoot=true → 代码仍在 pm/runs 上跑（ISS-570 待切状态）。
    agentsRootSource,
    agentsRoot: AGENTS_ROOT,
    agentsRootIsPmRoot: AGENTS_ROOT === PM_ROOT,
    agentsRootEqualsCopy: AGENTS_ROOT === AGENT_COPY_ROOT,
    agentRunsCopy: existsSync(join(AGENT_COPY_ROOT, "runs"))
      ? readdirSync(join(AGENT_COPY_ROOT, "runs")).filter((n) => n.endsWith(".md")).length
      : 0,
    queueBytes: dirBytes(queueDir),
    sqliteInDshHome: dbs,
  }
}

/** 命名遗迹：改名线的验收口径就是这几个数归零，开工前必须先有分母。 */
function measureNaming(plugins) {
  let linearLines = 0
  let linmoLines = 0
  let rootClassHits = 0
  const linearNamedFiles = []
  for (const p of plugins) {
    for (const f of walk(join(REPO, p))) {
      const r = rel(f)
      const base = f.split(sep).pop()
      if (/\.(tsx?|jsx?|mjs|css)$/.test(base) && /linear/i.test(base)) linearNamedFiles.push(r)
      if (!/\.(tsx?|jsx?|mjs|css)$/.test(base)) continue
      let text
      try {
        text = readFileSync(f, "utf8")
      } catch {
        continue
      }
      if (r.startsWith("forge-pm/src/")) {
        for (const line of text.split("\n")) {
          if (/linear/i.test(line)) linearLines++
          if (/linmo/i.test(line)) linmoLines++
        }
      }
      rootClassHits += countAll(text, /\.matter-linear-root/g)
    }
  }
  return { linearLines, linmoLines, forgeLinearRootHits: rootClassHits, linearNamedFiles: linearNamedFiles.sort() }
}

export function collect() {
  const plugins = listPlugins()
  return {
    plugins,
    code: measureCode(plugins),
    routes: measureRoutes(plugins),
    tools: measureTools(plugins),
    surfaces: measureSurfaces(plugins),
    data: measureData(),
    naming: measureNaming(plugins),
  }
}

function gitInfo() {
  const sh = (cmd) => {
    try {
      return execSync(cmd, { cwd: REPO, encoding: "utf8" }).trim()
    } catch {
      return "?"
    }
  }
  return { head: sh("git rev-parse --short HEAD"), branch: sh("git rev-parse --abbrev-ref HEAD") }
}

function cmdWrite() {
  const metrics = collect()
  // 地板③（文件头 §地板）：空根上量的基线会把「根找错」永久固化 —— 以后 base 与 cur 都是 0，
  // 再也看不见漂移。假基线就是从这里生出来的，所以这里必须拒绝。
  const empty = emptyDenominators(metrics)
  if (empty.length) {
    console.error(`✗ 拒绝写基线：分母为 0（${empty.length} 项）⇒ 这份基线量化的是「根找错」，不是事实：`)
    empty.forEach((l) => console.error("  ? " + l))
    console.error(`   设 \`FORGE_PM_ROOT=…/pm\` 或 \`DSH_HOME=…\` 后再跑 --write。`)
    return 3
  }
  // ISS-785：重录台账必须**跨 --write 继承**。没有它的话每次重录都把「这次漂移凭什么合法」冲掉，
  // 下一个人只看到新数字、看不到出处 —— 判据就变成了「随手按一下绿」。
  const prevDoc = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : {}
  const doc = {
    meta: {
      note: "PM v2 (DOC-258) 开工前基准 · ISS-583 · 交付时用 --check 对照；口径见 scripts/pm-v2-baseline.mjs 头注",
      generatedAt: new Date().toISOString(),
      ...gitInfo(),
    },
    // 人工维护：每条记录「哪次重录 / 漂了什么 / 凭什么合法（commit 或单号）」。--write 原样继承，只增不改。
    rerecordLog: prevDoc.rerecordLog ?? [],
    metrics,
  }
  mkdirSync(dirname(BASELINE_FILE), { recursive: true })
  writeFileSync(BASELINE_FILE, JSON.stringify(doc, null, 2) + "\n")
  console.log(`✓ 基线已写入 ${rel(BASELINE_FILE)}`)
  console.log(
    `  路由 ${metrics.routes.total} · agent 工具 ${metrics.tools.agentTools.length} · MCP 工具 ${metrics.tools.mcpTools.length} · surface ${metrics.surfaces.length}`,
  )
  console.log(
    `  实现行数 JS ${metrics.code.totals.jsLoc} + TS ${metrics.code.totals.tsLoc} · 测试 ${metrics.code.totals.testFiles} 文件 / ${metrics.code.totals.testCases} 用例`,
  )
  return 0
}

function isList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

/**
 * 「残留清单」——这些列表**越短越好**（改名线的交付目标就是让它归零），所以不能按功能契约判红。
 * 与 ISS-570 基线同一条教训：裁判造假红的代价比没裁判更大，人会习惯看红再忽略它。
 * ⚠️ 键含前导点（diffNode 逐层拼 `.${k}`）——写成 "naming.x" 会静默不匹配，等于没有这一档。
 */
const RESIDUE = new Set([".naming.linearNamedFiles"])

/**
 * 功能面契约段（**显式在册**，唯一能判红的清单路径）。
 * 判据：这里的项消失 = 某条路由 / 工具 / 插件 / surface **不见了** = 功能回归 ⇒ 红。
 * 不在这里的清单（含将来新增的）⇒ 默认只报不红 —— 默认只报是刻意的：
 * 「新字段自动获得判红权」正是本脚本 2026-10-03~10-24 每次开发都红的机制。
 * ⚠️ 已知代价（ISS-650）：`.plugins` 在册 ⇒ **真退役一个包仍会红一次**，出口是**有意**重取基线
 *    （`--write`）并在提交说明里写明「哪几件退役、谁裁的」。那是它该红的那一次，不是假红；
 *    要它永不红，只能把 `.plugins` 降出契约段 —— 等于放弃「插件不见了」这条判据。
 */
const CONTRACT_PATHS = new Set([
  ".plugins",
  ".routes.paths",
  ".tools.agentTools",
  ".tools.mcpTools",
  ".surfaces",
])

/**
 * 分母路径：`.data.*` 下的数字量的是**磁盘上的数据规模**（字节 / 条数）。
 * 只有这一段的 0 才意味着「根没找对」；别处的 0 可能是好事（`naming.*` 残留清零就是改名线的目标），
 * 一律当事故会造出新的假红 —— 假红的代价本仓写过好几遍。
 */
const isDataDenominator = (path) => path.startsWith(".data.")

/** 递归对照：清单类报增删（契约段删=回归，其余只报），标量与对象报差值。 */
function diffNode(base, cur, path, out) {
  // cur=null ⇒ 目标机上没有这份数据的来源：记「不判」（progress 档，不红），而不是「缺失 N 项」
  if (Array.isArray(base) && cur === null) { out.progress.push(path + " 本机无该数据根 ⇒ 不判（不是回归）"); return }
  if (Array.isArray(base) && isList(base) && Array.isArray(cur) && isList(cur)) {
    const b = new Set(base)
    const c = new Set(cur)
    const removed = base.filter((x) => !c.has(x))
    const added = cur.filter((x) => !b.has(x))
    if (RESIDUE.has(path)) {
      if (removed.length) out.progress.push(`${path} 已清 ${removed.length} 项：${removed.join(", ")}`)
      if (added.length) out.changed.push(`${path} 残留新增 ${added.length} 项：${added.join(", ")}`)
      return
    }
    if (!CONTRACT_PATHS.has(path)) {
      if (removed.length) out.changed.push(`${path} 少了 ${removed.length} 项（非契约段·只报不红）：${removed.join(", ")}`)
      if (added.length) out.changed.push(`${path} 多了 ${added.length} 项（非契约段·只报不红）：${added.join(", ")}`)
      return
    }
    if (removed.length) out.regressions.push(`${path} 缺失 ${removed.length} 项：${removed.join(", ")}`)
    if (added.length) out.added.push(`${path} 新增 ${added.length} 项：${added.join(", ")}`)
    return
  }
  if (base && cur && typeof base === "object" && typeof cur === "object") {
    for (const k of new Set([...Object.keys(base), ...Object.keys(cur)])) {
      diffNode(base[k], cur[k], `${path}.${k}`, out)
    }
    return
  }
  if (typeof base === "number" && typeof cur === "number") {
    if (base !== cur) {
      // 地板（ISS-650 批2 审查）：`.data.*` 的规模数字掉到 0 而基线是正值 ⇒ 根多半已迁移，
      // **不是**「数据真的清空了」。记「不判」而不是「只报不红」，终判才会失去绿（见 verdictOf）。
      if (isDataDenominator(path) && cur === 0) {
        out.unjudged.push(`${path} 基线 ${base} → 0 ⇒ 不判（根可能已迁移：${PM_ROOT}）`)
        return
      }
      out.changed.push(`${path} ${base} → ${cur}（${cur > base ? "+" : ""}${cur - base}）`)
    }
    return
  }
  if (JSON.stringify(base) !== JSON.stringify(cur)) {
    out.changed.push(`${path} ${JSON.stringify(base)} → ${JSON.stringify(cur)}`)
  }
}

/** 对照入口（导出给测试用：反向验证守卫能红能绿，不靠造空仓库这种间接证据）。 */
export function diffMetrics(base, cur) {
  const out = { regressions: [], added: [], changed: [], progress: [], unjudged: [] }
  diffNode(base, cur, "", out)
  return out
}

/**
 * 分母地板（纯函数，`--selftest` 直接喂数据）：任一分母为 0 ⇒ 返回「不判（根可能已迁移）」清单。
 * 只看三处**最小集合**：PM 根的 md 条数 / PM 根字节 / agent 运行数 —— 有它们就等于根找对了；
 * 逐域逐字段地列会让每加一个域就要改一次地板，而地板一漏就是又一次假绿。
 */
export function emptyDenominators(metrics) {
  const out = []
  const pm = metrics?.data?.pm ?? {}
  const mdCount = Object.values(pm).reduce(
    (a, d) => a + (d?.entries ?? 0) + (d?.activity ?? 0) + (d?.comments ?? 0), 0,
  )
  if (mdCount === 0) out.push(`.data.pm 里 0 条 md（根 ${PM_ROOT}）⇒ 不判（根可能已迁移）`)
  if (!metrics?.data?.pmBytes) out.push(`.data.pmBytes = 0（根 ${PM_ROOT}）⇒ 不判（根可能已迁移）`)
  if (!metrics?.data?.agentRuns) out.push(`.data.agentRuns = 0（根 ${AGENTS_ROOT}/runs）⇒ 不判（根可能已迁移）`)
  return out
}

/**
 * 终判三态（纯函数，`--selftest` 钉死）：2 = 功能回归 / 3 = 判不了（分母为 0，**绝不报绿**）/ 0 = 绿。
 * 为什么"不判"要有自己的码：与绿同码（旧版 exit 0）时，跑错根的人看不出自己其实什么都没判。
 */
export function verdictOf(out) {
  if (out.regressions.length) return { code: 2, tone: "red", why: `功能回归 ${out.regressions.length} 项` }
  if (out.unjudged.length) return { code: 3, tone: "unjudged", why: `${out.unjudged.length} 项分母为 0（根可能已迁移）` }
  return { code: 0, tone: "green", why: "功能清单无缺失" }
}

function cmdCompare(mode) {
  if (!existsSync(BASELINE_FILE)) {
    console.error(`✗ 基线不存在：${rel(BASELINE_FILE)}（先跑 --write）`)
    return mode === "check" ? 2 : 1
  }
  const base = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
  const cur = collect()
  const out = diffMetrics(base.metrics, cur)
  // 地板（文件头 §地板）：分母为 0 ⇒ 这一片的数字全都不可信，逐条记「不判」。
  for (const l of emptyDenominators(cur)) out.unjudged.push(l)
  const v = verdictOf(out)
  const w = (t) => console.log(t)
  w(`── PM v2 基准对照（基线 ${base.meta.head} / ${base.meta.generatedAt.slice(0, 10)}） ──`)
  w(`   数据根 ${PM_ROOT}${existsSync(PM_ROOT) ? "" : "（不存在！）"} · agent 运行根 ${AGENTS_ROOT}`)
  // 终判三态：绿只留给「真判过且没回归」；判不了单独一行，绝不打 ✓。
  if (v.tone === "green") w("✓ 功能清单无缺失")
  else if (v.tone === "red") {
    w(`✗ 功能回归 ${out.regressions.length} 项：`)
    out.regressions.forEach((l) => w("  - " + l))
  } else {
    w(`✗ 判不了：${v.why} —— 分母为 0 意味着根没找对，**不是**「数据没少」`)
    w(`   设 \`FORGE_PM_ROOT=…/pm\` 或 \`DSH_HOME=…\` 后再跑；exit 3（回归 = 2 / 绿 = 0，三者可分）`)
  }
  if (out.unjudged.length) {
    w(`· 不判（根可能已迁移）${out.unjudged.length} 项：`)
    out.unjudged.forEach((l) => w("  ? " + l))
  }
  if (out.progress.length) {
    w(`✓ 残留清理 ${out.progress.length} 项：`)
    out.progress.forEach((l) => w("  · " + l))
  }
  if (out.added.length) {
    w(`· 新增 ${out.added.length} 项：`)
    out.added.forEach((l) => w("  + " + l))
  }
  if (out.changed.length) {
    w(`· 只报不红（计数 / 非契约清单）${out.changed.length} 项：`)
    out.changed.forEach((l) => w("  ~ " + l))
  }
  if (mode === "check") return v.code
  return 0
}

/**
 * 守卫自检（`--selftest`）：证明这把裁判**既能红也能绿**，而不是恒绿门禁。
 * 为什么不写完就算交付：本仓为「看不见 / 恒绿」付过学费（ISS-570 基线头注、ISS-576 恒红门禁），
 * 一个从没红过的守卫和一个没有守卫等价。
 */
function cmdSelftest() {
  const cur = collect()
  const clone = () => JSON.parse(JSON.stringify(cur))
  const cases = []

  // ① 功能契约段少一项 → 必须判红（五条全测：一条不测就等于那条没牙）
  //   注意红在「现在比基线少」，所以造的是**当前态缺项**，不是基线缺项（方向反了就永远不红）。
  for (const [name, mutate] of [
    [".plugins", (m) => m.plugins.shift()],
    [".routes.paths", (m) => m.routes.paths.shift()],
    [".tools.agentTools", (m) => m.tools.agentTools.shift()],
    [".tools.mcpTools", (m) => m.tools.mcpTools.shift()],
    [".surfaces", (m) => m.surfaces.shift()],
  ]) {
    const dropped = clone()
    mutate(dropped)
    const out = diffMetrics(cur, dropped)
    cases.push([`契约段 ${name} 缺失判红`, out.regressions.some((l) => l.startsWith(name))])
  }

  // ② 契约段**新增**项 → 只报（added），不判红：新增是本次工作的目的本身
  const grown = clone()
  grown.routes.paths.push("__fx_probe_route")   // 不写成 /forge-xxx：那会被 C10（K5g 路由渗漏）当成真前缀
  const outGrown = diffMetrics(cur, grown)
  cases.push(["契约段新增只报不红", outGrown.regressions.length === 0 && outGrown.added.some((l) => l.startsWith(".routes.paths"))])

  // ③ 改名线清掉一个 linear 残留 → 必须判**绿**，且计入 progress（判红就是假红）
  const base2 = clone()
  base2.naming.linearNamedFiles.push("forge-pm/src/pm/linear-ghost.tsx")
  const out2 = diffMetrics(base2, cur)
  cases.push(["残留清理不误判回归", out2.regressions.length === 0 && out2.progress.length === 1])

  // ④ 「不判」与「真缺项」两头都有牙
  cases.push(["数据根缺席(null) 不算回归 · 契约清单真缺项仍算回归", (() => {
    const a = diffMetrics({ data: { x: ["p", "q", "r"] } }, { data: { x: null } })
    const b = diffMetrics({ routes: { paths: ["/a", "/b"] } }, { routes: { paths: ["/a"] } })
    return a.regressions.length === 0 && a.progress.length === 1 && b.regressions.length === 1
  })()])
  cases.push(["同一状态零差异", diffMetrics(clone(), cur).regressions.length === 0 && diffMetrics(clone(), cur).changed.length === 0])

  // ⑤ 计数变化只报不红（ISS-650 之前这里已经是这样，钉住不让它回退）
  const base5 = clone()
  base5.code.totals.jsLoc -= 1000
  base5.routes.total -= 1
  const out5 = diffMetrics(base5, cur)
  cases.push(["计数变化只报不红（行数 / 路由总数）", out5.regressions.length === 0 && out5.changed.some((l) => l.includes("jsLoc")) && out5.changed.some((l) => l.includes("routes") && l.includes("total"))])

  // ⑥ 降档的反向验证：**非契约**清单少一项 ⇒ 只报不红（.plugins / .routes.paths 之外的清单）
  //   ⚠️ 夹具要用**嵌套对象**而不是 `{ ".data.queueFiles": … }`：diffNode 逐层拼 `.${k}`，
  //   键里自带点会拼成 `..data.queueFiles`，于是永远匹配不上在册路径（上一版就这么空转过）。
  const base6 = { data: { queueFiles: ["a.md", "b.md", "c.md"] } }
  const out6 = diffMetrics(base6, { data: { queueFiles: ["a.md"] } })
  cases.push(["非契约清单缺失只报不红", out6.regressions.length === 0 && out6.changed.some((l) => l.includes("queueFiles"))])

  // ⑦ 盘点段整块消失（模拟真退役一个包：perPlugin 里那块没了）⇒ 只报不红
  const base7 = clone()
  base7.code.perPlugin["forge-ghost"] = { jsLoc: 10, tsLoc: 20, jsFiles: 1, tsFiles: 1, testFiles: 0, testCases: 0 }
  const out7 = diffMetrics(base7, cur)
  cases.push(["每包明细整块消失只报不红（改名的常态，不判回归）", out7.regressions.length === 0 && out7.changed.some((l) => l.includes("forge-ghost"))])

  // ⑧ 地板（ISS-650 批2 审查）：**分母为 0 ⇒ 不判，且终判不报绿**（三态各自钉住）
  //   以前的形态：`.data.pmBytes 41,638,373 → 0` 只落「只报不红 1 项」，终判照样 `✓ 功能清单无缺失`。
  //   ⚠️ 这几个夹具必须是**合成数据**：真 `cur` 在跑错根的机器上本来就是 0，
  //   拿它当"基线那是正值"的一侧会让这条自检随环境翻红翻绿（自检自己成了环境探测器）。
  const outZeroPure = diffMetrics({ data: { pmBytes: 41638373, agentRuns: 374 } }, { data: { pmBytes: 0, agentRuns: 0 } })
  cases.push(["分母从正值掉到 0 ⇒ 记「不判（根可能已迁移）」，不是只报",
    outZeroPure.unjudged.some((l) => l.includes("pmBytes")) && outZeroPure.unjudged.some((l) => l.includes("agentRuns"))
    && outZeroPure.regressions.length === 0])
  cases.push(["不判 ⇒ 终判 exit 3（不报绿，也不是回归 2）",
    verdictOf(outZeroPure).tone === "unjudged" && verdictOf(outZeroPure).code === 3])
  cases.push(["三态互斥：真回归仍优先判红（2），不被不判吃掉", (() => {
    const o = diffMetrics({ routes: { paths: ["/a", "/b"] }, data: { pmBytes: 100 } }, { routes: { paths: ["/a"] }, data: { pmBytes: 0 } })
    return verdictOf(o).code === 2 && o.unjudged.length === 1
  })()])
  // 反向控制三条：地板若要「见 0 就不判」，这三条立刻翻红 ⇒ 证明它不是恒不判
  cases.push(["反向：基线本来就是 0 ⇒ 不算不判（空环境不背事故）", diffMetrics({ data: { pmBytes: 0 } }, { data: { pmBytes: 0 } }).unjudged.length === 0])
  cases.push(["反向：残留清零（.naming 5 → 0）不触发地板 —— 0 在别的段是好事", diffMetrics({ naming: { linearLines: 5 } }, { naming: { linearLines: 0 } }).unjudged.length === 0])
  cases.push(["反向：.data 里的数字减少但**没归 0**（922018 → 12）仍只报不红 —— 别把「变少」当「搬走」", (() => {
    const o = diffMetrics({ data: { queueBytes: 922018 } }, { data: { queueBytes: 12 } })
    return o.unjudged.length === 0 && o.changed.some((l) => l.includes("queueBytes"))
  })()])
  // 根级地板：三个分母同时为 0（agent bash 里的真实形态）⇒ 三项都要报出来
  cases.push(["根级：整片 data 为 0（0 条 md / 0 字节 / 0 运行）⇒ 三项都记不判", emptyDenominators({ data: { pm: {}, pmBytes: 0, agentRuns: 0 } }).length === 3])
  cases.push(["根级反向控制：根找对（有 md / 有字节 / 有运行）⇒ 一条不判都不报", emptyDenominators({ data: { pm: { issues: { entries: 1538, activity: 1567, comments: 191 } }, pmBytes: 41638373, agentRuns: 374 } }).length === 0])

  let bad = 0
  for (const [name, ok] of cases) {
    console.log(`${ok ? "✓" : "✗"} ${name}`)
    if (!ok) bad++
  }
  console.log(bad ? `✗ 守卫自检失败 ${bad} 项` : `✓ 守卫自检 ${cases.length} 项全过（能红能绿）`)
  return bad ? 2 : 0
}

const arg = process.argv[2]
if (arg === "--write") process.exitCode = cmdWrite()
else if (arg === "--check") process.exitCode = cmdCompare("check")
else if (arg === "--report") process.exitCode = cmdCompare("report")
else if (arg === "--selftest") process.exitCode = cmdSelftest()
else if (arg === "--dump") console.log(JSON.stringify(collect(), null, 2))
else {
  console.log("用法: node scripts/pm-v2-baseline.mjs --write | --check | --report | --selftest | --dump")
  process.exitCode = 1
}
