#!/usr/bin/env node
/* 数据根取法守卫（ISS-938 架构线 · 10-02）
 *
 * 一句话：「这台机器的 DSH 家目录在哪」这件事只许有一处实现。
 *
 * 为什么要立：项目同时存在两个 home —— 老 web 盘 ~/.dsh 与桌面端生产盘 ~/.dsh-matter（AGENTS.md §0.5），
 * 分流靠 DSH_HOME。内核早有正解（forge-service-kit/fs 的 dshHome()/dshPath()），但各插件仍各抄一遍
 * join(process.env.DSH_HOME || defaultDshHome(), "某域") 或 join(homedir(), ".dsh", …)。
 * 抄写的代价不是难看，是漏抄/抄歪就静默读错根 —— 10-02 真栽了两次：
 *   · 出码侧只认旧根 ⇒ 读到旧引擎那份 theme（没有 --dsw-radius-*）⇒ 颜色/圆角静默出裸值，
 *     还记一条"官方没这档"的假借口；
 *   · 同一脚本里"读 theme 用候选、读文档却手写旧根"⇒ 两套口径并存。
 * 两处形状一样：一份语义被抄成多份，漂了的那份不报错。
 *
 * 口径（与 docs/code.md 的 K6a 同族，对象换成"取根"）：
 *   违例 A hand-rolled-root：站点自己写 `DSH_HOME ||` 回落 ⇒ 该用 dshHome()/dshPath()；
 *   违例 B literal-dsh-home：站点自己拼 `homedir(), ".dsh"` ⇒ 该用内核 defaultDshHome()/dshPath()。
 *   例外按文件写死 + 必须带理由（改名即新增违例）；名单里指不到命中的会被报成"待摘"，防止变永久后门。
 * 棘轮：**只拦新增**。基线 scripts/baseline/data-root.json 记今天的存量（多为别的包与测试参照实现），
 *   存量收敛后用 --write-baseline 压低（压低是成绩；抬高要在提交说明里给理由）。
 * PM 根（FORGE_PM_ROOT || defaultDshHome()/pm）不归本守卫管：那是"刻意不认 DSH_HOME"的历史口径，
 *   被 forge-service-kit/lib/fs-roots.test.js 明确钉住"两种口径不许统一"，在这儿统一它才是越权。
 *
 * 用法：node scripts/data-root-check.mjs [--check|--json|--verbose|--selftest|--write-baseline]
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { 读基线 } from "./baseline-read-lib.mjs"
import { WORKTREE_DIR_NAMES, WORKTREE_PATH_RE } from "./wt-exclude-lib.mjs" // ISS-724：工作树落点的唯一真相源

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const BASELINE = path.join(ROOT, "scripts", "baseline", "data-root.json")
const ARGV = process.argv.slice(2)
const SKIP_DIR = (n) => ["node_modules", "dist", "out", "static", "public", "assets", ".git", ...WORKTREE_DIR_NAMES].includes(n)
const SKIP = /(\/node_modules\/|\/dist\/|\.generated\.|~\d{3,})/

/** 例外名单：路径 → 理由。没有理由的例外等于没有守卫 */
export const 例外表 = new Map([
  ["forge-service-kit/lib/fs-roots.test.js", "等价性参照实现：故意逐字抄收口前的旧式写法来比对，删了就等于毁掉证据"],
  ["electron-shell/bridge-auth.js", "桥令牌按约定固定在 ~/.dsh/browser-bridge.token（与授权文件同根，不随 DSH_HOME 漂移）"],
  ["forge-agents/scripts/migrate-agents-root.mjs", "搬迁脚本按定义必须能指到旧根：默认值就是旧根才有意义（运行时打印实际 FROM/TO）"],
])

const toRel = (f, root) => path.relative(root, f).split(path.sep).join("/")

const relOf = (f) => {
  const r = toRel(f, ROOT)
  // 自检 fixture 在 tmpdir 下（../../…/forge-x/lib/a.js）⇒ 取末尾三段，让例外名单在 fixture 上也生效
  return r.startsWith("..") ? r.split("/").slice(-3).join("/") : r
}

/* SKIP 的作用对象是**相对 ROOT** 的路径，不是绝对路径（ISS-702）。
 * 事故形态：本仓的工作树被放在 <主checkout>/.wt/<ISS>/ 下，于是「根自身」就含 /.wt/；
 * 判据若看绝对路径，则该树里每个文件的绝对路径都含 /.wt/ ⇒ 全被滤掉 ⇒ 扫到 0 文件 ⇒ fail closed 恒红。
 * 判据的本意是「跳过仓库内嵌的 .wt/ 子目录」，而非「跳过位于 .wt/ 之下的根」。
 * ⇒ 换作用对象，不删判据：主 checkout 里内嵌的 .wt/ 仍按相对路径被跳过（自检有对应用例守着）。 */
export const 应跳过 = (f, root = ROOT) => {
  const rel = toRel(f, root)
  // ISS-724：工作树落点由共享名单判（`.wt` 与两段的 `.agents/worktrees` 都在里面）。
  // 不能只靠上面那行 SKIP 正则里写死的 `\/\.wt\/`：新落点是两段，搬家后整整一个池子会漏进来。
  // 注释里保留 `.wt` 的原意（ISS-702）：**内嵌**的 `.wt/` 仍跳过，而「根自身在 `.wt/` 之下」不跳过
  // —— 判据看的是相对路径，所以两者天然分得开。
  return WORKTREE_PATH_RE.test("/" + rel) || SKIP.test("/" + rel)
}

const RE_A = /(?:process\.env|env)\.DSH_HOME\s*\|\|/
const RE_B = /homedir\(\)\s*,\s*["']\.dsh["']/
const 是注释行 = (l) => /^\s*(\/\/|\*|\/\*)/.test(l)
const 只看代码 = (l) => l.split("//")[0]

export function scanSelf(files, 名单 = 例外表) {
  const 违例 = []
  for (const f of files) {
    const rel = relOf(f)
    if (!fs.existsSync(f) || 名单.has(rel)) continue
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (是注释行(line)) return
      const code = 只看代码(line) // 行尾注释不算判据对象（第一版就是被自己那句"与旧写法 || 等价"的说明判了红）
      if (RE_A.test(code)) 违例.push({ file: rel, line: i + 1, kind: "hand-rolled-root", detail: "自己写 DSH_HOME || 回落 ⇒ 改用 dshHome()/dshPath()（取根只留一份）" })
      if (RE_B.test(code)) 违例.push({ file: rel, line: i + 1, kind: "literal-dsh-home", detail: "自己拼 homedir(), \".dsh\" 字面量 ⇒ 改用内核 defaultDshHome()/dshPath()" })
    })
  }
  return 违例
}

/** 例外不许变成永久后门：名单里指不到任何命中的，报出来让人摘 */
export function scanStale(files, 名单 = 例外表) {
  const 命中 = new Set()
  for (const f of files) {
    if (!fs.existsSync(f)) continue
    fs.readFileSync(f, "utf8").split("\n").forEach((line) => {
      if (是注释行(line)) return
      const code = 只看代码(line)
      if (RE_A.test(code) || RE_B.test(code)) 命中.add(relOf(f))
    })
  }
  return [...名单.keys()].filter((k) => !命中.has(k))
}

const 扫文件 = () => {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!SKIP_DIR(e.name) && !应跳过(p)) walk(p) }
      else if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && !应跳过(p)) out.push(p)
    }
  }
  for (const pkg of fs.readdirSync(ROOT)) {
    if (!/^(forge-|matter|vscode-|electron-)/.test(pkg)) continue
    const dir = path.join(ROOT, pkg)
    if (fs.existsSync(dir)) walk(dir)
  }
  return out
}

const 键 = (v) => v.file + "#" + v.kind

if (ARGV.includes("--selftest")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "data-root-"))
  const mk = (name, body) => { const p = path.join(dir, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p }
  const bad = mk("forge-x/lib/index.js", 'const R = join(process.env.DSH_HOME || defaultDshHome(), "forge-x")\nconst L = join(homedir(), ".dsh", "pm")\n')
  const clean = mk("forge-y/lib/index.js", 'const R = dshPath("forge-y")\nconst Q = dshHome()\n')
  const commented = mk("forge-z/lib/index.js", '// 说明里提到 process.env.DSH_HOME || defaultDshHome() 只是历史叙述\nconst R = dshPath("forge-z")\n')
  const trail = mk("forge-w/lib/index.js", 'const R = dshPath("forge-w") // 解释：这一份与旧写法的回落语义逐字等价\n')
  // 例外 fixture 必须指向名单里**还在**的一条：ISS-564 前它指 forge-service-kit/lib/fs.js，
  // 而那条已变化石被摘掉（继续指它 = 自检靠一个不存在的例外变绿）。
  const exempt = mk("forge-service-kit/lib/fs-roots.test.js", "const home = process.env.DSH_HOME || defaultDshHome()\n")
  const res = []
  const push = (n, ok, note = "") => res.push({ n, ok: !!ok, note })
  push("A 手写 env 回落必被抓", scanSelf([bad]).some((v) => v.kind === "hand-rolled-root"))
  push("B 字面量 homedir/.dsh 必被抓", scanSelf([bad]).some((v) => v.kind === "literal-dsh-home"))
  push("用内核那份不误伤（干净文件 0 命中）", scanSelf([clean]).length === 0, JSON.stringify(scanSelf([clean])))
  push("整行注释不算违例（否则历史叙述全是假红）", scanSelf([commented]).length === 0, JSON.stringify(scanSelf([commented])))
  push("行尾注释不算违例（我自己第一版就被这句判红过）", scanSelf([trail]).length === 0, JSON.stringify(scanSelf([trail])))
  push("例外名单在 fixture 路径上也生效（按末三段认路）", scanSelf([exempt]).length === 0, relOf(exempt))
  push("例外不许变化石：名单里指不到命中要报出来", scanStale([clean, commented, trail, bad, exempt]).length > 0)

  // ISS-702：SKIP 的三种盘面。第二行是**原意**（主 checkout 不重复扫内嵌工作树），
  // 第三行是本单修的假红（根自身就在 .wt/ 之下）。两行必须同时成立 ——
  // 删掉 `\/\.wt\/` 判据能过第三行却会破坏第二行；把判据换回绝对路径能过第二行却破坏第三行。
  const MAIN = path.join(dir, "main")
  const MAINWT = path.join(MAIN, ".wt", "ISS-x")
  push("SKIP 盘面①：主 checkout 里的正常文件不跳过", !应跳过(path.join(MAIN, "forge-pm/lib/x.mjs"), MAIN))
  push("SKIP 盘面②：主 checkout 里内嵌的 .wt/ 仍跳过（原意不许丢）", 应跳过(path.join(MAINWT, "forge-pm/lib/x.mjs"), MAIN))
  push("SKIP 盘面③：.wt/ISS-x 自身为根时不跳过（本单的假红）", !应跳过(path.join(MAINWT, "forge-pm/lib/x.mjs"), MAINWT))
  // ISS-724：新落点 `.agents/worktrees`（两段）—— 名字级 SKIP_DIR 看不出来，靠路径判据兜。
  const MAINNEST = path.join(MAIN, ".agents", "worktrees", "ISS-y")
  push("SKIP 盘面④：内嵌的 .agents/worktrees/ 跳过（新落点）", 应跳过(path.join(MAINNEST, "forge-pm/lib/x.mjs"), MAIN))
  push("SKIP 盘面⑤：.agents/worktrees/ISS-y 自身为根时不跳过", !应跳过(path.join(MAINNEST, "forge-pm/lib/x.mjs"), MAINNEST))
  push("SKIP 盘面⑥：.agents/skills/ 不是工作树，不许误杀", !应跳过(path.join(MAIN, ".agents", "skills", "reviewer", "a.js"), MAIN))
  const fails = res.filter((r) => !r.ok)
  for (const r of res) console.log((r.ok ? "✓ " : "✗ ") + r.n + (r.note ? "（" + r.note + "）" : ""))
  console.log("data-root-check selftest " + (res.length - fails.length) + "/" + res.length + " 通过")
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(fails.length ? 2 : 0)
}

const files = 扫文件()
if (files.length === 0) { console.error("✗ 没扫到任何文件（ROOT=" + ROOT + "）⇒ fail closed，不许当成\"零违例\""); process.exit(2) }
const 违例 = scanSelf(files)
const 化石 = scanStale(files)

if (ARGV.includes("--write-baseline")) {
  const 存量 = {}
  for (const v of 违例) 存量[键(v)] = v.file + ":" + v.line + " " + v.kind
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify({ recordedAt: new Date().toISOString().slice(0, 10), tool: "data-root-check.mjs --write-baseline", 存量 }, null, 1) + "\n")
  console.log("已记基线 " + Object.keys(存量).length + " 条（存量不再拦；新增一律红）。以后压低它才是成绩。")
  process.exit(0)
}

const 基线 = 读基线(BASELINE)
const 新增 = 基线 ? 违例.filter((v) => !基线.存量[键(v)]) : 违例
for (const v of 新增) console.log("✗ " + v.file + ":" + v.line + " " + v.kind + " —— " + v.detail)
if (!基线) console.log("✗ 还没有基线（" + BASELINE + "）⇒ 先跑 --write-baseline 记存量，不许当\"没有欠账\"")
for (const k of 化石) console.log("○ 例外待摘：" + k + " 已不再命中任何取根写法 ⇒ 从名单删掉（留着就是给未来的违例开后门）")
if (ARGV.includes("--verbose")) for (const [k, why] of 例外表) console.log("  例外 " + k + " —— " + why)
if (ARGV.includes("--json")) { console.log(JSON.stringify({ 文件数: files.length, 全量命中: 违例.length, 新增, 例外待摘: 化石, 基线条数: 基线 ? Object.keys(基线.存量).length : null }, null, 1)); process.exit(基线 && 新增.length === 0 ? 0 : 2) }
console.log("data-root-check · 扫 " + files.length + " 文件 · 全量命中 " + 违例.length + " · 基线外新增 " + 新增.length + " · 例外 " + 例外表.size + "（待摘 " + 化石.length + "）")
process.exit(基线 && 新增.length === 0 ? 0 : 2)
