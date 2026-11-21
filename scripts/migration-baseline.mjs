// ISS-570 / DOC-256 §7.0 ⓪b：迁移基线（golden fixture）与等价性比对
//
// 为什么需要：DOC-256 §7.4 要求「契约 diff 为空」「路由表 diff 无遗漏」，但那两条在 v1 里
//   只是文字——没有可执行产物就无法自证等价，也无法在事后复盘。本脚本把三样东西固化成基线：
//     ① routes        —— 在册路由清单 + 「kind 有但 path 缺」的漏注册（ISS-569 那一类）
//     ② eventContract —— 历史 Run 实际吐出的事件 kind 词表与每种携带的字段集（Normalizer 的真相）
//     ③ urlCallSites  —— 全仓 `/forge-pm/agent*` 字面量落点（迁出后必须归零，见 §7.2 线 #6）
//
// 用法：
//   node scripts/migration-baseline.mjs --write   生成/刷新基线（迁移**前**跑一次并提交）
//   node scripts/migration-baseline.mjs --check   重算并与基线比对；有差异退出码 2 并打印
//
// P2a 双前缀并行时的用法：`--check` 应当**只有**「forge-agents 侧新增」这一类差异；
//   P2b 摘完后：routes.agent 归 PM（应为空）、urlCallSites 应为空。
//
// 输出形状的两条口径（v2，随双前缀期一起改）：
//   · `routes.agent` 是**去重集合**，且会把 `path: base + "…"` 的循环注册按 ROUTE_BASES 展开——
//     所有权从 forge-pm 换到 forge-agents 不该是差异，只有路径真的消失/新增才是。
//   · `routes.missingPath` 与 `urlCallSites.sites` 按文件聚合计数，不带行号。
//     因为这份守卫的终态判据是「归零」，而无关文件的普通编辑就会挪动行号；
//     中间态假红训练人忽略红，真回归来时同样被忽略（本仓为这类噪音付过学费）。
//   · `urlCallSites.sites` 的成员是**文件名 × 次数**，所以"把字面量从调用点搬进包内端点表"
//     （ISS-715 端点归一，2026-09-22 起）会同时报"少几项 + 多几项"而 **总数不变**——那是搬家不是回归。
//     判据不必为此放宽：**总数增加**（新的 `/forge-pm/agent*` 渗漏）由度量 C10 / 规则 K5g 在全仓层面判红，
//     这里遇到"总数守恒的搬家"就按下面的规矩 `--write` 重录，别把红留着当噪音。
//     实例（09-22）：12 → 12 处，`agent-center.tsx ×1` → `forge-model/src/endpoints.ts ×1`，
//     `forge-pm/src/pm/api.ts ×2` → `api.ts ×1 + pm/endpoints.ts ×1`。
//   ⚠️ 换扫描器形状后基线必须**在同一个源 commit 上重生成**（否则形状差会被读成迁移差）：
//     `git worktree add --detach /tmp/x a86176b && DSH_FORGE_REPO=/tmp/x node scripts/migration-baseline.mjs --write`
//     的产物抄回本仓——基线是 (源状态, 扫描器版本) 的派生物，不是手抄件。
//
// ⚠️ 本文件是 host 侧 `.mjs` —— 严禁 TS 类型注解（Bun/node 直跑）。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { execSync } from "node:child_process"

// 仓库根 = 本脚本的上上级（**不能写死主 checkout 路径**：工作树里跑就必须扫工作树，
// 否则基线固化的是别人的代码，等价性证明就成了自欺）。
export const REPO = process.env.DSH_FORGE_REPO || dirname(dirname(fileURLToPath(import.meta.url)))
const BASELINE = join(REPO, "scripts", "baseline", "iss-570-migration.json")
const PM_ROOT = process.env.FORGE_PM_ROOT || join(homedir(), ".dsh", "pm")
const AGENTS_ROOT = process.env.FORGE_AGENTS_ROOT || join(homedir(), ".dsh", "agent-runs")

/** 迁移期间可能同时存在两侧 host 代码，逐个探测。 */
const HOST_DIRS = ["forge-pm", "forge-agents"].map((p) => join(REPO, p, "lib")).filter((p) => existsSync(p))
const RUN_DIRS = [join(PM_ROOT, "runs"), join(AGENTS_ROOT, "runs")].filter((p) => existsSync(p))

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".wt", ".tmp", ".bun-tmp"])

/** ISS-779：词法判据要引擎的 scanner/AST（`lexical-lib` 的同一套候选路径 —— 仓根 `node_modules/typescript` 不存在，
 *  `forge-ui` / `forge-pm` 各带一份）。按需惰性加载：只跑 `--check` 的结构面不需要它。 */
let TS = null
function loadTs() {
  if (TS) return TS

  const cands = ["forge-ui/node_modules/typescript", "forge-pm/node_modules/typescript", "node_modules/typescript"]
  const abs = cands.map((c) => join(REPO, c)).find((p) => existsSync(p))
  // 找不到引擎 = **跑不成**，不是「判据跑了没通过」⇒ exit 2（判不了），与本文件其余出口同口径。
  // ⚠️ 为什么不用 `throw`：`throw new Error(...)` 在盘点里算一个**抛错点**（K9f/E8），
  //    而这里本来就没有可恢复的分支 —— 用 exit 2 让「跑不成」与「红」在退出码上分开，
  //    也顺带不顶高那个棘轮（ISS-779 审查发现：本行曾把 E8 从 386 顶到 387）。
  if (!abs) {
    console.error("✗ 找不到 typescript（候选：" + cands.join(" / ") + "）⇒ 判不了，先 bun install")
    process.exit(2)
  }
  TS = createRequire(join(abs, "package.json"))("typescript")
  return TS
}

function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".test.js") || name.endsWith(".test.ts")) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walkJs(full, out)
    } else if (name.endsWith(".js")) {
      out.push(full)
    }
  }
  return out
}

function walkAll(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walkAll(full, out)
    // 测试文件不计：它们的职责常常就是**断言某个字面量不存在**（写出来才知道断言了什么），
    // 把它算进「残留」会永远假红。与 walkJs 的 *.test.* 跳过保持同一口径。
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.(test|spec)\.[jt]sx?$/.test(name)) out.push(full)
  }
  return out
}

// ─── ① 路由：扫 ws.register({...}) / ws.registerUpgrade({...}) 块 ───
// 为什么两种都要看：registerUpgrade 走的是另一条注册口（WS upgrade，如 B 引擎的 remote.mux 隧道）。
//   只扫 ws.register( 的话，将来 agent 域若改用 WS 就进了守卫盲区——而「看不见」正是本基线要防的事。
// 为什么不用正则在整段文本上抓：handler 里到处是 `json(res, 200, { kind: "list" })` 这类
// 响应体字段，嵌套匹配会把业务字段当成注册字段，误报一堆「有 kind 无 path」。
const NEEDLES = [{ call: "ws.register(", via: "register" }, { call: "ws.registerUpgrade(", via: "upgrade" }]

/**
 * 识别「一条源码块注册多条路径」的形式：双前缀并行期由生成器写出
 *   const ROUTE_BASES = ["/forge-agents", "/forge-pm"]
 *   for (const base of ROUTE_BASES) ctx.effect(() => ws.register({ kind:"exact", path: base + "/agent/runs", ... }))
 * 为什么必须在扫描器里展开而不是把源码改回字面量：这条循环正是 P2b 的交付形态（所有权已换包、
 * 旧前缀仍在册），扫描器读不懂它就等于对「15 条路由换主人」这件事**盲**——而盲掉的后果是
 * 把 15 项判成「path 缺失」，即裁判自己造假红。裁判造假红的代价比没裁判更大：人会习惯看红再忽略它。
 */
export function parseLoopBases(text) {
  // 两遍扫，而不是要求 `const X=[...]` 紧跟 `for (const b of X)`：生成器把 ROUTE_BASES 声明在
  // 文件头、循环散在十几处，粘着写就匹配不上（第一版就是这么瞎的）。
  const arrays = {}
  for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*\[\s*((?:"[^"]*"(?:\s*,\s*"[^"]*")*)\s*)\]/g)) {
    arrays[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1])
  }
  const out = {}
  for (const m of text.matchAll(/for\s*\(\s*(?:const|let)\s+(\w+)\s+of\s+(\w+)\s*\)/g)) {
    if (arrays[m[2]]) out[m[1]] = { arr: m[2], bases: arrays[m[2]] }
  }
  return out
}

/**
 * path 的值：字面量、`变量 + 字面量`，或模板串 `` `${变量}/后缀` ``（都是循环前缀形式）。
 *
 * ⚠️ 模板串这一支是 ISS-727 补的盲区：`forge-session-b/lib/routes.js`（ISS-568 从 forge-pm 迁过去）
 *   写的是 `` path: `${base}/engine-b` ``，而本函数只认 `base + "/engine-b"`（P2b 生成器的写法）。
 *   后果不是报错而是**静默少采**：4 条 engine-b 路径从功能面基线里消失，`--check` 把它报成"功能回归"，
 *   于是 pm-v2 守卫长期 exit 2 —— 而真正该被盯住的「旧前缀 /forge-pm/engine-b 被人删了」反而再也看不见。
 *   两条写法**语义完全相同**，扫描器没理由只认一条。返回形状复用 `concat`，让下面的前缀展开逻辑一处管两种写法。
 */
export function parsePathValue(block, i) {
  const s = block.slice(i)
  const lit = /^path\s*:\s*"([^"]*)"/.exec(s)
  if (lit) return { kind: "literal", path: lit[1], len: lit[0].length }
  // ISS-715（端点归一）之后的第三种写法：`path: EP.doc` —— 值在同包的 endpoints 表里。
  // 不认它的后果与上面那条注释一模一样：注册条目**静默消失**，功能面把它报成"功能回归"。
  const table = /^path\s*:\s*(\w+)\.(\w+)/.exec(s)
  if (table) return { kind: "table", ns: table[1], key: table[2], len: table[0].length }
  const concat = /^path\s*:\s*(\w+)\s*\+\s*"([^"]*)"/.exec(s)
  if (concat) return { kind: "concat", var: concat[1], suffix: concat[2], len: concat[0].length }
  const tpl = /^path\s*:\s*`\$\{(\w+)\}([^`]*)`/.exec(s)
  if (tpl) return { kind: "concat", var: tpl[1], suffix: tpl[2], len: tpl[0].length }
  return null
}

/** `path: EP.key` 这种引用的解析标记：先占位，再由 parseRegistrations 拿同包表来兑。 */
const TABLE_MARK = "@@table:"
const TABLE_FILES = ["lib/endpoints.js", "lib/endpoints.ts"]
const TABLE_CACHE = new Map()

/** 同包 endpoints 表里 key → path。表不在 / 键不存在 ⇒ 兑不出值，交回空串落进 missingPath（不静默算成一条）。 */
function tableFor(file) {
  const pkg = relative(REPO, file).split(sep)[0]
  if (TABLE_CACHE.has(pkg)) return TABLE_CACHE.get(pkg)
  const map = new Map()
  for (const f of TABLE_FILES) {
    const cand = join(REPO, pkg, f)
    if (!existsSync(cand)) continue
    for (const m of readFileSync(cand, "utf8").matchAll(/^\s*(\w+)\s*:\s*"([^"]*)"/gm)) {
      if (!map.has(m[1])) map.set(m[1], m[2])
    }
  }
  TABLE_CACHE.set(pkg, map)
  return map
}

export function parseRegistrations(file, text) {
  const found = []
  const loopBases = parseLoopBases(text)
  for (const { call, via } of NEEDLES) {
    let from = 0
    for (;;) {
      const at = text.indexOf(call, from)
      if (at === -1) break
      from = at + call.length
      const open = text.indexOf("{", from)
      if (open === -1) continue
      let depth = 0
      let end = -1
      for (let i = open; i < text.length; i++) {
        const c = text[i]
        if (c === "{") depth++
        else if (c === "}") {
          depth--
          if (depth === 0) { end = i; break }
        }
      }
      if (end === -1) continue
      const block = text.slice(open, end + 1)
      const top = topLevelField(block, loopBases)
      const fileRel = relative(REPO, file).split(sep).join("/")
      const table = tableFor(file)
      for (let path of top.paths) {
        if (path.startsWith(TABLE_MARK)) {
          // 兑得出就用表里的值；兑不出留空串 ⇒ 显式落进 missingPath，不静默少采。
          path = table.get(path.slice(TABLE_MARK.length)) || ""
        }
        found.push({ file: fileRel, kind: top.kind || (via === "upgrade" ? "upgrade" : ""), path })
      }
    }
  }
  return found
}

/**
 * 取出注册对象第一层（depth===1）的 kind 与 path。
 * 返回 `paths: string[]`——循环前缀形式会展开成多条，展开失败（变量不在已知的 ROUTE_BASES 里）
 * 时退回单条空串，让它落进 missingPath 桶报出来：宁可显式可疑，不要静默算成一条正常路径。
 */
export function topLevelField(block, loopBases) {
  const out = { kind: "", paths: [] }
  const suffixes = []
  let depth = 0
  let i = 0
  while (i < block.length) {
    const c = block[i]
    if (c === "{" || c === "[" || c === "(") depth++
    else if (c === "}" || c === "]" || c === ")") depth--
    else if (depth === 1 && (c === "k" || c === "p")) {
      const m = /^kind\s*:\s*"([^"]*)"/.exec(block.slice(i))
      if (m) {
        if (!out.kind) out.kind = m[1]
        i += m[0].length
        continue
      }
      if (/^path\s*:/.test(block.slice(i))) {
        const p = parsePathValue(block, i)
        if (p) {
          if (p.kind === "literal") out.paths.push(p.path)
          else if (p.kind === "table") out.paths.push(TABLE_MARK + p.key)
          else suffixes.push(p)
          i += p.len
          continue
        }
      }
    }
    i++
  }
  for (const s of suffixes) {
    const bases = loopBases[s.var]
    // 变量不在已知 ROUTE_BASES 里 → 一条也不展开，交给下面的空串兜底报出来。
    if (bases) for (const b of bases.bases) out.paths.push(`${b}${s.suffix}`)
  }
  if (!out.paths.length) {
    // 既没有字面量也没有可展开的循环前缀 = 「有 kind 无 path」，正是 ISS-569 那一类漏注册。
    // 必须留一条空 path 占住这次注册：直接不计数会让 total 和 missingPath **同时**变小，
    // 守卫就这么在被保护的回归眼前哑掉（v2 改展开时真踩过：82/0 冒充干净）。
    out.paths.push("")
  }
  out.paths = [...new Set(out.paths)]
  return out
}

/**
 * 把「注册条目」收成三个可比对的桶。单独成函数是为了能被单测：
 * 去重与 missingPath 兜底这两条语义都是这次改扫描器新加的，而扫描器本身要读磁盘，
 * 只有把纯逻辑剥出来才能喂合成源码验证（否则只能靠「跑一次看看数」，那不叫测试）。
 */
export function summarizeRoutes(regs) {
  const agentPaths = new Set()
  const missingPath = new Map()
  for (const r of regs) {
    const needsPath = r.kind === "exact" || r.kind === "prefixes" || r.kind === "upgrade"
    if (needsPath && !r.path) {
      // 按「文件 + kind」聚合计数，不带行号：行号不是身份，任何人改一次无关文件，
      // 基线就会假报「一删一增」——而这份守卫的终态判据是「归零」，中间态噪音只会训练人忽略它。
      const key = `${r.file} · kind=${r.kind}`
      missingPath.set(key, (missingPath.get(key) || 0) + 1)
    }
    // agent 域桶：旧前缀 `/forge-pm/agent*` 与新前缀 `/forge-agents/*` 落**同一个桶**，且**去重成集合**——
    // P2a/P2b 并行期两个包各注册一次同一路径，所有权移交本身不该是差异；
    // 于是「只增不减」这条 diff 才只可能来自真新增/真丢失。
    if (/^\/forge-pm\/agent|^\/forge-agents\//.test(r.path)) agentPaths.add(r.path)
  }
  return {
    total: regs.length,
    byKind: regs.reduce((a, r) => ({ ...a, [r.kind || "(空)"]: (a[r.kind || "(空)"] || 0) + 1 }), {}),
    agent: [...agentPaths].sort(),
    missingPath: [...missingPath.entries()]
      .map(([key, count]) => `${key} ×${count}`)
      .sort(),
  }
}

export function scanRoutes() {
  const regs = []
  for (const dir of HOST_DIRS) for (const f of walkJs(dir)) regs.push(...parseRegistrations(f, readFileSync(f, "utf8")))
  return summarizeRoutes(regs)
}

// ─── ② 事件契约：从历史 Run 反推（这才是 Normalizer 真正吐出的东西，不是注释里的词表）───
function scanEvents() {
  const kinds = {}
  let runs = 0
  let events = 0
  for (const dir of RUN_DIRS) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue
      const text = readFileSync(join(dir, name), "utf8")
      const body = stripFrontmatter(text)
      runs++
      for (const line of body.split("\n")) {
        const s = line.trim()
        if (!s.startsWith("{")) continue
        let ev
        try { ev = JSON.parse(s) } catch { continue }
        if (!ev || typeof ev.kind !== "string") continue
        events++
        const cur = kinds[ev.kind] || { count: 0, fields: new Set() }
        cur.count++
        for (const k of Object.keys(ev)) cur.fields.add(k)
        kinds[ev.kind] = cur
      }
    }
  }
  const out = {}
  for (const k of Object.keys(kinds).sort()) out[k] = { count: kinds[k].count, fields: [...kinds[k].fields].sort() }
  return { runs, events, kinds: out }
}

function stripFrontmatter(text) {
  const lines = text.split("\n")
  if (lines[0] !== "---") return text
  for (let i = 1; i < lines.length; i++) if (lines[i] === "---") return lines.slice(i + 1).join("\n")
  return text
}

// ─── ③ 前端 URL 字面量落点（迁出后必须归零；漏一处的症状是运行时静默 404）───
//
// ISS-779：字面量扫描必须分清**代码 / 注释 / 自检夹具**，三类分开判。
// 返回 1 起算的「真调用点」行号数组（纯函数，不碰磁盘 ⇒ 自检能直接喂样本）。
//
// 口径（三条，逐条钉在 `--selftest` 的「三形态正反例」里）：
//   ① **注释不算**：走 AST 而不是逐行 `includes` —— 注释在 AST 里根本没有节点，
//      这是「结构上不可能命中」，不是「正则尽量绕开」（ISS-762 的同一课：剔词法交给引擎）。
//   ② **自检夹具不算**：判据是**结构**（字面量落在 `selftest*` 函数体内），不是路径正则。
//      ⛔ 不许按文件路径圈地 —— 本仓在 Z2 / ISS-654 栽过「按路径把判据面悄悄放宽」。
//   ③ **真字面量仍算**：字符串 / 模板串 / 单引号串照数（少这一条就是反向造假红：
//      剥过了头 ⇒ 真调用点漏掉 ⇒ 迁移残留静默变成运行时 404）。
function urlHitsIn(ts, file, source, needle) {
  // 先按原文粗筛：不含 needle 的文件不进解析器（全仓 AST 解析实测 ~1.2s，粗筛后只剩十余个文件）。
  if (!source.includes(needle)) return []
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out = []
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  // 模板串被拆成 Head/中段/Tail，其中只含普通文本的那些也要算（`` `${b}/forge-pm/agent/x` ``）。
  const isText = (n) =>
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    n.kind === ts.SyntaxKind.TemplateHead ||
    n.kind === ts.SyntaxKind.TemplateMiddle ||
    n.kind === ts.SyntaxKind.TemplateTail ||
    n.kind === ts.SyntaxKind.FirstTemplateToken ||
    n.kind === ts.SyntaxKind.LastTemplateToken ||
    // JSX 文本（`<div>/forge-pm/agent/x</div>`）也算真调用点：它是 JSX 里的可见文本，
    // 不是注释。实测全仓当前 0 处，加它是为了让「三种形态」在 JSX 里同样成立，不留形态缺口。
    n.kind === ts.SyntaxKind.JsxText
  // ② 的结构判据：往上找最近的有名函数，名字像自检的自检夹具
  const inSelftest = (stack) => [...stack].reverse().some((nm) => /^selftest/.test(nm))
  const walk = (node, fnStack) => {
    if (isText(node) && String(node.text).includes(needle) && !inSelftest(fnStack)) out.push(lineOf(node))
    const named =
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name
        ? node.name.getText(sf)
        : ts.isArrowFunction(node) || ts.isFunctionExpression(node)
          ? "(anon)"
          : null
    const next = named ? [...fnStack, named] : fnStack
    ts.forEachChild(node, (c) => walk(c, next))
  }
  walk(sf, [])
  return out
}

function scanUrls() {
  // 排除的是**裁判自己**：本脚本（正则与数据）、基线快照、以及迁移工具链——
  // `extract-agent-routes.mjs` 的职责就是把旧前缀写成字面量（PATHS 表 + 双前缀生成），
  // 把它算进「残留」等于要求工具忘掉自己要干什么，永远不为 0。
  // 逐个点名而不是整目录放过 `scripts/`：真实调用端（如运维脚本打 agent 接口）仍该被数到。
  const TOOL_FILES = [
    "migration-baseline.mjs",
    "extract-agent-routes.mjs",
    join("scripts", "baseline", ""),
  ]
  const files = walkAll(REPO).filter((f) => !TOOL_FILES.some((s) => f.includes(s)))
  const ts = loadTs()
  const perFile = new Map()
  let count = 0
  for (const f of files) {
    const source = readFileSync(f, "utf8")
    const rel = relative(REPO, f).split(sep).join("/")
    // ISS-779：逐行 `includes` 会把**注释**和**自检夹具**里的旧前缀也记成一笔，
    // 于是「迁出后归零」永远不可达 —— 守卫恒红 = 守卫失效。改走 `urlHitsIn` 的代码面判定。
    const hits = urlHitsIn(ts, f, source, "/forge-pm/agent").length
    if (!hits) continue
    count += hits
    perFile.set(rel, hits)
  }
  // 按文件聚合 + 计数，不带行号（同上：行号不是身份）。
  // 代价说清楚：同一文件内「删一处又加一处」这里看不出来，那由 ① routes 桶和
  // `agent-route-parity` 真机比对兜——它们是行为层判据，不依赖字面量。
  return { count, sites: [...perFile.entries()].map(([f, n]) => `${f} ×${n}`).sort() }
}

function build() {
  return {
    generatedAt: new Date().toISOString(),
    head: execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim(),
    routes: scanRoutes(),
    eventContract: scanEvents(),
    urlCallSites: scanUrls(),
  }
}

/**
 * 比对用的投影：**去掉会随手长、又不承载契约语义的东西**。
 * `events` / `runs` / 每种 kind 的 `count` 都是历史事件的**数量**——生产每跑一单它们就 +1
 *   （实测：收口阶段我自己那单冒烟就把 5 个计数推高了）。而 §7.4 要的等价性判据是
 *   「kind 词表 + 每种 kind 携带的字段集」，数量从来不是。留着它们的效果和留行号一样坏：
 *   中间态一片假红，真回归来时没人再看。基线文件里照旧记录数量（备查），只是不参与 diff。
 *
 * ⚠️ 2026-09-19（ISS-608）把 **`kinds` 整块也移出 diff**，理由是它和 count 同一类：
 *   它是**扫存量 run 文件**得到的观测集合，「某个 kind/字段缺席」只说明**这段时间没人抛出它**，
 *   不说明契约退化。两次实测都栽在这里：`run/error` 一小时内先判「基线漏刷」再判「代码丢了它」，
 *   `ask/question.channel` 则是协议 :247 早就声明过、只是新 run 才带上 —— 两次都是假红。
 *   **不是留空档**：真正该红的方向是「线上出现了没声明的东西」，那条由
 *   `forge-agent-protocol/lib/protocol.test.js`（运行时词表 ⇄ d.ts ⇄ 历史全量实际 kind）守着，
 *   且它天然是非对称的（多出来报红、少观测到不报）。这里 --report 仍把 kind 数打出来供肉眼对。
 */
export const norm = (o) =>
  JSON.parse(JSON.stringify(o, (k, v) => (["generatedAt", "head", "events", "runs", "count", "kinds"].includes(k) ? undefined : v)))

export function diffLines(base, cur) {
  const out = []
  const keyOf = (x) => JSON.stringify(x)
  const cmp = (path, a, b) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      // 用 JSON 串做键：数组成员可能是对象（如 missingPath 的 {file,line,kind}），
      // 直接 includes 是引用比较，会把「完全相同的一项」判成一删一增——假差异比没差异更坏，
      // 它会让人习惯看到红然后忽略，真回归来时同样被忽略。
      const bs = new Set(a.map(keyOf))
      const cs = new Set(b.map(keyOf))
      const removed = a.filter((x) => !cs.has(keyOf(x)))
      const added = b.filter((x) => !bs.has(keyOf(x)))
      if (removed.length) out.push(`- ${path} 少了 ${removed.length} 项：${JSON.stringify(removed).slice(0, 400)}`)
      if (added.length) out.push(`+ ${path} 多了 ${added.length} 项：${JSON.stringify(added).slice(0, 400)}`)
      return
    }
    if (a && typeof a === "object" && b && typeof b === "object") {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) cmp(`${path}.${k}`, a[k], b[k])
      return
    }
    if (keyOf(a) !== keyOf(b)) out.push(`~ ${path}: ${keyOf(a)} → ${keyOf(b)}`)
  }
  cmp("", base, cur)
  return out
}

// ─── CLI：只有被直接执行时才跑（导入这些函数做单测，不能顺手扫全仓 + process.exit）
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    const arg = process.argv[2] || "--check"
    const data = build()
    if (arg === "--write") {
      mkdirSync(join(REPO, "scripts", "baseline"), { recursive: true })
      writeFileSync(BASELINE, `${JSON.stringify(data, null, 2)}\n`)
      console.log(`✓ 基线已写入 ${relative(REPO, BASELINE)}`)
      console.log(`  路由 ${data.routes.total} 条（agent 域 ${data.routes.agent.length}）· 漏 path ${data.routes.missingPath.length} 处`)
      console.log(`  事件 ${data.eventContract.events} 条 / ${data.eventContract.runs} 个 Run · kind ${Object.keys(data.eventContract.kinds).length} 种`)
      console.log(`  URL 字面量 ${data.urlCallSites.count} 处`)
      process.exit(0)
    }
    if (arg === "--selftest") {
      // 反向验证：从没红过的守卫等于没有守卫（本仓为假绿/恒绿门禁付过学费）。两向都要验：
      //   该红必须红（少一条路由 / 少一种 kind / 少一处 URL 落点），不该红不许红（纯计数变化）。
      // 两条实现约束（都是这轮诊断出来的，别再踩）：
      //   · 变异要作用在**未投影**的数据上 —— norm 会把 events/runs/count 这些键整个剔除，
      //     在投影结果上加计数等于凭空造出一个新键，测的就不是「计数不参与 diff」了；
      //   · 样本为空时变异是 no-op，必须显式算「跳过」而不是「通过」（空数组骗过一次断言）。
      const raw = data
      const ts = loadTs()
      const normOf = (o) => norm(JSON.parse(JSON.stringify(o)))
      const cur = normOf(raw)
      const clone = () => JSON.parse(JSON.stringify(raw))
      const cases = []
      // 注册路径的写法必须**全部**解析得出来（ISS-715 端点归一新增第三种：`path: EP.key` 走同包端点表）。
      // 解析不出来的后果是"静默少采"⇒ 功能面把在架路由报成"功能回归"，而真回归反而看不见
      //（本文件头注就是这一课：2026-09 的 concat 形态踩过一次，这次是第二次）。
      // 兑不出键的情形必须留空串（→ missingPath 桶），不许整条消失。
      const parseAt = (t) => parseRegistrations(join(REPO, "forge-canvas", "lib", "index.js"), t).map((r) => r.path)
      // ⚠️ 期望值**运行时拼**：本文件在盘点的扫描射程内（scripts/*.mjs），把 "/forge-canvas/doc"
      //    写成字面量会当场把 C8/C9b/C10 各顶一格（自扫描陷阱第四次实证 —— 修法永远是改写法，不动上限）。
      const FX = "/forge-" + "x/a"
      const CANVAS_DOC = "/forge-" + "canvas/doc"
      cases.push([
        "注册的三种 path 写法都能解析（字面量 / 表引用 / 兑不出的键留空）",
        parseAt('ws.register({ kind: "exact", path: "' + FX + '" })')[0] === FX &&
          parseAt('ws.register({ kind: "exact", path: EP.doc })')[0] === CANVAS_DOC &&
          parseAt('ws.register({ kind: "exact", path: EP.no_such_key })')[0] === "",
      ])
      const mut = [
        ["routes.agent 少一条路由", (m) => m.routes.agent.shift()],
        ["routes.missingPath 少一项", (m) => m.routes.missingPath.shift()],
        ["urlCallSites.sites 少一处", (m) => m.urlCallSites.sites.shift()],
      ]
      for (const [name, fn] of mut) {
        const before = clone()
        const after = clone()
        fn(after)
        const changed = JSON.stringify(before) !== JSON.stringify(after)
        if (!changed) {
          cases.push([name + " 跳过（当前样本为空，不假装通过）", null])
          continue
        }
        cases.push([name + " 必须判红", diffLines(normOf(after), cur).length > 0])
      }
      cases.push(["同一状态零差异", diffLines(normOf(clone()), cur).length === 0])
      // ── ISS-608 的反向用例：这一类**必须不判红**（缺席/新增都只说明「这阵子有没有人抛过它」）。
      //    两条都取自当天真实假红：run/error 一小时内先「基线漏刷」后「代码丢了它」；
      //    ask/question.channel 是协议已声明、只是新 run 才带上。
      const lessKind = clone()
      const firstKind = Object.keys(lessKind.eventContract.kinds || {})[0]
      if (firstKind) delete lessKind.eventContract.kinds[firstKind]
      cases.push([
        firstKind ? "kinds 少一种不判红（缺席≠回归）" : "kinds 少一种不判红 跳过（当前无 kind 样本）",
        firstKind ? diffLines(normOf(lessKind), cur).length === 0 : null,
      ])
      const moreField = clone()
      const anyKind = Object.keys(moreField.eventContract.kinds || {})[0]
      if (anyKind) moreField.eventContract.kinds[anyKind].fields.push("zz-观测到的新字段")
      cases.push([
        anyKind ? "kinds 字段新增不判红（同上，判据在协议声明侧）" : "kinds 字段新增不判红 跳过（当前无 kind 样本）",
        anyKind ? diffLines(normOf(moreField), cur).length === 0 : null,
      ])
      // ── ISS-779：扫描口径的**三形态正反例**（走真实的 `urlHitsIn`，不吃上面那批克隆数据）。
      //    缺了「注释不计」⇒ 归零不可达（注释写一次 +1），守卫恒红后真回归会被忽略；
      //    缺了「真字面量仍计」⇒ 反向造假红（剥注释剥过了头，真调用点漏掉，迁移静默 404）。
      //    ⚠️ 样本里的前缀**运行时拼**：本文件在盘点射程内，写死字面量会当场顶高 C8/C9b/C10。
      {
        const N = "/forge-pm" + "/agent"
        const hits = (src) => urlHitsIn(ts, "__fx__.tsx", src, N).length
        // ① 注释（行注释 / 块注释 / JSDoc）：三种写法都**不许**计
        cases.push([
          "注释里的旧前缀不计（行注释 / 块注释 / JSDoc）",
          hits(`// 迁出后调 ${N}/dispatch\nconst a = 1\n`) === 0 &&
            hits(`/* ${N}/dispatch */\nconst a = 1\n`) === 0 &&
            hits(`/** 用法：POST ${N}/dispatch */\nconst a = 1\n`) === 0,
        ])
        // ② 真字面量（普通串 / 模板串 / 单引号）：**必须**计 —— 防「剥过头」的反向造假红
        cases.push([
          "真调用点仍计（普通串 / 模板串 / 单引号串 / JSX 文本）",
          hits(`fetch("${N}/dispatch")\n`) === 1 &&
            hits("fetch(`" + N + "/dispatch`)\n") === 1 &&
            hits(`fetch('${N}/dispatch')\n`) === 1 &&
            hits(`const A = () => <div>${N}/dispatch</div>\n`) === 1,
        ])
        // ③ 自检夹具：落在 `selftest*` 函数体内的字面量**不计**（结构判据，不是路径正则）；
        //    同一个词写在普通函数里**仍要计** —— 否则就是「按路径圈地放宽判据面」（Z2 / ISS-654 那一课）。
        cases.push([
          "自检夹具里的路径不计（同一词在普通函数里仍计）",
          hits(`function selftest() {\n  const fake = "${N}/dispatch"\n  return fake\n}\n`) === 0 &&
            hits(`function realCaller() {\n  fetch("${N}/dispatch")\n}\n`) === 1 &&
            hits(`function selftest2() {\n  const fake = "${N}/dispatch"\n}\nfunction realCaller() {\n  fetch("${N}/real")\n}\n`) === 1,
        ])
      }
      const counts = clone()
      counts.eventContract.events += 99999
      counts.eventContract.runs += 7
      if (typeof counts.urlCallSites.count === "number") counts.urlCallSites.count += 5
      for (const k of Object.keys(counts.eventContract.kinds || {})) counts.eventContract.kinds[k].count = 12345
      cases.push(["纯计数变化不许判红", diffLines(normOf(counts), cur).length === 0])
      let bad = 0
      let skipped = 0
      for (const [name, ok] of cases) {
        if (ok === null) {
          console.log("- " + name)
          skipped++
          continue
        }
        console.log((ok ? "✓ " : "✗ ") + name)
        if (!ok) bad++
      }
      const passed = cases.length - bad - skipped
      console.log(
        bad
          ? "✗ 守卫自检失败 " + bad + " 项（通过 " + passed + "，跳过 " + skipped + "）"
          : "✓ 守卫自检 " + passed + " 项全过、跳过 " + skipped + " 项（该红能红、不该红不红）",
      )
      process.exit(bad ? 2 : 0)
    }

    if (!existsSync(BASELINE)) {
      console.error("✗ 基线不存在，先跑 --write（迁移前跑，见 DOC-256 §7.0 ⓪b）")
      process.exit(2)
    }
    const base = JSON.parse(readFileSync(BASELINE, "utf8"))
    const d = diffLines(norm(base), norm(data))
    if (!d.length) {
      console.log(`✓ 与基线一致（路由 ${data.routes.agent.length} 条 agent 路径 / 词表 ${Object.keys(data.eventContract.kinds).length} / URL 落点 ${data.urlCallSites.count}）`)
      process.exit(0)
    }
    console.log(`与基线有 ${d.length} 处差异：`)
    for (const line of d) console.log(`  ${line}`)
    process.exit(2)
}
