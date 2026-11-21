/**
 * verify-ui-style-contracts 的 spec（ISS-932）——含必然失败反向对照。
 * 由 gate-runtime 的 --selftest 调度，导出 run(): boolean。
 */
import { judgeStyleContracts, type ExpectedExceptions } from "./verify-ui-style-contracts.ts"
import type { StyleFindings } from "../../packages/client/ui-theme/tests/style-contracts-scan.ts"

let fails = 0
const ok = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const expected: ExpectedExceptions = {
  s3: { "apps/web/src/a.css:2": { code: "border-radius:14px", reason: "自测夹具" } },
  s4: {},
  s6: {},
}
const actual: StyleFindings = {
  s3: { "apps/web/src/a.css:2": "border-radius:14px" },
  s4: {},
  s6: {},
}

export function run(): boolean {
  fails = 0
  console.log("verify-ui-style-contracts.spec")

  {
    const r = judgeStyleContracts(actual, expected)
    ok("正例：事实与例外精确相等 ⇒ passed", r.status === "passed")
  }
  {
    const r = judgeStyleContracts({ ...actual, s4: { "apps/web/src/b.css:9": "color:#fff" } }, expected)
    ok("反例：多一条违规 ⇒ failed 且点名", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("b.css:9")))
  }
  {
    const r = judgeStyleContracts({ s3: {}, s4: {}, s6: {} }, expected)
    ok("反例：少一条违规（例外里的违规消失）⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("少了")))
  }
  {
    const r = judgeStyleContracts({ ...actual, s3: { "apps/web/src/a.css:2": "border-radius:18px" } }, expected)
    ok("反例：code 漂移（14px→18px）⇒ failed", r.status === "failed")
  }
  {
    const bad: ExpectedExceptions = {
      s3: { "apps/web/src/a.css:2": { code: "border-radius:14px", reason: "" } },
      s4: {},
      s6: {},
    }
    const r = judgeStyleContracts(actual, bad)
    ok("反例：例外理由为空 ⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("缺理由")))
  }
  {
    const r = judgeStyleContracts(actual, null)
    ok("判不了：例外清单读不到 ⇒ unjudged（不冒绿）", r.status === "unjudged")
  }

  return fails === 0
}
