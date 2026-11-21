---
description: "Matter 知识库的块引擎库：28 类型 zod 判别联合 + 容器/引用校验 + V5（叶子块禁止 children）构成 schema 半，运行时半提供块树遍历、索引与引用提取、视图查询谓词。只有数据、辅助与纯算法，不渲染。"
kind: "package-reference"
---

# @matter/blocks

[English](README.md) | 中文

## Summary

`@matter/blocks` 是 Matter 知识库的块引擎库。schema 半（P2）是覆盖全部 28 种 `BlockType` 的 zod 判别联合，带容器/引用词表与边界上的 V5；运行时半（P3-B1）在同包加三个纯算法：`walkBlocks`（DFS 前序，256 层深度上限）、`indexBlocks` / `extractReferences`（一趟遍历产出 id→路径索引与四类引用分档）、`evaluateViewQuery`（filter AND / sort / limit 谓词，字段元数据由调用方注入）。始终是普通库 —— 不渲染、不挂 ctx 键、不装配执行器。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

导入 schema 并在边界校验即可。本包是普通库，无需插件装配。

```ts
import { Block, isContainer, isReference, blockChildren, blockRef } from "@matter/blocks"

const container = Block.parse({
  id: "b1",
  type: "columns",
  children: [{ id: "b2", type: "paragraph", rich: [{ text: "你好" }] }],
})
if (isContainer(container)) console.log(blockChildren(container).length) // 1

const ref = Block.parse({ id: "b3", type: "issueRef", ref: "ISS-526" })
if (isReference(ref)) console.log(blockRef(ref)) // ISS-526
```

### 遍历、索引与引用提取

遍历、索引与引用提取共用一趟 DFS 前序 —— 容器递归与深度上限共享一份实现，消费者不各写一遍。

```ts
import { Block, extractReferences, indexBlocks, walkBlocks } from "@matter/blocks"
import type { Block as BlockValue } from "@matter/blocks"

const blocks: BlockValue[] = [
  Block.parse({ id: "b1", type: "paragraph", rich: [{ text: "你好" }] }),
  Block.parse({
    id: "b2",
    type: "columns",
    children: [Block.parse({ id: "b3", type: "issueRef", ref: "ISS-529" })],
  }),
]

// DFS 前序：自身先于子孙，兄弟按数组序。
const ids: string[] = []
walkBlocks(blocks, (block, path, depth) => {
  ids.push(block.id)
  if (depth > 0) console.log(path.at(-1), "嵌套于第", depth, "层")
})

// id → { document, path }：嵌套块（columns 里的 issueRef）同样被索引。
const index = indexBlocks(blocks, "DOC-1")
console.log(index.get("b3")?.path) // ["b2", "b3"]

// 四类引用分三档：块级（syncedBlock）/ 实体级（issueRef、docRef）/ 配置级（view）。
const refs = extractReferences(blocks)
console.log(refs.entity.map((site) => site.block.ref)) // ["ISS-529"]
```

### 执行视图查询

`view` 块指向一份查询配置。spec 由 zod 校验；字段元数据由调用方注入 —— 本包不认识任何 issue/document 字段。

```ts
import { evaluateViewQuery } from "@matter/blocks"
import type { ViewFieldCatalog, ViewRow } from "@matter/blocks"

const rows: readonly ViewRow[] = [
  { id: "i1", status: "open", priority: "high" },
  { id: "i2", status: "closed", priority: "low" },
]
const fields: ViewFieldCatalog = { id: "string", status: "string", priority: "string" }

const out = evaluateViewQuery(
  rows,
  { filter: [{ field: "status", values: ["open"] }], sort: [{ field: "priority", dir: "desc" }], limit: 10 },
  fields,
)
console.log(out.map((row) => row.id)) // ["i1"]
```

### What you get

- **一个判别联合，28 个成员。** `Block` 按 `type` 判别；A/B/C 词表谓词 + 末尾 `assertNever` 封闭联合，新类型只需登记到对应词表。
- **边界上的 V5。** `Block.safeParse({ id, type: "paragraph", children: [] })` 会失败 —— 叶子是没有 `children` 键的 strict object。容器解析同样的值则通过。
- **递归也校验。** `children` 是指回 `Block` 的 lazy 引用，嵌套块在解析时按同一个联合校验。
- **词表与分组。** 导出 `BLOCK_TYPES`、`CONTAINER_TYPES`、`REFERENCE_TYPES` 与 A/B/C 三组列表，供生成器与 UI 使用。
- **三个树算法，一份递归。** `walkBlocks`、`indexBlocks`、`extractReferences` 共享一趟带 256 层 wire-safety 上限（`WalkDepthLimitError`）的 DFS 前序实现 —— 消费者不再各写容器递归。
- **不认识实体域的视图查询谓词。** `evaluateViewQuery` 在纯行数据上跑 filter（子句间 AND、子句内 OR、保输入序）→ sort（多键、稳定）→ limit，spec 由 `ViewQuerySpec` 校验、引用的字段逐一对注入的 `ViewFieldCatalog` 校验。

### Failures and recovery

| 错误 | 何时 | 怎么修 |
|---|---|---|
| `ZodError`（`invalid_union`） | 值不满足任何成员：未知 type、缺必填字段、叶子带 `children` | 看 `error.issues[].path`；去掉多余键或补必填字段 |
| `WalkDepthLimitError` | 树深超过 256 层 | 修产出这条深链的数据；上限是 wire-safety 护栏，不是可调参数 |
| `ViewQueryError`（`VIEW_QUERY_UNKNOWN_FIELD`） | filter/sort 引用了目录之外的字段 | 往注入的 `ViewFieldCatalog` 补该字段，或修 spec |
| `ViewQueryError`（`VIEW_QUERY_FIELD_TYPE_MISMATCH`） | 行值类型与目录声明矛盾 | 对齐行数据或目录 —— 比较按类型校验，绝不静默转换 |
| 编译 `TS2345` | 新增了 BlockType，但未登记到对应 A/B/C 词表 | 在 `src/index.ts` 把新类型登记到对应的 A/B/C 词表 |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design concept

联合由 25 个非递归的 `z.strictObject` 叶子 schema，加上 3 个 `children` 字段为指回 `Block` 的 `z.lazy` 的容器 schema 构成。用 `strictObject` 是 V5 的承重件：`z.object` 会静默丢弃未知键，那样叶子带 `children` 也能通过、容器/叶子的边界会在毫无报错的情况下塌掉。`ZodType<Block>` 标注只放在 lazy 的 `children` 字段上 —— 给整个联合成员加标注会抹掉 `z.discriminatedUnion` 所需的判别元数据。

TypeScript 的 `Block` 类型是运行时联合的真实镜像：25 个 `z.infer` 成员 + 3 个内联容器字面量类型。正因如此，A/B/C 三个类型谓词才能在 `blockGroup` 末尾把 `block.type` 收窄到 `never`，让 `assertNever` 有意义。

运行时半复用这套封闭而不另起炉灶：`extractReferences` 用 `isReference` 收窄（收窄类型**从 `REFERENCE_TYPES` 词表派生**，不是手写字面量 —— 词表是唯一真相源），对四类引用 switch 后以 `assertNever` 收尾；漏登记是编译错，词表外的运行期值抛与 `blockGroup` 同款的 `UnhandledBlockTypeError`。`isReference` 的收窄最初按结构写（`Extract<Block, { ref: string }>`），把 `template` 也收了进来（它结构上带 `ref` 但不是引用块），打碎了穷尽 switch —— ISS-529 修正为从词表派生。

### Source map

| 文件 | 装什么 |
|---|---|
| `src/spec.ts` | 28 个 zod schema、`Block` 联合与类型、五张词表、V5 强制 |
| `src/index.ts` | `assertNever`、`blockGroup`（A/B/C 词表谓词）、`isContainer` / `isReference` / `blockChildren` / `blockRef`、包级再导出 |
| `src/walk.ts` | `walkBlocks` DFS 前序、`MAX_WALK_DEPTH = 256`、`WalkDepthLimitError` |
| `src/tree-index.ts` | `indexBlocks`（id → 文档 + 路径）、`extractReferences`（四类引用分三档） |
| `src/view-query.ts` | `ViewQuerySpec`（zod）、`evaluateViewQuery`、`ViewQueryExecutor` 接缝、`ViewQueryError` |
| `tests/spec.test.ts` | 28 类型正例、V5 正反例、引用字段、分组 |
| `tests/walk.test.ts`、`tests/tree-index.test.ts`、`tests/view-query.test.ts` | 三个算法，每条断言都写成「换成错误实现即红」 |

### 为什么还没有 `ctx.blocks` 服务

块树算法（P3-B1）刻意落成纯函数：它们无状态，包一层服务不产生价值。`ctx.blocks` 键值得挂的条件是消费者需要跨文档缓存（P8 syncedBlock）或注入式执行器（P4 views）—— 两个触发条件都写进了规划，届时仍在本包内演进、不拆包。

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **不渲染。** walk/index/query 是数据面算法；渲染器属 U-2，不进本包。
- **引用只提取、不解析。** `extractReferences` 只报告引用在哪；目标存在性、反查（edges 表）与同步传播归 document 域存储（P8/P9）。
- **视图查询在内存跑。** `evaluateViewQuery` 过滤数组；没有 SQLite 查询计划、没有分页、没有执行器装配 —— `ViewQueryExecutor` 接口是 P4 建 views.json 时要实现的接缝。
- **索引每次全量重建。** 没有增量索引、没有失效协议 —— 与 edges 表同一哲学。
- **只有一种遍历形态。** DFS 前序覆盖今天的消费者（U-2 渲染、P9 导出、P8 定位）；pre/post/广度/异步等有真实消费者再说。
- **V5 只查 `children` 键。** 更深的规则 —— 超过遍历上限的容器嵌套深度、引用目标是否存在 —— 不在 schema 判据内；后者需要真存储（E-2/E-3b）。
- **富文本与 marks 是占位。** `Rich` 只有 `text` 与字符串 `marks` 数组；DOC-512 §2.4 的 12 种 mark 留到 P3。
- **媒体字段只存不透明 id/URL。** 本包不校验 `url` 能否打开、`asset` 是否存在 —— 媒体是横切挂件，不归本包拥有。
