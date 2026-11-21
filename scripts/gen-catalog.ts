#!/usr/bin/env node
/**
 * gen-catalog —— 单入口、多 extractor 的 catalog 生成器框架（ISS-893 / 轨 D D1，DOC-516:240-252）。
 *
 * DSH 的 24 个生成器各自独立、**没有**共用框架。这里建框架是**我们的改良、属增强不属减配**
 * （DOC-516 §八-2）：当下有 3 个真实消费者（ctx / event / dependency），不是预防性设计。
 * D0 的 `gen-ctx-catalog.ts` 已迁成 ctx extractor；它已验证的 AST 抽取与渲染逻辑一字未改，
 * 故 `docs/ctx-catalog.md` 字节不变（6 包 / 7 键 / 1 事件）。
 *
 * 机制与单生成器同构，仍是**失败驱动**：
 *   改源码 → 忘跑生成器 → `verify-catalogs --check` 红 → `node scripts/gen-catalog.ts` → 提交。
 * 生成物进 git、不手改、重生成幂等（无时间戳，一切按码位序排序）。
 *
 * 一次运行只建**一个** `ts.Program`，3 个 extractor 共用；每个 extractor 只负责
 * `extract(repo, program) → T` 与 `render(T) → string`，框架负责调度与写盘。
 *
 * 用法：node scripts/gen-catalog.ts            # 重生成 3 张 catalog
 *       node scripts/gen-catalog.ts --check    # 只比对，旧了退出 1（与判据同口径）
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"
import { ctxExtractor } from "./gen-ctx-catalog.ts"
import { scanSource } from "./gen-ctx-catalog.ts"

/** 仓库根（本文件在 `<repo>/scripts/`）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** 一个 extractor：id 唯一、output 唯一，extract/render 都是纯函数（spec 可直接喂构造数据）。 */
export interface Extractor<T> {
  readonly id: string
  readonly output: string
  extract(repo: string, program: ts.Program): T
  render(data: T): string
}

/** 扫描时跳过的目录名（与 D0 的 gen-ctx-catalog 同口径）。 */
const SKIP_DIRS = new Set(["node_modules", "dist", "lib", "tests", "test", ".git", "coverage"])
const posix = (p: string) => p.split(path.sep).join("/")
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const cell = (s: unknown) => String(s).replace(/\|/g, "\\|")

/* ────────────────────────────── 共享扫描基元 ────────────────────────────── */

export interface PkgInfo {
  name: string
  /** 仓库相对 posix 路径（`packages/<group>/<pkg>`）。 */
  dir: string
  dependencies: Record<string, string>
}

/**
 * 列出 `packages/<group>/<pkg>/package.json` 对应的包。结构化读 name/dependencies，不按包名字面猜。
 * @param repo - 仓库根。
 */
export function listPackages(repo: string): PkgInfo[] {
  const root = path.join(repo, "packages")
  const out: PkgInfo[] = []
  let groups: fs.Dirent[]
  try {
    groups = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const g of groups.sort((a, b) => byCodeUnit(a.name, b.name))) {
    if (!g.isDirectory() || SKIP_DIRS.has(g.name)) continue
    let pkgs: fs.Dirent[]
    try {
      pkgs = fs.readdirSync(path.join(root, g.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const p of pkgs.sort((a, b) => byCodeUnit(a.name, b.name))) {
      if (!p.isDirectory() || SKIP_DIRS.has(p.name)) continue
      const pkgDir = path.join(root, g.name, p.name)
      try {
        const json = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"))
        out.push({
          name: String(json.name ?? ""),
          dir: posix(path.relative(repo, pkgDir)),
          dependencies: (json.dependencies ?? {}) as Record<string, string>,
        })
      } catch {
        // 没有合法 package.json 的目录不是包（与 D0 口径一致：静默跳过）。
      }
    }
  }
  return out
}

/** 递归收集一个 `src` 下的源码文件（跳过产物与测试，口径同 D0）。 */
function collectSrcFiles(dir: string, acc: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      collectSrcFiles(path.join(dir, e.name), acc)
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && !e.name.endsWith(".spec.ts")) {
      acc.push(path.join(dir, e.name))
    }
  }
}

/**
 * 建整棵源码的**一个** `ts.Program`，供 3 个 extractor 共用。
 * `noResolve` —— 不追 import、不读 lib，只解析根文件；我们要的是 AST，不是类型检查。
 * @param repo - 仓库根。
 */
export function buildProgram(repo: string): ts.Program {
  const files: string[] = []
  for (const pkg of listPackages(repo)) collectSrcFiles(path.join(repo, pkg.dir, "src"), files)
  files.sort(byCodeUnit)
  return ts.createProgram(files, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    noResolve: true,
    skipLibCheck: true,
  })
}

/** program 里属于本仓 `packages/<group>/<pkg>/src` 的源文件（排除 `.d.ts` / `.spec.ts`）。 */
function repoSourceFiles(repo: string, program: ts.Program): ts.SourceFile[] {
  const pkgRoot = path.join(repo, "packages") + path.sep
  return program.getSourceFiles().filter(
    (sf) => sf.fileName.startsWith(pkgRoot) && sf.fileName.endsWith(".ts") &&
      !sf.fileName.endsWith(".d.ts") && !sf.fileName.endsWith(".spec.ts"),
  )
}

/** 一个源码文件属于哪个包（按目录归属，不按内容猜）。 */
function ownerPackage(repo: string, fileName: string, pkgs: PkgInfo[]): string {
  for (const pkg of pkgs) {
    const prefix = path.join(repo, pkg.dir) + path.sep
    if (fileName.startsWith(prefix)) return pkg.name
  }
  return ""
}

/* ────────────────────────────── event extractor ────────────────────────────── */

/** 一条类型化事件声明。 */
export interface EventRow {
  name: string
  mode: string
  site: string
  line: number
  pkg: string
}
export interface EventSurface {
  rows: EventRow[]
  packageCount: number
}

/** 事件生成物的文件头（逐字稳定，判据此校验）。 */
export const EVENT_HEADER = "<!-- Generated by scripts/gen-catalog.ts (extractor: event) — do not edit by hand. -->"
export const EVENT_OUT = "docs/event-catalog.md"

/**
 * 从单文件源码抽事件声明（复用 D0 的 `scanSource`，不另写一份 AST 口径）。
 * 正例/反例/变异由 spec 直接喂构造源码。
 * @param text - 源码全文。
 * @param site - 仓库相对路径。
 * @param pkg - 来源包名。
 */
export function scanEventDeclarations(text: string, site: string, pkg: string): EventRow[] {
  return scanSource(text, site).events.map((e) => ({ ...e, pkg }))
}

export const eventExtractor: Extractor<EventSurface> = {
  id: "event",
  output: EVENT_OUT,
  extract(repo, program) {
    const pkgs = listPackages(repo)
    const rows: EventRow[] = []
    for (const sf of repoSourceFiles(repo, program)) {
      const site = posix(path.relative(repo, sf.fileName))
      rows.push(...scanEventDeclarations(sf.text, site, ownerPackage(repo, sf.fileName, pkgs)))
    }
    return { rows, packageCount: pkgs.length }
  },
  render(data) {
    const { rows, packageCount } = data
    const lines: string[] = []
    lines.push(EVENT_HEADER, "")
    lines.push("# event catalog（生成物，勿手改）", "")
    lines.push(
      `事件声明 ${rows.length} 条 · 来源包 ${packageCount} 个。重生成：\`node scripts/gen-catalog.ts\`；` +
        "新鲜度：`node scripts/gates/verify-catalogs.ts --check`。",
      "",
    )
    lines.push(
      "本表由源码 AST 抽取：合并 `declare module \"@deepseek-ai/cordis\"` 的 `interface Events` 方法签名即一个类型化事件，" +
        "`@mode` 取自挂载的 JSDoc（不是回溯文本）。扫描面 `packages/*/*/src/**/*.ts`（`lib/` 是产物，不扫）；" +
        "按 (事件名, 来源包) 码位序排列，重生成幂等。",
      "",
    )
    lines.push("## 事件清单", "")
    if (!rows.length) {
      lines.push("（无：本期没有任何包合并 `interface Events`）", "")
    } else {
      lines.push("| 事件名 | 模式 | 来源包 | 声明位置 |", "|---|---|---|---|")
      for (const e of [...rows].sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.pkg, b.pkg))) {
        const mode = e.mode ? `\`@mode ${e.mode}\`` : "—"
        lines.push(`| \`${cell(e.name)}\` | ${cell(mode)} | \`${cell(e.pkg)}\` | \`${cell(e.site)}:${e.line}\` |`)
      }
      lines.push("")
    }
    return lines.join("\n")
  },
}

/* ────────────────────────────── dependency extractor ────────────────────────────── */

/** 一条包间依赖边（声明与源码 import 的并集）。 */
export interface DepEdge {
  from: string
  to: string
  declared: boolean
  /** import 位置列表（`site:line`）；仅声明时为 `[]`。 */
  imports: string[]
}
/** 一条外部依赖（package.json 里非 `@matter/*` 的 dependencies）。 */
export interface ExternalDep {
  from: string
  name: string
  version: string
}
export interface DependencySurface {
  packageCount: number
  edges: DepEdge[]
  external: ExternalDep[]
}

/** 依赖生成物的文件头。 */
export const DEP_HEADER = "<!-- Generated by scripts/gen-catalog.ts (extractor: dependency) — do not edit by hand. -->"
export const DEP_OUT = "docs/dependency-catalog.md"

/** 一条源码模块引用。 */
export interface ImportRef {
  from: string
  target: string
  site: string
  line: number
}

/**
 * 从单文件源码抽 `@matter/*` 的静态模块引用（`import` 与 `export … from`）。
 * 用 AST 而非正则：注释 / 字符串里的 `from "@matter/x"` 不是节点，天然抽不到。
 * @param text - 源码全文。
 * @param site - 仓库相对路径。
 * @param pkg - 来源包名。
 */
export function scanImportRefs(text: string, site: string, pkg: string): ImportRef[] {
  const sf = ts.createSourceFile(site, text, ts.ScriptTarget.Latest, true)
  const out: ImportRef[] = []
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const take = (spec: ts.Expression | undefined, node: ts.Node) => {
    if (!spec || !ts.isStringLiteral(spec) || !spec.text.startsWith("@matter/")) return
    out.push({ from: pkg, target: spec.text, site, line: lineOf(node) })
  }
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) take(stmt.moduleSpecifier, stmt)
    else if (ts.isExportDeclaration(stmt)) take(stmt.moduleSpecifier, stmt)
  }
  return out
}

/**
 * 把「声明」与「源码引用」合成依赖面（纯函数，spec 直接喂构造数据）。
 * 边集 = package.json 声明的 `@matter/*` ∪ 源码 import 的 `@matter/*`；
 * 只认真实存在的包名（`known`），拼错的名字不进边表（否则一张表里全是拼错目标）。
 * @param pkgs - 包清单（含 dependencies）。
 * @param refs - 源码引用。
 */
export function computeDependencies(pkgs: PkgInfo[], refs: ImportRef[]): DependencySurface {
  const known = new Set(pkgs.map((p) => p.name))
  const edgeMap = new Map<string, DepEdge>()
  const external: ExternalDep[] = []
  const key = (from: string, to: string) => `${from}\u0000${to}`
  const ensure = (from: string, to: string): DepEdge => {
    let e = edgeMap.get(key(from, to))
    if (!e) {
      e = { from, to, declared: false, imports: [] }
      edgeMap.set(key(from, to), e)
    }
    return e
  }

  for (const pkg of pkgs) {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      if (known.has(name)) ensure(pkg.name, name).declared = true
      else external.push({ from: pkg.name, name, version: String(version) })
    }
  }
  for (const ref of refs) {
    if (!known.has(ref.target) || !known.has(ref.from)) continue
    ensure(ref.from, ref.target).imports.push(`${ref.site}:${ref.line}`)
  }

  return {
    packageCount: pkgs.length,
    edges: [...edgeMap.values()].sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to)),
    external: external.sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.name, b.name)),
  }
}

export const dependencyExtractor: Extractor<DependencySurface> = {
  id: "dependency",
  output: DEP_OUT,
  extract(repo, program) {
    const pkgs = listPackages(repo)
    const refs: ImportRef[] = []
    for (const sf of repoSourceFiles(repo, program)) {
      const site = posix(path.relative(repo, sf.fileName))
      refs.push(...scanImportRefs(sf.text, site, ownerPackage(repo, sf.fileName, pkgs)))
    }
    return computeDependencies(pkgs, refs)
  },
  render(data) {
    const { packageCount, edges, external } = data
    const lines: string[] = []
    lines.push(DEP_HEADER, "")
    lines.push("# dependency catalog（生成物，勿手改）", "")
    lines.push(
      `包 ${packageCount} 个 · 包间依赖 ${edges.length} 条 · 外部依赖 ${external.length} 条。` +
        "重生成：`node scripts/gen-catalog.ts`；新鲜度：`node scripts/gates/verify-catalogs.ts --check`。",
      "",
    )
    lines.push(
      "本表从 `packages/*/*/package.json` 的 `dependencies` 与源码 AST 的 `@matter/*` 模块引用（`import` / `export … from`）交叉抽取。" +
        "「声明」= package.json 有该依赖；「import」= 源码有该引用；两者之并集算一条边。" +
        "只认真实存在的包名；按 (来源包, 目标包) 码位序排列，重生成幂等。",
      "",
    )
    lines.push("## 包间依赖（@matter）", "")
    if (!edges.length) {
      lines.push("（无）", "")
    } else {
      lines.push("| 来源包 | 目标包 | package.json 声明 | 源码 import | import 位置 |", "|---|---|---|---|---|")
      for (const e of edges) {
        const sites = e.imports.length ? e.imports.map((s) => `\`${cell(s)}\``).join("、") : "—"
        lines.push(
          `| \`${cell(e.from)}\` | \`${cell(e.to)}\` | ${e.declared ? "是" : "否"} | ${e.imports.length ? "是" : "否"} | ${sites} |`,
        )
      }
      lines.push("")
    }
    lines.push("## 外部依赖（package.json）", "")
    if (!external.length) {
      lines.push("（无）", "")
    } else {
      lines.push("| 来源包 | 依赖 | 版本 |", "|---|---|---|")
      for (const d of external) {
        lines.push(`| \`${cell(d.from)}\` | \`${cell(d.name)}\` | \`${cell(d.version)}\` |`)
      }
      lines.push("")
    }
    return lines.join("\n")
  },
}

/* ────────────────────────────── 框架调度 ────────────────────────────── */

/** 3 个真实消费者，注册顺序即生成顺序。 */
export const EXTRACTORS: Extractor<unknown>[] = [ctxExtractor, eventExtractor, dependencyExtractor]

/**
 * 一次跑全部 extractor：建一个 program → extract → render，产出 `{ output: text }`。
 * 判据与 CLI 都走这条唯一路径（不许各写一份扫描）。
 */
export function generateAll(repo: string): { output: string; text: string }[] {
  const program = buildProgram(repo)
  return EXTRACTORS.map((ex) => {
    const data = ex.extract(repo, program)
    return { output: ex.output, text: ex.render(data) }
  })
}

function main(argv: string[]): number {
  const check = argv.includes("--check")
  const generated = generateAll(REPO_ROOT)
  let bad = 0
  for (const { output, text } of generated) {
    const target = path.join(REPO_ROOT, output)
    if (check) {
      const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null
      if (current === text) {
        console.log(`✓ ${output} 与源码一致`)
      } else {
        console.error(`✗ ${output} ${current === null ? "不存在" : "是旧的"} —— 跑 \`node scripts/gen-catalog.ts\` 再提交`)
        bad++
      }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
      console.log(`✓ 已写 ${output}（${text.length} B）`)
    }
  }
  return bad === 0 ? 0 : 1
}

const invokedDirectly = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return pathToFileURL(path.resolve(argv1)).href === import.meta.url
  } catch {
    return false
  }
})()

if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
