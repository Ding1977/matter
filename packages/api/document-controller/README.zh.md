# @matter/document-controller

## Summary

`@matter/document-controller` 是 Matter api 组的第一个包：document 域的 `@Remote` host Service。它 extends `TypertRemoteService`，声明 `list` / `get` / `update` 三个端点，真实读写走 `ctx.documents`——文档门面，唯一写路径与活动流落点。形态与 DSH session-controller 同构（`super(ctx, 'document')`、`@Remote('...')` 装饰器、exact `@deepseek-ai/dsh-typert-protocol@0.2.2-rc.2`），P4 接 gateway 零返工。不接 typert-generator：P3 无跨进程消费者，生成物无读者。P3 数据通道是进程内（vitest boot cordis context），不铺 connection / gateway / remotes。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

作为 cordis 插件安装。构造即把服务注册到 `ctx.document`；所有读写经 `ctx.documents`。三方法在 P3 进程内直接调用，P4 可经 gateway 调用。

## Understand the implementation

本包是 host 半单面包，单一 tsconfig——无 DOM、无 client 半。`@Remote` 是标准 TypeScript 装饰器：构建由 tsdown 降级，测试由 pre-transform 插件降级。get 未命中抛已声明的 `RemoteError('document/not-found')`。

## Known Limitations and Deferred Work

- 不接 typert-generator、不产 `./remote` artifact；归 P4 gateway 单。
- P3 无 connection / gateway / remotes——只进程内。
- `list` 读全部行（可选 id 前缀过滤）；有真实消费者前不做分页。
