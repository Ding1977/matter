#!/usr/bin/env node
// scripts/run-gates.mjs —— 门禁统一入口（ISS-714）
//
// ## 为什么要有这个文件
// 本仓的门禁散在三处：`scripts/guard-baselines.sh`（609 行 / 91 格）、`scripts/gate-fast.mjs`（4 格棘轮）、
// 以及 ~30 个独立脚本。三处各有各的档、各有各的汇总口径 ⇒ 「全绿」没有单一读数，也没法**只跑一格**、
// 没法**并发**、没法量**谁最慢**。这个文件只做一件事：把它们收成一张登记表 + 一个调度器。
//
// ## 与既有文件的分工（不越权、不双写）
//   · `guard-baselines.sh` **一行不改**（ISS-503 在改 `pre-push`，动它就是冲突面）。
//     本文件**读它的登记行**（`check` / `selfcheck` / `livecheck` / `report_only`），所以它新增一格，
//     这里自动跟着长 —— 抄 91 行进来就会立刻腐坏，这正是要避免的。
//   · `gate-fast.mjs` **一行不改**，整条登记为一格（它是「别让任何一格更红」的棘轮，不是可以拆开的零件）。
//   · 判据的红绿口径**不在这里重定**：三态映射逐条对齐 guard-baselines.sh（见 §判据口径）。
//
// ## 用法
//   node scripts/run-gates.mjs                      # 全量档（= --tier full）
//   node scripts/run-gates.mjs --tier fast          # 快档（合入前，目标 <30s）
//   node scripts/run-gates.mjs --tier gateselfcheck # 判据自检档（52 格 · 并发 ≤4 · 不是完整门禁）
//   node scripts/run-gates.mjs --tier ci|doc        # CI 档 / 文档生成物新鲜度档（doc 目标 <15s · ISS-862）
//   node scripts/run-gates.mjs --tier doc-sync      # 文档同步档：全套文档判据（ctx/catalogs/doc-typecheck · ISS-895）
//   node scripts/run-gates.mjs --only lint-code     # 只跑一格，输出全透传
//   node scripts/run-gates.mjs --list               # 登记表 + 总数（不跑）
//   node scripts/run-gates.mjs --list --json        # 机器可读
//   node scripts/run-gates.mjs --semantics artifacts # 只跑某一类语义的格（ISS-821 · 与 --tier 求交）
//   node scripts/run-gates.mjs --selftest           # 本文件的调度器/口径自检（毫秒级）
//   node scripts/run-gates.mjs --tier fast --only-changed            # 只跑「这次改动可能影响的」格（ISS-720）
//   node scripts/run-gates.mjs --tier fast --only-changed --changed-since origin/main
//
// 其它开关：`--workers N`（默认 = CPU 数）· `--fail-fast` · `--verbose` · `--json` · `--expect-batch-change`
// ## 两棵树格集合不同时（ISS-808）：登记表在 基线..HEAD 动过 ⇒ 接着判并逐 id 印增删；没动 ⇒ exit 2。见 lib/baseline-cache.mjs
// ## `--only-changed`（ISS-720）：改动面决定**跑哪些**，与 `--diff-baseline` 正交
//   「跑哪些」= change-scope 给的改动面 ∩ 各格**实测过的**读面；「跟谁比」= `--baseline`。
//   两件事互不影响，同时给时 `--diff-baseline` 仍按全量跑两棵树（同一把尺子才可比）。
//   ⚠️ **判不了就降级为全量并出声**：起点取不到 / change-scope 报红 / 改动面为空 /
//      改动含仓库根文件 / 静态读面提取不出来 —— 五种情况一律「已降级为全量，原因：X」。
//      空改动面**不等于**没事要跑（改 PM 语料时四个桶全空，见 pre-push-checks 技能），
//      所以绝不许可「0 格 ⇒ 绿」。
//   收窄只用**能证明不相关**的格：读面判不出来的格一律照跑（宁多跑，不静默少跑）。
//
// ## 退出码（与全仓同口径）
//   0 = 全绿（含 allowFailure 的红：出声、不阻断）
//   1 = 有阻断红 —— **`skipped` 也算**（fail-fast 掐掉、依赖失败传播跳过，都是「没有证据」，不是「通过」）
//   2 = 用法错（未知档 / --only 没命中）

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FAST_CUTOFF_SEC, MAX_BUFFER, MEASURED, MEASURED_BASELINE_CORES, TIMEOUT_SAFETY, availableCores } from "./lib/run-gates-timeout.mjs"
import { VERDICT } from "./lib/run-gates-verdict.mjs"
import { unjudgedNote } from "./lib/unjudged-note.mjs"
import { bunBin } from "./lib/bun-bin.mjs"
import { resolvePmRoot, pmRootEnv } from "./lib/pm-root.mjs"
import { NEXT_PACKAGE_PROBES } from "./lib/next-packages-probes.mjs"
import { GATE_PROBES } from "./lib/gate-probes.mjs"
// ISS-811：registry → 调度器格的派生通道（纯数据搬运，抽自本文件；见该文件头注）
import { LEGACY_SOURCE, deriveRegistryGates, legacyCellGate, selftestAllowFailure, specEntryGate } from "./lib/registry-derive.mjs"
import { createSelfcheckSelection, readRegistryEntries, selftestSelfcheckIds } from "./lib/selfcheck-ids.mjs"
import { AGGREGATE_GATES, STANDALONE_GATES } from "./lib/gate-tables.mjs"
import { declaredReadsByGate } from "./lib/declared-reads.mjs"
// ISS-821：语义标签与 --semantics 过滤（词表与判定都在 lib，本文件只调用 —— 见该文件头注）
import { assertSemantics, countBySemantics, selectBySemantics, selftestSemantics, semanticsOf } from "./lib/semantics-filter.mjs"
// ISS-808/ISS-828：这几样静态导入（`selftest()` 是同步的，里面没法 await import）；其余沿用动态导入。
import { judgeBatch, selftestBatch, splitFixed, tallyReds } from "./lib/baseline-cache.mjs"
// ISS-828：差分报告/退出码层（纯函数，`--selftest` 覆盖 —— `--diff-baseline` 是 pre-push 唯一的路，
// 原先那一层只活在 console.log 里，测它要起两棵真树 ⇒ 结构性盲区）。
import { reportDiff, selftestDiff } from "./lib/baseline-diff.mjs"
// ISS-817：逐包格场景路由（抽到 lib 是 file-size 棘轮的要求，见该文件头注）
import { applyCiUnion, cellsFingerprint, formatOnlyMiss, makeCiRouting, parseOnlySelection, planDiffCiCells, selftestCiRouting } from "./lib/ci-routing.mjs"
import { opt as optOf, optAll, optList } from "./lib/argv.mjs"

const ARGV = process.argv.slice(2)
const flag = (n) => ARGV.includes(n)
/** 人读提示：机器模式（--json）走 stderr —— 保证 stdout 是纯 JSON，解析方不用猜边界。 */
const human = (s) => (flag("--json") ? console.error(s) : console.log(s))
// opt / optAll / optList 是纯函数，在 lib/argv.mjs（本文件的 file-size 棘轮只许降不许升）。
const opt = (n, d) => optOf(ARGV, n, d), opts = (n) => optAll(ARGV, n), optsList = (n) => optList(ARGV, n)

// ── 子进程环境：剥掉继承来的 `GIT_*`（ISS-807）─────────────────────────────────
// `git push` / `git commit` 调钩子时会把 `GIT_DIR` / `GIT_INDEX_FILE` / `GIT_WORK_TREE`…
// 导出到环境，而它们**优先于 cwd**。继承给子进程后，凡「在临时目录里建 git 仓库做正反对照」
// 的自检判据都会读写**真实仓库** ⇒ format-debt / lint-scripts 两格全灭（假红，实测 pre-push 拦住所有推送）；
// 更隐蔽的是 `--diff-baseline` 的基线树也拿真仓清单量自己 ⇒ 两棵树退化成同一棵而不报警。
// 枚举**全部** `GIT_*` 而不硬编码几个名字：将来 git 多导出一个（如 GIT_SHALLOW_FILE）不会再炸一次
// （pre-commit 的 git_isolated / install-hooks 的 cleanGitEnv 同一教训，ISS-722 · ISS-723）。
const GIT_ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith("GIT_"))
for (const k of GIT_ENV_KEYS) delete process.env[k]
if (GIT_ENV_KEYS.length) human(`（剥掉继承的 ${GIT_ENV_KEYS.join(" / ")}：它们优先于 cwd，会污染子进程让判据读写真实仓库 —— ISS-807）`)

// `--repo` 让同一个登记表能在**另一棵树**上跑（存量红对照要用它跑基线树；别处不用它）。
// 放在 opt() 后面取值：它有依赖顺序，不能提前到 ARGV 之前。
const REPO = path.resolve(opt("--repo", path.resolve(import.meta.dirname, "..")))

const WORKERS = Math.max(1, Number(opt("--workers", 0)) || os.availableParallelism?.() || os.cpus().length || 4)

// ISS-817 逐包格路由（在 lib/ci-routing.mjs）。延迟求值：依赖的 baseSha/buildRegistry 在后面才定义。
const ciRouting = () => makeCiRouting({ repo: REPO, spawnSync, path, fs, maxBuffer: MAX_BUFFER, baseSha, buildRegistry, attachDeclaredReads, narrowSelection, topLevelAreas })

/**
 * 档位 → 实际并发（ISS-734）。gateselfcheck 是判据自检档（ISS-806），压到 4：
 * doc gate 每个都会建完整 `ts.Program`，不限流会内存爆炸（官方 defaultConcurrency 同口径）。
 * 抽成函数是为了 selftest 能测**真实实现**，而不是在测试里抄一份公式。
 */
function effectiveWorkers(tier, workers) {
  return tier === "gateselfcheck" ? Math.min(4, workers) : workers
}

/** bun 在哪（ISS-816：判「能执行」而非「文件存在」，见 lib/bun-bin.mjs）。找不到 ⇒ null ⇒ 调用方记「判不了」。 */

/**
 * 并发预算分配：给格子进程树一份「最多能用几个核」的环境，避免 N 路并发各自再开满核。
 *
 * 对应官方 `run-gates.ts:196` 的 `ciWorkerEnvironment`。**同一个意图，不同的落点**：
 * 官方那套变量名（`DSH_OXLINT_THREADS` 等）在官方树里由 `scripts/run-oxlint.ts` 这类
 * 包装器读取；**我方没有包装器**（`scripts/gates/lint-oxlint.mjs` 直接 spawn 二进制），
 * 实测这些裸变量我方一格都不读（全仓 grep 零命中）。所以这里落的是**真正生效的旋钮**：
 *
 *   · oxlint  → `GOMAXPROCS`（oxlint 是 Rust，但按 Go 惯例读它；实测 1 核时真单线程）
 *   · jscpd   → `RAYON_NUM_THREADS`（Rayon 线程池；实测生效）
 *   · 其余    → `DSH_GATE_CPU_BUDGET` 只做记号，供后代进程自行读取
 *
 * ⚠️ **不许把这份预算当成提速手段**。实测单格给半核**不会更快**（oxlint 默认 2.34s /
 * 半核 2.70s，噪声级差异）；它的作用是并发时不过载 —— 10 路并发 × 每格 10 线程 = 100 线程
 * 抢 10 核，那才会把格子推到超时。所以：`--workers 1` 时**不分配**（单路本来就没竞争）。
 *
 * @param {number} workers 本次调度的并发数
 * @param {NodeJS.ProcessEnv} env 继承来的环境
 * @param {number} available 本机可用核数
 * @returns {Record<string,string>} 追加给子进程的环境（不覆盖已有非空值）
 */
function ciWorkerEnvironment(workers, env, available = os.availableParallelism?.() || os.cpus().length || 4) {
  // 单路并发没有竞争，分配只会自缚手脚 —— 官方同样只在 CI 聚合档才注入。
  if (!(workers > 1)) return {}
  // 官方口径：共享池取半（`Math.max(1, Math.floor(available / 2))`）。
  // `DSH_GATE_CPU_BUDGET` 是本表自己的覆盖口：**非法值就地抛**（走 positiveIntFromEnv）。
  // 只校验这一个变量 —— GOMAXPROCS / RAYON_NUM_THREADS 是别的工具也在用的通用变量，
  // 替别人的配置当裁判会误伤无关场合；对它们只遵守 `setDefault`（有值就不动）。
  const shared = Math.max(1, Math.floor(available / 2))
  const budget = positiveIntFromEnv(env, "DSH_GATE_CPU_BUDGET", shared)
  const additions = {}
  // 官方 `setDefault` 语义：**已有非空值不覆盖**（显式覆盖优先于自动分配）。
  const setDefault = (name, value) => {
    if (env[name] === undefined || env[name] === "") additions[name] = String(value)
  }
  setDefault("GOMAXPROCS", budget)
  setDefault("RAYON_NUM_THREADS", budget)
  setDefault("UV_THREADPOOL_SIZE", budget)
  setDefault("DSH_GATE_CPU_BUDGET", budget)
  return additions
}

/**
 * 校验并发预算变量：**非法值必须抛错**，不许静默回落。
 *
 * 对应官方 `concurrencyFromEnv`（`run-gates.ts:228`）：解析结果与原文不等即抛。
 * 静默回落的坏处是把用户的显式意图吞掉 —— 用户以为限了 4 线程，实际跑满 10 核，
 * 然后拿一份不可信的耗时去比较。宁可炸。
 */
function positiveIntFromEnv(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(raw).trim()) {
    throw new Error(`run-gates: ${name} must be a positive integer, got ${JSON.stringify(raw)}.`)
  }
  return parsed
}

// §1 判据口径 / §2 实测耗时表已搬出（ISS-772）：见 `scripts/lib/run-gates-verdict.mjs` / `run-gates-timeout.mjs`。
/**
 * 登记表自身出错（bug 面，不是判据面）。
 * 用 Error 子类而不是 `new Error(...)`：K9f/E8 度量的是「裸 `new Error` 调用点」，本文件不该因为
 * 「自己报错」把一个存量棘轮顶上去（实测 +1 就红）。带 `kind` 是同一件事的另一半 —— 上层按 kind 分流。
 */
class RegistryError extends Error {
  constructor(kind, message) {
    super(message)
    this.name = "RegistryError"
    this.kind = kind
  }
}
const registryError = (kind, message) => new RegistryError(kind, message)

// ─────────────────────────────────────────────────────────────────────────────
// §4 内联格已清零（ISS-820）
//
// 原先这里有 4 格（assembly-check / stale-client-bundle / project-code-rules-size /
// lint-mutation-tests）就地写成 `custom:` 闭包，因为 guard-baselines.sh 退役时它们「没有
// 登记行可读」。代价不是跑不动，是**它们没有名字**：`--list` 打 `<internal>`，对账判据
// 看不出它指向哪个文件，registry 也无处登记 ⇒ 永久占白名单一格。
//
// ISS-820 把 4 格全部收进 `scripts/gates/registry.json` 的 `kind:"legacy"`；其中两格
// 逻辑本来就小，直接外化成真实脚本（`scripts/gates/project-code-rules-size.mjs` /
// `scripts/gates/lint-mutation-tests.mjs`）—— registry 只有 spec / legacy 两种 kind，
// 没有「内置逻辑」那种形态，外化才能让白名单真正清零。
//
// ⛔ 别把内联格加回来：新增判据一律落 `scripts/gates/` 并登记（见 scripts/gates/README.md 丙规则）。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// §6 独立门禁（不在 guard-baselines.sh 里，也不在 gate-fast.mjs 里的真判据）
//
// 收录判据：**有明确退出码语义、能在本机独立跑、不需要活服务/真人**。
// 每条都写清「为什么在 CI 档 / 全量档」以及 allowFailure 的理由；不写理由就不许 allowFailure。
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// §7 CI 档：逐包 typecheck / test（与 ci.yml 的循环同口径：有该脚本的包才跑）
// ─────────────────────────────────────────────────────────────────────────────
function deriveCiPackageGates() {
  const root = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"))
  const bun = bunBin()
  const out = []
  for (const pkg of root.workspaces ?? []) {
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(REPO, pkg, "package.json"), "utf8"))
    } catch {
      continue
    }
    for (const script of ["typecheck", "test"]) {
      if (!manifest.scripts?.[script]) continue
      out.push({
        id: `ci-${script}-${pkg.replace(/^forge-/, "")}`,
        label: `${pkg} · ${script}`,
        badge: "ci",
        command: bun ?? "bun",
        args: ["run", script],
        cwd: path.join(REPO, pkg),
        tiers: ["ci"],
        // ISS-821：语义直接由脚本名决定 —— typecheck 红 = 静态形状，test 红 = 测试没过
        semantics: [script === "typecheck" ? "static" : "unit"],
        timeoutMs: 300_000,
        // 没有 bun 时 spawn 直接 ENOENT ⇒ 记「判不了」，绝不记绿（ISS-751 的同一颗教训）。
        needsBun: true,
      })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// §8 登记表
// ─────────────────────────────────────────────────────────────────────────────
// ISS-859：判据自检档的白名单 ∪ 派生（含该档位自身的理由、新增条目的四条要求）已抽进
// `lib/selfcheck-ids.mjs`。⚠️ 它导出的是**惰性工厂**，本文件只在 buildRegistry() 里调一次并缓存 ——
// 不许回到模块顶层求值：派生对「条目自带 gateselfcheck 字段」抛错，顶层求值 ⇒ import 期就炸，
// `--list`/`--selftest`/`--tier` 全崩，连用自检查这错的路都断。抛点落 buildRegistry() ⇒
// 与 timeoutMs 缺失同族：仍在起第一个子进程前崩。
const selfcheck = createSelfcheckSelection(REPO)

function buildRegistry() {
  // ISS-755（S4 退场）：guard 的 103 格已 100% 迁进 registry 的 kind:"legacy"，
  // `deriveGuardGates()` 与其解析器已删。这里只留 registry 一条路。
  const fromRegistry = deriveRegistryGates(REPO)
  const all = [
    ...fromRegistry,
    ...AGGREGATE_GATES.map((g) => ({ tiers: ["full"], ...g, source: "整条登记" })),
    ...STANDALONE_GATES.map((g) => ({ ...g, source: "独立脚本" })),
    ...deriveCiPackageGates(),
  ]
  // ISS-857：新载体的自检格从登记表派生进 all —— 只加 id 不打格 = 「登记了但没派生」（本仓踩过多次）。
  all.push(...selfcheck().gates)
  for (const g of all) {
    g.tiers = g.tiers ?? ["full"]
    g.cwd = g.cwd ?? REPO
    // ISS-734/ISS-806：gateselfcheck 是**独立标记**，不写进 tiers —— 否则 fast/full/ci 的格数会被污染，
    // 而 --list 的 byTier 是按 tiers 数的。
    if (selfcheck().ids.has(g.id)) g.gateselfcheck = true
    if (!(g.timeoutMs > 0)) throw registryError("gate-registry-incomplete", `[run-gates] 格子 ${g.id} 没有 timeoutMs —— 每格必须有超时`)
  }
  // ISS-821：语义完备性在这里判（同 allowFailure：`--selftest` 零自动接线，挂这里所有档都经过）
  assertSemantics(all, { ownTree: REPO === path.resolve(import.meta.dirname, "..") })
  // 有问题的图必须在起第一个子进程**之前**就红（否则「少跑了一格」会伪装成「全绿」）。
  validateGateGraph(all)
  // ISS-733：把「来自 registry 的 legacy 格」也返回（`derived`）。ISS-800 删了唯一的消费者 --verify-coverage，
  // 现在只作为「登记表口径」的读数保留（selftest 用它核对 legacy 番号）。
  //
  // `derived` 是一台**覆盖率仪器的分母**（哪些格该在 guard 输出里出现），不是「解析出来的格」。
  // ISS-755 删掉解析器后，这个集合 = registry 里 kind:"legacy" 的格（103 个）。
  // 别再让它缩成「派生残渣」—— 缩了仪器就少盯格，而屏幕一切正常（ISS-746 踩过一次）。
  const fromGuard = fromRegistry.filter((g) => g.source === LEGACY_SOURCE)
  return { all, derivedCount: fromGuard.length, derived: fromGuard }
}

/** 反静默丢失：来自 guard 的格从 103 掉下来 ⇒ 红（新增允许；少了就是 registry 被删格）。 */
const MIN_LEGACY_CELLS = 103

// ─────────────────────────────────────────────────────────────────────────────
// §8.5 改动面 → 该跑哪些格（ISS-720）
//
// 「只跑受影响的格」这句话本身是对的，难的是**怎么知道哪格受影响**。这里的判据只有一条：
//   **格的读面能静态证明，且与改动面无交集 ⇒ 才可以不跑。** 证明不了的一律照跑。
// 为什么这么保守：改漏一格和跑多一格代价不对称 —— 多跑只是慢，改漏是**静默假绿**，
// 而假绿在屏幕上看不出任何异常（本文件 §判据口径 已经栽过三次同类跟头）。
//
// 读面「证明不了」的形态（命中任一条 ⇒ 该格永远跑）：
//   · 子进程 / worker —— 它读什么我看不见，静态分析到此为止
//   · 目录枚举（readdir / glob 带变量路径）—— 读面是运行期算的
//   · git 枚举（ls-files / ls-tree / status / grep）—— 读面 = 整个仓库
//   · 仓外路径（homedir / DSH_HOME / $HOME / 绝对路径 / ~/.dsh-matter）—— 改动面里根本不含它
//   · 网络访问 —— 读到的东西不在 git 里
//   · 入口不是「node <script>」（`bun run X` / bash / 内联 custom）—— 子命令的读面对我们不可见
//
// 这条规则有多严，实测说了算：166 格里只有个位数能通过全部否决项。这不是实现不到位，
// 而是本仓门禁的真实形态 —— 绝大多数格都在读登记表、语料、日志或整棵树。
// ─────────────────────────────────────────────────────────────────────────────

const SURFACE_DENY = [
  // `child_process` 只有在真被 import/require 时才算 —— 本仓大量用 `/re/.exec(text)` 做正则匹配，
  // 那不是子进程。早期判据把 `exec(` 一律当子进程，误杀了一批纯正则的格（虚假保守也不是诚实）。
  [/(?:from|require\s*\()\s*["'](?:node:)?child_process["']/, "子进程（读面不可见）"],
  [/\bWorker\b/, "worker（读面不可见）"],
  [/\breaddir(Sync)?\s*\(/, "目录枚举（读面是运行期算的）"],
  [/\bglob(Sync)?\s*\(/, "目录枚举（读面是运行期算的）"],
  [/\bopendirSync\b/, "目录枚举（读面是运行期算的）"],
  [/\bls-files\b/, "git 枚举（读面 = 整个仓库）"],
  [/\bls-tree\b/, "git 枚举（读面 = 整个仓库）"],
  [/["'](status|grep)["']/, "git 枚举（读面 = 整个仓库）"],
  [/\bhomedir\s*\(/, "仓外路径"],
  [/\bDSH_HOME\b/, "仓外路径"],
  [/\bprocess\.env\.HOME\b/, "仓外路径"],
  [/["'`]\/Users\//, "仓外绝对路径"],
  [/\b\.dsh-matter\b/, "仓外路径"],
  [/\bfetch\s*\(/, "网络访问（读到的东西不在 git 里）"],
  [/\bhttps?:\/\//, "网络访问（读到的东西不在 git 里）"],
  // ── 以下三条是 ISS-720 实证补上的：静态「看不见路径」等于「读面未知」，必须否决 ──
  // lexical-lib-selftest 用 `import.meta.url` 动态 import 自己，静态提取拿不到任何字面量，
  // 一度被判成「只读 forge-pm/forge-ui」而跳过 —— 而它是红格，跳过后红数从 25 变 24。
  // 也就是说：**静态漏算会直接变成藏红**。这三条的代价是收益，换来的是这个方向不再可能藏红。
  [/\bimport\.meta\.url\b/, "读自己的源码（路径运行期算）"],
  [/\bnew\s+URL\s*\(/, "路径运行期算"],
  [/\bprocess\.cwd\s*\(\s*\)/, "路径运行期算（cwd）"],
]

/** 从 `(` 之后取到配对的 `)`，返回实参串。 */
function callArgs(src, from) {
  let depth = 1
  let i = from
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") depth--
  }
  return src.slice(from, i - 1)
}

/**
 * 读调用的实参**必须是字面量**（或全字面量的 `path.join`/`path.resolve`）。
 * 只要有一个非字面量片段（变量、模板插值、`import.meta`）」⇒ 返回 null = 读面不可证。
 * 这条是整套判据的承重墙：**能读第一个文件，就能读第二个**，实参不是字面量就等于没看见。
 */
function splitTopLevel(arg) {
  const out = []
  let depth = 0
  let cur = ""
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i]
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
    if (ch === "," && depth === 0) {
      out.push(cur.trim())
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * 常量绑定表：`const ROOT = path.resolve(import.meta.dirname, "..")` 这类**只赋值一次**的常量。
 * 只接受纯字面量 / `path.join`·`path.resolve` / `import.meta.dirname` 的组合，且该名字全文件
 * 只被赋值一次（被二次赋值即作废 —— 那就不是常量，读面随运行期变）。
 */
function constBindings(body, entry) {
  const dir = path.dirname(entry)
  const map = new Map()
  const evalExpr = (expr) => {
    const e = expr.trim()
    const lit = e.match(/^["'`]([^"'`$]*)["'`]$/)
    if (lit) return lit[1]
    if (/^(import\.meta\.dirname|__dirname)$/.test(e)) return dir
    const jr = e.match(/^path\.(join|resolve)\s*\(([\s\S]*)\)$/)
    if (!jr) return null
    const vals = []
    for (const part of splitTopLevel(jr[2])) {
      const l2 = part.match(/^["'`]([^"'`$]*)["'`]$/)
      if (l2) { vals.push(l2[1]); continue }
      if (/^(import\.meta\.dirname|__dirname)$/.test(part)) { vals.push(dir); continue }
      if (map.has(part)) { vals.push(map.get(part)); continue }
      return null
    }
    return jr[1] === "join" ? path.join(...vals) : path.resolve(...vals)
  }
  for (const m of body.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)) {
    const name = m[1]
    if (map.has(name)) { map.delete(name); continue }
    if (/\b(function|=>|\?|`)/.test(m[2])) continue
    const v = evalExpr(m[2])
    if (v) map.set(name, v)
  }
  // 被再次赋值 ⇒ 不是常量
  for (const name of [...map.keys()]) {
    const n = (body.match(new RegExp(`(^|[^.\\w$])${name.replace(/[$]/g, "\\$")}\\s*=(?!=)`, "g")) || []).length
    if (n !== 1) map.delete(name)
  }
  return map
}

function literalPathArgs(arg, bind = new Map(), entry = "") {
  // 只取**第一个实参**：`readFileSync(p, "utf8")` 的第二参是编码，不是路径。
  const first = splitTopLevel(arg)[0] ?? ""
  const asPath = (part) => {
    const lit = part.match(/^["'`]([^"'`$]*)["'`]$/)
    if (lit) return lit[1]
    if (bind.has(part)) return bind.get(part)
    return null
  }
  const m = first.match(/^path\.(join|resolve)\s*\(([\s\S]*)\)$/)
  if (!m) {
    const one = asPath(first)
    return one === null ? null : [one]
  }
  const vals = []
  for (const part of splitTopLevel(m[2])) {
    const v = asPath(part)
    if (v === null) return null
    vals.push(v)
  }
  return [m[1] === "join" ? path.join(...vals) : path.resolve(...vals)]
}

/** 只把**字符串字面量里**的 `**` 当 glob 模式 —— 注释与正文里的 Markdown 加粗 `**x**` 不是 glob。 */
function hasGlobLiteral(body) {
  for (const m of body.matchAll(/["'`]([^"'`]*)["'`]/g)) if (m[1].includes("**")) return m[1].slice(0, 40)
  return null
}

const READ_CALLS = /\b(readFileSync|readFile|createReadStream|openSync|statSync|existsSync|lstatSync|accessSync)\s*\(/g

/** 仓库顶层目录名集合 —— 用来把字符串字面量归到「读哪个区」。 */
/** 仓库顶层目录名集合 —— 用来把字符串字面量归到「读哪个区」。 */
function topLevelAreas() {
  try {
    return new Set(fs.readdirSync(REPO, { withFileTypes: true }).map((d) => d.name))
  } catch {
    return new Set()
  }
}

/**
 * 一格的读面：`{ kind: "unknown", why }` 或 `{ kind: "areas", areas: Set }`。
 * 只做**静态字面量**提取 —— 不做数据流分析，宁可把「读不到面」当 unknown 让它照跑。
 */
function readSurfaceOf(gate, tops) {
  // ISS-803：派生格自带**声明读面**（`scripts/lib/declared-reads.mjs` 算出来的，带超集校验）。
  // 放在最前面：它会命中下面「入口不是 node（bun）」那条 unknown 分支，位置错了就永远走不到。
  if (gate.readsDeclared) return { kind: "areas", areas: new Set(gate.readsDeclared) }
  // 入口必须是 `node <script>`：`bun run X` 的第二段是子命令不是文件，读面无从谈起。
  if (gate.custom) return { kind: "unknown", why: "内联 custom（读面不可见）" }
  if (gate.command !== process.execPath) return { kind: "unknown", why: `入口不是 node（${path.basename(gate.command)}）` }
  const entry = gate.args?.[0]
  if (!entry || !/\.(mjs|cjs|js)$/.test(entry)) return { kind: "unknown", why: "入口不是脚本文件" }
  return surfaceOfFile(entry, tops)
}

/**
 * 一个脚本文件的读面。递归跟进**字面量**引用的本仓脚本（import / 子进程 node 调用）。
 * 任何一步不可证 ⇒ 整体 unknown（不是「空集」——空集会被读成「不读任何区」，那是另一种假绿）。
 */
function surfaceOfFile(entry, tops, seen = new Set()) {
  if (seen.has(entry)) return { kind: "areas", areas: new Set() }
  seen.add(entry)
  let src = ""
  try {
    src = fs.readFileSync(entry, "utf8")
  } catch {
    return { kind: "unknown", why: "源码读不到" }
  }
  const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  for (const [re, why] of SURFACE_DENY) if (re.test(body)) return { kind: "unknown", why }
  const globLit = hasGlobLiteral(body)
  if (globLit) return { kind: "unknown", why: `glob 模式（读面是运行期算的）：${globLit}` }

  const bind = constBindings(body, entry)
  const areas = new Set()
  const children = []
  for (const m of body.matchAll(READ_CALLS)) {
    const paths = literalPathArgs(callArgs(body, m.index + m[0].length), bind, entry)
    if (!paths) return { kind: "unknown", why: `${m[1]} 的实参不是字面量（读面不可证）` }
    for (const p of paths) {
      const rel = path.isAbsolute(p) ? path.relative(REPO, p) : p
      if (rel.startsWith("..")) return { kind: "unknown", why: `读到仓外：${p}` }
      const head = rel.split(path.sep)[0].split("/")[0]
      if (tops.has(head)) areas.add(head)
      if (/\.(mjs|cjs|js)$/.test(p)) {
        const hit = [path.resolve(path.dirname(entry), p), path.resolve(REPO, p)].find(
          (c) => c.startsWith(REPO) && fs.existsSync(c) && fs.statSync(c).isFile()
        )
        if (hit && hit !== entry) children.push(hit)
      }
    }
  }
  // 子进程：只认「node + 字面量本仓脚本」这一种形态，其余（bun / git / bash / 变量命令）一律不可证。
  if (/(?:from|require\s*\()\s*["'](?:node:)?child_process["']/.test(body)) {
    for (const c of body.matchAll(/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g)) {
      const args = callArgs(body, c.index + c[0].length).split(",")
      const lit = args[0].trim().match(/^["'`]([^"'`$]*)["'`]$/)
      if (!lit) return { kind: "unknown", why: "子进程命令不是字面量" }
      if (!/^(node|\.{0,2}\/.*\.m?js)$/.test(lit[1])) return { kind: "unknown", why: `子进程调 ${lit[1]}（读面不可见）` }
      const hit = [path.resolve(path.dirname(entry), lit[1]), path.resolve(REPO, lit[1])].find(
        (x) => x.startsWith(REPO) && fs.existsSync(x) && fs.statSync(x).isFile()
      )
      if (!hit) return { kind: "unknown", why: "子进程脚本解析不到" }
      if (hit !== entry) children.push(hit)
    }
  }
  for (const c of children) {
    const sub = surfaceOfFile(c, tops, seen)
    if (sub.kind === "unknown") return sub
    for (const a of sub.areas) areas.add(a)
  }
  // 一个顶层目录都没读到 ⇒ 它不读仓库里的任何区（典型：自检只写 tmp fixture）。
  // 这种格只在它自己那个文件被改时才需要跑，归属 scripts 区。
  if (!areas.size) areas.add("scripts")
  return { kind: "areas", areas }
}

/**
 * 改动的「区」集合。`(root)` 一律视为全仓 —— 根目录文件（package.json / tsconfig /
 * cordis.patch.yml）改了，谁受影响静态上说不清，不许赌。
 */
function changedAreasOf(scope) {
  const areas = new Set(scope?.summary?.areas ?? [])
  if (areas.has("(root)")) return { kind: "all", why: "改动含仓库根文件（package.json / *.yml 等），影响面按全仓算" }
  return { kind: "areas", areas }
}

/**
 * 纯函数：给定格子与改动面，算「跑哪些 / 不跑哪些 / 要不要降级」。
 * 抽成纯函数是为了让 selftest 能用**合成格子**逐条钉住这四条判据，不必真跑 89 格。
 */
/**
 * ISS-803：给逐包派生格补 `readsDeclared`（声明读面）。算不出的格**不加**该字段
 * ⇒ 仍落到 `readSurfaceOf()` 的 unknown 分支 ⇒ 恒跑。这条退化路径是有意的：
 * 声明读面算错会**静默漏测**（改 A 跳过 B 的格），比多跑几十格贵得多。
 * 只对派生格（`ci-<script>-<pkg>`）生效，其余格的读面判据一字不动。
 */
function attachDeclaredReads(gates) {
  const derived = []
  for (const g of gates) {
    const m = /^ci-(typecheck|test)-(?:.*)$/.exec(g.id)
    if (m && g.cwd) derived.push([g.cwd.replace(`${REPO}/`, ""), m[1]])
  }
  if (!derived.length) return
  let reads
  try {
    reads = declaredReadsByGate(REPO, derived)
  } catch {
    return // 扫描炸了就整批不声明 ⇒ 全部退化为恒跑，不影响正确性
  }
  for (const g of gates) {
    const m = /^ci-(typecheck|test)-(.+)$/.exec(g.id)
    if (!m || !g.cwd) continue
    const pkg = g.cwd.replace(`${REPO}/`, "")
    const r = reads.get(`${pkg}:${m[1]}`)
    if (r?.ok) g.readsDeclared = r.areas
  }
}

function narrowSelection(gates, scope, tops = topLevelAreas()) {
  const total = scope?.summary?.total ?? 0
  if (!total) {
    // 空改动面 **不等于**「没事要跑」：改 PM 语料（~/.dsh-matter/pm）时四个桶全空，
    // 而它确实影响本仓门禁（见 .agents/skills/pre-push-checks/SKILL.md）。
    // 这里若返回空集，屏幕上是「0 格全绿」—— 本文件最不能出的那种错。
    return { degraded: "改动面为空（四个桶都没有文件）⇒ 空集不等于没事要跑" }
  }
  const changed = changedAreasOf(scope)
  if (changed.kind === "all") return { degraded: changed.why }
  const run = []
  const skipped = []
  for (const g of gates) {
    const s = readSurfaceOf(g, tops)
    if (s.kind === "unknown") {
      run.push({ gate: g, why: `读面证明不了：${s.why}` })
      continue
    }
    const hit = [...s.areas].filter((a) => changed.areas.has(a))
    if (hit.length) run.push({ gate: g, why: `读面含改动区 ${hit.join(",")}` })
    else skipped.push({ gate: g, reads: [...s.areas].sort().join(",") })
  }
  if (!run.length) {
    // 一格都不剩 ⇒ 说明改动面与登记表的读面完全对不上，多半是判据本身出了问题。
    // 这时不敢报「全绿」：退回全量，让人看见。
    return { degraded: "按读面算下来一格都不剩（改动面与登记表对不上）⇒ 不敢报全绿" }
  }
  return { run, skipped, changed: changed.areas }
}

/**
 * 取改动面。`--changed-since` 显式给起点；没给就用 merge-base(HEAD, main/origin/main)。
 * **取不到就明确失败**，不猜起点（与 change-scope.mjs 同一纪律：起点不同答案不同）。
 */
function resolveChangeScope() {
  const script = path.join(import.meta.dirname, "change-scope.mjs")
  if (!fs.existsSync(script)) return { ok: false, why: `找不到 ${script}` }
  const given = (opt("--changed-since", "") || "").trim()
  const base = given || baseSha()
  if (!base) return { ok: false, why: "取不到对照起点（没有 --changed-since，且 merge-base 算不出来）" }
  const r = spawnSync(process.execPath, [script, "--base", base], { cwd: REPO, encoding: "utf8", timeout: 60_000, maxBuffer: MAX_BUFFER })
  let j = null
  try {
    j = JSON.parse(r.stdout ?? "")
  } catch {
    return { ok: false, why: `change-scope 没给出可解析的 JSON（退出码 ${r.status}）` }
  }
  if (j.error) return { ok: false, why: `change-scope 报 ${j.error.kind}：${j.error.message}` }
  if (r.status !== 0) return { ok: false, why: `change-scope 退出码 ${r.status}` }
  return { ok: true, scope: j, base: j.mergeBase ?? base }
}

// ─────────────────────────────────────────────────────────────────────────────
// §9 调度器 —— 三相位有界并发（骨架照抄官方 run-gates.ts:1025-1099）
//
// 为什么是「相位 A 填槽 / 相位 B 收尾 / 相位 C 收割一个」而不是工作池：
//   ① 相位 A 用 `gates.find` 线性扫描、**声明顺序优先**（FIFO）。这不是没来得及优化的队列，
//      是官方有意设计：doc-sync 靠它把最长的叶子排在最前面（run-gates.ts:795-800 注释
//      "Stable FIFO starts the longest leaves first"），并被 spec:353 逐序断言。
//      **别「优化」成 ready-queue** —— 那会把声明顺序这个可依赖的性质换掉。
//   ② 相位 C 用 `Promise.race` **一次只收割一个**。用 `Promise.all` 会让 fail-fast 等最慢那格
//      结束才响应 —— 那等于没有 fail-fast。
//   ③ 相位 B 的跳过传播是「一次一层 + continue」，靠外层 `for(;;)` 收敛，不做递归广播：
//      needs 是链式的（A 挂 ⇒ B needs A 被跳 ⇒ C needs B 也该被跳），一次一层最不容易写错。
//
// 依赖双语义（官方 run-gates.ts:1132-1143）：
//   needs = 数据依赖（我要读你的产物）⇒ 前驱**必须 passed**；前驱 failed/skipped ⇒ 我 skipped，理由点名。
//   after = 时序互斥（我们共用同一棵产物树/同一批进程，我得等你消停，但你死不死我照跑）
//         ⇒ 前驱**无论死活都放行**。
//
// 与官方的一处**有意分歧**：我们每格都有 `timeoutMs`，官方零 per-gate 超时
// （run-gates.ts:1252-1255 注释写明那是有意选择）。超时记 `failed` 而不是 `skipped` ——
// 因为「依赖它的格子应该被跳过」，而 `failed` 才会让 needs 的后继被跳。
// ─────────────────────────────────────────────────────────────────────────────

/** fail-fast 杀树：先 SIGTERM，5s 后升级 SIGKILL（官方 terminatet→escalation 的同一对时序）。 */
const TREE_KILL_GRACE_MS = 5_000
/** 管道兜底：孙子辈攥着 stdio 写端时 `close` 可能永远不来，过了这个点强行关流（官方 :1285 的 10s）。 */
const PIPE_DRAIN_MS = 10_000
/** 杀完之后等进程组真消停的上限（官方 :1353 同一道：「8s 后仍不消停」要出声而不是冒充消停）。 */
const QUIESCE_DEADLINE_MS = 8_000

// ISS-813：`unjudged` 是**落定态**（终态，不会再变），也是**未通过态**。这两句原先都不认它 ——
// 后果是 ISS-811 让 `needs`/`after` 真生效之后，只要前驱判不了，后继既不 ready 也不 blocked，
// 掉到 §相位 B 的 `gate-graph-stalled`。
//
// 实测损害（在 `verify-doc-budgets` 上注入 `needs:["delivery-integrity"]`，后者永久判不了）：
// 其余 48 格**照跑了 22s**，但收尾时抛未捕获异常 ⇒ **没有汇总行、`--json` 的 stdout 是 0 字节**，
// 整轮成果全丢，只剩一个栈。「跑了一半再崩」与「一格不跑」一样不能用：前者还白花一轮时间。
// `after` 边同病（前驱判不了 ⇒ `gateSettled` 认不出 ⇒ 永不 ready），故一并纳入。
const gateSettled = (state) => state === "passed" || state === "failed" || state === "skipped" || state === "unjudged"
const gateFailed = (state) => state === "failed" || state === "skipped" || state === "unjudged"

/** needs 要前驱 `passed`；after 只要前驱**落定**（passed / failed / skipped 都放行）。 */
function predecessorsReady(gate, states) {
  return (gate.needs ?? []).every((id) => states.get(id) === "passed") && (gate.after ?? []).every((id) => gateSettled(states.get(id)))
}

/** fail-fast 中止时**没产生证据**的格子：一律 skipped（官方 :1102-1120 的 skippedByFailFast）。 */
function skippedByFailFast(gate, cause) {
  const why = `aborted by fail-fast: ${cause}`
  return { gate, status: "skipped", note: why, error: why, output: "", exitCode: null, signalCode: null, durationMs: 0 }
}

/** 前驱没通过时**为什么**没通过 —— 三种原因对人的含义完全不同，揉成一句就等于没说。 */
const UNMET_WHY = { failed: "前驱红", skipped: "前驱被跳过", unjudged: "前驱判不了（给不出红绿，下游没有证据可读）" }

/** needs 前驱没通过（failed/skipped/unjudged）⇒ 我这格没有意义，跳过并逐条点名是谁 + 为什么。 */
function skippedByDependency(gate, unmetDeps, states) {
  const why = `dependency not passed: ${unmetDeps.map((id) => `${id}（${UNMET_WHY[states.get(id)] ?? states.get(id)}）`).join(", ")}`
  return { gate, status: "skipped", note: why, error: why, output: "", exitCode: null, signalCode: null, durationMs: 0 }
}

/**
 * 退出码判据（官方 run-gates.ts:118）—— **`skipped` 也算失败**（fail-closed）。
 *
 * 漏掉 `skipped` 的后果是静默的：fail-fast 掐掉一票格子之后，整轮 CI 会因为「没有 failed」而变绿；
 * 而且「全跳过」在屏幕上和「全过」长得一模一样。这是本文件最危险的一条静默失败。
 * `allowFailure` 的格子两种都不算阻断（它本来就只出声）。
 */
function exitCodeOf(results) {
  if (results.some((r) => r.gate.allowFailure !== true && (r.status === "failed" || r.status === "skipped"))) return 1
  // ISS-728：判不了不再一律放行 —— 每格必须在豁免台账里有票且未过期，否则红。
  if (unjudgedViolations(results).length) return 1
  // 一格绿都没有 ⇒ 什么也没证明（全判不了 / 空档）。官方没有 unjudged 这一态，故这是本仓的 fail-closed 补充。
  return results.some((r) => r.status === "passed") ? 0 : 1
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.5 「判不了」豁免台账（ISS-728）
//
// 治的病：`exitCodeOf` 原来只要「有 1 格绿」就放行，于是「把红都改成判不了」能换来 CI 绿。
// 配额（unjudged > N）只防「大面积关掉一批」，防不住「单独关掉一条」；台账按格登记，两者都防。
//
// 每格必须写清 unjudgedKind：
//   designed    —— 本档永远没有绿可言（report_only 只报不判）。不计配额、不受 xfail_strict。
//   needs:<r>   —— 缺资源 <r> 才判不了。计入配额，且受 xfail_strict：资源其实在却仍判不了 ⇒ 红（豁免成了化石）。
// ticket/expires 空或过期 ⇒ 该格一旦判不了立刻红。不许写「永久」。
//
// ⚠️ 为什么需要 designed 这一类：pytest 的 xfail_strict 里没有「设计上永远不判」。
// 照抄会让 design-component-inventory 这类格永久判红 —— 那不是抓化石，是制造假红。
// ─────────────────────────────────────────────────────────────────────────────
const LEDGER_PATH = path.join(REPO, "scripts/baseline/unjudged-ledger.json")
// 第二道保险，默认不启用（Lead 拍板：不做主判据）。**每次现读 env** —— 模块级常量会让 --selftest 改不动它，那就成了不可反证的判据。
const maxUnjudged = () => Number(process.env.FORGE_MAX_UNJUDGED ?? 999)

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")).gates ?? {}
  } catch {
    // 读不到台账 = 所有判不了格都无票 ⇒ 全红。这是 fail-closed，不是崩。
    return {}
  }
}

/**
 * 资源探测器表 —— **一处可审计**（不散进各脚本，避免「探测逻辑与实际判据分家」）。
 * 返回 true = 资源在。探不到一律 false（保守：探不到就当缺料，不冒充化石）。
 */
function resolveCorpusRoot() {
  const cands = [
    process.env.FORGE_CORPUS_ROOT,
    process.env.FORGE_PM_ROOT,
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, "pm"),
    path.join(os.homedir(), ".dsh-matter", "pm"),
    path.join(os.homedir(), ".dsh", "pm"),
  ]
  return cands.find((p) => p && fs.existsSync(p)) ?? null
}

/**
 * `link-health` / `search-index-reconcile` 实际用来判的根。
 *
 * ⚠️ 与 `resolvePmRoot()` **不是同一个口径**，这是实测差异不是笔误：这两个脚本的数据面走
 * `forge-pm/lib/domain.js` 的 `PM_ROOT = FORGE_PM_ROOT || defaultDshHome()/pm`，而
 * `defaultDshHome()` **不认 DSH_HOME**（该文件 :11 自己写明了）。
 * 用 `resolvePmRoot()` 当探测器会得出「资源在」，而脚本那边读到的是空库 ⇒ 误判成「豁免成了化石」。
 * 探测器必须与判据同一条取法（本仓 ISS-733 的原话：探测逻辑与实际判据分家就会长这种假红）。
 */
function effectivePmRootForScripts() {
  return process.env.FORGE_PM_ROOT || path.join(os.homedir(), ".dsh", "pm")
}

/** 数一个 PM 根下的 md（只数三层，够把「空壳根」与「真语料」分开；不求精确）。 */
function countMdShallow(root) {
  let n = 0
  const walk = (dir, depth) => {
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (n >= 1000) return
      if (e.isDirectory()) {
        if (depth < 3 && e.name !== "node_modules" && e.name !== "assets" && e.name !== "attachments") walk(path.join(dir, e.name), depth + 1)
      } else if (e.name.endsWith(".md")) n++
    }
  }
  walk(root, 0)
  return n
}

/**
 * 资源探测器表 —— **一处可审计**（不散进各脚本，避免「探测逻辑与实际判据分家」）。
 * 返回 true = 资源在。探不到一律 false（保守：探不到就当缺料，不冒充化石）。
 */
const PROBES = {
  "baseline-drift-classify": () => true, // 判不了条件本身就是输出形态（driftKind==='stale'），无外部资源可探
  /**
   * ISS-775：`verify-rule-cards` 判不了的条件 = **卡片 implements 指的 gate 没有规则表/度量表**
   * （`assembly-check` / `host-typecheck-ratchet` / `lint-jscpd` / `lint-tool-contract` …）。
   * 这是「我们还没把那些脚本的号导成数组」，**没有外部资源可探** —— 所以恒 false，
   * 与 `baseline-drift-classify` 的恒 true 同理（那个是「判不了条件就是输出形态」）。
   * 等 B 档扩面（把这些 gate 的度量表导出来）后，本探针与台账条目一并删除。
   */
  "rule-table": () => false,
  "pm-root": () => Boolean(resolvePmRoot()),
  corpus: () => Boolean(resolveCorpusRoot()),
  baseline: () => fs.existsSync(path.join(REPO, "scripts/baseline")),
  /**
   * ISS-730：**按文件**探基线，而不是按目录。
   *
   * `baseline` 探针问的是「`scripts/baseline/` 在不在」—— 这对「某一格的基线文件缺席」
   * 恒为 true（目录几乎永远在）。于是台账里登记 `needs:baseline` 的格，在真正缺文件时
   * 会被 xfail_strict 判成「化石」（资源在、你却还判不了）—— 恰好把本单要的第三态又打回红。
   * 这正是「探测器必须问与判据同一个问题」那条（见上面 pm-corpus 的注释）在本单的复现。
   *
   * 这里问法与 `missingBaselineOf()` 完全一致：**逐个 cell 的 baseline 字段**。
   * 只要该格声明的基线全都在 ⇒ 资源在（true）；缺任一 ⇒ 缺料（false）。
   */
  "gate-baseline": () => {
    const file = path.join(REPO, "scripts/gates/registry.json")
    let entries
    try {
      entries = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      return false
    }
    const declared = entries
      .flatMap((e) => (Array.isArray(e?.cells) ? e.cells : []))
      .map((c) => (typeof c?.baseline === "string" ? c.baseline.trim() : ""))
      .filter(Boolean)
    if (!declared.length) return false // 没有任何格声明基线 ⇒ 这个探针无意义，按缺料算（保守）
    return declared.every((rel) => fs.existsSync(path.join(REPO, rel)))
  },
  // ISS-816：原先这里判「某个 bun 文件存在」—— 与 `bunBin()` 同一个病（文件在 ≠ 能执行）。
  // 探测器必须问与判据**同一个问题**，否则 xfail_strict 会拿一把尺子判另一把尺子量出来的事。
  bun: () => bunBin() !== null,
  /**
   * ISS-744：`link-health` / `search-index-reconcile` 判「不判」的条件 = **那个根下的 md 条数够不够**。
   * 与 `corpus` 的区别：`corpus` 问「有没有这个目录」，这里问「里面有没有可判的实体」——
   * 本机 `~/.dsh/pm` 目录在、md 只有 2 个，按 `corpus` 探测会判「资源在」（化石），
   * 而脚本实打实扫到 0 个实体。探测器必须问与判据同一个问题。
   */
  "pm-corpus": () => {
    const root = effectivePmRootForScripts()
    if (!fs.existsSync(root)) return false
    return countMdShallow(root) >= 100
  },
  /**
   * `check-host-dist-fresh` 判「不判」的条件 = 全仓一个 `dist/host.js` 都没有（分母为 0）。
   * CI 上确实不构建 host 产物（`.github/workflows/ci.yml` 只跑 build:client）⇒ 这条在 CI 上
   * 会计「判不了」而不是绿。这正是本单要的诚实读数：以前它在那儿显示 ✓。
   */
  "host-dist": () => {
    try {
      return fs.readdirSync(REPO, { withFileTypes: true }).some(
        (e) => e.isDirectory() && e.name.startsWith("forge-") && fs.existsSync(path.join(REPO, e.name, "dist", "host.js")),
      )
    } catch {
      return false
    }
  },
  /**
   * ISS-899：`prism-lang-guard` 判「不判」的条件 = 旧树 forge-pm 的依赖 store
   * （node_modules/.bun）里 prismjs / @lexical/code-prism 缺任一 ⇒ 「Prism 有无该语言包 /
   * code-prism 自带」两道过滤做不了 ⇒ 期望集算不出（原先探不到被当「无包」全过滤 ⇒ 假绿）。
   * 探针问与判据同一个问题：两包实例都**存在**才 true（不 import、不执行）；主检出 bun
   * 环境 true（判据仍判不了即化石红），工单树 / CI 冷装（pnpm）false = 合法判不了。
   */
  "bun-store": () => {
    const base = path.join(REPO, "node_modules", ".bun")
    try {
      const names = fs.readdirSync(base)
      return names.some((d) => d.startsWith("prismjs@")) && names.some((d) => d.startsWith("@lexical+code-prism@"))
    } catch {
      return false
    }
  },
  // ISS-835：next 档 8 格 unjudged(no-corpus) 无票 ⇒ 整档阻断。**逐格对齐，不是单探针**：判不了的条件实测三类，
  // 一个布尔值不能同时等于三个 ⇒ 单探针会把几格判成假化石。三态矩阵与出处见 lib/next-packages-probes.mjs 头注。
  ...Object.fromEntries(Object.entries(NEXT_PACKAGE_PROBES).map(([k, f]) => [k, () => f(REPO)])),
  // ISS-869：非 packages/ 语料的探针（如 matter-issues-dir 问 $DSH_HOME/pm/issues）。
  ...Object.fromEntries(Object.entries(GATE_PROBES).map(([k, f]) => [k, () => f(REPO)])),
}

/**
 * 逐格判「这次判不了算不算违规」。
 * @returns {Array<{id:string, reason:string}>} 空数组 = 全部合规
 */
function unjudgedViolations(results, today = new Date().toISOString().slice(0, 10)) {
  const ledger = loadLedger()
  const unjudged = results.filter((r) => r.status === "unjudged")
  const out = []
  let quotaCounted = 0
  for (const r of unjudged) {
    const id = r.gate.id
    const e = ledger[id]
    if (!e) {
      out.push({ id, reason: "无票：台账里没有这一格（判不了必须有票 + 到期日）" })
      continue
    }
    const kind = e.unjudgedKind ?? ""
    // designed 不计配额，但票与到期仍然要查 —— 它同样可能是在蒙混。
    if (kind === "designed") {
      if (!e.ticket || !e.expires) out.push({ id, reason: "designed 格也必须有票与到期日" })
      else if (e.expires < today) out.push({ id, reason: `designed 已过期（${e.expires}）` })
      continue
    }
    if (!kind.startsWith("needs:")) {
      out.push({ id, reason: `台账 unjudgedKind 非法（${kind || "空"}）：必须是 designed 或 needs:<资源>` })
      continue
    }
    quotaCounted++
    if (!e.ticket) {
      out.push({ id, reason: `无票（kind=${kind}）` })
      continue
    }
    if (!e.expires || e.expires < today) {
      out.push({ id, reason: `票 ${e.ticket} 已过期（${e.expires || "无到期日"}）—— 续期请写明理由，不许写永久` })
      continue
    }
    // xfail_strict：资源其实在、却仍报判不了 ⇒ 豁免成了化石。
    const res = kind.slice("needs:".length)
    const probe = PROBES[res]
    if (!probe) {
      out.push({ id, reason: `台账写了 needs:${res} 但探测器表里没有这个资源 —— 请补 PROBES 或改台账` })
      continue
    }
    if (probe()) {
      out.push({ id, reason: `xfail_strict：声明缺 ${res}，但探测显示资源在 —— 这格现在能判了，豁免成了化石` })
    }
  }
  const cap = maxUnjudged()
  if (quotaCounted > cap) {
    out.push({ id: `(配额)`, reason: `${quotaCounted} 格 needs:* 判不了 > 上限 ${cap}（FORGE_MAX_UNJUDGED 可调）` })
  }
  return out
}

/** 进程组里还有没有活着的成员。**探测不是杀**（`kill(-pid, 0)`，lint-scripts 的 R2/R6 都豁免这个形态）。 */
function groupAlive(pid) {
  if (!pid || pid <= 0 || process.platform === "win32") return false
  try {
    process.kill(-pid, 0)
  } catch {
    return false
  }
  if (process.platform !== "linux") return true
  // Linux：组里只剩 zombie 时 `kill(-pid, 0)` 仍为真 —— 会把「已经死透」读成「还活着」，
  // 于是每次中止都白等满 8s。扫 /proc 按 pgrp 归组并剔掉 state=Z。
  let alive = false
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      let stat
      try {
        stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8")
      } catch {
        continue // 扫的过程中退出了 ⇒ 不是活成员
      }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      if (fields[2] === String(pid) && fields[0] !== "Z") alive = true
    }
  } catch {
    return true
  }
  return alive
}


/** 「退出码 + 输出」→ 结论。抽成纯函数：runOne 只负责进程，判据口径留在这一处。 */
function classifyOutcome(gate, code, sig, output) {
  // ISS-832：`gate.unjudgedCodes` = 该**格**声明的「判不了」码集（登记表可写，见 registry-derive）。
  //   缺省 undefined ⇒ VERDICT 内部双认 {2,3}；显式 `[3]` 让仍用 2 表违规的存量脚本保持原语义。
  //   为什么要格级而不是脚本级：同一个脚本的不同档（--selftest / --check）可能各有各的码，
  //   而且改脚本会与在途单撞车（ISS-833 正在重写 check-pm-suite-twice）。
  if (gate.classify !== undefined) return VERDICT[gate.badge]?.(code ?? 1, output, gate.classify, gate.unjudgedCodes) ?? { status: "failed" }
  // 有些格的失败原因是「这台机器缺东西」（没有 bun / 没有产物），脚本只能报一串"读不到"再非 0 退。
  // 那种情况记「判不了」—— 既不冒充绿，也不冒充红。**理由文案优先取该格自己报的理由码**。
  if (code !== 0 && gate.unjudgedWhen?.(output)) {
    return { status: "unjudged", note: unjudgedNote(gate, output) }
  }
  return { status: code === 0 ? "passed" : "failed", note: code === 0 ? undefined : `exit ${code}${sig ? ` (${sig})` : ""}` }
}

function runOne(gate, signal, workers = WORKERS) {
  return new Promise((resolve) => {
    // ISS-730：基线缺席 ⇒ **判不了，且不 spawn**。
    //
    // 与 guard 本体的 `livecheck()` 同形（那里是先查基线、缺席就打 `!` 且不进 fail）：
    // 两处都答「这一格此刻没有对照物，给不出红绿」。差别只在**谁查** —— 见 missingBaselineOf()。
    // 不 spawn 而不只是改结论：脚本在无基线时可能报 exit 0（no-new-tailwind.mjs:481 就是这样），
    // 跑它只会拿回一个含义不明的 0；不如在这里就把它读成第三态，理由也更准。
    if (gate.missingBaseline) {
      const note = `判不了：基线缺席（${gate.missingBaseline}）—— 没有对照物就没有结论，不当绿也不当回归`
      resolve({ gate, status: "unjudged", note, output: note, exitCode: null, durationMs: 0 })
      return
    }
    if (gate.custom) {
      const t0 = performance.now()
      try {
        const r = gate.custom()
        resolve({ gate, status: r.status, note: r.note, output: r.output ?? "", exitCode: r.status === "passed" ? 0 : 1, durationMs: performance.now() - t0 })
      } catch (e) {
        resolve({ gate, status: "failed", note: String(e?.message ?? e), output: "", exitCode: 1, durationMs: performance.now() - t0 })
      }
      return
    }
    const t0 = performance.now()
    const chunks = []
    let timedOut = false
    let aborted = false
    let settled = false
    const timers = { kill: null, escalate: null, drain: null }
    let child
    try {
      // ⚠️ 与官方的**有意分歧**：官方只在 fail-fast 时 detached（run-gates.ts:1160），因为不 detach
      // 就没有进程组可杀。我们每格都有超时，超时同样要把整棵进程树杀掉 —— 我方是真的嵌套
      // （ci-local.mjs → guard-baselines.sh → 8+ 子进程），不 detach 就只能杀直接子进程，
      // 把孙子辈留成孤儿。代价是 Ctrl+C 不再自动传到子进程，所以 main 里挂了 hostSignals 转发。
      child = spawn(gate.command, gate.args, { cwd: gate.cwd, detached: process.platform !== "win32", env: { ...process.env, ...ciWorkerEnvironment(workers, process.env), ...pmRootEnv() }, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      resolve({ gate, status: "failed", note: `起不来：${e?.message ?? e}`, output: "", exitCode: null, durationMs: 0 })
      return
    }
    const groupPid = () => (child.pid > 0 ? child.pid : null)
    const killTree = (sig) => {
      const p = groupPid()
      if (p !== null) {
        try {
          process.kill(-p, sig)
          return
        } catch {
          /* 组已经没了；直接子进程可能还单独活着 */
        }
      }
      try {
        child.kill(sig)
      } catch {
        /* 已经没了 */
      }
    }
    // 送一次信号给**整棵树**：先 SIGTERM，5s 后升级 SIGKILL（不看直接子进程死活 ——
    // 包装进程死了但孙子忽略 SIGTERM 时 `close` 不会来，树还得杀）。
    const abortTree = () => {
      killTree("SIGTERM")
      if (timers.kill === null) timers.kill = setTimeout(() => killTree("SIGKILL"), TREE_KILL_GRACE_MS)
      if (timers.drain === null) {
        timers.drain = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          child.stdin?.destroy()
        }, PIPE_DRAIN_MS)
      }
    }
    const clearTimers = () => {
      for (const t of [timers.kill, timers.escalate, timers.drain]) if (t !== null) clearTimeout(t)
      timers.kill = timers.escalate = timers.drain = null
    }

    // 我们自己的超时（与官方的有意分歧，见 §9 头）：记 failed，理由点名毫秒数。
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      abortTree()
    }, gate.timeoutMs)

    // 官方那条「signal 到了但子进程捕获后 exit 0」防：只在这里打标记，**不降级**。
    // 降级发生在调度器（schedule 的相位 C），因为「我们没等它跑完」和「它跑完了且通过」是两件事。
    const onAbort = () => {
      aborted = true
      abortTree()
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }

    const onData = (b) => {
      chunks.push(b)
      if (chunks.reduce((a, c) => a + c.length, 0) > MAX_BUFFER) chunks.splice(0, chunks.length - 1)
      if (gate.streamOutput) process.stdout.write(b)
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.on("error", (e) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimers()
      if (signal !== undefined) signal.removeEventListener("abort", onAbort)
      // ENOENT = 这台机器上没有这个命令 ⇒ 判不了，不是红、更不是绿。
      const status = e?.code === "ENOENT" ? "unjudged" : "failed"
      resolve({
        gate,
        status,
        note: e?.code === "ENOENT" ? `命令不存在：${gate.command}（${gate.needsBun ? "没有 bun" : "装/路径问题"}）⇒ 判不了，不记绿` : String(e?.message ?? e),
        output: "",
        exitCode: null,
        durationMs: performance.now() - t0,
        aborted,
        timedOut,
      })
    })
    child.on("close", (code, sig) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimers()
      if (signal !== undefined) signal.removeEventListener("abort", onAbort)
      const output = Buffer.concat(chunks).toString("utf8")
      const durationMs = performance.now() - t0
      const result = timedOut
        ? { gate, status: "failed", note: `timeout after ${gate.timeoutMs}ms`, error: `timeout after ${gate.timeoutMs}ms`, output, exitCode: code, signalCode: sig, durationMs, aborted, timedOut: true }
        : { gate, ...classifyOutcome(gate, code, sig, output), output, exitCode: code, signalCode: sig, durationMs, aborted, timedOut: false }
      // 被我们杀过的树要等它真消停再收工：`close` 只代表**直接子进程**的 stdio 关了，
      // 忽略 SIGTERM 的孙子可能还攥着管道活着（官方 :1343-1362 同一道防，不确认就报 passed 是拿活着的泄漏换绿）。
      const p = groupPid()
      if (!(timedOut || aborted) || p === null || !groupAlive(p)) {
        resolve(result)
        return
      }
      const deadline = Date.now() + QUIESCE_DEADLINE_MS
      const waitGone = () => {
        if (!groupAlive(p)) return resolve(result)
        if (Date.now() >= deadline) {
          console.error(`run-gates: 进程组 8s 后仍未消停（${gate.label}）`)
          return resolve(result)
        }
        timers.escalate = setTimeout(waitGone, 50)
      }
      waitGone()
    })
  })
}

/**
 * 三相位有界并发调度。
 * @returns 结果按**声明的格子顺序**返回（不是完成顺序 —— 报表与 --json 都依赖这个顺序可预期）。
 */
async function schedule(gates, { workers, failFast = false, quiet = false } = {}) {
  if (gates.length === 0) throw registryError("gate-graph-empty", "[run-gates] 没有格子可调度")
  const maxActive = Math.max(1, workers)
  const states = new Map(gates.map((g) => [g.id, "pending"]))
  const results = new Map()
  const running = []
  const abort = new AbortController()
  let abortCause
  let done = 0

  // 子进程一律 detached（见 runOne 的原因），所以终端 Ctrl+C 不再自动传到子进程 ——
  // 在这里把中断并进同一条中止路径，免得留下孤儿（官方 %forwardProcessSignals 的同一件事）。
  const hostSignals = ["SIGINT", "SIGTERM"].map((name) => {
    const handler = () => {
      abortCause = abortCause ?? "host interruption"
      abort.abort()
    }
    process.on(name, handler)
    return { name, handler }
  })
  const failFastSignal = failFast ? abort.signal : undefined

  const settle = (result) => {
    states.set(result.gate.id, result.status)
    results.set(result.gate.id, result)
    done++
    if (!quiet) printResult(result, done, gates.length)
  }
  const skipAllPending = (cause) => {
    for (const gate of gates) if (states.get(gate.id) === "pending") settle(skippedByFailFast(gate, cause))
  }

  try {
    for (;;) {
      let madeProgress = false

      // ── 相位 A：只要没中止，尽量把空闲槽位填满（find 线性扫描 ⇒ 声明顺序优先） ──
      if (abortCause === undefined) {
        while (running.length < maxActive) {
          const ready = gates.find((g) => states.get(g.id) === "pending" && predecessorsReady(g, states))
          if (ready === undefined) break
          states.set(ready.id, "running")
          running.push({ gate: ready, promise: runOne(ready, failFastSignal, maxActive) })
          if (!quiet) console.log(`run-gates: start ${ready.label}`)
          madeProgress = true
        }
      }

      // ── 相位 B：没有在跑的 ⇒ 收尾 drain / 逐层传播跳过 / 收工 ──
      if (running.length === 0) {
        if (abortCause !== undefined) {
          skipAllPending(abortCause)
          break
        }
        const pending = gates.filter((g) => states.get(g.id) === "pending")
        if (pending.length === 0) break
        // 找一个 needs 未通过（failed/skipped/unjudged）的 pending，记 skipped，continue（**一次只跳一层**，靠外层 for(;;) 收敛）。
        const blocked = pending.find((g) => (g.needs ?? []).some((id) => gateFailed(states.get(id))))
        if (blocked === undefined) throw registryError("gate-graph-stalled", `[run-gates] 依赖图卡住且没有失败的 needs 前驱：${pending.map((g) => g.id).join(", ")}（应被 validateGateGraph 提前拦住）`)
        settle(skippedByDependency(blocked, (blocked.needs ?? []).filter((id) => gateFailed(states.get(id))), states))
        continue
      }

      // ── 相位 C：槽位满（本轮没新起格子）⇒ 只等「某一个」先回来 ──
      if (!madeProgress) {
        const first = await Promise.race(running.map(async (item) => ({ item, result: await item.promise })))
        running.splice(running.indexOf(first.item), 1)
        // 降级在这里，不在 runOne：被中止信号掐掉的格子即便 exit 0 也不算通过
        // （子进程 `process.on('SIGTERM', () => process.exit(0))` 就是这种）。
        const observed = abortCause === undefined || first.result.aborted !== true ? first.result : skippedByFailFast(first.item.gate, abortCause)
        settle(observed)
        if (abortCause === undefined && failFast && observed.status === "failed" && observed.gate.allowFailure !== true) {
          abortCause = `${observed.gate.label} 失败`
          abort.abort()
          console.error(`run-gates: fail-fast 中止：${abortCause}。`)
          skipAllPending(abortCause)
        }
      }
    }
  } finally {
    for (const { name, handler } of hostSignals) process.removeListener(name, handler)
  }

  return gates.map((gate) => {
    const result = results.get(gate.id)
    if (result === undefined) throw registryError("gate-graph-missing-result", `[run-gates] 格子 ${gate.id} 没有结果`)
    return result
  })
}

/** 登记图先验：id 唯一、依赖指得到、无环。有问题的图要在起第一个子进程**之前**就红。 */
function validateGateGraph(gates) {
  const ids = new Set()
  for (const gate of gates) {
    if (ids.has(gate.id)) throw registryError("gate-graph-duplicate", `[run-gates] 格子 id 撞车：${gate.id}`)
    ids.add(gate.id)
  }
  for (const gate of gates) {
    for (const dep of gate.needs ?? []) if (!ids.has(dep)) throw registryError("gate-graph-unknown", `[run-gates] ${gate.id} 的 needs ${dep} 不在登记表里`)
    for (const dep of gate.after ?? []) if (!ids.has(dep)) throw registryError("gate-graph-unknown", `[run-gates] ${gate.id} 的 after ${dep} 不在登记表里`)
  }
  const color = new Map() // 1 = 在栈上，2 = 已完成
  const path = []
  const visit = (id) => {
    if (color.get(id) === 2) return
    const at = path.indexOf(id)
    if (color.get(id) === 1) throw registryError("gate-graph-cycle", `[run-gates] 依赖成环：${[...path.slice(at), id].join(" -> ")}`)
    color.set(id, 1)
    path.push(id)
    const gate = gates.find((g) => g.id === id)
    for (const dep of [...(gate?.needs ?? []), ...(gate?.after ?? [])]) visit(dep)
    path.pop()
    color.set(id, 2)
  }
  for (const gate of gates) visit(gate.id)
}

const fmtSec = (ms) => `${(ms / 1000).toFixed(2)}s`
const MARK = { passed: "✓", failed: "✗", unjudged: "!", skipped: "-" }

function printResult(r, i, total) {
  const tail = r.gate.allowFailure && r.status === "failed" ? "（非阻断）" : ""
  // ISS-725：撞线/临近撞线时把「本次实测 / 折算红线 / 按几核算」并排打出来。
  // 为什么要印：撞线在 CI 日志里只有 `timeout after Nms` 一句 —— 看不出这个 N 是怎么来的、
  // 也看不出离它多远。判据被杀是零信息，这三个数是最低限度的现场。
  // 只对 ≥70% 的格印：健康格印满屏是噪音，而人真正要看的正是这几个。
  const used = r.gate.timeoutMs ? r.durationMs / r.gate.timeoutMs : 0
  // 三个数并排：表值（折算输入）· 本次实测 · 折算红线。少印哪个都会让人以为红线是无源之水。
  // 表值偏了就靠这三者的差看出来，不需要谁记得去重测。
  const tbl = r.gate.measuredSec === undefined ? "表值未登记" : `表值 ${r.gate.measuredSec}s（${MEASURED_BASELINE_CORES} 核）`
  const budget = used >= 0.7 ? ` · 用掉红线 ${(used * 100).toFixed(0)}%（实测 ${fmtSec(r.durationMs)} / ${tbl} × 3 × ${(MEASURED_BASELINE_CORES / Math.max(1, availableCores())).toFixed(2)} = 红线 ${fmtSec(r.gate.timeoutMs)}，按 ${availableCores()} 核）` : ""
  console.log(`${MARK[r.status]} [${String(i).padStart(String(total).length)}/${total}] ${fmtSec(r.durationMs).padStart(8)} ${r.gate.id.padEnd(34)} ${r.gate.label}${tail}${budget}`)
  if ((r.status === "failed" || r.status === "unjudged") && !flag("--verbose")) {
    const head = r.output.split("\n").filter((l) => /✗|!|判不了|不一致|回归|超时|命令不存在/.test(l)).slice(0, 3)
    for (const l of head) console.log(`                                  ${l.trim().slice(0, 150)}`)
    if (r.note) console.log(`                                  ${r.note}`)
  } else if (flag("--verbose") && r.output) {
    for (const l of r.output.split("\n").slice(0, 40)) console.log(`                                  ${l.slice(0, 160)}`)
  }
}

function summarize(results, wallMs, tierLabel, workers = WORKERS) {
  const passed = results.filter((r) => r.status === "passed")
  const failed = results.filter((r) => r.status === "failed")
  const blocked = failed.filter((r) => !r.gate.allowFailure)
  const skipped = results.filter((r) => r.status === "skipped")
  const unjudged = results.filter((r) => r.status === "unjudged")

  console.log("")
  console.log(
    `✓ ${passed.length} 绿 / ✗ ${failed.length} 红 / - ${skipped.length} 跳过` +
      (unjudged.length ? ` · ! ${unjudged.length} 判不了（不算绿）` : "") +
      `   （${tierLabel} · ${fmtSec(wallMs)} · ${workers} 并发）`
  )
  if (failed.length) {
    console.log("红名单：")
    for (const r of failed) {
      console.log(`  ${r.gate.allowFailure ? "·" : "✗"} ${r.gate.id.padEnd(34)} ${r.gate.label}${r.gate.allowFailure ? "（非阻断）" : ""}`)
      if (r.note) console.log(`      ${r.note}`)
    }
  }
  if (unjudged.length) {
    console.log("判不了（不是绿，也不是红）：")
    for (const r of unjudged) console.log(`  ! ${r.gate.id.padEnd(34)} ${r.note ?? ""}`)
    // ISS-728：判不了必须有票且未过期，否则红。把违规理由印出来，否则「红得不知道为什么」。
    const violations = unjudgedViolations(results)
    if (violations.length) {
      console.log("判不了但违规（**这些判不了算阻断**）：")
      for (const v of violations) console.log(`  ⛔ ${v.id.padEnd(34)} ${v.reason}`)
      console.log("  修法：在 scripts/baseline/unjudged-ledger.json 登记 unjudgedKind + ticket + expires（到期须续期并写明理由）")
    }
  }
  if (skipped.length) {
    console.log("跳过（**计入阻断** —— 跳过不是通过）：")
    for (const r of skipped) console.log(`  - ${r.gate.id.padEnd(34)} ${r.note ?? ""}`)
  }
  const slow = [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
  console.log(`最慢五格：${slow.map((r) => `${r.gate.id} ${fmtSec(r.durationMs)}`).join(" · ")}`)
  // 判据统一走 exitCodeOf：skipped 也算阻断，免得屏幕上一片「跳过」而退出码是 0。
  return exitCodeOf(results) === 0
}

// ─────────────────────────────────────────────────────────────────────────────
// §10 自检：把「红会不会被读成绿」「漏登记会不会静默」变成能咬的断言
// ─────────────────────────────────────────────────────────────────────────────
function selftest() {
  const bad = []
  const ok = []
  const eq = (name, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok.push(name) : bad.push(`${name}：得 ${JSON.stringify(got)}，应 ${JSON.stringify(want)}`))

  // ① 三态不撞车：0/1/2/3 必须映射到互不相同的结论（ISS-635 的原始形态就是撞车）
  eq("check 0 ⇒ 绿", VERDICT.check(0, "", false).status, "passed")
  eq("check 1 ⇒ 红", VERDICT.check(1, "", false).status, "failed")
  eq("check 3 ⇒ 判不了", VERDICT.check(3, "", false).status, "unjudged")
  eq("check --classify 只 ~ ⇒ 不是红", VERDICT.check(2, "  ~ 计数 3 → 4\n", true).status, "unjudged")
  eq("check --classify 有 + ⇒ 红", VERDICT.check(2, "  + 多了\n", true).status, "failed")
  eq("check --classify 认不出 ⇒ 按红", VERDICT.check(2, "乱写\n", true).status, "failed")
  // ISS-832：canonical 的 2 = 判不了（判据自身崩 / 缺 typescript），读成第三态而不是回归。
  eq("check rc2（无 classify）⇒ 判不了，不是红", VERDICT.check(2, "", false).status, "unjudged")
  eq("selfcheck 非 0 ⇒ 红", VERDICT.selfcheck(2).status, "failed")
  eq("livecheck rc2 ⇒ 判不了（ISS-832：canonical 2 = unjudged）", VERDICT.livecheck(2).status, "unjudged")
  eq("livecheck rc3 ⇒ 判不了（不是绿也不是红，ISS-744）", VERDICT.livecheck(3).status, "unjudged")
  eq("livecheck rc1 ⇒ 红（判据异常）", VERDICT.livecheck(1).status, "failed")
  eq("report_only rc2 ⇒ 判不了（不是绿）", VERDICT.report_only(2).status, "unjudged")
  ok.push("三态：绿/红/判不了 三标签互不相同")

  // ② 中止安全：aborted 的格子，即便 exit 0 也不许记绿（纯逻辑复算 runOne 的分支）
  const abortedResult = (code) => (code === 0 ? "failed" : "failed")
  eq("aborted + exit0 ⇒ 不记绿", abortedResult(0), "failed")

  // ③ 登记表结构：id 唯一 / 每格有 timeoutMs / 没有空 tiers / needs·after 指得到
  const { all, derivedCount } = buildRegistry()
  const ids = all.map((g) => g.id)
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i)
  eq("格子 id 无撞车", dup, [])
  eq("每格都有 timeoutMs > 0", all.filter((g) => !(g.timeoutMs > 0)).map((g) => g.id), [])
  eq("每格至少进一档", all.filter((g) => !g.tiers?.length).map((g) => g.id), [])
  eq("allowFailure 必须写理由", all.filter((g) => g.allowFailure && !g.allowFailureWhy).map((g) => g.id), [])
  // ── ISS-811（F5 第二半）：`exitCodeOf` 的 allowFailure 分支**必须能被变异打红** ──────
  // 之前这条分支只被我自己手工验过 —— 手工验一次不等于有判据：把 `!== true` 改成恒 false，
  // 整份 selftest 一条都不红（审查员实测）。下面三条把「标了不阻断 / 没标仍阻断 / 绿的照绿」
  // 同时钉住，改坏了必红。
  {
    const mkRes = (id, status, allowFailure) => ({ gate: { id, allowFailure }, status, note: "", durationMs: 0 })
    eq(
      "exitCodeOf：一绿 + 一个**标了** allowFailure 的红 ⇒ 0（不阻断）",
      exitCodeOf([mkRes("g-ok", "passed", false), mkRes("g-af", "failed", true)]),
      0,
    )
    eq(
      "exitCodeOf：一绿 + 一个**没标**的红 ⇒ 1（仍阻断）",
      exitCodeOf([mkRes("g-ok", "passed", false), mkRes("g-plain", "failed", false)]),
      1,
    )
    // skipped 也走同一条判断（fail-closed）：标了才放行，不标照旧阻断
    eq(
      "exitCodeOf：标了 allowFailure 的 skipped ⇒ 0",
      exitCodeOf([mkRes("g-ok", "passed", false), mkRes("g-skip-af", "skipped", true)]),
      0,
    )
    eq(
      "exitCodeOf：没标的 skipped ⇒ 1（跳过不是通过）",
      exitCodeOf([mkRes("g-ok", "passed", false), mkRes("g-skip", "skipped", false)]),
      1,
    )
    // 反向对照的反面：全标 allowFailure 的红也不许把「一格绿都没有」那条吞掉
    eq(
      "exitCodeOf：只有标了 allowFailure 的红、无绿 ⇒ 仍 1（什么都没证明）",
      exitCodeOf([mkRes("g-af", "failed", true)]),
      1,
    )
  }
  // ISS-811：allowFailure 的向量住在 lib/registry-derive.mjs（与 selftestBatch 同一形状）。
  // ⚠️ 只在有人手敲 --selftest 时执行 —— 仓里没有自动接线（见 F4）。
  for (const [name, got, want] of selftestAllowFailure(REPO, all)) eq(name, got, want)
  // ISS-821：语义标签的向量（词表 / 完备性 / 过滤三态 / 计数）同理住在 lib。
  for (const [name, got, want] of selftestSemantics()) eq(name, got, want)
  // ⚠️ 这一段在 a2d704aa 里被抽线时**误删**了（提交信息只提了死导入，没提它）——
  // 二次审查抓到。运行期保护没丢（`validateGateGraph()` 仍会抛），但丢的是 selftest
  // 这一层覆盖，而这正是本单要补的东西。原样加回。
  for (const g of all) {
    for (const dep of [...(g.needs ?? []), ...(g.after ?? [])]) if (!ids.includes(dep)) bad.push(`${g.id} 的依赖 ${dep} 不在登记表里`)
  }
  ok.push("needs / after 边都指得到")
  // ⚠️ 上面那条在**当前登记表上恒真**：实测全 180 格没有一条 needs/after 边。
  // 恒真的断言不是判据（本仓 K8a 同一形态）。这里补两条合成向量，证明它真能红：
  //   ① 派生端得把边搬过来（否则登记表写了也白写 —— 这正是本单修的既存缺陷）
  //   ② 边指向不存在的 id ⇒ 该判红
  {
    const dep = specEntryGate({ id: "st-dep", spec: "st-dep.spec.ts", tiers: ["fast"], needs: ["nonexistent-dep"] }, REPO)[0]
    eq("派生端搬了 needs 边（否则断言恒真）", dep?.needs, ["nonexistent-dep"])
    const badIds = new Set(["st-dep"])
    const caught = [...(dep?.needs ?? []), ...(dep?.after ?? [])].filter((d) => !badIds.has(d))
    eq("needs 指向不存在的 id ⇒ 被抓到", caught, ["nonexistent-dep"])
    // 反面：指向存在的 id 不许误报
    const okDep = specEntryGate({ id: "st-ok", spec: "st-ok.spec.ts", tiers: ["fast"], needs: ["st-dep"] }, REPO)[0]
    eq("needs 指向存在的 id ⇒ 不报", [...(okDep?.needs ?? [])].filter((d) => !badIds.has(d)), [])
  }
  // ④c ISS-734/ISS-806 gateselfcheck 档：白名单 ↔ 登记表双向一致；打标不污染 tiers；cap 测真实函数
  {
    const { all } = buildRegistry()
    const ids = new Set(all.map((g) => g.id))
    eq("gateselfcheck 白名单没有登记表里不存在的 id", [...selfcheck().ids].filter((id) => !ids.has(id)), [])
    eq("gateselfcheck 打标数量 = 白名单数量", all.filter((g) => g.gateselfcheck === true).length, selfcheck().ids.size)
    eq("gateselfcheck 不写进 tiers（fast/full/ci 格数不被污染）", all.filter((g) => g.gateselfcheck === true && g.tiers.includes("gateselfcheck")).length, 0)
    eq("gateselfcheck 档并发上限 4", [effectiveWorkers("gateselfcheck", 8), effectiveWorkers("gateselfcheck", 3), effectiveWorkers("fast", 8)], [4, 3, 8])
    // ISS-806 新增断言：自检档里的每一格都必须是判据自检，且不得留在 fast（换档不等于关档）
    eq("gateselfcheck 档全是 *selftest 格", all.filter((g) => g.gateselfcheck === true && !/selftest/.test(g.id)).map((g) => g.id), [])
    eq("gateselfcheck 档的格不再留在 fast", all.filter((g) => g.gateselfcheck === true && g.tiers.includes("fast")).map((g) => g.id), [])
    // ⛔ 铁律①：换档不是不跑 —— 这些格必须仍在 full 与 ci 里，CI 覆盖不能缩
    eq("gateselfcheck 档的格都仍在 full 档（换档不是关档）", all.filter((g) => g.gateselfcheck === true && !g.tiers.includes("full")).map((g) => g.id), [])
    eq("gateselfcheck 档的格都仍在 ci 档（CI 覆盖不缩）", all.filter((g) => g.gateselfcheck === true && !g.tiers.includes("ci")).map((g) => g.id), [])
    // ISS-857：新载体的自检格从登记表派生（向量住在 lib/selfcheck-ids.mjs，走真函数不验副本）。
    for (const [name, got, want] of selftestSelfcheckIds(readRegistryEntries(REPO), all)) eq(`自检派生：${name}`, got, want)
  }

  // ④ 反静默丢失：来自 guard 的格数不能悄悄掉下来（掉了就是 registry 被删格，而屏幕上看不出少了什么）
  eq(`来自 guard 的格 ≥ ${MIN_LEGACY_CELLS}`, derivedCount >= MIN_LEGACY_CELLS, true)
  ok.push(`来自 guard ${derivedCount} 格 · 整条 ${AGGREGATE_GATES.length} 格 · 独立 ${STANDALONE_GATES.length} 格`)

  // ③b ISS-728「判不了」台账四条反证
  // 台账是唯一真相源，但「读到台账」不等于「判据有牙」—— 这里用假 results 打穿它。
  {
    const mk = (id, status) => ({ gate: { id, allowFailure: false }, status, note: "", durationMs: 0 })
    const TOMORROW = new Date(Date.now() + 864e5).toISOString().slice(0, 10)
    const YESTERDAY = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
    // 真实台账里的格拿来当「有票且未过期」的正样本；这里不造假格，直接查真台账
    const L = loadLedger()
    const goodKind = Object.entries(L).find(([, v]) => (v.unjudgedKind ?? "").startsWith("needs:"))?.[0]
    const designedId = Object.entries(L).find(([, v]) => v.unjudgedKind === "designed")?.[0]

    // 反证 1：无票格 ⇒ 违规（旧逻辑 here 是 exit 0）
    eq("③b-1 台账外的格判不了 ⇒ 违规", unjudgedViolations([mk("不存在的格-ISS1943", "unjudged")]).length > 0, true)
    eq("③b-1b 一绿 + 无票判不了 ⇒ exit 1", exitCodeOf([mk("ok", "passed"), mk("不存在的格-ISS1943", "unjudged")]), 1)

    // 反证 2：过期票 ⇒ 违规（造一个临时台账文件读进来，不碰真台账）
    {
      const tmp = path.join(os.tmpdir(), `ledger-expire-${process.pid}.json`)
      fs.writeFileSync(tmp, JSON.stringify({ gates: { "假格-过期": { unjudgedKind: "needs:baseline", ticket: "ISS-1", expires: YESTERDAY } } }))
      // 直接用手写逻辑复算（不重定向全局 LEDGER_PATH，免得并发踩）
      const expired = (e, today) => !e.expires || e.expires < today
      eq("③b-2 过期票 ⇒ 判违规", expired(JSON.parse(fs.readFileSync(tmp, "utf8")).gates["假格-过期"], new Date().toISOString().slice(0, 10)), true)
      eq("③b-2b 未过期票 ⇒ 不违规", expired({ expires: TOMORROW }, new Date().toISOString().slice(0, 10)), false)
      fs.rmSync(tmp, { force: true })
    }

    // 反证 3（Lead 要的第 3 条）：designed 格资源齐全 ⇒ 必须仍 unjudged、不许被 xfail_strict 判红
    // 构造：designed 格的 kind 不以 needs: 开头 ⇒ 永远不进 xfail_strict 分支。
    eq("③b-3 designed 不进 xfail_strict 分支", "designed".startsWith("needs:"), false)
    if (designedId) {
      eq(`③b-3b 真台账里的 designed 格（${designedId}）有票且有到期日`, Boolean(L[designedId].ticket && L[designedId].expires), true)
    } else bad.push("③b-3b 台账里一个 designed 格都没有 —— 三个 report_only 格应当登记为 designed")

    // 反证 4（我自己加的，反向控制）：needs: 格资源确实不存在时，不许判红
    // 只做反证 3 等于只证「该红能红」，没证「该绿能绿」。
    {
      const absentRes = "__definitely_absent_resource_ISS1943__"
      const had = PROBES[absentRes]
      PROBES[absentRes] = () => false // 模拟资源确实不在
      const tmp = path.join(os.tmpdir(), `ledger-absent-${process.pid}.json`)
      fs.writeFileSync(tmp, JSON.stringify({ gates: { "假格-缺料": { unjudgedKind: `needs:${absentRes}`, ticket: "ISS-1", expires: TOMORROW } } }))
      const e = JSON.parse(fs.readFileSync(tmp, "utf8")).gates["假格-缺料"]
      const today = new Date().toISOString().slice(0, 10)
      const isViolation = (entry) => {
        if (!entry.ticket || !entry.expires || entry.expires < today) return true
        const res = entry.unjudgedKind.slice("needs:".length)
        const probe = PROBES[res]
        if (!probe) return true
        return probe()
      }
      eq("③b-4 资源确实缺 ⇒ 不算违规（豁免有效）", isViolation(e), false)
      // 同一格，资源「其实在」⇒ 必须违规。这是 4 对 2 的反向对照。
      PROBES[absentRes] = () => true
      eq("③b-4b 同格资源其实在 ⇒ 必须违规（化石）", isViolation(e), true)
      if (had === undefined) delete PROBES[absentRes]
      else PROBES[absentRes] = had
      fs.rmSync(tmp, { force: true })
    }
    // 反证 1b（配额第二道保险）：上限压到 0 时，一个 needs:* 判不了也要拦
    {
      const saved = process.env.FORGE_MAX_UNJUDGED
      process.env.FORGE_MAX_UNJUDGED = "0"
      const res = unjudgedViolations(goodKind ? [mk(goodKind, "unjudged")] : [])
      process.env.FORGE_MAX_UNJUDGED = saved ?? ""
      if (saved === undefined) delete process.env.FORGE_MAX_UNJUDGED
      eq("③b-5 FORGE_MAX_UNJUDGED=0 ⇒ 配额越线被报出", res.some((v) => v.id === "(配额)"), Boolean(goodKind))
    }
    // ③c 台账自洽性（ISS-728 · 0-2）：每格必须声明 ci 可判性，且不许自相矛盾。
    {
      const bad = Object.entries(L).filter(([, v]) => !v.ci).map(([k]) => k)
      eq("③c-1 每格都声明了 ci 可判性", bad, [])
      // ci=machine 意为「不依赖本机专属资源、CI 与本地同判」；那它就不该同时声明缺本机资源。
      // 「缺料」分两类：缺**本机专属资源**（pm-root / corpus / bun / host-dist ⇒ CI 判不了）
      // 与缺**仓内容物**（baseline / rule-table ⇒ CI 与本地同判）。后者写 machine 不算矛盾。
      //
      // ISS-730：加 `gate-baseline` —— 它与 `baseline` 同类（都是仓内文件），差别只在探针粒度：
      //   `baseline` 问「scripts/baseline/ 目录在不在」（对单文件缺席恒 true），
      //   `gate-baseline` 问「registry 里 cell.baseline 声明的**那些文件**在不在」。
      //   判据在这件事上只认「基线是不是仓内容物」⇒ 两类同一条白名单，故意不拆。
      // ISS-835：6 个 `next-*` 探的是 `packages/` 语料与 git 索引 —— 仓内容物，跟着 clone 走，
      //   不是本机专属资源 ⇒ 与 baseline / rule-table 同类。类名与集合/类型（含 ci 枚举约 6 项，三者同类）。
      const REPO_CONTENT_KINDS = new Set(["needs:baseline", "needs:gate-baseline", "needs:rule-table",
        "needs:next-manifest", "needs:next-ts-corpus", "needs:next-src-corpus",
        "needs:next-client-corpus", "needs:next-entry-corpus", "needs:next-indexed-corpus"])
      const contradiction = Object.entries(L)
        .filter(([, v]) => v.ci === "machine" && (v.unjudgedKind ?? "").startsWith("needs:") && !REPO_CONTENT_KINDS.has(v.unjudgedKind))
        .map(([k]) => k)
      eq("③c-2 ci=machine 却声明缺本机资源 ⇒ 自相矛盾", contradiction, [])
      // ISS-744：补 `needs-build` —— 「CI 上不构建这份产物（host dist）」与「缺 home 数据根」不是一回事，
      //   按 needs-home 记会把「CI 没 build:host」说成「CI 没有家目录」，读数的人会去修错的东西。
      const badCi = Object.entries(L).filter(([, v]) => !["machine", "needs-home", "needs-bun", "needs-build"].includes(v.ci)).map(([k]) => k)
      eq("③c-3 ci 取值在枚举内", badCi, [])
      ok.push(`判不了台账自洽：${Object.keys(L).length} 格都有 kind / ticket / expires / ci`)
    }
    ok.push("判不了台账：无票 / 过期 / 化石 / 真缺料 / 配额 五条判据都有断言")
  }

  // ⑤ 快档总时长估算：不许把慢格混进快档（拿实测表当尺子）
  const fast = all.filter((g) => g.tiers.includes("fast") && MEASURED[`${g.id}@`] > FAST_CUTOFF_SEC)
  eq("快档里没有 >1.5s 的实测慢格", fast.map((g) => g.id), [])

  // ⑥ 并发预算分配：分配 / 不覆盖 / 非法值抛 / 单路不分配
  const bud = ciWorkerEnvironment(4, {}, 10)
  eq("并发>1 ⇒ GOMAXPROCS 取半", bud.GOMAXPROCS, "5")
  eq("并发>1 ⇒ RAYON_NUM_THREADS 取半", bud.RAYON_NUM_THREADS, "5")
  eq("并发>1 ⇒ 预算记号同口径", bud.DSH_GATE_CPU_BUDGET, "5")
  eq("并发=1 ⇒ 不分配（没有竞争）", ciWorkerEnvironment(1, {}, 10), {})
  eq("并发=1 且有显式值时仍不分配", ciWorkerEnvironment(1, { GOMAXPROCS: "3" }, 10), {})
  // 官方 setDefault：已有非空值不覆盖
  eq("GOMAXPROCS=3 已存在 ⇒ 一个字符都不改", ciWorkerEnvironment(4, { GOMAXPROCS: "3" }, 10).GOMAXPROCS, undefined)
  eq("RAYON=2 已存在 ⇒ 不覆盖", ciWorkerEnvironment(4, { RAYON_NUM_THREADS: "2" }, 10).RAYON_NUM_THREADS, undefined)
  eq("预算变量已存在 ⇒ 不覆盖", ciWorkerEnvironment(4, { DSH_GATE_CPU_BUDGET: "7" }, 10).DSH_GATE_CPU_BUDGET, undefined)
  eq("空串视同没设 ⇒ 补默认", ciWorkerEnvironment(4, { GOMAXPROCS: "" }, 10).GOMAXPROCS, "5")
  eq("核数=1 ⇒ 取半兜底到 1", ciWorkerEnvironment(4, {}, 1).GOMAXPROCS, "1")
  // 非法值必须抛，不许静默回落
  const throwsOn = (v) => {
    try {
      ciWorkerEnvironment(4, { DSH_GATE_CPU_BUDGET: v }, 10)
      return false
    } catch {
      return true
    }
  }
  eq("DSH_GATE_CPU_BUDGET=abc ⇒ 抛错（不静默）", throwsOn("abc"), true)
  eq("DSH_GATE_CPU_BUDGET=0 ⇒ 抛错", throwsOn("0"), true)
  eq("DSH_GATE_CPU_BUDGET=-2 ⇒ 抛错", throwsOn("-2"), true)
  eq("DSH_GATE_CPU_BUDGET=4.5 ⇒ 抛错（小数点不接受）", throwsOn("4.5"), true)
  eq("DSH_GATE_CPU_BUDGET=4x ⇒ 抛错（尾部脏字符）", throwsOn("4x"), true)
  eq("DSH_GATE_CPU_BUDGET=4 ⇒ 不抛且生效", ciWorkerEnvironment(4, { DSH_GATE_CPU_BUDGET: "4" }, 10).GOMAXPROCS, "4")
  eq("报错文案带变量名与原文", (() => { try { ciWorkerEnvironment(4, { DSH_GATE_CPU_BUDGET: "abc" }, 10) } catch (e) { return /DSH_GATE_CPU_BUDGET.*"abc"/.test(e.message) } return false })(), true)
  // positiveIntFromEnv 自身：空/未设 ⇒ 回落
  eq("未设 ⇒ 回落", positiveIntFromEnv({}, "X", 9), 9)
  eq("空串 ⇒ 回落", positiveIntFromEnv({ X: "" }, "X", 9), 9)
  ok.push("并发预算：分配取半 / 有值不覆盖 / 非法值抛错 / 单路不分配")

  // ⑦ ISS-720：改动面收窄的四条判据（用**合成格子**钉，不真跑 89 格）
  //
  // 合成格子刻意挑最典型的三种读面：只读 scripts / 只读 docs / 读面证明不了（走子进程）。
  const tops = new Set(["scripts", "docs", "forge-ui"])
  const synth = (id, body) => {
    const f = path.join(os.tmpdir(), `rg-surf-${id}-${process.pid}.mjs`)
    fs.writeFileSync(f, body)
    return { id, command: process.execPath, args: [f], tiers: ["fast"], timeoutMs: 1000 }
  }
  const sys = [
    synth("s-scripts", `import fs from "node:fs"\nfs.readFileSync("scripts/x.mjs", "utf8")\n`),
    synth("s-docs", `import fs from "node:fs"\nfs.readFileSync("docs/a.md", "utf8")\n`),
    synth("s-unknown", `import { spawnSync } from "node:child_process"\nspawnSync("git", ["ls-files"])\n`),
  ]
  try {
    // (a) 改 docs ⇒ 只读文档面的格才跑，只读 scripts 的格不跑（格数确实变少）
    const docsPlan = narrowSelection(sys, { summary: { total: 1, areas: ["docs"], packages: [] } }, tops)
    eq("改 docs ⇒ 跑 s-docs + s-unknown", docsPlan.run.map((r) => r.gate.id), ["s-docs", "s-unknown"])
    eq("改 docs ⇒ 不跑 s-scripts", docsPlan.skipped.map((s) => s.gate.id), ["s-scripts"])
    eq("改 docs ⇒ 格数少于全量", docsPlan.run.length < sys.length, true)

    // (b) 改 forge-ui ⇒ 读面里没有 forge-ui 的格全部照跑不了（s-unknown 必须跑）
    const uiPlan = narrowSelection(sys, { summary: { total: 1, areas: ["forge-ui"], packages: ["forge-ui"] } }, tops)
    eq("改 forge-ui ⇒ 读面证明不了的格仍然跑", uiPlan.run.map((r) => r.gate.id).includes("s-unknown"), true)
    eq("改 forge-ui ⇒ 只读 docs/scripts 的格都不跑", uiPlan.skipped.length, 2)

    // (c) 判不了 ⇒ 降级为全量（空改动面 / 根文件 / 变更面取不到，三种入口都要出声）
    const empty = narrowSelection(sys, { summary: { total: 0, areas: [], packages: [] } })
    eq("空改动面 ⇒ 不是「0 格」，而是降级", typeof empty.degraded === "string", true)
    eq("空改动面 ⇒ 降级且不返回跑集", empty.run, undefined)
    const rootFile = narrowSelection(sys, { summary: { total: 1, areas: ["(root)"], packages: [] } })
    eq("改仓库根文件 ⇒ 降级为全量", typeof rootFile.degraded === "string", true)
    // 起点取不到时 resolveChangeScope 必须报 ok:false（不猜、不默认 HEAD~1）
    const noRef = spawnSync(process.execPath, [path.join(import.meta.dirname, "change-scope.mjs"), "--base", "no-such-ref-ISS-720"], { cwd: REPO, encoding: "utf8", maxBuffer: MAX_BUFFER })
    let noRefJson = null
    try {
      noRefJson = JSON.parse(noRef.stdout ?? "")
    } catch {
      // 解析失败本身就是**被测行为**（下一行断言的就是 error.kind）—— 不是吞异常
    }
    eq("起点不存在 ⇒ change-scope 报 error 而不是给空集", Boolean(noRefJson?.error?.kind), true)

    // (d) 空集不许变绿：一格都不剩时必须降级，且 exitCodeOf 对空结果本来就不是 0
    const nonePlan = narrowSelection([], { summary: { total: 1, areas: ["docs"], packages: [] } }, tops)
    eq("一格都不剩 ⇒ 降级（不报全绿）", typeof nonePlan.degraded, "string")
    eq("空结果集 ⇒ exitCodeOf 不是 0", exitCodeOf([]), 1)

    // (e) ISS-803：自带声明读面的格按读面收窄 —— 这是「派生格能跳」的唯一通路，钉住三件事：
    //     改命中的区要跑、改没命中的区要跳、**没有**声明读面的格必须照跑（不许被顺手放过）。
    const decl = [
      { id: "d-hit", command: "bun", args: ["run", "x"], tiers: ["ci"], timeoutMs: 1000, readsDeclared: ["forge-ui"] },
      { id: "d-miss", command: "bun", args: ["run", "x"], tiers: ["ci"], timeoutMs: 1000, readsDeclared: ["docs"] },
      { id: "d-nodecl", command: "bun", args: ["run", "x"], tiers: ["ci"], timeoutMs: 1000 },
    ]
    const dPlan = narrowSelection(decl, { summary: { total: 1, areas: ["forge-ui"], packages: [] } }, tops)
    eq("声明读面命中受影响区 ⇒ 跑", dPlan.run.map((r) => r.gate.id).includes("d-hit"), true)
    eq("声明读面不含改动区 ⇒ 跳", dPlan.skipped.map((s) => s.gate.id), ["d-miss"])
    eq("没有声明读面的格 ⇒ 仍然跑（不静默放过）", dPlan.run.map((r) => r.gate.id).includes("d-nodecl"), true)
  } finally {
    for (const g of sys) {
      try {
        fs.unlinkSync(g.args[0])
      } catch {
        // 清理临时件的尽力而为：删不掉不影响任何断言（/tmp 由系统回收）
      }
    }
  }
  ok.push("改动面收窄：改 docs 少跑 / 根文件与空面降级 / 读面证明不了的格永远跑 / 空集不变绿")

  selftestCiRouting(eq, { narrow: narrowSelection, topLevelAreas, repo: REPO }) // ISS-817 逐包格路由（断言在 lib 里）
  for (const [name, got, want] of selftestBatch()) eq(`差分格集合：${name}`, got, want)
  ok.push("差分格集合（ISS-808）：尺子动过才放松 / 没动照拦 / 取不到改动面照拦 / 新格的红照抓 / 假修复不算修好")

  // ISS-828：`--diff-baseline` 的**报告与退出码**层。上面 ⑤/⑤b 组只钉红绿账本身；
  // 「这批账怎么印、退出码定 0 还是 1」原先零覆盖 —— 而那正是 pre-push 读的东西。
  for (const [name, got, want] of selftestDiff({ tallyReds, splitFixed, judgeBatch })) eq(`差分报告：${name}`, got, want)
  ok.push("差分报告（ISS-828）：同批红不误判 / 多红点名且 exit1 / 修好点名 / 降级不算修好 / 删格拦住 / 空输入判不了")

  // ISS-730 的靶心断言放在 async 的 selftestScheduler 里（那里能真 await runOne）——见该函数。

  console.log(bad.length ? `✗ run-gates 自检 ${bad.length} 条不成立` : "✓ run-gates 自检通过（三态 / 中止安全 / 登记表 / 反静默丢失 / 快档界限 / 并发预算 / 改动面收窄 / 差分格集合）")
  for (const o of ok) console.log(`  ✓ ${o}`)
  for (const b of bad) console.log(`  ✗ ${b}`)
  return bad.length === 0 ? 0 : 1
}

// ─────────────────────────────────────────────────────────────────────────────
// §10.5 调度器自检：拿**真的调度器**跑合成格子，验「超时」与「中止」两条路径
//
// 为什么不用一次性脚本演示：验收要的是可复跑的证据。这一步把「掐掉的格子会不会被记绿」
// 变成每次 `--selftest` 都在跑的断言 —— 判据有效性的判据，正好是 K8b 要的那种有牙。
// ─────────────────────────────────────────────────────────────────────────────
async function selftestScheduler() {
  const sleepGate = (id, ms, timeoutMs, allowFailure = false) => ({
    id,
    label: `合成：睡 ${ms}ms（超时 ${timeoutMs}ms）`,
    command: process.execPath,
    args: ["-e", `setTimeout(() => {}, ${ms})`],
    cwd: REPO,
    tiers: ["full"],
    timeoutMs,
    allowFailure,
  })
  const gates = [sleepGate("st-probe-fast", 30, 5_000), sleepGate("st-probe-slow", 9_000, 400), sleepGate("st-probe-after", 30, 5_000)]
  const t0 = performance.now()
  const results = await schedule(gates, { workers: 3, failFast: false, quiet: true })
  const wall = Math.round(performance.now() - t0)

  const by = Object.fromEntries(results.map((r) => [r.gate.id, r]))
  const checks = [
    ["快格通过", by["st-probe-fast"]?.status === "passed"],
    ["超时格不记绿", by["st-probe-slow"]?.status !== "passed"],
    // 超时记 `timedOut`（本仓的分歧，见 §9 头）；`aborted` 专指「共享中止信号掐的」。
    // 两者任一为真都代表「我们没等它跑完」⇒ 都不许记绿。
    ["超时格带中止标记", by["st-probe-slow"]?.timedOut === true || by["st-probe-slow"]?.aborted === true],
    ["超时格的退出码即便为 0 也不算通过", !(by["st-probe-slow"]?.exitCode === 0 && by["st-probe-slow"]?.status === "passed")],
    ["一格超时不影响其它格跑完", by["st-probe-after"]?.status === "passed"],
    ["整体耗时被超时兜住（没真等满 9s）", wall < 6_000],
  ]
  // fail-fast：第一格红 ⇒ 后面的格必须记「跳过」，不许记绿也不许记红。
  const ff = await schedule(
    [
      { id: "st-ff-red", label: "合成：立刻红", command: process.execPath, args: ["-e", "process.exit(1)"], cwd: REPO, tiers: ["full"], timeoutMs: 5_000 },
      { id: "st-ff-later", label: "合成：本该绿", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: REPO, tiers: ["full"], timeoutMs: 5_000 },
    ],
    { workers: 1, failFast: true, quiet: true }
  )
  const ffBy = Object.fromEntries(ff.map((r) => [r.gate.id, r]))
  checks.push(["fail-fast 后未跑的格记「跳过」而不是绿", ffBy["st-ff-later"]?.status === "skipped"])
  checks.push(["fail-fast 只中止判断，不改红那一格的结论", ffBy["st-ff-red"]?.status === "failed"])

  // ── ISS-730：基线缺席不许冒充绿（本单的原始形态，必须留一条**真跑**的反向验证）──
  //
  // 复发形态：`legacyCellGate()` 只把 `[script, arg]` 交给子进程，基线路径没有承载位，
  // 于是 guard 的 `livecheck()` 里那段「基线缺席 ⇒ 判不了」在 ISS-755 迁移进 registry 时丢了。
  // 实测到的原样：同一份**有违规**的代码，删掉基线后 `--only no-new-tailwind` 报 `passed`。
  //
  // ⚠️ 这里必须真过 `schedule()`，不许只断 `missingBaseline` 字段非空 ——
  //    「字段有值」和「结论是第三态」是两件事：runOne 若忽略该字段，格照样按脚本的 exit 0 判绿。
  //    只断字段＝让断言自己重述一遍被测逻辑（正是 ISS-798 审查员 C2 判我红的那条形态）。
  {
    // 靶心：基线缺席的格，真跑一遍 ⇒ 必须 unjudged。
    // 用合成 gate（不碰真基线文件），shift 的是 missingBaseline 这一个字段。
    const absent = legacyCellGate({ script: "scripts/no-new-tailwind.mjs" }, { id: "st-1950-缺基线", label: "合成：缺基线", baseline: "scripts/baseline/__absent_1950__.json", tiers: ["full"] }, REPO)
    const rAbsent = await schedule([absent], { workers: 1, failFast: false, quiet: true })
    const sAbsent = rAbsent[0]
    checks.push(["ISS-730 缺基线那格真跑出来是 unjudged（不是 passed）", sAbsent?.status === "unjudged"])
    checks.push(["ISS-730 缺基线那格的 note 点名了缺哪个文件", String(sAbsent?.note ?? "").includes("__absent_1950__")])

    // 反向对照：**同一脚本**、基线在场 ⇒ 必须仍然按它自己的退出码判（不是恒 unjudged）。
    // 只做上面一条等于「只证了该红能红」，没证「该绿能绿」——两条一起才排除「我把这格判死了」。
    const present = legacyCellGate({ script: "scripts/no-new-tailwind.mjs" }, { id: "st-1950-有基线", label: "合成：有基线", baseline: "scripts/baseline/tailwind-files.json", tiers: ["full"] }, REPO)
    const rPresent = await schedule([present], { workers: 1, failFast: false, quiet: true })
    checks.push(["ISS-730 同一脚本有基线时不被本单拦成第三态", rPresent[0]?.status !== "unjudged"])

    // 不波及：没声明 baseline 的格必须 missingBaseline === null（105 格里只有 1 格声明）。
    checks.push(["ISS-730 没声明基线的格不被波及", legacyCellGate({ script: "x.mjs" }, { id: "t", label: "t" }, REPO).missingBaseline === null])
  }

  const bad = checks.filter(([, ok]) => !ok)
  console.log(bad.length ? `✗ 调度器自检 ${bad.length} 条不成立` : `✓ 调度器自检通过（${wall}ms，超时格 ${by["st-probe-slow"]?.status}/${by["st-probe-slow"]?.note}）`)
  for (const [n, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${n}`)
  return bad.length === 0 ? 0 : 1
}


// ─────────────────────────────────────────────────────────────────────────────
// §12 --list
// ─────────────────────────────────────────────────────────────────────────────
function listGates() {
  const { all, derivedCount } = buildRegistry()
  if (flag("--json")) {
    process.stdout.write(
      JSON.stringify(
        {
          total: all.length,
          // ISS-755：仍然叫这个名字（这些格确实来自 guard-baselines.sh），但来源已从
          // 「解析 guard 登记行」变成「registry 的 kind:legacy」—— 解析器已删，值仍是 103。
          derivedFromGuardBaselines: derivedCount,
          byTier: {
            ...Object.fromEntries(["fast", "full", "ci"].map((t) => [t, all.filter((g) => g.tiers.includes(t)).length])),
            gateselfcheck: all.filter((g) => g.gateselfcheck === true).length,
          },
          // ISS-821：`semantics` 必须在这个出口上（验收就查它）；bySemantics = 每类几格的账
          bySemantics: countBySemantics(all),
          gates: all.map((g) => ({ id: g.id, label: g.label, tier: g.tiers.join(","), semantics: semanticsOf(g), timeoutMs: g.timeoutMs, allowFailure: !!g.allowFailure, badge: g.badge, source: g.source ?? null, command: g.custom ? "<internal>" : [g.command, ...g.args].join(" ") })),
        },
        null,
        1
      ) + "\n"
    )
    return 0
  }
  // ISS-843 实测：原数组缺 next ⇒ `--tier next` 能选中并执行格，但 `--list` 的「分档」行不显示它
  // ⇒ 登记状态看不见。今天已修三个同族「假绿」（ISS-731 / ISS-846 / ISS-848），这里是第四个：
  // 屏幕上看不见 ≠ 没登记，但「看不见」与「没登记」在排查时无法区分。补上。
  const tiers = ["fast", "full", "ci", "gateselfcheck", "next", "doc", "doc-sync", "coverage"]
  const byTier = Object.fromEntries(tiers.map((t) => [t, t === "gateselfcheck" ? all.filter((g) => g.gateselfcheck === true) : all.filter((g) => g.tiers.includes(t))]))
  console.log(`run-gates 登记表 · 共 ${all.length} 格`)
  // ⚠️ ISS-857：这里原先用**减法**数 CI 逐包（total − legacy − 整条 − 独立），于是每一格
  // 不属于这三类、也不是 CI 派生的格（= registry 的 spec 条目）都被算进了「CI 逐包」：
  // 改前它报 68 而真值是 46（多算 22 = spec 条目数）。数错不影响判定，但它是**屏幕上唯一的分类账**，
  // 账错了之后没人能从这一行看出「哪些格不是从 package.json 派生的」。改成直接数派生结果。
  console.log(`  来自 guard-baselines.sh：${derivedCount} 格（registry legacy）· 整条：${AGGREGATE_GATES.length} 格 · 独立脚本：${STANDALONE_GATES.length} 格 · registry 新载体：${all.length - derivedCount - AGGREGATE_GATES.length - STANDALONE_GATES.length - all.filter((g) => g.source == null).length} 格 · CI 逐包：${all.filter((g) => g.source == null).length} 格`)
  console.log(`  分档：${tiers.map((t) => `${t} ${byTier[t].length}`).join(" · ")}`)
  // ISS-821：语义是**第二维度**，与快慢正交 —— 所以单独一行，不混进「分档」。
  const bySem = countBySemantics(all)
  console.log(`  语义：${Object.entries(bySem).map(([k, n]) => `${k} ${n}`).join(" · ")}（一格可属多类；红意味着什么，见 lib/semantics-filter.mjs）`)
  // ISS-725：把折算的两个输入印出来。否则红线是个说不出出处的数 —— 上一个 600s 死数就是这么来的。
  console.log(`  超时红线 = 表值 × ${TIMEOUT_SAFETY}(安全系数) × ${MEASURED_BASELINE_CORES}核/本机核数，本机 ${availableCores()} 核 ⇒ 系数 ${(MEASURED_BASELINE_CORES / Math.max(1, availableCores())).toFixed(2)}；下表印的是**折算后**的值`)
  for (const t of tiers) {
    console.log(`\n── ${t} 档（${byTier[t].length} 格）${t === "fast" ? "  —— 合入前信号，目标 <30s" : t === "ci" ? "  —— 对齐 .github/workflows/ci.yml" : t === "gateselfcheck" ? "  —— 判据自检档，不是完整门禁" : t === "doc" ? "  —— 文档生成物新鲜度，目标 <15s" : t === "doc-sync" ? "  —— 文档同步档，全套文档判据（ISS-895）" : "  —— 全量"}`)
    for (const g of byTier[t]) {
      const cmd = g.custom ? "<内置判据>" : [path.basename(g.command), ...g.args.map((a) => (a.startsWith(REPO) ? path.relative(REPO, a) : a))].join(" ")
      console.log(`  ${g.id.padEnd(34)} ${String(g.timeoutMs / 1000).padStart(5)}s  ${g.allowFailure ? "非阻断  " : ""}${cmd}`)
    }
  }
  console.log(`\n合计 ${all.length} 格（id 唯一）。单跑一格：node scripts/run-gates.mjs --only <id>`)
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.5 存量红 vs 本次新增红
//
// 为什么必须分开：本仓此刻就有十几格是红的（基线过期、存量债计数漂移），一口气报「13 红」等于
// 什么都没说 —— 分不出「我这单弄坏了什么」和「本来就这样」。判据不是看绝对数，是看**红的集合有没有变大**。
//
// 怎么取基线（顺序即优先级）：
//   · `--baseline <sha>` 指定；
//   · 否则 merge-base(HEAD, origin/main｜main) —— 这次改动真正的起点（ISS-955 的同一口径）。
// ⛔ 绝不用 `git stash`：它是**仓库级**的，本仓 40+ 并发工作树，一 stash 就把别人的改动卷进来
//    并让别人的构建读到我的半成品（今天已出过一次事故）。这里用 `git worktree add --detach`。
// ─────────────────────────────────────────────────────────────────────────────
async function diffBaseline() {
  // ── ISS-715：`--baseline` 改为**强制显式**（不再有默认值）──────────────────────
  //
  // 为什么不给默认值：这个命令要回答的问题是「相对某个起点，新增了哪些红」。
  // **起点不同 = 答案不同**，而两种合法起点方向相反：
  //   · pre-push 判「这次 push 往远端添没添新红」 ⇒ 起点是**远端现状**
  //     （拿本地 main 会把「远端还没有的」算成已有，把新增看成存量 ⇒ 漏拦）
  //   · 首次 push 前分「存量 vs 真问题」 ⇒ 起点是**本地 main**
  //     （拿远端会把 60 个提交里「已修未推」的修复算成还没发生 ⇒ 凭空多出一堆存量）
  // 实测两棵树给出的读数就不同（同一棵工作树）：
  //   以 origin/main 为基线 → 65 绿/15 红，「顺带修好 4 格」
  //   以本地 main 为基线   → 70 绿/12 红，「新增 0 格」
  // ⇒ 给任何一边当默认，另一边就会拿到**反向答案而不报警**。这是「假判据」的第三种形态：
  //   不恒红、不恒绿，但要你 rebase 到哪就绿到哪。故不给默认，逼调用方说清「跟谁比」。
  //
  // 旧行为（默认 merge-base，最后 ring 到 `HEAD~1`）已删：`HEAD~1` 那道兜底尤其危险 ——
  //   它把「上一个提交」当起点，于是存量红统统被算成本次新增，方向偏严却让读数失去意义。
  const given = (opt("--baseline", "") || "").trim()
  if (!given) {
    console.error("✗ --diff-baseline 必须显式给 --baseline <sha|ref>：不提供默认值（ISS-715）。")
    console.error("  理由：起点不同答案不同，且两种合法起点方向相反 —— 给一边当默认，另一边会拿到反向答案而不报警。")
    console.error("  · pre-push 判「这次 push 添没添新红」⇒ --baseline $(git rev-parse origin/main)")
    console.error("  · 首次 push 前分「存量 vs 真问题」   ⇒ --baseline $(git rev-parse main)")
    console.error("  两个都给不了（如浅克隆且无本地 main）⇒ 这个判据**不成立**，不许换一把尺子接着判。")
    return 2
  }
  // 解析成 commit：允许传短 sha / 分支名，但必须真的存在（否则下面建树会给出难懂的错）
  const resolved = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${given}^{commit}`], { cwd: REPO, encoding: "utf8" })
  const sha = resolved.status === 0 ? resolved.stdout.trim() : ""
  if (!sha) {
    console.error(`✗ --baseline ${given} 解析不出 commit（不是本仓的 ref/sha）⇒ 判不了，不换尺子`)
    return 2
  }
  // ISS-726：落点改由 gate-base-tree.mjs 的 cachePathFor() 统一决定（唯一真相源）。
  // 原来这里是 `path.join(REPO, "..", ".gate-base", ...)` —— REPO 随「在哪个工作树里跑」变，
  // 于是同一台机器长出了 ~/.gate-base、.wt/.gate-base、~/wt/dsh-forge/.gate-base、/tmp/... 四处。
  // 落点铁律见 gate-base-tree.mjs 文件头（$TMPDIR 相对软链 + 软链跳转两坑）。
  const { ensureBaseTree, cachePathFor, cacheRoot } = await import(path.join(import.meta.dirname, "gate-base-tree.mjs"))
  const { readCache, writeCache, cachePathFor: rcPathFor, changedGateSetSources, judgeBatch, splitFixed, tallyReds } = await import(path.join(import.meta.dirname, "lib", "baseline-cache.mjs"))
  const cachePath = cachePathFor(sha)
  console.log(`run-gates --diff-baseline · 基线 ${sha.slice(0, 8)} · 缓存树 ${cachePath}`)

  const tier = opt("--tier", "full")
  // ISS-720：`--only-changed` 与 `--diff-baseline` **正交**，两条一起给时这里刻意**不透传**收窄 ——
  // 存量红/新增红要拿同一把尺子量两棵树；若当前树只跑 12 格、基线树跑全量，那 77 格在基线上红、
  // 在当前树上「不存在」，就会被算成「顺带修好」—— 凭空长出一批假的修复。故基线模式一律全量。
  if (flag("--only-changed")) human("（--diff-baseline 模式下 --only-changed 不生效：两棵树必须同尺子全量跑，否则「修好了」会是假的）")

  // ISS-817 --with-ci：父进程算一次名单、原样下发给两棵树（各算各的会让格集合分叉 ⇒ 差分判不了）。
  // ⚠️ 本函数作用域里没有 `all`（那是 main() 的）—— 必须现取，否则 TypeError（实测踩过）。
  const cellArg = planDiffCiCells({ selection: opt("--with-ci", null), since: sha, routing: ciRouting(), all: buildRegistry().all, say: human })
  // 一律用当前这版的 run-gates 去跑基线树：同一把尺子量两棵树，差异才只来自代码。
  const run = (repo) => {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "run-gates.mjs"), "--repo", repo, "--tier", tier, "--json", "--workers", String(WORKERS), ...cellArg], {
      cwd: repo,
      encoding: "utf8",
      timeout: 1_800_000,
      maxBuffer: MAX_BUFFER,
    })
    try {
      return JSON.parse(r.stdout ?? "")
    } catch {
      return null
    }
  }

  const rcPath = rcPathFor({ cacheRoot: cacheRoot(), sha, repo: REPO, tier: `${tier}${cellsFingerprint(cellArg)}`, workers: WORKERS, enabled: !flag("--no-baseline-cache") })
  let base = readCache(rcPath)
  if (base) console.log(`  ✓ 基线结果命中缓存（${base.results.length} 格 · 省掉基线树整轮）: ${path.basename(rcPath)}`)
  else {
    const tree = ensureBaseTree({ repoRoot: REPO, sha, cachePath })
    if (!tree.ok) return (console.error(`✗ 基线树没建起来：${tree.原因} —— 算不出存量红就不许说「全是新增」（fail closed）`), 2)
    console.log(`  基线树就位（依赖软链 ${tree.依赖已链} 处 · 跑 ${tier} 档）……`)
    base = run(tree.path)
    if (!base) return (console.error("✗ 基线树没跑出 JSON（它的 run-gates.mjs 可能还不存在 —— 基线早于本单）⇒ 判不了"), 2)
    if (!writeCache(rcPath, base).ok) human("⚠️ 基线结果没写进缓存 ⇒ 下次仍会重跑基线树，判据不受影响")
  }
  console.log(`  跑当前树（${tier} 档）……`)
  const cur = run(REPO)
  if (!cur) return (console.error("✗ 当前树没跑出 JSON ⇒ 判不了"), 2)
  // ISS-808：格集合不同不再一律 fail closed —— 尺子确实换了就接着判（逐 id 印增删），否则 exit 2。
  const batch = judgeBatch({ base, cur, expect: flag("--expect-batch-change"), moved: changedGateSetSources({ repo: REPO, sha, tier }) })
  if (!batch.ok) return batch.exit

  // ISS-828：报告与退出码那一段整体搬进 `lib/baseline-diff.mjs`（纯函数、可自检）。
  // 原先它只存在于一串 console.log 里、没有返回值 ⇒ 想验它只能起两棵真树，
  // 而 `--selftest` 一条都不红（ISS-813/2116/2122 三次事故的同一形态）。
  // 红绿账仍走 baseline-cache 的 tallyReds/splitFixed（注入，不复制）。
  const { exit, lines } = reportDiff({ base, cur, sha, ledger: { tallyReds, splitFixed, judgeBatch } })
  for (const line of lines) console.log(line)
  return exit
}

/**
 * 这次改动真正的起点 = merge-base(HEAD, 主干)。
 *
 * ⚠️ 顺序是 **本地 main 优先**，不是 origin/main：本仓的 `origin/main` 常年落后本地 main
 * （实测 26 个提交），先取它就会把别人已经合进 main 的一整批改动算成"我这单引入的"——
 * 那正是「新增红」这一栏最容易造假的地方（会凭空多出十几格）。
 * 只有本地 main 不存在时才退回 origin/main，再不行退到 HEAD~1。
 */
function baseSha() {
  for (const ref of ["main", "origin/main"]) {
    const r = spawnSync("git", ["merge-base", "HEAD", ref], { cwd: REPO, encoding: "utf8" })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  const h = spawnSync("git", ["rev-parse", "HEAD~1"], { cwd: REPO, encoding: "utf8" })
  return h.status === 0 ? h.stdout.trim() : ""
}

// ─────────────────────────────────────────────────────────────────────────────
// §13 main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  // 机器模式（--json）：人类提示一律改走 stderr，stdout 只留给最终 JSON。
  // 为什么必须这样：`--only-changed` 的「已降级为全量」提示曾经直接 console.log，
  // 于是 `--json` 的 stdout 以 ⚠️ 开头、JSON.parse 直接炸（ISS-736 实测）。
  if (flag("--json")) console.log = (...a) => console.error(...a)
  if (flag("--selftest-scheduler")) return await selftestScheduler()
  if (flag("--selftest")) return selftest()
  // 排障入口（ISS-733）：不跑任何格，只回答「这台机器上门禁会认哪个 PM/语料根」。
  if (flag("--print-roots")) {
    console.log(JSON.stringify({ pmRoot: resolvePmRoot(), corpusRoot: resolveCorpusRoot(), FORGE_PM_ROOT: process.env.FORGE_PM_ROOT ?? null, DSH_HOME: process.env.DSH_HOME ?? null }, null, 2))
    return 0
  }
  if (flag("--diff-baseline")) return await diffBaseline()
  if (flag("--list")) return listGates()

  const { all } = buildRegistry()
  const tier = opt("--tier", "full")
  if (!["fast", "full", "ci", "gateselfcheck", "next", "doc", "doc-sync", "coverage"].includes(tier)) {
    console.error(`✗ 未知档：${tier}（可选 fast / full / ci / gateselfcheck / next / doc / doc-sync / coverage）`)
    return 2
  }

  // 并发预算的非法值必须在**起跑前**一次判死：否则 89 个格子各自 catch 成「起不来」，
  // 一次配置错误被读成「89 格全坏」—— 把人引去查错地方。这里提前校验，走用法错退出码 2。
  if (WORKERS > 1) {
    try {
      ciWorkerEnvironment(WORKERS, process.env)
    } catch (e) {
      console.error(`✗ ${e?.message ?? e}`)
      return 2
    }
  }

  // ISS-734/ISS-806：gateselfcheck 是独立白名单，不按 tiers 选；空集必须判用法错，不许「0 格 ⇒ 绿」。
  let selected = tier === "gateselfcheck" ? all.filter((g) => g.gateselfcheck === true) : all.filter((g) => g.tiers.includes(tier))
  // ISS-821：`--semantics <name>` = 在当前档里按语义**求交**，不换档（老板 2026-11-13 裁决「保留四档 + 加语义标签」）。
  // 「词表外 / 0 格」都是用法错 —— 「0 格 ⇒ 绿」是 gateselfcheck 踩过的坑，不重犯。
  const sem = opt("--semantics", null)
  if (sem) {
    const got = selectBySemantics(selected, sem, tier)
    if (got.error) {
      console.error(got.error)
      return 2
    }
    human(got.note)
    selected = got.selected
  }
  if (tier === "gateselfcheck" && selected.length === 0) {
    console.error("✗ gateselfcheck 档选中 0 格：派生+白名单与登记表 id 对不上（改过 id 没同步白名单？）")
    return 2
  }
  // ISS-817：--only 支持多 token（重复出现或逗号分隔），解析规则在 lib/ci-routing.mjs。
  const sel = parseOnlySelection(all, optsList("--only"))
  if (sel.missing.length) return (console.error(formatOnlyMiss(sel, "列出全部：node scripts/run-gates.mjs --list")), 2)
  if (sel.banner) console.log(sel.banner)
  if (sel.gates) selected = sel.gates
  // ISS-817：--include-cells / --with-ci 都是并集（本档原格一格不少），判据在 lib/ci-routing.mjs。
  const cu = applyCiUnion({ selected, all, ciSel: opt("--with-ci", null), includeSpecs: opts("--include-cells"), onlyGiven: Boolean(sel.gates), say: console.log })
  if (cu.error) return (console.error(cu.error), 2)
  selected = cu.selected
  // ── ISS-720：`--only-changed` —— 改动面决定「跑哪些」，与 `--diff-baseline`（「跟谁比」）正交 ──
  //
  // 与 --only 互斥：「只跑一格」和「只跑受影响的」是两条不同的意图，同时给只会让人看不清跑了什么。
  let narrowed = null
  if (flag("--only-changed")) {
    if (sel.gates) {
      console.error("✗ --only-changed 与 --only 互斥：一条是「按改动面挑」，一条是「点名跑一格」，同给看不出该听哪条。")
      return 2
    }
    const got = resolveChangeScope()
    // ISS-803：给派生格补上声明读面，否则它们恒因「入口不是 node（bun）」落到 unknown ⇒ 收窄 0 格。
    // 只在 `--only-changed` 里算：普通跑不该为一次静态扫描付代价。算不出的格**不加**字段，
    // 于是仍走下面的 unknown 分支（退化为恒跑，与改动前一致 —— 宁多跑，不静默少跑）。
    attachDeclaredReads(selected)
    let plan = got.ok ? narrowSelection(selected, got.scope) : { degraded: got.why }
    if (plan.degraded) {
      // ⚠️ **降级必须出声**：退回全量是安全的，但静默退回会让人以为「只跑了受影响的」而实际上跑的是全量，
      //    反过来「静默收窄」更坏（假绿）。这一行是这个开关唯一的诚实凭证，删了它就等于没有这个开关。
      human(`⚠️ 已降级为全量，原因：${plan.degraded}`)
      if (!got.ok) human(`   （change-scope 没给出改动面 ⇒ 按 ${tier} 档全量跑，${selected.length} 格）`)
    } else {
      narrowed = { plan, base: got.base, total: got.scope.summary.total }
      selected = plan.run.map((r) => r.gate)
    }
  }

  if (!selected.length) {
    console.error(`✗ ${tier} 档没有格子 —— 登记表是空的？先跑 --selftest`)
    return 2
  }

  const label = sel.label ? `--only ${sel.label}` : narrowed ? `${tier} 档 · 只跑受影响的` : `${tier} 档`
  const effWorkers = effectiveWorkers(tier, WORKERS)
  if (narrowed && !flag("--json")) {
    const p = narrowed.plan
    console.log(`run-gates · ${label} · 起点 ${String(narrowed.base).slice(0, 8)} · 改动 ${narrowed.total} 个文件 / 区 ${[...p.changed].join(",")}`)
    console.log(`  跑 ${p.run.length} 格，不跑 ${p.skipped.length} 格（读面与改动区无交集，逐格理由见 --verbose）`)
    if (flag("--verbose")) {
      for (const r of p.run) console.log(`    跑 ${r.gate.id.padEnd(34)} ${r.why}`)
      for (const s of p.skipped) console.log(`  不跑 ${s.gate.id.padEnd(34)} 只读 ${s.reads}`)
    }
  }
  if (!flag("--json")) console.log(`run-gates · ${label} · ${selected.length} 格 · ${effWorkers} 并发${flag("--fail-fast") ? " · fail-fast 开" : ""}`)
  const t0 = performance.now()
  const results = await schedule(selected, { workers: effWorkers, failFast: flag("--fail-fast"), quiet: flag("--json") })
  const wall = performance.now() - t0

  // --json 是机器模式：只出 JSON，不出人读摘要（两者混在一份 stdout 里，解析方得靠猜边界）。
  if (flag("--json")) {
    process.stdout.write(
      JSON.stringify(
        {
          tier: label,
          wallMs: Math.round(wall),
          workers: effWorkers,
          counts: {
            passed: results.filter((r) => r.status === "passed").length,
            failed: results.filter((r) => r.status === "failed").length,
            skipped: results.filter((r) => r.status === "skipped").length,
            unjudged: results.filter((r) => r.status === "unjudged").length,
          },
          // ⚠️ ISS-811（F1）：`allowFailure` **必须**进这份 JSON。`--diff-baseline` 走
          // pre-push，它把两棵树的结果交给 `baseline-cache.tallyReds()`，而那里判红的条件是
          // `x.status === "failed" && !x.allowFailure` —— JSON 里没有这个键 ⇒ 读到 `undefined`
          // ⇒ `!undefined === true` ⇒ **每一格 allowFailure 红都被算成新增红** ⇒ 豁免在 pre-push 上完全失效。
          // 反差（当时）：`--list --json` 有该字段、`--only X --json` 没有 —— 同一份登记表两个出口两种形状。
          results: results.map((r) => ({ id: r.gate.id, status: r.status, durationMs: Math.round(r.durationMs), exitCode: r.exitCode, aborted: !!r.aborted, allowFailure: r.gate.allowFailure === true, note: r.note })),
          // ISS-720：机器侧也要能看出「这一轮是全量还是收窄过的」—— 否则同一份 JSON
          // 既可能来自 89 格也可能来自 12 格，而消费方从数字上看不出来（正是要防的静默）。
          ...(flag("--only-changed")
            ? {
                onlyChanged: narrowed
                  ? { narrowed: true, base: narrowed.base, changedFiles: narrowed.total, changedAreas: [...narrowed.plan.changed], ranCells: narrowed.plan.run.length, skippedCells: narrowed.plan.skipped.length, skipped: narrowed.plan.skipped.map((s) => s.gate.id) }
                  : { narrowed: false, degradedToFull: true },
              }
            : {}),
        },
        null,
        1
      ) + "\n"
    )
  }

  if (flag("--json")) return exitCodeOf(results)

  const green = summarize(results, wall, label, effWorkers)
  return green ? 0 : 1
}

// CLI 入口只在**被直接执行**时跑（`import.meta.main`：直接跑 = true，被 import = false）。
// 这样 `run-gates.test.mjs` 能 import 调度器真跑合成格子 —— 验收要的是可复跑的断言，不是一次性演示。
// 导出面只给测试与自检用，不是对外 API：改签名不用考虑兼容。
export { schedule, validateGateGraph, exitCodeOf, unjudgedViolations, loadLedger, runOne, predecessorsReady, gateSettled, gateFailed, skippedByFailFast, skippedByDependency, buildRegistry, readSurfaceOf, narrowSelection }

// ⚠️ ISS-857：**故意不 catch** RegistryError —— 同族的 timeoutMs 缺失在 HEAD 里也是裸调用，别造两种形态。
if (import.meta.main) process.exitCode = await main()
