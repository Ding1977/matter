/**
 * 浏览器 bundle 纯度判据（ISS-906 / P0 门禁对齐）。
 *
 * 判什么：浏览器面（apps/web 的 src 树 + 各 client 包的 src/client 树）不得引入
 * 不该进 bundle 的外部依赖，也不得越层引用。规则：
 *   ① node-builtin        —— 浏览器面不许 import node:* / Node 核心模块
 *   ② server-only-external —— 不许 import 明确的服务端/原生模块（策略表，改它需要 diff + 评审）
 *   ③ cross-client-layer   —— client 包的浏览器面不许 import 兄弟 client 包（包自身描述即「零跨包引用」）
 *   ④ client-root-import   —— apps/web 引用 @matter/client-* 必须走 /client 子路径，不许拿 host 根
 *   ⑤ artifact-builtin     —— 若 apps/web/dist 存在，产物 JS 里不许出现 node:* / require('fs') 等
 *
 * 为什么重写而不是移植 DSH 的 client-bundle-purity.spec.ts + browser-bundled-externals.ts：
 *   · DSH 那套验的是它自己的 tsdown client preset（clientBundle/staticLinked/neverBundle）、
 *     packages/client/<pkg>/lib/client.js 产物、experimental 包输入隔离、CSS Modules watch 图，
 *     依赖 tsdown + product-isolation.ts + 一整套 build 事件——本仓全无对应物；
 *   · 本仓 client 包是 @matter/client-*，浏览器面是 src/client 树，lib/ 与 dist/ 是 gitignore 的
 *     构建产物（build:shell 当前还因外部包缺 export 而失败，见 ISS-906 note），照搬会恒红；
 *   · ⇒ 按本仓结构做纯静态检查，零新依赖（只用 typescript + node:fs，均已在仓）。
 *
 * 三态：0 绿 / 1 红 / 2 判不了（no-corpus）。type-only import 不进 bundle，不计违规。
 */
import { existsSync, globSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import ts from "typescript"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-browser-bundle-purity"
const REPO = resolve(import.meta.dirname, "..", "..")
const WEB_FACE_GLOB = "apps/web/src/**/*.{ts,tsx}"
const CLIENT_FACE_GLOB = "packages/client/*/src/client/**/*.{ts,tsx}"
const CLIENT_MANIFEST_GLOB = "packages/client/*/package.json"
const ARTIFACT_GLOB = "apps/web/dist/**/*.js"

/** Node 核心模块（带或不带 node: 前缀都算）。 */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto",
  "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https",
  "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty",
  "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
])
/** 明确的服务端/原生模块：浏览器 bundle 里出现任何一个都是事故。改这张表要 diff + 评审。 */
const SERVER_ONLY = new Set([
  "better-sqlite3", "sqlite3", "mootdx", "akshare", "pg", "mysql", "mysql2", "redis", "ioredis",
  "express", "fastify", "koa", "@grpc/grpc-js", "node-kb", "bullmq", "knex", "sequelize",
])

/** 一条 import 事实。 */
export interface ImportFact {
  file: string
  line: number
  specifier: string
  typeOnly: boolean
}

export interface PurityInput {
  /** 浏览器面源文件数（0 ⇒ no-corpus）。 */
  faceCount: number
  /** client 包名 → 仓库相对目录（由各 client 包的 package.json 现算，非快照）。 */
  clientPackages: Record<string, string>
  /** 浏览器面所有 import 事实。 */
  imports: ImportFact[]
  /** apps/web/dist 下扫到的 JS 产物路径（仓库相对）。 */
  artifacts: string[]
}

/** 从一段 TS/TSX 源码抽 import 事实（静态/动态/require，不写盘）。 */
export function extractImports(file: string, sourceText: string): ImportFact[] {
  const source = ts.createSourceFile(
    file, sourceText, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out: ImportFact[] = []
  const lineOf = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ file, line: lineOf(n), specifier: n.moduleSpecifier.text, typeOnly: n.importClause?.isTypeOnly === true })
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = n.arguments[0]
      if (first !== undefined && ts.isStringLiteral(first)) out.push({ file, line: lineOf(n), specifier: first.text, typeOnly: false })
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "require") {
      const first = n.arguments[0]
      if (first !== undefined && ts.isStringLiteral(first)) out.push({ file, line: lineOf(n), specifier: first.text, typeOnly: false })
    }
    ts.forEachChild(n, visit)
  }
  visit(source)
  return out
}

/** 现算：浏览器面文件 + client 包映射 + import 事实 + 产物清单。 */
export function scan(): PurityInput {
  const faceFiles = [...globSync(WEB_FACE_GLOB, { cwd: REPO }), ...globSync(CLIENT_FACE_GLOB, { cwd: REPO })]
    .map((f) => f.split("\\").join("/")).sort()
  const clientPackages: Record<string, string> = {}
  for (const manifest of globSync(CLIENT_MANIFEST_GLOB, { cwd: REPO }).sort()) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(REPO, manifest), "utf8")) as { name?: string }
      if (typeof pkg.name === "string") clientPackages[pkg.name] = dirname(manifest).split("\\").join("/")
    } catch { /* 坏 manifest 由包自身门禁管，这里只建映射 */ }
  }
  const imports: ImportFact[] = []
  for (const file of faceFiles) {
    const abs = resolve(REPO, file)
    if (existsSync(abs)) imports.push(...extractImports(file, readFileSync(abs, "utf8")))
  }
  const artifacts = globSync(ARTIFACT_GLOB, { cwd: REPO }).map((f) => f.split("\\").join("/")).sort()
  return { faceCount: faceFiles.length, clientPackages, imports, artifacts }
}

/** 判断 specifier 是不是 Node 核心模块。 */
function isBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier
  return specifier.startsWith("node:") || NODE_BUILTINS.has(bare)
}

/** 纯判据：输入事实 → 结论。 */
export function judge(input: PurityInput): GateResult {
  if (input.faceCount === 0) {
    return unjudged(GATE, "no-corpus", "浏览器面扫到 0 个源文件 ⇒ 判不了 bundle 纯度（空集不是绿）")
  }
  const findings: Finding[] = []
  for (const imp of input.imports) {
    if (imp.typeOnly) continue // type-only 被擦除，不进 bundle
    const isWeb = imp.file.startsWith("apps/web/")
    const fromClientDir = /^packages\/client\/([^/]+)\//.exec(imp.file)?.[1]

    // ① Node 核心模块
    if (isBuiltin(imp.specifier)) {
      findings.push({ file: imp.file, line: imp.line, detail: `浏览器面 import "${imp.specifier}" 是 Node 核心模块 ⇒ 不该进 bundle（server-only）` })
      continue
    }
    // ② 明确的 server-only 原生模块
    if (SERVER_ONLY.has(imp.specifier)) {
      findings.push({ file: imp.file, line: imp.line, detail: `浏览器面 import "${imp.specifier}" 是服务端/原生模块 ⇒ 不该进 bundle` })
      continue
    }
    // ③ 兄弟 client 包（client 浏览器面之间零跨包引用）
    if (fromClientDir !== undefined) {
      const targetDir = input.clientPackages[imp.specifier.split("/").slice(0, imp.specifier.startsWith("@") ? 2 : 1).join("/")]
        ?? input.clientPackages[imp.specifier]
      if (targetDir !== undefined && targetDir !== `packages/client/${fromClientDir}`) {
        findings.push({ file: imp.file, line: imp.line, detail: `client 包浏览器面 import 兄弟包 "${imp.specifier}" ⇒ 越层引用（包描述要求零跨包引用，共用走契约/装配）` })
        continue
      }
      // 相对路径逃出本包、落进另一个 client 包
      const rel = resolve(REPO, dirname(imp.file), imp.specifier)
      const relRepo = relative(REPO, rel).split("\\").join("/")
      const other = /^packages\/client\/([^/]+)\//.exec(relRepo)?.[1]
      if (other !== undefined && other !== fromClientDir) {
        findings.push({ file: imp.file, line: imp.line, detail: `相对 import "${imp.specifier}" 落进兄弟 client 包 packages/client/${other} ⇒ 越层引用` })
      }
    }
    // ④ apps/web 引用 client 包必须走 /client 子路径（根是 host 半）
    if (isWeb && imp.specifier.startsWith("@matter/client-")) {
      const parts = imp.specifier.split("/")
      if (parts.length === 2) {
        findings.push({ file: imp.file, line: imp.line, detail: `apps/web 以根路径 import "${imp.specifier}" ⇒ 越层引用（须走 ${imp.specifier}/client 子路径，根是 host 半）` })
      }
    }
  }

  // ⑤ 产物面：若 build 产物在盘，扫里面有没有被硬塞进来的 server-only 符号
  for (const artifact of input.artifacts) {
    const abs = resolve(REPO, artifact)
    if (!existsSync(abs)) continue
    const lines = readFileSync(abs, "utf8").split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      const m = /(?:from\s*|require\(\s*|import\(\s*)["']([^"']+)["']/.exec(line)
      const spec = m?.[1]
      if (spec !== undefined && (isBuiltin(spec) || SERVER_ONLY.has(spec))) {
        findings.push({ file: artifact, line: i + 1, detail: `构建产物里出现 ${spec} ⇒ 不该进 bundle 的外部依赖被打进产物` })
      }
    }
  }

  if (findings.length > 0) return { gate: GATE, status: "failed", findings }
  return {
    gate: GATE, status: "passed", findings: [],
    detail: `${input.faceCount} 个浏览器面文件 / ${Object.keys(input.clientPackages).length} 个 client 包 / ${input.imports.length} 条 import 干净${input.artifacts.length === 0 ? "（产物面：apps/web/dist 未构建，仅源码面）" : ` / ${input.artifacts.length} 个产物文件已扫`}`,
  }
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main: () => judge(scan()) })
    .then((code) => { process.exitCode = code })
    .catch((e: unknown) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
