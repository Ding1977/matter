/**
 * no-unknown-casts 语法指纹守卫（ISS-879）—— 移植 DSH `scripts/verify-no-unknown-casts.ts`。
 *
 * ## 判什么（一句话）
 *
 * 新树 `packages/<组>/<包>/src` 下**不许新增** `as unknown ...` 断言；存量按 SHA-256 语法指纹
 * 登记，按**身份**退役而非数量棘轮。封住 strict 的逃逸口（`as unknown as X` 绕过类型检查），
 * 补 `verify-type-ratchet`（只数 TS 错误码，看不见「合法但逃逸」的断言）看不见的缺口。
 *
 * ## 口径（对齐机制不统计量，老板 2026-11-18 拍板）
 *
 * | 观测 | 判定 |
 * |---|---|
 * | 新文件 / 新指纹（基线无记录） | ⛔ 红 |
 * | 存量指纹出现次数 > 基线计数 | ⛔ 红 |
 * | 存量指纹次数 = 基线计数 | ✅ 绿 |
 * | 基线有、实际没有（指纹消失） | ✅ 绿 + 提示可 `--prune`（**不红**） |
 *
 * `--prune`：确认没有新增后，把当前实测写回基线（退役已消失的指纹条目）。
 * 删一处存量 cast → `--prune` → 该条目消失、仍绿；手动加回（无基线记录）⇒ 红。
 *
 * ## 指纹算法（逐字照抄 DSH :25-34）
 *
 * 取断言节点的 syntax token（跳过 JSDoc），`JSON.stringify(tokens)` 后 SHA-256。
 * 去注释与空白 —— 重排格式/改注释不改指纹；改断言对象（变量名）会换指纹，这是刻意的
 * 「按身份退役」：同一处写法稳定，换写法就是新承诺，需重新登记。
 *
 * ## 退出码（`scripts/lib/gate-runtime.ts` 口径）
 *
 * 0 绿 / 1 红（新断言）/ 2 判不了：基线缺席或读不动（`no-baseline`）· 0 个源文件或 AST 起不来
 * （`no-corpus`）· 找不到 typescript（`no-binary`）。删基线 ≠ 绿（exit 2）。
 *
 * ## 与 DSH 参考的两处有意差异（不把简化说成等价）
 *
 * ① 射程收窄到 `packages/*\/*\/src`（任务书指定），不扫 DSH 的 apps/scripts/website —— 本仓
 *    `packages/` 外是旧树，归旧判据管。
 * ② 指纹消失从 DSH 的「抛错红」改成「提示可 prune、仍绿」—— 任务书口径「按身份退役、
 *    指纹消失⇒提示 prune」，与老板「对齐机制不统计量」一致； retirement 是正常动作不该报红。
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type Finding, type GateResult } from "../lib/gate-runtime.ts"

const GATE = "verify-no-unknown-casts"
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const BASELINE_REL = "scripts/baseline/no-unknown-casts.baseline.json"
const BASELINE = path.join(REPO, BASELINE_REL)

/** typescript 的候选路径（与 lint-rule-fingerprint / verify-plugin-entry-exports 同款）。 */
export const TS_CANDIDATES = [
  "forge-ui/node_modules/typescript/lib/typescript.js",
  "forge-pm/node_modules/typescript/lib/typescript.js",
  "node_modules/typescript/lib/typescript.js",
]

/**
 * 加载 typescript（工具，不是被扫对象）。候选表与仓库其余 AST 判据一致；取不到返回 null，
 * 由 judge 转 unjudged(no-binary)，不降级成正则。
 */
export function loadTs(root: string = REPO): any | null {
  for (const base of [root, REPO]) {
    let req: NodeRequire
    try {
      req = createRequire(path.join(base, "package.json"))
    } catch {
      continue
    }
    for (const c of TS_CANDIDATES) {
      const abs = path.join(base, c)
      if (!fs.existsSync(abs)) continue
      try {
        return req(abs) // 传绝对路径：'forge-ui/node_modules/...' 当模块名会被当成 scope 包
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

/** 一处 `as unknown ...` 断言。 */
export interface UnknownCast {
  /** 仓库相对路径（正斜杠）。 */
  file: string
  /** 1-based 源码行。 */
  line: number
  /** 断言 syntax token 的 SHA-256。 */
  fingerprint: string
}

/** `文件 → 指纹 → 计数`。 */
export type CastBaseline = Record<string, Record<string, number>>

/** judge 的纯输入：观测到的断言 + 读到的基线（null = 读不到，由 judge 转 unjudged）。 */
export interface CastInput {
  casts: UnknownCast[]
  baseline: CastBaseline | null
  /** 扫描根下的源码文件数（0 ⇒ no-corpus，不冒充绿）。 */
  fileCount: number
  /** typescript 是否可用（不可用 ⇒ no-binary）。 */
  hasTs: boolean
}

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/u
/** 只认 `packages/<组>/<包>/src/` 下的源码（任务书射程）。 */
const SRC_PATH = /^packages\/[^/]+\/[^/]+\/src\/.+/u

/** 断言的 syntax token 指纹：去 JSDoc、去空白注释，逐字照抄 DSH :25-34。 */
function syntaxFingerprint(node: unknown, source: unknown, ts: any): string {
  const tokens: string[] = []
  const visit = (child: any): void => {
    if (ts.isJSDoc(child)) return
    if (ts.isToken(child)) tokens.push(child.getText(source))
    else child.getChildren(source).forEach(visit)
  }
  visit(node)
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex")
}

/** 类型节点是否断言到 unknown（含括号与联合成员），逐字照抄 DSH :36-40。 */
function assertsUnknown(type: any, ts: any): boolean {
  if (ts.isParenthesizedTypeNode(type)) return assertsUnknown(type.type, ts)
  return type.kind === ts.SyntaxKind.UnknownKeyword
    || (ts.isUnionTypeNode(type) && type.types.some((t: any) => assertsUnknown(t, ts)))
}

/**
 * 扫单个文件的 `as unknown ...`（含 `<unknown>x` 尖括号写法与联合类型里的 unknown 成员）。
 * 注释/字符串/别名/容器类型不误伤 —— 用 AST 而不是正则。
 * @param file - 仓库相对路径，扩展名决定 TS/JSX 解析。
 * @param text - 源码正文。
 * @param ts - 已加载的 typescript 模块（工具，不是被扫对象）。
 */
export function findUnknownCasts(file: string, text: string, ts: any): UnknownCast[] {
  const normalized = file.replaceAll("\\", "/")
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true)
  const casts: UnknownCast[] = []
  const visit = (node: any): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      if (assertsUnknown(node.type, ts)) {
        casts.push({
          file: normalized,
          line: source.getLineAndCharacterOfPosition(node.type.getStart(source)).line + 1,
          fingerprint: syntaxFingerprint(node, source, ts),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return casts
}

/** `文件 → 指纹 → 计数`，稳定排序（照抄 DSH :129-137）。 */
export function countCasts(casts: readonly UnknownCast[]): CastBaseline {
  const out: CastBaseline = {}
  for (const { file, fingerprint } of casts) {
    const counts = (out[file] ??= {})
    counts[fingerprint] = (counts[fingerprint] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, counts]) => [file, Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))]),
  )
}

/** 基线结构体检：非法即返回 false（fail-closed，不拿空表当「全都没有记录」）。 */
function validBaseline(value: unknown): value is CastBaseline {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  for (const [file, counts] of Object.entries(value)) {
    if (!SRC_PATH.test(file) || file.startsWith("/") || file.includes("\\") || file.split("/").includes("..")) return false
    if (typeof counts !== "object" || counts === null || Array.isArray(counts) || Object.keys(counts).length === 0) return false
    for (const [fp, n] of Object.entries(counts)) {
      if (!/^[a-f0-9]{64}$/u.test(fp) || typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) return false
    }
  }
  return true
}

/**
 * 读基线。缺席 / 读不动 / 结构非法 ⇒ null（judge 转 unjudged，删基线不能让它永久变绿）。
 */
export function readBaseline(root: string = REPO): CastBaseline | null {
  const file = path.join(root, BASELINE_REL)
  if (!fs.existsSync(file)) return null
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    return validBaseline(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 纯判定：观测 + 基线 → GateResult。spec 直接喂构造数据，不碰 IO。
 *
 * 新断言每条都出一条 finding，带 `文件:行` + 指纹前12位 + 期望/实际 + 怎么改；
 * 指纹消失只进 hint（提示 prune），不红。
 */
export function judgeNoUnknownCasts(input: CastInput): GateResult {
  if (!input.hasTs) return unjudged(GATE, "no-binary", "找不到 typescript ⇒ AST 扫不了，判不了（不是绿）")
  if (input.fileCount === 0) return unjudged(GATE, "no-corpus", "packages/*/*/src 下 0 个源码文件 —— 分母为 0 不许冒充绿")
  if (input.baseline === null) return unjudged(GATE, "no-baseline", `基线缺席或读不动：${BASELINE_REL}（删基线不能让判据变绿）`)

  const remaining: CastBaseline = structuredClone(input.baseline)
  const added: UnknownCast[] = []
  for (const cast of input.casts) {
    const counts = remaining[cast.file]
    const allowance = counts?.[cast.fingerprint] ?? 0
    if (counts !== undefined && allowance > 0) counts[cast.fingerprint] = allowance - 1
    else added.push(cast)
  }

  const findings: Finding[] = added.map((c) => ({
    file: c.file,
    line: c.line,
    detail: `新增 as unknown 断言（指纹 ${c.fingerprint.slice(0, 12)}）：期望 0（基线无记录/已用尽），实际 1 —— 改用带类型的窄化值，或确认是刻意新增后更新基线（登记新指纹）。`,
  }))

  const stale = Object.entries(remaining).flatMap(([file, counts]) =>
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([fp, n]) => `${file}（${fp.slice(0, 12)}，余 ${n}）`),
  )
  if (findings.length) {
    return { gate: GATE, status: "failed", findings }
  }
  const detail = stale.length
    ? `存量 ${input.casts.length} 处断言已登记；${stale.length} 个指纹已消失，可运行 --prune 退役：${stale.slice(0, 6).join("、")}`
    : `存量 ${input.casts.length} 处断言已登记，无新增。`
  return { gate: GATE, status: "passed", findings: [], detail }
}

/**
 * 扫盘：git ls-files（含未跟踪新文件，抓「新文件⇒红」）→ 只留 packages/*\/*\/src 源码 → AST。
 * 符号链接直接拒绝（与 DSH 同口径：软链让指纹来源不确定）。
 */
export function scanCasts(root: string = REPO, ts: any = loadTs(root)): { casts: UnknownCast[]; fileCount: number } {
  let out: string
  try {
    out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (e) {
    throw new Error(`git ls-files 失败（${(e as Error).message}）`)
  }
  const files = [...new Set(out.split("\0").filter(Boolean).map((f) => f.replaceAll("\\", "/")))]
    .filter((f) => SRC_PATH.test(f) && SOURCE_EXT.test(f) && !f.endsWith(".d.ts"))
    .sort()
  const casts: UnknownCast[] = []
  let fileCount = 0
  for (const rel of files) {
    const abs = path.join(root, rel)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(abs)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) throw new Error(`源软链不支持：${rel}`)
    if (!stat.isFile()) continue
    fileCount++
    if (ts) casts.push(...findUnknownCasts(rel, fs.readFileSync(abs, "utf8"), ts))
  }
  return { casts, fileCount }
}

/** `--prune`：确认无新增后，把当前实测写回基线（退役消失的指纹）。返回写入的条目数。 */
export function pruneBaseline(root: string = REPO): number {
  const baseline = readBaseline(root)
  if (baseline === null) throw new Error(`基线读不动，拒绝 prune：${BASELINE_REL}`)
  const ts = loadTs(root)
  if (!ts) throw new Error("找不到 typescript，拒绝 prune")
  const { casts, fileCount } = scanCasts(root, ts)
  if (fileCount === 0) throw new Error("0 个源码文件，拒绝 prune（空集不许写空基线）")
  const judge = judgeNoUnknownCasts({ casts, baseline, fileCount, hasTs: true })
  if (judge.status === "failed") {
    throw new Error(`有新增断言，拒绝 prune：\n${(judge.findings ?? []).map((f) => `  ${f.file}:${f.line} ${f.detail}`).join("\n")}`)
  }
  const next = countCasts(casts)
  fs.mkdirSync(path.dirname(path.join(root, BASELINE_REL)), { recursive: true })
  fs.writeFileSync(path.join(root, BASELINE_REL), `${JSON.stringify(next, null, 2)}\n`)
  return Object.keys(next).length
}

async function cli(): Promise<number> {
  const args = process.argv.slice(2)
  const rootArg = args.indexOf("--root")
  const root = rootArg >= 0 && args[rootArg + 1] ? path.resolve(args[rootArg + 1]) : REPO

  if (args.includes("--prune")) {
    try {
      const n = pruneBaseline(root)
      console.log(`✓ ${GATE}: 已 prune，基线剩 ${n} 个文件条目。`)
      return 0
    } catch (e) {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      return 2
    }
  }

  const ts = loadTs(root)
  let input: CastInput
  try {
    const { casts, fileCount } = scanCasts(root, ts)
    input = { casts, baseline: readBaseline(root), fileCount, hasTs: ts !== null }
  } catch (e) {
    console.error(`✗ ${GATE}: 扫盘失败（${(e as Error).message}）⇒ 判不了（不是绿）`)
    return 2
  }
  return runGate({ name: GATE, main: () => judgeNoUnknownCasts(input) })
}

if (isMain(import.meta.url)) {
  // 顶层不 await --selftest 会动态 import spec、spec 又 import 本文件（同仓库其余判据）。
  cli()
    .then((code) => {
      process.exitCode = code
    })
    .catch((e) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
