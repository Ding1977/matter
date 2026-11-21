/**
 * 段一 + 段二浏览器快照回归：5 视口 × 3 页 = 15 条 ARIA 基线，另加错误态/加载态各 1 条。
 *
 * 场景：
 *   shell  —— 页壳骨架（侧栏 / 中栏 / 属性栏，窄宽下属性栏自然缺席）
 *   list   —— 12 条种子文档列表
 *   detail —— 点开第一条后的详情（含远端正文投影）
 *   error  —— 真打断 `/api/document/list`（route.abort）后的可见态
 *   loading—— 真延迟 `/api/document/list`（8s）且数据未返回前的可见态
 * 视口：1440 / 1024 / 900 / 768 / 480（段二在 768/480 之间补 1024/900 两档）。
 *
 * 每条快照同时挂 computed-style 层级断言（阈值从 theme.css token 读，不写死）。
 *
 * 基线：`apps/web/tests/expected/<场景>/<宽>.expected.md`。
 * 三态见 support.ts；本文件只负责排场景，不碰 cdp-driver / surface（那只「手」归 agent）。
 *
 * 错误/加载的「不得显示暂无文档」契约在 #165 合入后由 `it.fails` 兑现为正式 `it`
 * （合入前两条断言按设计失败；合入后真通过，自到期机制生效）。
 *
 * @module apps/web/tests/ui.snapshot
 */
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  assertHeadingHierarchy,
  BASE_URL,
  breakDocumentList,
  captureAria,
  compareOrWriteGolden,
  delayDocumentList,
  loadRecordEnv,
  openSnapshotPage,
  snapshotMode,
  startPreview,
  stopPreview,
  type PreviewHandle,
} from "./support.ts"

const MODE = snapshotMode()
const EXPECTED_DIR = fileURLToPath(new URL("./expected/", import.meta.url))
const VIEWPORTS = [1440, 1024, 900, 768, 480] as const
const SCENARIOS = ["shell", "list", "detail"] as const
type Scenario = (typeof SCENARIOS)[number]
const STATE_WIDTH = 1440
const STATES = ["error", "loading"] as const
type State = (typeof STATES)[number]

let browser: Browser | undefined
let preview: PreviewHandle | undefined

beforeAll(async () => {
  // 唯一碰 env 的分支：record（replay/refresh 的调用链不经过这里）
  if (MODE === "record") loadRecordEnv()
  browser = await chromium.launch()
  preview = await startPreview(browser)
}, 180_000)

afterAll(async () => {
  try {
    await browser?.close()
  } finally {
    await stopPreview(preview)
  }
}, 60_000)

/** 等列表 12 条种子真渲染完（页面就绪判据与 support.ts 同源）。 */
async function waitSeedList(page: Awaited<ReturnType<Browser["newPage"]>>): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-ui-kb="list"] li[data-doc-id]').length === 12,
    undefined,
    { timeout: 90_000 },
  )
}

/** 进详情：点第一条，等正文投影从 loading 变 ready。 */
async function openFirstDoc(page: Awaited<ReturnType<Browser["newPage"]>>): Promise<void> {
  await page.locator('[data-ui-kb="list"] li[data-doc-id] button').first().click()
  await page.locator('[data-ui-kb="detail"][data-state="ready"]').waitFor({ timeout: 30_000 })
}

/** 按场景取快照范围。 */
function ariaFor(page: Awaited<ReturnType<Browser["newPage"]>>, scenario: Scenario): Promise<string> {
  if (scenario === "shell") return page.locator('[data-shell="page"]').ariaSnapshot()
  if (scenario === "list") return page.locator('[data-ui-kb="list"]').ariaSnapshot()
  return page.locator('[data-ui-kb="detail"]').ariaSnapshot()
}

/** 制造错误/加载态并抓列表区域快照（含 list-empty，空错分离看得见）。 */
async function stateAria(page: Awaited<ReturnType<Browser["newPage"]>>, state: State): Promise<string> {
  if (state === "error") await breakDocumentList(page)
  else await delayDocumentList(page)
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
  // #165 后错误/加载各有独立形态（list-error / list-loading）。旧的 list/list-empty
  // 兼容分支已删——新形态是唯一真相，留着就是死代码。
  const LIST_REGION = '[data-ui-kb="list-error"], [data-ui-kb="list-loading"]'
  await page.waitForFunction(
    (selector) => document.querySelector(selector) !== null,
    LIST_REGION,
    { timeout: 15_000 },
  )
  return page.locator(LIST_REGION).ariaSnapshot()
}

/** computed-style 断言 + 一条现数回报（只在 1440 打，避免 17 行噪声）。 */
async function checkHierarchy(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  label: string,
  verbose: boolean,
): Promise<void> {
  const max = await assertHeadingHierarchy(page, label)
  if (verbose) {
    console.log(`[层级实测] ${label}：<${max.tag}>「${max.text}」 ${String(max.fontSizePx)}px fw=${max.fontWeight} role=${String(max.role)} level=${String(max.level)}`)
  }
}

for (const scenario of SCENARIOS) {
  for (const width of VIEWPORTS) {
    it(`${scenario} @ ${width}`, async () => {
      if (browser === undefined) throw new Error("浏览器未起")
      const page = await openSnapshotPage(browser, width)
      try {
        await waitSeedList(page)
        if (scenario === "detail") await openFirstDoc(page)
        const aria = await ariaFor(page, scenario)
        await compareOrWriteGolden(
          join(EXPECTED_DIR, scenario, `${String(width)}.expected.md`),
          aria,
          MODE,
          `场景=${scenario} 视口=${width}`,
        )
        await checkHierarchy(page, `场景=${scenario} 视口=${width}`, width === 1440 && scenario === "shell")
      } finally {
        await page.close()
      }
    }, 120_000)
  }
}

for (const state of STATES) {
  it(`${state} @ ${STATE_WIDTH}`, async () => {
    if (browser === undefined) throw new Error("浏览器未起")
    const page = await openSnapshotPage(browser, STATE_WIDTH)
    try {
      const aria = await stateAria(page, state)
      await compareOrWriteGolden(
        join(EXPECTED_DIR, state, `${String(STATE_WIDTH)}.expected.md`),
        aria,
        MODE,
        `场景=${state} 视口=${STATE_WIDTH}`,
      )
      await checkHierarchy(page, `场景=${state} 视口=${STATE_WIDTH}`, false)
    } finally {
      await page.close()
    }
  }, 120_000)
}

// ── 空错分离契约（#165 合入后由 it.fails 兑现为正式 it）────────────────────
it("契约：错误态必须出「加载失败 + 重试」而非「暂无文档」", async () => {
  if (browser === undefined) throw new Error("浏览器未起")
  const page = await openSnapshotPage(browser, STATE_WIDTH)
  try {
    const aria = await stateAria(page, "error")
    expect(aria).toContain("加载失败")
    expect(aria).not.toContain("暂无文档")
  } finally {
    await page.close()
  }
}, 120_000)

it("契约：数据未返回前不得显示「暂无文档」", async () => {
  if (browser === undefined) throw new Error("浏览器未起")
  const page = await openSnapshotPage(browser, STATE_WIDTH)
  try {
    const aria = await stateAria(page, "loading")
    expect(aria).not.toContain("暂无文档")
  } finally {
    await page.close()
  }
}, 120_000)
