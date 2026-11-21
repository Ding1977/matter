/**
 * 类型棘轮（ISS-739）—— 按错误类别分桶 + dry-run 写入。
 *
 * 依据：`docs/plans-k-replacement-2026-11-09.md` §4.3。
 * 旧口径两个缺陷：
 *   ① 按包记单一上限：把「环境缺失」（TS2307/TS2591/TS7016）和「代码写错」混成一笔账，
 *      正当重构（把三份实现收进内核）必然抬高接收方上限 ⇒ 撞红线；
 *   ② `--write` 先写盘再报错：退出码 1 只是道歉，盘已经改了。
 *
 * 新口径：
 *   · **逻辑类**：硬棘轮，`current > ceiling` ⇒ 红，**无抬升通道**（要抬必须改判据并过审查）
 *   · **环境类**：不计上限，只记「清单只许缩」——新增 ⇒ 红，修掉 ⇒ 提示可摘
 *   · `--write` 默认 **dry-run**：只输出 diff、不落盘；`--write --commit --reason "<理由>"` 才写
 *   · 总错误数只报不判（避免「修一桶涨另一桶」时总数掩盖真相）
 */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const BASELINE = path.join(REPO, "scripts/baseline/type-ratchet.json")
/**
 * 文件级基线（ISS-796 洞 2）。与包级基线分文件，理由见 `FileBaseline` 的注释。
 */
const FILE_BASELINE = path.join(REPO, "scripts/baseline/type-ratchet-files.json")
/** 文件级基线的口径标签。读到不认识的 unit ⇒ 判不了（改口径必须连它一起改，否则读数不可比）。 */
const FILE_UNIT = "logic-errors-per-file"
const ENV_CODES = new Set(["TS2307", "TS2591", "TS7016"])
const NON_WORKSPACE_TARGETS = ["electron-shell"]

export interface FamilyBaseline {
  logic: Record<string, number>
  env: Record<string, string[]>
}
export interface Baseline {
  recordedAt?: string
  families?: Record<string, FamilyBaseline>
  lastWrite?: { at?: string; reason?: string; from?: number | null; to?: number | null }
}
export interface PkgDiags {
  family: string
  pkg: string
  codes: string[]
  /**
   * 文件级诊断（ISS-796）：`仓库相对路径 → 错误码列表`。
   * 缺省 = 这一包没采到文件级数据（老调用方 / 只喂构造数据）⇒ 文件级判据跳过，不因此放绿也不因此报红。
   */
  byFile?: Record<string, string[]>
}

/**
 * 文件级棘轮基线（ISS-796）：`仓库相对路径 → 逻辑类错误条数`。
 *
 * 为什么与包级基线分两个文件：包级记的是「每个包的上限」（`type-ratchet.json`），
 * 文件级记的是「每个文件的上限」（本文件）。合并会逼着两套棘轮共用一个 lastWrite，
 * 而它们的抬升理由往往不同（收进内核抬包级、拆文件改文件级）。
 */
export interface FileBaseline {
  recordedAt?: string
  /** 口径标签：改口径必须连它一起改，读到不认识的 unit 就判不了（不冒充绿） */
  unit?: string
  /** 仓库相对路径 → 逻辑类错误条数 */
  files?: Record<string, number>
  lastWrite?: { at?: string; reason?: string; from?: number | null; to?: number | null }
}

export function splitCodes(codes: string[]): { logic: number; env: string[] } {
  const env = [...new Set(codes.filter((c) => ENV_CODES.has(c)))].sort()
  return { logic: codes.filter((c) => !ENV_CODES.has(c)).length, env }
}

/**
 * 从 tsc 原始行抽「文件 → 错误码列表」（ISS-796）。
 *
 * 为什么要文件级（洞 2）：包级棘轮只记「一个包总共多少条逻辑错」。
 * ⇒ 同一包内「删掉 1 条旧错 + 新增 1 条新错」总数不变 ⇒ 判绿。
 * 这不是理论风险：包级上限是 165 的文件里，删一条补一条可以无限次通过。
 *
 * 输入形状是 `runTsc` 返回的原始行（带路径）：
 *   `lib/agent-channels.js(67,5): error TS2741: Property 'x' is missing ...`
 * 路径是**相对包根**的（tsc -p 的 cwd 是包目录）⇒ 拼上包名才是仓库相对路径。
 *
 * @param lines tsc 输出里含 `error TS\d+` 的行
 * @param pkg 包名（拼成 `forge-x/lib/a.js` 这样的仓库相对路径）；缺省不拼
 */
export function groupByFile(lines: string[], pkg = ""): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const l of lines) {
    const m = /^(.+?)\(\d+,\d+\):\s*error (TS\d+)/.exec(l)
    if (!m) continue
    const f = m[1].trim()
    if (!f) continue
    const key = pkg ? `${pkg}/${f}` : f
    ;(out[key] ??= []).push(m[2])
  }
  return out
}

/**
 * 文件级判定（四条，与任务书 §2.4 同口径）：
 *   · 文件不在基线，且有逻辑错  ⇒ ⛔ 红（新文件零容忍）
 *   · 文件在基线，错误数 > 记录  ⇒ ⛔ 红
 *   · 文件在基线，错误数 < 记录  ⇒ ✅ 绿 + 提示「可收线」
 *   · 文件在基线，错误数 = 记录  ⇒ ✅ 绿
 *
 * 环境类错误不进文件级计数（与包级 `splitCodes` 同口径）：`TS2307/TS2591/TS7016`
 * 是「依赖没装 / 类型包缺」，不是这个文件写错了；把它算进来会让「装个依赖」表现为「改好了代码」。
 */
export function judgePerFile(cur: Record<string, string[]>, base: Record<string, number> | undefined): { findings: string[]; hints: string[] } {
  const findings: string[] = []
  const hints: string[] = []
  const b = base ?? {}
  for (const [f, codes] of Object.entries(cur)) {
    const logic = splitCodes(codes).logic
    if (!(f in b)) {
      if (logic > 0) findings.push(`${f}：新增文件有 ${logic} 条逻辑类错（新文件必须零错）`)
    } else if (logic > b[f]) {
      findings.push(`${f}：逻辑类 ${logic} > 记录 ${b[f]}`)
    } else if (logic < b[f]) {
      hints.push(`${f}：逻辑类 ${logic} < ${b[f]}，可收线`)
    }
  }
  return { findings, hints }
}

/**
 * 纯函数：诊断 + 基线 → 判定（spec 直接喂构造数据）。
 *
 * `fileBaseline` 是**可选**的第二层（ISS-796 洞 2）：包级判完再判文件级。
 * 为什么可选：老调用方与 spec 只喂 `codes`（没有 `byFile`）时，文件级无从判起 ——
 * 此时**跳过**文件级，但包级照判（不因为缺一层就整格放绿，也不因缺一层就报红）。
 */
export function judgeTypeRatchet(diags: PkgDiags[], baseline: Baseline | null, fileBaseline?: FileBaseline | null): GateResult {
  const gate = "verify-type-ratchet"
  if (!baseline) return unjudged(gate, "no-baseline", `基线不存在：${path.relative(REPO, BASELINE)}`)
  const findings: string[] = []
  const hints: string[] = []
  for (const d of diags) {
    const base = baseline.families?.[d.family] ?? { logic: {}, env: {} }
    const { logic, env } = splitCodes(d.codes)
    const cap = base.logic[d.pkg]
    if (cap === undefined) {
      if (logic > 0) findings.push(`${d.family}/${d.pkg}：逻辑类 ${logic} 条，但基线没有记录（首次记录前不许有逻辑错）`)
    } else if (logic > cap) {
      findings.push(`${d.family}/${d.pkg}：逻辑类 ${logic} > 上限 ${cap}（硬棘轮，无抬升通道）`)
    } else if (logic < cap) {
      hints.push(`${d.family}/${d.pkg}：逻辑类 ${logic} < ${cap}，可收线`)
    }
    const wasEnv = new Set(base.env[d.pkg] ?? [])
    const added = env.filter((c) => !wasEnv.has(c))
    if (added.length) findings.push(`${d.family}/${d.pkg}：新增环境债 ${added.join("、")}（清单只许缩）`)
    const removed = [...wasEnv].filter((c) => !env.includes(c))
    if (removed.length) hints.push(`${d.family}/${d.pkg}：环境债已摘 ${removed.join("、")}`)
  }
  // 文件级：把各包 byFile 合并后一次判（基线是一张全局表，按仓库相对路径索引）。
  const merged: Record<string, string[]> = {}
  for (const d of diags) for (const [f, codes] of Object.entries(d.byFile ?? {})) (merged[f] ??= []).push(...codes)
  const hasFileData = diags.some((d) => d.byFile !== undefined)
  if (hasFileData && fileBaseline !== undefined) {
    if (!fileBaseline) {
      // 有文件级数据却没有文件级基线 ⇒ 判不了（不冒充绿：那等于这一层默认关着）
      return unjudged(gate, "no-baseline", `文件级基线不存在：${path.relative(REPO, FILE_BASELINE)}（有文件级诊断却无基线 ⇒ 不判）`)
    }
    const per = judgePerFile(merged, fileBaseline.files)
    findings.push(...per.findings)
    hints.push(...per.hints)
  }
  return findings.length
    ? { gate, status: "failed", findings: findings.map((detail) => ({ detail })) }
    : { gate, status: "passed", findings: [], detail: hints.length ? hints.slice(0, 6).join("；") : undefined }
}

/** 纯函数：把本次文件级诊断生成「下一版文件级基线」。 */
export function buildNextFiles(diags: PkgDiags[], prev: FileBaseline | null): FileBaseline {
  const files: Record<string, number> = {}
  for (const d of diags) {
    for (const [f, codes] of Object.entries(d.byFile ?? {})) {
      files[f] = (files[f] ?? 0) + splitCodes(codes).logic
    }
  }
  return { recordedAt: new Date().toISOString().slice(0, 10), unit: FILE_UNIT, files, lastWrite: prev?.lastWrite }
}

/** 纯函数：文件级基线的升降 diff（抬升必须显式，故这里逐文件列）。 */
export function diffTextFiles(prev: FileBaseline | null, next: FileBaseline): string {
  const a = prev?.files ?? {}
  const b = next.files ?? {}
  const lines: string[] = []
  for (const f of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[f]
    const y = b[f]
    if (x === y) continue
    lines.push(`${f} logic: ${x ?? "(无)"} → ${y ?? "(无)"} ${x !== undefined && y !== undefined && y > x ? "⛔ 抬升" : ""}`)
  }
  return lines.join("\n")
}

/** 纯函数：把本次诊断生成「下一版基线」（保留 recordedAt 以外的治理字段）。 */
export function buildNext(diags: PkgDiags[], prev: Baseline | null): Baseline {
  const families: Record<string, FamilyBaseline> = {}
  for (const d of diags) {
    families[d.family] ??= { logic: {}, env: {} }
    const { logic, env } = splitCodes(d.codes)
    families[d.family].logic[d.pkg] = logic
    if (env.length) families[d.family].env[d.pkg] = env
  }
  return { recordedAt: new Date().toISOString().slice(0, 10), families, lastWrite: prev?.lastWrite }
}

/** 纯函数：人类可读 diff（不要求 unified 格式，但要能看出每包升降）。 */
export function diffText(prev: Baseline | null, next: Baseline): string {
  const lines: string[] = []
  const fams = new Set([...Object.keys(prev?.families ?? {}), ...Object.keys(next.families ?? {})])
  for (const fam of [...fams].sort()) {
    const a = prev?.families?.[fam] ?? { logic: {}, env: {} }
    const b = next.families?.[fam] ?? { logic: {}, env: {} }
    const pkgs = new Set([...Object.keys(a.logic), ...Object.keys(b.logic)])
    for (const pkg of [...pkgs].sort()) {
      const x = a.logic[pkg]
      const y = b.logic[pkg]
      if (x === y) continue
      lines.push(`${fam}/${pkg} logic: ${x ?? "(无)"} → ${y ?? "(无)"} ${x !== undefined && y !== undefined && y > x ? "⛔ 抬升" : ""}`)
    }
    const envPkgs = new Set([...Object.keys(a.env), ...Object.keys(b.env)])
    for (const pkg of [...envPkgs].sort()) {
      const x = (a.env[pkg] ?? []).join(",")
      const y = (b.env[pkg] ?? []).join(",")
      if (x !== y) lines.push(`${fam}/${pkg} env: [${x}] → [${y}]`)
    }
  }
  return lines.join("\n")
}

/** 纯函数：抬升必须有理由；没有抬升则随便写。 */
export function canCommit(prev: Baseline | null, next: Baseline, reason: string | undefined): { ok: boolean; why?: string } {
  let raised = false
  for (const [fam, b] of Object.entries(next.families ?? {})) {
    const a = prev?.families?.[fam] ?? { logic: {}, env: {} }
    for (const [pkg, n] of Object.entries(b.logic)) if (n > (a.logic[pkg] ?? 0)) raised = true
    for (const [pkg, codes] of Object.entries(b.env)) {
      const was = new Set(a.env[pkg] ?? [])
      if (codes.some((c) => !was.has(c))) raised = true
    }
  }
  if (raised && !reason?.trim()) return { ok: false, why: "本次有抬升但没给 --reason（抬升必须说明「为什么这次抬升是合法的」）" }
  return { ok: true }
}

// ── 扫描（IO 层；纯逻辑在上面）──────────────────────────────────────────────

const FAMILIES = [
  { key: "host", cfg: "tsconfig.lib.json", include: (p: string) => fs.existsSync(path.join(REPO, p, "lib")) && fs.existsSync(path.join(REPO, p, "tsconfig.lib.json")) },
  { key: "client", cfg: "tsconfig.json", include: (p: string) => fs.existsSync(path.join(REPO, p, "src")) && fs.existsSync(path.join(REPO, p, "tsconfig.json")) },
  { key: "shell", cfg: "tsconfig.lib.json", include: (p: string) => p === "electron-shell" && fs.existsSync(path.join(REPO, p, "tsconfig.lib.json")) },
]

function tscBin(): string | null {
  for (const c of ["forge-ui/node_modules/typescript/bin/tsc", "forge-pm/node_modules/typescript/bin/tsc", "node_modules/typescript/bin/tsc"]) {
    if (fs.existsSync(path.join(REPO, c))) return path.join(REPO, c)
  }
  return null
}

function targets(include: (p: string) => boolean): string[] {
  const ws = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).workspaces ?? []
  return [...ws, ...NON_WORKSPACE_TARGETS].filter(include)
}

/** 并发池：不依赖第三方，n 路消费（结果保序）。 */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/** 跑一个包的 tsc，返回**错误行**（异步；artifactOnly 需要原始行判断）。 */
function runTsc(tsc: string, pkg: string, cfg: string): Promise<string[]> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tsc, "-p", cfg, "--noEmit"], { cwd: path.join(REPO, pkg), stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (out += d))
    p.on("error", () => resolve([]))
    p.on("close", () => resolve(out.split("\n").filter((l) => /error TS\d+/.test(l))))
  })
}

/**
 * `--changed` 的收窄：只跑改动包。**收窄必须出声**——空改动 / 根文件 / git 失败一律降级全量，
 * 否则「只跑了 2 包」会被读成「全仓都干净」。
 */
function changedScope(): { full: boolean; why?: string; pkgs: Set<string> } {
  const base = process.env.FORGE_RATCHET_BASE || "main"
  let files: string[] = []
  try {
    files = execFileSync("git", ["diff", "--name-only", base], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean)
    files.push(
      ...execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" })
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean),
    )
  } catch (e) {
    return { full: true, why: `git 取改动失败（${(e as Error).message}）`, pkgs: new Set() }
  }
  if (!files.length) return { full: true, why: "改动面为空（空集不等于没改动）", pkgs: new Set() }
  const pkgs = new Set<string>()
  for (const f of files) {
    const top = f.split("/")[0]
    if (top.startsWith("forge-") || top === "electron-shell") pkgs.add(top)
    else return { full: true, why: `改动含非包路径 ${f}`, pkgs: new Set() }
  }
  return { full: false, pkgs }
}

async function scan(pkgFilter?: string, changedOnly = false): Promise<{ diags: PkgDiags[]; skips: string[] }> {
  const tsc = tscBin()
  if (!tsc) return { diags: [], skips: ["找不到 typescript/bin/tsc ⇒ 本族判不了"] }
  const scoped = changedOnly ? changedScope() : null
  if (scoped?.full) console.log(`⚠️ --changed 降级为全量：${scoped.why}`)
  const jobs: { fam: (typeof FAMILIES)[number]; pkg: string }[] = []
  const skips: string[] = []
  for (const fam of FAMILIES) {
    for (const pkg of targets(fam.include)) {
      if (pkgFilter && pkg !== pkgFilter) continue
      if (scoped && !scoped.full && !scoped.pkgs.has(pkg)) continue
      if (pkg === "electron-shell" && process.platform !== "darwin") {
        skips.push(`${fam.key}/${pkg}：非 darwin 平台不判（ISS-823）`)
        continue
      }
      if (pkg === "electron-shell" && !["@types", "electron", "bun-types"].every((n) => fs.existsSync(path.join(REPO, pkg, "node_modules", n)))) {
        skips.push(`${fam.key}/${pkg}：未装齐 node_modules ⇒ 计数不可信（ISS-774）`)
        continue
      }
      jobs.push({ fam, pkg })
    }
  }
  const concurrency = Math.max(1, Number(process.env.FORGE_RATCHET_CONCURRENCY) || 4)
  const results = await pool(jobs, concurrency, async (j) => ({ j, lines: await runTsc(tsc, j.pkg, j.fam.cfg) }))
  const diags: PkgDiags[] = []
  for (const { j, lines } of results) {
    if (lines.length && lines.every((l) => /error TS2307/.test(l) && /\.generated['"]/.test(l))) {
      skips.push(`${j.fam.key}/${j.pkg}：只有 .generated 缺失 ⇒ 未构建产物，不判`)
      continue
    }
    diags.push({
      family: j.fam.key,
      pkg: j.pkg,
      codes: lines.map((l) => /error (TS\d+)/.exec(l)?.[1] ?? "TS?"),
      // 文件级聚合（ISS-796 洞 2）：`runTsc` 的原始行带路径，拼上包名成仓库相对路径。
      byFile: groupByFile(lines, j.pkg),
    })
  }
  return { diags, skips }
}

function readBaseline(): Baseline | null {
  if (!fs.existsSync(BASELINE)) return null
  return JSON.parse(fs.readFileSync(BASELINE, "utf8"))
}

/**
 * 读文件级基线（ISS-796）。
 *
 * 返回 `null` = 「这一层判不了」（文件不在 / 读不动 / unit 不认识），由 judge 转成 unjudged。
 * ⚠️ 三种情形**都**返回 null 而不是 undefined：undefined 是「调用方没开这一层」的语义（spec 用），
 * 若把「文件不在」也映射成 undefined，那么**删掉基线文件就能让文件级判据永久关掉** ——
 * 那正是 gate-runtime 头注里点名的旧洞（「基线不存在 ⇒ exit 0 等于删基线就永久变绿」）。
 */
function readFileBaseline(): FileBaseline | null {
  if (!fs.existsSync(FILE_BASELINE)) {
    console.error(`✗ 文件级基线不在：${path.relative(REPO, FILE_BASELINE)} ⇒ 判不了（删基线不能让这一层关掉）`)
    return null
  }
  let b: FileBaseline
  try {
    b = JSON.parse(fs.readFileSync(FILE_BASELINE, "utf8"))
  } catch (e) {
    console.error(`✗ 文件级基线读不动：${(e as Error).message} ⇒ 不判（不拿空表当「全都没有记录」）`)
    return null
  }
  if (b.unit !== undefined && b.unit !== FILE_UNIT) {
    console.error(`✗ 文件级基线 unit=${JSON.stringify(b.unit)} ≠ ${JSON.stringify(FILE_UNIT)} ⇒ 判不了（口径改了，旧基线不可比）`)
    return null
  }
  return b
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function cli(): Promise<number> {
  // --selftest 必须先分流：否则会先跑一遍全量 tsc 再进 spec（白等 3 分钟）。
  if (process.argv.includes("--selftest")) return runGate({ name: "verify-type-ratchet", main: () => judgeTypeRatchet([], readBaseline()) })

  const writeMode = process.argv.includes("--write")
  if (writeMode && arg("--pkg")) {
    // 棘轮写基线必须全量：局部扫描生成的 next 不含其他包 ⇒ 落盘会**静默删掉**它们的记录。
    console.error("✗ --write 不接受 --pkg：局部写会静默删掉其他包的记录；写基线请全量，读判据可用 --pkg 收窄")
    return 1
  }
  if (writeMode && process.argv.includes("--changed")) {
    console.error("✗ --write 不接受 --changed：局部写会静默删掉其他包的记录；写基线请全量")
    return 1
  }
  if (writeMode) {
    const prev = readBaseline()
    const prevFiles = (() => {
      if (!fs.existsSync(FILE_BASELINE)) return null
      try {
        return JSON.parse(fs.readFileSync(FILE_BASELINE, "utf8")) as FileBaseline
      } catch {
        return null
      }
    })()
    const { diags, skips } = await scan(undefined, false)
    for (const s of skips) console.log(`  · 跳过 ${s}`)
    const next = buildNext(diags, prev)
    const nextFiles = buildNextFiles(diags, prevFiles)
    console.log(diffText(prev, next) || "（包级基线无变化）")
    console.log(diffTextFiles(prevFiles, nextFiles) || "（文件级基线无变化）")
    if (!process.argv.includes("--commit")) {
      console.log('dry-run：未落盘。确认后加 --commit --reason "<为什么这次抬升是合法的>"')
      return 0
    }
    const gate = canCommit(prev, next, arg("--reason"))
    if (!gate.ok) {
      console.error(`✗ ${gate.why}`)
      return 1
    }
    // 文件级抬升同样要理由（同一条纪律：抬升 = 重新定义什么叫可接受）
    const fileRaises = Object.entries(nextFiles.files ?? {}).filter(([f, n]) => n > ((prevFiles?.files ?? {})[f] ?? 0))
    if (fileRaises.length && !arg("--reason")?.trim()) {
      console.error(`✗ 文件级有 ${fileRaises.length} 个文件抬升但没给 --reason（抬升必须说明为什么合法）`)
      return 1
    }
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
    fs.writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n")
    const fileOut: FileBaseline = {
      ...nextFiles,
      lastWrite: {
        at: new Date().toISOString(),
        reason: arg("--reason") ?? null,
        from: prevFiles ? Object.values(prevFiles.files ?? {}).reduce((a, b) => a + b, 0) : null,
        to: Object.values(nextFiles.files ?? {}).reduce((a, b) => a + b, 0),
      },
    }
    fs.writeFileSync(FILE_BASELINE, JSON.stringify(fileOut, null, 2) + "\n")
    console.log(`✓ 已落盘（包级 + 文件级：${Object.keys(fileOut.files ?? {}).length} 个文件有逻辑错）`)
    return 0
  }
  const { diags, skips } = await scan(arg("--pkg"), process.argv.includes("--changed"))
  for (const s of skips) console.log(`  · 跳过 ${s}`)
  return runGate({ name: "verify-type-ratchet", main: () => judgeTypeRatchet(diags, readBaseline(), readFileBaseline()) })
}

if (isMain(import.meta.url)) {
  // 顶层不 await：--selftest 会 import spec、spec 又 import 本文件，TLA 会死锁（ISS-737 踩过）。
  cli()
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ verify-type-ratchet: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
