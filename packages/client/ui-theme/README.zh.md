---
description: "Matter 前端包的设计 token 底座：两层 CSS 变量（static 原子被 alias 语义引用）、与 CSS 保持一一对应的类型化 token 注册表、installThemeStyles 注入钩子（ctx.effect + disposer）。第一个 client 包；本单同时带来双面 tsconfig 与 jsdom 测试栈。"
kind: "package-reference"
---

# @matter/client-ui-theme

[English](README.md) | 中文

## Summary

`@matter/client-ui-theme` 是 Matter client 组的设计 token 底座，也是新树第一个 client 包（P3-U1）。三件东西：两层 CSS 变量——`--matter-static-*` 原子（色板、圆角）被 `--matter-alias-*` 语义（表面、文字、边框、强调、危险、圆角）引用——组件以 `var(--matter-alias-…)` 消费；类型化 token 注册表（`THEME_TOKENS`，每变量一条，带 name / description / valueType / cssVariable）；以及 `installThemeStyles(ctx)`——经 `ctx.effect()` 把样式表注入 `document.head` 并返回 disposer。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

组件只消费 alias 层。static 层是 token 文件的实现细节：视觉调整时只动 `theme.css` 内部的 `var()` 指向，消费方 CSS 不动。

### Consume tokens in component CSS

```css
.card {
  background: var(--matter-alias-surface-raised);
  color: var(--matter-alias-text-primary);
  border: 1px solid var(--matter-alias-border-subtle);
  border-radius: var(--matter-alias-radius-panel);
}
```

### Inject the stylesheet

token CSS 不从任何 HTML 入口 `<link>`；谁拥有 DOM 谁安装它。P3 里是测试，P4 里是 web shell 的挂载点。host 侧 `apply` 有意是空注册：加载本包零副作用，注入时机归调用方。

```ts
import type { Context } from "@deepseek-ai/cordis"
import { installThemeStyles } from "@matter/client-ui-theme/client"

const dispose = installThemeStyles(ctx) // <style> 已进入 document.head
// ……稍后手动，或 ctx 所属 fiber 卸载时自动：
await dispose()
```

### Read the token registry

注册表是 host 侧数据（无 DOM 依赖），从包根导出。它服务文档、校验工具与未来的主题设置面；运行时样式从不读它。

```ts
import { THEME_TOKENS } from "@matter/client-ui-theme"

for (const token of THEME_TOKENS) {
  console.log(token.name, token.valueType, token.cssVariable)
}
```

<a id="understand-the-implementation"></a>
## Understand the implementation

### Dual-plane tsconfig

本包经两个 project 编译，都在 `tsconfig.next.json` 登记——经包根 solution 文件（`tsconfig.json`，files 为空、两条 references）：

- `tsconfig.host.json` extends `tsconfig.base.emit.json`（node 类型），编 host 入口 `src/index.ts` 与 `src/tokens.ts`。
- `tsconfig.client.json` extends 新建的 `tsconfig.base.client.emit.json`（加 `jsx: "react-jsx"` 与 DOM / DOM.Iterable lib、去掉 node 类型；不开装饰器，照 DSH），只编 `src/client/**`，独立 tsbuildinfo。

两面产物同落 `lib/types/` 且互不重叠；tsdown 只把 host 入口打成 `lib/index.js`，client 半保持 tsc 原始 emit 给 Vite / vitest 消费。

### Why the registry lives in the host half

DSH 的 token 注册表在 client 半，因为它喂 client 侧的主题设置 UI。本包 P3 没有设置面，而注册表是纯数据，所以从 host 入口导出、任何工具可读。client 半保持只碰 DOM（`installThemeStyles`）——这也是 `*.css?inline` 的 ambient 声明（`src/client/assets.d.ts`）住在 client 面里的原因。

### Test stack and coverage domain

根 devDependencies 钉版 DSH 的 client 测试栈：`jsdom 29.1.1`、`@testing-library/react ^16.3.3`、`@testing-library/dom ^10.4.1`，另加 `react` / `react-dom` / `@types/react`（browser-only 第三方归 devDependencies；@types/react 只在根）。jsdom spec 逐文件用 `// @vitest-environment jsdom` pragma 声明环境——共享配置保持 node。覆盖率阈值在 `verify-coverage-threshold` 分域：`packages/client/` 判 perFile 80（DOC-520 §4.3），其余包维持 perFile 100。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- vitest 默认 `css: false` 会把所有 `.css` import——含 `?inline` 与 `?raw`——stub 成空串（`vitest:css-disable` 插件跑在 `enforce: pre`）。jsdom spec 因此钉注入契约（标签在场、`?inline` import 逐字透传、disposer），内容断言放在 `tests/tokens.test.ts`（fs 直读 `theme.css`）。给 `packages/client/` 范围开 CSS 处理（`vitest.config.ts` 里一条 `test.css` 项）另开单：该文件不在本单写范围。
- 仅浅色主题。无深色主题、注册表无 `requiresLightAndDark` 元数据（DSH 两者都有）；随主题切换面一起到，不在有消费者之前预建。
- 数值是第一版目测最小集，未经视觉评审；视觉定稿后随视觉走（单正文口径：先最小集，不抄 DSH 的量）。
- host `apply` 是空注册：无服务键、无 volatile `Config` 字段、无 `boot-theme`（DSH 有 shell 所以有这些）。随 P4+ 的设置面 / shell 一起到。
- 无 client 打包面：client 半以 tsc 原始 emit 供 Vite / vitest 消费。DSH 的 `clientBundle` preset 是其私有物，P3 无 web shell；打包随 P4 shell 单落地。
- `react` 与 testing-library 栈装在根、服务整个 client 组；本包自身没有 React 组件，暂时无人 import。
