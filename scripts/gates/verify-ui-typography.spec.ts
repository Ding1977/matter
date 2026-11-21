/**
 * verify-ui-typography 的 spec（ISS-907）——含必然失败反向对照。
 * 由 gate-runtime 的 --selftest 调度，导出 run(): boolean。
 */
import { judgeTypography, type ExpectedExceptions } from "./verify-ui-typography.ts"
import { headingWeightFindings, type ScanFindings } from "../../packages/client/ui-theme/tests/typography-scan.ts"

let fails = 0
const ok = (name: string, cond: boolean): void => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const expected: ExpectedExceptions = {
  s1: { "apps/web/src/a.tsx:2": { code: "h2", reason: "设计批待修" } },
  s2: {},
  s3: {},
}
const actual: ScanFindings = { s1: { "apps/web/src/a.tsx:2": "h2" }, s2: {}, s3: {} }

export function run(): boolean {
  fails = 0
  console.log("verify-ui-typography.spec")

  {
    const r = judgeTypography(actual, expected)
    ok("正例：事实与例外精确相等 ⇒ passed", r.status === "passed")
  }
  {
    const r = judgeTypography({ s1: { ...actual.s1, "apps/web/src/b.tsx:9": "h3" }, s2: {}, s3: {} }, expected)
    ok("反例：多一条违规 ⇒ failed 且点名", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("b.tsx:9")))
  }
  {
    const r = judgeTypography({ s1: {}, s2: {}, s3: {} }, expected)
    ok("反例：少一条违规（例外里的违规消失）⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("少了")))
  }
  {
    const r = judgeTypography({ s1: { "apps/web/src/a.tsx:2": "h3" }, s2: {}, s3: {} }, expected)
    ok("反例：code 漂移（h2→h3）⇒ failed", r.status === "failed")
  }
  {
    const bad: ExpectedExceptions = { s1: { "apps/web/src/a.tsx:2": { code: "h2", reason: "" } }, s2: {}, s3: {} }
    const r = judgeTypography(actual, bad)
    ok("反例：例外理由为空 ⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("缺理由")))
  }
  {
    const r = judgeTypography(actual, null)
    ok("判不了：例外清单读不到 ⇒ unjudged（不冒绿）", r.status === "unjudged")
  }

  // S3【reviewer 洞】：h2 用未声明 weight 的 title 类 ⇒ 红；死代码 .columnTitle 不能冒充修复。
  {
    const ts = [{ rel: "apps/web/src/_mut.tsx", text: 'createElement("h2", { className: css.title }, "hi")' }]
    const bare = headingWeightFindings(ts, [{ rel: "apps/web/src/_mut.module.css", text: ".title { font-size: 18px }" }])
    const r = judgeTypography({ ...actual, s3: bare }, expected)
    ok("反例：h2 用未声明 font-weight 的 .title ⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes(".title 缺 font-weight")))
  }
  {
    const ts = [{ rel: "apps/web/src/_mut.tsx", text: 'createElement("h2", { className: css.title }, "hi")' }]
    const css = ".title { font-size: 18px }\n.columnTitle { font-size: 18px; font-weight: 600 }"
    const bare = headingWeightFindings(ts, [{ rel: "apps/web/src/_mut.module.css", text: css }])
    const r = judgeTypography({ ...actual, s3: bare }, expected)
    ok("反例：另写带 600 的 .columnTitle 但 h2 仍用裸 .title（死代码假象）⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes(".title 缺 font-weight")))
  }
  {
    const ts = [{ rel: "apps/web/src/_mut.tsx", text: 'createElement("h2", { className: css.title }, "hi")' }]
    const fixed = headingWeightFindings(ts, [{ rel: "apps/web/src/_mut.module.css", text: ".title { font-size: 18px; font-weight: 600 }" }])
    const r = judgeTypography({ ...actual, s3: fixed }, expected)
    ok("正例：.title 显式声明 600 ⇒ passed", r.status === "passed")
  }

  return fails === 0
}
