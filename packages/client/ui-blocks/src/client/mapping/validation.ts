/**
 * 我们侧块的运行时 schema 校验（ISS-531 / P3-U2a 验收负例）——桥接 @matter/blocks zod。
 *
 * @matter/blocks 的 `Block` 是 28 种块的 zod discriminated union，用 strictObject：非法/多余字段
 * 一律 ZodError。本文件把它接到映射层：我们侧结构化块经 `toBlockSkeleton` 降级成骨架对象后
 * 交给 `Block.parse`——非法 props（如 heading.level=99、todo.checked="yes"）被拒，
 * 且 ZodError 的 issue path 点名字段（验收「error 点名字段」）。
 *
 * @matter/blocks 进 ui-blocks 的 dependencies（workspace:*）正是为此运行时校验；它是纯库包，
 * DSH 纪律禁的是 feature 插件互 import，库例外（U-0 问8）。
 *
 * @module @matter/client-ui-blocks/client/mapping/validation
 */

import { Block } from "@matter/blocks"
import { toBlockSkeleton } from "../contract/types.ts"
import type { OurBlock } from "../contract/types.ts"

/** 一条校验失败的字段定位（来自 ZodError issue path）。 */
export interface ValidationIssue {
  /** 点号连接的字段路径（如 `level` / `rich.0.text`）。 */
  readonly path: string
  /** zod 的错误信息。 */
  readonly message: string
}

/** 校验结果：成功携带解析后的骨架，失败携带逐字段定位。 */
export type ValidationResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] }

/**
 * 用 @matter/blocks 的 zod schema 校验我们侧块。
 * @param block - 我们侧块（A 档 9 或 B 档 5）。
 * @returns 校验结果（失败时 issues 每条带字段 path）。
 */
export function validateOurBlock(block: OurBlock): ValidationResult {
  return validateBlockSkeleton(toBlockSkeleton(block))
}

/**
 * 直接校验一个骨架对象（未经我们侧类型构造）——E-3a 容器判据的变异实证入口。
 *
 * `toBlockSkeleton` 按我们侧已知字段构造骨架，天生不会产出"叶子塞 children"这类非法形态；
 * 容器校验（叶子禁 children / toggle.title 必须 string）是 @matter/blocks 的 zod 职责，故给测试
 * 与上游写入方一个直通 zod 的入口：非法样本直接喂进来，红且 issue path 点名（变异实证）。
 *
 * @param skeleton - 待校验的块骨架（任意来源，含测试注入的非法样本）。
 * @returns 校验结果（失败时 issues 每条带字段 path）。
 */
export function validateBlockSkeleton(skeleton: unknown): ValidationResult {
  const parsed = Block.safeParse(skeleton)
  if (parsed.success) return { ok: true, value: parsed.data as Record<string, unknown> }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((p) => String(p)).join("."),
      message: issue.message,
    })),
  }
}
