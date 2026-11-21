/**
 * A 档 9 块的 BlockNote schema 装配（ISS-531 / P3-U2a）。
 *
 * `BlockNoteSchema.create()` 只挑 A 档 9 种内置块（defaultBlockSpecs 的子集）——我们侧
 * 28 种里的 B/C 档与四自写 mark 留给 U-2b，本单不碰。style 与 inline content 走 BN 默认：
 * style = 7 种（bold/italic/underline/strike/code/textColor/backgroundColor），inline = text + link。
 * 这正好覆盖 Marks 8（link 走 inline content，其余 7 走 style），零自写 spec。
 *
 * 全仓禁 xl-*（GPL/商业授权，DOC-512 §5.2）：这里只用 core/react 的内置 spec，无 XL。
 *
 * ## 两段类型处理（都有实测理由）
 *
 * 1. **公开类型别名用 core 具名 `Default*Schema`，不用 `typeof blockNoteSchema.*`**：后者是
 *    高度递归的推断类型，TS 6.0.3 在 *.d.ts emit 时栈溢出（实测 RangeError）。具名类型 emit
 *    只留一行 import，稳定；运行时 schema 仍只有 9 块，多出的默认 type 永不出现，读回侧统一
 *    经 `isBnAType` 守卫收窄（见 blocks.ts）。
 * 2. **schema 构造处一处 `as NamedSchema`**：9-spec 子集与具名默认 schema 的推断类型结构不同
 *    （union 成员数不等），直接赋值 TS2322；在构造边界断言一次，换来整个映射层对固定 union 的
 *    类型稳定。如实口径：本包 as 共 11 处，其中 10 处是守卫后窄化（as string / number /
 *    boolean / Record / BnInline / BnStyles 等），仅本处一处是具结构意义的边界断言。都不是
 *    `as unknown as`（不绕过 strict）；view.tsx 的 `props: any` 是另一处渲染边界，理由注释在位。
 *
 * @module @matter/client-ui-blocks/client/mapping/schema
 */

import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs, defaultStyleSpecs } from "@blocknote/core"
import type {
  Block,
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema,
  InlineContent,
  PartialBlock,
  StyledText,
} from "@blocknote/core"
import { createDocRefSpec, createIssueRefSpec, createMermaidSpec, createViewSpec, createCustomStyleSpecs } from "./custom-specs.tsx"

/** 具名默认 schema 类型（d.ts emit 稳定）。 */
type NamedSchema = BlockNoteSchema<DefaultBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>

/** 我们侧 A 档 9 种对应的 BN 内置块 spec（键 = BN type）。 */
const aBlockSpecs = {
  paragraph: defaultBlockSpecs.paragraph,
  heading: defaultBlockSpecs.heading,
  bulletListItem: defaultBlockSpecs.bulletListItem,
  numberedListItem: defaultBlockSpecs.numberedListItem,
  checkListItem: defaultBlockSpecs.checkListItem,
  quote: defaultBlockSpecs.quote,
  divider: defaultBlockSpecs.divider,
  codeBlock: defaultBlockSpecs.codeBlock,
  image: defaultBlockSpecs.image,
}

/**
 * A 档 9 块的 BlockNote schema 实例（模块级单例；无状态，可共享）。
 * 构造处唯一断言：9-spec 子集 → 具名 schema 类型（见文件头理由 2）。
 */
export const blockNoteSchema: NamedSchema = BlockNoteSchema.create({ blockSpecs: aBlockSpecs }) as NamedSchema

/**
 * 第一批 14 种的**完整** schema（ISS-532 / P3-U2b）：A 档 9 + BN 内置 toggleListItem +
 * 四自写块（issueRef/docRef/mermaid/view）；style = 默认 7 + 四自写（highlight/size/math/ref）；
 * inline = 默认（text + link）。U-2a 的 9 块 schema（{@link blockNoteSchema}）保留供既有
 * 映射/测试用；本 schema 只服务第一批全量 boot 与 W6 集成测试。
 *
 * 类型处理同 U-2a：自定义 spec 的推断类型递归，d.ts emit 会栈溢出——构造处断言到具名
 * `NamedSchema`（默认 schema 形状），运行时多出的块/样式永不出现在 A 档读回侧（读回统一经
 * type 字符串 switch，自定义分支在本单新增的 full 映射层处理）。
 */
const wideBlockSpecs = {
  paragraph: defaultBlockSpecs.paragraph,
  heading: defaultBlockSpecs.heading,
  bulletListItem: defaultBlockSpecs.bulletListItem,
  numberedListItem: defaultBlockSpecs.numberedListItem,
  checkListItem: defaultBlockSpecs.checkListItem,
  quote: defaultBlockSpecs.quote,
  divider: defaultBlockSpecs.divider,
  codeBlock: defaultBlockSpecs.codeBlock,
  image: defaultBlockSpecs.image,
  toggleListItem: defaultBlockSpecs.toggleListItem,
  issueRef: createIssueRefSpec(),
  docRef: createDocRefSpec(),
  mermaid: createMermaidSpec(),
  view: createViewSpec(),
}
// 结构化赋值（非断言）：宽 spec 表含 A 档 9 的全部键且类型一致，多出的 5 个键被结构类型
// 自然接受——于是 create() 推断的类型仍是 NamedSchema，d.ts emit 只留一行具名 import（不栈溢出）；
// 运行时 spec 表实际有 14 块，自定义分支在 full 映射层按 type 字符串处理。
const narrowBlockSpecs: typeof aBlockSpecs = wideBlockSpecs
const narrowStyleSpecs: typeof defaultStyleSpecs = { ...defaultStyleSpecs, ...createCustomStyleSpecs() }

/** 第一批 14 种完整 schema 实例（模块级单例）；构造处断言到具名 schema 保 d.ts emit 稳定（理由见上方注释）。 */
export const fullBlockNoteSchema: NamedSchema = BlockNoteSchema.create({
  blockSpecs: narrowBlockSpecs,
  styleSpecs: narrowStyleSpecs,
}) as NamedSchema

/** 本 schema 下的完整 BN 块类型（具名默认 schema，d.ts emit 稳定）。 */
export type BnBlock = Block<DefaultBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>

/** 本 schema 下的 BN 待插入块类型（props 可省略）。 */
export type BnPartialBlock = PartialBlock<DefaultBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>

/** 本 schema 下的 BN inline content（StyledText | Link 的判别联合）。 */
export type BnInline = InlineContent<DefaultInlineContentSchema, DefaultStyleSchema>

/** 本 schema 下的 BN styled text。 */
export type BnStyledText = StyledText<DefaultStyleSchema>

/** 本 schema 下的 BlockNote 编辑器实例类型（带完整具名泛型，避免回落到默认 schema）。 */
export type BnEditor = BlockNoteEditor<DefaultBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>
