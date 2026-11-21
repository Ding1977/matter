/**
 * slot 接入（ISS-532 / P3-U2b · 拍板甲）——ui-blocks 自己的 SlotMap 声明合并 + 注册 helper。
 *
 * DSH slot 语义（U-0 问2）：SlotMap 编译期 declaration merging（key 形如
 * `<domain>.<entry>.<hole>`）+ 运行时 `ctx.slots.register` 声明渲染位；ReactNode 跨包只走 slot。
 * 本包声明 `blocks.editor.surface`（domain=blocks / entry=editor / hole=surface）——编辑器正文
 * 的渲染位，真消费者页面由 U-3 挂入（W7），本单以 jsdom 测试证词收口。
 *
 * ## 依赖归置与 import 形态
 *
 * 两包（ui-slots / ui-renderer @exact 0.2.2-rc.2）归 devDependencies——shipped 代码零运行时
 * value-import，slot registry 由测试/host 注入。
 * renderer 的 `lib/client.js` 是 DSH closure-factory bundle（首行 `window.__ModuleLoader__.load`，
 * vitest/jsdom 下没有该全局⇒导入即炸），故测试从包的 `./src/*` 子路径导入原始 TS（DSH 同包
 * 测试也这么干；本仓 vitest `server.deps.inline` 已预置 `/@deepseek-ai\/dsh-client/`）。本模块只
 * 依赖 ui-slots 的类型（declaration merging）与 cordis Context 类型——不 import renderer 运行时。
 *
 * @module @matter/client-ui-blocks/client/slots
 */

import type { Context } from "@deepseek-ai/cordis"
// 锚定 declaration merging 的目标模块（type-only，无运行时依赖；TS 要求增强的模块在程序中可见）。
import type {} from "@deepseek-ai/dsh-client-ui-slots"

/** 编辑器正文渲染位的 slot key（照 DSH `<domain>.<entry>.<hole>` 命名）。 */
export const EDITOR_SURFACE_SLOT = "blocks.editor.surface" as const

/**
 * 声明合并：ui-blocks 拥有 `blocks.editor.surface`。
 * kind=single（一个编辑器正文渲染位）、scope=root（P3 无 session shell）；owner 传编辑器实例
 * 的轻量标识（ref）——真编辑器对象由 U-3 注入组件闭包，不经 slot owner 传 ReactNode。
 */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "blocks.editor.surface": {
      kind: "single"
      scope: "root"
      owner: { editorRef: string }
    }
  }
}

/** 注册结果：disposer（cordis effect 生命周期——fiber 卸载即移除）。 */
export type SlotRegistration = () => void

/**
 * 声明编辑器渲染位（root frame 的 children 声明 + 占用条目注册）。
 * 这是 P3 的"装配骨架"：root 的 owner 组件由调用方（测试 / U-3）提供，本函数挂一个
 * `blocks.editor.surface` 的占位占用（数据面 headless 编辑器由 U-3 渲染），返回 disposer。
 *
 * 用类型擦除的 `slots` 面（renderer 提供 `ctx.slots`，本包 host 入口不 import renderer 运行时），
 * 参数 `register` 的形状与 `SlotRegistry.register` 同构——测试与 U-3 把真 registry 传进来。
 *
 * @param slots - 提供 register 的 slots 服务（renderer 的 SlotRegistry）。
 * @param surfaceComponent - 渲染编辑器正文的 React 组件（U-3 传真组件；测试传桩）。
 * @returns disposer（释放注册）。
 */
export function registerEditorSurface(
  slots: {
    register(options: object, component: unknown): () => void
  },
  surfaceComponent: unknown,
): SlotRegistration {
  return slots.register(
    { name: EDITOR_SURFACE_SLOT },
    surfaceComponent,
  )
}

/**
 * 声明 root frame 的 children（让 `blocks.editor.surface` 成为可注册的 slot）。
 * 与 {@link registerEditorSurface} 分开：owner 组件注册 root 时带本 children 声明，
 * 再由插件注册占用条目——DSH 的"声明-占用"两段生命周期。
 * @returns root frame 的 children 声明对象。
 */
export function editorSurfaceChildrenDecl(): Record<string, { kind: "single"; scope: "root" }> {
  return { [EDITOR_SURFACE_SLOT]: { kind: "single", scope: "root" } }
}

/** 便于类型侧引用：本包 slot key 的字面量类型。 */
export type EditorSurfaceSlot = typeof EDITOR_SURFACE_SLOT

/** 声明本包使用 `@deepseek-ai/cordis` 的 Context（owner 侧装配用；仅类型，无运行时依赖）。 */
export type UiBlockContext = Context
