/**
 * 一个已打开的 JSON unit，`per-record` 布局：unit 是 `dir` 下的一个目录，
 * 每条记录一个文档 —— `<dir>/<table>/<key>.json`，全局单例槽是 `<dir>/global.json`。
 *
 * **目录即状态**：本 unit 自己不持有任何内存状态。`loadAll` 每次重读目录树，
 * 每次 put/delete 只动一个持久文档，批量删除先把文档 rename 出可读集再 unlink。
 * 活跃的内存表归领域层所有（由打开时的 `loadAll` 播种），写顺序也由领域层的写链保证。
 * 被拒的写不改变领域内存；失败的删除要么还原它暂存的文档，要么用 `unknown-state`
 * 隔离整个 unit。
 *
 * per-record 契约：**损坏的或版本戳不在可接受集合内的记录文档读作不存在** ——
 * 一个坏文件或旧文件永远不拖垮整个 unit，不接受的版本戳**丢弃而非迁移**。
 * 记录 key 会变成路径段，故必须路径安全（`[a-zA-Z0-9_-]+`）；不安全的 key **写前**拒绝。
 *
 * 抄自 DSH `@deepseek-ai/dsh-storage-json/src/per-record-unit.ts`。
 * **不含 legacy bootstrap**：整单元文件 `<root>/<name>.json` 是 `single` 布局的产物，
 * 本仓从未发布过 `single` 布局（一期只有 per-record），没有要迁移的旧数据 ——
 * 「每个抽象必须有当前所有者与需求」，故不抄（判断见交付说明）。
 * @module @matter/storage-json/src/per-record-unit
 */

import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Dirent } from "node:fs"
import { StorageError } from "@matter/storage"
import type { KvUnit, KvUnitDescriptor } from "@matter/storage"
import { fsyncDirectory, writeAtomic } from "./atomic.ts"
import { parseRecord, serializeRecord } from "./format.ts"
import type { UnitState } from "./format.ts"

/** 本布局里 key 会变成路径段；本集合在每个 OS 上都路径安全。 */
export const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

/**
 * 在 `root` 下打开一个 `per-record` 布局的 unit：unit 目录是 `<root>/<name>/`。
 * 首次 `loadAll` 才真正读盘 —— 本 unit 不持状态，打开时不碰介质。
 * @param descriptor - unit 的静态身份与形状。
 * @param root - 后端的根目录绝对路径。
 * @param onClose - 后端回调，释放该 unit 的「已打开」槽位。
 * @returns 已打开的 unit。
 */
// oxlint-disable-next-line typescript/require-await -- async 让两个 opener 的调用点形态一致
export async function openPerRecordUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  return new PerRecordJsonUnit(descriptor, join(root, descriptor.name), onClose)
}

/**
 * 从 unit 目录读出全部记录文档：每张声明表下的 `<key>.json`，加 `global.json`。
 * 目录不存在即空 unit（物化推迟到首次写入）；外来文档（缺失、损坏、版本戳不被接受）
 * 按 per-record 契约读作不存在的记录。
 * @param descriptor - unit 的静态身份与形状。
 * @param dir - unit 目录的绝对路径。
 * @returns 由目录树重建出的权威状态。
 */
async function loadPerRecordState(descriptor: KvUnitDescriptor, dir: string): Promise<UnitState> {
  const versions = acceptedStamps(descriptor)
  const state: UnitState = {
    version: descriptor.version,
    global: null,
    tables: new Map(descriptor.tables.map((table) => [table, new Map<string, unknown>()])),
  }
  let entries: Dirent[] | undefined
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // 目录不存在 = 空 unit。
  }
  if (entries !== undefined) {
    await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) {
        const records = state.tables.get(entry.name)
        if (records !== undefined) {
          await loadTableRecords(records, versions, join(dir, entry.name))
        }
        return
      }
      if (entry.name === "global.json" && descriptor.hasGlobal) {
        const global = await readRecord(join(dir, entry.name), versions)
        if (global !== undefined) state.global = global
      }
    }))
  }
  return state
}

/** 本 unit 视作自己的版本戳：当前版本加声明的 `compatibleVersions`。 */
function acceptedStamps(descriptor: KvUnitDescriptor): readonly number[] {
  return [descriptor.version, ...descriptor.compatibleVersions ?? []]
}

/** 把一张声明表的记录文档读进 `records`。 */
async function loadTableRecords(records: Map<string, unknown>, versions: readonly number[], dir: string): Promise<void> {
  const files = await readdir(dir, { withFileTypes: true })
  const loaded = await Promise.all(files.map(async (file) => {
    if (!file.name.endsWith(".json")) return
    const key = file.name.slice(0, -".json".length)
    if (!SAFE_KEY_RE.test(key)) return
    const record = await readRecord(join(dir, file.name), versions)
    if (record !== undefined) return [key, record] as const
  }))
  for (const record of loaded) {
    if (record !== undefined) records.set(...record)
  }
}

/** 读一条记录文档；外来（读不了或过期）的读作不存在。 */
async function readRecord(path: string, versions: readonly number[]): Promise<unknown> {
  try {
    return parseRecord(await readFile(path, "utf8"), versions)
  } catch {
    return undefined
  }
}

/**
 * 一个已打开的 `per-record` 布局 unit。**设计上无状态**：目录是介质，
 * 活跃内存归领域层。替换发布一个文档；删除先暂存并 sync 再清理。
 * 写顺序归调用方（领域层的写链）。
 */
export class PerRecordJsonUnit implements KvUnit {
  private closed = false
  /** 一次失败批量删除无法还原暂存文档时被置位。 */
  private unusable: StorageError | undefined
  /** 在飞的持久写；`close()` 在释放 unit 前把它们排干。 */
  private readonly inFlight = new Set<Promise<void>>()

  /**
   * @param descriptor - unit 的静态身份与形状。
   * @param dir - unit 目录的绝对路径。
   * @param onClose - 释放后端「已打开」槽位的回调。
   */
  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly dir: string,
    private readonly onClose: () => void,
  ) {}

  /**
   * 重读目录树：目录就是权威状态。
   * @returns 每张表的记录（按表名索引）以及全局单例槽。
   */
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const state = await loadPerRecordState(this.descriptor, this.dir)
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: state.global }
  }

  /**
   * 持久替换一条记录：只写它自己的文档，原子发布。
   * @param table - 已声明的表名。
   * @param key - 记录 key，必须路径安全（不安全则**写前**拒绝）。
   * @param value - 不透明的 JSON 可序列化记录。
   */
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    await this.tracked(this.writeDocument(join(this.tableDir(table), `${key}.json`), value))
  }

  /**
   * 持久删除一条记录。幂等：不存在的 key 是 no-op。
   * @param table - 已声明的表名。
   * @param key - 记录 key。
   */
  deleteRecord(table: string, key: string): Promise<void> {
    return this.deleteRecords(table, [key])
  }

  /**
   * 作为一批持久删除多条记录。先把文档 rename 出可读集，整批暂存完成后才 unlink。
   * 暂存阶段失败会把它已移动的文档还原，故拒绝通常意味着整批未生效。
   * 若还原本身失败，可读或持久状态未知：unit 以 `unknown-state` 拒绝，
   * 之后每次操作都拒绝，而 `close` 仍可释放它。
   * POSIX 上暂存的目录变化在清理前 sync，故已 resolve 的删除在崩溃后仍然缺失。
   * 清理残渣不可读（`open` 只读 `*.json` 文档）。
   * @param table - 已声明的表名。
   * @param keys - 记录 key；重复项无害。
   */
  async deleteRecords(table: string, keys: readonly string[]): Promise<void> {
    this.assertOpen()
    const dir = this.tableDir(table)
    const unique = [...new Set(keys)]
    for (const key of unique) assertSafeKey(this.descriptor.name, key)
    // 暂存、还原、清理一起 track，让 close() 能排干它们。
    await this.tracked(this.removeDocuments(dir, unique))
  }

  /**
   * 在一个被 track 的 promise 内移除一批文档。
   * @param dir - 已声明的表目录。
   * @param keys - 已校验、已去重的记录 key。
   */
  private async removeDocuments(dir: string, keys: readonly string[]): Promise<void> {
    const staged: Array<{ from: string; to: string }> = []
    try {
      for (const key of keys) {
        const from = join(dir, `${key}.json`)
        const to = `${from}.deleting`
        try {
          await rename(from, to)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
          throw error
        }
        staged.push({ from, to })
      }
      if (staged.length > 0) await fsyncDirectory(dir)
    } catch (error: unknown) {
      const restoreFailures: unknown[] = []
      for (const { from, to } of staged) {
        try {
          await rename(to, from)
        } catch (restoreError: unknown) {
          restoreFailures.push(restoreError)
        }
      }
      if (staged.length > 0) {
        try {
          await fsyncDirectory(dir)
        } catch (restoreError: unknown) {
          restoreFailures.push(restoreError)
        }
      }
      if (restoreFailures.length === 0) throw error
      this.unusable = new StorageError(
        "unknown-state",
        `unit '${this.descriptor.name}' could not restore a failed batch delete; its state is unknown`,
        { cause: new AggregateError([error, ...restoreFailures], "batch delete failed and restoration failed") },
      )
      throw this.unusable
    }
    // rename 已把这一批移出可读集；unlink 只是清理，失败也只留下不可读的文件而非可读条目。
    await Promise.allSettled(staged.map(({ to }) => rm(to, { force: true })))
  }

  /**
   * 把一条记录的文档移开成 `<key>.json.bak.<YYYYMMDDHHmm>`。
   * 移后文件名不再以 `.json` 结尾，故之后任何读取都会忽略它；字节留在盘上待查。
   * 同一分钟内对同一 key 的再次备份会覆盖上一次（较新的字节更值得留）。
   * @param table - 已声明的表名。
   * @param key - 记录 key，必须路径安全。
   * @returns 文档被移到的介质位置（诊断用）。
   */
  async backupRecord(table: string, key: string): Promise<string> {
    this.assertOpen()
    assertSafeKey(this.descriptor.name, key)
    const path = join(this.tableDir(table), `${key}.json`)
    const moved = `${path}.bak.${backupStamp(new Date())}`
    await this.tracked(rename(path, moved))
    return moved
  }

  /**
   * 持久替换全局单例。仅在声明了 `hasGlobal` 时合法。
   * @param value - 不透明的 JSON 可序列化值。
   */
  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new StorageError("invalid-descriptor", `unit '${this.descriptor.name}' does not declare a global slot`)
    }
    await this.tracked(this.writeDocument(join(this.dir, "global.json"), value))
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
    if (this.unusable !== undefined) throw this.unusable
  }

  /** 解析一张声明表的目录；未声明的表是调用方 bug，抛错。 */
  private tableDir(table: string): string {
    if (!this.descriptor.tables.includes(table)) {
      throw new StorageError("invalid-descriptor", `unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return join(this.dir, table)
  }

  /** 持久替换一个文档，按需创建父目录。 */
  private async writeDocument(path: string, value: unknown): Promise<void> {
    const text = serializeRecord(this.descriptor.version, value)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeAtomic(path, text)
  }

  /** track 一个持久写，让 close() 能排干它。 */
  private tracked(write: Promise<void>): Promise<void> {
    this.inFlight.add(write)
    // 只在 tracking 分支吞掉异常：调用方自己 await `write`，拒绝仍只被观察一次。
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}

/** 本地时间 `YYYYMMDDHHmm` 后缀，用于被备份的文档。 */
function backupStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** 拒绝一个会作为路径段而不安全的记录 key。 */
function assertSafeKey(unit: string, key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new StorageError("malformed-medium", `unit '${unit}': per-record key '${key}' is not path-safe (must match ${SAFE_KEY_RE})`)
  }
}
