// @vitest-environment jsdom
/**
 * DSH 原件 token 桥接的实证（ISS-534 / P4-0）。
 *
 * 三件被钉死的事：
 *  1. 原件可渲染 —— 真 import 两件原件源码（Button/Checkbox，经包 `./src/*` 导出），
 *     在 jsdom 里 render，断言产出了原生 button / input。
 *  2. token 无悬空 —— 实扫原件包 `lib 下全部 .css` 的 var 引用全集，逐一断言每个名字
 *     都在 (包内自带定义 ∪ 本包 dsw-bridge.css 定义) 里。这是「原件零改动即工作」的
 *     机器判据：少一个定义，`var(--x)` 就悬空，这里立刻红。
 *  3. 桥接是加法 —— 注入钩子注入独立 style 标签，与 U-1 的 theme 标签并存、可独立摘除。
 *
 * 「读真文件」用 fs（不经 Vite 管线）：vitest 默认 css:false 会把 `.css`/`?inline` stub 成
 * 空串，对账要的是文件真相 —— 与 tests/tokens.test.ts 同款口径。
 *
 * 原件包是 pnpm-lock 里钉死的 exact rc（仓内事实，随 lockfile 可复现），不是环境探针。
 *
 * @module @matter/client-ui-theme/tests/dsw-bridge
 */

import { createRequire } from "node:module"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createElement } from "react"
import { Context } from "@deepseek-ai/cordis"
import { render, cleanup } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { installDswBridgeStyles, DSW_BRIDGE_CSS_ID } from "../src/client/index.ts"

// clsx 是原件的 className 拼接器（rc 把它误列为 devDep，未被传递安装），
// 已在根 devDeps 显式安装，render 的是原件真源码与真 CSS Module。
import { Button } from "@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx"
import { Checkbox } from "@deepseek-ai/dsh-client-ui-primitives/src/Checkbox.tsx"

/** 解析原件包安装目录（exact rc，随 lockfile 复现）。 */
const require = createRequire(import.meta.url)
const pkgRoot = dirname(require.resolve("@deepseek-ai/dsh-client-ui-primitives/package.json"))

/** dsw-bridge.css 全文（fs 直读，理由见文件头；cwd=仓库根，仓内事实）。 */
const bridgeCss: string = readFileSync(
  resolve(process.cwd(), "packages/client/ui-theme/src/client/dsw-bridge.css"),
  "utf8",
)

/** 递归收集某目录下所有 .css 绝对路径。 */
function cssFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...cssFiles(p))
    else if (name.endsWith(".css")) out.push(p)
  }
  return out
}

/** 从 CSS 全文提取 var() **引用**名。 */
function varReferences(css: string): Set<string> {
  return new Set([...css.matchAll(/var\((--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]))
}

/** 从 CSS 全文提取变量**定义**名（`--x:` 形态，不含 var() 引用）。 */
function varDefinitions(css: string): Set<string> {
  return new Set([...css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]))
}

/** 包内自带定义 + 桥接定义 = 全部可用定义。 */
const packageCss = cssFiles(join(pkgRoot, "lib")).map((p) => readFileSync(p, "utf8")).join("\n")
const availableDefinitions = new Set([...varDefinitions(packageCss), ...varDefinitions(bridgeCss)])
const consumedVars = varReferences(packageCss)

afterEach(() => {
  cleanup()
  for (const s of document.head.querySelectorAll(`style[data-plugin-css="${DSW_BRIDGE_CSS_ID}"]`)) s.remove()
})

describe("原件 token 消费全集 ⊆ 可用定义集（无悬空 var）", () => {
  it("实扫 lib 下全部 .css 的 var 全集非空，且每个引用都有定义", () => {
    expect(consumedVars.size, "实扫到的 var 引用应非空").toBeGreaterThan(0)
    const dangling = [...consumedVars].filter((v) => !availableDefinitions.has(v))
    expect(dangling, `悬空的 token（原件会渲染成无色/失效）：${dangling.join(", ")}`).toEqual([])
  })

  it("桥接层独立覆盖实扫全集 —— 不靠包内自带定义也能解析", () => {
    const bridgeDefs = varDefinitions(bridgeCss)
    const danglingWithoutPackageDefs = [...consumedVars].filter((v) => !bridgeDefs.has(v))
    expect(danglingWithoutPackageDefs, "桥接层少定义的 token").toEqual([])
  })
})

describe("原件可渲染 + 桥接注入是加法", () => {
  it("jsdom 渲染 Button 与 Checkbox 两件原件，产出原生控件", () => {
    const { container } = render(
      createElement(
        "div",
        null,
        createElement(Button, { variant: "primary" }, "Save"),
        createElement(Checkbox, { checked: false, onChange: () => {}, label: "Remember me" }),
      ),
    )
    expect(container.querySelector("button")?.textContent).toBe("Save")
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(container.textContent).toContain("Remember me")
  })

  it("桥接钩子注入的 style 与 theme 标签并存、disposer 只摘自己的标签", async () => {
    const ctx = new Context()
    const style = document.createElement("style")
    style.setAttribute("data-plugin", "client-ui-theme")
    style.setAttribute("data-plugin-css", "theme")
    document.head.append(style)

    const dispose = installDswBridgeStyles(ctx)
    const bridgeTag = document.head.querySelector(`style[data-plugin-css="${DSW_BRIDGE_CSS_ID}"]`)
    expect(bridgeTag, "桥接 style 应注入").not.toBeNull()
    expect(document.head.querySelector('style[data-plugin-css="theme"]'), "theme 标签应仍在").not.toBeNull()

    await dispose()
    expect(document.head.querySelector(`style[data-plugin-css="${DSW_BRIDGE_CSS_ID}"]`), "桥接标签应摘除").toBeNull()
    expect(document.head.querySelector('style[data-plugin-css="theme"]'), "theme 标签不受影响").not.toBeNull()

    style.remove()
  })
})
