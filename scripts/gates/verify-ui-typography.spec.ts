/**
 * verify-ui-typography 的 spec（ISS-907）——含必然失败反向对照。
 * 由 gate-runtime 的 --selftest 调度，导出 run(): boolean。
 */
import { judgeTypography, type ExpectedExceptions } from "./verify-ui-typography.ts"
import type { ScanFindings } from "../../packages/client/ui-theme/tests/typography-scan.ts"

let fails = 0
const ok = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const expected: ExpectedExceptions = {
  s1: { "apps/web/src/a.tsx:2": { code: "h2", reason: "设计批待修" } },
  s2: {},
}
const actual: ScanFindings = { s1: { "apps/web/src/a.tsx:2": "h2" }, s2: {} }

export function run(): boolean {
  fails = 0
  console.log("verify-ui-typography.spec")

  {
    const r = judgeTypography(actual, expected)
    ok("正例：事实与例外精确相等 ⇒ passed", r.status === "passed")
  }
  {
    const r = judgeTypography({ s1: { ...actual.s1, "apps/web/src/b.tsx:9": "h3" }, s2: {} }, expected)
    ok("反例：多一条违规 ⇒ failed 且点名", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("b.tsx:9")))
  }
  {
    const r = judgeTypography({ s1: {}, s2: {} }, expected)
    ok("反例：少一条违规（例外里的违规消失）⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("少了")))
  }
  {
    const r = judgeTypography({ s1: { "apps/web/src/a.tsx:2": "h3" }, s2: {} }, expected)
    ok("反例：code 漂移（h2→h3）⇒ failed", r.status === "failed")
  }
  {
    const bad: ExpectedExceptions = { s1: { "apps/web/src/a.tsx:2": { code: "h2", reason: "" } }, s2: {} }
    const r = judgeTypography(actual, bad)
    ok("反例：例外理由为空 ⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("缺理由")))
  }
  {
    const r = judgeTypography(actual, null)
    ok("判不了：例外清单读不到 ⇒ unjudged（不冒绿）", r.status === "unjudged")
  }

  return fails === 0
}
