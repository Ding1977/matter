# @matter/client-ui-kb

## Summary

`@matter/client-ui-kb` 是 Matter client 的知识库最小页：doc 列表 + 渲染文档正文的详情页。它是 ui-blocks 的第一个真实消费者（W7）——详情只经 `blocks.editor.surface` slot 拿渲染位，零 import ui-blocks。client 三层 `contract/`（行类型 + slot key）、`list/`、`detail/` 由 `apply.ts` 装配。样式用 ui-theme token；产品文案走类型化 locale 字典（i18n 判据在档，新文案不豁免）。P3 数据通道进程内（vitest boot cordis），无 connection / gateway。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

从 `@matter/client-ui-kb/client` 导入 client 面：`DocList`、`DocDetail`、`resolveMessages` 与 `EDITOR_SURFACE_SLOT` key。挂载方提供 `loadDoc`（绑 controller.get → ctx.documents）与 `renderSurface`（绑 slot 的 `renderSlot` prop 面）。

## Understand the implementation

本包是双面 tsconfig（host 半 = 空插件入口；client 半 = DOM lib + jsx，三层结构）。跨包 UI 只走 slot key——ui-kb 既不 import 也不再导出任何 ui-blocks 值。W7 测试 boot 装了 document-controller + ctx.documents + 已注册 ui-blocks 渲染位的 cordis context，再断言正文文本真实出现在渲染出的 DOM。

## Known Limitations and Deferred Work

- P3 无 connection / gateway / remotes——数据进程内注入。
- 测试里的正文投影是最小展示形态，不是完整的 28 类型块联合。
- P3 无可视 shell 与截图；真机渲染推迟到 P4 shell。
