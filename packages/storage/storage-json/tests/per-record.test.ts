/**
 * 本布局（`per-record`）特有的行为测试 —— 共享套件管通用契约，
 * 本文件管「目录即真相」这一层只有 per-record 才有的判据。
 *
 * 每一条都对应任务书验收表里的一行，且**每条都是负向用例**：
 * per-record 的错法是「静默错」——「坏文件读作不存在」与「真的不存在」在
 * `loadAll()` 的返回值上**完全同形**，只测正例永远发现不了。
 *
 * ## 为什么本文件有 3 条断言与共享套件相反（语义依据，不是「已知冲突」）
 *
 * `../../storage/tests/contract.ts` 的 `runKvBackendContract` **只按 `single` 布局写**，
 * 它的 DESCRIPTOR 没有 `layout` 字段（默认即 `single`）。`backend.ts:60-72` 定义了两种布局
 * 的语义差异，套件从未按它分流：
 *
 * | 动作 | `single`（套件断言的语义） | `per-record`（本文件的语义） |
 * |---|---|---|
 * | 非法 key `../evil` | key 只是文档内字段，原样接受 | **必须拒绝** —— key 要当路径段，`SAFE_KEY_RE` 是**路径穿越防线** |
 * | 版本不符的文档 | 整个 unit 只有一个文档 ⇒ **抛 `version-mismatch`** | **读作不存在** —— 目录即真相，一条记录不与整 unit 同生共死 |
 *
 * `backend.ts:63-65` 原文：`per-record` keeps each record in its own document … and an
 * unaccepted document **reads as absent instead of rejecting the whole unit**。
 * `backend.ts:107-109` 原文：`In the per-record layout a key becomes a path segment and must
 * match [a-zA-Z0-9_-]+ (**an unsafe key rejects**)`。
 *
 * 同一张表的套件读者视角见 `../../storage/tests/contract.ts` 文件头 —— 那里多一列「归谁断言」。
 * 两处都留：本文件服务 Provider 读者（改 per-record 前先读这一侧），套件头服务套件读者
 * （加子句前先读那一侧）。读者不同，删任一处都会让对面的人翻错文件。
 *
 * ⇒ **套件错了，实现对了。** 本文件锁定 per-record 的正确行为：
 * 阻止有人为让套件变绿而放开 `SAFE_KEY_RE`（安全边界）或让 `open` 抛 `version-mismatch`。
 *
 * 差异子句已归各自 Provider 的 spec（安全 key / 版本语义归本文件）；套件自 ISS-512 乙档
 * （`bfa6e58a`）起只断言两布局**共同**的子句，故与本文件不再相反。
 *
 * ⚠️ 套件本身仍被**完整运行**，不 `skip`、不挑跑。
 *
 * @module @matter/storage-json/tests/per-record
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { KvUnitDescriptor } from "@matter/storage"
import { JsonStorageBackend } from "../src/index.ts"
import { serializeRecord } from "../src/format.ts"

/** 与共享套件同形状，但显式声明 per-record 布局。 */
const DESCRIPTOR: KvUnitDescriptor = {
  name: "unit_a",
  version: 3,
  tables: ["alpha", "beta"],
  hasGlobal: true,
  layout: "per-record",
}

/** 建一个临时根 + 一个已打开的 unit。 */
async function freshUnit(descriptor: KvUnitDescriptor = DESCRIPTOR) {
  const root = await mkdtemp(join(tmpdir(), "matter-json-pr-"))
  const backend = new JsonStorageBackend(root)
  const unit = await backend.kv!.open(descriptor)
  return { root, backend, unit }
}

/** 读一个落盘文档的原文，用于断言「物理上确实是这个形态而不是内存里对」。 */
async function readRaw(path: string): Promise<string> {
  return readFile(path, "utf8")
}

describe("目录即真相（落盘形态）", () => {
  it("落盘形态是 <root>/<unit>/<table>/<key>.json，一条记录一个文件", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "ISS-1", { title: "one" })
    await unit.putRecord("alpha", "ISS-2", { title: "two" })
    await unit.putRecord("beta", "k1", { n: 1 })
    await unit.setGlobal({ counter: 7 })

    const alphaFiles = await readdir(join(root, "unit_a", "alpha"))
    expect(alphaFiles.sort()).toEqual(["ISS-1.json", "ISS-2.json"])
    expect((await readdir(join(root, "unit_a", "beta"))).sort()).toEqual(["k1.json"])
    // global 槽是 unit 目录下的 global.json，不在任何表目录里。
    expect((await readdir(join(root, "unit_a"))).sort()).toEqual(["alpha", "beta", "global.json"])
    await backend.close()
  })

  it("落盘文档形状是 {version, record}，version 即 descriptor.version", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "k", { n: 1 })
    const raw = JSON.parse(await readRaw(join(root, "unit_a", "alpha", "k.json")))
    expect(raw).toEqual({ version: 3, record: { n: 1 } })
    await backend.close()
  })

  it("无内存缓存：外部直接改盘后 loadAll 立刻看到新值", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "k", { n: 1 })
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ k: { n: 1 } })

    // 绕过本实现直接写盘 —— 若有任何缓存，下面这条断言会读到旧值。
    const path = join(root, "unit_a", "alpha", "k.json")
    await writeFile(path, serializeRecord(3, { n: 999 }), "utf8")
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ k: { n: 999 } })

    // 外部**新增**一条：缓存实现同样看不到。
    await writeFile(join(root, "unit_a", "alpha", "external.json"), serializeRecord(3, { via: "disk" }), "utf8")
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ k: { n: 999 }, external: { via: "disk" } })
    await backend.close()
  })

})

/** 版本守卫与坏文件容错：per-record「丢弃而非拒绝」的判据。 */
describe("容错（版本守卫与坏文件）", () => {
  it("版本守卫：手改落盘文件 version:99 ⇒ 该条读作不存在，且不抛", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "good", { n: 1 })
    await unit.putRecord("alpha", "stale", { n: 2 })
    // 手改：把 stale 的版本戳改成不接受的 99。
    const stalePath = join(root, "unit_a", "alpha", "stale.json")
    await writeFile(stalePath, `${JSON.stringify({ version: 99, record: { n: 2 } }, null, 2)}\n`, "utf8")

    // 不抛（若抛，这一行就红）。
    const snapshot = await unit.loadAll()
    // 该条读作不存在，其余正常。
    expect(snapshot.tables["alpha"]).toEqual({ good: { n: 1 } })
    // 且文档**没有被冲掉或迁移**：字节仍在盘上，只是不可读。
    expect(JSON.parse(await readRaw(stalePath))).toEqual({ version: 99, record: { n: 2 } })
    await backend.close()
  })

  it("版本守卫：compatibleVersions 里的旧版本戳照常读得到", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "k", { n: 1 })
    await backend.close()
    const path = join(root, "unit_a", "alpha", "k.json")
    await writeFile(path, serializeRecord(2, { n: 1 }), "utf8")

    // version 3 声明 2 兼容 ⇒ 读得到。
    const compat = new JsonStorageBackend(root)
    const unitCompat = await compat.kv!.open({ ...DESCRIPTOR, compatibleVersions: [2] })
    expect((await unitCompat.loadAll()).tables["alpha"]).toEqual({ k: { n: 1 } })
    await compat.close()

    // 不声明兼容 ⇒ 同一条读作不存在。这是「同一份字节、唯一变量是声明」的对照。
    const strict = new JsonStorageBackend(root)
    const unitStrict = await strict.kv!.open(DESCRIPTOR)
    expect((await unitStrict.loadAll()).tables["alpha"]).toEqual({})
    await strict.close()
  })

  it("坏文件：手写 {} 到某 <key>.json ⇒ 该条读作不存在，其余正常", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "good", { n: 1 })
    await unit.putRecord("alpha", "broken", { n: 2 })
    // 手写：非法 JSON。
    await writeFile(join(root, "unit_a", "alpha", "broken.json"), "{}", "utf8")
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ good: { n: 1 } })

    // 再试真正的语法损坏（连 JSON 都不是）—— 同样读作不存在，不抛。
    await writeFile(join(root, "unit_a", "alpha", "broken.json"), "not json at all", "utf8")
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ good: { n: 1 } })
    await backend.close()
  })

  it("坏文件：global.json 坏掉 ⇒ global 读作 null，表不受影响", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "k", { n: 1 })
    await unit.setGlobal({ counter: 7 })
    await writeFile(join(root, "unit_a", "global.json"), "{}", "utf8")
    const snapshot = await unit.loadAll()
    expect(snapshot.global).toBeNull()
    expect(snapshot.tables["alpha"]).toEqual({ k: { n: 1 } })
    await backend.close()
  })

})

/** 写入侧守卫：路径安全、原子写留痕、批量删暂存、备份移出可读集。 */
describe("写入侧（key 安全 · 原子写 · 批量删 · 备份）", () => {
  it("非法 key：写前拒绝，且盘上不留任何痕迹", async () => {
    const { root, backend, unit } = await freshUnit()
    // 每个都是能逃出根目录或以非安全字符做路径段的形态。
    for (const key of ["../evil", "a/b", ".", "..", "with space", "semi;colon", ""]) {
      await expect(unit.putRecord("alpha", key, {})).rejects.toThrow(/not path-safe/)
    }
    // 「写前」的判据：表目录**根本没被创建**（若先 mkdir 再校验，这里会有一个空目录）。
    await expect(readdir(join(root, "unit_a", "alpha"))).rejects.toMatchObject({ code: "ENOENT" })
    await backend.close()
  })

  it("非法 key：deleteRecord / backupRecord 同样写前拒绝", async () => {
    const { backend, unit } = await freshUnit()
    await expect(unit.deleteRecord("alpha", "../evil")).rejects.toThrow(/not path-safe/)
    await expect(unit.deleteRecords("alpha", ["ok", "a/b"])).rejects.toThrow(/not path-safe/)
    await expect(unit.backupRecord!("alpha", "../evil")).rejects.toThrow(/not path-safe/)
    await backend.close()
  })

  it("原子写：序列化失败时临时文件被清、目标无半成品、旧值原样", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "k", { v: "old" })
    const dir = join(root, "unit_a", "alpha")

    const broken = {
      toJSON: () => {
        throw new Error("serialization failed")
      },
    }
    await expect(unit.putRecord("alpha", "k", broken)).rejects.toThrow("serialization failed")

    // ① 目标文件仍是旧值（没有半成品）
    expect(JSON.parse(await readRaw(join(dir, "k.json")))).toEqual({ version: 3, record: { v: "old" } })
    // ② 目录里只有 k.json —— 没有 .tmp 残渣
    expect((await readdir(dir)).sort()).toEqual(["k.json"])
    await backend.close()
  })

  it("批量删：rename 到 *.deleting 后 unlink，盘上无残渣", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "k1", { n: 1 })
    await unit.putRecord("alpha", "k2", { n: 2 })
    await unit.putRecord("alpha", "k3", { n: 3 })
    await unit.deleteRecords("alpha", ["k1", "k3"])
    expect((await readdir(join(root, "unit_a", "alpha"))).sort()).toEqual(["k2.json"])
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ k2: { n: 2 } })
    await backend.close()
  })

  it("批量删：缺失的 key 与空批都是 no-op，不建表目录", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.deleteRecords("alpha", [])
    await unit.deleteRecords("beta", ["never-existed"])
    // 「不物化」的判据：no-op 不该留下空目录。
    await expect(readdir(join(root, "unit_a", "beta"))).rejects.toMatchObject({ code: "ENOENT" })
    await backend.close()
  })

  it("backupRecord 把文档移出可读集但保留字节", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "k", { v: 1 })
    const moved = await unit.backupRecord!("alpha", "k")
    // 移到的位置不再以 .json 结尾 ⇒ 读不到
    expect(moved.endsWith(".json")).toBe(false)
    expect(JSON.parse(await readRaw(moved))).toEqual({ version: 3, record: { v: 1 } })
    expect((await unit.loadAll()).tables["alpha"]).toEqual({})
    // 之后 putRecord 会重新建出来
    await unit.putRecord("alpha", "k", { v: 2 })
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ k: { v: 2 } })
    await backend.close()
  })
})

describe("描述符与生命周期守卫", () => {
  it("unit 名与表名必须是 UNIT_NAME_RE 形态", async () => {
    const root = await mkdtemp(join(tmpdir(), "matter-json-pr-"))
    const backend = new JsonStorageBackend(root)
    // 连字符过 SAFE_KEY_RE 但过不了 UNIT_NAME_RE。
    await expect(backend.kv!.open({ ...DESCRIPTOR, name: "pm-issue" })).rejects.toMatchObject({
      code: "malformed-medium",
    })
    await expect(backend.kv!.open({ ...DESCRIPTOR, tables: ["pm-issue"] })).rejects.toMatchObject({
      code: "malformed-medium",
    })
    await backend.close()
  })

  it("同一 unit 重复 open 拒绝（调用方 bug）", async () => {
    const { backend, unit } = await freshUnit()
    await expect(backend.kv!.open(DESCRIPTOR)).rejects.toThrow(/already open/)
    await backend.close()
    await unit.close()
  })

  it("未声明的表是调用方 bug，抛错而不是静默丢弃", async () => {
    const { backend, unit } = await freshUnit()
    await expect(unit.putRecord("undeclared", "k", {})).rejects.toThrow(/does not declare table/)
    await backend.close()
  })

  it("未声明 hasGlobal 时 setGlobal 拒绝", async () => {
    const { backend } = await freshUnit()
    const noGlobal = new JsonStorageBackend(await mkdtemp(join(tmpdir(), "matter-json-pr-")))
    const u = await noGlobal.kv!.open({ ...DESCRIPTOR, name: "unit_b", hasGlobal: false })
    await expect(u.setGlobal({})).rejects.toThrow(/does not declare a global slot/)
    await noGlobal.close()
    await backend.close()
  })

  it("backend 关闭后 open 拒绝 closed", async () => {
    const { backend } = await freshUnit()
    await backend.close()
    await expect(backend.kv!.open(DESCRIPTOR)).rejects.toMatchObject({ code: "closed" })
  })

  it("未物化的 unit 打开时 loadAll 立刻给出空形状", async () => {
    const root = await mkdtemp(join(tmpdir(), "matter-json-pr-"))
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv!.open(DESCRIPTOR)
    expect(await unit.loadAll()).toEqual({ tables: { alpha: {}, beta: {} }, global: null })
    // 打开本身不物化介质（物化推迟到首次写入）
    expect(await readdir(root)).toEqual([])
    await backend.close()
  })
})

describe("目录结构（任务书验收表那一条）", () => {
  it("树形断言：<root>/<unit>/<table>/<key>.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "matter-json-pr-"))
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv!.open({ ...DESCRIPTOR, name: "pm_issue" })
    await unit.putRecord("alpha", "ISS-1", { title: "x" })
    await unit.setGlobal({ counter: 1 })

    // 逐层断言，不用「像不像」的描述。
    expect((await readdir(root)).sort()).toEqual(["pm_issue"])
    expect((await readdir(join(root, "pm_issue"))).sort()).toEqual(["alpha", "global.json"])
    expect((await readdir(join(root, "pm_issue", "alpha"))).sort()).toEqual(["ISS-1.json"])
    await backend.close()
  })
})

/** ISS-523 / C-0b：目录读取与批量删的错误分支（都有行为，不是死代码）。 */
describe("介质异常与批量删还原（C-0b 补测）", () => {
  it("unit 目录被普通文件占据 ⇒ readdir 的 ENOTDIR 原样抛出，不伪装成空 unit", async () => {
    const root = await mkdtemp(join(tmpdir(), "matter-json-pr-"))
    const backend = new JsonStorageBackend(root)
    const unit = await backend.kv!.open(DESCRIPTOR)
    // 只有 ENOENT 才当空 unit；ENOTDIR 是真介质故障，必须暴露。
    await writeFile(join(root, "unit_a"), "not a directory", "utf8")
    await expect(unit.loadAll()).rejects.toMatchObject({ code: "ENOTDIR" })
    await backend.close()
  })

  it("表目录里文件名不安全（bad.key）的文档被跳过，安全键照常读入", async () => {
    const { root, backend, unit } = await freshUnit()
    const table = join(root, "unit_a", "alpha")
    await mkdir(table, { recursive: true })
    await writeFile(join(table, "bad.key.json"), serializeRecord(3, { n: 1 }), "utf8")
    await writeFile(join(table, "ok.json"), serializeRecord(3, { n: 2 }), "utf8")
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ ok: { n: 2 } })
    await backend.close()
  })

  it("记录文档读不了（目录冒充 .json）⇒ 该条读作不存在，其余照常", async () => {
    const { root, backend, unit } = await freshUnit()
    const table = join(root, "unit_a", "alpha")
    await mkdir(table, { recursive: true })
    await mkdir(join(table, "ghost.json"))
    await writeFile(join(table, "ok.json"), serializeRecord(3, { n: 1 }), "utf8")
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ ok: { n: 1 } })
    await backend.close()
  })

  it("批量删中途失败 ⇒ 已暂存的文档被还原，抛原始错误，unit 仍可用", async () => {
    const { backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "good", { n: 1 })
    // 300 字符的单一路径段超过 NAME_MAX：rename 抛 ENAMETOOLONG（非 ENOENT）。
    const tooLong = "A".repeat(300)
    await expect(unit.deleteRecords("alpha", ["good", tooLong])).rejects.toThrow()
    // 还原成功 ⇒ 没有置 unusable，记录仍可读。
    expect((await unit.loadAll()).tables["alpha"]).toEqual({ good: { n: 1 } })
    await backend.close()
  })

  it("unit 目录下未声明表的目录、非 global 的散文件都被忽略", async () => {
    const { root, backend, unit } = await freshUnit()
    await mkdir(join(root, "unit_a", "extras"), { recursive: true })
    await writeFile(join(root, "unit_a", "extras", "x.json"), serializeRecord(3, { n: 1 }), "utf8")
    await writeFile(join(root, "unit_a", "notes.txt"), "stray", "utf8")
    // 两者都不属于声明的表/global 槽，loadAll 的形状不受影响。
    expect(await unit.loadAll()).toEqual({ tables: { alpha: {}, beta: {} }, global: null })
    await backend.close()
  })

  it("批量删首个 rename 就失败（空暂存）⇒ 直接抛原始介质错误", async () => {
    const { root, backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "k", { n: 1 })
    const table = join(root, "unit_a", "alpha")
    await rm(table, { recursive: true, force: true })
    await writeFile(table, "not a directory", "utf8")
    await expect(unit.deleteRecords("alpha", ["k"])).rejects.toMatchObject({ code: "ENOTDIR" })
    await backend.close()
  })

  it("unit 处于 unknown-state 时每次操作都拒绝（隔离语义）", async () => {
    const { backend, unit } = await freshUnit()
    await unit.putRecord("alpha", "k", { n: 1 })
    // 白盒注入：unknown-state 只能由「还原失败」这一双重 IO 故障置位，单测直接置位验隔离面。
    const { StorageError } = await import("@matter/storage")
    ;(unit as unknown as { unusable: unknown }).unusable = new StorageError("unknown-state", "injected")
    await expect(unit.loadAll()).rejects.toMatchObject({ code: "unknown-state" })
    await expect(unit.putRecord("alpha", "k2", {})).rejects.toMatchObject({ code: "unknown-state" })
    // 但 close 必须仍可释放，否则会泄漏句柄。
    await expect(backend.close()).resolves.toBeUndefined()
  })
})
