// @vitest-environment jsdom
/**
 * /editor-demo 真编辑器夹具验收（ISS-538 / P4-S2 · 验收 A1）。
 *
 * 断言四件实质（非 stub）：
 *   ① `bootFullEditor` 产出真 BlockNote 实例，初始文档含中文默认内容；
 *   ② 14 块工具条按钮在（type 覆盖 A 档 9 + B 档 5）；
 *   ③ 点插入按钮经 `editor.insertBlocks` 真插一块 → document 快照增长且含新块 type；
 *   ④ headless view 渲染出 BlockNote DOM（.bn-container / [class*=bn-]）+ CSS 注入。
 *
 * @module apps/web/tests/editor-demo
 */

import { act, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEMO_BLOCK_TYPES,
  EditorDemoComponent,
  initialDemoBlocks,
  insertBlockInto,
  makeDemoBlock,
  mountEditorDemo,
  readDocument,
  renderEditorDemo,
} from "../src/editor-demo.tsx"
import { bootFullEditor, createHeadlessView } from "@matter/client-ui-blocks/client"
import { BN_CORE_STYLE_ID } from "../src/editor-css.ts"
import type { EditorDemoHandle } from "../src/editor-demo.tsx"

/** mount 形态的句柄，逐用例清理。 */
let handle: EditorDemoHandle | undefined
afterEach(async () => {
  if (handle !== undefined) {
    await handle.dispose()
    handle = undefined
  }
  document.head.innerHTML = ""
  document.body.innerHTML = ""
})

describe("/editor-demo 真编辑器夹具（A1）", () => {
  it("14 块词表 = ui-blocks A 档 9 + B 档 5，无缺无重", () => {
    expect(DEMO_BLOCK_TYPES).toHaveLength(14)
    expect(new Set(DEMO_BLOCK_TYPES).size).toBe(14)
    expect(DEMO_BLOCK_TYPES).toEqual([
      "paragraph", "heading", "bulletList", "orderedList", "todo", "quote", "divider", "code", "image",
      "issueRef", "docRef", "mermaid", "toggle", "view",
    ])
  })

  it("bootFullEditor 产真实例：初始文档含中文默认内容，14 种块都能构造", () => {
    const editor = bootFullEditor(initialDemoBlocks())
    expect(editor.document.length).toBeGreaterThan(0)
    const doc = readDocument(editor)
    // 中文默认态：标题/正文/待办/toggle 的文本真在文档里。
    expect(JSON.stringify(doc)).toContain("中文")
    for (const type of DEMO_BLOCK_TYPES) {
      const block = makeDemoBlock(type, 1)
      expect(block.type).toBe(type)
    }
  })

  it("工具条渲染 14 个按钮，data-insert 覆盖全部 14 种 type", () => {
    const editor = bootFullEditor(initialDemoBlocks())
    const view = render(renderEditorDemo(editor, () => {}))
    const buttons = view.container.querySelectorAll("button[data-insert]")
    expect(buttons.length).toBe(14)
    const attrs = Array.from(buttons).map((b) => b.getAttribute("data-insert"))
    expect(new Set(attrs)).toEqual(new Set(DEMO_BLOCK_TYPES))
    expect(view.container.querySelector("[data-demo='surface']")).not.toBeNull()
  })

  it("点插入按钮经 insertBlocks 真插块：document 增长且含新 type", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const editor = bootFullEditor(initialDemoBlocks())
    const before = readDocument(editor).length
    let view: ReturnType<typeof render> | undefined
    const btnFor = (type: string) => { insertBlockInto(editor, type, 9) }
    view = render(renderEditorDemo(editor, btnFor))
    const viewRef = view
    act(() => {
      viewRef.container.querySelector("button[data-insert='issueRef']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    const after = readDocument(editor)
    expect(after.length).toBeGreaterThan(before)
    expect(after.some((b) => b.type === "issueRef")).toBe(true)
  })

  it("headless view 渲染 BlockNote DOM + CSS 注入（非 stub 视觉面）", async () => {
    const editor = bootFullEditor(initialDemoBlocks())
    const el = createHeadlessView({ editor, editable: true })
    const view = render(el as never)
    expect(view.container.querySelector(".bn-container")).not.toBeNull()
    expect(view.container.querySelector("[class*='bn-']")).not.toBeNull()

    const root = document.createElement("div")
    document.body.append(root)
    handle = await mountEditorDemo(root)
    expect(document.head.querySelector(`style[data-plugin='${BN_CORE_STYLE_ID}']`)).not.toBeNull()
  })

  it("mountEditorDemo 句柄：insert 真增文档、dispose 清样式", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const changes: number[] = []
    handle = await mountEditorDemo(root, { onDocumentChange: (blocks) => changes.push(blocks.length) })
    const before = handle.document().length
    const after = handle.insert("toggle")
    expect(after.length).toBeGreaterThan(before)
    expect(after.some((b) => b.type === "toggle")).toBe(true)
    expect(changes.length).toBeGreaterThanOrEqual(2)
    const toDispose = handle
    handle = undefined
    await toDispose.dispose()
    expect(root.querySelector("[data-demo='editor-demo']")).toBeNull()
    expect(document.head.querySelector(`style[data-plugin='${BN_CORE_STYLE_ID}']`)).toBeNull()
  })

  it("EditorDemoComponent 组件形态可直接 render（夹具标题 + 14 按钮 + 中文正文）", () => {
    let docSnapshot: ReturnType<typeof readDocument> = []
    const view = render(createElement(EditorDemoComponent, { onDocumentChange: (b) => { docSnapshot = b } }))
    expect(view.container.querySelector("[data-demo='title']")?.textContent).toContain("编辑器夹具")
    expect(view.container.querySelectorAll("button[data-insert]").length).toBe(14)
    expect(view.container.querySelector(".bn-container, [class*='bn-']")).not.toBeNull()
    expect(JSON.stringify(docSnapshot)).toContain("中文")
  })
})
