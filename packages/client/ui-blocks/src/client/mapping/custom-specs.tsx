/**
 * 四自写块 + 四自写 mark 的 BlockNote spec（ISS-532 / P3-U2b）。
 *
 * 用 react 包的 `createReactBlockSpec` / `createReactStyleSpec`（0.57.0 签名已实读核实）
 * 构造 8 个自定义 spec，供 {@link ./schema.ts} 组装进完整 schema。P3 无视觉面：render
 * 组件只渲染一个带 `data-*` 标记的占位元素（结构可断言、无图表引擎、无真实取数）——
 * 真消费者页面是 U-3，图表引擎/取数随各自单落地（见正文缺口段）。
 *
 * ## 工厂形态（0.57.0，实测）
 *
 * - `createReactBlockSpec(config, impl)` 返回**工厂函数**，须再调 `()` 才得 spec（U-0 未记这一层，scratch 实测补）；
 * - `createReactStyleSpec(config, impl)` 直接返回 spec（propSchema 仅 boolean|string）。
 *
 * ## 类型处理
 *
 * 自定义 spec 的推断类型高度递归，TS 6.0.3 在 *.d.ts emit 时栈溢出（U-2a 对 A 档 schema
 * 同款实测）。本文件**只导出工厂函数**（返回浅层 `BlockSpec`/style spec 形态经边界断言），
 * 深层泛型留在函数体内；schema.ts 组装后断言到具名 schema 类型（同 U-2a 口径）。
 *
 * @module @matter/client-ui-blocks/client/mapping/custom-specs
 */

import { createReactBlockSpec, createReactStyleSpec } from "@blocknote/react"
import { createElement } from "react"
import type { ReactElement } from "react"

/**
 * createReactBlockSpec 返回值的窄形态（config + implementation + 可选 extensions）。
 * 具名以避免把深层递归推断类型写进 *.d.ts（TS 6.0.3 栈溢出，U-2a 实测）；具体泛型留在函数体内，
 * 返回边界窄化一次——schema.ts 组装后再断言到具名 schema（同 U-2a 口径）。
 */
interface BlockSpecLike {
  readonly config: { readonly type: string }
  readonly implementation: unknown
  readonly extensions?: readonly unknown[]
}

/** createReactStyleSpec 返回的 spec 窄形态（config + implementation + 可选 extensions）；具名以避免深层递归推断。 */
interface StyleSpecLike {
  readonly config: { readonly type: string; readonly propSchema: "boolean" | "string" }
  readonly implementation: unknown
  readonly extensions?: readonly unknown[]
}

/** 四自写 style spec 的名→spec 映射（返回类型具名，d.ts emit 稳定）。 */
interface CustomStyleSpecs {
  readonly highlight: StyleSpecLike
  readonly size: StyleSpecLike
  readonly math: StyleSpecLike
  readonly ref: StyleSpecLike
}

/** 占位渲染参数：块的 props 序列化成 data-* 供结构断言（不做视觉）。 */
interface PlaceholderProps {
  readonly type: string
  readonly fields: Readonly<Record<string, string>>
}

/** 块/样式占位 React 组件：只产一个带 data 标记的 span，由 jsdom 断言结构。 */
function Placeholder({ type, fields }: PlaceholderProps): ReactElement {
  const attrs: Record<string, string> = { "data-bn-placeholder": type }
  for (const [k, v] of Object.entries(fields)) attrs[`data-field-${k}`] = v
  return createElement("span", attrs)
}

/** 各 spec 的渲染回调提取成纯函数（createElement、无 hooks）——spec 用它、测试直接调用验结构。 */

/**
 * issueRef 占位渲染。
 * @param block - BN 块（读 props.ref）。
 * @returns 占位 ReactElement。
 */
export function renderIssueRef(block: { props: Record<string, unknown> }): ReactElement {
  return createElement(Placeholder, { type: "issueRef", fields: { ref: String(block.props.ref) } })
}

/**
 * docRef 占位渲染。
 * @param block - BN 块（读 props.ref）。
 * @returns 占位 ReactElement。
 */
export function renderDocRef(block: { props: Record<string, unknown> }): ReactElement {
  return createElement(Placeholder, { type: "docRef", fields: { ref: String(block.props.ref) } })
}

/**
 * mermaid 占位渲染（图表引擎不入本单）。
 * @param block - BN 块（读 props.code）。
 * @returns 占位 ReactElement。
 */
export function renderMermaid(block: { props: Record<string, unknown> }): ReactElement {
  return createElement(Placeholder, { type: "mermaid", fields: { code: String(block.props.code) } })
}

/**
 * view 占位渲染（查询渲染见 mapping/view-query.ts）。
 * @param block - BN 块（读 props.ref / props.kind）。
 * @returns 占位 ReactElement。
 */
export function renderView(block: { props: Record<string, unknown> }): ReactElement {
  return createElement(Placeholder, { type: "view", fields: { ref: String(block.props.ref), kind: String(block.props.kind) } })
}

/**
 * highlight 自写 mark 占位渲染。
 * @returns 占位 ReactElement。
 */
export function renderHighlight(): ReactElement {
  return createElement(Placeholder, { type: "highlight", fields: {} })
}

/**
 * size 自写 mark 占位渲染。
 * @param value - style 字符串值（sm|base|lg）。
 * @returns 占位 ReactElement。
 */
export function renderSize(value: string): ReactElement {
  return createElement(Placeholder, { type: "size", fields: { value } })
}

/**
 * math 自写 mark 占位渲染。
 * @param value - tex 字符串。
 * @returns 占位 ReactElement。
 */
export function renderMath(value: string): ReactElement {
  return createElement(Placeholder, { type: "math", fields: { tex: value } })
}

/**
 * ref 自写 mark 占位渲染。
 * @param value - 编码串 "kind:target"。
 * @returns 占位 ReactElement。
 */
export function renderRef(value: string): ReactElement {
  return createElement(Placeholder, { type: "ref", fields: { ref: value } })
}

/** ref 块（issueRef/docRef）共用的 propSchema：ref:string + preview:boolean。 */
const REF_PROP_SCHEMA = {
  ref: { default: "" },
  preview: { default: false },
} as const

/** mermaid 的 propSchema：code:string + caption:string。 */
const MERMAID_PROP_SCHEMA = {
  code: { default: "" },
  caption: { default: "" },
} as const

/** view 的 propSchema：ref:string + kind:string（"list"|"table"|"board"，映射层守词表）。 */
const VIEW_PROP_SCHEMA = {
  ref: { default: "" },
  kind: { default: "list" },
} as const

/**
 * 构造 issueRef 自写块 spec（渲染 ref 标识占位卡，真实取数在 U-3）。
 * @returns BlockNote 可用的 block spec（工厂调用后的值）。
 */
export function createIssueRefSpec(): BlockSpecLike {
  return createReactBlockSpec(
    { type: "issueRef", content: "none" as const, propSchema: REF_PROP_SCHEMA },
    { render: ({ block }) => renderIssueRef(block) },
  )()
}

/**
 * 构造 docRef 自写块 spec。
 * @returns block spec。
 */
export function createDocRefSpec(): BlockSpecLike {
  return createReactBlockSpec(
    { type: "docRef", content: "none" as const, propSchema: REF_PROP_SCHEMA },
    { render: ({ block }) => renderDocRef(block) },
  )()
}

/**
 * 构造 mermaid 自写块 spec（code: string，图表引擎不入本单）。
 * @returns block spec。
 */
export function createMermaidSpec(): BlockSpecLike {
  return createReactBlockSpec(
    { type: "mermaid", content: "none" as const, propSchema: MERMAID_PROP_SCHEMA },
    { render: ({ block }) => renderMermaid(block) },
  )()
}

/**
 * 构造 view 自写块 spec（ref+kind，B-1 view-query 进程内直连查询渲染）。
 * @returns block spec。
 */
export function createViewSpec(): BlockSpecLike {
  return createReactBlockSpec(
    { type: "view", content: "none" as const, propSchema: VIEW_PROP_SCHEMA },
    { render: ({ block }) => renderView(block) },
  )()
}

/**
 * 构造四自写 mark 的 style spec（highlight boolean；size/math/ref string）。
 * @returns 四个 style spec 的名→spec 映射。
 */
export function createCustomStyleSpecs(): CustomStyleSpecs {
  return {
    highlight: createReactStyleSpec(
      { type: "highlight", propSchema: "boolean" as const },
      { render: () => renderHighlight() },
    ),
    size: createReactStyleSpec(
      { type: "size", propSchema: "string" as const },
      { render: ({ value }) => renderSize(value) },
    ),
    math: createReactStyleSpec(
      { type: "math", propSchema: "string" as const },
      { render: ({ value }) => renderMath(value) },
    ),
    ref: createReactStyleSpec(
      { type: "ref", propSchema: "string" as const },
      { render: ({ value }) => renderRef(value) },
    ),
  }
}
