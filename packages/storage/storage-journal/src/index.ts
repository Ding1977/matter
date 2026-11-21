/**
 * 活动流 seam（`ctx.journal`）：**自开 DB，不 import storage hub 包**。
 *
 * ## 为什么这是「另一个 seam」而不是往 hub 加一个 facet
 *
 * storage hub 包的 `StorageBackend.kv` 是**可省略**的成员，DSH 原文写「后端不能服务某种数据形状
 * 就省略它」。而 `storage-sqlite` 的 `kv` facet 物理形态是硬编码的
 * `u_<unit>_<table>(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`，`db` 句柄私有
 * ⇒ 加列 / 建索引 / 建 FTS5 都没有入口（DOC-514 §3 岔路① 的实测记录：用 `u_` 前缀建 FTS5 虚表，
 * DDL 被 `IF NOT EXISTS` 放行，第一条 upsert 就崩）。
 *
 * DSH 自己的 FTS5 先例 `session-query-sqlite` 也不 import `dsh-storage`：它是独立 seam，
 * 自建 `application_id` / `SCHEMA_VERSION` / `resetDerivedSchema`。本包照那个形态办。
 *
 * ## 三层，一个真相源 + 两个派生物
 *
 * | 件 | 性质 | 能不能重建 |
 * |---|---|---|
 * | `activity_log`（`journal.ts`） | **不可重建真相源** | ✗ 丢了就没了 |
 * | `pm_search`（`search.ts`） | 派生物 | ✓ `rebuild()` 从 `activity_log` 重灌 |
 * | `edges`（`edges.ts`） | 派生物 | ✓ `rebuild()` 从 `activity_log` 重算 |
 *
 * ⇒ 派生物**无独立契约、无独立版本轴**（硬约束 ③）。`resetDerivedSchema()` 能随时丢掉它们，
 * `rebuild()` 一句话回来。
 *
 * ## ⚠️ 本包的文档注释里**不写 storage hub 包的包名**（不是排版洁癖）
 *
 * 工单 `## 验收` 第 5 条是**字面** `grep -c "<hub 包名>" packages/storage/storage-journal/src/*.ts`
 * ⇒ 0。而那个 hub 包的包名**恰好是本包包名的前缀**，于是「在注释里写自己包名」「写 hub 包名」
 * 两件事在同一条判据眼里**长得一模一样**。
 *
 * 本包的处置：注释里一律称「storage hub 包」，`@module` 标只写短名。这样那条判据与
 * 它真正想问的（「有没有 import 它」）**恰好一致**。
 * ⛔ 判据本身有缺陷（它分不开前缀与包名）—— 已在交付说明里报 Lead，本文件不改判据。
 *
 * @module storage-journal
 */

import type { Context } from "@deepseek-ai/cordis"
import type { DatabaseSync } from "node:sqlite"
import { JournalError } from "./error.ts"
import type { JournalErrorCode } from "./error.ts"
import {
  appendJournal,
  countJournal,
  headJournal,
  listJournal,
  type JournalEntry,
  type JournalPage,
  type ListOptions,
} from "./journal.ts"
import { JOURNAL_SCHEMA_VERSION, openJournalDatabase, readIdentity, resetDerivedSchema } from "./schema.ts"
import type { JournalIdentity, JournalMode } from "./schema.ts"
import {
  countIndexed,
  indexDelta,
  projectRow,
  rebuildSearch,
  reconcileSearch,
  searchText,
  type IndexEntry,
  type SearchOptions,
  type SearchResult,
} from "./search.ts"
import { countEdges, incomingEdges, outgoingEdges, rebuildEdges, type JournalEdge } from "./edges.ts"

export { JournalError } from "./error.ts"
export type { JournalErrorCode } from "./error.ts"
export {
  AUDIT_VALUE_MAX,
  auditValue,
  sameAuditValue,
  sameAuditRecord,
  auditErrorText,
  makeAuditEntry,
  diffAuditEntries,
  makeAuditDiff,
  createAuditWriter,
} from "./audit.ts"
export type { AuditField, AuditCreated, AuditDiffer, AuditAppend, AuditWriterHandle, AuditWriter } from "./audit.ts"
export { AuditFacility } from "./facility.ts"
export type { AuditTableLike, AuditDomainLike, AuditAppendLike, AuditFacilitySpec } from "./facility.ts"
export { activityUid, appendJournal, countJournal, headJournal, listJournal, stablePayload } from "./journal.ts"
export type { JournalEntry, JournalRow, JournalPage, ListOptions } from "./journal.ts"
export { JOURNAL_APPLICATION_ID, JOURNAL_SCHEMA_VERSION, openJournalDatabase, readIdentity, resetDerivedSchema } from "./schema.ts"
export type { JournalIdentity, JournalMode } from "./schema.ts"
export { countIndexed, indexDelta, projectRow, reconcileSearch, rebuildSearch, searchText, toMatchQuery } from "./search.ts"
export type { IndexEntry, SearchHit, SearchOptions, SearchResult } from "./search.ts"
export { countEdges, incomingEdges, outgoingEdges, rebuildEdges } from "./edges.ts"
export type { JournalEdge } from "./edges.ts"

/** Cordis 插件名。 */
export const name = "storage-journal"

/**
 * ⛔ **空的**：本包**不**依赖 storage hub 包，也不依赖任何 Provider。
 *
 * 这是「另一个 seam」的接线形态 —— 它不是 hub 上的表单（`StorageForms`），
 * 是一个自带介质、自带生命周期的服务。写成 `[]` 而不是省略，是因为
 * 省略与「还没想」在代码里长得一样；写了空数组，下一个人能看出这是决定。
 */
export const inject: string[] = []

/**
 * 插件配置。
 *
 * `root` **故意无默认值**：退回 `process.cwd()` 会把库散落到进程碰巧启动的任何目录
 * （`storage-json` 的同一判断，`storage-json/src/index.ts:47-53`）。
 */
export interface Config {
  /** 存放 `journal.db` 的目录。必填。 */
  root: string
  /** SQLite journal 模式，缺省 `wal`。 */
  journalMode?: JournalMode
}

/**
 * 校验并归一化配置。加载期**立即失败**，不静默回退默认值。
 * @param raw - 装配点传入的原始配置。
 * @returns 已校验的配置。
 * @throws {@link JournalError} `io`：`root` 不是非空字符串或 `journalMode` 不在闭联合内。
 */
export function normalizeConfig(raw: Config): Config {
  const root = (raw as { root?: unknown } | undefined)?.root
  if (typeof root !== "string" || root.length === 0) {
    throw new JournalError("io", "storage-journal: config.root must be a non-empty string")
  }
  const mode = (raw as { journalMode?: unknown }).journalMode
  if (mode !== undefined && !["wal", "delete", "truncate", "persist"].includes(String(mode))) {
    throw new JournalError("io", `storage-journal: config.journalMode must be one of wal|delete|truncate|persist (got ${String(mode)})`)
  }
  return { root, journalMode: mode as JournalMode | undefined }
}

/** 库文件名（在 `Config.root` 下）。 */
export const JOURNAL_FILE = "journal.db"

/**
 * 挂载在 `ctx.journal` 上的 facility：本 seam 唯一的对外面。
 *
 * 三组方法对应三件东西，**不混淆性质**：
 * - `append` / `list` / `head` / `count` —— 真相源；
 * - `search` / `rebuildSearch` —— 派生物（可从 `list` 全量重算）；
 * - `edges` —— 派生物（同上）。
 */
export class JournalFacility {
  private closed = false

  /**
   * @param db - 已打开的 journal 库（由 {@link openJournalFacility} 建好）。
   * @param path - 库的实际路径，诊断用。
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly path: string,
  ) {}

  /** 库的实际路径（`journal.db` 或 `:memory:`）。 */
  get databasePath(): string {
    return this.path
  }

  /** 追加一条事件（幂等）。@returns 该事件的 seq。 */
  append(entry: JournalEntry): number {
    return appendJournal(this.usable(), entry)
  }

  /** 游标读。@returns 一页事件。 */
  list(options: ListOptions = {}): JournalPage {
    return listJournal(this.usable(), options)
  }

  /** 头部游标（当前最大 seq；空表 0）。 */
  head(): number {
    return headJournal(this.usable())
  }

  /** 事件总条数。 */
  count(): number {
    return countJournal(this.usable())
  }

  /** 全文检索（派生物；未建索引时返回空结果，不抛）。 */
  search(options: SearchOptions): SearchResult {
    return searchText(this.usable(), options)
  }

  /** 以实体为起点的边。 */
  edges(entity: string, kind?: string): JournalEdge[] {
    return outgoingEdges(this.usable(), entity, kind)
  }

  /** 指向实体的边（反向入口）。 */
  inboundEdges(entity: string, kind?: string): JournalEdge[] {
    return incomingEdges(this.usable(), entity, kind)
  }

  /** 索引与真相源的双向差集（诊断用；`{missing:[],orphaned:[]}` = 一致）。 */
  searchDelta(): { missing: number[]; orphaned: number[] } {
    return indexDelta(this.usable())
  }

  /** 派生物现状（诊断 / 测试用）。 */
  stats(): { events: number; indexed: number; edges: number; schemaVersion: number } {
    const db = this.usable()
    return {
      events: countJournal(db),
      indexed: countIndexed(db),
      edges: countEdges(db),
      schemaVersion: readIdentity(db).schemaVersion,
    }
  }

  /**
   * 从真相源重建**两个**派生物（全文索引 + 边表）。
   *
   * 一个方法而不是两个，是因为它们共享同一个输入（`activity_log`）与同一条不变量
   * （「派生层能随时丢掉重生」）。分开两个入口会让「只重建了一半」成为可达状态。
   * @returns 重建后的 `{indexed, edges}`。
   */
  rebuild(): { indexed: number; edges: number } {
    const db = this.usable()
    const entries = this.projectAll(db)
    const indexed = rebuildSearch(db, entries)
    const edges = rebuildEdges(db)
    return { indexed, edges }
  }

  /** 补缺（不整表重灌）。@returns `{indexed, evicted}`。 */
  reconcile(): { indexed: number; evicted: number } {
    const db = this.usable()
    return reconcileSearch(db, this.projectAll(db))
  }

  /**
   * 丢掉两个派生物并重建空表（不碰真相源）。`rebuild()` 之前 `search` 返回空结果。
   * @returns 重置前的派生物条数，供调用方比对。
   */
  resetDerived(): { indexed: number; edges: number } {
    const db = this.usable()
    const before = { indexed: countIndexed(db), edges: countEdges(db) }
    resetDerivedSchema(db)
    return before
  }

  /** 库身份三元组（诊断用）。 */
  identity(): JournalIdentity {
    return readIdentity(this.usable())
  }

  /** 关闭库。幂等；之后任何读写抛 `closed`。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  /** 把真相源全量投影成索引行（`rebuild` / `reconcile` 的唯一输入）。 */
  private projectAll(db: DatabaseSync): IndexEntry[] {
    return this.readAllForIndex(db)
  }

  /**
   * 索引投影需要的是**全部**事件，不分页 —— 但 `listJournal` 单页上限 1000。
   * 故这里直接一条 SQL 而不是循环分页：循环分页在并发写入下会漏行（游标会跳过插入点）。
   * @param db - 库。
   * @returns 全部索引行。
   */
  private readAllForIndex(db: DatabaseSync): IndexEntry[] {
    const rows = db
      .prepare("SELECT seq, entity, event, actor, payload_json FROM activity_log ORDER BY seq ASC")
      .all() as Array<{ seq: number; entity: string; event: string; actor: string | null; payload_json: string | null }>
    return rows.map((row) => projectRow({ ...row, known: 1, payload: parsePayload(row.payload_json) }))
  }

  /** 已释放的句柄一律抛 `closed`（不返回空集合 —— 那是「读成功但没有」，会静默清空调用方状态）。 */
  private usable(): DatabaseSync {
    if (this.closed) throw new JournalError("closed", "storage-journal: this journal handle is closed")
    return this.db
  }
}

/** payload 的宽容解析：索引投影里坏 payload 当空对象（`listJournal` 那条路径仍然抛）。 */
function parsePayload(payloadJson: string | null): Record<string, unknown> | null {
  if (payloadJson === null) return null
  try {
    return JSON.parse(payloadJson) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 打开一个 journal facility。
 *
 * ⚠️ 宿主必须自己持有返回值并负责 `close()`（通常作为 `ctx.effect` 的 disposer）。
 * 本函数不注册任何 effect —— 它也可被测试 / 脚本直接调用，不要求 cordis 上下文。
 * @param root - 库目录，或 `:memory:`（测试用；此时不建目录）。
 * @param journalMode - SQLite journal 模式，缺省 `wal`。
 * @returns 已打开的 facility。
 */
export async function openJournalFacility(root: string, journalMode?: JournalMode): Promise<JournalFacility> {
  const path = root === ":memory:" ? ":memory:" : `${root.replace(/\/+$/, "")}/${JOURNAL_FILE}`
  const db = await openJournalDatabase(path, journalMode)
  return new JournalFacility(db, path)
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** The activity journal seam: append-only event log plus its two derived views. */
    journal: JournalFacility
  }
}

/**
 * 挂载 journal seam：建库 → `ctx.provide("journal", …)`，卸载时关库。
 *
 * 注册即副作用（`ctx.effect()`），返回的 disposer 关库并摘掉服务键 ——
 * 与 `storage-json` 的注销顺序同理：先摘名字，再关介质。
 * @param ctx - 插件上下文。
 * @param rawConfig - 原始配置，经 {@link normalizeConfig} 校验。
 * @returns 激活完成的 promise。
 */
export function apply(ctx: Context, rawConfig: Config): Promise<void> {
  const config = normalizeConfig(rawConfig)
  return openJournalFacility(config.root, config.journalMode).then((facility) => {
    ctx.effect(() => {
      const dispose = ctx.provide("journal", facility)
      return () => {
        dispose()
        facility.close()
      }
    })
  })
}

/** 供诊断脚本复用的错误码清单（运行时可见，不只是类型）。 */
export const JOURNAL_ERROR_CODES: readonly JournalErrorCode[] = ["foreign-database", "closed", "malformed-event", "io"]
