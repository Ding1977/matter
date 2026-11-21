/**
 * `docs/ctx-catalog.md` 的新鲜度判据（ISS-862）。
 *
 * 依据：DOC-512 §5.6.1 —— 生成物进 git，机制是**失败驱动**而不是「自动同步」：
 *   改源码 → 忘跑生成器 → 本格红 → 跑 `scripts/gen-ctx-catalog.ts` → 提交。
 *
 * 为什么判据不自己再写一份扫描：`--check` 与生成器必须问同一个问题。两份实现会在某天分叉，
 * 而分叉的表现是「生成器说最新、判据说旧」，没人能说清哪边对。所以本格直接 import 生成器的
 * {@link buildCatalog}（同一函数、同一扫描面、同一排序）。
 *
 * 三态（`scripts/lib/gate-runtime.ts`）：0 绿 / 1 红（旧了）/ 2 判不了（没有语料）。
 * ⛔ **0 个包不许判绿**：`packages/` 空或读不到时，「生成物与源码一致」是一句空话
 *    （两边都是空表自然一致）。那是 `no-corpus`，必须判不了，让「目录搬走了」这件事出声。
 *
 * 红的信息必须给出「文件:行 + 期望 + 实际 + 怎么改」四件（DOC-512 §5.5.7 第 2 条）：
 *   · 文件:行 —— 第一个不同的行（没有行号的红只能让人从第一行开始肉眼比对）
 *   · 期望/实际 —— 该行的原文
 *   · 怎么改 —— 跑哪个命令
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain, runGate, unjudged, type GateResult, type Finding } from "../lib/gate-runtime.ts"
import { HEADER, OUT_REL, buildCatalog } from "../gen-ctx-catalog.ts"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const GATE = "verify-ctx-catalog"
/** 生成器的重跑命令：红文案里的「怎么改」必须是**能直接粘的**一条。 */
const REGEN = "node scripts/gen-ctx-catalog.ts"

export interface CatalogInput {
  /** 生成物现状（`null` = 文件不存在）。 */
  actual: string | null
  /** 现算的生成物内容。 */
  expected: string
  /** 扫到了几个包（0 ⇒ 判不了，不许绿）。 */
  packageCount: number
}

/**
 * 第一处不同的行（1-based）。逐行比，任一侧多出来的行也算不同。
 * @returns `{line, expected, actual}`；两侧完全相同返回 null。
 */
export function firstDiff(actual: string, expected: string): { line: number; expected: string; actual: string } | null {
  const a = actual.split("\n")
  const e = expected.split("\n")
  const n = Math.max(a.length, e.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== e[i]) return { line: i + 1, expected: e[i] ?? "（无此行）", actual: a[i] ?? "（无此行）" }
  }
  return null
}

/**
 * 缺哪些包：期望里有、实际文本里没以 `| \`<包名>\` |` 形式出现的。
 *
 * 只取 **`## 包清单` 那一节**的行 —— 生成物里还有 `## ctx key 对照` 与 `## 事件清单`，
 * 它们的首格是 `ctx.xxx` / 事件名，不限定段名就会把它们当成「包」报出来（spec 抓到过）。
 *
 * 为什么用「表格首格整格相等」而不是 `includes(包名)`：`@matter/storage` 是
 * `@matter/storage-journal` 的**前缀**（ISS-515 踩过），子串判法会把
 * 「journal 在、storage 缺了」判成两者都在 —— 正是反向变异要抓的那类假绿。
 */
export function missingPackages(actual: string, expected: string): string[] {
  const rowRe = /^\|\s*`([^`]+)`\s*\|/u
  /** 只取 `## 包清单` 段（到下一个 `## ` 之前）的表格首格。 */
  const packageNamesOf = (text: string) => {
    const lines = text.split("\n")
    const start = lines.findIndex((l) => l.trim() === "## 包清单")
    if (start < 0) return new Set<string>()
    const out = new Set<string>()
    for (const l of lines.slice(start + 1)) {
      if (/^##\s/.test(l)) break
      const m = rowRe.exec(l)
      if (m) out.add(m[1])
    }
    return out
  }
  const want = packageNamesOf(expected)
  const have = packageNamesOf(actual)
  return [...want].filter((p) => !have.has(p)).sort()
}

/**
 * 纯函数判据：spec 直接喂构造数据。
 * @param input - 生成物现状 + 现算内容 + 包数。
 */
export function judgeCatalog(input: CatalogInput): GateResult {
  if (!(input.packageCount > 0)) {
    return unjudged(
      GATE,
      "no-corpus",
      "packages/*/* 下扫到 0 个包 ⇒ 判不了「生成物是否新鲜」（空表与空表当然一致，那不是绿）",
    )
  }
  if (input.actual === null) {
    return {
      gate: GATE,
      status: "failed",
      findings: [
        {
          file: OUT_REL,
          detail: `文件不存在，但源码里有 ${input.packageCount} 个包 ⇒ 跑 \`${REGEN}\` 生成，并把结果提交进 git（生成物进仓库是这个机制的承重墙）`,
        } satisfies Finding,
      ],
    }
  }
  if (input.actual === input.expected) return { gate: GATE, status: "passed", findings: [] }

  const findings: Finding[] = []
  if (!input.actual.startsWith(HEADER)) {
    findings.push({
      file: OUT_REL,
      line: 1,
      detail: `首行不是生成器文件头。期望 \`${HEADER}\`，实际 \`${input.actual.split("\n")[0] ?? "（空文件）"}\``,
    })
  }
  const diff = firstDiff(input.actual, input.expected)
  if (diff) {
    findings.push({
      file: OUT_REL,
      line: diff.line,
      detail: `内容与源码不一致。期望 \`${oneLine(diff.expected)}\`，实际 \`${oneLine(diff.actual)}\``,
    })
  }
  const missing = missingPackages(input.actual, input.expected)
  if (missing.length) {
    findings.push({
      file: OUT_REL,
      detail: `表里缺 ${missing.length} 个包：${missing.map((p) => `\`${p}\``).join("、")}（源码里有、生成物里没有）`,
    })
  }
  findings.push({
    file: OUT_REL,
    detail: `这是生成物，不要手改：跑 \`${REGEN}\` 重生成后提交（改源码才是改这张表的唯一途径）`,
  })
  return { gate: GATE, status: "failed", findings }
}

/** 摘要把一行压成可读长度，免得一个超长行把红文案撑爆。 */
function oneLine(s: string): string {
  const t = s.length > 160 ? `${s.slice(0, 157)}…` : s
  return t.replace(/`/g, "ˋ")
}

function scan(): CatalogInput {
  const file = path.join(REPO, OUT_REL)
  const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
  const expected = buildCatalog(REPO) as string
  // 包数从生成物头部那行读（格式由生成器自述，避免判据另写一份扫描口径）。
  const m = /包 (\d+) 个 · ctx 键 (\d+) 条/u.exec(expected)
  return { actual, expected, packageCount: m ? Number(m[1]) : 0 }
}

if (isMain(import.meta.url)) {
  runGate({ name: GATE, main: () => judgeCatalog(scan()) })
    .then((code) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(`✗ ${GATE}: ${(e as Error).message}`)
      process.exitCode = 2
    })
}
