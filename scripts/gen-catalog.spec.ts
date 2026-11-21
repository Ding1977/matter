#!/usr/bin/env node
/**
 * `gen-catalog` 框架 + 3 extractor 的 spec（ISS-893 / 轨 D D1）。
 *
 * 最危险的错法不是崩，而是**静默少抽一条**：表里少一行、新鲜度判据仍绿（生成物与源码
 * 「一致地错」）。所以这里把框架的注册/共用、3 个 extractor 的正例、注释/字符串反例、
 * 「删一个声明生成物跟着变」的变异、以及真语料数字全部钉成断言 —— 每条删掉对应能力都会红。
 *
 * 分类计数（pos/neg/mut/corpus）打印成机读 `SPEC_RESULT`，供 grep 核对（不写死在回报里）。
 * 入口：`node scripts/gen-catalog.spec.ts`（也导出 run() 供复用）。
 */
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  EXTRACTORS,
  REPO_ROOT,
  buildProgram,
  computeDependencies,
  dependencyExtractor,
  eventExtractor,
  generateAll,
  scanEventDeclarations,
  scanImportRefs,
  type DependencySurface,
  type EventSurface,
  type ImportRef,
  type PkgInfo,
} from "./gen-catalog.ts"
import { buildCatalog, ctxExtractor, scanSource } from "./gen-ctx-catalog.ts"

const REPO = REPO_ROOT

/** 分类计数，保证回报里的数字是跑出来的、不是抄的。 */
const tally = { pos: 0, neg: 0, mut: 0, corpus: 0 }
let pass = 0
const failures: string[] = []

function check(cat: keyof typeof tally, name: string, fn: () => void): void {
  try {
    fn()
    pass++
    tally[cat]++
  } catch (e) {
    failures.push(`${name}\n    ${(e as Error).message}`)
  }
}

/** 从单文件扫描拼成 event 面（给变异用）。 */
const eventSurfaceOf = (rows: EventSurface["rows"]): EventSurface => ({ rows, packageCount: 1 })

export function run(): boolean {
  pass = 0
  failures.length = 0
  for (const k of Object.keys(tally) as (keyof typeof tally)[]) tally[k] = 0

  const program = buildProgram(REPO)

  // ── ① 框架正例 ───────────────────────────────────────────────────────
  check("pos", "框架① EXTRACTORS 三个真实消费者：id/output 唯一且齐全", () => {
    assert.equal(EXTRACTORS.length, 3)
    assert.deepEqual(EXTRACTORS.map((e) => e.id), ["ctx", "event", "dependency"])
    assert.equal(new Set(EXTRACTORS.map((e) => e.output)).size, 3)
    for (const e of EXTRACTORS) {
      assert.match(e.output, /^docs\/.*catalog\.md$/)
      assert.equal(typeof e.extract, "function")
      assert.equal(typeof e.render, "function")
    }
  })

  check("pos", "框架② 单个 program 供 3 extractor 共用，一次 generateAll 产 3 张", () => {
    const out = generateAll(REPO)
    assert.equal(out.length, 3)
    assert.deepEqual(out.map((o) => o.output), EXTRACTORS.map((e) => e.output))
    for (const o of out) assert.ok(o.text.length > 100, `${o.output} 不应为空`)
    assert.ok(program.getSourceFiles().length > 0, "program 必须真的解析到源文件")
  })

  check("pos", "框架③ 幂等：同仓连跑两次逐字节相同（无时间戳）", () => {
    const a = generateAll(REPO)
    const b = generateAll(REPO)
    assert.deepEqual(a, b)
  })

  // ── ② ctx extractor ───────────────────────────────────────────────────
  check("pos", "ctx 正例：抽 6 包 / 7 键 / 1 事件，render 与 D0 完全一致", () => {
    const surface = ctxExtractor.extract(REPO, program)
    assert.equal(surface.packages.length, 6)
    assert.equal(surface.keyRows.length, 7)
    assert.equal(surface.eventRows.length, 1)
    assert.equal(ctxExtractor.render(surface), buildCatalog(REPO), "迁入后生成物必须字节不变")
  })

  check("neg", "ctx 反例① 行注释里的 ctx.provide 不算（AST 天然抽不到）", () => {
    const s = scanSource(`// ctx.provide("ghost", x)\nconst real = 1`, "x.ts")
    assert.deepEqual(s.keys, [])
  })

  check("neg", "ctx 反例② other.ctx.provide 不是裸 ctx 调用，不算", () => {
    assert.deepEqual(scanSource(`other.ctx.provide("ghost", x)`, "x.ts").keys, [])
  })

  check("mut", "ctx 变异：删一个 ctx.provide，生成物不再含该键", () => {
    const surfaceOf = (src: string) => {
      const s = scanSource(src, "x.ts")
      return {
        packages: [{ name: "pkg", dir: "packages/x/pkg", description: "", keys: s.keys, events: s.events, serviceClasses: s.serviceClasses, hasApply: s.hasApply }],
        keyRows: s.keys.map((k) => ({ ...k, pkg: "pkg" })),
        eventRows: s.events.map((e) => ({ ...e, pkg: "pkg" })),
      }
    }
    const a = ctxExtractor.render(surfaceOf(`ctx.provide("gone", x)`))
    const b = ctxExtractor.render(surfaceOf(`const nothing = 1`))
    assert.ok(a.includes("ctx.gone"))
    assert.ok(!b.includes("ctx.gone"))
    assert.notEqual(a, b)
  })

  // ── ③ event extractor ─────────────────────────────────────────────────
  check("pos", "event 正例① interface Events + @mode emit 抽出（名/模式/行）", () => {
    const rows = scanEventDeclarations(`declare module "@deepseek-ai/cordis" {
  interface Events {
    /** @mode emit */
    "a/b"(x: X): void
  }
}`, "x.ts", "@matter/a")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, "a/b")
    assert.equal(rows[0].mode, "emit")
    assert.equal(rows[0].line, 4)
    assert.equal(rows[0].pkg, "@matter/a")
  })

  check("pos", "event 正例② 真语料：1 条 domain/changed，@mode emit", () => {
    const surface = eventExtractor.extract(REPO, program)
    assert.equal(surface.packageCount, 6)
    assert.equal(surface.rows.length, 1)
    assert.equal(surface.rows[0].name, "domain/changed")
    assert.equal(surface.rows[0].mode, "emit")
    assert.equal(surface.rows[0].pkg, "@matter/storage-domain")
    assert.equal(surface.rows[0].site, "packages/storage/storage-domain/src/events.ts")
  })

  check("neg", "event 反例① 注释里的 Events 不算", () => {
    const rows = scanEventDeclarations(`// interface Events { "ghost/e"(): void }`, "x.ts", "@matter/a")
    assert.deepEqual(rows, [])
  })

  check("neg", "event 反例② 字符串里的 Events 不算", () => {
    const rows = scanEventDeclarations(`const s = 'interface Events { "ghost/e"(): void }'`, "x.ts", "@matter/a")
    assert.deepEqual(rows, [])
  })

  check("mut", "event 变异：删事件 → 生成物不含该名、头部计数跟着变", () => {
    const withRow = eventSurfaceOf([{ name: "a/b", mode: "emit", site: "x.ts", line: 3, pkg: "@matter/a" }])
    const without = eventSurfaceOf([])
    const a = eventExtractor.render(withRow)
    const b = eventExtractor.render(without)
    assert.ok(a.includes("a/b"))
    assert.match(a, /事件声明 1 条/)
    assert.ok(!b.includes("a/b"))
    assert.match(b, /事件声明 0 条/)
  })

  // ── ④ dependency extractor ────────────────────────────────────────────
  check("pos", "dependency 正例① 声明 ∪ import 合成边，外部依赖单列", () => {
    const pkgs: PkgInfo[] = [
      { name: "@matter/a", dir: "packages/x/a", dependencies: { "@matter/b": "workspace:*", zod: "1" } },
      { name: "@matter/b", dir: "packages/x/b", dependencies: {} },
    ]
    const refs: ImportRef[] = [
      { from: "@matter/a", target: "@matter/b", site: "x.ts", line: 3 },
      { from: "@matter/a", target: "@matter/typo", site: "x.ts", line: 4 },
    ]
    const s = computeDependencies(pkgs, refs)
    assert.equal(s.packageCount, 2)
    assert.equal(s.edges.length, 1)
    assert.equal(s.edges[0].from, "@matter/a")
    assert.equal(s.edges[0].to, "@matter/b")
    assert.equal(s.edges[0].declared, true)
    assert.deepEqual(s.edges[0].imports, ["x.ts:3"])
    assert.deepEqual(s.external, [{ from: "@matter/a", name: "zod", version: "1" }])
  })

  check("pos", "dependency 正例② 真语料：6 包 / 7 边 / 4 外部，issue→storage 有据", () => {
    const s = dependencyExtractor.extract(REPO, program)
    assert.equal(s.packageCount, 6)
    assert.equal(s.edges.length, 7)
    assert.equal(s.external.length, 4)
    const edge = s.edges.find((e) => e.from === "@matter/issue" && e.to === "@matter/storage")
    assert.ok(edge, "issue 应依赖 storage")
    assert.equal(edge.declared, true)
    assert.ok(edge.imports.some((p) => p.includes("packages/pm/issue/src/index.ts")))
  })

  check("neg", "dependency 反例① 拼错的目标包不进边表（只认真实包名）", () => {
    const pkgs: PkgInfo[] = [{ name: "@matter/a", dir: "p/a", dependencies: {} }]
    const refs: ImportRef[] = [{ from: "@matter/a", target: "@matter/ghost", site: "x.ts", line: 1 }]
    assert.equal(computeDependencies(pkgs, refs).edges.length, 0)
  })

  check("neg", "dependency 反例② 注释/字符串里的 from \"@matter/x\" 不算", () => {
    assert.deepEqual(scanImportRefs(`// import { X } from "@matter/ghost"`, "x.ts", "@matter/a"), [])
    assert.deepEqual(scanImportRefs(`const s = 'from "@matter/ghost"'`, "x.ts", "@matter/a"), [])
  })

  check("mut", "dependency 变异① 删声明但保留 import ⇒ declared 由是变否，边仍在", () => {
    const pkgs: PkgInfo[] = [{ name: "@matter/a", dir: "p/a", dependencies: {} }]
    const pkgsDeclared: PkgInfo[] = [{ name: "@matter/a", dir: "p/a", dependencies: { "@matter/b": "workspace:*" } }]
    const refs: ImportRef[] = [{ from: "@matter/a", target: "@matter/b", site: "x.ts", line: 2 }]
    const withDecl = computeDependencies([...pkgsDeclared, { name: "@matter/b", dir: "p/b", dependencies: {} }], refs)
    const withoutDecl = computeDependencies([...pkgs, { name: "@matter/b", dir: "p/b", dependencies: {} }], refs)
    assert.equal(withDecl.edges[0].declared, true)
    assert.equal(withoutDecl.edges[0].declared, false)
    assert.equal(withoutDecl.edges.length, 1, "import 还在 ⇒ 边不能消失")
  })

  check("mut", "dependency 变异② 删声明与 import ⇒ 边消失，生成物跟着变", () => {
    const surface = (withDep: boolean): DependencySurface => ({
      packageCount: 2,
      edges: withDep ? [{ from: "@matter/a", to: "@matter/b", declared: true, imports: [] }] : [],
      external: [],
    })
    const a = dependencyExtractor.render(surface(true))
    const b = dependencyExtractor.render(surface(false))
    assert.ok(a.includes("@matter/b"))
    assert.match(a, /包间依赖 1 条/)
    assert.ok(!b.includes("@matter/a` | `@matter/b"))
    assert.match(b, /包间依赖 0 条/)
  })

  // ── ⑤ 真语料数字 grep 核对 ───────────────────────────────────────────
  check("corpus", "真语料数字：ctx 6/7/1 · event 1 · dependency 6/7/4（与生成物头部一致）", () => {
    const texts = generateAll(REPO)
    const ctx = texts[0].text
    const ev = texts[1].text
    const dep = texts[2].text
    assert.match(ctx, /包 6 个 · ctx 键 7 条 · 事件 1 条/)
    assert.match(ev, /事件声明 1 条 · 来源包 6 个/)
    assert.match(dep, /包 6 个 · 包间依赖 7 条 · 外部依赖 4 条/)
    assert.ok(ctx.includes("gen-ctx-catalog.ts"), "ctx 头部仍指向 D0 生成器（内容不变）")
    assert.ok(ev.includes("gen-catalog.ts") && dep.includes("gen-catalog.ts"))
  })

  const total = Object.values(tally).reduce((a, b) => a + b, 0)
  if (failures.length) {
    console.error(failures.map((f) => `✗ ${f}`).join("\n"))
    console.error(`✗ gen-catalog spec：${pass} 过 / ${failures.length} 失败`)
    return false
  }
  console.log(
    `✓ gen-catalog spec 全过：${total} 条（正例 ${tally.pos} / 反例 ${tally.neg} / 变异 ${tally.mut} / 真语料 ${tally.corpus}）` +
      ` —— SPEC_RESULT total=${total} pass=${pass} fail=0 pos=${tally.pos} neg=${tally.neg} mut=${tally.mut} corpus=${tally.corpus}`,
  )
  return true
}

const invokedDirectly = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return pathToFileURL(path.resolve(argv1)).href === import.meta.url
  } catch {
    return false
  }
})()

if (invokedDirectly) process.exitCode = run() ? 0 : 1
