/**
 * `verify-no-top-level-await` 的 spec（ISS-883）。
 *
 * 载体：本仓口径 —— **`export function run()` + `--selftest`**（gate-runtime.ts:104-126），
 * 非 bun describe/it。`bun test --isolate` 本仓跑 0 pass/0 fail，权威执行是 `--selftest`。
 *
 * ## 覆盖（任务书 7 类）
 *
 * ① 顶层 await 三种形态（await 表达式 / for await / await using）各必红，finding 带
 *    文件:行 + 源码行 + 怎么改；移除⇒绿
 * ② 函数内 await 不误伤（含本树真实函数内 await 的反向控制，分母从源现算不写死数字）
 * ③ 词法嵌套（顶层 block / if / for / class 计算成员里的 await 也抓）
 * ④ 字符串 / 模板 / 注释里的 "await" 不误报
 * ⑤ 可执行文件排除（shebang + bin 字段命名源）
 * ⑥ 语料完整性（删 .tsx 断言后「非空 + 不漏包」仍生效；0 .tsx 语料照样绿）
 * ⑦ 三态 fail-closed（0 文件 no-corpus / 无 typescript no-binary / 漏包判红）
 *
 * ⛔ 反例必须点名哪一行、哪段源码、期望/实际，不只断 status === "failed"。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  SOURCE_GLOB,
  binSources,
  collect,
  corpusIntegrity,
  excludedEntry,
  findTopLevelAwaits,
  judgeAwaits,
  loadTs,
  scanRepository,
  sourceCorpus,
  type AwaitInput,
  type ScanResult,
} from "./verify-no-top-level-await.ts"
import type { GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..")

let fails = 0
let okCount = 0
const ok = (name: string, cond: boolean, extra = ""): void => {
  okCount++
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` —— 实际：${extra}`}`)
  if (!cond) fails++
}

interface PkgSpec {
  group: string
  pkg: string
  /** src 相对路径 → 文件内容。 */
  files: Record<string, string>
  /** 写入 package.json 的 bin 字段（可选）。 */
  bin?: unknown
}

interface Fixture {
  root: string
  /** 取 src 下某文件的绝对路径。 */
  src: (group: string, pkg: string, rel: string) => string
}

/** 造 packages/<group>/<pkg>/src/<rel> 形态的临时仓根。 */
function makeFixture(pkgs: readonly PkgSpec[]): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tla-fixture-"))
  fs.mkdirSync(path.join(root, "packages"), { recursive: true })
  for (const spec of pkgs) {
    const dir = path.join(root, "packages", spec.group, spec.pkg)
    const srcDir = path.join(dir, "src")
    fs.mkdirSync(srcDir, { recursive: true })
    const manifest: Record<string, unknown> = { name: `@fixture/${spec.pkg}`, type: "module" }
    if (spec.bin !== undefined) manifest.bin = spec.bin
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
    for (const [rel, text] of Object.entries(spec.files)) {
      const target = path.join(srcDir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
    }
  }
  return {
    root,
    src: (group, pkg, rel) => path.join(root, "packages", group, pkg, "src", rel),
  }
}

function rmFixture(f: Fixture): void {
  fs.rmSync(f.root, { recursive: true, force: true })
}

const hasFinding = (r: GateResult, ...needles: string[]): boolean =>
  (r.findings ?? []).some((f) => needles.every((n) => (f.detail ?? "").includes(n) || (f.file ?? "").includes(n)))

/** 把 fixture 的 scan 包成 judge 输入（ts 已加载）。 */
function inputOf(f: Fixture, ts: any): AwaitInput {
  return { hasTs: true, scan: scanRepository(f.root, ts) }
}

export function run(): boolean {
  fails = 0
  okCount = 0
  console.log("verify-no-top-level-await.spec")

  const ts = loadTs(REPO)
  ok("typescript 可加载（不降级成正则）", ts !== null)
  if (ts === null) {
    console.log("✗ 无 typescript，后续 AST 用例无法运行")
    return false
  }

  /* ── ⓪ 常量与纯函数单测 ─────────────────────────────────────── */

  {
    ok("SOURCE_GLOB 覆盖两层包 src 的 ts/tsx", SOURCE_GLOB === "packages/*/*/src/**/*.{ts,tsx}", SOURCE_GLOB)
  }

  {
    ok("binSources：字符串形式 lib/tool.js → src/tool.ts + .tsx",
      binSources("packages/g/p", "lib/tool.js").join(",") === "packages/g/p/src/tool.ts,packages/g/p/src/tool.tsx",
      binSources("packages/g/p", "lib/tool.js").join(","))
    ok("binSources：name→path 映射也展开",
      binSources("packages/g/p", { cli: "./lib/cli.js" }).join(",") === "packages/g/p/src/cli.ts,packages/g/p/src/cli.tsx",
      binSources("packages/g/p", { cli: "./lib/cli.js" }).join(","))
    ok("binSources：lib/ 之外不排除任何源", binSources("packages/g/p", "bin/tool.js").length === 0)
    ok("binSources：无 bin 返回空", binSources("packages/g/p", undefined).length === 0)
    ok("excludedEntry：#! 开头判 shebang", excludedEntry("a.ts", "#!/usr/bin/env node\nawait x()", new Set()) === "shebang")
    ok("excludedEntry：bin 命名源判 bin", excludedEntry("packages/g/p/src/tool.ts", "await x()", new Set(["packages/g/p/src/tool.ts"])) === "bin")
    ok("excludedEntry：普通模块不排除", excludedEntry("a.ts", "await x()", new Set()) === undefined)
  }

  /* ── ① 三种顶层 await 形态各必红，带 文件:行+源码行+怎么改 ── */

  {
    // await expression：注入在第 3 行。
    const f = makeFixture([{ group: "g", pkg: "p", files: { "index.ts": "const a = 1;\nconst b = 2;\nconst value = await fetchIt();\n" } }])
    try {
      const r = judgeAwaits(inputOf(f, ts))
      ok("await 表达式：判红", r.status === "failed", r.status)
      ok("await 表达式：finding 带文件", (r.findings ?? []).some((x) => (x.file ?? "").includes("index.ts")), JSON.stringify(r.findings))
      ok("await 表达式：finding 带行号 3", (r.findings ?? []).some((x) => x.line === 3), JSON.stringify(r.findings?.map((x) => x.line)))
      ok("await 表达式：判词点名形态与源码行", hasFinding(r, "await expression", "const value = await fetchIt()"), JSON.stringify(r.findings))
      ok("await 表达式：判词含怎么改", hasFinding(r, "怎么改", "main()"), JSON.stringify(r.findings))
      // 移除 ⇒ 绿
      fs.writeFileSync(f.src("g", "p", "index.ts"), "const a = 1;\nconst b = 2;\nconst value = callIt();\n")
      const fixed = judgeAwaits(inputOf(f, ts))
      ok("await 表达式：移除后⇒绿（红只来自那处变异）", fixed.status === "passed", `${fixed.status}/${fixed.reason ?? ""}`)
    } finally {
      rmFixture(f)
    }
  }

  {
    // for await：第 2 行。
    const f = makeFixture([{ group: "g", pkg: "p", files: { "index.ts": "const a = 1;\nfor await (const item of stream()) { void item; }\n" } }])
    try {
      const r = judgeAwaits(inputOf(f, ts))
      ok("for await：判红", r.status === "failed", r.status)
      ok("for await：finding 带行号 2", (r.findings ?? []).some((x) => x.line === 2), JSON.stringify(r.findings?.map((x) => x.line)))
      ok("for await：判词点名形态与源码行", hasFinding(r, "for await loop", "for await (const item"), JSON.stringify(r.findings))
      ok("for await：判词含怎么改", hasFinding(r, "怎么改"), JSON.stringify(r.findings))
      fs.writeFileSync(f.src("g", "p", "index.ts"), "const a = 1;\nfor (const item of items()) { void item; }\n")
      ok("for await：移除后⇒绿", judgeAwaits(inputOf(f, ts)).status === "passed")
    } finally {
      rmFixture(f)
    }
  }

  {
    // await using：第 1 行。
    const f = makeFixture([{ group: "g", pkg: "p", files: { "index.ts": "await using resource = acquire();\nvoid resource;\n" } }])
    try {
      const r = judgeAwaits(inputOf(f, ts))
      ok("await using：判红", r.status === "failed", r.status)
      ok("await using：finding 带行号 1", (r.findings ?? []).some((x) => x.line === 1), JSON.stringify(r.findings?.map((x) => x.line)))
      ok("await using：判词点名形态与源码行", hasFinding(r, "await using declaration", "await using resource"), JSON.stringify(r.findings))
      ok("await using：判词含怎么改", hasFinding(r, "怎么改"), JSON.stringify(r.findings))
      fs.writeFileSync(f.src("g", "p", "index.ts"), "const resource = acquire();\nvoid resource;\n")
      ok("await using：移除后⇒绿", judgeAwaits(inputOf(f, ts)).status === "passed")
    } finally {
      rmFixture(f)
    }
  }

  /* ── ② 函数内 await 不误伤 ──────────────────────────────────── */

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "index.ts": [
      "async function f() { const x = await foo(); return x; }",
      "class C { async m() { await bar(); } }",
      "const g = async () => { await baz(); };",
      "export { f, C, g };",
    ].join("\n") + "\n" } }])
    try {
      const r = judgeAwaits(inputOf(f, ts))
      ok("函数内 await：声明/方法/箭头函数全不误伤，判绿", r.status === "passed", `${r.status} ${JSON.stringify(r.findings)}`)
      const v = findTopLevelAwaits("index.ts", fs.readFileSync(f.src("g", "p", "index.ts"), "utf8"), ts)
      ok("函数内 await：findTopLevelAwaits 返回 0 条", v.length === 0, JSON.stringify(v))
    } finally {
      rmFixture(f)
    }
  }

  {
    // 真树反向控制：本树全部 .ts 的函数内 await 全绿。
    // ⚠️ 分母不写死数字：曾硬编码 30，盘上加包加文件后一路假红（30→35→38，快照断言随语料
    //    漂移，ISS-899 清债）。分母改从源现算：checked = files − excluded（scanRepository
    //    的实现式——内部把这个关系改坏时此断言必红）+ 非零（0 文件的 no-corpus 形态由
    //    下方 fail-closed 用例钉死，不靠这里复读）。
    const scan = scanRepository(REPO, ts)
    ok("真树：checked = files − excluded（分母从源现算）", scan.checked === scan.files.length - scan.excluded.length, `${scan.checked} vs files ${scan.files.length} − excluded ${scan.excluded.length}`)
    ok("真树：分母非零（真语料在）", scan.checked > 0, String(scan.checked))
    ok("真树：0 顶层 await 违例", scan.violations.length === 0, JSON.stringify(scan.violations))
    ok("真树：判绿", judgeAwaits({ hasTs: true, scan }).status === "passed")
  }

  /* ── ③ 词法嵌套：顶层 block / if / for / class 计算成员 ────── */

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "index.ts": [
      "{ await inBlock(); }",
      "if (flag) { await inIf(); }",
      "for (const x of xs) { await inFor(x); }",
      "class K { [await computed()]() {} }",
    ].join("\n") + "\n" } }])
    try {
      const r = judgeAwaits(inputOf(f, ts))
      ok("词法嵌套：判红", r.status === "failed", r.status)
      ok("词法嵌套：抓到 4 处（block/if/for/class 计算成员）", (r.findings ?? []).length === 4, JSON.stringify(r.findings?.map((x) => `${x.file}:${x.line}`)))
      ok("词法嵌套：4 个行号 1/2/3/4 齐全",
        [1, 2, 3, 4].every((n) => (r.findings ?? []).some((x) => x.line === n)),
        JSON.stringify(r.findings?.map((x) => x.line)))
    } finally {
      rmFixture(f)
    }
  }

  /* ── ④ 字符串 / 模板 / 注释里的 "await" 不误报 ─────────────── */

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: { "index.ts": [
      "const s = \"await neverCalled();\";",
      "const t = `await alsoNever();`;",
      "// await inComment();",
      "/* await inBlockComment(); */",
      "export { s, t };",
    ].join("\n") + "\n" } }])
    try {
      const r = judgeAwaits(inputOf(f, ts))
      ok("字符串/模板/注释：判绿（AST 天然排除）", r.status === "passed", `${r.status} ${JSON.stringify(r.findings)}`)
      const v = findTopLevelAwaits("index.ts", "const s = \"await x()\"; // await y()\n", ts)
      ok("字符串/注释：findTopLevelAwaits 返回 0 条", v.length === 0, JSON.stringify(v))
    } finally {
      rmFixture(f)
    }
  }

  /* ── ⑤ 可执行文件排除（shebang + bin） ─────────────────────── */

  {
    const f = makeFixture([{ group: "g", pkg: "p", files: {
      "cli.ts": "#!/usr/bin/env node\nawait topLevel();\n",
      "index.ts": "const a = 1;\n",
    } }])
    try {
      const scan = scanRepository(f.root, ts)
      ok("shebang：被排除 1 个", scan.excluded.length === 1, JSON.stringify(scan.excluded))
      ok("shebang：排除理由标记 shebang", scan.excluded[0]?.reason === "shebang", String(scan.excluded[0]?.reason))
      ok("shebang：里面的顶层 await 不参与判定（按声明排除）", scan.violations.length === 0, JSON.stringify(scan.violations))
      ok("shebang：checked = 总数 - 排除数", scan.checked === 1, String(scan.checked))
    } finally {
      rmFixture(f)
    }
  }

  {
    const f = makeFixture([{ group: "g", pkg: "p", bin: { tool: "lib/tool.js" }, files: {
      "tool.ts": "await topLevel();\n",
      "index.ts": "const a = 1;\n",
    } }])
    try {
      const scan = scanRepository(f.root, ts)
      ok("bin：lib/tool.js 对应的 src/tool.ts 被排除", scan.excluded.some((e) => e.file.includes("src/tool.ts") && e.reason === "bin"), JSON.stringify(scan.excluded))
      ok("bin：里面的顶层 await 不参与判定", scan.violations.length === 0, JSON.stringify(scan.violations))
    } finally {
      rmFixture(f)
    }
  }

  /* ── ⑥ 语料完整性：删 .tsx 断言后「非空+不漏包」仍生效 ────── */

  {
    // 0 .tsx 语料也该绿（这正是删掉 DSH .tsx 断言的目的）。
    const f = makeFixture([
      { group: "g", pkg: "p0", files: { "index.ts": "const a = 1;\n" } },
      { group: "g", pkg: "p1", files: { "index.ts": "const b = 2;\n" } },
    ])
    try {
      const files = sourceCorpus(f.root)
      ok("0 .tsx 语料：扫到 2 个 .ts", files.length === 2, JSON.stringify(files))
      ok("0 .tsx 语料：无 .tsx 也不抛错（.tsx 断言已删）", files.every((x) => x.endsWith(".ts")))
      ok("0 .tsx 语料：判绿（不再假红）", judgeAwaits(inputOf(f, ts)).status === "passed")
      const integrity = corpusIntegrity(f.root, files)
      ok("完整性：全包覆盖时 missing 为空", integrity.missing.length === 0 && !integrity.empty, JSON.stringify(integrity))
    } finally {
      rmFixture(f)
    }
  }

  {
    // 缩小 glob 漏包 ⇒ 判红（完整性失败，不是判不了）。
    const f = makeFixture([
      { group: "g", pkg: "p0", files: { "index.ts": "const a = 1;\n" } },
      { group: "g", pkg: "p1", files: { "index.ts": "const b = 2;\n" } },
    ])
    try {
      const narrowed = sourceCorpus(f.root, "packages/g/p0/src/**/*.ts")
      ok("漏包实验：缩小 glob 只扫到 p0", narrowed.length === 1 && narrowed[0]!.includes("p0"), JSON.stringify(narrowed))
      const integrity = corpusIntegrity(f.root, narrowed)
      ok("漏包实验：完整性检查点名 p1/src", integrity.missing.some((m) => m.includes("p1")), JSON.stringify(integrity.missing))
      // 直接构造 scan 用缩小语料，验证 judge 判红（不是 unjudged）。
      const scan: ScanResult = { files: narrowed, integrity, checked: narrowed.length, excluded: [], violations: [] }
      const r = judgeAwaits({ hasTs: true, scan })
      ok("漏包实验：判红（完整性失败）", r.status === "failed", `${r.status}/${r.reason ?? ""}`)
      ok("漏包实验：判词点名漏掉的目录与「不要放宽 glob」",
        hasFinding(r, "p1/src", "完整性失败", "不要放宽 glob"), JSON.stringify(r.findings))
    } finally {
      rmFixture(f)
    }
  }

  /* ── ⑦ 三态 fail-closed ─────────────────────────────────────── */

  {
    const f = makeFixture([]) // 0 源文件
    try {
      const files = sourceCorpus(f.root)
      ok("no-corpus：语料 0 文件", files.length === 0, JSON.stringify(files))
      const integrity = corpusIntegrity(f.root, files)
      ok("no-corpus：integrity.empty=true", integrity.empty === true)
      const scan: ScanResult = { files, integrity, checked: 0, excluded: [], violations: [] }
      const r = judgeAwaits({ hasTs: true, scan })
      ok("no-corpus：判不了", r.status === "unjudged", r.status)
      ok("no-corpus：理由码 no-corpus", r.reason === "no-corpus", String(r.reason))
      ok("no-corpus：判词说分母为 0 不冒绿", hasFinding(r, "分母为 0") || (r.detail ?? "").includes("分母为 0"), r.detail ?? "")
    } finally {
      rmFixture(f)
    }
  }

  {
    const r = judgeAwaits({ hasTs: false, scan: null })
    ok("no-binary：判不了", r.status === "unjudged", r.status)
    ok("no-binary：理由码 no-binary", r.reason === "no-binary", String(r.reason))
    ok("no-binary：判词点名无法 AST 解析", (r.detail ?? "").includes("无法做 AST 解析"), r.detail ?? "")
    ok("no-binary：真树 collect 的 hasTs 为真（本用例只验 judge 三态）", collect(REPO).hasTs === true)
  }

  console.log(
    fails
      ? `✗ ${fails} 条不成立（共 ${okCount}）`
      : `✓ spec 全过（${okCount} 条断言：纯函数 + 三种 await 红/移除绿 + 函数内不误伤 + 词法嵌套 + 字符串注释 + shebang/bin 排除 + 语料完整性/0tsx + 三态 fail-closed）`,
  )
  return fails === 0
}
