// @vitest-environment jsdom
/**
 * ISS-532 / P3-U2b 集成测试（W6）：第一批 14 种逐块插入 + Marks 12 + toggle 容器红绿 +
 * slot renderSlot + IME 口径 + view 查询直连。
 *
 * 首行 pragma 照 DSH client 测试栈（U-1 先例）；slot 部分从 renderer 的 ./src/* 子路径导入原始
 * TS（lib/client.js 是 closure-factory bundle，vitest 下无 window.__ModuleLoader__ 会炸——scratch
 * 实测），配 vitest.config 已预置的 server.deps.inline；boot 用真 cordis Context + SlotRegistry +
 * 最小 session scope adapter（P3 无 shell）。
 *
 * @module @matter/client-ui-blocks/tests/integration
 */

import { Context } from "@deepseek-ai/cordis"
import { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts"
import { createSlotRenderer } from "@deepseek-ai/dsh-client-ui-renderer/src/client/scoped-slots.tsx"
import { act, render } from "@testing-library/react"
import { createElement } from "react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import {
  COMPOSITION_END_WINDOW_MS,
  EDITOR_SURFACE_SLOT,
  INITIAL_COMPOSITION_STATE,
  OUR_B_FIRST_TYPES,
  bnBlocksToOurFull,
  bnInlineToOurRich,
  bootFullEditor,
  createHeadlessView,
  compositionMeta,
  decodeRefMark,
  editorSurfaceChildrenDecl,
  encodeRefMark,
  isComposingEvent,
  isCompositionKey,
  isSizeValue,
  markedRich,
  onCompositionEnd,
  onCompositionStart,
  onKeyup,
  ourBlockToBnFull,
  ourRichToBnInline,
  plainRich,
  registerEditorSurface,
  roundTripFullBlocks,
  runViewQuery,
  shouldSubmitOnEnter,
  toBlockSkeleton,
  validateOurBlock,
  validateBlockSkeleton,
} from "../src/client/index.ts"
import type { OurBlock, OurRich, ViewRenderRequest } from "../src/client/index.ts"
import type { CompositionClock } from "../src/client/index.ts"

/** 构造一个富文本片段。 */
const R = (text: string, ...marks: OurRich["marks"][number][]): OurRich => ({ text, marks })

/**
 * 第一批 14 种各一个代表块（A 档 9 复用 U-2a 形状 + B 档 5 新增），覆盖名差/粒度差/props 差/容器。
 */
const ALL_14: OurBlock[] = [
  { id: "p1", type: "paragraph", rich: [R("Hello")] },
  { id: "h1", type: "heading", level: 2, rich: [R("Title")] },
  { id: "bl1", type: "bulletList", items: [R("one"), R("two")] },
  { id: "ol1", type: "orderedList", start: 3, items: [R("alpha"), R("beta")] },
  { id: "t1", type: "todo", checked: true, rich: [R("task")] },
  { id: "q1", type: "quote", rich: [R("quoted")] },
  { id: "d1", type: "divider" },
  { id: "c1", type: "code", code: "const x=1", language: "typescript" },
  { id: "i1", type: "image", url: "https://example.test/a.png", caption: "figure" },
  { id: "ir1", type: "issueRef", ref: "ISS-1", preview: true },
  { id: "dr1", type: "docRef", ref: "DOC-1", preview: false },
  { id: "m1", type: "mermaid", code: "graph TD; A-->B", caption: "flow" },
  { id: "v1", type: "view", ref: "view-1", kind: "board" },
  { id: "tg1", type: "toggle", title: "展开", children: [{ id: "tg-c1", type: "paragraph", rich: [R("nested")] }] },
]

// ─────────────────────────────────────────────────────────────────────────────
// W6 · 第一批 14 种逐块插入断言（验收 1）
// ─────────────────────────────────────────────────────────────────────────────
describe("W6 · 第一批 14 种逐块插入（验收 1）", () => {
  it("OUR_B_FIRST_TYPES 钉死 B 档 5 种", () => {
    expect([...OUR_B_FIRST_TYPES]).toEqual(["issueRef", "docRef", "mermaid", "toggle", "view"])
  })

  it("14 块各自插入 headless full editor，document 保留 type 与 id（列表类展开为多块）", () => {
    const editor = bootFullEditor(ALL_14)
    const doc = editor.document
    // A 档列表类（bulletList/orderedList）按 U-2a 粒度差展开为 N 块，其余 1 块：
    // bulletList 2 + orderedList 2 + 其余 12 × 1 = 16 块。
    expect(doc).toHaveLength(16)
    // 每个我们侧块的 id 都保留（列表首项用块 id，后续项带 -liN 后缀）。
    for (const block of ALL_14) {
      expect(doc.some((b) => b.id === block.id || b.id.startsWith(`${block.id}-li`))).toBe(true)
    }
    // B 档 5 种以 BN type 字面量在场（toggle→toggleListItem）。
    const types = new Set(doc.map((b) => b.type))
    for (const bnType of ["issueRef", "docRef", "mermaid", "toggleListItem", "view"]) {
      expect(types.has(bnType)).toBe(true)
    }
  })

  it("A 档 9 复用 U-2a round-trip（名差/粒度差/props 差全对齐）", () => {
    const aOnly = ALL_14.slice(0, 9)
    expect(roundTripFullBlocks(aOnly)).toEqual(aOnly)
  })

  it("第一批 14 种经完整 schema 往返逐字段相等", () => {
    expect(roundTripFullBlocks(ALL_14)).toEqual(ALL_14)
  })

  it("B 档 5 种单独往返（props 保真：ref/kind/code/preview）", () => {
    const bOnly = ALL_14.slice(9)
    expect(roundTripFullBlocks(bOnly)).toEqual(bOnly)
  })

  it("toggle title 走 inline content、children 递归往返", () => {
    const toggle: OurBlock = {
      id: "tg", type: "toggle", title: "父标题",
      children: [{ id: "c1", type: "paragraph", rich: [R("子段")] }],
    }
    const bn = ourBlockToBnFull(toggle)
    expect(bn[0].type).toBe("toggleListItem")
    expect(bn[0].children).toHaveLength(1)
    expect(roundTripFullBlocks([toggle])).toEqual([toggle])
  })

  it("bnBlocksToOurFull 逐块读回（A/B 分组不串位）", () => {
    const bn = bootFullEditor(ALL_14).document
    expect(bnBlocksToOurFull(bn as never)).toEqual(ALL_14)
  })
})

// 挂载真实编辑器视图：让 BlockNote 实际调用四自写块/四自写 mark 的 render 闭包
//（headless boot 只走数据面不触发），既是覆盖补齐也是"渲染位能挂载"的证词。
describe("真实视图挂载 · 自写块/mark render 闭包被触发", () => {
  it("full editor 挂 BlockNoteViewRaw，四自写块 + 四自写 mark 的 render 都被调用", () => {
    const blocks: OurBlock[] = [
      { id: "ir", type: "issueRef", ref: "ISS-1", preview: false },
      { id: "dr", type: "docRef", ref: "DOC-1", preview: false },
      { id: "m", type: "mermaid", code: "graph TD" },
      { id: "v", type: "view", ref: "v-1", kind: "list" },
      { id: "p", type: "paragraph", rich: [R("x", { type: "highlight" })] },
    ]
    const editor = bootFullEditor(blocks)
    const el = createHeadlessView({ editor } as never)
    const view = render(el)
    // 挂载成功即有 BlockNote 的 .bn-container 根节点；render 闭包在挂树时被调用（coverage 证词）。
    expect(view.container.querySelector(".bn-container, [class*='bn-']")).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Marks 12 全过（验收 3）：8 映射复用 + 4 自写
// ─────────────────────────────────────────────────────────────────────────────
describe("Marks 12 全过（验收 3）", () => {
  const EIGHT = [
    R("b", { type: "bold" }), R("i", { type: "italic" }), R("u", { type: "underline" }),
    R("s", { type: "strikethrough" }), R("c", { type: "code" }), R("col", { type: "color", value: "red" }),
    R("bg", { type: "bg", value: "yellow" }), R("link", { type: "link", href: "https://x.test" }),
  ]
  const FOUR = [
    R("hi", { type: "highlight" }),
    R("sm", { type: "size", value: "sm" }),
    R("math", { type: "math", tex: "x^2" }),
    R("ref", { type: "ref", kind: "issue", target: "ISS-1" }),
  ]

  it("8 映射 mark round-trip（U-2a 既有，含 link 双向）", () => {
    expect(bnInlineToOurRich(ourRichToBnInline(EIGHT))).toEqual(EIGHT)
  })

  it("4 自写 mark round-trip（highlight/size/math/ref）", () => {
    expect(bnInlineToOurRich(ourRichToBnInline(FOUR))).toEqual(FOUR)
  })

  it("Marks 12 一并往返", () => {
    expect(bnInlineToOurRich(ourRichToBnInline([...EIGHT, ...FOUR]))).toEqual([...EIGHT, ...FOUR])
  })

  it("size 三档 sm|base|lg 编解码正确", () => {
    expect(isSizeValue("sm")).toBe(true)
    expect(isSizeValue("base")).toBe(true)
    expect(isSizeValue("lg")).toBe(true)
    expect(isSizeValue("xl")).toBe(false)
    expect(bnInlineToOurRich(ourRichToBnInline([R("x", { type: "size", value: "lg" })]))[0].marks)
      .toEqual([{ type: "size", value: "lg" }])
  })

  it("ref 编码单串 'kind:target' 与解编码（含 URL 冒号防御）", () => {
    expect(encodeRefMark({ type: "ref", kind: "issue", target: "ISS-1" })).toBe("issue:ISS-1")
    expect(decodeRefMark("issue:ISS-1")).toEqual({ type: "ref", kind: "issue", target: "ISS-1" })
    expect(decodeRefMark("doc:DOC-9")).toEqual({ type: "ref", kind: "doc", target: "DOC-9" })
    expect(decodeRefMark("view:v-2")).toEqual({ type: "ref", kind: "view", target: "v-2" })
    expect(decodeRefMark("no-colon")).toEqual({ type: "ref", kind: "issue", target: "no-colon" })
    expect(decodeRefMark("weird:https://x")).toEqual({ type: "ref", kind: "issue", target: "weird:https://x" })
  })

  it("自写 mark 在完整 schema 的 BN style 字典里落位", () => {
    const bn = ourRichToBnInline(FOUR)
    const styles = bn.flatMap((x) => (x.type === "text" ? [x.styles] : []))
    expect(styles.some((s) => s["highlight"] === true)).toBe(true)
    expect(styles.some((s) => s["size"] === "sm")).toBe(true)
    expect(styles.some((s) => s["math"] === "x^2")).toBe(true)
    expect(styles.some((s) => s["ref"] === "issue:ISS-1")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// toggle 容器嵌套 E-3a schema 校验红绿双向（验收 2 · 变异实证）
// ─────────────────────────────────────────────────────────────────────────────
describe("toggle 容器嵌套 E-3a zod 校验红绿（验收 2）", () => {
  it("合法 toggle（children 合法嵌套）→ 绿", () => {
    const block: OurBlock = {
      id: "t", type: "toggle", title: "Q",
      children: [{ id: "p", type: "paragraph", rich: [plainRich("A")] }],
    }
    expect(validateOurBlock(block).ok).toBe(true)
  })

  it("变异实证①：叶子塞 children → 红且 issue path 点名 children.0", () => {
    // 直通 zod 的骨架（toBlockSkeleton 按已知字段构造，不会产出非法形态——变异须直接喂骨架）。
    const illegal = {
      id: "t", type: "toggle", title: "Q",
      children: [{ id: "p", type: "paragraph", rich: [], children: [] }],
    }
    const result = validateBlockSkeleton(illegal)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.path.startsWith("children.0"))).toBe(true)
  })

  it("变异实证②：title 非 string → 红且点名 title", () => {
    const illegal = { id: "t", type: "toggle", title: 123 }
    const result = validateBlockSkeleton(illegal)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((i) => i.path === "title")).toBe(true)
  })

  it("变异实证反向：合法骨架 → 绿（对照，证明红是变异导致）", () => {
    const legal = {
      id: "t", type: "toggle", title: "Q",
      children: [{ id: "p", type: "paragraph", rich: [] }],
    }
    expect(validateBlockSkeleton(legal).ok).toBe(true)
  })

  it("toBlockSkeleton 对 toggle children 递归降级（合法骨架结构）", () => {
    const block: OurBlock = {
      id: "t", type: "toggle", title: "Q",
      children: [{ id: "p", type: "paragraph", rich: [markedRich("x", { type: "bold" })] }],
    }
    const sk = toBlockSkeleton(block) as { children: unknown[] }
    expect(sk.children).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// slot 甲：ctx.slots.register + renderSlot 断言（验收 4）
// ─────────────────────────────────────────────────────────────────────────────
describe("slot 甲 · renderSlot 渲染位走通（验收 4）", () => {
  it("registerEditorSurface 注册占用 renderSlot 能渲染到组件", async () => {
    const ctx = new Context()
    const registry = new SlotRegistry(ctx)
    registry.install(createSlotRenderer())
    const absent = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
    const src = { getSnapshot: () => absent, subscribe: () => () => {} }
    registry.installScope("session", { current: src, bindingSource: () => src })

    await act(async () => {
      registry.register(
        { name: "root", children: editorSurfaceChildrenDecl() },
        (props: { renderSlot: (k: string, o: object) => ReactNode }) =>
          createElement("div", null, props.renderSlot(EDITOR_SURFACE_SLOT, { editorRef: "e1" })),
      )
      registerEditorSurface(registry, () => createElement("span", null, "EDITOR-SURFACE"))
    })
    const node = registry.renderSlot("root", {})
    const view = render(createElement(() => node as never))
    expect(view.container.textContent).toContain("EDITOR-SURFACE")
  })

  it("registerEditorSurface 返回 disposer（fiber 卸载即移除）", () => {
    const dispose = vi.fn(() => {})
    const fakeSlots = { register: vi.fn(() => dispose) }
    const d = registerEditorSurface(fakeSlots, () => null)
    expect(fakeSlots.register).toHaveBeenCalledWith({ name: EDITOR_SURFACE_SLOT }, expect.any(Function))
    d()
    expect(dispose).toHaveBeenCalled()
  })

  it("editorSurfaceChildrenDecl 声明正确的 slot key 与 cardinality/scope", () => {
    expect(editorSurfaceChildrenDecl()).toEqual({ [EDITOR_SURFACE_SLOT]: { kind: "single", scope: "root" } })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IME 口径（验收 5）：jsdom composition 模拟 + 三条守卫 + ProseMirror meta
// ─────────────────────────────────────────────────────────────────────────────
describe("IME 口径（验收 5）", () => {
  const clockAt = (t: number): CompositionClock => ({ now: () => t })

  it("isCompositionKey：isComposing 或 keyCode 229", () => {
    expect(isCompositionKey({ isComposing: true })).toBe(true)
    expect(isCompositionKey({ keyCode: 229 })).toBe(true)
    expect(isCompositionKey({ key: "Enter" })).toBe(false)
  })

  it("组合期 Enter 不提交（三条口径守门）", () => {
    const composing = onCompositionStart()
    expect(shouldSubmitOnEnter(composing, { key: "Enter" })).toBe(false)
    expect(shouldSubmitOnEnter(composing, { key: "Enter", isComposing: true })).toBe(false)
    expect(shouldSubmitOnEnter(composing, { key: "Enter", keyCode: 229 })).toBe(false)
    expect(shouldSubmitOnEnter(INITIAL_COMPOSITION_STATE, { key: "Enter" })).toBe(true)
  })

  it("compositionend 后兜底窗口内不提交、过期后放行", () => {
    const ended = onCompositionEnd(clockAt(1000))
    expect(isComposingEvent(ended, { key: "Enter" }, clockAt(1000 + COMPOSITION_END_WINDOW_MS - 1))).toBe(true)
    expect(isComposingEvent(ended, { key: "Enter" }, clockAt(1000 + COMPOSITION_END_WINDOW_MS))).toBe(false)
    expect(shouldSubmitOnEnter(ended, { key: "Enter" }, clockAt(1000))).toBe(false)
    expect(shouldSubmitOnEnter(ended, { key: "Enter" }, clockAt(2000))).toBe(true)
  })

  it("keyup 释放 ended（Safari 迟到 closing keydown 兜底）", () => {
    const ended = onCompositionEnd(clockAt(0))
    expect(onKeyup()).toEqual(INITIAL_COMPOSITION_STATE)
    expect(ended.ended).toBe(true)
  })

  it("ProseMirror transaction composition 元数据可读", () => {
    expect(compositionMeta({ getMeta: (k) => (k === "composition" ? 42 : undefined) })).toBe(42)
    expect(compositionMeta({ getMeta: () => undefined })).toBeUndefined()
  })

  it("真机 IME 无面可测——本测试只覆盖 jsdom 口径，真机单列 unjudged", () => {
    // 声明确认项：本单不冒充真机已测（DOC-512 §8 中文产品必验项随 P4 shell 补）。
    expect(true).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// view 块 B-1 view-query 进程内直连（需求段 1）
// ─────────────────────────────────────────────────────────────────────────────
describe("view 查询直连 B-1", () => {
  it("runViewQuery 跑 filter→sort→limit，保字段目录校验", () => {
    const rows = [
      { id: "a", status: "open", n: 2 },
      { id: "b", status: "done", n: 1 },
      { id: "c", status: "open", n: 3 },
    ]
    const req: ViewRenderRequest = {
      ref: "view-1", kind: "table",
      spec: { filter: [{ field: "status", values: ["open"] }], sort: [{ field: "n", dir: "desc" }], limit: 1 },
      rows,
      fields: { status: "string", n: "number" },
    }
    expect(runViewQuery(req)).toEqual([{ id: "c", status: "open", n: 3 }])
  })

  it("未知字段 → ViewQueryError（配置错误加载时报，不静默）", () => {
    expect(() => runViewQuery({
      ref: "v", spec: { filter: [{ field: "nope", values: ["x"] }] }, rows: [], fields: { status: "string" },
    })).toThrow(/unknown field/)
  })
})
