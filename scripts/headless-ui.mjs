#!/usr/bin/env node
// headless-ui.mjs —— 无头浏览器 UI 验证（ISS-608）
//
// ## 为什么需要（它是被一次真实误判逼出来的）
// 2026-10-10 修左栏徽标时，我用 `document.body.innerText / textContent` 验证 —— 而
// **`textContent` 包含隐藏元素**：当时左栏停在「会话」页，Matter 菜单是 `hidden` + `display:none`，
// 文字在 DOM 里、屏幕上一片空白，我却宣布「已修好」。老板回：「我怎么没看到？」
//
// ## 它与既有工具的关系（不是替代，是补位）
//   · `scripts/cdp-driver.mjs` —— 连**老板正在看的那台** Electron 壳（真机 trusted input）。
//     权威，但**会真实操控老板界面**（规范 §4.2 要求每次先征得同意）。
//   · **本脚本** —— 无头 Chrome 连**隔离实例 3211**，**不碰老板界面**，可反复跑、可进 CI。
//     代价：headless 与 Electron 的字体/合成有细微差异 ⇒ **像素级结论仍需 cdp-driver 复核**；
//          但**结构性/可见性断言**（元素渲染与否、几何是否为零、有无被裁）完全可靠 —— 实测可用。
//
// ## 用法
//   node scripts/headless-ui.mjs --url <url> [--shot <png>] [--eval <js 文件>] [--wait <ms>]
//   node scripts/headless-ui.mjs --instance 3211            # 自动从 dev-instance 取 URL（含 token）
// 退出码：0 正常；1 打不开页面 / eval 抛错
//
// ## 实现要点
//   · 用**系统 Chrome**（`/Applications/Google Chrome.app`）作 executablePath ⇒ 免下载 150MB 内核
//   · playwright-core 是**全局包**，须经 createRequire 显式路径引入（本地 require 不到，实测踩过）

import { createRequire } from "node:module"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const ROOT = resolve(import.meta.dirname, "..")

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]
const PW_CANDIDATES = [
  "<home>/.npm-global/lib/node_modules/playwright-core",
  join(ROOT, "node_modules", "playwright-core"),
]

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function resolveChrome() {
  const explicit = arg("chrome")
  if (explicit) return explicit
  const hit = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!hit) die("找不到可用浏览器内核（试过 Chrome / Chromium / Edge）—— 装一个或 --chrome <path>")
  return hit
}

function resolvePlaywright() {
  for (const p of PW_CANDIDATES) {
    if (existsSync(p)) return p
  }
  die(`找不到 playwright-core（试过 ${PW_CANDIDATES.join(" / ")}）—— npm i -g playwright-core`)
}

function die(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

/**
 * 取带 token 的入口 URL（直接开根路径会 401 "authentication required"）。
 *
 * ⚠️ 两处日志都要找（独立审查 2026-10-12 · minor 4）：
 *   · **3211 隔离实例** → token 打在 `dev-instance.log`；
 *   · **3210 开发盘**   → token 打在**生产 home 的 `matter.log`**。
 *   原先只读 `dev-instance.log` ⇒ `--port 3210` 永远取不到 token，只能拿到一个 401 页面。
 */
function urlFromInstance(port) {
  const home = process.env.HOME ?? ""
  const candidates = [
    process.env.DSH_HOME_VERIFY && join(process.env.DSH_HOME_VERIFY, "dev-instance.log"),
    join(ROOT, ".tmp", "verify", "dev-instance.log"),
    home && join(home, ".dsh-verify", "dev-instance.log"),
    // 3210：生产盘（甲案搬家后 home = ~/.dsh-matter；旧 home 一并兜底）
    home && join(home, ".dsh-matter", "matter.log"),
    home && join(home, ".dsh", "matter.log"),
  ].filter(Boolean)
  const re = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[A-Za-z0-9_-]+`, "g")
  for (const log of candidates) {
    if (!existsSync(log)) continue
    const m = [...readFileSync(log, "utf8").matchAll(re)].pop()
    if (m) return m[0]
  }
  return null
}

const port = arg("port", "3211")
let url = arg("url")
if (!url && process.argv.includes("--instance")) {
  url = urlFromInstance(port) ?? `http://127.0.0.1:${port}/`
} else if (!url) {
  url = urlFromInstance(port) ?? `http://127.0.0.1:${port}/`
}

const waitMs = Number(arg("wait", "3500"))
const shotPath = arg("shot")
const evalPath = arg("eval")

const pwPath = resolvePlaywright()
const pw = require(pwPath)
const chrome = resolveChrome()

const browser = await pw.chromium.launch({ executablePath: chrome, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
  // DSH 是客户端渲染：boot → 注入插件 → 首屏。定时等待比 waitForSelector 稳（插件名不固定）。
  await page.waitForTimeout(waitMs)

  const boot = await page.evaluate(() => typeof window.__DSH_BOOT__ !== "undefined")
  if (!boot) {
    console.error(`⚠ 页面已加载但 window.__DSH_BOOT__ 缺失 —— 可能不是 DSH 宿主页，或 boot 未完成`)
  }

  let result = null
  if (evalPath) {
    const code = readFileSync(evalPath, "utf8")
    result = await page.evaluate(code)
    console.log(JSON.stringify(result, null, 1))
  } else {
    // 默认：一张概览（标题 / 可见文本长度 / 有没有内容）
    result = await page.evaluate(() => ({
      title: document.title,
      visibleText: document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 400),
      visibleLen: document.body.innerText.trim().length,
    }))
    console.log(JSON.stringify(result, null, 1))
  }

  if (shotPath) {
    const out = resolve(shotPath)
    await page.screenshot({ path: out, fullPage: false })
    console.error(`✓ 截图 → ${out}`)
  }
} finally {
  await browser.close()
}
