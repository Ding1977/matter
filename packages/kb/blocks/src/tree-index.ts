/**
 * `@matter/blocks/src/tree-index` —— 块树索引与引用提取（P3-B1，ISS-529）。
 *
 * ## 两个算法都建在 walk 上
 *
 * `indexBlocks`（id → 所在文档 + 路径）与 `extractReferences`（四类引用块分档提取）
 * 不各写一份递归 —— 三份重复实现正是 B-0 调研要消灭的问题。两者都是
 * {@link walkBlocks} 的纯消费者：递归、嵌套、深度上限（256 层）语义全部继承自 walk，
 * 这里只做「每个访问点收进哪种结构」。
 *
 * ## 引用四类分三档
 *
 * 四种引用块（REFERENCE_TYPES）按**目标是什么**分档，不按 schema 分组：
 *
 * | 档 | 类型 | 目标 | 反查归属 |
 * |---|---|---|---|
 * | `block` | `syncedBlock` | 另一处的一个**块** | P8 syncedBlock（派生表 block_refs） |
 * | `entity` | `issueRef` / `docRef` | 一个**实体**（工单/文档） | document 包的 edges 表（本包只提取不解析） |
 * | `config` | `view` | 一个**视图配置** | P4 views.json |
 *
 * ## 封闭性：词表外炸，引用词表内漏 case 编译红
 *
 * visitor 里 `isReference` 先收窄到四种引用块，`switch` 四 case 全覆盖后 `default`
 * 收窄到 `never` ⇒ `assertNever` 是编译期闸：将来加第五种引用类型而漏 case，
 * **TS2345 编译红**（E-3a 同款验法），不是运行期静默漏提取。词表外的非法 `type`
 * （数据损坏）与 `blockGroup` 同款兜底：抛 `UnhandledBlockTypeError`，不静默跳过。
 *
 * ## 同 id 的行为是定义的：后访覆盖（last-wins）
 *
 * schema 层不保证块 id 唯一（`blockId` 只有 `min(1)`）；唯一性由写入方保证。
 * 索引遇同 id 时 DFS 前序的**后访者覆盖先访者** —— 这是定义过的行为（测试钉住），
 * 不是实现巧合。
 *
 * @module @matter/blocks/src/tree-index
 */

import { assertNever, isReference, UnhandledBlockTypeError } from "./index.ts"
import { BLOCK_TYPES } from "./spec.ts"
import type { Block } from "./spec.ts"
import { walkBlocks } from "./walk.ts"

/** `syncedBlock` 的收窄类型：块级引用（目标是一个块）。 */
export type SyncedBlockBlock = Extract<Block, { type: "syncedBlock" }>
/** `issueRef` / `docRef` 的收窄类型：实体级引用（反查归 document 包 edges 表）。 */
export type EntityRefBlock = Extract<Block, { type: "issueRef" | "docRef" }>
/** `view` 的收窄类型：配置级引用（目标是 P4 的视图配置）。 */
export type ViewRefBlock = Extract<Block, { type: "view" }>

/**
 * 树中一处引用：引用块本体 + 根到它的块 id 链（与 {@link walkBlocks} 的 `path`
 * 同语义，`path.at(-1) === block.id`）。
 */
export interface ReferenceSite<T extends Block = Block> {
  /** 引用块本体。 */
  readonly block: T
  /** 根到该块的 id 链（含自身）。 */
  readonly path: readonly string[]
}

/**
 * 引用提取结果：四类引用块分三档（`block` / `entity` / `config`），
 * 各档保 DFS 前序出现序。
 */
export interface BlockReferences {
  /** 块级（`syncedBlock`）。 */
  readonly block: readonly ReferenceSite<SyncedBlockBlock>[]
  /** 实体级（`issueRef` / `docRef`）。 */
  readonly entity: readonly ReferenceSite<EntityRefBlock>[]
  /** 配置级（`view`）。 */
  readonly config: readonly ReferenceSite<ViewRefBlock>[]
}

/**
 * 遍历一块树，把四类引用块按三档提取（嵌套容器内的引用块一并提取 —— 递归由
 * {@link walkBlocks} 承载）。同 id 不去重（提取的是**出现**，一处引用出现两次
 * 就是两个 site）。
 * @param blocks - 顶层块数组。
 * @returns 三档 `ReferenceSite` 数组（DFS 前序，每档独立保序）。
 */
export function extractReferences(blocks: readonly Block[]): BlockReferences {
  const block: ReferenceSite<SyncedBlockBlock>[] = []
  const entity: ReferenceSite<EntityRefBlock>[] = []
  const config: ReferenceSite<ViewRefBlock>[] = []
  walkBlocks(blocks, (visited, path) => {
    if (!isReference(visited)) {
      // 合法的 24 种非引用块不参与分档；词表外的非法 type 与 blockGroup 同款兜底。
      if ((BLOCK_TYPES as readonly string[]).includes(visited.type)) return
      throw new UnhandledBlockTypeError(visited.type)
    }
    switch (visited.type) {
      case "syncedBlock":
        block.push({ block: visited, path })
        return
      case "issueRef":
      case "docRef":
        entity.push({ block: visited, path })
        return
      case "view":
        config.push({ block: visited, path })
        return
      /* v8 ignore next 2 -- 运行期不可达的穷尽闸：isReference 词表与四 case 同步维护、
         交集恒空；它的验证载体是编译期（漏 case ⇒ default 的 visited 不是 never ⇒ TS2345）
         与变异演示，不是测试执行，故不进覆盖率分母。 */
      default:
        return assertNever(visited)
    }
  })
  return { block, entity, config }
}

/** 索引条目：块 id → 所在文档 + 根到该块的 id 链。 */
export interface BlockIndexEntry {
  /** 所属文档的 id（调用方传入，本包不解释）。 */
  readonly document: string
  /** 根到该块的 id 链（含自身，`path.at(-1) === 块 id`）。 */
  readonly path: readonly string[]
}

/**
 * 块索引：块 id → {@link BlockIndexEntry}。**嵌套容器内的块（含引用块）一并索引**；
 * 同 id 后访覆盖先访（DFS 前序 last-wins，测试钉住），id 唯一性由写入方保证。
 */
export type BlockIndex = ReadonlyMap<string, BlockIndexEntry>

/**
 * 建块索引：一遍 DFS 前序，把每个块（无论嵌套多深）的 `{document, path}` 收进 Map。
 * 每次全量重建（不增量）—— 与 edges 表同一哲学，重建成本低、无失效逻辑。
 * @param blocks - 顶层块数组。
 * @param document - 该树所属的文档 id（原样进索引条目）。
 * @returns 块 id 到 `{document, path}` 的只读 Map。
 */
export function indexBlocks(blocks: readonly Block[], document: string): BlockIndex {
  const index = new Map<string, BlockIndexEntry>()
  walkBlocks(blocks, (visited, path) => index.set(visited.id, { document, path }))
  return index
}
