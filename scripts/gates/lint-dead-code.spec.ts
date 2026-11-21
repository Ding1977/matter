/**
 * `lint-dead-code` 的 spec（ISS-844）。
 *
 * 四类用例（同 `verify-plugin-shape.spec.ts` 的口径）：正例 / 反例 / 干扰（边界）/ 缺输入。
 * 另加一段**真语料端到端**：临时目录里造包，跑 `evaluate()` 走完真实 IO 路径 ——
 * 纯函数用例证明「判定逻辑对」，端到端证明「真文件真能红、真能绿」。
 *
 * ⛔ 反例必须点名**哪一条**报红，不许只断 `status === "failed"`：
 *    三条红判据挤在同一个 failed 上时，「只坏了第 1 条」与「三条全坏」长得一样。
 *
 * ⚠️ 本仓 spec 用 `export function run(): boolean`，不是 `describe/it`
 *    （`runGate({...}) --selftest` 动态 import 本文件并调用 `run()`，见 `lib/gate-runtime.ts:104-125`）。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  MIN_REASON,
  blankLiterals,
  collectFiles,
  corpusExists,
  directivesIn,
  evaluate,
  judgeDirectives,
  loadTs,
  parseDirective,
  type Directive,
} from "./lint-dead-code.ts"

let fails = 0
/** 断言条数**实测累加**，不在结尾手写数字 —— 手写的数会和实际脱节。 */
let total = 0
const ok = (name: string, cond: boolean) => {
  total++
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

/** 造一条指令（等价于 `parseDirective` 的产出，用来单独喂纯函数）。 */
const dir = (over: Partial<Directive> = {}): Directive => ({
  file: "packages/g/p/src/a.ts",
  line: 1,
  kind: "next",
  reason: "the loop is bounded by the captured key count.",
  comment: "/* v8 ignore next -- … */",
  ...over,
})

/** 造一段源码的指令清单（走真实的 parseDirective 路径，不是手工对象）。 */
const parsed = (src: string, file = "packages/g/p/src/a.ts"): Directive[] => {
  const out: Directive[] = []
  // 逐行喂：本函数只测**单条注释**的解析，不需要真实 scanner。
  for (const [i, line] of src.split("\n").entries()) {
    const t = line.trim()
    if (!t.startsWith("/*") && !t.startsWith("//")) continue
    const d = parseDirective(file, i + 1, t)
    if (d) out.push(d)
  }
  return out
}

export function run(): boolean {
  fails = 0
  total = 0
  console.log("lint-dead-code.spec")

  // ── 正例：带理由的各种形态 ⇒ 一条都不报 ──────────────────────────────
  {
    ok("正例：`next -- 理由` ⇒ 0 条", judgeDirectives(parsed("/* v8 ignore next -- the switch is exhaustive. */"), 1).status === "passed")
    ok("正例：裸 `-- 理由`（无指令词）⇒ 0 条", judgeDirectives(parsed("/* v8 ignore -- defensive: upstream never returns null */"), 1).status === "passed")
    ok("正例：`start -- 理由` ⇒ 0 条", judgeDirectives(parsed("/* v8 ignore start -- POSIX lane covers it */"), 1).status === "passed")
    ok("正例：`else -- 理由` ⇒ 0 条", judgeDirectives(parsed("/* v8 ignore else -- every branch is handled above */"), 1).status === "passed")
    ok("正例：`if -- 理由` ⇒ 0 条", judgeDirectives(parsed("/* v8 ignore if -- mounted content always has a window */"), 1).status === "passed")
    ok("正例：`file -- 理由` ⇒ 0 条", judgeDirectives(parsed("/* v8 ignore file -- generated shim */"), 1).status === "passed")
    ok("正例：`next 3 -- 理由`（位置参数 + 理由）⇒ 0 条", judgeDirectives(parsed("/* v8 ignore next 3 -- closed union backstop. */"), 1).status === "passed")
    ok("正例：行注释形态 `// v8 ignore next -- 理由` ⇒ 0 条", judgeDirectives(parsed("// v8 ignore next -- ref is attached before layout effects"), 1).status === "passed")
    ok("正例：`stop` 不带理由是**正常形态** ⇒ 0 条（理由写在 start 那侧）", judgeDirectives(parsed("/* v8 ignore stop */"), 1).status === "passed")
    ok("正例：passed 的 detail 报出文件数与指令数", (() => {
      const r = judgeDirectives(parsed("/* v8 ignore next -- reason long enough here */"), 7)
      return r.status === "passed" && (r.detail ?? "").includes("7 个源文件") && (r.detail ?? "").includes("1 条")
    })())
  }

  // ── 反例①：裸 ignore（连指令词都没有）⇒ 红 ────────────────────────────
  {
    const r = judgeDirectives(parsed("/* v8 ignore */"), 1)
    ok("反例①：裸 `/* v8 ignore *\/` ⇒ 红", r.status === "failed")
    ok("反例①：detail 指向「裸 v8 ignore」而不是含糊的「违规」", (r.findings ?? []).some((f) => f.detail.includes("裸 `v8 ignore`")))
    ok("反例①：finding 带 file 与 line（没有行号的意见改不动）", (r.findings ?? [])[0]?.file === "packages/g/p/src/a.ts" && (r.findings ?? [])[0]?.line === 1)
  }

  // ── 反例②：`next` 不带理由 ⇒ 红（`next` 是位置指令不是理由）────────────
  {
    const r = judgeDirectives(parsed("/* v8 ignore next */"), 1)
    ok("反例②：`/* v8 ignore next *\/` ⇒ 红", r.status === "failed")
    ok("反例②：detail 点名是 `v8 ignore next` 缺理由", (r.findings ?? []).some((f) => f.detail.includes("`v8 ignore next` 没有理由")))
  }

  // ── 反例③：`next 8` 只有行数没有理由 ⇒ 红 ────────────────────────────
  {
    const r = judgeDirectives(parsed("/* v8 ignore next 8 */"), 1)
    ok("反例③：`/* v8 ignore next 8 *\/` ⇒ 红（8 是行数不是理由）", r.status === "failed")
  }

  // ── 反例④：理由太短（敷衍）⇒ 红 ──────────────────────────────────────
  {
    const r = judgeDirectives(parsed("/* v8 ignore next -- ok */"), 1)
    ok("反例④：理由 `ok`（2 字符 < 5）⇒ 红", r.status === "failed")
    ok("反例④：detail 报出实际字符数与下限", (r.findings ?? []).some((f) => f.detail.includes("2 字符 < 5")))
    ok("反例④：`-- ` 后面只有空格 ⇒ 红（trim 后为空即无理由）", judgeDirectives(parsed("/* v8 ignore next --    */"), 1).status === "failed")
    ok(`阈值边界：恰好 ${MIN_REASON} 字符 ⇒ 绿`, judgeDirectives([dir({ reason: "x".repeat(MIN_REASON) })], 1).status === "passed")
    ok(`阈值边界：${MIN_REASON - 1} 字符 ⇒ 红`, judgeDirectives([dir({ reason: "x".repeat(MIN_REASON - 1) })], 1).status === "failed")
  }

  // ── 干扰：不是指令的文字一律不判（假红会让门禁被关掉）──────────────────
  {
    ok("干扰：散文提及 `v8 ignore`（不在注释开头）⇒ 不判", parseDirective("a.ts", 1, "// (oxlint block-disable so both `v8 ignore next` and the rule") === null)
    ok("干扰：`v8 ignore` 出现在句子中间 ⇒ 不判", parseDirective("a.ts", 1, "/* upstream said v8 ignore next is fine */") === null)
    ok("干扰：`v8 ignored`（词边界）⇒ 不判", parseDirective("a.ts", 1, "/* v8 ignored line */") === null)
    ok("干扰：`istanbul ignore next` ⇒ 不判（别的工具的指令，本格射程外）", parseDirective("a.ts", 1, "/* istanbul ignore next */") === null)
    ok("干扰：JSDoc 星号前缀 `* v8 ignore next -- 理由` ⇒ 认得出", parseDirective("a.ts", 1, "/* v8 ignore next -- a real reason here */") !== null)
  }

  // ── 聚合：一条坏的不许把好的结论盖掉 ─────────────────────────────────
  {
    const ds = [...parsed("/* v8 ignore next -- a perfectly good reason */"), ...parsed("/* v8 ignore next */")]
    const r = judgeDirectives(ds, 2)
    ok("聚合：1 好 + 1 坏 ⇒ failed 且只报 1 条", r.status === "failed" && (r.findings ?? []).length === 1)
    ok("聚合：detail 同时报出「2 条指令里有 1 条没有真理由」", (r.detail ?? "").includes("2 条指令中有 1 条"))
  }

  // ── 缺输入（防扫空）：0 个文件 ⇒ unjudged，不是绿 ──────────────────────
  {
    const r = judgeDirectives([], 0)
    ok("防扫空：0 个文件 ⇒ unjudged（不是绿）", r.status === "unjudged")
    ok("防扫空：理由码是 no-corpus", r.reason === "no-corpus")
    ok("防扫空：detail 说明「0 个 .ts/.tsx」", (r.detail ?? "").includes("0 个 .ts/.tsx"))
  }

  // ── 变异：同一个文件改一处 ⇒ 绿变红（判据有牙）────────────────────────
  {
    const good = judgeDirectives(parsed("/* v8 ignore next -- the guard is defensive */"), 1)
    const bad = judgeDirectives(parsed("/* v8 ignore next */"), 1)
    ok("变异：去掉 `-- 理由` ⇒ passed → failed（绿变红）", good.status === "passed" && bad.status === "failed")
  }

  // ── 端到端：真临时目录 + 真 TS 扫描（找不到 typescript 时明说跳过）──────
  const ts = loadTs()
  if (!ts) {
    console.log("  ⚠ 跳过端到端用例：找不到 typescript（本机没装 ⇒ 生产里这会判 unjudged(no-binary)）")
  } else {
    // blankLiterals / directivesIn 本身
    const katex = 'const el = <div>/* v8 ignore */</div>\n'
    ok("扫描：JSX 文本里的 `v8 ignore` 不是注释 ⇒ 取不到", directivesIn(ts, "x.tsx", katex).directives.length === 0)
    ok("扫描：JSX 空表达式容器里的注释 ⇒ 取得到（AST leading-range 挂不到这里）", directivesIn(ts, "x.tsx", "const el = <div>{/* v8 ignore next */}</div>\n").directives.length === 1)
    const regexSrc = String.raw`const re = /[/*] v8 ignore/` + "\n"
    ok("扫描：正则字面量里的 `/*` 不许被当成注释（裸 scanner 会假红）", directivesIn(ts, "x.ts", regexSrc).directives.length === 0)
    ok("扫描：字符串字面量里的 `v8 ignore` ⇒ 不是注释", directivesIn(ts, "x.ts", "const s = '/* v8 ignore */'\n").directives.length === 0)
    ok("扫描：模板串里的 `v8 ignore` ⇒ 不是注释", directivesIn(ts, "x.ts", "const t = `/* v8 ignore */`\n").directives.length === 0)
    const multi = "/* v8 ignore next -- reason spanning\n * several lines of prose here */\nconst a = 1\n"
    const md = directivesIn(ts, "x.ts", multi)
    ok("扫描：多行块注释（理由跨行）⇒ 认得出且理由已单行化", md.directives.length === 1 && !(md.directives[0].reason ?? "").includes("\n"))
    ok("扫描：行号落在指令所在行", directivesIn(ts, "x.ts", "\n\n/* v8 ignore next */\n").directives[0]?.line === 3)

    // 抹字面量后：偏移与行号必须与原文一致（否则报出来的 path:line 指错地方）
    {
      const src = 'const s = "aaaaaaaa"\n/* v8 ignore next */\nconst b = 1\n'
      const blanked = blankLiterals(ts, src, "x.ts")
      ok("blankLiterals：长度不变（偏移不动）", blanked.length === src.length)
      ok("blankLiterals：换行数不变（行号不动）", blanked.split("\n").length === src.split("\n").length)
      ok("blankLiterals：字面量内容被抹掉", !blanked.includes("aaaaaaaa"))
    }

    // 整条链路：临时 repo → collectFiles → scanCorpus → judge
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lint-dead-code-spec-"))
    try {
      const write = (rel: string, content: string) => {
        const p = path.join(tmp, rel)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, content)
      }
      // 射程内：两个真包（含 src 内的子目录 —— 包内深度不受限）
      write("packages/core/agent/src/ok.ts", "/* v8 ignore next -- the switch is exhaustive. */\nexport const a = 1\n")
      write("packages/core/agent/src/bare.ts", "/* v8 ignore next */\nexport const b = 2\n")
      write("packages/util/kernel/src/deep/x.ts", "/* v8 ignore next -- deep file inside a package */\nexport const c = 3\n")
      // 射程外：tests/、dist/、三段包、非 TS
      write("packages/core/agent/tests/a.ts", "/* v8 ignore next */\nexport const t = 1\n")
      write("packages/core/agent/dist/a.ts", "/* v8 ignore next */\nexport const d = 1\n")
      write("packages/core/agent/nested/src/deep.ts", "/* v8 ignore next */\nexport const n = 1\n")
      write("packages/core/agent/src/a.js", "/* v8 ignore next */\nexport const f = 1\n")
      write("packages/core/agent/src/a.d.ts", "/* v8 ignore next */\n")

      ok("collectFiles：目录不存在 ⇒ 空数组（不是抛错）", collectFiles(path.join(tmp, "__nope__")).length === 0)
      ok("corpusExists：临时树有 packages/ ⇒ true", corpusExists(tmp))
      ok("corpusExists：不存在的树 ⇒ false", !corpusExists(path.join(tmp, "__nope__")))

      const files = collectFiles(tmp)
      ok("collectFiles：收 src 下的 .ts/.tsx", files.includes("packages/core/agent/src/ok.ts") && files.includes("packages/util/kernel/src/deep/x.ts"))
      ok("collectFiles：收 src 内子目录（包内深度不受限）", files.includes("packages/util/kernel/src/deep/x.ts"))
      ok("collectFiles：不收 tests/（DSH 的测试不在 src 下）", !files.some((f) => f.includes("/tests/")))
      ok("collectFiles：不收 dist/", !files.some((f) => f.includes("/dist/")))
      ok("collectFiles：不收包内第二层 src/（包深度恰好两段，不递归认包）", !files.some((f) => f.includes("/nested/")))
      ok("collectFiles：不收 .js", !files.some((f) => f.endsWith(".js")))
      ok("collectFiles：不收 .d.ts（没有可执行行）", !files.some((f) => f.endsWith(".d.ts")))
      ok("collectFiles：结果已排序（报告顺序稳定）", JSON.stringify(files) === JSON.stringify([...files].sort()))

      const red = evaluate(tmp)
      ok("端到端：造一个裸 ignore ⇒ failed", red.status === "failed")
      ok("端到端：红的是 bare.ts 那一行（不是别处）", (red.findings ?? []).some((f) => f.file === "packages/core/agent/src/bare.ts" && f.line === 1))
      ok("端到端：合规的 ok.ts 不被牵连", !(red.findings ?? []).some((f) => f.file === "packages/core/agent/src/ok.ts"))

      // 变异：删掉裸 ignore 那一行 ⇒ 绿
      fs.writeFileSync(path.join(tmp, "packages/core/agent/src/bare.ts"), "/* v8 ignore next -- defensive guard for the closed union. */\nexport const b = 2\n")
      const green = evaluate(tmp)
      ok("变异：给裸 ignore 加上理由 ⇒ failed → passed（红变绿）", green.status === "passed")

      // 变异：把理由改成敷衍 ⇒ 又红
      fs.writeFileSync(path.join(tmp, "packages/core/agent/src/bare.ts"), "/* v8 ignore next -- ok */\nexport const b = 2\n")
      const short = evaluate(tmp)
      ok("变异：理由写成 `ok` ⇒ passed → failed（敷衍挡得住）", short.status === "failed")

      // 0 个包 ⇒ 退 2（不是绿）
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lint-dead-code-empty-"))
      try {
        fs.mkdirSync(path.join(empty, "packages"), { recursive: true })
        const r = evaluate(empty)
        ok("0 个文件（packages/ 是空目录）⇒ unjudged(no-corpus)，不是绿", r.status === "unjudged" && r.reason === "no-corpus")
        ok("0 个文件：detail 说清「目录在，是空的」", (r.detail ?? "").includes("目录在，是空的"))
      } finally {
        fs.rmSync(empty, { recursive: true, force: true })
      }
      const gone = fs.mkdtempSync(path.join(os.tmpdir(), "lint-dead-code-gone-"))
      try {
        const r = evaluate(gone)
        ok("packages/ 目录不存在 ⇒ unjudged(no-corpus)，不是绿", r.status === "unjudged" && r.reason === "no-corpus")
        ok("packages/ 不存在：detail 说清「目录不存在」", (r.detail ?? "").includes("目录不存在"))
      } finally {
        fs.rmSync(gone, { recursive: true, force: true })
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  // ── 真语料：断言的是**不变式**，不是「本树此刻有几个包」（ISS-857）──────
  //
  // 「0 个包 ⇒ 判 unjudged 而不是绿」这个意图是对的，但它原先写成
  //   ok("本树（新树 W1 之前）⇒ unjudged", r.status === "unjudged")
  // 把结论押在了「当前树恰好没有包」这个**偶然条件**上。新树一有包，实现照旧正确、
  // 这条断言自己变假 ⇒ 恒红。**过期断言比没有断言更坏**：它让真回归埋在同一条永远红的格子里。
  //
  // 改法：把「0 个包」的三种形态用**构造数据**钉住（上面两处临时目录 + `judgeDirectives([], 0)`），
  // 这里只留一条与树状态无关的一致性约束 —— 文件数与结论必须对得上。
  // ⚠️ 不写「本树当前 N 个包」这类断言：那是快照，必然腐坏。
  {
    const files = collectFiles()
    const r = evaluate()
    ok(
      "防扫空不变式：本树 0 个源文件 ⇔ unjudged(no-corpus)；有文件时不许报 no-corpus",
      files.length === 0 ? r.status === "unjudged" && r.reason === "no-corpus" : r.reason !== "no-corpus",
    )
    const ts = loadTs()
    ok(
      "有语料时结论必须是 passed/failed（第三态只留给没语料 / 没 typescript）",
      files.length === 0 || !ts || r.status === "passed" || r.status === "failed",
    )
  }

  console.log(fails ? `✗ ${fails} 条不成立` : `✓ spec 全过（${total} 条断言：正例 / 三个反例 / 干扰 / 聚合 / 防扫空 / 变异 / 端到端，逐条见上）`)
  return fails === 0
}
