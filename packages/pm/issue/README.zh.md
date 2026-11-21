---
description: "Matter 的工单域：ctx.issues —— 有 zod 校验的工单记录，每次持久写都投影进活动流。"
kind: "package-reference"
---

# @matter/issue

[English](README.md) | 中文

## Summary

`@matter/issue` 是 P2 实体层的第一个业务域：`IssueProps` zod schema、它喂进去的 `defineDomain` 声明，以及把每次持久变更投影进活动流的写路径。它挂载 `ctx.issues`，并且是工单记录的**唯一**写入口 —— 读是同步的，直接从域的内存态来。它同时是 `@matter/storage-journal` 的第一个跨包消费方，所以这个包装上之后，活动流不再是一张空表。

## Table of Contents

- [使用本包](#使用本包)
- [理解实现](#理解实现)
- [已知限制与推迟的工作](#已知限制与推迟的工作)

-----

<a id="使用本包"></a>
## 使用本包

装配是四个插件，且**文件行序不影响结果** —— 每一个都靠 `ctx.inject` 等服务键。

```ts
// Storage（定义）→ storage-json（提供方）→ storage-domain（表单）→ issue（本包）
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: "/var/lib/matter/records" })
await ctx.plugin(StorageDomain, { backend: "json" })
await ctx.plugin(Journal, { root: "/var/lib/matter" })
await ctx.plugin(Issue)
```

然后经 `ctx.issues` 写：

```ts
const created = await ctx.issues.create({
  id: "ISS-1", title: "first", status: "todo", kind: "feature", created: "2026-11-17",
})
await ctx.issues.update(issueId("ISS-1"), { status: "in_review" }, { actor: "linmo" })

ctx.journal.list({ entity: "issues/ISS-1" }).rows
// → issue-created · issue-delivered（payload: { field: "status", from: "todo", to: "in_review" }）
```

### 你得到什么

- **记录在边界上被校验。** `IssueProps` 是 `z.strictObject`：未知键是错误，不是被静默丢掉的字段。`create` 与 `update` 都原样抛 `ZodError`，它的 `issues[].path` 直接点名坏在哪个字段。
- **审计来自差异。** `update` 把上一版与下一版做差，每个真变了的字段一条事件 —— 你没法忘记记录一次写，因为**写路径只有一条**。
- **字段来历写在 schema 上。** 每个字段带 `.meta({ writable, widget, indexable })`，而 `z.toJSONSchema(IssueProps)` 会保留它 —— 前端做字段编辑器不需要第二处真相。
- **重放幂等。** 重放同一条事件（同实体、同事件、同时刻）不会写第二行，所以迁移脚本可以反复跑。

### 失败与恢复

| 错误 | 何时 | 怎么办 |
|---|---|---|
| `ZodError` | 值不合 schema（非法状态、畸形 `ISS-*` id、未知键） | 修值；`error.issues[].path` 会说是哪个字段 |
| `IssueExistsError` | 对已存在的 id `create` | 用 `update`，或换一个 id |
| `IssueNotFoundError` | 对不存在的 id `update` | 先 `create`，或用 `get` 判一下 |

域层失败（`already-open` / `invalid-record` / `closed` / 后端各类错）从 `@matter/storage-domain` 原样透传 —— 本层不重新包装。

-----

<a id="理解实现"></a>
## 理解实现

### 设计要点

`@matter/storage-domain` 在**持久化之后**才发 `domain/changed`，而它的载荷**只带新值** —— 这是有意的：要算差异的消费者自己留上一版快照。所以若订阅它再算差，本包就成了记录状态的**第二个家**。差异改在写链内部算，那里上一版顺手可得：读上一版 → `put` → 发事件（域层）→ 追加审计。活动流的形状因此只由**一处**决定。

这个顺序是承重的。`domain/changed` 的监听器跑的时候，审计行**还不存在**（`tests/domain.test.ts` 断言那一刻 `count() === 0`）。反过来先写审计，会让一次被后端拒绝的写留下一条**从未发生**的事件 —— 那种行在盘上与真行长得一模一样。

### 源码地图

| 文件 | 装什么 |
|---|---|
| `src/spec.ts` | `IssueProps`（12 个核心字段 + `.meta()`）、`IssuePatch`、三张词表、`IssueDomain` |
| `src/events.ts` | 事件名、`diffEntries`、`bodyFingerprint`、`logValue`、`issueEntry`（幂等键的形状） |
| `src/index.ts` | `IssuesFacility`（`ctx.issues`）、`openIssues`、`apply`、两个域错误 |

### 为什么可选字段写成 `.optional().meta(...)`，绝不写成 `.meta(...).optional()`

zod 4.6.6：`z.string().meta({…}).optional()` 返回的是一个**新的 optional 包装层**，于是 `schema.meta()` 在它上面读回 `undefined` —— 而 `z.toJSONSchema()` 仍然会把内层那份元数据合并出来。这种劈裂是最坏的一种：JSON schema 看着对，而所有直接读 `.meta()` 的消费者什么都拿不到。把 `.meta()` 放最后，就只有一处。

### 为什么 id 的 brand 不用 `.transform()`

`z.string().transform(...)` 会让 `z.toJSONSchema()` 在默认 `io: "output"` 下抛异常。brand 在这里没有运行期语义 —— 它活在类型层（`Branded<"IssueId">`）—— 所以 schema 用 `.meta({ branded: ... })` 承载它，往返干净。

-----

<a id="已知限制与推迟的工作"></a>
## 已知限制与推迟的工作

- **41 个字段里只做 12 个。** `forge-pm/lib/domain.js` 的 `FIELD_META` 摊到 issues 域是 41 个字段（实测，不是引用）。今天只有 12 个有真实消费者，其余在 `src/spec.ts` 末尾列为 TODO。没有写者也没有读者的字段就是一个**恒空**的键，而空键在盘上与"还没写"分不出来。
- **`mdAt` 的装法（新树判断）**：`issueEntry` 把事件自身的时刻写进 `mdAt` 列。旧树那一列装的是 markdown 侧车里的 `at:`。不装它的话，同一次状态变迁的**两次真实发生**（`in_review` → `todo` → `in_review`）会塌成一行，因为 `stablePayload` 有意排除了 `at`。所以这个名字在本包名不副实；改名要动 P1 的 journal 契约，不在本包写范围内（已上报）。
- **非 1 的 `known` 会漏进 payload。** `@matter/storage-journal` 的 `stablePayload` 排除 `entity`/`event`/`actor`/`at`/`mdAt`/`uid`，但**不排除 `known`**，所以显式传它会让它进 `payload_json` 与 uid。本包在 `known` 为 1（缺省值）时省略它，只在其它值时才传。这是报给 journal seam 的缺陷，不在本包绕过。
- **没有跨重启修复。** 存着但不合 schema 的记录会让 `open` 拒绝。没有任何东西把它改写成当前形状。
- **`update` 是读-改-写，不是 compare-and-swap。** facility 把自己的写串行化，所以经同一个 facility 的并发写不会交错；两个进程共用一个介质时不受保护，因为下层不提供 CAS。
- **审计失败不回滚记录。** 活动流 append 抛错时，记录保持已写入并记一条 warn。反过来（为了保住审计而回滚一次成功的记录写）会让"成功了却抛错"变成常态。
- **还没有 `relations` / `blocked_by` 的投影。** journal 的边表投影 `relations` / `parent` / `blocked_by` 三个字段；本 schema 今天只有 `parent`，而边表重建是另一件事（`ctx.journal.rebuild()`）。
