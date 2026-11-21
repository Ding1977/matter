/**
 * 判据注册表（ISS-737 / ISS-740）—— 「有哪些判据、在哪些档跑、谁负责」的唯一真相源。
 *
 * 依据：`docs/plans-k-replacement-2026-11-09.md` §5.3。
 * 约束（由 `verify-gate-registry.ts` 双向判）：
 *   · 盘上有 `scripts/gates/*.ts` ⇒ 这里必须登记（`kind:"spec"`）
 *   · `kind:"spec"` 登记了 ⇒ 盘上必须有 `.ts` 实体、必须有同名 `.spec.ts`、必须至少进一个 tier
 *   · `kind:"legacy"` 登记了 ⇒ `script` 必须在盘上、`cells[]` 非空、每格有 id/runner/tiers
 *   · `owner` / `since` 不许为空
 *   · **每格必须有 `semantics`**（ISS-821）—— 与 `tiers` 正交的第二维度，答「红意味着什么」。
 *     词表唯一真相源 = `scripts/lib/semantics-filter.mjs` 的 `SEMANTICS`；不适用写 `["none"]`。
 *     由 `run-gates` 的 `buildRegistry()` 判（不在 `--selftest`，见那里的注释：selftest 零自动接线）。
 *
 * 新增一条判据时，**先加这里再写脚本**，否则 verify-gate-registry 会红。
 *
 * 为什么数据拆到 `registry.json`（ISS-740）：`run-gates.mjs` 是 `.mjs` 且 `buildRegistry()` 是同步的，
 * import `.ts` 要么把整条链改异步、要么解析源码文本；拆成 JSON 后调度器与元判据读**同一份数据**，
 * 不会出现「registry 一份、run-gates 一份」的双写。
 *
 * 为什么有 `kind:"legacy"`（ISS-746）：`run-gates` 原先靠正则解析 `guard-baselines.sh` 的 103 条登记行
 * 来派生格（`deriveGuardGates()`）。那份清单的真实形态是「已有脚本 + 每脚本 1~3 个动作」，
 * 与「一条判据 = 一个 .ts」的新载体不同型。`legacy` 用 `script` + `cells[]` 表达它，
 * 迁移期与派生结果按 id 去重（registry 优先），迁完即可删掉解析器。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type Tier = "pre-commit" | "fast" | "full" | "ci" | "scheduled" | "next" | "doc" | "doc-sync"

/** guard-baselines 的四种执行档；同时是调度器侧的 badge。 */
export type CellRunner = "check" | "selfcheck" | "livecheck" | "report_only"

interface EntryBase {
  /** 条目 id（spec 条目 = 文件名去 `.ts`；legacy 条目 = 脚本名去扩展名，与格 id 共用命名空间） */
  id: string
  /** 负责人（成员名 / 角色），不许空 */
  owner: string
  /** 登记日期 YYYY-MM-DD */
  since: string
  status: "active" | "deprecated"
  /** 人读备注（调度器不读；用于记录为什么暂不进某档 / 迁移来源） */
  note?: string
  /**
   * 只报不红：红照出，但不计入 run-gates 的阻断（`exitCodeOf()` 不因它返回 1）。
   * 用在哪：老板 2026-11-13 裁决「过程记录类文档不进审查、不走门禁」——
   * 只降强度（红继续出现在屏幕上，用于发现腐化），不把它移出屏幕。
   *
   * ⛔ 为 true 时 `allowFailureWhy` 必填 —— 仓里已有这条判据（`run-gates --selftest`
   *    「allowFailure 必须写理由」），新字段受同一条约束，不许绕过。
   * ⚠️ `kind:"legacy"` 写在该格的 `cells[i]` 上，不写条目级 —— 同 `tiers` 的理由：
   *    同一脚本的 `--check` 与 `--selftest` 经常一格该免、一格不该免。
   */
  allowFailure?: boolean
  /** 为什么只报不红。不写理由就不许 `allowFailure`（同 `--selftest` 那条判据的口径）。 */
  allowFailureWhy?: string
}

/** 新载体：一个 `.ts` 判据 + 同名 spec，一脚本一格。 */
export interface SpecEntry extends EntryBase {
  kind?: "spec"
  /** 同名 spec 的文件名（相对 scripts/gates/） */
  spec: string
  /** 至少一个执行档；空数组 = 登记了但永远不跑 */
  tiers: Tier[]
  /** 语义标签（见文件头 `SEMANTICS`）。spec 条目一格一个档集 ⇒ 语义也写在条目上。 */
  semantics?: string[]
  /** 调度器超时；缺省 120s */
  timeoutMs?: number
}

/** guard 派生格的迁移目标：已有脚本 + 1~N 个动作格。 */
export interface LegacyEntry extends EntryBase {
  kind: "legacy"
  /** 相对仓库根的脚本路径（例 `scripts/lint-code.mjs` / `forge-pm/scripts/link-health.mjs`） */
  script: string
  /**
   * 该脚本的每一格。档位写在**格上**，不在条目上 —— 同一脚本的 `--check` 与 `--selftest`
   * 经常不同档（例 `lint-code`: --check 在 full/ci，--selftest 在 fast/full/ci），
   * 条目级 tiers 只能表达并集，是把两件不同的事压成一个数。
   */
  cells: LegacyCell[]
  /**
   * ⛔ 不许有 timeoutMs：超时由调度器的 MEASURED 表 × 核数折算（ISS-725），
   * 写死就等于绕过折算，少核机器上会稳定撞线。
   */
  timeoutMs?: never
}

export interface LegacyCell {
  /** 格 id，必须与迁移前 `--list` 的 id 逐字相同（同名条目内唯一） */
  id: string
  /** guard 的执行档语义；同时是调度器侧的 badge（`guardRunsInFast()` 认它） */
  runner: CellRunner
  /** 传给脚本的 argv；无参格写空串（`livecheck` 靠空串占位，不能省略） */
  arg: string
  /** 人读标签，与 guard 打印的名字同源 */
  label: string
  /** 至少一个执行档；空数组 = 登记了但永远不跑 */
  tiers: Tier[]
  /**
   * 语义标签（ISS-821）：这一格红说明「什么坏了」，与 `tiers`（什么时候跑）正交。
   * 词表唯一真相源 = `scripts/lib/semantics-filter.mjs` 的 `SEMANTICS`，合法值由
   * `validateSemantics()` 现场判（不在这里抄一份数组 —— 抄了就会两份漂移）。
   *
   * ⛔ 每格至少一个，不适用写 `["none"]`。「没写」与「写了 none」处置相反，
   *    前者是配置缺项，后者是判过的结论。
   * ⚠️ `kind:"legacy"` 写在**每一格**上，不写条目级 —— 同 `tiers` / `allowFailure` 的理由：
   *    同一脚本的 `--check`（契约破了）与 `--selftest`（判据没牙了）红得不是一回事。
   */
  semantics?: string[]
  /**
   * guard 登记行第 4 参的 `--classify`（只有 `migration-baseline --check` 打开）。
   * 语义：`check` 档拿到 exit≠0 时先分「基线过期 / 真回归」再决定要不要进 fail。
   * ⚠️ 省略时调度器按 `false` 处理（见 `legacyCellGate()` 的注释：那个字段必须**显式**给，
   * 因为 `classifyOutcome()` 用 `!== undefined` 分派，省略会退化成「rc≠0 一律红」）。
   */
  classify?: boolean
  /**
   * 只报不红（格级，语义同 `EntryBase.allowFailure`）。
   * ⚠️ legacy 条目的文档类豁免必须写在**格上**而不是条目上：条目级会连 `--selftest`
   * 一起免掉，判据自己的反向自检不该跟着文档豁免一起降级。
   * ⛔ 为 true 时 `allowFailureWhy` 必填（同一条判据）。
   */
  allowFailure?: boolean
  /** 为什么只报不红。不写理由就不许 `allowFailure`。 */
  allowFailureWhy?: string
}

export type RegistryEntry = SpecEntry | LegacyEntry

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REGISTRY: RegistryEntry[] = JSON.parse(fs.readFileSync(path.join(HERE, "registry.json"), "utf8"))

/** 是不是 legacy 条目（类型收窄，避免各处手写 `e.kind === "legacy"` 时漏掉类型守卫）。 */
export const isLegacy = (e: RegistryEntry): e is LegacyEntry => e.kind === "legacy"
