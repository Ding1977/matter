/**
 * `@matter/blocks/src/walk` —— 块树的 DFS 前序遍历（P3-B1，ISS-529）。
 *
 * ## 为什么只有 DFS 前序一种形态
 *
 * 当前全部消费者（渲染 U-2、迁移导出 P9、引用定位 P8）都只要「父先于子、兄弟按序」。
 * pre/post/广度/异步多形态是预防性设计，没有当前所有者就不建（项目四原则·简洁）。
 * 需要第二种形态的那一天，先补一个消费者再补形态。
 *
 * ## 深度上限 256：wire-safety ceiling
 *
 * 数值与语义照 DSH tool-call-tree 的 `MAX_DEPTH = 256`（conversation-nodes/tool.ts）：手写
 * 或损坏的数据可以构造任意深的嵌套链，先在**深度闸**上抛类型化错误，好过在调用方的
 * 栈上崩一个 `RangeError`。DSH 对超限子树静默剪枝（渲染场景的取舍）；本包是数据层，
 * 剪枝等于让调用方拿着一棵被偷偷截断的树去写库，所以这里**抛错不剪枝**。
 *
 * depth 从 0 计（顶层块 depth = 0，`path.length === depth + 1` 恒成立）；层号 ≥ 上限即超限，
 * 即树深（层数）最多 256。R-1（ISS-528）已确认 P2 骨架的 V5 只管「叶子禁 children」、
 * 不管容器深度 —— 这道闸是运行期唯一的深度防线。
 *
 * ## 容器判定不自建
 *
 * 遍历消费 `blockChildren()`（src/index.ts，词表判定 + 叶子安全网），本模块不复制
 * 容器词表、不写 28-case switch —— 穷尽性由既有的词表 + `assertNever` 机制承载
 * （见 src/index.ts 头注）。新增 BlockType 时这里零改动。
 *
 * @module @matter/blocks/src/walk
 */

import { blockChildren } from "./index.ts"
import type { Block } from "./spec.ts"

/**
 * 遍历深度上限（wire-safety ceiling，照 DSH tool-call-tree 的 `MAX_DEPTH = 256`）。
 * 层号从 0 计：depth 0..255 合法（树深 256 层），第 257 层的块触发
 * {@link WalkDepthLimitError}。
 */
export const MAX_WALK_DEPTH = 256

/**
 * 块树超过 {@link MAX_WALK_DEPTH}。类型化错误，不静默剪枝 —— 数据层截断一棵树
 * 比报错更危险（调用方会把残树当全树写库）。
 */
export class WalkDepthLimitError extends Error {
  /**
   * @param atDepth - 超限块所在的层号（0 基；等于 {@link MAX_WALK_DEPTH} 时即第 257 层）。
   * @param blockId - 超限块的 id。
   */
  constructor(atDepth: number, blockId: string) {
    super(`block tree exceeds max depth ${MAX_WALK_DEPTH} (at block "${blockId}", depth ${atDepth})`)
    this.name = "WalkDepthLimitError"
  }
}

/**
 * 块访问器：每块调用一次（DFS 前序 —— 自身先于子孙，兄弟按数组序）。
 * `path` 是该次调用独享的新数组，visitor 内改写不影响遍历与其余调用。
 */
export interface BlockVisitor {
  /**
   * @param block - 当前块。
   * @param path - 从顶层块到当前块的 id 链（含自身；`path.at(-1) === block.id`）。
   * @param depth - 层号，0 基（顶层块 0；`path.length === depth + 1`）。
   */
  (block: Block, path: string[], depth: number): void
}

/**
 * DFS 前序遍历一块树（`blocks` 是某文档的顶层块数组）。
 * 超过 {@link MAX_WALK_DEPTH} 的层在**访问该层块之前**抛 {@link WalkDepthLimitError}，
 * 已访问过的块不回收（visitor 已收到的事实不撤回）。
 * @param blocks - 顶层块数组（空数组 ⇒ visitor 零调用）。
 * @param visitor - 每块调用一次的访问器。
 * @returns 无返回值（通知型遍历；要收集请闭包累加）。
 */
export function walkBlocks(blocks: readonly Block[], visitor: BlockVisitor): void {
  visit(blocks, [], 0)

  function visit(items: readonly Block[], prefix: string[], depth: number): void {
    for (const block of items) {
      if (depth >= MAX_WALK_DEPTH) throw new WalkDepthLimitError(depth, block.id)
      const path = [...prefix, block.id]
      // visitor 收的是独享快照：突变它不会污染子层的 prefix —— path 本体留给递归。
      visitor(block, [...path], depth)
      const children = blockChildren(block)
      if (children.length > 0) visit(children, path, depth + 1)
    }
  }
}
