---
description: "Matter 的文档实体域（ctx.documents）：权威 25 字段 DocProps、正文走 blocks 槽并以平级 {props, blocks} 落盘，每次持久写入都投影进活动流。"
kind: "package-reference"
---

# @matter/document

[English](README.md) | 中文

## Summary

`@matter/document` 是 P2 实体层的 E-2 业务域。`DocProps` schema 承载从 `fieldsForDomain('documents')` 实测得到的全部 25 个字段，每个字段都带 `.meta({ writable, widget, indexable })`。正文走 blocks 槽而非 `body` 字符串：表声明 `@matter/blocks` 的 `BlockArray` 为 blocksSchema，因此每条记录落盘为平级 `{props, blocks}`（ISS-525）。本包挂载 `ctx.documents` 作为唯一写路径，并把每次持久变更投影进活动流，装配照 E-0/E-1。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

导入 schema 并在边界校验。记录值是 `{props, blocks}` —— props 与 blocks 是平级的两个槽，不互相嵌套。

```ts
import { DocProps, BlockArray, DOCUMENT_TABLE, DocumentDomain } from "@matter/document"

const props = DocProps.parse({
  id: "DOC-1", title: "first", author: "linmo",
  created: "2026-11-20T00:00:00Z", updated: "2026-11-20T00:00:00Z",
})
const blocks = BlockArray.parse([{ id: "b1", type: "paragraph", rich: [{ text: "hello" }] }])
console.log(DocumentDomain.name, DOCUMENT_TABLE, props.title, blocks.length)
```

装配四个插件，文件顺序无关 —— 各自通过 `ctx.inject` 等服务键就绪：

```ts
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: "/var/lib/matter/records" })
await ctx.plugin(StorageDomain, { backend: "json" })
await ctx.plugin(Journal, { root: "/var/lib/matter" })
await ctx.plugin(Document)
```

之后经 `ctx.documents` 写入：

```ts
const created = await ctx.documents.create({ props, blocks })
await ctx.documents.update("DOC-1", { blocks: [/* 新块数组 */] }, { actor: "linmo" })
ctx.journal.list({ entity: "documents/DOC-1" }).rows
// -> created · body-change（payload: { field: "blocks", fromHash, toHash, blockDelta }）
```

### What you get

- **25 字段全建。** 不取「核心子集」：schema 与 `fieldsForDomain('documents')` 对齐，每个字段的写档、控件与检索标记就在 schema 上。
- **正文是块树。** `BlockArray` 在 durable 边界校验 28 类型判别联合；叶子塞 `children` 即校验红，盘上坏块让 `open` 以 `invalid-record` 拒绝。
- **平级 `{props, blocks}` 落盘。** 一条记录一个 JSON 文档，props 与 blocks 是同级键，后端信封之外无额外包装。
- **审计来自差异。** `update` 比较上一版：blocks 变更落 `body-change`（只记指纹、不记正文），`status` 落 `status-change`，其余 props 落 `field-change`。

### Failures and recovery

| 错误 | 何时 | 修法 |
|---|---|---|
| `ZodError` | 值破坏 schema（非法枚举 / 日期 / 未知键 / 坏块） | 修正值；`error.issues[].path` 指明字段 |
| `DocumentExistsError` | 对已存在 id `create` | 改用 `update` 或换 id |
| `DocumentNotFoundError` | 对不存在 id `update` | 先 `create`，或先用 `get` 查 |
| `invalid-record`（域层） | 重开时存量记录过不了 schema | 修盘上文档；否则 `open` 拒绝整域 |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design concept

E-2 域是 ISS-525 blocks 槽的第一个消费者。`domainTable<string, DocProps, BlockType[]>(DocProps, BlockArray)` 让 `B` 非 never，于是 `TableValueOf` 派生 `{props, blocks}`，而未传 blocksSchema 的 E-0/E-1 表仍逐字保持裸 props 形态。门面的 `parse` 校验整条平级记录，主键取 `record.props.id`。

`domain/changed` 只带新值，所以差异必须在写链这一格算 —— 那里还看得到上一版。顺序是承重的：`domain/changed` 监听器运行时活动流还没有那一行；审计先写会让一次被后端拒绝的写入在审计里留下假行。

### Source map

| 文件 | 内容 |
|---|---|
| `src/spec.ts` | `DocProps`（25 字段 + `.meta()`）、词表、`BlockArray`、`DocRecord`、`DocPatch`、`DocumentDomain` |
| `src/events.ts` | 事件名、`diffEntries`、`blocksFingerprint`、`documentEntry` |
| `src/index.ts` | `DocumentsFacility`（`ctx.documents`）、`openDocuments`、`apply`、两个域错误 |

### 为什么主键用裸 string

`@matter/storage` 的 brand 模块只导出 `IssueId`；补 `DocId` 要改那个 P1 包，超出本包写范围。因此主键是普通 `string`，而 schema 的 `id` 字段仍带 `.meta({ branded: "DocId" })`，供前端读出意图。等存储 seam 重开时再加 branded 类型。

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **PATCH 整体替换 `props` / `blocks`。** `DocPatch` 不深合并 props 单字段；改一个属性要传整份 props。深合并要等真消费者出现。
- **块树算法与渲染不在此。** 遍历、引用解析、同步传播与渲染属 E-3b / P3；本包只存与校验块。
- **不迁移旧 frontmatter。** 存量文档过不了 25 字段 schema 时 `open` 拒绝，暂无就地改写路径。
- **`update` 是读-改-写，不是 CAS。** 单个门面串行化自己的写；两进程共享同一介质时无保护，因为下层不提供 CAS。
- **审计失败不回滚记录。** append 失败只记 warn，记录照写。为保审计完整而回滚已持久写入，被判定为更坏的方向。
