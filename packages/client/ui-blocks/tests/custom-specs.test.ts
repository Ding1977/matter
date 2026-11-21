// @vitest-environment jsdom
/**
 * ISS-532 / P3-U2b：自写 spec 渲染函数与 B 档防御分支的覆盖补齐。
 *
 * headless boot 只走数据面，不挂载 React node view——四自写块的 render 回调与自写 mark 的
 * render 回调不会被触发（coverage 40%）。本文件直接拿到每个 spec 的 `implementation.render`
 * 调用它（组件用 createElement、无 hooks，可直接当纯函数调），断言产出带 data 标记的占位元素；
 * 同时把 B 档 toBlockSkeleton / 读回的"可选字段有/无"两支逐个钉住——不是凑数字，每个分支
 * 都是一条真实契约（缺 ref 不许炸、kind 词表外回落、叶子 children 递归等）。
 *
 * @module @matter/client-ui-blocks/tests/custom-specs
 */

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ReactElement } from "react"

afterEach(cleanup)
import {
  bnBlocksToOurFull,
  isOurBFirstType,
  ourBlockToBnFull,
  renderDocRef,
  renderHighlight,
  renderIssueRef,
  renderMath,
  renderMermaid,
  renderRef,
  renderSize,
  renderView,
  toBlockSkeleton,
} from "../src/client/index.ts"
import type { OurRich } from "../src/client/index.ts"

/** 真渲染占位元素到 DOM，读它的 data-* 属性（同时覆盖 Placeholder 组件）。 */
function dataAttrs(el: ReactElement): Record<string, string | undefined> {
  const view = render(el)
  const span = view.container.querySelector("span")!
  const out: Record<string, string | undefined> = {}
  for (const attr of Array.from(span.attributes)) out[attr.name] = attr.value
  return out
}

describe("自写块 spec 的 render 回调（结构占位，无视觉）", () => {
  it("issueRef render → data-bn-placeholder=issueRef + ref 字段", () => {
    const el = renderIssueRef({ props: { ref: "ISS-9" } })
    expect(dataAttrs(el)["data-bn-placeholder"]).toBe("issueRef")
    expect(dataAttrs(el)["data-field-ref"]).toBe("ISS-9")
  })

  it("docRef render → docRef + ref", () => {
    const el = renderDocRef({ props: { ref: "DOC-9" } })
    expect(dataAttrs(el)["data-bn-placeholder"]).toBe("docRef")
    expect(dataAttrs(el)["data-field-ref"]).toBe("DOC-9")
  })

  it("mermaid render → mermaid + code", () => {
    const el = renderMermaid({ props: { code: "graph TD" } })
    expect(dataAttrs(el)["data-bn-placeholder"]).toBe("mermaid")
    expect(dataAttrs(el)["data-field-code"]).toBe("graph TD")
  })

  it("view render → view + ref + kind", () => {
    const el = renderView({ props: { ref: "v-9", kind: "board" } })
    expect(dataAttrs(el)["data-bn-placeholder"]).toBe("view")
    expect(dataAttrs(el)["data-field-ref"]).toBe("v-9")
    expect(dataAttrs(el)["data-field-kind"]).toBe("board")
  })
})

describe("自写 mark spec 的 render 回调", () => {
  it("highlight render → 带 data 标记占位", () => {
    expect(dataAttrs(renderHighlight())["data-bn-placeholder"]).toBe("highlight")
  })
  it("size render → data-field-value", () => {
    expect(dataAttrs(renderSize("lg"))["data-field-value"]).toBe("lg")
  })
  it("math render → data-field-tex", () => {
    expect(dataAttrs(renderMath("x^2"))["data-field-tex"]).toBe("x^2")
  })
  it("ref render → data-field-ref", () => {
    expect(dataAttrs(renderRef("issue:ISS-1"))["data-field-ref"]).toBe("issue:ISS-1")
  })
})

describe("B 档契约分支覆盖", () => {
  it("isOurBFirstType 正反例", () => {
    expect(isOurBFirstType("toggle")).toBe(true)
    expect(isOurBFirstType("issueRef")).toBe(true)
    expect(isOurBFirstType("callout")).toBe(false)
  })

  it("toBlockSkeleton B 档可选字段有/无两支", () => {
    expect(toBlockSkeleton({ id: "a", type: "issueRef", ref: "ISS-1" })).toEqual({ id: "a", type: "issueRef", ref: "ISS-1" })
    expect(toBlockSkeleton({ id: "b", type: "docRef", ref: "DOC-1", preview: true })).toMatchObject({ preview: true })
    expect(toBlockSkeleton({ id: "c", type: "mermaid", code: "g" })).toEqual({ id: "c", type: "mermaid", code: "g" })
    expect(toBlockSkeleton({ id: "d", type: "mermaid", code: "g", caption: "cap" })).toMatchObject({ caption: "cap" })
    expect(toBlockSkeleton({ id: "e", type: "view", ref: "v" })).toEqual({ id: "e", type: "view", ref: "v" })
    expect(toBlockSkeleton({ id: "f", type: "view", ref: "v", kind: "list" })).toMatchObject({ kind: "list" })
    expect(toBlockSkeleton({ id: "g", type: "toggle", title: "T" })).toEqual({ id: "g", type: "toggle", title: "T" })
  })

  it("ourBlockToBnFull B 档默认值分支（preview/kind/caption/children 缺省）", () => {
    expect(ourBlockToBnFull({ id: "a", type: "issueRef", ref: "ISS-1" })[0].props).toMatchObject({ preview: false })
    expect(ourBlockToBnFull({ id: "b", type: "mermaid", code: "g" })[0].props).toMatchObject({ caption: "" })
    expect(ourBlockToBnFull({ id: "c", type: "view", ref: "v" })[0].props).toMatchObject({ kind: "list" })
    expect(ourBlockToBnFull({ id: "d", type: "toggle", title: "T" })[0].children).toEqual([])
  })

  it("bnBlocksToOurFull 缺 props/非法 kind/字符串 content 的防御分支", () => {
    const rich: OurRich[] = []
    void rich
    const out = bnBlocksToOurFull([
      { id: "a", type: "issueRef" },                                   // 无 props → ref=""
      { id: "b", type: "docRef", props: { ref: "D", preview: true } },  // preview 有值
      { id: "c", type: "mermaid", props: { code: "g", caption: "cap" } },
      { id: "d", type: "view", props: { ref: "v", kind: "weird" } },    // 词表外 → 回落
      { id: "e", type: "toggleListItem", content: "str" },              // 字符串 content → title
    ] as never)
    expect(out[0]).toMatchObject({ type: "issueRef", ref: "" })
    expect(out[1]).toMatchObject({ type: "docRef", preview: true })
    expect(out[2]).toMatchObject({ type: "mermaid", caption: "cap" })
    expect(out[3]).toEqual({ id: "d", type: "view", ref: "v" })
    expect(out[4]).toMatchObject({ type: "toggle", title: "str" })
  })

  it("bnBlocksToOurFull 非 B 档、空 children", () => {
    const out = bnBlocksToOurFull([
      { id: "p", type: "paragraph", content: [] },
    ] as never)
    expect(out[0]).toMatchObject({ type: "paragraph" })
  })
})
