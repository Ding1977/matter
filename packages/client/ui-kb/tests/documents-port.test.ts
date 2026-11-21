// @vitest-environment node
/**
 * documents-port seam 单元覆盖（ISS-542 / P4-N2）。
 *
 * 这里的 fake remote 只为**覆盖 port 的投影/判别分支**（coverage lane 只跑 packages/）；
 * 真 fetch 通道的端到端判据在 apps/host/tests/q5-e2e.test.ts（真 gateway/controller/documents），
 * 两者职责不同——本文件不冒充端到端。
 *
 * @module @matter/client-ui-kb/tests/documents-port
 */

import { Context } from "@deepseek-ai/cordis"
import { describe, expect, it } from "vitest"
import { createRemoteDocumentsPort, DocumentsPortError } from "../src/client/port/documents.ts"

/** 造一个带 `remote.document` 的 client context（Reflect.set 不做类型断言）。 */
function ctxWith(remote: object): Context {
  const ctx = new Context()
  Reflect.set(ctx, "remote", remote)
  return ctx
}

describe("documents-port · ctx.remote.document 投影与判别", () => {
  it("list 成功取 value.items；请求参数原样透传", async () => {
    const seen: unknown[] = []
    const ctx = ctxWith({
      document: {
        async list(request?: unknown) {
          seen.push(request)
          return { ok: true, value: { items: [{ id: "D1", title: "真链标题" }] } }
        },
        async get() {
          return { ok: false, error: new Error("unused") }
        },
      },
    })
    const port = createRemoteDocumentsPort(ctx)
    expect(await port.list()).toEqual([{ id: "D1", title: "真链标题" }])
    await port.list({ prefix: "D" })
    expect(seen).toEqual([undefined, { prefix: "D" }])
  })

  it("get 成功：record.blocks 投影成 {id,type,text}，rich/text 两种形态都守恒", async () => {
    const ctx = ctxWith({
      document: {
        async list() {
          return { ok: true, value: { items: [] } }
        },
        async get(request: { id: string }) {
          return {
            ok: true,
            value: {
              record: {
                props: { id: request.id, title: "标题" },
                blocks: [
                  { id: "b1", type: "paragraph", rich: [{ text: "甲" }, { text: "乙" }] },
                  { id: "b2", type: "code", text: "代码片段" },
                  { id: "b3", type: "divider" },
                ],
              },
            },
          }
        },
      },
    })
    const doc = await createRemoteDocumentsPort(ctx).get("DX")
    expect(doc).toEqual({
      id: "DX",
      title: "标题",
      blocks: [
        { id: "b1", type: "paragraph", text: "甲乙" },
        { id: "b2", type: "code", text: "代码片段" },
        { id: "b3", type: "divider", text: "" },
      ],
    })
  })

  it("get 的 document/not-found 归一为 undefined；其它失败抛出不吞", async () => {
    const ctx = ctxWith({
      document: {
        async list() {
          return { ok: true, value: { items: [] } }
        },
        async get(request: { id: string }) {
          if (request.id === "missing") return { ok: false, error: { code: "document/not-found" } }
          return { ok: false, error: { code: "gateway/internal", message: "boom" } }
        },
      },
    })
    const port = createRemoteDocumentsPort(ctx)
    await expect(port.get("missing")).resolves.toBeUndefined()
    await expect(port.get("other")).rejects.toMatchObject({ code: "gateway/internal" })
  })

  it("ctx.remote.document 未装配时抛类型化错误（不静默返回空数据）", async () => {
    const port = createRemoteDocumentsPort(new Context())
    await expect(port.list()).rejects.toBeInstanceOf(DocumentsPortError)
  })
})
