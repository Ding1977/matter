/**
 * 活动流：**不可重建的真相源**。
 *
 * 整个 seam 里只有这张表的数据不能重建 —— `search` 与 `edges` 都是它的派生物（见 `search.ts`
 * / `edges.ts` 头注）。所以本文件的两条规矩比别处硬：
 *
 * 1. **唯一写入路径**是 {@link appendJournal}，且它只发一条 `INSERT ... ON CONFLICT(uid) DO NOTHING`。
 *    没有第二条写语句、没有 UPDATE、没有 DELETE —— 事件流是追加型的，回放依赖 seq 单调。
 * 2. **幂等算法逐字照抄**旧树 `forge-pm/lib/pm-store.js:333-350` 的 `activityUid`。
 *    这不是风格选择：迁移脚本与镜像写入**必须共用同一个算法**，否则同一条事件会有两个 uid，
 *    幂等就变成「看起来去重了」—— 现场表现是表里慢慢长出重复行，而没有任何报错。
 *
 * @module storage-journal/src/journal
 */

import { createHash } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import { JournalError } from "./error.ts"

/** 追加一条事件时调用方给的字段。`at` 缺省取 `Date.now()`。 */
export interface JournalEntry {
  /** 事件所属实体（旧树口径：条目 rel 路径，如 `issues/2026-…-ISS-1.md`）。 */
  entity: string
  /** 事件名（旧树词表见 `forge-pm/lib/domain.js` 的 `ACTIVITY_EVENTS`）。 */
  event: string
  /** 触发者；不可自报的通道推导值。 */
  actor?: string | null
  /** 写入时刻（epoch ms）。**不进 uid** —— 重跑一次它的值必然不同。 */
  at?: number
  /** 侧车里的原样时间戳，对账时用来认亲。**进 uid**。 */
  mdAt?: string | null
  /** 词表状态：1 现行 / 2 历史退役 / 0 真未知。缺省 1。 */
  known?: number
  /** 附加键（`from`/`to`/`field`/`body`/…）。除核心列外的一切都归这里，并按 key 排序进 uid。 */
  [extra: string]: unknown
}

/** 读回的一条事件。 */
export interface JournalRow {
  seq: number
  entity: string
  event: string
  actor: string | null
  at: number
  known: number
  payload: Record<string, unknown> | null
  mdAt: string | null
  uid: string | null
}

/** {@link listJournal} 的参数。 */
export interface ListOptions {
  /** 游标：只取 `seq > since`。缺省 0（从头）。 */
  since?: number
  /** 只取这个实体的事件。 */
  entity?: string
  /** 页大小，1~1000，缺省 200（与旧树 `readActivity` 同口径）。 */
  limit?: number
  /** `false` 时只取 `known = 1`。缺省 `true`（未知事件照读，丢审计比脏词表严重）。 */
  includeUnknown?: boolean
}

/** {@link listJournal} 的结果。 */
export interface JournalPage {
  rows: JournalRow[]
  /** 下一页的游标（本页最后一条的 seq；空页则回传入的 since）。 */
  next: number
  /** 本页是否被 limit 截断。 */
  truncated: boolean
}

/**
 * 从事件里抽出「进 uid 的那部分」，按 key 排序序列化成 JSON。
 *
 * 排除项逐字照抄旧树 `stablePayload`：`entity` / `event` / `actor` / `at` / `mdAt` / `uid`。
 * `actor` 不在 uid 里是有意的 —— 同一条 md 事件被两套通道推导出不同 actor 时，
 * 它仍然是**同一条事件**（actor 是推导值，不是事件身份）。
 *
 * @param entry - 待序列化的事件。
 * @returns 稳定序 JSON；没有附加键时 `null`。
 */
export function stablePayload(entry: JournalEntry): string | null {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (key === "entity" || key === "event" || key === "actor" || key === "at" || key === "mdAt" || key === "uid") continue
    if (value === undefined) continue
    payload[key] = value
  }
  if (!Object.keys(payload).length) return null
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(payload).sort()) sorted[key] = payload[key]
  return JSON.stringify(sorted)
}

/**
 * 事件身份证：`sha1(entity|event|md_at|stable_payload)`。
 *
 * **逐字照抄**旧树 `pm-store.js:333-350`。改这四段中的任何一段（分隔符、顺序、缺省值 `""`）
 * 都会让新旧数据认不出彼此 ⇒ 迁移脚本重复跑会写出第二行，而**不会报错**。
 * 判据：`journal.test.ts` 里有一组黄金向量，值与旧树同一输入的实际输出逐字相同。
 *
 * @param entry - 事件。
 * @returns 40 位小写十六进制。
 */
export function activityUid(entry: JournalEntry): string {
  const payload = stablePayload(entry)
  return createHash("sha1")
    .update(`${entry.entity}|${entry.event}|${entry.mdAt ?? ""}|${payload ?? ""}`)
    .digest("hex")
}

/**
 * 追加一条事件（幂等：同 uid 重复写只留一行）。
 *
 * @param db - 已打开的 journal 库。
 * @param entry - 事件。
 * @returns 该事件的 `seq`（冲突时回既有行的 seq —— 幂等 ≠ 假装插进去了）。
 * @throws {@link JournalError} `malformed-event`：缺 `entity` / `event`。
 */
export function appendJournal(db: DatabaseSync, entry: JournalEntry): number {
  if (typeof entry?.entity !== "string" || entry.entity.length === 0) {
    throw new JournalError("malformed-event", "storage-journal: append requires a non-empty 'entity'")
  }
  if (typeof entry.event !== "string" || entry.event.length === 0) {
    throw new JournalError("malformed-event", "storage-journal: append requires a non-empty 'event'")
  }
  const payloadJson = stablePayload(entry)
  const uid = activityUid(entry)
  // ⛔ 本文件唯一的写入语句。改它之前先读头注第 1 条。
  db.prepare(
    `INSERT INTO activity_log(entity, event, actor, at, known, payload_json, md_at, uid)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO NOTHING`,
  ).run(
    entry.entity,
    entry.event,
    entry.actor == null ? null : String(entry.actor),
    Number(entry.at) || Date.now(),
    Number.isFinite(entry.known) ? Number(entry.known) : 1,
    payloadJson,
    entry.mdAt == null ? null : String(entry.mdAt),
    uid,
  )
  // 冲突时上面不产生 lastInsertRowid ⇒ 按 uid 取回既有行的 seq。
  const row = db.prepare("SELECT seq FROM activity_log WHERE uid = ?").get(uid) as { seq: number } | undefined
  if (row === undefined) {
    // 到达这里说明写入被静默丢弃（介质只读 / 触发器吞掉），绝不返回假 seq。
    throw new JournalError("io", `storage-journal: append to '${entry.entity}' produced no row`)
  }
  return Number(row.seq)
}

/**
 * 游标读：`seq > since`，升序。
 *
 * ⚠️ `payload` 的解析失败**不吞**：坏一行的 payload 就抛，而不是把它读成 `null`
 * ——「读回来 → 改 → 写回」把读失败当成「没有」会静默清空已有状态（旧树三条纪律第 1 条）。
 * @param db - 已打开的 journal 库。
 * @param options - 游标 / 过滤 / 页大小。
 * @returns 一页事件。
 */
export function listJournal(db: DatabaseSync, options: ListOptions = {}): JournalPage {
  const since = Number(options.since) || 0
  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 1000)
  const where = ["seq > ?"]
  const args: Array<string | number> = [since]
  if (options.entity) {
    where.push("entity = ?")
    args.push(options.entity)
  }
  if (options.includeUnknown === false) where.push("known = 1")
  const rows = db
    .prepare(
      `SELECT seq, entity, event, actor, at, known, payload_json, md_at, uid
       FROM activity_log WHERE ${where.join(" AND ")} ORDER BY seq ASC LIMIT ?`,
    )
    .all(...args, limit) as Array<Record<string, unknown>>
  return {
    rows: rows.map(toJournalRow),
    next: rows.length ? Number(rows[rows.length - 1]!.seq) : since,
    truncated: rows.length === limit,
  }
}

/** 一行原始 → {@link JournalRow}。payload 解析失败抛（见 {@link listJournal} 的 ⚠️）。 */
function toJournalRow(raw: Record<string, unknown>): JournalRow {
  const payloadJson = raw.payload_json == null ? null : String(raw.payload_json)
  let payload: Record<string, unknown> | null = null
  if (payloadJson !== null) {
    try {
      payload = JSON.parse(payloadJson) as Record<string, unknown>
    } catch (error) {
      throw new JournalError("io", `storage-journal: event seq ${String(raw.seq)} has unparseable payload_json`, {
        cause: error,
      })
    }
  }
  return {
    seq: Number(raw.seq),
    entity: String(raw.entity),
    event: String(raw.event),
    actor: raw.actor == null ? null : String(raw.actor),
    at: Number(raw.at),
    known: Number(raw.known),
    payload,
    mdAt: raw.md_at == null ? null : String(raw.md_at),
    uid: raw.uid == null ? null : String(raw.uid),
  }
}

/** 活动流头部游标（当前最大 seq）；空表为 0。 */
export function headJournal(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(seq) AS head FROM activity_log").get() as { head: number | null } | undefined
  return Number(row?.head ?? 0)
}

/** 活动流总条数（运维口径：与 md 侧车块数对得上才算迁移没漏）。 */
export function countJournal(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM activity_log").get() as { total: number } | undefined
  return Number(row!.total)
}
