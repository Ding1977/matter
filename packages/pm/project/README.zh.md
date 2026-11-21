---
description: "Matter 的项目域：ctx.projects —— 有 zod 校验的项目记录，每次持久写都投影进活动流。"
kind: "package-reference"
---

# @matter/project

[English](README.md) | 中文

## Summary

`@matter/project` 是 P2 实体层的第二个业务域：`ProjectProps` zod schema、它喂进去的 `defineDomain` 声明，以及把每次持久变更投影进活动流的写路径。它挂载 `ctx.projects`，并且是项目记录的**唯一**写入口 —— 读是同步的，直接从域的内存态来。它覆盖 11 个字段（10 个核心字段加 `created`）；`milestones` 与 `phases` 故意不在其中，因为旧树是在**读**时归一它们，不是写时。

## Table of Contents

- [使用本包](#使用本包)
- [理解实现](#理解实现)
- [已知限制与推迟的工作](#已知限制与推迟的工作)

-----

<a id="使用本包"></a>
## 使用本包

装配是五个插件，且**文件行序不影响结果** —— 每一个都靠 `ctx.inject` 等服务键。

```ts
// Storage（定义）→ storage-json（提供方）→ storage-domain（表单）→ journal → project（本包）
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: "/var/lib/matter/records" })
await ctx.plugin(StorageDomain, { backend: "json" })
await ctx.plugin(Journal, { root: "/var/lib/matter" })
await ctx.plugin(Project)
```

然后经 `ctx.projects` 写：

```ts
const created = await ctx.projects.create({
  id: "PRJ-1", title: "first", status: "active", created: "2026-11-17",
})
await ctx.projects.update("PRJ-1", { status: "paused" }, { actor: "linmo" })

ctx.journal.list({ entity: "projects/PRJ-1" }).rows
// → created · status-change（载荷：{ field: "status", from: "active", to: "paused" }）
```

### 你得到什么

- **记录在边界上被校验。** `ProjectProps` 是 `z.strictObject`：未知键是错误，不是被静默丢掉的字段。`create` 与 `update` 都以原始 `ZodError` 拒绝，它的 `issues[].path` 点出坏掉的字段。
- **审计由差异得出。** `update` 拿上一版快照与本版比较，每个真变了的字段发一条事件 —— 你没法忘记记一笔，因为写路径只有一条。
- **字段出处写在 schema 上。** 每个字段都带 `.meta({ writable, widget, indexable })`，且 `z.toJSONSchema(ProjectProps)` 保留它 —— 前端能凭它建出字段编辑器，不需要第二处真相。
- **重放幂等。** 重放同一条事件（同实体、同事件、同刻）不写第二行，所以迁移脚本可以重跑。

### 失败与恢复

| 错误 | 何时 | 怎么修 |
|---|---|---|
| `ZodError` | 值坏了 schema（非法状态、形状不对的 `PRJ-*` id、未知键） | 改值；`error.issues[].path` 说哪个字段 |
| `ProjectExistsError` | 对已存在的 id 调 `create` | 改用 `update`，或换一个 id |
| `ProjectNotFoundError` | 对不存在的 id 调 `update` | 先 `create`，或用 `get` 核 |

域层失败（`already-open` / `invalid-record` / `closed` / 后端错误）由 `@matter/storage-domain` 原样透出 —— 本层不重包。

-----

<a id="理解实现"></a>
## 理解实现

### 设计概念

`@matter/storage-domain` 在**持久化之后**才发 `domain/changed`，且载荷只带**新值** —— 这是有意的：要算差异的消费者自己留上一版快照。于是订阅并做差会让本包成为记录状态的第二个所有者。改为把差异算在写链内部，那里上一版顺手可见：读上一版 → `put` → 发事件（域层）→ 追加审计。活动流的形状只在**一处**决定。

顺序是承重的。先写审计会让一次被后端拒绝的写入留下一条**从未发生**的事件 —— 而它在盘上与真事件一模一样（`tests/domain.test.ts` 断言 `domain/changed` 到达时活动流还是空的）。

### 源码地图

| 文件 | 装什么 |
|---|---|
| `src/spec.ts` | `ProjectProps`（11 字段 + `.meta()`）、`ProjectPatch`、三张词表、`ProjectDomain` |
| `src/events.ts` | 事件名、`diffEntries`、`logValue`、`projectEntry`（幂等键形状） |
| `src/index.ts` | `ProjectsFacility`（`ctx.projects`）、`openProjects`、`apply`、两个域错误 |

### 为什么 `milestones` / `phases` 不在 schema 里

工具面称它们是只读派生视图。旧树表明这是「同一件事的两种写法」，而不是两种存储形态：`forge-pm/lib/md-store.js:51,105` 在**读**时归一它们（`normMilestones` / `normPhases`），而写侧**根本没有**归一器。落盘的是调用方原样给的形状 —— 而真数据里两种形状都真实存在（`$DSH_HOME/pm/projects`，26 个实体）：`milestones` 恒为对象数组，`phases` 则是**字符串数组**。

把归一后的 `{id,name,targetDate}` 收进 schema 会锁死两件今天都没有消费者的事。其一，存量里字符串形态的 `phases` 过不了校验，而 `@matter/storage-domain` 对过不了校验的存量记录的回答是 `invalid-record` —— 整个域拒绝打开。其二，阶段 id 由容器派生（`<容器 id>:ph-N`），而容器 id 就是这条记录自己的 `id`；一个只知道字段、不知道容器的 schema，等于把派生搬进存储。旧形态的归一是 P9 迁移的事，那时才有完整 frontmatter 与容器身份。

### 展示字段的 `widget` 取值

`widget` 描述的是**数据形态**，不是画它的 React 组件（与 `person` / `tags` / `markdown` 同一约定）。本包新增三个取值；`E-3` 与前端照它渲染：

| 字段 | `widget` | 定死含义的消费方 |
|---|---|---|
| `color` | `color` | `forge-pm/src/pm/shared/icon-picker.tsx:42` `PROJECT_ICON_COLORS`（12 色板） |
| `icon` | `icon` | 同文件 `:44` `iconById()`（lucide 图标集，按 id 名取） |
| `subtitle` | `text` | `forge-pm/src/pm/shared/blocks/subtitle-input.tsx`（单行，就地编辑） |
| `cover` | `image` | `forge-pm/src/pm/shared/blocks/cover-image.tsx`（文件上传 → `assets/<id>/`） |

### 为什么可选字段是 `.optional().meta(...)`，绝不 `.meta(...).optional()`

zod 4.6.6：`z.string().meta({…}).optional()` 返回的是**新的 optional 包装层**，于是 `schema.meta()` 在它上面读回 `undefined` —— 而 `z.toJSONSchema()` 仍会把内层元数据合并出来。这种裂开是最坏的一种：JSON schema 看着对，而每个直接读 `.meta()` 的消费者什么都拿不到。把 `.meta()` 放最后，就只有一个位置。

-----

<a id="已知限制与推迟的工作"></a>
## 已知限制与推迟的工作

- **21 个字段里只做了 11 个。** `forge-pm/lib/domain.js` 的 `FIELD_META` 摊出 21 个 projects 专属字段（外加 `priority` 这类通用字段）。只有 10 个核心字段加 `created` 被建出来，其余列在 `src/spec.ts` 的 TODO 块里。实测 `$DSH_HOME/pm/projects` 的 26 个实体：`color` 6/26 · `icon` 7/26 · `subtitle` 0/26 · `cover` 0/26 —— 展示字段在等它们真正的消费者。
- **没有 `ProjectId` 品牌类型。** `@matter/storage/src/brand.ts` 只导出 `IssueId`，所以本包的记录键是裸 `string`。补这个 brand 要改 `packages/storage/*`，而那被本单的写范围排除 —— 报出去而不是绕过去。今天把 `"DOC-1"` 传给 `get()` 能过类型检查、运行期返回 `undefined`。
- **没有状态信号层。** issues 发七个具名事件（`issue-started` / `issue-delivered` …）；projects 发通用的 `status-change`，与旧树一致（`forge-pm/lib/entity-ops.js:671`）。照抄 issue 的信号映射会造出旧树从没产出过的名字，那些事件的 `known` 会落到 0。
- **没有 `body` / `body-change`。** 核心字段清单里没有正文，所以 schema 与事件词表都不带它。一个没有产出方的事件名，读起来像有人在写它。
- **`known` 非 1 时会漏进 payload。** `@matter/storage-journal` 的 `stablePayload` 排除 `entity`/`event`/`actor`/`at`/`mdAt`/`uid`，但**不排除 `known`**，所以显式传它会把塞进 `payload_json` 与 uid。本包在它是 `1`（缺省值）时省略，只有非 1 才传。这是报给 journal 接缝的缺陷（ISS-520），不在本包绕过。
- **`mdAt` 装事件自身的时刻。** 旧树该列装的是 markdown 侧车的 `at:`。不留它，两次真实同形事件会塌成一行，因为 `stablePayload` 刻意排除 `at`。因此这个名字在本包名不副实；改名要动 P1 的 journal 契约。
- **没有跨重启修复。** 存量记录过不了 schema 就 `open` 失败，没有任何东西把它改写成当前形状。
- **`update` 是读-改-写，不是 compare-and-swap。** 门面把自身的写串行化，所以经一个门面的并发写不会交错；两个进程共用一个介质时不受保护，因为下层不提供 CAS。
- **审计失败不回滚记录。** journal append 抛错时，记录保持已写、只记一条 warn。反方向 —— 为保住审计而回滚一次成功的记录写 —— 会让「成功了却抛错」变成常态。
