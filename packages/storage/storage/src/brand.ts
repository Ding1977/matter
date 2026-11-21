/**
 * Branded domain identifiers used across the storage seam's consumers.
 *
 * ⚠️ 本模块**只做类型**：每个 brand 的类型是编译期的，工厂函数是恒等转换（`x === f(x)`）。
 * 这里不校验格式 —— 格式归 zod 边界、归各自业务包（`@matter/pm` 等）。
 * 出处：DSH 全仓 brand 工厂**无一**做 `throw` / `startsWith` 检查。
 *
 * @module @matter/storage/src/brand
 */

import type { Branded } from "@deepseek-ai/dsh-brand"

/** 工单 id，如 `ISS-509`。**能当 record key，不能当 unit 名**（见 README 的 Known Limitations）。 */
export type IssueId = Branded<"IssueId">

/**
 * 把字符串标成工单 id。
 * @param value - 业务包已确认属于工单 id 的字符串。
 * @returns 同一个字符串，带编译期 brand。
 */
export function issueId(value: string): IssueId {
  return value as IssueId
}
