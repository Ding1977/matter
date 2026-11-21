/**
 * 逐文件行数棘轮（ISS-738）—— 替代 K2a 的「≥1000 行文件个数 ≤32」。
 *
 * 依据：`docs/plans-k-replacement-2026-11-09.md` §4.1。
 * 旧口径的漏洞：已入册文件脱离射程 —— `scripts/code-inventory.mjs` 从 998 涨到 1728 行（+73%），
 * 只要不新造第 33 个文件，判据永远绿。新口径：**每个文件独立记录、只许降不许升**。
 *
 * 判定（§4.1）：
 *   · 不在 ceiling 且 > 1000 行        ⇒ 红（新 god module）
 *   · 在 ceiling 且 > 记录值           ⇒ 红（已入册也只许降）
 *   · 在 ceiling 且 < 记录值           ⇒ 绿 + 提示「可收线」
 *   · 在 ceiling 且 ≤ 1000             ⇒ 绿 + 提示「可摘条目」
 *   · exempt 必须带 why + ticket，缺一 ⇒ 红（不许用豁免当免死金牌）
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const BASELINE = path.join(REPO, "scripts/baseline/file-size.json")
const NEW_FILE_LIMIT = 1000

export interface FileStat {
  path: string
  lines: number
}

export interface FileSizeBaseline {
  recordedAt?: string
  unit?: string
  ceiling?: Record<string, number>
  exempt?: Record<string, { why?: string; ticket?: string }>
  lastWrite?: { at?: string; reason?: string; from?: number | null; to?: number | null }
}

export function countLines(text: string): number {
  if (text.length === 0) return 0
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
}

/** 纯函数：输入文件清单 + 基线，返回判定（spec 直接喂构造数据）。 */
export function judgeFileSize(files: FileStat[], baseline: FileSizeBaseline | null): GateResult {
  const gate = "verify-file-size"
  if (!baseline) return unjudged(gate, "no-baseline", `基线不存在：${path.relative(REPO, BASELINE)}`)
  const ceiling = baseline.ceiling ?? {}
  const exempt = baseline.exempt ?? {}
  const findings: string[] = []
  const hints: string[] = []

  for (const f of files) {
    const ex = exempt[f.path]
    if (ex) {
      if (!ex.why?.trim() || !ex.ticket?.trim()) findings.push(`${f.path}：exempt 缺 why 或 ticket（豁免必须带理由与单号）`)
      else hints.push(`${f.path}：exempt（${f.lines} 行，${ex.ticket}）`)
      continue
    }
    const recorded = ceiling[f.path]
    if (recorded === undefined) {
      if (f.lines > NEW_FILE_LIMIT) findings.push(`${f.path}：${f.lines} 行 > ${NEW_FILE_LIMIT}，且不在基线（新 god module）`)
      continue
    }
    if (f.lines > recorded) {
      findings.push(`${f.path}：${f.lines} 行 > 记录值 ${recorded}（已入册也只许降不许升）`)
      continue
    }
    // 两种提示可同时成立：900 < 950 且 ≤1000 ⇒ 既「可收线」也「可摘条目」。
    if (f.lines < recorded) hints.push(`${f.path}：${f.lines} < 记录值 ${recorded}，可收线`)
    if (f.lines <= NEW_FILE_LIMIT) hints.push(`${f.path}：${f.lines} 行 ≤ ${NEW_FILE_LIMIT}，可摘条目`)
  }

  if (findings.length) return { gate, status: "failed", findings: findings.map((detail) => ({ detail })) }
  return { gate, status: "passed", findings: [], detail: hints.length ? `${hints.length} 条提示：${hints.slice(0, 5).join("；")}` : undefined }
}

function isCandidate(p: string): boolean {
  if (!/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(p)) return false
  if (/\.(spec|test)\./.test(p) || /\.d\.ts$/.test(p)) return false
  if (p.startsWith("scripts/baseline/")) return false
  return /^forge-[^/]+\/(lib|src)\//.test(p) || /^scripts\//.test(p)
}

function scan(): FileStat[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 })
  const files: FileStat[] = []
  for (const rel of out.split("\0").filter(Boolean)) {
    if (!isCandidate(rel)) continue
    const abs = path.join(REPO, rel)
    try {
      files.push({ path: rel, lines: countLines(fs.readFileSync(abs, "utf8")) })
    } catch {
      // 读不到 = 不判这一格，交给 scan 覆盖类判据；不在这里静默当 0 行。
    }
  }
  return files
}

function readBaseline(): FileSizeBaseline | null {
  if (!fs.existsSync(BASELINE)) return null
  return JSON.parse(fs.readFileSync(BASELINE, "utf8"))
}

/** 生成/更新基线：只入册 >1000 行的文件；exempt 原样保留；必须给 --reason。 */
function writeBaseline(files: FileStat[], reason: string | undefined): number {
  if (!reason?.trim()) {
    console.error('✗ --write 必须带理由：--write --reason "<为什么这次记录值是合法的>"')
    return 1
  }
  const prev = readBaseline()
  const ceiling: Record<string, number> = {}
  for (const f of files) if (f.lines > NEW_FILE_LIMIT) ceiling[f.path] = f.lines
  const out: FileSizeBaseline = {
    recordedAt: new Date().toISOString().slice(0, 10),
    unit: "lines-per-file",
    ceiling,
    exempt: prev?.exempt ?? {},
    lastWrite: {
      at: new Date().toISOString(),
      reason,
      from: prev?.ceiling ? Object.keys(prev.ceiling).length : null,
      to: Object.keys(ceiling).length,
    },
  }
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
  fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n")
  console.log(`✓ 已写基线：${Object.keys(ceiling).length} 个 >${NEW_FILE_LIMIT} 行的文件`)
  return 0
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--write")) {
    process.exitCode = writeBaseline(scan(), arg("--reason"))
  } else {
    runGate({
      name: "verify-file-size",
      main: () => {
        const files = scan()
        return judgeFileSize(files, readBaseline())
      },
    })
      .then((code) => {
        process.exitCode = code
      })
      .catch((e) => {
        console.error(`✗ verify-file-size: ${(e as Error).message}`)
        process.exitCode = 2
      })
  }
}
