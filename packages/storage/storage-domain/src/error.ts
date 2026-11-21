/**
 * Error vocabulary of the domain data form.
 *
 * 照抄 DSH `storage-domain/src/error.ts`。与 backend 的 `StorageError` 分工**不可混**：
 * 本类的 `code` 是 domain 层（写链 / 校验 / 生命周期）的判别式，后端失败
 * （`backend-not-found` / `version-mismatch` / `malformed-medium` / `unknown-state`）
 * **原样透传 `StorageError`，不在这里重新包装** —— 消费者 switch 两种 code 词表才能分清
 * 「谁坏了」。
 * @module @matter/storage-domain/src/error
 */

/** Discriminant codes carried by every {@link DomainError}. */
export type DomainErrorCode =
  | "already-open"
  | "facet-unsupported"
  | "invalid-record"
  | "missing-key"
  | "closed"
  /** A domain declaration failed its own self-check (name / version / discriminants / global schema). */
  | "invalid-spec"

/** Location of the record that failed schema validation at the durable boundary. */
export interface InvalidRecordDetail {
  /** Table holding the rejected record; `''` for the global singleton. */
  readonly table: string
  /** Key of the rejected record; `''` for the global singleton. */
  readonly key: string
}

/** Construction options: standard `cause` plus the `invalid-record` location. */
export interface DomainErrorOptions extends ErrorOptions {
  /** Present exactly when `code` is `invalid-record`. */
  readonly detail?: InvalidRecordDetail
}

/**
 * Error thrown by the domain layer. The `code` is the stable contract
 * consumers may switch on; `message` is diagnostic prose.
 */
export class DomainError extends Error {
  override readonly name = "DomainError"

  /** Present exactly when `code` is `invalid-record`. */
  readonly detail?: InvalidRecordDetail

  /**
   * @param code - Stable discriminant for the failure class.
   * @param message - Human-readable diagnostic detail.
   * @param options - Standard error options plus the `invalid-record` location.
   */
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    options?: DomainErrorOptions,
  ) {
    super(message, options)
    if (options?.detail) this.detail = options.detail
  }
}
