/**
 * `@matter/document` —— P2 轨 E 的 document 实体域：全量 25 字段 props + blocks 正文。
 *
 * ## 它由三件东西组成，缺一件都不算接上
 *
 * | 件 | 在哪 | 谁依赖它 |
 * |---|---|---|
 * | `DocProps`（25 字段 zod schema + `.meta()`） | `spec.ts` | E-3 的 docRef 块指它 |
 * | `DocumentDomain`（blocks 槽的 defineDomain 实例） | `spec.ts` | `ctx.storageDomain.open()` |
 * | `ctx.documents`（唯一写路径 + 活动流落点） | 本文件 | 任何读写文档 record 的消费者 |
 *
 * ## 记录值是平级 {props, blocks}，不是裸 props
 *
 * 地基单 ISS-525 的 `TableValueOf` 在 `blocksSchema` 存在时派生 `{props, blocks}`。
 * E-0/E-1 的 facility 收裸 props；本包收整条 `{props, blocks}`：
 * `parse` 用同一份 `DocRecord` schema（props 与 blocks 各由 spec.ts 的权威 schema 组合），
 * 主键取 `record.props.id`，差异换算按 blocks / props.status / 其余 props 分三路。
 *
 * ## 写序与审计落点照 E-0
 *
 * 读上一版 → `table.put`（先落盘、再内存、再发 domain/changed）→ 落盘成功后写活动流。
 * 串行写链、空写判定、审计降级全在 `@matter/storage-journal` 的 `AuditFacility` 内核。
 * 本包只绑文档域的 schema、事件词表、错误类与 id 口径。
 *
 * @module @matter/document
 */

import type { Context } from "@deepseek-ai/cordis"
import type { Domain } from "@matter/storage-domain"
import type { JournalFacility } from "@matter/storage-journal"
import { AuditFacility, type AuditFacilitySpec } from "@matter/storage-journal"
import {
  DOCUMENT_CARD_KINDS, DOCUMENT_ENTITY_PREFIX, DOCUMENT_ID_RE, DOCUMENT_KINDS,
  DOCUMENT_MEDIA_TYPES, DOCUMENT_SESSION_KINDS, DOCUMENT_STATUSES, DOCUMENT_TABLE,
  BlockArray, DocPatch, DocProps, DocRecord, DocumentDomain,
} from "./spec.ts"
import {
  DOCUMENT_EVENTS, blocksFingerprint, createdEntries, deletedEntries, diffEntries,
  documentEntity, documentEntry,
} from "./events.ts"
import type { DocumentEventContext } from "./events.ts"

export {
  DOCUMENT_CARD_KINDS, DOCUMENT_ENTITY_PREFIX, DOCUMENT_ID_RE, DOCUMENT_KINDS,
  DOCUMENT_MEDIA_TYPES, DOCUMENT_SESSION_KINDS, DOCUMENT_STATUSES, DOCUMENT_TABLE,
  BlockArray, DocPatch, DocProps, DocRecord, DocumentDomain,
} from "./spec.ts"
export {
  DOCUMENT_EVENTS, LOG_VALUE_MAX, blocksFingerprint, createdEntries, deletedEntries,
  diffEntries, documentEntity, documentEntry, logValue, sameValue,
} from "./events.ts"
export type { BlocksFingerprint, DocumentEventContext } from "./events.ts"

/** Cordis 插件名。 */
export const name = "document"

/** 三处依赖：storage（hub）/ storageDomain（域）/ journal（活动流）。 */
export const inject = ["storage", "storageDomain", "journal"]

/** 一条文档记录的存储单元名（= DocumentDomain.name）。 */
export const DOCUMENT_DOMAIN_NAME = DocumentDomain.name

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 文档记录的门面：唯一的写路径 + 活动流落点。 */
    documents: DocumentsFacility
  }
}

/** 未找到指定文档。 */
export class DocumentNotFoundError extends Error {
  /** @param id - 文档 id。 */
  constructor(id: string) {
    super(`document '${id}' does not exist`)
    this.name = "DocumentNotFoundError"
  }
}

/** 文档 id 已被占用（建记录是「新建」，不是 upsert）。 */
export class DocumentExistsError extends Error {
  /** @param id - 文档 id。 */
  constructor(id: string) {
    super(`document '${id}' already exists`)
    this.name = "DocumentExistsError"
  }
}

/** @param value - 待校验记录；zod 校验失败原样抛 `ZodError`。 */
function parseRecord(value: unknown): DocRecord {
  return DocRecord.parse(value)
}

/** 文档域注入共享内核的差异点。 */
const DOCUMENT_FACILITY_SPEC: AuditFacilitySpec<string, DocRecord, DocumentEventContext> = {
  tableName: DOCUMENT_TABLE,
  closedMessage: `document facility '${DOCUMENT_DOMAIN_NAME}' is closed`,
  parse: parseRecord,
  keyOf: (record) => record.props.id,
  idOf: (record) => record.props.id,
  notFound: (id) => new DocumentNotFoundError(id),
  exists: (id) => new DocumentExistsError(id),
  created: createdEntries,
  deleted: deletedEntries,
  diff: diffEntries,
}

/**
 * 文档记录的门面，挂在 `ctx.documents`（复数：get / create / update / remove / entries / close）。
 * 记录值是平级 `{props, blocks}`；PATCH 面 `DocPatch` 对两者各自整体替换。
 */
export class DocumentsFacility extends AuditFacility<string, DocRecord, DocPatch, DocumentEventContext> {
  /**
   * @param domain - 已打开的文档域（调用方持有生命周期）。
   * @param journal - 活动流；审计往它落。
   * @param warn - 审计写失败时的出声道（闭包，不传整个 Context）。
   */
  constructor(
    domain: Domain<typeof DocumentDomain>,
    journal: JournalFacility,
    warn: (message: string) => void,
  ) {
    super(domain, journal, warn, DOCUMENT_FACILITY_SPEC)
  }
}

/**
 * 打开文档域并构造门面。宿主拥有返回值的生命周期（apply 里作为 disposer 关掉）。
 * @param ctx - 已注入 storageDomain 与 journal 的上下文。
 * @returns 已打开的门面。
 */
export async function openDocuments(ctx: Context): Promise<DocumentsFacility> {
  const domain = await ctx.storageDomain.open(DocumentDomain)
  const logger = ctx.logger("document")
  return new DocumentsFacility(domain, ctx.journal, (message) => { logger.warn(message) })
}

/**
 * 挂载 `ctx.documents`：开局 → 提供键 → 卸载时先摘键、再关域。
 * @param ctx - 插件上下文。
 * @returns 激活完成的 promise。
 */
export function apply(ctx: Context): Promise<void> {
  return openDocuments(ctx).then((facility) => {
    ctx.effect(() => {
      const dispose = ctx.provide("documents", facility)
      return async () => {
        dispose()
        await facility.close()
      }
    })
  })
}
