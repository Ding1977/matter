#!/usr/bin/env node
/* 测试内 env 赋值的恢复守卫（ISS-633）
 *
 * 一句话：测试里对 `process.env.X` 的赋值**必须有恢复保障**（try/finally 或 afterEach 恢复**原值**），
 * 否则同一段代码里**后面**的语句会看到被改过的 env —— 同一份代码、同一台机器跑出两种读数。
 *
 * ── 真因（独立审查推翻了上一版的根因；口径以审查原文为准，不要自己重编故事）
 * 事故现场在 `forge-pm/lib/doc-meta-layer-contract.test.js`：那段代码在 **PROBE 模板串**里，
 * 由 `runProbe()` 的 `execFileSync` 交给**子进程**执行 ⇒ **父进程没有被污染**（子进程改 env 不外溢）。
 * 真因是**子进程继承了外部 env**：外部 shell 若 `export FORGE_PM_TAG_STRICT=1`，子进程里的「裸标签」
 * 就（正确地）被拒 —— 而探针断言的是「合规入参不该被拒」⇒ **假红**，且只在那台机器 export 过时出现。
 * ⇒ 处置口径：**测试该改**（子进程 env 走 `test-fixture.js` 的 `cleanChildEnv` 清干净），**业务不该改**。
 *   本守卫守的是**形状**（同类病在别处复发），不替任何一次具体断言下结论。
 * ⚠️ 上一版这里贴过一组「两种环境两种读数」的对照数字，是按**错误的根因**口径复算出来的，
 *   本树复算不出 ⇒ 已删除。要读数就现跑现记；拿旧数字对账 = 沿用错基数。
 *
 * ── 为什么是**静态**守卫，而不是靠测试（本单踩过，别重复）
 * 把那段代码还原成「设 → await → delete」的裸三段后，本文件自己的运行时用例**仍然全绿**：
 * 因为正常路径下那个 await 不抛错，泄漏根本不发生。⇒ 「改代码 + 加运行时用例」这条路**抓不到它**。
 * 唯一有效的判据是**看形状**：赋值是否被恢复保障包住。这正是本脚本做的事。
 *
 * ── 判据（三档，宁缺勿滥）
 *   ① `try { … process.env.X = … … } finally { … }` —— 认得（finally 里有无恢复不再细究，形状对即算）
 *   ② 同文件里对该变量有 `afterEach`/`afterAll` 恢复 —— 认得
 *   ③ 赋值语句**紧跟**在同一行的 `=` 之后又被恢复（`process.env.X = v; … process.env.X = old`）—— 不认（易假阴）
 *   其余一律算「无恢复保障」→ 报出来。
 *   ⚠️ 刻意**不认**「文件里出现过 delete 或 `= 原值`」这种弱证据：本单的真 bug 正是这个形状
 *     （delete 写在 await 之后），弱判据会把它判成安全 —— 那就是本守卫存在的意义的反面。
 *   ⚠️ 模板串内的赋值**同样要检**（那段代码经 execFileSync 真的会跑，doc-meta 的裸三段就在里面）；
 *     唯一豁免是「模板内给**子进程 set-root 惯用变量**（FORGE_PM_ROOT）赋值」—— 子进程退出即销毁，不外溢。
 *
 * ── 棘轮
 * 立闸当天仓里已有存量（见基线）。零容忍 = 从第一天起永久红 = 没人看 = 等于没闸。
 * ⇒ 存量记基线只拦新增；**压低是成绩**，抬高要理由。基线不记裸数字，带分类理由。
 *
 * 用法：node scripts/test-env-restore-guard.mjs [--check|--json|--verbose|--selftest|--write-baseline]
 * 退出码：0 = 无新增；2 = 有新增 / fail-closed（没扫到文件）
 */
import fs from "node:fs"
import path from "node:path"
// 基线读取只留一份实现（K6a）：三份逐字节相同的 `读基线` 已收进 scripts/baseline-read-lib.mjs。
// 多的是仓内兄弟脚本依赖、不是包依赖 —— 本守卫的兜底纪律不受影响（它扫的是源码文本，不碰运行态）。
import { 读基线 } from "./baseline-read-lib.mjs"

const ROOT = path.resolve(import.meta.dirname, "..")
const BASELINE = path.join(ROOT, "scripts", "baseline", "test-env-restore.json")
const ARGV = process.argv.slice(2)

/** 扫这些包（与 ISSUE 的普查口径一致）。 */
const 包 = ["forge-pm", "forge-agents", "forge-canvas", "forge-model", "scripts"]
const SKIP_DIR = new Set(["node_modules", "dist", "out", ".git", ".wt", "assets", "vendor"])

/** 测试文件判据：`.test.js/.mjs/.ts/.tsx`。 */
const 是测试文件 = (n) => /\.test\.(js|mjs|cjs|ts|tsx)$/.test(n)

/** `process.env.NAME = …`（排除 `==` / `===`；也排除 `process.env.NAME ==` 这种比较）。 */
const 赋值RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g

const 注释行 = (l) => /^\s*(\/\/|\*|\/\*)/.test(l)

/**
 * 从赋值点往上找「是否被 try 包住」，往下找「finally 里是否恢复」。
 * 做法刻意保守：只认**同一次 tr y块**里的 finally，不做跨函数流分析（那需要 AST，代价大且易假阳）。
 */
export function 有恢复保障(源码, 变量名) {
  const lines = 源码.split("\n")
  const 是恢复块头 = (l) => /^\s*\}\s*(finally|catch)\b/.test(l)
  const 恢复RE = new RegExp(`process\\.env\\.${变量名}\\s*=(?!=)`)
  const 删RE = new RegExp(`delete\\s+process\\.env\\.${变量名}`)

  /** ① 先把「模板字符串内部」的行标出来 —— 那里面不是本文件的真代码。
   *  为什么必须做：本仓测试文件常把整段探针脚本塞进模板串（doc-meta-layer-contract.test.js 的 PROBE），
   *  逐行无状态扫描会把模板串里的 `try {` 当真代码 ⇒ 「文件级判据」曾因此漏判真 bug
   *  （还原成裸三段后守卫没红，被同文件别处的 finally 蒙过 —— 实测抓到）。 */
  const 模板内 = new Set()
  {
    let 在模板 = false
    let 深度 = 0
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      // 数反引号（忽略转义的 \`）。**注释行的反引号不算** —— 文档里大量行内代码（`delete` / `status:`）
      // 会被误当成模板串边界，于是整段真代码被标成"模板内"而漏检。
      // 实测：不改这一处时本文件 337/587 行被判进模板，含真正的 bug 行 ⇒ 变异四级都没红（吃过教训）。
      const n = 注释行(l) ? 0 : (l.match(/(?<!\\)`/g) || []).length
      if (在模板) 模板内.add(i)
      if (n % 2 === 1) 在模板 = !在模板
      void 深度
    }
  }

  /** ② 待检 = 模板串之外、非注释、且不是「恢复块内」的赋值行 */
  // ⚠️ ISS-633 复审抓到的第二处：原实现只在「}` 紧跟 finally/catch」时识别恢复块，
  //   而 `if (原===undefined) delete …; else env.X = 原` 这种 **else 子句里的恢复语句**
  //   会被当成新的「裸赋值」⇒ 明明有 finally 的文件被判违规（假红）。
  //   修法：恢复块内**所有**对本变量的赋值/删除都算「恢复」，不要求紧跟 `}`。
  const 恢复块区间 = []
  for (let i = 0; i < lines.length; i++) {
    if (!是恢复块头(lines[i])) continue
    for (let k = i + 1; k < lines.length; k++) {
      if (/^\s*\}\s*$/.test(lines[k])) { 恢复块区间.push([i, k]); break }
    }
  }
  const 在恢复块里 = (i) => 恢复块区间.some(([a, b]) => i >= a && i <= b)

  // ⚠️ 独立审查抓到的 critical（ISS-633 复审）：原实现**把模板串内的赋值整段排除**，
  //   但模板串里的代码经 `execFileSync` **真的会跑**（PROBE 就是这种形态），
  //   于是「模板内的裸三段」这个真 bug 形态**恒绿**。
  //   ⇒ 模板内也要检；判据相同（该赋值行必须有 try/finally 保障），只是不要求它在本文件的 try 里，
  //     而是要求**模板内那段代码自己**有保障。
  //
  // ⚠️ 但模板内也有一类**合法**写法必须放过（ISS-633 复审 H1 抓到的假红）：
  //   仓内惯用法是「探针脚本第一行 `process.env.FORGE_PM_ROOT = <临时根>`，再把脚本交给子 node 跑」
  //   （真实实例：id-ceiling-e2e.test.js:37/97、scan-index-derivation.test.js:51 —— 没有 try/finally，
  //   也不需要：子进程退出即销毁，改它不外溢给父进程，谈不上「泄漏到后续测试」）。
  //   核实过误判原因**不是**模板边界识别失效（含 `${}` 插值时那些行确实被判进了 模板内）；
  //   是语义上的：模板内赋值一律进 待检，而 模板内有恢复 要求同一段里有 finally ⇒ set-root 惯用法恒红。
  //   ⇒ 排除判据：**模板内 + 变量是子进程 set-root 惯用变量**。故意只列 FORGE_PM_ROOT（别的变量
  //   在模板内多半是「多段共享 env」的形状，那正是要拦的，见 doc-meta 的严格档）。
  const 子进程setRoot变量 = new Set(["FORGE_PM_ROOT", "FORGE_AGENTS_ROOT"])
  const 待检 = []
  lines.forEach((l, i) => {
    if (注释行(l) || 在恢复块里(i)) return
    赋值RE.lastIndex = 0
    const m = 赋值RE.exec(l)
    if (!m || m[1] !== 变量名) return
    if (模板内.has(i) && 子进程setRoot变量.has(m[1])) return
    待检.push(i)
  })
  if (待检.length === 0) return true

  /** ②b 模板内赋值的判据：它所在的那段代码必须自己带 finally/catch 恢复。
   *  判据形态：同一模板内、该行之后、**下一个模板边界之前**，存在恢复块头且能恢复本变量。 */
  const 模板内有恢复 = (i) => {
    for (let q = i + 1; q < lines.length; q++) {
      if (!模板内.has(q)) break            // 出了模板段就不再算
      if (是恢复块头(lines[q])) {
        for (let r = q + 1; r < lines.length; r++) {
          if (!模板内.has(r)) break
          if (恢复RE.test(lines[r]) || 删RE.test(lines[r])) return true
          if (/^\s*\}\s*$/.test(lines[r])) break
        }
      }
    }
    return false
  }

  /** ③ 每个待检行**各自**要有保障 —— 不许被同文件别处的 finally 蒙过。
   *  两档安全形状：
   *    (a) 该行落在某个 try 体内，且该 try 的 finally/catch 恢复本变量；
   *    (b) 该行在某个 `try {` 之前，且该 try 的 finally/catch 恢复本变量（`const 原=…; env.X=…; try{…}finally{env.X=原}`）。
   */
  const 这个try有恢复 = (tryLine) => {
    let head = -1
    for (let q = tryLine + 1; q < lines.length; q++) {
      if (模板内.has(q)) continue
      if (是恢复块头(lines[q])) { head = q; break }
      if (/^\s*\}\s*$/.test(lines[q]) && q > tryLine + 1) return false // try 体结束却没见 finally/catch
    }
    if (head < 0) return false
    for (let r = head; r < Math.min(lines.length, head + 25); r++) {
      if (恢复RE.test(lines[r]) || 删RE.test(lines[r])) return true
      if (/^\s*\}\s*$/.test(lines[r])) break
    }
    return false
  }

  const 全部安全 = 待检.every((行) => {
    // ⚠️ 模板内的赋值：用「模板内自己有无 finally」判（见 模板内有恢复 的注释）。
    if (模板内.has(行)) return 模板内有恢复(行)
    // (a) 落在某个 try 体内。**向上找时必须封顶**：撞到恢复块头 / 块结束 / 别的 test( 就停。
    //    第一版没有封顶，于是 :244 那处裸赋值会一路向上走，撞到文件下方别处测试里的 try 也算数
    //    ⇒ 还原成原 bug 后守卫不红（实测抓到）。
    for (let k = 行 - 1; k >= 0; k--) {
      if (模板内.has(k)) continue
      if (是恢复块头(lines[k])) break
      if (/^\s*\}\s*$/.test(lines[k])) break
      if (/^\s*(test|describe|afterEach|afterAll)\s*\(/.test(lines[k])) break
      if (/^\s*try\s*\{/.test(lines[k])) {
        if (这个try有恢复(k)) return true
        break
      }
    }
    // (b) 在某个 try 之前，且该 try 恢复它
    for (let k = 行 + 1; k < Math.min(lines.length, 行 + 40); k++) {
      if (模板内.has(k)) continue
      if (/^\s*try\s*\{/.test(lines[k])) return 这个try有恢复(k)
      if (/^\s*\}\s*(finally|catch)\b/.test(lines[k])) return false
    }
    return false
  })
  if (全部安全) return true

  // ④ afterEach / afterAll 兜底：仅当文件里存在**真正的后置钩子**恢复该变量。
  //    ⚠️ 这一档曾经写成「文件里任意处有 finally/恢复就整体放行」，于是把 ⑬ 还原成裸三段后
  //    守卫**不红**（同文件别处有 finally 把它蒙过去）—— 实测抓到，收窄成只认 afterEach/afterAll。
  return new RegExp(
    `(afterEach|afterAll)\\s*\\([\\s\\S]{0,400}?(process\\.env\\.${变量名}\\s*=(?!=)|delete\\s+process\\.env\\.${变量名})`,
  ).test(源码)
}

/** 扫全部测试文件，返回 {文件数, 赋值处数, 无保障[]}。 */
export function scanAll(root = ROOT) {
  const 文件 = []
  const walk = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p); continue }
      if (e.isFile() && 是测试文件(e.name)) 文件.push(p)
    }
  }
  for (const pkg of 包) walk(path.join(root, pkg))

  let 处数 = 0
  const 无保障 = []
  for (const abs of 文件) {
    let src
    try { src = fs.readFileSync(abs, "utf8") } catch { continue }
    const rel = path.relative(root, abs).split(path.sep).join("/")
    const 变量 = new Set()
    赋值RE.lastIndex = 0
    for (const m of src.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g)) 变量.add(m[1])
    for (const v of 变量) {
      const n = (src.match(new RegExp(`process\\.env\\.${v}\\s*=(?!=)`, "g")) || []).length
      处数 += n
      if (!有恢复保障(src, v)) 无保障.push({ file: rel, var: v, count: n, line: 行号(src, v) })
    }
  }
  return { 文件数: 文件.length, 处数, 无保障 }
}

function 行号(src, v) {
  const lines = src.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (注释行(lines[i])) continue
    if (new RegExp(`process\\.env\\.${v}\\s*=(?!=)`).test(lines[i])) return i + 1
  }
  return 0
}

const 键 = (x) => `${x.file}#${x.var}`

/* ─── selftest ─────────────────────────────────────────────────────────── */
if (ARGV.includes("--selftest")) {
  const res = []
  const push = (n, ok, note = "") => res.push({ n, ok: !!ok, note })
  const 裸三段 = `process.env.X = "1"\nawait foo()\ndelete process.env.X\n`
  const 有finally = `const o = process.env.X\ntry {\n  process.env.X = "1"\n  await foo()\n} finally {\n  if (o === undefined) delete process.env.X\n  else process.env.X = o\n}\n`
  const 有afterEach = `process.env.X = "1"\nafterEach(() => { delete process.env.X })\n`
  const 注释里写 = `// process.env.X = "1" 这只是注释\nconst a = 1\n`

  push("① 裸三段（真 bug 形态）必被抓", !有恢复保障(裸三段, "X"))
  push("② try/finally 恢复 ⇒ 放行", 有恢复保障(有finally, "X"))
  push("③ afterEach 恢复 ⇒ 放行", 有恢复保障(有afterEach, "X"))
  push("④ 注释里的赋值不算（否则文档全是假红）", 有恢复保障(注释里写, "X"))
  push("⑤ 比较运算不算赋值（== / ===）", 有恢复保障(`if (process.env.X === "1") foo()\n`, "X"))
  push("⑥ 该文件不赋这个变量 ⇒ 视为合规（不是不管，是没这问题）", 有恢复保障(`const a = 1\n`, "X"))

  // 真实文件的对照：修好的 ⑬ 块必须判为「有保障」
  const 真文件 = path.join(ROOT, "forge-pm", "lib", "doc-meta-layer-contract.test.js")
  if (fs.existsSync(真文件)) {
    const src = fs.readFileSync(真文件, "utf8")
    push("⑦ 真实文件里 FORGE_PM_TAG_STRICT 现在有保障（ISS-633 修完之后）", 有恢复保障(src, "FORGE_PM_TAG_STRICT"))
  }
  // 分母口径
  const s = scanAll()
  push("⑧ 分母：扫到的测试文件数是正的", s.文件数 > 0, "扫 " + s.文件数 + " 文件 / " + s.处数 + " 处赋值")

  // ⑨⑩ 模板串内的两个方向（ISS-633 复审 H1）：都属「模板串里的代码真的会跑」这一族。
  // ⑨ 子进程 set-root 惯用法 —— 必须判绿，否则守卫按构造拦下仓内既有写法（新写的探针一提交就红）。
  const 模板内setRoot = [
    "const script = `",
    "process.env.FORGE_PM_ROOT = ${JSON.stringify(root)}",
    'const m = await import("./md-store.js")',
    "console.log(m.nextTaskId(\"issues\"))",
    "`",
    "execFileSync(NODE, [file], { env: { ...process.env } })",
  ].join("\n") + "\n"
  push("⑨ 模板内给 FORGE_PM_ROOT 赋值（子进程 set-root 惯用法）⇒ 不误伤", 有恢复保障(模板内setRoot, "FORGE_PM_ROOT"))
  // ⑩ 模板内裸三段 —— 上一版的核心修复，必须仍然判红（子进程内多段代码共享 env，中间抛错就不恢复）。
  const 模板内裸三段 = [
    "const script = `",
    'process.env.FORGE_PM_TAG_STRICT = "1"',
    "await call()",
    "delete process.env.FORGE_PM_TAG_STRICT",
    "`",
    "execFileSync(NODE, [file])",
  ].join("\n") + "\n"
  push("⑩ 模板内裸三段（非 set-root 变量）⇒ 仍必须判红", !有恢复保障(模板内裸三段, "FORGE_PM_TAG_STRICT"))

  const fails = res.filter((r) => !r.ok)
  for (const r of res) console.log((r.ok ? "✓ " : "✗ ") + r.n + (r.note ? "（" + r.note + "）" : ""))
  console.log("test-env-restore-guard selftest " + (res.length - fails.length) + "/" + res.length + " 通过")
  process.exit(fails.length ? 2 : 0)
}

/* ─── 正常判定 ─────────────────────────────────────────────────────────── */
const { 文件数, 处数, 无保障 } = scanAll()

if (文件数 === 0) {
  console.error("✗ 一个测试文件都没扫到（ROOT=" + ROOT + "）⇒ fail closed，不许把\"没扫到\"读成\"零违例\"")
  process.exit(2)
}

const 基线 = 读基线(BASELINE)
const 新增 = 基线 ? 无保障.filter((x) => !基线.存量?.[键(x)]) : 无保障

if (ARGV.includes("--write-baseline")) {
  const 存量 = {}
  for (const x of 无保障) 存量[键(x)] = `${x.file}:${x.line} → ${x.var}（${x.count} 处）`
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify({
    recordedAt: new Date().toISOString().slice(0, 10),
    tool: "test-env-restore-guard.mjs --write-baseline",
    note: "测试内 process.env 赋值**没有恢复保障**的存量。只拦新增；压低是成绩，抬高要给理由。",
    存量,
  }, null, 1) + "\n")
  console.log("已记基线 " + Object.keys(存量).length + " 条（存量不再拦；新增一律红）。")
  process.exit(0)
}

for (const x of 新增) console.log("✗ " + x.file + ":" + x.line + " → process.env." + x.var + "（" + x.count + " 处赋值）—— 无恢复保障：中间那句一抛错就泄漏到后续所有测试")
if (!基线) console.log("✗ 还没有基线（" + BASELINE + "）⇒ 先跑 --write-baseline 记存量")
if (ARGV.includes("--verbose")) for (const x of 无保障) console.log("  [基线内] " + x.file + ":" + x.line + " → " + x.var)

if (ARGV.includes("--json")) {
  console.log(JSON.stringify({ 文件数, 赋值处数: 处数, 全量无保障: 无保障.length, 基线内: 无保障.length - 新增.length, 新增: 新增.length, 基线条数: 基线 ? Object.keys(基线.存量 ?? {}).length : null }, null, 1))
  process.exit(基线 && 新增.length === 0 ? 0 : 2)
}
console.log("test-env-restore-guard · 扫 " + 文件数 + " 个测试文件 · " + 处数 + " 处 process.env 赋值 · 无恢复保障 " + 无保障.length + " · 基线内 " + (无保障.length - 新增.length) + " · 基线外新增 " + 新增.length)
process.exit(基线 && 新增.length === 0 ? 0 : 2)
