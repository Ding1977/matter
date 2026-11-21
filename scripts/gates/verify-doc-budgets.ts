/**
 * 常驻规范文档的体量闸（ISS-741）。
 *
 * 依据：`specs/unified-spec-and-gates-plan-2026-11-09.md` §5 G1-4 / §7 #11。
 * 目的：给「规范文档只增不减」装机械闸——`project-code-rules.md` 自称 ≤27,000 B、实际 31,658 B 而没有任何机器判据。
 *
 * 判定：
 *   · 文件缺失 ⇒ 红（常驻文档不许悄悄消失）
 *   · bytes > limit ⇒ 红（上限只降不升）
 *   · bytes < limit ⇒ 绿 + 提示「可收线」
 *   · 有 target 且 bytes > target ⇒ 绿 + 提示「距目标还差 N 字节」（target 只提示、不判）
 *   · manifest 缺失 ⇒ unjudged（no-baseline），不判绿
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const MANIFEST = path.join(REPO, "scripts/doc-budgets.manifest.json")
const PLACEHOLDER = new Set(["待补", "todo", "tbd", "x", "-"])

export interface DocBudget {
  limit: number
  target?: number
}
export interface Manifest {
  recordedAt?: string
  unit?: string
  limits?: Record<string, DocBudget>
  lastWrite?: { at?: string; reason?: string }
}
export interface DocFile {
  path: string
  bytes: number | null
}

/** 纯函数：spec 直接喂构造数据。 */
export function judgeDocBudgets(files: DocFile[], manifest: Manifest | null): GateResult {
  const gate = "verify-doc-budgets"
  if (!manifest) return unjudged(gate, "no-baseline", `清单不存在：${path.relative(REPO, MANIFEST)}`)
  const limits = manifest.limits ?? {}
  const byPath = new Map(files.map((f) => [f.path, f.bytes]))
  const findings: string[] = []
  const hints: string[] = []

  for (const [p, b] of Object.entries(limits)) {
    const bytes = byPath.get(p)
    if (bytes === undefined || bytes === null) {
      findings.push(`${p}：常驻文档不存在（不许悄悄消失）`)
      continue
    }
    if (bytes > b.limit) findings.push(`${p}：${bytes} B > 上限 ${b.limit} B（只降不升）`)
    else if (bytes < b.limit) hints.push(`${p}：${bytes} < ${b.limit}，可收线`)
    if (b.target && bytes > b.target) hints.push(`${p}：距目标 ${b.target} 还差 ${bytes - b.target} B`)
  }

  return findings.length
    ? { gate, status: "failed", findings: findings.map((detail) => ({ detail })) }
    : { gate, status: "passed", findings: [], detail: hints.length ? hints.slice(0, 6).join("；") : undefined }
}

/** 纯函数：写清单必须有真理由（占位符不算）。 */
export function canWrite(reason: string | undefined): { ok: boolean; why?: string } {
  const r = (reason ?? "").trim()
  if (!r) return { ok: false, why: "--write 必须带 --reason（初版基线 / 收线 / 提额都要记账）" }
  if (PLACEHOLDER.has(r.toLowerCase())) return { ok: false, why: `--reason 是占位符（${JSON.stringify(reason)}）` }
  return { ok: true }
}

function readManifest(): Manifest | null {
  if (!fs.existsSync(MANIFEST)) return null
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"))
}

function scan(manifest: Manifest | null): DocFile[] {
  const paths = Object.keys(manifest?.limits ?? {})
  return paths.map((p) => {
    try {
      return { path: p, bytes: fs.statSync(path.join(REPO, p)).size }
    } catch {
      return { path: p, bytes: null }
    }
  })
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function writeManifest(reason: string | undefined): number {
  const gate = canWrite(reason)
  if (!gate.ok) {
    console.error(`✗ ${gate.why}`)
    return 1
  }
  const prev = readManifest()
  const files = scan(prev)
  const limits: Record<string, DocBudget> = {}
  const lines: string[] = []
  for (const f of files) {
    if (f.bytes === null) {
      console.error(`✗ ${f.path} 不存在 ⇒ 不写（缺文件是红，不是 0 B）`)
      return 1
    }
    const old = prev?.limits?.[f.path]
    limits[f.path] = { ...(old?.target ? { target: old.target } : {}), limit: f.bytes }
    if (old && old.limit !== f.bytes) lines.push(`${f.path}: ${old.limit} → ${f.bytes}`)
  }
  const next: Manifest = { recordedAt: new Date().toISOString().slice(0, 10), unit: "bytes", limits, lastWrite: { at: new Date().toISOString(), reason: reason!.trim() } }
  fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + "\n")
  console.log(lines.length ? lines.join("\n") : "（上限无变化）")
  console.log(`✓ 已写清单（${Object.keys(limits).length} 份文档）`)
  return 0
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--write")) {
    process.exitCode = writeManifest(arg("--reason"))
  } else {
    const manifest = readManifest()
    runGate({ name: "verify-doc-budgets", main: () => judgeDocBudgets(scan(manifest), manifest) })
      .then((code) => {
        process.exitCode = code
      })
      .catch((e) => {
        console.error(`✗ verify-doc-budgets: ${(e as Error).message}`)
        process.exitCode = 2
      })
  }
}
