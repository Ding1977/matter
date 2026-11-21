/**
 * flow-metrics 判据自身（2026-11-16）。
 *
 * 这条判据守的是**观测器自己**：它恒 passed，所以写错了没人会发现。
 * 唯一能守住它的就是「喂构造数据，断言数字」。
 *
 * 五组断言：
 *   ① 顺序合法性（合法链路不判非法 / 跳步判非法 / 退回单列）
 *   ② 停留时长计入**前一个**状态
 *   ③ 覆盖率按「≥2 次记录」计，无状态流的单不计入跳转
 *   ④ 分母为 0 时报 null 而非 100
 *   ⑤ 判不了时返回 unjudged（不是 passed）
 *
 * 变异实测（写这条 spec 时真抓到一次）：初版 reviewEntries 只数循环内的跳转，
 * 漏掉「首条记录已是 in_review」的单 ⇒ 退回率分母偏小。本 spec 第 3 组即为该变异。
 *
 * @module scripts/gates/flow-metrics.spec
 */
import assert from "node:assert/strict"
import { computeMetrics, readMatter, STATES } from "./flow-metrics.ts"

const T = (iso: string) => new Date(iso)

/** 一条合法全链路：backlog → todo → in_progress → in_review → done。 */
function legalChain(id: string) {
  return {
    id,
    transitions: [
      { at: T("2026-01-01T00:00:00Z"), to: "backlog" },
      { at: T("2026-01-01T01:00:00Z"), to: "todo" },
      { at: T("2026-01-01T02:00:00Z"), to: "in_progress" },
      { at: T("2026-01-01T03:00:00Z"), to: "in_review" },
      { at: T("2026-01-01T04:00:00Z"), to: "done" },
    ],
  }
}

export function run(): boolean {
  let pass = 0
  const failures: string[] = []
  const check = (name: string, fn: () => void) => {
    try {
      fn()
      pass++
    } catch (e) {
      failures.push(`${name}\n    ${(e as Error).message}`)
    }
  }

  // ── ① 顺序合法性 ──────────────────────────────────────────────────
  check("合法链路不计非法，首条记录不参与跳转计数", () => {
    const m = computeMetrics({ issues: [legalChain("ISS-1")] })
    assert.equal(m.compliance.illegal, 0, `非法数应为 0，实际 ${m.compliance.illegal}`)
    assert.equal(m.compliance.transitions, 4, `跳转数应为 4（5 条记录 - 1 首条），实际 ${m.compliance.transitions}`)
  })

  check("跳步 backlog→done 判非法", () => {
    const m = computeMetrics({
      issues: [{
        id: "ISS-2",
        transitions: [
          { at: T("2026-01-01T00:00:00Z"), to: "backlog" },
          { at: T("2026-01-01T01:00:00Z"), to: "done" },
        ],
      }],
    })
    assert.equal(m.compliance.illegal, 1)
    assert.equal(m.compliance.illegalDetail[0]!.hop, "backlog>done")
  })

  check("审查退回 in_review→in_progress 合法，但计入退回率", () => {
    const m = computeMetrics({
      issues: [{
        id: "ISS-3",
        transitions: [
          { at: T("2026-01-01T00:00:00Z"), to: "in_progress" },
          { at: T("2026-01-01T01:00:00Z"), to: "in_review" },
          { at: T("2026-01-01T02:00:00Z"), to: "in_progress" },
          { at: T("2026-01-01T03:00:00Z"), to: "in_review" },
        ],
      }],
    })
    assert.equal(m.compliance.illegal, 0, "退回不判非法")
    assert.equal(m.review.returns, 1, "退回 1 次")
    assert.equal(m.review.entries, 2, "进入 in_review 2 次")
    assert.equal(m.review.returnRate, 50)
  })

  // ── ② 停留时长方向 ────────────────────────────────────────────────
  check("停留时长计入前一个状态（不是后一个）", () => {
    const m = computeMetrics({
      issues: [{
        id: "ISS-4",
        transitions: [
          { at: T("2026-01-01T00:00:00Z"), to: "in_progress" },
          { at: T("2026-01-01T10:00:00Z"), to: "in_review" },
          { at: T("2026-01-01T12:00:00Z"), to: "done" },
        ],
      }],
    })
    assert.equal(m.dwellHoursByState.in_progress, 10, "in_progress 停 10 小时")
    assert.equal(m.dwellHoursByState.in_review, 2, "in_review 停 2 小时")
  })

  check("时间戳缺失不参与时长，但仍参与顺序判断", () => {
    const m = computeMetrics({
      issues: [{
        id: "ISS-5",
        transitions: [
          { at: T("2026-01-01T00:00:00Z"), to: "backlog" },
          { at: null, to: "done" },
        ],
      }],
    })
    assert.equal(m.compliance.illegal, 1, "缺时间戳的跳步仍判非法")
    assert.equal(m.dwellHoursByState.backlog, 0, "缺时间戳不计时长")
  })

  // ── ③ 覆盖率口径（这条守的是真实踩过的变异）───────────────────────
  check("首条记录已是 in_review 时，入口计数不漏", () => {
    const m = computeMetrics({
      issues: [{
        id: "ISS-6",
        transitions: [
          { at: T("2026-01-01T00:00:00Z"), to: "in_review" },
          { at: T("2026-01-01T01:00:00Z"), to: "in_progress" },
        ],
      }],
    })
    assert.equal(m.review.entries, 1, "首条 in_review 必须计入入口（初版此处漏计）")
    assert.equal(m.review.returns, 1)
  })

  check("无状态流的单计入总数但不计入跳转", () => {
    const m = computeMetrics({ issues: [{ id: "ISS-7", transitions: [] }] })
    assert.equal(m.coverage.issuesTotal, 1)
    assert.equal(m.coverage.issuesWithTrail, 0)
    assert.equal(m.compliance.transitions, 0)
  })

  check("覆盖率按 ≥2 次记录计", () => {
    const m = computeMetrics({
      issues: [
        {
          id: "ISS-8",
          transitions: [
            { at: T("2026-01-01T00:00:00Z"), to: "todo" },
            { at: T("2026-01-01T01:00:00Z"), to: "in_progress" },
          ],
        },
        { id: "ISS-9", transitions: [] },
      ],
    })
    assert.equal(m.coverage.issuesWithTrail, 1)
    assert.equal(m.coverage.trailRate, 50)
  })

  // ── ④ 分母为 0 不得报 100% ────────────────────────────────────────
  check("无证据可核时 completeRate 为 null（不是 100）", () => {
    const m = computeMetrics({ issues: [{ id: "ISS-10", transitions: [] }] })
    assert.equal(m.evidence.completeRate, null, "0 条可核不得报 100%")
  })

  check("无跳转时 illegalRate 为 null（不是 0%）", () => {
    const m = computeMetrics({ issues: [{ id: "ISS-11", transitions: [] }] })
    assert.equal(m.compliance.illegalRate, null, "无分母时不得报 0%")
  })

  check("进 in_review 但证据缺失的单被点名", () => {
    const m = computeMetrics({
      issues: [
        {
          id: "ISS-12",
          transitions: [
            { at: T("2026-01-01T00:00:00Z"), to: "in_progress" },
            { at: T("2026-01-01T01:00:00Z"), to: "in_review" },
          ],
        },
        {
          id: "ISS-13",
          transitions: [
            { at: T("2026-01-01T00:00:00Z"), to: "in_progress" },
            { at: T("2026-01-01T01:00:00Z"), to: "in_review" },
          ],
        },
      ],
      evidenceByIssue: new Map([["ISS-12", false], ["ISS-13", true]]),
    })
    assert.equal(m.evidence.missing, 1)
    assert.equal(m.evidence.missingIds[0], "ISS-12")
    assert.equal(m.evidence.completeRate, 50)
  })

  // ── ⑤ 判不了不当绿 ────────────────────────────────────────────────
  check("Matter 根不存在时 readMatter 返回 error（⇒ unjudged，不是 passed）", () => {
    const r = readMatter("/nonexistent-flow-metrics-spec-root")
    assert.ok("error" in r, "缺 issues 目录必须返回 error")
    assert.match((r as { error: string }).error, /issues/, "error 必须说明缺什么")
  })

  // ── 输出 ──────────────────────────────────────────────────────────
  if (failures.length > 0) {
    console.error(failures.map(f => `✗ ${f}`).join("\n"))
    console.error(`✗ flow-metrics 判据自身：${pass} 过 / ${failures.length} 失败`)
    return false
  }
  console.log(`✓ flow-metrics 判据自身：${pass} 条全过（七态 ${STATES.length} 个 / 含 0 分母不报 100% / 含首条 in_review 不漏计）`)
  return true
}
