/**
 * 元判据：判据注册表是否「盘上 ↔ 注册表」双向一致（ISS-737）。
 *
 * 依据：`docs/plans-k-replacement-2026-11-09.md` §5.3。
 * 这是本次替换最该先落的一条 —— ISS-732 实测 187 个脚本里 8 个从未接线，
 * 旧体系只管「盘上有但没登记」，删脚本后注册表会静默留空。
 *
 * 双向判**按 kind 分两条射程**（ISS-746 试点扩了 legacy 分支）：
 *   · `kind:"spec"`（缺省，新载体 `.ts`）：
 *       盘上有 `scripts/gates/*.ts` ⇒ 注册表必须有；
 *       注册表有 ⇒ 盘上必须有 `.ts` / 有同名 `.spec.ts` / 至少一个 tier。
 *   · `kind:"legacy"`（guard 派生格的迁移目标，已有脚本 + cells[]）：
 *       盘上必须有 `script`；`cells[]` 非空；每格 id 非空且全表唯一；runner ∈ 四值；tiers 非空；
 *       ⛔ 不许写 timeoutMs（超时由调度器的 MEASURED × 核数折算，写死会绕过折算）。
 *       ⚠️ legacy 条目**不参与** `.ts` 双向判 —— 它是 `.mjs`/`.sh`，本来就没有 `.ts` 与 spec。
 *   · 两条共同：`owner` / `since` 不许为空。
 *
 * ## 第三条射程：`next` 档的格必须**始终**有票（ISS-854）
 *
 * `tiers` 含 `next` 的格（spec 条目按条目本身，legacy 按 `cells[]` 逐格）必须在
 * `scripts/baseline/unjudged-ledger.json` 的 `gates.<格 id>` 下登记非空 `ticket` 与未过期的
 * `expires`，**与它当前判不判得了无关**。
 *
 * 为什么这必须由本判据独立判一次（而不是指望 ISS-728 那道无票检查）：
 * `run-gates.mjs` 的 `unjudgedViolations()` 只遍历**本次真的 unjudged 的格** ⇒ 绿的格无票完全静默。
 * 于是它可以在无人察觉时转成 unjudged，届时 `--tier next` 从 `EXIT=0` 突然变 `1`，
 * 而现场表现是一个与当前工作无关的格红了，没人能把症状与原因连起来。
 * 实测样本：`lint-rule-fingerprint` 在 next 档一直绿、一直无票（ISS-854 报出）。
 *
 * ⇒ **票的语义是「我知道这格现在判不了 / 可能判不了，且有到期日」。「现在恰好绿」不构成
 *   「不需要票」的理由 —— 恰恰相反，绿着的格最容易在无人察觉时变成判不了。**
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isGateFile, isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"
import type { CellRunner, RegistryEntry } from "./registry.ts"

const GATES_DIR = path.dirname(fileURLToPath(import.meta.url))
const CELL_RUNNERS: CellRunner[] = ["check", "selfcheck", "livecheck", "report_only"]
/** 「判不了」豁免台账（相对仓库根）。条目在 `gates.<格 id>` 下。 */
const LEDGER_REL = "scripts/baseline/unjudged-ledger.json"

export interface RegistryInput {
  /** 盘上的判据文件名（`.ts`，不含 spec 与 registry） */
  gatesOnDisk: string[]
  entries: RegistryEntry[]
  registryExists: boolean
  specExists: (spec: string) => boolean
  /** legacy 条目的脚本存在性判定（相对仓库根）；缺省视为「判不了」⇒ 不判绿。 */
  scriptExists?: (rel: string) => boolean
  /**
   * 「判不了」豁免台账 = `unjudged-ledger.json` 的 **`gates` 对象**（不是文件顶层）。
   * `null` = 台账读不到 / 不是合法 JSON ⇒ 判不了（**不许当「全都有票」放行**）。
   */
  ledger: LedgerGates | null
  /** 今天的日期 `YYYY-MM-DD`（由调用方注入：spec 要能钉住「恰好到期当天」这种边界）。缺省 = 真实今天。 */
  today?: string
}

/** 台账里一格的票据（本判据只读这三个字段，其余字段归 `run-gates` 的口径）。 */
export interface LedgerTicket {
  ticket?: string
  expires?: string
}

/** `unjudged-ledger.json` 的 `gates` 段。 */
export type LedgerGates = Record<string, LedgerTicket | undefined>

/** 纯函数：spec 可直接喂构造数据；不碰文件系统。 */
export function judgeRegistry(input: RegistryInput): GateResult {
  const gate = "verify-gate-registry"
  if (!input.registryExists) {
    return unjudged(gate, "no-corpus", "scripts/gates/registry.ts 不存在 ⇒ 判不了「有没有接线」")
  }
  // 台账读不到 ⇒ 判不了。⛔ 不许当成「全都有票」放行：那正是「删掉台账 = 更绿」。
  if (input.ledger === null) {
    return unjudged(gate, "no-baseline", "scripts/baseline/unjudged-ledger.json 读不到或 gates 段不是对象 ⇒ 判不了「next 档的格有没有票」")
  }

  const findings: string[] = []
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  const onDisk = new Set(input.gatesOnDisk)
  // 只有 spec 条目参与 `.ts` 双向判；legacy 条目是已存在的 .mjs/.sh，没有 .ts 与 spec。
  const specEntries = input.entries.filter((e) => e.kind !== "legacy")
  const known = new Set(specEntries.map((e) => e.id))

  for (const f of input.gatesOnDisk) {
    const id = f.replace(/\.ts$/, "")
    if (!known.has(id)) findings.push(`${f}：盘上有判据但 registry.ts 没有登记`)
  }

  // 格 id 全局唯一：legacy 的 cells 与 spec 的条目 id 共用调度器命名空间，
  // 撞了会让 --list 出现两格同名（用户看到的是「同一格跑两遍」，而两边各自都是"对"的）。
  const seenCellIds = new Map<string, string>()
  const claim = (id: string, where: string) => {
    const prev = seenCellIds.get(id)
    if (prev) findings.push(`${id}：格 id 撞车（${prev} 与 ${where}）`)
    else seenCellIds.set(id, where)
  }

  // 条目 id 也必须唯一（ISS-749 实测事故）：同一条目存两份时，cells 里的格 id 会**成对**重复，
  // 上面那条「格 id 撞车」其实也会报 —— 但它报的是 12 × 2 条格级噪音，看不出根因是「整条目重复」。
  // 更要紧的是：`run-gates --list` 遇到这种情况会**直接抛 RegistryError 崩掉**，
  // 而本判据自己没崩（它只读数组长度）⇒ 事故现场被误读成「判据没报警」。
  // 所以在这里按条目 id 单独判一次，措辞直指根因（多半是两个分支各自新增了同一批条目）。
  const seenEntryIds = new Map<string, number>()
  for (const e of input.entries) seenEntryIds.set(e.id, (seenEntryIds.get(e.id) ?? 0) + 1)
  for (const [id, n] of seenEntryIds) {
    if (n > 1) findings.push(`${id}：条目重复 ${n} 份（多为两个分支各自新增同一批条目后合并所致；按 id 去重）`)
  }

  for (const e of specEntries) {
    if (!onDisk.has(`${e.id}.ts`)) findings.push(`${e.id}：registry 有登记但盘上没有 ${e.id}.ts（悬空注册）`)
  }

  for (const e of input.entries) {
    // 执行档：spec 条目在条目上（一格判据一个档集），legacy 条目在**每一格**上
    // （同一脚本的 --check 与 --selftest 经常不同档；条目级写并集等于把两件事压成一个数）。
    if (e.kind !== "legacy" && (!Array.isArray(e.tiers) || e.tiers.length === 0)) findings.push(`${e.id}：没有任何执行档（登记了但永远不跑）`)
    if (!e.owner?.trim()) findings.push(`${e.id}：owner 为空`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.since ?? "")) findings.push(`${e.id}：since 不是 YYYY-MM-DD（实际 ${JSON.stringify(e.since)}）`)

    /**
     * `next` 档的格必须**始终**有票（ISS-854）—— 与它当前判不判得了无关。
     *
     * ⚠️ 键用**格 id**（legacy 用 `cell.id`，spec 用条目 id）：调度器的 `unjudgedViolations()`
     *   按 `r.gate.id` 查台账，两处必须同一套命名空间，否则查的是同一件事的两份账。
     * ⚠️ 只判 `status:"active"` 的条目：`deriveRegistryGates()` 只把 active 的条目送进调度器，
     *   deprecated 的格永远不会跑 ⇒ 也就永远不会有「绿 → 判不了」的转变 ⇒ 对它要票只是噪音。
     *   这**不构成逃逸口**：标 deprecated 的代价是该格从调度里彻底消失（另一条射程管着不许静默丢格）。
     */
    const checkTicket = (id: string, where: string) => {
      const t = input.ledger?.[id]
      if (!t) {
        findings.push(
          `${id}：${where}进了 next 档，但 unjudged-ledger.json 里没有票 —— next 档每格都必须有票（ticket + expires），与它当前判不判得了无关（ISS-854）`,
        )
        return
      }
      if (!t.ticket?.trim()) findings.push(`${id}：${where}进了 next 档，但台账的 ticket 为空 —— 票必须写明是哪张单在兜`)
      if (!t.expires) findings.push(`${id}：${where}进了 next 档，但台账没有 expires —— 不许写「永久」，必须有到期日`)
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(t.expires)) {
        findings.push(`${id}：${where}台账的 expires 不是 YYYY-MM-DD（实际 ${JSON.stringify(t.expires)}）—— 不是日期就没法判「到期」，等于永久票`)
      } else if (t.expires < today) findings.push(`${id}：${where}进了 next 档且票已过期（${t.ticket} · ${t.expires} < ${today}）—— 续期请写明理由，不许写永久`)
    }
    const active = e.status === "active"

    if (e.kind === "legacy") {
      const cells = Array.isArray(e.cells) ? e.cells : []
      if (!e.script?.trim()) findings.push(`${e.id}：legacy 条目的 script 未填`)
      else if (input.scriptExists && !input.scriptExists(e.script)) findings.push(`${e.id}：legacy 条目登记的脚本不存在（${e.script}）`)
      if (!cells.length) findings.push(`${e.id}：legacy 条目的 cells[] 为空（登记了但一格都不跑）`)
      if (e.timeoutMs !== undefined) findings.push(`${e.id}：legacy 条目不许写 timeoutMs（超时由 MEASURED × 核数折算，写死会绕过折算）`)
      for (const c of cells) {
        if (!c.id?.trim()) findings.push(`${e.id}：有 cell 缺 id`)
        else claim(c.id, `${e.id} 的 cell`)
        if (!CELL_RUNNERS.includes(c.runner)) findings.push(`${e.id}/${c.id}：runner 不合法（${JSON.stringify(c.runner)}）`)
        if (!Array.isArray(c.tiers) || c.tiers.length === 0) findings.push(`${e.id}/${c.id}：没有任何执行档`)
        // `classify` 不是「check 档专属」：调度器的 `classifyOutcome()` 用 `gate.classify !== undefined`
        // 决定要不要走 `VERDICT[badge]` 分档，**每个 badge 都需要这个字段**（省略就退化成
        // 「rc≠0 一律红」，把 livecheck/check 的 exit 3「判不了」读成红）。所以 `false` 必须允许出现在任何 runner 上。
        // 但 `true` 只对 check 有意义 —— guard 的 `--classify`（「基线过期 / 真回归」再分一类）
        // 只给 migration-baseline 那一条 check 行用过；写在别的 runner 上说明登记填错了格。
        if (c.classify === true && c.runner !== "check") findings.push(`${e.id}/${c.id}：classify:true 只对 check 档有意义（runner=${c.runner}）`)
        // ISS-854：next 档按**格**判（legacy 的 tiers 在格上）—— 同一脚本的 --check 进 next
        // 而 --selftest 不进是常态，拿条目级并集判会给不跑的格要票。
        if (active && c.id?.trim() && Array.isArray(c.tiers) && c.tiers.includes("next")) checkTicket(c.id, `${e.id} 的格 `)
      }
    } else {
      claim(e.id, `${e.id} 的 spec 条目`)
      if (!e.spec?.trim()) findings.push(`${e.id}：spec 未填`)
      else if (!input.specExists(e.spec)) findings.push(`${e.id}：缺同名 spec（${e.spec}）`)
      if (active && Array.isArray(e.tiers) && e.tiers.includes("next")) checkTicket(e.id, "spec 条目")
    }
  }

  return findings.length ? { gate, status: "failed", findings: findings.map((detail) => ({ detail })) } : { gate, status: "passed", findings: [] }
}

/**
 * 读「判不了」豁免台账的 `gates` 段（ISS-854）。
 *
 * ⚠️ 条目在 `gates.<id>` 下，**不在文件顶层** —— 读错层会让每一格都「无票」，
 *    而那时的表现是所有 next 格一起红，看起来像判据坏了。
 * 返回 `null`（判不了）的两种形态：文件读不到 / 不是合法 JSON / `gates` 不是对象。
 * ⛔ 三种都**不许**当成空台账放行 —— 那等于「删掉台账 ⇒ 全绿」。
 */
function readLedger(repoRoot: string): LedgerGates | null {
  try {
    const j: unknown = JSON.parse(fs.readFileSync(path.join(repoRoot, LEDGER_REL), "utf8"))
    const gates = isRecord(j) ? j.gates : undefined
    return isRecord(gates) ? (gates as LedgerGates) : null
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

async function scan(): Promise<RegistryInput> {
  const names = fs.existsSync(GATES_DIR) ? fs.readdirSync(GATES_DIR) : []
  const registryPath = path.join(GATES_DIR, "registry.ts")
  const registryExists = fs.existsSync(registryPath)
  const repoRoot = path.resolve(GATES_DIR, "..", "..")
  let entries: RegistryEntry[] = []
  if (registryExists) {
    const mod = await import(pathToFileURL(registryPath).href)
    entries = Array.isArray(mod.REGISTRY) ? mod.REGISTRY : []
  }
  return {
    gatesOnDisk: names.filter(isGateFile),
    entries,
    registryExists,
    specExists: (s: string) => fs.existsSync(path.join(GATES_DIR, s)),
    scriptExists: (rel: string) => fs.existsSync(path.join(repoRoot, rel)),
    ledger: readLedger(repoRoot),
  }
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：--selftest 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（Node 报 unsettled top-level await, rc=13）。
  //   改为不阻塞模块求值，完成后再设 exitCode。
  runGate({ name: "verify-gate-registry", main: async () => judgeRegistry(await scan()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ verify-gate-registry: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
