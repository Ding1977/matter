# @matter/client-ui-pm

## Summary

`@matter/client-ui-pm` 是 Matter 的 issue 列表骨架（ISS-540），第四个 client 包。它渲染由 `@matter/issue` 的 `ViewConfigStore` 读出的 `ViewConfig` 所驱动的注入 issue 行——真消费者，非并行 store。三层 `contract/`、`list/`、`detail/` 由 `apply.ts` 装配。文案走类型化 locale 字典（i18n 判据在档）。列表复用 2305 原件座席（`Button`）；其 `--dsw-alias-*` token 由宿主的 ui-theme 桥接层提供，故本包无私有 CSS、不 import 兄弟 UI 包。coverage 阈值 100%——第二个高于 client 80% 基线的包。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

从 `@matter/client-ui-pm/client` 导入 client 面：`IssueList`、`IssueDetail`、`resolveMessages`、`orderRows`，以及 `IssueRow` / `IssueListModel` 契约。挂载方从 `ViewConfigStore.list()/get()` 读出 `ViewConfig`，把 issue 记录投影成 `IssueRow[]`，两者作为 props 传给 `IssueList`。host 半暴露空注册的 cordis 插件入口。

## Understand the implementation

本包是双面 tsconfig（host 半 = 空插件入口；client 半 = DOM lib + jsx，三层结构）。列表应用配置的基本面——视图名作标题、`type` / `group` / `filter` 落成 data 属性、首条 `sort` 规则决定行序；未知字段回落空串。ViewConfig 类型来自 `@matter/issue`，不造并行 store。灵魂测试在假 KV unit 上开真 `ViewConfigStore`，读出一份 `ViewConfig`，断言渲染出的 DOM 带上该配置与 issue 行。

## Known Limitations and Deferred Work

- 本单只是骨架：只接了列表形态；完整两视图（list + table）与切换/持久化在下一单（#5）。
- 本单无可视 shell 与截图；真机视觉凭证推迟到 P4 shell。
- issue 行是最小展示投影，不是完整的 `IssueProps` schema。
