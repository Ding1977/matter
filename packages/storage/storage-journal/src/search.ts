/**
 * 全文检索：**派生物**，不是真相源。
 *
 * ## 这一层的三条约束（与 `journal.ts` 的差别，别读串）
 *
 * 1. **无独立契约**：`pm_search` 的形状不是对外承诺。调用方只看见 `search()` / `rebuild()`，
 *    看不见表结构。什么时候重建、建成什么样，是本文件的私事。
 * 2. **无独立版本轴**：`pm_search` **不**有自己的 `user_version` / `application_id` / 版本列。
 *    它的版本就是 `journal_meta.version`（`schema.ts`），升版本时连同 `edges` 一起丢掉重建。
 * 3. **只由 journal 重建**：`rebuild()` 的输入**只有** `activity_log`。没有任何「只有索引知道」
 *    的东西 —— 这就是「DROP 之后能原样回来」的机器保证。
 *
 * ## 为什么 rowid 用 `seq`
 *
 * 让「索引里有没有这一条」变成一次集合差：`pm_search.rowid` ↔ `activity_log.seq`。
 * 缺行 = `seq NOT IN rowid`，孤行 = `rowid NOT IN seq`。没有第二个 id 要维护，
 * 也就不存在「两个 id 漂移」这一类错。FTS5 允许显式写 `rowid`（实测）。
 *
 * ## 中文为什么必须 trigram
 *
 * FTS5 默认 `unicode61` 把一整串 CJK 当一个 token ⇒ 中文子串一个都命不中。`trigram` 按三字符切，
 * 中英文子串都能命中；代价是**查询串必须 ≥3 字符**，两字中文词（「派单」「审查」）切不出词元，
 * 故短串走 `LIKE` 兜底（仍在库内，不回落成读全表到 JS 里过滤）。
 *
 * @module storage-journal/src/search
 */

import type { DatabaseSync } from "node:sqlite"

/** 一条检索命中。 */
export interface SearchHit {
  /** 事件 seq（与 `activity_log.seq` 同值）。 */
  seq: number
  /** 实体（命中点的落点，调用方拿它去打开条目）。 */
  entity: string
  /** 标题片段（`<b>` 包住命中词）。 */
  titleSnippet: string
  /** 正文片段（`<b>` 包住命中词）。 */
  bodySnippet: string
  /** 相关性（bm25，越小越相关；`like` 模式下是 0/1 的粗排）。 */
  rank: number
}

/** 检索结果。`mode` 说清这次走的是哪条路径（诊断与测试都要它）。 */
export interface SearchResult {
  hits: SearchHit[]
  mode: "fts" | "like" | "empty"
}

/** {@link searchText} 的参数。 */
export interface SearchOptions {
  /** 查询串。空串直接回空结果，不查库。 */
  query: string
  /** 命中上限，1~200，缺省 30。 */
  limit?: number
}

/** trigram 索引最少需要的查询长度；短于此走 LIKE。 */
const TRIGRAM_MIN = 3
/** 高亮标记（与旧树 `snippet(...)` 的同一对）。 */
const HL_START = "<b>"
const HL_END = "</b>"

/**
 * 把一条事件投影成索引行（三列：标题 / 正文 / 结构化键）。
 *
 * 投影规则（**故意窄**）：标题 = 实体路径的最后一段，正文 = `payload.body`，
 * 键 = `event` + `actor` + payload 里除 `body` 外的标量值。评论正文以外的活动事件不进正文，
 * 免得「改一次状态」把整条实体重切一遍（旧树 `search-index.js` 头注 §覆盖范围 的同一判断）。
 *
 * @param row - 一条 journal 行。
 * @returns 三列值。
 */
export function projectRow(row: {
  seq: number
  entity: string
  event: string
  actor: string | null
  known: number
  payload: Record<string, unknown> | null
}): IndexEntry {
  const payload = row.payload ?? {}
  // `entity` 进索引但 `UNINDEXED`：它是命中点的**落点**（调用方拿它去打开条目），
  // 不是检索面。标题取路径最后一段，给 `snippet()` 一个短的展示字段。
  // split("/") 至少产出一个元素 ⇒ pop() 不会是 undefined，右侧回退是死代码。
  const title = row.entity.split("/").pop()!
  const body = typeof payload.body === "string" ? payload.body : ""
  const keys = [row.event, row.actor ?? "", ...scalarValues(payload)]
    .filter((part) => part.length > 0)
    .join(" ")
  return { seq: row.seq, entity: row.entity, title, body, keys }
}

/** payload 里除 `body` 外的标量值（数组按元素摊平，嵌套对象不收 —— 它们不是检索面）。 */
function scalarValues(payload: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (key === "body") continue
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.push(String(value))
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" || typeof item === "number") out.push(String(item))
      }
    }
  }
  return out
}

/** 一条已投影的索引行（`rebuild` / `reconcile` 的内部输入）。 */
export interface IndexEntry {
  /** 事件 seq；同时用作 FTS5 的 `rowid`（让「索引有没有这一条」变成一次集合差）。 */
  seq: number
  /** 命中点的落点（条目 rel 路径）。列 `UNINDEXED` —— 它是结果字段，不是检索面。 */
  entity: string
  title: string
  body: string
  keys: string
}

/** 把一个已投影的行写进索引（先删后插 = 幂等；显式 rowid = seq）。 */
function writeIndexRow(db: DatabaseSync, entry: IndexEntry): void {
  db.prepare("DELETE FROM pm_search WHERE rowid = ?").run(entry.seq)
  db.prepare("INSERT INTO pm_search(rowid, entity, title, body, keys) VALUES(?,?,?,?,?)").run(
    entry.seq,
    entry.entity,
    entry.title,
    entry.body,
    entry.keys,
  )
}

/**
 * 从**真相源**全量重建索引：丢掉 `pm_search` 的全部行，按 `activity_log` 重灌。
 *
 * 这是「search 是派生物」的唯一执行点。它在同一个事务里做完 ⇒ 中途失败不会留下半份索引
 * （半份索引比没有索引坏：它看起来能用）。
 * @param db - 已打开的 journal 库。
 * @param entries - 已投影的索引行（通常来自 `journalRowsToEntries()`）。
 * @returns 重建后的行数。
 */
export function rebuildSearch(db: DatabaseSync, entries: readonly IndexEntry[]): number {
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec("DELETE FROM pm_search")
    for (const entry of entries) writeIndexRow(db, entry)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  return entries.length
}

/**
 * **补缺**：只同步与真相源不一致的行，不整表重灌。
 *
 * 三件事各一：
 * - 孤行（索引里有、真相源没有）⇒ 删；
 * - 缺行（真相源有、索引没有）⇒ 写；
 * - 声明内已一致 ⇒ 原样留着（不重切，成本 = 差集）。
 * @param db - 已打开的 journal 库。
 * @param entries - 真相源现在的全量索引行。
 * @returns `{indexed, evicted}` —— 补了几行、删了几行。
 */
export function reconcileSearch(db: DatabaseSync, entries: readonly IndexEntry[]): { indexed: number; evicted: number } {
  const want = new Set(entries.map((entry) => entry.seq))
  const have = new Set(
    (db.prepare("SELECT rowid AS seq FROM pm_search").all() as Array<{ seq: number }>).map((row) => Number(row.seq)),
  )
  let evicted = 0
  const drop = db.prepare("DELETE FROM pm_search WHERE rowid = ?")
  for (const seq of have) {
    if (want.has(seq)) continue
    drop.run(seq)
    evicted++
  }
  let indexed = 0
  for (const entry of entries) {
    if (have.has(entry.seq)) continue
    writeIndexRow(db, entry)
    indexed++
  }
  return { indexed, evicted }
}

/** 索引里的行数（诊断 / 对账用，**不**参与「索引对不对」的判定 —— 那要看集合差）。 */
export function countIndexed(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM pm_search").get() as { total: number } | undefined
  return Number(row!.total)
}

/**
 * 索引与真相源之间的双向差集：缺的行与孤的行，都以 seq 表示。
 * @param db - 已打开的 journal 库。
 * @returns `{missing, orphaned}`（升序）。
 */
export function indexDelta(db: DatabaseSync): { missing: number[]; orphaned: number[] } {
  const missing = (
    db
      .prepare(
        `SELECT seq FROM activity_log
         WHERE seq NOT IN (SELECT rowid FROM pm_search) ORDER BY seq`,
      )
      .all() as Array<{ seq: number }>
  ).map((row) => Number(row.seq))
  const orphaned = (
    db
      .prepare(
        `SELECT rowid AS seq FROM pm_search
         WHERE rowid NOT IN (SELECT seq FROM activity_log) ORDER BY rowid`,
      )
      .all() as Array<{ seq: number }>
  ).map((row) => Number(row.seq))
  return { missing, orphaned }
}

/**
 * 查询串 → FTS5 的 `MATCH` 串：按空白切词，每个词加引号。
 *
 * 加引号不是排版：FTS5 的语法里 `AND` / `NEAR` / `(` 都是操作符，用户输入里的这些字符
 * 会被当语法解释 —— 那是注入面，不只是报错面。词内部的引号按 FTS5 规则双写转义。
 * @param query - 用户查询串。
 * @returns `MATCH` 用的串。
 */
export function toMatchQuery(query: string): string {
  return String(query ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ")
}

/** LIKE 模式里的转义（`%` / `_` / `\` 当字面量）。 */
function likePattern(query: string): string {
  return `%${query.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`
}

/**
 * 检索。
 *
 * 两条路径，**判据是查询串长度**：≥3 字符走 FTS5（吃倒排加速 + bm25 排序 + 片段高亮），
 * 短于此走 `LIKE` 兜底（标题命中排在正文命中之前）。
 * @param db - 已打开的 journal 库。
 * @param options - 查询串与命中上限。
 * @returns 命中与所用模式。
 */
export function searchText(db: DatabaseSync, options: SearchOptions): SearchResult {
  const query = String(options.query ?? "").trim()
  if (query.length === 0) return { hits: [], mode: "empty" }
  const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 200)
  return query.length >= TRIGRAM_MIN ? searchFts(db, query, limit) : searchLike(db, query, limit)
}

/** FTS5 路径（≥3 字符）。 */
function searchFts(db: DatabaseSync, query: string, limit: number): SearchResult {
  const rows = db
    .prepare(
      `SELECT rowid AS seq, entity,
          snippet(pm_search, 1, ?, ?, '…', 16) AS title_snippet,
          snippet(pm_search, 2, ?, ?, '…', 24) AS body_snippet,
          bm25(pm_search, 10.0, 1.0) AS rank
       FROM pm_search WHERE pm_search MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(HL_START, HL_END, HL_START, HL_END, toMatchQuery(query), limit) as Array<Record<string, unknown>>
  return {
    mode: "fts",
    hits: rows.map((row) => ({
      seq: Number(row.seq),
      entity: String(row.entity),
      titleSnippet: String(row.title_snippet ?? ""),
      bodySnippet: String(row.body_snippet ?? ""),
      rank: Number(row.rank),
    })),
  }
}

/** `LIKE` 兜底（<3 字符：trigram 切不出词元）。 */
function searchLike(db: DatabaseSync, query: string, limit: number): SearchResult {
  const pattern = likePattern(query)
  const rows = db
    .prepare(
      `SELECT rowid AS seq, entity, title, body,
          CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END AS rank
       FROM pm_search
       WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR keys LIKE ? ESCAPE '\\'
       ORDER BY rank, seq LIMIT ?`,
    )
    .all(pattern, pattern, pattern, pattern, limit) as Array<Record<string, unknown>>
  return {
    mode: "like",
    hits: rows.map((row) => ({
      seq: Number(row.seq),
      entity: String(row.entity),
      titleSnippet: String(row.title ?? ""),
      bodySnippet: String(row.body ?? "").slice(0, 80),
      rank: Number(row.rank),
    })),
  }
}
