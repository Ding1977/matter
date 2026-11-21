// impact-of-diff 的自测（ISS-641 收口：从主文件外置，让它回到 K2a 1000 行红线以下）
//
// ## 为什么外置（不是"整理好看"）
// 主脚本一度涨到 1037 行、**越过本仓 K2a 的 1000 行 god-module 红线**（lint-code 因此新增 1 条违例）。
// `scripts/code-inventory.mjs` 的头注里就写着同一句话——「本文件已贴着 K2a 红线，往里加能力=抬棘轮」，
// 它自己也是靠外置（lexical-lib / dup-detail-lib）解决的。本例照那个先例办。
// ⛔ **不许**用删注释或压格式来凑行数：那些注释解释了"为什么不做某事"，是资产不是赘肉。
//     本模块 100% 是判据与判据的自述，主脚本的**执行路径一行都不依赖它**。
//
// ## 依赖注入（为什么不用 import）
// `cliFixtures()` 会把主脚本 `copyFileSync` 进临时仓再起子进程（ROOT 由脚本自身位置推导）。
// 若本模块与主脚本用**静态 import** 相连，那个被复制的副本会在 link 阶段找不到本文件 ⇒ 子进程直接崩，
// 而 cliFixtures 本来只跑 `--who-imports`（不跑 --self-test）—— 崩在一个用不到的分支上，等于白崩。
// 所以主脚本用**动态 import** 拉本模块，且只在 `--self-test` 分支里拉：
// 正常跑 `--who-imports` / diff 时这个文件根本不参与解析。实测验证过复制形态仍能跑。
//
// ## 入参
// 主脚本把自己的内部符号（resolveSpec / factsOf / innermost / renderWhoBlock / classifyTargets …）
// 通过 `deps` 整体交进来。**故意的**：这些符号大量是模块级私有（`const` 而非 `export`），
// 为了外置而把它们全 export，会直接把 K10b（零引用导出）顶高一截 —— 那是用一条违例换另一条。
// 注入既保持了主脚本的私有边界，也让本模块能对"生产用的那同一份实现"做断言（不是另抄一份假设）。
//
// ⚠️ 与主脚本共用同一条纪律：不读源码文本、只验行为（ISS-637 返工的教训）。

import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

export function makeSelfTest(deps) {
  const {
    ROOT, A, has, resolveSpec, factsOf, innermost, gatesFor, isProd, isCode, parseVals,
    scanFiles, analyze, CACHE_DIR, cachePath, cacheStatus, resetIndexForTest, loadIndex,
    INDEX_VERSION, catOf, GROUP_MIN, KNOWN_FLAGS, unknownFlags, parseDepth, renderWhoBlock,
    classifyTargets, reverseLevels, CHANGED_ONLY, QUIET, DEPTH, FILE_RE, VENDOR,
    FIXTURE_DIR_REL, untrackedFiles, untrackedStatus, render, cryptoMod, symbolForRange,
  } = deps

  function cliFixtures(fn) {
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "impact-selftest-"))
    try {
      const run = (args) => execFileSync("git", ["-C", tmp, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      run(["init", "-q"])
      run(["config", "user.email", "selftest@local"])
      run(["config", "user.name", "selftest"])
      const write = (rel, src) => { const abs = path.join(tmp, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, src) }
      /* target ← 12 个同包 importer（走 forge-x/src/lib/ 下，被 catOf 判成 samepkg） */
      const target = "forge-x/src/lib/target.ts"
      write(target, "export const t = 1\n")
      for (let i = 0; i < 12; i++) write(`forge-x/src/lib/imp-${String(i).padStart(2, "0")}.ts`, `import { t } from "./target.ts"\nexport const v${i} = t\n`)
      /* orphan：没人 import 它 ⇒ 供 --only-impacted 折叠用 */
      const orphan = "forge-x/src/lib/orphan.ts"
      write(orphan, "export const o = 1\n")
      /* 二阶链：imp-00 再被 upstream 引用 ⇒ --depth 2 才有东西可报（否则第 2 阶恒空，
         命令行断言「含第 2 阶段」永远绿 ⇒ 抓不到 DEPTH 写死的变异）。 */
      write("forge-x/src/upstream.ts", 'import { v0 } from "./lib/imp-00.ts"\nexport const u = v0\n')
      /* 需要一个 commit，否则 git diff 无基准（--who-imports 不需要 diff，但 index 要干净） */
      run(["add", "-A"]); run(["commit", "-qm", "fixture"])
      /* 子进程的 ROOT 由脚本自身位置推导 ⇒ 把脚本复制进 fixture 仓的 scripts/ 下再跑，
         这样 ROOT=fixture，buildReverse 扫的就是 fixture。typescript 由 loadTs 从 ROOT 找 ——
         fixture 里没有 node_modules ⇒ 用软链指向本仓的 typescript（只读，不新增依赖）。 */
      fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true })
      fs.copyFileSync(path.join(ROOT, "scripts/impact-of-diff.mjs"), path.join(tmp, "scripts/impact-of-diff.mjs"))
      /* ISS-658：主脚本现在 **import** 同目录的 `impact-of-diff-calls.mjs`（调用图实现）。
         只复制主脚本 ⇒ 子进程在 link 阶段就崩（ERR_MODULE_NOT_FOUND），13 条 CLI 用例全红 ——
         而它们的断言文本看起来像「折叠/depth/quiet 失效」，与实际原因（缺文件）毫无关系。
         **凡是主脚本 import 的 sibling 都必须一起复制**：新增一个就要在这里加一行。 */
      fs.copyFileSync(path.join(ROOT, "scripts/impact-of-diff-calls.mjs"), path.join(tmp, "scripts/impact-of-diff-calls.mjs"))
      /* typescript 由 loadTs 从 ROOT 找（forge-ui → forge-pm → root）。fixture 里没有 node_modules，
         ⇒ 软链到本仓的（**只读、不新增依赖**）。⚠️ 必须先建父目录，否则 symlink 报 ENOENT
         —— 返工第一版漏了这步，fixture 子进程直接以「找不到 typescript」退出，三条用例全红。 */
      for (const pkg of ["forge-ui", "forge-pm"]) {
        const src = path.join(ROOT, pkg, "node_modules")
        if (!fs.existsSync(src)) continue
        fs.mkdirSync(path.join(tmp, pkg), { recursive: true })
        try { fs.symlinkSync(src, path.join(tmp, pkg, "node_modules")) } catch { /* 已存在 */ }
      }
      const run2 = (args) => {
        try { return { ok: true, out: execFileSync(process.execPath, [path.join(tmp, "scripts/impact-of-diff.mjs"), ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }), err: "", code: 0 } }
        catch (e) { return { ok: false, out: String(e.stdout || ""), err: String(e.stderr || ""), code: e.status } }
      }
      return fn({ tmp, target, orphan, run: run2 })
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
    }
  }

  function runSelfTest() {
    const cases = [], T = (n, p) => cases.push({ n, p: !!p })
    const S = new Set(["forge-x/src/a.ts", "forge-x/src/b.tsx", "forge-x/src/index.ts"])
    const R = (spec) => resolveSpec("forge-x/src/index.ts", spec, S)
    const dyn = factsOf("d.ts", "const m = require(name)\n")
    /* ⚠️ 第 1 行是 **import 语句**，不是 `const`：ISS-656 之后顶层 `const` 会产 span，
       这条用例问的是「真落在声明间隙的行 ⇒ null」，用一个真实间隙（import 区）来问才对。
       换掉它时**不要动行号**（下面 at(3)/at(5)/at(7)/at(9)/at(10) 全按这版行号写）。 */
    const f = factsOf("fixture.ts", "import { x } from \"./x.js\"\nexport function alpha() {\n  return 1\n}\nexport class Beta {\n  run() {\n    return 2\n  }\n}\nexport const gamma = () => 3\n")
    const at = (line) => innermost(f.spans, line)?.name ?? null
    const memoAt = (src, l) => innermost(factsOf("w.tsx", src).spans, l)?.name
    const ids = (ch, htd) => gatesFor(ch, [], htd).gates.map((x) => x.id)
    // 表驱动：[说明, 实得, 期望]。解析 / 符号定位 / 闸映射三组判据都钉在这里。
    for (const [what, got, want] of [
      ["相对路径 → .ts", R("./a"), "forge-x/src/a.ts"],
      ["相对路径 → .tsx", R("./b"), "forge-x/src/b.tsx"],
      ["目录 → index.ts", resolveSpec("forge-x/src/a.ts", ".", S), "forge-x/src/index.ts"],
      ["解析不到 ⇒ null（不静默编一个）", R("./nope"), null],
      ["node: 内置不算仓内边", R("node:fs"), null],
      ["第三方包不算仓内边", R("react"), null],
      ["forge-design/ui/cn 经 exports 映射", resolveSpec("forge-canvas/src/x.ts", "forge-design/ui/cn", new Set(scanFiles())), "forge-design/src/ui/cn.ts"],
      ["动态 require 进盲区而非静默忽略", dyn.blind.length === 1 && dyn.specs.length === 0, true],
      ["打包产物不当源码分析（vendor 只报文件级）", isCode("forge-cad/static/vendor/cad-engine.js"), false],
      ["函数体内的 hunk → 函数名", at(3), "alpha"],
      ["方法体内的 hunk → 方法名（取最内层）", at(7), "run"],
      ["类体内但不在方法里 → 类", at(5), "Beta"],
      ["模块顶层 → null（渲染成「模块顶层」，不许编符号）", at(1), null],
      ["箭头函数常量 → 名字", at(10), "gamma"],
      ["反控：函数外一行不该被判成 alpha", at(9) !== "alpha", true],
      // 回归线：memo/forwardRef 包裹的组件曾整个漏成「模块顶层」（看着正常，实则漏符号）
      ["memo() 包裹的组件 → 组件名", memoAt("export const Comp = memo(function Comp() {\n  return null\n})\n", 2), "Comp"],
      ["forwardRef() 包裹的组件 → 组件名", memoAt("export const Fwd = forwardRef((p, ref) => null)\n", 1), "Fwd"],
      /* ── ISS-656：顶层 `const/let/var` 必须产 span + 必须标出「是不是导出」 ──
         判据行：**span 命中名字**（不是「文件里出现了这个名字」）+ **exported 位正确**。
         为什么用 `spansOf(src)` 而不是只看 span 数：数数会漏掉「认错了名字」这类错
         （把 `const` 认成初始化器里的某个标识符，总数照样对）。 */
      ...(() => {
        const spansOf = (src) => factsOf("m.js", src).spans
        const byName = (src, n) => spansOf(src).find((s) => s.name === n) || null
        const objFreeze = byName('export const KINDS = Object.freeze(["a", "b"])\n', "KINDS")
        const literalNum = byName("const N = 1\n", "N")
        const literalArr = byName("export const LIST = [1, 2, 3]\n", "LIST")
        const literalObj = byName("export const MAP = { a: 1 }\n", "MAP")
        const req = byName('const http = require("node:http")\n', "http")
        const dynImp = byName('const lazy = import("node:fs")\n', "lazy")
        /* `export { X }` 与声明分处两行：后置回填必须认到（本仓两种顺序都有）。 */
        const reExp = byName("const hidden = 1\nexport { hidden }\n", "hidden")
        const reExpAlias = byName("const local = 1\nexport { local as remote }\n", "local")
        const defExp = byName("const only = 1\nexport default only\n", "only")
        /* 局部 `const` 不进 spans：那不是对外契约，产 span 只会把 hunk 糊到无关局部变量上。 */
        const localInFn = spansOf("export function f() {\n  const buf = []\n  return buf\n}\n").filter((s) => s.name === "buf").length
        /* 既有行为不能收：函数形态的常量在**任意作用域**仍认（含函数体内）。 */
        const nestedFn = spansOf("export function f() {\n  const g = () => 1\n  return g\n}\n").filter((s) => s.name === "g").length
        return [
          ["1576 顶层 Object.freeze([...]) → span 命中且 exported:true", !!objFreeze && objFreeze.exported, true],
          ["1576 顶层数字字面量 → span 命中且 exported:false", !!literalNum && literalNum.exported, false],
          ["1576 顶层数组字面量 → span 命中", !!literalArr, true],
          ["1576 顶层对象字面量 → span 命中", !!literalObj, true],
          ["1576 const http = require(\"x\") → span 命中但 exported:false（局部句柄不是契约）", !!req && req.exported, false],
          ["1576 const x = import(\"x\") → span 命中", !!dynImp, true],
          ["1576 `export { X }` 后置导出 ⇒ exported:true", !!(reExp && reExp.exported), true],
          ["1576 `export { local as remote }` ⇒ 本地名 local 标 exported", !!(reExpAlias && reExpAlias.exported), true],
          ["1576 `export default X` ⇒ exported:true", !!(defExp && defExp.exported), true],
          ["1576 反控：函数体内的 const 不产 span（只放宽顶层）", localInFn, 0],
          ["1576 反控：函数体内的箭头常量仍产 span（既有行为不收）", nestedFn, 1],
          /* 向后兼容：既有四个字段名一个不许改（symbols.js 的 symbolForRange 与 index-store.js 的
             symbolSpan 都在读），只许新增 `exported`；放宽档额外带 `fallback`（匹配时降级用）。
             ⚠️ 这条按**必含字段**判，不 `.length === 5` —— 按个数判会在新增字段时假红（我就撞了一次）。 */
          ["1576 spans 元素保留 {name,kind,start,end} 且带 exported（既有字段名不变）", (() => {
            const s = objFreeze
            return !!s && ["name", "kind", "start", "end", "exported"].every((k) => k in s) && s.name === "KINDS"
          })(), true],
          ["1576 既有档 span 不带 fallback 位（老 span 形状不多出字段）", (() => {
            const sp = factsOf("t.js", "export function f() {\n  return 1\n}\n").spans[0]
            return !sp || !("fallback" in sp)
          })(), true],
          /* 真相样本：本仓 `forge-agent-protocol/lib/index.js` 的 5 个 export const（ISS-656 实测样本）。
             用真文件而不是自编样本 —— 本仓踩过「自测样本编得太整齐、真实形态漏掉」的坑（isProd 那次）。 */
          ["1576 真样本：index.js 的 PROTOCOL_VERSION/MSG_KINDS/ASK_KINDS/ASK_DECISIONS/AGENT_EVENT_KINDS 全部有 span",
            (() => {
              const abs = path.join(ROOT, "forge-agent-protocol/lib/index.js")
              if (!fs.existsSync(abs)) return false
              const sp = factsOf("forge-agent-protocol/lib/index.js", fs.readFileSync(abs, "utf8")).spans
              const want = ["PROTOCOL_VERSION", "MSG_KINDS", "ASK_KINDS", "ASK_DECISIONS", "AGENT_EVENT_KINDS"]
              return want.every((n) => sp.some((s) => s.name === n && s.exported === true))
            })(), true],
          /* 同区间平局（ISS-656 返工）：`var g = { create(){} }` 会让变量声明与内联方法**行区间完全相同**，
             平局先到先得 ⇒ 更外层的 `g` 会顶掉原本能命中的 `create`。那不是新增 span，是符号名被换差。
             判据用真仓实测形态（demo-layers.js:147 那种「顶层变量 + 内联方法」写法）。 */
          /* ── 回归线（返工核心）：**0 长度 span 跨区间抢占** ──
             第一版把放宽出来的常量与既有 span 混在一池交给「取最短」，结果
             `const DSH_URL = dshUrl()`（单行 ⇒ 区间长 0）跨区间顶掉整个函数。
             独立复核实测 357 处改名、220 处「函数名 → 全大写常量名」。
             ⇒ 放宽档必须是 **fallback（兜底）**：既有档有候选时它一律不参与。
             下面三条就是按真实踩到的三例写的（main.js / index.js / no-new-tailwind.mjs）。 */
          /* ⚠️ 这三条的形状必须让**常量与函数同时成为候选**，才验得到抢占。
             第一版写成「ref 落在函数体内、常量在别处」⇒ 常量压根不是候选 ⇒ 变异「去掉分档」照样绿
             （实测存活过一轮）。真实形态是锚点**跨两个相邻 span**：
             `electron-shell/main.js` ref `44-53` 同时与 `dshUrl[50,52]`、`DSH_URL[53,53]` 相交。 */
          ["1576 回归：锚点跨尾时，0 长度常量不许抢走前面的函数（ref 3-4 取 f 不取 K）",
            (() => {
              const src = "export function f() {\n  return 1\n}\nconst K = 0\n"
              const sp = factsOf("t.js", src).spans
              return sp.some((x) => x.name === "K" && x.fallback)     // 先确认 K 真是 fallback 档
                ? innermost(sp, 3)?.name : "PRECONDITION-FAILED"
            })(), "f"],
          ["1576 回归：锚点跨头时同理（ref 1-4 取 f 不取 K）",
            (() => {
              const src = "const K = 0\nexport function f() {\n  return 1\n}\n"
              const sp = factsOf("t.js", src).spans
              return sp.some((x) => x.name === "K" && x.fallback) ? innermost(sp, 2)?.name : "PRECONDITION-FAILED"
            })(), "f"],
          ["1576 回归：真仓形态复刻（dshUrl/dshUrl 常量相邻，锚点跨两者取函数）",
            (() => {
              const src = "const dshUrl = () => {\n  return \"x\"\n}\nconst DSH_URL = dshUrl()\n"
              const sp = factsOf("t.js", src).spans
              return innermost(sp, 3)?.name
            })(), "dshUrl"],
          /* ── 真正的抢占发生在**区间匹配**（wiki 索引走的是 symbolForRange），不是单行 ──
             实测真仓：`electron-shell/main.js` ref `44-53` 同时与 `readDshTokenUrl[29,49]`(长20,
             ) 和 `DSH_URL[53,53]`(长0) 相交 ⇒ 单池竞争报 `DSH_URL`（错），两轮报函数（对）。
             这两条是返工的核心回归线：`innermost` 按单行匹配，构造不出跨 span 抢占
             （我第一版只用 innermost 写用例，变异「去掉分档」照样绿 —— 就是这么漏的）。 */
          /* ⚠️ `symbolForRange` 拿不到时这三条报 SKIP（不可能绿）——
             副本场景（cliFixtures）里没有 lib/，静默跳过会让「判据同口径」这件事无人守。 */
          ...(!symbolForRange ? [["1576 核心回归：symbolForRange 不可用 ⇒ 三条区间用例 SKIP", false, true]] : (() => {
            const R = (spans, s, e) => symbolForRange(spans, s, e).symbol
            const FUNC = { name: "readDshTokenUrl", kind: "VariableDeclaration", start: 29, end: 49, exported: false }
            const CONST0 = { name: "DSH_URL", kind: "VariableDeclaration", start: 53, end: 53, exported: true, fallback: true }
            return [
              ["1576 核心回归：区间匹配下 0 长度常量不许抢走跨尾的既有函数（ref 44-53 型）", R([FUNC, CONST0], 44, 53), "readDshTokenUrl"],
              ["1576 核心回归：单池竞争会报 DSH_URL（反控：证明上一条真的在验抢占，不是恒真）",
                (() => { const noFb = [{ ...FUNC }, { ...CONST0 }]; delete noFb[1].fallback; return R(noFb, 44, 53) })(), "DSH_URL"],
              ["1576 核心回归：区间匹配下常量仍在既有档全无候选时兜底命中",
                R([{ name: "KINDS", kind: "VariableDeclaration", start: 7, end: 7, exported: true, fallback: true }], 1, 9), "KINDS"],
              ["1576 核心回归：`innermost` 与 `symbolForRange` 同一条判据（同一输入必须同答案）",
                (() => {
                  const spans = [{ name: "fn", kind: "FunctionDeclaration", start: 10, end: 30, exported: true }, { name: "CONST_X", kind: "VariableDeclaration", start: 30, end: 30, exported: true, fallback: true }]
                  return innermost(spans, 30)?.name === symbolForRange(spans, 30, 30).symbol
                })(), true],
            ]
          })()),
          ["1576 回归：宽松区间不落在常量上时，常量仍能兜底命中（这是本单要的收益）",
            (() => {
              const src = "const ARGS = parse()\nconst REPO = repo()\n"
              const sp = factsOf("t.js", src).spans
              return innermost(sp, 1)?.name
            })(), "ARGS"],
          /* 反控：既有档一个候选都没有时，放宽档**必须**出场 —— 否则本单一分收益都没有
             （变异「fallback 永不参与」⇒ 下面这条会红）。 */
          ["1576 反控：既有档无候选时兜底档出场（变异：fallback 恒不参与 ⇒ 红）",
            (() => {
              const src = "export function f() {\n  return 1\n}\nexport const KINDS = Object.freeze([\"a\"])\n"
              const sp = factsOf("t.js", src).spans
              return innermost(sp, 4)?.name
            })(), "KINDS"],
          ["1576 fallback 位只打在放宽档（既有档一律不带，否则会改变旧答案）",
            (() => {
              const src = "export function f() {\n  return 1\n}\nexport const KINDS = Object.freeze([\"a\"])\nconst g = () => 1\n"
              const sp = factsOf("t.js", src).spans
              return sp.filter((x) => x.fallback).map((x) => x.name).join(",")
            })(), "KINDS"],
          /* 函数形态的变量是**旧判据本来就认**的 ⇒ 不许打 fallback 位（打了就降级，会改旧答案）。 */
          ["1576 反控：函数形态常量不带 fallback 位（它是既有档，不许降级）",
            (() => {
              const src = "const sc = (e) => ({ async inspect() { return e } })\nconst h = function () { return 1 }\n"
              const sp = factsOf("t.js", src).spans
              return sp.filter((x) => x.fallback).length
            })(), 0],
          /* 缓存结构变了 ⇒ 版本必须抬，否则 v2 缓存里的旧 spans（只有函数）会被静默复用。 */
          ["1576 INDEX_VERSION 已抬到 ≥3（不抬 ⇒ 旧 span 静默复用）", INDEX_VERSION >= 3, true],
        ]
      })(),
      ["tsx 改 ⇒ design 与 code 都在", (() => { const g = ids(["forge-x/src/ui/c.tsx"], false); return g.includes("design") && g.includes("code") })(), true],
      ["反控：md 改不带 design/code（文档不是源码）", ids(["docs/a.md"], false).length === 0, true],
      ["lib/** 改 ⇒ 必须带 build:host（ISS-610）", ids(["forge-canvas/lib/x.js"], false).includes("build:host"), true],
      ["defineTool 改 ⇒ 带 tool-contract", ids(["forge-x/src/a.ts"], true).includes("tool-contract"), true],
      ["反控：无 defineTool 不带 tool-contract", !ids(["forge-x/src/a.ts"], false).includes("tool-contract"), true],
      // ── ISS-621 ① 产物识别（2026-10-20 实战反馈）：塞一个**假产物**进去必须被识别 ──
      ["产物：esbuild banner ×2 必判产物", isProd("// ../../node_modules/a/x.js\nvar a=1\n// ../../node_modules/b/y.js\nvar b=2\n") !== null, true],
      /* 实战形态：banner 中间夹仓库名（`// ../../../../dsh-forge/node_modules/…`）。
         第一版正则写死 `(?:\.\./)+node_modules/` 就这样漏掉了 canvas-core.js，而当时那条假用例
         恰好没夹仓库名 ⇒ 自测绿、实战漏。这条断言就是为了锁住那个坑。 */
      ["产物：banner 夹仓库名也必判（实战形态）", isProd("// ../../../../dsh-forge/node_modules/a/x.js\nvar a=1\n// ../../../../dsh-forge/node_modules/b/y.js\nvar b=2\n") !== null, true],
      ["反控：正常源码不判产物（不能误杀 entity-ops 那种形态）", isProd("// 说明注释\nexport function f() {\n  return 1\n}\n"), null],
      ["反控：只有 1 条 banner 不算（阈值是 ≥2，不是 ≥1）", isProd("// ../../node_modules/a/x.js\nvar a=1\n"), null],
      ["压缩单行：300KB 单行 → 产物", isProd("a".repeat(300000)) !== null, true],
      ["反控：50KB 单行未过体积门槛 → 不判产物（防把 base64/数据表当产物）", isProd("a".repeat(50 * 1024)), null],
      // ── ISS-621 ② 多路径参数解析（拆成纯函数才可测）──
      ["--who-imports 取到全部多路径", parseVals(["--who-imports", "a.js", "b.js", "c.js", "--verbose"], "--who-imports").length, 3],
      ["反控：flag 后紧跟另一个 flag ⇒ 空（不把 --verbose 当路径）", parseVals(["--who-imports", "--verbose"], "--who-imports").length, 0],
      // ── ISS-621 ④ 注释里提到文件名不算依赖（2026-10-20 追加）──
      /* 这条钉的是「spec 提取必须是 AST 级、不受注释影响」。
         有人实测到「删掉真实 import、只剩注释提到文件名，仍被报成反向依赖」——
         实测结论是**工具本身没有问题**（三层复现都不成立），真正原因是**观察口径错位**：
         在主 checkout 跑工具（那里的 import 还在）、看的是工作树里改过的文件。
         断言仍然值得留：它把「AST 级」这件事固定住，将来谁改成正则/文本匹配，这里立刻红。 */
      ["注释里写完整 import 语句 ⇒ 不产生 spec（AST 级，不是文本匹配）", factsOf("c.ts", "// import { x } from './auto-merge.js'\nexport const a = 1\n").specs.length, 0],
      ["正控：真实 import ⇒ 产生 1 条 spec", factsOf("c.ts", "import { x } from './auto-merge.js'\n").specs.length, 1],
      ["反控：块注释里写 import 也不算", factsOf("c.ts", "/*\nimport { x } from './auto-merge.js'\n*/\nexport const a = 1\n").specs.length, 0],
      // ── ISS-637 ① 缓存落点：必须在仓内 `.git/` 下（~/.cache 在 sandbox 下不可写 ⇒ 永远冷启动）──
      /* 判据必须是「落在 git dir 内」而不是「字面含 /.git/impact-cache」——
         工作树里 `.git` 是**文件**（`gitdir: <主仓>/.git/worktrees/<名>`），缓存实际落在
         `.git/worktrees/<名>/impact-cache`。按字面判会把**正确行为**判成红（2026-10-22 在
         `.wt/ISS-637` 实测踩到：主 checkout 81/81，工作树 80/81 且唯一红的就是这条）。 */
      ["① 缓存落在 git dir 内（不是 ~/.cache）", (() => {
        const gd = execFileSync("git", ["-C", ROOT, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
        return path.resolve(CACHE_DIR) === path.join(path.resolve(gd), "impact-cache")
      })(), true],
      ["① 反控：缓存不得落在 ~/.cache 下（sandbox 不可写 ⇒ 会退回冷启动）", CACHE_DIR.startsWith(path.join(process.env.HOME || "/tmp", ".cache")), false],
      ["① 缓存路径按 rootHash 分文件（同一 .git 下多仓不串）", /^[0-9a-f]{16}\.json$/.test(path.basename(cachePath())), true],
      ["反控：改 ROOT 理论上会换 cachePath（rootHash 真的进了文件名）", /^[0-9a-f]{16}$/.test(cryptoMod.createHash("sha1").update(ROOT + "x").digest("hex").slice(0, 16)), true],
      // ── ISS-637 ② 缓存不许静默：状态必须有值、且版本不匹配要报 ──
      /* F1（返工）B′：**行为**断言 —— 真写一个版本号不匹配的缓存文件，调 loadIndex()，读状态。
         旧版这条断言的是常量（`1 !== INDEX_VERSION`），把版本检查整个短路成 `if (false && ...)`
         也能绿 —— 而那会让 v99 缓存谎报「命中」、用旧答案回答新问题。
         现在变异 `if (false && (!raw || raw.version !== INDEX_VERSION))` 必然让 state 变成「命中」⇒ 红。 */
      ...(() => {
        const probePath = cachePath(), bak = fs.existsSync(probePath) ? fs.readFileSync(probePath) : null
        try {
          fs.mkdirSync(CACHE_DIR, { recursive: true })
          fs.writeFileSync(probePath, JSON.stringify({ version: INDEX_VERSION + 97, files: { "x.ts": { sig: "1:1", facts: {} } } }))
          resetIndexForTest()
          loadIndex()
          const mismatchState = cacheStatus.state, mismatchWhy = cacheStatus.why
          /* 正控：版本号正确时必须真「命中」（证明失败态不是「永远不命中」的假绿） */
          fs.writeFileSync(probePath, JSON.stringify({ version: INDEX_VERSION, files: { "x.ts": { sig: "1:1", facts: {} } } }))
          resetIndexForTest()
          loadIndex()
          const hitState = cacheStatus.state
          return [
            ["② 行为：版本不匹配 ⇒ 状态是「未命中」（变异：谎报命中 ⇒ 红）", mismatchState, "未命中"],
            ["② 行为：版本不匹配的 why 里带两个版本号（人能看懂差在哪）", /v\d+.*v\d+|版本不匹配/.test(mismatchWhy), true],
            ["② 正控：版本号对得上 ⇒ 真「命中」（不是永远不命中的假绿）", hitState, "命中"],
          ]
        } catch (e) {
          return [["② 缓存探针写入失败（跳过）", false, true]]
        } finally {
          try { if (bak) fs.writeFileSync(probePath, bak); else if (fs.existsSync(probePath)) fs.unlinkSync(probePath) } catch { /* 尽力还原 */ }
          resetIndexForTest()
        }
      })(),
      ["反控：缓存状态带实际使用的目录（页脚不会骗人）", typeof cacheStatus.dir === "string" && cacheStatus.dir.length > 0, true],
      // ── ISS-637 ③ --depth N ──
      ["③ parseDepth 缺省 = 1（旧行为一字不变）", parseDepth([]).depth, 1],
      ["③ --depth 2 解得 2", parseDepth(["--depth", "2"]).depth, 2],
      ["③ --depth 0 拒收（静默当 1 会让「查了二阶」变成假话）", parseDepth(["--depth", "0"]).depth, null],
      ["③ --depth abc 拒收", parseDepth(["--depth", "abc"]).depth, null],
      ["③ --depth 缺值拒收（不许当 1）", parseDepth(["--depth"]).depth, null],
      ["③ --depth 非整数（2.5）拒收", parseDepth(["--depth", "2.5"]).depth, null],
      /* reverseLevels 是纯函数 ⇒ 直接喂假图验分阶。构造：a←b←c←d（b import a，c import b…）。
         期望：第1阶 [b]，第2阶 [c]，第3阶 [d]。 */
      ...(() => {
        const g = new Map([["a.ts", new Set(["b.js"])], ["b.js", new Set(["c.js"])], ["c.js", new Set(["d.js"])]])
        const L1 = reverseLevels(g, ["a.ts"], 1), L2 = reverseLevels(g, ["a.ts"], 2), L3 = reverseLevels(g, ["a.ts"], 3)
        return [
          ["③ 一阶只给直接 importer（默认口径不变）", JSON.stringify(L1), JSON.stringify([["b.js"]])],
          ["③ 二阶分出第 2 阶（b 的 importer 是 c）", JSON.stringify(L2), JSON.stringify([["b.js"], ["c.js"]])],
          ["③ 三阶分出第 3 阶（c 的 importer 是 d）", JSON.stringify(L3), JSON.stringify([["b.js"], ["c.js"], ["d.js"]])],
          ["反控：一阶不含二阶文件（分阶不许塌成一坨）", L1.flat().includes("c.js"), false],
          ["反控：同一文件不重复占两阶（去重按「先见先得」）", (() => { const g2 = new Map([["a.ts", new Set(["b"])], ["b", new Set(["a.ts", "x"])]]); return reverseLevels(g2, ["a.ts"], 2).flat().filter((f) => f === "a.ts").length })(), 0],
          /* F1（返工）M：**渲染行为**断言 —— 分阶算得对还不够，必须**真的渲染出来**。
             旧版只验 reverseLevels 的返回值，把第 2 阶的输出循环收紧到 `d <= 1`（永远不执行）
             仍然全绿，而实际 --depth 2 只剩「累计」行、没有第 2 阶文件清单。
             这里断言渲染输出里**同时有第 2 阶段标题与第 2 阶的文件行**。 */
          ...(() => {
            const lv = [["b.js"], ["c.js"], ["d.js"]]
            const blk = renderWhoBlock({ norm: "a.ts", importers: ["b.js"], levelFiles: lv, untracked: false, quiet: false, verbose: false, depth: 3, changedOnly: false })
            const text = blk.L.join("\n")
            const hasHead = /── 第 2 阶反向依赖 1 个/.test(text)
            const hasRow = /第 2 阶反向依赖[\s\S]*\n      c\.js/.test(text)
            const hasHead3 = /── 第 3 阶反向依赖 1 个/.test(text)
            const hasRow3 = /第 3 阶反向依赖[\s\S]*\n      d\.js/.test(text)
            const d1 = renderWhoBlock({ norm: "a.ts", importers: ["b.js"], levelFiles: [["b.js"]], untracked: false, quiet: false, verbose: false, depth: 1, changedOnly: false })
            return [
              ["③ 行为：depth=3 渲染出第 2 阶段标题（变异：循环收紧 ⇒ 红）", hasHead, true],
              ["③ 行为：第 2 阶段下真列出文件行 c.js（只有标题不算）", hasRow, true],
              ["③ 行为：depth=3 也渲染第 3 阶与其文件行 d.js", hasHead3 && hasRow3, true],
              ["反控：depth=1 不出现任何「第 2 阶」字样（默认输出不变）", /第 2 阶/.test(d1.L.join("\n")), false],
              ["③ 行为：json.levels 带分阶（--json 不再丢弃 --depth）", blk.json.levels.map((x) => x.depth).join(","), "1,2,3"],
            ]
          })(),
        ]
      })(),
      // ── ISS-637 ④ --only-impacted / --changed-only 别名一致 ──
      /* F1（返工）J：**端到端**断言 —— 起真子进程，验 `--only-impacted` 真的折叠。
         为什么必须走子进程：`CHANGED_ONLY` 是**模块级常量**，直接给 renderWhoBlock 传 changedOnly:true
         会绕过它。返工第一版就是这么写的 ⇒ 把常量短路成 `&& false` 时自测仍全绿（实测存活）。
         现在常量一旦失效，子进程输出的折叠行就消失 ⇒ 红。 */
      ...cliFixtures((fx) => {
        const on = fx.run(["--who-imports", fx.orphan, "--only-impacted"])
        const onAlias = fx.run(["--who-imports", fx.orphan, "--changed-only"])
        const off = fx.run(["--who-imports", fx.orphan])
        return [
          ["④ 端到端：--only-impacted 下 0 依赖目标真的被折叠（变异：常量失效 ⇒ 红）", /已折叠/.test(on.out), true],
          ["④ 端到端：--changed-only 别名产出同样折叠（同一判据）", /已折叠/.test(onAlias.out), true],
          ["反控：不带旗标时同一目标照常出行（折叠不是无条件）", /已折叠/.test(off.out) === false && /谁依赖/.test(off.out), true],
          /* R2（不变量）：`DEPTH` 也是模块级常量。只验 reverseLevels/renderWhoBlock 的入参不算数 ——
             把 CLI 里 `Math.max(1, DEPTH)` 改成写死 1，二阶功能就真丢了，而前面那些用例仍绿。
             这里断言真子进程 `--depth 2` 的输出**含第 2 阶段**、`--depth 1` 的**不含**。 */
          ["③ 端到端：--depth 2 子进程输出含第 2 阶段（变异：常量写死 1 ⇒ 红）", /第 2 阶反向依赖/.test(fx.run(["--who-imports", fx.target, "--depth", "2"]).out), true],
          ["③ 端到端：--depth 1 输出不含第 2 阶（默认不变）", /第 2 阶/.test(fx.run(["--who-imports", fx.target]).out), false],
        ]
      }),
      /* F1（返工）G：**行为**断言 —— 构造 25 个同包 importer，调真渲染函数，数**输出里真的列了几行文件名**。
         旧版只断言 `GROUP_MIN === 20` 常量 + 一段脱离渲染的 `slice` 算术 —— 从没经过消费点，
         于是把 `g.slice(0, GROUP_MIN)` 改成 `g.slice(0, 5)` 仍然全绿，而实际输出只列 5 个。
         现在消费点一旦写死 5，这里的行数立刻不是 20 ⇒ 红。 */
      ...(() => {
        const mk = (n) => Array.from({ length: n }, (_, i) => `forge-x/src/lib/file-${String(i).padStart(2, "0")}.ts`)
        /* 只数文件行：`      … 其余 N 个` 也是 6 空格开头，但那是截断提示、不是文件行（排除掉，
           否则「写死 5」的变异会因为多一条提示行而凑出 6 行、把断言骗过去）。 */
        const rowsOf = (out) => out.L.filter((l) => /^ {6}(?!…)\S/.test(l)).length
        const countLine = (out) => out.L.find((l) => l.includes("其余")) || ""
        const g25 = renderWhoBlock({ norm: "forge-x/src/lib/target.ts", importers: mk(25), levelFiles: [mk(25)], untracked: false, quiet: false, verbose: false, depth: 1, changedOnly: false })
        const g19 = renderWhoBlock({ norm: "forge-x/src/lib/target.ts", importers: mk(19), levelFiles: [mk(19)], untracked: false, quiet: false, verbose: false, depth: 1, changedOnly: false })
        const g25v = renderWhoBlock({ norm: "forge-x/src/lib/target.ts", importers: mk(25), levelFiles: [mk(25)], untracked: false, quiet: false, verbose: true, depth: 1, changedOnly: false })
        return [
          ["⑤ 行为：25 个 importer ⇒ 输出**真列 20 行**文件名（变异：写死 5 ⇒ 红）", rowsOf(g25), 20],
          ["⑤ 行为：25 个时补一行「其余 5 个」（截断不许静默）", countLine(g25).includes("其余 5 个"), true],
          ["反控：19 个全列、不出「其余」行（保底不是上限）", rowsOf(g19) === 19 && !countLine(g19), true],
          ["反控：--verbose 25 个全列（不受保底约束）", rowsOf(g25v), 25],
        ]
      })(),
      // ── ISS-637 ⑥ --quiet ──
      /* F1（返工）K：**端到端**断言 —— 起真子进程，验 `--quiet` 真的压缩输出。
         同 J：`QUIET` 是模块级常量，直接传 quiet:true 给它绕过了它 ⇒ 变异 `&& false` 存活过。 */
      ...cliFixtures((fx) => {
        const loud = fx.run(["--who-imports", fx.target])
        const shut = fx.run(["--who-imports", fx.target, "--quiet"])
        const rowsOf = (t) => (t.split("\n").filter((l) => /^ {6}(?!…)\S/.test(l))).length
        return [
          ["⑥ 端到端：--quiet 输出显著短于非 quiet（变异：QUIET 失效 ⇒ 红）", shut.out.length * 2 < loud.out.length, true],
          ["⑥ 端到端：--quiet 不列任何文件名行", rowsOf(shut.out), 0],
          ["反控：非 quiet 同输入真列文件名（证明上面的 0 不是「两边都不列」）", rowsOf(loud.out) > 0, true],
          ["⑥ 端到端：--quiet 仍保留分组计数行（结论不许丢）", /■ 同包库文件 12 个/.test(shut.out), true],
        ]
      }),
      // ── ISS-637 ⑦ 未知参数 + 未跟踪 ──
      /* ── ISS-641 目标不存在（K9b 第三次）──
         判据：**不存在**与「存在但无人 import」必须可区分（旧版两者输出逐字节相同、exit 0）。
         ⚠️ 这三条验的是 classifyTargets（纯判定层）；「CLI 层真会 exit 2」另用端到端子进程验（见下），
         因为常量/分支在 CLI 里 —— ISS-637 返工的教训：验到的那一层必须就是被改的那一层。 */
      ...(() => {
        const miss = classifyTargets(["forge-pm/src/pm/__definitely_not_here__.ts"])
        const hit = classifyTargets(["forge-pm/lib/auto-merge.js"])
        const dirc = classifyTargets(["forge-pm/src/pm"])
        const mixed = classifyTargets(["forge-pm/lib/auto-merge.js", "forge-pm/lib/__nope__.js"])
        return [
          ["1517 不存在的目标进 missing（不再混进可分析集）", miss.missing.length === 1 && miss.ok.length === 0, true],
          ["1517 存在但无人依赖 ⇒ 进 ok（正常分析，不许误报成不存在）", hit.ok.length === 1 && hit.missing.length === 0, true],
          ["1517 目标是目录 ⇒ 单列 dir（不是「文件无人依赖」）", dirc.dir.length === 1 && dirc.ok.length === 0, true],
          ["1517 多目标混合 ⇒ 有效的留 ok、无效的进 missing（一个错不废整次）", mixed.ok.length === 1 && mixed.missing.length === 1, true],
          ["反控：不存在的目标**不会**出现在 ok 里（防「全当有效」的假绿）", miss.ok.includes("forge-pm/src/pm/__definitely_not_here__.ts"), false],
        ]
      })(),
      ["⑦ 未知参数 --find 会被抓出（不再被静默吞掉）", unknownFlags(["--find", "pmRead"]).length, 1],
      ["⑦ 未知参数 --files 会被抓出", unknownFlags(["--files", "x.ts"]).length, 1],
      ["反控：全部已知参数不误报", unknownFlags([...KNOWN_FLAGS]).length, 0],
      ["反控：非 flag 位置参数（--who-imports 的路径）不误报", unknownFlags(["--who-imports", "a.js", "b.js"]).length, 0],
      ["⑦ 未跟踪清单只收源码文件（fixture 目录与 vendor 排除）", untrackedFiles().every((f) => FILE_RE.test(f) && !VENDOR.test(f) && !f.startsWith(FIXTURE_DIR_REL + "/")), true],
      /* 未跟踪检测的**正控**：临时造一个未跟踪文件，必须进清单；删掉必须出清单。
         不自己造文件的断言等于只验了函数不崩 —— 那正是本仓踩过的「自测绿、实战漏」。 */
      ...(() => {
        const probe = path.join(ROOT, "scripts/zz-impact-selftest-probe.ts")
        try {
          fs.writeFileSync(probe, "export const probe = 1\n")
          const withIt = untrackedFiles().includes("scripts/zz-impact-selftest-probe.ts")
          fs.unlinkSync(probe)
          const without = untrackedFiles().includes("scripts/zz-impact-selftest-probe.ts")
          return [["⑦ 正控：真造一个未跟踪源码 ⇒ 进清单", withIt, true], ["⑦ 反控：删掉 ⇒ 出清单", without, false]]
        } catch (e) { try { fs.unlinkSync(probe) } catch { /* 已删 */ } ; return [["⑦ 未跟踪探针写入失败（跳过）", false, true]] }
      })(),
      /* ── ISS-641 端到端（**走真子进程**，验到 exit 码那一层）──
         为什么必须起子进程：目标校验与 `process.exit(2)` 都在 CLI 分支里，纯函数断言覆盖不到
         「CLI 真的返回 2」这件事。这正是 ISS-637 返工踩过的坑（验纯函数、变异在 CLI 分支上存活）。 */
      ...cliFixtures((fx) => {
        const noSuch = "forge-x/src/lib/definitely-absent.ts"
        const gone = fx.run(["--who-imports", noSuch])
        const exists = fx.run(["--who-imports", fx.orphan])
        const isDir = fx.run(["--who-imports", "forge-x/src/lib"])
        const mixed = fx.run(["--who-imports", fx.orphan, noSuch])
        return [
          ["1517 端到端：目标不存在 ⇒ 退出码 2（变异：删掉这层检查 ⇒ 变 0 ⇒ 红）", gone.code, 2],
          ["1517 端到端：不存在的目标消息含路径（人能看出写错了哪个）", /目标不存在/.test(gone.err) && gone.err.includes(noSuch), true],
          ["1517 端到端：消息含扫描根（说清相对哪里找的）", gone.err.includes(fx.tmp), true],
          ["1517 端到端：不存在时**不许**输出「反向依赖 0 个」这种看起来正常的结论", /反向依赖 0 个/.test(gone.out), false],
          ["反控：存在但无人 import ⇒ 退出码 0 + 正常报「0 个」（不回归）", exists.code === 0 && /反向依赖 0 个/.test(exists.out), true],
          ["1517 端到端：目标是目录 ⇒ 退出码 2 且说明是目录（不是「无人依赖」）", isDir.code === 2 && /目录/.test(isDir.err), true],
          ["1517 端到端：多目标混合 ⇒ 报出缺的那个，**且**仍分析存在的那个", /目标不存在/.test(mixed.err) && /谁依赖 forge-x\/src\/lib\/orphan\.ts/.test(mixed.out), true],
          ["1517 端到端：多目标混合退出码 2（部分成功不算完全成功）", mixed.code, 2],
        ]
      }),
    ]) T(what, got === want)
    /* 反向依赖必须**真的进结果**：变异「照算但不进结果」（消费端断掉）曾在此存活过 ——
       那时自测只验 hunk 归类、一句 deps 都没断言，把 deps 换成空数组也全绿。 */
    const real = new Set(scanFiles()), r = analyze({ base: "HEAD~15..HEAD" }), withDeps = r.results.filter((x) => x.deps.length > 0)
    T(`端到端真仓：至少一个改动文件反向依赖非空（实测 ${withDeps.length} 个）`, withDeps.length > 0)
    T("端到端真仓：deps 每条都是真实扫描面内的路径（不是空/占位）", withDeps.every((x) => x.deps.every((d) => real.has(d))))
    T("反控：自己 import 自己不算反向边", r.results.every((x) => !x.deps.includes(x.file)))
    /* 恒等式必须把**产物**那一项也算进来（ISS-621 ① 引入第三类 hunk）——
       少补一项 = 产物文件的 hunk 静默蒸发，而这正是本工具立单时最反对的造假形态。 */
    const c = r.counts, accounted = c.nSymbol + c.nModule + c.nLost + c.nonCodeHunks + c.prodHunks
    T("端到端（真仓）：hunk 全部有账、无静默蒸发、且真能定位到符号", c.hunks > 0 && accounted === c.hunks && c.nSymbol > 0)
    T("产物识别的 hunk 也在账上（恒等式含 prodHunks，不许漏项）", c.prodHunks >= 0 && accounted === c.hunks)
    const bad = cases.filter((x) => !x.p)
    console.log(cases.map((x) => `${x.p ? "✓" : "✗"} ${x.n}`).join("\n"))
    console.log(`\nimpact-of-diff --self-test ${cases.length - bad.length}/${cases.length} 通过`)
    console.log(`  · 真仓 HEAD~15..HEAD：hunk ${c.hunks} = 符号 ${c.nSymbol} + 模块顶层 ${c.nModule} + 未定位 ${c.nLost} + 非源码 ${c.nonCodeHunks} + 产物 ${c.prodHunks}（合计 ${accounted}）`)
    console.log(`  · 产物识别命中 ${c.prod} 个文件${c.prod ? "：" + r.prodFiles.map((p) => p.file).join(", ") : ""}`)
    return bad.length ? 2 : 0
  }
  return runSelfTest
}
