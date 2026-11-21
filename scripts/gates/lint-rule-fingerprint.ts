/**
 * lint 规则集指纹（ISS-840 / W0-GATE-G4）—— 98 行锁住整个 lint 配置。
 *
 * ## 判什么
 *
 * 把 oxlint 配置里**每一条规则**归一化后算 sha256，与基线比对。改任何一条规则的存在性、
 * 严重级、参数 ⇒ 指纹变 ⇒ 红。移植自 DSH 官方 `~/dsh-src/scripts/lint-rule-fingerprint.spec.ts`。
 *
 * ## 归一化（逐字照抄官方 `:44-62`，一行不改）
 *
 * ```
 * 只留 severity > 0（off 丢弃） · 按键名排序 · severity 归成 1|2 数字 · 选项原样保留
 * ```
 *
 * ⇒ pin 的是**语义规则集**：`"error"` 与 `2` 同值、键序无关、`off` 不入哈希。
 *
 * ## ⛔ 与官方的三处**有意**分歧（都是我们的配置结构不同逼出来的，不是抄漏）
 *
 * ### ① profile 按射程拆，不按单聚合
 *
 * 官方 9 组 override 是**叠加式**（src / tests / 全局各自叠加），所以它能把几个 index 直接
 * `Object.assign` 成一个规则集。我们旧树是**互斥式**：
 *
 * | 组 | files | excludeFiles | 规则数 |
 * |---|---|---|---|
 * | ov0 | `forge-*\/src/**` | 无 | 69 |
 * | ov1 | `forge-*\/src/**` | `**\/*.test.ts` 等 4 条 | 6 |
 * | ov2 | `forge-*\/src/**\/*.test.ts` 等 | 无 | 6 |
 *
 * ov1 与 ov2 射程互斥（一个是"src 但非测试"，一个是"测试"），`Object.assign` 合并
 * = 让互斥的两个射程互相抹除。**实测：单聚合会漏检 5 条 error 规则**，删掉
 * ov1 的 `typescript/require-await` 指纹**一动不动**。
 *
 * 所以按**生效射程**拆成两个 profile：
 *   · `root:src`  = 顶层 rules + ov0 + ov1（src 里的非测试文件）
 *   · `root:test` = 顶层 rules + ov0 + ov2（src 里的 *.test.ts / *.spec.ts）
 * ov0 两边都要（它对 `forge-*\/src/**\/*.{ts,tsx}` 全射程生效，测试文件也吃它）。
 * 归一化本体没改，改的只是「哪些 override 属于同一个 profile」。
 *
 * ### ② 顶层 `rules` 是**基础层**，必须先叠
 *
 * oxlint 语义实测：顶层 `rules` 先写，overrides 在其上逐条覆盖。官方顶层 0 条不吃这条；
 * 旧树顶层也是 0 条；但 `.oxlintrc.next.json` **只有顶层 3 条、0 组 override** ——
 * 漏了这步，新树指纹恒为空集、永远不变、永远绿。
 *
 * ### ③ `members` 带**射程签名**，不只记 index
 *
 * 只记 index 时，配置里插一组或换顺序 ⇒  профиль 悄悄指向另一组规则（算的是别人的指纹）。
 * 基线里连 `files` / `excludeFiles` 一起记：射程一变就报"射程签名与登记不符"，
 * 而不是算出一个看似正常的错数。这条也顺带盖住"改射程 ⇒ 规则一条都不判了但规则集没变"
 * 那个形态（实测：把 `src/**` 改成 `src2/**`，规则集一字未改，oxlint 从报错变全绿）。
 *
 * ## JSONC 解析用 typescript，不用朴素正则（实测理由）
 *
 * 两份配置都是 JSONC（旧 76 行注释 / 新 26 行）。`require()` / `JSON.parse` 直接报
 * `Expected double-quoted property name`。而**朴素去注释正则会静默改值**：
 * `/*` 在我们的 glob 字符串里是合法内容（全仓 19 + 6 个字符串值含 `/*` 或 `*\/`），
 * `/\*[\s\S]*?\*\//g` 一跑，`["**\/node_modules/**","**\/dist/**"]` 变成
 * `["**\/node_modulesdist*"]` —— **解析成功、值全错**。那是最坏的一种红：不报错，只是算的是
 * 另一份配置的指纹。
 *
 * 所以用 `typescript` 的 `parseConfigFileTextToJson` —— 官方那份判据用的就是同一个函数
 * （`lint-rule-fingerprint.spec.ts:81`），且**本仓已有**（`forge-ui` / `forge-pm` 的
 * devDependency，5.9.3），零新依赖。实测它吃尾逗号 / 块注释 / 行内尾注释 / BOM / CRLF，
 * 且干净 JSON 上结果与 `JSON.parse` 全等。
 *
 * 取不到 typescript ⇒ `unjudged(no-binary)`，**不许降级成正则凑**（同
 * `scripts/code-inventory.mjs` §0 的纪律：解析不到就退出不出数）。
 *
 * ## 退出码（口径见 `scripts/lib/gate-runtime.ts`）
 *   0 = 过 · 1 = 红 · 2 = 判不了
 */
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "lint-rule-fingerprint"
const BASELINE_REL = "scripts/baseline/lint-rule-fingerprint.json"

/** typescript 按候选路径显式解析（工作树里没有这个包的 node_modules；同 `code-inventory.mjs:64-71`）。 */
export const TS_CANDIDATES = ["forge-ui/node_modules/typescript", "forge-pm/node_modules/typescript", "node_modules/typescript"]

export interface TsLike {
  parseConfigFileTextToJson(file: string, text: string): { config?: unknown; error?: { messageText?: unknown } }
}

/** 取 typescript；取不到返回 null（调用方判 `unjudged(no-binary)`，不是降级）。 */
export function loadTypescript(repo: string = REPO): TsLike | null {
  for (const candidate of TS_CANDIDATES) {
    try {
      const mod = createRequire(path.join(path.resolve(repo, candidate), "package.json"))("typescript") as TsLike
      if (typeof mod?.parseConfigFileTextToJson === "function") return mod
    } catch {
      // 换下一个候选
    }
  }
  return null
}

/** JSONC 文本 → 对象。失败返回 `{ error }`，不抛（解析错误要变成 finding，不是崩）。 */
export function parseJsonc(ts: TsLike, text: string): { config?: Record<string, unknown>; error?: string } {
  const r = ts.parseConfigFileTextToJson("oxlintrc.json", text)
  if (r.error) {
    const m = r.error.messageText
    const flat = typeof m === "string" ? m : { messageText: "" }
    return { error: JSON.stringify(flat).slice(0, 200) }
  }
  return isRecord(r.config) ? { config: r.config } : { error: "解析结果不是对象" }
}

type Rules = Record<string, unknown>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * 严重级 → `0 | 1 | 2`（官方 `:36-42` 逐字）。
 * 认不出的写法**抛**——由 `judgeFingerprint` 接住变成红，不许静默当 off。
 */
export function severity(value: unknown): 0 | 1 | 2 {
  const level = Array.isArray(value) ? value[0] : value
  if (level === "off" || level === 0) return 0
  if (level === "warn" || level === "warning" || level === 1) return 1
  if (level === "error" || level === 2) return 2
  throw new Error(`unsupported lint severity: ${JSON.stringify(level)}`)
}

/** 归一化（官方 `:44-52` **逐字**）：丢 off / 按键名排序 / severity 归一 / 选项原样留。 */
export function normalizedRules(rules: Rules): Rules {
  return Object.fromEntries(
    Object.entries(rules)
      .filter(([, value]) => severity(value) > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        const options = Array.isArray(value) ? value.slice(1) : []
        return [name, [severity(value), ...options]]
      }),
  )
}

/**
 * 叠一个 profile 的规则集：**先顶层 `rules`（基础层），再按 index 升序叠 overrides**。
 * 顺序即 oxlint 的生效顺序（实测：顶层 error + override off ⇒ 该文件不报）。
 */
export function mergeOverlay(base: Record<string, unknown>, overrides: readonly unknown[], indexes: readonly number[]): Rules {
  const merged: Rules = { ...base }
  for (const i of [...indexes].sort((a, b) => a - b)) {
    const ov = overrides[i]
    if (!isRecord(ov) || !isRecord(ov.rules)) throw new Error(`override #${i} 没有 rules 对象`)
    Object.assign(merged, ov.rules)
  }
  return merged
}

/** 归一化后的规则集 → sha256（`JSON.stringify` 顺序由归一化的排序钉死）。 */
export function fingerprint(normalized: Rules): string {
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

/** `files` / `excludeFiles` 的比较口径：字符串数组、**内部顺序无关**（oxlint 不 care 数组内顺序）。 */
function scopeOf(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return null
  return [...(v as string[])].sort()
}

function sameScope(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** 基线里的一条 profile。`members` 带射程签名（见文件头分歧 ③）。 */
export interface ProfileRecord {
  /** 相对仓库根的配置路径 */
  config: string
  /** 归一化后的规则条数（与 sha 一起判：数量对不上时读者知道差多少） */
  count: number
  sha256: string
  members: Array<{ index: number; files: string[] | null; excludeFiles: string[] | null }>
}

export interface Baseline {
  _meta?: { why?: string; todo?: string[] }
  profiles?: Record<string, ProfileRecord>
}

/** 读好的一份配置（`config` 为 null = 读不到 / 解析不了）。 */
export interface ParsedConfig {
  path: string
  config: Record<string, unknown> | null
  error?: string
}

/**
 * **纯函数**：配置已解析好 + 基线 → 判定。spec 直接喂构造数据，不碰文件系统。
 */
export function judgeFingerprint(configs: readonly ParsedConfig[], baseline: Baseline | null): GateResult {
  if (baseline === null) return unjudged(GATE, "no-baseline", `基线读不到：${BASELINE_REL}`)
  const profiles = baseline.profiles ?? {}
  const names = Object.keys(profiles).sort()
  if (names.length === 0) {
    return unjudged(GATE, "no-baseline", `基线里 0 个 profile —— 什么都没 pin，不算绿（${BASELINE_REL}）`)
  }

  const byPath = new Map(configs.map((c) => [c.path, c]))
  const findings: string[] = []
  const oks: string[] = []

  for (const name of names) {
    const p = profiles[name]
    const cfg = byPath.get(p.config)
    if (!cfg || cfg.config === null) {
      findings.push(`${name}：配置 ${p.config} 读不到或解析不了${cfg?.error ? `（${cfg.error}）` : ""} ⇒ 这一组规则没被 pin`)
      continue
    }
    const overrides = Array.isArray(cfg.config.overrides) ? cfg.config.overrides : []
    const topRules = isRecord(cfg.config.rules) ? cfg.config.rules : {}

    // 射程签名核对：index 只记位置，射程才是「这组规则管哪些文件」。
    let scopeBad = false
    for (const m of p.members) {
      const ov = overrides[m.index]
      if (!isRecord(ov)) {
        findings.push(`${name}：${p.config} 里没有 override #${m.index}（配置被删组或换了顺序）⇒ 射程签名失效`)
        scopeBad = true
        continue
      }
      if (!sameScope(scopeOf(ov.files), m.files) || !sameScope(scopeOf(ov.excludeFiles), m.excludeFiles)) {
        findings.push(
          `${name}：${p.config} override #${m.index} 的射程与登记不符 —— 登记 files=${JSON.stringify(m.files)} excludeFiles=${JSON.stringify(m.excludeFiles)}，` +
            `实际 files=${JSON.stringify(scopeOf(ov.files))} excludeFiles=${JSON.stringify(scopeOf(ov.excludeFiles))}`,
        )
        scopeBad = true
      }
    }
    if (scopeBad) continue

    let normalized: Rules
    try {
      normalized = normalizedRules(mergeOverlay(topRules, overrides, p.members.map((m) => m.index)))
    } catch (e) {
      // 严重级写法不认识 / override 没有 rules ⇒ 红，不是崩、也不是判不了
      findings.push(`${name}：规则集归一化失败（${(e as Error).message}）`)
      continue
    }
    const count = Object.keys(normalized).length
    const sha = fingerprint(normalized)
    if (count !== p.count) findings.push(`${name}：规则条数 ${count} ≠ 基线 ${p.count}（${p.config}）`)
    if (sha !== p.sha256) findings.push(`${name}：指纹 ${sha.slice(0, 16)}… ≠ 基线 ${p.sha256.slice(0, 16)}…（${p.config}）`)
    if (count === p.count && sha === p.sha256) oks.push(`${name} ${count} 条`)
  }

  // 覆盖率：**每一条带 rules 的 override 都必须至少属于一个 profile**。
  // 少登记一组 = 那组规则的改动不会让指纹红（静默漏检），这正是本判据存在的意义。
  for (const cfgPath of [...new Set(names.map((n) => profiles[n].config))].sort()) {
    const cfg = byPath.get(cfgPath)
    if (!cfg || cfg.config === null) continue
    const overrides = Array.isArray(cfg.config.overrides) ? cfg.config.overrides : []
    const covered = new Set(names.filter((n) => profiles[n].config === cfgPath).flatMap((n) => profiles[n].members.map((m) => m.index)))
    overrides.forEach((ov, i) => {
      if (!isRecord(ov) || !isRecord(ov.rules) || Object.keys(ov.rules).length === 0) return // 不带规则的组无规则可 pin
      if (!covered.has(i)) findings.push(`${cfgPath} override #${i} 不属于任何 profile ⇒ 改它的规则不会让指纹红（静默漏检）`)
    })
  }

  if (findings.length) return { gate: GATE, status: "failed", findings: findings.map((detail) => ({ detail })) }
  const todo = baseline._meta?.todo ?? []
  return {
    gate: GATE,
    status: "passed",
    detail: `${names.length} 个 profile 指纹一致（${oks.join(" · ")}）${todo.length ? `；⏳ 待登记 ${todo.length} 条：${todo.join(" / ")}` : ""}`,
  }
}

function readConfigs(ts: TsLike, baseline: Baseline): ParsedConfig[] {
  const paths = [...new Set(Object.values(baseline.profiles ?? {}).map((p) => p.config))].sort()
  return paths.map((rel) => {
    const abs = path.join(REPO, rel)
    try {
      const parsed = parseJsonc(ts, fs.readFileSync(abs, "utf8"))
      return parsed.config ? { path: rel, config: parsed.config } : { path: rel, config: null, error: parsed.error }
    } catch (e) {
      return { path: rel, config: null, error: (e as Error).message }
    }
  })
}

function readBaseline(): Baseline | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, BASELINE_REL), "utf8")) as Baseline
  } catch {
    return null
  }
}

function main(): GateResult {
  const baseline = readBaseline()
  if (baseline === null) return unjudged(GATE, "no-baseline", `基线读不到或不是合法 JSON：${BASELINE_REL}`)
  const ts = loadTypescript()
  if (ts === null) {
    return unjudged(GATE, "no-binary", `找不到 typescript（试过 ${TS_CANDIDATES.join(" / ")}）⇒ 没有可信的 JSONC 解析器，不降级成正则凑`)
  }
  return judgeFingerprint(readConfigs(ts, baseline), baseline)
}

if (isMain(import.meta.url)) {
  // ⚠️ 顶层不许 `await runGate(...)`：`--selftest` 会动态 import spec，而 spec 又静态 import 本文件
  //   ⇒ 本文件 TLA 未结算时 spec 永远等它 = 死锁（同 verify-plugin-shape.ts 的注释）。
  runGate({ name: GATE, main })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
