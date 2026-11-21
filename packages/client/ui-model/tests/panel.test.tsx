// @vitest-environment jsdom
/**
 * ui-model 最小座席验收（ISS-543）。
 *
 * 灵魂断言：ctx 注入 stub 模型目录 → 两级面板真渲染（provider 分组 + 搜索框 + 模型行），
 * ↑↓ 回绕高亮、Enter 进详情、Escape/返回键退回——键盘导航是行为断言，不是纯函数得分。
 * 其余用例把四个源文件每条分支走满（本包 coverage 阈值 100）。
 *
 * @module @matter/client-ui-model/tests/panel
 */

import { createElement } from "react"
import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import {
  ModelSelect,
  filterGroups,
  identityTranslator,
  matchesQuery,
  moveHighlight,
  onPanelKeyDown,
  resolveMessages,
  stubDirectory,
  visibleModels,
} from "../src/client/index.ts"
import * as hostEntry from "../src/index.ts"

/** 取当前高亮行（data-highlighted 唯一）。 */
function highlighted(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-highlighted]")
}

/** 取搜索框。 */
function searchBox(container: HTMLElement): HTMLInputElement {
  return container.querySelector("[role='searchbox']") as HTMLInputElement
}

describe("ui-model 契约与纯函数", () => {
  it("host 半空注册插件：可加载、不改 context", () => {
    const ctx = {} as never
    expect(hostEntry.name).toBe("client-ui-model")
    expect(() => hostEntry.apply(ctx)).not.toThrow()
  })

  it("locale：默认恒等 + 自定义 translator + identityTranslator 直调", () => {
    const messages = resolveMessages()
    expect(messages.title).toBe("选择模型")
    expect(messages.searchPlaceholder).toBe("搜索模型")
    expect(messages.empty).toBe("没有匹配的模型")
    expect(messages.detailTitle).toBe("模型详情")
    expect(messages.back).toBe("返回列表")
    expect(messages.providerLabel).toBe("供应商")
    expect(messages.nameLabel).toBe("模型名称")
    expect(messages.effortLabel).toBe("推理强度")
    expect(identityTranslator("原文")).toBe("原文")
    const upper = resolveMessages((s) => s.toUpperCase())
    expect(upper.title).toBe("选择模型") // 中文 toUpperCase 不变，验证自定义 t 真被调用
    expect(resolveMessages((s) => `[${s}]`).back).toBe("[返回列表]")
  })

  it("stubDirectory：3 provider / 6 模型（>4 出搜索）", () => {
    const dir = stubDirectory()
    expect(dir.groups.map((g) => g.id)).toEqual(["deepseek", "openai", "anthropic"])
    expect(dir.groups.reduce((n, g) => n + g.models.length, 0)).toBe(6)
  })

  it("matchesQuery：空查询 / 前缀 / 子序列 / 大小写不敏感 / 不命中", () => {
    expect(matchesQuery("DeepSeek V3", "")).toBe(true)
    expect(matchesQuery("DeepSeek V3", "deep")).toBe(true) // 前缀 + 大小写不敏感
    expect(matchesQuery("DeepSeek V3", "DV3")).toBe(true) // 有序子序列（非连续）
    expect(matchesQuery("GPT-4o mini", "gptmini")).toBe(true)
    expect(matchesQuery("GPT-4o", "zzz")).toBe(false) // 不命中
  })

  it("filterGroups：保留命中组 / 丢弃空组 / 空目录；visibleModels 展平", () => {
    const dir = stubDirectory()
    const all = filterGroups(dir, "")
    expect(all.map((g) => g.id)).toEqual(["deepseek", "openai", "anthropic"])
    const filtered = filterGroups(dir, "deepseek")
    expect(filtered.map((g) => g.id)).toEqual(["deepseek"])
    expect(filtered[0].models.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"])
    expect(filterGroups({ groups: [] }, "")).toEqual([])
    const rows = visibleModels(all)
    expect(rows.map((r) => r.id)).toEqual([
      "deepseek-chat", "deepseek-reasoner", "gpt-4o", "gpt-4o-mini", "o3", "claude-sonnet",
    ])
  })

  it("moveHighlight：空列表回 0 / 前进 / 正向回绕 / 反向回绕", () => {
    expect(moveHighlight(0, 1, 0)).toBe(0)
    expect(moveHighlight(0, 1, 6)).toBe(1)
    expect(moveHighlight(5, 1, 6)).toBe(0) // 正向回绕
    expect(moveHighlight(0, -1, 6)).toBe(5) // 反向回绕
  })

  it("onPanelKeyDown：非导航键不消费（无 preventDefault、无动作）", () => {
    let moved = 0
    let accepted = 0
    let backed = 0
    const noop = { move: () => { moved++ }, accept: () => { accepted++ }, back: () => { backed++ } }
    const event = { key: "a", preventDefault: () => {} } as never
    onPanelKeyDown(event, noop)
    expect([moved, accepted, backed]).toEqual([0, 0, 0])
  })
})

describe("ui-model 两级面板 DOM 真接线", () => {
  it("灵魂：ctx 注入 stub 目录 → 列表级面板渲染 + provider 分组 + 搜索框", () => {
    const dom = render(createElement(ModelSelect, {
      directory: stubDirectory(),
      messages: resolveMessages(),
    }))
    const root = dom.container.querySelector("[data-ui-model='panel']")!
    expect(root.getAttribute("data-pane")).toBe("list")
    expect(dom.container.querySelector("h2")!.textContent).toBe("选择模型")

    const search = searchBox(dom.container)
    expect(search.getAttribute("aria-label")).toBe("搜索模型")
    expect(search.getAttribute("aria-activedescendant")).toBe("model-0")

    const groups = [...dom.container.querySelectorAll("[data-ui-model='group']")]
    expect(groups.map((g) => g.getAttribute("data-provider"))).toEqual(["deepseek", "openai", "anthropic"])
    expect(groups.map((g) => g.textContent)).toEqual(["DeepSeek", "OpenAI", "Anthropic"])

    const options = [...dom.container.querySelectorAll("[data-ui-model='option']")]
    expect(options.length).toBe(6)
    expect(options.map((o) => o.getAttribute("data-model-id"))).toEqual([
      "deepseek-chat", "deepseek-reasoner", "gpt-4o", "gpt-4o-mini", "o3", "claude-sonnet",
    ])
    expect(highlighted(dom.container)!.getAttribute("data-model-id")).toBe("deepseek-chat")
    expect(options[1].getAttribute("aria-selected")).toBe("false")
  })

  it("键盘导航：↑↓ 回绕高亮 + Enter 进详情 + Escape 退回（≥6 条断言）", () => {
    const dom = render(createElement(ModelSelect, {
      directory: stubDirectory(),
      messages: resolveMessages(),
    }))
    const root = dom.container.querySelector("[data-ui-model='panel']") as HTMLElement

    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(highlighted(dom.container)!.getAttribute("data-model-id")).toBe("deepseek-reasoner")
    expect(searchBox(dom.container).getAttribute("aria-activedescendant")).toBe("model-1")

    fireEvent.keyDown(root, { key: "ArrowUp" })
    expect(highlighted(dom.container)!.getAttribute("data-model-id")).toBe("deepseek-chat")

    fireEvent.keyDown(root, { key: "ArrowUp" })
    expect(highlighted(dom.container)!.getAttribute("data-model-id")).toBe("claude-sonnet")
    expect(searchBox(dom.container).getAttribute("aria-activedescendant")).toBe("model-5")

    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(highlighted(dom.container)!.getAttribute("data-model-id")).toBe("deepseek-chat")

    fireEvent.keyDown(root, { key: "a" }) // 非导航键不改高亮
    expect(highlighted(dom.container)!.getAttribute("data-model-id")).toBe("deepseek-chat")

    fireEvent.keyDown(root, { key: "Enter" })
    const detail = dom.container.querySelector("[data-ui-model='detail']")!
    expect(root.getAttribute("data-pane")).toBe("detail")
    expect(detail.getAttribute("data-model-id")).toBe("deepseek-chat")
    expect(detail.querySelector("[data-field='name']")!.textContent).toBe("DeepSeek V3")
    expect(detail.querySelector("[data-field='provider']")!.textContent).toBe("deepseek")
    expect(detail.querySelector("[data-field='effort']")!.textContent).toBe("medium")

    fireEvent.keyDown(root, { key: "Escape" })
    expect(root.getAttribute("data-pane")).toBe("list")
    expect(searchBox(dom.container)).toBeTruthy()
  })
})

describe("ui-model 面板交互分支", () => {
  it("搜索：输入即过滤 + 无匹配空提示 + 清空恢复 + 过滤后 ↑↓/Enter", () => {
    const dom = render(createElement(ModelSelect, {
      directory: stubDirectory(),
      messages: resolveMessages(),
    }))
    const root = dom.container.querySelector("[data-ui-model='panel']") as HTMLElement
    const search = searchBox(dom.container)

    fireEvent.change(search, { target: { value: "gpt" } })
    expect([...dom.container.querySelectorAll("[data-ui-model='option']")].map((o) =>
      o.getAttribute("data-model-id"))).toEqual(["gpt-4o", "gpt-4o-mini"])
    expect([...dom.container.querySelectorAll("[data-ui-model='group']")].map((g) =>
      g.getAttribute("data-provider"))).toEqual(["openai"])
    expect(highlighted(dom.container)!.getAttribute("data-model-id")).toBe("gpt-4o")

    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(highlighted(dom.container)!.getAttribute("data-model-id")).toBe("gpt-4o-mini")
    fireEvent.keyDown(root, { key: "Enter" })
    expect(dom.container.querySelector("[data-ui-model='detail']")!.getAttribute("data-model-id")).toBe("gpt-4o-mini")
    fireEvent.keyDown(root, { key: "Escape" })

    fireEvent.change(searchBox(dom.container), { target: { value: "zzz" } })
    expect(dom.container.querySelector("[data-ui-model='empty']")!.textContent).toBe("没有匹配的模型")
    expect(dom.container.querySelector("[data-ui-model='groups']")).toBeNull()

    // 空结果下 ↑↓/Enter 无高亮可动，也不误进详情
    fireEvent.keyDown(root, { key: "ArrowDown" })
    fireEvent.keyDown(root, { key: "Enter" })
    expect(root.getAttribute("data-pane")).toBe("list")

    fireEvent.change(searchBox(dom.container), { target: { value: "" } })
    expect([...dom.container.querySelectorAll("[data-ui-model='option']")].length).toBe(6)
  })

  it("点击：点模型行进详情 + 原件 Button 返回键回列表；空高亮 Enter 不动作", () => {
    const dom = render(createElement(ModelSelect, {
      directory: { groups: [] }, // 空目录：rows.length=0 分支
      messages: resolveMessages(),
    }))
    const root = dom.container.querySelector("[data-ui-model='panel']") as HTMLElement
    expect(dom.container.querySelector("[data-ui-model='empty']")!.textContent).toBe("没有匹配的模型")
    fireEvent.keyDown(root, { key: "Enter" }) // active === undefined：不进详情
    expect(root.getAttribute("data-pane")).toBe("list")
  })

  it("点击模型行进入详情，再用返回键回列表", () => {
    const dom = render(createElement(ModelSelect, {
      directory: stubDirectory(),
      messages: resolveMessages(),
    }))
    const root = dom.container.querySelector("[data-ui-model='panel']") as HTMLElement
    const o3 = [...dom.container.querySelectorAll("[data-ui-model='option']")]
      .find((o) => o.getAttribute("data-model-id") === "o3")!
    fireEvent.click(o3)
    expect(root.getAttribute("data-pane")).toBe("detail")
    expect(dom.container.querySelector("[data-ui-model='detail']")!.getAttribute("data-model-id")).toBe("o3")

    const back = [...dom.container.querySelectorAll("button")]
      .find((b) => b.textContent === "返回列表")!
    fireEvent.click(back)
    expect(root.getAttribute("data-pane")).toBe("list")
  })
})
