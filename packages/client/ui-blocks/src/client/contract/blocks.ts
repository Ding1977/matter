/**
 * A 档 9 块的名/粒度映射表（ISS-531 / P3-U2a）——契约层，只放常量与类型。
 *
 * DOC-512 §5.2 的 A 档 9 种与我们侧 @matter/blocks 的 A_BASIC_TYPES 一一对应，
 * 其中 4 种存在**名差或粒度差**，映射必须由显式表表达、不靠同名巧合：
 *
 * | 我们侧 type | BlockNote type | 差异 |
 * |---|---|---|
 * | paragraph   | paragraph        | 同名 |
 * | heading     | heading          | 同名（level prop 直传）|
 * | bulletList  | bulletListItem   | **名差 + 粒度差**：我们一块带 N 个 items，BN 每 item 一块 |
 * | orderedList | numberedListItem | **名差 + 粒度差**：同上，start prop 在首项 |
 * | todo        | checkListItem    | **名差**：checked prop 直传 |
 * | quote       | quote            | 同名 |
 * | divider     | divider          | 同名 |
 * | code        | codeBlock        | **名差**：code 字段→plain content，language prop 直传 |
 * | image       | image            | 同名：url/caption→props |
 *
 * @module @matter/client-ui-blocks/client/contract/blocks
 */

/** 我们侧 A 档 9 种 type（与 @matter/blocks 的 A_BASIC_TYPES 同集合，此处独立列出以免契约层 import 库包）。 */
export const OUR_A_TYPES = [
  "paragraph", "heading", "bulletList", "orderedList", "todo", "quote", "divider", "code", "image",
] as const

/** 我们侧 A 档 type 的联合。 */
export type OurAType = (typeof OUR_A_TYPES)[number]

/** BlockNote 侧对应 A 档 9 种 type。 */
export const BN_A_TYPES = [
  "paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote", "divider", "codeBlock", "image",
] as const

/** BlockNote 侧 A 档 type 的联合。 */
export type BnAType = (typeof BN_A_TYPES)[number]

/**
 * 我们侧 type → BlockNote type 的显式映射（含名差与粒度差的落点）。
 * `as const satisfies` 保留每个键的字面量类型，供映射分支消费且仍收窄 discriminated union。
 */
export const OUR_TO_BN_TYPE = {
  paragraph: "paragraph",
  heading: "heading",
  bulletList: "bulletListItem",
  orderedList: "numberedListItem",
  todo: "checkListItem",
  quote: "quote",
  divider: "divider",
  code: "codeBlock",
  image: "image",
} as const satisfies Record<OurAType, BnAType>

/**
 * BlockNote type → 我们侧 type 的反向映射。
 * 由 {@link OUR_TO_BN_TYPE} 逐条反转派生，不另立第二份真相源。
 */
export const BN_TO_OUR_TYPE = {
  paragraph: "paragraph",
  heading: "heading",
  bulletListItem: "bulletList",
  numberedListItem: "orderedList",
  checkListItem: "todo",
  quote: "quote",
  divider: "divider",
  codeBlock: "code",
  image: "image",
} as const satisfies Record<BnAType, OurAType>

/** 粒度差块：我们侧一块携带 N 个 item，BlockNote 侧展开为 N 个连续块（读回时再折叠）。 */
export const GRANULAR_LIST_TYPES: ReadonlySet<OurAType> = new Set(["bulletList", "orderedList"])

/**
 * 我们侧 type 是否属于 A 档 9 种（类型守卫）。
 * @param t - 待判 type 字符串。
 * @returns 是 A 档时收窄到 OurAType。
 */
export function isOurAType(t: string): t is OurAType {
  return (OUR_A_TYPES as readonly string[]).includes(t)
}

/**
 * BlockNote type 是否属于 A 档 9 种（类型守卫）。
 * @param t - 待判 type 字符串。
 * @returns 是 A 档时收窄到 BnAType。
 */
export function isBnAType(t: string): t is BnAType {
  return (BN_A_TYPES as readonly string[]).includes(t)
}

// ─────────────────────────────────────────────────────────────────────────────
// B 档第一批 5 种（ISS-532 / P3-U2b）：issueRef / docRef / mermaid / toggle / view
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 第一批 B 档 5 种我们侧 type（与 @matter/blocks 的 B_BUSINESS_TYPES 子集对齐）。
 * callout / table 留 P6，不在第一批（任务书第一批清单钉死）。
 */
export const OUR_B_FIRST_TYPES = [
  "issueRef", "docRef", "mermaid", "toggle", "view",
] as const

/** 第一批 B 档我们侧 type 的联合。 */
export type OurBFirstType = (typeof OUR_B_FIRST_TYPES)[number]

/** 第一批 B 档对应的 BN type：仅 toggle 名差（toggle→toggleListItem），其余同名。 */
export const OUR_TO_BN_B_TYPE = {
  issueRef: "issueRef",
  docRef: "docRef",
  mermaid: "mermaid",
  toggle: "toggleListItem",
  view: "view",
} as const satisfies Record<OurBFirstType, string>

/** BN type → 我们侧 B 档 type 的反向映射（由 {@link OUR_TO_BN_B_TYPE} 反转派生）。 */
export const BN_TO_OUR_B_TYPE = {
  issueRef: "issueRef",
  docRef: "docRef",
  mermaid: "mermaid",
  toggleListItem: "toggle",
  view: "view",
} as const satisfies Record<string, OurBFirstType>

/**
 * 我们侧 type 是否属于第一批 B 档 5 种（类型守卫）。
 * @param t - 待判 type 字符串。
 * @returns 是 B 档第一批时收窄到 OurBFirstType。
 */
export function isOurBFirstType(t: string): t is OurBFirstType {
  return (OUR_B_FIRST_TYPES as readonly string[]).includes(t)
}
