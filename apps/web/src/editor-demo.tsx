/**
 * `/editor-demo` 真编辑器夹具页（ISS-538 / P4-S2 · 验收 A1）。
 *
 * 与 ISS-537 的 stub 页不同，这里是**真 BlockNote 编辑器实例**（非 stub）：
 * 用 ui-blocks 的 `bootFullEditor`（fullBlockNoteSchema，第一批 14 块）+ `createHeadlessView`
 * （BlockNoteViewRaw 无默认 UI）构造，编辑器文档在纯 JS 下可读写、view 可挂载。
 *
 * ## 中文默认态与 IME 夹具
 *
 * 初始内容是一段中文 paragraph + 标题 + 待办 + toggle（折叠/收开是操作序列的一环），
 * 中文默认输入态。真机验证 Q1（macOS 拼音组合期 Enter 选字不换段）由 Lead+老板在浏览器
 * 亲手输入销账——本页只提供「可编辑、可插入 14 块、可折叠、中文默认」的夹具面，不冒充已测。
 *
 * ## 14 块可插入面
 *
 * 工具条列出第一批 14 种块（A 档 9 + B 档 5，词表直取 ui-blocks 常量），点击经
 * `editor.insertBlocks` 真插入文档（不是往 data 属性写字符串）；插入后上报 document 快照，
 * 供 jsdom 断言与真机读数。
 *
 * @module apps/web/src/editor-demo
 */

import { createElement, useEffect, useRef } from "react"
import { createRoot } from "react-dom/client"
import type { FC, ReactElement } from "react"
import {
  OUR_A_TYPES,
  OUR_B_FIRST_TYPES,
  bnBlocksToOurFull,
  bootFullEditor,
  createHeadlessView,
  ourBlockToBnFull,
  plainRich,
} from "@matter/client-ui-blocks/client"
import type { BnEditor, OurBlock } from "@matter/client-ui-blocks/client"
import { installEditorStyles } from "./editor-css.ts"

/** 14 种块的展示名（键 = 我们侧 type；夹具标签，非产品字典文案）。 */
const BLOCK_LABELS: Readonly<Record<string, string>> = {
  paragraph: "段落",
  heading: "标题",
  bulletList: "无序列表",
  orderedList: "有序列表",
  todo: "待办",
  quote: "引用",
  divider: "分割线",
  code: "代码块",
  image: "图片",
  issueRef: "需求引用",
  docRef: "文档引用",
  mermaid: "Mermaid 图",
  toggle: "折叠块",
  view: "视图块",
}

/** 第一批 14 种块的 type 列表（直取 ui-blocks 词表常量，不另立真相源）。 */
export const DEMO_BLOCK_TYPES: readonly string[] = [...OUR_A_TYPES, ...OUR_B_FIRST_TYPES]

/**
 * 构造一个某类型的可插入块（内容用中文，保证插入后即是中文态）。
 * @param type - 我们侧块 type（14 种之一）。
 * @param seq - 递增序号，保证 id 唯一。
 * @returns 我们侧块记录。
 */
export function makeDemoBlock(type: string, seq: number): OurBlock {
  const id = `demo-${type}-${seq}`
  const text = `${BLOCK_LABELS[type] ?? type} · 可编辑示例 ${seq}`
  switch (type) {
    case "paragraph":
    case "quote":
      return { id, type, rich: [plainRich(text)] }
    case "heading":
      return { id, type, level: 2, rich: [plainRich(text)] }
    case "bulletList":
    case "orderedList":
      return { id, type, items: [plainRich(text), plainRich("第二项（中文）")] }
    case "todo":
      return { id, type, checked: false, rich: [plainRich(text)] }
    case "divider":
      return { id, type }
    case "code":
      return { id, type, code: `// ${text}\nconst 示例 = true`, language: "typescript" }
    case "image":
      return { id, type, url: "https://example.test/demo.png", caption: text }
    case "issueRef":
    case "docRef":
      return { id, type, ref: "ISS-538" }
    case "mermaid":
      return { id, type, code: "graph TD\n  A[开始] --> B[结束]", caption: text }
    case "toggle":
      return {
        id,
        type,
        title: "点我折叠 / 收开（真 toggle 容器）",
        children: [{ id: `${id}-child`, type: "paragraph", rich: [plainRich("折叠里的中文子块")] }],
      }
    case "view":
      return { id, type, ref: "views/demo", kind: "list" }
    default:
      // 14 种之外不应出现；fallback 成 paragraph 保夹具可用，不静默丢块。
      return { id, type: "paragraph", rich: [plainRich(text)] }
  }
}

/** 中文默认初始内容：覆盖富文本 / 标题 / 待办 / toggle，给真机 IME 一个可输入落点。 */
export function initialDemoBlocks(): OurBlock[] {
  return [
    { id: "demo-init-h", type: "heading", level: 1, rich: [plainRich("Matter 编辑器 · 中文输入夹具")] },
    {
      id: "demo-init-p",
      type: "paragraph",
      rich: [plainRich("请用拼音输入法在下方输入一句中文，组合期按 Enter 观察选字是否上屏、是否不换段。")],
    },
    { id: "demo-init-todo", type: "todo", checked: false, rich: [plainRich("组合期不回车 → 选字上屏")] },
    {
      id: "demo-init-toggle",
      type: "toggle",
      title: "折叠面板（点我收开）",
      children: [{ id: "demo-init-toggle-child", type: "paragraph", rich: [plainRich("折叠体内的中文子块")] }],
    },
  ]
}

/**
 * 把 BlockNote 文档读回我们侧块形态（经 ui-blocks full 映射层的读回函数）。
 * @param editor - 真编辑器实例。
 * @returns 我们侧 14 种块数组。
 */
export function readDocument(editor: BnEditor): OurBlock[] {
  return bnBlocksToOurFull(editor.document as never)
}

/** demo 对外句柄：文档快照读数 + 卸载清理。 */
export interface EditorDemoHandle {
  /** 当前 BlockNote 文档（我们侧块形态）。 */
  document(): OurBlock[]
  /** 按 type 真插入一块，返回插入后的文档快照。 */
  insert(type: string): OurBlock[]
  /** 卸载：React 根 unmount + 样式标签摘除。 */
  dispose(): Promise<void>
}

export interface EditorDemoOptions {
  /** 文档变化回调（每次插入后触发，供断言/父组件读数）。 */
  readonly onDocumentChange?: (blocks: OurBlock[]) => void
}

/**
 * 真插入一块到编辑器：我们侧块先经 `ourBlockToBnFull` 映射到 BN schema 块（type 名差
 * toggle→toggleListItem / bulletList→bulletListItem 等只在映射层消化），再 insertBlocks。
 * ⚠️ 不能直接把 OurBlock 当 PartialBlock 传——挂载态 view 会按 BN schema 解析 type，
 * 我们侧 type 不在词表里 ⇒ `isInGroup` 崩（实测）。映射层正是为此存在。
 */
export function insertBlockInto(editor: BnEditor, type: string, seq: number): void {
  const bnBlocks = ourBlockToBnFull(makeDemoBlock(type, seq))
  const doc = editor.document
  const last = doc[doc.length - 1]
  if (last !== undefined) editor.insertBlocks(bnBlocks as never, last.id, "after")
}

/** 生成插入函数（mount 与组件两形态共用，唯一块插入实现）。 */
function makeInserter(editor: BnEditor, emit: () => void): (type: string) => OurBlock[] {
  let seq = 0
  return (type: string): OurBlock[] => {
    insertBlockInto(editor, type, seq++)
    emit()
    return readDocument(editor)
  }
}

/**
 * 纯渲染：构造 demo 的 ReactElement（editor + 14 块工具条），不挂载、不注入样式。
 * 单独成函数让 jsdom 组件测试可直接 render 断言 DOM。
 */
export function renderEditorDemo(editor: BnEditor, onInsert: (type: string) => void): ReactElement {
  return createElement(
    "div",
    { "data-demo": "editor-demo" },
    createElement("h1", { "data-demo": "title" }, "Matter 编辑器夹具（真 BlockNote · 第一批 14 块）"),
    createElement(
      "div",
      { "data-demo": "toolbar", role: "toolbar", "aria-label": "插入块" },
      ...DEMO_BLOCK_TYPES.map((type) =>
        createElement(
          "button",
          { key: type, type: "button", "data-insert": type, onClick: () => onInsert(type) },
          BLOCK_LABELS[type] ?? type,
        ),
      ),
    ),
    createElement("div", { "data-demo": "surface" }, createHeadlessView({ editor, editable: true })),
  )
}

/**
 * 挂载真编辑器夹具到一个 React 挂载点（main.ts 的路由入口）。
 * @param root - 挂载容器。
 * @param options - 可选文档变化回调。
 * @returns EditorDemoHandle（读数 / 插入 / 卸载）。
 */
export async function mountEditorDemo(root: HTMLElement, options: EditorDemoOptions = {}): Promise<EditorDemoHandle> {
  const editor = bootFullEditor(initialDemoBlocks())
  const disposeCss = installEditorStyles()
  const emit = () => options.onDocumentChange?.(readDocument(editor))
  const insert = makeInserter(editor, emit)

  const reactRoot = createRoot(root)
  reactRoot.render(renderEditorDemo(editor, (type) => { insert(type) }))
  emit()

  return {
    document: () => readDocument(editor),
    insert,
    async dispose(): Promise<void> {
      reactRoot.unmount()
      disposeCss()
    },
  }
}

/**
 * React 组件形态的 demo（供组件测试直接 render，不经 mountEditorDemo 的 React 根）。
 * 自己建 editor + 注入样式 + useEffect 清理。
 */
export const EditorDemoComponent: FC<EditorDemoOptions> = (options) => {
  const editorRef = useRef<BnEditor | null>(null)
  if (editorRef.current === null) editorRef.current = bootFullEditor(initialDemoBlocks())
  const editor = editorRef.current

  useEffect(() => {
    const disposeCss = installEditorStyles()
    options.onDocumentChange?.(readDocument(editor))
    return () => disposeCss()
    // options 是每次渲染的新对象，只在挂载时取一次回调即可（与 mount 形态一致）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const insert = makeInserter(editor, () => options.onDocumentChange?.(readDocument(editor)))
  return renderEditorDemo(editor, (type: string) => { insert(type) })
}