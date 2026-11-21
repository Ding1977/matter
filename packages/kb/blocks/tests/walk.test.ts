/**
 * ISS-529 · `walkBlocks`（DFS 前序 + 深度上限 256）的回归守卫。
 *
 * 全部断言写成「换成错误实现即红」的形态：
 *   §1–§4 钉住前序/兄弟序、path 链、depth 语义与 visitor 隔离；
 *   §5–§8 钉住 wire-safety ceiling：绿界 256 层链恰好通过、红界 257 层链抛
 *   类型化错误（**删掉深度闸即红** —— 变异样本 1 的常驻形态）、错误类与上限常量。
 * @module @matter/blocks/tests/walk
 */

import { describe, expect, it } from "vitest"
import { Block } from "../src/spec.ts"
import { MAX_WALK_DEPTH, WalkDepthLimitError, walkBlocks } from "../src/walk.ts"
import type { Block as BlockValue } from "../src/index.ts"

/**
 * 深度链：外层全是 `columns` 容器、最内一个 `divider` 叶子。
 * @param length - 链长（层数）；1 = 单个叶子，N = N-1 层容器包一个叶子。
 * @returns 顶层块数组（单元素）。
 */
function chain(length: number): BlockValue[] {
  let inner: BlockValue = Block.parse({ id: "leaf", type: "divider" })
  for (let i = length - 2; i >= 0; i--) {
    inner = Block.parse({ id: `c${i}`, type: "columns", children: [inner] })
  }
  return [inner]
}

describe("ISS-529 · walkBlocks 前序遍历与 path/depth 语义", () => {
  /** 两层混合树：columns > [paragraph, toggle > [heading]] + 顶层 divider。 */
  const tree = Block.parse({
    id: "c1",
    type: "columns",
    children: [
      { id: "p1", type: "paragraph", rich: [{ text: "a" }] },
      { id: "t1", type: "toggle", title: "t", children: [{ id: "h1", type: "heading", level: 2 }] },
    ],
  })
  const standalone = Block.parse({ id: "d1", type: "divider" })
  const blocks = [tree, standalone]

  it("§1 DFS 前序：自身先于子孙、兄弟按数组序，顺序逐字钉住", () => {
    const visited: string[] = []
    walkBlocks(blocks, (block) => visited.push(block.id))
    expect(visited).toEqual(["c1", "p1", "t1", "h1", "d1"])
  })

  it("§2 path 是根到自身的 id 链、depth 0 基且 path.length === depth + 1", () => {
    const seen = new Map<string, { path: string[]; depth: number }>()
    walkBlocks(blocks, (block, path, depth) => seen.set(block.id, { path: [...path], depth }))
    expect(seen.get("c1")).toEqual({ path: ["c1"], depth: 0 })
    expect(seen.get("p1")).toEqual({ path: ["c1", "p1"], depth: 1 })
    expect(seen.get("h1")).toEqual({ path: ["c1", "t1", "h1"], depth: 2 })
    for (const [id, { path, depth }] of seen) {
      expect(path.at(-1), `${id} path 末位`).toBe(id)
      expect(path.length, `${id} path.length`).toBe(depth + 1)
    }
  })

  it("§3 visitor 改写 path 不影响遍历（每次调用独享新数组）", () => {
    const seen = new Map<string, string[]>()
    walkBlocks(blocks, (block, path) => {
      seen.set(block.id, [...path])
      path.push("MUTATED")
      path.length = 0
    })
    // 遍历没被扰动：块数完整、每块 path 仍与 §2 相同
    expect([...seen.keys()]).toEqual(["c1", "p1", "t1", "h1", "d1"])
    expect(seen.get("h1")).toEqual(["c1", "t1", "h1"])
  })

  it("§4 空数组零调用；无 children 的容器不递归；叶子无递归", () => {
    let calls = 0
    walkBlocks([], () => {
      calls++
    })
    expect(calls).toBe(0)

    const emptyContainer = Block.parse({ id: "cl", type: "columns" })
    const ids: string[] = []
    walkBlocks([emptyContainer], (b) => ids.push(b.id))
    expect(ids).toEqual(["cl"])
  })
})

describe("ISS-529 · 深度上限 256（wire-safety ceiling）", () => {
  it("§5 绿界：256 层链恰好通过，visitor 恰收 256 次、最深层号 255", () => {
    const seen: number[] = []
    expect(() =>
      walkBlocks(chain(MAX_WALK_DEPTH), (_b, _p, depth) => seen.push(depth)),
    ).not.toThrow()
    expect(seen).toHaveLength(MAX_WALK_DEPTH)
    expect(Math.max(...seen)).toBe(MAX_WALK_DEPTH - 1)
  })

  it("§6 红界：257 层链抛 WalkDepthLimitError，且在第 257 层被访问前抛", () => {
    const seen: string[] = []
    expect(() =>
      walkBlocks(chain(MAX_WALK_DEPTH + 1), (b) => seen.push(b.id)),
    ).toThrow(WalkDepthLimitError)
    // 已访问的是前 256 层（c0..c255）；第 257 层的块（depth 256 的 leaf）没进 visitor
    expect(seen).toHaveLength(MAX_WALK_DEPTH)
    expect(seen.at(-1)).toBe("c255")

    let caught: unknown
    try {
      walkBlocks(chain(MAX_WALK_DEPTH + 1), () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WalkDepthLimitError)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe("WalkDepthLimitError")
    expect((caught as Error).message).toBe(
      `block tree exceeds max depth 256 (at block "leaf", depth 256)`,
    )
  })

  it("§7 WalkDepthLimitError 可独立构造：instanceof、name 与消息文本", () => {
    const error = new WalkDepthLimitError(300, "b-x")
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(WalkDepthLimitError)
    expect(error.name).toBe("WalkDepthLimitError")
    expect(error.message).toBe('block tree exceeds max depth 256 (at block "b-x", depth 300)')
  })

  it("§8 上限常量钉在 256（改数值即红，与 DSH tool-call-tree 同值）", () => {
    expect(MAX_WALK_DEPTH).toBe(256)
  })
})
