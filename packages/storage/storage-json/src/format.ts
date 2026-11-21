/**
 * per-record 落盘格式：**一条记录一个文档**，文档形如 `{version, record}`，
 * 与整单元格式（`{unit, global, tables}`）不同 —— 每条记录自带版本戳，
 * 才能做到「一条坏文件只丢这一条」而不是拖垮整个 unit。
 *
 * 只保留 per-record 需要的两个函数：`serialize`/`parse`（整单元单文档）属于
 * `single` 布局，本包不实现该布局（ISS-510 · 无消费者），故不抄。
 *
 * 抄自 DSH `@deepseek-ai/dsh-storage-json/src/format.ts` 的对应函数。
 * 整单元单文档的 `serialize` / `parse` 在 ISS-535 补回（views.json 是第一个消费者）：
 * 此前 Matter 只实现 per-record，故未抄；现在 single layout 有了当前所有者与需求。
 * @module @matter/storage-json/src/format
 */

import { StorageError } from "@matter/storage"
import type { KvUnitDescriptor } from "@matter/storage"

/** 一个 unit 由目录树重建出的权威状态；`global` 在首次写入前为 `null`。 */
export interface UnitState {
  /** 该 unit 当前声明的格式版本。 */
  version: number
  /** 全局单例槽的值。 */
  global: unknown
  /** 表名 → (记录 key → 记录值)。 */
  tables: Map<string, Map<string, unknown>>
}

/**
 * 序列化整单元单文档（single layout）：文件是持久状态，美化输出供人读。
 *
 * 抄自 DSH `@deepseek-ai/dsh-storage-json/src/format.ts:28-39`（逐行适配本仓依赖名）。
 * @param name - unit 名，写进文档头。
 * @param state - 权威内存状态。
 * @returns 带结尾换行的美化 JSON 文档。
 */
export function serialize(name: string, state: UnitState): string {
  const tables: Record<string, Record<string, unknown>> = {}
  for (const [table, records] of state.tables) {
    tables[table] = Object.fromEntries(records)
  }
  const document = {
    unit: { name, version: state.version },
    global: state.global,
    tables,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * 解析整单元单文档（single layout），校验形状与版本。
 *
 * **整单元格式损坏必须出声拒绝**（`malformed-medium` / `version-mismatch`），
 * 与 per-record「一条坏记录读作不存在」相反：single 只有一个文档，损坏意味着整个 unit 不可信。
 * 抄自 DSH `@deepseek-ai/dsh-storage-json/src/format.ts:47-91`。
 * @param text - 文档原文。
 * @param descriptor - 期望的身份与可接受版本（当前 + compatibleVersions）。
 * @returns 解析出的权威状态。
 */
export function parse(text: string, descriptor: KvUnitDescriptor): UnitState {
  const document = parseDocument(text, descriptor.name)
  const { unit, global: globalValue, tables } = document
  const version = readVersion(unit, descriptor)
  // typeof 收得下数组：把数组当表映射读会让每张声明表缺席，下一次整份发布就抹掉数据。
  const tableMap = asRecord(tables, `unit '${descriptor.name}': tables is not an object`)
  const state: UnitState = { version, global: globalValue ?? null, tables: new Map() }
  for (const table of descriptor.tables) {
    state.tables.set(table, parseTableRecords(tableMap[table], table, descriptor.name))
  }
  return state
}

/** JSON.parse + 顶层对象校验。 */
function parseDocument(text: string, name: string): Record<string, unknown> {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new StorageError("malformed-medium", `unit '${name}': file is not valid JSON`, { cause: error })
  }
  if (typeof document !== "object" || document === null) {
    throw new StorageError("malformed-medium", `unit '${name}': file is not a JSON object`)
  }
  return document as Record<string, unknown>
}

/** 读 unit 头并校验身份与版本。 */
function readVersion(unit: unknown, descriptor: KvUnitDescriptor): number {
  const header = asRecord(unit, `unit '${descriptor.name}': missing or foreign unit header`)
  if (header["name"] !== descriptor.name || typeof header["version"] !== "number") {
    throw new StorageError("malformed-medium", `unit '${descriptor.name}': missing or foreign unit header`)
  }
  const version = header["version"] as number
  if (version !== descriptor.version && !descriptor.compatibleVersions?.includes(version)) {
    throw new StorageError(
      "version-mismatch",
      `unit '${descriptor.name}': stored version ${version} is not accepted by version ${descriptor.version}`,
    )
  }
  return version
}

/** 把一张声明表的记录值读成 Map；缺表 = 空 Map，非法值出声拒绝。 */
function parseTableRecords(records: unknown, table: string, name: string): Map<string, unknown> {
  if (records === undefined) return new Map()
  if (typeof records !== "object" || records === null || Array.isArray(records)) {
    throw new StorageError("malformed-medium", `unit '${name}': table '${table}' is not an object`)
  }
  return new Map(Object.entries(records as Record<string, unknown>))
}

/** 断言一个 unknown 是普通对象（非 null、非数组），否则抛 malformed-medium。 */
function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageError("malformed-medium", message)
  }
  return value as Record<string, unknown>
}

/**
 * 序列化一条 per-record 文档：unit 的版本戳 + 记录值，与整单元文档一样美化输出
 * （为什么美化：可读性是这个后端存在的理由之一）。
 * @param version - unit 的格式版本，写入文档头。
 * @param value - 记录值（或全局单例值）。
 * @returns 美化后的 JSON，带结尾换行。
 */
export function serializeRecord(version: number, value: unknown): string {
  return `${JSON.stringify({ version, record: value }, null, 2)}\n`
}

/**
 * 解析一条 per-record 文档并校验版本戳。
 *
 * **坏文件与版本不符都读作不存在**（返回 `undefined`），不抛 —— 这是 per-record 契约：
 * 一条坏/旧记录不能拖垮整个 unit，且**不接受的版本戳丢弃而非迁移**
 * （整单元格式相反：那里只有一个文档，损坏必须拒绝）。
 * @param text - per-record 文档原文。
 * @param versions - 可接受的版本集合（当前版本 + `compatibleVersions`）；其它戳一律丢弃。
 * @returns 记录值；对「外来文档」返回 `undefined`。
 */
export function parseRecord(text: string, versions: readonly number[]): unknown {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof document !== "object" || document === null) return undefined
  const { version: stamped, record } = document as Record<string, unknown>
  if (typeof stamped !== "number" || !versions.includes(stamped)) return undefined
  return record
}
