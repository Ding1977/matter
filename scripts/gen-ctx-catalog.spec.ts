#!/usr/bin/env node
/**
 * `gen-ctx-catalog` 的生成器 spec（ISS-892 / 轨 D D0）。
 *
 * 生成器从「注释掩码 + 正则」改成 AST 之后，最危险的错法不是崩，而是**静默少抽一条**：
 * 表里少一行、新鲜度判据仍然绿（生成物与源码「一致地错」）。所以这里喂构造语料，
 * 把四类声明的正例、注释/字符串的反例、嵌套函数边界、以及「删一个声明生成物跟着变」
 * 的变异全部钉成断言——每一条删掉生成器对应能力都会红。
 *
 * 入口：`node scripts/gen-ctx-catalog.spec.ts`（也导出 run() 供判据 selftest 复用）。
 */
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { HEADER, buildCatalog, renderCatalog, scanSource, type SourceScan } from "./gen-ctx-catalog.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** 把单文件扫描产物拼成 renderCatalog 能吃的三张表，用于「删声明 → 生成物变」的变异。 */
function surfaceOf(scan: SourceScan, pkg = "pkg") {
  return {
    packages: [{ name: pkg, serviceClasses: scan.serviceClasses, hasApply: scan.hasApply }],
    keyRows: scan.keys.map((k) => ({ ...k, pkg })),
    eventRows: scan.events.map((e) => ({ ...e, pkg })),
  }
}

const tally = { pos: 0, neg: 0, mut: 0, corpus: 0 }
let pass = 0
const failures: string[] = []

/** 分类计数，保证回报里的数字是跑出来的、不是抄的。 */
function check(cat: keyof typeof tally, name: string, fn: () => void): void {
  try {
    fn()
    pass++
    tally[cat]++
  } catch (e) {
    failures.push(`${name}\n    ${(e as Error).message}`)
  }
}

export function run(): boolean {
  pass = 0
  failures.length = 0
  for (const k of Object.keys(tally) as (keyof typeof tally)[]) tally[k] = 0

  // ── ① 正例：4 类声明各能抽出 ──────────────────────────────────────
  check("pos", "正例① declare module / Context → ctx 键", () => {
    const s = scanSource(`declare module "@deepseek-ai/cordis" {
  interface Context {
    issues: IssuesFacility
  }
}`, "x.ts")
    assert.deepEqual(s.keys.map((k) => k.key), ["issues"])
    assert.match(s.keys[0].form, /服务键/)
    assert.equal(s.keys[0].line, 3, "行号应取成员声明行，不是模块起始行")
  })

  check("pos", "正例② class X extends Service + super → 键 + 类角色", () => {
    const s = scanSource(`class Foo extends Service {
  constructor(ctx: Context) {
    super(ctx, "foo")
  }
}`, "x.ts")
    assert.deepEqual(s.serviceClasses, ["Foo"])
    assert.equal(s.keys[0].key, "foo")
    assert.match(s.keys[0].form, /Service 子类/)
    assert.equal(s.keys[0].line, 3)
  })

  check("pos", "正例③ interface Events + JSDoc @mode → 事件", () => {
    const s = scanSource(`declare module "@deepseek-ai/cordis" {
  interface Events {
    /** @mode emit */
    "a/b"(x: X): void
  }
}`, "x.ts")
    assert.deepEqual(s.events.map((e) => e.name), ["a/b"])
    assert.equal(s.events[0].mode, "emit", "@mode 应从 AST 挂载的 JSDoc 读")
    assert.equal(s.events[0].line, 4)
  })

  check("pos", "正例④ ctx.provide 字面量与 storageBackendServiceKey 都收", () => {
    const s = scanSource(`export function apply(ctx: Context): void {
  ctx.provide("dyn", x)
  ctx.provide(storageBackendServiceKey("json"), y)
}`, "x.ts")
    assert.deepEqual(s.keys.map((k) => k.key), ["dyn", "storage.backend.json"])
    assert.ok(s.keys.every((k) => k.form.includes("动态注册")))
    assert.equal(s.hasApply, true, "顶层 export function apply 应被识别")
  })

  check("pos", "正例⑤ @matter/storage 的 StorageForms → hub 表单键（整串模块名相等）", () => {
    const s = scanSource(`declare module "@matter/storage" {
  interface StorageForms {
    domain: DomainFacility
  }
}`, "x.ts")
    assert.deepEqual(s.keys.map((k) => k.key), ["storage.domain"])
    assert.match(s.keys[0].form, /hub 表单键/)
    assert.equal(s.keys[0].line, 3)
  })

  check("pos", "正例⑥ 嵌套函数内的 ctx.provide 仍抽出（旧版口径：遍历整棵树）", () => {
    const s = scanSource(`export function apply(ctx: Context): void {
  const mount = () => { ctx.provide("nested", x) }
  mount()
}`, "x.ts")
    assert.deepEqual(s.keys.map((k) => k.key), ["nested"])
  })

  // ── ② 反例：注释 / 字符串 / 边界不算 ───────────────────────────────
  check("neg", "反例① 行注释里的 ctx.provide 不算", () => {
    const s = scanSource(`// ctx.provide("ghost", x)
const real = 1`, "x.ts")
    assert.deepEqual(s.keys, [])
  })

  check("neg", "反例② 块注释里的 ctx.provide 不算", () => {
    const s = scanSource(`/* ctx.provide("ghost", x) */
const real = 1`, "x.ts")
    assert.deepEqual(s.keys, [])
  })

  check("neg", "反例③ 字符串里的 ctx.provide 不算", () => {
    const s = scanSource(`const s = 'ctx.provide("ghost", x)'`, "x.ts")
    assert.deepEqual(s.keys, [])
  })

  check("neg", "反例④ 块注释里的 declare module 不算（无键、无事件）", () => {
    const s = scanSource(`/*
declare module "@deepseek-ai/cordis" {
  interface Context { ghost: X }
  interface Events { "ghost/e"(x: X): void }
}
*/`, "x.ts")
    assert.deepEqual(s.keys, [])
    assert.deepEqual(s.events, [])
  })

  check("neg", "反例⑤ 块注释里的 class extends Service 不算", () => {
    const s = scanSource(`/* class Ghost extends Service { constructor(ctx: Context){ super(ctx, "ghost") } } */`, "x.ts")
    assert.deepEqual(s.serviceClasses, [])
    assert.deepEqual(s.keys, [])
  })

  check("neg", "反例⑥ 边界：other.ctx.provide 不是裸 ctx 调用，不算", () => {
    const s = scanSource(`other.ctx.provide("ghost", x)`, "x.ts")
    assert.deepEqual(s.keys, [])
  })

  check("neg", "反例⑦ 边界：首参非字符串的 ctx.provide 不算", () => {
    const s = scanSource(`ctx.provide(keyVariable, x)`, "x.ts")
    assert.deepEqual(s.keys, [])
  })

  // ── ③ 变异：删一个声明，生成物必须跟着变 ────────────────────────────
  check("mut", "变异① 删 ctx.provide → 生成物不再有该键", () => {
    const withDecl = scanSource(`ctx.provide("gone", x)`, "x.ts")
    const without = scanSource(`const nothing = 1`, "x.ts")
    const a = renderCatalog(surfaceOf(withDecl))
    const b = renderCatalog(surfaceOf(without))
    assert.ok(a.includes("ctx.gone"), "删之前生成物应含该键")
    assert.ok(!b.includes("ctx.gone"), "删之后生成物必须不含该键")
    assert.notEqual(a, b, "生成物必须跟着变")
  })

  check("mut", "变异② 删 Events 声明 → 生成物不再有该事件", () => {
    const withDecl = scanSource(`declare module "@deepseek-ai/cordis" {
  interface Events { "a/b"(x: X): void }
}`, "x.ts")
    const without = scanSource(`declare module "@deepseek-ai/cordis" {
  interface Events {}
}`, "x.ts")
    const a = renderCatalog(surfaceOf(withDecl))
    const b = renderCatalog(surfaceOf(without))
    assert.ok(a.includes("a/b"))
    assert.ok(!b.includes("a/b"))
  })

  check("mut", "变异③ 删 Service super → 生成物不再有该键", () => {
    const withDecl = scanSource(`class Foo extends Service {
  constructor(ctx: Context) { super(ctx, "foo") }
}`, "x.ts")
    const without = scanSource(`class Foo extends Service {
  constructor(ctx: Context) { super(ctx) }
}`, "x.ts")
    const a = renderCatalog(surfaceOf(withDecl))
    const b = renderCatalog(surfaceOf(without))
    assert.ok(a.includes("ctx.foo"))
    assert.ok(!b.includes("ctx.foo"))
  })

  check("mut", "变异④ 删键后头部计数行随之变化（不是只变某一格）", () => {
    const a = renderCatalog(surfaceOf(scanSource(`ctx.provide("gone", x)`, "x.ts")))
    const b = renderCatalog(surfaceOf(scanSource(`const nothing = 1`, "x.ts")))
    assert.match(a, /包 1 个 · ctx 键 1 条 · 事件 0 条/)
    assert.match(b, /包 1 个 · ctx 键 0 条 · 事件 0 条/)
  })

  // ── ④ 真语料不变式：本仓现读数仍是包 6 / ctx 键 7 / 事件 1 ──────────
  check("corpus", "真语料：6 包 / 7 键 / 1 事件，且文件头指向 .ts", () => {
    const text = buildCatalog(REPO)
    const m = /包 (\d+) 个 · ctx 键 (\d+) 条 · 事件 (\d+) 条/u.exec(text)
    assert.deepEqual(m?.slice(1), ["6", "7", "1"], "AST 抽取若改变现读数须在 note 说明")
    assert.ok(text.startsWith(HEADER))
    assert.match(HEADER, /gen-ctx-catalog\.ts/)
  })

  const total = Object.values(tally).reduce((a, b) => a + b, 0)
  if (failures.length) {
    console.error(failures.map((f) => `✗ ${f}`).join("\n"))
    console.error(`✗ gen-ctx-catalog spec：${pass} 过 / ${failures.length} 失败`)
    return false
  }
  console.log(
    `✓ gen-ctx-catalog spec 全过：${total} 条（正例 ${tally.pos} / 反例 ${tally.neg} / 变异 ${tally.mut} / 真语料 ${tally.corpus}）` +
      ` —— SPEC_RESULT total=${total} pass=${pass} fail=${failures.length} pos=${tally.pos} neg=${tally.neg} mut=${tally.mut} corpus=${tally.corpus}`,
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
