/**
 * `gen-block-catalog` 生成器的 spec（ISS-900 / P3-F2）。
 *
 * 最危险的错法不是崩，而是**静默少抽一块 / 抽错口径**：表里少一个块、新鲜度判据仍绿（生成物与
 * 源码「一致地错」）。所以把抽取口径各钉正反例（base 展开 / strictObject / 字符串与注释不抽）、
 * 词表标记与批次的变异（改 type literal / 加字段 / 改容器引用词表 / 改分档词表各断言生成物变），
 * 真语料数字（28 块 / A9-B7-C12 / 容器 3 / 引用 4 / 第一批 14）与幂等全部断言 ——
 * 每条删掉对应能力都会红。
 *
 * 分类计数（pos/neg/mut/corpus）打印成机读 `SPEC_RESULT`，供 grep 核对。
 * 入口：`node scripts/gen-block-catalog.spec.ts`（也导出 run() 供复用）。
 */
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  REPO,
  HEADER,
  buildBlockCatalog,
  renderBlockCatalog,
  scanBlockSchemas,
  scanBlockSurface,
  surfaceFromSource,
  type BlockRow,
} from "./gen-block-catalog.ts"

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

/** 构造语料：mini spec.ts —— 5 块 / A2-B2-C1 / 容器 1 / 引用 1 / 第一批 4。 */
const SRC = `export const A_BASIC_TYPES = ["paragraph", "heading"] as const
export const B_BUSINESS_TYPES = ["issueRef", "toggle"] as const
export const C_NOTION_TYPES = ["video"] as const
export const CONTAINER_TYPES = ["toggle"] as const
export const REFERENCE_TYPES = ["issueRef"] as const
const base = (type) => ({ id: blockId, type: z.literal(type) })
const rich = z.array(Rich).optional()
const Paragraph = z.strictObject({ ...base("paragraph"), rich })
const Heading = z.strictObject({ ...base("heading"), level: z.number().int() })
const IssueRef = z.strictObject({ ...base("issueRef"), ref, preview: z.boolean().optional() })
const Toggle = z.strictObject({ ...base("toggle"), title: z.string(), children: blockChildren })
const Video = z.strictObject({ ...base("video"), url })`
const miniBlocks = (src: string): BlockRow[] => scanBlockSchemas(src, "x.ts")
const byType = (b: BlockRow[]): Map<string, BlockRow> => new Map(b.map((x) => [x.type, x]))

export function run(): boolean {
  pass = 0
  failures.length = 0
  for (const k of Object.keys(tally) as (keyof typeof tally)[]) tally[k] = 0

  // ── ① 正例：口径全满足 ⇒ 抽到块 ──────────────────────────────────────
  check("pos", "正例① 5 块全抽：schema 名 / type / 字段 / 行号", () => {
    const b = miniBlocks(SRC)
    assert.equal(b.length, 5)
    assert.deepEqual(b.map((x) => x.schema), ["Paragraph", "Heading", "IssueRef", "Toggle", "Video"])
    assert.deepEqual(b.map((x) => x.type), ["paragraph", "heading", "issueRef", "toggle", "video"])
    assert.equal(b[0].line, 8)
    const m = byType(b)
    assert.deepEqual(m.get("paragraph")!.fields, ["rich"])
    assert.deepEqual(m.get("heading")!.fields, ["level"])
    assert.deepEqual(m.get("issueRef")!.fields, ["ref", "preview"])
    assert.deepEqual(m.get("toggle")!.fields, ["title", "children"])
    assert.deepEqual(m.get("video")!.fields, ["url"])
  })

  check("pos", "正例② type 取自 base(\"…\") 字面量，不是 schema 变量名", () => {
    const m = byType(miniBlocks(SRC))
    assert.equal(m.has("Paragraph"), false)
    assert.equal(m.has("paragraph"), true)
  })

  check("pos", "正例③ 渲染头部自述数字 + 三档分节 + 标记/第一批列", () => {
    const text = renderBlockCatalog(surfaceFromSource(SRC))
    assert.ok(text.startsWith(HEADER))
    assert.match(text, /共 5 种块 · A 基础 2 \/ B 业务 2 \/ C Notion 1 · 容器 1 · 引用 1 · 第一批 4 · 词表声明 5/)
    assert.ok(text.includes("## A 基础（2 种）"))
    assert.ok(text.includes("## B 业务（2 种）"))
    assert.ok(text.includes("## C Notion 扩展（1 种）"))
    assert.ok(text.includes("| `paragraph` | `rich` | 否 | 否 | A 基础 | ✓ |"))
    assert.ok(text.includes("| `toggle` | `title`、`children` | 是 | 否 | B 业务 | ✓ |"))
    assert.ok(text.includes("| `issueRef` | `ref`、`preview` | 否 | 是 | B 业务 | ✓ |"))
    assert.ok(text.includes("| `video` | `url` | 否 | 否 | C Notion 扩展 | — |"))
  })

  check("pos", "正例④ 无字段的块字段列写 —，容器兼引用两块标记同时为是", () => {
    const src = SRC + "\nconst Empty = z.strictObject({ ...base(\"empty\") })"
    const text = renderBlockCatalog(surfaceFromSource(src))
    assert.ok(text.includes("| `empty` | — |"))
    const both = "export const A_BASIC_TYPES = [] as const\nexport const B_BUSINESS_TYPES = [] as const\nexport const C_NOTION_TYPES = [\"syncedBlock\"] as const\nexport const CONTAINER_TYPES = [\"syncedBlock\"] as const\nexport const REFERENCE_TYPES = [\"syncedBlock\"] as const\nconst base = (t) => ({ type: z.literal(t) })\nconst S = z.strictObject({ ...base(\"syncedBlock\"), ref, children })"
    assert.ok(renderBlockCatalog(surfaceFromSource(both)).includes("| `syncedBlock` | `ref`、`children` | 是 | 是 | C Notion 扩展 | — |"))
  })

  // ── ② 反例：口径任一不满足 ⇒ 整块不收（不静默收错） ──────────────────
  check("neg", "反例① 注释里的 z.strictObject 不是 AST 节点，抽不到", () => {
    assert.deepEqual(miniBlocks(`// const Ghost = z.strictObject({ ...base("ghost"), f: z.string() })`), [])
  })

  check("neg", "反例② 字符串里的不算", () => {
    assert.deepEqual(miniBlocks(`const s = 'const Ghost = z.strictObject({ ...base("ghost") })'`), [])
  })

  check("neg", "反例③ 没有 base 展开的 z.strictObject（Rich 等共用 schema）不是块", () => {
    assert.deepEqual(miniBlocks(`const Rich = z.strictObject({ text: z.string(), marks: z.array(z.string()).optional() })`), [])
  })

  check("neg", "反例④ z.object（非 strictObject）不收", () => {
    assert.deepEqual(miniBlocks(`const X = z.object({ ...base("x"), f: z.string() })`), [])
  })

  check("neg", "反例⑤ base 的参数不是字符串字面量 ⇒ 没有 type，不收", () => {
    assert.deepEqual(miniBlocks(`const T = "x"\nconst X = z.strictObject({ ...base(T), f: z.string() })`), [])
  })

  // ── ③ 变异：改东西 ⇒ 生成物跟着变（判据才能红） ───────────────────────
  check("mut", "变异① 改 type literal ⇒ type 变、原块消失、第一批计数跟着变", () => {
    const before = renderBlockCatalog(surfaceFromSource(SRC))
    const after = renderBlockCatalog(surfaceFromSource(SRC.replace('base("paragraph")', 'base("paraGraph")')))
    assert.notEqual(before, after)
    assert.ok(before.includes("| `paragraph` |"))
    assert.ok(!after.includes("| `paragraph` |"))
    assert.match(before, /第一批 4/)
    assert.match(after, /第一批 3/)
    assert.ok(after.includes("未分档 1"))
  })

  check("mut", "变异② 给块加字段 ⇒ 字段列跟着变", () => {
    const before = renderBlockCatalog(surfaceFromSource(SRC))
    const after = renderBlockCatalog(surfaceFromSource(SRC.replace("{ ...base(\"paragraph\"), rich }", "{ ...base(\"paragraph\"), rich, level: z.number() }")))
    assert.notEqual(before, after)
    assert.ok(before.includes("| `paragraph` | `rich` |"))
    assert.ok(after.includes("| `paragraph` | `rich`、`level` |"))
  })

  check("mut", "变异③ 改 CONTAINER_TYPES ⇒ 容器计数与标记跟着变", () => {
    const before = renderBlockCatalog(surfaceFromSource(SRC))
    const after = renderBlockCatalog(surfaceFromSource(SRC.replace('CONTAINER_TYPES = ["toggle"]', 'CONTAINER_TYPES = []')))
    assert.notEqual(before, after)
    assert.match(before, /容器 1/)
    assert.match(after, /容器 0/)
    assert.ok(after.includes("| `toggle` | `title`、`children` | 否 | 否 |"))
  })

  check("mut", "变异④ 改分档词表 ⇒ 词表声明数与分节跟着变", () => {
    const before = renderBlockCatalog(surfaceFromSource(SRC))
    const after = renderBlockCatalog(surfaceFromSource(SRC.replace('A_BASIC_TYPES = ["paragraph", "heading"]', 'A_BASIC_TYPES = ["heading"]')))
    assert.notEqual(before, after)
    assert.match(before, /词表声明 5/)
    assert.match(after, /词表声明 4/)
    assert.ok(after.includes("未分档 1"))
  })

  // ── ④ 真语料：数字是扫出来的，不是抄的 ────────────────────────────────
  check("corpus", "真语料① 28 块 / A9-B7-C12 / 容器 3 / 引用 4 / 第一批 14 / 词表声明 28", () => {
    const s = scanBlockSurface(REPO)
    assert.equal(s.blocks.length, 28)
    assert.deepEqual([s.groups.A.length, s.groups.B.length, s.groups.C.length], [9, 7, 12])
    assert.equal(s.declaredCount, 28)
    assert.equal(s.blocks.length, s.declaredCount, "扫到的块数必须等于词表声明数")
    assert.deepEqual(s.containers, ["columns", "toggle", "syncedBlock"])
    assert.deepEqual(s.references, ["issueRef", "docRef", "view", "syncedBlock"])
    assert.equal(s.firstBatch.length, 14)
  })

  check("corpus", "真语料② 关键块字段与标记（toggle 容器 / syncedBlock 容器兼引用 / docRef 引用）", () => {
    const m = byType(scanBlockSurface(REPO).blocks)
    assert.deepEqual(m.get("paragraph")!.fields, ["rich"])
    assert.deepEqual(m.get("toggle")!.fields, ["title", "children"])
    assert.deepEqual(m.get("syncedBlock")!.fields, ["ref", "children"])
    assert.deepEqual(m.get("divider")!.fields, [])
    assert.equal(m.has("Rich"), false, "共用 schema Rich 不是块")
    const surface = scanBlockSurface(REPO)
    assert.ok(surface.containers.includes(m.get("toggle")!.type))
    assert.ok(surface.containers.includes(m.get("syncedBlock")!.type))
    assert.ok(surface.references.includes(m.get("docRef")!.type))
  })

  check("corpus", "真语料③ 生成物头部自述数字与判据 grep 口径一致", () => {
    const text = buildBlockCatalog(REPO)
    assert.match(text, /共 28 种块 · A 基础 9 \/ B 业务 7 \/ C Notion 12 · 容器 3 · 引用 4 · 第一批 14 · 词表声明 28/)
    assert.ok(text.includes("## A 基础（9 种）"))
    assert.ok(text.includes("## B 业务（7 种）"))
    assert.ok(text.includes("## C Notion 扩展（12 种）"))
    assert.equal((text.match(/\| ✓ \|/g) ?? []).length, 14, "第一批恰好 14 行打勾")
  })

  check("corpus", "真语料④ 28 个 type 全部出现在生成物里（无静默漏抽）", () => {
    const s = scanBlockSurface(REPO)
    const text = buildBlockCatalog(REPO)
    for (const t of [...s.groups.A, ...s.groups.B, ...s.groups.C]) {
      assert.ok(text.includes(`\`${t}\``), `${t} 应在生成物里`)
    }
  })

  check("corpus", "真语料⑤ 幂等：同仓连跑两次逐字节相同（无时间戳）", () => {
    assert.equal(buildBlockCatalog(REPO), buildBlockCatalog(REPO))
  })

  const total = Object.values(tally).reduce((a, b) => a + b, 0)
  if (failures.length) {
    console.error(failures.map((f) => `✗ ${f}`).join("\n"))
    console.error(`✗ gen-block-catalog spec：${pass} 过 / ${failures.length} 失败`)
    return false
  }
  console.log(
    `✓ gen-block-catalog spec 全过：${total} 条（正例 ${tally.pos} / 反例 ${tally.neg} / 变异 ${tally.mut} / 真语料 ${tally.corpus}）` +
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
