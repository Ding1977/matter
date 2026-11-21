/**
 * `verify-file-size` 的 spec（ISS-738）。
 * 四类用例：正例 / 反例 / 干扰（exempt 与边界）/ 缺输入。
 */
import { countLines, judgeFileSize, type FileSizeBaseline } from "./verify-file-size.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const base = (over: Partial<FileSizeBaseline> = {}): FileSizeBaseline => ({
  recordedAt: "2026-11-09",
  unit: "lines-per-file",
  ceiling: {},
  exempt: {},
  ...over,
})

export function run(): boolean {
  fails = 0
  console.log("verify-file-size.spec")

  {
    const r = judgeFileSize([{ path: "a.ts", lines: 1200 }], base())
    ok("反例：不在册且 >1000 ⇒ failed 且点名", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("a.ts")))
  }

  {
    const r = judgeFileSize([{ path: "a.ts", lines: 1500 }], base({ ceiling: { "a.ts": 1600 } }))
    ok("正例：在册且低于记录值 ⇒ passed", r.status === "passed")
    ok("提示：低于记录值 ⇒ 可收线", (r.detail ?? "").includes("可收线"))
  }

  {
    const r = judgeFileSize([{ path: "a.ts", lines: 1500 }], base({ ceiling: { "a.ts": 1400 } }))
    ok("反例：在册且超记录值 ⇒ failed（入册不等于免死）", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("只许降不许升")))
  }

  {
    // 转 full+ci 前的阳性对照（ISS-772）：涨 1 行就必须红 —— 边界上不许有「四舍五入」的空间。
    const r = judgeFileSize([{ path: "a.ts", lines: 2060 }], base({ ceiling: { "a.ts": 2059 } }))
    ok("反例：已入册文件只涨 1 行 ⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("只许降不许升")))
  }

  {
    const r = judgeFileSize([{ path: "a.ts", lines: 900 }], base({ ceiling: { "a.ts": 950 } }))
    ok("正例：在册且 ≤1000 ⇒ passed", r.status === "passed")
    ok("提示：≤1000 ⇒ 可摘条目", (r.detail ?? "").includes("可摘"))
  }

  {
    const r = judgeFileSize([{ path: "a.ts", lines: 1000 }], base())
    ok("边界：恰好 1000 且不在册 ⇒ passed（不判新 god module）", r.status === "passed")
  }

  {
    const r = judgeFileSize(
      [{ path: "big.ts", lines: 5000 }],
      base({ exempt: { "big.ts": { why: "渲染引擎单文件，拆分需重构坐标系", ticket: "ISS-623" } } }),
    )
    ok("干扰：exempt 带 why+ticket ⇒ 不判（即使 5000 行）", r.status === "passed")
  }

  {
    const r = judgeFileSize([{ path: "big.ts", lines: 5000 }], base({ exempt: { "big.ts": { why: "x", ticket: "" } } }))
    ok("反例：exempt 缺 ticket ⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("exempt 缺 why 或 ticket")))
  }

  {
    const r = judgeFileSize([{ path: "a.ts", lines: 1 }], null)
    ok("缺输入：基线不存在 ⇒ unjudged（不是绿）", r.status === "unjudged" && r.reason === "no-baseline")
  }

  ok("countLines：空文件 = 0", countLines("") === 0)
  ok("countLines：无尾换行", countLines("a\nb") === 2)
  ok("countLines：有尾换行不多算", countLines("a\nb\n") === 2)

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（正例×2 / 反例×4 / 干扰×1 / 缺输入 / countLines×3）")
  return fails === 0
}
