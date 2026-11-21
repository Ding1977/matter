/**
 * ISS-529 · `indexBlocks` / `extractReferences` 的回归守卫。
 *
 * 全部断言写成「换成错误实现即红」的形态：
 *   §1–§4 钉索引语义（嵌套容器内的块必须被索引 —— **遍历跳过容器子块即红**，
 *   变异样本 2 的常驻形态；last-wins 是定义过的行为）；
 *   §5–§8 钉四类引用三档分放、嵌套引用块进档、词表外兜底与 blockGroup 同款。
 * @module @matter/blocks/tests/tree-index
 */

import { describe, expect, it } from "vitest"
import { Block } from "../src/spec.ts"
import { extractReferences, indexBlocks } from "../src/tree-index.ts"
import { blockRef, isReference, UnhandledBlockTypeError } from "../src/index.ts"
import type { Block as BlockValue } from "../src/index.ts"

/**
 * 标本树：一棵含四类引用 + 非引用、两层容器嵌套的混合树。
 * 嵌套层（toggle 里）放的是**引用块** —— 「嵌套容器内的引用块必须被索引/提取」
 * 的用例载体。
 */
const TREE: BlockValue[] = [
  Block.parse({ id: "p1", type: "paragraph", rich: [{ text: "text" }] }),
  Block.parse({
    id: "c1",
    type: "columns",
    children: [
      Block.parse({ id: "sb1", type: "syncedBlock", ref: "b-root" }),
      Block.parse({
        id: "t1",
        type: "toggle",
        title: "refs",
        children: [
          Block.parse({ id: "ir1", type: "issueRef", ref: "ISS-1" }),
          Block.parse({ id: "dr1", type: "docRef", ref: "DOC-1" }),
          Block.parse({ id: "v1", type: "view", ref: "view-1" }),
        ],
      }),
    ],
  }),
  Block.parse({ id: "ir2", type: "issueRef", ref: "ISS-2" }),
]

describe("ISS-529 · indexBlocks 块索引", () => {
  it("§1 顶层块的条目：document 原样透传、path 单元素", () => {
    const index = indexBlocks(TREE, "DOC-X")
    expect(index.get("p1")).toEqual({ document: "DOC-X", path: ["p1"] })
    expect(index.get("ir2")).toEqual({ document: "DOC-X", path: ["ir2"] })
  })

  it("§2 嵌套容器内的块（含引用块）全部被索引，path 是根到自身的链（跳过子块即红）", () => {
    const index = indexBlocks(TREE, "DOC-X")
    expect(index.size).toBe(8)
    expect(index.get("sb1")).toEqual({ document: "DOC-X", path: ["c1", "sb1"] })
    expect(index.get("t1")).toEqual({ document: "DOC-X", path: ["c1", "t1"] })
    expect(index.get("ir1")).toEqual({ document: "DOC-X", path: ["c1", "t1", "ir1"] })
    expect(index.get("v1")).toEqual({ document: "DOC-X", path: ["c1", "t1", "v1"] })
  })

  it("§3 同 id 后访覆盖先访（DFS 前序 last-wins，行为是定义的不是巧合）", () => {
    const duped: BlockValue[] = [
      Block.parse({ id: "dup", type: "paragraph" }),
      Block.parse({
        id: "c2",
        type: "columns",
        children: [Block.parse({ id: "dup", type: "divider" })],
      }),
    ]
    const index = indexBlocks(duped, "DOC-D")
    expect(index.size).toBe(2)
    // DFS 前序后访的是嵌套里的 divider：其 path 覆盖了顶层 paragraph 的
    expect(index.get("dup")).toEqual({ document: "DOC-D", path: ["c2", "dup"] })
  })

  it("§4 空数组 ⇒ 空 Map", () => {
    expect(indexBlocks([], "DOC-E").size).toBe(0)
  })
})

describe("ISS-529 · extractReferences 四类引用三档分放", () => {
  it("§5 三档各归其位：block=syncedBlock、entity=issueRef+docRef、config=view", () => {
    const refs = extractReferences(TREE)
    expect(refs.block.map((s) => s.block.id)).toEqual(["sb1"])
    expect(refs.entity.map((s) => s.block.id)).toEqual(["ir1", "dr1", "ir2"])
    expect(refs.config.map((s) => s.block.id)).toEqual(["v1"])
    // 分档不是分 schema 组：entity 档混着 issueRef 与 docRef，且目标字段可读
    expect(refs.entity.map((s) => s.block.ref)).toEqual(["ISS-1", "DOC-1", "ISS-2"])
    expect(refs.block[0]!.block.ref).toBe("b-root")
    expect(refs.config[0]!.block.ref).toBe("view-1")
  })

  it("§6 嵌套容器内的引用块进档且 path 是完整链；各档保 DFS 前序", () => {
    const refs = extractReferences(TREE)
    expect(refs.block[0]!.path).toEqual(["c1", "sb1"])
    expect(refs.entity[0]!.path).toEqual(["c1", "t1", "ir1"])
    expect(refs.entity[2]!.path).toEqual(["ir2"]) // 顶层的在前序里最后
    expect(refs.config[0]!.path).toEqual(["c1", "t1", "v1"])
  })

  it("§7 词表外的非法 type 抛 UnhandledBlockTypeError（与 blockGroup 同款兜底，不静默跳过）", () => {
    const bogus = [{ id: "x", type: "NOPE", ref: "r" }] as unknown as BlockValue[]
    let caught: unknown
    try {
      extractReferences(bogus)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UnhandledBlockTypeError)
    expect((caught as Error).name).toBe("UnhandledBlockTypeError")
    expect((caught as Error).message).toBe("unhandled BlockType: NOPE")
  })

  it("§8 纯非引用树 ⇒ 三档全空；template 带 ref 但不是引用块（词表说了算）", () => {
    const plain: BlockValue[] = [
      Block.parse({ id: "p", type: "paragraph" }),
      Block.parse({ id: "cl", type: "columns", children: [Block.parse({ id: "d", type: "divider" })] }),
    ]
    const refs = extractReferences(plain)
    expect(refs.block).toEqual([])
    expect(refs.entity).toEqual([])
    expect(refs.config).toEqual([])
    // template 结构上带 ref，但不在 REFERENCE_TYPES 词表 ⇒ 不是引用块，不进任何档。
    // （isReference 的收窄类型按词表精确镜像 —— 见 src/index.ts 的 ⚠️ 注释。）
    const tpl = Block.parse({ id: "tp", type: "template", ref: "tpl-1" })
    expect(isReference(tpl)).toBe(false)
    expect(blockRef(tpl)).toBeUndefined()
    const withTemplate = extractReferences([tpl])
    expect(withTemplate.block).toEqual([])
    expect(withTemplate.entity).toEqual([])
    expect(withTemplate.config).toEqual([])
  })
})
