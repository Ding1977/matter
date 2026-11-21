// @vitest-environment jsdom
/**
 * ui-pm 两视图与持久化闭环验收（ISS-541 / Q4 三判据）。
 *
 * 三判据逐条落断言：
 *  ① 建视图 —— deriveColumns / withType 产出可装配的两态配置，两态 DOM 各渲染正确形态；
 *  ② 切换形态 —— 同 rows/view 在 type=list⇄table 下根 data-ui-pm 切换（IssueView DOM 两态断言）；
 *  ③ 持久化 —— withType → ViewConfigStore.upsert → 防抖整组写 → flush → reload 回读一致。
 * 三态语义（空态/损坏）沿用 2306 store，本包通过真 Store 再验一次回读。
 *
 * 其余用例把 contract/list/table/apply 新增文件每条分支走满（本包 coverage 阈值 100）。
 *
 * @module @matter/client-ui-pm/tests/views
 */

import { createElement } from "react"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { minimalView, ViewConfigStore, type ViewConfig } from "@matter/issue"
import {
  deriveColumns, groupRows, ISSUE_FIELDS, IssueList, IssueTable, IssueView,
  orderRows, resolveMessages, shapeOf, withType,
  type IssueRow,
} from "../src/client/index.ts"

/** 三行 issue（status 各不同；ISS-2 空标题覆盖占位；priority 各异覆盖排序/列头）。 */
const ROWS: readonly IssueRow[] = [
  { id: "ISS-1", title: "低优先", status: "todo", priority: "low" },
  { id: "ISS-2", title: "", status: "in_progress", priority: "high" },
  { id: "ISS-3", title: "中优先", status: "done", priority: "medium" },
]

/** list 形态视图（无 sort/group）。 */
function listView(): ViewConfig {
  return minimalView("v", "行式视图")
}

/** table 形态视图（sort/group/filter 齐全，证明配置真驱动渲染）。 */
function tableView(): ViewConfig {
  return {
    ...minimalView("v", "列式视图"),
    type: "table",
    sort: [{ field: "priority", dir: "desc" }],
    group: [{ field: "status" }],
    filter: { logic: "and", conditions: [{ field: "status", op: "eq", value: "in_progress" }] },
  }
}

/** 可变内存 KV：setGlobal 更新 global 并计写次数，供回读闭环断言。 */
function fakeKv(initial: ViewConfig[] | null) {
  let global: unknown = initial
  let writes = 0
  return {
    unit: {
      loadAll: async () => ({ tables: {}, global }),
      putRecord: async () => {},
      deleteRecord: async () => {},
      deleteRecords: async () => {},
      setGlobal: async (value: unknown) => { global = value; writes += 1 },
      close: async () => {},
    },
    writes: () => writes,
  }
}

describe("contract：两态共用纯函数", () => {
  it("deriveColumns 从字段 meta 派生列集（全部已声明字段、有序、新数组）", () => {
    const cols = deriveColumns(tableView())
    expect(cols).toEqual(ISSUE_FIELDS)
    expect(cols).not.toBe(ISSUE_FIELDS)
  })

  it("groupRows 无分组规则 → 单组含全部行（key 空串）", () => {
    const groups = groupRows(ROWS, listView())
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe("")
    expect(groups[0].rows).toHaveLength(3)
  })

  it("groupRows 按 group.field 分组；同键行合并进一桶、无键行独立桶", () => {
    const view: ViewConfig = { ...listView(), group: [{ field: "status" }] }
    const withDup: readonly IssueRow[] = [
      ROWS[0], { ...ROWS[0], id: "ISS-1b", title: "重复状态" }, ROWS[2],
    ]
    const groups = groupRows(withDup, view)
    expect(groups.map((g) => g.key)).toEqual(["todo", "done"])
    expect(groups[0].rows.map((r) => r.id)).toEqual(["ISS-1", "ISS-1b"]) // existing bucket 分支
    expect(groups[1].rows.map((r) => r.id)).toEqual(["ISS-3"])             // new bucket 分支
  })

  it("withType 产出 type 变更的新配置，不改入参、其余字段保留", () => {
    const before = tableView()
    const after = withType(before, "list")
    expect(after.type).toBe("list")
    expect(after.id).toBe(before.id)
    expect(after.sort).toEqual(before.sort)
    expect(before.type).toBe("table") // 入参未变
  })

  it("shapeOf：list 走行式，其余形态走列式", () => {
    expect(shapeOf(listView())).toBe("list")
    for (const type of ["table", "board", "timeline", "card", "calendar"] as const) {
      expect(shapeOf({ ...listView(), type })).toBe("table")
    }
  })

  it("orderRows：无 sort 保持顺序；desc/asc 两向（不改入参）", () => {
    expect(orderRows(ROWS, listView()).map((r) => r.id)).toEqual(["ISS-1", "ISS-2", "ISS-3"])
    const desc: ViewConfig = { ...listView(), sort: [{ field: "priority", dir: "desc" }] }
    const asc: ViewConfig = { ...listView(), sort: [{ field: "priority", dir: "asc" }] }
    expect(orderRows(ROWS, desc).map((r) => r.id)).toEqual(["ISS-3", "ISS-1", "ISS-2"])
    expect(orderRows(ROWS, asc).map((r) => r.id)).toEqual(["ISS-2", "ISS-1", "ISS-3"])
    expect(ROWS[0].id).toBe("ISS-1")
  })
})

describe("Q4 判据①：建视图 + 两态 DOM", () => {
  it("list 态：分组头 + 排序指示 + 行密度 + 标题占位（配置真驱动）", () => {
    const view: ViewConfig = {
      ...tableView(),
      type: "list",
      sort: [{ field: "priority", dir: "asc" }],
    }
    const dom = render(createElement(IssueList, {
      rows: ROWS, view, messages: resolveMessages(), density: "compact",
    }))
    const root = dom.container.querySelector("[data-ui-pm='list']")!
    expect(root.getAttribute("data-view-type")).toBe("list")
    expect(root.getAttribute("data-group-by")).toBe("status")
    expect(root.getAttribute("data-density")).toBe("compact")
    const ind = dom.container.querySelector("[data-ui-pm='sort-indicator']")!
    expect(ind.getAttribute("data-sort-field")).toBe("priority")
    expect(ind.getAttribute("data-sort-dir")).toBe("asc")
    expect(ind.textContent).toContain("↑")
    expect(dom.container.querySelectorAll("[data-ui-pm='group-header']")).toHaveLength(3)
    expect(dom.container.textContent).toContain(resolveMessages().untitled) // 空标题
  })

  it("list 态：默认密度 normal；无 sort 不渲染指示；空标题分组键回落占位", () => {
    const view: ViewConfig = { ...listView(), group: [{ field: "title" }] }
    const dom = render(createElement(IssueList, {
      rows: ROWS, view, messages: resolveMessages(),
    }))
    expect(dom.container.querySelector("[data-ui-pm='list']")!.getAttribute("data-density")).toBe("normal")
    expect(dom.container.querySelector("[data-ui-pm='sort-indicator']")).toBeNull()
    const emptyKeyHeader = [...dom.container.querySelectorAll("[data-ui-pm='group-header']")]
      .find((n) => n.getAttribute("data-group-key") === "")
    expect(emptyKeyHeader!.textContent).toBe(resolveMessages().untitled)
  })

  it("list 态：desc 指示用下箭头；空行渲染 emptyHint", () => {
    const desc: ViewConfig = { ...listView(), sort: [{ field: "priority", dir: "desc" }] }
    const dom = render(createElement(IssueList, {
      rows: ROWS, view: desc, messages: resolveMessages(),
    }))
    expect(dom.container.querySelector("[data-ui-pm='sort-indicator']")!.textContent).toContain("↓")
    const empty = render(createElement(IssueList, {
      rows: [], view: listView(), messages: resolveMessages(),
    }))
    expect(empty.container.querySelector("[data-ui-pm='empty']")!.textContent).toBe("暂无事项")
  })

  it("table 态：列头由字段 meta 派生、单元格对齐列、排序列标记、空标题占位", () => {
    const dom = render(createElement(IssueTable, {
      rows: ROWS, view: tableView(), messages: resolveMessages(),
    }))
    const root = dom.container.querySelector("[data-ui-pm='table']")!
    expect(root.getAttribute("data-view-type")).toBe("table")
    expect(root.getAttribute("data-column-count")).toBe(String(ISSUE_FIELDS.length))
    const heads = [...dom.container.querySelectorAll("th")].map((n) => n.getAttribute("data-column"))
    expect(heads).toEqual([...ISSUE_FIELDS])
    expect(dom.container.querySelector("th[data-column='priority']")!.getAttribute("data-sort-dir")).toBe("desc")
    expect(dom.container.querySelector("th[data-column='id']")!.getAttribute("data-sort-dir")).toBeNull()
    const cells = [...dom.container.querySelectorAll("tr[data-issue-id='ISS-2'] td")]
      .map((n) => n.textContent)
    expect(cells).toContain(resolveMessages().untitled) // title 空 → 占位分支
    expect(cells).toContain("ISS-2")                     // 非 title 字段原值
  })

  it("table 态：无 sort 不标记列头；空行渲染 emptyHint", () => {
    const dom = render(createElement(IssueTable, {
      rows: ROWS, view: listView(), messages: resolveMessages(),
    }))
    expect(dom.container.querySelector("th[data-sort-field]")).toBeNull()
    const empty = render(createElement(IssueTable, {
      rows: [], view: tableView(), messages: resolveMessages(),
    }))
    expect(empty.container.querySelector("[data-ui-pm='empty']")!.textContent).toBe("暂无事项")
  })

  it("locale：列头文案走字典（含自定义 translator）", () => {
    const m = resolveMessages()
    expect(m.columns.id).toBe("编号")
    expect(m.columns.title).toBe("标题")
    expect(resolveMessages((s) => s.toUpperCase()).columns.status).toBe("状态") // 恒等中文，大写不变
  })
})

describe("Q4 判据②：切换形态（DOM 两态断言）", () => {
  it("同 rows/view 在 type=list⇄table 下根 data-ui-pm 切换", () => {
    const base = listView()
    const listDom = render(createElement(IssueView, {
      rows: ROWS, view: base, messages: resolveMessages(),
    }))
    expect(listDom.container.querySelector("[data-ui-pm='list']")).not.toBeNull()
    expect(listDom.container.querySelector("[data-ui-pm='table']")).toBeNull()

    const switched = withType(base, "table")
    const tableDom = render(createElement(IssueView, {
      rows: ROWS, view: switched, messages: resolveMessages(),
    }))
    expect(tableDom.container.querySelector("[data-ui-pm='table']")).not.toBeNull()
    expect(tableDom.container.querySelector("[data-ui-pm='list']")).toBeNull()
    expect(tableDom.container.querySelectorAll("th")).toHaveLength(ISSUE_FIELDS.length)
  })

  it("IssueView 把 density 透传给 list；其余 VIEW_TYPES 归列式", () => {
    const listDom = render(createElement(IssueView, {
      rows: ROWS, view: listView(), messages: resolveMessages(), density: "compact",
    }))
    expect(listDom.container.querySelector("[data-ui-pm='list']")!.getAttribute("data-density")).toBe("compact")
    const board = render(createElement(IssueView, {
      rows: ROWS, view: { ...listView(), type: "board" }, messages: resolveMessages(),
    }))
    expect(board.container.querySelector("[data-ui-pm='table']")).not.toBeNull()
  })
})

describe("Q4 判据③：持久化回读闭环（真 ViewConfigStore）", () => {
  it("切换写回 → 防抖整组写 → flush → reload 回读一致，且驱动 table DOM", async () => {
    const kv = fakeKv([listView()])
    const store = new ViewConfigStore(kv.unit as never, 10)
    await store.reload()
    const before = store.get("v")!
    expect(before.type).toBe("list")

    // 切换动作：withType 产出新配置 → upsert 写回（防抖在途）
    const switched = withType(before, "table")
    store.upsert(switched)
    expect(store.hasPending).toBe(true)
    expect(store.get("v")!.type).toBe("table") // 内存权威态已更新，盘上未写

    // flush 立即整组落盘；重新加载回读一致
    await store.flush()
    const reread = new ViewConfigStore(kv.unit as never, 0)
    await reread.reload()
    const after = reread.get("v")!
    expect(after.type).toBe("table")
    expect(after.id).toBe(before.id)
    expect(after.sort).toEqual(before.sort)
    expect(kv.writes()).toBe(1)

    // 回读的配置真驱动 table 形态 DOM（闭环末端）
    const dom = render(createElement(IssueView, {
      rows: ROWS, view: after, messages: resolveMessages(),
    }))
    expect(dom.container.querySelector("[data-ui-pm='table']")).not.toBeNull()
    await store.close()
    await reread.close()
  })

  it("防抖窗口内多次切换合并成一次整组写", async () => {
    const kv = fakeKv([listView()])
    const store = new ViewConfigStore(kv.unit as never, 30)
    await store.reload()
    const base = store.get("v")!
    store.upsert(withType(base, "table"))
    store.upsert(withType(base, "board"))
    store.upsert(withType(base, "table"))
    expect(kv.writes()).toBe(0) // 窗口内还没落盘
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(kv.writes()).toBe(1) // 三次 upsert 合并成一次 setGlobal
    expect(store.get("v")!.type).toBe("table") // 最后一次为准
    await store.close()
  })

  it("三态沿用：文件缺失（global=null）回读空态；损坏值 reload 原样抛", async () => {
    const missing = fakeKv(null)
    const s1 = new ViewConfigStore(missing.unit as never, 0)
    await s1.reload()
    expect(s1.list()).toEqual([])
    await s1.close()

    const corrupt = fakeKv([{ id: "v" }] as never)
    const s2 = new ViewConfigStore(corrupt.unit as never, 0)
    await expect(s2.reload()).rejects.toThrow()
  })
})
