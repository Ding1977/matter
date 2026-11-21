/**
 * 元判据：**registry 登记表 ↔ 实际调度格** 双向对账（ISS-812）。
 *
 * 为什么要有它：`scripts/run-gates.mjs:179` 的注释实测写着 ——
 *   「ISS-800：原先靠 `--verify-coverage` 真跑 guard 并对账名字来钉这件事；guard 退役后该命令一并删了。」
 * ⇒ 2026-11-13 之后**新增硬编码格不会被任何判据发现**。实测 `--list` 180 格 vs registry 派生 114 格，
 * 差额 66 格（内联 4 + 独立脚本 16 + CI 逐包 46）。其中内联与独立脚本**硬编码在代码里**，
 * 迁格时漏一格没人会知道 —— 这条判据就是那个「会知道」。
 *
 * 三条断言（射程互不重叠，缺一条就有一族格没人盯）：
 *   ① **正向**：registry 声明的 ⇒ 必须在 `--list` 里出现。
 *      `kind:"legacy"` 每个 `cells[i]` 必须派生出同名格；`kind:"spec"` 必须派生 `<id>` 格。
 *      ⚠️ 这一条不是重言式：`--list` 的派生有过滤器（只认 `status:active`、
 *      `REGISTRY_TIER_MAP` 把 `pre-commit`/`scheduled` 映射成空数组 ⇒ 那两档的条目**静默掉出 `--list`**）。
 *      也正因为派生侧会过滤，① 必须**另外**查脚本存在性 —— 否则「指向不存在脚本的条目」
 *      在两边同源的情况下永远对得上（ISS-812 返工实测）。
 *
 *      **`status:"deprecated"` 的语义（刻意如此，不是漏判）**：
 *        · 只要求 `note` 非空（弃用必须登记理由，否则等于静默下架）；
 *        · **不做存在性检查** —— 退役本就该删脚本，`deprecated + 脚本已删` 是**正常终态**，
 *          判红等于逼人留住尸体；
 *        · 但 `deprecated + 脚本还在` 会进结论行**提示可清理**（不红）——
 *          静默跳过会让「已退役」和「被跳过没人知道」在屏幕上长得一模一样。
 *
 *   ② **反向**：`--list` 里出现的 ⇒ 必须有来源归属。
 *      ⛔ 关键设计：**不是「禁止硬编码」，而是「硬编码必须登记在白名单里」**。
 *      这样收拢时每迁一格就从白名单删一条，迁完白名单为空 —— 那就是「登记唯一化」的自然收口。
 *      一句「禁止硬编码」在这里只会变成一条没人执行的口号。
 *
 *   ③ **基线自身不说谎**：白名单里每一格必须真实存在于 `--list`。
 *      防「登记了但没删」的化石：格迁走/改名了，白名单那条还在，账面上就永远有一笔假债。
 *
 * 口径来源：`source` 字段**只认调度器自己打的标记**，不从 `command` 猜脚本路径 ——
 * 猜法会把 `<internal>` 内置格和「同脚本两格」判错，而归属本来就有现成的机器可读字段。
 *
 *   ⑥ **入口存在性**（ISS-824）：一格指向的脚本必须**真有可执行入口**。
 *      ⑤ 之后还剩一种形态没被任何人盯：文件在、能读、`--check` 跑得出来，但**主逻辑整段没执行**。
 *      典型来源是把「供人 import 的库」登记成了格（官方 `bundle-input-isolation.ts` 就是 `export class`）——
 *      跑它拿到 `EXIT=0`，屏幕上和「判过了」一模一样，而它一行判据逻辑都没跑。
 *      这个假绿**不会自己暴露**：假红会有人修，假绿没人会去查一个永远绿的格。
 *      ⚠️ 判据按**登记形态分族**，不同族的入口长法不同（见 `entryFormOf()`）：
 *        · spec 条目（`.ts`）：`isMain(import.meta.url)` 包 `runGate({...})`
 *        · legacy `.mjs`：`process.argv` / `import.meta.main` / 顶层直跑（带 shebang）
 *        · legacy `.sh`：shebang（shell 无「import 但不执行」的形态）
 *        · CI 逐包格（`bun run test`）：**没有注册文件** ⇒ 本条不适用（不是漏判）
 *
 * 判据口径（`scripts/lib/gate-runtime.ts`）：0 绿 / 1 红 / 2 判不了。
 *   `--list --json` 拿不到（调度器崩了/不在本树）⇒ **unjudged，不许绿** —— 否则它自己坏掉时会安静地放过一切。
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"
import type { RegistryEntry } from "./registry.ts"
// ⚠️ 口径复用，不复制：派生规则只在 `selfcheck-ids.mjs` 有一份。
import { deriveSelftestGate } from "../lib/selfcheck-ids.mjs"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-gate-coverage"
const RUN_GATES_REL = "scripts/run-gates.mjs"
// ⚠️ 本文件住在 `scripts/baseline/`，会被 `verify-exemption-register`（ISS-814）数成
// 「66 条无 expires 的豁免」—— 因为它的口径是「凡带 `reason`/`why` 的对象 = 一条豁免」，
// 把**允许清单**与**豁免**混为一谈了。ISS-812 试过把文件搬到 `scripts/gates/` 规避，
// 老板 2026-11-13 否决：**按目录决定语义是错的**，谁的清单住在 gates/ 就永远数不到。
// 正解是 ISS-818 修口径。当前过渡办法：`exemption-register.json` 里登记
// `grandfathered: 66` 让它先绿；本文件的 `_meta.kind = "allowlist"` 是给 ISS-818
// 用的机器可读标记 —— 届时应按 kind 区分，不再靠目录猜。
const ALLOWLIST_REL = "scripts/baseline/gate-coverage-allowlist.json"

/** `buildRegistry()` 给 registry 派生格打的 `source`（spec 条目与 legacy 格各一种写法）。 */
const REGISTRY_SOURCES = new Set(["gates/registry.json", "gates/registry.json（legacy）"])
const INLINE_SOURCE = "guard-baselines.sh 内联"
const STANDALONE_SOURCE = "独立脚本"
const AGGREGATE_SOURCE = "整条登记"
/** `source` 为 `null` = `deriveCiPackageGates()` 逐包派生，没有标记。白名单里用这个字面量登记。 */
const CI_SOURCE = "ci-packages"

/**
 * 认得的归属族。只有 registry 一族免登记，其余四族都要进白名单。
 *
 * ⚠️ ISS-820 之后：`INLINE_SOURCE` / `STANDALONE_SOURCE` 两族的**产出者已经不存在**
 * （`scripts/lib/inline-gates.mjs` 已删、`gate-tables.mjs` 两张表已清空，20 格全迁进 registry）。
 * 这张表仍然保留它们，理由有两条，都不是"忘了删"：
 *   ① 措辞层要认得**历史来源**：宿主机器上 checkout 的旧工作树（未合入本单的树）照样会产出这两个
 *      source，判据要给得出「这格硬编码在哪个文件里」这句话，而不是「未知来源」——后者会把人引向
 *      "新增了派生路径"的错误结论。
 *   ② 若哪天有人误把表加回来，它会立刻以这两族的 source 出现 ⇒ 走「实际有但无归属」报红，
 *      不会静默通过。删掉这两行等于把那个洞重新打开（`source in ORIGIN_OF` 判的就是这个）。
 * 睡醒时想删它们：先确认仓里 `--list` 再也产不出这两个 source（`--list --json | grep -c 内联`）。
 */
const ORIGIN_OF: Record<string, string> = {
  [INLINE_SOURCE]: "scripts/lib/inline-gates.mjs（ISS-820 已删：4 格全数迁进 registry，别再往这里加）",
  [STANDALONE_SOURCE]: "scripts/lib/gate-tables.mjs 的 STANDALONE_GATES（ISS-820 已清空：16 格全数迁进 registry）",
  [AGGREGATE_SOURCE]: "scripts/lib/gate-tables.mjs 的 AGGREGATE_GATES",
  [CI_SOURCE]: "scripts/run-gates.mjs 的 deriveCiPackageGates()",
}

export interface ListedGate {
  id: string
  /** `--list --json` 原样给的值；`null` = CI 逐包派生。缺字段按「没有来源」处理。 */
  source: string | null
  /**
   * `--list --json` 的 `command` 整行（`<internal>` = 内置格，没有脚本）。
   * 用来查「这一格指向的脚本在不在」—— 连带把内联/独立脚本两族的同一个洞一起堵上，
   * 而 `verify-gate-registry` 只查 registry 声明，够不到这两族。
   */
  command?: string
}

export interface CoverageAllowEntry {
  /** 格 id，必须与 `--list` 逐字相同 */
  id: string
  /** 期望来源。等于 `--list` 的 `source`；CI 逐包写 `ci-packages`。对不上 ⇒ 红（多半是这格迁走了，该删条目） */
  source: string
  /** 非空 —— 理由是这个机制唯一的可审计面 */
  why: string
}

export interface CoverageAllowlist {
  why?: string
  /**
   * 条目数上限，**只减不增**。与 `legacy-allowlist.json` 同一个棘轮口径：
   * 要新增一条豁免必须同时调高它，那在 `git diff` 里是一行看得见的账。
   * 缺这个字段 ⇒ 红 —— 没有上限的存量清单会慢慢长回「全部登记」，判据等于回到重言式。
   */
  maxEntries?: number
  entries: CoverageAllowEntry[]
}

export interface CoverageInput {
  /** `scripts/gates/registry.json` 原样内容 */
  entries: RegistryEntry[]
  /** `--list --json` 的 gates；`null` = 拿不到（判不了，不许绿） */
  listed: ListedGate[] | null
  /** 白名单；`null` = 文件不存在（按空白名单照判，缺文件不能把整格变成不可判） */
  allowlist: CoverageAllowlist | null
  /**
   * 「这个仓库相对路径存在吗」。**缺了它 ① 就是重言式** ——
   * `--list` 的格是从 registry 派生的，两边同源，所以「声明了没派生」永远成立。
   * 真正会脱节的是**派生不看文件在不在**：`deriveRegistryGates()` 只按条目生成格、
   * 不 stat 脚本，于是「指向不存在脚本的条目」照样出现在 `--list` 里，跑起来必失败。
   * 这个探针就是查那一层。spec 注入固定集合，main 用 `fs.existsSync`。
   */
  scriptExists?: (rel: string) => boolean
  /**
   * 「读得出这个脚本的正文吗」。**⑥ 的探针**，与 `scriptExists` 同一个注入理由（spec 不碰 IO）。
   *
   * 返回 `null` = 读不出（文件没了 / 权限 / 编码）。这一支**判红**，不跳过：
   * 「读不出」与「读出来了但没有入口」在屏幕上都会显示成绿 —— 那正是本判据要修的那类假绿。
   */
  readScript?: (rel: string) => string | null
  /**
   * 上一版（`git show <锚点>:...`）的计数快照，供 ⑤ 格数棘轮做锚点。
   * `null` = 读不到锚点 ⇒ 这一条判不了（判红，不冒充绿，见 ⑤）。
   *
   * ⚠️ 为什么锚点是 **`origin/main`**，不是工作区、也不是 `HEAD`：
   *
   *   · **工作区**不行 —— 基线自己能被改（把 182 改成 66 就绕过了）。
   *   · **`HEAD` 不行**（ISS-812 返工，实测）：`git show HEAD:` 的锚点会**追平被检查的内容** ——
   *     清空 registry 后**一提交**，`HEAD` 里的 registry 也变成空，两边相等 ⇒ ⑤ 重新变成重言式。
   *     实测：清空 + 未提交 ⇒ 红（182→66）；同样内容**提交后 ⇒ passed**（66 == 66）。
   *     这与 `review-gate` 第 10 条同型：**锚点和被检查对象同源，就判不出两者脱节**。
   *   · **`origin/main`** 才对 —— 本地清空并提交，`origin/main` 仍是旧值 ⇒ 照样红；
   *     要动 `origin/main` 必须推到远端，那要过 pre-push 闸并留下 PR 记录。
   *
   * ⚠️ 取不到 `origin/main`（未 fetch 的裸克隆 / 浅克隆 / 非 git 环境）⇒ `null`。
   * 此时 ⑤ **判红并指名原因**，不是「只提示」。理由：本仓 `main` 是唯一主干，
   * 取不到锚点说明环境不满足判据前提，此时报绿等于把「没验」说成「验过」。
   * 口径与 `verify-exemption-register`（ISS-814）的 `readPreviousLimits` 同类，但**结论更强**。
   */
  baselineAtHead?: GateCountBaseline | null
  /**
   * 批量退役通道（ISS-880）：置位时放宽 ⑤ 的「只许降」两条，但**逐 id 留痕**。
   * 缺省回落到读 `process.env.GATE_BATCH_RETIRE === "1"` —— 判据常由 run-gates 子进程调用，env 会继承。
   * spec 显式注入本字段，保证「未置位仍红」的用例不受宿主环境变量污染。
   */
  batchRetire?: boolean
}

/** 格数快照：两条独立的棘轮，一个不许降、一个不许升。 */
export interface GateCountBaseline {
  /** `--list` 的总格数（**不许降**：清空登记表 = 关掉所有门禁） */
  gates: number
  /** registry 参与派生的条目数（**不许降**：大面积标 deprecated 等价于清空） */
  registryEntries: number
  /**
   * 锚点里 `--list` 的格 id 集合。**只服务于批量退役通道的逐 id 留痕**（ISS-880）：
   * 只给计数不给 id，通道就只能说「降了 N 格」而说不出「降了哪几格」—— 那正是「不静默」要防的。
   * 与 `gates` 同一口径（active registry 派生 id + 白名单 id），长度应等于 `gates`。锚点读不到时缺省。
   */
  listedIds?: string[]
  /** 锚点里 active registry 条目的 id 集合，与 `registryEntries` 同一口径，供通道逐 id 留痕。 */
  activeIds?: string[]
  /**
   * 白名单里**硬编码族**（`source !== ci-packages`）的条数（**不许升**：防止靠扩白名单
   * 把新硬编码洗成「已登记」）。
   *
   * ⚠️ ISS-863：这里数的是**分族后的**条数，不是白名单总条数。原先是总数，
   * 于是同一个动作被两条规则判相反：③b 的文案明确允许「调高 maxEntries 就能加豁免」，
   * 而 ⑤ 拿总数对锚点一比就红 —— **规则 2 的许可在规则 3 面前无效**，新增包无路可走。
   * 分族的理由见 ⑤ 那段注释：ci-packages 族由 `deriveCiPackageGates()` 按包派生，
   * 包数增长必然长出格，那不是「有人偷偷加硬编码」。总量闸仍由 ③b 把着，没有放松。
   */
  allowHardcodedEntries: number
}

/** 一条格在 `--list` 里的归属表现（用于措辞，不参与判定）。 */
const describeSource = (source: string | null): string => (source === null ? CI_SOURCE : source)

/**
 * 白名单里**硬编码族**的条数 —— ⑤ 棘轮的唯一计数口径（ISS-863）。
 *
 * 为什么要把 `ci-packages` 族剔除：这一族的格由 `deriveCiPackageGates()` 按
 * `package.json` 的 `workspaces` 逐包派生（`scripts/run-gates.mjs:209-235`），
 * **包数增长必然长出格**，跟「有人把硬编码塞进白名单洗成已登记」是两件事。
 * ⑤ 的文案写明它防的是后者，剔除前者是**把射程收回到文案承诺的那件事**，不是放宽。
 *
 * ⚠️ 剔除的只是「自然增长」，不是「整个 ci 族免检」：
 *   · 手动加一条 ci-packages 条目仍然过 ②（格必须真的在 `--list` 里）与 ③（不许化石）；
 *   · 手动加**任何**非 ci-packages 条目仍然被 ⑤ 判红（`comm` 出来的那一族才是棘轮的对象）；
 *   · 白名单**总量**仍被 ③b 的 `maxEntries` 夹着，二者分工不同、都在。
 *
 * ⚠️ 口径复用：这里用 `CI_SOURCE` 常量，与 ② 的 `describeSource()` 同一个字面量 ——
 * 两处各写一份字符串就会在下一次改族名时分叉（本仓反复踩的形态）。
 */
const countHardcodedAllowEntries = (entries: readonly { source?: unknown }[]): number =>
  entries.filter((e) => e?.source !== CI_SOURCE).length

/** `countHardcodedAllowEntries` 的导出别名：spec 必须用**同一个函数**造基线，不自己写一份。 */
export { countHardcodedAllowEntries }

/** argv 拆分：按空白切，但引号里的空白不切（与 `verify-gates-registry.mjs` 同口径）。 */
const splitArgv = (cmd: string): string[] =>
  (String(cmd).match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ""))

/**
 * 从 `--list` 的 `command` 整行里取出脚本路径（仓库相对或绝对）。
 * 认第一个带脚本扩展名的 token —— `<internal>` 没有 token 命中 ⇒ 返回 null（内置格不适用）。
 * 解释器路径（`/usr/local/bin/node`）不带这些扩展名，不会被误当脚本。
 */
export function scriptOf(command: string | undefined): string | null {
  if (typeof command !== "string" || !command.trim()) return null
  for (const tok of splitArgv(command)) {
    if (/\.(mjs|cjs|js|ts|tsx|sh)$/.test(tok)) return tok
  }
  return null
}

/**
 * 剥掉注释：**注释里提到 `process.argv` 不等于它有入口**（ISS-824）。
 *
 * 为什么必须剥：本仓脚本的注释极密（`run-gates.mjs` 2056 行里近半是注释），
 * 而注释恰恰最爱写「为什么这里读 `process.argv`」「`--check` 时走哪支」——
 * 拿原文匹配等于让**解释**冒充**实现**。ISS-762 的教训同一件事：注释不是代码。
 *
 * ⚠️ **必须单趟交替匹配**，不能「先剥块注释、再剥行注释」分两步跑 —— 实测踩过：
 *   `stale-client-bundle.mjs:2` 的行注释里写着 `src/{星}{星}`（glob 里的双星），两步写法先拿块注释正则去扫，
 *   把那个「斜杠+星」当成块注释开头，一路吞到下一个「星+斜杠」，**把中间 137 行真代码（含 `process.argv`）全剥掉**
 *   ⇒ 两个真判据被误判成「无入口」。单趟交替时左起先遇到的是 `//`，行注释整条吃掉，
 *   那个「斜杠+星」落在它体内，不再升格成块注释开头。
 *
 * ⚠️ 射程（明说，别当全覆盖）：只剥「整行注释」与块注释，**不剥行尾注释**（`code // 说明`，
 *   与 `scripts/lib/declared-reads.mjs` 的 `stripComments` 同一口径）。
 *   这只会**少剥**、不会**多剥** ⇒ 最坏把行尾注释里的关键词当成代码（偏假绿），不会把真代码剥掉（不造假红）。
 *   字符串里出现「斜杠+星」仍会误开块注释（同 `declared-reads` 的已知边界）——
 *   本仓 91 个判据脚本实测 0 处命中，但它确实是本函数的上限。
 */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/.*$/gm, "")

/** 一格的可执行入口形态（`none` = 该红）。 */
export type EntryForm =
  /** `isMain(import.meta.url)` —— spec 载体的标准形态（`runGate({...})` 挂在它下面） */
  | "isMain"
  /** `import.meta.main` —— Bun 的写法，本仓只 1 处 */
  | "import.meta.main"
  /** `process.argv` —— `.mjs` 独立脚本的主形态（91 个脚本里 74 个走这个） */
  | "process.argv"
  /** shebang + 顶层直跑，一个标记都不带。**只认 `.mjs` 一族**，见 `entryFormOf()` */
  | "shebang"
  /** `.sh`：shebang 是 shell 唯一的「入口」概念 */
  | "shell-shebang"
  /** 顶层自执行：无 main guard，整个文件就是程序（`node <file>` 直接跑）— ISS-832 */
  | "top-level"
  /** 没有可执行入口 ⇒ 登记成格就是假绿 */
  | "none"

/**
 * 判一格的入口形态（ISS-824）。**按登记形态分族**，不分就无法同时判对下面三种：
 *
 * | 族 | 入口长法 | 为什么不能一视同仁 |
 * |---|---|---|
 * | spec `.ts` | `isMain(import.meta.url)` | 只认这一种。`.ts` 里出现 `process.argv` 是**读参数**不是入口（`runGate` 内部就在读，6/11 个判据带它），拿它当入口会把「没有 isMain 的库」判成有入口 |
 * | legacy `.mjs` | `process.argv` / `import.meta.main` / shebang | 三形态并存（实测 56 带 shebang、17 不带、1 只带 shebang）。缺 shebang 也照样是入口：`node x.mjs` 不需要它 |
 * | legacy `.sh` | shebang | shell 没有「被 import 就不执行」的形态 ⇒ 有 shebang 就是可执行入口。⚠️ 不查 `set -e`：那是**错误处理**，不是**入口**，拿它判入口会把 5 个 `.sh` 里 4 个误判成无入口（实测只有 `ws-lease-selftest.sh` 写了） |
 *
 * ⚠️ `--check` / `isGateFile(` **不算入口依据**：前者是**参数名**不是分发逻辑
 *   （`route-alias-check.mjs` 全文没有 `--check`，靠 `argv.includes("--selftest")` 分流，
 *   却确实可执行）；后者是「这文件名算不算判据」的谓词，与能不能跑无关。
 *   工单草稿里列了这两个，实测都不能当判据 —— 拿它们判会把**两个方向都判错**。
 *
 * ⚠️ 射程：CI 逐包格（`bun run test`）与 `<internal>` 没有注册文件，`scriptOf()` 就返回 null
 *   ⇒ 调用方在进本函数之前已经跳过，不会走到这里。
 */
export function entryFormOf(script: string, raw: string | null): EntryForm {
  const rel = script.toLowerCase()
  // 读不出 ⇒ 判红（**不跳过**：跳过 = 「没验」和「验过了」在屏幕上一样）
  if (raw === null) return "none"
  if (rel.endsWith(".sh")) return raw.startsWith("#!") ? "shell-shebang" : "none"
  const code = stripComments(raw)
  if (rel.endsWith(".ts") || rel.endsWith(".tsx")) {
    // spec 载体：入口**只认** isMain —— 见上面表格第二行。
    return /isMain\(/.test(code) || /import\.meta\.main/.test(code) ? "isMain" : "none"
  }
  // .mjs / .cjs / .js：四种形态都算入口。
  if (/import\.meta\.main/.test(code)) return "import.meta.main"
  if (/process\.argv/.test(code)) return "process.argv"
  if (raw.startsWith("#!")) return "shebang"
  // ISS-832：**顶层自执行**形态 —— 没有 main guard，整个文件就是程序（`node <file>` 直接跑）。
  //   实测两个受害者：`scripts/tests/build-index-credential.test.mjs`（顶层跑 + `process.exitCode`）、
  //   `scripts/lint-code.test.mjs`（`import test from "node:test"`，node:test 自己驱动）。
  //   二者都不需要 main guard：文件被 `node <file>` 调用时**顶层就是入口**。
  //   ⚠️ 判据要窄：只认「有可执行顶层效果」的明确信号，不能「有顶层语句就算」——
  //   那几乎任何文件都算，判据就白设了。
  //
  // ⛔ **这是判据语义变更（收紧），不是重构**：第 ⑥ 条能判出的「有入口」集合变小了。
  //   真语料 196 格按宽/窄两种子句各算一遍，判定变化的格 **0 个** ⇒ 今天不改变任何结论；
  //   将来若某格因这一改从「有入口」翻成 none，那是**该格本来就没入口**，不是退步。
  //
  // ⚠️ ISS-857：`console.log(` **不再是入口依据**（原先与上两条并列）。
  //   它判的不是「有没有入口」，而是「有没有打印」：函数体里一行缩进的 `console.log("build")`
  //   就足够命中，于是 `export class` 库被判成有入口 —— 正是第 ⑥ 条存在的唯一目的（堵假绿）被自己绕开。
  //   实测两例（都在本单改前、真跑 `entryFormOf`）：
  //     `export class X {\n  run() {\n    console.log("build")\n  }\n}`           ⇒ top-level（应为 none）
  //     "export class X {}\nconst s = `\nconsole.log(1)\n`"                        ⇒ top-level（应为 none）
  //   而真受害者 `build-index-credential.test.mjs` 靠的是 `process.exitCode = …`（实测同时命中两条，
  //   去掉 console.log 一条仍判 top-level）。真语料全 196 格按宽/窄两种子句各算一遍：
  //   判定不同的格 **0 个** ⇒ 去掉它不改变任何现有结论，只堵住那个洞。
  //   `await` / `process.exitCode` 保留：它们是**进程级副作用**，库文件里不会无声出现。
  if (/(^|\n)\s*(process\.exitCode\s*=|await\s+)/.test(code)) return "top-level"
  if (/from\s+["']node:test["']/.test(code)) return "top-level"
  return "none"
}

/**
 * 纯函数：spec 直接喂构造数据，不碰文件系统。
 *
 * 输出顺序固定为 ①②③，红项措辞各自点名「是声明了没派生 / 实际有但无归属 / 基线说谎」——
 * 三种红的根因完全不同，措辞混在一起就得分不出该改 registry 还是该改白名单。
 */
export function judgeCoverage(input: CoverageInput): GateResult {
  if (input.listed === null) {
    return unjudged(GATE, "no-corpus", `拿不到 ${RUN_GATES_REL} --list --json 的登记表 ⇒ 分不清「没有多出来的格」和「判据自己坏了」`)
  }
  const findings: string[] = []
  /** 只提示不判红的观察项（deprecated 残留、可清理项）。 */
  const stale: string[] = []
  /** 真正参与派生的条目数（`status:"active"`）—— 结论行不能拿总条目数冒充它。 */
  let activeCount = 0
  const listedIds = new Set(input.listed.map((g) => g.id))
  const allow = input.allowlist ?? { entries: [] }

  // ── ① 正向：声明了 ⇒ 必须派生 ───────────────────────────────────────────
  for (const e of input.entries) {
    if (e.status === "deprecated") {
      // 豁免必须留理由：没有理由的「弃用」= 删不动又不用管，两边都不负责任。
      if (!e.note?.trim()) {
        findings.push(`${e.id}：registry 标了 deprecated 却没写 note（弃用必须登记理由，否则等于静默下架）`)
      }
      // ⚠️ deprecated 条目**刻意不做存在性检查**（ISS-812 返工）。
      //
      // 语义：退役本就该删脚本 ⇒「deprecated + 脚本已删」是**正常终态**，判红等于逼人留住尸体。
      // 而「deprecated + 脚本还在」才是没清干净的残渣，提示可清理（不红）。
      // 两者都不是错，所以这一支不产生 findings —— 但它必须出声，不能静默 continue：
      // 静默跳过的坏处是「这格已经退役」与「这格被跳过了没人知道」在屏幕上长得一模一样。
      if (e.kind === "legacy" && e.script?.trim() && input.scriptExists?.(e.script)) {
        stale.push(`${e.id}：已 deprecated 但脚本 ${e.script} 还在，可清理`)
      }
      continue
    }
    activeCount++
    if (e.kind === "legacy") {
      const cells = Array.isArray(e.cells) ? e.cells : []
      if (!cells.length) findings.push(`${e.id}：legacy 条目 cells[] 为空（登记了但一格都不派发）`)
      // ⚠️ 这条不是冗余：`--list` 对不存在的脚本照样派生格，所以上一条逐格比对**查不出来**。
      // 这就是「--list 是假绿」那个洞 —— 元判据该管的正是它。
      if (e.script?.trim() && input.scriptExists && !input.scriptExists(e.script)) {
        findings.push(
          `${e.id}：登记的脚本不存在（${e.script}）—— --list 照样派生出这些格，但真跑必失败【登记指向不存在的脚本】`,
        )
      }
      for (const c of cells) {
        if (!c.id?.trim()) findings.push(`${e.id}：有 cell 缺 id（派生出来会是空 id 格）`)
        else if (!listedIds.has(c.id)) findings.push(`${e.id}/${c.id}：声明了但没派生 —— registry 有这一格，--list 里没有【声明了没派生】`)
      }
      continue
    }
    // spec 条目：派生路径写死成 `scripts/gates/<id>.ts`，同一个洞。
    if (input.scriptExists && !input.scriptExists(`scripts/gates/${e.id}.ts`)) {
      findings.push(`${e.id}：登记的判据文件不存在（scripts/gates/${e.id}.ts）—— --list 照样派生，但真跑必失败【登记指向不存在的脚本】`)
    }
    if (!listedIds.has(e.id)) {
      findings.push(`${e.id}：声明了但没派生 —— registry 有这条 spec 条目，--list 里没有【声明了没派生】`)
    }
  }

  // ── ② 反向：实际有 ⇒ 必须有归属 ─────────────────────────────────────────
  const allowById = new Map<string, CoverageAllowEntry>()
  for (const a of allow.entries) {
    const id = typeof a?.id === "string" ? a.id.trim() : ""
    if (!id) {
      findings.push(`(白名单条目缺 id)：有一条白名单没有 id 字段【基线自身说谎】`)
      continue
    }
    if (allowById.has(id)) findings.push(`${id}：白名单里重复登记【基线自身说谎】`)
    allowById.set(id, a)
    if (!a.why?.trim()) findings.push(`${id}：白名单条目 why 为空（空理由 = 不可审计的免死金牌）`)
  }

  const declaredIds = new Set<string>()
  for (const e of input.entries) {
    if (e.status !== "active") continue
    if (e.kind === "legacy") {
      for (const c of e.cells ?? []) if (c.id) declaredIds.add(c.id)
    } else {
      declaredIds.add(e.id)
      // ISS-857：spec 条目还派生一格自检格（`<id>-selftest`，进 gateselfcheck 档）。
      // 它同样「来自 registry」，② 必须认得它 —— 否则派生一上线就以 22 条
      // 「实际有但无归属」连红，而那是**判据口径落后于调度器**，不是真有 22 格无主。
      // ⚠️ 口径不在这里重写：调 `selfcheck-ids.mjs` 的派生函数本体，
      // 两处各写一份判断就会在下一次改规则时分叉（本仓反复踩的形态）。
      const derived = deriveSelftestGate(e, "")
      if (derived) declaredIds.add(derived.id)
    }
  }

  for (const g of input.listed) {
    const source = g.source ?? null

    if (source !== null && REGISTRY_SOURCES.has(source)) {
      // 归属 registry 一族：来源合法，但还要求它**真的在 registry 里**。
      // 这条不是重言式 —— 派生只认 `status:"active"`，而 `declaredIds` 也只算 active，
      // 一旦两处口径漂开（例如派生侧漏了过滤器），这里会立刻点名。
      if (!declaredIds.has(g.id)) {
        findings.push(`${g.id}：--list 标为 ${source}，但 registry.json 里没有这条 active 声明【实际有但无归属】`)
      }
      continue
    }

    if (source !== null && !(source in ORIGIN_OF)) {
      // 出现没见过的 source ⇒ 有人给调度器加了新的派生路径。这条**不许白名单**：
      // 白名单是为了让「已登记的存量硬编码」可审计，不是为了让新派生路径绕过人的一眼。
      findings.push(`${g.id}：--list 的 source 是未知的 ${JSON.stringify(source)} —— 新的派生路径必须先进本判据的归属表，或改成 registry 登记`)
      continue
    }

    const a = allowById.get(g.id)
    if (!a) {
      findings.push(
        `${g.id}：--list 里有，但白名单没有登记（来源 ${describeSource(source)} ⇒ ${ORIGIN_OF[source ?? CI_SOURCE]}）【实际有但无归属】`,
      )
      continue
    }
    if (a.source !== describeSource(source)) {
      // 来源改了 = 这格迁走了（或换族了）。旧条目必须删，否则账面上那笔债永远不还。
      findings.push(`${g.id}：白名单记的来源是 ${a.source}，--list 现在是 ${describeSource(source)} —— 这格已经换族/迁走，删掉这条白名单`)
    }
  }

  // ── ③ 基线自身不说谎：白名单每格必须真实存在 ───────────────────────────
  for (const a of allow.entries) {
    const id = typeof a?.id === "string" ? a.id.trim() : ""
    if (!id) continue
    if (!listedIds.has(id)) {
      findings.push(`${id}：白名单登记了，但 --list 里没有这一格【基线自身说谎】`)
    }
  }

  // ── ③b 棘轮：清单只许变短 ────────────────────────────────────────────────
  // 与 `legacy-allowlist.json` 同一口径。没有这条上限，「登记」会慢慢长成「全部登记」，
  // 判据就退回它要修的那个重言式 —— 而每一步都合法，没有任何一步会被发现。
  if (input.allowlist) {
    const cap = input.allowlist.maxEntries
    if (!Number.isInteger(cap) || (cap as number) < 0) {
      findings.push(`${ALLOWLIST_REL}：maxEntries 缺失或不是非负整数（它是「只减不增」唯一的机械约束）`)
    } else if (allow.entries.length > cap) {
      findings.push(
        `${ALLOWLIST_REL}：${allow.entries.length} 条 > 上限 ${cap} 条 —— 清单只许变短。` +
          `真要加豁免必须同时调高 maxEntries，那在 git diff 里看得见，赖不掉。`,
      )
    }
  }

  // ── ⑤ 格数棘轮：①②③ 全都防不住「干脆不写」 ──────────────────────────────
  //
  // 为什么必须有这一条（ISS-812 实测，审查员报、Lead 复核）：
  //   ① 的命题是「声明了 ⇒ 必须派生」。**registry 写成 `[]` 时没有任何声明，
  //   命题空洞地成立 ⇒ passed**，而 `--list` 从 182 格掉到 66 格 ——
  //   等于把 113 个门禁全关了，屏幕上却一片绿。
  //   同理把 63 条 legacy 全标 `deprecated`（只出提示不红）也能把 182 掉到 75。
  //
  // 「声明都要生效」防的是**写了不生效**，防不住**不写**。这两件事必须分开判。
  //
  // 三条棘轮各自夹一个方向（只加一条不够，逐个都留了绕法）：
  //   · gates 不许降 —— 夹「清空 registry / 大面积 deprecated」；
  //   · registryEntries 不许降 —— 夹「用 tiers 或 status 把条目藏起来」；
  //   · allowHardcodedEntries 不许升 —— 夹反方向：把新增硬编码塞进白名单洗成「已登记」。
  // 锚点取 `git show origin/main:` 而非工作区、也不是 HEAD，理由见 `baselineAtHead` 的注释。
  //
  // ⚠️ ISS-863：第三条的计数**按 source 分族**，只数硬编码族（`source !== ci-packages`）。
  // 原先是白名单总条数，于是与 ③b 直接互斥 —— ③b 明写「真要加豁免必须同时调高 maxEntries」，
  // 而那正是 ⑤ 判红的同一个动作，新增包无论怎么改都红（实测：补 2 条 ⇒ ③b 红；调高
  // maxEntries ⇒ ⑤ 红）。⑤ 的射程写的是「防新增**硬编码**格」，而 CI 逐包格由
  // `deriveCiPackageGates()` 按包派生、`why` 里已写明「不是硬编码债」，本就不在射程内。
  // ⇒ 分族是**把射程收回到文案**，不是开新口子：手动加硬编码条仍红（spec 有反例），
  // 白名单总量仍被 ③b 的 `maxEntries` 夹着。
  //
  // ── 批量退役通道（ISS-880）──────────────────────────────────────────────
  // DOC-518 §5 步 0 要整批退役旧树棘轮（约 10 条），退役会合法地让 gates / registryEntries
  // 下降 ⇒ 假红。pre-push 的 GATE_EXPECT_BATCH_CHANGE（ISS-808）只管 run-gates 格集合一致性，
  // 不管这条独立判据，所以这里单开一个显式通道。
  //
  // 边界（违反任一条就是后门，不是通道）：
  //   ① 默认关：未置位时下面三条判定逐字不变，3 条棘轮反例必须继续红；
  //   ② 只放宽「只许降」两条（gates / registryEntries），**不碰 allowHardcodedEntries 只许升**；
  //   ③ 放宽不是静默：逐 id 打印降了哪些（走 result.detail，而非被判定为红），
  //      锚点没给 id 集合时只能说「未留 id」—— 拒绝只报个数字就放过；
  //   ④ 下限保护：置位也不是「清到 0 格就绿」—— gates 降到 0 / registryEntries 降到 0 仍红，
  //      通道只放行「退役一部分」，不放行「关掉全部」。
  // env 由 `process.env.GATE_BATCH_RETIRE === "1"` 读；spec 用 `batchRetire` 显式注入，
  // 使「未置位仍红」用例不受宿主环境变量污染（否则跑 spec 的 shell 恰好置位会让反例假绿）。
  const batchRetire = input.batchRetire ?? process.env.GATE_BATCH_RETIRE === "1"
  const retireNotes: string[] = []
  if (!input.baselineAtHead) {
    // 取不到锚点 ⇒ **判红**，不是「只提示」。
    // 曾经的写法把它塞进 `stale`（只提示不判红）⇒ 那一支的结论是 **passed**，
    // 屏幕上是绿的 —— 「判不了」被显示成「通过了」，正是本判据要修的那类假绿。
    // 锚点读不到只可能是环境不满足前提（未 fetch / 浅克隆 / 非 git），
    // 此时正确动作是让门禁响，而不是放它过去。
    findings.push(
      `格数棘轮未判：读不到锚点 origin/main 里的计数（未 fetch / 浅克隆 / 非 git 环境）。` +
        `这一条是本判据唯一的「只增不减」约束，判不了就不许报绿 —— 先 git fetch 再来`,
    )
  } else {
    const prev = input.baselineAtHead
    const nowAllow = countHardcodedAllowEntries(allow.entries)
    const now = { gates: input.listed.length, registryEntries: activeCount, allowHardcodedEntries: nowAllow }
    const gatesDropped = now.gates < prev.gates
    const registryDropped = now.registryEntries < prev.registryEntries
    // 批量退役只放行「部分退役」。清到 0 格 / 0 条 ⇒ 仍是关门禁，通道不适用这两条仍红。
    const gatesCleared = now.gates === 0
    const registryCleared = now.registryEntries === 0
    const retireGates = batchRetire && gatesDropped && !gatesCleared
    const retireRegistry = batchRetire && registryDropped && !registryCleared

    /** 逐 id 留痕：两端 id 集合都给了才算留得住；只给一端就降级成「未留 id」，绝不静默放过。 */
    const droppedIds = (prevIds: string[] | undefined, nowIds: Set<string>): string => {
      if (!Array.isArray(prevIds)) return "（锚点未提供 id 集合，无法逐 id 留痕）"
      const gone = [...new Set(prevIds)].filter((id) => !nowIds.has(id))
      return gone.length ? gone.join("、") : "（计数降但 id 集合未减少，请人工核对）"
    }

    if (gatesDropped) {
      if (retireGates) {
        const nowIds = new Set(input.listed.map((g) => g.id))
        retireNotes.push(
          `批量退役通道已启用：--list 格数从 ${prev.gates} 掉到 ${now.gates}（合法降 ${prev.gates - now.gates} 格），逐 id 列出：${droppedIds(prev.listedIds, nowIds)}【批量退役留痕】`,
        )
      } else {
        findings.push(
          `--list 格数从 ${prev.gates} 掉到 ${now.gates}（少 ${prev.gates - now.gates} 格）—— 格数只许增不许减。` +
            `清空登记表 = 关掉所有门禁，而 ① 对空登记表是空洞成立【格数棘轮】`,
        )
      }
    }
    if (registryDropped) {
      if (retireRegistry) {
        const nowIds = new Set(input.entries.filter((e) => e.status !== "deprecated").map((e) => e.id))
        retireNotes.push(
          `批量退役通道已启用：registry 参与派生的条目数从 ${prev.registryEntries} 掉到 ${now.registryEntries}（合法降 ${prev.registryEntries - now.registryEntries} 条），逐 id 列出：${droppedIds(prev.activeIds, nowIds)}【批量退役留痕】`,
        )
      } else {
        findings.push(
          `registry 参与派生的条目数从 ${prev.registryEntries} 掉到 ${now.registryEntries} —— 只许增不许减。` +
            `大面积标 deprecated / 抽掉 tiers 都能把格藏起来【格数棘轮】`,
        )
      }
    }
    if (now.allowHardcodedEntries > prev.allowHardcodedEntries) {
      findings.push(
        `白名单里的硬编码族（非 ${CI_SOURCE}）从 ${prev.allowHardcodedEntries} 条涨到 ${now.allowHardcodedEntries} 条 —— 只许减不许增。` +
          `否则新增硬编码格可以靠「加进白名单」洗成已登记，② 就白判了【格数棘轮】` +
          `（${CI_SOURCE} 族不计入：它由 deriveCiPackageGates() 随包派生，见 ISS-863）`,
      )
    }
  }

  // ── ④ 派生物自身的完整性：--list 的格指向的脚本必须存在 ────────────────
  //
  // 为什么这一条不能省（ISS-812 实测）：`--list` 是**派生结果**，派生不 stat 脚本，
  // 所以「指向不存在脚本的格」会以完全合法的样子出现在登记表里 ——
  // ①~③ 全都看不见它：① 比的是同一份 registry，② 只问来源归属，③ 只管白名单。
  // 覆盖到真跑那一刻才炸，而那时报的是「某格失败」，看不出根因是「登记指向了不存在的文件」。
  // ⚠️ 射程：只查带脚本路径的格（`<internal>` 内置格没有脚本，跳过 —— 那不是漏判，是不适用）。
  for (const g of input.listed) {
    const script = scriptOf(g.command)
    if (!script || !input.scriptExists) continue
    if (!input.scriptExists(script)) {
      findings.push(`${g.id}：--list 的格指向不存在的脚本（${script}）—— 它会照常出现在登记表里，但真跑必失败【派生物指向不存在的脚本】`)
    }
  }

  // ── ⑥ 入口存在性：文件在 ≠ 它能跑出判据 ────────────────────────────────
  //
  // 为什么 ④ 之后还差这一条（ISS-824，ISS-819 实测撞到）：
  //   ④ 只问「脚本在不在」。一个 `export class` 库**在**，`node x.ts --check` 也**退 0**（主逻辑整段不执行），
  //   于是「在」和「判过了」在屏幕上长得一模一样。官方 `bundle-input-isolation.ts` 就是这个形态，
  //   它是构建期注入 tsdown 的 class 库 —— 而本仓用 `bun build`，那段代码根本不会被调用。
  //
  // 与 ④ 分开判的理由：两者的**修法不同**。④ 红 = 补文件或改登记路径；⑥ 红 = 这文件**不该被登记成格**
  //   （它是库，交给 import 用）。措辞混在一起，读报的人不知道该补文件还是该撤登记。
  //
  // ⚠️ 射程（明说，别当全覆盖）：只查 `--list` 里 `command` 带脚本路径的格（实测 138/184）。
  //   CI 逐包 46 格没有注册文件（`bun run test` 的真相源是各包 package.json），本条管不到它们。
  for (const g of input.listed) {
    const script = scriptOf(g.command)
    if (!script || !input.readScript) continue
    // 文件不存在 ⇒ ④ 已经报过「派生物指向不存在的脚本」。这里**跳过**，同一个根因只出一句：
    // 两条同时报会让人以为是两个毛病（④ 的修法是补文件，⑥ 的修法是撤登记 —— 混在一起就读不出该改哪边）。
    if (input.scriptExists && !input.scriptExists(script)) continue
    const form = entryFormOf(script, input.readScript(script))
    if (form === "none") {
      findings.push(
        `${g.id}：${script} 没有可执行入口 —— 它跑出来的 EXIT=0 是「主逻辑没执行」的假绿，不是「判过了」【无声判据】`,
      )
    }
  }

  if (findings.length) {
    return { gate: GATE, status: "failed", findings: findings.map((detail) => ({ detail })) }
  }
  const registryCount = input.listed.filter((g) => g.source !== null && REGISTRY_SOURCES.has(g.source)).length
  // ⚠️ 分账必须用 activeCount，不能用「条目总数」冒充 —— 实测踩过：
  // 加一条 deprecated 条目后，结论行照样打「registry 73 条声明全部派生」，
  // 而 `--list` 只派生了 72 条（deprecated 被派生侧过滤掉）。那一行是**假话**，
  // 而整格还报 passed —— 一个不成立的断言比没有断言更糟。
  const deprecatedCount = input.entries.length - activeCount
  const parts = [
    `--list ${input.listed.length} 格 = registry ${registryCount} + 白名单 ${allow.entries.length}（硬编码存量）`,
    deprecatedCount > 0
      ? `registry ${activeCount} 条 active 声明全部派生（另有 ${deprecatedCount} 条 deprecated 不派生）`
      : `registry ${activeCount} 条声明全部派生`,
  ]
  if (stale.length) parts.push(`${stale.length} 条可清理：${stale.slice(0, 3).join("；")}`)
  // ⑥ 的口径必须**上屏**（ISS-621 ④：观察口径不可见 = 读报的人以为它管了全部）。
  // 46 格是 CI 逐包（`bun run test`），脚本住在各包 package.json 里，没有「注册文件」这个概念。
  if (input.readScript) {
    const withScript = input.listed.filter((g) => scriptOf(g.command) !== null).length
    parts.push(`入口存在性查了 ${withScript} 格（另 ${input.listed.length - withScript} 格是 CI 逐包，没有注册文件 ⇒ 本条不适用）`)
  }
  // 批量退役留痕：必须上屏，否则「放宽」和「静默放行」在屏幕上长得一模一样 ——
  // 每条逐 id 的增删都在 result.detail 里，跑一遍 --check 就能看到降了哪几格。
  if (retireNotes.length) parts.push(...retireNotes)
  return { gate: GATE, status: "passed", findings: [], detail: parts.join(" · ") }
}

/** 读白名单。文件不存在 ⇒ 按空白名单照判（不判不了）；存在但坏 ⇒ 判不了。 */
function readAllowlist(p: string): { ok: true; allow: CoverageAllowlist | null } | { ok: false; detail: string } {
  if (!fs.existsSync(p)) return { ok: true, allow: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8"))
  } catch (e) {
    return { ok: false, detail: `${ALLOWLIST_REL} 不是合法 JSON（${(e as Error).message}）⇒ 判不了` }
  }
  const entries = (parsed as CoverageAllowlist | null)?.entries
  if (!Array.isArray(entries)) return { ok: false, detail: `${ALLOWLIST_REL} 没有 entries 数组 ⇒ 判不了` }
  return { ok: true, allow: parsed as CoverageAllowlist }
}

/**
 * 问调度器要它的登记表。**不解析源码** —— 源码里出现格名不算派生（同 `verify-gates-registry.mjs` 的口径）。
 * 失败一律返回 null（⇒ unjudged），绝不返回空数组：空数组会伪装成「没有多出来的格」= 恒绿。
 */
function readListed(): ListedGate[] | null {
  const sched = path.join(REPO, RUN_GATES_REL)
  if (!fs.existsSync(sched)) return null
  const r = spawnSync(process.execPath, [sched, "--list", "--json"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 })
  if (r.status !== 0) return null
  try {
    const j = JSON.parse(r.stdout) as { gates?: unknown }
    if (!Array.isArray(j.gates)) return null
    return (j.gates as { id?: unknown; source?: unknown; command?: unknown }[]).map((g) => ({
      id: String(g?.id ?? ""),
      source: typeof g?.source === "string" ? g.source : null,
      command: typeof g?.command === "string" ? g.command : undefined,
    }))
  } catch {
    return null
  }
}

/**
 * 从 `git show HEAD:<path>` 读上一版，交给 `derive` 算计数。
 * 读不到（首次入库 / 非 git 环境 / 文件在 HEAD 里不存在）⇒ `null`，由 ⑤ 降级成提示。
 *
 * ⚠️ 与 `verify-exemption-register` 的 `readPreviousLimits` 同一手法，理由也同一件事：
 * **锚点必须来自已提交的版本**，否则「改基线」和「改数据」可以在同一笔提交里互相抵消。
 */
/**
 * 从 `git show <锚点>:<path>` 读上一版，交给 `derive` 算计数。
 * 读不到（未 fetch / 浅克隆 / 非 git / 文件在锚点里不存在）⇒ `null`，由 ⑤ **判红**。
 *
 * ⚠️ 锚点是 `origin/main`，**不是 `HEAD`**（ISS-812 返工，实测）：
 * `git show HEAD:` 的锚点会追平被检查的内容 —— 清空 registry 后提交一次，`HEAD` 里的
 * registry 也空了，两边相等 ⇒ ⑤ 退回重言式。实测「清空+未提交 ⇒ 红」「清空+提交 ⇒ passed」。
 * 锚点必须来自**被检查对象之外**的真相源，否则判不出两者脱节（review-gate 第 10 条）。
 */
const ANCHOR_REF = "origin/main"

function countAtAnchor<T>(rel: string, derive: (raw: unknown) => T | null): T | null {
  try {
    const out = execFileSync("git", ["-C", REPO, "show", `${ANCHOR_REF}:${rel}`], {
      encoding: "utf8",
      maxBuffer: 8 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return derive(JSON.parse(out))
  } catch {
    return null
  }
}

/** 锚点（`origin/main`）里的三个计数。任一读不到 ⇒ 整条棘轮判不了（不拿半个数冒充）。 */
function readBaselineAtAnchor(): GateCountBaseline | null {
  const prevEntries = countAtAnchor("scripts/gates/registry.json", (raw) => (Array.isArray(raw) ? (raw as RegistryEntry[]) : null))
  const prevAllow = countAtAnchor(ALLOWLIST_REL, (raw) => {
    const e = (raw as CoverageAllowlist | null)?.entries
    if (!Array.isArray(e)) return null
    // ⚠️ ISS-863：锚点侧与判定侧**必须用同一个函数**数 —— 两处各写一份就会在
    // 「哪一族计入」上下一次改动时分叉，而分叉的表现是「锚点比总数、现在比分族」
    // ⇒ 首次入库必红（本仓 ISS-812 已踩过同型：拿格数比条目数，误报 116 vs 72）。
    return { total: e.length, hardcoded: countHardcodedAllowEntries(e) }
  })
  if (!prevEntries || prevAllow === null) return null
  // 上一版的 `--list` 格数按**同一口径**重算（registry 派生 + 白名单），
  // 不缓存「上次 --list 的原始输出」—— 那会在调度器改动后立刻过期，变成另一个会说谎的数。
  const derived = prevEntries
    .filter((e) => e.status === "active")
    .reduce((n, e) => (e.kind === "legacy" ? n + (Array.isArray(e.cells) ? e.cells.length : 0) : n + 1), 0)
  // ⚠️ `registryEntries` 数的是**参与派生的条目数**（active 条目），不是派生出的格数 ——
  // 两边量纲必须与 `judgeCoverage` 里的 `activeCount` 一致，否则 ⑤ 拿格数比条目数，
  // 首次入库就必红（实测：116 格 vs 72 条，误报「条目数从 116 掉到 72」）。
  const activeEntries = prevEntries.filter((e) => e.status === "active").length
  // 批量退役通道的逐 id 留痕（ISS-880）：id 集合与计数**同口径**取自锚点，
  // 否则留痕说「降了 X」而 id 对不上，读报的人无从核对。
  //   · activeIds = active 条目 id；
  //   · listedIds = active registry 派生 id（legacy 展开 cells）。
  // 白名单侧锚点只给了计数值、没留原始 id，故 listedIds 不含白名单格；
  // 退役针对 registry 条目，逐 id 留痕落在这一侧已经够用。
  const active = prevEntries.filter((e) => e.status === "active")
  const derivedIds = active.flatMap((e) =>
    e.kind === "legacy" ? (Array.isArray(e.cells) ? e.cells.map((c) => c.id) : []) : [e.id],
  )
  // `gates` 用**总条数**：白名单每多登一格，`--list` 就多一格，两边量纲必须一致。
  // （分族计数只服务于 ⑤ 的「不许升」，与格数无关 —— 拿它算 gates 会把 46 格算丢。）
  return {
    gates: derived + prevAllow.total,
    registryEntries: activeEntries,
    allowHardcodedEntries: prevAllow.hardcoded,
    listedIds: derivedIds,
    activeIds: active.map((e) => e.id),
  }
}

async function scan(): Promise<CoverageInput> {
  const registryPath = path.join(REPO, "scripts/gates/registry.json")
  let entries: RegistryEntry[] = []
  if (fs.existsSync(registryPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"))
      if (Array.isArray(parsed)) entries = parsed as RegistryEntry[]
    } catch {
      // 坏 JSON ⇒ entries 空 ⇒ ① 无可判、② 全红。仍比「静默当 0 条」好。
    }
  }
  return {
    entries,
    listed: readListed(),
    allowlist: null,
    baselineAtHead: readBaselineAtAnchor(),
    // `--list` 的 command 里是**绝对路径**（`path.join(REPO, ...)` 拼的），registry 的 `script`
    // 是**仓库相对路径**。两种都收 —— 只用 `path.join` 会把绝对路径再前置一次 REPO（实测 115 条假阳性）。
    scriptExists: (p: string) => fs.existsSync(path.isAbsolute(p) ? p : path.join(REPO, p)),
    // ⑥ 的探针。读不出返回 `null`（不抛）—— 那一支在 `entryFormOf()` 里判 `none`，
    // 即「读不出」与「读出来没入口」**同等判红**。理由：两者在屏幕上都显示成绿，
    // 而「没验」被显示成「验过了」正是本判据存在的理由。
    readScript: (p: string) => {
      try {
        return fs.readFileSync(path.isAbsolute(p) ? p : path.join(REPO, p), "utf8")
      } catch {
        return null
      }
    },
  }
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：--selftest 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（Node 报 unsettled top-level await, rc=13）。
  //
  // ⚠️ 更不许在模块顶层调 `scan()`：它 `spawnSync` 整个调度器，spec 一 import 本文件就会连带跑一遍
  //   `--list`（几秒 + 一个子进程），而 spec 判的是纯函数，本不该碰 IO。
  runGate({
    name: GATE,
    main: async () => {
      const allow = readAllowlist(path.join(REPO, ALLOWLIST_REL))
      if (!allow.ok) return unjudged(GATE, "no-baseline", allow.detail)
      const i = await scan()
      return judgeCoverage({ ...i, allowlist: allow.allow })
    },
  })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
