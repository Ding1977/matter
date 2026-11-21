/**
 * `verify-gate-registry` 的 spec（ISS-737 / ISS-746）。
 * 四类用例齐全：正例 / 反例 / 干扰形态 / 缺输入（unjudged，不许绿）。
 * ISS-746 扩了 `kind:"legacy"` 分支 ⇒ 那一条射程也补上自己的正反例。
 */
import { isGateFile } from "../lib/gate-runtime.ts"
import { judgeRegistry, type RegistryInput } from "./verify-gate-registry.ts"
import type { LegacyEntry, SpecEntry } from "./registry.ts"

let fails = 0
const ok = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`)
  if (!cond) fails++
}

const specEntry = (over: Partial<SpecEntry> = {}): SpecEntry => ({
  id: "a",
  spec: "a.spec.ts",
  tiers: ["fast"],
  owner: "lead",
  since: "2026-11-09",
  status: "active",
  ...over,
})

/** legacy 条目：一条登记 = 一个已有脚本 + N 格（与 registry.json 里的真实形状一致）。 */
const legacyEntry = (over: Partial<LegacyEntry> = {}): LegacyEntry => ({
  id: "a",
  kind: "legacy",
  script: "scripts/a.mjs",
  owner: "lead",
  since: "2026-11-09",
  status: "active",
  cells: [{ id: "a", runner: "check", arg: "--check", label: "a", tiers: ["fast"] }],
  ...over,
})

const mk = (over: Partial<RegistryInput> = {}): RegistryInput => ({
  gatesOnDisk: ["a.ts"],
  entries: [specEntry()],
  registryExists: true,
  specExists: () => true,
  scriptExists: () => true,
  ledger: {},
  today: "2026-11-16",
  ...over,
})

const findingHas = (r: { findings?: { detail: string }[] }, needle: string) => (r.findings ?? []).some((f) => f.detail.includes(needle))

export function run(): boolean {
  fails = 0
  console.log("verify-gate-registry.spec")

  ok("正例：盘上与注册表一致 ⇒ passed", judgeRegistry(mk()).status === "passed")

  {
    const r = judgeRegistry(mk({ gatesOnDisk: ["a.ts", "b.ts"] }))
    ok("反例：盘上有未登记 ⇒ failed 且点名 b.ts", r.status === "failed" && findingHas(r, "b.ts"))
  }

  {
    const r = judgeRegistry(mk({ entries: [specEntry({ tiers: [] })] }))
    ok("反例：登记了但没有任何档 ⇒ failed", r.status === "failed" && findingHas(r, "没有任何执行档"))
  }

  {
    const r = judgeRegistry(mk({ specExists: () => false }))
    ok("反例：缺同名 spec ⇒ failed", r.status === "failed" && findingHas(r, "缺同名 spec"))
  }

  {
    const r = judgeRegistry(mk({ entries: [specEntry({ id: "ghost", spec: "ghost.spec.ts" })] }))
    ok("反例：悬空注册（盘上没有实体）⇒ failed", r.status === "failed" && findingHas(r, "悬空"))
  }

  {
    const r = judgeRegistry(mk({ entries: [specEntry({ owner: "  " })] }))
    ok("反例：owner 为空白 ⇒ failed", r.status === "failed" && findingHas(r, "owner 为空"))
  }

  {
    const r = judgeRegistry(mk({ registryExists: false }))
    ok("缺输入：registry 不存在 ⇒ unjudged（不是绿）", r.status === "unjudged" && r.reason === "no-corpus")
  }

  // ── ISS-746：kind:"legacy" 分支的射程（每条都要有反例，否则「扩了射程」是空话）──
  {
    // 正例：legacy 条目**不该**被 `.ts` 双向判牵连（它是 .mjs，盘上没有 a.ts 也不算悬空）
    const r = judgeRegistry(mk({ gatesOnDisk: [], entries: [legacyEntry()] }))
    ok("legacy 正例：盘上无 .ts 也不算悬空 ⇒ passed", r.status === "passed", )
  }
  {
    const r = judgeRegistry(mk({ entries: [legacyEntry()], scriptExists: () => false }))
    ok("legacy 反例：script 不存在 ⇒ failed", r.status === "failed" && findingHas(r, "登记的脚本不存在"))
  }
  {
    const r = judgeRegistry(mk({ entries: [legacyEntry({ cells: [] })] }))
    ok("legacy 反例：cells[] 为空 ⇒ failed", r.status === "failed" && findingHas(r, "cells[] 为空"))
  }
  {
    const r = judgeRegistry(mk({ entries: [legacyEntry({ timeoutMs: 60000 as never })] }))
    ok("legacy 反例：写了 timeoutMs ⇒ failed（绕过核数折算）", r.status === "failed" && findingHas(r, "不许写 timeoutMs"))
  }
  {
    const r = judgeRegistry(mk({ entries: [legacyEntry({ cells: [{ id: "a", runner: "bogus" as never, arg: "", label: "a", tiers: ["fast"] }] })] }))
    ok("legacy 反例：runner 不合法 ⇒ failed", r.status === "failed" && findingHas(r, "runner 不合法"))
  }
  {
    const r = judgeRegistry(mk({ entries: [legacyEntry({ cells: [{ id: "a", runner: "check", arg: "", label: "a", tiers: [] }] })] }))
    ok("legacy 反例：格没有执行档 ⇒ failed", r.status === "failed" && findingHas(r, "没有任何执行档"))
  }
  {
    // classify：`false` 必须允许出现在**任何** runner 上（调度器靠 `!== undefined` 分派到 VERDICT[badge]，
    // 省略就把 livecheck 的 exit 3「判不了」读成红 —— ISS-748/F2 两次踩）。
    // 只有 `true` 才限定 check 档（guard 的 `--classify` 只有 migration-baseline 一条 used）。
    const liveFalse = judgeRegistry(
      mk({ gatesOnDisk: [], entries: [legacyEntry({ cells: [{ id: "a", runner: "livecheck", arg: "", label: "a", tiers: ["fast"], classify: false }] })] }),
    )
    ok("classify 正例：livecheck 显式 false ⇒ passed（省略才是错的）", liveFalse.status === "passed")

    const liveTrue = judgeRegistry(
      mk({ gatesOnDisk: [], entries: [legacyEntry({ cells: [{ id: "a", runner: "livecheck", arg: "", label: "a", tiers: ["fast"], classify: true }] })] }),
    )
    ok("classify 反例：livecheck 写 true ⇒ failed（该字段只给 check 档）", liveTrue.status === "failed" && findingHas(liveTrue, "classify:true 只对 check 档有意义"))

    const checkTrue = judgeRegistry(
      mk({ gatesOnDisk: [], entries: [legacyEntry({ cells: [{ id: "a", runner: "check", arg: "--check", label: "a", tiers: ["fast"], classify: true }] })] }),
    )
    ok("classify 正例：check 写 true ⇒ passed（migration-baseline 那种）", checkTrue.status === "passed")
  }
  {
    // 格 id 撞车：同一脚本两格同 id，或 legacy 格与 spec 条目同 id —— 调度器会出两格同名
    const dupInEntry = judgeRegistry(
      mk({
        gatesOnDisk: [],
        entries: [legacyEntry({ cells: [
          { id: "a", runner: "check", arg: "--check", label: "a", tiers: ["fast"] },
          { id: "a", runner: "selfcheck", arg: "--selftest", label: "a2", tiers: ["fast"] },
        ] })],
      }),
    )
    ok("legacy 反例：同条目内格 id 撞车 ⇒ failed", dupInEntry.status === "failed" && findingHas(dupInEntry, "格 id 撞车"))

    // ISS-749 实测事故的回归用例：整条条目存两份（两分支各自新增同一批，合并后各留一份）。
    // 措辞必须直指「条目重复」，否则只看到 12×2 条格级噪音，看不出根因。
    const dupEntry = judgeRegistry(
      mk({ gatesOnDisk: [], entries: [legacyEntry({ id: "dup" }), legacyEntry({ id: "dup" })] }),
    )
    ok(
      "反例：整条 legacy 条目重复 2 份 ⇒ failed 且措辞指根因",
      dupEntry.status === "failed" && findingHas(dupEntry, "条目重复 2 份"),
    )

    const dupCrossKind = judgeRegistry(
      mk({ gatesOnDisk: ["a.ts"], entries: [specEntry(), legacyEntry({ id: "other" })] }),
    )
    ok("反例：legacy 格 id 与 spec 条目 id 撞车 ⇒ failed", dupCrossKind.status === "failed" && findingHas(dupCrossKind, "格 id 撞车"))
  }
  {
    // 缺输入：没有 scriptExists 探针 ⇒ 不判脚本存在性（不因此判红，也不冒充绿）
    // gatesOnDisk 必须清空：本用例的 registry 里只有 legacy 条目，盘上留一个 a.ts 会正确地
    // 判「盘上有判据但没登记」（那是另一条射程，不能混进来干扰这条断言）。
    const r = judgeRegistry(mk({ gatesOnDisk: [], entries: [legacyEntry()], scriptExists: undefined }))
    ok("legacy 缺输入：无 scriptExists 探针 ⇒ 不误判红", r.status === "passed")
  }

  // ── ISS-854：`next` 档的格必须**始终**有票（与当前判不判得了无关）──
  // 这一节的每条反例都是本单的**核心判据**：无票 / 空票 / 过期票 / 非日期 / 台账读不到，
  // 且全部在「该格是绿的」这个前提下判红 —— 因为「绿」正是旧实现看不见它的原因。
  {
    const nextEntry = (over: Partial<SpecEntry> = {}) => specEntry({ tiers: ["next"], ...over })
    const ticket = { ticket: "ISS-835", expires: "2026-12-31" }

    // 正例：next 格 + 有票 + 未过期 ⇒ 绿（这是补票后的现状）
    ok(
      "next 正例：格有票且未过期 ⇒ passed",
      judgeRegistry(mk({ entries: [nextEntry()], ledger: { a: ticket } })).status === "passed",
    )

    // ⛔ 本单要治的那个洞：next 格无票，而它**是绿的** ⇒ 必须红
    {
      const r = judgeRegistry(mk({ entries: [nextEntry()], ledger: {} }))
      ok("next 反例：格无票（且它当前是绿的）⇒ failed", r.status === "failed" && findingHas(r, "没有票"))
    }

    // 非 next 档的格**不要求**票 —— 否则这条判据会把全仓 190+ 格都判红
    ok(
      "next 干扰：不在 next 档的格无票 ⇒ 仍 passed（射程不外溢）",
      judgeRegistry(mk({ entries: [specEntry({ tiers: ["fast"] })], ledger: {} })).status === "passed",
    )

    // 反例：票在但 expires 是昨天 ⇒ 红（到期日不是装饰）
    {
      const r = judgeRegistry(mk({ entries: [nextEntry()], ledger: { a: { ticket: "ISS-835", expires: "2026-11-15" } } }))
      ok("next 反例：票已过期 ⇒ failed", r.status === "failed" && findingHas(r, "票已过期"))
    }

    // 边界：expires **恰好等于今天** ⇒ 不算过期（到期当天仍有效，次日才红）
    // 这条钉住 `<` 而不是 `<=`：差一个等号会让「今天到期」提前一天红，且没人查得出为什么。
    ok(
      "next 边界：expires 恰等于今天 ⇒ 仍 passed（`<` 不是 `<=`）",
      judgeRegistry(mk({ entries: [nextEntry()], ledger: { a: { ticket: "ISS-835", expires: "2026-11-16" } }, today: "2026-11-16" })).status === "passed",
    )

    // 反例：ticket 是空白串 —— 有 expires 也不算有票（「写到字段了」不等于「写明是哪张单」）
    {
      const r = judgeRegistry(mk({ entries: [nextEntry()], ledger: { a: { ticket: "  ", expires: "2026-12-31" } } }))
      ok("next 反例：ticket 是空白 ⇒ failed", r.status === "failed" && findingHas(r, "ticket 为空"))
    }

    // 反例：没有 expires —— 台账自己的 _rules 写着「不许写永久」，缺到期日就是永久票
    {
      const r = judgeRegistry(mk({ entries: [nextEntry()], ledger: { a: { ticket: "ISS-835" } } }))
      ok("next 反例：缺 expires（永久票）⇒ failed", r.status === "failed" && findingHas(r, "没有 expires"))
    }

    // 反例：expires 不是 YYYY-MM-DD —— 字符串比较下 "2026-13-01" 之类的怪值会让「过期」判不准
    {
      const r = judgeRegistry(mk({ entries: [nextEntry()], ledger: { a: { ticket: "ISS-835", expires: "20261231" } } }))
      ok("next 反例：expires 不是 YYYY-MM-DD ⇒ failed", r.status === "failed" && findingHas(r, "不是 YYYY-MM-DD"))
    }

    // 缺输入：台账读不到 ⇒ 判不了，**不许**当成「全都有票」放行（那就是「删台账 = 更绿」）
    ok(
      "next 缺输入：台账读不到 ⇒ unjudged（不是绿、也不是红）",
      judgeRegistry(mk({ entries: [nextEntry()], ledger: null })).status === "unjudged",
    )

    // legacy 条目的 next 票按**格**判，不按条目并集判 —— 同一脚本的 --check 进 next 而
    // --selftest 不进是常态，拿条目并集给不跑的格要票会造出假红。
    {
      const twoCells = legacyEntry({
        cells: [
          { id: "c1", runner: "check", arg: "--check", label: "c1", tiers: ["next"] },
          { id: "c2", runner: "check", arg: "--check2", label: "c2", tiers: ["fast"] },
        ],
      })
      // 只给进 next 的那一格票 ⇒ 不该因为 c2 无票而红
      ok(
        "legacy 正例：next 票按格判，非 next 的格不要求票",
        judgeRegistry(mk({ gatesOnDisk: [], entries: [twoCells], ledger: { c1: ticket } })).status === "passed",
      )
      // 而 c1 无票必须红，且点名到格
      const r = judgeRegistry(mk({ gatesOnDisk: [], entries: [twoCells], ledger: { c2: ticket } }))
      ok("legacy 反例：next 格无票 ⇒ failed 且点名该格", r.status === "failed" && findingHas(r, "c1"))
    }

    // ⚠️ deprecated 条目不要求票：`deriveRegistryGates()` 只派生 active 条目，
    // deprecated 的格永远不跑 ⇒ 也就永远不会有「绿 → 判不了」的转变。对它要票只是噪音。
    {
      const dep = specEntry({ tiers: ["next"], status: "deprecated" })
      ok(
        "next 正例：deprecated 条目无票 ⇒ 不误伤（它根本不进调度器）",
        judgeRegistry(mk({ entries: [dep], ledger: {} })).status === "passed",
      )
    }
  }

  // 干扰形态：spec / registry 自身 / 备份文件都不算判据
  ok("干扰：a.spec.ts 不算判据", isGateFile("a.spec.ts") === false)
  ok("干扰：registry.ts 不算判据", isGateFile("registry.ts") === false)
  ok("干扰：registry.ts.bak 不算判据", isGateFile("registry.ts.bak") === false)
  ok("正例：a.ts 算判据", isGateFile("a.ts") === true)

  console.log(fails ? `✗ ${fails} 条不成立` : "✓ spec 全过（spec 正例/反例×5 · legacy 正例 1/反例×7/缺输入 1 · 干扰×3 · 缺输入×1）")
  return fails === 0
}
