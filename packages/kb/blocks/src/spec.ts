/**
 * `@matter/blocks/src/spec` —— P2 块引擎的 schema 骨架：28 种 `BlockType` 的 zod
 * discriminated union、容器/引用词表、V5（叶子禁止 `children`）的承重实现。
 *
 * ## 为什么 discriminated union 用 `z.strictObject` 而不是 `z.object`
 *
 * V5（ISS-517）要求「叶子块塞 `children` ⇒ 校验红」。`z.object` 默认**静默丢弃**
 * 未知键 —— 叶子塞了 `children` 会被丢掉后照样通过，不报错、不红，正是最危险的静默错。
 * `z.strictObject` 把未知键变成 `ZodError`；25 种叶子一律不带 `children` 字段，
 * 于是「叶子塞 children」必然在 `unrecognized_keys` 上红（V5 反例用例逐类钉住）。
 *
 * ## 为什么容器 children 走 `z.lazy` + 显式 `ZodType<Block>` 标注
 *
 * `Block` 递归引用自身（容器含 `Block[]`）。实测（zod 4.6.6 + TS 6.0.3）：
 * 直接写 `z.lazy(() => Block)` 且不给类型 ⇒ TS7022 循环推断；把整个 schema 标注成
 * `z.ZodType<Block>` 再喂 discriminatedUnion ⇒ 判别项的 `propValues` 丢失，union 构造报错。
 * ⇒ 只有 **`children` 字段**的 lazy 带显式 `ZodType<Block>` 标注；28 个判别项本身保持
 * 具体 `z.strictObject` 类型。`Block` 的 TS 类型由 25 个叶子 `z.infer` + 3 个容器内联
 * 字面量类型拼成 —— 联合是真正的判别联合，`switch(block.type)` 的 `default` 才能收窄到
 * `never`（`assertNever` 封闭性的前提）。
 *
 * ## 分组数字（grep 可核，运行时相等由用例钉住）
 *
 * A 基础 9 · B 业务 7 · C Notion 扩展 12 = 28；容器 3 · 引用 4。
 * 四张词表是这份骨架里「分组」的唯一真相源，schema union 与它们的一致性由测试断言，
 * 任一处漂移即红。
 *
 * @module @matter/blocks/src/spec
 */

import { z } from "zod"

/** 每条块的稳定标识（跨块引用与同步块指它）。 */
const blockId = z.string().min(1)

/** 富文本片段。P2 骨架只留 text + marks 的形状，12 种 mark 的细化留 P3。 */
export const Rich = z.strictObject({
  text: z.string(),
  marks: z.array(z.string()).optional(),
})
/** 富文本片段类型。 */
export type Rich = z.infer<typeof Rich>

/** 文本类块共用的 `rich` 字段。 */
const rich = z.array(Rich).optional()
/** 引用块共用的引用目标字段（issue id / doc id / view id / 源块 id）。 */
const ref = z.string().min(1)
/** 媒体/嵌入类块共用的地址字段。 */
const url = z.string().min(1)

/** 28 种块共有的判别项：id + type 字面量。 */
const base = <T extends string>(type: T) => ({ id: blockId, type: z.literal(type) })

// ─────────────────────────────────────────────────────────────────────────────
// A 基础 9（叶子，全部无 children）
// ─────────────────────────────────────────────────────────────────────────────
const Paragraph = z.strictObject({ ...base("paragraph"), rich })
const Heading = z.strictObject({ ...base("heading"), rich, level: z.number().int().min(1).max(6) })
const BulletList = z.strictObject({ ...base("bulletList"), items: z.array(Rich).optional() })
const OrderedList = z.strictObject({ ...base("orderedList"), items: z.array(Rich).optional(), start: z.number().int().optional() })
const Todo = z.strictObject({ ...base("todo"), rich, checked: z.boolean() })
const Quote = z.strictObject({ ...base("quote"), rich })
const Divider = z.strictObject({ ...base("divider") })
const Code = z.strictObject({ ...base("code"), code: z.string(), language: z.string().optional() })
const Image = z.strictObject({ ...base("image"), url, caption: z.string().optional() })

// ─────────────────────────────────────────────────────────────────────────────
// B 业务 7（Toggle 是容器；issueRef/docRef/view 是引用，全部叶子无 children）
// ─────────────────────────────────────────────────────────────────────────────
const IssueRef = z.strictObject({ ...base("issueRef"), ref, preview: z.boolean().optional() })
const DocRef = z.strictObject({ ...base("docRef"), ref, preview: z.boolean().optional() })
const Mermaid = z.strictObject({ ...base("mermaid"), code: z.string(), caption: z.string().optional() })
const Callout = z.strictObject({ ...base("callout"), rich, tone: z.enum(["info", "warn", "success", "error"]).optional() })
const Table = z.strictObject({ ...base("table"), rows: z.array(z.array(z.string())) })
const View = z.strictObject({ ...base("view"), ref, kind: z.enum(["list", "table", "board"]).optional() })

// ─────────────────────────────────────────────────────────────────────────────
// C Notion 扩展 12（Columns / SyncedBlock 是容器；SyncedBlock 同时是引用）
// ─────────────────────────────────────────────────────────────────────────────
const Video = z.strictObject({ ...base("video"), url, caption: z.string().optional() })
const Audio = z.strictObject({ ...base("audio"), url, caption: z.string().optional() })
const Pdf = z.strictObject({ ...base("pdf"), url, page: z.number().int().optional() })
const Bookmark = z.strictObject({ ...base("bookmark"), url, caption: z.string().optional() })
const Attachment = z.strictObject({ ...base("attachment"), asset: z.string().min(1), name: z.string(), mime: z.string().optional() })
const Math = z.strictObject({ ...base("math"), tex: z.string() })
const Toc = z.strictObject({ ...base("toc") })
const Breadcrumb = z.strictObject({ ...base("breadcrumb") })
const Template = z.strictObject({ ...base("template"), ref, name: z.string().optional() })
const Embed = z.strictObject({ ...base("embed"), url, html: z.string().optional() })

// ─────────────────────────────────────────────────────────────────────────────
// 分组词表（数字的真相源）
// ─────────────────────────────────────────────────────────────────────────────

/** A 基础块的 9 种 type。 */
export const A_BASIC_TYPES = [
  "paragraph", "heading", "bulletList", "orderedList", "todo", "quote", "divider", "code", "image",
] as const
/** B 业务块的 7 种 type。 */
export const B_BUSINESS_TYPES = [
  "issueRef", "docRef", "mermaid", "toggle", "callout", "table", "view",
] as const
/** C Notion 扩展块的 12 种 type。 */
export const C_NOTION_TYPES = [
  "video", "audio", "pdf", "bookmark", "attachment", "columns", "math", "toc", "breadcrumb", "syncedBlock", "template", "embed",
] as const
/** 容器块（可含 children）的 3 种 type。 */
export const CONTAINER_TYPES = ["columns", "toggle", "syncedBlock"] as const
/** 引用块（指向别处）的 4 种 type。 */
export const REFERENCE_TYPES = ["issueRef", "docRef", "view", "syncedBlock"] as const

/** 全部 28 种 BlockType，按 A→B→C 顺序。 */
export const BLOCK_TYPES = [
  ...A_BASIC_TYPES, ...B_BUSINESS_TYPES, ...C_NOTION_TYPES,
] as const

/**
 * 一个块。25 种叶子由各自 zod schema 推断；3 种容器在此内联字面量类型（带 `children`），
 * 这是打破 `Block` 递归推断环的唯一手写处。判别联合保证 `switch(block.type)` 的
 * `default` 收窄到 `never`，`assertNever` 才能判「新增类型未处理」。
 */
export type Block =
  | z.infer<typeof Paragraph>
  | z.infer<typeof Heading>
  | z.infer<typeof BulletList>
  | z.infer<typeof OrderedList>
  | z.infer<typeof Todo>
  | z.infer<typeof Quote>
  | z.infer<typeof Divider>
  | z.infer<typeof Code>
  | z.infer<typeof Image>
  | z.infer<typeof IssueRef>
  | z.infer<typeof DocRef>
  | z.infer<typeof Mermaid>
  | z.infer<typeof Callout>
  | z.infer<typeof Table>
  | z.infer<typeof View>
  | z.infer<typeof Video>
  | z.infer<typeof Audio>
  | z.infer<typeof Pdf>
  | z.infer<typeof Bookmark>
  | z.infer<typeof Attachment>
  | z.infer<typeof Math>
  | z.infer<typeof Toc>
  | z.infer<typeof Breadcrumb>
  | z.infer<typeof Template>
  | z.infer<typeof Embed>
  | { id: string; type: "columns"; children?: Block[] }
  | { id: string; type: "toggle"; title: string; children?: Block[] }
  | { id: string; type: "syncedBlock"; ref: string; children?: Block[] }

/** 具名递归块类型（ISS-539）：children 必填，供 Typert Remote codec 识别递归边。 */
export type RemoteBlock =
  | z.infer<typeof Paragraph> | z.infer<typeof Heading> | z.infer<typeof BulletList>
  | z.infer<typeof OrderedList> | z.infer<typeof Todo> | z.infer<typeof Quote>
  | z.infer<typeof Divider> | z.infer<typeof Code> | z.infer<typeof Image>
  | z.infer<typeof IssueRef> | z.infer<typeof DocRef> | z.infer<typeof Mermaid>
  | z.infer<typeof Callout> | z.infer<typeof Table> | z.infer<typeof View>
  | z.infer<typeof Video> | z.infer<typeof Audio> | z.infer<typeof Pdf>
  | z.infer<typeof Bookmark> | z.infer<typeof Attachment> | z.infer<typeof Math>
  | z.infer<typeof Toc> | z.infer<typeof Breadcrumb> | z.infer<typeof Template>
  | z.infer<typeof Embed>
  | { id: string; type: "columns"; children: RemoteBlock[] }
  | { id: string; type: "toggle"; title: string; children: RemoteBlock[] }
  | { id: string; type: "syncedBlock"; ref: string; children: RemoteBlock[] }

/** BlockType 判别字面量联合（从 Block 派生，不另立真相源）。 */
export type BlockType = Block["type"]

/**
 * 容器 children 字段。`z.lazy` 的显式 `ZodType<Block>` 标注打破递归推断环；
 * `z.array(...).optional()` 让空容器合法，V5 只管「叶子不许有 children」。
 */
const blockChildren = z.array(z.lazy((): z.ZodType<RemoteBlock> => Block as z.ZodType<RemoteBlock>)).optional()

const Columns = z.strictObject({ ...base("columns"), children: blockChildren })
const Toggle = z.strictObject({ ...base("toggle"), title: z.string(), children: blockChildren })
const SyncedBlock = z.strictObject({ ...base("syncedBlock"), ref, children: blockChildren })

/**
 * 28 种块的 zod discriminated union，按 `type` 判别。
 * 叶子全是 `z.strictObject` 且无 `children` 字段 ⇒ 叶子塞 children 必红（V5 反例）；
 * 仅 Columns / Toggle / SyncedBlock 声明 children ⇒ 容器塞 children 必绿（V5 正例）。
 */
export const Block = z.discriminatedUnion("type", [
  Paragraph, Heading, BulletList, OrderedList, Todo, Quote, Divider, Code, Image,
  IssueRef, DocRef, Mermaid, Toggle, Callout, Table, View,
  Video, Audio, Pdf, Bookmark, Attachment, Columns, Math, Toc, Breadcrumb, SyncedBlock, Template, Embed,
])

// ─────────────────────────────────────────────────────────────────────────────
// ISS-539 RemoteBlock 漂移闸（编译期）：手写的 3 个容器成员字段一旦与 zod schema
// 定义漂移（加/删/改字段），tsc 直接红。25 个叶子是 z.infer<typeof LeafSchema>，
// 天然随 schema 演进，无需闸。children 必填性是 generator 硬契约，不作为漂移。
// ─────────────────────────────────────────────────────────────────────────────
type _Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type _Expect<T extends true> = T
type _Hand<T> = Omit<T, "children">
type _Zod<T> = Omit<T, "children">

type _Gate_Columns = _Expect<_Eq<_Hand<Extract<RemoteBlock, { type: "columns" }>>, _Zod<z.infer<typeof Columns>>>>
type _Gate_Toggle = _Expect<_Eq<_Hand<Extract<RemoteBlock, { type: "toggle" }>>, _Zod<z.infer<typeof Toggle>>>>
type _Gate_SyncedBlock = _Expect<_Eq<_Hand<Extract<RemoteBlock, { type: "syncedBlock" }>>, _Zod<z.infer<typeof SyncedBlock>>>>
/** 判别标签集合也必须一致。 */
type _Gate_Types = _Expect<_Eq<RemoteBlock["type"], Block["type"]>>

/**
 * RemoteBlock 漂移闸的编译期断言元组（ISS-539）：3 容器字段 + 判别标签集与 zod 一致。
 * @remarks 纯类型守卫，运行时无产物；导出仅为让 tsc 求值上面四个 `_Gate_*` 断言。
 */
export type RemoteBlockDriftGate = [_Gate_Columns, _Gate_Toggle, _Gate_SyncedBlock, _Gate_Types]
