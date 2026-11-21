---
description: "Matter 的存储接缝定义：ctx.storage 服务，持有一张具名后端注册表。不做任何 IO。"
kind: "package-reference"
---

# @matter/storage

[English](README.md) | 中文

## 摘要

`@matter/storage` 是存储接缝的 **Definition** 角。它贡献 `ctx.storage` 服务：一张具名后端注册表（`ctx.storage.backend`），加一张可挂载的数据面表（`ctx.storage.mount` / `ctx.storage.form`）。它**不做任何 IO**，也**没有 `Config`** —— 介质在 Provider（如 `@matter/storage-json`），语义在 domain 层。没有挂任何 Provider 时，这个服务依然是完整可用的：注册表就是空的。任何要持久化应用数据的组合都该挂它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

先挂 Definition，Provider 自己注册进来。

```ts
import { Context } from "@deepseek-ai/cordis"
import Storage from "@matter/storage"

const ctx = new Context()
await ctx.plugin(Storage)

ctx.storage.backend.names() // 没有 Provider 时是 []
```

Provider 用具名方式注册后端，并拿到 disposer：

```ts
const dispose = ctx.storage.backend.register("json", backend)
```

哪个后端服务哪个消费者，由**消费者**配置决定，从来不是 hub 的全局选择 —— 多个后端可以并排挂着。

### 本包提供什么

- 一个带类型的 `ctx.storage`，没有可配错的配置面。
- 注册即副作用：`register()` / `mount()` 返回 disposer，随 owning fiber 自动卸载。
- 配置错误会带稳定 `StorageError` 码直接报错，而不是静默无操作。

### 失败与恢复

| 码 | 何时 | 怎么办 |
|---|---|---|
| `backend-not-found` | 解析一个没人注册的名字 | 挂上 Provider 包，或改正配置的名字 |
| `duplicate-backend` | 同一个名字注册两次 | 组合 bug —— 两个 Provider 抢一个名字 |
| `form-not-mounted` | 在拥有者挂载前读某个 form | 排好顺序：form 拥有者在前，消费者在后 |
| `duplicate-mount` | 同一个 form key 挂两次 | 一个 form 只能有一个拥有者 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 —— 点击展开</summary>

hub 是一张纯注册表，有两面。

### 设计要点

- **Definition 拥有契约，不拥有介质。** 零 IO 与零 `Config` 是刻意的：所有介质参数归 Provider，这样 hub 不可能意外长出一个介质依赖。
- **注册即副作用。** `register()` 与 `mount()` 都返回 disposer，且只撤掉**自己那次**的贡献。
- **form 是可合并的表。** `StorageForms` 是一个空接口，form 拥有者通过声明合并扩展它；hub 从不枚举 domain 的 key。

### stale-disposer 守卫

两张表都在删除前做同一处身份比对：

```ts
if (this.backends.get(name) === backend) this.backends.delete(name)
```

这不是防御性编程。Provider 的 fiber 重挂时，**旧的** disposer 可能晚于新的注册执行。没有这行身份比对，旧 disposer 会删掉新后端，而现场表现是「注册报成功但取不到」—— 不报错、不崩、只是数据没了。`tests/storage.test.ts` 覆盖的正是这个顺序。

### 后端契约

[`src/backend.ts`](src/backend.ts) 是 Provider 实现者的规范契约；共享套件在 [`tests/contract.ts`](tests/contract.ts)。Provider 拥有一个介质，暴露可选的数据形状分面；今天 `kv` 是唯一的分面。Provider 在自己的 spec 里调 `runKvBackendContract(label, create)` —— 接缝的第三条腿是这样验证的，不是靠一句接口声明。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Storage` 服务、`StorageForms`、`storageBackendServiceKey` |
| [`src/registry.ts`](src/registry.ts) | `BackendRegistry`：名字 → 后端，注册 disposer |
| [`src/backend.ts`](src/backend.ts) | 契约：`UNIT_NAME_RE`、分面、unit |
| [`src/error.ts`](src/error.ts) | `StorageError` 与稳定错误码 |
| [`src/brand.ts`](src/brand.ts) | branded id（仅编译期，不校验格式） |
| [`src/types.ts`](src/types.ts) | 纯类型面，零运行时 |
| [`tests/contract.ts`](tests/contract.ts) | 共享一致性套件，由 Provider 调用 |

</details>

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

这些是当前包约束，不是任务清单。

- **本包不做任何 IO，也没有 `Config`。** 这里没有可配的东西：每个介质参数（根目录、文件权限、布局）都归 Provider。若你在找数据物理上落在哪，那是另一个包。
- **`UNIT_NAME_RE` 是 `^[a-z][a-z0-9_]*$`，所以实体 id 不能当 unit 名。** Matter 的实体 id 如 `ISS-506` 满足 per-record 的 key 规则 `[a-zA-Z0-9_-]+`，因此可以当 **record key**；但它不满足 `UNIT_NAME_RE`（大写字母与连字符），会被拒绝作为 **unit 或 table 名**。unit 名必须是 snake_case：`pm_issue`，不是 `pm-issue`。
- **`kv` 是唯一的数据形状。** 会话事件日志用的 `log` 分面没有实现，也还没有消费者。
- **branded id 不校验格式。** `issueId()` 是恒等转换；畸形字符串会被接受，直到 zod 边界才失败。格式校验归拥有该 id 的业务包，不归接缝。
- **`mount` / `form` 在 P0 没有消费者。** domain 层（`ctx.storage.domain`）随 `@matter/storage-domain` 到来；在那之前这两个方法只被本包自己的测试覆盖。
