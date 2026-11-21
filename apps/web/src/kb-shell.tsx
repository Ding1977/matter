/**
 * kb 三步流壳（ISS-538 / P4-S2 · 验收 A2；ISS-542 / P4-N2 切真 Remote）。
 *
 * 列表 → 打开 → 正文三步走全。ISS-542 起数据源经 {@link DocumentsPort} seam 注入：
 * - 真机 boot 注入 `createRemoteDocumentsPort(ctx)`（`ctx.remote.document.*`，真 fetch）；
 * - 既有 in-process 测试不传 port ⇒ 仍走 STUB_DOCS，W7/boot/kb-flow 断言零改。
 *
 * ## 装配口径（shell 是组合根）
 *
 * `renderSurface` 是 ui-kb detail 注入的 seam：跨包 UI 经回调/slot 注入，ui-kb 源码零 import
 * ui-blocks（W7 纪律）。真机壳是装配点，可在回调里同时 import 两包并把它们接起来。
 * N 轨只换 loadDoc 的数据来源；不传 port 时 renderSurface 仍用真编辑器（stub body）。
 * 传 port 时正文回显走 port 投影的 BodyBlock（契约最小展示面），不依赖 stub body。
 *
 * @module apps/web/src/kb-shell
 */

import { createElement, useEffect, useRef, useState } from "react"
import type { FC, ReactElement, ReactNode } from "react"
import { DocDetail, DocList, EDITOR_SURFACE_SLOT, resolveMessages } from "@matter/client-ui-kb/client"
import type { BodyBlock, DocDetailRow, DocRow, SurfaceRenderer } from "@matter/client-ui-kb/client"
import type { DocumentsPort } from "@matter/client-ui-kb/client"
import { bootFullEditor, createHeadlessView } from "@matter/client-ui-blocks/client"
import type { OurBlock } from "@matter/client-ui-blocks/client"
import { plainRich } from "@matter/client-ui-blocks/client"
import { installEditorStyles } from "./editor-css.ts"
import { PageShell, DEFAULT_SHELL_WIDTH } from "./page-shell.tsx"
import css from "./kb-shell.module.css"

/** in-process stub 文档（不传 port 时的默认数据源，保留供既有测试）。 */
export interface StubDoc {
  readonly row: DocRow
  readonly body: readonly OurBlock[]
}

/** 两条 stub 文档，正文带可辨识中文，供真机与 jsdom 断言正文真现。 */
export const STUB_DOCS: readonly StubDoc[] = [
  {
    row: { id: "DOC-STUB-1", title: "欢迎使用 Matter 浏览器壳" },
    body: [
      { id: "stub1-h", type: "heading", level: 1, rich: [plainRich("欢迎使用 Matter 浏览器壳")] },
      { id: "stub1-p", type: "paragraph", rich: [plainRich("这是列表 → 打开 → 正文三步流的正文（真 BlockNote 渲染）。")] },
      { id: "stub1-todo", type: "todo", checked: true, rich: [plainRich("正文块已渲染")] },
    ],
  },
  {
    row: { id: "DOC-STUB-2", title: "P4-S1 · Vite 直连甲形态" },
    body: [
      { id: "stub2-h", type: "heading", level: 2, rich: [plainRich("P4-S1 · Vite 直连甲形态")] },
      { id: "stub2-q", type: "quote", rich: [plainRich("正文由 ui-blocks 的 headless view 渲染，不经过 stub。")] },
    ],
  },
]

/** 由 stub 集构造 loadDoc 回调（同步；旧 in-process 路径）。 */
export function stubLoadDoc(docs: readonly StubDoc[] = STUB_DOCS): (id: string) => DocDetailRow | undefined {
  return (id: string) => {
    const found = docs.find((d) => d.row.id === id)
    if (found === undefined) return undefined
    return {
      id: found.row.id,
      title: found.row.title,
      blocks: found.body.map((b) => ({ id: b.id, type: b.type, text: plainText(b) })),
    }
  }
}

/** OurBlock → 正文纯文本（detail 契约的最小展示形态）。 */
function plainText(block: OurBlock): string {
  if (!("rich" in block)) return ""
  return block.rich.map((r) => r.text).join("")
}

/** 真编辑器渲染位回调（stub body → BlockNote headless view）。 */
export function stubRenderSurface(docs: readonly StubDoc[] = STUB_DOCS): SurfaceRenderer {
  return (slot, owner): ReactNode => {
    if (slot !== EDITOR_SURFACE_SLOT) return null
    const found = docs.find((d) => d.row.id === owner.editorRef)
    if (found === undefined) return null
    const editor = bootFullEditor(found.body)
    return createElement("div", { "data-demo": "doc-body" }, createHeadlessView({ editor, editable: false }))
  }
}

/** in-process 取数端口（既有测试用：不装 remote 也能走 port seam）。 */
export function stubPort(docs: readonly StubDoc[] = STUB_DOCS): DocumentsPort {
  const load = stubLoadDoc(docs)
  return {
    async list() {
      return docs.map((d) => d.row)
    },
    async get(id) {
      return load(id)
    },
  }
}

/** 真 Remote 正文回显：port.get 投影出的 BodyBlock 真进 DOM（不依赖 stub body）。 */
export function remoteRenderSurface(cache: Map<string, readonly BodyBlock[]>): SurfaceRenderer {
  return (slot, owner): ReactNode => {
    if (slot !== EDITOR_SURFACE_SLOT) return null
    const blocks = cache.get(owner.editorRef) ?? []
    return createElement(
      "div",
      { "data-demo": "doc-body", "data-remote": "true" },
      ...blocks.map((block) => createElement("p", {
        key: block.id,
        "data-ui-kb": "remote-block",
        "data-block-type": block.type,
      }, block.text)),
    )
  }
}

export interface KbShellProps {
  /** 是否在文档打开时上报 id（供外层断言/埋点）。 */
  readonly onOpen?: (id: string) => void
  /**
   * 列表组件（由 boot 组合根注入，默认 = ui-kb DocList）。
   */
  readonly ListComponent?: typeof DocList
  /**
   * 取数端口（ISS-542 seam）：真机注入 ctx.remote.document.* 投影；不传 = in-process stub。
   */
  readonly port?: DocumentsPort
}

/**
 * kb 三步流组件：列表 → 点击设 active → 详情（含正文）渲染。
 * @param props - onOpen / ListComponent / port。
 * @returns ReactElement。
 */
export const KbShell: FC<KbShellProps> = (props) => {
  const [activeId, setActiveId] = useState<string | null>(null)
  // 视口宽（审查必修）：驱动三栏宽度轴；真机读 window.innerWidth + resize，SSR/测试回落默认。
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window === "undefined" ? DEFAULT_SHELL_WIDTH : window.innerWidth,
  )
  useEffect(() => {
    if (typeof window === "undefined") return
    const onResize = () => setViewportWidth(window.innerWidth)
    onResize()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  const messages = resolveMessages()
  const stubRows = STUB_DOCS.map((d) => d.row)
  const [remoteRows, setRemoteRows] = useState<readonly DocRow[]>([])
  const bodyCache = useRef(new Map<string, readonly BodyBlock[]>())
  const ListComponent = props.ListComponent ?? DocList
  const port = props.port

  useEffect(() => {
    const disposeCss = installEditorStyles()
    return () => disposeCss()
  }, [])

  useEffect(() => {
    if (port === undefined) return
    let alive = true
    void port.list().then((rows) => { if (alive) setRemoteRows(rows) })
    return () => { alive = false }
  }, [port])

  const rows = port === undefined ? stubRows : remoteRows
  const loadDoc = port === undefined
    ? stubLoadDoc()
    : async (id: string): Promise<DocDetailRow | undefined> => {
        try {
          const doc = await port.get(id)
          if (doc !== undefined) bodyCache.current.set(id, doc.blocks)
          return doc
        } catch (error) {
          // 卸载/dispose 时在途 RPC 会被 client 取消（gateway/cancelled）——组件已不消费，
          // 归一为 undefined 免得 DocDetail 的 Promise 链抛 unhandled；其余失败也只让详情留空。
          void error
          return undefined
        }
      }
  const renderSurface = port === undefined ? stubRenderSurface() : remoteRenderSurface(bodyCache.current)

  const open = (id: string) => {
    setActiveId(id)
    props.onOpen?.(id)
  }

  const activeRow = rows.find((r) => r.id === activeId)

  return createElement(
    PageShell,
    {
      // 宽驱动（审查必修）：视口宽注入宽度轴，窄宽下右栏先收缩、中栏保 400、侧栏收起/抽屉。
      width: viewportWidth,
      // renderSlot 注入：侧栏/内容/属性栏三槽各司其职；列表与详情挂在内容槽。
      renderSlot: (slot) => {
        if (slot === "shell.sidebar") {
          return createElement(
            "nav",
            { "data-shell": "sidebar", "aria-label": messages.sidebarTitle },
            createElement("h2", { className: css.title }, messages.sidebarTitle),
          )
        }
        if (slot === "shell.properties") {
          return createElement(
            "aside",
            { "data-shell": "properties" },
            createElement("h2", { className: css.title }, messages.propertiesTitle),
            activeRow === undefined
              ? createElement("p", { "data-ui-kb": "properties-empty" }, messages.propertiesEmptyHint)
              : createElement("dl", { "data-ui-kb": "properties" },
                  createElement("dt", null, messages.propertiesIdLabel),
                  createElement("dd", null, activeRow.id),
                  createElement("dt", null, messages.propertiesTitleLabel),
                  createElement("dd", null, activeRow.title),
                ),
          )
        }
        return createElement(
          "div",
          { "data-shell": "surface", "data-demo": "kb-shell" },
          createElement("h2", { className: css.title }, messages.listTitle),
          createElement(ListComponent, { rows, onOpen: open, messages, selectedId: activeId }),
          activeId === null
            ? null
            : createElement(DocDetail, {
                docId: activeId,
                loadDoc,
                renderSurface,
                messages,
              }),
        )
      },
    },
  )
}
