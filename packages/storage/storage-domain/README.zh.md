---
description: "Matter 的 domain 数据表单：ctx.storage.domain / ctx.storageDomain —— 有 zod 校验、发变更事件的 KV domain。"
kind: "package-reference"
---

# @matter/storage-domain

[English](README.md) | 中文

## Summary

`@matter/storage-domain` 是存储接缝的**第三角**：数据表单（消费方）。它挂载一个 facility，把一个后端的不透明 KV unit 变成**有 schema 校验、会发变更事件的 domain** —— zod 在持久化边界校验，每个 domain 一条写链，每次持久写之后发 `domain/changed`。它提供**两个指向同一对象的 Context 键**：`ctx.storageDomain`（服务键，供 `ctx.inject` 依赖）与 `ctx.storage.domain`（hub 表单键，供消费者从 hub 读）。当某个包要保存「重启后还在、且形状必须校验」的记录时用它。

## Table of Contents

- [使用本包](#使用本包)
- [理解实现](#理解实现)
- [已知限制与推迟的工作](#已知限制与推迟的工作)

-----

<a id="使用本包"></a>
## 使用本包

domain 声明一次；运行时与类型面都从它派生。

```ts
import { z } from "zod"
import { defineDomain, domainTable } from "@matter/storage-domain"

const spec = defineDomain({
  name: "demo",
  version: 1,
  global: { schema: z.object({ theme: z.string() }), initial: { theme: "plain" } },
  tables: { items: domainTable<string, { label: string; count: number }>(
    z.object({ label: z.string(), count: z.number().int() }),
  ) },
})
```

装配顺序：先定义（Definition），再提供方（Provider），最后本包。**装配文件里的行序不影响结果** —— `apply` 会为配置里出现的每个后端声明 `ctx.inject([storage.backend.<name>])`，所以 facility 只在那些键存在时才激活。

```ts
import { storageBackendServiceKey } from "@matter/storage"

// 行序：Storage（定义）→ storage-json（提供方）→ storage-domain（本包）
const domain = await ctx.storage.domain.open(spec)
await domain.table("items").put("a", { label: "first", count: 1 })
ctx.on("domain/changed", (change) => { /* 推给对端、失效缓存…… */ })
```

### 你得到什么

- **在持久化边界校验**：存着的记录不合 zod schema ⇒ 整个 `open` 拒绝，抛 `DomainError('invalid-record')` 且带 `detail: { table, key }` —— 不是静默跳过。
- **每个 domain 一条写链**：`update` 的 transform 在它排队的位置执行，50 个并发自增就落 50。unit 契约明文写了它不串行化写，串行化由本包负责。
- **持久化之后才发事件，绝不提前**：每个事件只带新值，按写入顺序到达。
- **介质状态不明就隔离**：后端报 `unknown-state` 时，读与后续写都抛该错，而不是继续把可能已与介质分叉的内存当权威。`close()` 仍然可用。

### 失败与恢复

| 码 | 何时 | 怎么办 |
|---|---|---|
| `already-open` | 同一 facility 上同名 domain 开两次 | 一个名字只 `open` 一次；`close()` 会释放 |
| `facet-unsupported` | 路由到的后端没有 `kv` facet；或 `config.backend` 为空 | 路由到提供 `kv` 的后端 |
| `invalid-record` | 存着的记录/global 不合 schema | 修数据；一次性派生数据可声明 `invalidRecords: 'backup-and-skip'` |
| `missing-key` | 对不存在的记录 `update` | 先 `put`，或用 `get` 判一下 |
| `closed` | `close()` 之后读/写 | 该句柄已死，重新 `open` |

后端失败（`backend-not-found` / `version-mismatch` / `malformed-medium` / `unknown-state`）原样透传 `StorageError`，本层不重新包装 —— 这样按 `code` 分支的消费者能分清是「哪一侧」坏了。

-----

<a id="理解实现"></a>
## 理解实现

### 设计要点

unit 契约（`@matter/storage` 的 `src/backend.ts`）明写：`KvUnit` **不串行化并发写** —— 顺序是调用方的事。本包就是那个调用方：每个 domain 拥有一条 promise 链，每次写是链上一个 job，job 先等持久化，再改内存，最后发事件。因此被后端拒绝的写不会动内存，读与介质不会分叉。

### 源码地图

| 文件 | 装什么 |
|---|---|
| `src/index.ts` | `name` / `inject` / `Config` / `apply` + `DomainFacility`（路由、打开、快照校验） |
| `src/spec.ts` | `DomainSpec` / `defineDomain`（四类加载期自检）/ `domainTable` / `descriptorOf` |
| `src/domain.ts` | `DomainImpl` —— 写链、排干屏障、隔离 |
| `src/table.ts` | `KvTableImpl` + 它与 `DomainImpl` 共享的 `TableHost` 接缝 |
| `src/events.ts` | `DomainChanged` 闭联合 + `domain/changed` 的声明合并 |
| `src/error.ts` | `DomainErrorCode`（5 条）+ 带 `detail` 的 `DomainError` |

`table.ts` 从 `domain.ts` 拆出来是为了 400 行的文件上限，不是因为两半有不同的所有者。

### 为什么 `deleteMany` 分两趟：一趟落内存、一趟发事件

批量删是链上一个 job。内存先被带到**整批的终态**，然后第一个监听器才跑 —— 于是每条 `domain/changed` 观察到的已删集合与介质一致。若在删除循环里直接发事件，第一个监听器会读到**前缀状态**（`b`、`c` 还在），而这种不一致不抛任何错，只表现为消费者缓存变旧。

-----

<a id="已知限制与推迟的工作"></a>
## 已知限制与推迟的工作

- **只有 `per-record` 布局是真实的。** `defineDomain` 在加载期拒绝 `layout: 'single'`，而不是接受一个提供方根本不读的声明 —— 接受它等于让声明形态与落盘形态悄悄分叉。本仓没有 `single` 的消费者（ISS-510）。
- **`compatibleVersions` 在这里是文档粒度。** `@matter/storage-json` 把版本不被接受的文档**读作不存在**（丢弃，不迁移），而不是整个 unit 拒绝打开。未列出的旧记录因此会在加载时静默缺席 —— 这是 per-record 的契约，不是缺陷，但别把它读成"迁移"。
- **配置校验是手写的，不是 schemastery。** 那个包在本仓装不上（P0 已判），所以 `Config` 是纯 TS interface 加加载期的 `normalizeConfig()`。对现有两个字段校验强度等价，但它不是通用 schema。
- **变更推送只到 `ctx.emit`。** `domain/changed` 的跨进程 RPC 帧属于后续阶段；今天监听器只在进程内运行。
- **没有跨重启修复。** 不合 schema 的记录会让 `open` 拒绝（或在 `backup-and-skip` 下被移到一边并记日志）。没有任何东西把它改写成当前形状。
- **写链是每 domain 一条，不是每表或每 key。** 同一 domain 里两个热点 key 会互相排队；若那成为瓶颈，拆分应另开单并先给测量，不在本包内做。
