/**
 * `DocProps`（全量 25 字段）与 `DocumentDomain`（blocks 槽）的契约。
 *
 * 写成「换成错误实现即红」的形态：字段数、每字段三件 meta、坏值抛 zod error、
 * defineDomain 的 load 期自检真的过、blocks 平级落盘的运行时形状与类型派生。
 *
 * @module @matter/document/tests/spec
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"
import { Block } from "@matter/blocks"
import type { TableValueOf } from "@matter/storage-domain"
import {
  DOCUMENT_CARD_KINDS, DOCUMENT_ENTITY_PREFIX, DOCUMENT_KINDS,
  DOCUMENT_MEDIA_TYPES, DOCUMENT_SESSION_KINDS, DOCUMENT_STATUSES, DOCUMENT_TABLE,
  BlockArray, DocPatch, DocProps, DocRecord, DocumentDomain,
} from "../src/index.ts"

/** 必填 5 项的最小 props。 */
const minProps = () => ({
  id: "DOC-1", title: "第一份", author: "linmo",
  created: "2026-11-20T00:00:00Z", updated: "2026-11-20T00:00:00Z",
})

/** 权威 25 字段清单（`fieldsForDomain('documents')` 实测，字母序）。 */
const FIELDS = [
  "activity", "author", "cardKind", "created", "deleted", "id", "kind", "log_size",
  "mediaType", "model", "outcome", "project", "refs", "relations", "session",
  "session_kind", "source", "source_session", "status", "tags", "title", "type",
  "updated", "verdict", "workspace",
]

describe("DocProps：全量 25 字段", () => {
  it("schema 恰有 25 个字段，与权威清单逐字相等（多一个少一个都红）", () => {
    expect(Object.keys(DocProps.shape).sort()).toEqual(FIELDS)
    expect(FIELDS).toHaveLength(25)
  })

  it("最小合法 props 只填 5 个必填项；可选字段缺省就是没有（不被默认值材料化）", () => {
    const parsed = DocProps.parse(minProps())
    expect(Object.keys(parsed).sort()).toEqual(["author", "created", "id", "title", "updated"])
    for (const f of FIELDS.filter((f) => !["author", "created", "id", "title", "updated"].includes(f))) {
      expect(parsed).not.toHaveProperty(f)
    }
  })

  it("全量 25 字段各类型合法值都能过；枚举词表逐字正确", () => {
    const full = {
      ...minProps(),
      activity: "2026-11-20 会话", cardKind: "session-distill", deleted: false,
      kind: "document", log_size: "2.2M", mediaType: "md", model: "hy4",
      outcome: "完成", project: "PRJ-1", refs: ["AGENTS.md §2"],
      relations: ["references|issues/x.md"], session: "sess-1", session_kind: "main",
      source: "/tmp/x.md", source_session: "sess-0", status: "in_progress",
      tags: ["topic/x"], type: "document", verdict: "可 purge", workspace: "/repo",
    }
    expect(DocProps.parse(full)).toEqual(full)
    expect([...DOCUMENT_STATUSES]).toEqual(["draft", "in_progress", "revising", "done"])
    expect([...DOCUMENT_KINDS]).toEqual(["document"])
    expect([...DOCUMENT_MEDIA_TYPES]).toEqual(["md", "html", "text", "image", "audio", "video", "pdf", "other"])
    expect([...DOCUMENT_SESSION_KINDS]).toEqual(["main", "subagent"])
    expect([...DOCUMENT_CARD_KINDS]).toEqual(["session-distill"])
    expect(DOCUMENT_ENTITY_PREFIX).toBe("documents")
  })

  it("校验失败报 zod error 且 path 指坏字段：枚举 / 日期 / 未知键 / 数组元素", () => {
    const bad = DocProps.safeParse({ ...minProps(), status: "zap" })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error.issues[0]!.path).toEqual(["status"])
    expect(DocProps.safeParse({ ...minProps(), mediaType: "docx" }).success).toBe(false)
    expect(DocProps.safeParse({ ...minProps(), created: "2026-11-20" }).success).toBe(false)
    expect(DocProps.safeParse({ ...minProps(), 拼错的字段: 1 }).success).toBe(false)
    const unknown = DocProps.safeParse({ ...minProps(), 拼错的字段: 1 })
    if (!unknown.success) expect(unknown.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true)
    expect(DocProps.safeParse({ ...minProps(), tags: [1] }).success).toBe(false)
  })
})

describe("字段元数据（每字段 .meta）", () => {
  it("25 字段每个都带 writable / widget / indexable", () => {
    const shape = DocProps.shape as Record<string, z.ZodType>
    for (const f of FIELDS) {
      const meta = shape[f]!.meta() as Record<string, unknown> | undefined
      expect(meta, `${f} 缺 .meta()`).toBeDefined()
      expect(meta!.writable, `${f}.writable`).toBeDefined()
      expect(meta!.widget, `${f}.widget`).toBeDefined()
      expect(meta!.indexable, `${f}.indexable`).toBeDefined()
    }
    const w = (f: string) => (shape[f]!.meta() as { writable: string }).writable
    expect(w("id")).toBe("immutable"); expect(w("created")).toBe("immutable"); expect(w("type")).toBe("immutable")
    expect(w("status")).toBe("user"); expect(w("title")).toBe("user"); expect(w("verdict")).toBe("user")
    expect(w("author")).toBe("system"); expect(w("relations")).toBe("system")
    expect((shape.id!.meta() as { branded: string }).branded).toBe("DocId")
  })

  it("z.toJSONSchema 保留 meta（前端字段描述不需要第二处真相，且无 .transform 抛异常）", () => {
    const json = z.toJSONSchema(DocProps) as { properties: Record<string, Record<string, unknown>> }
    expect(json.properties.id!.writable).toBe("immutable")
    expect(json.properties.title!.widget).toBe("text")
    expect(json.properties.status!.enum).toEqual([...DOCUMENT_STATUSES])
    expect(JSON.stringify(z.toJSONSchema(DocProps))).toBe(JSON.stringify(json))
  })
})

describe("DocPatch：PATCH 面", () => {
  it("整体替换 props / blocks；未知键、空 {} 的边界", () => {
    expect(DocPatch.parse({})).toEqual({})
    expect(DocPatch.parse({ blocks: [{ id: "b1", type: "paragraph" }] })).toHaveProperty("blocks")
    expect(DocPatch.safeParse({ 拼错: 1 }).success).toBe(false)
    // props 必填项未给全 ⇒ 拒（整体替换，不深合并单字段）
    expect(DocPatch.safeParse({ props: { title: "只有标题" } }).success).toBe(false)
    expect(DocPatch.parse({ props: minProps() })).toHaveProperty("props")
  })
})

describe("blocks 槽：Block 数组 schema 与平级落盘形状", () => {
  it("合法块过、叶子塞 children 红（V5）、未知 type 红", () => {
    expect(BlockArray.safeParse([{ id: "b1", type: "paragraph", rich: [{ text: "hi" }] }]).success).toBe(true)
    expect(Block.safeParse({ id: "b1", type: "paragraph", children: [] }).success).toBe(false)
    expect(BlockArray.safeParse([{ id: "b1", type: "zap" }]).success).toBe(false)
  })

  it("DocRecord 是 {props, blocks} 平级；未知顶层键报错", () => {
    const value = { props: minProps(), blocks: [{ id: "b1", type: "paragraph", rich: [{ text: "hi" }] }] }
    expect(DocRecord.parse(value)).toEqual(value)
    expect(DocRecord.safeParse({ ...value, 拼错: 1 }).success).toBe(false)
  })

  it("defineDomain 声明 blocks 槽；descriptor 不携带 blocks 概念（storage 契约零改）", () => {
    expect(DocumentDomain.name).toBe("kb_document")
    expect(DocumentDomain.version).toBe(1)
    expect(Object.keys(DocumentDomain.tables)).toEqual([DOCUMENT_TABLE])
    const table = DocumentDomain.tables[DOCUMENT_TABLE]!
    expect(Object.keys(table).sort()).toEqual(["blocksSchema", "valueSchema"])
    // 类型派生：blocks 表的值是平级 {props, blocks}（E-0/E-1 的裸 props 形态未变，由地基用例守）
    type DV = TableValueOf<typeof DocumentDomain, typeof DOCUMENT_TABLE>
    const dv: DV = { props: minProps() as never, blocks: [] }
    expect(dv.blocks).toEqual([])
  })
})
