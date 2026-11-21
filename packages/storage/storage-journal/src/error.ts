/**
 * Journal 的错误词表。
 *
 * 每个 `code` 是一个**可 switch 的契约**（消费者按它分流恢复动作），`message` 是给人看的诊断。
 * 与 storage hub 包的 `StorageError` **故意不同型**：本包不 import 那个 seam
 * （硬约束 ①），两个错误类各有自己的 `code` 域 ⇒ 谁也没法对另一个的 code 做 `instanceof`。
 * 这不是重复实现，是「另一个 seam」的必然结果 —— 复用错误类就得复用包，而那正是被禁止的。
 *
 * @module storage-journal/src/error
 */

/** {@link JournalError} 携带的判别码。 */
export type JournalErrorCode =
  /** 库文件属于别的应用（`application_id` 不是本包的），或没有身份却被写过 —— 拒开。 */
  | "foreign-database"
  /** 库已被 `close()` 释放后还有调用。 */
  | "closed"
  /** 追加的事件缺少必需字段，或 payload 不可序列化。调用方 bug，不是介质状况。 */
  | "malformed-event"
  /** 文件系统 / SQLite 引擎层失败（建目录失败、无法打开文件等）。 */
  | "io"

/** 本包抛出的唯一错误类型。 */
export class JournalError extends Error {
  override readonly name = "JournalError"

  /**
   * @param code - 稳定的判别码。
   * @param message - 诊断正文（含路径与具体原因）。
   * @param options - 标准错误选项（`cause`）。
   */
  constructor(
    readonly code: JournalErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
