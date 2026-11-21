/**
 * `@matter/blocks` —— P2 块引擎的 schema 骨架（28 类型 + 容器/引用 + V5），不渲染。
 *
 * ## 库形态，不是插件
 *
 * 本包没有 `apply` / `inject` / ctx 键：它是纯 schema + 类型 + 判别辅助的库。
 * DOC-512 §4.1.1 给 `@matter/blocks` 规划了 `ctx.blocks` 引擎（singular），但那一项的
 * 实质是「块树算法与遍历」，属 E-3b；P2 骨架没有当前消费者，先建服务就是给一个
 * 永远为空的 ctx 键造家（项目四原则「每个抽象有当前的活」）。今天只导出数据与判别面。
 *
 * ## assertNever 是封闭性的唯一闸
 *
 * 新增一种 BlockType 而没进 A/B/C 三张词表时，{@link blockGroup} 三个类型谓词之后的
 * 剩余类型不再是 `never` ⇒ `assertNever(block)` 处 TS2345 当场编译红。三张词表覆盖
 * 全部 28 类型这一点另由 `tests/spec.test.ts` 的 schema union ↔ 词表相等断言钉住。
 * 用谓词而非 28 个 case 的 switch，是为了让 `lint-complexity` 的 ≤15 成立
 * （实测 28-case switch 的圈复杂度 29，红）。
 *
 * @module @matter/blocks
 */

import {
  A_BASIC_TYPES, B_BUSINESS_TYPES, C_NOTION_TYPES,
  CONTAINER_TYPES, REFERENCE_TYPES,
} from "./spec.ts"
import type { Block, BlockType } from "./spec.ts"

// `Block` / `Rich` 在 spec.ts 里同时是值（schema）与类型（z.infer）：一条 export 即可
// 把两个含义一起带出，再加 export type 会 TS2300 重复声明（实测）。
export {
  A_BASIC_TYPES, B_BUSINESS_TYPES, C_NOTION_TYPES, BLOCK_TYPES,
  CONTAINER_TYPES, REFERENCE_TYPES, Rich, Block,
} from "./spec.ts"
export type { BlockType } from "./spec.ts"
// P3-B1（ISS-529）块树三算法。walk.ts 反向 import 本文件的 blockChildren：ESM live
// binding + walk 顶层零调用 ⇒ 循环无害（测试 import 顺序打乱也盖住）。
export { MAX_WALK_DEPTH, WalkDepthLimitError, walkBlocks } from "./walk.ts"
export type { BlockVisitor } from "./walk.ts"
export { extractReferences, indexBlocks } from "./tree-index.ts"
export type {
  BlockIndex, BlockIndexEntry, BlockReferences, EntityRefBlock, ReferenceSite, SyncedBlockBlock, ViewRefBlock,
} from "./tree-index.ts"
export {
  evaluateViewQuery, ViewFilterClause, ViewQueryError, ViewQuerySpec, ViewSortKey,
} from "./view-query.ts"
export type {
  ViewFieldCatalog, ViewFieldType, ViewFilter, ViewQuery, ViewQueryErrorCode, ViewQueryExecutor, ViewRow, ViewSort,
} from "./view-query.ts"

/**
 * 穷尽联合被打破（出现未登记的 BlockType）。
 * 消息文本沿用封闭性断言的原句，只把裸 Error 换成有名字的类型化错误。
 */
export class UnhandledBlockTypeError extends Error {
  /** @param type - 未处理的 type 值（JSON 序列化后的文本）。 */
  constructor(type: string) {
    super(`unhandled BlockType: ${type}`)
    this.name = "UnhandledBlockTypeError"
  }
}

/**
 * 封闭联合的兜底：任何走到这里的值都应是 `never`。
 * 新增 BlockType 未进词表 ⇒ 编译红（TS2345），不是运行期才炸。
 * @param value - 三张词表穷尽后剩下的值（类型为 never）。
 * @returns 永不返回。
 */
export function assertNever(value: never): never {
  throw new UnhandledBlockTypeError(JSON.stringify(value))
}

/** A 组的 9 个 type（从词表派生，不另立真相源）。 */
type AType = (typeof A_BASIC_TYPES)[number]
/** B 组的 7 个 type。 */
type BType = (typeof B_BUSINESS_TYPES)[number]
/** C 组的 12 个 type。 */
type CType = (typeof C_NOTION_TYPES)[number]

/** @param t - 待判 type。 @returns 是否属于 A 组。 */
function isAType(t: BlockType): t is AType {
  return (A_BASIC_TYPES as readonly string[]).includes(t)
}
/** @param t - 待判 type。 @returns 是否属于 B 组。 */
function isBType(t: BlockType): t is BType {
  return (B_BUSINESS_TYPES as readonly string[]).includes(t)
}
/** @param t - 待判 type。 @returns 是否属于 C 组。 */
function isCType(t: BlockType): t is CType {
  return (C_NOTION_TYPES as readonly string[]).includes(t)
}

/**
 * 块分组判别：A 基础 / B 业务 / C Notion 扩展。
 * 三个类型谓词按 A→B→C 收窄 `block.type`；若三张词表没覆盖新类型，剩余类型不是
 * `never` ⇒ 末尾 {@link assertNever} 编译红。这是封闭性的编译期载体。
 * @param block - 任意块。
 * @returns 所属分组。
 */
export function blockGroup(block: Block): "A" | "B" | "C" {
  const t = block.type
  if (isAType(t)) return "A"
  if (isBType(t)) return "B"
  if (isCType(t)) return "C"
  return assertNever(t)
}

/**
 * 是否容器块（columns / toggle / syncedBlock）。
 * @param block - 任意块。
 * @returns 容器判定，并把类型收窄到带 `children` 的三种。
 */
export function isContainer(block: Block): block is Extract<Block, { children?: Block[] }> {
  return (CONTAINER_TYPES as readonly string[]).includes(block.type)
}

/**
 * 是否引用块（issueRef / docRef / view / syncedBlock）。
 * ⚠️ 收窄类型**从 `REFERENCE_TYPES` 词表派生**（`(typeof REFERENCE_TYPES)[number]`），
 * 不是手写字面量、也不是按结构 `Extract<Block, { ref: string }>`：`template` 结构上
 * 也有 `ref` 字段，但词表说了它不是引用块（模板占位符不是跨文档引用）—— 按结构
 * 收窄会把 template 混进来，词表与类型就不一致（ISS-529 实测撞上：引用分档的
 * 穷尽 switch 在 default 处剩 template，`assertNever` 报 TS2345）。从词表派生 ⇒
 * 词表加值时收窄自动跟，无第二份要手动同步的镜像。
 * @param block - 任意块。
 * @returns 引用判定，并把类型收窄到词表成员（每种都带 `ref`）。
 */
export function isReference(
  block: Block,
): block is Extract<Block, { type: (typeof REFERENCE_TYPES)[number] }> {
  return (REFERENCE_TYPES as readonly string[]).includes(block.type)
}

/**
 * 块的 children：容器返回其子节点（缺省空数组），叶子恒为空数组。
 * 叶子在 schema 层就没有 children 字段（V5），这里再给一层运行期安全网。
 * @param block - 任意块。
 * @returns 只读子节点数组。
 */
export function blockChildren(block: Block): readonly Block[] {
  return isContainer(block) ? block.children ?? [] : []
}

/**
 * 块的引用目标：引用块返回其 `ref`，其余恒为 undefined。
 * @param block - 任意块。
 * @returns 引用目标 id 或 undefined。
 */
export function blockRef(block: Block): string | undefined {
  return isReference(block) ? block.ref : undefined
}

/**
 * 分组词表计数（供运行期与 grep 双向核对）。
 * @returns A/B/C 各自的种类数。
 */
export function groupCounts(): { a: number; b: number; c: number } {
  return { a: A_BASIC_TYPES.length, b: B_BUSINESS_TYPES.length, c: C_NOTION_TYPES.length }
}
