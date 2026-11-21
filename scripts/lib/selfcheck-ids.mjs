/**
 * `--tier gateselfcheck` 选格：legacy 白名单 ∪ **新载体的派生格**（ISS-857）。
 *
 * ## 这个文件补的是什么洞
 *
 * gateselfcheck 档原先只认一张**手写**的 52 条 id 白名单。实测那 52 条
 * （`ids.filter(i => i.includes("selftest")).length === 52`，不含的为 0）**全部是旧树 legacy 格** ——
 * 也就是说新载体（`scripts/gates/<id>.ts` + 同名 `.spec.ts`）的自检**一条都没被任何档位调度**：
 *
 * | 载体 | 自检写在哪 | 改前谁跑它 |
 * |---|---|---|
 * | legacy `.mjs` | 脚本自带 `--selftest` | ✅ `--tier gateselfcheck`（52 条白名单） |
 * | **新载体 `.ts`** | 同名 `.spec.ts`，入口是 `<id>.ts --selftest` | ⛔ **没人跑** |
 *
 * `registry.json` 里 `gateselfcheck: true` 的条目实测 = **0**。所以这不是「跑得少」，
 * 是「新写一条判据，它的自检从此只在有人手敲时才跑」—— 而手敲不是调度。
 *
 * ## 为什么是「派生 + 白名单」而不是把条目登记进 JSON
 *
 * 甲档（老板 2026-11-16 拍）要求**派生**：可被 `--tier gateselfcheck` 调度的自检自动进集合。
 * 让每条条目自己在 registry 里写一个 `gateselfcheck: true` 是「登记」，不是「派生」——
 * 新增判据的人会忘（这正是本洞的成因：**靠自觉的机制已经失败过一次**）。
 * 派生则相反：新增一条 active 的非 legacy 条目，它的自检格**自动**进档，忘不了。
 *
 * ## 口径：「非 legacy 条目」，不是「`kind:"spec"` 条目」
 *
 * 实测 `registry.json`（105 条）：**字面 `kind:"spec"` 是 0 条**，`kind` 缺省 24 条、`kind:"legacy"` 81 条。
 * 所以判据只能是「`kind` 缺省或 === "spec"」= 非 legacy —— 照字面写 `kind === "spec"`
 * 会让派生数 **= 0**，本机制整段空转而屏幕上看不出任何异常。
 *
 * ## 洞的规模是 22，不是 44
 *
 * `--list` 里新增的 44 格 = **22 个 check 格 + 22 个自检格**，而那 22 个 check 格
 * **本来就在跑**（它们一直在 fast/full/ci 档里）。本单补上的是那 22 个**自检**格。
 * 读这一行的人容易把 44 当成「44 条判据的自检以前没人跑」—— 那是 22。
 *
 * legacy 那 52 条保留为白名单，理由不是懒：它们的主体身份在 registry 的 `cells[]` 里，
 * 而「哪一格是自检」这件事 legacy 世界没有可派生的判据 —— 有的是 `--selftest` 参数、
 * 也有的是名字带 selftest 而参数是 `--check`（实测 `build-index-credential-selftest@--check` 一格）。
 * 按参数猜会把「名字像自检」当「是自检」，那不是派生，是瞎猜。
 *
 * ## 为什么跑到 `scripts/lib/`
 *
 * `scripts/run-gates.mjs` 有 `verify-file-size` 的只许降棘轮（ceiling 2056，改前 2053 ⇒ 只剩 3 行）。
 * 本仓对这件事的既有处置一律是**抽出去腾空间**（`registry-derive.mjs` / `gate-tables.mjs` /
 * `next-packages-probes.mjs` 同一形态），没有一次是靠抬上限过的。
 */

/**
 * 旧树 legacy 自检格白名单（ISS-806 原表，逐字搬入，未增删）。
 *
 * ⛔ 这些**不是**「已登记的豁免」，而是「身份在 cells[] 里、无法从 spec 条目派生」的那部分。
 * 从这张表里删一条 = 那一格的自检退出 gateselfcheck 档（但它仍在 full/ci 里，
 * 见 run-gates 的 ④c 断言「换档不是关档」）。
 */
export const LEGACY_SELFCHECK_IDS = new Set([
  "web-crash-evidence-selftest", "scan-input-selftest", "lexical-lib-selftest", "caliber-lib-selftest", "dup-detail-lib-selftest",
  "dead-code-ledger-selftest", "ws-bin-mirror.test-selftest", "verify-test-wiring-selftest", "verify-hooks-installed-selftest", "route-alias-check-selftest",
  "k6a-screen-selftest", "data-root-check-selftest", "prism-lang-guard-selftest", "search-index-reconcile-selftest", "stale-client-bundle-selftest",
  "test-env-restore-guard-selftest", "review-range-selftest", "link-health-selftest", "assembly-check-selftest", "assembly-diff-check-selftest",
  "assembly-mounts-lib-selftest", "no-new-tailwind-selftest", "ui-load-contract-selftest", "migration-baseline-selftest", "md-corpus-guard-selftest",
  "audit-doc-sync-selftest", "audit-freshness-selftest", "code-inventory-selftest", "code-inventory-selftest-routes", "component-map-selftest",
  "delivery-integrity-selftest", "deps-hygiene-selftest", "format-debt-selftest", "install-shape-selftest", "preset-var-check-selftest",
  "lint-criteria-teeth-selftest", "lint-boot-log-selftest", "lint-capability-contract-selftest", "lint-channel-contract-selftest", "lint-code-selftest",
  "lint-common-selftest", "lint-cross-pkg-events-selftest", "lint-design-selftest", "lint-layer-selftest", "lint-log-outlet-selftest",
  "lint-scripts-selftest", "lint-tool-contract-selftest", "lint-writer-uniqueness-selftest", "md-mermaid-lint-selftest", "shell-utf8-var-guard-selftest",
  "ci-red-to-issue-selftest", "review-ledger-selftest",
])

/**
 * 派生格的 id 后缀。
 *
 * ⚠️ 这个后缀是**格 id 的一部分**，不是装饰：`run-gates` 的 ④c 断言按 `/selftest/` 认
 * 「自检档里的每一格都是自检」，不带后缀会让那条断言当场红 —— 而它是对的（它是防错塞的闸）。
 * 也便于 `--only verify-spec-selftest` 单独点名。
 */
export const SELFCHECK_SUFFIX = "-selftest"

/**
 * 派生格一律进这两档（对齐 legacy 自检格的实测档位：63/64 条是 `["full","ci"]`，1 条 `["full"]`）。
 *
 * ⛔ **不许把 gateselfcheck 写进这里**：它是 `gate.gateselfcheck: true` 这个**独立标记**，
 *    不是 tier。写进 tiers 会污染 fast/full/ci 的格数计数（`--list` 的 byTier 按 tiers 数），
 *    这也是 `run-gates` 里那条「不写进 tiers」断言的来历。
 */
export const SELFCHECK_TIERS = ["full", "ci"]

/**
 * 一条 registry 条目 ⇒ 它该派生的自检格（`null` = 不派生）。
 *
 * 派生规则（每条都能在真语料上验，见本文件末的 `selftestSelfcheckIds`）：
 *   · `kind` **缺省或 "spec"** —— 实测 `registry.json` 里**字面 `kind:"spec"` 是 0 条**，
 *     24 条新载体全是缺省值；所以判据必须写成「非 legacy」而不是 `=== "spec"`，
 *     否则派生数 = 0、本机制整段空转。legacy 条目的格身份在 `cells[]`，走白名单；
 *   · `status` 必须 `active` —— deprecated 的不派生（与 `deriveRegistryGates` 同一口径，
 *     两处口径漂开就会造出「条目退役了、自检格还在跑」的幽灵）；
 *   · `tiers` 必须非空 —— 一个所有档都不进的条目屏幕上根本不出现，给它造自检格是加倍浪费；
 *   · **自带 `gateselfcheck` 字段 ⇒ 抛错**（ISS-857 审查返工，见下）。
 *
 * ## 为什么「自带 gateselfcheck」必须抛错而不是 return null
 *
 * 这是本单**自己制造**的缺陷，由独立审查抓出（作者视角看不出来：注释写的是「不许静默吞」，
 * 代码写的是 `return null` —— **看注释是睡的，看行为是醒的**）。
 *
 * 现象：给一条 active 条目手写 `gateselfcheck: true`（「登记自检」最自然的那一手）⇒
 * 该格的自检**整个消失**，`--list` 的 gateselfcheck 从 74 掉到 73，**零告警**。
 * 实测确认 `full` / `ci` 也各掉一格 —— 不是「退出自检档」，是**这一格不存在**。
 *
 * 根因不是笔误，是**同名不同义**：`run-gates.mjs` 用 `gate.gateselfcheck = true` 当
 * 「这格进自检档」的**输出标记**（打给调度器格）；而 registry 条目上的 `gateselfcheck`
 * 被本函数当成「作者已显式登记」的**输入声明**。同一个字段名在两层各是一个意思。
 *
 * 本单的命题是「写了没人跑 = 没写」。`return null` 恰恰造出「配了被吞 = 没配，且不报错」——
 * 同一种病。⇒ 按 AGENTS.md「配置错误在加载时报错」，改成抛。
 *
 * ⚠️ 抛出的错误必须**不是在 import 期炸**：`run-gates.mjs` 在模块顶层取并集
 * （`const GATESELFCHECK_IDS = …`），纯函数抛错会让 `--list` / `--selftest` / `--tier`
 * **全部以 JS 栈回溯崩掉**（实测三条命令 EXIT=1 + Node.js v24.13.1 尾巴），
 * 连「用自检查这个配置错」的路都断了。故调用方用惰性求值把它推迟到 `buildRegistry()` 里，
 * 与 `timeoutMs` 缺失同族（`RegistryError`，起第一个子进程前崩）。
 *
 * ⚠️ 入口是 `--selftest`，**不是 `.spec.ts`**：`runGate()` 的 `--selftest` 会自己去找同名 spec
 *    并调它的 `run()`（`gate-runtime.ts:106`）。调度器若直接跑 vitest/`bun test` 跑 spec，
 *    那是另一套口径（不吃 `export function run()` 约定），且 .spec.ts 不进本档射程。
 */
export function deriveSelftestGate(e, repo) {
  if (!e || typeof e.id !== "string" || !e.id.trim()) return null
  // 顺序是判据：这条必须在 gateselfcheck 那条**之前** —— legacy 条目在 run-gates 侧会被打上
  // `gate.gateselfcheck` 标记，但**条目**上没有该字段（实测 legacy 自带 = 0 条）。
  // 若顺序反过来，将来任何「legacy 条目带了该字段」的形态都会误炸。
  if (e.kind !== undefined && e.kind !== "spec") return null
  if (e.status !== "active") return null
  if (!Array.isArray(e.tiers) || e.tiers.length === 0) return null
  if (e.gateselfcheck !== undefined) {
    throw new SelftestConfigError(
      `[selfcheck-ids] ${e.id} 自带 gateselfcheck 字段 —— 派生机制已自动覆盖全部 active 非 legacy 条目，` +
        `手写它不会「登记自检」，反而会让 ${e.id}${SELFCHECK_SUFFIX} 这一格被静默吞掉（实测 74→73，无告警）。删掉该字段。`,
    )
  }
  return {
    id: `${e.id}${SELFCHECK_SUFFIX}`,
    label: `[新载体] ${e.id} 自检`,
    // badge = VERDICT 的分派键。selfcheck 档读退出码：0 = 自检成立，非 0 = 红（没有第三态）。
    badge: "selfcheck",
    command: process.execPath,
    args: [`${repo}/scripts/gates/${e.id}.ts`, "--selftest"],
    cwd: repo,
    // 档位写死成 full/ci，**不抄条目的 tiers**：条目可能只进 next 档（新判据落地时常这样），
    // 若抄它的 tiers，那条判据的自检就第一次出场就「不在任何常规档」——换档变成丢档。
    tiers: [...SELFCHECK_TIERS],
    // 自检是纯判据自查，实测最慢 0.35s（publint-all）⇒ 60s 兜底对 20 倍余量都够；
    // 不读 MEASURED 表：那张表是**调度实测**，自检不在里面，硬查会拿到缺省值，绕一圈等于没写。
    timeoutMs: 120_000,
    source: REGISTRY_SPEC_SOURCE,
    // 语义是「判据自身失去判别力」，与 legacy 自检格同一档（实测 64/64 都声明 selftest）。
    semantics: ["selftest"],
  }
}

/**
 * registry 里 spec 条目的 source 标记 —— **必须与 `registry-derive.mjs` 的 specEntryGate() 逐字相同**。
 *
 * 为什么这不是「又一个魔法字符串」：`verify-gate-coverage` 的 ② 用 `REGISTRY_SOURCES`
 * 判「这一格的来源合不合法」，再把来源合法的格拿 `declaredIds` 核一遍「registry 里真有这条 active 声明」。
 * 两边字符串一旦分叉，派生出来的自检格会被判成「实际有但无归属」⇒ gateselfcheck 上线当天连红 22 格。
 */
export const REGISTRY_SPEC_SOURCE = "gates/registry.json"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * 登记表配置矛盾（不是判据面的红，是**配置面**的错）。
 *
 * 带 `kind` 与 `name` 是为了让 `run-gates` 能原样包成它的 `RegistryError` 语义：
 * 上层按 kind 分流，且这条错的处置是「改 registry」而不是「查判据」。
 */
export class SelftestConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = "SelftestConfigError"
    this.kind = "gate-registry-selftest-conflict"
  }
}

/**
 * 读 `scripts/gates/registry.json` 的原始条目。
 *
 * 为什么在这里再读一份、而不是让 `deriveRegistryGates()` 顺带返回：那会改 `registry-derive.mjs`
 * 的返回值契约（它现在返回**格**，不返回条目），而它的 `selftestAllowFailure(repo, all)` 依赖那个形状。
 * 一次 `JSON.parse` 的代价（实测 <1ms）换「不动别人契约」，划算。
 * 读不到 / JSON 坏 ⇒ 空数组：本函数只负责给派生提供输入，**登记表的坏法由别处判**
 * （`deriveRegistryGates()` 会抛 RegistryError，`verify-gate-registry` 判双向一致）；
 * 在这里重复判一次会让同一个错报两遍，且两遍的措辞迟早分叉。
 */
export function readRegistryEntries(repo) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repo, "scripts/gates/registry.json"), "utf8"))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 合并：白名单 ∪ 派生集合。
 *
 * @param entries registry.json 读出来的全部条目（**原样**，本函数自己过滤 active/kind ——
 *                不要求调用方先过滤，否则「过滤放在调用方」这件事本身就是下一个漂开点）
 * @param repo 仓根（拼 `<id>.ts` 的绝对路径用）
 * @returns `{ ids, gates }`：`ids` 是并集 id（供 `run-gates` 打标），`gates` 是派生出来的格对象
 */
export function selfcheckSelection(entries, repo) {
  const ids = new Set(LEGACY_SELFCHECK_IDS)
  const gates = []
  for (const e of Array.isArray(entries) ? entries : []) {
    const g = deriveSelftestGate(e, repo)
    if (!g) continue
    // 撞车必须出声不静默：白名单里已有同名 id（或两条 spec 条目重名）时，
    // 后写入的会覆盖先写的格，而屏幕上只少一格 —— 没人会注意到。
    if (ids.has(g.id)) {
      throw new Error(
        `[selfcheck-ids] 自检格 id 撞车：${g.id} —— 它同时由 legacy 白名单与 spec 条目 ${e.id} 派生。` +
          `两条路只能留一条：删白名单那条，或改这条条目的 id。`,
      )
    }
    ids.add(g.id)
    gates.push(g)
  }
  return { ids, gates }
}

/**
 * **惰性工厂**：把「读登记表 + 合并」推迟到调用时刻，并缓存一次（ISS-859 抽自 `run-gates.mjs`）。
 *
 * ## ⛔ 不许导出立即求值的常量
 *
 * `derived` 对「条目自带 `gateselfcheck` 字段」**抛错**（见 `deriveSelftestGate`）。若写成
 * `export const X = selfcheckSelection(readRegistryEntries(repo), repo)`，抛点就在**模块顶层**
 * = import 期 ⇒ `run-gates` 的 `--list` / `--selftest` / `--tier` 全部以 JS 栈回溯崩掉，
 * **连「用自检查这个配置错」的路都断**（ISS-857 审查返工实测三条命令 EXIT=1 + Node.js 尾巴）。
 *
 * 调用方（`run-gates.mjs`）把工厂**在 `buildRegistry()` 里调一次**，抛点就落回配置解析处：
 * 与「`timeoutMs` 缺失」同族 —— 仍在起第一个子进程**之前**崩，而 import 是干净的。
 * 两条语义（惰性 / 抛点）都是验收硬线，改这段前先读 `run-gates` 里那条指针注释。
 *
 * ## 判据自检档（ISS-806 · 原 `quick` 档改造而来）—— 逐字搬自 `run-gates.mjs`
 *
 * **为什么单独一档**：自检测的是「判据自己准不准」（变异验证：故意造错，看判据抓不抓得住），
 * 不是「你的代码对不对」。一个 builder 改业务代码，不会影响 `lint-layer-selftest` 是否成立
 * ⇒ 每次提交都跑 52 格自检是纯浪费（老板 2026-11-12：「时间不长，但也会占用系统资源」）。
 *
 * **⛔ 不是「不跑」**：这些格仍在 `full` / `ci` 的 `tiers` 里，CI 覆盖一格没缩。
 * 本档只是把它们的**调度入口**从 `fast` 换到 `--tier gateselfcheck`。
 * **⛔ 名字不叫 `selfcheck`**：`scripts/selfcheck.mjs` 是 builder 的门面命令（ISS-736），同名不同义必混。
 *
 * 新增条目必须：① 是判据的 `--selftest` 反向验证 ② 无 build 依赖
 * ③ 只读仓库内文件或登记表 ④ 在这里写清理由。
 *
 * @param repo 仓根（读 `<repo>/scripts/gates/registry.json` 用）
 * @returns {() => { ids: Set<string>, gates: object[] }} 无参访问器：首调求值并缓存，此后复用同一份
 */
export function createSelfcheckSelection(repo) {
  let cache = null
  return () => (cache ??= selfcheckSelection(readRegistryEntries(repo), repo))
}

/**
 * 本文件的自检向量（`run-gates --selftest` 逐条喂给它自己的 `eq`）。
 *
 * ⚠️ 与 `registry-derive.mjs` 同一个口径：喂的是**本文件的真函数**，不是副本 ——
 *    验副本就是验自己。这也意味着这些断言在改坏实现时会真的红。
 *
 * @param entries 盘上真 registry.json 的条目（用于最后那条端到端断言）
 * @param all 调度器派生后的全部格（用于证明自检格真的出现在 `all` 里）
 */
export function selftestSelfcheckIds(entries, all) {
  const v = []
  const repo = "/repo"
  const base = { id: "x", spec: "x.spec.ts", tiers: ["fast"], status: "active" }

  // ── 派生：该派的必须派出来 ────────────────────────────────────────────────
  {
    const g = deriveSelftestGate(base, repo)
    v.push(["派生：active spec 条目派出一格", !!g, true])
    v.push(["派生：id 带 -selftest 后缀", g?.id, "x-selftest"])
    // 最关键的一条：入口必须是 `--selftest`，不是 `.spec.ts`（ISS-857 的验收点就在这）
    v.push(["派生：入口是 --selftest（不是 .spec.ts）", g?.args?.[1], "--selftest"])
    v.push(["派生：跑的是条目的 .ts 本体", g?.args?.[0], `${repo}/scripts/gates/x.ts`])
    v.push(["派生：badge=selfcheck（读退出码，无第三态）", g?.badge, "selfcheck"])
    v.push(["派生：tiers 不抄条目的，写死 full+ci", g?.tiers, SELFCHECK_TIERS])
    v.push(["派生：语义声明 selftest", g?.semantics, ["selftest"]])
  }

  // ── 派生：不该派的一个都不许派 ────────────────────────────────────────────
  v.push(["反证：legacy 条目不派生（格身份在 cells[]，走白名单）", deriveSelftestGate({ ...base, kind: "legacy" }, repo), null])
  v.push(["反证：deprecated 条目不派生（退役了就停跑，不留幽灵格）", deriveSelftestGate({ ...base, status: "deprecated" }, repo), null])
  v.push(["反证：tiers 为空的条目不派生（永久不跑的条目不给它造自检格）", deriveSelftestGate({ ...base, tiers: [] }, repo), null])
  v.push(["反证：tiers 缺失的条目不派生", deriveSelftestGate({ ...base, tiers: undefined }, repo), null])
  v.push(["反证：id 为空的不派生", deriveSelftestGate({ ...base, id: "  " }, repo), null])
  // ⛔ ISS-857 审查返工（本单自己制造的缺陷）：原先这里是「返回 null」，
  // 而那正是**静默吞**——给条目手写 `gateselfcheck: true` ⇒ 自检格消失且零告警（实测 74→73）。
  // 现在断言的是**抛错**。这条断言是给下一个改这段的人看的：为什么不能静默 return null。
  v.push([
    "反证：自带 gateselfcheck 字段的条目 ⇒ 抛错（否则自检被静默吞）",
    (() => {
      try {
        deriveSelftestGate({ ...base, gateselfcheck: true }, repo)
        return "未抛错"
      } catch (err) {
        return err instanceof SelftestConfigError ? "SelftestConfigError" : "抛了别的错"
      }
    })(),
    "SelftestConfigError",
  ])
  // 顺序判据：legacy 条目即便带了该字段也走「不派生」而不是抛错（第 2 行先返回，
  // 走不到 gateselfcheck 那条）。这条钉住顺序，防止有人把两个判断调换位置后 legacy 误炸。
  v.push([
    "顺序：legacy 条目带 gateselfcheck 字段 ⇒ 仍走「不派生」，不抛错",
    deriveSelftestGate({ ...base, kind: "legacy", gateselfcheck: true }, repo),
    null,
  ])
  v.push(["反证：null / 非对象不炸，返回 null", deriveSelftestGate(null, repo), null])

  // ── 只进 next 档的条目：自检格仍必须进 full/ci（否则换档 = 丢档）────────────
  {
    const g = deriveSelftestGate({ ...base, tiers: ["next"] }, repo)
    v.push(["边界：只进 next 档的条目，自检格仍进 full+ci", g?.tiers, SELFCHECK_TIERS])
  }

  // ── 合并：白名单 ∪ 派生，且撞车要出声 ──────────────────────────────────
  {
    const { ids, gates } = selfcheckSelection([base], repo)
    v.push(["合并：白名单原样保留（52 条一条不少）", LEGACY_SELFCHECK_IDS.size, 52])
    v.push(["合并：白名单的每条都在并集里", [...LEGACY_SELFCHECK_IDS].filter((i) => !ids.has(i)), []])
    v.push(["合并：派生格进了并集", ids.has("x-selftest"), true])
    v.push(["合并：派生格进了 gates 清单", gates.map((g) => g.id), ["x-selftest"]])
    v.push(["合并：原子数量 = 白名单 + 派生", ids.size, LEGACY_SELFCHECK_IDS.size + gates.length])
  }
  {
    // 撞车：白名单里已有一条同名 id 时，必须抛而不是静默覆盖
    let threw = false
    try {
      selfcheckSelection([{ ...base, id: "web-crash-evidence" }], repo) // ⇒ 派生 web-crash-evidence-selftest，与白名单撞
    } catch {
      threw = true
    }
    v.push(["合并：id 撞车必须抛错，不静默覆盖", threw, true])
  }

  // ── 端到端：盘上那份 registry 的实测读数 ────────────────────────────────
  {
    const raw = Array.isArray(entries) ? entries : []
    const specActive = raw.filter((e) => e.status === "active" && e.kind !== "legacy")
    const derivedIds = specActive.map((e) => `${e.id}${SELFCHECK_SUFFIX}`)
    v.push(["端到端：每条 active spec 条目都派生出一格", derivedIds.filter((i) => !selfcheckSelection(raw, repo).ids.has(i)), []])
    // 恒真防呆：派生数必须 > 0，否则「并集」退化回白名单 = 本单什么都没做
    v.push(["端到端：派生数 > 0（否则本机制是空转）", derivedIds.length > 0, true])
    // 反向：白名单里的 id 不该有一个是新载体的格（那说明有人又手写了一条）
    v.push(["端到端：白名单里没有新载体的 id（新旧两界不混）", [...LEGACY_SELFCHECK_IDS].filter((i) => specActive.some((e) => i === `${e.id}${SELFCHECK_SUFFIX}`)), []])
    // 调度器侧：派生出来的格真的出现在 all 里，且都被打了 gateselfcheck 标
    const inAll = derivedIds.filter((i) => !(all ?? []).some((g) => g.id === i))
    v.push(["端到端：派生格全部出现在调度器 all 里", inAll, []])
    v.push(["端到端：派生格全部被打上 gateselfcheck 标", derivedIds.filter((i) => !(all ?? []).some((g) => g.id === i && g.gateselfcheck === true)), []])
    // 反面：派生格不许出现在 fast 档（换档不是「既在 fast 又在自检档」）
    v.push(["端到端：派生格不在 fast 档", derivedIds.filter((i) => (all ?? []).some((g) => g.id === i && (g.tiers ?? []).includes("fast"))), []])
  }

  // ── 惰性工厂（ISS-859 抽线时新增的契约，两条语义都是验收硬线）────────────────
  //
  // 用**临时仓**造一个「自带 gateselfcheck 字段」的登记表 —— 正是派生会抛错的那种形态。
  // 不改盘上真 registry（那会让本文件的其它断言与调度器一起崩，且污染工作树）。
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "selfcheck-ids-"))
    const dir = path.join(tmp, "scripts", "gates")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "registry.json")
    // 第 1 条：故障登记表
    fs.writeFileSync(file, JSON.stringify([{ ...base, gateselfcheck: true }]))
    // ⛔ 这条是本单的主判据：**建工厂**不许求值。若实现退回「模块顶层立即求值」或工厂内先行求值，
    // 这里就当场抛 ⇒ 抓得住。它对应真机上「import 期就炸、--list/--selftest 全崩」那一形态。
    const mk = () => createSelfcheckSelection(tmp)
    let built = "抛错"
    try {
      mk()
      built = "建工厂未求值"
    } catch {
      built = "建工厂即抛错"
    }
    v.push(["惰性：建工厂时不求值（登记表坏也不炸）", built, "建工厂未求值"])
    // 第 2 条：抛点必须推迟到**首调**。只验「不炸」等于只证了惰性的一半 ——
    // 另一半是「该炸的还得炸」，否则工厂可以永远返回空对象，屏幕上一片绿。
    let firstCall = "未抛错"
    try {
      mk()()
    } catch (err) {
      firstCall = err instanceof SelftestConfigError ? "SelftestConfigError" : "抛了别的错"
    }
    v.push(["惰性：首调才抛（配置错没被吞掉）", firstCall, "SelftestConfigError"])
    // 第 3 条：缓存 —— 首调之后**换掉**盘上登记表，同一实例必须仍给首调那份答案。
    // 不缓存的话每次调用都重读盘，同一个进程里会拿到两份不同的集合（且没人会发现）。
    fs.writeFileSync(file, JSON.stringify([base]))
    const sel = mk()
    const first = sel().ids.size // 首调：白名单 52 + 派生 1
    fs.writeFileSync(file, "[]") // 盘上已无条目 ⇒ 若重读，答案会退回 52
    v.push(["惰性：首调结果被缓存（换盘不换答案）", [first, sel().ids.size], [LEGACY_SELFCHECK_IDS.size + 1, LEGACY_SELFCHECK_IDS.size + 1]])
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  return v
}
