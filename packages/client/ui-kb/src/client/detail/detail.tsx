/**
 * doc 详情（layer 1，domain=detail）：打开 doc → 经 slot 渲染正文。
 *
 * ## W7 的落点
 *
 * 「打开 doc → 编辑器渲染正文」这一步**经 slot 拿 `blocks.editor.surface`**：
 * 本组件拿到的是装配方注入的 `renderSurface` 回调（绑到 cordis `ctx.slots.renderSlot`），
 * 只用契约里的 slot key 调用它，真正渲染正文的 React 组件由 ui-blocks 在 slot 上占用。
 * **零 import ui-blocks**——连类型都不引，跨包 UI 只走 slot（DOC-512 §4.5）。
 *
 * 数据（doc 正文）走 `loadDoc` 回调（behavior 走 controller/ctx 注入），
 * 与 UI 渲染位分开：这正是 DSH 「behavior through injected services, UI through slots」。
 *
 * @module @matter/client-ui-kb/client/detail/detail
 */

import { createElement, useEffect, useState } from "react"
import type { ReactElement } from "react"
import {
  EDITOR_SURFACE_SLOT,
  type DocDetailRow,
  type SurfaceRenderer,
} from "../contract/doc.ts"
import type { Messages } from "../locale.ts"

/** doc 详情入参。 */
export interface DocDetailProps {
  /** 要打开的文档 id。 */
  readonly docId: string
  /** 取文档详情的回调（装配方绑 controller.get → ctx.documents.get）。 */
  readonly loadDoc: (id: string) => Promise<DocDetailRow | undefined> | DocDetailRow | undefined
  /** 正文渲染位（装配方绑 ctx.slots.renderSlot）。 */
  readonly renderSurface: SurfaceRenderer
  /** 用户可见文案（locale 字典）。 */
  readonly messages: Messages
}

/**
 * 打开文档并渲染正文。标题用字典文案；正文交给 slot 的渲染位组件。
 * @param props - docId / loadDoc / renderSurface / 文案。
 * @returns React 元素。
 */
export function DocDetail(props: DocDetailProps): ReactElement {
  const { docId, loadDoc, renderSurface, messages } = props
  const [doc, setDoc] = useState<DocDetailRow | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void Promise.resolve(loadDoc(docId)).then((next) => {
      if (alive) setDoc(next)
    })
    return () => {
      alive = false
    }
  }, [docId, loadDoc])

  const body = doc === undefined
    ? createElement("p", { "data-ui-kb": "loading" }, messages.loadingHint)
    : createElement(
      "article",
      { "data-ui-kb": "body", "data-doc-id": doc.id },
      renderSurface(EDITOR_SURFACE_SLOT, { editorRef: doc.id }),
    )

  return createElement(
    "section",
    { "data-ui-kb": "detail" },
    createElement("h2", null, doc?.title ?? messages.detailTitle),
    body,
  )
}
