// @vitest-environment jsdom
/**
 * ui-pm 骨架真接线验收（ISS-540）。
 *
 * 灵魂断言：在假 KV unit 上开**真 ViewConfigStore**，读出一份 ViewConfig，
 * 连同注入的 issue rows 渲染 IssueList ⇒ DOM 真实带上该配置与行（不是纯函数得分）。
 * 其余用例把四个源文件每条分支走满（本包 coverage 阈值 100）。
 *
 * @module @matter/client-ui-pm/tests/skeleton
 */

import { createElement } from "react"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { minimalView, ViewConfigStore, type ViewConfig } from "@matter/issue"
import {
  IssueDetail,
  IssueList,
  firstField,
  identityTranslator,
  orderRows,
  resolveMessages,
  rowField,
  type IssueRow,
} from "../src/client/index.ts"
import * as hostEntry from "../src/index.ts"

/** 三行 issue（priority 各不同，用于排序断言；含一条空标题覆盖 untitled 占位）。 */
const ROWS: readonly IssueRow[] = [
  { id: "ISS-1", title: "低优先", status: "todo", priority: "low" },
  { id: "ISS-2", title: "", status: "in_progress", priority: "high" },
  { id: "ISS-3", title: "中优先", status: "done", priority: "medium" },
]

/** 一份非默认视图配置（type=table + sort/group/filter 齐全，证明配置真驱动渲染）。 */
function tableView(): ViewConfig {
  return {
    ...minimalView("v-skeleton", "骨架视图"),
    type: "table",
    sort: [{ field: "priority", dir: "desc" }],
    group: [{ field: "status" }],
    filter: { logic: "and", conditions: [{ field: "status", op: "eq", value: "in_progress" }] },
  }
}

describe("ui-pm 契约与纯函数", () => {
  it("host 半空注册插件：可加载、不改 context", () => {
    const ctx = {} as never
    expect(hostEntry.name).toBe("client-ui-pm")
    expect(() => hostEntry.apply(ctx)).not.toThrow()
  })

  it("locale：默认恒等 + 自定义 translator + identityTranslator 直调", () => {
    const messages = resolveMessages()
    expect(messages.listTitle).toBe("事项列表")
    expect(identityTranslator("原文")).toBe("原文")
    const upper = resolveMessages((s) => s.toUpperCase())
    expect(upper.detailTitle).toBe("事项详情")
    expect(upper.untitled).toBe("无标题")
  })

  it("contract：rowField 四个已声明字段 + 未知字段回落空串", () => {
    expect(rowField(ROWS[0], "id")).toBe("ISS-1")
    expect(rowField(ROWS[0], "title")).toBe("低优先")
    expect(rowField(ROWS[0], "status")).toBe("todo")
    expect(rowField(ROWS[0], "priority")).toBe("low")
    expect(rowField(ROWS[0], "unknown")).toBe("")
  })

  it("contract：firstField 有规则取首条 field，无规则回落空串", () => {
    expect(firstField([{ field: "status" }, { field: "title" }])).toBe("status")
    expect(firstField([])).toBe("")
  })

  it("list：orderRows 无 sort 保持注入顺序；asc / desc 按首则字段排序，不改入参", () => {
    const noSort = minimalView("v", "V")
    expect(orderRows(ROWS, noSort).map((r) => r.id)).toEqual(["ISS-1", "ISS-2", "ISS-3"])

    const asc: ViewConfig = { ...noSort, sort: [{ field: "priority", dir: "asc" }] }
    expect(orderRows(ROWS, asc).map((r) => r.id)).toEqual(["ISS-2", "ISS-1", "ISS-3"])

    const desc: ViewConfig = { ...noSort, sort: [{ field: "priority", dir: "desc" }] }
    expect(orderRows(ROWS, desc).map((r) => r.id)).toEqual(["ISS-3", "ISS-1", "ISS-2"])
    expect(ROWS[0].id).toBe("ISS-1") // 入参未被就地修改
  })
})

describe("ui-pm 骨架 DOM 真接线", () => {
  it("灵魂：ViewConfigStore 读出的配置驱动列表 DOM（配置读到 + 行渲染出）", async () => {
    const view = tableView()
    const fake = {
      loadAll: async () => ({ tables: {}, global: [view] }),
      putRecord: async () => {},
      deleteRecord: async () => {},
      deleteRecords: async () => {},
      setGlobal: async () => {},
      close: async () => {},
    }
    const store = new ViewConfigStore(fake as never, 0)
    await store.reload()
    const read = store.get("v-skeleton")
    expect(read).toBeDefined()
    expect(read!.type).toBe("table")

    const dom = render(createElement(IssueList, {
      rows: ROWS,
      view: read!,
      messages: resolveMessages(),
    }))
    const root = dom.container.querySelector("[data-ui-pm='list']")!
    expect(root.getAttribute("data-view-type")).toBe("table")
    expect(root.getAttribute("data-group-by")).toBe("status")
    expect(root.getAttribute("data-filter-count")).toBe("1")
    expect(root.querySelector("h2")!.textContent).toBe("骨架视图")
    // 行按配置的 desc 排序渲染（localeCompare 降序：medium > low > high）。
    const ids = [...dom.container.querySelectorAll("[data-issue-id]")].map((n) => n.getAttribute("data-issue-id"))
    expect(ids).toEqual(["ISS-3", "ISS-1", "ISS-2"])
    expect(dom.container.textContent).toContain("低优先")
    expect(dom.container.textContent).toContain(resolveMessages().untitled) // 空标题走占位分支
    await store.close()
  })

  it("list：空行渲染 emptyHint；普通行渲染标题", () => {
    const empty = render(createElement(IssueList, {
      rows: [],
      view: minimalView("v", "空视图"),
      messages: resolveMessages(),
    }))
    expect(empty.container.querySelector("[data-ui-pm='empty']")!.textContent).toBe("暂无事项")

    const one = render(createElement(IssueList, {
      rows: [ROWS[0]],
      view: minimalView("v", "单行视图"),
      messages: resolveMessages(),
    }))
    expect(one.container.textContent).toContain("低优先")
  })

  it("detail：留位骨架渲染标题与 issue 锚点", () => {
    const dom = render(createElement(IssueDetail, {
      issueId: "ISS-42",
      messages: resolveMessages(),
    }))
    const root = dom.container.querySelector("[data-ui-pm='detail']")!
    expect(root.getAttribute("data-issue-id")).toBe("ISS-42")
    expect(root.querySelector("h2")!.textContent).toBe("事项详情")
  })
})
