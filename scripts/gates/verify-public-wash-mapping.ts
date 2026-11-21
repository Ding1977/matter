/**
 * 公开仓洗脱映射判据（ISS-904 / ISS-930）——`scripts/baseline/public-wash-mapping.json` 的三条断言：
 *   ① **可解析**：JSON 有 `mapping` 对象，key 是 4+ token、value 是 <1000 小号段，目标唯一无碰撞。
 *   ② **append-only 形态**：前 `legacy_distinct_tokens` 条 = ISS-501.. 连续段（ISS-902 的 36 条原样迁入），
 *      其后 = `appended[]` 逐条对应（token/batch/to 一致），且目标满足**严格单调递增 + 全局唯一 +
 *      不占用 `small_existing_numbers` 保留集**。
 *      保留号是**在册真实单号**（如 ISS-680）：新 token 占用它，同一个 ISS-680 在公开仓就同时指两件事，
 *      正是洗脱要防的混淆。因此追加时跳过保留号（跳号合法、重号/占用保留号非法）；legacy 段固定不动。
 *   ③ **覆盖当前 main 4+ 全集**：当前 main 白名单里出现的每个 4+ token 都在 `mapping` 中有条目。
 *
 * ## 为什么射程取 git 对象而不是磁盘文件
 * 「当前 main 的 token 全集」是 git 事实（`git grep <ref>`），不随工作树未入库文件变化——
 * 与 `verify-memory-index` 的「射程 = 已入库 ∩ 盘上存在」同纪律：本机与 CI 必须读到同一份集合。
 * 拿不到 main ref ⇒ unjudged（不退回空集判绿：那是「没有 token 要映射」的假绿）。
 *
 * ## 为什么 ③ 是活 tripwire（会随 main 前进变红）
 * main 每引入一个新 4+ token，本格即红，逼同步脚本按 append-only 追加映射——这正是机制的目的
 * （DOC-528 §5.2）。它不是「当前树恰好 N 条」的过期快照断言：断言的是**覆盖关系**（main ⊆ mapping），
 * main 与 mapping 同步前进时恒绿，脱节才红。
 *
 * ## 与 sync 脚本的分工
 * 「36 条与 /tmp 源逐字一致」是**一次性迁入证据**（实施时已比对并写入 `source` 字段），不是本判据的
 * 常驻职责——常驻判据只许依赖仓内事实，探 /tmp 会随环境变色（写判据硬边界）。本判据守的是
 * 此后**不再重排/不再重算**的结构不变量。
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const MAPPING_FILE = path.join(REPO, "scripts/baseline/public-wash-mapping.json")

const TOKEN_RE = /^(?:ISS|PRJ)-[1-9][0-9]{3,}$/
const SCAN_RE = /(?:ISS|PRJ)-[1-9][0-9]{3,}/g
/** git grep -E 走 POSIX ERE，不认 (?:...) 非捕获组 —— 单独一条捕获组版本给它。 */
const GREP_ERE = "(ISS|PRJ)-[1-9][0-9]{3,}"
const SMALL_RE = /^(?:ISS|PRJ)-[1-9][0-9]{0,2}$/

/** 导出白名单里的根脚手架件（与 sync-public.mjs 共享同一张表；ISS-902 八件 + ISS-930 三件）。 */
export const ROOT_SCAFFOLD = [
  "pnpm-workspace.yaml",
  "tsconfig.next.json",
  "tsconfig.base.json",
  "tsconfig.base.emit.json",
  "tsconfig.base.client.emit.json",
  "vitest.config.ts",
  "vitest.setup.ts",
  "tsdown.config.ts",
  // ISS-930：lint 配置（公开仓要跑 lint）+ typert 生成器定位用的 host tsconfig（文档 Controller 的 ./remote|./typert 产物依赖它）。
  ".oxlintrc.json",
  ".oxlintrc.next.json",
  "tsconfig.host.json",
] as const

const num = (id: string): number => Number(id.split("-")[1])

export interface WashMappingInput {
  /** 解析后的 JSON 文档（外面已 JSON.parse） */
  doc: Record<string, unknown>
  /** 当前 main 白名单里出现的全部 4+ token（去重） */
  mainTokens: string[]
}

/** 结构体检：mapping 是 4+→小号段 的双射；坏形状返回诊断串（非空即判定失败）。 */
export function shapeProblems(doc: Record<string, unknown>): string[] {
  const problems: string[] = []
  const mapping = doc.mapping
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return ["缺 mapping 对象"]
  const entries = Object.entries(mapping as Record<string, unknown>)
  if (!entries.length) return ["mapping 为空"]
  for (const [k, v] of entries) {
    if (!TOKEN_RE.test(k)) problems.push(`key 不是 4+ token：${k}`)
    if (typeof v !== "string" || !SMALL_RE.test(v)) problems.push(`value 不是 <1000 小号段：${k}→${String(v)}`)
  }
  // 「目标重复」与「占用保留号」都是 append 规则违例（非结构），由 appendOnlyProblems 判红。
  const legacy = Number(doc.legacy_distinct_tokens)
  if (!Number.isInteger(legacy) || legacy < 1 || legacy > entries.length) problems.push(`legacy_distinct_tokens 非法：${String(doc.legacy_distinct_tokens)}`)
  const small = doc.small_existing_numbers
  if (!Array.isArray(small)) problems.push("small_existing_numbers 不是数组")
  // 「目标占用保留号」不是结构问题，而是 append 规则违例——由 appendOnlyProblems 判红（见该函数注释）。
  return problems
}

/**
 * append-only 形态：前 legacy 条连续 ISS-501..；其后逐条对应 appended[]，目标满足三条：
 *   ① 严格单调递增（重号/回退即红）；② 全局唯一（与 legacy + 保留集 + 先前 appended 都不撞）；
 *   ③ 不占用 small_existing_numbers 保留集（在册真实单号，如 ISS-680）。
 * 跳号合法（保留号被跳过时）；`next_small_id` = 最后一条 appended 目标 + 1。
 */
export function appendOnlyProblems(doc: Record<string, unknown>): string[] {
  const problems: string[] = []
  const mapping = doc.mapping as Record<string, string>
  const entries = Object.entries(mapping)
  const legacy = Number(doc.legacy_distinct_tokens)
  const small = doc.small_existing_numbers as number[]
  const occupied = new Set<number>(small)

  // legacy 段：ISS-501 起连续，目标不与既有小号段冲突
  for (let i = 0; i < legacy; i++) {
    const expect = 501 + i
    const got = num(entries[i][1])
    if (got !== expect) problems.push(`legacy[${i}] 目标应 ISS-${expect}，实 ${entries[i][1]}`)
    if (occupied.has(got)) problems.push(`legacy[${i}] 目标撞既有小号段 ${got}`)
    occupied.add(got)
  }

  // appended 段：条数、顺序、字段一致；目标严格单调递增 + 全局唯一 + 不占用保留集（跳号合法）
  const appended = doc.appended
  if (!Array.isArray(appended)) return [...problems, "appended 不是数组"]
  const tail = entries.slice(legacy)
  if (appended.length !== tail.length) problems.push(`appended 条数 ${appended.length} ≠ mapping 尾段 ${tail.length}`)
  let prev = 500 + legacy  // legacy 末条 = ISS-(500+legacy)
  for (let i = 0; i < appended.length; i++) {
    const a = appended[i] as Record<string, unknown>
    const [key, val] = tail[i] ?? ["<缺>", "<缺>"]
    if (a.token !== key) problems.push(`appended[${i}].token=${String(a.token)} ≠ mapping 顺序键 ${key}`)
    if (a.to !== val) problems.push(`appended[${i}].to=${String(a.to)} ≠ mapping[${key}]=${val}`)
    if (typeof a.batch !== "string" || !a.batch.trim()) problems.push(`appended[${i}] 缺 batch 归属`)
    const got = num(val)
    if (got <= prev) problems.push(`appended[${i}] 目标 ISS-${got} 非严格递增（前值 ISS-${prev}）——重号/回退/重排`)
    if (occupied.has(got)) problems.push(`appended[${i}] 目标 ISS-${got} 占用保留号或与既有目标撞号——破坏唯一性`)
    occupied.add(got)
    prev = got
  }
  const next = Number(doc.next_small_id)
  if (next !== prev + 1) problems.push(`next_small_id 应 ${prev + 1}（末条目标 + 1），实 ${next}`)
  return problems
}

/** 纯判据：三章合成一个 GateResult。 */
export function judgeWashMapping(input: WashMappingInput): GateResult {
  const gate = "verify-public-wash-mapping"
  const doc = input.doc

  const shape = shapeProblems(doc)
  if (shape.length) return { gate, status: "unjudged", reason: "no-rule-table", detail: `映射结构不可判：${shape.slice(0, 5).join("；")}` }
  const append = appendOnlyProblems(doc)
  const mapping = doc.mapping as Record<string, string>

  const findings: string[] = []
  if (append.length) findings.push(`append-only 形态破 ${append.length} 处：${append.slice(0, 6).join("；")}`)

  // 覆盖：main ⊆ mapping（mapping 可含已从 main 移除的历史 token——append-only 永不删）
  const missing = [...new Set(input.mainTokens)].filter((t) => !mapping[t])
  if (missing.length) findings.push(`当前 main 的 4+ token 有 ${missing.length} 个未映射：${missing.slice(0, 10).join("、")}${missing.length > 10 ? `…（另 ${missing.length - 10}）` : ""}`)

  const entries = Object.entries(mapping)
  const detail = `可解析 ${entries.length} 条（legacy ${String(doc.legacy_distinct_tokens)} + appended ${(doc.appended as unknown[]).length}）· main token ${new Set(input.mainTokens).size} 个 · 形态 ${append.length ? "红" : "绿"} · 覆盖 ${missing.length ? "红" : "绿"}`
  if (findings.length) return { gate, status: "failed", findings: findings.map((detail) => ({ detail })), detail }
  return { gate, status: "passed", detail }
}

/** 从 git 对象读当前 main 白名单的 4+ token 全集；拿不到 ref ⇒ null（unjudged）。 */
export function scanMainTokens(): string[] | null {
  const ref = ["origin/main", "main"].find((r) => {
    try {
      execFileSync("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", r], { stdio: "ignore" })
      return true
    } catch {
      return false
    }
  })
  if (!ref) return null
  const out: string[] = []
  // 射程 = 当前导出白名单（packages + scripts + apps + 根件），与 sync-public.mjs 同口径；
  // 只扫 packages/ 会漏掉 scripts/apps 新增 token，tripwire 就钝了。
  const paths = ["packages/", "scripts/", "apps/", ...ROOT_SCAFFOLD]
  for (const p of paths) {
    try {
      const text = execFileSync("git", ["-C", REPO, "grep", "-h", "-o", "-E", GREP_ERE, ref, "--", p], {
        encoding: "utf8",
        maxBuffer: 64 << 20,
        stdio: ["ignore", "pipe", "ignore"],
      })
      out.push(...(text.match(SCAN_RE) ?? []))
    } catch {
      // git grep 无命中 exit 1，非错误；路径不在该 ref 也可能报 128——都当作该路径 0 token
    }
  }
  return [...new Set(out)]
}

if (isMain(import.meta.url)) {
  runGate({
    name: "verify-public-wash-mapping",
    main: () => {
      if (!fs.existsSync(MAPPING_FILE)) return unjudged("verify-public-wash-mapping", "no-baseline", `缺 ${path.relative(REPO, MAPPING_FILE)}`)
      let doc: Record<string, unknown>
      try {
        doc = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"))
      } catch (e) {
        return unjudged("verify-public-wash-mapping", "no-rule-table", `JSON 解析失败：${(e as Error).message}`)
      }
      const tokens = scanMainTokens()
      if (tokens === null) return unjudged("verify-public-wash-mapping", "no-baseline", "找不到 origin/main 或 main ref ⇒ 判不了当前 token 全集")
      return judgeWashMapping({ doc, mainTokens: tokens })
    },
  })
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error(`✗ verify-public-wash-mapping: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
