/**
 * 覆盖率阈值判据（ISS-522 / C-0a）—— 把覆盖率从「采到了吗」升级成「够不够」。
 *
 * ## 判什么、不判什么
 *
 * 判：`coverage/coverage-summary.json` 里每个非 `total` 文件的四维覆盖率是否都到阈值。
 * 不判：测试红不红（那是 `run-package-tests` 的事）、采集链路通不通（那是 `verify-coverage-collect` 的事）。
 * 这三格是同一条链上的三段，刻意分开 —— 混在一格会让判词说不清到底是「没跑」还是「跑得不够」。
 *
 * ## 为什么判词是本格的主交付（不是附属品）
 *
 * vitest 的 `perFile 100%` 只会打印一行没有行号的 ERROR：
 *   `ERROR: Coverage for branches (41.17%) does not meet global threshold (100%) for <file>`
 * 人拿到它不知道该删代码还是补测试。本判据读 `coverage-final.json` 的 `statementMap/fnMap/branchMap`
 * 自己生成 `文件:行:列` + expected/actual + howToFix 三选一，零新依赖且保持纯函数。
 * DSH 的 reporter 搬不动（实测 `istanbul-lib-report` 从 `scripts/` 解析不到），故走 JSON 自生成。
 *
 * ## 一个 v8 实测盲区（决定豁免清单的形状）
 *
 * `issueId(value) { return value }` 这种单行恒等函数，写测试直调且断言通过，v8 仍记 `0/1`。
 * ⇒ `brand.ts` 永远到不了 100%，只能走带 ticket + expires 的豁免（不进 `coverage.exclude`）。
 * ⛔ 除首批那一个文件外不许加别的条目 —— 其余 15 个文件是真缺口，属于 C-0b 补测。
 *
 * ## 分域阈值（ISS-530 / P3-U1：client 域 80% 起步）
 *
 * 单一 100% 阈值只对**后端包**成立：client（前端）包按 DOC-520 §4.3 定 80% 起步
 * （严于 DSH 现状——DSH client 侧整片豁免、从未真到 100%）。落法是给本判据加一张
 * **路径前缀 → 阈值表**（`DEFAULT_PREFIX_THRESHOLDS`），判据按仓库相对路径做**最长前缀
 * 匹配**：命中用域阈值，不命中回落全局 `threshold`（默认 100）。非 client 的
 * `packages/<g>/<p>/src` 一行不改地维持 perFile 100。
 * ⛔ 不落 vitest thresholds：本仓管线是「vitest 产 json → 自建判据判」（DSH 同路），
 *    阈值真相只在 `DEFAULT_PREFIX_THRESHOLDS` 这一处。
 *
 * ## 退出码（口径见 `scripts/lib/gate-runtime.ts`）
 *   0 = 绿（所有在判文件四维达标）· 1 = 红（有文件不达标）· 2 = 判不了（无产物 / 无 vitest）
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-coverage-threshold"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** 采集产物：`json-summary` 判红绿，`json` 出行号。 */
export const SUMMARY_REL = "coverage/coverage-summary.json"
export const FINAL_REL = "coverage/coverage-final.json"
/** 豁免清单：带 ticket + expires，不进 vitest 的 `coverage.exclude`。 */
export const EXEMPT_REL = "scripts/baseline/coverage-exempt.json"
/** 阈值唯一来源；spec 可注入覆盖，文案里的 expected 从这里读，不手写。 */
export const DEFAULT_THRESHOLD = 100

/**
 * 分域阈值表（ISS-530 / P3-U1）：仓库相对路径前缀 → 该域的 perFile 阈值。
 *
 * · 键 = 仓库相对路径前缀，按**最长匹配**优先（`packages/client/` 80 是当前唯一一条；
 *   后续要给某个 client 包单独提档，加更长前缀即可，如 `packages/client/ui-blocks/` → 90）。
 * · 未命中任何前缀的文件回落 `threshold`（默认 100）—— 非 client 的 packages/&lt;g&gt;/&lt;p&gt;/src
 *   一行不改地维持 perFile 100。
 * · 数值依据：DOC-520 §4.3（client 80% 起步，严于 DSH 现状——DSH client 侧走豁免清单）。
 */
export const DEFAULT_PREFIX_THRESHOLDS: Readonly<Record<string, number>> = {
  "packages/client/": 80,
  // ISS-534 / P4-0：ui-theme 是 client 域里第一个 coverage 达 100 的包，单独提档。
  // 最长前缀优先 ⇒ 本包走 100，其余 client 包维持 80（注释原文：加更长前缀即可提档）。
  "packages/client/ui-theme/": 100,
  // ISS-540 / P4-V2：ui-pm 列表骨架以 coverage 100 交付（提档纪律第二例）。
  // 最长前缀优先 ⇒ 本包走 100，其余 client 包维持 80。
  "packages/client/ui-pm/": 100,
  // ISS-543 / P4-M1：ui-model 最小座席以 coverage 100 交付（提档纪律第三例）。
  // 最长前缀优先 ⇒ 本包走 100，其余 client 包维持 80。
  "packages/client/ui-model/": 100,
  // ISS-544 / P5-D1：设计批首单动到 ui-kb 的 list/detail/locale（确定交集 3/24），
  // 顺带把本包从 80 提到 100（最长前缀提档，Q7 甲案首例）。
  "packages/client/ui-kb/": 100,
}

type Dim = "statements" | "branches" | "functions" | "lines"
const DIMS: readonly Dim[] = ["statements", "branches", "functions", "lines"]

/** 豁免清单一行。 */
export interface ExemptEntry {
  why: string
  ticket: string
  expires: string
}
/** 仓库相对路径 → 豁免行。 */
export type ExemptMap = Record<string, ExemptEntry>

/** 纯函数输入 —— spec 直接喂构造数据，不碰 IO。 */
export interface ThresholdInputs {
  /** `coverage-summary.json` 全文；null = 没产出。 */
  summary: string | null
  /** `coverage-final.json` 全文；null = 没产出（判词将缺行号，但仍可判红绿）。 */
  final: string | null
  /** 豁免清单全文（JSON），默认 `{}`。 */
  exempt?: string
  /** 阈值，默认 100。**未命中分域前缀的文件**用它；命中前缀的文件域阈值优先。 */
  threshold?: number
  /** 分域阈值表（前缀 → 阈值），默认 {@link DEFAULT_PREFIX_THRESHOLDS}；spec 可注入覆盖。 */
  prefixThresholds?: Record<string, number>
}

/** 一个未覆盖位置。 */
interface Loc {
  line: number
  column: number
  /** 该位置的措辞，如 `uncovered statement` / `uncovered branch (if, path 1/2)`。 */
  what: string
}

/**
 * 纯函数：覆盖率是否达标 + 带行号的判词。
 *
 * @param i 见 `ThresholdInputs`
 * @returns 绿 / 红（逐文件逐维度 finding）/ 判不了（无产物 / 坏 JSON）
 */
export function judgeCoverageThreshold(i: ThresholdInputs): GateResult {
  const threshold = i.threshold ?? DEFAULT_THRESHOLD
  const prefixThresholds = i.prefixThresholds ?? DEFAULT_PREFIX_THRESHOLDS

  if (i.summary === null) {
    return unjudged(GATE, "no-corpus", "缺覆盖率产物（期望 coverage/coverage-summary.json；先跑 ./node_modules/.bin/vitest run packages --coverage）")
  }

  let summary: Record<string, Record<string, CoverageStat>> | null = null
  try {
    const parsed = JSON.parse(i.summary)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) summary = parsed as typeof summary
  } catch {
    /* 留 null 交给下面判 */
  }
  if (!summary) {
    return { gate: GATE, status: "failed", findings: [{ file: SUMMARY_REL, detail: "coverage-summary.json 不是合法 JSON（reporter 可能被换掉）" }] }
  }

  let exempt: ExemptMap = {}
  if (i.exempt !== undefined) {
    try {
      const parsed = JSON.parse(i.exempt)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) exempt = parsed as ExemptMap
    } catch {
      return { gate: GATE, status: "failed", findings: [{ file: EXEMPT_REL, detail: "豁免清单不是合法 JSON" }] }
    }
  }

  const final = parseFinal(i.final)
  const findings: Finding[] = []
  let judged = 0
  let exempted = 0
  let nonTotal = 0
  /** 域阈值实际用在判了多少文件（按前缀分桶，供 pass detail 出声——判据改了读数形态要看得见）。 */
  const domainCount = new Map<string, number>()

  for (const [key, stat] of Object.entries(summary)) {
    if (key === "total") continue
    nonTotal++
    const rel = toRepoRel(key)
    if (exempt[rel] !== undefined) {
      exempted++
      continue
    }
    const domainPrefix = matchedPrefix(rel, prefixThresholds)
    const fileThreshold = domainPrefix === undefined ? threshold : prefixThresholds[domainPrefix]
    if (domainPrefix !== undefined) {
      domainCount.set(domainPrefix, (domainCount.get(domainPrefix) ?? 0) + 1)
    }
    judged++
    for (const dim of DIMS) {
      const d = stat?.[dim]
      if (!d || typeof d.pct !== "number" || typeof d.total !== "number" || typeof d.covered !== "number") continue
      if (d.total <= 0) continue // 空真（纯类型文件 S 0/0）不判
      if (d.pct >= fileThreshold) continue
      findings.push(buildFinding(rel, dim, d, fileThreshold, final.get(key), exempted > 0))
    }
  }

  if (findings.length) return { gate: GATE, status: "failed", findings }
  // 「一个文件都没有」与「有文件但全在豁免清单里」是两件事：前者是判不了（采集可能只产了 total），
  // 后者是绿（豁免生效的结果）—— 用 judged 判会把后者误报成 no-corpus（spec 的豁免用例抓到过这个 bug）。
  if (!nonTotal) {
    return unjudged(GATE, "no-corpus", "coverage-summary.json 里没有非 total 的文件条目（采集可能只产了 total）")
  }
  const domainText = [...domainCount.entries()]
    .map(([prefix, n]) => `${prefix}→${prefixThresholds[prefix]} ×${n} 文件`)
    .join("、")
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail:
      `四维达标 · 在判 ${judged} 文件${exempted ? ` · 豁免 ${exempted} 文件` : ""}` +
      (domainText ? ` · 域阈值 ${domainText}` : ""),
  }
}

/** 命中分域表的**最长前缀**；未命中返回 undefined。 */
function matchedPrefix(rel: string, prefixes: Record<string, number>): string | undefined {
  let hit: string | undefined
  for (const prefix of Object.keys(prefixes)) {
    if (rel.startsWith(prefix) && (hit === undefined || prefix.length > hit.length)) hit = prefix
  }
  return hit
}

/** summary 里一个维度的覆盖统计。 */
interface CoverageStat {
  statements?: DimStat
  branches?: DimStat
  functions?: DimStat
  lines?: DimStat
}
interface DimStat {
  total: number
  covered: number
  pct: number
}

/** 仓库相对路径：绝对路径里截出 `packages/...`。 */
function toRepoRel(key: string): string {
  const m = /((?:packages|forge-[^/]+)\/[^"]+)$/.exec(key)
  return m ? m[1] : key.replace(/^\//, "")
}

/** 一条红的判词。 */
function buildFinding(rel: string, dim: Dim, d: DimStat, threshold: number, cov: FileCoverage | undefined, hasExempt: boolean): Finding {
  const pctText = `${d.covered}/${d.total} = ${d.pct.toFixed(2)}%`
  const locs = cov ? uncoveredLocs(cov, dim) : []
  const first = locs[0]
  const locText = first ? `:${first.line}:${first.column}` : ""
  const locList = locs.length
    ? locs.slice(0, 8).map((l) => `:${l.line}:${l.column} ${l.what}`).join(" · ") + (locs.length > 8 ? ` … +${locs.length - 8}` : "")
    : "（coverage-final.json 未提供该维度的未覆盖位置）"
  const detail =
    `${dim} 覆盖不足${locText} · expected ${threshold}% / actual ${pctText}\n` +
    `     uncovered: ${locList}\n` +
    `     howToFix（三选一）：① 不在射程内 ⇒ 删掉它；② 确有行为 ⇒ 在 <pkg>/tests/<x>.test.ts 加用例；③ 不可达防御 ⇒ /* v8 ignore -- <真理由> */\n` +
    `     forbidden: 不许改阈值、不许往 coverage.exclude 或豁免清单加条目来变绿${hasExempt ? "（本清单已有豁免文件，别顺手加）" : ""}`
  return { file: rel, line: first?.line, detail }
}

/** coverage-final.json 里一个文件的覆盖率数据（只取判词要用的字段）。 */
interface FileCoverage {
  statementMap: Record<string, { start: LocBase }>
  fnMap: Record<string, { decl: { start: LocBase } }>
  branchMap: Record<string, { type?: string; locations: { start: LocBase }[] }>
  s: Record<string, number>
  f: Record<string, number>
  b: Record<string, number[]>
}
interface LocBase {
  line: number
  column: number
}

/** 解析 coverage-final.json：文件绝对路径 → 覆盖率数据。 */
function parseFinal(raw: string | null): Map<string, FileCoverage> {
  const out = new Map<string, FileCoverage>()
  if (raw === null) return out
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return out
    for (const [k, v] of Object.entries(parsed)) {
      if (k === "total" || !v || typeof v !== "object") continue
      out.set(k, v as FileCoverage)
    }
  } catch {
    /* 产物坏 ⇒ 判词没行号，但红绿仍可判（不在这里编一个红） */
  }
  return out
}

/** 某维度下所有未覆盖位置（带措辞）。 */
function uncoveredLocs(cov: FileCoverage, dim: Dim): Loc[] {
  try {
    if (dim === "statements") {
      return Object.keys(cov.statementMap ?? {})
        .filter((id) => cov.s?.[id] === 0)
        .map((id) => ({ ...cov.statementMap[id].start, what: "uncovered statement" }))
    }
    if (dim === "functions") {
      return Object.keys(cov.fnMap ?? {})
        .filter((id) => cov.f?.[id] === 0)
        .map((id) => ({ ...cov.fnMap[id].decl.start, what: "uncovered function" }))
    }
    if (dim === "branches") {
      const out: Loc[] = []
      for (const [id, hits] of Object.entries(cov.b ?? {})) {
        const meta = cov.branchMap?.[id]
        if (!meta) continue
        hits.forEach((h, idx) => {
          if (h === 0 && meta.locations[idx]) {
            out.push({ ...meta.locations[idx].start, what: `uncovered branch (${meta.type ?? "branch"}, path ${idx + 1}/${hits.length})` })
          }
        })
      }
      return out
    }
    // lines：从 statements 推（v8 的 line 覆盖由语句覆盖聚合）。
    return Object.keys(cov.statementMap ?? {})
      .filter((id) => cov.s?.[id] === 0)
      .map((id) => ({ ...cov.statementMap[id].start, what: "uncovered line" }))
  } catch {
    return []
  }
}

/** 真读数：三份输入都从盘上读；没有产物时把 null 交给纯函数判「判不了」。 */
function readInputs(): ThresholdInputs {
  const read = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(REPO, rel), "utf8")
    } catch {
      return null
    }
  }
  return {
    summary: read(SUMMARY_REL),
    final: read(FINAL_REL),
    exempt: read(EXEMPT_REL) ?? "{}",
  }
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main: () => judgeCoverageThreshold(readInputs()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
