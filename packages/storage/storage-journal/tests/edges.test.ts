/**
 * 边表：**派生物**的投影语义与可重建性。
 *
 * 三条判据：① 边只从 `relations` / `parent` / `blocked_by` 三个字段来（别的字段不进边表）；
 * ② 同一字段后来者覆盖先者 ⇒ 改成空数组就是删边；③ 丢掉边表能从真相源原样重建。
 *
 * 每条都会先造一个**必须能红**的形态：投影规则改了、last-write-wins 改成 first-write-wins、
 * `rebuild` 漏了 `DELETE FROM edges`，都会有一条测试红。
 *
 * @module @matter/storage-journal/tests/edges
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openJournalFacility } from "../src/index.ts"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** 打开一个临时库并登记清理。 */
async function openTemp(): Promise<Awaited<ReturnType<typeof openJournalFacility>>> {
  const root = await mkdtemp(join(tmpdir(), "matter-journal-edges-"))
  const facility = await openJournalFacility(root)
  cleanups.push(() => facility.close())
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return facility
}

describe("投影：三个字段 → 边", () => {
  it("relations 的 `kind|dst` 拆成两段", async () => {
    const facility = await openTemp()
    facility.append({
      entity: "issues/ISS-1.md",
      event: "issue-created",
      relations: ["references|ISS-501", "blocks|ISS-9"],
    })
    facility.rebuild()
    const edges = facility.edges("issues/ISS-1.md")
    expect(edges.map((edge) => [edge.kind, edge.dst])).toEqual([
      ["blocks", "ISS-9"],
      ["references", "ISS-501"],
    ])
  })

  it("relations 项没有 `|` 时缺省 kind 是 references", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["ISS-7"] })
    facility.rebuild()
    expect(facility.edges("issues/a.md")).toEqual([
      { src: "issues/a.md", kind: "references", dst: "ISS-7", seq: 1 },
    ])
  })

  it("parent 是标量边（kind = parent）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/child.md", event: "issue-created", parent: "ISS-100" })
    facility.rebuild()
    expect(facility.edges("issues/child.md", "parent")).toEqual([
      { src: "issues/child.md", kind: "parent", dst: "ISS-100", seq: 1 },
    ])
  })

  it("blocked_by 是数组边（kind = blocked_by）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-queued", blocked_by: ["ISS-1", "ISS-2"] })
    facility.rebuild()
    expect(facility.edges("issues/a.md", "blocked_by").map((edge) => edge.dst)).toEqual(["ISS-1", "ISS-2"])
  })

  it("**别的字段不进边表**（project / subtasks 该不该进是没拍的问题，本包不替它拍）", async () => {
    const facility = await openTemp()
    facility.append({
      entity: "issues/a.md",
      event: "issue-created",
      project: "PRJ-1",
      subtasks: ["ISS-2"],
      milestones: ["M1"],
    })
    facility.rebuild()
    expect(facility.edges("issues/a.md")).toEqual([])
  })

  it("只收 payload 里真有的字段（缺席不是「到 undefined 的边」）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-noted", body: "只写备注" })
    facility.rebuild()
    expect(facility.edges("issues/a.md")).toEqual([])
  })
})

describe("last-write-wins：后者覆盖前者，空数组就是删边", () => {
  it("relations 第二次覆盖第一次（不累积）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["references|ISS-1"] })
    facility.append({ entity: "issues/a.md", event: "field-change", field: "relations", from: ["references|ISS-1"], to: ["references|ISS-2"] })
    facility.rebuild()
    expect(facility.edges("issues/a.md").map((edge) => edge.dst)).toEqual(["ISS-2"])
  })

  it("改成空数组 = 删边（这是「现态」不是「历史」的机器形态）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["references|ISS-1"] })
    facility.append({ entity: "issues/a.md", event: "field-change", field: "relations", from: ["references|ISS-1"], to: [] })
    facility.rebuild()
    expect(facility.edges("issues/a.md")).toEqual([])
  })

  it("parent 可以移到另一个父单", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/c.md", event: "issue-created", parent: "ISS-1" })
    facility.append({ entity: "issues/c.md", event: "field-change", field: "parent", from: "ISS-1", to: "ISS-2" })
    facility.rebuild()
    expect(facility.edges("issues/c.md", "parent").map((edge) => edge.dst)).toEqual(["ISS-2"])
  })

  it("field-change 只作用于它写明的那个 field（不能把 parent 变更投射成 relations 变更）", async () => {
    const facility = await openTemp()
    facility.append({
      entity: "issues/a.md",
      event: "issue-created",
      relations: ["references|ISS-1"],
      parent: "ISS-9",
    })
    facility.append({ entity: "issues/a.md", event: "field-change", field: "parent", from: "ISS-9", to: "ISS-10" })
    facility.rebuild()
    expect(facility.edges("issues/a.md").map((edge) => `${edge.kind}:${edge.dst}`)).toEqual([
      "parent:ISS-10",
      "references:ISS-1",
    ])
  })

  it("seq 记的是最后一次写明的那条事件（能追回是哪条）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["references|ISS-1"] })
    facility.append({ entity: "issues/a.md", event: "field-change", field: "relations", to: ["references|ISS-5"] })
    facility.rebuild()
    expect(facility.edges("issues/a.md")[0]!.seq).toBe(2)
  })

  it("**同一个 (src,kind,dst) 由两个字段各自投出**时取 seq 更大的那条", async () => {
    // relations 里写 `blocked_by|ISS-1` 与 blocked_by 字段写 `[ISS-1]` 会投出**同一个三元组**
    // （kind=blocked_by, dst=ISS-1）。两条来源的 seq 不同 ⇒ materialize 的 byKey 必须取大者。
    // ⭐ 变异实测：把 `prior.seq < edge.seq` 改成只在 undefined 时写入 ⇒ 这条红。
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["blocked_by|ISS-1"] })
    facility.append({ entity: "issues/a.md", event: "issue-noted", blocked_by: ["ISS-1"] })
    facility.rebuild()
    const edges = facility.edges("issues/a.md", "blocked_by")
    expect(edges).toHaveLength(1)
    // seq=2 是后来那条（blocked_by 字段），比 relations 投出的 seq=1 新
    expect(edges[0]!.seq).toBe(2)
  })

  it("同一条边被两条事件写两次只留一行（PRIMARY KEY 去重）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["references|ISS-1"] })
    facility.append({ entity: "issues/a.md", event: "issue-noted", relations: ["references|ISS-1"], body: "再说一次" })
    facility.rebuild()
    expect(facility.stats().edges).toBe(1)
  })
})

describe("反向入口与查询过滤", () => {
  it("inboundEdges 拿到「谁指向我」（旧树 _inboundMapFor 的替代）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["references|ISS-7"] })
    facility.append({ entity: "issues/b.md", event: "issue-created", blocked_by: ["ISS-7"] })
    facility.rebuild()
    // 排序口径 = `ORDER BY kind, src`（确定性排序，不看插入顺序）
    expect(facility.inboundEdges("ISS-7").map((edge) => [edge.src, edge.kind])).toEqual([
      ["issues/b.md", "blocked_by"],
      ["issues/a.md", "references"],
    ])
  })

  it("inboundEdges 按 kind 收窄", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["references|ISS-7"] })
    facility.append({ entity: "issues/b.md", event: "issue-created", blocked_by: ["ISS-7"] })
    facility.rebuild()
    expect(facility.inboundEdges("ISS-7", "blocked_by").map((edge) => edge.src)).toEqual(["issues/b.md"])
  })

  it("没有边的实体回空数组（不是 undefined / 不是抛）", async () => {
    const facility = await openTemp()
    facility.rebuild()
    expect(facility.edges("issues/nothing.md")).toEqual([])
    expect(facility.inboundEdges("ISS-404")).toEqual([])
  })
})

describe("边表可重建", () => {
  it("丢掉边表后 rebuild 回到同一组边（resetDerived 覆盖 edges 也覆盖 pm_search）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["references|ISS-1"], parent: "ISS-9" })
    facility.append({ entity: "issues/b.md", event: "issue-created", blocked_by: ["ISS-1"] })
    facility.rebuild()
    const before = facility.stats().edges
    expect(before).toBe(3)

    facility.resetDerived()
    expect(facility.stats().edges).toBe(0)
    expect(facility.edges("issues/a.md")).toEqual([])

    expect(facility.rebuild().edges).toBe(before)
    expect(facility.stats().edges).toBe(before)
  })

  it("重建两次边数不翻倍（rebuild 里有 DELETE，漏了会红在这条）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["references|ISS-1"] })
    expect(facility.rebuild().edges).toBe(1)
    expect(facility.rebuild().edges).toBe(1)
    expect(facility.stats().edges).toBe(1)
  })

  it("边表不参与 schemaVersion（无独立版本轴）", async () => {
    const facility = await openTemp()
    facility.append({ entity: "issues/a.md", event: "issue-created", relations: ["references|ISS-1"] })
    const before = facility.identity().schemaVersion
    facility.rebuild()
    facility.resetDerived()
    facility.rebuild()
    expect(facility.identity().schemaVersion).toBe(before)
  })
})
