#!/usr/bin/env node
// impact-of-diff —— 把 git diff 的 hunk 映射成「符号 + 反向依赖 + 该跑哪几条闸」（ISS-621）
// 用法：node scripts/impact-of-diff.mjs [--range A..B|--base <ref>] [--staged] [--json] [--verbose] [--quiet]
//                                       [--changed-only|--only-impacted] [--no-cache] [--self-test]
//       node scripts/impact-of-diff.mjs --who-imports <相对路径…> [--depth N] [--quiet] [--changed-only]
//
// ISS-637（2026-10-22）工程优化，7 项，均有实测依据：
//   ① 缓存落点 `~/.cache/` → `<ROOT>/.git/impact-cache/`（前者在 agent sandbox 下不可写 ⇒ 永远冷启动 2s）；
//   ② 缓存不命中/写失败**不许静默** —— 盘上 v1 对代码 v2 曾静默永不命中；
//   ③ `--depth N` 二阶及以上（原来只能看直接 importer）；④ who-imports 认 `--changed-only`/`--only-impacted`；
//   ⑤ 分组截断保底 20（原来每组 5，59 个 importer 看不出分布）；⑥ `--quiet` 只出结论行（页脚口径占过 35%）；
//   ⑦ 未跟踪新文件两处可见 + 未知 `--xxx` exit 2（原来被静默吞掉后退回默认 diff 模式）。
// ⛔ 不做：根定位参数化 / CALLS 图 / 风险分级（前两者实测不可判，理由见 analyze 与文件头注释）。
//
// ⚠️ 输出是**影响面估计**，不是完整影响分析。宣称"完整"就是造假。
//   ① 只做一阶反向 import 文件图（谁 import 我），不做 CALLS 图：实测 2185 个函数/类名里 78 个（3.6%）同名跨文件、
//      `evt` 一名 70 个调用点跨 3 文件 ⇒ 按名字连调用关系会**静默错**。谁调我 ≈ 谁 import 我，一阶够用且不会假。
//   ② 成员访问与动态调用解析不到符号 ⇒ 输出尾部**必须**看「未解析 N 处」。
//   ③ 每次现算、不建索引（实测 1215 文件 <1s；缓存比现算贵且会腐坏）。④ 不做风险分级（分级规则不可判 = 假精度）。
//   ⑤ 只认 TS/TSX/JS；非源码与打包产物只报到文件级。⑥ 盲区与本 diff 分两笔账，见 analyze 尾部。
// 解析器借仓库已有 typescript（零新依赖）。不用 createProgram（实测 1381ms + checker 1478ms）；
// 逐文件 createSourceFile 且 setParentNodes=false（809ms → 566ms；getStart/getEnd 已验不受影响）。
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import cryptoMod from "node:crypto"
import { execFileSync } from "node:child_process"

const ROOT = path.resolve(import.meta.dirname, ".."), A = process.argv.slice(2)
const has = (f) => A.includes(f), val = (f, d) => { const i = A.indexOf(f); return i < 0 ? d : A[i + 1] }
const VERBOSE = has("--verbose"), JSONOUT = has("--json"), MAX_HUNK = VERBOSE ? Infinity : 12, MAX_DEP = VERBOSE ? Infinity : 8
/** ISS-621 ③：反向依赖 0 的文件不列明细（38 个文件里大半是它们，明细把人埋了）。尾部报总数，不许静默。
 *  ISS-637 ④：who-imports 模式此前没有等价物 —— 反向依赖 0 的目标仍独占位置。`--only-impacted` 是别名，
 *  语义与 `--changed-only` 一致（同一条判据，不给两个实现）。 */
const CHANGED_ONLY = has("--changed-only") || has("--only-impacted")
/** ISS-637 ⑥：`--quiet` 只出结论行（页脚口径说明固定占 120 tok，案例 A 里占输出 35%，批量调用累积）。 */
const QUIET = has("--quiet")
/** ISS-637 ⑤：分组截断保底 20（原来每组 5，59 个 importer 只给 5 个 ⇒ 判断不了分布）。 */
const GROUP_MIN = 20

/* ISS-637 ⑦：**未知参数显式报错**。实测 `--find pmRead` / `--files x.ts` 曾被静默吞掉、悄悄退回默认
   diff 模式 —— 调用方会当成「工具查过了，没事」，这是本工具立单时最反对的静默形态（比报错危险）。
   已知参数表是唯一真相源：`--boundary` 曾是注释里承诺过、代码里从未实现的形态，一并从表里去掉。 */
const KNOWN_FLAGS = new Set([
  "--range", "--base", "--staged", "--json", "--verbose", "--quiet",
  "--changed-only", "--only-impacted", "--no-cache", "--self-test",
  "--who-imports", "--depth", "--callers", "--call-graph", "--limit",
])
function unknownFlags(argv) {
  return argv.filter((a) => typeof a === "string" && a.startsWith("--") && !KNOWN_FLAGS.has(a))
}
/** `--depth N` 解析（纯函数，便于自测直接喂数组）。缺省 1 = 现有行为一字不变。
 *  值非整数或 <1 ⇒ 返回 err 由调用方 exit 2 —— 静默当 1 会让「我查了二阶」变成假话。 */
function parseDepth(argv) {
  const i = argv.indexOf("--depth")
  if (i < 0) return { depth: 1 }
  const raw = argv[i + 1]
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return { depth: null, err: `--depth 需要一个 ≥1 的整数，收到 ${JSON.stringify(raw ?? null)}` }
  return { depth: n }
}
const _unknown = unknownFlags(A)
if (_unknown.length) {
  console.error(`✗ 未知参数 ${_unknown.join(" ")}\n  已知参数：${[...KNOWN_FLAGS].join(" ")}\n  参数写错不许静默退回默认模式 —— 那会让人以为「已经查过了」。`)
  process.exit(2)
}
const _depth = parseDepth(A)
if (_depth.depth === null) { console.error(`✗ ${_depth.err}\n  用法：--depth <N>，N≥1，缺省 1（只看直接 importer）`); process.exit(2) }
const DEPTH = _depth.depth
const NO_CACHE = has("--no-cache")
const SKIP_DIR = new Set(["node_modules", "dist", "out", "build", ".git", ".wt", ".tmp", ".bun-tmp", "static", "mockups", "vendor", "coverage", ".next", ".dsh"])
const FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
/** 打包/第三方产物：与 code-inventory 的 VENDOR_NAME 同判据 —— 一行一个压缩函数名，符号定位对它无意义。 */
const VENDOR = /(standalone|tsWorker|monaco|pdfjs|mermaid|bundle|vendor)[.\-/]|\.min\.[cm]?js$/
const pkgOf = (rel) => (/^((?:forge-|matter)[^/]*)\//.exec(rel) || [])[1] || null
/** who-imports 的处置分组判据。**提到模块级**（ISS-637 返工 F1）：自测要用同一份判据算「某个目标
 *  的同包组有多大」，才能预测渲染该列几行。若自测在本地再写一遍分组逻辑，就变成「验自己实现的假设」
 *  而不是「验生产行为」—— 那是本仓 ISS-993 踩过的坑。生产与自测共用这一个函数，改判据两边同步。 */
const catOf = (f, pkg) => {
  if (/\.(test|spec)\.[jt]sx?$/.test(f)) return "test"
  if (/\/routes\/|routes\.js$|\/index\.[jt]s$|\/entry\.[jt]s$/.test(f)) return "entry"
  if (pkgOf(f) === pkg) return "samepkg"
  return "cross"
}
const GROUP_LABEL = {
  test: ["测试文件", "改了要复跑这些测试"],
  entry: ["路由 / 入口", "改了要端到端验一遍"],
  samepkg: ["同包库文件", "改了要 typecheck 该包"],
  cross: ["跨包消费方", "改了要回归对端包"],
}
const isTest = (rel) => /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)
/** 多语言是**砍掉**的能力，不是没做完 ⇒ 非 TS/JS 只报到文件级，不许假装分析过。 */
const isCode = (rel) => FILE_RE.test(rel) && !VENDOR.test(rel)

/** 打包产物识别（ISS-621 ① · 2026-10-20 实战反馈）——**按内容判，不按文件名**。
 *
 * 为什么不能只靠文件名：`forge-canvas/lib/canvas-core.js` 是 esbuild 出来的单文件产物，名字里
 * 没有任何 vendor / min / bundle 字样，上面那条 `VENDOR` 正则放它过去 ⇒ 输出 `触_()` / `吸_2()` /
 * `作_()` 这类**压缩后的名字**，零定位价值（实测它的 7 处 hunk 全部落在压缩函数里）。
 *
 * 两个信号，任一命中即判产物：
 *   A. **打包器的 banner 注释**：出现 ≥2 行「`// ../../…/node_modules/…`」。
 *      为什么这条硬：那是打包器逐模块写下的来源路径，**正常手写源码不会成片出现这种注释**
 *      （实测 canvas-core.js 8 条；对照 `entity-ops.js` / `agent-tools.js` / `index.js` /
 *      `providers.js` 全是 0 条）。
 *      ⚠️ 正则必须容忍中间夹仓库名：本仓实测形态是 `// ../../../../dsh-forge/node_modules/…`
 *      —— 第一版写死 `(?:\.\./)+node_modules/` 就这样漏掉了整个文件（自测的假用例没夹仓库名，
 *      所以自测绿而实战漏 —— 教训：**判据要用真实样本验，不能只用自己编的样本**）。
 *      阈值 ≥2 而非 ≥1：单条可能是人手写的引用注释（实测正常源码 0 条，留一档余量）。
 *   B. **压缩单行**：全文最长行 > 2000 字符 **且** 文件 > 256KB。
 *      两个条件必须同时成立 —— 单纯长行可能是 base64 / 数据表（正常源码里就有），
 *      单纯大文件可能是正常大模块。
 *      注：canvas-core.js 是「打包但不压缩」（207KB / 6635 行 / 最长行 718），所以它靠信号 A 命中，
 *      不依赖 B —— B 留给真正 minify 过的产物。
 *
 * 判据纪律：不按扩展名、不按目录、不采第三方的「看起来像压缩」启发式 —— 每条都要能被复算。
 * ⚠️ 判为产物后**仍要算反向依赖**（谁 import 它这件事与它是不是产物无关），只是不报符号。
 */
const PROD_BANNER_RE = /^\/\/ (?:\.\.\/)+.*?node_modules\//gm
function isProd(src) {
  const banner = (src.match(PROD_BANNER_RE) || []).length
  if (banner >= 2) return `打包器 banner ×${banner}`
  if (src.length > 256 * 1024) {
    let max = 0, cur = 0
    for (let i = 0; i < src.length; i++) { if (src.charCodeAt(i) === 10) { if (cur > max) max = cur; cur = 0 } else cur++ }
    if (cur > max) max = cur
    if (max > 2000) return `压缩单行 ${max} 字符 · ${Math.round(src.length / 1024)}KB`
  }
  return null
}

/** 从 argv 取「一个 flag 后面的全部非 flag 参数」（ISS-621 ②：--who-imports 支持多路径）。
 * 拆成纯函数是为了自测能直接喂数组 —— 读模块级 A 的函数没法测。 */
function parseVals(argv, flag) {
  const i = argv.indexOf(flag)
  if (i < 0) return []
  const out = []
  for (let j = i + 1; j < argv.length; j++) { if (String(argv[j]).startsWith("--")) break; out.push(argv[j]) }
  return out
}

function loadTs() {
  for (const c of ["forge-ui/node_modules/typescript", "forge-pm/node_modules/typescript", "node_modules/typescript"]) {
    const abs = path.join(ROOT, c)
    if (!fs.existsSync(abs)) continue
    try { return { ts: createRequire(path.join(abs, "package.json"))("typescript"), from: c } } catch { /* 换下一个候选 */ }
  }
  console.error("✗ 找不到 typescript（试过 forge-ui / forge-pm / root 的 node_modules）—— 拒绝降级成正则凑的口径：那样「谁 import 我」会静默错。先装依赖再跑。")
  process.exit(2)
}
const { ts, from: TS_FROM } = loadTs()
/* ISS-658：调用图（符号级反向调用）实现在同目录 sibling 里，用依赖注入接进本文件 —— 见"4b / 8c 已抽到"那段注释放。 */
import { makeCallGraph } from "./impact-of-diff-calls.mjs"
const SKIND = { ".ts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX, ".js": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX, ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS }

/* 1. 扫描面：与 code-inventory 同一条 SKIP 纪律（ISS-561：排除判据只吃仓根相对路径） */
function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, acc) } else if (FILE_RE.test(e.name)) acc.push(p)
  }
  return acc
}
function scanFiles() {
  const out = []
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) if (e.isDirectory() && /^(forge-[a-z0-9-]+|electron-shell)$/.test(e.name)) walk(path.join(ROOT, e.name), out)
  return walk(path.join(ROOT, "scripts"), out).map((p) => path.relative(ROOT, p).split(path.sep).join("/"))
}
const PKGJSON = new Map()
const pkgJson = (p) => { if (!PKGJSON.has(p)) { try { PKGJSON.set(p, JSON.parse(fs.readFileSync(path.join(ROOT, p, "package.json"), "utf8"))) } catch { PKGJSON.set(p, {}) } } return PKGJSON.get(p) }

/* 2. 说明符解析：判据照抄 code-inventory:resolveSpec（相对候选 + forge-* 包 exports），不改它的口径。
   返回 null = 解析不到（外部包 / 非源码 / 动态说明符）。 */
const CAND = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"]
const hit = (base, fileSet) => { for (const c of CAND) if (fileSet.has(base + c)) return base + c; return null }
function resolveSpec(fromRel, spec, fileSet) {
  if (!spec) return null
  if (spec.startsWith(".")) return hit(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)), fileSet)
  if (/^node:/.test(spec) || !/^(forge-|matter)/.test(spec)) return null
  const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
  const sub = spec.slice(bare.length + 1), pj = pkgJson(bare)
  if (sub && pj.exports) {
    const m = pj.exports["./" + sub] || pj.exports["./*"]
    const def = typeof m === "string" ? m : m && (m.types || m.default || m.import)
    if (def) { const c = hit(path.posix.normalize(bare + "/" + String(def).replace(/^\.\//, "").replace(/\*$/, sub)), fileSet); if (c) return c }
  }
  if (!sub) return hit(bare + "/src/index.ts", fileSet) || hit(bare + "/lib/index.js", fileSet) || hit(bare + "/index.js", fileSet)
  for (const p of [bare + "/" + sub, bare + "/src/" + sub, bare + "/lib/" + sub]) { const c = hit(p, fileSet); if (c) return c }
  return null
}

/* 3a. 解析结果索引（ISS-621 优化：解析占全部耗时 91%，实测 1.06ms/文件）
 *
 * 为什么加索引：每次查询都重建图 = 1223 文件 × 1.06ms ≈ 1.3s。
 * 审查员/builder 一天要查几十次 ⇒ 现算的成本是「查询次数 × 1.3s」。
 * 索引后单次查询 ≈ 50ms（读 JSON），**10 次查询从 13s 降到 1.4s**。
 *
 * 失效判据：文件 (mtimeMs, size) 签名。任一变化 ⇒ 该文件重解析，其余读缓存。
 * **不用内容哈希**：读全仓算哈希与解析同量级，省不了；mtime+size 足以识别编辑（写入必改 mtime）。
 *
 * 持久化位置（ISS-637 ① 改）：`<ROOT>/.git/impact-cache/<rootHash>.json`。
 * **为什么从 `~/.cache/` 搬过来**：agent 跑在 sandbox 下，`~/.cache` **不可写** ⇒ 每次写盘静默失败、
 * 每次都是冷启动（实测 1.95s）。改到 `.git/` 下（实测可写、且 `.git` 不进 git status，不脏工作区）后
 * 实测 1.95s → 0.14s，约 13 倍。仓内写 ⇒ 天然跟着仓库走，换 checkout 不会读到别的仓库的旧答案。
 *
 * ⚠️ 缓存不命中/写失败**不许静默**（ISS-637 ②）：盘上曾长期是 `version: 1` 而代码是 2 ⇒ 永不命中
 * 且一声不响，看起来「缓存没生效但也不知道为什么」。现在版本不匹配与写失败都走 stderr，
 * 页脚固定报 `缓存 命中 / 未命中（原因）`。仍然**不阻断**（工具可用性优先），但不再无声。
 */
/* v2（ISS-621 ①）：facts 新增 `prod` 字段 ⇒ 旧缓存的 facts 没有它，必须整段失效重算。
   不 bump 的后果：产物识别对已缓存文件永不生效（缓存「看起来更快」但答案是旧的）。
   v3（ISS-656）：span 放宽到顶层 `const/let/var` + 新增 `exported` 字段 ⇒ 同一条理由：
   旧缓存里每个文件的 spans 都是「只有函数」的旧口径，不 bump 就**永远不重算**、
   wiki 索引照样几百条 module-scope 缺口，而且看不出为什么（v1→v2 就是这么静默的）。
   ⚠️ `forge-repowiki/lib/symbols.js` 有一份必须对齐的副本，两处不同步 ⇒ 读缓存一律「版本不匹配」，
   整份索引会被 build-index 的 C3 守卫判成「符号全空」（2026-10-25 实测拦下过）。
   v4（ISS-658）：facts 新增 `imports` / `calls` / `dropped` 三字段（符号级反向调用）。
   同一条理由：旧缓存里没有它们 ⇒ 不 bump 就**永远算出 0 条 calls 边**，而 0 看起来像
   「这个仓没人互相调用」—— 静默且荒谬。 */
const INDEX_VERSION = 4
const sigOf = (abs) => { try { const s = fs.statSync(abs); return `${Math.round(s.mtimeMs)}:${s.size}` } catch { return null } }
/** 缓存根：仓内 `.git/impact-cache`。取不到 `.git`（工作树里 `.git` 是文件；或者不是 git 仓）
 *  就退回 `~/.cache` —— 退路不是静默降级，`cacheStatus.dir` 会报实际用了哪个，页脚可见。 */
function cacheDir() {
  let gitDir = null
  try { gitDir = execFileSync("git", ["-C", ROOT, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 20 }).trim() } catch { /* 不是 git 仓 */ }
  if (gitDir) return path.join(gitDir, "impact-cache")
  return path.join(process.env.HOME || "/tmp", ".cache", "impact-of-diff")
}
const CACHE_DIR = cacheDir()
const cachePath = () => path.join(CACHE_DIR, cryptoMod.createHash("sha1").update(ROOT).digest("hex").slice(0, 16) + ".json")
/** 缓存状态：页脚据此报「命中/未命中」与原因。**每次运行都算出来，不许猜**。 */
const cacheStatus = { state: "未用", why: "", dir: CACHE_DIR }

let _index = null
/** 只给自测用：清掉模块级索引缓存，让下一次 loadIndex() 真去读盘。
 *  没有它就无法「先写一个坏版本缓存，再验 loadIndex 的状态」—— 而那个行为正是 ② 的判据。 */
function resetIndexForTest() { _index = null }
function loadIndex() {
  if (_index) return _index
  _index = { version: INDEX_VERSION, files: {} }
  if (NO_CACHE) { cacheStatus.state = "已关闭"; cacheStatus.why = "--no-cache"; return _index }
  const p = cachePath()
  let raw
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")) }
  catch (e) {
    cacheStatus.state = "未命中"
    cacheStatus.why = e.code === "ENOENT" ? "无缓存文件（首跑，本跑会写入）" : `读取失败 ${String(e.code || e.message).slice(0, 40)}`
    return _index
  }
  if (!raw || raw.version !== INDEX_VERSION) {
    /* ISS-637 ②：这一条就是当年静默的现场 —— v1 对 v2，永不命中且没人知道。现在明说。 */
    cacheStatus.state = "未命中"
    cacheStatus.why = `版本不匹配（盘上 v${raw && raw.version} / 代码 v${INDEX_VERSION}，整段重算）`
    console.error(`[impact-of-diff] 缓存版本不匹配：盘上 v${raw && raw.version} ≠ 代码 v${INDEX_VERSION} ⇒ 本次全量重算（不是错误，但旧缓存不再被使用）`)
    return _index
  }
  _index = raw
  cacheStatus.state = "命中"
  cacheStatus.why = `${Object.keys(raw.files || {}).length} 条事实`
  return _index
}
function saveIndex() {
  if (NO_CACHE) return
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cachePath(), JSON.stringify(_index)) }
  catch (e) {
    /* ISS-637 ②：写失败此前只在 IMPACT_DEBUG 下可见（sandbox 下就是永远静默）⇒ 每次都是冷启动而没人知道为什么。 */
    cacheStatus.state = "写入失败"
    cacheStatus.why = String(e.code || e.message).slice(0, 60)
    console.error(`[impact-of-diff] 缓存写入失败（${cacheStatus.why}）@ ${CACHE_DIR} ⇒ 本次结果正确，但下一跑仍是冷启动`)
  }
}

/** 带索引的 factsOf：命中签名即复用，未命中走原 factsOf。**返回形状与 factsOf 完全一致。** */
function factsCached(rel) {
  const idx = loadIndex(), abs = path.join(ROOT, rel), sig = sigOf(abs)
  const ent = idx.files[rel]
  /* 关键：签名命中 ⇒ **不读文件**。旧版由调用方先 readFileSync 再传进来，
     等于每次都读全仓 1215 个文件（~70ms）——缓存只省了「解析」而没省「读盘」。
     实测这 70ms 占缓存路径总耗时 40%。签名比对只需 stat，比读盘便宜一个量级。 */
  if (ent && sig && ent.sig === sig && ent.facts) return ent.facts
  let src
  try { src = fs.readFileSync(abs, "utf8") } catch { src = null }
  if (src === null) return null
  const facts = factsOf(rel, src)
  if (sig) idx.files[rel] = { sig, facts }
  return facts
}

/* 3. 单文件事实：静态 import/export + 字面量动态 import/require（非字面量进盲区）；声明跨度表 */
/** 声明跨度表。**这是全仓唯一的 span 来源**（`forge-repowiki/lib/symbols.js` 明令不许有第二个
 *  TS 解析器 —— 两套口径必然漂，且漂移是静默的：同一行在两套解析器下给出不同符号名，没有测试会红）。
 *
 *  ## ISS-656（2026-10-25）：顶层 `const/let/var` 产不出 span
 *  旧判据只认「变量声明 **且** 初始化器是箭头/函数表达式（或被 memo/forwardRef 包裹）」⇒
 *  `export const X = Object.freeze([...])` / `= 1` / `= require("x")` 全部落到 `return null`，
 *  wiki 锚点落在这些行上被判成 `module-scope`（「落在声明间隙」）—— 把「我们没抽出来」
 *  误报成「这里本来就没符号」。
 *  实测：全仓 592 个 `export const`，函数形态 49 个里 47 个有 span；**非函数形态 542 个里只有 4 个**（漏 99.3%）。
 *  样本 `forge-agent-protocol/lib/index.js` 修复前 16 个 span 全是函数，一个常量都没有（修复后 40 个）。
 *
 *  ## 放宽到哪一档、为什么这么定
 *  ① **非函数初始化形态一律认**，不做「只认 Object.freeze / 字面量 / require」的白名单：
 *     顶层声明就是顶层声明 —— 白名单得跟着写法长（`= new Map()`、`= COND ? a : b`、
 *     模板串、二元表达式…），漏一种就是一次静默缺口，而这类漏永远不会有测试红。
 *  ② **只在模块顶层放宽**（`top`）：函数体里的 `const buf = []` 是局部实现细节，产 span 只会
 *     把 hunk 糊到无关局部变量名上。既有「函数形态任意作用域都认」的行为**一字不变**（只增不减）。
 *  ③ 解构声明（`const { a, b } = obj`，全仓 465 处）**不产 span**：它一次绑多个名字，
 *     取哪个都错。这是已知缺口，不是疏忽。
 *
 *  ## `exported`（ISS-656 要求 ②）
 *  `const http = require("node:http")` 产 span 是对的（它确实是顶层声明），但它是局部句柄、
 *  不是对外契约。判据：**声明的祖先 VariableStatement 有 `export` 修饰符**，或文件里另有
 *  `export { X }` / `export { X as Y }` / `export default X` 指向该本地绑定。
 *  ⚠️ `setParentNodes=false`（性能取舍，见文件头）⇒ 拿不到 `n.parent`，所以「是不是顶层、
 *  有没有 export」只能由递归**带下来**（`top` / `exported` 两个参数），不许改成读 `.parent`：
 *  那样判断会静默恒假（实测：改成 `.parent` 后 span 总数 15131 不变、一个都没多）。
 *
 *  ## spans 元素形状（向后兼容）
 *  `{ name, kind, start, end, exported }` —— 既有四个字段名一个不动（`symbols.js` 的
 *  `symbolForRange` 与 `index-store.js` 的 `symbolSpan` 都在读），只新增 `exported`。
 *  新增字段必须抬 `INDEX_VERSION`（v2 → v3），否则盘上旧缓存静默复用、新 span 永不生效。
 */
function factsOf(rel, src) {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, false, SKIND[path.extname(rel)] || ts.ScriptKind.TS)
  const specs = [], blind = [], spans = [], ln = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  /* ── ISS-658：符号级「谁调它」的两块原料 ──────────────────────────────
     `imports`：本文件每个**本地绑定**来自哪个说明符（`{local, imported, spec}`）。
        · `import { a as b } from "s"` ⇒ {local:"b", imported:"a", spec:"s"}
        · `import * as ns from "s"`   ⇒ {local:"ns", imported:"*", spec:"s"}
        · `import d from "s"`         ⇒ {local:"d", imported:"default", spec:"s"}
        · `const { a } = require("s")` / `const m = require("s")` 同样收（本仓 CJS 不少）
     `calls`：调用表达式的 callee 名 + 行号，**带 evidence 下标**（`ev` 指向 imports）。
       `ev = -1` ⇒ 这个调用**没有 import 证据**（本文件自己定义的函数、`obj.m()`、参数回调…），
       JS/TS 没有跨模块隐式作用域，按名字裸匹配会把同名导出连成假边
       （graphify `extract.py:10871` 的判据；本仓 `apply` 一个名字 48 处定义）。
       这类**不进 calls**（省缓存），只计数 `callsDropped` —— 计数必须报出来，不许静默。 */
  const imports = [], calls = []
  const bindingOf = new Map()
  const addImport = (local, imported, spec) => { if (!local) return; bindingOf.set(local, imports.length); imports.push({ local, imported, spec }) }
  /* `export default` 绑的**本地名**（`export default X` / `export default function foo`）。
     没有它，`import d from "s"; d()` 这条边就永远核不了目标名 —— 而「核不了就不连」是对的，
     但代价是默认导出全丢。记下名字 ⇒ 可核对 ⇒ 能连（`default` 不再是盲区）。 */
  let defaultExport = null
  const isDefault = (n) => !!(n.modifiers && n.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
  const addSpec = (s) => { if (s && !/\.(css|json|svg|png|wasm)$/.test(s)) specs.push(s) }
  /** 节点自带 `export` 修饰符？`export default function f` 也自带 ExportKeyword ⇒ 同一判据。 */
  const hasExport = (n) => !!(n.modifiers && n.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
  /* `export { X }` / `export { local as X }` / `export default X` 里的**本地绑定名**。
     必须收全文件再回填：`export { X }` 与 `const X = 1` 的先后顺序不固定（本仓两种写法都有）。 */
  const localExports = new Set()
  /** 顶层 span 的下标：`export { X }` 只对**顶层**绑定生效（同名的方法/局部变量不许被误标）。 */
  const topSpans = new Set()
  /** 本单**新增**的那一档 span 的下标（非函数形态的顶层变量）。同区间去重只对这档生效。 */
  const relaxedIdx = new Set()
  const decl = (n, top, exported) => {
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isEnumDeclaration(n) || ts.isTypeAliasDeclaration(n)) && n.name) {
      if (isDefault(n)) defaultExport = n.name.text
      return { name: n.name.text, exported: hasExport(n) }
    }
    if (ts.isMethodDeclaration(n) && n.name) return { name: n.name.getText(sf), exported: false }
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || !n.initializer) return null
    const i = n.initializer
    /* memo(...) / forwardRef(...) 包裹的组件：实现藏在实参里，只认箭头/函数表达式会把它整个漏成「模块顶层」。
       实测 KLineChartComponent 就是这么漏的 —— 报成模块顶层看着正常，实则漏了符号（本仓现有 2 处这种写法）。 */
    const wrapped = ts.isCallExpression(i) && /(^|\.)(memo|forwardRef)$/.test(i.expression.getText(sf))
    if (ts.isArrowFunction(i) || ts.isFunctionExpression(i) || wrapped) return { name: n.name.text, exported }
    /* ISS-656：顶层变量声明的其余初始化形态（调用表达式 / 字面量 / require / 任意表达式）。
       任意作用域里的函数形态仍在上一行被认掉 ⇒ 这里只补顶层，不收回任何既有 span。
       `relaxed:true` 标的是**本单新增的那一档**：下面去重只对这档生效，不许碰既有 span。 */
    return top ? { name: n.name.text, exported, relaxed: true } : null
  }
  /** 调用表达式的 callee 名 + 命名空间基名（`ns.fn()` ⇒ {name:"fn", base:"ns"}）。
   *  只认两种形态（**这就是判据的上限，不许放宽到「按名字裸匹配」**）：
   *    · `f(...)`  ⇒ 标识符 f
   *    · `a.f(...)` 且 a 是标识符 ⇒ 属性末段 f（`a` 用来找 import 证据）
   *  链式（`a.b.c()`）与 `this.m()` 一律不产边 —— 抽不到能核对的来源，硬连就是造边。 */
  const calleeOf = (e) => {
    if (ts.isIdentifier(e)) return { name: e.text, base: null }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) && ts.isIdentifier(e.expression)) return { name: e.name.text, base: e.expression.text }
    return null
  }
  /* 未成边的调用计数：`noEvidence`（本文件没有对应 import 证据）与 `dynamic`（callee 形态抽不出名）。
     两者都不进 calls（省缓存），但计数落盘 ⇒ 加载率可核对，不许静默。 */
  const dropped = { noEvidence: 0, dynamic: 0 }
  /** CJS 的「导出名 → 本地名」。**没有它，全仓 CommonJS 文件的调用边会整片消失**：
   *  `module.exports = { corsOriginFor, requestAllowed }` 里 `exported` 位按 ESM 判据恒 false，
   *  于是所有 `require("./bridge-auth")` 的调用都被判成「目标未导出」。
   *  实测（`electron-shell/browser-http-server.js` → `bridge-auth.js`）：graphify 报 3 条真边、我们 0 条，
   *  根因就是这一条 —— 这是召回率的第一大缺口，与「判据松不松」无关。
   *  `local: null` = 导出的就是同名本地绑定（shorthand）；给了名字就能核别名（`{ a: someFn }`）。 */
  const cjsExports = new Map()
  /** 转出口：`export { a as b } from "s"` ⇒ {name:"b", remote:"a", spec:"s"}；`export * from "s"` ⇒ reexportStars。 */
  const reexports = [], reexportStars = []
  const visit = (n, top, exported) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) addSpec(n.moduleSpecifier.text)
      /* ISS-658：本地绑定 → 说明符（判「调用有没有 import 证据」的唯一依据）。 */
      if (ts.isImportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
        const spec = n.moduleSpecifier.text, cb = n.importClause
        if (cb.name) addImport(cb.name.text, "default", spec)
        const nb = cb.namedBindings
        if (nb && ts.isNamespaceImport(nb)) addImport(nb.name.text, "*", spec)
        else if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) addImport(el.name.text, el.propertyName ? el.propertyName.text : el.name.text, spec)
      }
      /* 无 moduleSpecifier 的 `export { X }` 才是本地绑定；带说明符的是**转出口**（re-export），
         它是「调用方 import 的名字 ≠ 声明所在文件」的**唯一合法来由**，必须记下来
         （ISS-658 召回率第一大缺口的第二半：`import { cn } from "./lib/utils"` 而 cn 声明在
         `../ui/cn`，只按「目标文件里有没有这个 span」判就整片丢边）。 */
      if (ts.isExportDeclaration(n) && !n.moduleSpecifier && n.exportClause && ts.isNamedExports(n.exportClause)) for (const e of n.exportClause.elements) localExports.add((e.propertyName || e.name).text)
      if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        if (n.exportClause && ts.isNamedExports(n.exportClause)) {
          for (const e of n.exportClause.elements) reexports.push({ name: e.name.text, remote: (e.propertyName || e.name).text, spec: n.moduleSpecifier.text })
        } else if (!n.exportClause) reexportStars.push(n.moduleSpecifier.text)
      }
    } else if (ts.isExportAssignment(n) && !n.isExportEquals && ts.isIdentifier(n.expression)) { localExports.add(n.expression.text); defaultExport = n.expression.text }
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      /* ── ISS-658：CommonJS 导出形态（`module.exports = {…}` / `exports.x = …` / `module.exports.x = …`）──
         只收「导出名能对上声明名」的写法；别名（`{ a: someFn }`）记下来由 buildCalls 按它核对。 */
      const eqLeft = n.left
      const pa = (node) => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)
      const isModuleExports = pa(eqLeft) && ts.isIdentifier(eqLeft.expression) && eqLeft.expression.text === "module" && eqLeft.name.text === "exports"
      const isExportsX = pa(eqLeft) && ts.isIdentifier(eqLeft.expression) && eqLeft.expression.text === "exports"
      const isModuleExportsX = pa(eqLeft) && ts.isPropertyAccessExpression(eqLeft.expression) && ts.isIdentifier(eqLeft.expression.expression) && eqLeft.expression.expression.text === "module" && eqLeft.expression.name.text === "exports"
      if (isModuleExports && ts.isObjectLiteralExpression(n.right)) {
        for (const prop of n.right.properties) {
          if (!prop.name) continue
          const en = prop.name.getText(sf).replace(/^["']|["']$/g, "")
          /* `{ a, b }`（shorthand）⇒ 同名；`{ a: someFn }` ⇒ 别名；方法简写 `{ f() {} }` ⇒ 同名。 */
          const local = ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop) ? en : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer) ? prop.initializer.text : null
          cjsExports.set(en, local === en ? null : local)
        }
      } else if (isExportsX || isModuleExportsX) {
        const en = eqLeft.name.text
        cjsExports.set(en, ts.isIdentifier(n.right) && n.right.text !== en ? n.right.text : null)
      }
    }
    else if (ts.isCallExpression(n)) {
      const e = n.expression, a = n.arguments[0]
      const isReq = ts.isIdentifier(e) && e.text === "require"
      const isDynImp = e.kind === ts.SyntaxKind.ImportKeyword
      if (isReq || isDynImp) {
        if (a && ts.isStringLiteral(a)) addSpec(a.text); else blind.push(`${ln(n)}:${n.getText(sf).slice(0, 48)}`)
      }
      /* ISS-658：调用边原料（require/import 本身不是符号调用，跳过）。 */
      if (!isReq && !isDynImp) {
        const cal = calleeOf(e)
        if (!cal) dropped.dynamic++
        else {
          const ev = bindingOf.has(cal.base || cal.name) ? bindingOf.get(cal.base || cal.name) : -1
          if (ev < 0) dropped.noEvidence++
          else calls.push({ name: cal.name, line: ln(n), ev })
        }
      }
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)) {
      /* `const m = require("s")` / `const { a } = require("s")` / `const x = await import("s")` 的本地绑定。
         本仓 CJS 不少，不收这批等于把它们的调用全判成「无证据」。 */
      const ci = n.initializer, ce = ci.expression, ca = ci.arguments[0]
      const isReq = ts.isIdentifier(ce) && ce.text === "require"
      if ((isReq || ce.kind === ts.SyntaxKind.ImportKeyword) && ca && ts.isStringLiteral(ca)) addImport(n.name.text, "*", ca.text)
    } else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && ts.isCallExpression(n.initializer)) {
      const ci = n.initializer, ce = ci.expression, ca = ci.arguments[0]
      if (ts.isIdentifier(ce) && ce.text === "require" && ca && ts.isStringLiteral(ca)) {
        for (const el of n.name.elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) addImport(el.name.text, ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text, ca.text)
      }
    }
    if (ts.isSourceFile(n)) {
      /* 顶层语句逐条带上下文下传：`top` 只给「语句本身」，`exported` 取该语句的 export 修饰符。
         走这个分支而不是 `ts.forEachChild(sf, …)`：后者拿不到「这条语句是不是顶层」。 */
      for (const st of n.statements) visit(st, true, ts.isVariableStatement(st) ? hasExport(st) : false)
      return
    }
    /* 顶层变量语句 → 逐个声明带 top/exported 下传。
       ⚠️ 必须在这里直接展开 `declarationList.declarations`：AST 层级是
       `VariableStatement → VariableDeclarationList → VariableDeclaration`，靠 `forEachChild`
       逐层传会**在中间那层丢掉 top**（实测：这样改完 span 一个没多，缓存里仍是 16 个函数）。 */
    if (top && ts.isVariableStatement(n)) {
      for (const dc of n.declarationList.declarations) visit(dc, true, exported)
      return
    }
    const d = decl(n, top, exported)
    if (d) {
      if (top) topSpans.add(spans.length)
      if (d.relaxed) relaxedIdx.add(spans.length)
      const sp = { name: d.name, kind: ts.SyntaxKind[n.kind], start: ln(n), end: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1, exported: d.exported }
      if (d.relaxed) sp.fallback = true
      spans.push(sp)
    }
    /* 其余子节点一律按「非顶层、不导出」下传：局部 `const buf = []` 因此不进 spans。 */
    ts.forEachChild(n, (c) => visit(c, false, false))
  }
  visit(sf, false, false)
  /* 后置导出回填：`export { X }` 与 `const X` 谁在前都能认到（只动顶层 span 的 exported 位）。 */
  if (localExports.size) for (const k of topSpans) if (localExports.has(spans[k].name)) spans[k].exported = true
  /* CJS 导出的回填（ISS-658）：导出名对上同名本地绑定的标 exported；别名形态记进 exportAlias。 */
  const exportAlias = {}
  for (const [en, local] of cjsExports) {
    if (local) exportAlias[en] = local
    for (const k of topSpans) if (spans[k].name === (local || en)) spans[k].exported = true
  }
  /* ISS-658：`calls` 只留**有 import 证据**的（`ev` 指向 `imports[ev]`），未成边的进 `dropped` 计数。
     形状说明见本函数头部「ISS-658」那段；`imports` 落缓存是必须的 —— 跨文件解析时
     需要在**别处**知道「这个文件里的 f 是从哪个说明符来的」，重算一次就得再解析一遍源文件。 */
  return { specs, blind, spans, prod: isProd(src), imports, calls, dropped, defaultExport, exportAlias, reexports, reexportStars }
}

/** hunk 行 → 最内层声明。**生产路径与自测共用这一个函数**：自测若自己再实现一遍匹配，
    变异「判定恒假」就只红端到端一条、单元用例照样绿 —— 那等于在验源码文本而不是验行为（ISS-993 的坑）。
 *
 *  ## 两轮：既有档优先，`fallback` 档只兜底（ISS-656 返工，2026-10-25）
 *  第一版把放宽出来的常量 span 与既有 span 混在一池里、交给「取最短」判据竞争，**结果符号名被改
 *  357 处、其中 220 处是「函数名 → 全大写常量名」**（Lead 独立复核推翻，我自己的自检没抓到）。
 *  根因不是「同区间平局」而是更根本的一条：`const DSH_URL = dshUrl()` 这种**单行**声明的
 *  `start == end` ⇒ 区间长 0 ⇒ 在「取最短」下它是任何区间的**最短候选** ⇒ 跨区间把整个函数顶掉。
 *  实测三例：`electron-shell/main.js` L44-53 报 `DSH_URL`（长 0）抢走 L50-52 的 `dshUrl()`；
 *  `forge-agent-protocol/lib/index.js` L201-260 报 `MAX_TEXT`；`scripts/no-new-tailwind.mjs` L1-196 报 `ARGS`。
 *
 *  为什么修在匹配层而不是「让 0 长度垫底」：0 长度只是最刺眼的一档，把 `end-start` 当序本来就会让
 *  「后加的细粒度 span」无条件压过「先有的粗粒度 span」—— 不管它是不是 0。**只要两档同池竞争，
 *  旧答案就可能被换掉**，而「换了名字」这种回归在指标上表现为「符号率上升」（正是本仓反复踩的
 *  「门禁绿而行为错」）。
 *  两轮之后：既有档的候选集**一字不变** ⇒ 旧能命中的每一处答案必然不变（构造性保证，不是概率），
 *  放宽档只在「既有档一个候选都没有」时才出场 —— 那正是本单要补的那批 module-scope 缺口。
 *
 *  §line-drift 影响：`forge-repowiki/lib/stale.js` 拿 `span.start` 与索引快照比。C 档只在
 *  「同名符号现在还能找到」时判漂移；两轮规则下既有档 span 的位置一个没动，放宽档新增的符号
 *  在旧索引里本来就没有快照（那时它是 module-scope、没有 symbolSpan），故不进 C 档比较。
 *  ⇒ **不影响 line-drift 档**。（这也是不动 `symbolForRange` 的理由：它是同一口径的第二份实现，
 *  改它才会真的动 line-drift。） */
function innermost(spans, line) {
  let best = null, rest = null
  for (const s of spans) {
    if (line < s.start || line > s.end) continue
    const len = s.end - s.start
    if (s.fallback) { if (!rest || len < rest.end - rest.start) rest = s; continue }
    if (!best || len < best.end - best.start) best = s
  }
  return best || rest
}

/* 4. 一阶反向 import 图（现算，不缓存） */
function buildReverse(files) {
  const fileSet = new Set(files), rev = new Map(), blind = [], fwd = new Map()
  for (const rel of files) {
    let f
    try { f = factsCached(rel) } catch (e) { blind.push({ file: rel, why: `解析失败 ${String(e.message).slice(0, 60)}` }); continue }
    if (!f) { blind.push({ file: rel, why: "读不到文件" }); continue }
    fwd.set(rel, f.spans)
    for (const b of f.blind) blind.push({ file: rel, why: `动态说明符 ${b}` })
    for (const s of f.specs) {
      const t = resolveSpec(rel, s, fileSet)
      if (!t) { if (s.startsWith(".") && !/\.(css|json)$/.test(s)) blind.push({ file: rel, why: `解析不到 ${s}` }); continue }
      if (!rev.has(t)) rev.set(t, new Set())
      rev.get(t).add(rel)
    }
  }
  saveIndex()   /* 索引在每轮建图后落盘：漏了这一步，缓存永远只是「读旧值」，增量更新不生效 */
  return { rev, blind, fwd }
}

/* 4b / 8c 已抽到 `./impact-of-diff-calls.mjs`（ISS-658）：本文件已到 K2a 的 1000 行红线，
   再往里塞调用图会新增一个 god module（棘轮只许降）。抽法与 `impact-of-diff-selftest.mjs`
   同一套 —— **依赖注入**：那边的模块不 import 本文件（本文件绝大多数符号是模块级私有），
   而是本文件把 `factsCached` / `resolveSpec` / `innermost` / `saveIndex` 传进去。
   判据没变：调用图的抽取仍然只用 `factsOf`（不许新建第二个 TS 解析器），只是搬了个文件。 */
const { buildCalls, renderCallersBlock, DROPPED_LABEL, runCallersCli } = makeCallGraph({
  factsCached, resolveSpec, saveIndex, innermost, pkgOf, isTest,
})

/* 5. git diff 的 hunk（--unified=0：每个 hunk 头就是一段连续改动） */
/** 未跟踪源码文件（ISS-637 ⑦）：`git diff` 天然不含 `??`，而 agent 常新建文件 ⇒ 两处都看不见，
 *  等于「刚加的文件没人 import、也没人受影响」这种最该看的情况反而漏掉。用 `git ls-files --others`
 *  （比 `git status --porcelain` 便宜一半且不受 `-uall` 配置影响），只取源码、去掉被 ignore 的。
 *  fixture 目录是自测用的假文件，不进真仓口径（否则自测自己会污染每次运行）。
 *
 *  ⚠️ K9b「读不到 ≠ 真的空」（ISS-637 返工 F2）：`catch { return [] }` 是错的 —— git 一旦失败
 *  （不在 git 仓、索引被锁、PATH 上的 git 被拦），`??` 文件会**凭空消失**，而页脚照样报
 *  「未跟踪新增 0 个」，读者会当成「查过了，没有」。现在失败态单独记账：stderr 一行 + 页脚报「取不到」，
 *  与「真的是 0 个」在输出上可区分。
 */
const FIXTURE_DIR_REL = "scripts/impact-of-diff.selftest-fixtures"
/** 未跟踪清单的读取状态。`ok=false` ⇒ 清单**不可信**，页脚必须这么说，不许报成 0。 */
const untrackedStatus = { ok: true, why: "" }
function untrackedFiles() {
  let out = ""
  try { out = execFileSync("git", ["-C", ROOT, "ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }) }
  catch (e) {
    untrackedStatus.ok = false
    /* 优先用退出码（`git` 失败时 e.code 常为空、e.message 是一长串命令行）——
       取消息里最有信息量的部分：退出码 > stderr 首行 > 通用兜底。 */
    const stderrFirst = String(e.stderr || "").trim().split("\n").filter(Boolean)[0]
    untrackedStatus.why = stderrFirst ? stderrFirst.slice(0, 60) : (e.status != null ? `git 退出码 ${e.status}` : String(e.code || "").slice(0, 40)) || "git 失败"
    console.error(`[impact-of-diff] 未跟踪文件清单取不到（${untrackedStatus.why}）⇒ 本次**不含** \`??\` 新文件的账，别当成「没有新文件」`)
    return []
  }
  untrackedStatus.ok = true
  untrackedStatus.why = ""
  return out.split("\0").filter((p) => p && FILE_RE.test(p) && !VENDOR.test(p) && !p.startsWith(FIXTURE_DIR_REL + "/")).sort()
}

function hunksOf(base, staged) {
  const args = ["-C", ROOT, "diff", "--unified=0", "--no-color", "--no-ext-diff"]
  if (staged) args.push("--cached")
  if (base) args.push(base)
  let out = ""
  try { out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 << 20 }) } catch (e) { console.error(`✗ git diff 失败：${String(e.message).slice(0, 200)}`); process.exit(2) }
  const hunks = [], deleted = []
  let cur = null, curOld = null
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim()
      if (p === "/dev/null") { if (curOld) deleted.push(curOld); cur = null } else cur = p.replace(/^b\//, "").replace(/^"|"$/g, "")
      continue
    }
    if (line.startsWith("--- ")) { const p = line.slice(4).trim(); curOld = p === "/dev/null" ? null : p.replace(/^a\//, "").replace(/^"|"$/g, ""); continue }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (m && cur) hunks.push({ file: cur, line: Number(m[1]) })
  }
  return { hunks, deleted }
}

/* 6. 该跑哪几条闸（闸名→命令沿用 gate-fast:32-66 的口径，补 scripts / deps / build:host / tool-contract） */
function gatesFor(changed, pkgs, hasToolDef) {
  const g = new Map(), add = (id, cmd, why) => { if (!g.has(id)) g.set(id, { id, cmd, why }) }
  for (const rel of changed) {
    const pkg = pkgOf(rel)
    if (isCode(rel) || /\.css$/.test(rel)) add("code", "node scripts/lint-code.mjs --check", "code 门禁是存量债棘轮，源码改动都要过")
    if (pkg && /\.(tsx?|jsx?)$/.test(rel) && !isTest(rel) && !VENDOR.test(rel)) add("design", "node scripts/lint-design.mjs --check", "design 门禁扫 forge-*/matter* 的 tsx/jsx/css")
    if (rel.startsWith("scripts/") || rel.endsWith(".sh")) add("scripts", "node scripts/lint-scripts.mjs --check", "scripts 六条红线（R5 说明注释等）")
    if (path.basename(rel) === "package.json") add("deps", "node scripts/deps-hygiene.mjs", "改了依赖声明 ⇒ 依赖卫生")
    if (pkg && /\/lib\//.test(rel) && pkgJson(pkg).scripts?.["build:host"]) add("build:host", `(cd ${pkg} && bun run build:host)`, "改过 lib/** 必须重建，否则真机跑旧码而门禁全绿（ISS-610）")
  }
  if (hasToolDef) add("tool-contract", "node scripts/lint-tool-contract.mjs", "改动里出现 defineTool( ⇒ 工具契约")
  return { gates: [...g.values()], pkgs }
}

/* 7. 主流程 */
/** 反向依赖的第 N 阶（ISS-637 ③）。`depth=1` ⇒ [直接 importer]，与旧行为完全一致。
 *  为什么要它：实测 `--who-imports forge-ui/lib/browser-bridge.js` 只报 2 个直接 importer，
 *  「谁再用 forge-ui」得人工再查一轮 —— 而这恰恰是判断影响面时最常问的第二个问题。
 *  去重口径：某文件出现在第 1 阶就不再算进第 2 阶（否则同一份清单里重复列，读者会以为它被两路波及）。 */
function reverseLevels(rev, start, depth) {
  const seen = new Set(start), levels = []
  let frontier = new Set(start)
  for (let d = 0; d < depth; d++) {
    const next = new Set()
    for (const f of frontier) for (const imp of (rev.get(f) || new Set())) if (!seen.has(imp)) next.add(imp)
    for (const f of next) seen.add(f)
    levels.push([...next].sort())
    frontier = next
    if (!next.size) break
  }
  return levels
}
function analyze(opts = {}) {
  const t0 = Date.now(), files = scanFiles(), tScan = Date.now()
  const { rev, blind, fwd } = buildReverse(files), tGraph = Date.now()
  const { hunks, deleted } = hunksOf(opts.base, opts.staged)
  /* ISS-637 ⑦：`git diff` 天然不含未跟踪新文件，而 agent 常新建文件 ⇒ 最该被看见的「整文件新增」
     在两处都不可见。这里单独取一份清单，diff 模式与 who-imports 各自成段报出（不并入 hunks 账，
     因为它们没有 hunk —— 混进恒等式会让「hunk 全部有账」这条判据失真）。 */
  const untracked = untrackedFiles()
  const byFile = new Map()
  for (const h of hunks) { if (!byFile.has(h.file)) byFile.set(h.file, []); byFile.get(h.file).push(h.line) }
  const results = [], nonCode = [], prodFiles = [], affected = new Set()
  let nSymbol = 0, nModule = 0, nLost = 0, prodHunks = 0, hasToolDef = false
  // 改动与删除同一条循环：删除的文件也在 diff 里，拆第二个循环只是重复一遍 pkg/rev 逻辑
  for (const [rel, lines, gone] of [...[...byFile].map(([f, l]) => [f, l, false]), ...deleted.map((f) => [f, [], true])]) {
    const pkg = pkgOf(rel); if (pkg) affected.add(pkg)
    if (!isCode(rel)) { nonCode.push({ file: rel, pkg, n: lines.length, deleted: gone }); continue }
    let src = null
    try { src = fs.readFileSync(path.join(ROOT, rel), "utf8") } catch { /* 空/读不到 */ }
    const facts = (() => { try { return factsCached(rel) } catch { return null } })()
    if (src && /defineTool\s*\(/.test(src)) hasToolDef = true
    const deps = [...(rev.get(rel) || [])]
    for (const d of deps) { const p = pkgOf(d); if (p) affected.add(p) }
    /* 打包产物（ISS-621 ①）：**不报符号** —— `触_()` / `吸_2()` 这类压缩名零定位价值。
       但反向依赖照算（谁 import 它与它是不是产物无关），hunk 数也要进账（见下方恒等式）。
       ⚠️ 不许静默丢弃：每个产物文件都进 prodFiles，render 里点名 + 尾部汇总。 */
    if (facts && facts.prod) { prodFiles.push({ file: rel, pkg, n: lines.length, why: facts.prod, deps, deleted: gone }); prodHunks += lines.length; continue }
    const spans = facts ? facts.spans : null
    const sites = []
    for (const line of lines) {
      if (spans === null) { nLost++; sites.push({ line, kind: "未定位" }); continue }
      const best = innermost(spans, line)
      if (best) { nSymbol++; sites.push({ line, symbol: best.name, kind: best.kind, start: best.start, end: best.end }) }
      else { nModule++; sites.push({ line, kind: "模块顶层" }) }
    }
    results.push({ file: rel, pkg, test: isTest(rel), sites, deps, deleted: gone })
  }
  /* 盲区分两笔账，不许混成一个数（第一版混过：全仓 43 处贴在「本次 2 hunk」旁边，读起来像本次有 43 处未解析
     —— 另一种造假，只是方向相反）。① 本次 hunk 定位失败 ② 反向图全仓盲区（不随 diff 变），后者只把
     「落在受影响包里」的那一小撮算进本次口径。 */
  const affectedPkgs = [...affected].sort(), blindPkg = blind.filter((b) => affected.has(pkgOf(b.file) || ""))
  /* hunk 必须**全部**有账：源码归符号/模块顶层/未定位之一，非源码归 nonCodeHunks，
     打包产物归 prodHunks（ISS-621 ① 引入第三类，恒等式同步补项 —— **少补一项就是静默蒸发**）。
     自测有一条恒等式钉死这点 —— 第一版漏过：260 hunk 只有 105 个进账，其余静默蒸发。 */
  const nonCodeHunks = nonCode.reduce((s, x) => s + x.n, 0)
  return {
    results, nonCode, prodFiles, affectedPkgs, gates: gatesFor([...byFile.keys(), ...deleted], affectedPkgs, hasToolDef), blindPkg,
    /* ISS-637 ⑦：未跟踪新文件单独成段。**不进 hunks 恒等式**（它们没有 hunk），也不进 gates 推演
       （新增文件与「改了已有文件」的闸口径不同，本单不改那条口径 —— 只保证可见）。 */
    untracked,
    counts: {
      hunks: hunks.length, files: byFile.size + deleted.length, nSymbol, nModule, nLost, nonCodeHunks, prodHunks,
      prod: prodFiles.length, untracked: untracked.length,
      noDeps: results.filter((x) => !x.deps.length && !x.deleted).length,
      blindAll: blind.length, blindProd: blind.filter((b) => !isTest(b.file)).length, blindInAffected: blindPkg.length,
      unresolved: nLost + blindPkg.length,
    },
    timings: { scan: tScan - t0, graph: tGraph - tScan, total: Date.now() - t0 }, tsFrom: TS_FROM, filesScanned: files.length,
  }
}

/* 8. 渲染（措辞纪律：只说「影响面估计」，未解析数不许省） */
/** 缓存页脚（ISS-637 ②）：**每次都报**，命中/未命中/已关闭 + 原因。以前「到底缓存有没有生效」只能靠猜，
 *  v1→v2 那次静默就是猜错的代价。`--quiet` 下也保留（它是一个字，且是结论的一部分）。 */
const cacheLine = () => `缓存 ${cacheStatus.state}${cacheStatus.why ? `（${cacheStatus.why}）` : ""} · ${cacheStatus.dir}`

function render(r) {
  const c = r.counts, L = []
  const cap = (arr, max) => arr.length > max ? [...arr.slice(0, max), `… 其余 ${arr.length - max} 个（--verbose 看全）`] : arr
  L.push(`影响面估计（impact-of-diff · ${c.hunks} hunk / ${c.files} 文件 · 只做一阶反向 import、不做 CALLS 图、不做风险分级）`, "")
  /* ISS-637 ⑦：未跟踪新文件段。放在开头（紧跟标题）而不是塞进尾部 —— 它是「这份估计漏了一整块输入」
     级别的信息，藏在页脚等于没说。只有真有未跟踪源码时才出这一行，没有时**一字不出**（旧行为不变）。
     F4（返工）：`--quiet` 下只报计数、不列文件名 —— 与 nonCode 段同形。此前这里漏了 quiet 闸，
     5 个未跟踪文件就把 quiet 顶到 412 tok（破 400），因为还在用 cap(..., MAX_HUNK=12) 列名。 */
  if (c.untracked) L.push(
    QUIET ? `■ 新增未跟踪文件 ${c.untracked} 个（整文件新增 · \`git diff\` 天然不含；--quiet 不列文件名）`
      : `■ 新增未跟踪文件 ${c.untracked} 个（整文件新增 · \`git diff\` 天然不含，此前完全不可见）`,
    ...(QUIET ? [] : cap(r.untracked.map((f) => `  ${f}`), MAX_HUNK)), "")
  /* F2（返工）：清单取不到时**必须出声** —— 否则「0 个」会被读成「查过了没有」。
     这一行与上面那段互斥：读不到时 c.untracked 是 0，靠这一行说清「0 不可信」。 */
  if (!untrackedStatus.ok) L.push(`■ 未跟踪文件清单**取不到**（${untrackedStatus.why}）—— 本次 \`??\` 新文件未入账，别当成「没有新文件」`, "")
  const folded = []
  /* ISS-637 ⑥：`--quiet` 只出**结论行** —— 单里把它定义为「标题 + 分组计数 + 闸清单 + 未解析数」，
     即**不逐条列文件**。第一版留了前 8 个文件名，实测 HEAD~15..HEAD 仍 890 tok（明细随 diff 面线性膨胀），
     破 400 上限；按单定义收成纯计数后 203~575 tok。文件清单是「去哪个文件改」，不是结论 —— 要它就去掉 --quiet。 */
  const listable = r.results.filter((x) => x.deleted || x.deps.length || x.sites.length)
  const quietShown = QUIET ? [] : r.results
  for (const x of quietShown) {
    /* ISS-621 ③：反向依赖 0 的文件（38 个文件里占大半）折叠成一行计数 ——
       但只折叠「不列出」，数量照样报（盲区必须显式，这条与产物识别同一条纪律）。 */
    if (CHANGED_ONLY && !x.deleted && !x.deps.length) { folded.push(x); continue }
    if (x.deleted) { L.push(`■ ${x.file}（已删除${x.deps.length ? ` · 下游 ${x.deps.length} 个文件可能断` : ""}）`, ...x.deps.slice(0, MAX_DEP).map((d) => `    被 ${d} import`)); continue }
    L.push(`■ ${x.file}（${x.sites.length} 处改动${x.pkg ? ` · ${x.pkg}` : ""}${x.test ? " · 测试" : ""}）`)
    L.push(...cap(x.sites.map((s) => s.symbol ? `  :${s.line} → ${s.symbol}() L${s.start}-${s.end}` : `  :${s.line} → ${s.kind}`), MAX_HUNK))
    L.push(x.deps.length ? `  反向依赖 ${x.deps.length} 个文件：${cap(x.deps, MAX_DEP).join(", ")}` : "  反向依赖 0 个（没有文件 import 它）")
  }
  /* quiet 下用一行报改动文件的分组计数：有反向依赖的 / 0 依赖的 / 已删除的。
     「0 依赖」的数量必须显式（同名纪律）——否则 quiet 让人以为所有文件都波及别人。 */
  if (QUIET) {
    const withDeps = listable.filter((x) => x.deps.length && !x.deleted).length
    const zeroDep = listable.filter((x) => !x.deps.length && !x.deleted).length
    const goneN = listable.filter((x) => x.deleted).length
    L.push(`■ 改动文件 ${listable.length} 个：反向依赖非空 ${withDeps} 个 · 反向依赖 0 个 ${zeroDep} 个 · 已删除 ${goneN} 个`)
  }
  if (folded.length) L.push("", `■ 反向依赖 0 的文件 ${folded.length} 个已折叠（--changed-only；它们改动不影响别的文件）${VERBOSE ? "：" + folded.map((x) => x.file).join(", ") : ""}`)
  /* 打包产物单独成段（ISS-621 ①）：不报符号，但**必须可见** —— 静默丢弃会让「跳过 7 处 hunk」消失得无影无踪，
     那正是本工具立单时反对的「宣称完整」。反向依赖照列（谁 import 它与它是不是产物无关）。 */
  if (r.prodFiles.length) L.push("", `■ 打包产物 ${r.prodFiles.length} 个（本工具不解析其符号 —— 压缩名无定位价值；反向依赖仍照算）`,
    ...cap(r.prodFiles.map((p) => `  ${p.file}（${p.deleted ? "已删除" : `${p.n} 处改动`} · ${p.why}${p.deps.length ? ` · 反向依赖 ${p.deps.length} 个` : ""}）`), MAX_HUNK))
  /* 非源码清单同理：quiet 下只报计数（头部已有总数，明细随 diff 面线性膨胀）。 */
  if (r.nonCode.length) L.push("", `■ 非 TS/JS 或打包产物的改动 ${r.nonCode.length} 个（本工具不解析 ⇒ 只报到文件级，符号定位对它无意义）${QUIET ? "（--quiet 不列文件名）" : ""}`,
    ...(QUIET ? [] : cap(r.nonCode.map((n) => `  ${n.file}${n.n ? `（${n.n} 处）` : "（已删除）"}`), MAX_HUNK)))
  /* ── ISS-637 ⑥：`--quiet` 收尾在这些结论行之后、口径说明之前截住 ──
     保留的：标题（含 hunk/文件数）、分组计数、闸清单、未解析数、缓存状态。
     省掉的：扫描根解释、盲区逐条、耗时明细、产物清单 —— 那些是「为什么数字是这个」，不是数字本身。 */
  L.push("", "── 该跑哪几条闸 ──")
  /* quiet 下闸只报 `id（命令）` 单行，省掉每条两行的 `why` 说明（那是「为什么」，不是「跑什么」）。
     去掉 --quiet 即恢复原文两行形态 —— 闸的命令本身一个字节没改，改的只是说明行的呈现。 */
  if (QUIET) for (const g of r.gates.gates) L.push(`  ${g.cmd}`)
  else for (const g of r.gates.gates) L.push(`  ${g.cmd}\n      ← ${g.why}`)
  if (r.affectedPkgs.length) L.push(QUIET
    ? `  受影响包 ${r.affectedPkgs.length} 个（按包跑 bun test / typecheck；改过 lib/** 的先用 build:host）`
    : `  受影响包 ${r.affectedPkgs.length} 个：${r.affectedPkgs.join(", ")}\n      ← bun test / bun run typecheck 按包跑（改过 lib/** 的先用 build:host）`)
  if (QUIET) {
    L.push("", `未解析 ${c.unresolved} 处（hunk 定位失败 ${c.nLost} + 受影响包内盲区 ${c.blindInAffected}）· 分组：符号 ${c.nSymbol} / 模块顶层 ${c.nModule} / 非源码 ${c.nonCodeHunks} / 产物 ${c.prodHunks} · 打包产物 ${c.prod} 个 · 未跟踪新增 ${c.untracked} 个`,
      cacheLine())
    return L.join("\n")
  }
  L.push("", `未解析 ${c.unresolved} 处（本次口径 = hunk 定位失败 ${c.nLost} + 受影响包内的反向图盲区 ${c.blindInAffected}）`,
    `  · hunk 无法定位 ${c.nLost} 处（文件解析失败或行越界）`,
    `  · 受影响包内的盲区文件 ${c.blindInAffected} 个 —— 这些文件的下游边**可能漏**，不是零`,
    ...cap(r.blindPkg.map((b) => `    - ${b.file}：${b.why}`), VERBOSE ? 999 : 5),
    `  · 全仓盲区背景值 ${c.blindAll} 处（非测试 ${c.blindProd} 处）—— **不随 diff 变**，是反向图自身的口径缺口，单列免得被误读成本次问题`,
    `  · 已定位：具名符号 ${c.nSymbol} 处 / 模块顶层 ${c.nModule} 处（后者只能报到文件，报不到符号）`,
    `  · 跳过 ${c.prod} 个打包产物文件（符号定位无意义；其中 ${c.prodHunks} 处 hunk 已进产物账，不是丢了）${c.prod ? "：" + r.prodFiles.map((p) => p.file).join(", ") : ""}`,
    "", `耗时 ${r.timings.total}ms（扫描 ${r.timings.scan}ms + 反向图 ${r.timings.graph}ms）· 扫描面 ${r.filesScanned} 文件 · typescript 取自 ${r.tsFrom}`,
    cacheLine(),
    `扫描根 ${ROOT}`,
    `  ↑ ISS-621 ④（2026-10-20）：这行不是装饰。曾有一次「工具把注释里的文件名当成依赖」的误判，`,
    `    查到底工具本身没问题（spec 提取是 AST 级，注释不进 AST），真因是**观察口径错位**——`,
    `    在 A 处跑工具、看的是 B 处改过的文件。扫描根写出来，这类误读当场就能看出来。`)
  return L.join("\n")
}

/* 8b. who-imports 的单目标渲染（ISS-637 返工 F1：**抽成纯函数才能验行为**）
 *
 * 为什么必须抽出来：F1 之前的自测只能断言「GROUP_MIN === 20」这种常量，因为渲染逻辑埋在
 * CLI 分支的闭包里、自测根本调不到 —— 于是把消费点改成 `g.slice(0, 5)` 仍然全绿。
 * 抽成纯函数后，自测可以「喂一组 importers → 读输出行」断言**真列了 20 行文件名**，
 * 变异在消费点上立刻红。这也是自测能验 depth 分段、折叠段、quiet 压缩的前提。
 *
 * 入参全部显式（不读模块级 QUIET/DEPTH/VERBOSE），使自测能分别构造 4 种组合而互不污染。
 */
function renderWhoBlock({ norm, importers, levelFiles, untracked, quiet, verbose, depth, changedOnly }) {
  const pkg = pkgOf(norm), L = []
  const json = { target: norm, pkg, count: importers.length, untracked, importers }
  /* ISS-637 ④：反向依赖 0 的目标**整段不输出**（折叠 ≠ 消失，尾部另有计数行）。 */
  if (changedOnly && !importers.length) return { L: [], json: { ...json, folded: true }, folded: norm }
  L.push(`谁依赖 ${norm}${pkg ? `（${pkg}）` : ""}`, "")
  if (untracked) L.push(`  · 注意：本文件未跟踪（\`??\`，还没进 git）—— 下面仍是全仓口径的影响面`, "")
  /* ISS-637 ③：levels[0] = 直接 importer，levels[n-1] = 第 n 阶。 */
  json.levels = levelFiles.map((g, i) => ({ depth: i + 1, count: g.length, files: g }))
  json.depth = Math.max(1, depth)
  if (!importers.length) L.push("  反向依赖 0 个（没有文件 import 它）")
  else {
    const groups = { test: [], entry: [], samepkg: [], cross: [] }
    for (const f of importers) groups[catOf(f, pkg)].push(f)
    L.push(`  反向依赖 ${importers.length} 个文件（按处置分组）：`)
    for (const k of ["test", "entry", "samepkg", "cross"]) {
      const g = groups[k]
      if (!g.length) continue
      const [name, todo] = GROUP_LABEL[k]
      /* ISS-637 ⑥：`--quiet` 只报**计数**，不列文件名 —— 「结论行」= 「多少个、该做什么」，
         文件清单属于「去哪个文件改」，不是结论。这是 quiet 能压进 400 tok 的关键。 */
      if (quiet) { L.push(`  ■ ${name} ${g.length} 个 —— ${todo}`); continue }
      L.push("", `  ■ ${name} ${g.length} 个 —— ${todo}`)
      /* ISS-637 ⑤：保底 GROUP_MIN 个（原 5）。59 个 importer 只列 5 个 ⇒ 看不出分布。 */
      const show = verbose ? g : g.slice(0, GROUP_MIN)
      for (const f of show) L.push(`      ${f}`)
      if (g.length > show.length) L.push(`      … 其余 ${g.length - show.length} 个（--verbose 看全）`)
    }
    const pkgs = [...new Set(importers.map(pkgOf).filter(Boolean))]
    if (pkgs.length) L.push("", `── 受影响的包（${pkgs.length} 个）──`, `  ${pkgs.join(" · ")}`)
    /* ISS-637 ③：第 2 阶及以上单独成段，按阶分。depth=1 时这段**一字不出**（旧行为不变）。 */
    for (let d = 2; d <= levelFiles.length; d++) {
      const g = levelFiles[d - 1]
      if (!g || !g.length) continue
      L.push("", `── 第 ${d} 阶反向依赖 ${g.length} 个（谁 import 了第 ${d - 1} 阶 —— 间接波及，不是直接调用方）──`)
      if (!quiet) {
        const show = verbose ? g : g.slice(0, GROUP_MIN)
        for (const f of show) L.push(`      ${f}`)
        if (g.length > show.length) L.push(`      … 其余 ${g.length - show.length} 个（--verbose 看全）`)
      }
    }
    if (depth > 1) {
      const deeper = levelFiles.slice(1).reduce((s, g) => s + g.length, 0)
      L.push("", `  · 累计已展开 ${depth} 阶，第 2 阶及以下共 ${deeper} 个文件（--depth N 可继续加深；N 越大越像「全仓都受影响」，判断力递减）`)
    }
    if (!quiet) L.push("", `⚠️ 本口径是「波及面」（谁 import 了本文件），不是「谁真会执行到改动那一行」。`, `   要判断精确调用关系请另查 —— 本工具不做调用图（同名跨文件 3.6%、成员访问 50.4%、盲区 14%）。`)
  }
  return { L, json }
}

/** 校验 --who-imports 的目标（ISS-641 · K9b 第三次）。
 *
 *  **为什么这是 bug 不是吹毛求疵**：目标不存在时旧版输出「反向依赖 0 个」，与「文件存在但无人
 *  import」**逐字节相同**、且 exit 0。ISS-638 之后 `code_impact` 让**模型**传路径，模型写错一个字母
 *  ⇒ 拿到「0 个依赖」⇒ 推断「没人依赖，安全，可以改」——它查的是个不存在的文件。
 *  两种情况的输出必须能区分：「查过了没有」≠「查错东西了」。
 *
 *  顺带修同类（实测发现的第二处）：目标是**目录**时旧版同样报「0 个依赖」（`--who-imports forge-pm/src/pm`）。
 *  目录不是可分析目标（本工具问的是「谁 import 这个**文件**」），必须单列出来说清楚，
 *  不能与「文件无人依赖」共用一个答案。
 *
 *  返回 {ok:[], missing:[], dir:[]}；纯函数（只做 fs 判定），自测可直接喂路径。
 *  ⚠️ 路径一律相对 ROOT 解析 —— 调用方已去过 `./` 前缀。 */
function classifyTargets(targets, root = ROOT) {
  const ok = [], missing = [], dir = []
  for (const t of targets) {
    const abs = path.join(root, t)
    let st = null
    try { st = fs.statSync(abs) } catch { /* 不存在（或无权读）⇒ 下面归到 missing */ }
    if (!st) missing.push(t)
    else if (st.isDirectory()) dir.push(t)
    else ok.push(t)
  }
  return { ok, missing, dir }
}

/* ── 自测（ISS-641 收口：判据已外置到 impact-of-diff-selftest.mjs）─────────────────────
 * **为什么是动态 import 而不是文件顶部静态 import**：`cliFixtures()` 会把本文件 copy 进临时仓
 * 再起子进程跑 `--who-imports`。静态 import 会在 link 阶段就解析外置模块，而那个副本旁边没有它
 * ⇒ 子进程崩在一个**用不到的分支**上（cliFixtures 只跑 who-imports）。动态 import + 放在
 * `has("--self-test")` 分支里 ⇒ 正常路径根本不加载它。实测复制形态跑 who-imports 正常。
 * **为什么用依赖注入而不是让外置模块 import 本文件**：本文件绝大多数符号是模块级私有（const，
 * 非 export），为外置而全部 export 会把 K10b（零引用导出）顶高 —— 用一条违例换另一条。 */
if (has("--self-test")) {
  const { makeSelfTest } = await import("./impact-of-diff-selftest.mjs")
  /* `symbolForRange` 来自 lib（wiki 索引那条路径）。**动态 import 且失败不阻断**：
     自测里有一组用例会判「`innermost` 与 `symbolForRange` 同判据」，没有它就跳过那组（报 SKIP 而不是假绿）。
     ⚠️ 不许改成顶部静态 import：`cliFixtures()` 会把本脚本复制进临时仓再跑，那份副本旁边没有
     `forge-repowiki/lib/`，静态 import 会让副本在 link 阶段就崩（历史教训，见本文件 self-test 段注释）。 */
  let symbolForRange = null
  try { ({ symbolForRange } = await import(new URL("../forge-repowiki/lib/symbols.js", import.meta.url).href)) } catch { /* 副本场景：无 lib 可用 */ }
  const runSelfTest = makeSelfTest({
    ROOT, A, has, resolveSpec, factsOf, innermost, gatesFor, isProd, isCode, parseVals,
    scanFiles, analyze, CACHE_DIR, cachePath, cacheStatus, resetIndexForTest, loadIndex,
    INDEX_VERSION, catOf, GROUP_MIN, KNOWN_FLAGS, unknownFlags, parseDepth, renderWhoBlock, symbolForRange,
    classifyTargets, reverseLevels, CHANGED_ONLY, QUIET, DEPTH, FILE_RE, VENDOR,
    FIXTURE_DIR_REL, untrackedFiles, untrackedStatus, render, cryptoMod,
  })
  process.exit(runSelfTest())
}

/* --who-imports <rel>：从**符号/文件**出发问「谁依赖我」（与从 diff 出发互补）。
 * 为什么需要它：审查员和 builder 的实际问题是「改了这个文件，谁会受影响」，
 * 不一定有现成 diff —— 而 grep 会被注释、断言文本、工作树副本污染（实测 93% 噪音）。
 * 复用 analyze 已建好的 rev 图。 */
if (has("--who-imports")) {
  /* ISS-621 ②（2026-10-20 实战反馈）：**支持多路径** —— 评估一次改动常要同时查几个文件，
     原先查 3 个 = 起 3 个进程 × 各建一遍反向图。现在一次建图、按文件分段输出；
     **单路径的输出格式一字未改**（既有用法与截图不受影响）。 */
  const rawTargets = parseVals(A, "--who-imports").map((t) => String(t).replace(/^\.\//, ""))
  if (!rawTargets.length) { console.error("✗ --who-imports 需要一个相对路径（可给多个）"); process.exit(2) }
  /* ISS-641（K9b 第三次）：目标**不存在**不许报成「反向依赖 0 个」——
     旧版两者输出逐字节相同且 exit 0，模型会据「0 个依赖」推断「安全可改」，而它查的是个不存在的文件。
     多目标分两路：不存在的点名报出（exit 2），**存在的继续分析**（一个写错不该废掉整次查询）。 */
  const { ok: validTargets, missing, dir: dirTargets } = classifyTargets(rawTargets)
  if (missing.length || dirTargets.length) {
    const msgs = []
    if (missing.length) msgs.push(`目标不存在：${missing.join("、")}（相对仓库根 ${ROOT}；你可能写错了路径）`)
    if (dirTargets.length) msgs.push(`目标是目录而非文件：${dirTargets.join("、")}（本工具问的是「谁 import 这个**文件**」，请给到具体文件）`)
    for (const m of msgs) console.error(`✗ ${m}`)
    /* 全部无效 ⇒ 直接退出，不产出任何分析（没有可分析的东西）。 */
    if (!validTargets.length) process.exit(2)
    /* 部分有效 ⇒ **继续分析**（一个写错不该废掉整次查询），但**退出码仍是 2**：
       K9b 的判据是「读不到 ≠ 真的空」—— 这次结果只覆盖一部分目标，就是「不完整」，
       不许让调用方在 `&&` 链或 `if exit==0` 里把它当完全成功。有效目标的分析照常写到 stdout，
       调用方既有数据、也能从非零退出码知道「有问题、别全信」。 */
    console.log(`⚠️ 部分目标无法分析（本次结果只覆盖 ${validTargets.length}/${rawTargets.length} 个目标）—— 退出码 2：结果不完整，别当完全成功：`)
    for (const m of msgs) console.log(`   ${m}`)
    console.log("")
  }
  const targets = validTargets.length ? validTargets : rawTargets
  /* 部分目标无效时，分析照做但**收尾退出码为 2**（不能在这里 exit：那会丢掉下面的分析输出）。 */
  const PARTIAL_FAIL = missing.length > 0 || dirTargets.length > 0
  const files = scanFiles()
  const { rev } = buildReverse(files)
  /* ISS-637 ⑦：`??` 未跟踪源码。who-imports 靠文件系统扫描建图 ⇒ 未跟踪的**import 方**本来就看得到，
     但**目标本身**是否已入库此前无人报：「你查的这 5 个文件里有 2 个还不在 git 里」是会影响结论口径的事实。 */
  const untrackedSet = new Set(untrackedFiles())
  /* 分层输出（ISS-621 甲）：56 个文件平铺对人没有判断价值 ——
     同一份清单里「测试文件」与「跨包消费方」的处置完全不同，却混在一行。
     按**改动后的动作**分组，每组给一句「要做什么」，比逐个列文件名有用。
     ⚠️ 这不是精确度提升：一阶 import 会把「import 了本文件其它符号」也算进来
     （实测 domain.js 56 个 importer 里，真调用 activityEventState 的只有 2 个）。
     本工具的口径始终是「**波及面**」，不是「谁真会执行到这一行」。 */
  /* F1（返工）：渲染逻辑已抽成 renderWhoBlock（纯函数），此处只做「取图 → 调渲染」。
     生产与自测走同一个函数 ⇒ 自测断言的就是真实渲染行为，而不是另写一份假设。 */
  const blocks = targets.map((norm) => {
    const importers = [...(rev.get(norm) || [])].sort()
    return renderWhoBlock({
      norm, importers,
      levelFiles: reverseLevels(rev, [norm], Math.max(1, DEPTH)),
      untracked: untrackedSet.has(norm),
      quiet: QUIET, verbose: VERBOSE, depth: DEPTH, changedOnly: CHANGED_ONLY,
    })
  })
  if (JSONOUT) console.log(JSON.stringify(blocks.length === 1 ? blocks[0].json : blocks.map((b) => b.json), null, 1))
  else {
    const shown = blocks.filter((b) => !b.folded), foldedList = blocks.filter((b) => b.folded).map((b) => b.folded)
    shown.forEach((b, i) => { if (i) console.log(""); for (const l of b.L) console.log(l) })
    /* 折叠的必须报数（与 diff 模式同一条纪律：折叠 ≠ 消失）。全部被折叠时出一行，不留空输出。 */
    if (foldedList.length) { if (shown.length) console.log(""); console.log(`  反向依赖 0 的 ${foldedList.length} 个目标已折叠（--changed-only / --only-impacted；它们不波及别的文件）：${foldedList.join(", ")}`) }
    /* ISS-637 ⑥：`--quiet` 省掉扫描根的解释块（固定 3 行 + 尾注），只留一行结论。 */
    if (QUIET) console.log("")
    else console.log(`\n扫描根 ${ROOT}  ← ISS-621 ④：工具的观察口径必须可见（改 A 看 B 是这类误判的根因）`)
    console.log(`缓存 ${cacheStatus.state}${cacheStatus.why ? `（${cacheStatus.why}）` : ""} · ${cacheStatus.dir}`)
  }
  /* ISS-641：部分目标无效 ⇒ 结果不完整，退出码 2（数据照给，但调用方必须知道别全信）。 */
  process.exit(PARTIAL_FAIL ? 2 : 0)
}

/* 8d. `--callers` / `--call-graph` 的分支也搬进了 sibling（同上：K2a 行数）。 */
if (has("--callers") || has("--call-graph")) {
  runCallersCli({
    A, has, val, QUIET, VERBOSE, JSONOUT, ROOT, DROPPED_LABEL,
    buildCalls, renderCallersBlock, classifyTargets, scanFiles, parseVals, cacheStatus,
  })
}

/* 默认 diff 主流程。`--callers` / `--call-graph` 已在上面处理完、并把 exitCode 设好，
   不许再落进来跑一遍 diff（那会在同一份输出尾部追加一份与问题无关的影响面估计）。 */
if (!has("--callers") && !has("--call-graph")) {
  const res = analyze({ base: val("--base", has("--range") ? val("--range") : "HEAD"), staged: has("--staged") })
  console.log(JSONOUT ? JSON.stringify(res, null, 1) : render(res))
}

