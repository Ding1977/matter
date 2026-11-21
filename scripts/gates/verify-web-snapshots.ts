/**
 * verify-web-snapshots —— 浏览器快照回归判据（段一 · full/ci 档，不进 fast：要起真浏览器）。
 *
 * ## 它判什么
 *
 * 在 **replay（只读）** 态跑 apps/web/tests/ui.snapshot.ts：
 *   · 9 个场景基线必须与当前 ARIA 树逐字一致（任何一行漂移即红，报场景+视口+行号）；
 *   · 基线数量必须恰好 9（3 场景 × 3 视口）——少了/多了都是配置漂移，不判绿；
 *   · 缺 vitest / 缺 Chromium / 0 基线 = 判不了（2），不许当绿。
 *
 * ⛔ 本判据**永远以 MATTER_SNAPSHOT=replay 起测试**，绝不传 record/refresh：
 *    把它接进 CI 却让它悄悄写基线，等于门禁自己把回归抹平。
 *
 * @module scripts/gates/verify-web-snapshots
 */
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-web-snapshots"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GOLDEN_DIR = path.join(REPO, "apps", "web", "tests", "expected")
const CONFIG = "vitest.web.config.ts"
/** 段一固定 3 场景 × 3 视口（与 ui.snapshot.ts 同源）。改这里必须同步改测试与 spec。 */
export const EXPECTED_GOLDENS = 9

/** 判据输入（纯函数喂构造数据，spec 不真起浏览器）。 */
export interface SnapshotRunInput {
  /** vitest 退出码（0 = 全绿）。 */
  rc: number
  /** vitest stdout+stderr。 */
  output: string
  /** 盘上 .expected.md 数量。 */
  goldenCount: number
  /** vitest 二进制不在（环境缺料，判不了）。 */
  missingBinary?: boolean
  /** 测试输出里带 Chromium 未安装特征（环境缺料，判不了）。 */
  browserMissing?: boolean
}

/** 从失败输出里挑第一条「场景=… 视口=…」，让门禁红也点名到场景+视口。 */
export function firstSceneLabel(output: string): string | undefined {
  return /场景=\S+\s+视口=\d+/.exec(output)?.[0]
}

/**
 * 判据纯函数：输入 → GateResult。
 * @param input - 跑批结果与基线计数。
 * @returns 判过/红/判不了。
 */
export function judgeWebSnapshots(input: SnapshotRunInput): GateResult {
  if (input.missingBinary === true) return unjudged(GATE, "no-binary", "缺 vitest 二进制；先 pnpm install")
  if (input.browserMissing === true) return unjudged(GATE, "no-binary", "Chromium 未安装；先 npx playwright install chromium")
  if (input.goldenCount === 0) return unjudged(GATE, "no-baseline", "0 个 .expected.md；先 MATTER_SNAPSHOT=record 生成基线")
  if (input.goldenCount !== EXPECTED_GOLDENS) {
    return {
      gate: GATE,
      status: "failed",
      findings: [{ detail: `基线数量 = ${String(input.goldenCount)}，应为 ${String(EXPECTED_GOLDENS)}（3 场景 × 3 视口）` }],
    }
  }
  if (input.rc === 0) {
    return { gate: GATE, status: "passed", detail: `${String(input.goldenCount)} 个 ARIA 基线 replay 全绿` }
  }
  const label = firstSceneLabel(input.output)
  const detail = label === undefined ? "replay 有测试红" : `replay 有测试红（${label}）`
  return { gate: GATE, status: "failed", findings: [{ detail }] }
}

/** 递归数 .expected.md（基线数量是判据的一维，不能用固定假设代替实测）。 */
export function countGoldens(dir: string): number {
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) n += countGoldens(full)
    else if (entry.name.endsWith(".expected.md")) n += 1
  }
  return n
}

/** Chromium 未安装的特征（vitest 报错原文形态，不靠猜） */
const BROWSER_MISSING_RE = /Executable doesn't exist|browserType\.launch:|npx playwright install|playwright install chromium/

function main(): GateResult {
  const vitestBin = path.join(REPO, "node_modules", "vitest", "vitest.mjs")
  const missingBinary = !existsSync(vitestBin)
  let goldenCount = 0
  try {
    goldenCount = countGoldens(GOLDEN_DIR)
  } catch {
    goldenCount = 0
  }
  if (missingBinary) return judgeWebSnapshots({ rc: 2, output: "", goldenCount, missingBinary: true })

  const run = spawnSync(process.execPath, [vitestBin, "run", "--config", CONFIG], {
    cwd: REPO,
    env: { ...process.env, MATTER_SNAPSHOT: "replay" },
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
  return judgeWebSnapshots({
    rc: run.status ?? 2,
    output,
    goldenCount,
    browserMissing: BROWSER_MISSING_RE.test(output),
  })
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main })
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      console.error(`✗ ${GATE}: ${(error as Error).message}`)
      process.exitCode = 2
    })
}
