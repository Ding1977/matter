// @vitest-environment jsdom
/**
 * kb 三步流验收（ISS-538 / P4-S2 · 验收 A2）：列表 → 打开文档 → 正文渲染。
 *
 * ISS-537 骨架只渲染 DocList + data 属性；这里断言三步走全：
 *   ① 列表渲染 stub 文档行；② 点行设 active（DocDetail 出现 + onOpen 上报）；
 *   ③ 正文经 renderSurface 用真 BlockNote headless view 渲染，正文中文真现 DOM。
 *
 * @module apps/web/tests/kb-flow
 */

import { act, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { KbShell, STUB_DOCS, stubLoadDoc, stubRenderSurface } from "../src/kb-shell.tsx"
import { EDITOR_SURFACE_SLOT } from "@matter/client-ui-kb/client"

afterEach(() => {
  document.head.innerHTML = ""
  document.body.innerHTML = ""
})

describe("kb 三步流（A2）", () => {
  it("stubLoadDoc / stubRenderSurface 契约：按 id 取详情、按 slot 渲染真正文", () => {
    const load = stubLoadDoc()
    const detail = load("DOC-STUB-1")
    expect(detail?.id).toBe("DOC-STUB-1")
    expect(detail?.title).toBe("欢迎使用 Matter 浏览器壳")
    expect(detail?.blocks.length).toBeGreaterThan(0)
    expect(load("NOT-EXIST")).toBeUndefined()

    const surface = stubRenderSurface()
    const el = surface(EDITOR_SURFACE_SLOT, { editorRef: "DOC-STUB-1" })
    expect(el).not.toBeNull()
    expect(surface("other.slot" as never, { editorRef: "DOC-STUB-1" })).toBeNull()
    expect(surface(EDITOR_SURFACE_SLOT, { editorRef: "NOT-EXIST" })).toBeNull()
  })

  it("列表 → 点行打开 → 正文真现 DOM（三步闭环）", async () => {
    const opened: string[] = []
    const view = render(createElement(KbShell, { onOpen: (id) => opened.push(id) }))

    // ① 列表：两行标题在 DOM。
    expect(view.container.querySelector("[data-ui-kb='list']")).not.toBeNull()
    for (const doc of STUB_DOCS) {
      expect(view.container.textContent).toContain(doc.row.title)
    }
    // 打开前无详情。
    expect(view.container.querySelector("[data-ui-kb='detail']")).toBeNull()

    // ② 点第一行 → onOpen 上报 + DocDetail 出现。
    const firstBtn = view.container.querySelector("[data-ui-kb='list'] button") as HTMLButtonElement
    act(() => {
      firstBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(opened).toEqual(["DOC-STUB-1"])
    expect(view.container.querySelector("[data-ui-kb='detail']")).not.toBeNull()

    // DocDetail 经 useEffect + Promise.resolve(loadDoc) 异步设 doc，flush 微任务。
    await act(async () => { await Promise.resolve() })

    // ③ 正文：BlockNote headless view 真渲染（.bn- 容器 + 正文中文 + doc-body 包裹）。
    expect(view.container.querySelector("[data-demo='doc-body']")).not.toBeNull()
    expect(view.container.querySelector(".bn-container, [class*='bn-']")).not.toBeNull()
    expect(view.container.textContent).toContain("正文块已渲染")
  })

  it("嵌入/样式：Ctrl CSS 注入，详情打开后 BlockNote CSS 在 head", () => {
    const view = render(createElement(KbShell))
    const btn = view.container.querySelector("[data-ui-kb='list'] button") as HTMLButtonElement
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(document.head.querySelector("style[data-plugin='blocknote-core']")).not.toBeNull()
  })
})
