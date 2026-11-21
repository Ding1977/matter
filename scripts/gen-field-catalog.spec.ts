/**
 * `gen-field-catalog` 生成器的 spec（ISS-896 / P3-F1）。
 *
 * 最危险的错法不是崩，而是**静默少抽一张**：表里少一个 schema、新鲜度判据仍绿（生成物与
 * 源码「一致地错」）。所以把判别口径三条（strictObject 字面量 / 属性全为 z.* 链 / 链全带
 * 三键 meta）各钉一个正反例，「删 meta ⇒ schema 消失」的变异（对应验收 6）、真语料数字
 * （3 schema / 48 字段 / 12-11-25 分布）与幂等全部断言 —— 每条删掉对应能力都会红。
 *
 * 分类计数（pos/neg/mut/corpus）打印成机读 `SPEC_RESULT`，供 grep 核对。
 * 入口：`node scripts/gen-field-catalog.spec.ts`（也导出 run() 供复用）。
 */
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  REPO,
  buildFieldCatalog,
  renderFieldCatalog,
  scanFieldSchemas,
  scanFieldSurface,
  type FieldSchema,
} from "./gen-field-catalog.ts"

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

/** 构造语料：一张最小字段清单（含三种形态：string+regex / array+optional / iso.date）。 */
const SRC = `export const Mini = z.strictObject({
  id: z.string().regex(ID_RE).meta({ writable: "immutable", widget: "text", indexable: true }),
  tags: z.array(z.string()).optional().meta({ writable: "user", widget: "tags", indexable: false }),
  created: z.iso.date().meta({ writable: "immutable", widget: "date", indexable: false }),
})`
const miniOf = (src: string): FieldSchema[] => scanFieldSchemas(src, "x.ts")

export function run(): boolean {
  pass = 0
  failures.length = 0
  for (const k of Object.keys(tally) as (keyof typeof tally)[]) tally[k] = 0

  // ── ① 正例：判别口径三条全满足 ⇒ 收 ──────────────────────────────────
  check("pos", "正例① 三形态字段全抽：名/形态/optional/meta 三键/行号", () => {
    const s = miniOf(SRC)
    assert.equal(s.length, 1)
    assert.equal(s[0].name, "Mini")
    assert.equal(s[0].line, 1)
    assert.deepEqual(s[0].fields.map((f) => f.name), ["id", "tags", "created"])
    assert.equal(s[0].fields[0].shape, "z.string")
    assert.equal(s[0].fields[0].optional, false)
    assert.deepEqual(s[0].fields[0].meta, { writable: "immutable", widget: "text", indexable: true })
    assert.equal(s[0].fields[0].line, 2)
    assert.equal(s[0].fields[1].shape, "z.array<z.string>")
    assert.equal(s[0].fields[1].optional, true)
    assert.equal(s[0].fields[2].shape, "z.iso.date")
  })

  check("pos", "正例② 校验器不进类型列：.regex/.min 是校验不是形态", () => {
    const s = miniOf(`export const M = z.strictObject({
  a: z.string().min(1).meta({ writable: "user", widget: "text", indexable: true }),
})`)
    assert.equal(s[0].fields[0].shape, "z.string")
  })

  check("pos", "正例③ meta 额外键（branded）容忍，不进五列", () => {
    const s = miniOf(`export const M = z.strictObject({
  id: z.string().meta({ writable: "immutable", widget: "text", indexable: true, branded: "DocId" }),
})`)
    assert.deepEqual(s[0].fields[0].meta, { writable: "immutable", widget: "text", indexable: true })
  })

  check("pos", "正例④ 非 export / 非 strictObject 不收（口径 ①）", () => {
    assert.deepEqual(miniOf(`const NotExported = z.strictObject({ x: z.string().meta({ writable: "user", widget: "text", indexable: true }) })`), [])
    assert.deepEqual(miniOf(`export const Loose = z.object({ x: z.string().meta({ writable: "user", widget: "text", indexable: true }) })`), [])
  })

  check("pos", "正例⑤ nullable / nullish 不静默吞：抽 nullable 标记并渲染 `|null` / `?|null` 后缀（ISS-896 审查 minor 钉子）", () => {
    const s = miniOf(`export const M = z.strictObject({
  a: z.string().nullable().meta({ writable: "user", widget: "text", indexable: true }),
  b: z.string().nullish().meta({ writable: "user", widget: "text", indexable: true }),
})`)
    assert.equal(s.length, 1)
    assert.equal(s[0].fields[0].optional, false)
    assert.equal(s[0].fields[0].nullable, true)
    assert.equal(s[0].fields[1].optional, true, "nullish ⇒ optional 也为真")
    assert.equal(s[0].fields[1].nullable, true)
    const text = renderFieldCatalog({ schemas: s, packageCount: 8 })
    // 表格 cell 里竖线被转义为 `\|`（markdown 表格字面竖线），断言按转义后形态匹配。
    assert.ok(text.includes("`z.string\\|null`"), "nullable 字段的类型列应带 |null 后缀")
    assert.ok(text.includes("`z.string?\\|null`"), "nullish 字段的类型列应带 ?|null 后缀")
  })

  // ── ② 反例：口径任一不满足 ⇒ 整张不收（不静默收半张） ────────────────
  check("neg", "反例① 注释里的 z.strictObject 不是 AST 节点，抽不到", () => {
    assert.deepEqual(miniOf(`// export const Ghost = z.strictObject({ x: z.string() })`), [])
  })

  check("neg", "反例② 字符串里的不算", () => {
    assert.deepEqual(miniOf(`const s = "export const Ghost = z.strictObject({})"`), [])
  })

  check("neg", "反例③ 引用型属性（DocRecord 形态）⇒ 整张不算字段清单（口径 ②）", () => {
    assert.deepEqual(
      miniOf(`export const Rec = z.strictObject({ props: DocProps, blocks: BlockArray })`),
      [],
    )
  })

  check("neg", "反例④ 字段链无 .meta()（blocks 叶子形态）⇒ 整张不收（口径 ③）", () => {
    assert.deepEqual(miniOf(`export const Leaf = z.strictObject({ type: z.literal("p") })`), [])
  })

  check("neg", "反例⑤ meta 三键缺一（缺 indexable）⇒ 不算字段链，整张不收", () => {
    assert.deepEqual(
      miniOf(`export const M = z.strictObject({
  x: z.string().meta({ writable: "user", widget: "text" }),
})`),
      [],
    )
  })

  check("neg", "反例⑥ 衍生 schema（.omit().partial()）无字面量属性，抽不到", () => {
    assert.deepEqual(miniOf(`export const Patch = Props.omit({ id: true }).partial()`), [])
  })

  // ── ③ 变异：删东西 ⇒ 生成物跟着变（判据才能红） ───────────────────────
  check("mut", "变异① 删一个字段的 .meta() ⇒ schema 整张消失（meta 纪律由机器兜底）", () => {
    const withMeta = miniOf(SRC)
    const noMeta = miniOf(SRC.replace('.meta({ writable: "immutable", widget: "text", indexable: true })', ""))
    assert.equal(withMeta.length, 1)
    assert.equal(noMeta.length, 0, "链上没 meta 就不该收这张 schema")
    assert.ok(renderFieldCatalog({ schemas: withMeta, packageCount: 8 }).includes("Mini"))
    assert.ok(!renderFieldCatalog({ schemas: noMeta, packageCount: 8 }).includes("Mini"))
  })

  check("mut", "变异② 删整字段 ⇒ 该行消失、头部字段计数跟着变", () => {
    const three = miniOf(SRC)
    const two = miniOf(SRC.replace('  created: z.iso.date().meta({ writable: "immutable", widget: "date", indexable: false }),\n', ""))
    assert.equal(three[0].fields.length, 3)
    assert.equal(two[0].fields.length, 2)
    const a = renderFieldCatalog({ schemas: three, packageCount: 8 })
    const b = renderFieldCatalog({ schemas: two, packageCount: 8 })
    assert.ok(a.includes("`created`"))
    assert.ok(!b.includes("`created`"))
    assert.match(a, /字段 3 条/)
    assert.match(b, /字段 2 条/)
  })

  check("mut", "变异③ 可空性翻转 ⇒ 类型列后缀跟着变（optional/nullable 各自有牙）", () => {
    const withOpt = miniOf(SRC)
    const noOpt = miniOf(SRC.replace(".optional().meta", ".meta"))
    const nulled = miniOf(SRC.replace(".optional().meta", ".nullable().meta"))
    assert.match(renderFieldCatalog({ schemas: withOpt, packageCount: 8 }), /`z\.array<z\.string>\?`/)
    assert.match(renderFieldCatalog({ schemas: noOpt, packageCount: 8 }), /`z\.array<z\.string>`/)
    assert.ok(renderFieldCatalog({ schemas: nulled, packageCount: 8 }).includes("`z.array<z.string>\\|null`"))
  })

  // ── ④ 真语料：数字是扫出来的 ─────────────────────────────────────────
  check("corpus", "真语料① 三域 3 schema / 48 字段（12-11-25），blocks/DocRecord/Patch 不在表里", () => {
    const s = scanFieldSurface(REPO)
    assert.equal(s.packageCount, 8)
    assert.equal(s.schemas.length, 3)
    assert.deepEqual(s.schemas.map((x) => x.name), ["DocProps", "IssueProps", "ProjectProps"])
    assert.deepEqual(s.schemas.map((x) => x.fields.length), [25, 12, 11])
    assert.equal(s.schemas.reduce((n, x) => n + x.fields.length, 0), 48)
    const names = s.schemas.map((x) => x.name).join(",")
    for (const not of ["DocRecord", "IssuePatch", "ProjectPatch", "DocPatch", "Rich"]) {
      assert.ok(!names.includes(not), `${not} 不该在表里`)
    }
  })

  check("corpus", "真语料② 生成物头部自述数字，与判据的 grep 口径一致", () => {
    const text = buildFieldCatalog(REPO)
    assert.match(text, /字段清单 schema 3 张 · 字段 48 条 · 覆盖包 3 个 · 扫描面 8 包/)
    assert.ok(text.includes("## @matter/document · DocProps（25 字段）"))
    assert.ok(text.includes("## @matter/issue · IssueProps（12 字段）"))
    assert.ok(text.includes("## @matter/project · ProjectProps（11 字段）"))
  })

  check("corpus", "真语料③ 幂等：同仓连跑两次逐字节相同（无时间戳）", () => {
    assert.equal(buildFieldCatalog(REPO), buildFieldCatalog(REPO))
  })

  const total = Object.values(tally).reduce((a, b) => a + b, 0)
  if (failures.length) {
    console.error(failures.map((f) => `✗ ${f}`).join("\n"))
    console.error(`✗ gen-field-catalog spec：${pass} 过 / ${failures.length} 失败`)
    return false
  }
  console.log(
    `✓ gen-field-catalog spec 全过：${total} 条（正例 ${tally.pos} / 反例 ${tally.neg} / 变异 ${tally.mut} / 真语料 ${tally.corpus}）` +
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
