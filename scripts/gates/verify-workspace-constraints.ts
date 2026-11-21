/**
 * 新树包名不变式（ISS-849 / W0-P0-3）—— 只补 `verify-plugin-shape` 没管的三条。
 *
 * ## 为什么单独成一条判据，而不并进 plugin-shape
 *
 * 两条判据的**语料与寿命不同**：`verify-plugin-shape` 判的是「包的物理外形」（main/types/exports/
 * files，官方 9 条不变式），`packages/` 下每个包都要长得一模一样；本判据判的是「这个包在 workspace
 * 里的身份」（是否发布、version 跟不跟根、包间互引走不走协议），它跟着 workspace 结构走。
 * 合成一条会让「哪条坏了」更难读 —— 而这两类的修法完全不同（前者改路径字段，后者改依赖声明）。
 *
 * ## ⛔ 为什么只有 3 条（实证，不是省事）
 *
 * 老板 / Lead 的判断是「净增量 3 条，不是 6 条」。本次接手时**逐条复核过**，结论成立：
 *
 *   | 判据 | `verify-plugin-shape.ts` 里有吗（grep 实测） |
 *   |---|---|
 *   | `private: true` | `grep -c "private"` → **0** |
 *   | `version` 与根一致 | `grep -c "version"` → **0** |
 *   | 包间互引必须 `workspace:` | 只管 `@deepseek-ai/cordis` 那两条，不扫其它依赖 |
 *
 * 已被 plugin-shape 覆盖、**本文件不重复实现**的六条（重复实现 = 两份数据迟早对不上）：
 * cordis peer+dev 双写且 range 相同 · `type: "module"` · `main` / `types` / `exports["."]` 逐字 ·
 * `files` 含三项必需 · 组目录不许有 `package.json`。
 *
 * ## 三条判据的出处
 *
 * 官方 `scripts/check-workspace-constraints.ts`：
 *   · `:553-554` 「experimental package must set `"private": true`」
 *   · `:486-499` 「package.json version must match root version」
 *   · `:690-714` `checkWorkspaceProtocol()` —— 「手写 range 对 workspace 实际版本一无所知，
 *     `pnpm pack` 又原样保留它：`^0.0.1` 从 `0.0.2` 发布出去，指着两个不存在的版本。
 *     协议让 pack 换成成员的真实版本。」
 *
 * ## ⚠️ 与官方的两处有意分歧
 *
 * 1. **不判「哪些包可以 private:false」的白名单**。官方那套是按 release member / Landlock /
 *    public experimental 分档判（`:426-560`），新树 P0 一个发布包都没有 ⇒ 那几档现在编不出反例，
 *    编不出反例的分支等于没判。**新树一律 `private: true`**；将来要发布哪个包，先来改这里。
 * 2. **`workspace:` 的期望值只有一种**（`workspace:*`）。官方还给 vendor / native 用
 *    `workspace:~`（`:706-709`），我们新树没有 vendor 与 native 目录 ⇒ 不引入那个分叉。
 *
 * ## 判不了（退出码 2）的两种情形 —— **都不许退化成绿**
 *
 *   · `packages/` 下 0 个包（新树 W1 之前就是这个状态）
 *   · 根的 `version` 取不到 —— 那第 ② 条判据无法判，而退 0 等于**声称验过了**一条没验的判据
 *
 * ## 退出码
 *   0 = 绿 · 1 = 红 · 2 = 判不了（见上）
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"
import { scanPackages } from "./verify-plugin-shape.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-workspace-constraints"

/** 依赖段：包间互引可能出现在这四处（官方 `dependencySections`，`:651`）。 */
export const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const

/** 新树包不发布 ⇒ 唯一的合法值。 */
export const PRIVATE_REQUIRED = true

/** 包间互引的唯一合法协议前缀。 */
export const WORKSPACE_PROTOCOL = "workspace:"

export interface ConstraintsPackage {
  /** 相对仓库根，形如 `packages/storage/storage` */
  dir: string
  /** 解析后的 manifest；`null` = 读不到 / JSON 解析失败 */
  manifest: Record<string, unknown> | null
}

export interface ConstraintsInput {
  /** 仓库根的 version（通常是根的 package.json 的 version）。空串 = 取不到。 */
  rootVersion: string
  /** packages/<group>/<pkg> 下每个包的 manifest + 仓库相对目录 */
  packages: ConstraintsPackage[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** 一条问题：`file` 填到 manifest 路径，`detail` 只说「哪条判据、期望、实际、怎么改」。 */
export interface ConstraintFinding {
  file: string
  detail: string
}

/**
 * 纯函数判定（spec 直接喂构造数据，不碰 IO）。
 *
 * 逐包判三条，**互不影响**：一个包只坏第 ② 条时不许把第 ①③ 条也报出来
 * （那会让「只坏了 version」与「三条全坏」长得一样）。
 */
export function judgeConstraints(input: ConstraintsInput): GateResult {
  if (input.packages.length === 0) {
    return unjudged(
      GATE,
      "no-corpus",
      "packages/<group>/<pkg>/package.json 一个都没扫到（0 个包）—— 判不了，不当绿",
    )
  }
  if (!input.rootVersion) {
    // 退 0 会声称「version 一致性已验」—— 而它根本没法判。宁可不判。
    return unjudged(GATE, "no-corpus", "根 package.json 取不到 version ⇒ 第 ② 条判据（version 与根一致）无从判，不当绿")
  }

  // 成员名集合：workspace 内互引的判据依赖它。取不到 manifest 的包贡献不了名字，
  // 这是已知盲区（那种包本身已被下面的 null 分支判红，不会静默漏过去）。
  const members = new Set<string>()
  for (const p of input.packages) {
    const name = p.manifest?.name
    if (typeof name === "string" && name) members.add(name)
  }

  const findings: ConstraintFinding[] = []
  for (const p of input.packages) {
    const file = `${p.dir}/package.json`
    const m = p.manifest
    if (m === null) {
      findings.push({ file, detail: "读不到或不是合法 JSON —— 判不了这个包的三条不变式，按红处理" })
      continue
    }

    // ① private: true —— 新树包一律不发布（官方 :553-554）
    if (m.private !== PRIVATE_REQUIRED) {
      findings.push({
        file,
        detail: `private 必须是 true（实际 ${JSON.stringify(m.private)}）—— 新树包不发布，加 "private": true`,
      })
    }

    // ② version 与根一致（官方 :486-499）
    if (m.version !== input.rootVersion) {
      findings.push({
        file,
        detail: `version 必须与根一致（期望 "${input.rootVersion}"，实际 ${JSON.stringify(m.version)}）—— 改成根的 version，发布链按它取版本`,
      })
    }

    // ③ workspace 内互引必须走 workspace: 协议（官方 checkWorkspaceProtocol，:690-714）
    for (const section of DEP_SECTIONS) {
      const deps = isRecord(m[section]) ? m[section] : undefined
      if (!deps) continue
      for (const [name, range] of Object.entries(deps)) {
        if (!members.has(name)) continue // 外部依赖（含 @deepseek-ai/cordis）不归本判据管
        if (typeof range === "string" && range.startsWith(WORKSPACE_PROTOCOL)) continue
        findings.push({
          file,
          detail: `${section}["${name}"] 必须用 ${WORKSPACE_PROTOCOL} 协议（实际 ${JSON.stringify(range)}）—— 改成 "workspace:*"：手写 range 在 pnpm pack 后指向一个不存在的版本`,
        })
      }
    }
  }

  if (findings.length) return { gate: GATE, status: "failed", findings }
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${input.packages.length} 个包 × 3 条不变式全过（private / version="${input.rootVersion}" / ${WORKSPACE_PROTOCOL} 协议）`,
  }
}

/**
 * 语料读取：根 version + packages/<group>/<pkg> 各包 manifest。
 *
 * 包扫描复用 `scanPackages()`（`verify-plugin-shape.ts`）—— **「什么算一个包」只能有一处定义**，
 * 抄一份就会在两条判据之间漂移。组目录（`isGroup`）在这里丢弃：本判据的三条只对包本身有意义。
 */
export function readConstraints(root: string = REPO): ConstraintsInput {
  let rootVersion = ""
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    if (isRecord(v) && typeof v.version === "string") rootVersion = v.version
  } catch {
    rootVersion = ""
  }
  const packages = scanPackages(root)
    .filter((p) => !p.isGroup)
    .map((p) => ({ dir: p.dir, manifest: p.manifest }))
  return { rootVersion, packages }
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-plugin-shape.ts 的注释）。
  runGate({ name: GATE, main: () => judgeConstraints(readConstraints()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
