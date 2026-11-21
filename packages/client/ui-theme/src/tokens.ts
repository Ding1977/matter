/**
 * 类型化 token 注册表 —— `@matter/client-ui-theme` 的数据半（ISS-530 / P3-U1；ISS-544 扩）。
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
 * · static 层 = 原子值（色板、圆角、字号、行高、阴影），只许被 alias 层 `var()` 引用；
 * · alias 层 = 语义名（表面、文字、边框、强调、圆角、排版、层级），组件只消费这层；
 * · 数值是 P3 第一版目测值 + ISS-544 typography/圆角扩展，**视觉定稿后随视觉走**。
 *
 * @module @matter/client-ui-theme/tokens
 */

/** token 原始值的解释方式：颜色、长度（px 等绝对长度）或阴影（box-shadow 值）。 */
export type TokenValueType = "color" | "length" | "shadow"

/** 一条设计 token 的注册表条目。 */
export interface ThemeToken {
  /** 注册表内的稳定名，形如 `static.color.white` / `alias.surface`；层由 cssVariable 前缀可判。 */
  name: string
  /** 一句话用途：这条 token 管什么、什么时候用它。 */
  description: string
  /** 值的解释方式（颜色 / 长度 / 阴影）。 */
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
  { name: "static.color.white", description: "纯白：页面表面与强调色上的文字底。", valueType: "color", cssVariable: "--matter-static-color-white" },
  { name: "static.color.black", description: "近黑（非纯黑）：最强档正文文字，比 #000 柔和不刺眼。", valueType: "color", cssVariable: "--matter-static-color-black" },
  { name: "static.color.gray-40", description: "浅灰：分隔线与卡片描边的原子色。", valueType: "color", cssVariable: "--matter-static-color-gray-40" },
  { name: "static.color.gray-60", description: "中灰：次要文字与图标的原子色。", valueType: "color", cssVariable: "--matter-static-color-gray-60" },
  { name: "static.color.gray-90", description: "极浅灰：抬升表面（卡片、浮层）的原子底色。", valueType: "color", cssVariable: "--matter-static-color-gray-90" },
  { name: "static.color.blue-10", description: "强调蓝的极浅档：选中与悬停的淡彩底。", valueType: "color", cssVariable: "--matter-static-color-blue-10" },
  { name: "static.color.blue-60", description: "强调蓝主档：主操作、链接与焦点态的原子色。", valueType: "color", cssVariable: "--matter-static-color-blue-60" },
  { name: "static.color.red-60", description: "危险红主档：破坏性操作与错误态的原子色。", valueType: "color", cssVariable: "--matter-static-color-red-60" },
  { name: "static.color.green-60", description: "Success green: atomic color for positive state and success feedback (ISS-544).", valueType: "color", cssVariable: "--matter-static-color-green-60" },
  { name: "static.radius.sm", description: "小圆角：按钮、输入框等控件的原子圆角。", valueType: "length", cssVariable: "--matter-static-radius-sm" },
  { name: "static.radius.md", description: "中圆角：卡片、编辑器外框等面板的原子圆角。", valueType: "length", cssVariable: "--matter-static-radius-md" },
  { name: "static.radius.12", description: "12px radius: third tier of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-static-radius-12" },
  { name: "static.radius.16", description: "16px radius: fourth tier of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-static-radius-16" },
  { name: "static.radius.20", description: "20px radius: fifth tier of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-static-radius-20" },
  { name: "static.radius.28", description: "28px radius: top panel tier of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-static-radius-28" },
  { name: "static.font-size.body", description: "Body font size: paragraphs, list rows and main content (ISS-544).", valueType: "length", cssVariable: "--matter-static-font-size-body" },
  { name: "static.line-height.body", description: "Body line height: paired with the body font size (ISS-544).", valueType: "length", cssVariable: "--matter-static-line-height-body" },
  { name: "static.font-size.secondary", description: "Secondary font size: helper text and secondary info (ISS-544).", valueType: "length", cssVariable: "--matter-static-font-size-secondary" },
  { name: "static.line-height.secondary", description: "Secondary line height: paired with the secondary font size (ISS-544).", valueType: "length", cssVariable: "--matter-static-line-height-secondary" },
  { name: "static.font-size.caption", description: "Caption font size: labels, breadcrumbs and keycaps (ISS-544).", valueType: "length", cssVariable: "--matter-static-font-size-caption" },
  { name: "static.line-height.caption", description: "Caption line height: paired with the caption font size (ISS-544).", valueType: "length", cssVariable: "--matter-static-line-height-caption" },
  { name: "static.font-size.code", description: "Code font size: monospace code snippets (ISS-544).", valueType: "length", cssVariable: "--matter-static-font-size-code" },
  { name: "static.line-height.code", description: "Code line height: paired with the code font size (ISS-544).", valueType: "length", cssVariable: "--matter-static-line-height-code" },
  { name: "static.font-size.title", description: "Title font size: section and detail headings (ISS-544).", valueType: "length", cssVariable: "--matter-static-font-size-title" },
  { name: "static.line-height.title", description: "Title line height: paired with the title font size (ISS-544).", valueType: "length", cssVariable: "--matter-static-line-height-title" },
  { name: "static.overlay.top", description: "Overlay top: single top offset for all portal layers (ISS-544).", valueType: "length", cssVariable: "--matter-static-overlay-top" },
  { name: "static.focus-ring.width", description: "Focus ring width: stroke width of the keyboard focus ring (ISS-544).", valueType: "length", cssVariable: "--matter-static-focus-ring-width" },
  { name: "static.elevation.soft", description: "Soft elevation: shallowest shadow for input surfaces (ISS-544).", valueType: "shadow", cssVariable: "--matter-static-elevation-soft" },
  { name: "static.elevation.panel", description: "Panel elevation: mid shadow for cards and overlays (ISS-544).", valueType: "shadow", cssVariable: "--matter-static-elevation-panel" },
  { name: "static.elevation.prominent", description: "Prominent elevation: top shadow for high-level overlays (ISS-544).", valueType: "shadow", cssVariable: "--matter-static-elevation-prominent" },
  // ── alias 层：语义名（组件只消费这层）────────────────────────────────
  { name: "alias.surface", description: "页面/画布底色：最大面积的背景。", valueType: "color", cssVariable: "--matter-alias-surface" },
  { name: "alias.surface-raised", description: "抬升表面：卡片、浮层、工具条相对 surface 抬一层的底色。", valueType: "color", cssVariable: "--matter-alias-surface-raised" },
  { name: "alias.surface-selected", description: "选中底：列表选中项、文本选区与悬停的淡彩底。", valueType: "color", cssVariable: "--matter-alias-surface-selected" },
  { name: "alias.text-primary", description: "主文字：正文与标题的颜色。", valueType: "color", cssVariable: "--matter-alias-text-primary" },
  { name: "alias.text-muted", description: "次要文字：占位符、说明文字、禁用态标签。", valueType: "color", cssVariable: "--matter-alias-text-muted" },
  { name: "alias.border-subtle", description: "弱边框：分隔线、卡片描边、输入框描边。", valueType: "color", cssVariable: "--matter-alias-border-subtle" },
  { name: "alias.accent", description: "强调色：主操作按钮、链接、焦点环。", valueType: "color", cssVariable: "--matter-alias-accent" },
  { name: "alias.accent-contrast", description: "强调色上的文字：accent 填充之上保持可读的前景色。", valueType: "color", cssVariable: "--matter-alias-accent-contrast" },
  { name: "alias.danger", description: "危险色：破坏性操作、校验错误、删除确认。", valueType: "color", cssVariable: "--matter-alias-danger" },
  { name: "alias.success", description: "Success color: positive state and success feedback (ISS-544).", valueType: "color", cssVariable: "--matter-alias-success" },
  { name: "alias.interactive-bg-hover", description: "Interactive hover background: fill for hovered interactive elements (ISS-544).", valueType: "color", cssVariable: "--matter-alias-interactive-bg-hover" },
  { name: "alias.radius-control", description: "控件圆角：按钮与输入框的圆角。", valueType: "length", cssVariable: "--matter-alias-radius-control" },
  { name: "alias.radius-panel", description: "面板圆角：卡片与编辑器外框的圆角。", valueType: "length", cssVariable: "--matter-alias-radius-panel" },
  { name: "alias.radius-xs", description: "xs radius tier: finest of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-alias-radius-xs" },
  { name: "alias.radius-sm", description: "sm radius tier: second of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-alias-radius-sm" },
  { name: "alias.radius-md", description: "md radius tier: third of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-alias-radius-md" },
  { name: "alias.radius-lg", description: "lg radius tier: fourth of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-alias-radius-lg" },
  { name: "alias.radius-xl", description: "xl radius tier: fifth of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-alias-radius-xl" },
  { name: "alias.radius-2xl", description: "2xl radius tier: top panel tier of the six-step gradient (ISS-544).", valueType: "length", cssVariable: "--matter-alias-radius-2xl" },
  { name: "alias.font-size.body", description: "Body-tier font size: main content text (ISS-544).", valueType: "length", cssVariable: "--matter-alias-font-size-body" },
  { name: "alias.line-height.body", description: "Body-tier line height: paired with the body font size (ISS-544).", valueType: "length", cssVariable: "--matter-alias-line-height-body" },
  { name: "alias.font-size.secondary", description: "Secondary-tier font size: helper and secondary text (ISS-544).", valueType: "length", cssVariable: "--matter-alias-font-size-secondary" },
  { name: "alias.line-height.secondary", description: "Secondary-tier line height: paired with the secondary font size (ISS-544).", valueType: "length", cssVariable: "--matter-alias-line-height-secondary" },
  { name: "alias.font-size.caption", description: "Caption-tier font size: labels and breadcrumbs (ISS-544).", valueType: "length", cssVariable: "--matter-alias-font-size-caption" },
  { name: "alias.line-height.caption", description: "Caption-tier line height: paired with the caption font size (ISS-544).", valueType: "length", cssVariable: "--matter-alias-line-height-caption" },
  { name: "alias.font-size.code", description: "Code-tier font size: monospace snippets (ISS-544).", valueType: "length", cssVariable: "--matter-alias-font-size-code" },
  { name: "alias.line-height.code", description: "Code-tier line height: paired with the code font size (ISS-544).", valueType: "length", cssVariable: "--matter-alias-line-height-code" },
  { name: "alias.font-size.title", description: "Title-tier font size: section and detail headings (ISS-544).", valueType: "length", cssVariable: "--matter-alias-font-size-title" },
  { name: "alias.line-height.title", description: "Title-tier line height: paired with the title font size (ISS-544).", valueType: "length", cssVariable: "--matter-alias-line-height-title" },
  { name: "alias.overlay.top", description: "Overlay top: shared top for portal layers (ISS-544).", valueType: "length", cssVariable: "--matter-alias-overlay-top" },
  { name: "alias.focus-ring.width", description: "Focus ring width: keyboard focus stroke (ISS-544).", valueType: "length", cssVariable: "--matter-alias-focus-ring-width" },
  { name: "alias.focus-ring.color", description: "Focus ring color: keyboard focus stroke color (ISS-544).", valueType: "color", cssVariable: "--matter-alias-focus-ring-color" },
  { name: "alias.elevation.soft", description: "Soft elevation: shallow surfaces such as inputs (ISS-544).", valueType: "shadow", cssVariable: "--matter-alias-elevation-soft" },
  { name: "alias.elevation.panel", description: "Panel elevation: cards and regular overlays (ISS-544).", valueType: "shadow", cssVariable: "--matter-alias-elevation-panel" },
  { name: "alias.elevation.prominent", description: "Prominent elevation: high-level overlays (ISS-544).", valueType: "shadow", cssVariable: "--matter-alias-elevation-prominent" },
]
