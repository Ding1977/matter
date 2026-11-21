/**
 * `verify-gate-coverage` 的 spec（ISS-812）。
 *
 * 三条断言各给正例 + 反例，缺一条就等于那条射程没人验过：
 *   ① 正向（声明了没派生）  ② 反向（实际有但无归属）  ③ 基线自身说谎
 *   ④ 派生物指向的脚本不存在 ⑤ 格数棘轮 ⑥ **入口存在性**（ISS-824：`export class` 登记成格 = 假绿）
 * 另有干扰形态（未知 source / 缺字段 / deprecated 豁免）与缺输入（拿不到 --list ⇒ unjudged，不许绿）。
 *
 * 为什么反例必须是**构造数据**而不是跑真仓库：真仓库此刻是对的，
 * 「本次全绿」分辨不出「判据没问题」和「判据坏了」。只有喂它一份已知有罪的输入，
 * 它红到点名的那个位置，才算这条射程有牙。
 */
import { countHardcodedAllowEntries, entryFormOf, judgeCoverage, scriptOf, type CoverageAllowlist, type ListedGate } from "./verify-gate-coverage.ts"
import type { RegistryEntry } from "./registry.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const details = (r: ReturnType<typeof judgeCoverage>) => (r.findings ?? []).map((f) => f.detail).join("\n")
const has = (r: ReturnType<typeof judgeCoverage>, needle: string) => details(r).includes(needle)
/** 批量退役留痕走 passed 的 detail（不进 findings，否则等于判红），另开一个查法。 */
const hasDetail = (r: ReturnType<typeof judgeCoverage>, needle: string) => (r.detail ?? "").includes(needle)

/** spec 条目（`kind` 缺省 = 新载体 .ts 判据）。 */
const specEntry = (id: string, over: Partial<RegistryEntry> = {}): RegistryEntry =>
  ({ id, spec: `${id}.spec.ts`, tiers: ["fast"], owner: "lead", since: "2026-11-09", status: "active", ...over }) as RegistryEntry

/** legacy 条目：一个脚本 + N 格。 */
const legacyEntry = (id: string, cells: string[], over: Partial<RegistryEntry> = {}): RegistryEntry =>
  ({
    id,
    kind: "legacy",
    script: `scripts/${id}.mjs`,
    owner: "lead",
    since: "2026-11-09",
    status: "active",
    cells: cells.map((c) => ({ id: c, runner: "check", arg: "--check", label: c, tiers: ["fast"] })),
    ...over,
  }) as RegistryEntry

const gate = (id: string, source: string | null): ListedGate => ({ id, source })

/** 白名单构造器。`maxEntries` 缺省 = 恰好等于条目数（棘轮不紧），要验棘轮的用例自己传。 */
const allow = (entries: { id: string; source: string; why?: string }[], maxEntries?: number): CoverageAllowlist => ({
  maxEntries: maxEntries ?? entries.length,
  entries: entries.map((e) => ({ why: "存量硬编码，待 ISS-B 收拢", ...e })),
})

/**
 * 构造判据输入。
 *
 * ⚠️ `baselineAtHead` 缺省 = **由本输入自身推出来的自洽值**（格数 / active 条目 / 白名单条数）。
 * 为什么不是留空：ISS-812 返工把「读不到锚点」从「只提示」改成**判红**（判不了不许报绿），
 * 留空会让每一条只想验 ①②③④ 的用例都连带红在 ⑤ 上 —— 那不是用例错，是默认值错。
 * 想验 ⑤ 的用例显式传 `baselineAtHead`，缺省即「与当前持平」。
 */
const mk = (over: Partial<Parameters<typeof judgeCoverage>[0]> = {}) => {
  const base = {
    entries: [specEntry("a")],
    listed: [gate("a", "gates/registry.json")],
    allowlist: allow([]),
    ...over,
  }
  const active = (base.entries ?? []).filter((e) => e.status !== "deprecated")
  const derived = active.reduce(
    (n, e) => (e.kind === "legacy" ? n + (Array.isArray(e.cells) ? e.cells.length : 0) : n + 1),
    0,
  )
  // 调用方显式给了 `baselineAtHead`（含显式 `null`）⇒ 尊重它，不要用推导值盖掉 ——
  // ⑤ 的用例正是靠显式传值来验「掉数」与「判不了」两种形态。
  if ("baselineAtHead" in over) return { ...base, baselineAtHead: over.baselineAtHead }
  return {
    ...base,
    baselineAtHead: {
      gates: derived + (base.allowlist?.entries.length ?? 0),
      registryEntries: active.length,
      // ⚠️ ISS-863：调**同一个函数**数分族条数，不在这里自己写 `filter` ——
      // 判据侧与 spec 侧各写一份口径，分叉时用例会自己跟着分叉，那等于没验。
      allowHardcodedEntries: countHardcodedAllowEntries(base.allowlist?.entries ?? []),
    },
  }
}

export function run(): boolean {
  fails = 0
  console.log("verify-gate-coverage.spec")

  // ── 正例：三边对齐 ─────────────────────────────────────────────────────────
  {
    const r = judgeCoverage(mk({ entries: [specEntry("a"), legacyEntry("leg", ["leg"])], listed: [gate("a", "gates/registry.json"), gate("leg", "gates/registry.json（legacy）")] }))
    ok("正例：registry 声明全部派生、无硬编码 ⇒ passed", r.status === "passed")
    ok("正例：结论行报出「registry N + 白名单 M」的分账", (r.detail ?? "").includes("--list 2 格 = registry 2 + 白名单 0"))
  }
  {
    // 白名单里的格真实存在且来源对得上 ⇒ passed（这是 ② 的正例，不是 ① 的）
    const r = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("inl", "guard-baselines.sh 内联")], allowlist: allow([{ id: "inl", source: "guard-baselines.sh 内联" }]) }))
    ok("正例：硬编码格已在白名单 ⇒ passed（「登记」而非「禁止」）", r.status === "passed")
  }

  // ── ① 正向反例：声明了没派生 ───────────────────────────────────────────────
  {
    const r = judgeCoverage(mk({ listed: [] }))
    ok("① 反例：spec 条目声明了但 --list 没有 ⇒ 红且点名【声明了没派生】", r.status === "failed" && has(r, "声明了没派生"))
  }
  {
    // ⚠️ 这条是 Lead 实测暴露的那个洞（ISS-812 返工）：
    // `deriveRegistryGates()` **不 stat 脚本**，所以「指向不存在脚本的条目」照样出现在 `--list` 里。
    // 只比「声明 vs --list」对这条输入是重言式（两边同源）⇒ 必须另外查文件在不在。
    const r = judgeCoverage({
      ...mk({ entries: [legacyEntry("leg", ["leg"])], listed: [gate("leg", "gates/registry.json（legacy）")] }),
      scriptExists: () => false,
    })
    ok("① 反例：legacy 的 script 不存在 ⇒ 红（--list 会照样派生，原口径看不见）", r.status === "failed" && has(r, "登记的脚本不存在"))
  }
  {
    // spec 条目的派生路径写死成 scripts/gates/<id>.ts，同一个洞
    const r = judgeCoverage({ ...mk({ listed: [gate("a", "gates/registry.json")] }), scriptExists: () => false })
    ok("① 反例：spec 的 .ts 不存在 ⇒ 红", r.status === "failed" && has(r, "登记的判据文件不存在"))
  }
  {
    // 正例：脚本都在 ⇒ 不因这条误红
    const r = judgeCoverage({ ...mk({ entries: [specEntry("a"), legacyEntry("leg", ["leg"])], listed: [gate("a", "gates/registry.json"), gate("leg", "gates/registry.json（legacy）")] }), scriptExists: () => true })
    ok("① 正例：scriptExists 全 true ⇒ passed（不误红）", r.status === "passed")
  }
  {
    // 缺探针 ⇒ 不判这一层（不冒充绿，也不误判红）
    const r = judgeCoverage({ ...mk({ listed: [gate("a", "gates/registry.json")] }), scriptExists: undefined })
    ok("① 缺输入：没有 scriptExists 探针 ⇒ 不判脚本存在性（不误红）", r.status === "passed")
  }
  {
    // 一格漏派生：legacy 的两格里只派生了 1 格
    const r = judgeCoverage(mk({ entries: [legacyEntry("leg", ["leg", "leg-selftest"])], listed: [gate("leg", "gates/registry.json（legacy）")] }))
    ok("① 反例：legacy 某格漏派生 ⇒ 红且点名那一格", r.status === "failed" && has(r, "leg/leg-selftest：声明了但没派生"))
  }
  {
    const r = judgeCoverage(mk({ entries: [legacyEntry("leg", [])], listed: [] }))
    ok("① 反例：legacy 条目 cells[] 为空 ⇒ 红（登记了一格都不派发）", r.status === "failed" && has(r, "cells[] 为空"))
  }
  {
    // 真实事故形态：条目 tiers 只有 pre-commit/scheduled ⇒ REGISTRY_TIER_MAP 映射成空 ⇒ 静默掉出 --list
    const r = judgeCoverage(mk({ entries: [specEntry("a", { tiers: ["pre-commit"] } as never)], listed: [] }))
    ok("① 反例：tiers 映射成空数组导致静默掉出 ⇒ 仍红（不因「登记过」就放过）", r.status === "failed" && has(r, "声明了但没派生"))
  }

  // ── deprecated 豁免：可豁免，但必须登记理由 ────────────────────────────────
  {
    const r = judgeCoverage(mk({ entries: [specEntry("a", { status: "deprecated", note: "已由 b 取代" } as never)], listed: [] }))
    ok("deprecated 正例：写了 note ⇒ 豁免，不算「声明了没派生」", r.status === "passed")
  }
  {
    const r = judgeCoverage(mk({ entries: [specEntry("a", { status: "deprecated" } as never)], listed: [] }))
    ok("deprecated 反例：没写 note ⇒ 红（弃用必须留理由）", r.status === "failed" && has(r, "deprecated 却没写 note"))
  }
  {
    // ⚠️ Lead 抽查暴露的绕过（ISS-812 二次返工）：deprecated 分支原先只查 note 就 `continue`，
    // 后面的存在性检查永远到不了 ⇒「deprecated + 脚本不存在」被判 passed。
    //
    // 语义判断（不是简单「也查」）：**退役本就该删脚本** ⇒「deprecated + 脚本已删」是正常终态，
    // 不该红。但也不能静默跳过 —— 结论行必须说清「另有 N 条 deprecated 不派生」。
    const gone = judgeCoverage({
      ...mk({ entries: [legacyEntry("retired", ["retired"], { status: "deprecated", note: "已退役" } as never)], listed: [] }),
      scriptExists: () => false,
    })
    ok("deprecated 语义：脚本已删是正常终态 ⇒ 不红", gone.status === "passed")
    ok("deprecated 语义：但结论行点名「另有 1 条 deprecated 不派生」（不静默跳过）", (gone.detail ?? "").includes("另有 1 条 deprecated 不派生"))

    // 分账不能说谎：activeCount 才是「全部派生」的主语，不能拿条目总数冒充
    ok("deprecated 语义：结论行用 active 计数，不拿总条目数冒充", (gone.detail ?? "").includes("registry 0 条 active 声明全部派生"))
  }
  {
    // 另一面：deprecated 但脚本还在 ⇒ 是可清理的残渣，提示（不红）
    const staleCase = judgeCoverage({
      ...mk({ entries: [legacyEntry("retired", ["retired"], { status: "deprecated", note: "已退役" } as never)], listed: [] }),
      scriptExists: () => true,
    })
    ok("deprecated 提示：脚本还在 ⇒ 不红但结论行提示可清理", staleCase.status === "passed" && (staleCase.detail ?? "").includes("可清理"))
  }
  {
    // 反向确认没退化：active + 脚本不存在仍然红（Lead 的验收 ③）
    const r = judgeCoverage({
      ...mk({ entries: [legacyEntry("live", ["live"])], listed: [gate("live", "gates/registry.json（legacy）")] }),
      scriptExists: () => false,
    })
    ok("不退化：active + 脚本不存在 ⇒ 仍红", r.status === "failed" && has(r, "登记的脚本不存在"))
  }

  // ── ② 反向反例：实际有但无归属 ─────────────────────────────────────────────
  {
    const r = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("newinline", "guard-baselines.sh 内联")] }))
    ok("② 反例：内联新格不在白名单 ⇒ 红且点名【实际有但无归属】+ 指到 inline-gates.mjs", r.status === "failed" && has(r, "newinline") && has(r, "实际有但无归属") && has(r, "inline-gates.mjs"))
  }
  {
    const r = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("standalone-new", "独立脚本")] }))
    ok("② 反例：独立脚本新格不在白名单 ⇒ 红且指到 gate-tables.mjs", r.status === "failed" && has(r, "standalone-new") && has(r, "gate-tables.mjs"))
  }
  {
    const r = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("ci-test-x", null)] }))
    ok("② 反例：source=null 的 CI 逐包格不在白名单 ⇒ 红且标为 ci-packages", r.status === "failed" && has(r, "ci-test-x") && has(r, "ci-packages"))
  }
  {
    // 未知 source：有人给调度器加了新派生路径 ⇒ 红，且**不许**用白名单消声
    const r = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("weird", "全新派生路径")], allowlist: allow([{ id: "weird", source: "全新派生路径" }]) }))
    ok("② 反例：未知 source ⇒ 红（白名单不顶事，新派生路径必须先过归属表）", r.status === "failed" && has(r, "未知的"))
  }
  {
    // --list 标 registry 但登记表里没有 ⇒ 派生侧比声明侧多了东西
    const r = judgeCoverage(mk({ entries: [], listed: [gate("ghost", "gates/registry.json")] }))
    ok("② 反例：--list 标 registry 但无对应 active 声明 ⇒ 红", r.status === "failed" && has(r, "没有这条 active 声明"))
  }

  // ── ④ 派生物自身的完整性：--list 的格指向的脚本必须存在 ────────────────────
  // 射程是**三族都查**（registry / 内联 / 独立脚本）—— 这一条是唯一能够到后两族的，
  // `verify-gate-registry` 只读 registry 声明，实测那个变异它全绿。
  {
    const r = judgeCoverage({
      ...mk({ listed: [{ id: "a", source: "gates/registry.json", command: "/usr/bin/node /repo/scripts/gates/a.ts --check" }] }),
      scriptExists: (p: string) => !p.includes("a.ts"),
    })
    ok("④ 反例：--list 的格指向不存在脚本 ⇒ 红【派生物指向不存在的脚本】", r.status === "failed" && has(r, "派生物指向不存在的脚本"))
  }
  {
    // 内置格（command=<internal>）没有脚本 ⇒ 不适用，不许当红（实测 181 格里 3 格是这种：
    // project-code-rules-size / lint-mutation-tests / client-artifacts）。
    // ⚠️ 用内联来源而不是 registry 来源：标 registry 就必须有对应 active 声明，
    // 否则 ② 那条会先红 —— 那就分不清是「内置格被误判」还是「声明缺失」。
    const r = judgeCoverage({
      ...mk({
        entries: [],
        listed: [{ id: "a", source: "guard-baselines.sh 内联", command: "<internal>" }],
        // 内联网格本来就要进白名单；不登记的话 ② 会正确红，干扰本条断言。
        allowlist: allow([{ id: "a", source: "guard-baselines.sh 内联" }]),
      }),
      scriptExists: () => false,
    })
    ok("④ 不适用：<internal> 内置格没有脚本 ⇒ 跳过（不误红）", r.status === "passed")
  }
  {
    // 脚本在 ⇒ 不红（反例形态说得出「不一样会是什么样」才叫验过）
    const r = judgeCoverage({
      ...mk({ listed: [{ id: "a", source: "gates/registry.json", command: "/usr/bin/node /repo/scripts/gates/a.ts --check" }] }),
      scriptExists: () => true,
    })
    ok("④ 正例：脚本在 ⇒ passed", r.status === "passed")
  }
  {
    // 解释器路径不能被误当脚本：/usr/local/bin/node 不以脚本扩展名结尾
    ok("④ 解析：解释器路径不被当成脚本", scriptOf("/usr/local/bin/node /repo/x.mjs --check") === "/repo/x.mjs")
    ok("④ 解析：<internal> 无脚本 token ⇒ null", scriptOf("<internal>") === null)
    ok("④ 解析：空/undefined ⇒ null", scriptOf(undefined) === null && scriptOf("") === null)
    ok("④ 解析：.sh 也算脚本", scriptOf("bash /repo/x.sh --check") === "/repo/x.sh")
    ok("④ 解析：带引号的路径能拆出来", scriptOf(`"node" "/repo/a b/x.ts" --check`) === "/repo/a b/x.ts")
  }

  // ── ③b 棘轮：清单只许变短 ─────────────────────────────────────────────────
  // 不是可选项：没有它，「登记」会慢慢长成「全部登记」，判据退回它要修的重言式，
  // 而每一步都合法 —— 那就等于没有判据。
  {
    // listed 只放两格硬编码格；不放 registry 来源的假格（那会触发 ② 的「无对应声明」，干扰本条）。
    const listed = [gate("a2", "独立脚本"), gate("b", "独立脚本")]
    const r = judgeCoverage(mk({ entries: [], listed, allowlist: allow([{ id: "a2", source: "独立脚本" }, { id: "b", source: "独立脚本" }], 1) }))
    ok("③b 反例：条目数 > maxEntries ⇒ 红（只减不增）", r.status === "failed" && has(r, "只许变短"))
    const okCase = judgeCoverage(mk({ entries: [], listed, allowlist: allow([{ id: "a2", source: "独立脚本" }, { id: "b", source: "独立脚本" }], 2) }))
    ok("③b 正例：条目数 == maxEntries ⇒ 绿", okCase.status === "passed")
  }
  {
    const r = judgeCoverage(mk({ allowlist: { entries: [] } as unknown as CoverageAllowlist }))
    ok("③b 反例：maxEntries 缺失 ⇒ 红（没有上限的存量清单会慢慢长回全部登记）", r.status === "failed" && has(r, "maxEntries"))
  }
  {
    const r = judgeCoverage(mk({ allowlist: { maxEntries: -1, entries: [] } as unknown as CoverageAllowlist }))
    ok("③b 反例：maxEntries 为负数 ⇒ 红", r.status === "failed" && has(r, "maxEntries"))
  }

  // ── ⑤ 格数棘轮：防「干脆不写」（审查员报、Lead 复核的两条绕过）──────────
  //
  // 这两条是本单最有价值的用例：①~③ 全部**空洞成立**却报 passed。
  {
    // 绕过 1（critical）：registry 写成 `[]` ⇒ ① 没有声明可判 ⇒ 空洞真 ⇒ passed。
    // 实测 --list 从 182 掉到 66 格，而屏幕上全绿。
    const r = judgeCoverage({
      ...mk({ entries: [], listed: [], baselineAtHead: { gates: 182, registryEntries: 72, allowHardcodedEntries: 66 } }),
      allowlist: allow([]),
    })
    ok("⑤ 反例（绕过1）：清空 registry ⇒ 格数棘轮红（① 对空登记表是空洞成立）", r.status === "failed" && has(r, "格数从 182 掉到"))
  }
  {
    // 绕过 2（high）：63 条 legacy 全标 deprecated ⇒ 只出「可清理」提示，不红。
    // 这里用「条目还在但参与派生的从 2 降到 0」表达同一形态。
    const r = judgeCoverage({
      ...mk({ entries: [legacyEntry("a", ["a"], { status: "deprecated", note: "x" } as never), legacyEntry("b", ["b"], { status: "deprecated", note: "x" } as never)], listed: [] }),
      baselineAtHead: { gates: 182, registryEntries: 2, allowHardcodedEntries: 66 },
      allowlist: allow([{ id: "x1", source: "独立脚本" }], 66),
    })
    ok("⑤ 反例（绕过2）：条目全标 deprecated ⇒ 参与派生的条目数下降 ⇒ 红", r.status === "failed" && has(r, "参与派生的条目数从 2 掉到 0"))
  }
  {
    // 反方向：白名单只许减不许增，否则新增硬编码可以靠「再加一条」洗成已登记，② 白判
    const r = judgeCoverage({
      ...mk({ entries: [], listed: [gate("n1", "独立脚本"), gate("n2", "独立脚本")], baselineAtHead: { gates: 2, registryEntries: 0, allowHardcodedEntries: 1 } }),
      allowlist: allow([{ id: "n1", source: "独立脚本" }, { id: "n2", source: "独立脚本" }], 2),
    })
    ok("⑤ 反例（反方向）：白名单从 1 涨到 2 ⇒ 红（不许靠扩白名单洗登记）", r.status === "failed" && has(r, "只许减不许增"))
  }
  {
    // ★ 本单的正例（ISS-863）：新增包派生出的 CI 逐包格登记后，⑤ 必须放行。
    //
    // 这一对用例（本块 + 下一块）是本单的判据核心：只给正例 = 证明不了棘轮还在，
    // 只给反例 = 证明不了死锁解了。两块必须同时在场。
    //
    // 反例形态（「不一样会是什么样」）：若 ⑤ 仍按**总条数**比，这里会红成
    // 「白名单从 0 条涨到 2 条」—— 那正是修复前实测的形态。
    const a = allow([
      { id: "ci-test-x", source: "ci-packages" },
      { id: "ci-typecheck-x", source: "ci-packages" },
    ])
    const r = judgeCoverage({
      ...mk({
        entries: [],
        listed: [gate("ci-test-x", null), gate("ci-typecheck-x", null)],
        baselineAtHead: { gates: 2, registryEntries: 0, allowHardcodedEntries: 0 },
      }),
      allowlist: a,
    })
    ok("⑤ 正例（ISS-863）：ci-packages 族随包自然增长（0→2 条）⇒ 不红", r.status === "passed")
  }
  {
    // ★ 硬要求（本单验收 3）：手动往白名单加一条**硬编码**格 ⇒ 仍必须红。
    //
    // 没有这条，「修死锁」就变成了「废掉棘轮」—— 这是本单唯一不许放宽的语义。
    // 输入刻意让 ci 族**同时**存在，证明放行的是那一族、不是整个棘轮。
    const a = allow([
      { id: "ci-test-x", source: "ci-packages" },
      { id: "ci-typecheck-x", source: "ci-packages" },
      { id: "sneaky", source: "独立脚本" },
    ])
    const r = judgeCoverage({
      ...mk({
        entries: [],
        listed: [gate("ci-test-x", null), gate("ci-typecheck-x", null), gate("sneaky", "独立脚本")],
        baselineAtHead: { gates: 3, registryEntries: 0, allowHardcodedEntries: 0 },
      }),
      allowlist: a,
    })
    ok(
      "⑤ 反例（ISS-863 变异）：ci 族放行，但手动加一条硬编码 ⇒ 仍红（棘轮没被废）",
      r.status === "failed" && has(r, "只许减不许增") && has(r, "硬编码族"),
    )
  }
  {
    // 更狠的变异：把一条硬编码格**伪装成** ci-packages 塞进白名单 ⇒ ② 判红（来源对不上）。
    // 证明「分族」不是「只要 source 写 ci-packages 就免棘轮」—— ② 的逐格来源对账在挡。
    const r = judgeCoverage({
      ...mk({ entries: [], listed: [gate("fake-ci", "独立脚本")], allowlist: allow([{ id: "fake-ci", source: "ci-packages" }]) }),
    })
    ok("⑤ 变异：硬编码格伪装成 ci-packages 登记 ⇒ ② 判红（来源对不上）", r.status === "failed" && has(r, "来源是"))
  }
  {
    // 正例：三项都持平 ⇒ 绿
    const r = judgeCoverage({
      ...mk({ entries: [specEntry("a")], listed: [gate("a", "gates/registry.json")], baselineAtHead: { gates: 1, registryEntries: 1, allowHardcodedEntries: 0 } }),
    })
    ok("⑤ 正例：三个计数都持平 ⇒ passed", r.status === "passed")
  }
  {
    // 只许增：格数变多不红（新增门禁是好事，不是这个棘轮要管的方向）
    const r = judgeCoverage({
      ...mk({ entries: [specEntry("a"), specEntry("b")], listed: [gate("a", "gates/registry.json"), gate("b", "gates/registry.json")], baselineAtHead: { gates: 1, registryEntries: 1, allowHardcodedEntries: 0 } }),
    })
    ok("⑤ 正例：格数增加 ⇒ 不红（棘轮只管降）", r.status === "passed")
  }
  {
    // 缺锚点 ⇒ **判红**（ISS-812 返工改了这里）。
    // 原行为是「塞进 stale ⇒ 只提示不判红 ⇒ passed」—— 那等于把「判不了」显示成「通过了」，
    // 正是本判据要修的那类假绿。锚点读不到只可能是环境不满足前提（未 fetch / 浅克隆）。
    const r = judgeCoverage({ ...mk({ baselineAtHead: null }) })
    ok(
      "⑤ 缺锚点 ⇒ 红，且点名「未判」+ 锚点 origin/main（不许把判不了显示成通过）",
      r.status === "failed" && has(r, "格数棘轮未判") && has(r, "origin/main"),
    )
  }

  // ── ⑤b 批量退役通道（ISS-880）──────────────────────────────────────────
  // 四例缺一不可：放行方向 / 未置位不放行 / 只放行退役方向 / 清到 0 格的保护。
  // 全部显式传 batchRetire，不让宿主环境变量污染「未置位仍红」的断言。
  {
    // ① 置位 + 合法部分退役：registry 与 --list 同步删掉 b ⇒ 绿，且逐 id 点名 b。
    const base = {
      entries: [specEntry("a")],
      listed: [gate("a", "gates/registry.json")],
      allowlist: allow([]),
      baselineAtHead: { gates: 2, registryEntries: 2, allowHardcodedEntries: 0, listedIds: ["a", "b"], activeIds: ["a", "b"] },
      batchRetire: true,
    }
    const r = judgeCoverage(mk(base))
    ok("⑤b 置位+合法降 ⇒ 绿且逐 id 留痕（点名退役的 b）", r.status === "passed" && hasDetail(r, "批量退役通道已启用") && hasDetail(r, "逐 id 列出：b") && hasDetail(r, "【批量退役留痕】"))
  }
  {
    // ② 未置位 + 同样降 ⇒ 仍红（通道默认关，3 条棘轮反例不回归）。
    const base = {
      entries: [specEntry("a")],
      listed: [gate("a", "gates/registry.json")],
      allowlist: allow([]),
      baselineAtHead: { gates: 2, registryEntries: 2, allowHardcodedEntries: 0, listedIds: ["a", "b"], activeIds: ["a", "b"] },
      batchRetire: false,
    }
    const r = judgeCoverage(mk(base))
    ok("⑤b 未置位+降 ⇒ 仍红【格数棘轮】且无留痕", r.status === "failed" && has(r, "【格数棘轮】") && has(r, "掉到 1") && !has(r, "批量退役通道已启用"))
  }
  {
    // ③ 置位但硬编码白名单升（n1→n2）⇒ 仍红。证明通道只放行「退役方向」，不碰「只许升」。
    const a = allow([{ id: "n1", source: "独立脚本" }, { id: "n2", source: "独立脚本" }], 2)
    const r = judgeCoverage(mk({
      entries: [],
      listed: [gate("n1", "独立脚本"), gate("n2", "独立脚本")],
      allowlist: a,
      baselineAtHead: { gates: 2, registryEntries: 0, allowHardcodedEntries: 1 },
      batchRetire: true,
    }))
    ok("⑤b 置位但硬编码白名单升 ⇒ 仍红（通道不放行反方向）", r.status === "failed" && has(r, "只许减不许增") && has(r, "硬编码族") && has(r, "【格数棘轮】"))
  }
  {
    // ④ 置位但清到 0 格 ⇒ 仍红。下限保护：通道只放行「部分退役」，不是「关掉全部」的后门。
    const r = judgeCoverage(mk({
      entries: [],
      listed: [],
      allowlist: allow([]),
      baselineAtHead: { gates: 2, registryEntries: 2, allowHardcodedEntries: 0, listedIds: ["a", "b"], activeIds: ["a", "b"] },
      batchRetire: true,
    }))
    ok("⑤b 置位但清到 0 格 ⇒ 仍红（下限保护，通道不是关门禁后门）", r.status === "failed" && has(r, "【格数棘轮】") && has(r, "掉到 0") && !has(r, "批量退役通道已启用"))
  }

  // ── ⑥ 入口存在性：文件在 ≠ 它能跑出判据（ISS-824）────────────────────────
  //
  // 这一条要修的是**假绿**：假红会有人修，假绿没人会去查一个永远绿的格。
  // ⇒ 每条都给出「红的样子」和「不该红的样子」，只给正例等于没验（④ 的教训）。
  {
    // 最核心的反例：官方 `bundle-input-isolation.ts` 的形态 —— `export class`，无入口。
    const r = judgeCoverage({
      ...mk({ listed: [{ id: "a", source: "gates/registry.json", command: "/usr/bin/node /repo/scripts/gates/a.ts --check" }] }),
      scriptExists: () => true,
      readScript: () => "export class BundleInputIsolation {\n  constructor(x) { this.x = x }\n}\n",
    })
    ok("⑥ 反例：export class 库被登记成格 ⇒ 红且标【无声判据】", r.status === "failed" && has(r, "（未命名）") === false && has(r, "【无声判据】"))
    ok("⑥ 反例：点名「EXIT=0 是主逻辑没执行」而不是「文件不存在」", has(r, "主逻辑没执行") && !has(r, "不存在的脚本"))
  }
  {
    // 正例：spec 载体的标准形态（isMain + runGate 挂在下面）⇒ 不红
    const r = judgeCoverage({
      ...mk({ listed: [{ id: "a", source: "gates/registry.json", command: "/usr/bin/node /repo/scripts/gates/a.ts --check" }] }),
      scriptExists: () => true,
      readScript: () => 'import { isMain, runGate } from "../lib/gate-runtime.ts"\nif (isMain(import.meta.url)) {\n  runGate({ name: "a", main: async () => ({}) })\n}\n',
    })
    ok("⑥ 正例：isMain(import.meta.url) + runGate ⇒ passed", r.status === "passed")
  }
  {
    // 读不出（null）⇒ 判红，**不许静默跳过**：跳过会让「没验」和「验过了」在屏幕上一样。
    const r = judgeCoverage({
      ...mk({ listed: [{ id: "a", source: "gates/registry.json", command: "/usr/bin/node /repo/scripts/gates/a.ts --check" }] }),
      scriptExists: () => true,
      readScript: () => null,
    })
    ok("⑥ 缺输入：readScript 返回 null（读不出）⇒ 红，不跳过", r.status === "failed" && has(r, "【无声判据】"))
  }
  {
    // 文件不存在 ⇒ ④ 已报，⑥ **不重复报**（同一个根因只出一句，否则读报的人以为是两个毛病）
    const r = judgeCoverage({
      ...mk({ listed: [{ id: "a", source: "gates/registry.json", command: "/usr/bin/node /repo/scripts/gates/a.ts --check" }] }),
      scriptExists: () => false,
      readScript: () => null,
    })
    ok("⑥ 不重复：文件不存在由 ④ 报，⑥ 不叠加", r.status === "failed" && !has(r, "【无声判据】") && has(r, "派生物指向不存在的脚本"))
  }
  {
    // CI 逐包格（command = bun run test）没有注册文件 ⇒ 本条不适用，不许当红
    // ⚠️ 两处配平，缺一处就会红在别处、分不清是「⑥ 误判」还是「用例自己没配平」：
    //    · entries 必须清空 —— `mk()` 默认带一条 spec 条目 `a`，留着它 ① 会先红；
    //    · allowlist 必须**传进 mk()** —— `baselineAtHead` 是按 mk 收到的 allowlist 推的，
    //      在外层覆盖会与推导值打架，⑤ 的白名单棘轮先红（实测踩到）。
    const a = allow([{ id: "ci-test-x", source: "ci-packages" }])
    const r = judgeCoverage({
      ...mk({ entries: [], listed: [gate("ci-test-x", null)], allowlist: a }),
      scriptExists: () => true,
      readScript: () => null,
    })
    ok("⑥ 不适用：CI 逐包格没有注册文件 ⇒ 跳过（不误红）", r.status === "passed")
  }
  {
    // 缺探针 ⇒ 整条不判（与 ④ 同一口径，不冒充绿也不误红）
    const r = judgeCoverage({ ...mk({ listed: [gate("a", "gates/registry.json")] }), scriptExists: () => true, readScript: undefined })
    ok("⑥ 缺输入：没有 readScript 探针 ⇒ 不判（不误红）", r.status === "passed")
  }

  // ── ⑥ 分族判入口：四种登记形态各验一遍（这是本单最容易做错的地方）───────────
  //
  // 一视同仁地「全文匹配 process.argv 就算有入口」会把 spec 里的**读参数**当成入口；
  // 「全文匹配 --check」会把 `route-alias-check.mjs`（靠 argv.includes('--selftest') 分流）判成无入口。
  {
    const T = (n: string, cond: boolean) => ok(`⑥ 分族：${n}`, cond)
    T("spec .ts 有 isMain ⇒ isMain", entryFormOf("scripts/gates/a.ts", 'if (isMain(import.meta.url)) { runGate({}) }\n') === "isMain")
    // 关键反向：.ts 里有 process.argv 但没 isMain ⇒ 仍是 none（那是读参数，不是入口）
    T(
      "spec .ts 只有 process.argv（读参数）⇒ 仍是 none",
      entryFormOf("scripts/gates/a.ts", 'const argv = process.argv.slice(2)\nexport function judge() {}\n') === "none",
    )
    T("legacy .mjs 有 process.argv ⇒ process.argv", entryFormOf("scripts/x.mjs", 'const A = process.argv.slice(2)\nprocess.exit(0)\n') === "process.argv")
    T("legacy .mjs 有 import.meta.main ⇒ import.meta.main", entryFormOf("scripts/x.mjs", "if (import.meta.main) main()\n") === "import.meta.main")
    // 实测形态：check-host-dist-fresh.mjs 只有 shebang + 顶层直跑，一个标记都不带
    T("legacy .mjs 只有 shebang + 顶层直跑 ⇒ shebang（实测 1 处）", entryFormOf("scripts/x.mjs", "#!/usr/bin/env bun\nmain()\n") === "shebang")
    T("legacy .mjs 三样都没有 ⇒ none", entryFormOf("scripts/x.mjs", "export const x = 1\n") === "none")

    // shell：**另判**，与 .ts/.mjs 完全不同的口径
    T("legacy .sh 有 shebang ⇒ shell-shebang", entryFormOf("scripts/x.sh", "#!/usr/bin/env bash\necho hi\n") === "shell-shebang")
    T("legacy .sh 无 shebang ⇒ none", entryFormOf("scripts/x.sh", "echo hi\n") === "none")
    // ⚠️ 不查 set -e：那是错误处理不是入口。实测 5 个 .sh 只 1 个写了 set -e，
    //    拿它判入口会把另外 4 个真判据误报。
    T("legacy .sh 有 shebang 但没 set -e ⇒ 仍是入口（set -e 是错误处理，不是入口）", entryFormOf("scripts/x.sh", "#!/usr/bin/env bash\necho hi\n") === "shell-shebang")

    // 注释不算代码：注释里的 process.argv 不许冒充入口（ISS-762 同一教训）
    T("注释里的 process.argv 不算入口", entryFormOf("scripts/x.mjs", "// 这里要读 process.argv\nconst x = 1\n") === "none")
    T("块注释里的 isMain 不算入口", entryFormOf("scripts/gates/a.ts", "/* isMain(import.meta.url) */\nexport class A {}\n") === "none")
    // ⚠️ 实测踩到的坑：行注释里的 glob `src/**` 会让「先剥块注释」的两步写法吞掉后面 137 行真代码
    T(
      "行注释里的 glob src/** 不会吞掉后面的真入口（单趟交替匹配）",
      entryFormOf("scripts/x.mjs", "// 改 src/** 要重建\nconst A = process.argv.slice(2)\nprocess.exit(0)\n") === "process.argv",
    )
    // --check 不许当入口依据：route-alias-check.mjs 全文无 --check 却可执行
    T("只有 --check 字样、无真入口 ⇒ none（--check 是参数名不是分发逻辑）", entryFormOf("scripts/x.mjs", 'console.log("pass --check")\nexport const y = 2\n') === "none")
    // ISS-857：`console.log(` 不是入口依据 —— 它是「打印」，不是「入口」。
    // 这两条是第 ⑥ 条自己的命门：一个 `export class` 库只要函数体里有一行缩进的
    // `console.log`，改前会被判成 top-level ⇒ 第 ⑥ 条**放行它**，而放行正是它唯一要防的假绿
    // （官方 `bundle-input-isolation.ts` 就是这个形态）。
    T(
      "⑥ 命门：export class 库 + 函数体内缩进的 console.log ⇒ none（不是 top-level）",
      entryFormOf("scripts/x.ts", 'export class X {\n  run() {\n    console.log("build")\n  }\n}\n') === "none",
    )
    T(
      "⑥ 命门：export class 库 + 模板串里行首 console.log ⇒ none（字面量不是逻辑）",
      entryFormOf("scripts/x.mjs", "export class X {}\nconst s = `\nconsole.log(1)\n`\n") === "none",
    )
    // 反面：进程级副作用仍是入口依据 —— 去掉 console.log 不许把真受害者一起判掉
    T("⑥ 反面：顶层 process.exitCode ⇒ top-level（真受害者 build-index-credential 靠它）", entryFormOf("scripts/x.mjs", "const a = 1\nprocess.exitCode = a ? 1 : 0\n") === "top-level")
    T("⑥ 反面：顶层 await ⇒ top-level", entryFormOf("scripts/x.mjs", "await main()\n") === "top-level")
  }

  // ── ③ 基线自身说谎 ────────────────────────────────────────────────────────
  {
    const r = judgeCoverage(mk({ allowlist: allow([{ id: "fossil", source: "独立脚本" }]) }))
    ok("③ 反例：白名单登记了不存在的格 ⇒ 红且点名【基线自身说谎】", r.status === "failed" && has(r, "fossil") && has(r, "基线自身说谎"))
  }
  {
    // 化石 + 已换族：格还在，但来源从「独立脚本」变成「内联」⇒ 旧条目该删
    const r = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("moved", "guard-baselines.sh 内联")], allowlist: allow([{ id: "moved", source: "独立脚本" }]) }))
    ok("③ 反例：白名单 source 与 --list 不符（这格迁走了）⇒ 红且提示删条目", r.status === "failed" && has(r, "已经换族/迁走"))
  }
  {
    const r = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("nw", "独立脚本")], allowlist: allow([{ id: "nw", source: "独立脚本", why: "  " }]) }))
    ok("③ 反例：白名单条目 why 为空 ⇒ 红（空理由 = 不可审计的免死金牌）", r.status === "failed" && has(r, "why 为空"))
  }
  {
    const r = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("dup", "独立脚本")], allowlist: allow([{ id: "dup", source: "独立脚本" }, { id: "dup", source: "独立脚本" }]) }))
    ok("③ 反例：白名单重复登记同一格 ⇒ 红（账算不清）", r.status === "failed" && has(r, "重复登记"))
  }

  // ── 缺输入：拿不到登记表 ⇒ unjudged，绝不绿 ───────────────────────────────
  {
    const r = judgeCoverage(mk({ listed: null }))
    ok("缺输入：拿不到 --list ⇒ unjudged（no-corpus），不许绿", r.status === "unjudged" && r.reason === "no-corpus")
  }
  {
    // 白名单文件缺席 ≠ 判不了：按空白名单照判。此时若有硬编码格，照红（不静默放过）。
    const r = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("x", "独立脚本")], allowlist: null }))
    ok("缺白名单：按空白名单照判 ⇒ 有硬编码格就红（缺文件不能把整格变成不可判）", r.status === "failed" && has(r, "x"))
    const pass = judgeCoverage(mk({ allowlist: null }))
    ok("缺白名单：没有硬编码格时照绿", pass.status === "passed")
  }

  // ── 措辞分族：三种红的标签必须能分开（不然读报的人不知道该改哪边）─────────
  {
    const a = judgeCoverage(mk({ listed: [] }))                                  // ① 改 registry
    const b = judgeCoverage(mk({ listed: [gate("a", "gates/registry.json"), gate("z", "独立脚本")] })) // ② 改白名单
    const c = judgeCoverage(mk({ allowlist: allow([{ id: "zz", source: "独立脚本" }]) }))              // ③ 删白名单
    const labels = (r: ReturnType<typeof judgeCoverage>) => details(r).match(/【[^】]+】/g) ?? []
    ok("措辞：① 只打【声明了没派生】", labels(a).includes("【声明了没派生】") && !labels(a).includes("【基线自身说谎】"))
    ok("措辞：② 只打【实际有但无归属】", labels(b).includes("【实际有但无归属】") && !labels(b).includes("【声明了没派生】"))
    ok("措辞：③ 只打【基线自身说谎】", labels(c).includes("【基线自身说谎】") && !labels(c).includes("【声明了没派生】"))
  }

  // ⚠️ 总数以本文件里断言函数的静态出现数为准（ISS-818 事故：手写总数写错过一次）。
  // 静态数 = 66；运行时断言数由 T() 包装的 17 条分族用例额外叠加，两者口径不同 ——
  // 这里印静态数，与 grep 核对一致即可。
  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（66 条：正例 2 · ① 反例 4+正例1+缺输入1 · 脚本存在性 3 · deprecated 4+2 · ② 反例 5 · ③b 棘轮 3 · ⑤ 格数棘轮 3+正例2+缺输入1 · ⑤b 批量退役通道 4 · ④ 反例1+不适用1+正例1+解析5 · ⑥ 反例2+正例1+缺输入2+不适用1+不重复1+分族17 · ③ 反例 4 · 缺输入 3 · 措辞分族 3）")
  return fails === 0
}
