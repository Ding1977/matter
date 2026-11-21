/**
 * `verify-tsconfig-paths` —— 包名 ⇔ paths 键**双向对账**闸（ISS-897 / ISS-518 盲区闭环）。
 *
 * ## 为什么需要这条判据（ISS-518 实测教训，不是推理）
 *
 * `tsconfig.base.emit.json` 的 `paths` 是手写的，而 next 档 18 格无一格判它的**完备性**
 * （`verify-tsconfig-coverage` 只判 references 图，不管模块解析）。漏配一条的直接后果：
 * **在漏配那一刻没有任何判据红**，直到第一个跨包消费方撞 TS2307 才暴露 —— 且报错位置在
 * consumer 的 import 行，不在漏配处。P3 新增包 3–5 个，漏配概率随包数线性上升。
 * ISS-518 的 storage-journal 就是这么漏的：该包当时零跨包消费方，TS2307 一直没炸，
 * 直到 E-0（@matter/issue）成为第一个 consumer 才在别人身上红。
 *
 * ## 乙方案（Lead 已拍）：纯对账，不做生成
 *
 * 只对「键集合 ⇔ 包名集合」做双向对账，不生成、不改 tsconfig。生成路线
 * （DSH 式 gen-tsconfig-paths）等 D4 生成区域机制落地后再议 —— 往这份满篇注释的
 * JSONC 里塞生成段需要配套机制，本单不碰。
 *
 * | 方向 | 判据 | 不判会怎样 |
 * |---|---|---|
 * | 正向 | 盘上每个 `packages/<g>/<p>/package.json` 的 `name` 必须是 paths 的一个键 | ISS-518 本体：漏配静默，直到第一个 consumer 撞 TS2307 |
 * | 反向 | paths 的每个键必须是盘上某个包的 `name` | 删了包/改了名却留着键 ⇒「表」与「盘」悄悄脱节；悬空键还会给人「已配置」的假象 |
 *
 * ## 与 ISS-855（值有效性射程）的分界
 *
 * 本判据只管**集合对账**（该有的键在不在）；「键在但值写错 ⇒ tsc 靠 node_modules 软链
 * 兜底不红」的**值有效性**是 ISS-855 的射程（其对每条 paths 断言目标文件存在且被真实
 * import，设计待 Lead 裁决）。两半互补，不互相替代：本格判不出「值写错」，那格判不出
 * 「整条漏配」。
 *
 * ## 语料口径（三条纪律）
 *
 *   · 包侧复用 `scanPackages()`（verify-plugin-shape）——「什么算一个包」只有一处定义
 *     （同 verify-workspace-constraints 复用先例）。组目录（isGroup）不是包，不参与对账
 *     （组目录禁 manifest 由 verify-plugin-shape 管，不在这里重复实现）。
 *   · paths 侧用 `parseJsonc`（lint-rule-fingerprint 的 typescript 解析器）：这份文件满篇
 *     `//` 注释，`JSON.parse` 直接抛，**不许降级成正则剥注释**（会把 `"http://…"` 字符串吃掉，
 *     同 verify-tsconfig-coverage 头注的纪律）。
 *   · manifest 坏（JSON 坏 / 无 name）的包**按红**，不静默跳过 —— 静默跳过等于那一支
 *     永远没人盯（语料坏 ≠ 语料空）。
 *
 * ## 退出码（口径见 `scripts/lib/gate-runtime.ts`）
 *
 *   0 = 绿（双向全对上） · 1 = 红（漏配 / 悬空 / 语料坏） · 2 = unjudged
 *
 * unjudged 的两种情形（**都不许退化成绿**）：
 *   · `tsconfig.base.emit.json` 不存在 ⇒ no-corpus（对账一侧缺席）
 *   · 取不到 typescript ⇒ no-binary（没有可信 JSONC 解析器，不降级成正则凑）
 *
 * ⚠️ **空语料 = 0 个包 ⇒ unjudged，不是绿**（单正文钉死）：空包集合与任何键集合都
 * 「对不上任何东西」，那不是「全对上」。但「0 包 + 8 键」仍判 unjudged 而非红——
 * 包语料为空时悬空键无从定义（「哪个包该对上哪个键」这个问题没有语料）。
 * 反之「8 包 + 0 键」判红不判 unjudged：包语料是满的，对账可执行，
 * 结论就是 8 条漏配（真实的违规状态，不是判不了）。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"
import { loadTypescript, parseJsonc } from "./lint-rule-fingerprint.ts"
import { scanPackages } from "./verify-plugin-shape.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-tsconfig-paths"

/** 对账对象：仓库根的 emit 基座（ISS-508 起 packages 新树唯一 paths 出处）。 */
export const EMIT_REL = "tsconfig.base.emit.json"

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数判定：spec 直接喂构造数据，不碰 IO
// ─────────────────────────────────────────────────────────────────────────────

/** 盘上一个包的对账输入。`name: null` = manifest 坏（JSON 坏 / 无 name）——按红不静默。 */
export interface PkgEntry {
  /** 仓库相对路径，形如 `packages/storage/storage` */
  dir: string
  /** manifest 的 `name`；null = 读不出（IO 层填好，judge 不再碰盘） */
  name: string | null
}

export interface PathsInput {
  /** 盘上包（packages/&lt;group&gt;/&lt;pkg&gt;，有 manifest）；**不含组目录** */
  packages: PkgEntry[]
  /** `tsconfig.base.emit.json` 的 `compilerOptions.paths` 的键（包名形态，如 `@matter/issue`） */
  pathsKeys: string[]
}

/**
 * 纯函数判定（与 `judgeCoverage` 同构：两侧集合双向对账）。
 *
 * 判定顺序即语义：语料空先判（unjudged），再判语料坏（红），最后双向对账——
 * 顺序错了会把「空语料」误判成「8 条漏配」的假红。
 */
export function judgePaths(input: PathsInput): GateResult {
  const { packages, pathsKeys } = input

  if (packages.length === 0) {
    return unjudged(
      GATE,
      "no-corpus",
      `packages/<group>/<pkg>/package.json 一个都没扫到（0 个包）—— 没有对账语料，判不了，不当绿`,
    )
  }

  const findings: Finding[] = []

  // ── 语料坏：manifest 读不出 name ⇒ 按红，不静默跳过 ────────────────────────
  for (const p of packages) {
    if (p.name === null || p.name === "") {
      findings.push({
        file: `${p.dir}/package.json`,
        detail:
          `manifest 读不出 name（JSON 坏或没有 name 字段）—— 无法对账，按红处理` +
          `（静默跳过等于这一支永远没人盯）。修法：修好 ${p.dir}/package.json（合法 JSON 且有 name）`,
      })
    }
  }

  const names = new Set(packages.filter((p) => p.name).map((p) => p.name as string))
  const keys = new Set(pathsKeys)

  // ── 正向：包存在而 paths 缺 ⇒ ISS-518 本体（漏配静默到第一个 consumer 撞 TS2307）──
  for (const p of packages) {
    if (!p.name || keys.has(p.name)) continue
    findings.push({
      file: `${p.dir}/package.json`,
      detail:
        `包 \`${p.name}\`（${p.dir}）在盘上，但 ${EMIT_REL} 的 compilerOptions.paths 没有它的键 —— ` +
        `期望 paths 含 "${p.name}"，实际缺失；漏配此刻没人红，第一个跨包消费方会在自己的 import 行撞 TS2307（ISS-518）。` +
        `修法：在 ${EMIT_REL} 的 paths 补一条 "${p.name}": ["./${p.dir}/src/index.ts"]（新增 @matter 包时同批补）`,
    })
  }

  // ── 反向：paths 有键而包不存在 ⇒ 悬空（「表」与「盘」脱节，还给人已配置的假象）──
  for (const key of pathsKeys) {
    if (names.has(key)) continue
    findings.push({
      file: EMIT_REL,
      detail:
        `悬空键 \`${key}\`：paths 有这个键，但盘上没有任何包的 name 是它（packages/*/*/package.json 对不上）—— ` +
        `期望键与包名一一对应，实际多出悬空项。修法：包已删/改名 ⇒ 从 ${EMIT_REL} 的 paths 删掉这条；包还在别处 ⇒ 对齐 name`,
    })
  }

  if (findings.length) return { gate: GATE, status: "failed", findings }
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${packages.length} 个包的 name 与 ${EMIT_REL} 的 ${pathsKeys.length} 条 paths 键双向对上（${[...names].sort().join(" · ")}）`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IO 侧：语料发现（scanPackages）+ JSONC 解析（parseJsonc）
// ─────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * 取 typescript：先试被测树，再退回本仓。
 *
 * 口径同 `verify-tsconfig-coverage.ts` 的 `loadTsFor`：typescript 是**解析工具**不是语料
 * （语料在被测树里说了算，工具可以来自运行方）。spec 在 `os.tmpdir()` 造临时树时
 * 那里没有 node_modules，不退回会让整格 unjudged、IO 断言全废。
 */
export function loadTsFor(root: string) {
  return loadTypescript(root) ?? loadTypescript(REPO)
}

/**
 * 语料读取（main 用；spec 也可直接喂临时树 —— 走的是**同一套**发现/解析逻辑）。
 *
 * 分层返回：emit.json 缺席 / 取不到 typescript ⇒ unjudged；JSONC 坏 / paths 不是对象
 * ⇒ 红（语料坏按红，先例 verify-tsconfig-coverage 的「坏 JSONC ⇒ failed」）；其余进 judgePaths。
 */
export function readPaths(root: string = REPO): GateResult {
  const emitAbs = path.join(root, EMIT_REL)
  if (!fs.existsSync(emitAbs)) {
    return unjudged(GATE, "no-corpus", `${EMIT_REL} 不存在 ⇒ paths 无从对账，判不了（不当绿）`)
  }
  const ts = loadTsFor(root)
  if (!ts) {
    return unjudged(
      GATE,
      "no-binary",
      `找不到 typescript（候选见 lint-rule-fingerprint.ts 的 TS_CANDIDATES）⇒ 没有可信的 JSONC 解析器，不降级成正则凑`,
    )
  }
  const parsed = parseJsonc(ts, fs.readFileSync(emitAbs, "utf8"))
  if (parsed.error !== undefined) {
    return {
      gate: GATE,
      status: "failed",
      findings: [{ file: EMIT_REL, detail: `不是合法 JSONC（${parsed.error}）—— paths 读不出来，按红处理（不静默跳过）` }],
    }
  }
  const pathsObj = (parsed.config?.compilerOptions as Record<string, unknown> | undefined)?.paths
  if (pathsObj !== undefined && !isRecord(pathsObj)) {
    return {
      gate: GATE,
      status: "failed",
      findings: [
        {
          file: EMIT_REL,
          detail: `compilerOptions.paths 不是对象（实际是 ${Array.isArray(pathsObj) ? "数组" : typeof pathsObj}）—— 配置写坏，按红处理。修法：改回 { "包名": ["./目标.ts"] } 形态`,
        },
      ],
    }
  }
  const pathsKeys = isRecord(pathsObj) ? Object.keys(pathsObj) : []

  const packages: PkgEntry[] = scanPackages(root)
    .filter((p) => !p.isGroup) // 组目录不是包：它禁 manifest 由 verify-plugin-shape 管，不在这里重复实现
    .map((p) => ({ dir: p.dir, name: typeof p.manifest?.name === "string" ? p.manifest.name : null }))

  return judgePaths({ packages, pathsKeys })
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-tsconfig-coverage.ts 的注释）。
  runGate({ name: GATE, main: () => readPaths() })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
