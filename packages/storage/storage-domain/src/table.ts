/**
 * Table handle runtime: one in-memory record map bound to its domain's single
 * write chain. Split out of `domain.ts` because together they exceeded the
 * 400-line file ceiling (`verify-file-size-new.ts` `FILE_LIMIT`), not because
 * the two halves have different owners — `TableHost` is still implemented by
 * `DomainImpl` and nothing else.
 *
 * 写链不在本类：本类每个写方法都是**把一个 job 交给 host 的链**。这保证
 * 「同一 domain 的所有写串行、跨 domain 不串行」，也保证 `update` 的 transform
 * 在链上 slot 执行（50 并发自增不丢）。
 * @module @matter/storage-domain/src/table
 */

import type { KvUnit } from "@matter/storage"
import { DomainError } from "./error.ts"
import type { DomainChanged } from "./events.ts"

/**
 * Handle on one declared table. Records are plain immutable data: returned
 * values are the stored objects themselves (no defensive copies) and must not
 * be mutated in place — replace via `put`/`update`.
 */
export interface KvTable<K extends string, V> {
  /**
   * Read one record, synchronously from memory.
   * @param key - Record key.
   * @returns the record, or `undefined` when absent.
   */
  get(key: K): V | undefined

  /**
   * Snapshot iterator over `[key, record]` pairs. A snapshot, not a live
   * view: iteration stays stable while queued writes land.
   * @returns the pair iterator.
   */
  entries(): IterableIterator<[K, V]>

  /**
   * Snapshot iterator over keys.
   * @returns the key iterator.
   */
  keys(): IterableIterator<K>

  /** Current record count. */
  readonly size: number

  /**
   * Insert or overwrite one record durably.
   * @param key - Record key.
   * @param value - The full new record (no partial merge).
   * @returns resolution after durability and event emission.
   */
  put(key: K, value: V): Promise<void>

  /**
   * Delete one record durably.
   * @param key - Record key.
   * @returns `true` when the record existed, `false` when it was already
   * absent (no write and no event in that case).
   */
  delete(key: K): Promise<boolean>

  /**
   * Delete several records durably in one write slot.
   *
   * The batch is one job on the domain's write chain: it runs at its slot, not
   * at call time, so an earlier queued write of the same domain is visible to
   * it and no other write interleaves. Missing keys are ignored. **The whole
   * batch reaches the in-memory state before the first `domain/changed`
   * listener runs**, so every listener observes the committed batch state, not
   * a prefix of it. One event per removed key; the events are not merged.
   *
   * A backend failure normally rejects with the batch unapplied, leaving every
   * record in place. A backend that cannot establish or restore the batch's
   * state rejects with `unknown-state` and quarantines the domain: synchronous
   * reads and every later write reject with that error, while `close()` still
   * works.
   * @param keys - Record keys; duplicates are harmless.
   * @returns the number of keys that existed and were removed.
   */
  deleteMany(keys: readonly K[]): Promise<number>

  /**
   * Atomic read-modify-write on the domain's write chain: `fn` sees the value
   * current at its queue slot, so concurrent updates never interleave.
   * @param key - Record key; a missing key rejects with `missing-key`.
   * @param fn - Synchronous pure transform from current to next record.
   * @returns the stored next record.
   */
  update(key: K, fn: (current: V) => V): Promise<V>
}

/**
 * Internal boundary handing table handles their domain-owned write machinery.
 * Implemented by `DomainImpl` and by nothing else — it is the seam that keeps
 * the write chain, the quarantine flag, and event emission in one place while
 * the table bodies stay mechanical.
 */
export interface TableHost {
  /** Owning domain name, for error prose and event payloads. */
  readonly domainName: string
  /** The opened backend unit this domain owns. */
  readonly unit: KvUnit
  /** Queue one job on the domain's single write chain. */
  enqueue<T>(job: () => Promise<T>): Promise<T>
  /** Throw `closed` after teardown, or the recorded `unknown-state` while quarantined. */
  assertReadable(): void
  /** Emit `domain/changed` for one durably landed write. */
  emitChanged(change: DomainChanged): void
}

/** Table handle bound to one in-memory record map and its domain's write chain. */
export class KvTableImpl<K extends string, V> implements KvTable<K, V> {
  constructor(
    private readonly host: TableHost,
    private readonly tableName: string,
    private readonly records: Map<string, unknown>,
  ) {}

  get(key: K): V | undefined {
    this.host.assertReadable()
    return this.records.get(key) as V | undefined
  }

  entries(): IterableIterator<[K, V]> {
    this.host.assertReadable()
    return ([...this.records.entries()] as [K, V][])[Symbol.iterator]()
  }

  keys(): IterableIterator<K> {
    this.host.assertReadable()
    return ([...this.records.keys()] as K[])[Symbol.iterator]()
  }

  get size(): number {
    this.host.assertReadable()
    return this.records.size
  }

  put(key: K, value: V): Promise<void> {
    return this.host.enqueue(async () => {
      await this.host.unit.putRecord(this.tableName, key, value)
      this.records.set(key, value)
      this.emitPut(key, value)
    })
  }

  delete(key: K): Promise<boolean> {
    return this.host.enqueue(async () => {
      // Existence is decided at this job's chain slot, not at call time: an
      // earlier queued put of the same key makes this delete observe it.
      if (!this.records.has(key)) return false
      await this.host.unit.deleteRecord(this.tableName, key)
      this.records.delete(key)
      this.emitDeleted(key)
      return true
    })
  }

  deleteMany(keys: readonly K[]): Promise<number> {
    return this.host.enqueue(async () => {
      // Existence and the backend write happen at this job's chain slot, so an
      // earlier queued put of a key is observed and the batch is one unit call.
      const present = [...new Set(keys)].filter(key => this.records.has(key))
      if (present.length === 0) return 0
      await this.host.unit.deleteRecords(this.tableName, present)
      // Memory reaches the committed batch state before the first listener
      // runs, so every `domain/changed` observes the same removed set as the
      // medium. Two loops, not one: deleting inside the emit loop would make
      // the first listener run see a prefix state.
      for (const key of present) this.records.delete(key)
      for (const key of present) this.emitDeleted(key)
      return present.length
    })
  }

  update(key: K, fn: (current: V) => V): Promise<V> {
    return this.host.enqueue(async () => {
      if (!this.records.has(key)) {
        throw new DomainError(
          "missing-key",
          `domain '${this.host.domainName}' table '${this.tableName}' has no record '${key}' to update`,
        )
      }
      const next = fn(this.records.get(key) as V)
      await this.host.unit.putRecord(this.tableName, key, next)
      this.records.set(key, next)
      this.emitPut(key, next)
      return next
    })
  }

  private emitPut(key: K, value: V): void {
    this.host.emitChanged({
      domain: this.host.domainName,
      table: this.tableName,
      key,
      operation: "put",
      value,
    })
  }

  private emitDeleted(key: K): void {
    this.host.emitChanged({
      domain: this.host.domainName,
      table: this.tableName,
      key,
      operation: "deleted",
    })
  }
}
