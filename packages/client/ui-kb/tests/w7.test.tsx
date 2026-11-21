// @vitest-environment jsdom
/**
 * W7 灵魂验收（ISS-533）：ui-blocks 的第一个真实消费者。
 *
 * vitest 内 boot cordis Context → install document-controller（真 controller，走 ctx.documents）
 * → slots 注册 ui-blocks 的 `blocks.editor.surface` 渲染位 → @testing-library render ui-kb 详情
 * ⇒ **DOM 断言正文块真实出现**（不是纯函数断言）。
 *
 * 三步装配对应三层角色：behavior（数据）走 controller/ctx 注入；UI 跨包只走 slot
 * （ui-kb 源码零 import ui-blocks，本测试才 import 它注册渲染位）。
 *
 * @module @matter/client-ui-kb/tests/w7
 */

import { Context } from "@deepseek-ai/cordis"
import { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts"
import { createSlotRenderer } from "@deepseek-ai/dsh-client-ui-renderer/src/client/scoped-slots.tsx"
import { act, render } from "@testing-library/react"
import { createElement } from "react"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"
import {
  EDITOR_SURFACE_SLOT as BLOCKS_SURFACE_SLOT,
  bootFullEditor,
  createHeadlessView,
  editorSurfaceChildrenDecl,
  registerEditorSurface,
} from "@matter/client-ui-blocks/client"
import { DocumentController } from "@matter/document-controller"
import type { DocRecord } from "@matter/document"
import {
  DocDetail,
  DocList,
  EDITOR_SURFACE_SLOT,
  resolveMessages,
  type SurfaceRenderer,
} from "../src/client/index.ts"
import * as hostEntry from "../src/index.ts"

/** 一条正文里带可辨识文本的 doc（DOM 断言的锚）。 */
const W7_BODY = "W7-正文块已真实渲染"
const doc: DocRecord = {
  props: {
    id: "DOC-W7",
    title: "W7 文档",
    author: "tester",
    created: "2026-11-20T00:00:00+08:00",
    updated: "2026-11-20T00:00:00+08:00",
  },
  blocks: [{ id: "w7-b1", type: "paragraph", rich: [{ text: W7_BODY, marks: [] }] }],
}

/** 起一个装好 controller + documents 的 cordis context。 */
function bootContext(): { ctx: Context; controller: DocumentController } {
  const ctx = new Context()
  const map = new Map<string, DocRecord>([[doc.props.id, doc]])
  // @ts-expect-error —— 测试最小注入：controller 只读 entries/get/update
  ctx.provide("documents", {
    entries: () => map.entries(),
    get: (id: string) => map.get(id),
    update: async (id: string, patch: { props?: object; blocks?: DocRecord["blocks"] }) => {
      const cur = map.get(id)!
      const next = { props: { ...cur.props, ...patch.props }, blocks: patch.blocks ?? cur.blocks } as DocRecord
      map.set(id, next)
      return next
    },
  })
  const controller = new DocumentController(ctx) // Service 基类自动注册到 ctx.document
  return { ctx, controller }
}

/** 起 slot registry（照 ui-blocks integration.test 的 boot：renderer 原始 TS + session scope adapter）。 */
function bootSlots(ctx: Context): SlotRegistry {
  const registry = new SlotRegistry(ctx)
  registry.install(createSlotRenderer())
  const absent = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
  const src = { getSnapshot: () => absent, subscribe: () => () => {} }
  registry.installScope("session", { current: src, bindingSource: () => src })
  return registry
}

describe("W7 · ui-kb 详情经 slot 真实渲染 doc 正文", () => {
  it("controller + ctx.documents + slots + testing-library ⇒ 正文块出现在 DOM", async () => {
    const { ctx, controller } = bootContext()
    const registry = bootSlots(ctx)

    const loadDoc = (id: string) => {
      const record = ctx.document.get({ id }).record
      return {
        id: record.props.id,
        title: record.props.title,
        blocks: record.blocks.map((b) => ({
          id: b.id,
          type: b.type,
          text: "rich" in b && Array.isArray(b.rich) ? b.rich.map((r) => ("text" in r ? String(r.text) : "")).join("") : "",
        })),
      }
    }

    // DSH slot 语义（slots.md:25）：ctx 级 renderSlot 只渲染 root，所有后代经「声明它的组件的
    // renderSlot prop」渲染。故 root 占用组件拿到 props.renderSlot（子槽面），把它作为
    // `renderSurface` 传给 ui-kb detail —— 这就是 UI 跨包的真实通道，不是 ctx.renderSlot。
    await act(async () => {
      registry.register(
        { name: "root", children: editorSurfaceChildrenDecl() },
        (props: { renderSlot: (k: string, o: object) => ReactNode }) =>
          createElement(DocDetail, {
            docId: "DOC-W7",
            loadDoc,
            renderSurface: props.renderSlot as SurfaceRenderer,
            messages: resolveMessages(),
          }),
      )
      // 真正的 ui-blocks 渲染位占用：从 controller.get 取 doc，交给 BlockNote headless view。
      registerEditorSurface(registry, ({ editorRef }: { editorRef: string }) => {
        const record = controller.get({ id: editorRef }).record
        const editor = bootFullEditor(record.blocks as never)
        return createHeadlessView({ editor, editable: false } as never)
      })
    })

    const node = registry.renderSlot("root", {})
    const view = render(createElement(() => node as never))

    // 灵魂断言：正文文本真实出现在渲染出的 DOM 里（不是抽象函数返回值得分）。
    await act(async () => { await Promise.resolve() })
    expect(view.container.textContent).toContain(W7_BODY)
    expect(view.container.querySelector("[data-ui-kb='body']")).not.toBeNull()
    expect(view.container.querySelector(".bn-container, [class*='bn-']")).not.toBeNull()
    // slot key 两侧一致（ui-blocks owner 与 ui-kb 消费方用同一个字面量）
    expect(EDITOR_SURFACE_SLOT).toBe(BLOCKS_SURFACE_SLOT)
    // 卸载触发 useEffect cleanup（alive=false 分支），覆盖详情的清理路径
    view.unmount()
  })

  it("同一 context 的 doc 列表把标题渲染成可点击行（列表+详情闭环）", () => {
    const { ctx } = bootContext()
    const opened: string[] = []
    const view = render(createElement(DocList, {
      // 含一条空标题行，覆盖 untitled 占位分支（client 域 80% 要求）
      rows: [...ctx.documents.entries()].map(([id, r]) => ({ id, title: r.props.title })).concat([{ id: "NO-TITLE", title: "" }]),
      onOpen: (id) => opened.push(id),
      messages: resolveMessages(),
    }))
    expect(view.container.textContent).toContain("W7 文档")
    expect(view.container.textContent).toContain(resolveMessages().untitled)
    view.container.querySelector("button")?.click()
    expect(opened).toEqual(["DOC-W7"])
  })

  it("host 半空注册插件：可加载、不改 context", () => {
    const { ctx, name, apply } = hostEntry
    expect(name).toBe("client-ui-kb")
    expect(() => apply(ctx)).not.toThrow()
  })
})
