// @vitest-environment jsdom
/**
 * document-controller 单元测试（ISS-533）：@Remote 三方法真实读写走 ctx.documents。
 * 覆盖率目标：本包 perFile 100（api 域阈值），故每个方法、每条分支都要走到。
 *
 * @module @matter/document-controller/tests/controller
 */
import { Context } from "@deepseek-ai/cordis"
import { remoteMethods, type RemoteError } from "@deepseek-ai/dsh-typert-protocol"
import type { DocPatch, DocRecord } from "@matter/document"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DocumentController,
  apply,
  name,
  type DocListRequest,
  type DocGetRequest,
  type DocUpdateRequest,
} from "../src/index.ts"

/** 构造一条合法 DocRecord（props 必填项齐 + 一段正文 blocks）。 */
const doc = (id: string, title: string, text: string): DocRecord => ({
  props: {
    id,
    title,
    author: "tester",
    created: "2026-11-20T00:00:00+08:00",
    updated: "2026-11-20T00:00:00+08:00",
  },
  blocks: [{ id: `${id}-b1`, type: "paragraph", rich: [{ text, marks: [] }] }],
})

/** 最小 ctx.documents stub：只实现 controller 用到的 entries / get / update。 */
function stubDocuments(records: DocRecord[]) {
  const map = new Map(records.map((r) => [r.props.id, r]))
  const update = vi.fn(async (id: string, patch: DocPatch): Promise<DocRecord> => {
    const cur = map.get(id)
    if (cur === undefined) throw new Error(`no doc ${id}`)
    const merged: DocRecord = {
      props: { ...cur.props, ...patch.props },
      blocks: patch.blocks ?? cur.blocks,
    }
    map.set(id, merged)
    return merged
  })
  return {
    entries: () => map.entries(),
    get: (id: string) => map.get(id),
    update,
    map,
  }
}

describe("document-controller · @Remote 三方法", () => {
  let ctx: Context
  let docs: ReturnType<typeof stubDocuments>
  let controller: DocumentController

  beforeEach(() => {
    ctx = new Context()
    docs = stubDocuments([
      doc("DOC-1", "First doc", "第一段正文"),
      doc("DOC-2", "Second doc", "第二段正文"),
      doc("TASK-9", "A task", "任务正文"),
    ])
    // @ts-expect-error —— 测试最小注入，形状满足 controller 读取面
    ctx.provide("documents", docs)
    controller = new DocumentController(ctx)
  })

  it("构造即注册到 ctx.document（Service 基类提供）", () => {
    // cordis 把带 invoke 面的 Service 注册成 callable 包装（与实例行为一致、非同一引用），
    // 故按「键在册 + 行为可用」断言，而非 Object.is。
    expect(ctx.document.name).toBe("document")
    expect(ctx.document.get({ id: "DOC-1" }).record.props.id).toBe("DOC-1")
    expect(controller.name).toBe("document")
  })

  it("@Remote 导出面 = list/get/update 三方法", () => {
    const markers = remoteMethods(controller)
    expect(markers.map((m) => m.exportName ?? m.method).sort()).toEqual(["get", "list", "update"])
  })

  it("list 无前缀：返回全部行（不含 blocks）", () => {
    const res = controller.list()
    expect(res.items).toEqual([
      { id: "DOC-1", title: "First doc" },
      { id: "DOC-2", title: "Second doc" },
      { id: "TASK-9", title: "A task" },
    ])
    expect("blocks" in res.items[0]!).toBe(false)
  })

  it("list 带前缀：只返回 id 命中的行（prefix 分支 + 跳过分支）", () => {
    const req: DocListRequest = { prefix: "DOC-" }
    expect(controller.list(req).items).toEqual([
      { id: "DOC-1", title: "First doc" },
      { id: "DOC-2", title: "Second doc" },
    ])
    // 不命中的前缀 ⇒ 空数组（走到 continue 且无 push）
    expect(controller.list({ prefix: "ZZZ" }).items).toEqual([])
  })

  it("get 命中：返回整条 {props, blocks}", () => {
    const req: DocGetRequest = { id: "DOC-1" }
    expect(controller.get(req).record.blocks[0]?.type).toBe("paragraph")
    expect(controller.get(req).record.props.title).toBe("First doc")
  })

  it("get 未命中：抛 document/not-found RemoteError（带 code 与 id）", () => {
    expect(() => controller.get({ id: "NOPE" })).toThrowError(/does not exist/)
    try {
      controller.get({ id: "NOPE" })
      expect.unreachable("should have thrown")
    } catch (e) {
      const err = e as RemoteError<"document/not-found">
      expect(err.code).toBe("document/not-found")
      expect(err.details).toEqual({ id: "NOPE" })
    }
  })

  it("update：把 PATCH 交给 ctx.documents.update 并返回更新后的记录", async () => {
    const req: DocUpdateRequest = { id: "DOC-1", patch: { props: { title: "Renamed" } } }
    const res = await controller.update(req)
    expect(res.record.props.title).toBe("Renamed")
    expect(docs.update).toHaveBeenCalledWith("DOC-1", req.patch)
  })

  it("apply 插件名与装配点可调用", () => {
    expect(name).toBe("document-controller")
    const c2 = new Context()
    // @ts-expect-error —— 测试最小注入
    c2.provide("documents", stubDocuments([]))
    apply(c2)
    expect(c2.document).toBeInstanceOf(DocumentController)
  })
})
