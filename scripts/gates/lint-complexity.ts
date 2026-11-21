/**
 * 函数复杂度红线（ISS-841 / W0-GATE-G5）—— 新树（S3）专用。
 *
 * ## 为什么要有这条
 *
 * DSH 官方**没有任何复杂度判据**（`grep -rn "complexity|max-depth|max-lines-per-function"
 * ~/dsh-src/.oxlintrc.json` 零命中），它靠审查纪律活着：最长手写文件 3,607 行、
 * 最长函数 1,513 行。老板点名「不要过分嵌套」，DSH 给不了答案 ⇒ 必须自补。
 *
 * ## 三条判据（**文件行数不在这里**）
 *
 * 三阈值均为**本仓自补 + DSH 分布支撑**（DSH 官方无此类门禁，可参 `docs/memory/dsh-complexity-distribution-2026-11-18.md`
 * 与 `dsh-style-alignment-2026-11-14.md`）；分布用判据同一引擎 oxlint 1.76.0 `max=0` 实测抽取，非估算。
 *
 * | 判据 | 阈值 | 依据（DSH packages/ 5,901 文件实测） |
 * |---|---|---|
 * | 函数行数 | ≤100 | DSH 36,504 函数实测 p99=94（前例 TS-AST 口径）；oxlint 口径 p99=129，尾部口径差异据实记录于 docs。老板裁决不动 |
 * | 嵌套层数 | ≤4 | 每函数最大嵌套 **p99=4**、p99.9=5、max=8（oxlint `max-depth` 同口径）⇒ 4 = p99 自然边界 |
 * | 圈复杂度 | ≤15 | **p99=12、p99.5=17**、max=219、>15 仅 0.62%（oxlint `complexity` 同口径）⇒ 15 在 p99 与 p99.5 之间 |
 *
 * ⛔ 文件级 `max-lines` 归 **ISS-842（G6 `verify-file-size-new`）**。两格都判文件行数 =
 * 同一个缺陷红两次，且两处阈值迟早漂移。本判据的射程**故意**不含文件行数。
 *
 * ## 为什么用 oxlint 而不是自写 AST
 *
 * oxlint 1.76.0 原生带这三条 eslint 规则（实测输出见工单 note）。自写 AST 要重新实现
 * 三条判据，是重复实现；引入 lizard 则是多一个依赖。
 *
 * ⚠️ **本文件不硬编码阈值**。阈值的执行真相是 `.oxlintrc.next.json`（oxlint 从那里读），
 * 本文件只**读回来**并与 `CANONICAL` 对账：两件事 ——
 *   ① 少一份副本 ⇒ 不存在「配置改了、判据还按老数报」的漂移；
 *   ② `CANONICAL` 钉住**老板拍过的数**，有人偷偷把 100 改成 200 会被这里判红。
 *
 * ## 「判不了」的三态（防空转，全部 fail-closed）
 *
 * | 情形 | 结果 | 理由码 |
 * |---|---|---|
 * | `packages/` 下 0 个 `.ts/.tsx`（**新树 W1 之前的真实状态**） | unjudged | `no-corpus` |
 * | oxlint 二进制不在 | unjudged | `no-binary` |
 * | `.oxlintrc.next.json` 缺失 / 解析不了 / 阈值与 `CANONICAL` 不符 | unjudged | `no-rule-table` |
 * | 我数的文件数 ≠ oxlint 判的文件数 | unjudged | `no-binary` |
 *
 * ⛔ **0 个文件绝不许判绿**：那正是「新树一行 lint 都没跑，屏幕上却是 ✓」的假绿形态
 * （`docs/memory/gate-scan-L0-2026-11-14.md` 实测记录的就是这个形态）。
 *
 * ## 解析错误也算红（不改判成绿）
 *
 * 配置里 `categories.correctness: "off"` 且只开三条规则 ⇒ oxlint 只会多报一类：
 * **文件根本解析不了**（实测：坏文件 `export function oops( {` 即使全关规则仍报
 * `Expected \`:\` but found \`decimal\``，诊断无 `code` 字段）。
 * 那种文件**没有复杂度可言**，判绿等于「解析不了 = 合规」。归成 finding（红）。
 *
 * ## 退出码（口径见 `scripts/lib/gate-runtime.ts`）
 *   0 = 过 · 1 = 红 · 2 = 判不了
 */
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "lint-complexity"

/** 新树根：`packages/<group>/<pkg>/…`（S3 目标形态，见 docs/memory/gate-scan-L0-2026-11-14.md）。 */
export const CORPUS_ROOT = "packages"
/** 新树专用配置（**不是**根 `.oxlintrc.json` —— 那是旧树的，ISS-713）。 */
export const CONFIG_REL = ".oxlintrc.next.json"

/**
 * 老板拍过的阈值（工单正文）。配置读出来的数必须与这里逐项相等，否则判不了 ——
 * 这是**唯一**允许写死数字的地方：它是决策记录，不是执行参数。
 */
export const CANONICAL = { maxDepth: 4, complexity: 15, maxLinesPerFunction: 100 } as const

export interface Thresholds {
  maxDepth: number
  complexity: number
  maxLinesPerFunction: number
}

/** 三条规则名 → Thresholds 字段。oxlint 的 code 形如 `eslint(max-depth)`。 */
const RULES: Record<string, keyof Thresholds> = {
  "max-depth": "maxDepth",
  complexity: "complexity",
  "max-lines-per-function": "maxLinesPerFunction",
}

export interface Diagnostic {
  file: string
  line?: number
  /** 规则名（`max-depth` 等）；解析错误没有 code ⇒ `parse-error` */
  rule: string
  message: string
}

/** 遍历时跳过的目录：与配置的 ignorePatterns 同语义（否则「我数的」与「oxlint 判的」不是同一集合）。 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".wt", ".agents"])

/**
 * 新树语料 = `packages/` 下全部 `.ts/.tsx`（相对仓库根，posix 分隔、已排序）。
 *
 * ⚠️ 用 fs 遍历而不是 `git ls-files`（`verify-file-size.ts` 用的是后者）：门禁要在**开发期**
 * 也判得到刚写、还没 `git add` 的文件。git 清单会漏掉它们 ⇒ 一个 500 行的新函数
 * 在 `git add` 之前一路绿 —— 那正是本判据最该抓的东西。
 */
export function collectCorpus(repo: string = REPO): string[] {
  const root = path.join(repo, CORPUS_ROOT)
  const out: string[] = []
  if (!fs.existsSync(root)) return out
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
        walk(path.join(dir, e.name), rel)
      } else if (e.isFile() && /\.tsx?$/.test(e.name)) {
        out.push(`${CORPUS_ROOT}/${rel}`)
      }
    }
  }
  walk(root, "")
  return out.sort()
}

/**
 * 从配置读回阈值。配置是 JSONC（允许注释）⇒ 用 oxlint 自己的解析口径不值得，
 * 这里只做「逐条规则取第二个数组元素」的最小解析：
 * 缺规则 / 值不是正整数 ⇒ 返回 null（判不了），不猜默认值。
 */
export function readThresholds(configText: string): Thresholds | null {
  let json: Record<string, unknown>
  try {
    // 去注释：配置里的 `//` 注释都在行首或行内，且不含字符串内的 `//`（本文件自己维护）。
    json = JSON.parse(configText.replace(/^\s*\/\/.*$/gm, ""))
  } catch {
    return null
  }
  const rules = json.rules as Record<string, unknown> | undefined
  if (!rules) return null
  const out = {} as Thresholds
  for (const [rule, field] of Object.entries(RULES)) {
    const v = rules[rule]
    const n = Array.isArray(v) ? v[1] : undefined
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null
    out[field] = n
  }
  return out
}

/** 阈值 ↔ `CANONICAL` 对账：返回不一致项（空数组 = 一致）。 */
export function thresholdDrift(t: Thresholds): string[] {
  const out: string[] = []
  for (const k of Object.keys(CANONICAL) as Array<keyof Thresholds>) {
    if (t[k] !== CANONICAL[k]) out.push(`${k}：配置 ${t[k]} ≠ 判定值 ${CANONICAL[k]}`)
  }
  return out
}

/** oxlint 的 `eslint(max-depth)` → `max-depth`；无 code（解析错误）→ `parse-error`。 */
export function ruleOf(code: unknown): string {
  if (typeof code !== "string" || !code) return "parse-error"
  const m = /^[a-z-]+\((.+)\)$/.exec(code)
  return m ? m[1] : code
}

/** oxlint `-f json` 输出 → 归一化诊断（纯函数，spec 直接喂构造数据）。 */
export function parseDiagnostics(stdout: string, repo: string = REPO): Diagnostic[] | null {
  let parsed: { diagnostics?: unknown }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed.diagnostics)) return null
  const out: Diagnostic[] = []
  for (const raw of parsed.diagnostics as Array<Record<string, unknown>>) {
    const abs = typeof raw.filename === "string" ? raw.filename : ""
    const file = abs.startsWith(repo + path.sep) ? abs.slice(repo.length + 1).split(path.sep).join("/") : abs
    const labels = Array.isArray(raw.labels) ? (raw.labels as Array<{ span?: { line?: number } }>) : []
    const line = labels[0]?.span?.line
    out.push({
      file,
      ...(typeof line === "number" ? { line } : {}),
      rule: ruleOf(raw.code),
      message: typeof raw.message === "string" ? raw.message : "",
    })
  }
  return out
}

/**
 * **纯函数**：输入语料规模 + 阈值 + 诊断，返回判定。spec 直接喂构造数据。
 *
 * `files` = 我数出来的语料数（不是 oxlint 报的）—— 两者不一致由调用方先判掉。
 */
export function judgeComplexity(
  files: string[],
  thresholds: Thresholds | null,
  diagnostics: Diagnostic[] | null,
): GateResult {
  if (!Array.isArray(files)) return unjudged(GATE, "no-corpus", "拿不到语料清单 ⇒ 判不了")
  if (files.length === 0) {
    return unjudged(
      GATE,
      "no-corpus",
      `${CORPUS_ROOT}/ 下 0 个 .ts/.tsx（新树 W1 之前就是这个状态）⇒ 没有可判的对象，不判绿`,
    )
  }
  if (thresholds === null) {
    return unjudged(GATE, "no-rule-table", `${CONFIG_REL} 缺失或规则表解析不了 ⇒ 不知道按什么阈值判`)
  }
  const drift = thresholdDrift(thresholds)
  if (drift.length) {
    return unjudged(GATE, "no-rule-table", `阈值与工单判定值不符（${drift.join("；")}）⇒ 配置被改过，判不了`)
  }
  if (diagnostics === null) {
    return unjudged(GATE, "no-binary", "oxlint 输出不是可解析的 JSON ⇒ 拿不到诊断")
  }
  if (diagnostics.length === 0) {
    return {
      gate: GATE,
      status: "passed",
      detail: `${files.length} 个文件 · 函数 ≤${thresholds.maxLinesPerFunction} 行 / 嵌套 ≤${thresholds.maxDepth} / 复杂度 ≤${thresholds.complexity}`,
    }
  }
  // 解析错误单独计数：它不是「太复杂」，而是「这个文件根本没判成」——两条都红，但读者要知道是哪条。
  const parseErrors = diagnostics.filter((d) => !(d.rule in RULES))
  const findings = diagnostics.map((d) => ({
    file: d.file,
    ...(d.line ? { line: d.line } : {}),
    detail: d.rule === "parse-error" ? `文件解析不了 ⇒ 没有复杂度可判：${d.message}` : `${d.rule}：${d.message}`,
  }))
  return {
    gate: GATE,
    status: "failed",
    findings,
    detail: parseErrors.length
      ? `${files.length} 个文件 · 其中 ${parseErrors.length} 条是解析错误（那些文件根本没判成复杂度）`
      : undefined,
  }
}

/** 找 oxlint：本树优先，再退主检出（工作树的 node_modules 是镜像，`.bin` 可能指回主检出）。 */
export function findOxlint(repo: string = REPO): string | null {
  for (const c of [path.join(repo, "node_modules", "oxlint", "bin", "oxlint"), path.join(repo, "node_modules", ".bin", "oxlint")]) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // 悬空软链：existsSync 为 false 即跳过
    }
  }
  return null
}

/** 每批喂给 oxlint 的文件数（避免命令行长度上限；本机 ARG_MAX 1MB，60 字符路径 × 5000 就顶到边界）。 */
const BATCH = 500

/** IO：跑 oxlint，返回全部诊断（或 null = 拿不到可解析输出）。 */
export function runOxlint(bin: string, repo: string, files: string[]): Diagnostic[] | null {
  const all: Diagnostic[] = []
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH)
    const r = spawnSync(bin, ["-c", CONFIG_REL, "--format=json", ...batch], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 10 * 60_000,
    })
    const parsed = parseDiagnostics(r.stdout ?? "", repo)
    if (parsed === null) {
      console.error(`! ${GATE}: oxlint 输出解析不了（rc=${r.status ?? "?"}）`)
      const raw = (r.stdout ?? "").slice(0, 500)
      if (raw) console.error(`   stdout 头 500 字符：${raw}`)
      const err = (r.stderr ?? "").slice(0, 500)
      if (err) console.error(`   stderr：${err}`)
      return null
    }
    all.push(...parsed)
  }
  return all
}

function readThresholdsFromDisk(repo: string): { thresholds: Thresholds | null; detail?: string } {
  const p = path.join(repo, CONFIG_REL)
  if (!fs.existsSync(p)) return { thresholds: null, detail: `${CONFIG_REL} 不存在` }
  try {
    return { thresholds: readThresholds(fs.readFileSync(p, "utf8")) }
  } catch (e) {
    return { thresholds: null, detail: `读不动 ${CONFIG_REL}：${(e as Error).message}` }
  }
}

if (isMain(import.meta.url)) {
  const files = collectCorpus()
  // 防空转：0 个文件不启动 oxlint —— 它在空语料下**退出码 1 且输出非 JSON**
  // （实测：「No files found to lint.」）⇒ 不先自己数语料就会把「没东西可判」误读成红。
  const gate = files.length === 0
    ? Promise.resolve(judgeComplexity(files, null, null))
    : (() => {
        const bin = findOxlint()
        if (!bin) return Promise.resolve(unjudged(GATE, "no-binary", "找不到 oxlint 可执行文件（node_modules/oxlint/bin/oxlint）"))
        const { thresholds, detail } = readThresholdsFromDisk(REPO)
        if (thresholds === null) {
          return Promise.resolve(unjudged(GATE, "no-rule-table", detail ?? `${CONFIG_REL} 的规则表解析不了`))
        }
        const diagnostics = runOxlint(bin, REPO, files)
        return Promise.resolve(judgeComplexity(files, thresholds, diagnostics))
      })()
  gate
    .then((result) => runGate({ name: GATE, main: () => result }))
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
