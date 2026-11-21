// @vitest-environment jsdom
/**
 * ui-kb 设计态边界覆盖（ISS-544 / P5-D1）：补齐 coverage 100 的剩余分支。
 *
 * 覆盖：
 *  · DocList 空列表（emptyHint 分支）+ 状态五组合 data-* + density 变体；
 *  · DocDetail 卸载后异步返回（alive=false 清理分支）；
 *  · documents-port 的 rich/text 非典型形态、list 失败、notFound 非对象错误分支
 *    —— 这些是 ui-kb 提到 100 档后必须覆盖的既有缺口（非本单新引入，但同包内一并补齐）。
 *
 * @module @matter/client-ui-kb/tests/design-state
 */

import { Context } from "@deepseek-ai/cordis"
import { act, render } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { DocDetail, DocList, resolveMessages } from "../src/client/index.ts"
import { createRemoteDocumentsPort } from "../src/client/port/documents.ts"

const messages = resolveMessages()

afterEach(() => {
  document.body.innerHTML = ""
})

describe("DocList 设计态", () => {
  it("空列表渲染 emptyHint（覆盖 rows.length === 0 分支）", () => {
    const view = render(createElement(DocList, { rows: [], onOpen: () => {}, messages }))
    expect(view.container.querySelector("[data-ui-kb='list-empty']")?.textContent).toBe(messages.emptyHint)
    expect(view.container.querySelector("[data-ui-kb='list']")).toBeNull()
  })

  it("状态五组合 + density 变体落到 data-* 与 class", () => {
    const rows = [
      { id: "A", title: "甲" },
      { id: "B", title: "乙" },
    ]
    const view = render(createElement(DocList, {
      rows,
      onOpen: () => {},
      messages,
      selectedId: "A",
      density: "compact",
      disabledIds: new Set(["B"]),
      expandedId: "A",
      menuOpenId: "A",
      className: "owner-override",
    }))
    const ul = view.container.querySelector("[data-ui-kb='list']") as HTMLElement
    expect(ul.getAttribute("data-density")).toBe("compact")
    expect(ul.className).toContain("owner-override")

    const [a, b] = Array.from(view.container.querySelectorAll("li[data-doc-id]"))
    expect(a?.getAttribute("data-selected")).toBe("true")
    expect(a?.getAttribute("data-expanded")).toBe("true")
    expect(a?.getAttribute("data-menu-open")).toBe("true")
    expect(a?.querySelector("button")?.disabled).toBe(false)
    expect(b?.getAttribute("data-disabled")).toBe("true")
    expect((b?.querySelector("button") as HTMLButtonElement)?.disabled).toBe(true)
    expect(b?.getAttribute("data-selected")).toBe("false")
  })
})

describe("DocDetail 清理分支", () => {
  it("卸载后 loadDoc 才 resolve → alive=false，不 setState（不抛）", async () => {
    let resolveDoc!: (value: { id: string; title: string; blocks: [] }) => void
    const deferred = new Promise<{ id: string; title: string; blocks: [] }>((res) => { resolveDoc = res })
    const renderSurface = () => null
    const view = render(createElement(DocDetail, {
      docId: "D",
      loadDoc: () => deferred,
      renderSurface,
      messages,
    }))
    // 先卸载，再让 Promise resolve —— 走 alive=false 分支。
    view.unmount()
    await act(async () => {
      resolveDoc({ id: "D", title: "迟到的文档", blocks: [] })
      await deferred
    })
  })
})

describe("documents-port 边界分支（提 100 档补齐既有缺口）", () => {
  function ctxWith(getDoc: () => Promise<unknown>, listDoc?: () => Promise<unknown>): Context {
    const ctx = new Context()
    Reflect.set(ctx, "remote", {
      document: {
        async list() { return listDoc ? listDoc() : { ok: true, value: { items: [] } } },
        async get() { return getDoc() },
      },
    })
    return ctx
  }

  it("block 的 rich/text 非典型形态：text 非字符串 + rich 真数组 → 走 rich 归并", async () => {
    const ctx = ctxWith(async () => ({
      ok: true,
      value: {
        record: {
          props: { id: "D", title: "T" },
          // text 是非字符串（覆盖 typeof text === string 的 false 分支），rich 是真数组
          blocks: [{ id: "b", type: "p", text: 123, rich: [{ text: "甲" }, { text: "乙" }] }],
        },
      },
    }))
    const doc = await createRemoteDocumentsPort(ctx).get("D")
    expect(doc?.blocks[0]?.text).toBe("甲乙")
  })

  it("block 缺 id/type → 走 ?? 默认值分支", async () => {
    const ctx = ctxWith(async () => ({
      ok: true,
      value: {
        record: {
          props: { id: "D", title: "T" },
          blocks: [{ rich: [{ text: "甲" }] }],
        },
      },
    }))
    const doc = await createRemoteDocumentsPort(ctx).get("D")
    expect(doc?.blocks[0]?.id).toBe("")
    expect(doc?.blocks[0]?.type).toBe("paragraph")
  })

  it("list 返回 ok:false → 抛 result.error（覆盖 list 失败分支）", async () => {
    const ctx = ctxWith(async () => ({ ok: false, error: new Error("unused") }), async () => ({ ok: false, error: new Error("list boom") }))
    await expect(createRemoteDocumentsPort(ctx).list()).rejects.toThrow("list boom")
  })

  it("get 返回 ok:false 且 error 为 null → notFound 非对象分支 → 抛出（不吞）", async () => {
    const ctx = ctxWith(async () => ({ ok: false, error: null }))
    await expect(createRemoteDocumentsPort(ctx).get("X")).rejects.toBeNull()
  })

  it("get 返回 ok:false 且 error.code 含 not-found（非精确）→ 归一 undefined", async () => {
    const ctx = ctxWith(async () => ({ ok: false, error: { code: "gateway.document-not-found" } }))
    await expect(createRemoteDocumentsPort(ctx).get("X")).resolves.toBeUndefined()
  })
})
