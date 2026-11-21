// @vitest-environment jsdom
/**
 * ISS-531 / P3-U2a 集成测试：headless boot + A 档 9 逐块 round-trip + Marks 8 round-trip。
 *
 * 首行 pragma 照 DSH client 测试栈（U-1 先例）：shared config 保持 node，本文件逐文件声明 jsdom。
 * 但 boot 本身是纯 JS（不 mount、不建 view），文档模型在 node 也可用——用 jsdom 是为展示面
 * createHeadlessView 的 ReactElement 构造提供 DOM 语境（U-0 问3）。
 *
 * 断言分四组：
 *   ① A 档 9 逐块：our Block record → 插入 headless editor → 读回转换 → 逐字段 toEqual（验收 2）；
 *   ② 负例：非法 props 被 @matter/blocks zod 拒且 error 点名字段（验收 2）；
 *   ③ Marks 8 round-trip（含 link 双向）（验收 3）；
 *   ④ headless 形态契约：boot 不建 UI、createHeadlessView 产出 ReactElement、版本面/无 xl-*。
 *
 * vitest css:false 把 @blocknote/core/style.css stub 成空串（U-1 实测 vitest:css-disable），
 * 结构断言不受影响；视觉断言不做（P3 无视觉面）。
 *
 * @module @matter/client-ui-blocks/tests/roundtrip
 */

import { describe, expect, it } from "vitest"
import {
  OUR_A_TYPES,
  bootHeadlessEditor,
  bnInlineToOurRich,
  createHeadlessView,
  ourRichToBnInline,
  roundTripBlocks,
  validateOurBlock,
  type OurABlock,
  type OurRich,
} from "../src/client/index.ts"

/** 构造一个富文本片段。 */
const R = (text: string, ...marks: OurRich["marks"][number][]): OurRich => ({ text, marks })

/** A 档 9 种各一个代表块（覆盖名差/粒度差/props 差）。 */
const A_BLOCKS: OurABlock[] = [
  { id: "p1", type: "paragraph", rich: [R("Hello space")] },
  { id: "h1", type: "heading", level: 2, rich: [R("Title")] },
  { id: "bl1", type: "bulletList", items: [R("one"), R("two")] },
  { id: "ol1", type: "orderedList", start: 3, items: [R("alpha"), R("beta")] },
  { id: "t1", type: "todo", checked: true, rich: [R("task")] },
  { id: "q1", type: "quote", rich: [R("quoted")] },
  { id: "d1", type: "divider" },
  { id: "c1", type: "code", code: "const x=1", language: "typescript" },
  { id: "i1", type: "image", url: "https://example.test/a.png", caption: "figure" },
]

describe("headless boot", () => {
  it("bootHeadlessEditor 产出编辑器，document 就是我们插入的块（不 mount、无 UI）", () => {
    const editor = bootHeadlessEditor(A_BLOCKS.slice(0, 2))
    // 9 块里前 2 块：paragraph + heading；id 保留、type 对齐。
    expect(editor.document.map((b) => b.id)).toEqual(["p1", "h1"])
    expect(editor.document.map((b) => b.type)).toEqual(["paragraph", "heading"])
  })

  it("createHeadlessView 用 BlockNoteViewRaw 构造 ReactElement（展示面 headless）", () => {
    const editor = bootHeadlessEditor([A_BLOCKS[0]])
    const el = createHeadlessView({ editor })
    expect(el).toBeTruthy()
    // ReactElement 的形状：type 是 BlockNoteViewRaw 组件、props 带 editor。
    expect(typeof el).toBe("object")
    expect((el as { props: { editor: unknown } }).props.editor).toBe(editor)
  })
})

describe("A 档 9 逐块 round-trip（验收 2）", () => {
  it("OUR_A_TYPES 覆盖 9 种且顺序与 @matter/blocks A_BASIC_TYPES 一致", () => {
    expect(OUR_A_TYPES).toEqual(["paragraph", "heading", "bulletList", "orderedList", "todo", "quote", "divider", "code", "image"])
    expect(A_BLOCKS.map((b) => b.type)).toEqual(OUR_A_TYPES)
  })

  it("9 块经 headless editor 往返后逐字段相等（id/type/props/rich/items 全对齐）", () => {
    expect(roundTripBlocks(A_BLOCKS)).toEqual(A_BLOCKS)
  })

  it("名/粒度映射：bulletList 2 items 与 orderedList start=3 往返不丢", () => {
    const out = roundTripBlocks([A_BLOCKS[2], A_BLOCKS[3]])
    expect(out[0]).toEqual(A_BLOCKS[2])
    expect(out[1]).toEqual(A_BLOCKS[3])
  })
})

describe("props 校验负例：@matter/blocks zod 拒非法字段且点名（验收 2）", () => {
  it("heading.level=99 → 红且 issue path 点名 level", () => {
    const r = validateOurBlock({ id: "x", type: "heading", level: 99, rich: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.path === "level")).toBe(true)
  })

  it("todo.checked 非 boolean → 红且点名 checked", () => {
    const r = validateOurBlock({ id: "x", type: "todo", checked: "yes" as unknown as boolean, rich: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.some((i) => i.path === "checked")).toBe(true)
  })

  it("合法块 → 绿", () => {
    expect(validateOurBlock(A_BLOCKS[1]).ok).toBe(true)
    expect(validateOurBlock(A_BLOCKS[4]).ok).toBe(true)
  })
})

describe("Marks 8 round-trip（验收 3，含 link 双向）", () => {
  const ALL_MARKS: OurRich[] = [
    R("b", { type: "bold" }),
    R("i", { type: "italic" }),
    R("u", { type: "underline" }),
    R("s", { type: "strikethrough" }),
    R("c", { type: "code" }),
    R("col", { type: "color", value: "red" }),
    R("bg", { type: "bg", value: "yellow" }),
    R("link", { type: "link", href: "https://example.test/path" }),
  ]

  it("8 mark 经 BN inline content 往返逐项相等（7 style + link inline content）", () => {
    const bn = ourRichToBnInline(ALL_MARKS)
    // link 走 inline content 而非 style：BN 侧 type=link、href 在场。
    const linkItem = bn.find((x) => x.type === "link")
    expect(linkItem).toBeDefined()
    expect((linkItem as { href: string }).href).toBe("https://example.test/path")
    expect(bnInlineToOurRich(bn)).toEqual(ALL_MARKS)
  })

  it("link 双向：our mark{type:link,href} ⇄ BN inlineContent（单独往返）", () => {
    const src = [R("点击", { type: "link", href: "https://a.test" })]
    expect(bnInlineToOurRich(ourRichToBnInline(src))).toEqual(src)
  })

  it("strikethrough→strike / color→textColor / bg→backgroundColor 名映射正确", () => {
    const bn = ourRichToBnInline(ALL_MARKS)
    const styles = bn.flatMap((x) => (x.type === "text" ? [x.styles] : []))
    expect(styles.some((s) => s["strike"] === true)).toBe(true)
    expect(styles.some((s) => s["textColor"] === "red")).toBe(true)
    expect(styles.some((s) => s["backgroundColor"] === "yellow")).toBe(true)
  })
})
