/**
 * 成品预览的种子数据（ISS-905 · D2 前置承载层）。
 *
 * ≥10 条真文档，覆盖长文（正文纯文本 ≥2000 字）、空标题、多段多块、四种状态。
 * 落库幂等：按 `props.id` 判存在则跳过——重跑不翻倍，也不覆盖用户已改过的记录。
 *
 * `DocProps.title` 的 zod schema 是 `z.string().min(1)`，真空串会被门面拒绝；
 * 「空标题」因此以一个空格（视觉上空白）表达，这是 schema 允许的最接近形态。
 *
 * @module apps/host/src/seed
 */

import type { DocRecord } from "@matter/document"

/** 预览数据落仓内 dev-data（gitignore），相对仓库根。 */
export const PREVIEW_DATA_DIR = "dev-data/preview"

/** 预览 host 固定端口。3210 = DSH GUI、8100 = trader 行情，均实测占用；3212 实测空闲。 */
export const PREVIEW_HOST_PORT = Number(process.env.MATTER_PREVIEW_API_PORT ?? 3212)

/** Vite 预览端口（也是 RPC cookie 签署的 authority 端口）。 */
export const PREVIEW_WEB_PORT = Number(process.env.MATTER_PREVIEW_WEB_PORT ?? 5173)

/** 一条 paragraph 块。 */
function paragraph(id: string, text: string) {
  return { id, type: "paragraph" as const, rich: [{ text, marks: [] }] }
}

/** 一条 heading 块。 */
function heading(id: string, text: string, level: number) {
  return { id, type: "heading" as const, level, rich: [{ text, marks: [] }] }
}

/** 一条 quote 块。 */
function quote(id: string, text: string) {
  return { id, type: "quote" as const, rich: [{ text, marks: [] }] }
}

/** 一条 todo 块。 */
function todo(id: string, text: string, checked: boolean) {
  return { id, type: "todo" as const, checked, rich: [{ text, marks: [] }] }
}

/** 一条 code 块。 */
function code(id: string, text: string, language: string) {
  return { id, type: "code" as const, code: text, language }
}

/** 一条 divider 块。 */
function divider(id: string) {
  return { id, type: "divider" as const }
}

/** 长文正文：24 节 × 约 110 字 ⇒ 纯文本约 2600 字，满足 ≥2000 字覆盖。 */
const LONG_BODY = Array.from({ length: 24 }, (_, i) =>
  `第 ${String(i + 1).padStart(2, "0")} 节 · 预览承载的验收口径：审核者打开成品预览时，` +
  `应能在列表里看到本条长文，点开后读到这里连续的第 ${String(i + 1).padStart(2, "0")} 段正文，` +
  `而不是空白占位或模块 HTTP 200 的假象。每一节都写满可辨识的中文，便于一眼确认正文全文已渲染。`,
).join("")

/** 种子记录共有元数据时刻（固定值保证可重复）。 */
const SEED_TIME = "2026-11-21T00:00:00+08:00"

/** 种子文档集合（12 条）。 */
export const PREVIEW_SEEDS: readonly { readonly record: DocRecord }[] = [
  {
    record: {
      props: { id: "DOC-PREVIEW-001", title: "长文 · Matter 成品预览说明", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "in_progress", tags: ["preview", "long-form"] },
      blocks: [
        heading("pv1-h1", "长文 · Matter 成品预览说明", 1),
        paragraph("pv1-p1", "这一条是种子数据里的长文代表：点开后应能通读到下面 ≥2000 字的正文，用于证明承载层交的是成品而不是空壳。"),
        ...LONG_BODY.split(/(?<=。)/).filter((s) => s.length > 0).map((s, i) => paragraph(`pv1-long-${String(i).padStart(2, "0")}`, s)),
      ],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-002", title: "需求评审纪要（草稿）", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "draft" },
      blocks: [
        heading("pv2-h", "需求评审纪要（草稿）", 2),
        paragraph("pv2-p1", "状态：草稿。这一段记录评审待确认项，改动后保存并刷新应能回显。"),
        todo("pv2-t1", "确认预览端口避让方案", true),
        todo("pv2-t2", "确认种子数据覆盖面", false),
        todo("pv2-t3", "确认 D2 页面设计范围", false),
      ],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-003", title: "设计评审 · 进行中", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "in_progress" },
      blocks: [
        heading("pv3-h", "设计评审 · 进行中", 2),
        paragraph("pv3-p1", "列表 → 打开 → 正文三步流已走通，视觉重排留给 D2。"),
        quote("pv3-q", "半成品我无法确认效果——所以先看成品，再谈视觉。"),
        paragraph("pv3-p2", "引用块与正文块混排，验证多块渲染。"),
      ],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-004", title: "技术规范修订", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "revising" },
      blocks: [
        heading("pv4-h", "技术规范修订", 2),
        paragraph("pv4-p1", "规范会腐坏，故改契约必须同 diff 改文档。"),
        divider("pv4-d1"),
        paragraph("pv4-p2", "分隔线之后的第二段，验证非空正文。"),
      ],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-005", title: "结项复盘 · 已归档", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "done" },
      blocks: [
        heading("pv5-h", "结项复盘 · 已归档", 2),
        paragraph("pv5-p1", "已完成的事项留档，状态取四态中的 done。"),
        todo("pv5-t1", "真后端 + 种子 + 一条命令", true),
      ],
    },
  },
  {
    // 空标题：DocProps.title 要求 min(1)，单空格是 schema 允许的最接近「空」的形态。
    record: {
      props: { id: "DOC-PREVIEW-006", title: " ", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "draft" },
      blocks: [
        paragraph("pv6-p1", "这条文档的标题是单个空格——列表里应显示为空白标题，但点开仍有正文。"),
        quote("pv6-q", "空标题覆盖：验证列表不因空标题崩溃。"),
      ],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-007", title: "多块混排示例", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "in_progress" },
      blocks: [
        heading("pv7-h1", "多块混排示例", 1),
        paragraph("pv7-p1", "第一段。"),
        paragraph("pv7-p2", "第二段。"),
        heading("pv7-h2", "小节标题", 3),
        quote("pv7-q", "引用一句话。"),
        todo("pv7-t1", "待办一", false),
        todo("pv7-t2", "待办二", true),
        divider("pv7-d"),
        paragraph("pv7-p3", "最后一段。"),
      ],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-008", title: "代码片段与语言标注", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "draft" },
      blocks: [
        heading("pv8-h", "代码片段与语言标注", 2),
        code("pv8-c1", "pnpm run dev:preview", "bash"),
        paragraph("pv8-p1", "代码块覆盖：验证非富文本块不吞正文。"),
      ],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-009", title: "短句列表", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "revising" },
      blocks: [paragraph("pv9-p1", "短句。用于覆盖只有一段的最小文档。")],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-010", title: "四态覆盖 · done", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME, status: "done" },
      blocks: [
        paragraph("pv10-p1", "状态字段覆盖 done。"),
        paragraph("pv10-p2", "两段正文，避免详情只有标题。"),
      ],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-011", title: "不同更新时间的文档", author: "iss-2322", created: "2026-11-20T09:00:00+08:00", updated: "2026-11-21T06:00:00+08:00", status: "in_progress" },
      blocks: [heading("pv11-h", "不同更新时间的文档", 2), paragraph("pv11-p1", "created 与 updated 不同，覆盖时间字段差异。")],
    },
  },
  {
    record: {
      props: { id: "DOC-PREVIEW-012", title: "无状态文档", author: "iss-2322", created: SEED_TIME, updated: SEED_TIME },
      blocks: [paragraph("pv12-p1", "status 缺省（schema 允许 optional），覆盖无状态文档。")],
    },
  },
]

/** 幂等落库所需的最小门面结构（由 ctx.documents 满足）。 */
export interface SeedDocuments {
  get(id: string): DocRecord | undefined
  create(input: DocRecord): Promise<DocRecord>
}

/** 落库结果读数。 */
export interface SeedResult {
  readonly added: number
  readonly skipped: number
  readonly total: number
}

/**
 * 按 id 判存在则跳过地落种子：重跑不翻倍，也不覆盖用户已有修改。
 * @param documents - 文档门面（create 对重复 id 会抛 DocumentExistsError，故先 get 判存）。
 * @returns added / skipped / total 计数。
 */
export async function seedPreviewDocuments(documents: SeedDocuments): Promise<SeedResult> {
  let added = 0
  let skipped = 0
  for (const seed of PREVIEW_SEEDS) {
    if (documents.get(seed.record.props.id) !== undefined) {
      skipped++
      continue
    }
    await documents.create(seed.record)
    added++
  }
  return { added, skipped, total: PREVIEW_SEEDS.length }
}
