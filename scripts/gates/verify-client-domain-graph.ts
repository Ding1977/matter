/**
 * 新树 client 包**内部分层**判据（ISS-839 / W0-GATE-G3）—— 移植自官方
 * `scripts/verify-client-domain-graph.ts`（`~/dsh-src` 同路径）。
 *
 * ## 判什么
 *
 * 官方用「三层模型 + 两条规则」管住一个 client 包内部不许糊成一坨。三层逐字照抄官方 `:8-12`：
 *
 *   | 层 | 目录 / 文件 | 是什么 |
 *   |---|---|---|
 *   | 0 | `contract/` | 共享契约 API（类型 + slot 声明） |
 *   | 1 | `<domain>/` | 各域实现（`skeleton/`、`chat/`、…） |
 *   | 2 | `apply.ts` / `index.ts` / `index.tsx` | 装配点与再导出外壳 |
 *
 * 两条规则（官方 `:69-76`）：
 *   ① 顶层**非装配**文件不许 import 任何域 —— 只有 `apply`/`index` 可以跨域装配；
 *   ② 域与域之间不许互相 import —— 要共享就走 `contract/`。
 *
 * 违规原因文本**逐字照抄官方 `:72-76`**，不重写措辞：
 *   `top-level non-assembly file imports domain "${D}" (only apply/index may assemble)`
 *   `domain "${A}" imports sibling domain "${B}" (route shared API through contract/)`
 * 照抄的理由不是崇拜：这两句是官方 issue 里被引用过上千次的既定措辞，改一个字，
 * 将来两侧对账时就要靠人眼判断「是不是同一件事」。
 *
 * ## ⚠️ 扫描根只到 `src/client/`，因此 `tests/` **天然不在射程**
 *
 * 官方 `:85` 先 `statSync(join(CLIENT_DIR, pkg, 'src/client'))`，目录不在就 `continue`
 * （注释自称 *"No client half in this package — nothing to layer-check."*）。
 * 全文件 `grep -n "tests\|\.spec"` **零命中** —— 它没写排除逻辑，
 * 因为扫描根本来就避开了测试目录。**本判据照此办理，且不额外加任何测试豁免口**：
 * 测试从别包取值构造被测对象是正当用法，不该进豁免名单；反过来，
 * 写在 `src/client/` **里面**的 `*.spec.ts` 仍会被扫（它是包源码，不是测试树）。
 *
 * ## 与官方的五处有意分歧（逐条带证据，不把分歧说成等价）
 *
 * **① 空语料 ⇒ `unjudged(no-corpus)`，不是绿。**
 *   官方 0 个 client 包时一路 `continue`，落到文件尾打印 `client domain layering clean.`（exit 0）——
 *   即「扫到 0 个包」与「扫到 N 个包全合规」在屏幕上完全一样。这正是本仓
 *   `scripts/lib/gate-runtime.ts` 头注点名禁止的「用 0 表示跳过」。
 *   本判据按载体口径退 2。新树 W1 之前没有 `src/client/`，就该是这个状态。
 *
 * **② 三种 import 形态都算边**（官方只认 `from '…'`）。
 *   官方正则 `from\s+['"](\.[^'"]+)['"]`（`:62`）抓不到 `await import('./x.ts')` 与
 *   副作用 `import './x.ts'` —— 跨域写这两种形态就是**静默漏报**（假绿）。
 *   本判据加抓这两形。**假阳性风险已实测为 0**：在官方 tree（`~/dsh-src`）上
 *   按三形态各跑一遍，`from` 抓 85 条违规，动态 import 与副作用 import 各 0 条新增。
 *   ⚠️ 那是**快照**，不是恒等式；复检（glob 里的星号在此处写成 `<pkg>`，避免注释被提前闭合）：
 *   `cd ~/dsh-src && grep -rn "import" packages/client/<pkg>/src/client --include=*.ts -E "\bimport\s*\(\s*['\"]\.['\"]|^[[:space:]]*import\s+['\"]\."`
 *
 * **③ 先剥注释再匹配**（官方不剥）。
 *   官方把注释掉的 `// import { X } from '../other/y.ts'` 当成真边 —— 重构期临时注释掉一行就假红。
 *   本判据与 `scripts/lib/declared-reads.mjs` 的 `stripComments`、`scripts/gates/verify-gate-coverage.ts`
 *   同口径（行首 `//` 整行 + 块注释）。⚠️ 已知代价：模板字符串里**顶格**的 `//` 会被当成注释，
 *   与上述两处同一缺陷面（不是本单引入的）。
 *
 * **④ 不搬官方的 `.legacy.` 文件名豁免。**
 *   官方 `:34` 把 basename 含 `.legacy.` 的文件整个剔出射程（`.filter(rel => !/\.legacy\./.test(...))`）——
 *   一个文件名就能让该文件**永久退出判据**。新树没有历史遗留（W1 才写第一个包），
 *   开这个口等于预埋一条无人监督的免死金牌。需要豁免时按本仓口径走显式豁免登记
 *   （带 expires + ticket，`verify-exemption-register` 有牙），不是改文件名。
 *
 * **⑤ 不收紧「域 → 顶层非装配文件」。**
 *   官方 `:68` 对目标落在顶层（`toDomain === ''`）的引用直接放行，只判「域 ↔ 域」。
 *   所以 `<domain>/x.ts` 可以 import `../locale.ts`、`../stores.ts` —— 这**是官方自己的 idiom**，
 *   实测（快照，复检命令见 ②）官方 tree 上有 101 条走这条路。
 *   严格按三层模型说，这算「低层 import 高层」；但把它判红等于宣布官方自己 76 个 client 包结构违规，
 *   属于规范决策，超出本单。⇒ **按要求照抄官方口径**，把这条差异写在这里交给 Lead 裁决。
 *
 * ## 射程边界（故意不管的部分）
 *
 * `../../` 出 `src/client` 的引用**不判**（官方 `:66` 同）：那是包级依赖方向，归
 * `verify-module-graph` 那一类判据管。本判据只管包**内部**目录分层，不放宽也不越界。
 *
 * ## 退出码（`scripts/lib/gate-runtime.ts` 唯一口径）
 *   0 = 绿（扫到 ≥1 个 client 包，且 0 条违规）
 *   1 = 红（有违规）
 *   2 = 判不了（`packages/` 不存在 / 0 个 client 包 / 扫到的 `src/client/` 里 0 个源文件）
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-client-domain-graph"

/** 层 0：所有域都可 import 的共享契约层（官方 `CONTRACT_DIRS`，`:24`）。 */
export const CONTRACT_DIRS: ReadonlySet<string> = new Set(["contract"])

/** 层 2：唯一允许跨域装配的顶层文件（官方 `ASSEMBLY_FILES`，`:26`，含 `index.tsx`）。 */
export const ASSEMBLY_FILES: ReadonlySet<string> = new Set(["apply.ts", "index.ts", "index.tsx"])

/** 源文件后缀 —— 与官方 `globSync('**\/*.{ts,tsx}')`（`:32`）同集合。 */
const SOURCE_RE = /\.(?:ts|tsx)$/

/**
 * 三种「引用另一个文件」的语法形态（见文件头分歧 ②）。
 * 顺序即报出顺序：同一文件里三种形态各命中一次时，输出顺序固定，便于 diff。
 */
export const IMPORT_PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[] = [
  // 静态 import / 静态 re-export / `import type` / `export type ... from`
  { kind: "from", re: /\bfrom\s+['"](\.[^'"]+)['"]/g },
  // 动态 import：`await import('./x.ts')` 与类型位 `import('./x.ts').T`
  { kind: "dynamic", re: /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g },
  // 副作用 import：`import './register.ts'`（只在行首出现，避免与 from 形态重叠）
  { kind: "side-effect", re: /(?:^|\n)[ \t]*import\s+['"](\.[^'"]+)['"]/g },
]

/** 一个 `packages/<group>/<pkg>/src/client` 包（已读进内存，纯函数可直接喂）。 */
export interface ClientPackage {
  /** 仓库相对目录，形如 `packages/client/ui-chat` —— 报错时作为路径前缀 */
  dir: string
  /** 该包 `src/client/` 下的源文件（相对 `src/client/`，正斜杠分隔） */
  files: readonly ClientSource[]
}

export interface ClientSource {
  /** 相对 `src/client/` 的路径，形如 `chat/inner/step.ts` */
  rel: string
  /** 文件正文（已剥注释前/后的语义由 `judgeClientDomainGraph` 决定，这里存原文） */
  source: string
}

/** 一条违规：与官方 `Violation`（`:28`）同形。 */
export interface LayerViolation {
  file: string
  imported: string
  reason: string
}

/**
 * 剥注释（分歧 ③）。
 * ⚠️ 与 `scripts/lib/declared-reads.mjs` 的 `stripComments` 逐字同口径 —— 同仓不许两套「什么算注释」。
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
}

/** 文件相对 `src/client/` 的首段目录；顶层文件回 `''`（官方 `domainOf`，`:39-42`）。 */
export function domainOf(rel: string): string {
  const ix = rel.indexOf("/")
  return ix === -1 ? "" : rel.slice(0, ix)
}

/** 把一条相对 import 解析成 `src/client/` 相对路径（官方 `resolveClientImport`，`:50-52`）。 */
export function resolveClientImport(file: string, specifier: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
}

/** 官方 `:72-76` 的两句原因文本，逐字。 */
export function reasonFor(fromDomain: string, toDomain: string): string {
  return fromDomain === ""
    ? `top-level non-assembly file imports domain "${toDomain}" (only apply/index may assemble)`
    : `domain "${fromDomain}" imports sibling domain "${toDomain}" (route shared API through contract/)`
}

/** 单包判据：返回该包的全部违规（空数组 = 该包合规）。 */
export function checkPackage(pkg: ClientPackage): LayerViolation[] {
  const out: LayerViolation[] = []
  for (const { rel, source } of pkg.files) {
    const fromDomain = domainOf(rel)
    // 层 2：装配点豁免（官方 `:59-60`）。注意判定条件是**同时**满足「顶层」与「文件名在名单里」——
    // `chat/index.ts` 是域内的 index，不是装配点，照样受两条规则约束。
    if (fromDomain === "" && ASSEMBLY_FILES.has(rel)) continue
    const code = stripComments(source)
    for (const { re } of IMPORT_PATTERNS) {
      // 每次从同一份 code 上跑，正则带 g ⇒ 必须重置 lastIndex，否则第二条起从上次位置继续
      re.lastIndex = 0
      for (const match of code.matchAll(re)) {
        const spec = match[1]
        if (spec === undefined) continue
        const target = resolveClientImport(rel, spec)
        // 出 `src/client` 的引用不管（射程边界，见文件头）
        if (target === ".." || target.startsWith("../")) continue
        const toDomain = domainOf(target)
        // 目标落顶层（非 contract）⇒ 官方放行（分歧 ⑤）
        if (toDomain === "" || CONTRACT_DIRS.has(toDomain)) continue
        // 同域内部引用合法
        if (fromDomain === toDomain) continue
        out.push({ file: `${pkg.dir}/src/client/${rel}`, imported: spec, reason: reasonFor(fromDomain, toDomain) })
      }
    }
  }
  return out
}

/**
 * 纯函数判定：spec 直接喂构造数据（不碰 IO）。
 *
 * 空语料两种形态都退 2，**都不许算绿**：
 *   · 0 个 client 包（新树 W1 之前的真实状态）
 *   · 有 `src/client/` 目录但里面 0 个 `.ts/.tsx`（删空源码就永久变绿，是同一类病）
 */
export function judgeClientDomainGraph(pkgs: readonly ClientPackage[]): GateResult {
  if (pkgs.length === 0) {
    return unjudged(GATE, "no-corpus", "packages/<group>/<pkg>/src/client 一个都没扫到（0 个 client 包）—— 判不了，不当绿")
  }
  const totalFiles = pkgs.reduce((n, p) => n + p.files.length, 0)
  if (totalFiles === 0) {
    return unjudged(GATE, "no-corpus", `扫到 ${pkgs.length} 个 src/client 目录，但其中 0 个 .ts/.tsx 源文件 —— 判不了，不当绿`)
  }
  const violations: LayerViolation[] = []
  for (const pkg of pkgs) violations.push(...checkPackage(pkg))
  if (violations.length) {
    return {
      gate: GATE,
      status: "failed",
      findings: violations.map((v) => ({ file: v.file, detail: `-> ${v.imported}\n    ${v.reason}` })),
    }
  }
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${pkgs.length} 个 client 包 / ${totalFiles} 个源文件：域间 0 条跨域引用，装配点以外 0 条跨域装配`,
  }
}

/** 只用于扫描时跳过的目录名。`node_modules` 与点目录不是包源码。 */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules"])

function listSources(dir: string, prefix = ""): ClientSource[] {
  const out: ClientSource[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...listSources(path.join(dir, e.name), rel))
    else if (e.isFile() && SOURCE_RE.test(e.name)) {
      out.push({ rel, source: fs.readFileSync(path.join(dir, e.name), "utf8") })
    }
  }
  return out
}

/**
 * 扫 `packages/<group>/<pkg>/src/client/**`。
 *
 * 返回空数组 = 一个都没有（由 `judgeClientDomainGraph` 判 unjudged）。
 * ⚠️ **只下探两层**（group → pkg）：三层布局之外的包扫不到 ⇒ 它们会静默退出射程，
 * 所以 `verify-plugin-shape` 同样只认 `packages/<group>/<pkg>`，两处口径一致。
 * ⚠️ 没有 `statSync` 是否存在之外的容错：目录读不了就让它抛，由 `main` 落 exit 2
 * —— 「读不了」不许伪装成「扫过了、没问题」（同 `gate-runtime` 的口径）。
 */
export function scanClientPackages(root: string = REPO): ClientPackage[] {
  const base = path.join(root, "packages")
  if (!fs.existsSync(base)) return []
  const subdirs = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => e.name)
      .sort()

  const out: ClientPackage[] = []
  for (const group of subdirs(base)) {
    const groupDir = path.join(base, group)
    for (const pkg of subdirs(groupDir)) {
      const clientDir = path.join(groupDir, pkg, "src", "client")
      let isDir = false
      try {
        isDir = fs.statSync(clientDir).isDirectory()
      } catch {
        // 这个包没有 client 半 —— 没什么可分层检查的（官方 `:89` 同一句注释）
        continue
      }
      if (!isDir) continue
      out.push({ dir: `packages/${group}/${pkg}`, files: listSources(clientDir) })
    }
  }
  return out
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-plugin-shape.ts 的注释）。
  runGate({ name: GATE, main: () => judgeClientDomainGraph(scanClientPackages()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
