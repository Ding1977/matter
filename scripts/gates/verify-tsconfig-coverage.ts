/**
 * 新树 tsconfig 覆盖闸（ISS-850 / W0-P0-4）—— 封陷阱③：**包没进 `references` ⇒ 类型错静默跳过且全绿**。
 *
 * ## 为什么需要这条判据（实测，不是推理）
 *
 * `tsc -b` **只遍历 `references` 图**。一个包「在 `packages/` 下但没登记」= 它永远不被类型检查，
 * 而 `tsc -b` 依然 `EXIT=0`。DOC-513 §1.2 的原始实测：
 *
 * ```
 * 新建 packages/kb/blocks/src/index.ts，写 export const bad: number = "type error"
 *   未加入 tsconfig.next.json 的 references：
 *     tsc -b                    → EXIT=0        ← 绿！错误没被看见
 *     ls packages/kb/blocks/lib → 不存在（它根本没被编译）
 *   加入 references 后：
 *     tsc -b                    → EXIT=1（TS2322，正确）
 * ```
 *
 * ⇒ 这是**最坏那一类失败**：假红有人修，假绿没人查。屏幕上一片绿，而新写的包从没被类型检查过一次。
 *
 * ## DSH 也没有这条判据（实查 7 处 `projectReferences` 消费者，逐处看过）
 *
 * `~/dsh-src` 里 grep 到 7 个文件引用 `projectReferences`：
 *   `scripts/project-reference-faces.ts`（判 host/client 面错配）·`scripts/compile-referenced-projects.ts`
 *   （拿引用去拼 `tsc -b` 参数）·`scripts/persistence-schema.ts`（取 outDir）·`scripts/clean.ts`（清产物）
 *   ·`scripts/ts-project.ts`（建 Program）·`packages/typert/generator/{src/analyzer,tests/type-model.spec}.ts`
 * **没有一处**问「盘上有 tsconfig.json 但没人 reference 它」。⇒ 必须自建。
 *
 * ## 两个方向都要，缺一条就是半个判据
 *
 * | 方向 | 判据 | 不判会怎样 |
 * |---|---|---|
 * | 正向 | 盘上每个 `packages/<g>/<p>/tsconfig.json` 都必须在图里（**含间接**：包级 tsconfig 自己的 `references`） | 陷阱③本身 |
 * | 反向 | 图里的 reference 指向的 `tsconfig.json` 在盘上不存在 | 删了包却留着 reference，`tsc -b` 报 TS5083 之前没人知道；更坏的是它让「图」与「盘」的集合悄悄脱节 |
 *
 * ## 语料口径：**只认盘上实际文件**
 *
 * ⛔ 不从 `pnpm-workspace.yaml` 反推包清单。反推的后果是「忘了建目录」被判成绿 ——
 * 那正好是陷阱③的另一种形态（workspace 声明了、盘上没有、于是没人查）。
 * 与 `verify-workspace-constraints` / `verify-plugin-shape` 同一条纪律：语料 = 盘上实际文件。
 *
 * ⚠️ 但「包级 tsconfig」的发现**不复用 `scanPackages()`**：那个函数以 `package.json` 为「什么算一个包」的
 * 判据，而本判据的语料是 `tsconfig.json`。两者在过渡期会不同步（先写 manifest 后补 tsconfig 是常态），
 * 用 manifest 当发现器会让「有 manifest 没 tsconfig」的包整个从射程里消失 —— 那又是一次静默跳过。
 *
 * ## 判不了（退出码 2）的三种情形 —— **都不许退化成绿**
 *
 *   · `packages/` 下 0 个包级 tsconfig.json（缺语料）
 *   · 聚合入口 `tsconfig.next.json` 不存在（图无从解析）
 *   · 取不到 typescript（JSONC 解析器缺失；**不许降级成正则凑** —— tsconfig 里带注释与尾逗号，
 *     `JSON.parse` 直接抛，正则剥注释会把 `"http://…"` 这类字符串吃掉）
 *
 * ## 退出码（口径见 `scripts/lib/gate-runtime.ts`）
 *   0 = 绿 · 1 = 红 · 2 = 判不了
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"
import { loadTypescript, parseJsonc } from "./lint-rule-fingerprint.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-tsconfig-coverage"

/** 聚合入口（`tsc -b` 的唯一入口，见 tsconfig.next.json 头注）。 */
export const ENTRY_REL = "tsconfig.next.json"
/** 包级 tsconfig 的两段位置：`packages/<group>/<pkg>/tsconfig.json`。 */
export const PACKAGES_REL = "packages"
/** 递归解图的深度上限。references 正常两三跳，给 16 是「成环或病态配置时别把进程耗死」。 */
export const MAX_DEPTH = 16

export interface CoverageInput {
  /** 盘上实际存在的包级 tsconfig 目录（仓库相对，如 `packages/storage/storage`） */
  onDisk: string[]
  /** 聚合入口递归解析出的全图目录（仓库相对；**已含间接**） */
  inGraph: string[]
  /**
   * 图里指向、但盘上没有对应 `tsconfig.json` 的目录 —— 「悬空 reference」。
   *
   * ⚠️ 为什么单独一个字段、而不让 `inGraph` 兼容两种语义：一个字符串数组无法同时表达
   * 「这个目标存在」与「这个目标不存在」。混在一起时只有两种做法，都错：
   *   · 只放存在的 ⇒ 悬空项在两侧都不出现 ⇒ **判绿**（陷阱③的反向版本，本判据一半失效）
   *   · 全放 ⇒ 合法引用到 `apps/`、`vendor/` 这类非包 project 会被误判成悬空（假红）
   * 分开之后：`inGraph` 答「图里有哪些真 project」，`dangling` 答「图里有哪些假 path」。
   * 省略 `dangling`（= 未声明）时视为「没有悬空项」，spec 的两个字段构造法照常成立。
   */
  dangling?: string[]
}

/** 路径归一：反斜杠→正斜杠、去掉 `./` 前缀与尾斜杠。空串 = 仓库根本身。 */
export function normalizeDir(p: string): string {
  const s = p.replaceAll("\\", "/").replace(/^\.\//, "")
  return s.length > 1 ? s.replace(/\/+$/, "") : s
}

/**
 * 纯函数判定（spec 直接喂构造数据，不碰 IO）。
 *
 * 两条方向**互不影响**：只缺一个登记时不许把悬空也报出来（那会让「漏登记一个包」与
 * 「图盘完全脱节」长得一样）。
 */
export function judgeCoverage(input: CoverageInput): GateResult {
  const onDisk = input.onDisk.map(normalizeDir)
  const inGraph = input.inGraph.map(normalizeDir)
  const dangling = (input.dangling ?? []).map(normalizeDir)

  if (onDisk.length === 0) {
    return unjudged(
      GATE,
      "no-corpus",
      `${PACKAGES_REL}/<group>/<pkg>/tsconfig.json 一个都没扫到（0 个包级 tsconfig）—— 判不了，不当绿`,
    )
  }

  const findings: Finding[] = []
  const graph = new Set(inGraph)

  // ── 正向：盘上有，图里没有 ⇒ 这个包永远不会被 tsc -b 编译 ────────────────────
  for (const dir of onDisk) {
    if (graph.has(dir)) continue
    findings.push({
      file: `${dir}/tsconfig.json`,
      detail:
        `不在 ${ENTRY_REL} 的 references 图里（含间接）—— **这个包不会被 tsc -b 编译，它的类型错永远不会被看见**。` +
        `修法：在 ${ENTRY_REL} 的 references 补 { "path": "./${dir}" }，或由某个已在图里的包级 tsconfig 引用它`,
    })
  }

  // ── 反向：图里有，盘上没有 ⇒ 悬空 reference ─────────────────────────────────
  for (const dir of dangling) {
    findings.push({
      file: `${dir}/tsconfig.json`,
      detail:
        `悬空 reference：\`${dir}\` 在盘上不存在（没有 tsconfig.json）—— ` +
        `包已删/已改名，而 references 还指着它。删掉那条 reference，或把包补回来`,
    })
  }

  if (findings.length) return { gate: GATE, status: "failed", findings }
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${onDisk.length} 个包级 tsconfig 全在 ${ENTRY_REL} 的 references 图里（含间接），无悬空 reference`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IO 侧：语料发现 + 解图
// ─────────────────────────────────────────────────────────────────────────────

/** `packages/<group>/<pkg>/` 的目录名两段。跳过点目录 / node_modules / 工作树池。 */
function twoLevelPkgDirs(root: string): string[] {
  const base = path.join(root, PACKAGES_REL)
  const skip = (n: string) => n.startsWith(".") || n === "node_modules"
  let groups: fs.Dirent[]
  try {
    groups = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return [] // packages/ 不存在 = 0 个包（不是崩）
  }
  const out: string[] = []
  for (const g of groups) {
    if (!g.isDirectory() || skip(g.name)) continue
    let pkgs: fs.Dirent[]
    try {
      pkgs = fs.readdirSync(path.join(base, g.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const p of pkgs) {
      if (!p.isDirectory() || skip(p.name)) continue
      out.push(`${PACKAGES_REL}/${g.name}/${p.name}`)
    }
  }
  return out.sort()
}

/** 盘上的包级 tsconfig 目录（= 语料全集）。 */
export function scanOnDisk(root: string = REPO): string[] {
  return twoLevelPkgDirs(root).filter((dir) => fs.existsSync(path.join(root, dir, "tsconfig.json")))
}

/** 一条 reference 解析出来的 config 绝对路径。TS 允许指向目录（找其中 tsconfig.json）或直接指文件。 */
function resolveRef(fromConfigAbs: string, refPath: string): string {
  const abs = path.resolve(path.dirname(fromConfigAbs), refPath)
  return abs.endsWith(".json") ? abs : path.join(abs, "tsconfig.json")
}

export interface GraphScan {
  inGraph: string[]
  dangling: string[]
  /** 解析失败的文件（JSONC 语法错 / 读不到）—— 调用方按红处理，不静默跳过 */
  errors: Finding[]
}

/**
 * 从聚合入口递归解出全图（含间接）。
 *
 * `visited` 兼作**环保护**：两条 tsconfig 互相 reference 在 TS 里是允许的（tsc 自己会处理），
 * 不设 visited 会无限递归。
 */
export function scanGraph(root: string, ts: ReturnType<typeof loadTypescript>): GraphScan {
  const inGraph: string[] = []
  const dangling: string[] = []
  const errors: Finding[] = []
  if (!ts) return { inGraph, dangling, errors }

  const seenDirs = new Set<string>()
  const visited = new Set<string>()

  const walk = (configAbs: string, depth: number): void => {
    if (visited.has(configAbs)) return
    visited.add(configAbs)
    if (depth > MAX_DEPTH) {
      errors.push({
        file: normalizeDir(path.relative(root, configAbs)),
        detail: `references 递归超过 ${MAX_DEPTH} 跳 —— 配置成环或病态，判不了这一支（不冒充绿）`,
      })
      return
    }
    let text: string
    try {
      text = fs.readFileSync(configAbs, "utf8")
    } catch (e) {
      errors.push({
        file: normalizeDir(path.relative(root, configAbs)),
        detail: `读不到：${(e as Error).message} —— 按红处理（跳过等于静默少判一整支）`,
      })
      return
    }
    const parsed = parseJsonc(ts, text)
    if (parsed.error !== undefined) {
      errors.push({
        file: normalizeDir(path.relative(root, configAbs)),
        detail: `不是合法 JSONC（${parsed.error}）—— 解不出 references，按红处理`,
      })
      return
    }
    const refs = parsed.config?.references
    if (!Array.isArray(refs)) return
    for (const ref of refs) {
      const p = (ref as { path?: unknown } | null)?.path
      if (typeof p !== "string" || !p) continue
      const targetConfig = resolveRef(configAbs, p)
      const targetDir = normalizeDir(path.relative(root, path.dirname(targetConfig)))
      if (!fs.existsSync(targetConfig)) {
        if (!dangling.includes(targetDir)) dangling.push(targetDir)
        continue
      }
      if (targetDir && !seenDirs.has(targetDir)) {
        seenDirs.add(targetDir)
        inGraph.push(targetDir)
      }
      walk(targetConfig, depth + 1) // 间接：跟着被引用的 project 继续走
    }
  }

  walk(path.join(root, ENTRY_REL), 1)
  return { inGraph, dangling, errors }
}

/**
 * 取 typescript：先试被测树，再退回本仓。
 *
 * ⚠️ 为什么要有退路（spec 实测抓到的）：`loadTypescript(root)` 的候选是**相对 root** 的
 * `node_modules/typescript`。spec 在 `os.tmpdir()` 造的临时树上跑同一个 `readCoverage()` 时，
 * 那里没有 node_modules ⇒ 取不到 ⇒ 整格 `unjudged(no-binary)`，**7 条真实 IO 断言全废**
 * （第一版就是这么红的）。
 *
 * 口径上这也更对：**typescript 是解析工具，不是被扫的语料**。语料在被测树里（该树说了算），
 * 工具可以来自运行方。同 `gen-layer-graph.ts:594` 的 `for (const base of [root, REPO])` 是同一做法。
 */
export function loadTsFor(root: string) {
  return loadTypescript(root) ?? loadTypescript(REPO)
}

/** 语料读取（main 用；spec 也可直接喂临时树 —— 走的是**同一套**发现/解图逻辑）。 */
export function readCoverage(root: string = REPO): GateResult {
  if (!fs.existsSync(path.join(root, ENTRY_REL))) {
    return unjudged(GATE, "no-corpus", `聚合入口 ${ENTRY_REL} 不存在 ⇒ references 图无从解析，判不了（不当绿）`)
  }
  const ts = loadTsFor(root)
  if (!ts) {
    return unjudged(GATE, "no-binary", `找不到 typescript（候选见 lint-rule-fingerprint.ts 的 TS_CANDIDATES）⇒ 没有可信的 JSONC 解析器，不降级成正则凑`)
  }
  const onDisk = scanOnDisk(root)
  const { inGraph, dangling, errors } = scanGraph(root, ts)
  // 解图本身出错（JSONC 坏 / 读不到 / 超深）⇒ 按红，不并入下面那两条方向判定：
  // 它是「判据判不了」，与「包漏登记」是两件事，混在一起会误导修法。
  if (errors.length) return { gate: GATE, status: "failed", findings: errors }
  return judgeCoverage({ onDisk, inGraph, dangling })
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-workspace-constraints.ts 的注释）。
  runGate({ name: GATE, main: () => readCoverage() })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
