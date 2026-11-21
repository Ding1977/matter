/**
 * 类型化 token 注册表 —— `@matter/client-ui-theme` 的数据半（ISS-530 / P3-U1）。
 *
 * ## 它是什么、不是什么
 *
 * 是：CSS 自定义属性（`src/client/theme.css`）的**元数据侧**。每一条 token 在这里带
 * name / description / valueType / cssVariable 四个字段，与 CSS 里的变量定义一一对应
 * —— 对应关系由 `tests/tokens.test.ts` 钉死（删一侧任何一条即红）。
 *
 * 不是：值得消费的运行时值。组件与样式**直接消费 CSS 变量**（`var(--matter-alias-…)`），
 * 不经本注册表绕行；注册表供文档、校验工具与后续的主题设置面读。
 *
 * ## 为什么注册表住在 host 半（与 DSH 的分歧，README「Understand」有对照）
 *
 * DSH 的 token 注册表在 client 半（`client/index.ts:129+`），因为它喂 client 侧的
 * 主题设置 UI。本仓 P3 没有设置面，注册表是纯数据、无 DOM 依赖 ⇒ 放 host 半
 * （`src/index.ts` 导出），client 半只留真正碰 document 的注入函数。
 *
 * ## 两层的取值纪律（单正文：「数值先最小集跟视觉走，不抄 DSH 的量」）
 *
 * · static 层 = 原子值（色板、圆角），只许被 alias 层 `var()` 引用，组件不许直接消费；
 * · alias 层 = 语义名（表面、文字、边框、强调、危险、控件/面板圆角），组件只消费这层；
 * · 数值是 P3 第一版目测值，**视觉定稿后随视觉走**，不是从 DSH design-platform.css 抄来的量。
 *
 * @module @matter/client-ui-theme/tokens
 */

/** token 原始值的解释方式：颜色（任何 CSS color 语法）或长度（px 等绝对长度）。 */
export type TokenValueType = "color" | "length"

/** 一条设计 token 的注册表条目。 */
export interface ThemeToken {
  /** 注册表内的稳定名，形如 `static.color.white` / `alias.surface`；层由 cssVariable 前缀可判。 */
  name: string
  /** 一句话用途：这条 token 管什么、什么时候用它。 */
  description: string
  /** 值的解释方式（颜色 / 长度）。 */
  valueType: TokenValueType
  /** 承载这条 token 的 CSS 自定义属性名，如 `--matter-alias-surface`；与 theme.css 一一对应。 */
  cssVariable: string
}

/**
 * 全量 token 注册表（static + alias 两层）。
 *
 * 与 `src/client/theme.css` 的变量定义集合**双向一一对应**：CSS 里多一个变量、
 * 少一个变量，或注册表多一条、少一条，`tests/tokens.test.ts` 都判红。
 */
export const THEME_TOKENS: readonly ThemeToken[] = [
  // ── static 层：原子值 ────────────────────────────────────────────────
  {
    name: "static.color.white",
    description: "纯白：页面表面与强调色上的文字底。",
    valueType: "color",
    cssVariable: "--matter-static-color-white",
  },
  {
    name: "static.color.black",
    description: "近黑（非纯黑）：最强档正文文字，比 #000 柔和不刺眼。",
    valueType: "color",
    cssVariable: "--matter-static-color-black",
  },
  {
    name: "static.color.gray-40",
    description: "浅灰：分隔线与卡片描边的原子色。",
    valueType: "color",
    cssVariable: "--matter-static-color-gray-40",
  },
  {
    name: "static.color.gray-60",
    description: "中灰：次要文字与图标的原子色。",
    valueType: "color",
    cssVariable: "--matter-static-color-gray-60",
  },
  {
    name: "static.color.gray-90",
    description: "极浅灰：抬升表面（卡片、浮层）的原子底色。",
    valueType: "color",
    cssVariable: "--matter-static-color-gray-90",
  },
  {
    name: "static.color.blue-10",
    description: "强调蓝的极浅档：选中与悬停的淡彩底。",
    valueType: "color",
    cssVariable: "--matter-static-color-blue-10",
  },
  {
    name: "static.color.blue-60",
    description: "强调蓝主档：主操作、链接与焦点态的原子色。",
    valueType: "color",
    cssVariable: "--matter-static-color-blue-60",
  },
  {
    name: "static.color.red-60",
    description: "危险红主档：破坏性操作与错误态的原子色。",
    valueType: "color",
    cssVariable: "--matter-static-color-red-60",
  },
  {
    name: "static.radius.sm",
    description: "小圆角：按钮、输入框等控件的原子圆角。",
    valueType: "length",
    cssVariable: "--matter-static-radius-sm",
  },
  {
    name: "static.radius.md",
    description: "中圆角：卡片、编辑器外框等面板的原子圆角。",
    valueType: "length",
    cssVariable: "--matter-static-radius-md",
  },
  // ── alias 层：语义名（组件只消费这层）────────────────────────────────
  {
    name: "alias.surface",
    description: "页面/画布底色：最大面积的背景。",
    valueType: "color",
    cssVariable: "--matter-alias-surface",
  },
  {
    name: "alias.surface-raised",
    description: "抬升表面：卡片、浮层、工具条相对 surface 抬一层的底色。",
    valueType: "color",
    cssVariable: "--matter-alias-surface-raised",
  },
  {
    name: "alias.surface-selected",
    description: "选中底：列表选中项、文本选区与悬停的淡彩底。",
    valueType: "color",
    cssVariable: "--matter-alias-surface-selected",
  },
  {
    name: "alias.text-primary",
    description: "主文字：正文与标题的颜色。",
    valueType: "color",
    cssVariable: "--matter-alias-text-primary",
  },
  {
    name: "alias.text-muted",
    description: "次要文字：占位符、说明文字、禁用态标签。",
    valueType: "color",
    cssVariable: "--matter-alias-text-muted",
  },
  {
    name: "alias.border-subtle",
    description: "弱边框：分隔线、卡片描边、输入框描边。",
    valueType: "color",
    cssVariable: "--matter-alias-border-subtle",
  },
  {
    name: "alias.accent",
    description: "强调色：主操作按钮、链接、焦点环。",
    valueType: "color",
    cssVariable: "--matter-alias-accent",
  },
  {
    name: "alias.accent-contrast",
    description: "强调色上的文字：accent 填充之上保持可读的前景色。",
    valueType: "color",
    cssVariable: "--matter-alias-accent-contrast",
  },
  {
    name: "alias.danger",
    description: "危险色：破坏性操作、校验错误、删除确认。",
    valueType: "color",
    cssVariable: "--matter-alias-danger",
  },
  {
    name: "alias.radius-control",
    description: "控件圆角：按钮与输入框的圆角。",
    valueType: "length",
    cssVariable: "--matter-alias-radius-control",
  },
  {
    name: "alias.radius-panel",
    description: "面板圆角：卡片与编辑器外框的圆角。",
    valueType: "length",
    cssVariable: "--matter-alias-radius-panel",
  },
]
