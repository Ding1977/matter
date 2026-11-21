---
description: "Matter 前端的 BlockNote 块编辑器底座：headless 编辑器 boot、我们侧 @matter/blocks 记录与 BlockNote 块之间显式的 props/marks 映射层、A 档 9 与 Marks 8 往返转换。只有数据与映射；P3 无默认 UI chrome、无视觉面。"
kind: "package-reference"
---

# @matter/client-ui-blocks

[English](README.md) | 中文

## Summary

`@matter/client-ui-blocks` 是 Matter 的 BlockNote 块编辑器底座（P3-U2a）。三件东西：headless 编辑器 boot（`bootHeadlessEditor`，不 mount、无 UI chrome）与基于 `BlockNoteViewRaw` 的展示工厂；一个显式映射层，把我们侧 `@matter/blocks` 记录与 BlockNote 块互转——名字（`bulletList`→`bulletListItem`）、粒度（一块列表 ↔ N 个列表项）、props 与 Rich 内联内容——八种 mark（七种 style 加作为 inline content 的 `link`，双向）；以及我们侧块的运行时 zod 校验。A 档 9 与 Marks 8 在 jsdom 测试中往返。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Boot 一个 headless 编辑器并往返块

把我们侧 A 档块转成 BlockNote 文档、读回、再得到我们的记录——无需 DOM mount。

```ts
import { bootHeadlessEditor, roundTripBlocks, type OurABlock } from "@matter/client-ui-blocks/client"

const blocks: OurABlock[] = [
  { id: "p1", type: "paragraph", rich: [{ text: "Hello", marks: [{ type: "bold" }] }] },
  { id: "l1", type: "bulletList", items: [{ text: "one", marks: [] }, { text: "two", marks: [] }] },
]

const editor = bootHeadlessEditor(blocks) // 未挂载；editor.document 可读
const back = roundTripBlocks(blocks)      // 再得到我们侧记录（逐字段相等）
```

### 用块 schema 校验记录

```ts
import { validateOurBlock } from "@matter/client-ui-blocks/client"

const result = validateOurBlock({ id: "h", type: "heading", level: 9, rich: [] })
// result.ok === false；result.issues[0].path === "level"（点名字段）
```

### 构造展示视图（headless，无默认 UI）

```ts
import { bootHeadlessEditor, createHeadlessView } from "@matter/client-ui-blocks/client"

const editor = bootHeadlessEditor([/* ... */])
const element = createHeadlessView({ editor }) // BlockNoteViewRaw 元素；无 toolbar/menu
```

<a id="understand-the-implementation"></a>
## Understand the implementation

### client 三层结构

`src/client/` 遵循 `verify-client-domain-graph` 分层：`contract/`（layer 0——名字/粒度映射表、mark 映射表、我们侧结构化记录类型）→ `mapping/`（layer 1——inline/props/blocks 转换、校验、schema、headless boot、view）→ `index.ts`（layer 2 装配）。host 半（`src/index.ts`）是空的 cordis 注册；所有依赖 BlockNote 的代码都在 client 面。

### 名字与粒度是显式表

`OUR_TO_BN_TYPE` / `BN_TO_OUR_TYPE` 编码了四处名字/粒度差异（`bulletList`→`bulletListItem`、`orderedList`→`numberedListItem`、`todo`→`checkListItem`、`code`→`codeBlock`）；其余同名。映射层把一块列表展开成 N 个 BlockNote 列表项再折叠回去，并裁掉不属于我们记录的 BlockNote 默认 props（`backgroundColor`、`textColor`、`textAlignment` 等）。

### 为什么 link 是 inline content 而非 style

BlockNote 有七种内置 style（`bold`、`italic`、`underline`、`strike`、`code`、`textColor`、`backgroundColor`），并把 `link` 建模成带 `href` 的 inline-content 节点。我们的八种 mark 映射到这些之上；`link` 转为 BlockNote 的 link inline-content 节点再转回，而不是塞进 style 字典（往返测试已实证）。

### headless 形态与依赖纪律

数据面直接 `BlockNoteEditor.create({ schema, initialContent })`，不 mount。展示面用 `BlockNoteViewRaw`，它没有默认 UI 包装——比关闭八个 DefaultUI 开关更硬的 headless。`@blocknote/core` 与 `@blocknote/react` 都钉 exact `0.57.0`（MPL-2.0）；不用任何 `xl-*` 包（GPL/商业）。`@matter/blocks` 作为运行时依赖用于 zod 校验（纯库，虽是包间 import 但属允许的库例外）。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- i18n 判据（`verify-client-ui-i18n`）是 W12 雏形：经 CJK 代理检测 `packages/client/*/src` 里的裸中文字面量，豁免 ui-theme 的 21 条 token description 元数据（ticket ISS-530）。它不解析 JSX 文本、模板插值或 props 传递；英文硬编码文案不在雏形射程内。
- 只映射 A 档 9 块与 Marks 8。B/C 档块、四种自写 mark（`highlight`/`size`/`math`/`ref`）、自写 layout 块（columns / B5 toggle）、slot 机制与 IME 处理属 U-2b 及后续。
- 无视觉面：vitest 默认 `css: false` 把 BlockNote 样式表 stub 成空串；断言只做结构判断。真机渲染与 macOS 拼音 IME「组合期按 Enter 选字不换段」须在 U-2b 真机验证。
- BlockNoteViewRaw 展示工厂本单暴露但不挂载（P3 无 shell）。`createElement` 边界用了一处显式 `any`，因为组件的泛型约束与本包固定的具名 schema 类型结构不同构（源码有说明）。
- 公开类型别名用 BlockNote 具名 `Default*Schema` 而非 `typeof blockNoteSchema.*`，因为 TypeScript 6.0.3 在 emit 深层递归推断类型时栈溢出；运行时 schema 仍只含九个 A 档块 spec。
