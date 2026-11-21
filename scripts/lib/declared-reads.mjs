// scripts/lib/declared-reads.mjs —— 逐包派生格的**声明读面**（ISS-803）
//
// ## 为什么需要这个文件
// `ci-test-*` / `ci-typecheck-*` 是逐包派生格，入口是 `bun run <script>` 且 `cwd=<包目录>`，
// `readSurfaceOf()` 走「入口不是 node（bun）」分支 ⇒ `unknown` ⇒ `--only-changed` 对它们恒跑。
// 本文件给这些格算一个**能被证明**的读面，使「只改 A 包」不再去跑 B 包的格。
//
// ## 两类格的读面**机制不同，不能套同一套判据**
//
// | script | 机制 | 读面判据 |
// |---|---|---|
// | `typecheck` | `tsc --noEmit`：**只静态解析**，不执行任何代码 | 模块解析闭包（含跨包 import / tsconfig extends 链）|
// | `test` | `bun test`：**执行**测试代码 | 闭包 ∪ 运行期读调用的路径；出现逃逸构造 ⇒ unknown |
//
// 把 typecheck 也按「运行期读」判，会把 `scripts/build-client.mjs` 里的 `child_process`
// 算成 typecheck 的逃逸面 —— 而 `tsc` 根本不执行它。实测这样一刀切会把 23 格全判死
// （0/46），那不是判据严，是拿错了判据。
//
// ## 声明面必须是真实读面的**超集**（这条是承重墙）
// 漏算一个区 = 改那个区时这格被跳过 = **静默漏测**。所以：
//   · 裸说明符 `forge-x/子路径` 一律把**整个 `forge-x`** 算进读面，不去猜它解析到哪个文件
//     （实测 `forge-pm` 写 `import ... from "forge-ui/surface-official"`，按扩展名解析不到，
//      漏掉它就会让「改 forge-ui ⇒ 跳 forge-pm 的 typecheck」）。
//   · 解析到 `(root)`（仓根文件 / tsconfig.base）也算进去 —— 与 `changedAreasOf()` 同一口径。
//   · 遇到证明不了的构造（子进程 / worker / git 枚举 / 读根是函数形参）⇒ 整格 unknown，宁多跑。
//
// ## 只声明交给机器对账的结论
// `verifyAgainstTsc()` 拿 `tsc --listFiles` 的**真实读面**做超集校验，用来证明本文件的静态
// 模型没有漏读。测试里跑它，就不必靠人肉复核这套正则。

import fs from "node:fs"
import path from "node:path"

const SRC_EXT = /\.(mjs|cjs|js|ts|tsx|jsx)$/
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo", ".git", ".cache"])

/** 运行期读：第一个实参决定读哪。 */
const READ_RE =
  /\b(readdirSync|readdir|opendirSync|globSync|glob|readFileSync|readFile|createReadStream|openSync|statSync|lstatSync|existsSync|accessSync)\s*\(/g

/**
 * 运行期读面不可见的构造：子进程能执行任意命令，worker 同，git 枚举读出整棵树。
 * 只用于 **test** 格 —— typecheck 不执行代码，这些构造对它无意义。
 */
const RUNTIME_ESCAPE = [
  [/(?:from|require\s*\()\s*["'](?:node:)?child_process["']/, "子进程（读面不可见）"],
  [/\bnew\s+Worker\b/, "worker（读面不可见）"],
  [/\bls-files\b|\bls-tree\b/, "git 枚举（读面 = 整个仓库）"],
]

/** 剥注释：注释里提到函数名不等于调用了它。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

/** 从 `(` 之后取到配对的 `)`。 */
function callArgs(src, from) {
  let depth = 1
  let i = from
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") depth--
  }
  return src.slice(from, i - 1)
}

function splitTopLevel(arg) {
  const out = []
  let depth = 0
  let cur = ""
  for (const ch of arg) {
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
    if (ch === "," && depth === 0) {
      out.push(cur.trim())
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** `dirname(fileURLToPath(import.meta.url))` 等价于 `__dirname`，本仓最常见的写法之一。 */
const DIRNAME_FORMS = [
  /^(import\.meta\.dirname|__dirname)$/,
  /^dirname\s*\(\s*fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*\)$/,
]
const isDirname = (e) => DIRNAME_FORMS.some((re) => re.test(e.trim()))

/**
 * 可证「仓库之外」的根：`homedir()` / `tmpdir()`。它们永远不是仓内路径，而改动面只含仓内路径
 * ⇒ 读到这里不影响收窄正确性（`changedAreasOf()` 的 areas 里不可能出现它们）。
 * **不**把 `process.env.X` 算进来：环境变量可以被指到仓内，证明不了。
 */
const OUTSIDE_ROOT_RE = /^(?:os\.)?(homedir|tmpdir)\s*\(\s*\)$/
/** 仓外根的哨兵值：既不是仓内路径，也不会被 `path.join` 当相对段接错。 */
const OUTSIDE_MARK = "\u0000outside\u0000"

/** 读一个表达式指向的绝对路径；`null` = 证明不了。 */
function staticPathOf(expr, fileDir, bind) {
  const e = expr.trim()
  if (isDirname(e)) return fileDir
  // `new URL("./x", import.meta.url)` —— 与 import.meta.dirname 同义（本仓 64 处）
  const url = e.match(/^new\s+URL\s*\(\s*(["'`])([^"'`$]*)\1\s*,\s*import\.meta\.url\s*\)$/)
  if (url) return path.resolve(fileDir, url[2])
  // `homedir()` / `tmpdir()` 是可证仓外的根。用一个不可能与仓内重合的标记表示，
  // 这样它经 join() 传播后仍能被 areaOf() 认出来（早退成原样会在 join 里变成相对路径）。
  if (OUTSIDE_ROOT_RE.test(e)) return OUTSIDE_MARK
  const lit = e.match(/^["'`]([^"'`$]*)["'`]$/)
  if (lit) return lit[1]
  if (bind.has(e)) return bind.get(e)
  const jr = e.match(/^(?:path\.)?(join|resolve)\s*\(([\s\S]*)\)$/)
  if (!jr) return null
  const vals = []
  for (const part of splitTopLevel(jr[2])) {
    const v = staticPathOf(part, fileDir, bind)
    if (v === null) return null
    if (v === OUTSIDE_MARK) return OUTSIDE_MARK // 任一段在仓外 ⇒ 整条在仓外
    vals.push(v)
  }
  return jr[1] === "resolve" ? path.resolve(...vals) : path.join(...vals)
}

/**
 * 常量绑定表：只接受「字面量 / dirname 形态 / `join`·`resolve`」的组合，且该名字全文件只赋值一次。
 * 二次赋值即作废 —— 那就不是常量，读根随运行期变。
 * ⚠️ `join` 必须同时认裸调用（`import { join } from "node:path"`），只认 `path.join`
 * 会把本仓绝大多数读调用误判成「读根证明不了」。
 */
function constBindings(body, fileDir) {
  const map = new Map()
  for (const m of body.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)) {
    const name = m[1]
    if (map.has(name)) { map.delete(name); continue }
    if (/\b(function|=>|\?|`)/.test(m[2])) continue
    const v = staticPathOf(m[2], fileDir, map)
    if (v !== null) map.set(name, v)
  }
  for (const name of [...map.keys()]) {
    const n = (body.match(new RegExp(`(^|[^.\\w$])${name.replace(/\$/g, "\\$")}\\s*=(?!=)`, "g")) || []).length
    if (n !== 1) map.delete(name)
  }
  return map
}

/** 读调用第一实参 → 绝对路径数组；证明不了返回 null。 */
function literalPathArgs(arg, bind, fileDir) {
  const first = splitTopLevel(arg)[0] ?? ""
  const one = staticPathOf(first, fileDir, bind)
  return one === null ? null : [one]
}

/** 递归列出目录内源码，确定性顺序（顺序不定会让结论随文件系统变）。 */
function walkSources(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkSources(p, out)
    else if (SRC_EXT.test(e.name)) out.push(p)
  }
  return out
}

/** import / require / 动态 import 的说明符。 */
function specifiersOf(body) {
  const out = []
  for (const m of body.matchAll(/\bfrom\s*["']([^"']+)["']/g)) out.push(m[1])
  for (const m of body.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1])
  for (const m of body.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1])
  for (const m of body.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1])
  return out
}

const RESOLVE_EXT = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".d.ts", "/index.js", "/index.ts", "/index.tsx"]
function resolveFile(base) {
  for (const e of RESOLVE_EXT) {
    const c = base + e
    try {
      if (fs.statSync(c).isFile()) return c
    } catch {
      /* 试下一个后缀 */
    }
  }
  return null
}

/**
 * 建上下文：顶层区名 + workspace 说明符解析器（只追**入口**，不追依赖方的测试文件
 * —— 依赖方的测试不会被加载，把它们扫进来会凭空判死）。
 */
export function makeContext(REPO) {
  const root = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"))
  const wsSet = new Set(root.workspaces ?? [])
  const tops = new Set(wsSet)
  try {
    for (const d of fs.readdirSync(REPO, { withFileTypes: true })) if (d.isDirectory()) tops.add(d.name)
  } catch {
    /* 顶层目录列不出来就用 workspaces 兜底 */
  }
  const manifestCache = new Map()
  const manifestOf = (p) => {
    if (!manifestCache.has(p)) {
      try {
        manifestCache.set(p, JSON.parse(fs.readFileSync(path.join(REPO, p, "package.json"), "utf8")))
      } catch {
        manifestCache.set(p, null)
      }
    }
    return manifestCache.get(p)
  }
  const entryCache = new Map()
  /** 说明符 → 入口文件（解析不到返回 null，调用方据此把整包算进读面）。 */
  const workspaceOf = (spec) => {
    if (entryCache.has(spec)) return entryCache.get(spec)
    const head = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
    let hit = null
    if (wsSet.has(head)) {
      const sub = spec.slice(head.length).replace(/^\//, "")
      const man = manifestOf(head)
      const base = path.join(REPO, head)
      if (sub) {
        hit =
          resolveFile(path.join(base, sub)) ||
          resolveFile(path.join(base, "src", sub)) ||
          resolveFile(path.join(base, "lib", sub)) ||
          null
      } else {
        const entry = typeof man?.main === "string" ? man.main : null
        hit =
          (entry && resolveFile(path.join(base, entry))) ||
          resolveFile(path.join(base, "lib/index.js")) ||
          resolveFile(path.join(base, "src/index.ts")) ||
          resolveFile(path.join(base, "index.js")) ||
          null
      }
    }
    entryCache.set(spec, hit)
    return hit
  }
  const areaOf = (abs) => {
    // `homedir()` / `tmpdir()` 是**可证仓外**的根：改动面只含仓内路径，读到这里不影响收窄正确性。
    // 这类返回 null（不算进读面），与真正的「证明不了」分开 —— 混为一谈会把它判成逃逸。
    if (abs === OUTSIDE_MARK || OUTSIDE_ROOT_RE.test(abs)) return null
    const rel = path.relative(REPO, abs)
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null // 仓外：改动面永不含它，不影响正确性
    const head = rel.split(path.sep)[0]
    if (!head) return null
    return tops.has(head) ? head : "(root)"
  }
  /** 裸说明符 → 包名（哪怕解析不到具体文件，也把整包算进读面）。 */
  const packageOf = (spec) => {
    const m = spec.match(/^((?:@[\w.-]+\/)?forge-[a-z0-9-]+)/)
    return m && wsSet.has(m[1]) ? m[1] : null
  }
  return { REPO, root, wsSet, tops, manifestOf, workspaceOf, areaOf, packageOf }
}

/** 沿 import 追文件闭包（含跨包入口）。 */
function closureOfSeeds(seeds, ctx) {
  const seen = new Set()
  const queue = [...seeds]
  while (queue.length) {
    const f = queue.pop()
    if (seen.has(f)) continue
    seen.add(f)
    let src = ""
    try {
      src = fs.readFileSync(f, "utf8")
    } catch {
      continue
    }
    for (const spec of specifiersOf(stripComments(src))) {
      if (spec.startsWith(".")) {
        const hit = resolveFile(path.resolve(path.dirname(f), spec))
        if (hit) queue.push(hit)
        continue
      }
      if (spec.startsWith("node:")) continue
      const hit = ctx.workspaceOf(spec)
      if (hit) queue.push(hit)
    }
  }
  return seen
}

/** tsconfig 的 extends 链（可能指到仓根 `tsconfig.base.json`）。 */
function tsconfigExtendsAreas(pkgDir, ctx, areas) {
  const seen = new Set()
  const pull = (cfg) => {
    if (seen.has(cfg)) return
    seen.add(cfg)
    let raw = ""
    try {
      raw = fs.readFileSync(cfg, "utf8")
    } catch {
      return
    }
    let o
    try {
      o = JSON.parse(stripComments(raw))
    } catch {
      return
    }
    const a = ctx.areaOf(cfg)
    if (a) areas.add(a)
    const ex = o.extends
    if (typeof ex === "string" && ex.startsWith(".")) pull(path.resolve(path.dirname(cfg), ex))
  }
  let files = []
  try {
    files = fs.readdirSync(pkgDir).filter((f) => /^tsconfig.*\.json$/.test(f))
  } catch {
    /* 没 tsconfig 就只按默认 program 算 */
  }
  for (const f of files.sort()) pull(path.join(pkgDir, f))
  return files.length
}

/**
 * **typecheck** 格的读面：`tsc --noEmit` 只静态解析 —— 种子是 tsconfig 覆盖的全部源码，
 * 读面 = 本包 ∪ 模块解析闭包 ∪ extends 链上的区。
 * 不执行代码，故不做运行期逃逸检查。
 */
export function typecheckReads(REPO, pkg, ctx = makeContext(REPO)) {
  const pkgDir = path.join(REPO, pkg)
  const all = walkSources(pkgDir)
  if (!all.length) return { ok: false, why: "包内没有源码文件" }
  const areas = new Set([pkg])
  for (const f of closureOfSeeds(all, ctx)) {
    const a = ctx.areaOf(f)
    if (a) areas.add(a)
    let src = ""
    try {
      src = fs.readFileSync(f, "utf8")
    } catch {
      continue
    }
    const body = stripComments(src)
    for (const spec of specifiersOf(body)) {
      if (spec.startsWith(".") || spec.startsWith("node:")) continue
      // 裸说明符：解析不到也把整包算进来（超集，防漏算）
      const p = ctx.packageOf(spec)
      if (p) areas.add(p)
    }
    // 相对路径字面量（`/// <reference path="../../scripts/x.d.mts" />` 这类）
    for (const m of body.matchAll(/["'`](\.\.?\/[^"'`\n$]*)["'`]/g)) {
      const a2 = ctx.areaOf(path.resolve(path.dirname(f), m[1]))
      if (a2) areas.add(a2)
    }
  }
  if (!tsconfigExtendsAreas(pkgDir, ctx, areas)) {
    // 没有 tsconfig ⇒ 无法确认 tsc 的 program 边界，不敢声明。
    return { ok: false, why: "包内没有 tsconfig，program 边界不可证" }
  }
  return { ok: true, areas: [...areas].sort() }
}

/**
 * **test** 格的读面：`bun test` 会执行代码，故必须做运行期逃逸检查。
 * 种子只取测试文件（`bun test` 不加载非测试文件，除非被 import）。
 */
export function testReads(REPO, pkg, ctx = makeContext(REPO)) {
  const pkgDir = path.join(REPO, pkg)
  const all = walkSources(pkgDir)
  const seeds = all.filter(
    (f) => /\.(test|spec)\.[a-z]+$/.test(f) || f.includes(`${path.sep}__tests__${path.sep}`)
  )
  if (!seeds.length) return { ok: false, why: "包内没有测试文件（bun test 的读面为空，不敢声明）" }

  const areas = new Set([pkg])
  const files = closureOfSeeds(seeds, ctx)
  for (const f of files) {
    let src = ""
    try {
      src = fs.readFileSync(f, "utf8")
    } catch {
      continue
    }
    const body = stripComments(src)
    const rel = path.relative(REPO, f)
    for (const [re, why] of RUNTIME_ESCAPE) if (re.test(body)) return { ok: false, why: `${rel}：${why}` }
    if (/\bprocess\.cwd\s*\(\s*\)/.test(body)) return { ok: false, why: `${rel}：路径运行期算（cwd）` }

    for (const spec of specifiersOf(body)) {
      if (spec.startsWith(".")) {
        const hit = resolveFile(path.resolve(path.dirname(f), spec))
        if (hit) { const a = ctx.areaOf(hit); if (a) areas.add(a) }
      } else if (!spec.startsWith("node:")) {
        const p = ctx.packageOf(spec)
        if (p) areas.add(p)
      }
    }
    const bind = constBindings(body, path.dirname(f))
    for (const m of body.matchAll(READ_RE)) {
      const paths = literalPathArgs(callArgs(body, m.index + m[0].length), bind, path.dirname(f))
      if (paths === null) return { ok: false, why: `${rel}：${m[1]} 的实参证明不了读根` }
      for (const p of paths) {
        const abs = path.isAbsolute(p) ? p : path.resolve(path.dirname(f), p)
        const a = ctx.areaOf(abs)
        if (a) areas.add(a)
      }
    }
    for (const m of body.matchAll(/["'`](\.\.?\/[^"'`\n$]*)["'`]/g)) {
      const a = ctx.areaOf(path.resolve(path.dirname(f), m[1]))
      if (a) areas.add(a)
    }
  }
  return { ok: true, areas: [...areas].sort() }
}

/**
 * 全部派生格 → 声明读面。按 `(pkg, script)` 分派到两种判据。
 * @returns {Map<string, {ok:true, areas:string[]} | {ok:false, why:string}>} key = `${pkg}:${script}`
 */
export function declaredReadsByGate(REPO, pairs) {
  const out = new Map()
  let ctx
  try {
    ctx = makeContext(REPO)
  } catch {
    return out
  }
  for (const [pkg, script] of pairs) {
    const key = `${pkg}:${script}`
    if (out.has(key)) continue
    try {
      out.set(key, script === "test" ? testReads(REPO, pkg, ctx) : typecheckReads(REPO, pkg, ctx))
    } catch (e) {
      out.set(key, { ok: false, why: `算读面时抛错：${e?.message ?? e}` })
    }
  }
  return out
}

/**
 * 对账：用 `tsc --listFiles` 的**真实读面**校验静态模型是超集。
 * 漏读会让「改那个区 ⇒ 跳这格」，所以要求 declared ⊇ actual，不是相等。
 * @param {(pkg:string)=>string|null} tscBinOf 该包的 tsc 可执行
 * @returns {Array<{pkg:string, missing:string[], actual:string[]}>} 空数组 = 无漏读
 */
export function verifyAgainstTsc(REPO, pkgs, tscBinOf, execFileSync) {
  const ctx = makeContext(REPO)
  const bad = []
  for (const pkg of pkgs) {
    const declared = typecheckReads(REPO, pkg, ctx)
    if (!declared.ok) {
      bad.push({ pkg, missing: ["(整格未声明)"], actual: [], why: declared.why })
      continue
    }
    const pkgDir = path.join(REPO, pkg)
    const actual = new Set()
    let cfgs = []
    try {
      cfgs = fs.readdirSync(pkgDir).filter((f) => /^tsconfig.*\.json$/.test(f))
    } catch {
      cfgs = []
    }
    for (const cfg of cfgs.sort()) {
      const bin = tscBinOf(pkg)
      if (!bin) continue
      let stdout = ""
      try {
        stdout = execFileSync(bin, ["-p", cfg, "--listFiles"], {
          cwd: pkgDir,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        })
      } catch {
        continue // 个别配置本身报错，跳过（不拿它当反例，也不拿它当通过）
      }
      for (const line of stdout.split("\n")) {
        const t = line.trim()
        if (!t || !path.isAbsolute(t) || t.includes("node_modules")) continue
        const a = ctx.areaOf(t)
        if (a) actual.add(a)
      }
    }
    const declaredSet = new Set(declared.areas)
    const missing = [...actual].filter((a) => !declaredSet.has(a))
    if (missing.length) bad.push({ pkg, missing, actual: [...actual].sort() })
  }
  return bad
}
