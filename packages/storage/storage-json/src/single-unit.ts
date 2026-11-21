/**
 * 一个已打开的 `single` 布局 JSON unit：整个 unit 是 `<root>/<name>.json` 一份文档。
 * 内存状态是权威；每次写原语都改内存并整份原子重发（包括批量删除——改多条只发一次）。
 *
 * **写不在这里排队**：按后端契约，写顺序归调用方（领域层的写链）；本 unit 只保证
 * 单次调用发布一份完整、持久的文件。与 `per-record-unit.ts` 的逐记录布局是两个类。
 *
 * ISS-535 补回（views.json 是第一个 single 消费者）：抄自 DSH
 * `@deepseek-ai/dsh-storage-json/src/single-unit.ts`，逐行适配本仓依赖名与注释语言。
 * `parse` 对损坏文档**出声拒绝**（整单元只有一个文档，坏了整个 unit 不可信）——
 * 正是 views.json「损坏=报错不吞」三态语义的落点。
 * @module @matter/storage-json/src/single-unit
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { KvUnit, KvUnitDescriptor } from "@matter/storage"
import { StorageError } from "@matter/storage"
import { writeAtomic } from "./atomic.ts"
import { parse, serialize } from "./format.ts"
import type { UnitState } from "./format.ts"

/**
 * 在 `root` 下打开一个 `single` 布局 unit：unit 文件是 `<root>/<name>.json`。
 * 文件缺失 = 空 unit（物化推迟到首次写）；文件损坏 = 抛错不吞（parse 出声）。
 * @param descriptor - unit 的静态身份与形状。
 * @param root - 后端根目录绝对路径。
 * @param onClose - 后端回调，释放该 unit 的「已打开」槽位。
 * @returns 已打开的 unit。
 */
export async function openSingleUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  const path = join(root, `${descriptor.name}.json`)
  let text: string | undefined
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // 文件缺失 = 空 unit，不冒绿：不建文件、不造默认内容，物化推迟到首次写。
  }
  const state: UnitState =
    text === undefined
      ? {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map((table) => [table, new Map<string, unknown>()])),
      }
      : parse(text, descriptor)
  // open 不碰盘；下一次整份原子发布用当前戳。
  state.version = descriptor.version
  return new SingleJsonUnit(descriptor, path, state, onClose)
}

/**
 * 一个已打开的 `single` 布局 unit。**内存状态权威**：文件只是投影。
 * 发布失败一律回滚内存，避免拒绝的改动搭上下一次发布便车。
 */
class SingleJsonUnit implements KvUnit {
  private closed = false
  /** 在飞的整份发布；close() 在释放前把它们排干。 */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly path: string,
    private readonly state: UnitState,
    private readonly onClose: () => void,
  ) {}

  // oxlint-disable-next-line typescript/require-await -- async 让关闭守卫走拒绝而不是同步抛
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: this.state.global }
  }

  /**
   * 整份替换一条记录：改内存后整份原子发布；发布失败回滚这一条。
   * @param table - 已声明的表名。
   * @param key - 记录 key（single 布局里是不透明字符串，不做路径校验）。
   * @param value - 不透明的 JSON 可序列化记录。
   */
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    const hadKey = records.has(key)
    const previous = records.get(key)
    records.set(key, value)
    await this.publish().catch((error: unknown) => {
      if (hadKey) records.set(key, previous)
      else records.delete(key)
      throw error
    })
  }

  /**
   * 持久删除一条记录。幂等：不存在的 key 是 no-op（不发布、不推进版本）。
   * @param table - 已声明的表名。
   * @param key - 记录 key。
   */
  deleteRecord(table: string, key: string): Promise<void> {
    return this.deleteRecords(table, [key])
  }

  /**
   * 整份删除一批记录：改内存后**一次**整份发布（single 的「整组写」）；失败全量回滚。
   * @param table - 已声明的表名。
   * @param keys - 记录 key；重复项无害。
   */
  async deleteRecords(table: string, keys: readonly string[]): Promise<void> {
    this.assertOpen()
    const records = this.records(table)
    const removed = new Map<string, unknown>()
    for (const key of new Set(keys)) {
      if (!records.has(key)) continue
      removed.set(key, records.get(key))
      records.delete(key)
    }
    if (removed.size === 0) return
    await this.publish().catch((error: unknown) => {
      for (const [key, value] of removed) records.set(key, value)
      throw error
    })
  }

  /**
   * 整份替换全局单例槽。仅在声明了 `hasGlobal` 时合法。
   * @param value - 不透明的 JSON 可序列化值。
   */
  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new StorageError("invalid-descriptor", `unit '${this.descriptor.name}' does not declare a global slot`)
    }
    const previous = this.state.global
    this.state.global = value
    await this.publish().catch((error: unknown) => {
      this.state.global = previous
      throw error
    })
  }

  /** 排干在飞的写并释放 unit。幂等。 */
  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError("closed", `unit '${this.descriptor.name}' is closed`)
    }
  }

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new StorageError("invalid-descriptor", `unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  /** 把当前内存状态整份原子发布到文件。 */
  private async publish(): Promise<void> {
    const write = writeAtomic(this.path, serialize(this.descriptor.name, this.state))
    this.inFlight.add(write)
    // 只在 tracking 分支吞掉异常：调用方自己 await `write`，拒绝仍只被观察一次。
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}
