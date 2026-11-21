/**
 * flow-metrics —— Matter 流程指标基线观测（**观测器 + 判据自身**，2026-11-16）。
 *
 * ## 它判什么
 *
 * 这个门禁**不判流程好坏**——那是老板与趋势的事。它判的是**观测器自己有没有坏**：
 *   ① 判不了时必须 exit 2（删掉 Matter 目录就永久变绿，是这类观测器最常见的腐烂方式）
 *   ② 0 条可核时不得报 100%（「没数据」被算成「全过」是第二常见的腐烂方式）
 *   ③ 停留时长必须计入**前一个**状态（算在后一个上会让瓶颈看起来在错的阶段）
 *
 * ## 为什么需要它
 *
 * `specs/iss-flow-gates-spec-2026-11-14.md` 定义了七态 × 十动作 × 36 条每跳门禁，
 * 但没有任何东西在量「这些门禁有没有真的拦住东西」。现有 skill 只能统计「被调用几次」，
 * 测不出流程是否执行。
 *
 * 2026-11-16 首测基线（Matter 2196 单）：
 *   · 记账覆盖率 **42.3%**（929 单有 ≥2 次状态记录）⇒ 其余指标当前测的是**记账质量**
 *   · 非法跳转 **13.6%**（164/1202），最高频是 `in_progress>done` 40 次
 *   · 审查退回率 **8.1%**（15/185）
 *   · 证据完整率 **78.5%**（缺 185 单）
 *
 * ## 为什么是「观测器」而不是「闸」
 *
 * 存量数据本来就不合规（12.9% 非法跳转、42% 无状态流）。若一上线就判红，
 * 等于把历史债务记在今天的收口者头上——`K8e` 明令禁止这类判据。
 * 所以主判据恒 passed，只把数字印出来；真正的闸留给「指标变好之后」再立。
 *
 * @module scripts/gates/flow-metrics
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

/** 七个合法状态，与 `plugins/matter/mcp/matter-mcp.mjs` 的 STATE_FLOW 同源。 */
export const STATES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled", "duplicate"] as const

/**
 * spec 允许的状态跳转。`in_review → in_progress` 是审查退回：合法，但单列统计。
 * 首次记录（单的初始状态）不参与合法性判断——它没有前驱。
 */
export const LEGAL = new Set([
  "backlog>todo",
  "todo>in_progress",
  "in_progress>in_review",
  "in_review>done",
  "in_review>in_progress",
  "backlog>canceled",
  "todo>canceled",
  "in_progress>canceled",
  "in_review>canceled",
  "backlog>duplicate",
  "todo>duplicate",
  "in_progress>duplicate",
  "in_review>duplicate",
])

export interface Transition {
  at: Date | null
  to: string
}

export interface IssueTimeline {
  id: string
  transitions: Transition[]
}

export interface MetricsInput {
  issues: IssueTimeline[]
  /** 单 id → 正文是否同时含自检段与时间戳。只有进过 in_review 的单才该有此键。 */
  evidenceByIssue?: Map<string, boolean>
}

/** 四类指标。所有比例在分母为 0 时返回 null，**不返回 100**。 */
export interface FlowMetrics {
  coverage: { issuesTotal: number; issuesWithTrail: number; trailRate: number | null }
  compliance: {
    transitions: number
    illegal: number
    illegalRate: number | null
    illegalDetail: { hop: string; count: number }[]
  }
  review: {
    entries: number
    returns: number
    returnRate: number | null
    dwellHoursMedian: number | null
    dwellHoursMean: number | null
  }
  dwellHoursByState: Record<string, number>
  evidence: { checked: number; missing: number; missingIds: string[]; completeRate: number | null }
}

function pct(n: number, d: number): number | null {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

/**
 * 主计算。纯函数，spec 直接喂构造数据。
 * @param input - 每个单的状态时间线与证据可核性
 * @returns 四类指标
 */
export function computeMetrics(input: MetricsInput): FlowMetrics {
  const evidenceByIssue = input.evidenceByIssue ?? new Map<string, boolean>()

  let transitions = 0
  let illegal = 0
  let reviewReturns = 0
  let reviewEntries = 0
  let issuesWithTrail = 0
  const dwell = new Map<string, number>(STATES.map(s => [s, 0]))
  const reviewDwell: number[] = []
  const illegalDetail = new Map<string, number>()
  // 用 Set 而不是数组：同一张单可能多次进入 in_review，重复 push 会让
  // 「缺证据数」超过「可核数」，算出负的完整率（实测踩到 -1.7%）。
  const evidenceMissing = new Set<string>()

  for (const issue of input.issues) {
    const tr = issue.transitions
    if (tr.length === 0) continue
    if (tr.length >= 2) issuesWithTrail++

    // 首条记录是初始状态：不判合法性，但仍可能已经是 in_review（单未入系统前就在该态）。
    let prev = tr[0]!.to
    if (prev === "in_review") {
      reviewEntries++
      if (evidenceByIssue.get(issue.id) === false) evidenceMissing.add(issue.id)
    }

    for (let i = 1; i < tr.length; i++) {
      const cur = tr[i]!
      transitions++
      const hop = `${prev}>${cur.to}`
      if (!LEGAL.has(hop)) {
        illegal++
        illegalDetail.set(hop, (illegalDetail.get(hop) ?? 0) + 1)
      }
      if (prev === "in_review" && cur.to === "in_progress") reviewReturns++
      if (cur.to === "in_review") {
        reviewEntries++
        if (evidenceByIssue.get(issue.id) === false) evidenceMissing.add(issue.id)
      }
      prev = cur.to
    }

    // 停留时长计入**前一个**状态：从 A 到 B 的间隔属于 A 的停留。
    for (let i = 0; i < tr.length - 1; i++) {
      const from = tr[i]!.at
      const to = tr[i + 1]!.at
      if (from === null || to === null) continue
      const hours = (to.getTime() - from.getTime()) / 3_600_000
      if (hours < 0) continue
      const state = tr[i]!.to
      dwell.set(state, (dwell.get(state) ?? 0) + hours)
      if (state === "in_review") reviewDwell.push(hours)
    }
  }

  const dwellHoursByState: Record<string, number> = {}
  for (const [state, hours] of dwell) dwellHoursByState[state] = Math.round(hours)

  return {
    coverage: {
      issuesTotal: input.issues.length,
      issuesWithTrail,
      trailRate: pct(issuesWithTrail, input.issues.length),
    },
    compliance: {
      transitions,
      illegal,
      illegalRate: pct(illegal, transitions),
      illegalDetail: [...illegalDetail.entries()]
        .map(([hop, count]) => ({ hop, count }))
        .sort((a, b) => b.count - a.count),
    },
    review: {
      entries: reviewEntries,
      returns: reviewReturns,
      returnRate: pct(reviewReturns, reviewEntries),
      dwellHoursMedian: median(reviewDwell),
      dwellHoursMean: reviewDwell.length === 0
        ? null
        : Math.round(reviewDwell.reduce((a, b) => a + b, 0) / reviewDwell.length),
    },
    dwellHoursByState,
    evidence: {
      checked: evidenceByIssue.size,
      missing: evidenceMissing.size,
      missingIds: [...evidenceMissing].slice(0, 20),
      completeRate: pct(evidenceByIssue.size - evidenceMissing.size, evidenceByIssue.size),
    },
  }
}

/** 解析一个 activity 侧车的 `---\n…\n---` 块序列。 */
function parseBlocks(text: string): { event?: string; at?: string; to?: string }[] {
  const out: { event?: string; at?: string; to?: string }[] = []
  const re = /---\r?\n([\s\S]*?)\r?\n---/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = m[1]!
    const get = (key: string) => {
      const mm = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(body)
      return mm ? mm[1]!.trim() : undefined
    }
    out.push({ event: get("event"), at: get("at"), to: get("to") })
  }
  return out
}

function parseTime(value?: string): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 从 Matter 根读单据与活动侧车。返回 error 字符串表示输入不可用（⇒ unjudged）。 */
export function readMatter(home: string): { issues: IssueTimeline[]; evidenceByIssue: Map<string, boolean> } | { error: string } {
  const issuesDir = path.join(home, "pm", "issues")
  if (!fs.existsSync(issuesDir)) return { error: `找不到 issues 目录：${issuesDir}` }

  const files = fs.readdirSync(issuesDir)
  const mains = files.filter(f => f.endsWith(".md") && !f.endsWith("-activity.md") && !f.endsWith("-comments.md"))
  const issues: IssueTimeline[] = []
  const evidenceByIssue = new Map<string, boolean>()

  for (const f of mains) {
    const id = f.replace(/\.md$/, "")
    const activityPath = path.join(issuesDir, `${id}-activity.md`)
    let transitions: Transition[] = []
    if (fs.existsSync(activityPath)) {
      transitions = parseBlocks(fs.readFileSync(activityPath, "utf8"))
        .filter(b => b.event === "status-change" && b.to !== undefined)
        .map(b => ({ at: parseTime(b.at), to: b.to! }))
        // 时间戳缺失的记录夹在中间会切断停留计算；保留它参与顺序判断。
        .sort((a, b) => (a.at === null || b.at === null ? 0 : a.at.getTime() - b.at.getTime()))
    }
    issues.push({ id, transitions })

    if (transitions.some(t => t.to === "in_review")) {
      const body = fs.readFileSync(path.join(issuesDir, f), "utf8")
      const hasSelfCheck = /##\s*自检|自检六段|selfcheck/i.test(body)
      const hasTimestamp = /\b20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(body)
      evidenceByIssue.set(id, hasSelfCheck && hasTimestamp)
    }
  }
  return { issues, evidenceByIssue }
}

/** 人读报告。 */
export function render(m: FlowMetrics, home: string): string {
  const L: string[] = []
  const p = (s: string) => L.push(s)
  p(`Matter 流程指标 · ${home}`)
  p("=".repeat(56))
  p("")
  p("【覆盖率】先看这个——它决定其余指标可不可信")
  p(`  单据总数              ${m.coverage.issuesTotal}`)
  p(`  有完整状态流(≥2 次)   ${m.coverage.issuesWithTrail}`)
  p(`  记账覆盖率            ${m.coverage.trailRate ?? "n/a"}%`)
  p("")
  p("【合规】")
  p(`  状态跳转总数          ${m.compliance.transitions}`)
  p(`  非法跳转              ${m.compliance.illegal}（${m.compliance.illegalRate ?? "n/a"}%）`)
  for (const d of m.compliance.illegalDetail.slice(0, 8)) {
    p(`    ${String(d.count).padStart(5)}  ${d.hop}`)
  }
  p("")
  p("【审查】")
  p(`  进入 in_review 次数   ${m.review.entries}`)
  p(`  审查退回次数          ${m.review.returns}（退回率 ${m.review.returnRate ?? "n/a"}%）`)
  p(`  in_review 停留中位数  ${m.review.dwellHoursMedian === null ? "n/a" : Math.round(m.review.dwellHoursMedian)} 小时`)
  p(`  in_review 停留均值    ${m.review.dwellHoursMean ?? "n/a"} 小时`)
  p("")
  p("【时间分布】各状态累计停留（小时）")
  for (const s of STATES) {
    const h = m.dwellHoursByState[s] ?? 0
    if (h > 0) p(`  ${s.padEnd(14)}${String(h).padStart(10)}`)
  }
  p("")
  p("【证据】进 in_review 时正文有自检段 + 时间戳")
  p(`  可核单据              ${m.evidence.checked}`)
  p(`  缺证据                ${m.evidence.missing}`)
  p(`  完整率                ${m.evidence.completeRate ?? "n/a"}%`)
  p("")
  p("  ⚠️ 这个数字接近 0 是**真实值**，不是判据坏了：")
  p("     `## 自检` 段是 spec §4.8 在 2026-11-14 才立的规矩，")
  p("     之前 2000+ 张单里几乎没有一张写过它。它测的是「新规矩落地率」，")
  p("     不是「历史单质量」。存量不追溯（spec §〇），所以它只能看趋势。")
  if (m.evidence.missingIds.length > 0) p(`  样例：${m.evidence.missingIds.slice(0, 5).join(", ")}`)
  p("")
  p("=".repeat(56))
  p("判读：覆盖率 <80% 时，其余指标测的是「记账质量」，不是「流程质量」。")
  return L.join("\n")
}

/** 默认 Matter 根：`$DSH_HOME` 或 `~/.dsh-matter`。 */
function defaultHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh-matter")
}

if (isMain(import.meta.url)) {
  // 用 .then 而不是顶层 await：顶层 await 会让 `--selftest` 的模块加载挂住
  // （`runGate` 走 `--selftest` 分支时不需要 main，但顶层 await 仍会先执行）。
  const home = (() => {
    const i = process.argv.indexOf("--home")
    return i >= 0 ? process.argv[i + 1]! : defaultHome()
  })()
  const asJson = process.argv.includes("--json")

  void runGate({
    name: "flow-metrics",
    main: (): GateResult => {
      const data = readMatter(home)
      if ("error" in data) {
        return unjudged("flow-metrics", "no-home", data.error)
      }
      const m = computeMetrics(data)
      // 观测器：恒 passed，把数字印进 detail。真正的闸等指标变好之后再立。
      return {
        gate: "flow-metrics",
        status: "passed",
        detail: asJson
          ? JSON.stringify({ home, ...m }, null, 2)
          : render(m, home),
      }
    },
  }).then((code) => {
    process.exitCode = code
  }).catch((e: unknown) => {
    console.error(`✗ flow-metrics: ${(e as Error).message}`)
    process.exitCode = 2
  })
}
