/**
 * 工作树深度判据（ISS-870 / W-0）—— **恰好两级准入**的机器形态。
 *
 * ## 为什么需要它（实测，不是推理）
 *
 * 老板 2026-11-17 定「先打通二级树链路」。现状是：官方 `create_worktree` 从**会话树**里建树
 * `EXIT=0`、`repositoryRoot` 取到会话树、池随之变成 `<会话树>/.agents/worktrees`
 * —— 而官方**零处**嵌套判据（全包 grep `nest` 只命中 `restore` 的一条路径校验）。
 * 我们这边唯一的「禁套娃」只在 `scripts/ws.sh` 的 `adopt` 一条命令里，`cmd_new` / `cmd_allocate` 0 处。
 *
 * ⇒ 今天二级树**能建**，只是 `adopt` 拒绝认领，且**没有任何判据看得见它**。
 *   三级及以上同理：没有任何入口会拦，也没有任何东西会报。
 *
 * ## 判据（三断言，三条互不重叠）
 *
 * ```
 * depth(P) = |{ Q ∈ 注册树 : Q ≠ P 且 P.startsWith(Q + '/') }|
 *
 * ① ∀P: depth(P) ≤ 1        红 = 三层及以上（无定义）
 * ② ∀P: depth(P)=1 ⇒ 登记表 kind === 'issue' 且 parent 指到外层那棵
 *                           红 = 无约定/无登记的随手嵌套（ISS-688 那类）
 * ③ ∀P: depth(P)=0 且非主检出 ⇒ 无记录只报不红（存量 52 棵，清理由人执行）
 * ```
 *
 * 为什么 ③ 只报不红：仓里今天有 52 棵平级树，本判据落地那一刻它们全部「未登记」。
 * 判红 = 判据上线即红 = 长红等于没有判据（`docs/code.md` K7 系列反复记过这一条）。
 * ⛔ 但 ③ **绝不放宽 ②**：一旦某棵树的 depth 变成 1，它就必须在登记表里且 kind=issue。
 *
 * ## 口径：路径必须**双侧 realpath 归一**（这是本判据最容易错的一处）
 *
 * 主检出的池是软链 `.agents/worktrees → ~/wt/dsh-forge`（`pool_link_problem` 的合规形态），
 * 于是**同一棵树有两种写法**：
 *
 * ```
 * git worktree list 给出      <wt>/ISS-870
 * 经池软链写出来的是           <repo>/.agents/worktrees/ISS-870
 * ```
 *
 * 不归一就前缀匹配 ⇒ 同一棵树既算 `depth=0` 又算 `depth=1`，② 会对**每一棵合法树**误红
 * （2026-11-17 现场：主检出侧 `.agents/worktrees` 实测是软链，见 `ls -ld`）。
 * ⇒ 输入侧（`git worktree list`）与登记表侧（`trees.json` 的 `path`）**两边都用 realpath 归一**，
 *   只归一一边是假阴性（同 `scripts/ws.sh:1909` 的 `worktree_registered` 口径）。
 *
 * ## 为什么登记表「文件不存在」不等于「判不了」
 *
 * 少一张表 ≠ 环境不满足判据前提，而是**准入约定本身没了**。此时若 return passed，
 * 删掉 `.agents/trees.json` 就等于关掉 ②（`scripts/lib/gate-runtime.ts` 头注 ① 明令禁止
 * 「用 0 表示跳过」）。故：**文件缺席 ⇒ 按空表判**（有 depth≥1 的树就红，并点名「表不存在」）。
 * 只有**表在但读不动**（JSON 坏 / 权限）才 return `unjudged(no-corpus)` —— 那是真判不了。
 *
 * ## 退出码（口径见 `scripts/lib/gate-runtime.ts`）
 *   0 = 绿 · 1 = 有违规 · 2 = 判不了（`git worktree list` 拿不到 / 登记表读不动 / 一棵树都没列出来）
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-tree-depth"

/** 登记表的仓内位置（相对仓库根）。 */
export const REGISTRY_REL = ".agents/trees.json"
/** 允许的最大深度。0 = 主检出/平级树；1 = 会话树下的工单树。**2 及以上无定义**。 */
export const MAX_DEPTH = 1

/** 登记表一行。只落判据要用到的最小字段 —— 没有消费者的字段不预建。 */
export interface TreeEntry {
  /** `session` = 会话树（二级里的外层）；`issue` = 工单树（内层）。其余值一律判红。 */
  kind?: string
  /** 该树的绝对落点（判据按它做前缀匹配，必须与 `git worktree list` 对得上）。 */
  path?: string
  /** 分支名（人读 + 与 `worktree list` 对账用；判据不依赖它）。 */
  branch?: string
  /** 外层树的标识：可以是外层在登记表里的**键**，也可以是外层树的**路径**（两种写法都认）。 */
  parent?: string | null
}

export interface DepthInput {
  /** `git worktree list` 给出的路径，**原样**（未归一，`--check` 时就是这样）。第一行 = 主检出。 */
  trees: string[]
  /** 主检出路径；不给则取 `trees[0]`（git 的 `worktree list` 恒把主检出放第一行）。 */
  mainCheckout?: string
  /** `.agents/trees.json` 解析结果。`null` = 读不动 ⇒ 判不了；`{}` = 表在且为空。 */
  registry: Record<string, TreeEntry> | null
  /** 归一函数（默认 `fs.realpathSync`，解析不到时回落原串）。spec 注入它才是纯函数。 */
  realpath?: (p: string) => string
  /** 盘上存在性（默认 `fs.existsSync`）。用于跳过「登记了但树已删」的行。 */
  exists?: (p: string) => boolean
}

/** 归一 + 去尾斜杠；解析不到（路径已不存在）时回落原串 —— 回落而不是抛，才能进 finding 而不是崩。 */
const tolerantRealpath = (p: string): string => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p.replace(/\/+$/, "") || "/"
  }
}

/** `P` 是否落在 `Q` 之内（按路径段匹配，`/a/bc` 不算 `/a/b` 的子路径）。 */
const isUnder = (p: string, q: string): boolean => p !== q && p.startsWith(q.endsWith("/") ? q : `${q}/`)

/**
 * 纯函数层：喂构造数据（或真读数）⇒ `GateResult`。**不碰 IO**，除经注入的两个回调。
 *
 * @param input 见 `DepthInput`
 * @returns 绿 / 红（逐条 finding）/ 判不了（无树可判、登记表读不动）
 */
export function judgeTreeDepth(input: DepthInput): GateResult {
  const rp = input.realpath ?? tolerantRealpath
  const exists = input.exists ?? ((p: string) => fs.existsSync(p))

  if (!Array.isArray(input.trees) || input.trees.length === 0) {
    return unjudged(GATE, "no-corpus", "`git worktree list` 一棵树都没给出来 —— 判不了，不当绿")
  }

  const trees = [...new Set(input.trees.filter((t) => !!t).map(rp))]
  const main = rp(input.mainCheckout ?? input.trees.find((t) => !!t) ?? "")

  if (input.registry === null) {
    return unjudged(GATE, "no-corpus", `${REGISTRY_REL} 读不动（JSON 坏 / 权限）—— 两级准入无从判定，不当绿`)
  }
  const registry = input.registry ?? {}

  const findings: Finding[] = []
  const hints: string[] = []

  // ── 登记表侧归一：路径 → (键, 行) ────────────────────────────────────────
  // 映射键用**归一后的路径**，不用 id：单号会改名（`ISS-860-v2`）、目录名会带后缀（`ISS-835-ledger`），
  // 而路径是判据真正在做前缀匹配的那个东西。id 只作措辞里的指称。
  const byPath = new Map<string, { key: string; e: TreeEntry }>()
  let vanished = 0
  for (const [key, e] of Object.entries(registry)) {
    if (!e || typeof e !== "object") {
      findings.push({ file: REGISTRY_REL, detail: `${key}：登记行不是对象 —— 这一行无法参与准入判定` })
      continue
    }
    if (typeof e.path !== "string" || !e.path.trim()) {
      findings.push({ file: REGISTRY_REL, detail: `${key}：登记行缺 path —— 没有落点就无法与 \`git worktree list\` 对齐` })
      continue
    }
    // 登记了但树已删（会话树归档 / 收树后忘删行）：跳过，不判红。
    // 理由：判红会让「删一棵树」这个正常动作把门禁弄红，而它不违反深度约定。
    //
    // ⚠️ 这一行同时承担**可移植性**：`.agents/trees.json` 里是绝对路径，别人 clone 之后
    //   那些路径在他机器上**不存在**。没有这条跳过，判据会在每一台别人的机器上报红
    //   （「登记了 N 棵不存在的树」）⇒ 判据随环境变色，正是 skill 明令禁止的形态。
    //   实测：只留主检出 + 一棵平级树、`exists()` 恒 false，判据仍 passed（detail 报「跳过 2 条」）。
    if (!exists(e.path)) {
      vanished++
      continue
    }
    const p = rp(e.path)
    const prev = byPath.get(p)
    if (prev) {
      findings.push({
        file: REGISTRY_REL,
        detail: `${key} 与 ${prev.key} 登记了**同一条路径** ${p} —— ② 的映射会静默挑一个，必须去重`,
      })
      continue
    }
    byPath.set(p, { key, e })
  }

  // ── 主判据：逐棵树算深度 ────────────────────────────────────────────────
  let maxDepth = 0
  let unrecordedDepth0 = 0
  for (const p of trees) {
    // 主检出**不作父节点**：`new --in-repo` 的 `.wt/ISS-x` 物理上就在主检出目录下，那不是「另一棵树」。
    // 同一口径见 `scripts/ws.sh` 的 `worktree_nesting_parent`（排除 $REPO 的那一行）。
    const parents = trees.filter((q) => q !== main && isUnder(p, q))
    const depth = parents.length
    if (depth > maxDepth) maxDepth = depth
    const where = `深度=${depth}（外层 ${parents.sort((a, b) => b.length - a.length)[0]}）`

    // ① 三层及以上：无定义
    if (depth > MAX_DEPTH) {
      findings.push({
        file: p,
        detail: `${where} —— **三层及以上**无定义（上限 ${MAX_DEPTH} 级）。` +
          `树里再建树会让 deps/产物按外层树的 node_modules 补 ⇒ 门禁不可信；` +
          `且 git 把多层树的注册条目绞在一起，rm/prune 会互相牵连。修法：回到主检出再建，或删掉多出来的那层`,
      })
      continue
    }

    const hit = byPath.get(p)

    // ② depth=1 ⇒ 必须在登记表里、kind=issue、parent 指到外层
    if (depth === MAX_DEPTH) {
      if (!hit) {
        findings.push({
          file: p,
          detail: `${where} —— ${REGISTRY_REL} 里**没有它的登记行**。` +
            `两级准入要求内层树必须先登记（kind:"issue" + parent 指到外层）才允许存在；` +
            `无约定的随手嵌套就是 ISS-688 那类（deps/产物补到别人树上的静默错）。` +
            `修法：在 ${REGISTRY_REL} 加一行 { "<单号>": { kind: "issue", path: "${p}", parent: "${parents[0] ?? ""}" } }`,
        })
        continue
      }
      const e = hit.e
      if (e.kind !== "issue") {
        findings.push({
          file: REGISTRY_REL,
          detail: `${hit.key}：${where}，但登记行 kind=${JSON.stringify(e.kind)} —— ` +
            `两级里的**内层必须是 issue**（外层才是 session）。改 kind，或把这棵树挪到池外`,
        })
        continue
      }
      // parent 两种写法都认（外层键 / 外层路径）：写键便于人读，写路径便于机器生成。
      const outer = parents.sort((a, b) => b.length - a.length)[0] ?? ""
      const outerKey = byPath.get(outer)?.key
      const parentRaw = typeof e.parent === "string" ? e.parent : ""
      const parentOk = !!parentRaw && (parentRaw === outerKey || rp(parentRaw) === outer)
      if (!parentOk) {
        findings.push({
          file: REGISTRY_REL,
          detail: `${hit.key}：${where}，但 parent=${JSON.stringify(e.parent)} 指不到外层那棵树。` +
            `期望 ${outerKey ? `"${outerKey}"` : "外层的登记键"} 或 "${outer}"。` +
            `parent 错会让「谁是谁的外层」两张表对不上，事后无法归属`,
        })
      }
      continue
    }

    // ③ depth=0 的存量：只报不红
    if (p !== main) {
      if (hit) hints.push(`${hit.key} 已登记`)
      else {
        unrecordedDepth0++
        hints.push(`${p} 无登记行`)
      }
    }
  }

  if (findings.length) return { gate: GATE, status: "failed", findings }

  const parts = [`trees=${trees.length}`, `maxDepth=${maxDepth}`]
  if (unrecordedDepth0) parts.push(`depth0 未登记 ${unrecordedDepth0} 棵（只报不红，清理由人执行）`)
  if (vanished) parts.push(`登记行指向已删除的树 ${vanished} 条（跳过）`)
  return { gate: GATE, status: "passed", findings: [], detail: parts.join(" · ") }
}

/** `git worktree list --porcelain` 的输出 → 路径数组（第一行恒为主检出，git 如此定义）。 */
export function parseWorktrees(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter(Boolean)
}

/** 真读数：`git worktree list --porcelain` 的路径列（第一行 = 主检出）。拿不到 ⇒ null。 */
function readWorktrees(): string[] | null {
  try {
    const out = execFileSync("git", ["-C", REPO, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      maxBuffer: 1 << 22,
    })
    return parseWorktrees(out)
  } catch {
    return null
  }
}

/**
 * 真读数：登记表。三态 ——
 *   文件缺席 ⇒ `{}`（按空表判，理由见文件头「为什么登记表文件不存在不等于判不了」）
 *   表在且能解析 ⇒ 解析结果
 *   表在但读不动 ⇒ `null`（判不了）
 *
 * spec 直接喂临时文件测这三态，不碰真仓的 `.agents/trees.json`。
 */
export function readRegistryAt(p: string): Record<string, TreeEntry> | null {
  if (!fs.existsSync(p)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    // 以 `_` 开头的键是注释位（与 `unjudged-ledger.json` / `file-size.json` 同口径），不当作登记行。
    const out: Record<string, TreeEntry> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k.startsWith("_")) continue
      out[k] = v as TreeEntry
    }
    return out
  } catch {
    return null
  }
}

export function readDepthInput(): DepthInput {
  const trees = readWorktrees()
  return {
    trees: trees ?? [],
    mainCheckout: trees?.[0],
    registry: readRegistryAt(path.join(REPO, REGISTRY_REL)),
  }
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-tsconfig-coverage.ts 的注释）。
  runGate({ name: GATE, main: () => judgeTreeDepth(readDepthInput()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
