/**
 * documents-port seam（ISS-542 / P4-N2 · ui-kb 从进程内直连切真 Remote）。
 *
 * ## 三角色
 *
 * - 服务定义（本文件）：{@link DocumentsPort} —— ui-kb 详情/列表只认这组取数回调，
 *   contract/UI 层零改动（spec §3.6「只换 transport，contract 与 Service 实现不动」）。
 * - 服务提供方（shell / 测试）：{@link createRemoteDocumentsPort} 把 cordis 的
 *   `ctx.remote.document.*`（2314 生成的 `./remote` 投影）投影成本端口。
 * - 消费方（DocList / DocDetail 装配点）：拿到 port 的 list/get 结果经既有 props 传入，UI 组件不动。
 *
 * 本文件不 import `@matter/document` 的重类型：远端记录按结构最小面接收，`blocks`
 * 投影成契约里的 `{id, type, text}`（与 shell 旧 stub 的 plainText 同义，但不再依赖 stub）。
 *
 * @module @matter/client-ui-kb/client/port/documents
 */

import type { Context } from "@deepseek-ai/cordis"
import type { BodyBlock, DocDetailRow, DocRow } from "../contract/doc.ts"

/**
 * `ctx.remote.document` 的最小结构面。不在源码里 import gateway client 的声明——那会把它的
 * 可选 peer 类型（dsh-session / dsh-llm）拖进 ui-kb 的 typecheck，而 P4 最小闭环没装这些 peer。
 * 真正的生成类型在组合根（shell）里由 `@matter/document-controller/remote` 投影提供，
 * 本端口只按契约结构消费，UI 零改动。
 */
interface RemoteDocumentContract {
  list(request?: DocumentsListRequest): Promise<RemoteResultLike<{ readonly items: readonly DocRow[] }>>
  get(request: { readonly id: string }): Promise<RemoteResultLike<{ readonly record: RemoteRecordLike }>>
}

/** RemoteResult 的最小判别联合（不 import typert-protocol 的重类型）。 */
type RemoteResultLike<V> = { readonly ok: true; readonly value: V } | { readonly ok: false; readonly error: unknown }

/** 装配缺失的类型化错误（bare-throw 禁令：用本端口的错误类，不裸 throw new Error）。 */
export class DocumentsPortError extends Error {
  override name = "DocumentsPortError"

  constructor(message: string) {
    super(message)
  }
}

/** 远端 list 的可见请求形状（与生成 `DocListRequest` 结构同形）。 */
export interface DocumentsListRequest {
  readonly prefix?: string
}

/** 文档取数端口：列表 + 详情，均异步（真 Remote 往返）。 */
export interface DocumentsPort {
  /** 列文档行（可前缀过滤）。 */
  list(request?: DocumentsListRequest): Promise<readonly DocRow[]>
  /** 读一条详情（标题 + 正文最小展示块）；不存在返回 undefined。 */
  get(id: string): Promise<DocDetailRow | undefined>
}

/** 从 client context 取 document 远端契约（结构性窄化，不加运行时依赖）。 */
function remoteDocument(ctx: Context): RemoteDocumentContract {
  const remote = Reflect.get(ctx, "remote") as { readonly document?: RemoteDocumentContract } | undefined
  const document = remote?.document
  if (document === undefined) {
    throw new DocumentsPortError("ctx.remote.document is not mounted; install the remote client before creating the port")
  }
  return document
}

/** 远端记录的最小结构面（避免 import @matter/document 重依赖）。 */
interface RemoteRecordLike {
  readonly props: { readonly id: string; readonly title: string }
  readonly blocks: readonly (unknown & {
    readonly id?: string
    readonly type?: string
    readonly rich?: readonly { readonly text: string }[]
    readonly text?: string
  })[]
}

/** 远端 block → 契约 BodyBlock（与既有 plainText 投影同义）。 */
function projectBlock(block: RemoteRecordLike["blocks"][number]): BodyBlock {
  const rich = "rich" in block && Array.isArray(block.rich) ? block.rich : []
  const text = "text" in block && typeof block.text === "string"
    ? block.text
    : rich.map((part) => part.text).join("")
  return {
    id: String(block.id ?? ""),
    type: String(block.type ?? "paragraph"),
    text,
  }
}

/** RemoteResult 的失败分支：`document/not-found` 归一为 undefined，其余抛错不吞。 */
function notFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false
  const code = (error as { readonly code?: unknown }).code
  return code === "document/not-found"
    || (typeof code === "string" && code.includes("not-found"))
}

/**
 * 用 `ctx.remote.document.*` 构造 documents-port（真 fetch 通道的 consumer 投影）。
 *
 * 远端调用返回 `RemoteResult`（`{ok:true,value}` / `{ok:false,error}`）：成功取 value，
 * `document/not-found` 归一为 undefined（与旧 `loadDoc` 签名一致），其余失败抛出——
 * 边界显式，不静默返回空列表冒充成功。
 *
 * @param ctx - 已装好 `ctx.remote`（gateway client 半 + $mount）的 cordis client context。
 * @returns 可直接喂给 DocList/DocDetail 装配点的端口。
 */
export function createRemoteDocumentsPort(ctx: Context): DocumentsPort {
  return {
    async list(request) {
      const result = await remoteDocument(ctx).list(request)
      if (!result.ok) throw result.error
      return result.value.items
    },
    async get(id) {
      const result = await remoteDocument(ctx).get({ id })
      if (!result.ok) {
        if (notFound(result.error)) return undefined
        throw result.error
      }
      const record = result.value.record
      return {
        id: record.props.id,
        title: record.props.title,
        blocks: record.blocks.map(projectBlock),
      }
    },
  }
}
