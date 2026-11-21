/**
 * `verify-public-wash-mapping` 的 spec（ISS-904）。
 * 正例 + 三章各自的反向用例（破坏可解析 / 破坏 append-only / 覆盖缺 token），
 * 外加「main 可含 mapping 没有的历史 token 不误报」与「appended 重排即红」。
 */
import { appendOnlyProblems, judgeWashMapping, shapeProblems, type WashMappingInput } from "./verify-public-wash-mapping.ts"

/**
 * 夹具假 token（2332 号单）：源码里不写 9999/9998 号段的 token 字面量，避免洗脱扫描
 * `ISS|PRJ-[1-9][0-9]{3,}` 把它们当成真实 4+ token 而要求新增映射、吃掉真实小号段。
 * 已占的两个小号（9999→926 / 9998→931）保留在基线（append-only），此处只停止新增。
 */
const FIXTURE_9999 = ["ISS", "9999"].join("-")
const FIXTURE_9998 = ["ISS", "9998"].join("-")

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

/** 造一份最小合法 doc：legacy 2 条（ISS-501/502）+ appended 1 条（ISS-503）。 */
const doc = () => ({
  rule: "test",
  legacy_distinct_tokens: 2,
  distinct_tokens: 3,
  next_small_id: 504,
  small_existing_numbers: [1, 2, 90],
  appended: [{ token: FIXTURE_9999, to: "ISS-503", batch: "ISS-904", occurrences: 4 }],
  mapping: { "ISS-545": "ISS-501", "ISS-546": "ISS-502", [FIXTURE_9999]: "ISS-503" },
})
const input = (d: ReturnType<typeof doc>, tokens: string[]): WashMappingInput => ({ doc: d, mainTokens: tokens })
const findings = (r: ReturnType<typeof judgeWashMapping>) => (r.findings ?? []).map((f) => f.detail).join("\n")

export function run(): boolean {
  fails = 0
  console.log("verify-public-wash-mapping.spec")

  // ── 正例 ────────────────────────────────────────────────────────────────────
  {
    const r = judgeWashMapping(input(doc(), ["ISS-545", "ISS-546", FIXTURE_9999]))
    ok("正例：三章齐 ⇒ passed", r.status === "passed")
    ok("正例：detail 报三章计数", (r.detail ?? "").includes("legacy 2 + appended 1") && (r.detail ?? "").includes("main token 3 个"))
  }

  // ── 可解析（结构） ──────────────────────────────────────────────────────────
  {
    const d = doc() as Record<string, unknown>; delete d.mapping
    ok("可解析：缺 mapping ⇒ unjudged(no-rule-table)", shapeProblems(d).length > 0 && judgeWashMapping(input(d as ReturnType<typeof doc>, [])).status === "unjudged")
  }
  {
    const d = doc() as Record<string, unknown>; (d.mapping as Record<string, string>)["ISS-545"] = "ISS-917"
    ok("可解析：value 超 3 位不再小号段 ⇒ 结构破", shapeProblems(d).some((p) => p.includes("小号段")))
  }
  {
    // ISS-930：目标重复归 append 规则管（全局唯一），判红而不是结构判不了。
    const d = doc() as Record<string, unknown>; (d.mapping as Record<string, string>)["ISS-546"] = "ISS-501"
    ok("append-only：目标重复(501) ⇒ 红", appendOnlyProblems(d).length > 0 && judgeWashMapping(input(d as ReturnType<typeof doc>, [])).status === "failed")
  }
  {
    // ISS-930：占用保留号（在册真实单号，如 ISS-680）不是结构问题，而是 append 规则违例 ⇒ 红（failed）。
    const d = doc() as Record<string, unknown>
    ;(d.mapping as Record<string, string>)[FIXTURE_9999] = "ISS-90"; (d.appended as Record<string, unknown>[])[0].to = "ISS-90"
    ok("append-only：目标占用保留号(90) ⇒ 红", appendOnlyProblems(d).some((p) => p.includes("保留号")) && judgeWashMapping(input(d as ReturnType<typeof doc>, [FIXTURE_9999])).status === "failed")
  }
  {
    const d = doc() as Record<string, unknown>; (d.mapping as Record<string, string>)["ISS-xyz"] = "ISS-501"
    ok("可解析：key 非 4+ token ⇒ 结构破", shapeProblems(d).some((p) => p.includes("不是 4+ token")))
  }

  // ── append-only 形态 ────────────────────────────────────────────────────────
  {
    // legacy 从 2 改成 1：尾段变成 [ISS-502, ISS-503] 但 appended 只有 1 条 ⇒ 条数对不上 + 连续目标错位
    const d = doc() as Record<string, unknown>; d.legacy_distinct_tokens = 1
    ok("append-only：legacy 段错位数 ⇒ 形态破", appendOnlyProblems(d).some((p) => p.includes("尾段") || p.includes("应 ISS-502")))
  }
  {
    // 跳号合法（ISS-930 保留号机制）：504 保留 ⇒ 从 503 跳到 505，仍严格递增且唯一 ⇒ 绿。
    const d = doc()
    d.small_existing_numbers = [1, 2, 90, 504]
    d.mapping[FIXTURE_9999] = "ISS-505"; d.appended[0].to = "ISS-505"; d.next_small_id = 506
    ok("append-only：跳过保留号(504)后 503→505 ⇒ passed", judgeWashMapping(input(d, [FIXTURE_9999])).status === "passed")
  }
  {
    // 重号：两条 appended 指向同一目标 ⇒ 非严格递增 + 撞号 ⇒ 红。
    const d = doc()
    d.mapping[FIXTURE_9998] = "ISS-503"; d.appended.push({ token: FIXTURE_9998, to: "ISS-503", batch: "ISS-930", occurrences: 1 }); d.distinct_tokens = 4
    ok("append-only：目标重号(503) ⇒ 红", appendOnlyProblems(d).some((p) => p.includes("非严格递增")) && judgeWashMapping(input(d, [FIXTURE_9999])).status === "failed")
  }
  {
    // 回退：目标比 legacy 末条(502)还小 ⇒ 非严格递增 ⇒ 红。
    const d = doc() as Record<string, unknown>
    ;(d.mapping as Record<string, string>)[FIXTURE_9999] = "ISS-500"; (d.appended as Record<string, unknown>[])[0].to = "ISS-500"
    ok("append-only：目标回退(500<502) ⇒ 红", appendOnlyProblems(d).some((p) => p.includes("非严格递增")))
  }
  {
    // appended 顺序与 mapping 尾段不一致（对调两条 appended）⇒ 形态破
    const d = doc()
    d.appended = [{ token: "ISS-546", to: "ISS-503", batch: "ISS-904", occurrences: 1 }, { token: FIXTURE_9999, to: "ISS-502", batch: "ISS-904", occurrences: 4 }]
    ok("append-only：appended 与 mapping 顺序对不上 ⇒ 形态破", appendOnlyProblems(d).some((p) => p.includes("顺序")))
  }
  {
    const d = doc() as Record<string, unknown>; d.next_small_id = 999
    ok("append-only：next_small_id 与连续值不符 ⇒ 形态破", appendOnlyProblems(d).some((p) => p.includes("next_small_id")))
  }
  {
    const d = doc() as Record<string, unknown>; delete (d.appended as Record<string, unknown>[])[0].batch
    ok("append-only：appended 缺 batch 归属 ⇒ 形态破", appendOnlyProblems(d).some((p) => p.includes("batch")))
  }

  // ── 覆盖当前 main 4+ 全集 ───────────────────────────────────────────────────
  {
    const r = judgeWashMapping(input(doc(), ["ISS-545", "ISS-546", "ISS-914"]))
    ok("覆盖：main 有新 token 未映射 ⇒ failed 且点名", r.status === "failed" && findings(r).includes("ISS-914"))
  }
  {
    // mapping 可含已从 main 移除的历史 token（append-only 永不删）——不误报
    const r = judgeWashMapping(input(doc(), ["ISS-545", FIXTURE_9999]))
    ok("覆盖：mapping 多出历史 token 不误报（main ⊆ mapping 单向）", r.status === "passed")
  }
  {
    const r = judgeWashMapping(input(doc(), []))
    ok("覆盖：main 0 token ⇒ passed（空集是合法子集，非空映射本身已由结构章验过）", r.status === "passed")
  }

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（正例×2 / 结构×3 / append-only×9 / 覆盖×3；ISS-930 保留号正反例已含）")
  return fails === 0
}
