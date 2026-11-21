/**
 * `verify-layout-manifest` 的 spec（2332 号单）。
 * 正反例：顶层多/少、组级多/少、整组删光、豁免生效、缺输入 unjudged、真仓绿。
 * 每条反例都是「把这次改动删掉会红」的反向对照——只有正例的自检等于没写。
 */
import { EXEMPTIONS, judgeLayout, parseLayout, readTruth, type LayoutInput } from "./verify-layout-manifest.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

/** 造一份只有 Repository layout 的最小 AGENTS.md 文本（缩进行紧跟其父目录，否则会被归到上一个顶格目录）。 */
const text = (top: string[], groups: Record<string, string[]> = {}): string => {
  const body = ["```"]
  for (const t of top) {
    body.push(`${t}/     描述`)
    for (const g of groups[t] ?? []) body.push(`  ${g}/      组描述（父 ${t}）`)
  }
  body.push("```")
  return `# AGENTS.md\n\n## Repository layout\n\n${body.join("\n")}\n`
}
const input = (top: string[], groups: Record<string, string[]> = {}, truthTop = top, truthGroups: Record<string, string[]> = {}): LayoutInput => ({
  layoutText: text(top, groups),
  topDirs: truthTop,
  groupDirs: truthGroups,
})
const details = (r: ReturnType<typeof judgeLayout>) => (r.findings ?? []).map((f) => f.detail).join("\n")

export function run(): boolean {
  fails = 0
  console.log("verify-layout-manifest.spec")

  // ── 正例：一致 ⇒ 绿 ────────────────────────────────────────────────────────
  {
    const r = judgeLayout(input(["packages", "apps", "docs", "scripts", ".agents"], { packages: ["storage", "pm", "kb", "api", "client"] }, ["packages", "apps", "docs", "scripts", ".agents"], { packages: ["api", "client", "kb", "pm", "storage"] }))
    ok("正例：顶层 + 组级一致 ⇒ passed", r.status === "passed")
    ok("正例：detail 报顶层/真值/组级计数", (r.detail ?? "").includes("顶层声明 5 项") && (r.detail ?? "").includes("组级父目录 1 个"))
  }

  // ── 反例①：顶层多一个（幻影）⇒ 红 ─────────────────────────────────────────
  {
    const r = judgeLayout(input(["packages", "apps", "ghost", "docs"], {}, ["packages", "apps", "docs"]))
    ok("反例：顶层多一个 ghost/ ⇒ failed 且点名幻影", r.status === "failed" && details(r).includes("顶层多列 ghost/"))
  }

  // ── 反例②：顶层少一个（apps/ 漏项）⇒ 红 —— 本单核心验收的形态 ──────────────
  {
    const r = judgeLayout(input(["packages", "docs", "scripts"], {}, ["packages", "apps", "docs", "scripts"]))
    ok("反例：顶层漏列 apps/ ⇒ failed 且点名漏项", r.status === "failed" && details(r).includes("顶层漏列 apps/"))
  }

  // ── 反例③：组级多一个（llm/ 幻影）⇒ 红 ────────────────────────────────────
  {
    const r = judgeLayout(input(["packages"], { packages: ["storage", "llm"] }, ["packages"], { packages: ["storage"] }))
    ok("反例：packages/ 组级多列 llm/ ⇒ failed 且点名", r.status === "failed" && details(r).includes("packages/ 组级多列 llm/"))
  }

  // ── 反例④：组级少一个 ⇒ 红 ────────────────────────────────────────────────
  {
    const r = judgeLayout(input(["packages"], { packages: ["storage", "pm"] }, ["packages"], { packages: ["storage", "pm", "kb"] }))
    ok("反例：packages/ 组级漏列 kb/ ⇒ failed 且点名", r.status === "failed" && details(r).includes("packages/ 组级漏列 kb/"))
  }

  // ── 反例⑤：把一组全删光（代码块没有缩进行）也不能绿 —— GROUP_SCOPED 兜底 ──
  {
    const r = judgeLayout(input(["packages"], {}, ["packages"], { packages: ["api", "client", "kb", "pm", "storage"] }))
    ok("反例：整组删光 ⇒ failed（GROUP_SCOPED 兜底）", r.status === "failed" && details(r).includes("组级漏列 api/"))
  }

  // ── 豁免：真值侧有 forge-* 与机器目录，声明侧不列仍绿 ──────────────────────
  {
    const r = judgeLayout(input(["packages", "apps"], {}, ["packages", "apps", "forge-ui", "forge-pm", "node_modules", ".git", "specs"]))
    ok("豁免：forge-* / node_modules / .git / specs 不列 ⇒ passed", r.status === "passed")
    ok("豁免：detail 报豁免计数 5 项（7 项真值里 packages/apps 不在豁免表）", (r.detail ?? "").includes("豁免 5 项"))
  }

  // ── fail-closed 三态 ───────────────────────────────────────────────────────
  {
    const r = judgeLayout({ ...input(["packages"]), layoutText: null })
    ok("缺输入：AGENTS.md 读不到 ⇒ unjudged(no-rule-table)", r.status === "unjudged" && r.reason === "no-rule-table")
  }
  {
    const r = judgeLayout({ ...input(["packages"]), layoutText: "# AGENTS.md\n没有那一章\n" })
    ok("缺输入：没有 Repository layout 章 ⇒ unjudged", r.status === "unjudged" && r.reason === "no-rule-table")
  }
  {
    const r = judgeLayout({ ...input(["packages"]), topDirs: null })
    ok("缺输入：git tree 读不到 ⇒ unjudged(no-baseline)", r.status === "unjudged" && r.reason === "no-baseline")
  }

  // ── 元断言：豁免每条有真理由；解析器认得出 .agents/ 这类点开头目录 ──────────
  ok("解析：顶格 .agents/ 被认出（点开头目录不被正则漏掉）", parseLayout(text([".agents"]))?.top.includes(".agents") === true)
  ok("豁免表：每条 match / why 非空（占位符不算）", EXEMPTIONS.every((e) => e.match.trim().length > 0 && e.why.trim().length > 5))

  // ── 真仓绿：现读 AGENTS.md + git tree，改前/改后一致即绿 ────────────────────
  {
    const r = judgeLayout(readTruth())
    ok("真仓绿：当前 AGENTS.md 与磁盘顶层一致 ⇒ passed", r.status === "passed")
    if (r.status !== "passed") console.log(`   detail=${r.detail ?? ""}\n${details(r)}`)
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（正例 / 顶层反例×2 / 组级反例×3 / 豁免 / 缺输入×3 / 元断言×2 / 真仓绿）")
  return fails === 0
}
