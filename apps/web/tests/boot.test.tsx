// @vitest-environment jsdom
/**
 * 壳 boot 渲染 smoke（ISS-537 / P4-S1 验收「jsdom boot 渲染根组件断言」）。
 *
 * 断的就是 boot 链图两件实质：① react 根挂出 ui-kb DocList 表面（in-process stub 文本
 * 真进 DOM）；② 两个 install 各恰一次——head 里 `data-plugin="client-ui-theme"` 的 style
 * 恰 2 条（theme + dsw-bridge，review-2305 观察项：重复装会追加 style 标签）。
 * 另验 config 注入（URL/env → apiBase/embed）与 dispose 清理、embed 开关的 chrome 分支。
 *
 * @module apps/web/tests/boot
 */

import { act } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { bootWeb, stubRows } from "../src/boot.ts"
import { DEFAULT_API_BASE, ENV_API_BASE, PARAM_API_BASE, resolveConfig } from "../src/config.ts"
import { stubPort } from "../src/kb-shell.tsx"
import type { BootHandle } from "../src/boot.ts"

/** 每个用例后清 DOM，避免跨用例残留 style / root 内容。 */
let handle: BootHandle | undefined
afterEach(async () => {
  if (handle !== undefined) {
    await handle.dispose()
    handle = undefined
  }
  document.head.innerHTML = ""
  document.body.innerHTML = ""
})

/** 建一个干净的挂载点。 */
function mountPoint(): HTMLElement {
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
  return root
}

describe("浏览器壳 boot 链（甲形态）", () => {
  it("config 注入：URL 覆盖 env、env 覆盖默认；embed 真值只认 1/true", () => {
    expect(resolveConfig({ search: "", env: {} })).toEqual({ apiBase: DEFAULT_API_BASE, embed: false })
    expect(resolveConfig({ search: "", env: { [ENV_API_BASE]: "http://env:8100/" } }).apiBase).toBe("http://env:8100")
    const fromUrl = resolveConfig({
      search: `?${PARAM_API_BASE}=http%3A%2F%2Furl%3A8100&embed=1`,
      env: { [ENV_API_BASE]: "http://env:8100" },
    })
    expect(fromUrl.apiBase).toBe("http://url:8100")
    expect(fromUrl.embed).toBe(true)
    expect(resolveConfig({ search: "?embed=false", env: {} }).embed).toBe(false)
  })

  it("bootWeb 渲染 ui-kb 表面：stub 文档标题真进 DOM，样式各恰一次", async () => {
    const root = mountPoint()
    const config = resolveConfig({ search: "", env: {} })
    await act(async () => {
      handle = await bootWeb(root, config, { port: stubPort() })
    })

    const rows = stubRows()
    expect(root.querySelector("[data-shell='app']")).not.toBeNull()
    expect(root.querySelector("[data-ui-kb='list']")).not.toBeNull()
    for (const row of rows) {
      expect(root.textContent).toContain(row.title)
    }

    // review-2305：installThemeStyles + installDswBridgeStyles 各恰一次 ⇒ 恰 2 条 style。
    const themeStyles = document.head.querySelectorAll("style[data-plugin='client-ui-theme']")
    expect(themeStyles.length).toBe(2)
    expect(document.head.querySelector("style[data-plugin-css='theme']")).not.toBeNull()
    expect(document.head.querySelector("style[data-plugin-css='dsw-bridge']")).not.toBeNull()

    // 非嵌入模式渲染自带 chrome。
    expect(root.querySelector("[data-shell='chrome']")).not.toBeNull()
    expect(root.querySelector("[data-shell='app']")?.getAttribute("data-embed")).toBe("false")
  })

  it("embed=1：单页聚焦——不渲染 chrome，data-embed=true", async () => {
    const root = mountPoint()
    const config = resolveConfig({ search: "?embed=1", env: {} })
    await act(async () => {
      handle = await bootWeb(root, config, { port: stubPort() })
    })
    expect(root.querySelector("[data-shell='chrome']")).toBeNull()
    expect(root.querySelector("[data-ui-kb='list']")).not.toBeNull()
    expect(root.querySelector("[data-shell='app']")?.getAttribute("data-embed")).toBe("true")
  })

  it("dispose：React 根卸载 + 两条样式标签摘除", async () => {
    const root = mountPoint()
    const config = resolveConfig({ search: "", env: {} })
    await act(async () => {
      handle = await bootWeb(root, config, { port: stubPort() })
    })
    expect(document.head.querySelectorAll("style[data-plugin='client-ui-theme']").length).toBe(2)

    const toDispose = handle
    handle = undefined
    await act(async () => {
      await toDispose?.dispose()
    })
    expect(root.querySelector("[data-shell='app']")).toBeNull()
    expect(document.head.querySelectorAll("style[data-plugin='client-ui-theme']").length).toBe(0)
  })
})
