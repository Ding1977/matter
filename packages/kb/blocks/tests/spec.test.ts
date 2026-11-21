/**
 * ISS-526 · `@matter/blocks` schema 骨架的永久回归守卫。
 *
 * 三组断言都写成「换成错误实现即红」的形态：
 *   ① 28 类型正例 + schema union ↔ 分组词表不漂移（§1–§3）；
 *   ② V5：3 容器塞 children 绿、25 叶子塞 children 红（§4–§6）；
 *   ③ 引用块目标字段 + assertNever 穷尽 switch 的可执行载体（§7–§9）。
 *
 * 叶子塞 children 的红**只归因于 children 这个键**：每个叶子先过一遍不含 children 的
 * 正例（绿），再过一遍仅多 children 的反例（红）—— 两者只差一个键，红必由它引起。
 * @module @matter/blocks/tests/spec
 */

import { describe, expect, it } from "vitest"
import {
  A_BASIC_TYPES, B_BUSINESS_TYPES, C_NOTION_TYPES, BLOCK_TYPES,
  CONTAINER_TYPES, REFERENCE_TYPES, Block,
  assertNever, blockChildren, blockGroup, blockRef, groupCounts, isContainer, isReference,
} from "../src/index.ts"
import type { Block as BlockValue, BlockType } from "../src/index.ts"

/** 每种块的最小合法值（只给 required 字段）。与 V5 反例配对：只差一个 children 键。 */
const MINIMAL: Record<BlockType, Record<string, unknown>> = {
  paragraph: { id: "p", type: "paragraph" },
  heading: { id: "h", type: "heading", level: 1 },
  bulletList: { id: "bl", type: "bulletList" },
  orderedList: { id: "ol", type: "orderedList" },
  todo: { id: "t", type: "todo", checked: false },
  quote: { id: "q", type: "quote" },
  divider: { id: "d", type: "divider" },
  code: { id: "c", type: "code", code: "1+1" },
  image: { id: "i", type: "image", url: "https://x/img.png" },
  issueRef: { id: "ir", type: "issueRef", ref: "ISS-526" },
  docRef: { id: "dr", type: "docRef", ref: "DOC-512" },
  mermaid: { id: "m", type: "mermaid", code: "graph TD" },
  toggle: { id: "tg", type: "toggle", title: "more" },
  callout: { id: "co", type: "callout" },
  table: { id: "tb", type: "table", rows: [["a"]] },
  view: { id: "v", type: "view", ref: "view-1" },
  video: { id: "vd", type: "video", url: "https://x/v.mp4" },
  audio: { id: "au", type: "audio", url: "https://x/a.mp3" },
  pdf: { id: "pd", type: "pdf", url: "https://x/p.pdf" },
  bookmark: { id: "bm", type: "bookmark", url: "https://x" },
  attachment: { id: "at", type: "attachment", asset: "media-1", name: "f.txt" },
  columns: { id: "cl", type: "columns" },
  math: { id: "ma", type: "math", tex: "x^2" },
  toc: { id: "toc", type: "toc" },
  breadcrumb: { id: "bc", type: "breadcrumb" },
  syncedBlock: { id: "sb", type: "syncedBlock", ref: "b-root" },
  template: { id: "tp", type: "template", ref: "tpl-1" },
  embed: { id: "em", type: "embed", url: "https://x/embed" },
}

describe("ISS-526 · 词表与 union 不漂移", () => {
  it("§1 分组数字：A9 + B7 + C12 = 28，容器 3、引用 4，且无重复", () => {
    expect(A_BASIC_TYPES).toHaveLength(9)
    expect(B_BUSINESS_TYPES).toHaveLength(7)
    expect(C_NOTION_TYPES).toHaveLength(12)
    expect(BLOCK_TYPES).toHaveLength(28)
    expect(CONTAINER_TYPES).toHaveLength(3)
    expect(REFERENCE_TYPES).toHaveLength(4)
    expect(new Set(BLOCK_TYPES).size).toBe(28)
    expect(groupCounts()).toEqual({ a: 9, b: 7, c: 12 })
  })

  it("§2 MINIMAL 覆盖全部 28 类型（多一个漏一个都红）", () => {
    expect(Object.keys(MINIMAL).sort()).toEqual([...BLOCK_TYPES].sort())
  })

  it("§3 schema union 的判别值逐字等于 BLOCK_TYPES（新增 schema 忘登记即红）", () => {
    const unionTypes = Block.options.map((o) => o.shape.type.value)
    expect([...unionTypes]).toEqual([...BLOCK_TYPES])
  })
})

describe("ISS-526 · 28 类型 discriminated union 全过", () => {
  it("§4 每种块的最小合法值都能 parse，type 判别正确", () => {
    for (const type of BLOCK_TYPES) {
      const parsed = Block.parse(MINIMAL[type])
      expect(parsed.type, `type=${type}`).toBe(type)
      expect(parsed.id).toBeTruthy()
    }
  })

  it("§5 叶子塞未知键也红（strictObject 承重：反过来 children 才能被拒）", () => {
    const bad = Block.safeParse({ id: "x", type: "paragraph", typo: 1 })
    expect(bad.success).toBe(false)
  })
})

describe("ISS-526 · V5 容器/叶子边界", () => {
  const leaves = BLOCK_TYPES.filter((t) => !(CONTAINER_TYPES as readonly string[]).includes(t))

  it("§6 正例：3 容器塞 children 绿，且 children 递归校验、读回一致", () => {
    for (const type of CONTAINER_TYPES) {
      const child = { id: "child", type: "paragraph", rich: [{ text: "hi" }] }
      const value = { ...MINIMAL[type], children: [child] }
      const parsed = Block.safeParse(value)
      expect(parsed.success, `container=${type}`).toBe(true)
      if (parsed.success) {
        expect(parsed.data).toEqual(value)
        expect(blockChildren(parsed.data as BlockValue)).toHaveLength(1)
      }
    }
    // 反面对照物：容器里塞非法子块必须红 —— children 字段真在递归校验，不是摆设。
    expect(Block.safeParse({ id: "cl", type: "columns", children: [{ id: "x", type: "NOPE" }] }).success).toBe(false)
  })

  it("§7 反例：25 叶子塞 children 全红，且不含 children 的同值全绿（红只因 children）", () => {
    expect(leaves).toHaveLength(25)
    for (const type of leaves) {
      expect(Block.safeParse(MINIMAL[type]).success, `leaf ${type} w/o children`).toBe(true)
      const withChildren = Block.safeParse({ ...MINIMAL[type], children: [] })
      expect(withChildren.success, `leaf ${type} w/ children`).toBe(false)
    }
  })

  it("§8 判别辅助：容器/引用判定与空数组安全网", () => {
    for (const type of CONTAINER_TYPES) expect(isContainer(Block.parse(MINIMAL[type])), type).toBe(true)
    for (const type of BLOCK_TYPES) {
      const b = Block.parse(MINIMAL[type])
      if (!(CONTAINER_TYPES as readonly string[]).includes(type)) {
        expect(isContainer(b), type).toBe(false)
        expect(blockChildren(b)).toEqual([])
      }
    }
  })
})

describe("ISS-526 · 引用字段与 assertNever 封闭性", () => {
  it("§9 引用块必须有 ref，缺 ref 红；blockRef 读回目标", () => {
    for (const type of REFERENCE_TYPES) {
      const value = Block.parse(MINIMAL[type])
      expect(isReference(value), type).toBe(true)
      expect(blockRef(value), type).toBeTruthy()
      const { ref: _ref, ...withoutRef } = MINIMAL[type]
      expect(Block.safeParse(withoutRef).success, `ref required on ${type}`).toBe(false)
    }
    expect(isReference(Block.parse(MINIMAL.paragraph))).toBe(false)
    expect(blockRef(Block.parse(MINIMAL.paragraph))).toBeUndefined()
  })

  it("§10 blockGroup 穷尽 28 类型（assertNever 在 default 收尾，漏一 case 即编译红）", () => {
    for (const type of BLOCK_TYPES) {
      const group = A_BASIC_TYPES.includes(type as never) ? "A"
        : B_BUSINESS_TYPES.includes(type as never) ? "B" : "C"
      expect(blockGroup(Block.parse(MINIMAL[type])), type).toBe(group)
    }
  })
})
