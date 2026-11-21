/**
 * 双轴映射表生成器 + 三判据（ISS-845 · W0-GATE-G9）—— 老板 2026-11-14 亲自拍的「乙档」。
 *
 * 骨架照抄 DSH `scripts/gen-module-graph.ts`（从 manifest 生成依赖图 + `--check` 判过期），
 * 加一列 `logical_layer`；再移植官方 `verify-package-dependencies.ts` 的**符号级扫描**核心。
 *
 * ## 为什么必须看 import（乙档 vs 甲档的唯一差别）
 *
 * 甲档只判「manifest 里声明的对不对」。我们真正的问题是「**用错了层**」—— 那必须看 import。
 * 官方闭环：
 *
 *   源码 import → 符号级扫描算真实使用
 *              → 对照分层表判该进 dependencies 还是 peerDependencies
 *              → 回写 package.json（⚠️ 本判据**不做**这一步，见「三处已知缺口」）
 *              → gen-layer-graph 从 manifest 生成图
 *              → --check 判图是否过期
 *
 * ⚠️ **官方 `package-graph.ts:52-57` 只读 `peerDependencies`**：
 *   `const deps = Object.keys(json.peerDependencies ?? {}).filter(...)`
 *   我们旧树内部 peer 边 = **0 条**（实测 13 dependencies + 31 devDependencies + 0 peer）
 *   ⇒ 直接照抄会画出一张空图。所以本判据必须同时**算出**该写 peer 还是 dep。
 *
 * ## 一条命令判三件事（`--check`）
 *
 *   ① **图是否过期**：生成物与现算内容字节比对（官方机制）。
 *   ② **是否有反向边**：`L1 → L3` 上行、`L4 → L2` 越层。
 *   ③ **声明与实际是否一致**：符号级扫描算真实 import，查表判该进 peer 还是 dep。
 *
 * ## ⭐ peer vs dep 的判定规则（本单核心交付物）
 *
 * ⚠️ 判据**不是**「两份实例会不会出问题」—— 那要人想、机器判不出。官方
 * `expectedPackageDependencies()`（`verify-package-dependencies.ts:777-825`）实际是
 * **按 (包, 导出符号) 查表**，且**默认拒绝**：
 *
 *   | 条件 | 结论 |
 *   |---|---|
 *   | `cordis`（含子路径） | **peer + dev**（无条件；官方 373/373） |
 *   | `(spec, 符号)` 命中 `peerRequiredHostExports` | **peer + dev** |
 *   | `(spec, 符号)` 命中 `safeHostDependencyExports` | **dependencies** |
 *   | 包名命中 `duplicateSafePackages` | **dependencies**（重复安装无害） |
 *   | 只带类型（`import type`） | **devDependencies**（不进运行时） |
 *   | **以上都没命中** | ⛔ **红**（默认拒绝：新符号必须显式分类） |
 *
 * 「用到了什么符号」**100% 机器算**（AST）；「该进哪段」**是查表、不是算出来的** —— 表是人写的。
 * 官方也如此。不把「查表」说成「自动判定」。
 *
 * ### ⚠️ 双写是**通用规则**，不是 cordis 专属
 *
 * 官方实测：非 cordis 的 peer 边 **1092 条，1092 条全部同时写 dev**（仅 peer = 0）。
 * 凡判为 peer 的，`devDependencies` 必须有同 range 一行。
 * 注：`cordis` 那一对由 G1 `verify-plugin-shape.ts:125-126` 专判，本判据不重复判它。
 *
 * ## 三处已知缺口（**不是等价移植**）
 *
 * 官方 1106 + 225 + 44 = **1375 行**，本判据只移植核心。以下**判不到**：
 *
 *   1. **Typert 生成源码**（官方 `:349-466`）：官方把构建期**生成**的 Host 源码
 *      （`lib/typert.host.js`）也算进运行时面。新树无此机制 ⇒ 只以生成物出现的依赖会**漏判**。
 *   2. **`--fix` 自动回写 manifest + 刷 pnpm-lock**（官方 `:969-1050`）：本判据**只判不改**。
 *      理由：自动改 `package.json` 的门禁在并行 worktree 下是事故源（多单同写一份 manifest）。
 *   3. **translation-pairing 中英双语配对**（`gen-module-graph.ts:11-20,136-167`）：
 *      本仓无此机制（实测无 `scripts/translation-pairing*`、无 `docs/*.zh.md`）⇒ 只生成单语文档。
 *
 * 两处**有意简化**（不漏判，只少一层覆盖）：Worker 16 线程并发（官方 `:732-776`）→ 串行；
 * `collectRootTypePackageViolations`（官方 `:928-947`）→ 不移植（属「root 提供类型包」另一件事）。
 *
 * ## 8 张白名单：**砍 4 留 4**
 *
 * | 白名单 | 处置 | 理由 |
 * |---|---|---|
 * | `PEER_REQUIRED_HOST_EXPORTS` | **留** | 判 peer 的唯一依据 |
 * | `SAFE_HOST_DEPENDENCY_EXPORTS` | **留** | 判 dep 的唯一依据 |
 * | `DUPLICATE_SAFE_PACKAGES` | **留** | 整包走 dep 的唯一依据 |
 * | `HOST_DEPENDENCY_PACKAGES` | **留** | 决定哪些包算 Host 面 |
 * | Client 面 4 张 | **砍** | 判 client 装配关系，新树还没这些结构 |
 *
 * ⚠️ **不能全砍**：全砍会让「默认拒绝」失效 —— 没表可查，所有符号都红。
 *
 * ## ⚠️ 与 G7 `scanEdges` 的关系（一处必须交代的事实）
 *
 * 方向判定**复用** G7 的 `scanEdges`（`lint-layer-new.ts:248`，有 export），不重写方向逻辑。
 * 但 **G7 的 `LayerEdge` 只有 `{src,dst,spec,file,line,typeOnly}`，没有 `exportName`**
 * （`lint-layer-new.ts:118-130`）⇒ 它是**包级**的。而官方的 peer/dep 判定单位是
 * **(specifier, exportName) 符号级** ⇒ 符号这一维 `scanEdges` 给不了。
 *
 * ⇒ 本文件补一个**极小的**符号抽取 `collectSymbolUses()`（复用同一个 `ts` 对象与同一批文件），
 *   只回答「这个文件从 spec 里取了哪些具名符号」。**它不是第二份方向扫描器**：
 *   方向/边集合仍然只由 `scanEdges` 决定，两者不重叠。
 *   若将来 G7 的 `LayerEdge` 加上 `exportName`，删掉本函数即可。
 *
 * 与 G7 的分工（一段单，不是重复）：G7 判**方向**；本判据判**新鲜度 + 声明对账**。
 * G7 文件头 `:56-57` 自己写着「package.json 的依赖声明与源码 import 是否一致（那是依赖清单类判据的射程）」。
 *
 * ## 0 个包 ⇒ 判不了（不是绿）
 *
 * `packages/` 不存在或 0 个包 ⇒ **unjudged（退出码 2）**。「0 个包」与「0 条违规」不是一件事
 * （与 G7 `:405-414` 同口径）。
 *
 * ## 用法
 *
 *   node scripts/gates/gen-layer-graph.ts              # 生成 docs/layer-graph.md
 *   node scripts/gates/gen-layer-graph.ts --check      # 门禁（0 绿 / 1 红 / 2 判不了）
 *   node scripts/gates/gen-layer-graph.ts --selftest   # 正反例（走同名 .spec.ts）
 */
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"
import { discoverPackages, readContract, scanEdges, type LayerEdge, type PkgRef } from "./lint-layer-new.ts"

const GATE = "gen-layer-graph"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const CONTRACT_REL = "scripts/baseline/layer-contract-next.json"
export const OUTPUT_REL = "docs/layer-graph.md"

/** 四段声明（官方 `declaredSections` 同口径）。 */
export const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const

export interface ManifestLike {
  name?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/* ───────────────────── 依赖判定（纯函数 + 策略表） ───────────────────── */

/** 三张符号表 + Host 面清单 —— 官方 `package-dependency-policy.ts` 的 4 个常量（砍掉 client 面 4 张）。 */
export interface DependencyPolicy {
  peerRequiredHostExports: Readonly<Record<string, readonly string[]>>
  safeHostDependencyExports: Readonly<Record<string, readonly string[]>>
  duplicateSafePackages: readonly string[]
  hostDependencyPackages: readonly string[]
}

/**
 * 起手策略表。**全部为空是合法起手状态**：新树无包、无符号需要分类。
 *
 * ⚠️ 反过来说：一旦有真实 import 而这里没登记，那条边会因为「默认拒绝」判红。
 * 这是**设计意图** —— 逼人在加依赖那一刻显式裁决，不让它静默落进 dependencies。
 *
 * `duplicateSafePackages` 起手为空。将来新树的 `brand` 落地时按「重复安装无害」登记在这里
 * （官方 `package-dependency-policy.ts:39` 就是这么登的）。
 */
export const DEFAULT_POLICY: DependencyPolicy = {
  peerRequiredHostExports: {},
  safeHostDependencyExports: {},
  duplicateSafePackages: [],
  hostDependencyPackages: [],
}

/** 一条 (specifier, 符号) 使用。符号为空 = 命名空间/默认/副作用（无界，不可分类）。 */
export interface SymbolUse {
  /** 源包键 */
  from: string
  /** 完整 specifier */
  spec: string
  /** 具名符号；`""` = 无界（`import * as ns` / 默认 / 副作用） */
  exportName: string
  file: string
  line: number
  typeOnly: boolean
}

/** 期望段落。 */
export type ExpectedSection = "peer" | "dependency" | "dev"

export interface Classification {
  name: string
  section: ExpectedSection
  origin: string
}

const CORDIS = "cordis"

/** 是不是 cordis（含子路径）。 */
export function isCordis(spec: string): boolean {
  return spec === CORDIS || spec.startsWith(`${CORDIS}/`)
}

/**
 * 把一条符号级使用映射成期望段落。**默认拒绝**：没命中任何表 ⇒ 返回 `null`（调用方判红）。
 *
 * @param use 一条符号级使用
 * @param policy 三张表
 * @returns 期望段落；`null` = 未分类
 */
export function classifyUse(use: SymbolUse, policy: DependencyPolicy): Classification | null {
  const name = use.spec
  if (isCordis(name)) return { name, section: "peer", origin: "cordis 共享运行时（无条件，官方 373/373）" }
  if (policy.duplicateSafePackages.includes(name)) {
    return { name, section: "dependency", origin: "duplicateSafePackages（重复安装无害）" }
  }
  if (use.exportName !== "") {
    if (policy.peerRequiredHostExports[name]?.includes(use.exportName) === true) {
      return { name, section: "peer", origin: `peerRequiredHostExports[${name}]#${use.exportName}` }
    }
    if (policy.safeHostDependencyExports[name]?.includes(use.exportName) === true) {
      return { name, section: "dependency", origin: `safeHostDependencyExports[${name}]#${use.exportName}` }
    }
  }
  if (use.typeOnly) return { name, section: "dev", origin: "仅类型 import（不进运行时）" }
  return null
}

/* ───────────────────── 符号抽取（补 scanEdges 缺的那一维） ───────────────────── */

/**
 * 从源码抽 (specifier, 具名符号) 使用。**只补符号维**，不重判方向。
 *
 * `scanEdges` 已给出「哪个文件 import 了哪个包」；这里只额外回答「取了哪个符号」。
 * 因此本函数**不做**包名解析、不做层号判定、不产出边 —— 那些仍是 `scanEdges` 的唯一职责。
 *
 * 覆盖形态：`import { a, b as c }` / `import * as ns` / `import def` / `import "x"`（副作用）/
 * `import type { T }` / `import { type T }`。无界形态（命名空间/默认/副作用）记 `exportName: ""`。
 *
 * @param opts.root 仓库根
 * @param opts.files 要扫的文件（相对路径）
 * @param opts.fromOf 文件 → 源包键
 * @param opts.ts typescript 模块
 * @returns 符号级使用清单（稳定排序）
 */
export function collectSymbolUses(opts: {
  root: string
  files: readonly string[]
  fromOf: (relFile: string) => string | null
  ts: unknown
}): SymbolUse[] {
  const ts = opts.ts as any
  const out: SymbolUse[] = []
  for (const rel of opts.files) {
    const from = opts.fromOf(rel)
    if (!from) continue
    let source = ""
    try {
      source = fs.readFileSync(path.join(opts.root, rel), "utf8")
    } catch {
      continue
    }
    const kind = rel.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : /\.(ts|mts|cts)$/.test(rel)
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS
    const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, kind)
    const push = (spec: string, exportName: string, node: any, typeOnly: boolean) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      out.push({ from, spec, exportName, file: rel, line, typeOnly })
    }
    const walk = (n: any) => {
      if (ts.isImportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text
        const clause = n.importClause
        if (!clause) {
          push(spec, "", n, false) // 副作用 import：会执行目标模块 ⇒ 算值
        } else {
          const declType = clause.isTypeOnly === true
          const nb = clause.namedBindings
          if (clause.name) push(spec, "", n, declType) // default import
          if (nb && ts.isNamespaceImport(nb)) push(spec, "", n, declType) // import * as ns
          else if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              const nm = el.propertyName ? el.propertyName.text : el.name.text
              push(spec, nm, n, declType || el.isTypeOnly === true)
            }
          } else if (!clause.name && !nb) {
            push(spec, "", n, declType) // `import type "x"` 之类
          }
        }
      } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text
        const declType = n.isTypeOnly === true
        const cl = n.exportClause
        if (cl && ts.isNamedExports(cl)) {
          for (const el of cl.elements) {
            const nm = el.propertyName ? el.propertyName.text : el.name.text
            push(spec, nm, n, declType || el.isTypeOnly === true)
          }
        } else push(spec, "", n, declType)
      }
      ts.forEachChild(n, walk)
    }
    walk(sf)
  }
  return out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.spec.localeCompare(b.spec) ||
      a.exportName.localeCompare(b.exportName),
  )
}

/* ───────────────────── 图渲染 ───────────────────── */

export interface PackageRow {
  key: string
  name: string | null
  group: string
  layer: number | null
  peers: string[]
  deps: string[]
}

/** 层号 → `L1` / `—`。 */
export function renderLayer(layer: number | null): string {
  return layer == null ? "—" : `L${layer}`
}

/**
 * 渲染映射表。**纯函数、字节稳定** —— 同输入必同字节，否则过期判定会变噪声。
 *
 * 六列：`package | group | logical_layer | area | peerDependencies | evidence`
 * `area` 恒 `—`：18 域清单在仓外，且主规划 `:209` 铁律明写「18 域只做概念族分类，
 * **不产生依赖约束**」⇒ 对本判据无贡献。留 `—` 是 Lead 已批的处置。
 */
export function renderLayerGraph(rows: readonly PackageRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const table = [
    "| package | group | logical_layer | area | peerDependencies | evidence |",
    "| --- | --- | --- | --- | --- | --- |",
    ...sorted.map((r) => {
      const peers = r.peers.length > 0 ? r.peers.join(", ") : "—"
      const evidence = r.layer == null ? "层表未登记" : "`layer-contract-next.json`"
      return `| ${r.name ?? r.key} | ${r.group} | ${renderLayer(r.layer)} | — | ${peers} | ${evidence} |`
    }),
  ]
  return [
    "<!-- 由 scripts/gates/gen-layer-graph.ts 生成——请勿手工编辑。",
    "     运行 `node scripts/gates/gen-layer-graph.ts` 重新生成。",
    "     ISS-845 / W0-GATE-G9 双轴映射表。 -->",
    "",
    "# 双轴映射表（logical_layer × physical_group）",
    "",
    "两轴正交：`logical_layer` 来自 `scripts/baseline/layer-contract-next.json`",
    "（键 = `packages/` 下两段相对路径）；`group` 是物理目录分组。",
    "**物理分组不改变逻辑层号，逻辑层号不写进目录名。**",
    "",
    "`peerDependencies` 列读自本包 manifest 的真实声明。判为 peer 的依赖一律 **peer + dev 双写**",
    "（实测：DSH 官方非 cordis 的 peer 边 1092 条全部同时写 dev，仅 peer = 0）。",
    "",
    "`area` 恒为 `—`：18 域只做概念族分类、不产生依赖约束（主规划 `:209`）。",
    "",
    ...table,
    "",
  ].join("\n")
}

/* ───────────────────── 采集（IO） ───────────────────── */

export function readManifest(root: string, pkg: PkgRef): ManifestLike | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, pkg.dir, "package.json"), "utf8")) as ManifestLike
  } catch {
    return null
  }
}

/** specifier → 包名（`@matter/kernel/io` → `@matter/kernel`；`x/y` → `x`）。 */
export function packageNameOf(spec: string): string | undefined {
  const parts = spec.split("/")
  const head = parts[0].startsWith("@") ? 2 : 1
  if (parts.length < head) return undefined
  return parts.slice(0, head).join("/")
}

/** 按 manifest 段落 + 层表生成行。 */
export function buildRows(
  packages: readonly PkgRef[],
  layers: Record<string, number>,
  manifests: ReadonlyMap<string, ManifestLike | null>,
): PackageRow[] {
  const byName = new Map<string, string>()
  for (const p of packages) if (p.name) byName.set(p.name, p.key)
  const keyOf = (spec: string): string | null => {
    const n = packageNameOf(spec)
    return n ? byName.get(n) ?? null : null
  }
  return packages.map((p) => {
    const m = manifests.get(p.key) ?? null
    const peers: string[] = []
    const deps: string[] = []
    for (const n of Object.keys(m?.peerDependencies ?? {})) {
      const k = byName.get(n)
      if (k && k !== p.key) peers.push(k)
    }
    for (const n of Object.keys(m?.dependencies ?? {})) {
      const k = byName.get(n)
      if (k && k !== p.key) deps.push(k)
    }
    void keyOf
    peers.sort()
    deps.sort()
    return {
      key: p.key,
      name: p.name,
      group: p.key.split("/")[0],
      layer: layers[p.key] ?? null,
      peers,
      deps,
    }
  })
}

/* ───────────────────── 三判据（纯函数） ───────────────────── */

export interface JudgeInput {
  rows: readonly PackageRow[]
  edges: readonly LayerEdge[]
  uses: readonly SymbolUse[]
  layers: Record<string, number>
  packages: readonly PkgRef[]
  manifests: ReadonlyMap<string, ManifestLike | null>
  packagesDirExists: boolean
  astAvailable: boolean
  contractPresent: boolean
  policy: DependencyPolicy
  expectedDoc: string
  actualDoc: string | null
}

export interface GraphFinding {
  rule: string
  file?: string
  line?: number
  detail: string
}

/** 判三件事：图过期 / 反向边 / 声明与实际一致。 */
export function judgeLayerGraph(input: JudgeInput): GateResult {
  if (!input.astAvailable) {
    return unjudged(GATE, "no-binary", "找不到 typescript ⇒ 扫不出 import 边，判不了（不是绿）")
  }
  if (!input.contractPresent) {
    return unjudged(GATE, "no-baseline", `层表不存在或不可解析：${CONTRACT_REL} ⇒ 判不了`)
  }
  if (!input.packagesDirExists) {
    return unjudged(GATE, "no-corpus", "packages/ 不存在 ⇒ 新树还没有落盘，判不了（不是绿）")
  }
  if (input.packages.length === 0) {
    return unjudged(
      GATE,
      "no-corpus",
      `packages/*/* 下 0 个包（层表登记 ${Object.keys(input.layers).length} 条）⇒ 判不了，不是绿`,
    )
  }

  const hits: GraphFinding[] = []

  // ① 图是否过期（字节比对）
  if (input.actualDoc === null) {
    hits.push({
      rule: "GRAPH-STALE",
      file: OUTPUT_REL,
      detail: `${OUTPUT_REL} 不存在 ⇒ 图未生成（跑 \`node scripts/gates/gen-layer-graph.ts\` 后提交）`,
    })
  } else if (input.actualDoc !== input.expectedDoc) {
    hits.push({
      rule: "GRAPH-STALE",
      file: OUTPUT_REL,
      detail: `${OUTPUT_REL} 与现算内容不一致 ⇒ 图过期（手改过或漏重生成）`,
    })
  }

  // ② 反向边（复用 G7 的层号口径，不重判方向定义）
  for (const e of input.edges) {
    const s = input.layers[e.src]
    const d = input.layers[e.dst]
    if (s == null || d == null) continue
    if (s < d) {
      hits.push({
        rule: "GRAPH-REVERSE",
        file: e.file,
        line: e.line,
        detail: `反向边 L${s}→L${d}：${e.src} → ${e.spec}（低层不许 import 高层）`,
      })
    } else if (s === 4 && d < 4 && !e.typeOnly) {
      hits.push({
        rule: "GRAPH-REVERSE",
        file: e.file,
        line: e.line,
        detail: `越层取值 L${s}→L${d}：${e.src} → ${e.spec}（L4 向下取到值，应走注入服务）`,
      })
    }
  }

  // ③ 声明与实际一致
  const pkgByKey = new Map(input.packages.map((p) => [p.key, p]))
  const declared = (m: ManifestLike, name: string): string[] =>
    SECTIONS.filter((s) => (m as Record<string, Record<string, string> | undefined>)[s]?.[name] !== undefined)

  for (const u of input.uses) {
    const c = classifyUse(u, input.policy)
    if (c === null) {
      hits.push({
        rule: "GRAPH-UNCLASSIFIED",
        file: u.file,
        line: u.line,
        detail: `${u.from} → ${u.spec}${u.exportName ? `#${u.exportName}` : ""} 未分类：既不在 peerRequiredHostExports 也不在 safeHostDependencyExports ⇒ 必须显式登记（默认拒绝）`,
      })
      continue
    }
    const pkg = pkgByKey.get(u.from)
    if (!pkg) continue
    const m = input.manifests.get(pkg.key)
    if (!m) continue
    const got = declared(m, c.name)
    if (c.section === "peer") {
      // cordis 的 peer+dev 那一对由 G1 verify-plugin-shape:125-126 专判，这里不重复判它。
      if (isCordis(c.name)) continue
      const hasPeer = m.peerDependencies?.[c.name] !== undefined
      const hasDev = m.devDependencies?.[c.name] !== undefined
      if (!hasPeer || !hasDev) {
        hits.push({
          rule: "GRAPH-PEER-NOT-DUAL",
          file: `${pkg.dir}/package.json`,
          detail: `${u.from} → ${c.name} 判 peer（${c.origin}）⇒ 必须 peer + dev 双写，实际只有 ${got.join(" + ") || "无声明"}`,
        })
      }
    } else if (c.section === "dependency") {
      if (!got.includes("dependencies")) {
        hits.push({
          rule: "GRAPH-SECTION-MISMATCH",
          file: `${pkg.dir}/package.json`,
          detail: `${u.from} → ${c.name} 判 dependencies（${c.origin}）⇒ 实际只有 ${got.join(" + ") || "无声明"}`,
        })
      }
    }
  }

  // ③b 反向对账：声明了内部依赖但源码零 import ⇒ 化石声明
  //
  // 为什么必须有这一条（实测缺口）：只做「import ⇒ 该声明」是单向的。
  // 造一个声明了 peer `@m/a` 但源码零 import 的包，第一版判据报 **passed** ——
  // 「声明」与「实际」就对不上了，而这正是本判据的立身之本（乙档的核心承诺）。
  // 官方对应物是 `expectedPackageDependencies` 只遍历**已有事实**，多余声明靠
  // `collectPackageDependencyViolations` 的「must be X-only; found …」反向报出。
  {
    const workspaceNames = new Set(input.packages.map((p) => p.name).filter((n): n is string => !!n))
    const usedBy = new Map<string, Set<string>>()
    for (const u of input.uses) {
      const owner = u.from
      const name = packageNameOf(u.spec)
      if (!name) continue
      if (!usedBy.has(owner)) usedBy.set(owner, new Set())
      usedBy.get(owner)!.add(name)
    }
    for (const pkg of input.packages) {
      const m = input.manifests.get(pkg.key)
      if (!m) continue
      const used = usedBy.get(pkg.key) ?? new Set<string>()
      for (const sectionName of ["peerDependencies", "dependencies"] as const) {
        for (const name of Object.keys(m[sectionName] ?? {})) {
          // 只看内部包（workspace 内互引）；外部包不归本判据管。
          if (!workspaceNames.has(name)) continue
          if (isCordis(name)) continue
          if (used.has(name)) continue
          hits.push({
            rule: "GRAPH-PHANTOM-DECL",
            file: `${pkg.dir}/package.json`,
            detail: `${pkg.key} 的 ${sectionName}.${name} 是化石声明：src/ 下零 import（确认是否该删）`,
          })
        }
      }
    }
  }

  if (hits.length > 0) {
    return {
      gate: GATE,
      status: "failed",
      findings: hits.map((h) => ({ file: h.file, line: h.line, detail: `[${h.rule}] ${h.detail}` })),
    }
  }
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${input.packages.length} 个包 / ${input.edges.length} 条跨包边 / 层表 ${Object.keys(input.layers).length} 条 ⇒ 三判据全过（图新鲜、无反向边、声明与实际一致）`,
  }
}

/* ───────────────────── 装配（IO） ───────────────────── */

const TS_CANDS = [
  "forge-ui/node_modules/typescript/lib/typescript.js",
  "forge-pm/node_modules/typescript/lib/typescript.js",
  "node_modules/typescript/lib/typescript.js",
]

/** 加载 typescript（工具，不是被扫对象）。候选表与 G7 `:188-209` 一致。 */
export function loadTs(root: string): unknown | null {
  for (const base of [root, REPO]) {
    let req: NodeRequire
    try {
      req = createRequire(path.join(base, "package.json"))
    } catch {
      continue
    }
    for (const c of TS_CANDS) {
      const abs = path.join(base, c)
      if (!fs.existsSync(abs)) continue
      try {
        return req(abs)
      } catch {
        /* 换下一个候选 */
      }
    }
    try {
      return req("typescript")
    } catch {
      /* 换下一个 base */
    }
  }
  return null
}

/** `packages/<g>/<p>/src/**` 下的源文件（与 G7 `walkFiles` 同射程）。 */
function srcFiles(root: string, pkg: PkgRef): string[] {
  const out: string[] = []
  const skip = /^(node_modules|dist|lib|build|out|coverage|__pycache__|\.git|static|preview|vendor)$/
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!skip.test(e.name) && !e.name.startsWith(".")) walk(path.join(rel, e.name))
      } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(e.name)) {
        out.push(path.join(rel, e.name).split(path.sep).join("/"))
      }
    }
  }
  walk(`${pkg.dir}/src`)
  return out.sort()
}

/** 装配一次完整判定（main 与 spec 共用，避免「自检的和门禁跑的不是同一条路」）。 */
export function evaluate(root: string, policy: DependencyPolicy = DEFAULT_POLICY): GateResult {
  const { contract, error } = readContract(root)
  const { packages, dirExists } = discoverPackages(root)
  const layers = contract?.layers ?? {}
  const manifests = new Map<string, ManifestLike | null>()
  for (const p of packages) manifests.set(p.key, readManifest(root, p))
  const ts = loadTs(root)
  const edges = ts ? scanEdges({ root, packages, ts }) : []

  const files: string[] = []
  const owner = new Map<string, string>()
  for (const p of packages) {
    for (const f of srcFiles(root, p)) {
      files.push(f)
      owner.set(f, p.key)
    }
  }
  const uses = ts
    ? collectSymbolUses({ root, files, fromOf: (f) => owner.get(f) ?? null, ts })
    : []

  const rows = buildRows(packages, layers, manifests)
  const expectedDoc = renderLayerGraph(rows)
  const outPath = path.join(root, OUTPUT_REL)
  const actualDoc = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : null

  return judgeLayerGraph({
    rows,
    edges,
    uses,
    layers,
    packages,
    manifests,
    packagesDirExists: dirExists,
    astAvailable: !!ts,
    contractPresent: contract != null,
    policy,
    expectedDoc,
    actualDoc,
  })
}

/** 生成文档。返回是否变化。 */
export function writeLayerGraph(root: string = REPO): { changed: boolean; path: string; rows: PackageRow[] } {
  const { contract } = readContract(root)
  const { packages } = discoverPackages(root)
  const layers = contract?.layers ?? {}
  const manifests = new Map<string, ManifestLike | null>()
  for (const p of packages) manifests.set(p.key, readManifest(root, p))
  const rows = buildRows(packages, layers, manifests)
  const content = renderLayerGraph(rows)
  const outPath = path.join(root, OUTPUT_REL)
  const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : null
  if (prev === content) return { changed: false, path: OUTPUT_REL, rows }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, content)
  return { changed: true, path: OUTPUT_REL, rows }
}

/* ───────────────────── main ───────────────────── */

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (isMain(import.meta.url)) {
  runGate({
    name: GATE,
    main: () => {
      const rootArg = argOf("--root")
      const root = rootArg ? path.resolve(rootArg) : REPO
      if (!process.argv.includes("--check")) {
        const r = writeLayerGraph(root)
        console.log(`✓ ${GATE}: ${r.path}${r.changed ? "（已更新）" : "（无变化）"}，${r.rows.length} 个包`)
        return { gate: GATE, status: "passed" as const, detail: `${r.rows.length} 个包，${r.changed ? "已更新" : "无变化"}` }
      }
      return evaluate(root)
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
