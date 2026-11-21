/**
 * `@matter/document-controller` —— api 组首包：document 域的 @Remote host Service。
 *
 * ## 形态（ISS-533 / U-0 问6）
 *
 * 照 DSH `packages/api/session-controller/src/index.ts` 立 host 半 Service：
 * `extends TypertRemoteService` + `@Remote('list' | 'get' | 'update')` 三方法，
 * `super(ctx, 'document')` 把 service key 兼作默认 wire namespace。依赖
 * `@deepseek-ai/dsh-typert-protocol@0.2.2-rc.2`（npm exact 直装）——TS 面与 DSH 同构，
 * P4 接 gateway 时零返工。**不接 typert-generator**（Lead 决策：P3 无跨进程消费者，
 * artifact 无读者，违反「每个抽象有当前消费者」；generator 接线随 P4 gateway 单）。
 *
 * ## 真实读写面
 *
 * 三方法都走 `ctx.documents`（`@matter/document` 的 `DocumentsFacility`，唯一写路径 +
 * 活动流落点）。controller 不另开存储通道，只读/转交门面的 `entries` / `get` / `update`。
 * 本包不铺 connection / gateway / remotes —— P3 数据通道是测试内进程直连（vitest boot cordis）。
 *
 * @module @matter/document-controller
 */

import type { Domain } from "@matter/storage-domain"
import { DocumentDomain } from "@matter/document"
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol"
import type { Context } from "@deepseek-ai/cordis"
import type {
  DocGetRequest,
  DocGetValue,
  DocListRequest,
  DocListValue,
  DocRow,
  DocUpdateRequest,
  DocUpdateValue,
} from "./types.ts"

// Remote boundary 类型归 ./types 子路径（generator 的 publicRemoteType 要求非根导出）；
// 这里 re-export 保持既有消费者从根 `.` import 的写法零破坏（ISS-539 / P4-N1）。
export type * from "./types.ts"

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** document 域的 @Remote host Service（wire namespace `document`）。 */
    document: DocumentController
  }
}

declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    /** get 的 id 不存在。 */
    "document/not-found": { readonly id: string }
  }
}

/** 文档域句柄类型（storage-domain 的 defineDomain 实例，供 host 装配侧引用）。 */
export type DocumentDomainHandle = Domain<typeof DocumentDomain>

/**
 * document 域的 @Remote host Service。构造即经 Service 基类注册到 `ctx.document`。
 */
export class DocumentController extends TypertRemoteService {
  /**
   * @param ctx - 已注入 `ctx.documents` 的 Cordis 上下文。
   */
  constructor(ctx: Context) {
    super(ctx, "document")
  }

  /**
   * 列文档行（可按 id 前缀过滤）；只读，不恢复正文编辑器。
   * @param request - 可选 prefix。
   * @returns 可见文档行数组。
   */
  @Remote("list")
  list(request?: DocListRequest): DocListValue {
    const filter = request ?? {}
    const items: DocRow[] = []
    for (const [id, record] of this.ctx.documents.entries()) {
      if (filter.prefix !== undefined && !id.startsWith(filter.prefix)) continue
      items.push({ id, title: record.props.title })
    }
    return { items }
  }

  /**
   * 读一条文档整记录。
   * @param request - 文档 id。
   * @returns `{props, blocks}` 整记录。
   * @throws RemoteError('document/not-found') —— id 不存在。
   */
  @Remote("get")
  get(request: DocGetRequest): DocGetValue {
    const record = this.ctx.documents.get(request.id)
    if (record === undefined) {
      throw new RemoteError("document/not-found", `document '${request.id}' does not exist`, { id: request.id })
    }
    return { record }
  }

  /**
   * 局部更新一条文档（props / blocks 各自整体替换）。
   * @param request - 文档 id 与 PATCH。
   * @returns 更新后的整记录。
   */
  @Remote("update")
  async update(request: DocUpdateRequest): Promise<DocUpdateValue> {
    const record = await this.ctx.documents.update(request.id, request.patch)
    return { record }
  }
}

/** Cordis 插件名。 */
export const name = "document-controller"

/**
 * 装配点：在 fiber 内构造 Service（Service 基类自动注册到 `ctx.document`）。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    new DocumentController(ctx)
    // Service 基类经 ctx.reflect.provide 把自身绑到当前 fiber，卸载自动注销；
    // 本 effect 只需持有 fiber，返回空 disposer（真正的清理由 Service 自己负责）。
    // 该 disposer 只在 cordis fiber 卸载时被框架调用，单测不直接触发 ⇒ v8 ignore（真理由）。
    /* v8 ignore next -- cordis fiber 卸载时才调用，单测不直接触发 disposer */
    return () => {}
  }, "document-controller: service")
}
