/**
 * Marks 8 的契约层（ISS-531 / P3-U2a）：我们侧的富文本 mark 形状，与 BlockNote
 * 的 style / inline-content 名之间的**唯一映射表**。本文件只放类型与常量，
 * 不 import BlockNote（contract 层保持纯净，映射实现在 `mapping/` 域）。
 *
 * 8 个 mark 的落点（U-0 问3 实证）：
 *   - 7 个是 BlockNote 的 style（bold/italic/underline/strike/code/textColor/backgroundColor）；
 *   - `link` 不是 style，而是 BlockNote 的 **inline content**（`type:"link"` + `href`）。
 *
 * 我们侧的 mark 是结构化对象（P2 骨架 `Rich.marks: string[]` 在 P3 细化——细化发生在
 * 本 client 包，@matter/blocks 的写范围不在本单）。值型 mark（color/bg）带 `value`，
 * link 带 `href`，其余为裸开关。
 *
 * @module @matter/client-ui-blocks/client/contract/marks
 */

/** 无值的布尔 mark（对应 BlockNote 的 boolean style）。 */
export type SimpleMarkName = "bold" | "italic" | "underline" | "strikethrough" | "code"

/** 带字符串值的 mark（对应 BlockNote 的 string style）。 */
export type ValuedMarkName = "color" | "bg"

/** link 是我们侧唯一走 BlockNote inline content（而非 style）的 mark。 */
export type LinkMarkName = "link"

// ── 四自写 mark（ISS-532 / P3-U2b）──
// createReactStyleSpec 的 propSchema 仅支持 boolean|string（U-0 补齐记录#1 实证）：
//   highlight = boolean；size / math / ref = string。ref 与 size 在映射层做值编解码。

/** 布尔型自写 mark（BN boolean style）。 */
export type CustomBoolMarkName = "highlight"

/** 字符串型自写 mark（BN string style）。 */
export type CustomStringMarkName = "size" | "math" | "ref"

/** size mark 的合法档位（枚举值编码为 string）。 */
export type SizeValue = "sm" | "base" | "lg"

/** ref mark 的引用类别（编码进单 string 的前缀，如 "issue:ISS-1"）。 */
export type RefKind = "issue" | "doc" | "view"

/**
 * 我们侧一个富文本 mark 的判别联合。
 * - 简单 mark 只有 `type`；
 * - color/bg 额外带 `value`（CSS 颜色名或变量值）；
 * - link 额外带 `href`。
 */
export type OurMark =
  | { readonly type: SimpleMarkName }
  | { readonly type: ValuedMarkName; readonly value: string }
  | { readonly type: LinkMarkName; readonly href: string }
  | { readonly type: CustomBoolMarkName }
  | { readonly type: "size"; readonly value: SizeValue }
  | { readonly type: "math"; readonly tex: string }
  | { readonly type: "ref"; readonly kind: RefKind; readonly target: string }

/** 我们侧简单 mark 名 → BlockNote style 名的映射（strikethrough→strike 在此归一）。 */
export const SIMPLE_MARK_TO_BN_STYLE: Readonly<Record<SimpleMarkName, string>> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strikethrough: "strike",
  code: "code",
}

/** 我们侧值型 mark 名 → BlockNote style 名的映射（color→textColor / bg→backgroundColor）。 */
export const VALUED_MARK_TO_BN_STYLE: Readonly<Record<ValuedMarkName, string>> = {
  color: "textColor",
  bg: "backgroundColor",
}

/** BlockNote style 名 → 我们侧 mark 名的反向映射（7 个 style，不含 link）。 */
export const BN_STYLE_TO_OUR_MARK: Readonly<Record<string, SimpleMarkName | ValuedMarkName>> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strike: "strikethrough",
  code: "code",
  textColor: "color",
  backgroundColor: "bg",
}

/** BlockNote 侧 link inline content 的 `type` 字面量。 */
export const BN_LINK_INLINE_TYPE = "link"

// ── 四自写 mark 的 BN style 名映射（ISS-532 / P3-U2b）──
// createReactStyleSpec 的 style type 用我们侧同名（identity），集中成表让映射层与守卫
// 共用一份真相源；反向表在 BN style 字典读回时判是不是我们认识的自写 style。

/** 我们侧自写 mark 名 → BN style 名（当前全为 identity，集中成表供映射层与测试引用）。 */
export const CUSTOM_MARK_TO_BN_STYLE: Readonly<Record<CustomBoolMarkName | CustomStringMarkName, string>> = {
  highlight: "highlight",
  size: "size",
  math: "math",
  ref: "ref",
}

/** BN style 名 → 我们侧自写 mark 名（identity；与 7 个默认 style 反向表并存）。 */
export const BN_CUSTOM_STYLE_TO_OUR_MARK: Readonly<Record<string, CustomBoolMarkName | CustomStringMarkName>> = {
  highlight: "highlight",
  size: "size",
  math: "math",
  ref: "ref",
}

/**
 * ref mark 的双字段 → BN string style 的单串编码（如 `{kind:"issue",target:"ISS-1"}` → `"issue:ISS-1"`）。
 * 分隔符用第一个冒号；target 自身可含冒号（如 URL），不做二次拆分。
 * @param mark - ref mark。
 * @returns `"<kind>:<target>"` 单串。
 */
export function encodeRefMark(mark: Extract<OurMark, { type: "ref" }>): string {
  return `${mark.kind}:${mark.target}`
}

/**
 * BN string style 单串 → ref mark 的双字段（映射层解编码）。
 * 无冒号视为 kind="issue"、整串作 target（防御：外部写入的裸串不炸；配置错误在加载时报）。
 * @param value - BN style 字符串值。
 * @returns ref mark。
 */
export function decodeRefMark(value: string): Extract<OurMark, { type: "ref" }> {
  const i = value.indexOf(":")
  if (i < 0) return { type: "ref", kind: "issue", target: value }
  const kind = value.slice(0, i)
  const target = value.slice(i + 1)
  if (kind === "issue" || kind === "doc" || kind === "view") return { type: "ref", kind, target }
  return { type: "ref", kind: "issue", target: `${kind}:${target}` }
}

/**
 * 校验字符串是否为合法 size 档位（写映射到 BN 前的守门；非法值回落到 "base"）。
 * @param value - 待判字符串。
 * @returns 是合法档位时收窄到 SizeValue。
 */
export function isSizeValue(value: string): value is SizeValue {
  return value === "sm" || value === "base" || value === "lg"
}

/**
 * 把一个我们侧 mark 序列化成 @matter/blocks P2 骨架 `Rich.marks: string[]` 可接受的
 * 字符串（zod 只要求 string，故任何编码都通过；这里用 `type:value` 形状便于往返）。
 * 仅用于把细化后的 mark 交给 @matter/blocks 做块级 props 校验，不参与 BN 映射。
 * @param mark - 我们侧 mark。
 * @returns 骨架兼容的 mark 字符串。
 */
export function markToSkeletonString(mark: OurMark): string {
  if (mark.type === "link") return `link:${mark.href}`
  if (mark.type === "color" || mark.type === "bg" || mark.type === "size") return `${mark.type}:${mark.value}`
  if (mark.type === "math") return `math:${mark.tex}`
  if (mark.type === "ref") return encodeRefMark(mark)
  return mark.type
}
