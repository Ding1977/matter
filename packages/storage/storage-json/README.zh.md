---
description: "Matter 的 per-record JSON 存储后端：在配置的根目录下一条记录一个人类可读文档，作为后端 `json` 注册到 ctx.storage。"
kind: "package-reference"
---

# @matter/storage-json

[English](README.md) | 中文

## Summary

`@matter/storage-json` 是存储 seam 的 **Provider** 角色。它拥有一份介质 —— 配置 `root` 下的一棵目录树 —— 并以 `json` 之名提供 `ctx.storage.backend` 的 `kv` facet。落盘布局是 **`per-record`**：`<root>/<unit>/<table>/<key>.json`，一条记录一个文档，全局槽是 `<root>/<unit>/global.json`。每次写只通过原子 rename 发布一个文档，故写一条记录不会重写整个 unit。

任何要通过 `ctx.storage` 持久化应用数据的装配都应挂载它。

## Table of Contents

- [使用本包](#使用本包)
- [理解实现](#理解实现)
- [已知限制与待办](#已知限制与待办)

-----

## 使用本包

### 得到什么

一个注册为 `json` 的 `StorageBackend`，外加一个只负责生命周期的服务键 `storage.backend.json`，领域层 provider 注入它以防「先于后端注册就激活」。

```ts
import { apply as jsonStorage } from "@matter/storage-json"

await ctx.plugin(jsonStorage, { root: "/var/lib/matter/storage" })
const backend = ctx.storage.backend.get("json")
const unit = await backend.kv!.open({ name: "pm_issue", version: 1, tables: ["issues"], hasGlobal: true })
```

`root` **故意没有默认值**：退回 `process.cwd()` 会把 unit 文件散落到进程碰巧启动的任何目录。缺失或非字符串的 `root` 在加载时报错，而不是静默跳过。

### 故障与恢复

| 情况 | 行为 |
|---|---|
| 记录文档损坏 | 该条读作**不存在**，unit 其余部分不受影响 |
| 记录文档的版本戳不被接受 | 该条读作**不存在**；**不迁移**，字节留在盘上 |
| 记录 key 不是路径安全的 | **写前**拒绝（须匹配 `[a-zA-Z0-9_-]+`） |
| 批量删除无法还原它暂存的文档 | unit 以 `unknown-state` 拒绝；之后每次调用都拒绝，直到 `close()` |
| 写在中途失败 | 临时文件被移除，旧文档完整存活 |

要紧的区分是：**per-record 丢弃，整单元拒绝。** `single` 布局下每个 unit 只有一个文档，坏文件必须大声拒绝；本布局下一条坏记录不能拖垮整个 unit，故读作不存在。这个不对称是契约，不是疏漏。

## 理解实现

### 设计概念

**目录即状态。** `loadAll()` 每次调用都重读目录树，unit 不持有任何内存记录 —— 活跃的表归领域层所有，它用打开时的 `loadAll()` 播种，并通过自己的写链串行化写入。此处加缓存会与磁盘脱节，而「目录就是数据」正是本布局的全部意义。

写是原子的：同目录临时文件 → `sync()` → `rename()` → fsync 父目录。rename 在 POSIX 与 Windows 上都是原子替换，而**替换**（不是不覆盖）才是正确语义，因为一个 unit 文档只有一个写者。

### 原子发布协议

1. 在目标**同目录**里 `open(<tmp>, 'wx', 0o600)` —— rename 因此永不跨文件系统。
2. `writeFile` 后 `handle.sync()` —— 字节先落盘，名字才发布。
3. `rename(tmp, target)` —— 读者看到的要么是旧文档要么是新文档，永不是半个写。
4. POSIX 上 `fsyncDirectory(dirname)` —— 新目录项在崩溃后仍存在。

任何异常路径都移除临时文件，故崩溃后既没有半成品文档，也没有 `.tmp` 残渣。

### 批量删除：先暂存，再清理

文档先被 rename 成 `<key>.json.deleting`，整批暂存完成后才 unlink。rename 已把这一批从读者视野里藏起来，故 unlink 只是清理 —— 而 unlink 失败也只留下不可读的文件，而不是可读条目。暂存失败会回滚已做的 rename；若回滚本身也失败，可读状态未知，unit 以 `unknown-state` 隔离。删一半的状态比不删更坏。

### 源码地图

| 文件 | 职责 |
|---|---|
| `src/index.ts` | `name` / `inject` / `Config` / `apply`、`JsonStorageBackend`、描述符校验 |
| `src/per-record-unit.ts` | `PerRecordJsonUnit` + `openPerRecordUnit`；读树、put、批量删、备份 |
| `src/atomic.ts` | `writeAtomic`、`fsyncDirectory` |
| `src/format.ts` | `{version, record}` 的序列化与解析 |

`apply()` 在关闭介质**之前**先注销名字。把两者顺序颠倒会开一个窗口：并发写仍能从注册表解析到后端，却发现它已关闭 —— 现场表现是偶发 `closed` 报错，而不是崩溃。

## 已知限制与待办

- **`per-record` 与 `single` 两种布局都有。** `descriptor.layout === "single"` 打开整单元单文档 `<root>/<name>.json`（`single-unit.ts`）；缺省（含 `undefined`）仍是 `per-record`。ISS-510 因当时无消费者而故意不做 `single`；ISS-535 的 `views.json`（视图配置整组放 global 槽）成了那个消费者，该决策**被取代**——整单元的 `serialize`/`parse` 与 `single-unit.ts` 已从 DSH 补回，原子整份发布、损坏出声拒绝等语义与 DSH 先例一致。
- **没有 legacy bootstrap。** DSH 会在首次打开时把 per-record 之前的整单元文件（`<root>/<name>.json`）迁移进新树。Matter 从未发布过那种布局，故没有旧数据要迁。
- **key 是路径段。** `ISS-506` 能过 `SAFE_KEY_RE`，但 unit 与表名还必须过 `UNIT_NAME_RE`（`[a-z][a-z0-9_]*`）—— 所以工单 id 能当记录 key，永远不能当 unit 名。
- **unit 不串行化并发写。** 写顺序归调用方；领域层对每个 unit 跑一条写链。
- **共享一致性套件有三条用例断言的是 `single` 布局语义**（不安全 key 能往返；不接受的版本在 open 时拒绝）。它们与本后端的契约按设计冲突，记录在 ISS-510 上，不在此处绕过。
