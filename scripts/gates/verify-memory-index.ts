/**
 * 元判据：`docs/memory/README.md` 的归档表 ↔ 磁盘实体的双向对账（ISS-766）。
 *
 * ## 为什么需要它（两个独立 agent 各发现一半）
 * 现有两处扫描面都盖不到 `docs/memory/`：
 *   · `verify-spec` 扫的是 `docs/*.md` **单层** + `AGENTS.md` + `specs/*.md` —— 子目录不在射程；
 *   · `scripts/doc-budgets.manifest.json` 只登记 8 份常驻规范文档，**不含** `docs/memory/README.md`。
 * ⇒ 两个方向都没人判：「索引指向不存在的文件」与「实体存在但索引没有」。
 *
 * 今天两次险情：① 事故档改名后索引仍指旧名（合并顺序反了就是永久悬空）；
 * ② `incidents/` 两篇归档一开始没有索引（违反 `docs/project-memory-rules.md` §3.1「先归档后索引」）。
 *
 * ## 三条断言
 *   ① **悬空（全量判，无基线）**：归档表里的每个路径 ⇒ `docs/memory/` 下必须存在。
 *   ② **缺条目（棘轮）**：每份 `.md` 若**不在表里且不在 `knownMissing`** ⇒ 红并点名。
 *   ③ **基线自身不说谎**：`knownMissing` 里出现射程外路径（封存目录 / README 自身）⇒ 红。
 *      另两条**只提示不判红**：某条已被索引 ⇒ 可摘；某条文件已删 ⇒ 可摘（文件已删）。
 *      ⚠️ 这个取舍是有意的：名单腐烂只产生噪音，不会让真回归漏掉。
 *
 * 封存目录**不要求**索引（见 `SEALED`）——它们不是「给人看的归档」，是退役产物 / 图片附件 / 补丁文本。
 *
 * ## 射程 = **git 跟踪集**，不是 `readdirSync` 的物理文件
 * 主检出上实测：`git ls-files docs/memory` = 239 平铺 md，而 `ls docs/memory/*.md` = 272
 * —— 差额是 34 个 `??` 未入库文件（最老 2026-10-08）。若按物理文件扫：
 *   · 本机算出缺条目 ~217 ⇒ **红**；CI 干净 checkout 算出 184 ⇒ **绿**；
 *   · 下一个人 `git add` 一批文件就会「莫名把门禁弄红」——**K8e 明令禁止**：
 *     门禁不得对在途未入库文件判红并归责于收口者（`scripts/scan-input.mjs` 头注同一条纪律）。
 * ⇒ 射程只取「已入库 ∩ 盘上存在」的 `.md`，并把**排除了多少份未入库**打印进结论行（静默排除 = 另一种错）。
 *   未入库文件是 `project-memory-rules.md` §3.6 的账（`git add` 责任），不是本判据的账。
 *
 * ## 为什么缺条目侧走棘轮而不是一次补齐
 * 实测存量 184 条，索引最后一次更新 = 2026-10-27，此前 8~10 月的归档从未逐条入索引。
 * 强行补齐 184 条「一行主题」等于为没人记得的老档**编造描述** —— 把编的写进索引比缺索引更坏
 * （后来人会信它）。所以存量只记**名单**（一条全局 reason，不逐条复制 why），只许减不许增。
 *
 * ⛔ 表解析为空 / 索引文件不存在 ⇒ `unjudged`（exit 2），不判绿：删掉表格不等于「没有归档」。
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult } from "../lib/gate-runtime.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const MEMORY_DIR = path.join(REPO, "docs/memory")
const INDEX_FILE = path.join(MEMORY_DIR, "README.md")
const BASELINE_FILE = path.join(REPO, "scripts/baseline/memory-index.json")

/**
 * 不要求进索引的路径（封存目录 / 过程数据 / 附件 / README 自身）。
 * 判据：**不是「给人看的归档」** —— 封存目录是退役产物、attachments 是图片与矩阵、
 * patches 是补丁文本。它们进索引只会让索引膨胀，且没有任何检索价值。
 */
export const SEALED: readonly RegExp[] = [
  /^archive\//,
  /^pool-archive\//,
  /^wt-salvage-[^/]*(\/|$)/,
  /^triage-[^/]*(\/|$)/,
  /^evidence-[^/]*$/,
  /^attachments\//,
  /^patches\//,
  /^README\.md$/,
]

export const isSealed = (rel: string): boolean => SEALED.some((re) => re.test(rel))

/** 表格行第一列里的 md 路径；不是表格行 / 第一列没路径 ⇒ null。 */
export function indexRowPath(line: string): string | null {
  if (!/^\s*\|/.test(line)) return null
  const first = line.split("|")[1] ?? ""
  const m = first.match(/`([^`\n]+\.md)`/)
  return m ? m[1].trim() : null
}

/** 表里被索引的全部路径（去重，保持出现顺序）。 */
export function parseIndex(indexText: string): string[] {
  const out: string[] = []
  for (const line of indexText.split("\n")) {
    const p = indexRowPath(line)
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** 射程内且缺索引的实体（= 棘轮要记的名单）。`--write` 与判定共用同一个口径。 */
export function missingInScope(input: { indexText: string; files: string[] }): string[] {
  const indexed = new Set(parseIndex(input.indexText))
  return input.files.filter((f) => !isSealed(f) && !indexed.has(f))
}

export interface MemoryIndexInput {
  indexText: string
  /** 射程：**已入库 ∩ 盘上存在**的 `.md` 相对路径（含封存目录，排除与否由 isSealed 决定） */
  files: string[]
  /** 棘轮基线里的存量缺条目名单；缺省 = 严格（一条都不豁免） */
  knownMissing?: readonly string[]
  /** 被射程排除的「未入库」.md 数量——只用于结论行报数，不参与判定 */
  untrackedCount?: number
  /**
   * `docs/memory/` 下**盘上实际存在**的全部 `.md`（含封存目录）——只用于把「悬空」的两种成因分开报。
   * 缺省 ⇒ 不分段（文案退化为中性说法）。判定不受影响：两种成因在射程口径下都是红。
   */
  physical?: readonly string[]
}

export function judgeMemoryIndex(input: MemoryIndexInput): GateResult {
  const gate = "verify-memory-index"
  const indexedList = parseIndex(input.indexText)
  // 表解析为空 = 判不了（不是「没有归档」）：删表格 / 改标题层级都会走到这里。
  if (!indexedList.length) return unjudged(gate, "no-corpus", "docs/memory/README.md 的归档表里没解析出任何 *.md 路径 ⇒ 判不了")

  const indexed = new Set(indexedList)
  const filesSet = new Set(input.files)
  const inScope = input.files.filter((f) => !isSealed(f))
  if (!inScope.length) return unjudged(gate, "no-corpus", "docs/memory/ 下一份可索引的 .md 都没有 ⇒ 判不了")

  const known = input.knownMissing ?? []
  const knownSet = new Set(known)
  const findings: string[] = []
  const hints: string[] = []

  // ① 悬空：索引里有、射程内没有（全量，无基线）。两种成因**分开报**——
  //    判定相同（射程口径下都红，且本机/CI 一致），但成因不同，文案混用会让人在本机找不到「明明存在」的文件：
  //    · 盘上也没有 ⇒ 改名/删除后索引没跟上
  //    · 盘上有但没入库 ⇒ 索引指向未提交文件（CI 上必然悬空）
  const dangling = indexedList.filter((p) => !filesSet.has(p))
  if (dangling.length) {
    const physical = input.physical ? new Set(input.physical) : null
    const absent = physical ? dangling.filter((p) => !physical.has(p)) : dangling
    const uncommitted = physical ? dangling.filter((p) => physical.has(p)) : []
    if (absent.length) {
      findings.push(`索引悬空 ${absent.length} 条 —— 表里有、盘上也没有这个文件（改名/删除后索引没跟上）：${absent.join("、")}`)
    }
    if (uncommitted.length) {
      findings.push(
        `索引指向未入库文件 ${uncommitted.length} 条 —— 盘上有、git 没跟踪（只在本机存在，CI 上会悬空；先 git add 这个文件，或把它从表里摘掉）：${uncommitted.join("、")}`,
      )
    }
  }

  // ② 缺条目：盘上有、表里没有、也不在基线（棘轮：只判新增）
  const fresh = missingInScope(input).filter((f) => !knownSet.has(f))
  if (fresh.length) {
    const shown = fresh.slice(0, 10).join("、")
    findings.push(
      `缺条目新增 ${fresh.length} 份 —— 这份归档没有被 README 归档表索引（违反 project-memory-rules §3.1「先归档后索引」）：${shown}${fresh.length > 10 ? `…（另 ${fresh.length - 10} 份）` : ""}`,
    )
  }

  // ③ 基线自身不说谎：射程外路径不许出现在 knownMissing 里
  const bogus = [...knownSet].filter((k) => isSealed(k))
  if (bogus.length) {
    findings.push(`基线自身说谎 ${bogus.length} 条 —— knownMissing 里出现射程外路径（封存目录 / README）：${bogus.join("、")}`)
  }

  // 只提示不判红：已摘 / 文件已删
  const nowIndexed = known.filter((k) => indexed.has(k))
  const gone = known.filter((k) => !indexed.has(k) && !filesSet.has(k) && !isSealed(k))
  if (nowIndexed.length) hints.push(`可摘 ${nowIndexed.length} 条（已被索引，用 --write --reason 摘掉）：${nowIndexed.join("、")}`)
  if (gone.length) hints.push(`可摘 ${gone.length} 条（文件已删）：${gone.join("、")}`)

  const summary = `缺条目 ${fresh.length} 新增 · 存量豁免 ${knownSet.size} · 悬空 ${dangling.length} · 射程 = git 跟踪 ${inScope.length} 份（已排除 ${input.untrackedCount ?? 0} 份未入库）`
  if (findings.length) return { gate, status: "failed", findings: findings.map((detail) => ({ detail })), detail: summary }
  return { gate, status: "passed", detail: [summary, ...hints].join("；") }
}

/** 递归列出 `docs/memory/` 下**盘上实际存在**的 `.md`（`/` 分隔，相对该目录）——只用于数「排除了多少未入库」。 */
function scanPhysical(dir = MEMORY_DIR, prefix = ""): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...scanPhysical(path.join(dir, e.name), rel))
    else if (e.name.endsWith(".md")) out.push(rel)
  }
  return out
}

/** `docs/memory/` 下**已入库**的 `.md`；拿不到 git ⇒ null（= 判不了，不退回物理口径）。 */
function scanTracked(): string[] | null {
  try {
    const out = execFileSync("git", ["-C", REPO, "ls-files", "-z", "--", "docs/memory"], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const prefix = "docs/memory/"
    return out
      .split("\0")
      .filter((p) => p.startsWith(prefix) && p.endsWith(".md"))
      .map((p) => p.slice(prefix.length))
  } catch {
    return null
  }
}

/**
 * 射程 = **已入库 ∩ 盘上存在**。
 * 取交集而不是直接用 tracked：索引指向「已提交但已被删掉」的文件同样该红（改名事故的第一现场），
 * 而纯 tracked 会让它静默通过。
 */
function scope(): { files: string[]; untrackedCount: number; physical: string[] } | null {
  const tracked = scanTracked()
  if (tracked === null) return null
  const physical = scanPhysical()
  const trackedSet = new Set(tracked)
  return {
    files: tracked.filter((f) => fs.existsSync(path.join(MEMORY_DIR, f))),
    // 「未入库」= 盘上有、git 没有；已入库但被删的文件不在这里（它已在 files 之外，由悬空判据处理）
    untrackedCount: physical.filter((f) => !trackedSet.has(f)).length,
    physical,
  }
}

interface Baseline {
  generatedAt?: string
  reason?: string
  knownMissing?: string[]
}

function readBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_FILE)) return {}
  return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"))
}

/**
 * `--write --reason "<为什么这次基线变化合法>"`：重算名单。
 * 只允许**减少**（有人补了索引 / 删了老档）；新增必须靠 reason 点名是哪批归档要豁免。
 */
function writeBaseline(reason: string | undefined): number {
  if (!reason?.trim()) {
    console.error('✗ --write 必须带理由：--write --reason "<这批新增缺索引的归档是哪一批、为什么现在不补>"')
    return 1
  }
  const scoped = scope()
  if (!scoped) {
    console.error("✗ 拿不到 git 清单 ⇒ 判不了射程（不退回物理文件：那会让本机与 CI 出两套数）")
    return 2
  }
  const prev = readBaseline().knownMissing ?? []
  const next = missingInScope({ indexText: fs.readFileSync(INDEX_FILE, "utf8"), files: scoped.files })
  const prevSet = new Set(prev)
  const nextSet = new Set(next)
  const added = next.filter((p) => !prevSet.has(p))
  const removed = prev.filter((p) => !nextSet.has(p))
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true })
  fs.writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), reason: reason.trim(), knownMissing: next }, null, 2)}\n`,
  )
  console.log(`✓ 已写基线：${next.length} 条（摘除 ${removed.length} / 新增 ${added.length}）`)
  if (added.length) console.log(`  ⚠️ 新增必须写进 reason：${added.slice(0, 10).join("、")}${added.length > 10 ? `…（另 ${added.length - 10} 条）` : ""}`)
  return 0
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--write")) {
    process.exitCode = fs.existsSync(INDEX_FILE) ? writeBaseline(arg("--reason")) : 1
    if (process.exitCode === 1 && !fs.existsSync(INDEX_FILE)) console.error(`✗ 缺 ${path.relative(REPO, INDEX_FILE)}`)
  } else {
    runGate({
      name: "verify-memory-index",
      main: () => {
        if (!fs.existsSync(INDEX_FILE) || !fs.existsSync(MEMORY_DIR)) {
          return unjudged("verify-memory-index", "no-corpus", "缺 docs/memory/README.md 或 docs/memory/ 目录")
        }
        const scoped = scope()
        if (!scoped) return unjudged("verify-memory-index", "no-binary", "拿不到 git 清单 ⇒ 判不了射程（不退回物理文件：本机与 CI 会出两套数）")
        return judgeMemoryIndex({
          indexText: fs.readFileSync(INDEX_FILE, "utf8"),
          files: scoped.files,
          knownMissing: readBaseline().knownMissing ?? [],
          untrackedCount: scoped.untrackedCount,
          physical: scoped.physical,
        })
      },
    })
      .then((code) => {
        process.exitCode = code
      })
      .catch((e) => {
        console.error(`✗ verify-memory-index: ${(e as Error).message}`)
        process.exitCode = 2
      })
  }
}
