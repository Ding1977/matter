---
description: "Matter 的活动流 seam：ctx.journal —— 追加型事件流（幂等 uid）+ 两个派生物（全文检索 / 边表）。自开 SQLite，不 import 存储 hub。"
kind: "package-reference"
---

# storage-journal

[English](README.md) | 中文

## Summary

`storage-journal` 是**活动流 seam**：一张追加型事件表（`activity_log`）加上由它派生的两个视图 —— 全文检索（`pm_search`，FTS5 + trigram 分词）与边表（`edges`，从 `relations` / `parent` / `blocked_by` 投影）。它挂载 `ctx.journal`，自开一个 SQLite 库。它**故意不是**存储 hub 上的表单：hub 的 KV facet 把列硬编码成 `key`/`value` 且句柄私有，活动流、检索索引、边表在那里无处安身。

## Table of Contents

- [使用本包](#使用本包)
- [理解实现](#理解实现)
- [已知限制与推迟的工作](#已知限制与推迟的工作)

-----

<a id="use-this-package"></a>
## 使用本包

给它一个目录，它在那里放 `journal.db`。

```ts
// 装配：一个插件、一个配置字段。`root` 故意没有默认值 ——
// 退回 process.cwd() 会把库散落到进程碰巧启动的任何目录。
plugins:
  - id: storage-journal
    config:
      root: /var/lib/matter
```

之后经 `ctx.journal` 追加、读取、检索：

```ts
const seq = ctx.journal.append({
  entity: 'issues/2026-11-16-ISS-1.md',
  event: 'issue-noted',
  actor: 'linmo',
  mdAt: '2026-11-16T12:50:49.694Z',   // 侧车自己的时间戳；是事件身份的一部分
  body: 'PM 调度器与事件流',
})

ctx.journal.list({ since: seq, entity: 'issues/2026-11-16-ISS-1.md' })
ctx.journal.rebuild()                    // 从真相源重建两个派生物
ctx.journal.search({ query: '调度器' })   // FTS5 trigram；不足三字符退回 LIKE
ctx.journal.inboundEdges('ISS-501')     // 谁指向我
```

### 你得到什么

- **幂等追加**：`append` 只发一条 `INSERT ... ON CONFLICT(uid) DO NOTHING`。同一条事件跑两次只留一行，并返回同一个 `seq`。迁移脚本重复执行不会长出第二份。
- **游标而不是列表**：`seq` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`，所以 `list({ since })` 是一个真正的重放游标，不是全量读。
- **两个可丢视图**：`search` 与 `edges` **无独立契约、无独立版本轴**。`resetDerived()` 丢掉两者，`rebuild()` 只凭 `activity_log` 让它们回来。
- **失败保持响亮**：已关闭的句柄抛 `closed` 而不是返回空集合；别人的库文件以 `foreign-database` 拒开而不是被认领。

### 失败与恢复

| code | 何时 | 怎么办 |
|---|---|---|
| `foreign-database` | 文件的 `application_id` 属于别的应用，或文件有用户表却没有身份 | 把 `config.root` 指到本包独占的目录 |
| `closed` | `close()` 之后读写 | 句柄已死；重新开一个 facility |
| `malformed-event` | `append` 缺非空的 `entity` 或 `event` | 调用方 bug —— 补齐两者 |
| `io` | 文件系统或引擎失败（目录建不出、文件打不开） | 修路径或权限 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

### 设计概念

一个真相源、两个派生物，版本轴避开邻包已占的那一列。

`activity_log` 是本 seam 里唯一不可重建的数据。`pm_search` 与 `edges` 都是它的投影：FTS5 表用 `activity_log.seq` 作 `rowid`，于是「索引一致吗」变成一次集合差，而不是跨两个标识符对账。`edges` 对 `relations` / `parent` / `blocked_by` 三个字段的 payload 做 last-write-wins 重算 —— 它回答「**现在**谁指向谁」，不是「历史上谁曾指向谁」。

版本身份是 `PRAGMA application_id = 0x4d4a524e`，不是 `user_version`。邻着那个 SQLite 后端只接受 `0` 与 `1` 之外的任何 `user_version` 都拒开；共用那一列等于两个包写同一根轴，而撞车是静默的 —— 各自读到一个自己认为合法的值。

### 源码地图

| 文件 | 装什么 |
|---|---|
| `src/index.ts` | `name` / `inject` / `Config` / `apply` + `JournalFacility`（append / list / search / edges / rebuild） |
| `src/schema.ts` | 开库序列、`JOURNAL_APPLICATION_ID`、`JOURNAL_SCHEMA_VERSION`、`resetDerivedSchema` |
| `src/journal.ts` | `appendJournal`（唯一的 INSERT）、`listJournal`、`activityUid`、`stablePayload` |
| `src/search.ts` | FTS5 投影、`rebuildSearch` / `reconcileSearch`、`searchText`、`toMatchQuery` |
| `src/edges.ts` | 三个 payload 字段的边投影，加上正向与反向查询 |
| `src/error.ts` | `JournalErrorCode`（4 条）+ `JournalError` |

### 为什么用 trigram，以及为什么要 LIKE 兜底

FTS5 默认的 `unicode61` 分词把一整串 CJK 当一个 token，中文子串一个都命不中。`trigram` 按三字符切，中文与英文子串都能查到。代价是查询串必须至少三字符；两字中文词（「派单」「审查」）很常见，所以短查询退回同一个库里的 `LIKE`，而不是降级成在 JS 里扫全表。

### 为什么 uid 算法逐字照抄

`activityUid = sha1(entity|event|md_at|stable_payload)` 从旧树的 `pm-store.js` 原样搬来。它是「重复导入不产生第二行」的唯一保证。`tests/journal.test.ts` 钉了四个黄金向量，期望值由**加载旧模块现算**得到，所以分隔符、字段顺序、`""` 缺省值任何一处漂了都会红，而不是悄悄把历史复制一份。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与推迟的工作

- **不写迁移脚本。** 本包只建空库。导入旧树那 1.8 万条事件是另一个阶段；测试从不读生产库。
- **`edges` 只覆盖三个字段，不是四个。** 投影 `relations` / `parent` / `blocked_by`。`project` 与 `subtasks` 该不该进边表是没拍的问题 —— 旧树把两者存成标量，猜错方向会产出一张没人敢信的表。
- **`rebuild()` 是 O(事件数)，不是增量。** 本 seam 的量级是几千到几万条事件。增量同步会换来一整类新错（边表与事件流漂移），而它要换的那点延迟还没有任何测量说明它重要。
- **只有备注正文进检索面。** 状态变更按 `event` 与 payload 标量进索引，不重切整个实体，所以写一条评论不会把一篇文档重新索引一遍。
- **`inject` 故意为空。** 本包既不依赖存储 hub 也不依赖任何 Provider，因此无条件激活。那是「另一个 seam」的定义，不是疏忽。
- **没有跨进程变更通知。** `append` 返回 `seq`；把它推到其它进程是后续阶段。
