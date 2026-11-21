/**
 * client 面装配点（ISS-531 / P3-U2a）——`@matter/client-ui-blocks/client` 的公开出口。
 *
 * 按 `verify-client-domain-graph` 的三层结构：本文件是 layer 2 装配点，只做再导出，
 * 把 contract（layer 0）与 mapping（layer 1）的公开面汇总给消费者；自身不实现逻辑，
 * 不 import 其它域的实现细节。
 *
 * @module @matter/client-ui-blocks/client
 */

// ── contract（layer 0）──
export {
  SIMPLE_MARK_TO_BN_STYLE, VALUED_MARK_TO_BN_STYLE, BN_STYLE_TO_OUR_MARK, BN_LINK_INLINE_TYPE, markToSkeletonString,
  CUSTOM_MARK_TO_BN_STYLE, BN_CUSTOM_STYLE_TO_OUR_MARK, encodeRefMark, decodeRefMark, isSizeValue,
} from "./contract/marks.ts"
export type { OurMark, SimpleMarkName, ValuedMarkName, LinkMarkName, CustomBoolMarkName, CustomStringMarkName, SizeValue, RefKind } from "./contract/marks.ts"
export {
  OUR_A_TYPES, BN_A_TYPES, OUR_TO_BN_TYPE, BN_TO_OUR_TYPE, GRANULAR_LIST_TYPES, isOurAType, isBnAType,
  OUR_B_FIRST_TYPES, OUR_TO_BN_B_TYPE, BN_TO_OUR_B_TYPE, isOurBFirstType,
} from "./contract/blocks.ts"
export type { OurAType, BnAType, OurBFirstType } from "./contract/blocks.ts"
export { plainRich, markedRich, toBlockSkeleton } from "./contract/types.ts"
export type { OurRich, OurABlock, OurBBlock, OurBlock } from "./contract/types.ts"

// ── mapping（layer 1）──
export { ourRichToBnInline, bnInlineToOurRich } from "./mapping/inline.ts"
export { ourBlockToBn, bnBlocksToOur } from "./mapping/blocks.ts"
export { validateOurBlock, validateBlockSkeleton } from "./mapping/validation.ts"
export type { ValidationIssue, ValidationResult } from "./mapping/validation.ts"
export { blockNoteSchema, fullBlockNoteSchema } from "./mapping/schema.ts"
export type { BnBlock, BnPartialBlock, BnInline, BnStyledText, BnEditor } from "./mapping/schema.ts"
export { bootHeadlessEditor, roundTripBlocks } from "./mapping/editor.ts"
export { createHeadlessView } from "./mapping/view.tsx"
export type { HeadlessViewOptions } from "./mapping/view.tsx"

// ── ISS-532 / P3-U2b：14 块完整映射 + view 查询 + IME + slot ──
export {
  createIssueRefSpec, createDocRefSpec, createMermaidSpec, createViewSpec, createCustomStyleSpecs,
  renderIssueRef, renderDocRef, renderMermaid, renderView, renderHighlight, renderSize, renderMath, renderRef,
} from "./mapping/custom-specs.tsx"
export { ourBlockToBnFull, bnBlocksToOurFull, bootFullEditor, roundTripFullBlocks, isOurA } from "./mapping/full-blocks.ts"
export { runViewQuery } from "./mapping/view-query.ts"
export type { ViewRenderRequest } from "./mapping/view-query.ts"
export {
  INITIAL_COMPOSITION_STATE, COMPOSITION_END_WINDOW_MS, systemClock,
  isCompositionKey, onCompositionStart, onCompositionEnd, onKeyup, isComposingEvent, shouldSubmitOnEnter, compositionMeta,
} from "./mapping/ime.ts"
export type { KeyLikeEvent, CompositionGuardState, CompositionClock } from "./mapping/ime.ts"
export { EDITOR_SURFACE_SLOT, registerEditorSurface, editorSurfaceChildrenDecl } from "./slots.ts"
export type { SlotRegistration, EditorSurfaceSlot, UiBlockContext } from "./slots.ts"
