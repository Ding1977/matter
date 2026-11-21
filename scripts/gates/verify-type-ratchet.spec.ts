/**
 * `verify-type-ratchet` 的 spec（ISS-739 / ISS-796）。
 * 纯函数层：分桶 / 硬棘轮 / 环境债只缩 / dry-run 的抬升门槛 / diff / **文件级棘轮**。
 */
import {
  canCommit,
  diffText,
  diffTextFiles,
  groupByFile,
  judgePerFile,
  judgeTypeRatchet,
  splitCodes,
  type Baseline,
  type FileBaseline,
  type PkgDiags,
} from "./verify-type-ratchet.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const bl = (logic: Record<string, number> = {}, env: Record<string, string[]> = {}): Baseline => ({
  recordedAt: "2026-11-09",
  families: { host: { logic, env } },
})
const d = (codes: string[], pkg = "a", family = "host"): PkgDiags => ({ family, pkg, codes })
const fb = (files: Record<string, number> = {}): FileBaseline => ({ recordedAt: "2026-11-10", unit: "logic-errors-per-file", files })

export function run(): boolean {
  fails = 0
  console.log("verify-type-ratchet.spec")

  ok("splitCodes：TS2307 计环境，TS2322 计逻辑", JSON.stringify(splitCodes(["TS2307", "TS2322", "TS2322"])) === JSON.stringify({ logic: 2, env: ["TS2307"] }))

  {
    const r = judgeTypeRatchet([d(["TS2322", "TS2322"])], bl({ a: 1 }))
    ok("反例：逻辑类超上限 ⇒ failed（硬棘轮）", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("逻辑类 2 > 上限 1")))
  }

  {
    const r = judgeTypeRatchet([d(["TS2322"])], bl({ a: 5 }))
    ok("正例：逻辑类低于上限 ⇒ passed", r.status === "passed")
    ok("提示：低于上限 ⇒ 可收线", (r.detail ?? "").includes("可收线"))
  }

  {
    const r = judgeTypeRatchet([d(["TS2322"])], bl({}))
    ok("反例：基线无记录且逻辑类 >0 ⇒ failed", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("基线没有记录")))
  }

  {
    const r = judgeTypeRatchet([d(["TS2322", "TS2307"])], bl({ a: 1 }, { a: [] }))
    ok("反例：新增环境债 ⇒ failed（清单只许缩）", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("新增环境债")))
  }

  {
    const r = judgeTypeRatchet([d(["TS2322"])], bl({ a: 1 }, { a: ["TS2307"] }))
    ok("正例：环境债已摘 ⇒ passed", r.status === "passed")
    ok("提示：环境债已摘", (r.detail ?? "").includes("已摘"))
  }

  {
    const r = judgeTypeRatchet([d([])], null)
    ok("缺输入：基线不存在 ⇒ unjudged（不是绿）", r.status === "unjudged" && r.reason === "no-baseline")
  }

  ok("canCommit：抬升无理由 ⇒ 拒绝", canCommit(bl({ a: 1 }), bl({ a: 3 }), undefined).ok === false)
  ok("canCommit：抬升有理由 ⇒ 允许", canCommit(bl({ a: 1 }), bl({ a: 3 }), "收进内核后接收方多 2 条环境债").ok === true)
  ok("canCommit：无抬升 ⇒ 不需要理由", canCommit(bl({ a: 3 }), bl({ a: 3 }), undefined).ok === true)

  ok("diffText：升降都写出来", diffText(bl({ a: 1 }), bl({ a: 3 })).includes("1 → 3"))

  // ── ISS-796 洞 2：文件级棘轮（四条判据 + 聚合 + 环境类不计数）────────────
  {
    // 任务书 §2.4 四条，逐条钉住
    const base = { "pkg/lib/has.js": 2 }

    // ① 文件不在基线，且有逻辑错 ⇒ 红（新文件零容忍）
    const r1 = judgePerFile({ "pkg/lib/new.js": ["TS2741"] }, base)
    ok("文件级①：新文件有逻辑错 ⇒ 红（新文件零容忍）", r1.findings.some((f) => f.includes("新增文件有 1 条逻辑类错")))

    // ② 文件在基线，错误数 > 记录 ⇒ 红
    const r2 = judgePerFile({ "pkg/lib/has.js": ["TS2741", "TS2322", "TS2322"] }, base)
    ok("文件级②：错误数 3 > 记录 2 ⇒ 红", r2.findings.some((f) => f.includes("逻辑类 3 > 记录 2")))

    // ③ 文件在基线，错误数 < 记录 ⇒ 绿 + 可收线
    const r3 = judgePerFile({ "pkg/lib/has.js": ["TS2741"] }, base)
    ok("文件级③：错误数 1 < 记录 2 ⇒ 无 finding", r3.findings.length === 0)
    ok("文件级③：错误数 1 < 记录 2 ⇒ 提示可收线", r3.hints.some((h) => h.includes("可收线")))

    // ④ 文件在基线，错误数 = 记录 ⇒ 绿且无提示
    const r4 = judgePerFile({ "pkg/lib/has.js": ["TS2741", "TS2322"] }, base)
    ok("文件级④：错误数 = 记录 ⇒ 绿且无提示", r4.findings.length === 0 && r4.hints.length === 0)

    // 环境类不进文件级计数（与包级 splitCodes 同口径）
    const r5 = judgePerFile({ "pkg/lib/new.js": ["TS2307", "TS2591", "TS7016"] }, base)
    ok("文件级：只有环境类（TS2307/TS2591/TS7016）⇒ 不算逻辑错，不判红", r5.findings.length === 0)
  }

  {
    // 洞 2 的**核心场景**：同包内「删 1 条旧错 + 加 1 条新错」⇒ 包级总数不变 ⇒ 包级判绿，文件级必须判红。
    // 这不是理论构造：forge-pm 包级上限 165，实测把一处 channelFail 换成满足类型的字面量、
    // 再往另一个文件加一行类型错，包级复算仍是 165（判绿），文件级抓到 inbox-store.js 10 → 11。
    const pkgBaseline = bl({ a: 2 }) // 包级：a 包总共 2 条
    const perFileBase = fb({ "a/lib/old.js": 1, "a/lib/other.js": 1 })
    // 删掉 old.js 那 1 条，加到 other.js 上 ⇒ 总数还是 2
    const diags: PkgDiags[] = [{ family: "host", pkg: "a", codes: ["TS2741", "TS2322"], byFile: { "a/lib/other.js": ["TS2741", "TS2322"] } }]
    const r = judgeTypeRatchet(diags, pkgBaseline, perFileBase)
    ok("洞2 核心：包级总数不变（2 = 2）", splitCodes(diags[0].codes).logic === 2)
    ok("洞2 核心：文件级抓到 other.js 1 → 2 ⇒ 红（包级挡不住的那一次）", r.status === "failed" && (r.findings ?? []).some((f) => f.detail.includes("other.js") && f.detail.includes("逻辑类 2 > 记录 1")))
  }

  {
    // 有文件级数据却没有文件级基线 ⇒ 判不了（不许冒充绿：那等于这一层默认关着）
    const diags: PkgDiags[] = [{ family: "host", pkg: "a", codes: ["TS2741"], byFile: { "a/lib/x.js": ["TS2741"] } }]
    const r = judgeTypeRatchet(diags, bl({ a: 1 }), null)
    ok("文件级：有数据无基线 ⇒ unjudged（不是绿）", r.status === "unjudged")
  }

  {
    // 没有文件级数据（老调用方只喂 codes）⇒ 跳过文件级，包级照判，不因缺一层就红
    const r = judgeTypeRatchet([d(["TS2322"])], bl({ a: 5 }))
    ok("文件级：无 byFile 数据 ⇒ 跳过该层，包级照判（不误红）", r.status === "passed")
  }

  ok(
    "groupByFile：从 tsc 原始行抽文件→错误码，并拼上包名",
    JSON.stringify(groupByFile(["lib/a.js(1,2): error TS2741: x", "lib/b.js(3,4): error TS2322: y", "lib/a.js(5,6): error TS2322: z"], "forge-x")) ===
      JSON.stringify({ "forge-x/lib/a.js": ["TS2741", "TS2322"], "forge-x/lib/b.js": ["TS2322"] }),
  )
  ok("groupByFile：非错误行（如总结行）被跳过", Object.keys(groupByFile(["Found 3 errors.", "lib/a.js(1,2): error TS2741: x"])).length === 1)

  ok("diffTextFiles：文件级升降都写出来", diffTextFiles(fb({ "a/lib/x.js": 1 }), fb({ "a/lib/x.js": 3 })).includes("1 → 3"))
  ok("diffTextFiles：抬升标 ⛔", diffTextFiles(fb({ "a/lib/x.js": 1 }), fb({ "a/lib/x.js": 3 })).includes("⛔ 抬升"))
  ok("diffTextFiles：无变化 ⇒ 空串", diffTextFiles(fb({ "a/lib/x.js": 2 }), fb({ "a/lib/x.js": 2 })) === "")

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（分桶 / 硬棘轮 / 环境债 / 缺输入 / canCommit×3 / diff / 文件级棘轮四条+聚合）")
  return fails === 0
}
