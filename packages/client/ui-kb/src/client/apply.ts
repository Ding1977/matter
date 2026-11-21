/**
 * client 面装配点（layer 2，ISS-533）：汇总 contract/list/detail 的公开面。
 *
 * 只做再导出 + 文案解析入口，不实现业务逻辑，不 import 兄弟域的实现细节
 * （verify-client-domain-graph：装配点是唯一允许跨域的地方）。
 * 本文件不 import ui-blocks——渲染位经 `renderSurface` 注入，非包级引用。
 *
 * @module @matter/client-ui-kb/client/apply
 */

export { EDITOR_SURFACE_SLOT } from "./contract/doc.ts"
export type {
  DocRow,
  DocDetailRow,
  BodyBlock,
  EditorSurfaceOwner,
  SurfaceRenderer,
} from "./contract/doc.ts"

export { DocList } from "./list/list.tsx"
export type { DocListProps } from "./list/list.tsx"

export { DocDetail } from "./detail/detail.tsx"
export type { DocDetailProps } from "./detail/detail.tsx"

export { resolveMessages, identityTranslator } from "./locale.ts"
export type { Messages, Translator } from "./locale.ts"
