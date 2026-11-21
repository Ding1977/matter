/**
 * `DocumentProps` 的 25 字段 zod schema + blocks 槽的 `defineDomain` 声明。
 *
 * ## 25 字段是权威实测，不是 DOC-517 的 21
 *
 * `forge-pm/lib/domain.js` 的 `fieldsForDomain('documents')` 实测返回 **25** 个字段
 * （DOC-517 写的 21 已过期）。本包全量建这 25 个，不取子集 —— 老板 2026-11-20 拍板。
 * 落盘分布核过 `$DSH_HOME/pm/documents/`（505 份非 activity frontmatter）：
 * author/created/updated/id 近乎全有；其余按可选处理（会话蒸馏卡与评论卡字段差异极大）。
 * 一句话：必填只收「每个真实文档都有」的 5 个，其余 `.optional()` 且不设 `.default()`
 * —— 默认值会让 PATCH 把别的字段材料化清空（E-0 同款口径）。
 *
 * ## 正文走 blocks 槽，不是 body:string
 *
 * 地基单 ISS-525 给了 `domainTable<K,V,B>` 第三参数：`B` 不是 never 时，记录值从裸
 * props 变成平级 `{props, blocks}`（DOC-512 §2.1）。本包传 `@matter/blocks` 的
 * `BlockArray`（28 类型判别联合的数组）作 blocksSchema，正文因此进 blocks，不进 props。
 * `TableValueOf<typeof DocumentDomain, "document">` 派生出 `{props: DocProps, blocks: Block[]}`。
 * ⚠️ 未发现 Block[] 传导的类型障碍：地基的 `ZodType<B>` 与 blocks 的 `z.infer` 同构，
 *    若将来地基改动致其断裂 ⇒ 报 Lead，不硬改地基。
 *
 * ## 每字段 .meta() 放链末；brand 用 .meta({branded})
 *
 * 与 E-0（ISS-519）同：`.optional().meta(...)` 才会让 `schema.meta()` 读回元数据
 * （`.meta().optional()` 拿到的是新包装层，读回 undefined）。brand 走 meta 不经
 * `.transform()`（后者让 `toJSONSchema()` 在默认 io 下抛）。本包无 `DocId` branded
 * 类型（`@matter/storage` 只导出 `IssueId`；补它要改 P1 包，不在本单写范围），
 * 故 key 用裸 `string`，但 schema 的 id 字段仍带 `branded: "DocId"` 元数据供前端取用。
 *
 * @module @matter/document/src/spec
 */

import { z } from "zod"
import { Block } from "@matter/blocks"
import type { Block as BlockType } from "@matter/blocks"
import { defineDomain, domainTable } from "@matter/storage-domain"

/** 文档状态词表（旧树 `domain.js:592` FIELD_OPTIONS.status.documents 逐字，四态）。 */
export const DOCUMENT_STATUSES = ["draft", "in_progress", "revising", "done"] as const
/** 文档类型词表（旧树 `domain.js:611` documents = 唯一值 `document`）。 */
export const DOCUMENT_KINDS = ["document"] as const
/** 媒体类型词表（旧树 `domain.js:612`，8 值）。 */
export const DOCUMENT_MEDIA_TYPES = ["md", "html", "text", "image", "audio", "video", "pdf", "other"] as const
/** 会话来源词表（旧树 `domain.js:613`）。 */
export const DOCUMENT_SESSION_KINDS = ["main", "subagent"] as const
/** 会话蒸馏卡词表（旧树 `domain.js:614`）。 */
export const DOCUMENT_CARD_KINDS = ["session-distill"] as const

/** 文档 id 的标准形状（`domain.js:290` 前缀表 documents → DOC）；存量有 MEM/MSG/evt 等异形，故 schema 只验非空。 */
export const DOCUMENT_ID_RE = /^DOC-[0-9]+$/

/** 记录键前缀：`activity_log.entity` 与 `edges` 的节点身份都靠它认域。 */
export const DOCUMENT_ENTITY_PREFIX = "documents"

/**
 * 一条文档的 props（25 字段，按权威清单字母序）。
 *
 * writable 分档照旧树 FIELD_META：`immutable` = id/created/type；
 * `system` = 17 个系统写字段；`user` = project/status/tags/title/verdict。
 * widget 取数据形态而非组件名；`boolean` 是 E-0/E-1 词表外新增的形态（deleted 用），
 * 与 E-1 新增 color/icon/image 同理，取值本身就是渲染契约。
 */
export const DocProps = z.strictObject({
  activity: z.string().optional().meta({ writable: "system", widget: "text", indexable: false }),
  author: z.string().min(1).meta({ writable: "system", widget: "person", indexable: false }),
  cardKind: z.enum(DOCUMENT_CARD_KINDS).optional().meta({ writable: "system", widget: "select", indexable: false }),
  created: z.iso.datetime({ offset: true }).meta({ writable: "immutable", widget: "date", indexable: false }),
  deleted: z.boolean().optional().meta({ writable: "system", widget: "boolean", indexable: false }),
  id: z.string().min(1).meta({ writable: "immutable", widget: "text", indexable: true, branded: "DocId" }),
  kind: z.enum(DOCUMENT_KINDS).optional().meta({ writable: "system", widget: "select", indexable: false }),
  log_size: z.string().optional().meta({ writable: "system", widget: "text", indexable: false }),
  mediaType: z.enum(DOCUMENT_MEDIA_TYPES).optional().meta({ writable: "system", widget: "select", indexable: false }),
  model: z.string().optional().meta({ writable: "system", widget: "text", indexable: false }),
  outcome: z.string().optional().meta({ writable: "system", widget: "text", indexable: false }),
  project: z.string().optional().meta({ writable: "user", widget: "ref", indexable: false }),
  refs: z.array(z.string()).optional().meta({ writable: "system", widget: "ref", indexable: false }),
  relations: z.array(z.string()).optional().meta({ writable: "system", widget: "ref", indexable: false }),
  session: z.string().optional().meta({ writable: "system", widget: "text", indexable: false }),
  session_kind: z.enum(DOCUMENT_SESSION_KINDS).optional().meta({ writable: "system", widget: "select", indexable: false }),
  source: z.string().optional().meta({ writable: "system", widget: "text", indexable: false }),
  source_session: z.string().optional().meta({ writable: "system", widget: "text", indexable: false }),
  status: z.enum(DOCUMENT_STATUSES).optional().meta({ writable: "user", widget: "select", indexable: false }),
  tags: z.array(z.string()).optional().meta({ writable: "user", widget: "tags", indexable: false }),
  title: z.string().min(1).meta({ writable: "user", widget: "text", indexable: true }),
  type: z.string().min(1).optional().meta({ writable: "immutable", widget: "text", indexable: false }),
  updated: z.iso.datetime({ offset: true }).meta({ writable: "system", widget: "date", indexable: false }),
  verdict: z.string().optional().meta({ writable: "user", widget: "text", indexable: false }),
  workspace: z.string().optional().meta({ writable: "system", widget: "text", indexable: false }),
})

/** 一条文档 props 的推断类型。 */
export type DocProps = z.infer<typeof DocProps>

/** 文档正文的 blocks schema：@matter/blocks 的 28 类型判别联合的数组。 */
export const BlockArray = z.array(Block)

/** 一条文档记录的推断类型（props 与 blocks 平级，见 defineDomain）。 */
export type BlockArray = z.infer<typeof BlockArray>

/**
 * 写面的记录 schema：{props, blocks} 平级。facility 的 parse 在写链上校验整条记录；
 * 域层另在 durable 边界用 valueSchema/blocksSchema 校验两者 —— 两处口径同源（同一份 schema）。
 */
export const DocRecord = z.strictObject({ props: DocProps, blocks: BlockArray })
/** 一条文档记录（zod 推断）。 */
export type DocRecord = z.infer<typeof DocRecord>

/**
 * 局部更新（PATCH）：props 与 blocks 各自整体替换（不深合并 props 单字段）。
 * ⛔ 不是「宽松一点的 DocRecord」：未知键报错、不静默丢弃（E-0 同款）。
 */
export const DocPatch = DocRecord.partial()
/** 局部更新的入参类型。 */
export type DocPatch = z.infer<typeof DocPatch>

/** 记录表名（单数，后端 unit 子目录名，须匹配 UNIT_NAME_RE）。 */
export const DOCUMENT_TABLE = "document"

/**
 * 域声明。name 同时是后端 unit 名 ⇒ 用 `kb_document`（带域前缀，避免与 pm_issue 撞名）。
 *
 * `domainTable<DocId, DocProps, Block[]>` 第三参数传 `BlockArray` ⇒ B 不是 never ⇒
 * `TableValueOf` 派生 `{props, blocks}`；不传时（E-0/E-1）仍是裸 props，逐字不变。
 */
export const DocumentDomain = defineDomain({
  name: "kb_document",
  version: 1,
  tables: {
    [DOCUMENT_TABLE]: domainTable<string, DocProps, BlockType[]>(DocProps, BlockArray),
  },
})
