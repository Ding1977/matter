/**
 * 文档变更的事件词表与「上一版 → 本版」的差异换算。
 *
 * ## 词表照旧树，不自造
 *
 * 旧树 `forge-pm/lib/domain.js` 给 documents 登记的事件是 `created` / `deleted` /
 * `status-change` / `field-change` / `body-change`（见 EVENT_META 与各域事件表）。
 * 本文件逐字沿用 —— 正文现在是 blocks 而非字符串，但事件名仍是 `body-change`：
 * 它回答的是「正文变了」，载荷改记块数组的指纹，不贴块内容（与 E-0 的正文指纹同理）。
 *
 * ## 差异只在写链这一格算
 *
 * `domain/changed` 只带新值（storage-domain 契约），旧值只在写链里同时可见。
 * 本文件把「整个 {props, blocks} 记录」的差拆成三路：
 *   · `blocks` 变 → `body-change`（指纹 + 块数，不含正文）
 *   · `props.status` 变 → `status-change`（field/from/to）
 *   · 其余 props 字段变 → `field-change`
 * 顺序稳定（props 字段名序 + blocks 单独一件），uid 与回放才能对齐。
 *
 * @module @matter/document/src/events
 */

import { createHash } from "node:crypto"
import type { Block } from "@matter/blocks"
import { auditValue as logValue, diffAuditEntries, makeAuditEntry } from "@matter/storage-journal"
import type { JournalEntry } from "@matter/storage-journal"
import type { DocRecord } from "./spec.ts"
import { DOCUMENT_ENTITY_PREFIX, DOCUMENT_STATUSES } from "./spec.ts"

export {
  AUDIT_VALUE_MAX as LOG_VALUE_MAX,
  auditValue as logValue,
  sameAuditValue as sameValue,
} from "@matter/storage-journal"

/** 本包可能写出的全部事件名（旧树 documents 的词表子集）。表外名字落 known:0。 */
export const DOCUMENT_EVENTS: ReadonlySet<string> = new Set([
  "created", "deleted", "status-change", "field-change", "body-change",
])

/** 指纹保留的十六进制位数（与 E-0 的正文指纹同值）。 */
const HASH_LEN = 12

/** 一次写入的署名人与发生时刻。 */
export interface DocumentEventContext {
  /** 触发者；缺省不写（append 落 null）。 */
  readonly actor?: string | null
  /** 事件发生时刻，缺省「现在」。 */
  readonly at?: Date
}

/**
 * 记录的对外身份。
 * @param id - 文档 id。
 * @returns `documents/<id>`。
 */
export function documentEntity(id: string): string {
  return `${DOCUMENT_ENTITY_PREFIX}/${id}`
}

/** 块数组指纹：`{hash, blocks}`，**不含块内容**。 */
export interface BlocksFingerprint {
  /** 稳定序列化后的 sha256 前 12 位。 */
  readonly hash: string
  /** 块数（空数组记 0）。 */
  readonly blocks: number
}

/**
 * 块数组指纹。判据只需「事后能判定两次之间正文变了」⇒ 稳定序列化的短哈希 + 块数就够。
 * 注意键序：块对象来自 zod strictObject，字段顺序稳定；同一份逻辑内容的键序变化会改哈希，
 * 但这比贴全文污染整条审计轻得多。
 * @param value - 块数组（非数组按空数组算，防御面）。
 * @returns 指纹。
 */
export function blocksFingerprint(value: unknown): BlocksFingerprint {
  const blocks = Array.isArray(value) ? value as Block[] : []
  return {
    hash: createHash("sha256").update(JSON.stringify(blocks), "utf8").digest("hex").slice(0, HASH_LEN),
    blocks: blocks.length,
  }
}

/**
 * 拼一条文档审计条目。
 * @param id - 文档 id。
 * @param event - 事件名。
 * @param payload - 附加键（进 uid）。
 * @param context - 署名人与发生时刻。
 * @returns 可直接交给 `ctx.journal.append` 的条目。
 */
export function documentEntry(
  id: string,
  event: string,
  payload: Record<string, unknown>,
  context: DocumentEventContext = {},
): JournalEntry {
  const known = DOCUMENT_EVENTS.has(event) ? 1 : 0
  return makeAuditEntry(documentEntity(id), event, payload, known, context.actor, context.at)
}

/**
 * 建记录 → 一条 `created`。
 * @param id - 文档 id。
 * @param context - 署名人与发生时刻。
 * @returns 单条条目。
 */
export function createdEntries(id: string, context: DocumentEventContext = {}): JournalEntry[] {
  return [documentEntry(id, "created", {}, context)]
}

/**
 * 删记录 → 一条 `deleted`。
 * @param id - 文档 id。
 * @param context - 署名人与发生时刻。
 * @returns 单条条目。
 */
export function deletedEntries(id: string, context: DocumentEventContext = {}): JournalEntry[] {
  return [documentEntry(id, "deleted", {}, context)]
}

/**
 * 上一版 → 本版，整条 {props, blocks} 记录换算成事件。
 * @param id - 文档 id。
 * @param previous - 上一版；`undefined` 表示建记录。
 * @param next - 本版。
 * @param context - 署名人与发生时刻。
 * @returns 事件条目。
 */
export function diffEntries(
  id: string,
  previous: DocRecord | undefined,
  next: DocRecord,
  context: DocumentEventContext = {},
): JournalEntry[] {
  if (previous === undefined) return createdEntries(id, context)
  const out: JournalEntry[] = []
  // 正文（blocks）变更 → body-change，只记指纹与块数。
  if (JSON.stringify(previous.blocks) !== JSON.stringify(next.blocks)) {
    const from = blocksFingerprint(previous.blocks)
    const to = blocksFingerprint(next.blocks)
    out.push(documentEntry(id, "body-change", {
      field: "blocks",
      fromHash: from.hash,
      toHash: to.hash,
      fromBlocks: from.blocks,
      toBlocks: to.blocks,
      blockDelta: to.blocks - from.blocks,
    }, context))
  }
  // props 字段变更 → status-change（状态）或 field-change（其余），按字段名序。
  out.push(...diffAuditEntries<string, DocumentEventContext>(
    id, previous.props, next.props, context,
    () => [], // previous 已判非 undefined，created 回调不会被调用
    propFieldEntry,
  ))
  return out
}

/**
 * 一个 props 字段的变更 → 该字段口径的事件。
 * @param id - 文档 id。
 * @param field - 字段名。
 * @param before - 旧值。
 * @param after - 新值。
 * @param context - 署名人与发生时刻。
 * @returns 条目（本包 props 字段都有口径，恒非 null）。
 */
function propFieldEntry(
  id: string,
  field: string,
  before: unknown,
  after: unknown,
  context: DocumentEventContext,
): JournalEntry {
  const payload = { field, from: before === undefined ? null : logValue(before), to: after === undefined ? null : logValue(after) }
  // ⛔ 表外状态值不冒充生命周期信号：文档用通用 status-change，但野值走 field-change，
  //    与 E-0「表外状态不编造信号名」同口径（值已过 zod 写面，这里只防外部脏数据）。
  const isKnownStatus = (DOCUMENT_STATUSES as readonly string[]).includes(String(after))
  const event = field === "status" && isKnownStatus ? "status-change" : "field-change"
  return documentEntry(id, event, payload, context)
}
