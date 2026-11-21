/**
 * `verify-doc-budgets` 的 spec（ISS-741）。
 * 超限 / 未超 / 缺文件 / 缺清单 / target 提示 / 写清单的理由门槛。
 */
import { canWrite, judgeDocBudgets, type DocFile, type Manifest } from "./verify-doc-budgets.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const m = (limits: Manifest["limits"]): Manifest => ({ recordedAt: "2026-11-09", unit: "bytes", limits })
const f = (p: string, bytes: number | null): DocFile => ({ path: p, bytes })

export function run(): boolean {
  fails = 0
  console.log("verify-doc-budgets.spec")

  {
    const r = judgeDocBudgets([f("a.md", 900)], m({ "a.md": { limit: 1000 } }))
    ok("正例：未超上限 ⇒ passed", r.status === "passed")
    ok("提示：低于上限 ⇒ 可收线", (r.detail ?? "").includes("可收线"))
  }

  {
    const r = judgeDocBudgets([f("a.md", 1100)], m({ "a.md": { limit: 1000 } }))
    ok("反例：超上限 ⇒ failed 且点名", r.status === "failed" && (r.findings ?? []).some((x) => x.detail.includes("a.md")) && (r.findings ?? []).some((x) => x.detail.includes("1100")))
  }

  {
    const r = judgeDocBudgets([f("a.md", null)], m({ "a.md": { limit: 1000 } }))
    ok("反例：常驻文档缺失 ⇒ failed", r.status === "failed" && (r.findings ?? []).some((x) => x.detail.includes("不存在")))
  }

  {
    const r = judgeDocBudgets([f("a.md", 900)], null)
    ok("缺输入：清单不存在 ⇒ unjudged（不是绿）", r.status === "unjudged" && r.reason === "no-baseline")
  }

  {
    const r = judgeDocBudgets([f("a.md", 31658)], m({ "a.md": { limit: 31658, target: 27000 } }))
    ok("target 只提示：超 target 仍 passed", r.status === "passed")
    ok("target 提示给出差额", (r.detail ?? "").includes("4658"))
  }

  ok("canWrite：空理由 ⇒ 拒", canWrite(undefined).ok === false && canWrite("  ").ok === false)
  ok("canWrite：占位符 ⇒ 拒", canWrite("待补").ok === false && canWrite("TODO").ok === false)
  ok("canWrite：真理由 ⇒ 过", canWrite("project-code-rules 从 31,658 收到 31,000，删 §12 事故档").ok === true)

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（正例 / 反例×2 / 缺输入 / target / canWrite×3）")
  return fails === 0
}
