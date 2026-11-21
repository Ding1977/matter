/**
 * 边表：**派生物**，不是真相源。
 *
 * ## 边从哪来
 *
 * 旧树**没有边表** —— `relations` 每次从 frontmatter 现算（`_inboundMapFor` 带签名缓存）。
 * 所以这里不是「迁移保真」，是新增能力。既然是新能力，就不给它独立的真相源：
 * 边的真相是「事件流里最后一次写明的那三个字段」——
 *
 * | 字段 | 形状（旧树实测） | 边的 `kind` |
 * |---|---|---|
 * | `relations` | `["references|ISS-501", "blocks|ISS-9"]` 的字符串数组 | `|` 前那段（缺 `|` ⇒ `references`） |
 * | `parent` | 单个 id | `parent` |
 * | `blocked_by` | id 数组 | `blocked_by` |
 *
 * ⇒ **这三种之外的东西不进边表**。`project` / `subtasks` 该不该进是没拍的问题
 * （DOC-514 §6-6），本包不替它拍 —— 猜错方向会让边表长成一棵不可信的树。
 *
 * ## 为什么「最后一次写明的值胜出」，而不是「所有事件都投影一遍」
 *
 * 边表要回答的是「**现在**谁指向谁」，不是「历史上谁曾指向谁」。所以：
 * 按 seq 升序扫，同一 `(src, field)` 后来者覆盖先者；某次把 `relations` 从 `[A]` 改成 `[]`
 * 就是**删边**。全部扫完才写表 ⇒ 结果与事件顺序无关，只与最后一次状态有关。
 *
 * 代价：`rebuild()` 是 O(事件数)，不是增量。这个包的规模是几千到几万条，
 * 而增量同步会引入「边表与事件流不一致」这一整类错 —— 那比慢贵。
 *
 * @module storage-journal/src/edges
 */

import type { DatabaseSync } from "node:sqlite"

/** 一条边。 */
export interface JournalEdge {
  /** 起点实体（事件所属实体）。 */
  src: string
  /** 边类型：`relations` 里的前缀，或 `parent` / `blocked_by`。 */
  kind: string
  /** 终点实体。 */
  dst: string
  /** 这条边最后一次被写明的 `activity_log.seq`（诊断用：能追回是哪条事件）。 */
  seq: number
}

/** 进边表的三个字段名。⛔ 加字段前先读头注的表格 —— 每个都要有旧树实测形状。 */
const EDGE_FIELDS = ["relations", "parent", "blocked_by"] as const
type EdgeField = (typeof EDGE_FIELDS)[number]

/** `relations` 项没有 `|` 时的缺省 kind。 */
const DEFAULT_RELATION_KIND = "references"

/**
 * 一个 `(src, field)` 的当前取值 → 边。
 * @param src - 起点实体。
 * @param field - 三个字段之一。
 * @param value - 该字段的当前值（`relations` / `blocked_by` 是数组，`parent` 是标量）。
 * @param seq - 最后一次写明的 seq。
 * @returns 该字段投影出的全部边（可能为空 = 删边）。
 */
function edgesOf(src: string, field: EdgeField, value: unknown, seq: number): JournalEdge[] {
  if (value === null || value === undefined) return []
  if (field === "parent") {
    if (typeof value !== "string" || value.length === 0) return []
    return [{ src, kind: "parent", dst: value, seq }]
  }
  if (!Array.isArray(value)) return []
  const out: JournalEdge[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) continue
    if (field === "blocked_by") {
      out.push({ src, kind: "blocked_by", dst: item, seq })
      continue
    }
    const bar = item.indexOf("|")
    const kind = bar < 0 ? DEFAULT_RELATION_KIND : item.slice(0, bar)
    const dst = bar < 0 ? item : item.slice(bar + 1)
    if (dst.length === 0 || kind.length === 0) continue
    out.push({ src, kind, dst, seq })
  }
  return out
}

/**
 * 从真相源重算全部边并**整表替换**。
 *
 * @param db - 已打开的 journal 库。
 * @returns 重算出的边数。
 */
export function rebuildEdges(db: DatabaseSync): number {
  const rows = db
    .prepare("SELECT seq, entity, event, payload_json FROM activity_log ORDER BY seq ASC")
    .all() as Array<{ seq: number; entity: string; event: string; payload_json: string | null }>
  /** src → field → 当前值。last-write-wins，所以扫完留下的就是当前状态。 */
  const state = new Map<string, Map<EdgeField, { value: unknown; seq: number }>>()
  for (const row of rows) applyPayloadRow(state, row)
  const edges = materialize(state)
  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec("DELETE FROM edges")
    const insert = db.prepare("INSERT OR REPLACE INTO edges(src, kind, dst, seq) VALUES(?,?,?,?)")
    for (const edge of edges) insert.run(edge.src, edge.kind, edge.dst, edge.seq)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  return edges.length
}

/** 把一条事件并进状态表。`field-change` 取 `to`（当前值），其余事件直接读 payload 上的键。 */
function applyPayloadRow(
  state: Map<string, Map<EdgeField, { value: unknown; seq: number }>>,
  row: { seq: number; entity: string; event: string; payload_json: string | null },
): void {
  if (row.payload_json === null) return
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>
  } catch {
    // 坏 payload 不参与投影：边表是派生物，为一行脏数据让整次重建失败不划算。
    // ⚠️ 但它不是静默的 —— `journal.ts` 的 `listJournal` 对同一行会抛。
    return
  }
  const isFieldChange = row.event === "field-change"
  const changedField = isFieldChange && typeof payload.field === "string" ? payload.field : null
  for (const field of EDGE_FIELDS) {
    if (isFieldChange && changedField !== field) continue
    const source = isFieldChange ? payload.to : payload[field]
    if (!(field in payload) && !isFieldChange) continue
    const slots = state.get(row.entity) ?? new Map<EdgeField, { value: unknown; seq: number }>()
    slots.set(field, { value: source, seq: Number(row.seq) })
    state.set(row.entity, slots)
  }
}

/** 状态表 → 去重后的边列表（同 `(src,kind,dst)` 取最大 seq）。 */
function materialize(state: Map<string, Map<EdgeField, { value: unknown; seq: number }>>): JournalEdge[] {
  const byKey = new Map<string, JournalEdge>()
  for (const [src, slots] of state) {
    for (const [field, slot] of slots) {
      for (const edge of edgesOf(src, field, slot.value, slot.seq)) {
        const key = `${edge.src}\u0000${edge.kind}\u0000${edge.dst}`
        const prior = byKey.get(key)
        if (prior === undefined || prior.seq < edge.seq) byKey.set(key, edge)
      }
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.src === b.src ? (a.kind === b.kind ? a.dst.localeCompare(b.dst) : a.kind.localeCompare(b.kind)) : a.src.localeCompare(b.src),
  )
}

/**
 * 以 `entity` 为**起点**的边。
 * @param db - 已打开的 journal 库。
 * @param entity - 起点实体。
 * @param kind - 只看这一种边。
 * @returns 升序边列表（表为空 ⇒ 空数组，不是「没查」）。
 */
export function outgoingEdges(db: DatabaseSync, entity: string, kind?: string): JournalEdge[] {
  const rows = (
    kind === undefined
      ? db.prepare("SELECT src, kind, dst, seq FROM edges WHERE src = ? ORDER BY kind, dst").all(entity)
      : db.prepare("SELECT src, kind, dst, seq FROM edges WHERE src = ? AND kind = ? ORDER BY dst").all(entity, kind)
  ) as Array<Record<string, unknown>>
  return rows.map(toEdge)
}

/**
 * 以 `entity` 为**终点**的边（反向入口：谁指向我）。
 * @param db - 已打开的 journal 库。
 * @param entity - 终点实体。
 * @param kind - 只看这一种边。
 * @returns 升序边列表。
 */
export function incomingEdges(db: DatabaseSync, entity: string, kind?: string): JournalEdge[] {
  const rows = (
    kind === undefined
      ? db.prepare("SELECT src, kind, dst, seq FROM edges WHERE dst = ? ORDER BY kind, src").all(entity)
      : db.prepare("SELECT src, kind, dst, seq FROM edges WHERE dst = ? AND kind = ? ORDER BY src").all(entity, kind)
  ) as Array<Record<string, unknown>>
  return rows.map(toEdge)
}

/** 边表总条数（诊断用；「边对不对」要看集合，不是看条数）。 */
export function countEdges(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM edges").get() as { total: number } | undefined
  return Number(row!.total)
}

function toEdge(raw: Record<string, unknown>): JournalEdge {
  return { src: String(raw.src), kind: String(raw.kind), dst: String(raw.dst), seq: Number(raw.seq) }
}
