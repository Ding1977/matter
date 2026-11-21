/**
 * 外部 NodeNext 消费者契约守卫（ISS-882）—— 移植 DSH `scripts/verify-node-next-types.ts`，
 * 外层套 ISS-879/2261 的三态 fail-closed 载体（gate-runtime.runGate / unjudged）。
 *
 * ## 判什么
 *
 * 构建后的 lib/types 下 .d.ts 能否被**标准外部 NodeNext ESM 工程**消费：扫
 * packages 两层的 package.json 的公开 specifier（`types` + `exports[].types`），建临时
 * NodeNext ESM 工程软链所有包，生成 `index.ts` 逐个 `import * as modN`，用
 * `node node_modules/typescript/bin/tsc -p` 编译。编译不过 ⇒ 红（公开 API 不可消费）。
 *
 * 另保留 DSH 的轻量预检：扫 lib/types 下 .d.ts 里相对 specifier 无扩展名（NodeNext
 * 必报），先报这批带 文件:行 的错——这是 deficit 的可定位来源。
 *
 * ## 三态 fail-closed（退出码 = gate-runtime 口径：0 绿 / 1 红 / 2 判不了）
 *
 * | 观测 | 判定 |
 * |---|---|
 * | 相对 specifier 无扩展名 / 外部编译失败 | ⛔ 红（exit 1） |
 * | 全部构好、外部编译通过 | ✅ 绿（exit 0） |
 * | build 产物缺失（`missingOutputs`）/ 0 包 / 0 specifier / 无 typescript | ⚠️ 判不了（exit 2，理由码） |
 *
 * **与 DSH 的唯一有意差异**：DSH 原样在 `missingOutputs` 时 `process.exit(1)` 判红
 * （`verify-node-next-types.ts:102-106`）。本树 6 包中部分未 build 是**环境态**（`lib/` 是
 * .gitignore 产物，随构建走不随 clone 走），照抄会把环境缺料冒充真缺陷 ⇒ 改为
 * `unjudged(no-build)`，不冒绿也不判红。typescript 找不到 ⇒ `no-binary`；
 * 0 包 / 0 specifier ⇒ `no-corpus`。三态均单列退 2，理由码见 reason。
 *
 * ## 为什么是外部工程编译，而不是仓内 tsc
 *
 * `publint-all` 只验包结构（字段齐不齐），不验真实消费者能否 `import` 到类型。仓内
 * typecheck 走 workspace 解析（paths/源码可达），掩盖了 `exports.types` 指错、声明里
 * 无扩展名相对 specifier 等只在 NodeNext 严格解析下才暴露的问题。本判据造一个与仓库
 * 无 paths/无源码可达的干净 ESM 工程，只靠软链 + exports 字段解析，才验到消费者视角。
 */
import { execFileSync } from "node:child_process"
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-node-next-types"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

interface ExportTarget { types?: string }
interface PackageManifest {
  name?: string
  types?: string
  exports?: Record<string, ExportTarget | string | null>
}
export interface WorkspacePackage {
  dir: string
  name: string
  manifest: PackageManifest
}

/** 读一个 package.json；无 name 不算包。 */
export function readPackage(absPath: string): WorkspacePackage | null {
  let manifest: PackageManifest
  try {
    manifest = JSON.parse(readFileSync(absPath, "utf8")) as PackageManifest
  } catch {
    return null
  }
  if (!manifest.name) return null
  return { dir: path.dirname(absPath), name: manifest.name, manifest }
}

/** 本树包发现：只扫 packages 两层下的 package.json（无 DSH 的 vendor 旧树）。 */
export function workspacePackages(root: string = REPO): WorkspacePackage[] {
  return globSync("packages/*/*/package.json", { cwd: root })
    .map((rel) => readPackage(path.resolve(root, rel)))
    .filter((pkg): pkg is WorkspacePackage => pkg !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 声明里的相对 specifier（from / import() / import / declare module）。 */
const declarationSpecifierPattern = /(?:from\s*|import\s*\(\s*|import\s+|declare\s+module\s*)["'](\.{0,2}(?:\/[^"']*)?)["']/g
const hasExtension = /\.[^/.]+$/

/** 一条「相对 specifier 无扩展名」违规。 */
export interface BadSpecifier { file: string; line: number; specifier: string }

/**
 * 预检：扫 lib/types 下所有 .d.ts，报相对 specifier 无扩展名（NodeNext 必报）。
 * filesOverride 供 spec 在临时语料上直接喂相对路径。
 */
export function relativeSpecifiersMissingExtensions(
  root: string = REPO,
  filesOverride?: readonly string[],
): BadSpecifier[] {
  const errors: BadSpecifier[] = []
  const files = filesOverride
    ? [...new Set(filesOverride.map((f) => f.replaceAll("\\", "/")))].sort()
    : globSync("packages/*/*/lib/types/**/*.d.ts", { cwd: root }).sort()
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(path.resolve(root, file), "utf8")
    } catch {
      continue
    }
    for (const match of text.matchAll(declarationSpecifierPattern)) {
      const specifier = match[1]
      if (!specifier) continue
      const isRelative = specifier === "." || specifier.startsWith("./") || specifier.startsWith("../")
      if (isRelative && !hasExtension.test(specifier)) {
        const before = text.slice(0, match.index ?? 0)
        const line = before.split("\n").length
        errors.push({ file, line, specifier })
      }
    }
  }
  return errors
}

/** 从 `types` + `exports[].types` 构造公开 specifier（跳过 pattern key 与 ./package.json）。 */
export function publicSpecifiers(pkg: WorkspacePackage): string[] {
  const specifiers = new Set<string>()
  if (pkg.manifest.types) specifiers.add(pkg.name)
  for (const [key, target] of Object.entries(pkg.manifest.exports ?? {})) {
    if (key.includes("*") || key === "./package.json") continue
    if (typeof target !== "object" || target === null || !target.types) continue
    specifiers.add(key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`)
  }
  return [...specifiers].sort()
}

/** 缺 build 产物的包：`manifest.types` 指向的文件不在盘上。 */
export function missingOutputs(packages: readonly WorkspacePackage[], root: string = REPO): string[] {
  return packages
    .filter((pkg) => pkg.manifest.types && !existsSync(path.resolve(pkg.dir, pkg.manifest.types)))
    .map((pkg) => `${pkg.name}: missing ${pkg.manifest.types}`)
}

/** typescript 可执行入口候选（与外部工程 `node node_modules/typescript/bin/tsc` 同一路径）。 */
export const TSC_BIN = "node_modules/typescript/bin/tsc"

/** typescript 在不在（外部工程要 `node <root>/node_modules/typescript/bin/tsc`）。 */
export function hasTsc(root: string = REPO): boolean {
  return existsSync(path.resolve(root, TSC_BIN))
}

function linkPackage(pkg: WorkspacePackage, nodeModules: string): void {
  const parts = pkg.name.split("/")
  const link = path.resolve(nodeModules, ...parts)
  mkdirSync(path.dirname(link), { recursive: true })
  symlinkSync(pkg.dir, link, "dir")
}

/** 外部 NodeNext 工程配置（与 DSH 一致；skipLibCheck 让第三方声明的 lib noise 不遮我们的回归）。 */
export function consumerTsconfig(): Record<string, unknown> {
  return {
    compilerOptions: {
      target: "es2024",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      preserveSymlinks: true,
      noEmit: true,
      types: ["node"],
    },
    include: ["index.ts"],
  }
}

/**
 * 造临时外部工程、软链各包、生成 index.ts、编译。返回 tsc 输出（失败时非空）或 null（成功）。
 * 抛错由调用方转 failed finding（环境类已由 judge 前置挡掉，这里只可能是真编译问题）。
 */
export function compileExternal(
  packages: readonly WorkspacePackage[],
  root: string = REPO,
): { ok: boolean; output: string } {
  const tmp = mkdtempSync(path.resolve(root, ".node-next-types-"))
  try {
    const nodeModules = path.resolve(tmp, "node_modules")
    mkdirSync(nodeModules, { recursive: true })
    for (const pkg of packages) linkPackage(pkg, nodeModules)

    const rootTypes = path.resolve(root, "node_modules/@types/node")
    if (existsSync(rootTypes)) {
      const typesDir = path.resolve(nodeModules, "@types")
      mkdirSync(typesDir, { recursive: true })
      symlinkSync(rootTypes, path.resolve(typesDir, "node"), "dir")
    }

    writeFileSync(path.resolve(tmp, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`)
    writeFileSync(path.resolve(tmp, "tsconfig.json"), `${JSON.stringify(consumerTsconfig(), null, 2)}\n`)

    const imports = packages.flatMap(publicSpecifiers)
      .map((specifier, index) => `import * as mod${index} from ${JSON.stringify(specifier)};\nvoid mod${index};`)
      .join("\n")
    writeFileSync(path.resolve(tmp, "index.ts"), `${imports}\n`)

    // 走 tsc 的 JS 入口（不经 .bin shim）：shim 无扩展名在 Windows 不可 spawn（CVE-2024-27980），
    // .cmd 变体要 shell:true 且空格拼接不转义（DEP0190）—— 临时 tsconfig 路径有空格时危险。
    try {
      execFileSync(process.execPath, [path.resolve(root, TSC_BIN), "-p", path.resolve(tmp, "tsconfig.json"), "--pretty", "false"], {
        cwd: root,
        stdio: "pipe",
      })
      return { ok: true, output: "" }
    } catch (error: unknown) {
      const output = error as { stdout?: Buffer; stderr?: Buffer }
      return { ok: false, output: `${output.stdout?.toString() ?? ""}${output.stderr?.toString() ?? ""}` }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** judge 的纯输入。 */
export interface NextTypesInput {
  packages: readonly WorkspacePackage[]
  badSpecifiers: readonly BadSpecifier[]
  missing: readonly string[]
  hasTs: boolean
  /** 外部编译结果：null = 没跑（前置判不了）；否则为编译结果。 */
  compile: { ok: boolean; output: string } | null
}

/** 纯判定：观测 → GateResult。 */
export function judgeNextTypes(input: NextTypesInput): GateResult {
  // 判不了三态先于红绿：缺资源不许冒充绿，也不许拿环境态判红。
  if (!input.hasTs) return unjudged(GATE, "no-binary", "找不到 typescript（node_modules/typescript/bin/tsc）⇒ 外部编译做不了，判不了（不是绿）")
  if (input.packages.length === 0) return unjudged(GATE, "no-corpus", "packages/*/*/package.json 下 0 个包 —— 分母为 0 不许冒充绿")
  if (input.packages.flatMap(publicSpecifiers).length === 0) return unjudged(GATE, "no-corpus", `${input.packages.length} 个包没有一个声明公开 specifier（types / exports[].types）—— 没有可验的公开 API`)
  if (input.missing.length > 0) {
    return unjudged(GATE, "no-build", `build 产物缺失（${input.missing.length} 包），先 \`pnpm run build\`；这是环境态，不冒绿也不判红：\n${input.missing.join("\n")}`)
  }

  // 预检违规：带 文件:行 报（这里只有文件，行由调用方 spec 的注入实验用真实行号验证；
  // detail 里点名文件与 specifier，可定位到源头）。
  if (input.badSpecifiers.length > 0) {
    const findings: Finding[] = input.badSpecifiers.map((b) => ({
      file: b.file,
      line: b.line,
      detail: `相对 specifier 无扩展名 ${JSON.stringify(b.specifier)} —— NodeNext 下必报；补 .js 扩展名（指向产物）`,
    }))
    return { gate: GATE, status: "failed", findings }
  }

  if (input.compile === null) {
    return unjudged(GATE, "no-corpus", "没有外部编译结果（调用方未执行编译）⇒ 判不了")
  }
  if (!input.compile.ok) {
    const lines = input.compile.output.split("\n").filter(Boolean).slice(0, 12).join("\n")
    return {
      gate: GATE,
      status: "failed",
      findings: [{ file: "index.ts", detail: `外部 NodeNext 工程编译失败（tsc 出口非 0）：\n${lines}` }],
    }
  }
  return {
    gate: GATE,
    status: "passed",
    findings: [],
    detail: `${input.packages.length} 个包的公开 API 在外部 NodeNext ESM 工程编译通过。`,
  }
}

/** 现场采集：一次扫盘 + 在产物齐时编译一次，产出 judge 的纯输入。 */
export function collect(root: string = REPO): NextTypesInput {
  const packages = workspacePackages(root)
  const badSpecifiers = relativeSpecifiersMissingExtensions(root)
  const missing = missingOutputs(packages, root)
  const ts = hasTsc(root)
  // 前置缺资源或缺产物时不跑编译（省时），此时 compile=null，judge 先返回 unjudged。
  const compile = ts && packages.length > 0
    && packages.flatMap(publicSpecifiers).length > 0
    && missing.length === 0
    && badSpecifiers.length === 0
    ? compileExternal(packages, root)
    : null
  return { packages, badSpecifiers, missing, hasTs: ts, compile }
}

async function cli(): Promise<number> {
  const args = process.argv.slice(2)
  const rootArg = args.indexOf("--root")
  const root = rootArg >= 0 && args[rootArg + 1] ? path.resolve(args[rootArg + 1]) : REPO
  let input: NextTypesInput
  try {
    input = collect(root)
  } catch (e) {
    console.error(`✗ ${GATE}: 扫盘/编译失败（${(e as Error).message}）⇒ 判不了（不是绿）`)
    return 2
  }
  return runGate({ name: GATE, main: () => judgeNextTypes(input) })
}

if (isMain(import.meta.url)) {
  cli()
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
