/**
 * 审计门面的**共享内核**：序列化写链 + 落审计 + CRUD 骨架。
 *
 * ## 为什么在 storage-journal
 *
 * `pm/issue` 的 `IssuesFacility` 与 `pm/project` 的 `ProjectsFacility` 是同一个概念的两次
 * 实现：一条串行写链（读旧 → 落盘 → 写审计）+ 一组 CRUD。它们的操作**全部**可以由回调注入
 * （parse / 主键归一 / 错误工厂 / 事件工厂 / 表名），没有一处依赖某域的 ctx 或 service 形态。
 * ⇒ 一物一家，骨架放这里；两域只各自给出「自己的 schema、事件名、错误类、id 类型」（ISS-524）。
 *
 * ## 为什么不是「底层依赖上层域」的架构倒挂
 *
 * 本文件**不 import 任何 @matter/\** 包**（storage-journal 的定义，见 index.ts 头注）。
 * 域对象只按结构 `{ table(name), close() }` 使用，`KvTable` 用本地结构型 {@link AuditTableLike}
 * 描述；域特定行为全在 {@link AuditFacilitySpec} 的回调里由上层传入。依赖方向仍是
 * `pm/* → storage-journal`，没有反向边，也没有新增依赖声明。
 *
 * @module storage-journal/src/facility
 */

import type { JournalEntry } from "./journal.ts"
import { createAuditWriter, sameAuditRecord, type AuditWriter } from "./audit.ts"

/** 门面所需的最小表能力（结构型；由 storage-domain 的 KvTable 满足，本包不 import 它）。 */
export interface AuditTableLike<K, V> {
  get(id: K): V | undefined
  put(id: K, value: V): Promise<void>
  delete(id: K): Promise<boolean>
  entries(): IterableIterator<[K, V]>
  readonly size: number
}

/** 门面所需的最小域对象（结构型）。 */
export interface AuditDomainLike {
  table(name: string): AuditTableLike<string, unknown>
  close(): Promise<void>
}

/** 最小追加能力（由 `ctx.journal.append` 满足）。 */
export interface AuditAppendLike {
  append(entry: JournalEntry): number
}

/**
 * 域注入的差异点 —— 全是回调/常量，journal 不认识任何域语义。
 * @typeParam K - 主键（issue 为 branded IssueId，project 为裸 string）。
 * @typeParam V - 记录类型（域的 zod 输出）。
 * @typeParam C - 写上下文类型（署名人与时刻）。
 */
export interface AuditFacilitySpec<K, V, C> {
  /** 存储单元名（= Domain.name，诊断与报错用）。 */
  readonly tableName: string
  /** 关闭后写操作的报错文案（域侧拼好，带域名）。 */
  readonly closedMessage: string
  /** zod 校验 + 收窄；失败原样抛。 */
  readonly parse: (value: unknown) => V
  /** 从记录取主键（issue 用 `issueId(record.id)` 归一成 branded）。 */
  readonly keyOf: (record: V) => K
  /** 从记录取原始 id 字符串（进错误文案与建/删事件）。 */
  readonly idOf: (record: V) => string
  /** 未找到错误工厂。 */
  readonly notFound: (id: K) => Error
  /** id 已占用错误工厂。 */
  readonly exists: (id: string) => Error
  /** 建记录事件工厂。 */
  readonly created: (id: string, context: C) => JournalEntry[]
  /** 删记录事件工厂。 */
  readonly deleted: (id: string, context: C) => JournalEntry[]
  /** 差异事件工厂。 */
  readonly diff: (id: K, previous: V | undefined, next: V, context: C) => JournalEntry[]
}

/**
 * 审计门面的共享基类：把「读旧 → 落盘 → 写审计」三步锁在一条串行链上。
 *
 * 不串行时两个并发写会交错成「A 读旧 → B 读旧 → A 落 → B 落」，B 的审计基于过期旧值。
 * append 失败只记 warn、不撤销落盘（记录是主，审计是伴生）。这些不变量在本类里收口一次，
 * 两域不再各抄一份。
 * @typeParam K - 主键类型。
 * @typeParam V - 记录类型。
 * @typeParam P - PATCH 类型。
 * @typeParam C - 写上下文类型。
 */
export class AuditFacility<K, V extends object, P, C> {
  private readonly writer: AuditWriter

  /**
   * @param domain - 已打开的域对象（调用方持有生命周期）。
   * @param journal - 追加能力（通常是 `ctx.journal`）。
   * @param warn - 审计写失败时的出声道（域侧闭包）。
   * @param spec - 域注入的差异点（schema / 事件 / 错误 / id）。
   */
  constructor(
    protected readonly domain: AuditDomainLike,
    journal: AuditAppendLike,
    warn: (message: string) => void,
    protected readonly spec: AuditFacilitySpec<K, V, C>,
  ) {
    this.writer = createAuditWriter(
      (entry) => journal.append(entry),
      (message) => warn(message),
      spec.closedMessage,
    )
  }

  /** 记录表句柄（写请走本类，否则审计会漏）。 */
  protected get table(): AuditTableLike<K, V> {
    return this.domain.table(this.spec.tableName) as AuditTableLike<K, V>
  }

  /**
   * 读一条。
   * @param id - 主键。
   * @returns 记录，或 `undefined`。
   */
  get(id: K): V | undefined {
    return this.table.get(id)
  }

  /**
   * 遍历全部记录（内存快照，不触盘）。
   * @returns `[id, record]` 迭代器。
   */
  entries(): IterableIterator<[K, V]> {
    return this.table.entries()
  }

  /** 记录条数。 */
  get size(): number {
    return this.table.size
  }

  /**
   * 建一条。`id` 已存在时报错而非覆盖 —— 覆盖会让「两次建单」在审计里与「一次」同形。
   * @param input - 整条记录。
   * @param context - 署名人与时刻。
   * @returns 落盘后的记录（zod 规范化形态）。
   */
  create(input: V, context: C = {} as C): Promise<V> {
    return this.writer.enqueue(async () => {
      const record = this.spec.parse(input)
      const key = this.spec.keyOf(record)
      if (this.table.get(key) !== undefined) throw this.spec.exists(this.spec.idOf(record))
      await this.table.put(key, record)
      this.writer.writeAudit(this.spec.created(this.spec.idOf(record), context))
      return record
    })
  }

  /**
   * 改一条（PATCH：只给要改的字段）。解出的记录与上一版完全相同则不落盘、不记审计。
   * @param id - 主键。
   * @param patch - 要改的字段。
   * @param context - 署名人与时刻。
   * @returns 落盘后的整条记录。
   */
  update(id: K, patch: P, context: C = {} as C): Promise<V> {
    return this.writer.enqueue(async () => {
      const previous = this.get(id)
      if (previous === undefined) throw this.spec.notFound(id)
      const next = this.spec.parse({ ...previous, ...patch })
      if (sameAuditRecord(previous, next)) return previous
      await this.table.put(id, next)
      this.writer.writeAudit(this.spec.diff(id, previous, next, context))
      return next
    })
  }

  /**
   * 删一条。原本不存在返回 `false`（不写审计）。
   * @param id - 主键。
   * @param context - 署名人与时刻。
   * @returns 删掉了返回 `true`。
   */
  remove(id: K, context: C = {} as C): Promise<boolean> {
    return this.writer.enqueue(async () => {
      const removed = await this.table.delete(id)
      if (removed) this.writer.writeAudit(this.spec.deleted(String(id), context))
      return removed
    })
  }

  /**
   * 关闭门面。幂等；之后任何读写抛 `closed`。
   * @returns 关域完成。
   */
  close(): Promise<void> {
    this.writer.markClosed()
    return this.domain.close()
  }
}
