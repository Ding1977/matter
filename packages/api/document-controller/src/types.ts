/**
 * Public Remote boundary types for `@matter/document-controller` (ISS-539 · P4-N1).
 *
 * @Remote request/value types must be reachable from a non-root `./types` export for
 * the Typert generator to project them into the client `./remote` artifact
 * (`generator/analyzer.ts` `publicRemoteType`: root `.` is rejected unless the
 * package is in `PUBLIC_REMOTE_TYPE_ROOTS`). DSH's session-controller declares
 * the same `./types` subpath; this is its document-domain counterpart.
 *
 * The root `index.ts` re-exports these types (`export type * from './types.ts'`),
 * so existing consumers importing from `.` are unchanged.
 *
 * @module @matter/document-controller/types
 */

import type { DocPatch, DocRecord } from "@matter/document"

/** list 请求：可选 id 前缀过滤（空 = 全部）。 */
export interface DocListRequest {
  readonly prefix?: string
}

/** 一条文档行（列表面，不携带正文 blocks）。 */
export interface DocRow {
  readonly id: string
  readonly title: string
}

/** list 返回值。 */
export interface DocListValue {
  readonly items: readonly DocRow[]
}

/** get 请求：文档 id。 */
export interface DocGetRequest {
  readonly id: string
}

/** get 返回值：整条 `{props, blocks}` 记录。 */
export interface DocGetValue {
  readonly record: DocRecord
}

/** update 请求：文档 id + PATCH（props / blocks 各自整体替换）。 */
export interface DocUpdateRequest {
  readonly id: string
  readonly patch: DocPatch
}

/** update 返回值：更新后的整条记录。 */
export interface DocUpdateValue {
  readonly record: DocRecord
}
