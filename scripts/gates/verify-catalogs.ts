/**
 * 3 张 catalog 的新鲜度判据（ISS-893 / 轨 D D1，仿 verify-ctx-catalog）。
 *
 * 机制仍是**失败驱动**：改源码 → 忘跑生成器 → 本格红 → `node scripts/gen-catalog.ts` → 提交。
 * 判据不自己再写一份扫描：`expected` 直接调生成器的 `generateAll()`（同一个 program、同一批
 * extractor、同一套渲染）。两份实现迟早分叉成「生成器说最新、判据说旧」，届时没人能说清哪边对。
 *
 * 三态（`scripts/lib/gate-runtime.ts`）：0 绿 / 1 红（旧了）/ 2 判不了（没有语料）。
 * ⛔ 0 个包不许判绿：空表与空表当然一致，那不是绿，是 `no-corpus`。
 * 红文案给全四件：文件:行 + 期望 + 实际 + 重生成命令（能直接粘的一条）。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult, type Finding } from "../lib/gate-runtime.ts"
import { firstDiff } from "./verify-ctx-catalog.ts"
import { EXTRACTORS, REPO_ROOT, generateAll, listPackages } from "../gen-catalog.ts"

const REPO = REPO_ROOT
const GATE = "verify-catalogs"
/** 生成器的重跑命令：红文案里的「怎么改」必须是能直接粘的一条。 */
const REGEN = "node scripts/gen-catalog.ts"

/** 一张 catalog 的检查输入。 */
export interface CatalogCheck {
  id: string
  output: string
  /** 生成物现状（`null` = 文件不存在）。 */
  actual: string | null
  /** 现算内容（来自生成器，同一条路径）。 */
  expected: string
}

export interface CatalogsInput {
  catalogs: CatalogCheck[]
  packageCount: number
}

/** 摘要把一行压成可读长度，免得一个超长行把红文案撑爆。 */
function oneLine(s: string): string {
  const t = s.length > 160 ? `${s.slice(0, 157)}…` : s
  return t.replace(/`/g, "ˋ")
}

/**
 * 纯函数判据：spec 直接喂构造数据（正例 / 改一字 / 删文件 / 改头 / 0 包）。
 * @param input - 3 张 catalog 的现状 + 现算内容 + 包数。
 */
export function judgeCatalogs(input: CatalogsInput): GateResult {
  if (!(input.packageCount > 0)) {
    return unjudged(
      GATE,
      "no-corpus",
      "packages/<group>/<pkg> 下扫到 0 个包 ⇒ 判不了「生成物是否新鲜」（空表与空表当然一致，那不是绿）",
    )
  }
  const findings: Finding[] = []
  for (const c of input.catalogs) {
    if (c.actual === null) {
      findings.push({
        file: c.output,
        detail: `文件不存在，但源码里有 ${input.packageCount} 个包 ⇒ 跑 \`${REGEN}\` 生成，并把结果提交进 git（生成物进仓库是这个机制的承重墙）`,
      })
      continue
    }
    if (c.actual === c.expected) continue
    const expectedHeader = c.expected.split("\n")[0] ?? ""
    if (!c.actual.startsWith(expectedHeader)) {
      findings.push({
        file: c.output,
        line: 1,
        detail: `首行不是生成器文件头。期望 \`${oneLine(expectedHeader)}\`，实际 \`${oneLine(c.actual.split("\n")[0] ?? "（空文件）")}\``,
      })
    }
    const diff = firstDiff(c.actual, c.expected)
    if (diff) {
      findings.push({
        file: c.output,
        line: diff.line,
        detail: `内容与源码不一致（extractor=${c.id}）。期望 \`${oneLine(diff.expected)}\`，实际 \`${oneLine(diff.actual)}\``,
      })
    }
    findings.push({
      file: c.output,
      detail: `这是生成物，不要手改：跑 \`${REGEN}\` 重生成后提交（改源码才是改这些表的唯一途径）`,
    })
  }
  if (findings.length) return { gate: GATE, status: "failed", findings }
  return { gate: GATE, status: "passed", findings: [] }
}

/** 现算 3 张生成物 + 读盘现状 + 包数（与生成器/判据共用同一条路径）。 */
export function scan(): CatalogsInput {
  const generated = generateAll(REPO)
  const catalogs = generated.map(({ output, text }) => {
    const target = path.join(REPO, output)
    return {
      id: EXTRACTORS.find((e) => e.output === output)?.id ?? output,
      output,
      actual: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null,
      expected: text,
    }
  })
  return { catalogs, packageCount: listPackages(REPO).length }
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main: () => judgeCatalogs(scan()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
