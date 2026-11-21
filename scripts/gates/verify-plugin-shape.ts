/**
 * 新树包外形判据（ISS-837 / W0-GATE-G1）—— 移植自官方 `scripts/check-workspace-constraints.ts`。
 *
 * ## 判什么
 *
 * 官方用 9 条 manifest 不变式保证「每个 `packages/<group>/<pkg>` 的外形一模一样」
 * （`~/dsh-src/scripts/check-workspace-constraints.ts:577-612`）。本判据逐条搬过来，
 * **只扫 `packages/<group>/<pkg>`**（旧 `forge-*` 平铺包不在射程内 —— 它们的形态本来就与官方不同）。
 *
 *   | # | 判据 | 精确值 |
 *   |---|---|---|
 *   | 1 | `peerDependencies['@deepseek-ai/cordis']` 存在 | — |
 *   | 2 | `devDependencies['@deepseek-ai/cordis']` 也存在 | — |
 *   | 3 | peer 与 dev 的 range 必须相同 | — |
 *   | 4 | `type` | `"module"` |
 *   | 5 | `main` | `lib/index.js` |
 *   | 6 | `types` | `lib/types/index.d.ts` |
 *   | 7 | `exports["."].types` | `./lib/types/index.d.ts` |
 *   | 8 | `exports["."].default` | `./lib/index.js` |
 *   | 9 | `files` 含 `lib/index.js` / `lib/types/**\/*.d.ts` / `src` | — |
 *
 * ## ⚠️ 第 9 条是**简化版**（诚实交代，不把简化说成等价）
 *
 * 官方 `expectedDshPackageFiles()`（`:312-385`，73 行）从 manifest **自身推导** `files` 该是什么：
 * 从 `icon` / `exports['./*icon']` / `locale/*.json` / `dsh.bundle` / `bin` / `./client` /
 * `./worker` / `./store` / `./startup` / `./loader` / `./typert*` 逐条推导，再用 `sameStringList`
 * **顺序敏感**地全等比对 —— 差一个元素或顺序不同都红。
 *
 * 本版只判**三个必需元素在不在**（`REQUIRED_FILES`），不判推导、不判顺序、不判多余元素。
 * 理由：新树现在一个包都还没有，推导逻辑没有真实 manifest 可对照，照抄 73 行等于搬一堆
 * 永远走不到的分支（而走不到的分支编不出正例，编不出正例的分支等于没判）。
 * **完整推导待有真实包后补，实现见官方 `:312-385`。**
 *
 * ## scope 前缀：**已拍**（老板 2026-11-16 · DOC-513 §3 D2 甲档）
 *
 * 两件事**分开**，这是本条最容易读错的地方：
 *
 *   · **我们自己包的包名前缀** = `@matter/`（`SCOPE_PREFIX`）。全仓唯一一处，别处不许硬编码。
 *   · **框架依赖 cordis 的包名** = `@deepseek-ai/cordis`（`cordisPackage()`）。它是 DSH 基座的
 *     真名，**不从 scope 派生** —— 详见 `cordisPackage()` 的函数注释。
 *
 * ⚠️ 历史：原实现是 `cordisPackage(scope) = ${scope}cordis`，在 scope 未拍时看着自洽，
 * 拍板后立刻变成与事实互斥的两难（照判据写 `@matter/cordis` ⇒ `pnpm install` 找不到该包；
 * 写真名 ⇒ 本判据报 2 条红）。这条 bug 是**拍板才暴露的**，不是实现写错。
 *
 * ⇒ 判据里所有需要 cordis 名的地方调 `cordisPackage()`；`SCOPE_PREFIX` 只用于「是不是自家包」
 * 这类问题，**不再参与框架依赖名的计算**。
 *
 * ## 与官方的两处有意分歧
 *
 * 1. **语料口径**：官方要求 `manifest.name` 以 `@deepseek-ai/dsh-` 开头才进这 9 条判据
 *    （`:578`）。我们 `packages/` 下全是自家包，不按名字过滤 —— 按名字过滤会让一个
 *    改了名的包**静默退出射程**，那正是本判据要防的事。
 * 2. **组目录带 package.json**：取自官方 `checkHierarchyShape`（`:619-641`）的一条。
 *    不取全量（那条还判「不许更深嵌套」），只取「组目录不许有 package.json」——
 *    因为它会让 `packages/<group>/package.json` 变成一个**永远不被扫到**的包，
 *    与本判据自己的「防扫空」是同一件事。
 *
 * ## 退出码
 *   0 = 绿 · 1 = 红 · 2 = 判不了（`packages/` 下 0 个包 / 目录不存在 ⇒ **不算绿**）
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-plugin-shape"

/** 新树包 scope 前缀（老板 2026-11-16 拍板 · DOC-513 §3 D2 甲档）。全仓唯一一处，别处不许硬编码。 */
export const SCOPE_PREFIX = "@matter/"

/**
 * 框架依赖包名：**cordis 是 DSH 基座，用它的真名**。
 *
 * 为什么不从 scope 派生（原实现 `${scope}cordis`）：`@matter/cordis` 不存在，也不会存在
 * —— 我们用的是 DSH 的 cordis，不 fork 一份。vendor 第二份 cordis 会产生两个实例 =
 * 两套 `Context` 类型族，`declare module` 的合并会分裂。
 *
 * scope 管的是「我们自己包的包名前缀」，框架依赖的真名是**另一件事**。
 * 老板 2026-11-16 拍板（DOC-513 §3 D2 甲档）。
 *
 * ⛔ **不带参数**：带参（哪怕是可选参）会让人以为它还能从某个 scope 派生出来，
 * 而事实上没有任何 scope 能派生出 `@deepseek-ai/cordis`。原签名 `(scope = SCOPE_PREFIX)`
 * 的实参已在同批改动里从 `judgeManifest` 去掉。
 */
export function cordisPackage(): string {
  return "@deepseek-ai/cordis"
}

/** 官方 `:577-612` 里的逐字常量。 */
export const EXPECTED = {
  type: "module",
  main: "lib/index.js",
  types: "lib/types/index.d.ts",
  exportsTypes: "./lib/types/index.d.ts",
  exportsDefault: "./lib/index.js",
} as const

/**
 * 第 9 条**简化版**的三个必需元素。
 * 完整清单由官方 `expectedDshPackageFiles()`（`:312-385`）从 manifest 推导，顺序敏感。
 */
export const REQUIRED_FILES = ["lib/index.js", "lib/types/**/*.d.ts", "src"] as const

/** 一个待判的包。spec 直接构造这种数据喂给 `judgePluginShape`（纯函数，不碰 IO）。 */
export interface PackageInput {
  /** 相对仓库根，形如 `packages/core/agent` */
  dir: string
  /** true = 这是组目录（`packages/<group>`）本身，它不该有 package.json */
  isGroup?: boolean
  /** 解析后的 manifest；`null` = 读不到 / JSON 解析失败 */
  manifest: Record<string, unknown> | null
}

/** 一条问题：`file` 填到 manifest 路径，`detail` 只说「哪条判据、期望什么、实际什么」。 */
export interface ManifestFinding {
  file: string
  detail: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** 官方 `exportFields`：取条件导出的字段表；字符串 / 数组目标没有具名条件 ⇒ undefined。 */
function exportFields(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined
}

/**
 * 单包判据（纯函数）—— 返回问题清单，空数组 = 该包合规。
 * 顺序固定为 1→9，便于 diff 与「哪条又坏了」的定位。
 *
 * ⛔ **不接受 scope 参数**：本判据里唯一与包名有关的是 cordis 的**真名**，而它不从 scope 派生
 * （见 `cordisPackage()`）。留一个不影响任何判定的 `scope` 实参，会让下一个读者以为
 * 「换个 scope 判据就换口径」—— 那是假的。
 */
export function judgeManifest(dir: string, manifest: Record<string, unknown> | null): ManifestFinding[] {
  const file = `${dir}/package.json`
  if (manifest === null) return [{ file, detail: "读不到或不是合法 JSON —— 判不了这个包，按红处理" }]
  const out: ManifestFinding[] = []
  const push = (detail: string) => out.push({ file, detail })
  const cordis = cordisPackage()

  const peer = isRecord(manifest.peerDependencies) ? manifest.peerDependencies : undefined
  const dev = isRecord(manifest.devDependencies) ? manifest.devDependencies : undefined
  const peerRange = peer?.[cordis]
  const devRange = dev?.[cordis]
  // ① ② ③：peer / dev 双写且 range 相同（官方 :577-585）
  if (typeof peerRange !== "string" || !peerRange) push(`${cordis} 必须是 peerDependency`)
  if (typeof devRange !== "string" || !devRange) push(`${cordis} 也必须同时是 devDependency`)
  if (typeof peerRange === "string" && peerRange && typeof devRange === "string" && devRange && peerRange !== devRange) {
    push(`${cordis} 的 peer (${peerRange}) 与 dev (${devRange}) range 必须相同`)
  }

  // ④ ⑤ ⑥：三个顶层路径字段（官方 :586-591）
  if (manifest.type !== EXPECTED.type) push(`type 必须是 "${EXPECTED.type}"（实际 ${JSON.stringify(manifest.type)}）`)
  if (manifest.main !== EXPECTED.main) push(`main 必须是 "${EXPECTED.main}"（实际 ${JSON.stringify(manifest.main)}）`)
  if (manifest.types !== EXPECTED.types) push(`types 必须是 "${EXPECTED.types}"（实际 ${JSON.stringify(manifest.types)}）`)

  // ⑦ ⑧：根导出两半（官方 :592-598）
  const exportsMap = isRecord(manifest.exports) ? manifest.exports : undefined
  const rootEntry = exportFields(exportsMap?.["."])
  if (rootEntry?.types !== EXPECTED.exportsTypes) {
    push(`exports["."].types 必须是 "${EXPECTED.exportsTypes}"（实际 ${JSON.stringify(rootEntry?.types)}）`)
  }
  if (rootEntry?.default !== EXPECTED.exportsDefault) {
    push(`exports["."].default 必须是 "${EXPECTED.exportsDefault}"（实际 ${JSON.stringify(rootEntry?.default)}）`)
  }

  // ⑨：files —— **简化版**，只判三个必需元素在不在（见文件头「第 9 条是简化版」）
  const files = manifest.files
  if (!Array.isArray(files)) {
    push(`files 必须是数组（实际 ${JSON.stringify(files)}）`)
  } else {
    for (const need of REQUIRED_FILES) {
      if (!files.includes(need)) push(`files 必须含 "${need}"（简化版只判这三项，完整推导见官方 :312-385）`)
    }
  }
  return out
}

/**
 * 纯函数判定：spec 直接喂构造数据。
 *
 * `packages/` 下 0 个包 ⇒ **unjudged**，不是绿。
 * 对照官方 `verify-no-unknown-casts.ts:91-96`：那里对 `packages/`/`apps/`/`scripts/`/`website/`
 * 逐个断言「发现到的源文件里必须出现过这个区」，缺一个就 throw —— 同一意图（扫空不许算过），
 * 我们的载体把 throw 换成 `unjudged + no-corpus`（`gate-runtime.ts` 的口径：缺输入退 2，不许退 0）。
 *
 * ⛔ 同 `judgeManifest`：不接受 scope 参数 —— 判据口径里没有「按 scope 变」的东西。
 */
export function judgePluginShape(pkgs: readonly PackageInput[]): GateResult {
  if (pkgs.length === 0) {
    return unjudged(GATE, "no-corpus", `packages/<group>/<pkg>/package.json 一个都没扫到（0 个包）—— 判不了，不当绿`)
  }
  const findings: ManifestFinding[] = []
  for (const p of pkgs) {
    if (p.isGroup) {
      // 组目录本身就是包 ⇒ 它会**绕过** `packages/<group>/<pkg>` 扫描面（一个永远不判的包），
      // 与「防扫空」是同一件事。出处：官方 checkHierarchyShape（:619-641）的第一条。
      findings.push({ file: `${p.dir}/package.json`, detail: "组目录不许有 package.json —— 包必须住在 packages/<group>/<pkg>（否则这个包永远不被扫到）" })
      continue
    }
    findings.push(...judgeManifest(p.dir, p.manifest))
  }
  if (findings.length) return { gate: GATE, status: "failed", findings }
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    // 拍板后不再写「待拍」：这句话是给后来者读的现状，不是历史注记（历史在文件头）。
    detail: `${pkgs.length} 个包 × 9 条不变式全过（第 9 条为简化版）；包名前缀 = ${SCOPE_PREFIX}，框架依赖 = ${cordisPackage()}`,
  }
}

/** 扫 `packages/<group>/<pkg>`。返回空数组 = 一个包都没有（由 judge 判 unjudged）。 */
export function scanPackages(root: string = REPO): PackageInput[] {
  const base = path.join(root, "packages")
  if (!fs.existsSync(base)) return []
  const out: PackageInput[] = []
  const entries = (dir: string) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name)

  for (const group of entries(base)) {
    const groupDir = path.join(base, group)
    const groupManifest = path.join(groupDir, "package.json")
    if (fs.existsSync(groupManifest)) {
      out.push({ dir: `packages/${group}`, isGroup: true, manifest: null })
      continue
    }
    for (const pkg of entries(groupDir)) {
      const manifestPath = path.join(groupDir, pkg, "package.json")
      if (!fs.existsSync(manifestPath)) continue
      out.push({ dir: `packages/${group}/${pkg}`, manifest: readManifest(manifestPath) })
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

function readManifest(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-gate-registry.ts 的注释）。
  runGate({ name: GATE, main: () => judgePluginShape(scanPackages()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
