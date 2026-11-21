/**
 * Type-only surface of the storage seam. **零运行时**：本模块只声明类型，
 * 编译后不含任何 JS 语句，消费者 `import type` 不会建立运行时依赖边。
 * @module @matter/storage/src/types
 */

import type { KvUnit } from "./backend.ts"

export type {
  KvFacet,
  KvUnit,
  KvUnitDescriptor,
  StorageBackend,
} from "./backend.ts"

/**
 * `loadAll()` 的快照形状。
 *
 * ⚠️ 故意**从 `KvUnit` 派生**，不重新声明：`{tables, global}` 这个形状只有一个家
 * （`backend.ts` 里 `KvUnit.loadAll` 的返回类型）。写第二份相等声明等于两份真相，
 * 迟早一处改了另一处没改。
 */
export type KvSnapshot = Awaited<ReturnType<KvUnit["loadAll"]>>
