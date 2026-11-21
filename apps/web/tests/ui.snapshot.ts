/**
 * 段一浏览器快照回归：3 场景 × 3 视口 = 9 个 ARIA 基线。
 *
 * 场景（错误态留段二，本段不做）：
 *   shell  —— 页壳骨架（侧栏 / 中栏 / 属性栏，窄宽下属性栏自然缺席）
 *   list   —— 12 条种子文档列表
 *   detail —— 点开第一条后的详情（含远端正文投影）
 * 视口：1440 / 768 / 480。
 *
 * 基线：`apps/web/tests/expected/<场景>/<宽>.expected.md`。
 * 三态见 support.ts；本文件只负责排场景，不碰 cdp-driver / surface（那只「手」归 agent）。
 *
 * @module apps/web/tests/ui.snapshot
 */
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, it } from "vitest"
import {
  BASE_URL,
  captureAria,
  compareOrWriteGolden,
  loadRecordEnv,
  openSnapshotPage,
  snapshotMode,
  startPreview,
  stopPreview,
  type PreviewHandle,
} from "./support.ts"

const MODE = snapshotMode()
const EXPECTED_DIR = fileURLToPath(new URL("./expected/", import.meta.url))
const VIEWPORTS = [1440, 768, 480] as const
const SCENARIOS = ["shell", "list", "detail"] as const
type Scenario = (typeof SCENARIOS)[number]

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
      } finally {
        await page.close()
      }
    }, 120_000)
  }
}
