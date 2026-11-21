/**
 * 新树包 README 闸（ISS-850 / W0-P0-4）—— 只判三条 + 一条存在性，**不搬 DSH 的 658 行**。
 *
 * ## 为什么是「三条」而不是照搬 DSH
 *
 * `~/dsh-src` 的 README 校验分三份脚本、合计约 658 行（`verify-package-readme-summaries.ts` 100 行 /
 * `verify-package-readme-limitations.ts` 143 行 / `verify-package-readme-model-experience.ts` 415 行）。
 * 其中 Model Experience 那 415 行判的是「工具包 README 的模型可见段落结构」——
 * **新树 P0 有 0 个真实工具包**，照搬等于一排永远走不到的分支（判据自己成了 `designed` 的死码）。
 *
 * ⇒ 本判据只留**新树今天就能判、且坏了真有害**的三条（+ 一条存在性）：
 *
 * | # | 判据 | 口径 |
 * |---|---|---|
 * | 1 | `## Summary` 存在且 ≤ 100 词 | 照 DSH `countWords`：`split(/\s+/u).filter(Boolean).length`（≈ `wc -w`） |
 * | 2 | `## Known Limitations and Deferred Work` 是**最后一个 H2**，且段内 ≥1 条 `- ` 顶层条目 | 标题逐字 |
 * | 3 | `README.md` / `README.zh.md` / `README.i18n.yaml` 三件套齐全 | 缺一件就红 |
 * | 3b | 有 `package.json` 就必须有 `README.md` | **缺失是红，不是跳过** |
 *
 * 第 2 条的「最后一个 H2」不是排版洁癖：这段是**读者决定要不要用这个包**的地方
 * （「它现在不能干什么」）。放在文档中间会被后文淹没，而写在最后是读者离开前的最后一道信息。
 *
 * ## ⚠️ 与 DSH 的两处有意偏离（都写在这里，免得下一个人以为是抄错）
 *
 * 1. **段尾判定按「任意级标题」，不是只按 `^## `**。DSH 的 `h2Body()` 用
 *    `(?=^## )` 收尾，于是 Summary 里若有 `### Details` 子节，子节的字数会被算进 Summary。
 *    我按「下一个任意级标题」收尾 —— 「段内」对两条判据（字数 / 条目）是同一个概念，
 *    两处用不同边界会让同一个文档在两条判据眼里有不同结构。
 * 2. **标题扫描是 fence-aware**。DSH 用正则直接扫全文，代码块里的 `## comment`（shell/Python 注释）
 *    会被当成真标题 —— 后果是**假红**：Limitations 段后面跟一个含 `## ` 的代码块，
 *    该段就「不是最后一个 H2」了。假红比没门禁更赶人，所以这里跳围栏。
 *
 * ## 判不了（退出码 2）
 *
 *   · `packages/<g>/<p>/package.json` 一个都没扫到（0 个包 ⇒ 没有「有 manifest 的包」可判）
 *
 * ⚠️ 与 `verify-tsconfig-coverage` 的关键区别：本判据的语料是 **manifest**（「有 package.json 就必须有 README」），
 * 不是 tsconfig。所以它复用 `next-manifest` 探针（问的正是「有没有 package.json」），不新造。
 *
 * ## 退出码（口径见 `scripts/lib/gate-runtime.ts`）
 *   0 = 绿 · 1 = 红 · 2 = 判不了
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-package-readme"

/** Summary 词数上限。与 DSH `MAX_PACKAGE_README_SUMMARY_WORDS` 同值（不是巧合：那是 `wc -w` 的实测经验值）。 */
export const MAX_SUMMARY_WORDS = 100
/** 规范段标题，**逐字**（多一个空格都算变体，因为它是读者与生成器共同依赖的锚）。 */
export const LIMITATIONS_HEADING = "Known Limitations and Deferred Work"
export const SUMMARY_HEADING = "Summary"
/** 三件套。缺任一件即红。 */
export const README_TRIO = ["README.md", "README.zh.md", "README.i18n.yaml"] as const

/** `wc -w` 等价口径（逐字照 DSH `countWords`）。 */
export function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length
}

export interface Heading {
  /** 1~6 */
  level: number
  /** 标题正文（去掉 `#` 与前后空白），不做其它归一 */
  title: string
  /** 1-based 行号（报错定位用） */
  line: number
  /** 本节正文（到下一个任意级标题或文末；已 trim） */
  body: string
}

const ATX = /^(#{1,6})[ \t]+(.*)$/
const FENCE = /^\s*(```|~~~)/

/**
 * 把 markdown 拆成标题节（fence-aware）。
 *
 * 围栏代码块里的 `## xxx` **不算标题** —— 见文件头「与 DSH 的两处有意偏离」第 2 条。
 * 围栏只认行首（允许缩进），与 `verify-spec.ts:95` 同一正则口径。
 */
export function scanHeadings(source: string): Heading[] {
  const lines = source.split("\n").map((l) => l.replace(/\r$/, ""))
  const heads: { level: number; title: string; line: number }[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (FENCE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = ATX.exec(raw)
    if (!m) continue
    heads.push({ level: m[1].length, title: m[2].trim(), line: i + 1 })
  }
  return heads.map((h, idx) => {
    const next = heads[idx + 1]
    const endLine = next ? next.line - 1 : lines.length
    // ⚠️ 只剥**首尾空行**，不用 `.trim()` —— 见下面 body 那行注释。
    const chunk = lines.slice(h.line, endLine)
    while (chunk.length > 0 && chunk[0].trim() === "") chunk.shift()
    while (chunk.length > 0 && chunk[chunk.length - 1].trim() === "") chunk.pop()
    // ⚠️ **不许 `.trim()`**（spec 实测抓到的真缺陷）：段内第一条若是缩进 bullet（`  - x`），
    //   `trim()` 会把行首缩进吃掉，让它变成 `- x` ⇒ 被当成**顶层**条目 ⇒ 「只有子项」判成「有条目」。
    //   保留缩进，`/^- /` 才真的在问「是不是顶层」。
    const body = chunk.join("\n")
    return { ...h, body }
  })
}

/** 找某个**逐字**标题的 H2（`undefined` = 没有）。 */
export function findH2(heads: Heading[], title: string): Heading | undefined {
  return heads.find((h) => h.level === 2 && h.title === title)
}

/** 某标题出现的 H2 次数（判「同名段重复」用）。 */
export function countH2(heads: Heading[], title: string): number {
  return heads.filter((h) => h.level === 2 && h.title === title).length
}

/**
 * 单个 README 的三条判据（不含三件套 —— 那是目录级的事，见 `judgeReadmes`）。
 * @param file - 报错用的仓库相对路径
 * @param source - README 全文
 * @returns 违规说明（空数组 = 全过）；每条都含「期望 + 实际 + 怎么改」
 */
export function judgeOneReadme(file: string, source: string): Finding[] {
  const out: Finding[] = []
  const heads = scanHeadings(source)

  // ── ① Summary 存在且 ≤ 100 词 ─────────────────────────────────────────
  const summary = findH2(heads, SUMMARY_HEADING)
  if (!summary) {
    out.push({ file, detail: `缺 \`## ${SUMMARY_HEADING}\` 段 —— 补一段不超过 ${MAX_SUMMARY_WORDS} 词的摘要（读者只读这一段决定要不要用这个包）` })
  } else {
    const words = countWords(summary.body)
    if (words > MAX_SUMMARY_WORDS) {
      out.push({
        file,
        line: summary.line,
        detail:
          `Summary has ${words} words; the limit is ${MAX_SUMMARY_WORDS}. ` +
          `删到 ${MAX_SUMMARY_WORDS} 词以内，或把细节移到正文的 \`## Details\` 段（不要为了过而删信息）`,
      })
    }
  }

  // ── ② Limitations 是最后一个 H2，且段内 ≥1 条 `- ` 顶层条目 ──────────────
  const h2s = heads.filter((h) => h.level === 2)
  const occurrence = countH2(heads, LIMITATIONS_HEADING) // 含扫到的全部同名段
  const limitations = findH2(heads, LIMITATIONS_HEADING)
  const lastH2 = h2s.at(-1)

  if (!limitations) {
    out.push({
      file,
      detail:
        `缺 \`## ${LIMITATIONS_HEADING}\` 段 —— 补一段逐条列出「现在不能干什么 / 推迟了什么」；` +
        `真的没有可写的，也要写一条（空段与「忘了写」在屏幕上长得一样，判据只认有声明的）`,
    })
  } else {
    if (lastH2 !== limitations) {
      out.push({
        file,
        line: limitations.line,
        detail:
          `\`## ${LIMITATIONS_HEADING}\` 不是最后一个 H2（后面还有 \`## ${lastH2?.title ?? "?"}\` @行 ${lastH2?.line ?? "?"}）—— ` +
          `把这一段移到文档末尾：它是读者离开前的最后一道信息，放中间会被后文淹没`,
      })
    }
    if (occurrence > 1) {
      out.push({
        file,
        line: limitations.line,
        detail: `\`## ${LIMITATIONS_HEADING}\` 出现了 ${occurrence} 次 —— 只留一个（两条同名段落时，读者不知道哪条作准）`,
      })
    }
    if (!limitations.body.split("\n").some((l) => /^- /.test(l))) {
      out.push({
        file,
        line: limitations.line,
        detail: `\`## ${LIMITATIONS_HEADING}\` 段内没有顶层 \`- \` 条目 —— 每一条限制写成一行 \`- \` 开头（表格或段落读起来不像清单，也无法被逐条引用）`,
      })
    }
  }
  return out
}

export interface ReadmePackage {
  /** 仓库相对目录，如 `packages/storage/storage` */
  dir: string
  /** 该目录下实际存在的文件名（只用于查三件套，不要求包含其它文件） */
  presentFiles: string[]
  /** README.md 正文；`null` = 文件不存在；`undefined` = 存在但读不到（按红处理） */
  readme: string | null | undefined
}

/**
 * 目录级判定（纯函数，spec 直接喂构造数据）。
 *
 * 语料归零 ⇒ `unjudged`，**不许绿**：0 个有 manifest 的包时「每个包都有 README」空洞成立，
 * 而那条空洞的成立正是「删掉包就永久变绿」的形态（K8 禁止）。
 */
export function judgeReadmes(packages: ReadmePackage[]): GateResult {
  if (packages.length === 0) {
    return unjudged(
      GATE,
      "no-corpus",
      "packages/<group>/<pkg>/package.json 一个都没扫到（0 个有 manifest 的包）—— 判不了，不当绿",
    )
  }

  const findings: Finding[] = []
  for (const p of packages) {
    // ── ③ 三件套齐全 ────────────────────────────────────────────────────
    const present = new Set(p.presentFiles)
    const missing = README_TRIO.filter((f) => !present.has(f))
    for (const f of missing) {
      // 3b：README.md 缺失单独一条更强的措辞（「有 manifest 就必须有 README」，不是「三件套之一缺了」）
      const detail =
        f === "README.md"
          ? `有 package.json 却没有 README.md —— 包必须有 README（**缺失是红，不是跳过**），补 \`${p.dir}/README.md\``
          : `三件套缺 \`${f}\` —— 补 \`${p.dir}/${f}\`（README.md / README.zh.md / README.i18n.yaml 三件缺一即红）`
      findings.push({ file: `${p.dir}/${f}`, detail })
    }

    // ── ①② 只在 README.md 存在时判（不存在已由上面那两条报过，不重复报）──
    if (!present.has("README.md")) continue
    if (p.readme === undefined) {
      findings.push({ file: `${p.dir}/README.md`, detail: "读到但解析失败（读不出正文）—— 按红处理：跳过等于静默少判一个包" })
      continue
    }
    if (p.readme === null) {
      findings.push({ file: `${p.dir}/README.md`, detail: "文件在但读不到正文 —— 按红处理（同「读不出」）" })
      continue
    }
    findings.push(...judgeOneReadme(`${p.dir}/README.md`, p.readme))
  }

  if (findings.length) return { gate: GATE, status: "failed", findings }
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${packages.length} 个包的 README 三件套齐全，Summary ≤ ${MAX_SUMMARY_WORDS} 词，\`## ${LIMITATIONS_HEADING}\` 都在末位且有条目`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IO 侧
// ─────────────────────────────────────────────────────────────────────────────

/** `packages/<group>/<pkg>/` 两段目录名。跳过点目录 / node_modules。 */
function twoLevelPkgDirs(root: string): string[] {
  const base = path.join(root, "packages")
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
      out.push(`packages/${g.name}/${p.name}`)
    }
  }
  return out.sort()
}

/** 语料读取：只收**有 package.json** 的包（3b 的语料定义）。 */
export function readReadmes(root: string = REPO): ReadmePackage[] {
  const out: ReadmePackage[] = []
  for (const dir of twoLevelPkgDirs(root)) {
    const abs = path.join(root, dir)
    if (!fs.existsSync(path.join(abs, "package.json"))) continue // 没 manifest 的目录不是「包」，不在 3b 射程
    let presentFiles: string[] = []
    try {
      presentFiles = fs.readdirSync(abs)
    } catch {
      presentFiles = []
    }
    let readme: string | null | undefined
    if (!presentFiles.includes("README.md")) readme = null
    else {
      try {
        readme = fs.readFileSync(path.join(abs, "README.md"), "utf8")
      } catch {
        readme = undefined // 读了但失败 ⇒ 按红处理（不冒充「没有这个文件」）
      }
    }
    out.push({ dir, presentFiles, readme })
  }
  return out
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-workspace-constraints.ts 的注释）。
  runGate({ name: GATE, main: () => judgeReadmes(readReadmes()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
