/**
 * Shared KV-backend conformance suite. Each backend's spec file calls
 * {@link runKvBackendContract} with a factory bound to its own medium; the
 * suite asserts every clause of the `src/backend.ts` contract so both
 * backends are held to identical semantics.
 *
 * 【为什么本文件是 `.ts` 而不是 `.test.ts`】它不是测试文件，是**被 Provider 调用**的
 * 共享套件：`@matter/storage-json`（ISS-510）在自己的 spec 里
 * `import { runKvBackendContract }`。它自己不注册任何用例 —— 只有被调用时才 `describe()`。
 *
 * 【为什么拆成四个子套件】`lint-complexity`（`.oxlintrc.next.json`）判
 * `max-lines-per-function ≤ 100`：单函数装 9 个用例实测 155 行 ⇒ 2 条红（本单实测）。
 * 按「基础读写 / 版本守卫 / 序列化与容错 / 生命周期」四组切分，每个用例体一字未改 ——
 * 这是**组织方式**的改动，不是行为的简化。
 *
 * ⚠️ 消费者是**下一个单**（ISS-510），本单内它是零调用的。这不是「没有消费者的抽象」——
 * 它是 seam Definition 三角色的第三条腿：没有一致性套件，Provider 的正确性只能靠口头约定。
 *
 * 【本套件只断言两种布局**共同**的子句】（ISS-512）
 * 套件是**跨布局**的：它不被允许知道描述符落在哪种布局上，故 `DESCRIPTOR` 故意**不声明**
 * `layout`（声明它 = 把套件钉死在一个布局的语义上）。两种布局语义相反的两类子句因此
 * **不在**本套件里，各自的 Provider spec 负责：
 *
 * | 子句 | `single` | `per-record` | 归谁断言 |
 * |---|---|---|---|
 * | 记录 key 是否可以是任意字符串 | 原样接受（key 只是文档内字段） | **写前拒绝** —— key 要当路径段，`SAFE_KEY_RE` 是路径穿越防线 | `storage-json/tests/per-record.test.ts`「非法 key」两条 |
 * | 版本不符的 `open()` | 整个 unit 一个文档 ⇒ **判 `version-mismatch`** | **读作不存在** —— 目录即真相，一条记录不与整 unit 同生共死 | `storage-json/tests/per-record.test.ts`「版本守卫」两条 + `contract-conflict.test.ts` |
 *
 * 语义依据是 `src/backend.ts` 自己的话：`:63-72`「`per-record` … an unaccepted document
 * **reads as absent instead of rejecting the whole unit**」、`:107-110`「In the `per-record`
 * layout a key becomes a path segment and must match `[a-zA-Z0-9_-]+` (**an unsafe key
 * rejects**)」。⚠️ 这两类是**布局差异**，不是「实现错误的已知红」：谁为让它们在本套件里
 * 变绿而放开 `SAFE_KEY_RE` 或让 `open()` 抛 `version-mismatch`，`contract-conflict.test.ts` 会红。
 *
 * @module @matter/storage/tests/contract
 */

import { describe, expect, it } from "vitest"
import type { KvUnitDescriptor, StorageBackend } from "../src/backend.ts"

/** One conformance run: a fresh backend plus a way to reopen the same medium (crash simulation). */
export interface KvBackendContractHarness {
  /** The backend under test, freshly created over an empty medium. */
  backend: StorageBackend
  /** Open a NEW backend instance over the SAME medium, as after a process restart. */
  reopen(): Promise<StorageBackend>
}

/**
 * Fixed descriptor shared by every sub-suite.
 *
 * ⚠️ **故意不声明 `layout`**（ISS-512）：声明它等于把套件钉死在一个布局的语义上，
 * 而本套件只断言两种布局**共同**的子句（差异见文件头表格）。
 */
const DESCRIPTOR: KvUnitDescriptor = {
  name: "contract_unit",
  version: 3,
  tables: ["alpha", "beta"],
  hasGlobal: true,
}

/** Fresh harness factory shared by every sub-suite. */
type Create = () => Promise<KvBackendContractHarness>

/** Basic read/write shape: empty open, round-trip, overwrite, batch delete. */
function basicsSuite(create: Create): void {
  describe("basics", () => {
    it("opens a missing unit as empty and serves loadAll immediately", async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      const snapshot = await unit.loadAll()
      expect(snapshot.tables).toEqual({ alpha: {}, beta: {} })
      expect(snapshot.global).toBeNull()
      await backend.close()
    })

    it("round-trips records and global durably across reopen", async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord("alpha", "k1", { n: 1 })
      await unit.putRecord("alpha", "k2", { n: 2 })
      // key 用**两种布局都合法**的形态：`per-record` 要求它当路径段（`[a-zA-Z0-9_-]+`），
      // `single` 随便。套件只断言共同子句 ⇒ 不能拿只对 single 成立的 key 当输入。
      // 「不安全 key 是否被拒」归 per-record 自己的 spec（见文件头表格）。
      await unit.putRecord("beta", "weird_key_with_stuff", { ok: true })
      await unit.setGlobal({ counter: 7 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      const snapshot = await (await reopened.kv!.open(DESCRIPTOR)).loadAll()
      expect(snapshot.tables["alpha"]).toEqual({ k1: { n: 1 }, k2: { n: 2 } })
      expect(snapshot.tables["beta"]).toEqual({ weird_key_with_stuff: { ok: true } })
      expect(snapshot.global).toEqual({ counter: 7 })
      await reopened.close()
    })

    it("putRecord overwrites and deleteRecord is idempotent", async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.putRecord("alpha", "k", { v: "old" })
      await unit.putRecord("alpha", "k", { v: "new" })
      await unit.deleteRecord("alpha", "k")
      await unit.deleteRecord("alpha", "k")
      await unit.deleteRecord("alpha", "never-existed")
      expect((await unit.loadAll()).tables["alpha"]).toEqual({})
      await backend.close()
    })

    it("deleteRecords removes the whole batch durably and is idempotent", async () => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord("alpha", "k1", { n: 1 })
      await unit.putRecord("alpha", "k2", { n: 2 })
      await unit.putRecord("alpha", "k3", { n: 3 })
      await unit.putRecord("beta", "b1", { n: 4 })
      await unit.deleteRecords("alpha", ["k1", "k3", "missing", "k1"])
      await unit.deleteRecords("alpha", [])
      const expected = { alpha: { k2: { n: 2 } }, beta: { b1: { n: 4 } } }
      expect((await unit.loadAll()).tables).toEqual(expected)
      await harness.backend.close()

      const reopened = await harness.reopen()
      expect((await (await reopened.kv!.open(DESCRIPTOR)).loadAll()).tables).toEqual(expected)
      await reopened.close()
    })
  })
}

/** Version stamp and compatibility rules. */
function versionSuite(create: Create): void {
  describe("versioning", () => {
    // 原用例是 `it.each([2, 4])("rejects version %s on reopen …")`，断言 `open()` **抛
    // `version-mismatch`** —— 那是 `single` 布局的语义（整个 unit 一个文档）。`per-record`
    // 相反：一条记录不与整 unit 同生共死，版本不符的文档**读作不存在而不抛**
    // （`src/backend.ts:63-67`）。**反应本身**是布局差异，不归本套件（见文件头表格）；
    // 而「不论哪种反应，落盘数据都不许被这次 open 改动」是两种布局**共同**的子句 ——
    // 保留它，把断言从「反应」改成「数据完整性」。
    it.each([2, 4])("an unaccepted version %s never damages the stored records", async (version) => {
      const harness = await create()
      const unit = await harness.backend.kv!.open(DESCRIPTOR)
      await unit.putRecord("alpha", "k", { v: 1 })
      await harness.backend.close()

      const reopened = await harness.reopen()
      try {
        // 抛（single）或读作不存在（per-record）都在契约内 —— 本套件不断言是哪种。
        await reopened.kv!.open({ ...DESCRIPTOR, version })
      } catch (error) {
        // ⚠️ 必须过滤，不能裸 `catch {}`：无过滤等于「把**任何**异常都解释成单侧的合法反应」。
        // 实测（ISS-512 审查）：让 `openPerRecordUnit` 在 `version !== 3` 时抛
        // `ENOSPC: no space left on device`，裸 catch 下本条仍**照绿** —— 磁盘满、权限不足、
        // 路径被删全被吞掉。只放行契约里那一个合法拒绝码，其余原样抛出去让用例红。
        //
        // ⚠️ 判**码**不判**类**（`src/error.ts:18-19` 原文：「The `code` is the stable contract
        // consumers may switch on; `message` is diagnostic prose」）。不能用
        // `error instanceof StorageError`：Provider 按惯例从包入口 `@matter/storage` 导入，
        // 而本文件从 `../src/error.ts` 导入 —— 构建把同一份源码内联进 `lib/index.js`
        // 与 `lib/types/error.js` 两个产物，实测 `same class: false`、包入口实例对源码类
        // `instanceof` 为 **false** ⇒ 合法 `version-mismatch` 会被误判成非法再抛一遍。
        // per-record 下看不出来（它不抛），`single` 一落地就红，且红的是合法路径。
        if ((error as { code?: string }).code !== "version-mismatch") throw error
      }
      await reopened.close()

      // 用**原版本**重开：数据必须一字未动。
      const intact = await harness.reopen()
      expect((await (await intact.kv!.open(DESCRIPTOR)).loadAll()).tables["alpha"]).toEqual({ k: { v: 1 } })
      await intact.close()
    })

    it("reads an accepted older version without changing its stamp or records", async () => {
      const harness = await create()
      const original = await harness.backend.kv!.open(DESCRIPTOR)
      await original.putRecord("alpha", "k", { v: 1 })
      await original.setGlobal({ counter: 1 })
      await harness.backend.close()

      const current = { ...DESCRIPTOR, version: 4, compatibleVersions: [3] }
      const reader = await harness.reopen()
      expect(await (await reader.kv!.open(current)).loadAll()).toEqual({
        tables: { alpha: { k: { v: 1 } }, beta: {} },
        global: { counter: 1 },
      })
      await reader.close()

      const unchanged = await harness.reopen()
      expect((await (await unchanged.kv!.open(DESCRIPTOR)).loadAll()).tables["alpha"]).toEqual({ k: { v: 1 } })
      await unchanged.close()
    })

    it.each(["deleteRecord", "deleteRecords", "emptyBatch"] as const)(
      "keeps the older stamp for a no-op %s",
      async (operation) => {
        const harness = await create()
        const original = await harness.backend.kv!.open(DESCRIPTOR)
        await original.putRecord("alpha", "saved", { v: 1 })
        await harness.backend.close()

        const writer = await harness.reopen()
        const unit = await writer.kv!.open({ ...DESCRIPTOR, version: 4, compatibleVersions: [3] })
        if (operation === "deleteRecord") await unit.deleteRecord("alpha", "missing")
        else await unit.deleteRecords("alpha", operation === "emptyBatch" ? [] : ["missing", "missing"])
        await writer.close()

        const unchanged = await harness.reopen()
        expect((await (await unchanged.kv!.open(DESCRIPTOR)).loadAll()).tables["alpha"]).toEqual({ saved: { v: 1 } })
        await unchanged.close()
      },
    )
  })
}

/** Serialization failure must leave the previous snapshot intact and allow retry. */
function resilienceSuite(create: Create): void {
  describe("serialization failure", () => {
    it("restores the open snapshot and retries on the same unit", async () => {
      const harness = await create()
      await (await harness.backend.kv!.open(DESCRIPTOR)).putRecord("alpha", "saved", { v: 1 })
      await harness.backend.close()

      const current = { ...DESCRIPTOR, version: 4, compatibleVersions: [3] }
      const writer = await harness.reopen()
      const unit = await writer.kv!.open(current)
      const broken = {
        toJSON: () => {
          throw new Error("serialization failed")
        },
      }
      await expect(unit.putRecord("alpha", "broken", broken)).rejects.toThrow("serialization failed")
      expect((await unit.loadAll()).tables["alpha"]).toEqual({ saved: { v: 1 } })
      await unit.putRecord("alpha", "retry", { v: 2 })
      await writer.close()

      const restarted = await harness.reopen()
      expect((await (await restarted.kv!.open(current)).loadAll()).tables["alpha"]).toEqual({
        saved: { v: 1 },
        retry: { v: 2 },
      })
      await restarted.close()
    })
  })
}

/** Close semantics: idempotent, and every later call rejects `closed`. */
function lifecycleSuite(create: Create): void {
  describe("lifecycle", () => {
    it("rejects operations after unit close, and close is idempotent", async () => {
      const { backend } = await create()
      const unit = await backend.kv!.open(DESCRIPTOR)
      await unit.close()
      await unit.close()
      await expect(unit.putRecord("alpha", "k", {})).rejects.toMatchObject({ code: "closed" })
      await expect(unit.loadAll()).rejects.toMatchObject({ code: "closed" })
      await expect(unit.deleteRecords("alpha", ["k"])).rejects.toMatchObject({ code: "closed" })
      await backend.close()
      await backend.close()
    })
  })
}

/**
 * Run the shared conformance suite against one backend implementation.
 * @param label - Suite label, e.g. `json` / `sqlite`.
 * @param create - Factory producing a fresh harness per test.
 */
export function runKvBackendContract(label: string, create: Create): void {
  describe(`kv backend contract: ${label}`, () => {
    basicsSuite(create)
    versionSuite(create)
    resilienceSuite(create)
    lifecycleSuite(create)
  })
}
