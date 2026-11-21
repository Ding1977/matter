# @matter/client-ui-model

## Summary

`@matter/client-ui-model` 是 Matter 的模型选择器最小座席（ISS-543），P4 第五个也是最后一个 client 包。它在 ctx 注入的 stub 目录上渲染两级面板——带搜索键盘导航的 provider 分组模型列表（↑↓ 循环回绕、Enter 选中、Escape 返回）与模型详情级。产品文案走类型化字典。详情返回键复用 2305 原件座席 `Button` 与 ui-theme token，故本包无私有 CSS、不 import 兄弟 UI 包。coverage 100%。三页管理界面不做（P7+），不建后端（llm 域是 P5+）。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

从 `@matter/client-ui-model/client` 导入 client 面：`ModelSelect`、`ModelPanel`、`ModelDetail`、`onPanelKeyDown`、`stubDirectory`，以及 `ModelRow` / `ModelDirectory` 契约。挂载方经 prop 注入 stub 目录与文案集，`ModelSelect` 装配两级面板。host 半暴露空注册的 cordis 插件入口。

## Understand the implementation

本包是双面 tsconfig（host 半 = 空插件入口；client 半 = DOM lib + jsx，三层 `contract/`、`panel/`、`apply.ts`）。搜索/分组/高亮纯函数在 `contract/`；`panel/` 域渲染列表（provider 分组、`aria-activedescendant` 焦点纪律）与详情级；`apply.ts` 是唯一允许跨域的装配点。键盘处理器挂在根 section 上，故详情级也能收 Escape。灵魂测试经 `ModelSelect` 注入 stub 目录并断言真实 DOM：provider 分组、↑↓ 回绕、Enter 进详情、Escape 返回。模型名匹配是大小写不敏感的有序子序列（DSH `ModelSelect.tsx` 形态学）。

## Known Limitations and Deferred Work

- 不建后端：目录是挂载方注入的 stub；真实 llm 域数据是 P5+。
- 三页管理界面不做（P7+）；本单只是 UI 座席。
- 本单无可视 shell 与截图；真机视觉凭证推迟到 P4 shell。
