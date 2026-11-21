/**
 * ISS-531 / P3-U2a：映射契约与辅助函数的覆盖补齐（coverage 档 client 域 perFile ≥80%）。
 *
 * roundtrip.test.ts 走的是「整链往返」，对这些纯函数的部分分支（类型守卫、mark 序列化、
 * 骨架降级、便捷构造、name-map 的兜底分支）覆盖不到。本文件逐函数钉住其全部分支，
 * 让 client 域每个源文件四维都过 80% 阈值——不是为了数字，而是这些分支各有契约：
 * 守卫判错会把非 A 档当 A 档、mark 序列化错会让 zod 校验失真、骨架降级漏字段会让负例失灵。
 *
 * @module @matter/client-ui-blocks/tests/helpers
 */

import { describe, expect, it } from "vitest"
import { apply } from "../src/index.ts"
import {
  BN_A_TYPES,
  BN_STYLE_TO_OUR_MARK,
  GRANULAR_LIST_TYPES,
  OUR_A_TYPES,
  OUR_TO_BN_TYPE,
  BN_TO_OUR_TYPE,
  isBnAType,
  isOurAType,
  markToSkeletonString,
  markedRich,
  plainRich,
  toBlockSkeleton,
  ourBlockToBn,
  bnBlocksToOur,
} from "../src/client/index.ts"

describe("host apply（空注册契约）", () => {
  it("apply 不抛错、无返回值", () => {
    expect(apply({} as never)).toBeUndefined()
  })
})

describe("contract/blocks 名/粒度表与守卫", () => {
  it("OUR_TO_BN_TYPE / BN_TO_OUR_TYPE 互为逆映射", () => {
    for (const our of OUR_A_TYPES) {
      const bn = OUR_TO_BN_TYPE[our]
      expect(BN_TO_OUR_TYPE[bn]).toBe(our)
    }
  })

  it("名差四处正确（bulletList/orderedList/todo/code）", () => {
    expect(OUR_TO_BN_TYPE.bulletList).toBe("bulletListItem")
    expect(OUR_TO_BN_TYPE.orderedList).toBe("numberedListItem")
    expect(OUR_TO_BN_TYPE.todo).toBe("checkListItem")
    expect(OUR_TO_BN_TYPE.code).toBe("codeBlock")
    expect(GRANULAR_LIST_TYPES.has("bulletList")).toBe(true)
    expect(GRANULAR_LIST_TYPES.has("orderedList")).toBe(true)
    expect(GRANULAR_LIST_TYPES.has("paragraph")).toBe(false)
  })

  it("isOurAType / isBnAType 正反例", () => {
    expect(OUR_A_TYPES.every(isOurAType)).toBe(true)
    expect(isOurAType("issueRef")).toBe(false)
    expect(BN_A_TYPES.every(isBnAType)).toBe(true)
    expect(isBnAType("table")).toBe(false)
  })
})

describe("contract/marks mark 序列化与反向表", () => {
  it("markToSkeletonString 四种形态", () => {
    expect(markToSkeletonString({ type: "bold" })).toBe("bold")
    expect(markToSkeletonString({ type: "color", value: "red" })).toBe("color:red")
    expect(markToSkeletonString({ type: "bg", value: "blue" })).toBe("bg:blue")
    expect(markToSkeletonString({ type: "link", href: "https://x" })).toBe("link:https://x")
  })

  it("BN_STYLE_TO_OUR_MARK 七种 style 名齐全", () => {
    expect(BN_STYLE_TO_OUR_MARK["strike"]).toBe("strikethrough")
    expect(BN_STYLE_TO_OUR_MARK["textColor"]).toBe("color")
    expect(BN_STYLE_TO_OUR_MARK["backgroundColor"]).toBe("bg")
    expect(Object.keys(BN_STYLE_TO_OUR_MARK).length).toBe(7)
  })
})

describe("contract/types 骨架降级与便捷构造", () => {
  it("plainRich / markedRich", () => {
    expect(plainRich("x")).toEqual({ text: "x", marks: [] })
    expect(markedRich("x", { type: "bold" })).toEqual({ text: "x", marks: [{ type: "bold" }] })
  })

  it("toBlockSkeleton 逐型覆盖（含可选字段有/无两支）", () => {
    const r = plainRich("t")
    expect(toBlockSkeleton({ id: "p", type: "paragraph", rich: [r] })).toEqual({ id: "p", type: "paragraph", rich: [{ text: "t", marks: [] }] })
    expect(toBlockSkeleton({ id: "q", type: "quote", rich: [r] })).toEqual({ id: "q", type: "quote", rich: [{ text: "t", marks: [] }] })
    expect(toBlockSkeleton({ id: "h", type: "heading", level: 2, rich: [r] })).toMatchObject({ level: 2 })
    expect(toBlockSkeleton({ id: "bl", type: "bulletList", items: [r] })).toMatchObject({ items: [{ text: "t" }] })
    expect(toBlockSkeleton({ id: "ol", type: "orderedList", items: [r] })).not.toHaveProperty("start")
    expect(toBlockSkeleton({ id: "ol", type: "orderedList", items: [r], start: 4 })).toMatchObject({ start: 4 })
    expect(toBlockSkeleton({ id: "t", type: "todo", checked: true, rich: [r] })).toMatchObject({ checked: true })
    expect(toBlockSkeleton({ id: "d", type: "divider" })).toEqual({ id: "d", type: "divider" })
    expect(toBlockSkeleton({ id: "c", type: "code", code: "x" })).not.toHaveProperty("language")
    expect(toBlockSkeleton({ id: "c", type: "code", code: "x", language: "ts" })).toMatchObject({ language: "ts" })
    expect(toBlockSkeleton({ id: "i", type: "image", url: "u" })).not.toHaveProperty("caption")
    expect(toBlockSkeleton({ id: "i", type: "image", url: "u", caption: "cap" })).toMatchObject({ caption: "cap" })
  })
})

describe("mapping/blocks ourBlockToBn 全分支", () => {
  it("九型各产出至少一块，列表类按 items 展开", () => {
    const r = plainRich("t")
    expect(ourBlockToBn({ id: "p", type: "paragraph", rich: [r] })).toHaveLength(1)
    expect(ourBlockToBn({ id: "h", type: "heading", level: 1, rich: [r] })).toHaveLength(1)
    expect(ourBlockToBn({ id: "t", type: "todo", checked: false, rich: [r] })).toHaveLength(1)
    expect(ourBlockToBn({ id: "q", type: "quote", rich: [r] })).toHaveLength(1)
    expect(ourBlockToBn({ id: "d", type: "divider" })).toHaveLength(1)
    expect(ourBlockToBn({ id: "c", type: "code", code: "x", language: "ts" })).toHaveLength(1)
    expect(ourBlockToBn({ id: "c", type: "code", code: "x" })).toHaveLength(1)
    expect(ourBlockToBn({ id: "i", type: "image", url: "u", caption: "cap" })).toHaveLength(1)
    expect(ourBlockToBn({ id: "i", type: "image", url: "u" })).toHaveLength(1)
    const bl = ourBlockToBn({ id: "bl", type: "bulletList", items: [r, r, r] })
    expect(bl).toHaveLength(3)
    expect(bl[0].id).toBe("bl")
    expect(bl[1].id).toBe("bl-li1")
    const ol = ourBlockToBn({ id: "ol", type: "orderedList", items: [r, r], start: 5 })
    expect(ol).toHaveLength(2)
    expect(ol[0].props).toMatchObject({ start: 5 })
    expect(ol[1].props).not.toHaveProperty("start")
    const ol2 = ourBlockToBn({ id: "ol", type: "orderedList", items: [r] })
    expect(ol2[0].props).toEqual({})
  })
})

describe("mapping/blocks bnBlocksToOur 读回防御分支", () => {
  /** 造一个最小 BN 块（字段按需要给）。 */
  const bn = (type: string, extra: Record<string, unknown> = {}) => ({ id: "x", type, props: {}, content: [], children: [], ...extra }) as never

  it("codeBlock 的 string content 分支（BN 读回规范化前的形态）", () => {
    const out = bnBlocksToOur([bn("codeBlock", { content: "const y=2" })])
    expect(out[0]).toMatchObject({ type: "code", code: "const y=2" })
  })

  it("props 缺失走 fallback（heading.level=1 / todo.checked=false / image.url='')", () => {
    const out = bnBlocksToOur([
      bn("heading"),
      bn("checkListItem"),
      bn("image"),
    ])
    expect(out[0]).toMatchObject({ type: "heading", level: 1 })
    expect(out[1]).toMatchObject({ type: "todo", checked: false })
    expect(out[2]).toMatchObject({ type: "image", url: "" })
  })

  it("非文本 content（image/divider 的 undefined）走空富文本数组", () => {
    const out = bnBlocksToOur([bn("divider", { content: undefined }), bn("image", { content: undefined, props: { url: "u", caption: "c" } })])
    expect(out[0]).toEqual({ id: "x", type: "divider" })
    expect(out[1]).toMatchObject({ type: "image", url: "u", caption: "c" })
  })

  it("heading.level / todo.checked 有值时走非 fallback 分支", () => {
    const out = bnBlocksToOur([
      bn("heading", { props: { level: 5 } }),
      bn("checkListItem", { props: { checked: true } }),
    ])
    expect(out[0]).toMatchObject({ type: "heading", level: 5 })
    expect(out[1]).toMatchObject({ type: "todo", checked: true })
  })
})
