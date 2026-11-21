/**
 * 审计事件的**共享机制层**：域无关的纯函数与「串行写链 + 追加审计」能力。
 *
 * ## 为什么这些逻辑的家在 storage-journal
 *
 * `pm/issue` 与 `pm/project` 的事件模块曾各有一份 `logValue` / `sameValue` / `sameRecord` /
 * `errorText` / entry 拼装 / diff 骨架 / 写链 —— 七段 token 级克隆（ISS-524）。这些段里
 * **没有一处**引用工单或项目自己的 schema、字段词表或 id 类型：它们只操作 {@link JournalEntry}、
 * 其 payload 值（`unknown`）与一个 `append` 能力闭包。唯一真相源就是 journal 契约本身
 * （`known` 缺省、`mdAt` 装事件时刻、`stablePayload` 不排 `known`）。⇒ 一物一家，放进本包；
 * 两域只保留各自**真正不同**的部分（事件名、字段口径、状态映射、zod schema、错误类）。
 *
 * ## 为什么不是「底层依赖上层域」的架构倒挂
 *
 * 本文件**不 import 任何 @matter/\** 包**（连 storage-domain 都不 import —— 见 index.ts 头注
 * 「另一个 seam」）。域特定输入一律以参数/回调传入：`makeAuditEntry` 收 entity/event/payload，
 * `makeAuditDiff` 收 `created`/`field` 回调，`createAuditWriter` 收 `append`/`warn`/closed 文案。
 * ⇒ 依赖方向仍是 `pm/* → storage-journal`，没有反向边。
 *
 * @module storage-journal/src/audit
 */

import type { JournalEntry } from "./journal.ts"

/** 审计行里的值截断长度（旧树 `entity-ops.js:39` `LOG_VALUE_MAX` 同值）。 */
export const AUDIT_VALUE_MAX = 200

/**
 * 值 → 审计行里的字符串。数组逗号拼接、对象 JSON 化并截断
 * （旧树 `logValue` 同口径：不截断的话一次 tags 变更能把整条审计流污染成几十 KB）。
 * @param value - 任意字段值。
 * @returns 字符串形式。
 */
export function auditValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ")
  if (value !== null && typeof value === "object") {
    const text = JSON.stringify(value) ?? String(value)
    return text.length > AUDIT_VALUE_MAX ? `${text.slice(0, AUDIT_VALUE_MAX)}…` : text
  }
  return String(value)
}

/**
 * 两个字段值是否相同。**按值比较，不按引用**。
 *
 * ⛔ `left === right` 在数组/对象字段上是错的：一次 PATCH 重建 tags 数组会换引用，于是
 * 「内容一模一样」被判成变更 ⇒ 审计里长出 `from: "a", to: "a"` 噪声行。
 * @param left - 旧值。
 * @param right - 新值。
 * @returns 内容相同返回 `true`（`undefined` 与缺键等价）。
 */
export function sameAuditValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (typeof left !== "object" || typeof right !== "object") return false
  if (left === null || right === null) return false
  // 复合字段是字符串数组与扁平对象：键序敏感的 JSON 比较在这两类上不误判。
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * 两条记录是否逐字段相同（按值比较，见 {@link sameAuditValue}，不依赖键序）。
 * @param left - 旧记录。
 * @param right - 新记录。
 * @returns 相同返回 `true`。
 */
export function sameAuditRecord(left: object, right: object): boolean {
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!sameAuditValue(a[key], b[key])) return false
  }
  return true
}

/**
 * 错误 → 一句可读文案（审计失败时用）。
 * @param error - 抛出的东西。
 * @returns 消息文本。
 */
export function auditErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 拼一条审计条目的核心列（payload 在前，核心列覆盖同名附加键）。
 *
 * 收口的两条 journal 契约：`known: 1` 是缺省值不写（`stablePayload` 不排除 `known`，写了会进
 * uid）；`actor` 缺省不写。`mdAt` 装事件自身时刻（缺省「现在」），不是可选项 —— 留空会让
 * 两次真实的同形事件在 uid 上塌成一次。
 * @param entity - 实体身份（域侧算好，如 `issues/<id>`）。
 * @param event - 事件名。
 * @param payload - 附加键（进 uid，按 key 排序）。
 * @param known - 词表状态：1 现行不写 / 非 1 显式写。
 * @param actor - 触发者；缺省不写。
 * @param at - 事件时刻；缺省「现在」。
 * @returns 可直接交给 `append` 的条目。
 */
export function makeAuditEntry(
  entity: string,
  event: string,
  payload: Record<string, unknown>,
  known: number,
  actor?: string | null,
  at?: Date,
): JournalEntry {
  const when = at ?? new Date()
  return {
    ...payload,
    entity,
    event,
    at: when.getTime(),
    mdAt: when.toISOString(),
    ...known === 1 ? {} : { known },
    ...actor == null ? {} : { actor },
  }
}

/** 建记录时兜底的条目工厂（域侧绑定自己的事件名与词表）。 */
export type AuditCreated<K, C> = (id: K, context: C) => JournalEntry[]
/** 单字段换算：返回 `null` 表示该字段不记（如工单表外状态）。 */
export type AuditField<K, C> = (
  id: K,
  field: string,
  before: unknown,
  after: unknown,
  context: C,
) => JournalEntry | null

/**
 * 「上一版 → 本版」逐字段换算成审计条目的通用骨架（域无关）。
 *
 * 只报真变了、且域侧给了口径（`field` 返回非 `null`）的字段。顺序按字段名排（stable）。
 * @param id - 实体 id（原样传给回调）。
 * @param previous - 上一版；`undefined` 时走 `created`。
 * @param next - 本版。
 * @param context - 域侧上下文（原样传给回调）。
 * @param created - `previous === undefined` 时的建记录条目工厂。
 * @param field - 单字段换算回调。
 * @returns 事件条目，按字段名序。
 */
export function diffAuditEntries<K, C>(
  id: K,
  previous: object | undefined,
  next: object,
  context: C,
  created: AuditCreated<K, C>,
  field: AuditField<K, C>,
): JournalEntry[] {
  if (previous === undefined) return created(id, context)
  const out: JournalEntry[] = []
  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (sameAuditValue(before[key], after[key])) continue
    const entry = field(id, key, before[key], after[key], context)
    if (entry !== null) out.push(entry)
  }
  return out
}

/** 域侧 `diffEntries(id, previous, next, context)` 的签名（域门面据此声明公开导出）。 */
export type AuditDiffer<K, V, C> = (id: K, previous: V | undefined, next: V, context: C) => JournalEntry[]

/**
 * 造一个绑定了域回调的 `diffEntries`。域侧只写一行 `export const diffEntries = makeAuditDiff(...)`，
 * 不再复制逐字段迭代骨架（那正是克隆源之一）。
 * @param created - 建记录条目工厂。
 * @param field - 单字段换算回调。
 * @returns 可直接导出的 diff 函数。
 */
export function makeAuditDiff<K, V extends object, C>(
  created: AuditCreated<K, C>,
  field: AuditField<K, C>,
): AuditDiffer<K, V, C> {
  return (id, previous, next, context) => diffAuditEntries(id, previous, next, context, created, field)
}

/** 追加审计条目的能力（域侧传 `ctx.journal.append` 的绑定函数）。 */
export type AuditAppend = (entry: JournalEntry) => number

/** {@link createAuditWriter} 返回的写链句柄。 */
export interface AuditWriterHandle {
  /** 逐条追加；单条失败只记 warn 并继续。 */
  writeAudit(entries: readonly JournalEntry[]): void
  /** 把一次写排进链。 */
  enqueue<T>(job: () => Promise<T>): Promise<T>
  /** 链是否已关闭。 */
  isClosed(): boolean
  /** 标记关闭（关域由域侧自己做）。 */
  markClosed(): void
}

/**
 * 串行写链 + 落审计：把「读上一版 → 落盘 → 写审计」三步锁在同一条 promise 链上。
 *
 * 不串行时两个并发写会交错成「A 读旧 → B 读旧 → A 落 → B 落」，B 的审计基于过期旧值，
 * 顺序与落盘脱节。append 失败只记 warn 不撤销落盘（记录是主，审计是伴生）。
 * @param append - 审计追加能力。
 * @param warn - 失败出声道。
 * @param closedMessage - 关闭后写操作的报错文案（域侧给，带域名）。
 * @returns 写链句柄。
 */
export function createAuditWriter(
  append: AuditAppend,
  warn: (message: string) => void,
  closedMessage: string,
): AuditWriterHandle {
  let chain: Promise<void> = Promise.resolve()
  let closed = false
  const writeAudit = (entries: readonly JournalEntry[]): void => {
    for (const entry of entries) {
      try {
        append(entry)
      } catch (error) {
        warn(`audit append failed (${entry.entity} ${entry.event}): ${auditErrorText(error)}`)
      }
    }
  }
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error(closedMessage))
    const run = chain.then(job)
    chain = run.then(noop, noop)
    return run
  }
  return {
    /** 逐条追加；单条失败只记 warn 并继续。 */
    writeAudit,
    /** 把一次写排进链。 */
    enqueue,
    /** 链是否已关闭。 */
    isClosed: (): boolean => closed,
    /** 标记关闭（关域由域侧自己做）。 */
    markClosed: (): void => { closed = true },
  }
}

/** 写链句柄类型（供域门面声明私有字段；与 {@link AuditWriterHandle} 同义）。 */
export type AuditWriter = AuditWriterHandle

/** enqueue 链上的空操作：吞掉上一任务的拒绝，不毒化后续。 */
const noop = (): void => {}
